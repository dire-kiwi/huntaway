import type { Result } from "effect"
import { Clock, Context, Effect, Fiber, FiberSet, Layer, Option, Ref, Schema } from "effect"
import { Digest, Mac, SecureRandom } from "effect/crypto"
import { ChildProcessSpawner } from "effect/process"
import { AgentConfigId, AutomationId, Conflict, Invalid } from "@huntaway/contracts"
import type {
  Action,
  ActionInput,
  ActiveHours,
  Automation,
  AutomationList,
  AutomationPatch,
  AutomationRun,
  AutomationRuns,
  HostTimeZone,
  NewAutomation,
  ProfileId,
  ProjectId,
  Task,
  Trigger,
} from "@huntaway/contracts"
import { Permissions } from "../permissions/Permissions.ts"
import { nowTimestamp } from "../platform/columns.ts"
import { Db } from "../platform/Db.ts"
import { ServerConfig } from "../platform/ServerConfig.ts"
import { ProfileRepo } from "../profiles/ProfileRepo.ts"
import { ProfileNotFound } from "../profiles/Profiles.ts"
import { ProjectRepo } from "../projects/ProjectRepo.ts"
import { ProjectNotFound } from "../projects/Projects.ts"
import { Runs } from "../runs/Runs.ts"
import { TaskRepo } from "../tasks/TaskRepo.ts"
import { Tasks } from "../tasks/Tasks.ts"
import { act, makeRun } from "./act.ts"
import type { ActDeps, RunSource } from "./act.ts"
import { AutomationRepo } from "./AutomationRepo.ts"
import type { StoredAutomation, StoredRun } from "./AutomationRepo.ts"
import { deliveryOf, DeliveryJson, eventOf, signatureBytes, sortedJson, testDelivery } from "./delivery.ts"
import type { Delivery } from "./delivery.ts"
import { receiveDelivery } from "./receive.ts"
import type { Raw, TooManyWaiting } from "./receive.ts"
import { checkAction, checkActiveHours, checkBudget, checkName, checkPrecheck, checkSecret, checkTrigger, hookPath, KEEP_RECENT } from "./model.ts"
import { Routines } from "./Routines.ts"
import { isoOf, nextRun, timeZoneOf } from "./schedule.ts"
import type { Zone } from "./schedule.ts"
import { RoutineHost } from "./RoutineHost.ts"

// A project's automations and a profile's routines (docs/plan/06-server.md, Automations; huntaway's automations.ts,
// automations/handlers.ts and running.ts): adding, changing and deleting them, what the board shows of them, running one
// (its guards and its action: `act.ts`) and taking a webhook delivery (`receive.ts`). The scheduler and the webhook
// route call in here; so do the RPCs and the board tools.

export class AutomationNotFound extends Schema.TaggedError<AutomationNotFound, { readonly brand: unique symbol }>()("AutomationNotFound", {
  id: Schema.String,
}) {}

export { TooManyWaiting } from "./receive.ts"

/** What an automation belongs to: a project, or (a routine) a profile. */
export type Owner = { readonly _tag: "Project"; readonly id: ProjectId } | { readonly _tag: "Profile"; readonly id: ProfileId }

/** A test delivery from the board (Run now on a webhook): its body (else the latest delivery's) and its event. */
export interface TestDelivery {
  readonly payload?: unknown
  readonly event?: string | null | undefined
}

