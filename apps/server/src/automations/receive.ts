import { Clock, Effect, Fiber, Schema } from "effect"
import { Timestamp } from "@huntaway/contracts"
import type { AutomationRun } from "@huntaway/contracts"
import type { AutomationRepoShape, StoredAutomation, StoredRun } from "./AutomationRepo.ts"
import { deliveryId, eventLabel, eventOf, failedFilter, render, takesPing } from "./delivery.ts"
import type { Delivery, Vars } from "./delivery.ts"
import { makeRun } from "./act.ts"
import type { RunSource } from "./act.ts"
import { DAY, isoOf } from "./schedule.ts"
import type { Zone } from "./schedule.ts"
import { DEDUPE_DAYS, MAX_PENDING } from "./model.ts"
import type { RoutinesShape } from "./Routines.ts"

// A webhook delivery to an automation (huntaway's automations/running.ts `receive`; docs/plan/inventory/06-integrations.md
// 9): the signature, whether it's on, GitHub's ping, the filters, then deduplication and coalescing in one transaction,
// so two deliveries at once can't both pass them. One from outside that runs is answered as soon as its run is recorded
// (`running`), and its action goes on by itself: a slow precheck would outlast the sender's timeout (GitHub's is 10 s).

/** A delivery from outside: its body as sent, and its `X-Hub-Signature-256`. */
export interface Raw {
  readonly body: Uint8Array
  readonly signature: string | null
}

/** What taking a delivery needs. */
export interface ReceiveDeps {
  readonly repo: AutomationRepoShape
  readonly routines: RoutinesShape
  readonly tx: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  readonly zone: Zone
  readonly newId: Effect.Effect<string>
  readonly signed: (secret: string, body: Uint8Array, signature: string | null) => Effect.Effect<boolean>
  readonly bodyId: (body: Uint8Array) => Effect.Effect<string>
  readonly spawn: (
    a: StoredAutomation,
    run: string,
    source: RunSource,
    delivery: Delivery | null,
    count: number,
  ) => Effect.Effect<Fiber.Fiber<StoredRun | null>>
}

/** Too many coalesced runs of the automation are waiting (the delivery is recorded as skipped): a 429. */
export class TooManyWaiting extends Schema.TaggedError<TooManyWaiting, { readonly brand: unique symbol }>()("TooManyWaiting", {
  reason: Schema.String,
}) {}

const encodePayload = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))

/** The run a delivery made, or why it didn't make one; fails `TooManyWaiting` past `MAX_PENDING` coalesced runs. */
export const receiveDelivery = (d: ReceiveDeps, a: StoredAutomation, delivery: Delivery, raw: Raw | null) =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis
    const at = Timestamp.make(isoOf(now))
    const source: RunSource = raw === null ? "manual" : "webhook"
    const trigger = a.trigger
    if (trigger.kind !== "webhook") return yield* Effect.die("not a webhook")
    let run: StoredRun = { ...makeRun(yield* d.newId, a.id, source, "running", at), delivery_id: deliveryId(delivery), event: eventLabel(delivery) }
    const settled = (status: AutomationRun["status"]) => (status === "running" || status === "pending" ? null : at)
    const record = Effect.fnUntraced(function* (status: AutomationRun["status"], detail: string, batch: string | null = null) {
      run = { ...run, status, detail, batch_id: batch ?? run.batch_id, finished_at: settled(status) }
      yield* d.repo.insertRun(run)
      yield* d.routines.changed(a)
      return run
    })
    const secret = a.secret === null || a.secret === "" ? null : a.secret
    if (raw !== null) {
      if (secret !== null && !(yield* d.signed(secret, raw.body, raw.signature))) {
        const why = raw.signature !== null ? "its X-Hub-Signature-256 doesn't match the secret" : "it isn't signed (no X-Hub-Signature-256)"
        return yield* record("rejected", `Rejected: ${why}`)
      }
      // A signed delivery is known by its body, which the signature covers, and not by its id header, which it doesn't:
      // one that's been captured can't be sent again with a new id. GitHub's own Redeliver sends the same body.
      if (secret !== null) run = { ...run, delivery_id: yield* d.bodyId(raw.body) }
      if (!a.enabled) return yield* record("skipped", "Skipped: the automation is off")
    }
    if (eventOf(delivery) === "ping" && !trigger.filters.some(takesPing)) {
      return yield* record("filtered", "Ignored: GitHub's ping, sent when a webhook is added (a filter on event equal to ping takes it)")
    }
    const vars: Vars = { automation: a.name, source, delivery, count: 1, now, zone: d.zone }
    const filtered = failedFilter(trigger.filters, vars)
    if (filtered !== null) return yield* record("filtered", filtered)
    const payload = yield* encodePayload(delivery).pipe(Effect.orDie)
    const coalesce = raw !== null && trigger.coalesce_seconds > 0
    // From the checks to the record in one transaction, so two deliveries at once can't both pass them.
    const recorded = yield* d.tx(
      Effect.gen(function* () {
        if (raw !== null && run.delivery_id !== null) {
          const seen = yield* d.repo.seenDelivery(a.id, run.delivery_id, Timestamp.make(isoOf(now - DEDUPE_DAYS * DAY)))
          if (seen !== null) {
            const why = run.delivery_id.startsWith("body-sha256:")
              ? "Dropped: this delivery came before (it's known by its signed body)"
              : "Dropped: this delivery came before"
            run = { ...run, status: "duplicate", detail: why, batch_id: seen, finished_at: at }
            yield* d.repo.insertRun(run)
            return "done" as const
          }
        }
        if (coalesce) {
          const key = render(trigger.coalesce_key, vars, "title")[0]
          run = { ...run, batch_key: key }
          const batch = yield* d.repo.pendingBatch(a.id, key)
          if (batch !== null) {
            // The batch runs with the latest delivery's values.
            yield* d.repo.joinBatch(batch, payload, run.delivery_id, run.event)
            run = { ...run, status: "coalesced", batch_id: batch, finished_at: at }
            yield* d.repo.insertRun(run)
            return "done" as const
          }
          if ((yield* d.repo.pendingCount(a.id)) >= MAX_PENDING) {
            run = { ...run, status: "skipped", detail: `Turned away: ${MAX_PENDING} coalesced runs are waiting already`, finished_at: at }
            yield* d.repo.insertRun(run)
            return "too many" as const
          }
          run = { ...run, status: "pending", payload, due_at: isoOf(now + trigger.coalesce_seconds * 1000) }
          yield* d.repo.insertRun(run)
          return "done" as const
        }
        run = { ...run, payload }
        yield* d.repo.insertRun(run)
        return "run" as const
      }),
    )
    yield* d.routines.changed(a)
    if (recorded === "too many") return yield* new TooManyWaiting({ reason: `${MAX_PENDING} coalesced runs are waiting already` })
    if (recorded === "done") return run
    const fiber = yield* d.spawn(a, run.id, source, delivery, 1)
    // The board's test delivery waits for how it went.
    if (raw === null) return (yield* Fiber.join(fiber)) ?? run
    return run
  })
