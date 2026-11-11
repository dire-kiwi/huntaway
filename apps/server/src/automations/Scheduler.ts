import { Cause, Clock, Context, Effect, Fiber, FiberSet, Layer, Option, Ref, Schedule, Schema } from "effect"
import { Timestamp } from "@huntaway/contracts"
import type { AutomationId } from "@huntaway/contracts"
import { Db } from "../platform/Db.ts"
import { makeRun } from "./act.ts"
import type { RunSource } from "./act.ts"
import { AutomationRepo } from "./AutomationRepo.ts"
import type { StoredAutomation, StoredRun } from "./AutomationRepo.ts"
import { Automations } from "./Automations.ts"
import { deliveryOf, DeliveryJson } from "./delivery.ts"
import { DEDUPE_DAYS, LATE_GRACE, TICK } from "./model.ts"
import { Routines } from "./Routines.ts"
import { align, DAY, formatLocal, isoOf, MINUTE, nextRun, parseTime } from "./schedule.ts"
import { SecureRandom } from "effect/crypto"

// The scheduler (docs/plan/06-server.md, Automations; huntaway's automations/running.ts `start`, `claim_due`,
// `claim_batches`): every five seconds it claims the schedules that are due and the coalesced deliveries whose window has
// closed, each in one conditional transaction before anything runs, so neither a restart nor a second pass can run one
// twice. No backfill: an interval missed while the server was down runs once, late; a time of day or cron expression more
// than ten minutes late is recorded as missed; an `at` runs however late, then turns itself off. Each automation's runs go
// on by themselves (a slow precheck holds up no other's), and one that comes due again before its last run is over waits.

export interface SchedulerShape {
  /** Claims what's due at `now` and starts each automation's runs on their own: the fibers running them. */
  readonly startDue: (now: number) => Effect.Effect<ReadonlyArray<Fiber.Fiber<void>>>
  /** `startDue`, then waits for what it started (tests). */
  readonly tick: (now: number) => Effect.Effect<void>
  /** Runs left `running` by a server that stopped are marked as interrupted, and aren't run again. How many. */
  readonly markInterrupted: Effect.Effect<number>
  /** Old runs, payloads and routine threads go. */
  readonly prune: (now: number) => Effect.Effect<void>
}

const decodeDelivery = Schema.decodeUnknownOption(Schema.fromJsonString(DeliveryJson))