export interface AutomationsShape {
  /** A project's automations, or a profile's routines, with the host's time zone. */
  readonly list: (owner: Owner) => Effect.Effect<AutomationList, ProjectNotFound | ProfileNotFound>
  readonly get: (id: string) => Effect.Effect<Automation, AutomationNotFound>
  /** It as it's kept (with its token and secret). */
  readonly stored: (id: string) => Effect.Effect<StoredAutomation, AutomationNotFound>
  /**
   * Adds one, checked: its action only makes tasks in its project, with its configs, and only messages its tasks; a
   * routine only messages its profile's assistant (`Conflict` when that assistant runs on another host).
   */
  readonly create: (owner: Owner, input: NewAutomation) => Effect.Effect<StoredAutomation, Invalid | Conflict | ProjectNotFound | ProfileNotFound>
  /** Changes what's given; a schedule starts over from now when it's turned on or changed. */
  readonly update: (id: string, patch: AutomationPatch) => Effect.Effect<StoredAutomation, AutomationNotFound | Invalid | ProjectNotFound>
  /** Deletes it with its runs; agents asking to change it are told it's gone. */
  readonly delete: (id: string) => Effect.Effect<StoredAutomation, AutomationNotFound>
  /** Runs it now, on or off (a webhook's: a test delivery, through its filters only). The run once it's over. */
  readonly runNow: (id: string, test: TestDelivery) => Effect.Effect<AutomationRun, AutomationNotFound>
  /** Its latest runs and deliveries, newest first, and the latest delivery's body and event. */
  readonly runs: (id: string) => Effect.Effect<AutomationRuns, AutomationNotFound>
  /** It as the board shows it: its costs, its webhook's path and whether it has a secret, and its latest run. */
  readonly wire: (a: StoredAutomation) => Effect.Effect<Automation>
  /** A run as the board shows it, with its task and its cost so far. */
  readonly runWire: (r: StoredRun) => Effect.Effect<AutomationRun>
  /**
   * A webhook delivery to `a` (`raw`: from outside, with its body and signature header; null: the board's test).
   * One from outside that runs is answered once its run is recorded (`running`) and goes on by itself.
   */
  readonly receive: (a: StoredAutomation, delivery: Delivery, raw: Raw | null) => Effect.Effect<StoredRun, TooManyWaiting>
  /** Whether `signature` (`sha256=<hex>`) is the HMAC-SHA256 of `body` with `secret`, as GitHub signs. */
  readonly signed: (secret: string, body: Uint8Array, signature: string | null) => Effect.Effect<boolean>
  /** Does what the automation does for run `run` once it has passed its guards, and records how it went. */
  readonly runAction: (a: StoredAutomation, run: string, source: RunSource, delivery: Delivery | null, count: number) => Effect.Effect<StoredRun | null>
  /** `runAction` in the background, so a request given up on can't cut it short. */
  readonly spawnAction: (
    a: StoredAutomation,
    run: string,
    source: RunSource,
    delivery: Delivery | null,
    count: number,
  ) => Effect.Effect<Fiber.Fiber<StoredRun | null>>
  /** A message's task: one of the project's own tasks, never another project's. */
  readonly targetTask: (project: ProjectId, task: string) => Effect.Effect<Task, Invalid>
  /** The host's time zone now. */
  readonly timeZone: Effect.Effect<HostTimeZone>
  readonly zone: Zone
  /** Waits until the runs going on by themselves are over (tests). */
  readonly idle: Effect.Effect<void>
}

const fromResult = <A>(r: Result.Result<A, Invalid>) => Effect.fromResult(r)

const decodeDelivery = Schema.decodeUnknownOption(Schema.fromJsonString(DeliveryJson))

/** Whether two stored values are the same, as their JSON with sorted keys. */
const same = (a: unknown, b: unknown) => sortedJson(a) === sortedJson(b)

