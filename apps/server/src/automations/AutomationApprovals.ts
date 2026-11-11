import { Clock, Context, Effect, Layer, Option, Predicate, Result, Schema } from "effect"
import { SecureRandom } from "effect/crypto"
import { AgentConfigId, AutomationPatch, Invalid, NewAutomation, ProfileId, ProjectId } from "@huntaway/contracts"
import type { Action, ActionInput, Conflict, ActiveHours, ActiveHoursInput, Project, Profile, Trigger, TriggerInput } from "@huntaway/contracts"
import { NotApproved } from "../permissions/Approvals.ts"
import { Permissions } from "../permissions/Permissions.ts"
import type { Asker } from "../permissions/Permissions.ts"
import { Identity } from "../platform/Identity.ts"
import { AgentConfigRepo } from "../profiles/AgentConfigRepo.ts"
import type { ProfileNotFound } from "../profiles/Profiles.ts"
import type { ProjectNotFound } from "../projects/Projects.ts"
import { HostSettings } from "../settings/HostSettings.ts"
import { TaskRepo } from "../tasks/TaskRepo.ts"
import type { StoredAutomation } from "./AutomationRepo.ts"
import { Automations } from "./Automations.ts"
import type { Owner, AutomationNotFound } from "./Automations.ts"
import { checkAction, checkActiveHours, checkBudget, checkName, checkPrecheck, checkTrigger, hookPath } from "./model.ts"
import { RoutineHost } from "./RoutineHost.ts"
import { nextAfter, timeZoneOf } from "./schedule.ts"
import { sortedJson } from "./delivery.ts"

// Agents' changes to automations (docs/plan/07-agents.md, Board changes that always ask; huntaway's mcp/tools/
// automations.ts and approvals.ts; inventory 03 2.6, 06 7): creating, changing and deleting one asks the user first (a
// prompt of kind `automation` whose input shows what would run, `before` and `changes` for a change, and `apply`, what
// is made once approved); only turning one off or renaming it is done without asking. What is made is exactly what was
// approved (with the model and effort the user picked for its tasks, `Permissions`' `withModelEffort`). A call that was
// asking when the server stopped carries on with the input it asked about (`Permissions.asked`).

/** What an agent asks to create. Its `action`'s task is already resolved to an id. */
export interface CreationRequest {
  readonly owner: { readonly _tag: "Project"; readonly project: Project } | { readonly _tag: "Profile"; readonly profile: Profile }
  readonly name: string | null
  readonly trigger: TriggerInput | null
  readonly action: ActionInput | null
  readonly enabled: boolean | null
  readonly guards: GuardsGiven
  readonly generateSecret: boolean
  readonly reason: string | null
}

/** What an agent asks to change; what's null is kept. */
export interface ChangeRequest {
  readonly automation: StoredAutomation
  readonly owner: CreationRequest["owner"]
  readonly name: string | null
  readonly trigger: TriggerInput | null
  readonly action: ActionInput | null
  readonly enabled: boolean | null
  readonly guards: GuardsGiven
  readonly generateSecret: boolean
  readonly removeSecret: boolean
  readonly rotateUrl: boolean
  readonly reason: string | null
}

export interface DeletionRequest {
  readonly automation: StoredAutomation
  readonly owner: CreationRequest["owner"]
  readonly reason: string | null
}

/** The guards an agent gives: each left out (undefined) keeps what it was; null clears it. */
export interface GuardsGiven {
  readonly active_hours?: ActiveHoursInput | null | undefined
  readonly precheck?: string | null | undefined
  readonly budget_usd?: number | null | undefined
}

interface Guards {
  readonly active_hours: ActiveHours | null
  readonly precheck: string | null
  readonly budget_usd: number | null
}

/** Why a change can't be made, as the agent is told. */
export class AutomationRefused extends Schema.TaggedError<AutomationRefused, { readonly brand: unique symbol }>()("AutomationRefused", {
  message: Schema.String,
}) {}

type Errors = NotApproved | Invalid | Conflict | AutomationRefused | AutomationNotFound | ProjectNotFound | ProfileNotFound