export class Scheduler extends Context.Service<Scheduler, SchedulerShape>()("huntaway-server/automations/Scheduler") {
  static readonly layer = Layer.effect(
    Scheduler,
    Effect.gen(function* () {
      const { tx } = yield* Db
      const repo = yield* AutomationRepo
      const automations = yield* Automations
      const routines = yield* Routines
      const random = yield* SecureRandom.SecureRandom
      const zone = routines.zone
      const running = yield* FiberSet.make<void>()
      /** The automations whose scheduled or coalesced run is under way: another of theirs waits for it. */
      const inFlight = yield* Ref.make<ReadonlySet<AutomationId>>(new Set())

      const take = (id: AutomationId) =>
        Ref.modify(inFlight, (all): readonly [boolean, ReadonlySet<AutomationId>] => (all.has(id) ? [false, all] : [true, new Set([...all, id])]))
      const drop = (id: AutomationId) => Ref.update(inFlight, (all) => new Set([...all].filter((x) => x !== id)))

      /** Claims one schedule if it's due: its run to start, or null. Its place in flight is kept only when it returns a run. */
      const claimOne = Effect.fnUntraced(function* (a: StoredAutomation, archived: boolean, now: number) {
        const due = parseTime(a.next_run_at)
        if (a.next_run_at === null || due === null || due > now) return null
        const t = a.trigger
        let run: boolean
        let next: number | null
        if (t.kind === "interval") {
          // An interval keeps its rhythm, unless it's missed one: then it runs once, and goes on from now. Outside its
          // active hours, it starts again when they do.
          const n = due + t.every_minutes * MINUTE
          run = true
          next = align(t, a.active_hours, n > now ? n : now + t.every_minutes * MINUTE, zone)
        } else if (t.kind === "daily" || t.kind === "cron") {
          run = now - due <= LATE_GRACE
          next = nextRun(t, a.active_hours, now, zone)
        } else if (t.kind === "at") {
          // Once, however late (a reminder is better late than never), and then it's off.
          run = true
          next = null
        } else {
          run = false
          next = null
        }
        if (!(yield* take(a.id))) return null
        const id = yield* random.uuidV4()
        const at = Timestamp.make(isoOf(now))
        const dueAt = a.next_run_at
        const claimed = yield* tx(
          Effect.gen(function* () {
            if (!(yield* repo.claim(a.id, dueAt, next === null ? null : isoOf(next), t.kind === "at"))) return null
            // An archived project's schedules go on without running (or filling its history) until it's unarchived.
            if (t.kind === "webhook" || archived) return "none" as const
            const r: StoredRun = {
              ...makeRun(id, a.id, "schedule", run ? "running" : "skipped", at),
              due_at: dueAt,
              ...(run
                ? {}
                : {
                    detail: `Missed: it was due at ${formatLocal(zone, due)}, when the server wasn't running (or the host was asleep). Runs more than 10 minutes late are skipped.`,
                    finished_at: at,
                  }),
            }
            yield* repo.insertRun(r)
            return r
          }),
        ).pipe(Effect.tapCause(() => drop(a.id)))
        if (claimed === null || claimed === "none" || !run) {
          yield* drop(a.id)
          if (claimed !== null && claimed !== "none") yield* routines.changed(a)
          return null
        }
        return claimed
      })

      /** Starts `runs` of `a` one after another in the background, its place in flight given up after. */
      const start = (a: StoredAutomation, runs: ReadonlyArray<StoredRun>, source: RunSource) =>
        FiberSet.run(
          running,
          Effect.forEach(
            runs,
            (r) => {
              const delivery = r.payload === null ? null : Option.getOrNull(Option.map(decodeDelivery(r.payload), deliveryOf))
              return automations.runAction(a, r.id, source, delivery, r.count)
            },
            { concurrency: 1, discard: true },
          ).pipe(
            Effect.catchCause((cause) => Effect.logError(`automation ${a.id}: running it`, cause)),
            Effect.ensuring(drop(a.id)),
          ),
        )

      /** The schedules due at `now`, claimed. One whose last run is still under way stays due. */
      const claimDue = (now: number) => {
        const out: Array<readonly [StoredAutomation, StoredRun]> = []
        return Effect.gen(function* () {
          for (const { automation, archived } of yield* repo.scheduled) {
            const r = yield* claimOne(automation, archived, now)
            if (r !== null) out.push([automation, r])
          }
          return out
        }).pipe(
          // An error part way gives up the places of those claimed before it, so they aren't held back for good.
          Effect.tapCause(() => Effect.forEach(out, ([a]) => drop(a.id), { concurrency: 1, discard: true })),
        )
      }

      /** The coalesced runs whose window has closed, by automation. One whose automation's last run is under way waits. */
      const claimBatches = Effect.fnUntraced(function* (now: number) {
        const at = Timestamp.make(isoOf(now))
        const out = new Map<AutomationId, { readonly a: StoredAutomation; readonly runs: Array<StoredRun> }>()
        for (const r of yield* repo.pendingDue(at)) {
          const a = yield* repo.get(r.automation_id)
          const existing = out.get(r.automation_id)
          const runs = a !== null && a.enabled && a.trigger.kind === "webhook"
          let took = false
          if (runs && existing === undefined) {
            took = yield* take(r.automation_id)
            if (!took) continue
          }
          const claimed = yield* repo
            .claimPending(
              r.id,
              runs ? "running" : "skipped",
              runs ? null : "Skipped: the automation was turned off (or isn't a webhook any more) before it ran",
              at,
            )
            .pipe(Effect.tapCause(() => (took ? drop(r.automation_id) : Effect.void)))
          if (a !== null && runs && claimed && existing !== undefined) existing.runs.push(r)
          else if (a !== null && runs && claimed && took) out.set(a.id, { a, runs: [r] })
          else {
            if (took) yield* drop(r.automation_id)
            if (a !== null) yield* routines.changed(a)
          }
        }
        return [...out.values()]
      })

      const startDue = Effect.fn("Scheduler.startDue")(function* (now: number) {
        const started: Array<Fiber.Fiber<void>> = []
        const due = yield* Effect.exit(claimDue(now))
        if (due._tag === "Success") for (const [a, r] of due.value) started.push(yield* start(a, [r], "schedule"))
        else yield* Effect.logError("checking automations' schedules", due.cause)
        const batches = yield* Effect.exit(claimBatches(now))
        if (batches._tag === "Success") for (const { a, runs } of batches.value) started.push(yield* start(a, runs, "webhook"))
        else yield* Effect.logError("checking automations' coalesced deliveries", batches.cause)
        return started
      })

      const prune = Effect.fn("Scheduler.prune")(function* (now: number) {
        yield* repo.prune(Timestamp.make(isoOf(now - DEDUPE_DAYS * DAY)), Timestamp.make(isoOf(now - 2 * DAY)))
        yield* routines.pruneThreads(now)
      })

      return Scheduler.of({
        startDue,
        tick: (now) => Effect.flatMap(startDue(now), (fibers) => Fiber.joinAll(fibers)).pipe(Effect.asVoid),
        markInterrupted: Effect.flatMap(Clock.currentTimeMillis, (now) => repo.markInterrupted(Timestamp.make(isoOf(now)))),
        prune,
      })
    }).pipe(Effect.annotateLogs({ module: "automations" })),
  )

  /**
   * The scheduler's loops, as long as the server runs: runs left over from before a restart are marked interrupted, then
   * a pass every `TICK` (passes don't wait for the runs they start), and the old runs and routine threads pruned at start
   * and every hour.
   */
  static readonly loop = Layer.effectDiscard(
    Effect.gen(function* () {
      const scheduler = yield* Scheduler
      const n = yield* scheduler.markInterrupted
      if (n > 0) yield* Effect.logWarning(`${n} automation run(s) were interrupted by the restart; they aren't run again`)
      const pass = Effect.flatMap(Clock.currentTimeMillis, scheduler.startDue).pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) => Effect.logError("automations' scheduler", cause),
        ),
      )
      yield* pass.pipe(Effect.repeat(Schedule.spaced(TICK)), Effect.forkScoped)
      const prune = Effect.flatMap(Clock.currentTimeMillis, scheduler.prune).pipe(
        Effect.catchCause((cause) => Effect.logError("pruning automation runs", cause)),
      )
      yield* prune.pipe(Effect.repeat(Schedule.spaced("1 hour")), Effect.forkScoped)
    }).pipe(Effect.annotateLogs({ module: "automations" })),
  )
}