export class Automations extends Context.Service<Automations, AutomationsShape>()("huntaway-server/automations/Automations") {
  static readonly layer = Layer.effect(
    Automations,
    Effect.gen(function* () {
      const repo = yield* AutomationRepo
      const routines = yield* Routines
      const host = yield* RoutineHost
      const projects = yield* ProjectRepo
      const profiles = yield* ProfileRepo
      const taskRepo = yield* TaskRepo
      const permissions = yield* Permissions
      const random = yield* SecureRandom.SecureRandom
      const mac = yield* Mac.Mac
      const digest = yield* Digest.Digest
      const { tx } = yield* Db
      const tasks = yield* Tasks
      const runsService = yield* Runs
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const config = yield* ServerConfig
      const background = yield* FiberSet.make<StoredRun | null>()
      const starting = yield* Ref.make<ReadonlySet<string>>(new Set())
      const zone = routines.zone

      const now = Clock.currentTimeMillis

      const stored = Effect.fn("Automations.stored")(function* (id: string) {
        const a = yield* repo.get(id)
        if (a === null) return yield* new AutomationNotFound({ id })
        return a
      })

      const runWire = Effect.fn("Automations.runWire")(function* (r: StoredRun) {
        const { agent_run_id: _a, batch_key: _b, payload: _p, ...shown } = r
        let cost = r.cost_usd
        let task: AutomationRun["task"]
        const t = r.task_id === null ? null : yield* taskRepo.get(r.task_id)
        if (t !== null) {
          task = { key: t.key, title: t.title, status: t.status, running: t.running }
          // A routine thread's cost so far, while it works.
          if (cost === null && t.kind === "task" && t.task_type === "routine") cost = t.cost_usd
        }
        // The agent run that took its message in, while it works.
        if (cost === null) cost = yield* repo.shareSoFar(r.id)
        const out: AutomationRun = { ...shown, cost_usd: cost, ...(task === undefined ? {} : { task }) }
        return out
      })

      const wire = Effect.fn("Automations.wire")(function* (a: StoredAutomation) {
        const last = (yield* repo.runs(a.id, 1))[0]
        const { token: _t, secret, ...shown } = a
        const out: Automation = {
          ...shown,
          cost_usd: yield* repo.spent(a.id, null),
          cost_today_usd: yield* routines.spentToday(a.id, yield* now),
          ...(a.trigger.kind === "webhook" ? { hook_path: hookPath(a), has_secret: secret !== null && secret !== "" } : {}),
          last_run: last === undefined ? null : yield* runWire(last),
        }
        return out
      })

      const timeZone = Effect.map(now, (t) => timeZoneOf(zone, t))

      const list = Effect.fn("Automations.list")(function* (owner: Owner) {
        let found: ReadonlyArray<StoredAutomation>
        if (owner._tag === "Project") {
          if (Option.isNone(yield* projects.get(owner.id))) return yield* new ProjectNotFound({ id: owner.id })
          found = yield* repo.list(owner.id)
        } else {
          if (Option.isNone(yield* profiles.get(owner.id))) return yield* new ProfileNotFound({ id: owner.id })
          found = yield* repo.listRoutines(owner.id)
        }
        const out: AutomationList = { automations: yield* Effect.forEach(found, wire, { concurrency: 1 }), time_zone: yield* timeZone }
        return out
      })

      const targetTask = Effect.fn("Automations.targetTask")(function* (project: ProjectId, id: string) {
        const t = yield* taskRepo.get(id)
        if (t === null) return yield* new Invalid({ field: "action", reason: "task not found" })
        if (t.kind === "task" && t.project_id === project) return t
        return yield* new Invalid({ field: "action", reason: "an automation can only send messages to tasks in its own project" })
      })

      /** An action as it's stored, checked against its owner (the project's tasks and configs). */
      const action = Effect.fnUntraced(function* (owner: Owner, input: ActionInput) {
        const checked = yield* fromResult(checkAction(owner._tag === "Project" ? "project" : "routine", input))
        if (owner._tag === "Profile" || checked.kind === "message_assistant") return checked
        if (checked.kind === "send_to_task") {
          const t = yield* targetTask(owner.id, checked.task_id)
          const out: Action = { ...checked, task_id: t.id }
          return out
        }
        const ref = yield* taskRepo.project(owner.id)
        if (ref === null) return yield* new Invalid({ field: "action", reason: "the project is gone" })
        const configs = yield* taskRepo.configs(ref.profile_id, ref)
        const given = checked.claude_config_id
        if (given !== null && !configs.includes(AgentConfigId.make(given))) {
          return yield* new Invalid({ field: "action", reason: "claude_config_id must be one of the project's (or profile's) Claude configs" })
        }
        const out: Action = { ...checked, claude_config_id: given ?? configs[0] ?? null }
        return out
      })

      /**
       * When a schedule that's on and has just been set (or turned on) first runs: an `at` that's passed can't be, nor
       * one whose times never fall in its active hours.
       */
      const firstRun = (trigger: Trigger, active: ActiveHours | null, at: number): Effect.Effect<string | null, Invalid> => {
        const next = nextRun(trigger, active, at, zone)
        if (next === null && trigger.kind === "at")
          return Effect.fail(new Invalid({ field: "trigger", reason: "its time (at) has passed: give it one to come" }))
        if (next === null && trigger.kind !== "webhook") {
          return Effect.fail(new Invalid({ field: "active_hours", reason: "its schedule never falls in its active hours, so it would never run" }))
        }
        return Effect.succeed(next === null ? null : isoOf(next))
      }

      const newToken = Effect.map(random.randomBytes(32), (b) => [...b].map((x) => x.toString(16).padStart(2, "0")).join(""))

      const create = Effect.fn("Automations.create")(function* (owner: Owner, input: NewAutomation) {
        const t = yield* now
        let profile: ProfileId
        if (owner._tag === "Project") {
          const p = yield* projects.get(owner.id)
          if (Option.isNone(p)) return yield* new ProjectNotFound({ id: owner.id })
          profile = p.value.profile_id
        } else {
          if (Option.isNone(yield* profiles.get(owner.id))) return yield* new ProfileNotFound({ id: owner.id })
          // Not one that couldn't run.
          const why = yield* host.elsewhere(owner.id)
          if (why !== null) return yield* new Conflict({ reason: "in_use", detail: why })
          profile = owner.id
        }
        const name = yield* fromResult(checkName(input.name))
        const trigger = yield* fromResult(checkTrigger(input.trigger, t, zone))
        const act_ = yield* action(owner, input.action)
        const enabled = input.enabled ?? true
        const secret = yield* fromResult(checkSecret(input.secret))
        const active = yield* fromResult(checkActiveHours(input.active_hours))
        const precheck = yield* fromResult(checkPrecheck(input.precheck))
        const budget = yield* fromResult(checkBudget(input.budget_usd))
        const next = enabled ? yield* firstRun(trigger, active, t) : null
        const at = yield* nowTimestamp
        const a: StoredAutomation = {
          id: AutomationId.make(yield* random.uuidV4()),
          profile_id: profile,
          project_id: owner._tag === "Project" ? owner.id : null,
          name,
          enabled,
          trigger,
          action: act_,
          token: yield* newToken,
          secret,
          next_run_at: next,
          last_run_at: null,
          active_hours: active,
          precheck,
          budget_usd: budget,
          created_at: at,
          updated_at: at,
        }
        yield* repo.insert(a, sortedJson(trigger), sortedJson(act_))
        yield* routines.changed(a)
        return a
      })

      const update = Effect.fn("Automations.update")(function* (id: string, patch: AutomationPatch) {
        const t = yield* now
        const a = yield* stored(id)
        const owner: Owner = a.project_id === null ? { _tag: "Profile", id: a.profile_id } : { _tag: "Project", id: a.project_id }
        if (owner._tag === "Project" && Option.isNone(yield* projects.get(owner.id))) return yield* new ProjectNotFound({ id: owner.id })
        const name = patch.name === undefined ? a.name : yield* fromResult(checkName(patch.name))
        const trigger = patch.trigger === undefined ? a.trigger : yield* fromResult(checkTrigger(patch.trigger, t, zone))
        const act_ = patch.action === undefined ? a.action : yield* action(owner, patch.action)
        const enabled = patch.enabled ?? a.enabled
        const secret = patch.secret === undefined ? a.secret : yield* fromResult(checkSecret(patch.secret))
        const token = patch.rotate_token === true ? yield* newToken : a.token
        const active = patch.active_hours === undefined ? a.active_hours : yield* fromResult(checkActiveHours(patch.active_hours))
        const precheck = patch.precheck === undefined ? a.precheck : yield* fromResult(checkPrecheck(patch.precheck))
        const budget = patch.budget_usd === undefined ? a.budget_usd : yield* fromResult(checkBudget(patch.budget_usd))
        // A schedule starts over from now when it's turned on or changed; it doesn't run while it's off.
        const next = !enabled
          ? null
          : enabled !== a.enabled || !same(trigger, a.trigger) || !same(active, a.active_hours)
            ? yield* firstRun(trigger, active, t)
            : a.next_run_at
        yield* repo.update(
          a.id,
          {
            name,
            enabled,
            trigger: sortedJson(trigger),
            action: sortedJson(act_),
            secret,
            token,
            next_run_at: next,
            active_hours: active === null ? null : sortedJson(active),
            precheck,
            budget_usd: budget,
          },
          yield* nowTimestamp,
        )
        const after = yield* stored(id)
        yield* routines.changed(after)
        return after
      })

      const remove = Effect.fn("Automations.delete")(function* (id: string) {
        const a = yield* stored(id)
        yield* repo.delete(a.id)
        // Agents waiting to change or delete it are told it's gone.
        yield* permissions.expireFor({ _tag: "Automation", automation: a.id })
        yield* routines.changed(a)
        return a
      })

      const signed = Effect.fn("Automations.signed")(function* (secret: string, body: Uint8Array, signature: string | null) {
        const tag = signatureBytes(signature)
        if (tag === null) return false
        const key = yield* Mac.key(Mac.hmacSha256, new TextEncoder().encode(secret)).pipe(Effect.orDie)
        return yield* mac.verify(key, tag, body).pipe(Effect.orElseSucceed(() => false))
      })

      const deps: ActDeps = {
        repo,
        routines,
        host,
        tasks,
        runs: runsService,
        projects,
        spawner,
        agentEnv: config.agentEnv,
        home: config.home,
        starting,
        zone,
        targetTask,
      }
      const newId = random.uuidV4()

      const runAction = (a: StoredAutomation, run: string, source: RunSource, delivery: Delivery | null, count: number) =>
        act(deps, a, run, source, delivery, count)

      const spawnAction = (a: StoredAutomation, run: string, source: RunSource, delivery: Delivery | null, count: number) =>
        FiberSet.run(background, runAction(a, run, source, delivery, count))

      const bodyId = (body: Uint8Array) => Effect.map(digest.digestHex(Digest.sha256, body), (hex) => `body-sha256:${hex}`)

      const receive = (a: StoredAutomation, delivery: Delivery, raw: Raw | null) =>
        receiveDelivery({ repo, routines, tx, zone, newId, signed, bodyId, spawn: spawnAction }, a, delivery, raw)

      const latestDelivery = Effect.fnUntraced(function* (id: AutomationId) {
        const payload = yield* repo.latestPayload(id)
        if (payload === null) return null
        return Option.getOrNull(Option.map(decodeDelivery(payload), deliveryOf))
      })

      const runNow = Effect.fn("Automations.runNow")(function* (id: string, test: TestDelivery) {
        const a = yield* stored(id)
        if (a.trigger.kind === "webhook") {
          const given = test.payload !== undefined && test.payload !== null ? testDelivery(test.payload) : ((yield* latestDelivery(a.id)) ?? testDelivery({}))
          const headers: Record<string, unknown> = { ...given.headers }
          const e = test.event?.trim() ?? ""
          if (e !== "") headers["x-github-event"] = e
          // The same delivery id would be a duplicate of the real one.
          for (const h of ["x-github-delivery", "x-delivery-id", "idempotency-key"]) delete headers[h]
          const run = yield* receive(a, { ...given, headers }, null).pipe(Effect.catchTag("TooManyWaiting", Effect.die))
          return yield* runWire(run)
        }
        const run = makeRun(yield* newId, a.id, "manual", "running", yield* nowTimestamp)
        yield* repo.insertRun(run)
        const fiber = yield* spawnAction(a, run.id, "manual", null, 1)
        return yield* runWire((yield* Fiber.join(fiber)) ?? run)
      })

      const runs = Effect.fn("Automations.runs")(function* (id: string) {
        const a = yield* stored(id)
        const shown = yield* Effect.forEach(yield* repo.runs(a.id, KEEP_RECENT), runWire, { concurrency: 1 })
        const d = yield* latestDelivery(a.id)
        const out: AutomationRuns = { runs: shown, latest_delivery: d === null ? null : { body: d.body, event: eventOf(d) } }
        return out
      })

      return Automations.of({
        list,
        get: (id) => Effect.flatMap(stored(id), wire),
        stored,
        create,
        update,
        delete: remove,
        runNow,
        runs,
        wire,
        runWire,
        receive,
        signed,
        runAction,
        spawnAction,
        targetTask,
        timeZone,
        zone,
        idle: FiberSet.awaitEmpty(background),
      })
    }),
  )
}