export interface AutomationApprovalsShape {
  /** `create_automation`: asks to add it, and adds it once approved. `request` is only read when this call hasn't asked before. */
  readonly create: <E>(asker: Asker, request: Effect.Effect<CreationRequest, E>) => Effect.Effect<Readonly<Record<string, unknown>>, E | Errors>
  /** `update_automation`: turning it off or renaming it at once; anything else asked about first. */
  readonly update: <E>(asker: Asker, request: Effect.Effect<ChangeRequest, E>) => Effect.Effect<Readonly<Record<string, unknown>>, E | Errors>
  readonly delete: <E>(asker: Asker, request: Effect.Effect<DeletionRequest, E>) => Effect.Effect<Readonly<Record<string, unknown>>, E | Errors>
  /** An automation as the board tools show it: with its webhook's full URL when the host's public address is set. */
  readonly json: (a: StoredAutomation) => Effect.Effect<Readonly<Record<string, unknown>>>
}

const isRecord = (v: unknown): v is Readonly<Record<string, unknown>> => Predicate.isObject(v) && !Array.isArray(v)
const field = (v: unknown, ...path: ReadonlyArray<string>): unknown => path.reduce<unknown>((x, k) => (isRecord(x) ? x[k] : undefined), v)
const text = (v: unknown, ...path: ReadonlyArray<string>): string => {
  const s = field(v, ...path)
  return typeof s === "string" ? s : ""
}
/** A JSON object with its keys sorted, as the old server's serde map wrote it. */
const sortedObject = (v: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(
    Object.keys(v)
      .toSorted()
      .map((k) => [k, v[k]]),
  )

/** What an approval of `tool` is about, for the agent: `creating the automation "Triage"`. */
const what = (tool: string, v: unknown) => {
  const verb = tool.startsWith("create") ? "creating" : tool.startsWith("update") ? "changing" : "deleting"
  return `${verb} the ${field(v, "profile") !== undefined ? "routine" : "automation"} "${text(v, "automation", "name")}"`
}

const fromResult = <A>(r: Result.Result<A, Invalid>) => Effect.fromResult(r)

const decodeNew = Schema.decodeUnknownEffect(NewAutomation)
const decodePatch = Schema.decodeUnknownEffect(AutomationPatch)

export class AutomationApprovals extends Context.Service<AutomationApprovals, AutomationApprovalsShape>()("huntaway-server/automations/AutomationApprovals") {
  static readonly layer = Layer.effect(
    AutomationApprovals,
    Effect.gen(function* () {
      const automations = yield* Automations
      const permissions = yield* Permissions
      const settings = yield* HostSettings
      const taskRepo = yield* TaskRepo
      const configs = yield* AgentConfigRepo
      const host = yield* RoutineHost
      const random = yield* SecureRandom.SecureRandom
      const { hostName } = yield* Identity
      const zone = automations.zone

      const json = Effect.fn("AutomationApprovals.json")(function* (a: StoredAutomation) {
        const shown: Record<string, unknown> = Object.assign({}, yield* automations.wire(a))
        if (a.trigger.kind === "webhook") {
          const url = (yield* settings.get).public_url
          if (url !== null && url !== "") shown["webhook_url"] = `${url.replace(/\/+$/u, "")}${hookPath(a)}`
          else
            shown["webhook_note"] = "hook_path is on this host; the full URL depends on how it's reached from outside (the host's public_url setting isn't set)"
        }
        return shown
      })

      /** The thread asking, as the approval shows it. */
      const askedBy = Effect.fnUntraced(function* (asker: Asker) {
        const t = yield* taskRepo.get(asker.run.task_id)
        return t === null ? null : { id: t.id, key: t.kind === "task" ? t.key : null, title: t.title }
      })

      /** An automation as its approval shows it: what it is, and the task its message goes to and the config its tasks use, by name. */
      const view = Effect.fnUntraced(function* (id: string, name: string, enabled: boolean, trigger: Trigger, action: Action, signed: boolean, guards: Guards) {
        const v: Record<string, unknown> = { id, name, enabled, trigger, action, signed }
        if (guards.active_hours !== null) v["active_hours"] = guards.active_hours
        if (guards.precheck !== null) v["precheck"] = guards.precheck
        if (guards.budget_usd !== null) v["budget_usd"] = guards.budget_usd
        if (action.kind === "send_to_task") {
          const t = yield* taskRepo.get(action.task_id)
          if (t !== null) v["target"] = { id: t.id, key: t.key, title: t.title, status: t.status }
        } else if (action.kind === "create_task" && action.claude_config_id !== null) {
          const c = yield* configs.get(AgentConfigId.make(action.claude_config_id))
          if (Option.isSome(c)) v["config"] = { id: c.value.id, name: c.value.name, agent: c.value.agent }
        }
        return v
      })

      /** What an automation approval asks: `op` on `automation` of `owner`, asked by the calling agent, with the time zone. */
      const input = Effect.fnUntraced(function* (asker: Asker, op: string, owner: CreationRequest["owner"], automation: Record<string, unknown>) {
        const v: Record<string, unknown> = { op, task: yield* askedBy(asker), automation, time_zone: timeZoneOf(zone, yield* Clock.currentTimeMillis) }
        if (owner._tag === "Project") v["project"] = { id: owner.project.id, key: owner.project.key, name: owner.project.name, host: hostName }
        else v["profile"] = { id: owner.profile.id, name: owner.profile.name, host: hostName }
        return v
      })

      /** The action an agent gives, checked against its owner. */
      const actionOf = Effect.fnUntraced(function* (owner: CreationRequest["owner"], given: ActionInput) {
        const checked = yield* fromResult(checkAction(owner._tag === "Project" ? "project" : "routine", given))
        if (owner._tag === "Project" && checked.kind === "send_to_task") yield* automations.targetTask(owner.project.id, checked.task_id)
        if (owner._tag === "Project" && checked.kind === "create_task") {
          const ref = yield* taskRepo.project(owner.project.id)
          const ids = ref === null ? [] : yield* taskRepo.configs(ref.profile_id, ref)
          if (checked.claude_config_id !== null && !ids.includes(AgentConfigId.make(checked.claude_config_id))) {
            return yield* new Invalid({ field: "action", reason: "claude_config_id must be one of the project's (or profile's) Claude configs" })
          }
          const out: Action = { ...checked, claude_config_id: checked.claude_config_id ?? ids[0] ?? null }
          return out
        }
        return checked
      })

      const guardsOf = Effect.fnUntraced(function* (given: GuardsGiven, was: Guards) {
        const out: Guards = {
          active_hours: given.active_hours === undefined ? was.active_hours : yield* fromResult(checkActiveHours(given.active_hours)),
          precheck: given.precheck === undefined ? was.precheck : yield* fromResult(checkPrecheck(given.precheck)),
          budget_usd: given.budget_usd === undefined ? was.budget_usd : yield* fromResult(checkBudget(given.budget_usd)),
        }
        return out
      })

      /** Asks the user to approve `v` for `tool` and waits: what they approved. */
      const ask = Effect.fnUntraced(function* (asker: Asker, tool: string, v: unknown) {
        const answer = yield* permissions.approve(asker, "automation", tool, v)
        if (Result.isSuccess(answer)) return answer.success
        return yield* new NotApproved({
          message: `The user didn't approve ${what(tool, v)}, so nothing was ${tool.startsWith("create") ? "created" : "changed"}: ${answer.failure}`,
        })
      })

      const newToken = Effect.map(random.randomBytes(32), (b) => [...b].map((x) => x.toString(16).padStart(2, "0")).join(""))

      /**
       * Asks about `v` (an `op` on an automation) and makes exactly what was approved. A new secret is made once it's
       * approved, and returned once.
       */
      const change = Effect.fnUntraced(function* (asker: Asker, v: Readonly<Record<string, unknown>>) {
        const op = text(v, "op")
        const tool = `${op}_automation`
        const id = text(v, "automation", "id")
        const name = text(v, "automation", "name")
        const gone = <E>(e: E): Effect.Effect<never, E | AutomationRefused> =>
          Effect.flatMap(Effect.exit(automations.stored(id)), (found): Effect.Effect<never, E | AutomationRefused> =>
            found._tag === "Failure"
              ? Effect.fail(new AutomationRefused({ message: `the automation "${name}" was deleted meanwhile, so nothing was changed` }))
              : Effect.fail(e),
          )
        const approved = yield* ask(asker, tool, v).pipe(Effect.catchTag("NotApproved", (e) => (op === "create" ? Effect.fail(e) : gone(e))))
        if (op === "delete") {
          const deleted = yield* automations.delete(id).pipe(Effect.catchTag("AutomationNotFound", gone))
          return { deleted: true, id: deleted.id, name: deleted.name }
        }
        const given = field(approved, "apply")
        const apply: Record<string, unknown> = isRecord(given) ? { ...given } : {}
        const generate = apply["generate_secret"] === true
        delete apply["generate_secret"]
        const secret = generate ? yield* newToken : null
        if (secret !== null) apply["secret"] = secret
        let made: StoredAutomation
        if (op === "create") {
          const profile = field(approved, "profile", "id")
          const owner: Owner =
            typeof profile === "string"
              ? { _tag: "Profile", id: ProfileId.make(profile) }
              : { _tag: "Project", id: ProjectId.make(text(approved, "project", "id")) }
          made = yield* automations.create(owner, yield* decodeNew(apply).pipe(Effect.mapError(() => unreadable)))
        } else {
          made = yield* automations
            .update(id, yield* decodePatch(apply).pipe(Effect.mapError(() => unreadable)))
            .pipe(Effect.catchTag("AutomationNotFound", gone))
        }
        const out: Record<string, unknown> = Object.assign({}, yield* json(made))
        // The user picked its tasks' model and effort as they approved it: say so, so it isn't put back.
        const asked = field(v, "automation", "action")
        const got = field(approved, "automation", "action")
        if (
          text(asked, "kind") === "create_task" &&
          text(got, "kind") === "create_task" &&
          (field(asked, "model") !== field(got, "model") || field(asked, "effort") !== field(got, "effort"))
        ) {
          const model = field(got, "model")
          const effort = field(got, "effort")
          out["approval_note"] =
            `The user picked its tasks' model and effort as they approved it (model ${typeof model === "string" ? model : "default"}, effort ${typeof effort === "string" ? effort : "default"}): keep them.`
        }
        if (secret !== null) {
          out["secret"] = secret
          out["secret_note"] = "Deliveries must be signed with this secret (X-Hub-Signature-256, as GitHub does). It isn't shown again."
        }
        return out
      })

      const unreadable = new Invalid({ field: "input", reason: "the approved change doesn't read: call it again" })

      /** What this call asked before it was cut short, if it did. */
      const saved = (asker: Asker) => Effect.map(permissions.asked(asker.call_id), Option.filter(isRecord))

      const create = Effect.fn("AutomationApprovals.create")(function* <E>(asker: Asker, request: Effect.Effect<CreationRequest, E>) {
        const before = yield* saved(asker)
        if (Option.isSome(before)) return yield* change(asker, before.value)
        const r = yield* request
        if (r.owner._tag === "Profile") {
          // Not one that couldn't run, before the user's asked about it.
          const why = yield* host.elsewhere(r.owner.profile.id)
          if (why !== null) return yield* new AutomationRefused({ message: why })
        }
        const now = yield* Clock.currentTimeMillis
        const name = yield* fromResult(checkName(r.name))
        if (r.trigger === null) return yield* new Invalid({ field: "trigger", reason: "trigger: missing" })
        if (r.action === null) return yield* new Invalid({ field: "action", reason: "action: missing" })
        const trigger = yield* fromResult(checkTrigger(r.trigger, now, zone))
        const action = yield* actionOf(r.owner, r.action)
        const guards = yield* guardsOf(r.guards, { active_hours: null, precheck: null, budget_usd: null })
        const enabled = r.enabled ?? true
        if (r.generateSecret && trigger.kind !== "webhook") return yield* new AutomationRefused({ message: "only a webhook can have a secret" })
        if (enabled && trigger.kind === "at" && nextAfter(trigger, now, zone) === null) {
          return yield* new AutomationRefused({ message: "its time (at) has passed: give it one to come" })
        }
        const v = yield* input(asker, "create", r.owner, yield* view("", name, enabled, trigger, action, r.generateSecret, guards))
        v["apply"] = {
          action,
          active_hours: guards.active_hours,
          budget_usd: guards.budget_usd,
          enabled,
          generate_secret: r.generateSecret,
          name,
          precheck: guards.precheck,
          trigger,
        }
        v["reason"] = r.reason
        return yield* change(asker, sortedObject(v))
      })

      const update = Effect.fn("AutomationApprovals.update")(function* <E>(asker: Asker, request: Effect.Effect<ChangeRequest, E>) {
        const before = yield* saved(asker)
        if (Option.isSome(before)) return yield* change(asker, before.value)
        const r = yield* request
        const a = r.automation
        const now = yield* Clock.currentTimeMillis
        const apply: Record<string, unknown> = {}
        const name = r.name === null ? a.name : yield* fromResult(checkName(r.name))
        if (name !== a.name) apply["name"] = name
        const trigger = r.trigger === null ? a.trigger : yield* fromResult(checkTrigger(r.trigger, now, zone))
        if (sortedJson(trigger) !== sortedJson(a.trigger)) apply["trigger"] = trigger
        const action = r.action === null ? a.action : yield* actionOf(r.owner, r.action)
        if (sortedJson(action) !== sortedJson(a.action)) apply["action"] = action
        const was: Guards = { active_hours: a.active_hours, precheck: a.precheck, budget_usd: a.budget_usd }
        const guards = yield* guardsOf(r.guards, was)
        if (sortedJson(guards.active_hours) !== sortedJson(was.active_hours)) apply["active_hours"] = guards.active_hours
        if (guards.precheck !== was.precheck) apply["precheck"] = guards.precheck
        if (guards.budget_usd !== was.budget_usd) apply["budget_usd"] = guards.budget_usd
        const enabled = r.enabled ?? a.enabled
        if (enabled !== a.enabled) apply["enabled"] = enabled
        const webhook = trigger.kind === "webhook"
        if ((r.generateSecret || r.rotateUrl) && !webhook) return yield* new AutomationRefused({ message: "only a webhook has a secret or a URL" })
        if (r.generateSecret && r.removeSecret) return yield* new AutomationRefused({ message: "generate_secret and remove_secret can't both be true" })
        const hasSecret = a.secret !== null && a.secret !== ""
        if (r.generateSecret) apply["generate_secret"] = true
        else if (r.removeSecret && hasSecret) apply["secret"] = ""
        if (r.rotateUrl) apply["rotate_token"] = true
        const keys = Object.keys(apply)
        if (keys.length === 0) return yield* new AutomationRefused({ message: "nothing to change" })
        // Turning it off, or renaming it, doesn't make it do anything it didn't.
        if (keys.every((k) => k === "name" || k === "enabled") && (!enabled || a.enabled)) {
          const patch: AutomationPatch = { ...(apply["name"] === undefined ? {} : { name }), ...(apply["enabled"] === undefined ? {} : { enabled }) }
          return yield* json(yield* automations.update(a.id, patch))
        }
        const signed = r.generateSecret ? true : r.removeSecret ? false : hasSecret
        const v = yield* input(asker, "update", r.owner, yield* view(a.id, name, enabled, trigger, action, signed, guards))
        v["before"] = yield* view(a.id, a.name, a.enabled, a.trigger, a.action, hasSecret, was)
        v["changes"] = keys.toSorted()
        v["apply"] = apply
        v["reason"] = r.reason
        return yield* change(asker, sortedObject(v))
      })

      const remove = Effect.fn("AutomationApprovals.delete")(function* <E>(asker: Asker, request: Effect.Effect<DeletionRequest, E>) {
        const before = yield* saved(asker)
        if (Option.isSome(before)) return yield* change(asker, before.value)
        const r = yield* request
        const a = r.automation
        const v = yield* input(
          asker,
          "delete",
          r.owner,
          yield* view(a.id, a.name, a.enabled, a.trigger, a.action, a.secret !== null && a.secret !== "", {
            active_hours: a.active_hours,
            precheck: a.precheck,
            budget_usd: a.budget_usd,
          }),
        )
        v["reason"] = r.reason
        return yield* change(asker, sortedObject(v))
      })

      return AutomationApprovals.of({ create, update, delete: remove, json })
    }),
  )
}
