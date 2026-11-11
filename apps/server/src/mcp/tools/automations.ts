import { Effect, Schema } from "effect"
import { Tool } from "effect/ai"
import { DocumentLabel, Effort, FilterOp, Weekday } from "@huntaway/contracts"
import type { ActionInput, TriggerInput } from "@huntaway/contracts"
import { AutomationApprovals } from "../../automations/AutomationApprovals.ts"
import type { CreationRequest, GuardsGiven } from "../../automations/AutomationApprovals.ts"
import { AutomationRepo } from "../../automations/AutomationRepo.ts"
import type { StoredAutomation } from "../../automations/AutomationRepo.ts"
import { Automations } from "../../automations/Automations.ts"
import { MIN_INTERVAL_MINUTES } from "../../automations/model.ts"
import { isAssistants } from "../../tasks/checks.ts"
import { makeReach } from "../resolve.ts"
import { ApprovalKind, ForPlanning, Rerunnable, ToolError } from "../tool.ts"
import type { McpCaller } from "../tool.ts"
import { asker, boardTool, given, Json, PROJECT_ONE, ProfileArg, told } from "./common.ts"
import type { ServiceError } from "./common.ts"

// The automation tools (docs/plan/inventory/03-mcp.md 2.5, 2.6; inventory 06 7; the old mcp/schemas/automations.ts,
// mcp/tools/automations.ts and local.ts): listing, creating, changing, deleting and running a project's automations, or
// with `routines` the caller's own profile's routines. Creating, changing (but for turning one off or renaming it) and
// deleting ask the user first (`AutomationApprovals`).

const ProjectArg = Schema.String.annotate({ description: PROJECT_ONE })
const AutomationRef = Schema.String.annotate({
  description: "The automation's id, or its name in project_id (or with routines=true, among your profile's routines; see list_automations)",
})
const RoutinesArg = Schema.Boolean.annotate({
  description:
    "Your own profile's routines (automations that wake its assistant) rather than a project's automations. The default for the assistant, and for an action of kind message_assistant",
})

const TriggerArg = Schema.Struct({
  kind: Schema.Literals(["interval", "daily", "cron", "at", "webhook"]),
  expr: Schema.optionalKey(Schema.String.annotate({ description: "For cron: the expression" })),
  at: Schema.optionalKey(Schema.String.annotate({ description: "For at: when it runs" })),
  every_minutes: Schema.optionalKey(Schema.Int.annotate({ description: `At least ${MIN_INTERVAL_MINUTES}` })),
  time: Schema.optionalKey(Schema.String.annotate({ description: "A time of day like 09:30" })),
  weekdays: Schema.optionalKey(Schema.Array(Weekday)),
  filters: Schema.optionalKey(
    Schema.Array(Schema.Struct({ path: Schema.String, op: FilterOp, value: Schema.optionalKey(Schema.Unknown) })).annotate({
      description: "Conditions a delivery must meet: path names a value as templates do (event, action, labels, body.issue.user.login…)",
    }),
  ),
  coalesce_seconds: Schema.optionalKey(
    Schema.Int.annotate({
      description: "Deliveries within this many seconds of the first make one run, with the latest one's values (0: each runs by itself)",
    }),
  ),
  coalesce_key: Schema.optionalKey(
    Schema.String.annotate({ description: "With coalescing, only deliveries with the same key (a template such as {{body.issue.number}}) go together" }),
  ),
}).annotate({
  description:
    `What starts it: {kind: 'interval', every_minutes} (${MIN_INTERVAL_MINUTES} minutes to 31 days, counted from when it's turned on or changed); ` +
    "{kind: 'daily', time: 'HH:MM', weekdays} (in the host's time zone, on those weekdays, or every day with none); " +
    "{kind: 'cron', expr} (5 fields: minute hour day-of-month month day-of-week, in the host's time zone, e.g. '0 8 * * mon-fri'); " +
    "{kind: 'at', at} (once, at a time like '2026-11-05 09:30' in the host's time zone or RFC 3339; then it turns itself off); " +
    "or {kind: 'webhook', filters, coalesce_seconds, coalesce_key}: each POST to its URL that passes all the filters. " +
    "Use the fields of its kind.",
})

const ActionArg = Schema.Struct({
  kind: Schema.Literals(["create_task", "send_to_task", "message_assistant"]),
  mode: Schema.optionalKey(
    Schema.Literals(["fresh", "thread"]).annotate({ description: "For message_assistant: a fresh thread (default) or the assistant's own" }),
  ),
  title: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String.annotate({ description: "Instructions for the new task's agent (markdown)" })),
  task_type: Schema.optionalKey(Schema.Literals(["scratch"]).annotate({ description: "Leave out for a code task" })),
  labels: Schema.optionalKey(
    Schema.Array(DocumentLabel).annotate({
      description: "Documents the task's agent writes besides its other work: a plan, an artifact (an HTML page) or a diagram",
    }),
  ),
  claude_config_id: Schema.optionalKey(Schema.String.annotate({ description: "One of the project's agent configs; leave out for its default" })),
  model: Schema.optionalKey(Schema.String),
  effort: Schema.optionalKey(Effort),
  status: Schema.optionalKey(
    Schema.Literals(["todo", "backlog"]).annotate({ description: "Where the task goes (default todo); a started task moves to in_progress" }),
  ),
  start: Schema.optionalKey(Schema.Boolean.annotate({ description: "Start the new task's agent straight away" })),
  task_id: Schema.optionalKey(Schema.String.annotate({ description: "The task to message: an id or key of a task in the same project" })),
  message: Schema.optionalKey(Schema.String),
}).annotate({
  description:
    "What it does: {kind: 'create_task', title, description, task_type, labels, claude_config_id, model, effort, status, start} creates a task in the automation's project, " +
    "or {kind: 'send_to_task', task_id, message} sends a message to one of the project's tasks. A routine's (a profile's) is {kind: 'message_assistant', message, mode}: " +
    "mode 'fresh' (the default) runs it in a new thread under the assistant, whose last message is posted to the assistant as a report unless it's NO_REPLY; " +
    "'thread' sends it to the assistant's own thread. Title, description and message are templates: " +
    "{{body.<path>}}, {{headers.<name>}}, {{query.<name>}}, {{event}}, {{action}}, {{labels}} and {{delivery}} from a webhook delivery, and {{precheck}} (what the precheck printed) " +
    "(marked as untrusted data for the agent), and {{date}}, {{time}}, {{now}}, {{automation}} and {{count}} from the board.",
})

const guardFields = {
  active_hours: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        start: Schema.String.annotate({ description: "e.g. 08:00" }),
        end: Schema.String.annotate({ description: "e.g. 22:00" }),
        weekdays: Schema.optionalKey(Schema.Array(Weekday)),
      }),
    ).annotate({
      description:
        "The hours its scheduled runs may start in (host time zone; end may be past midnight), on weekdays (none for every day): a scheduled run waits for them, a delivery outside them is skipped. Not for at, nor Run now. null for any time",
    }),
  ),
  precheck: Schema.optionalKey(
    Schema.NullOr(Schema.String).annotate({
      description:
        "A bash command run before each run, in the assistant's workspace (or the project's folder): exit 0 runs it, with what it printed as {{precheck}}; exit 1 skips the run (nothing new); anything else fails it. null or blank for none",
    }),
  ),
  budget_usd: Schema.optionalKey(
    Schema.NullOr(Schema.Finite).annotate({
      description:
        "What its runs may cost a day (host time zone): once they have, it's skipped until tomorrow. A run's cost is its agent's: a routine's thread (or the assistant's run that took its message), or for a project's automation the first run of the task it made and started, or the run that took its message in. null or 0 for no limit",
    }),
  ),
}

const ASKS = "It asks the user to approve it first (say why in reason): the call waits for their answer, and if they don't approve it nothing changes."

export const ListAutomations = Tool.make("list_automations", {
  description:
    "List a project's automations, or with routines=true your profile's routines: what starts each one (an interval, a time of day, a cron expression, a time or a webhook), what it does (create a task or message one, or wake the assistant), whether it's on, when it next runs, its latest run and what its runs cost. The time zone the times are in comes with them.",
  parameters: Schema.Struct({ project_id: Schema.optionalKey(ProjectArg), profile: Schema.optionalKey(ProfileArg), routines: Schema.optionalKey(RoutinesArg) }),
  success: Json,
})
  .annotate(Rerunnable, true)
  .annotate(ForPlanning, true)

export const CreateAutomation = Tool.make("create_automation", {
  description:
    "Add an automation to a project: it creates a task there, or sends a message to one of its tasks, on a schedule or whenever its webhook URL gets a delivery " +
    `(e.g. from GitHub). Or a routine to your profile (an action of kind message_assistant): it wakes the assistant. Only when the user asks for one. ${ASKS} ` +
    "For a webhook, the result has its hook_path (and webhook_url, if the host's public address is set), which lets whoever has it start runs, so only give it to " +
    "where the deliveries come from; with generate_secret, the secret to sign deliveries with is in the result, once.",
  parameters: Schema.Struct({
    project_id: Schema.optionalKey(ProjectArg),
    profile: Schema.optionalKey(ProfileArg),
    name: Schema.String,
    trigger: TriggerArg,
    action: ActionArg,
    enabled: Schema.optionalKey(Schema.Boolean.annotate({ description: "On straight away (default true)" })),
    generate_secret: Schema.optionalKey(
      Schema.Boolean.annotate({
        description: "For a webhook: make a secret that deliveries must be signed with (X-Hub-Signature-256, as GitHub's webhook Secret does)",
      }),
    ),
    reason: Schema.optionalKey(Schema.String.annotate({ description: "Why, shown to the user when they're asked to approve it" })),
    routines: Schema.optionalKey(RoutinesArg),
    ...guardFields,
  }),
  success: Json,
}).annotate(ApprovalKind, "automation")

export const UpdateAutomation = Tool.make("update_automation", {
  description:
    "Change a project's automation; leave out what to keep. Turning it off (enabled false) or renaming it is done straight away; any other change, " +
    `including turning it on, asks the user. ${ASKS}`,
  parameters: Schema.Struct({
    automation_id: AutomationRef,
    project_id: Schema.optionalKey(ProjectArg),
    profile: Schema.optionalKey(ProfileArg),
    name: Schema.optionalKey(Schema.String),
    trigger: Schema.optionalKey(TriggerArg),
    action: Schema.optionalKey(ActionArg),
    enabled: Schema.optionalKey(Schema.Boolean),
    generate_secret: Schema.optionalKey(Schema.Boolean.annotate({ description: "For a webhook: a new signing secret, returned once in the result" })),
    remove_secret: Schema.optionalKey(Schema.Boolean.annotate({ description: "For a webhook: stop checking deliveries' signatures" })),
    rotate_url: Schema.optionalKey(Schema.Boolean.annotate({ description: "For a webhook: a new URL (the old one stops working)" })),
    reason: Schema.optionalKey(Schema.String.annotate({ description: "Why, shown to the user when they're asked to approve it" })),
    routines: Schema.optionalKey(RoutinesArg),
    ...guardFields,
  }),
  success: Json,
}).annotate(ApprovalKind, "automation")

export const DeleteAutomation = Tool.make("delete_automation", {
  description: `Delete a project's automation (its run history goes with it; the tasks it made stay). Only when the user asks for it. ${ASKS}`,
  parameters: Schema.Struct({
    automation_id: AutomationRef,
    project_id: Schema.optionalKey(ProjectArg),
    profile: Schema.optionalKey(ProfileArg),
    reason: Schema.optionalKey(Schema.String.annotate({ description: "Why, shown to the user when they're asked to confirm" })),
    routines: Schema.optionalKey(RoutinesArg),
  }),
  success: Json,
}).annotate(ApprovalKind, "automation")

export const RunAutomation = Tool.make("run_automation", {
  description:
    "Run an automation once now, on or off, as its Run now (or, for a webhook, Test) does on the board: a webhook's run is a test delivery of payload (else the latest delivery's body) through its filters and templates, without the signature check, duplicate check or coalescing. Returns the run: its status, detail and task.",
  parameters: Schema.Struct({
    automation_id: AutomationRef,
    project_id: Schema.optionalKey(ProjectArg),
    profile: Schema.optionalKey(ProfileArg),
    payload: Schema.optionalKey(Schema.Unknown.annotate({ description: "For a webhook: the test delivery's JSON body" })),
    event: Schema.optionalKey(Schema.String.annotate({ description: "For a webhook: the test delivery's event (X-GitHub-Event), e.g. issues" })),
    routines: Schema.optionalKey(RoutinesArg),
  }),
  success: Json,
})

type TriggerParams = typeof TriggerArg.Type
type ActionParams = typeof ActionArg.Type

const missing = (what: string, name: string) => ToolError.other(`${what}: missing field \`${name}\``)

/** A trigger as the agent gives it, as a request has it. */
const triggerOf = (t: TriggerParams): Effect.Effect<TriggerInput, ToolError> => {
  switch (t.kind) {
    case "interval":
      return t.every_minutes === undefined
        ? Effect.fail(missing("trigger", "every_minutes"))
        : Effect.succeed({ kind: "interval", every_minutes: t.every_minutes })
    case "daily":
      return t.time === undefined ? Effect.fail(missing("trigger", "time")) : Effect.succeed({ kind: "daily", time: t.time, weekdays: t.weekdays ?? [] })
    case "cron":
      return t.expr === undefined ? Effect.fail(missing("trigger", "expr")) : Effect.succeed({ kind: "cron", expr: t.expr })
    case "at":
      return t.at === undefined ? Effect.fail(missing("trigger", "at")) : Effect.succeed({ kind: "at", at: t.at })
    case "webhook":
    default:
      return Effect.succeed({
        kind: "webhook",
        ...(t.filters === undefined ? {} : { filters: t.filters }),
        ...(t.coalesce_seconds === undefined ? {} : { coalesce_seconds: t.coalesce_seconds }),
        ...(t.coalesce_key === undefined ? {} : { coalesce_key: t.coalesce_key }),
      })
  }
}

/** Whether a call is about the caller's routines: it says so, its action wakes the assistant, or it's the assistant's and names no project. */
const wantsRoutines = (caller: McpCaller, p: { readonly routines?: boolean; readonly project_id?: string; readonly action?: ActionParams }) =>
  p.routines === true || p.action?.kind === "message_assistant" || ((p.project_id === undefined || p.project_id === "") && isAssistants(caller.task))

const guardsOf = (p: {
  readonly active_hours?: GuardsGiven["active_hours"]
  readonly precheck?: string | null
  readonly budget_usd?: number | null
}): GuardsGiven => ({
  ...(p.active_hours === undefined ? {} : { active_hours: p.active_hours }),
  ...(p.precheck === undefined ? {} : { precheck: p.precheck }),
  ...(p.budget_usd === undefined ? {} : { budget_usd: p.budget_usd }),
})

/** An automation service's error as the agent is told it. */
const toldAll = <A, R>(
  self: Effect.Effect<
    A,
    ServiceError | { readonly _tag: "AutomationRefused"; readonly message: string } | { readonly _tag: "AutomationNotFound"; readonly id: string },
    R
  >,
): Effect.Effect<A, ToolError, R> =>
  told(
    Effect.catchTags(self, {
      AutomationRefused: (e) => Effect.fail(ToolError.other(e.message)),
      AutomationNotFound: (e) => Effect.fail(ToolError.notFound(`automation ${e.id}`)),
    }),
  )

const sameText = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

/** The automation tools' handlers, in the order runs are shown them. */
export const automationTools = Effect.gen(function* () {
  const reach = yield* makeReach
  const automations = yield* Automations
  const repo = yield* AutomationRepo
  const approvals = yield* AutomationApprovals

  /** The caller's own profile, whose routines it can see and change: other profiles' agents can't reach them. */
  const ownRoutines = Effect.fnUntraced(function* (caller: McpCaller, profile: string | null) {
    const own = caller.profile
    if (profile !== null && !sameText(profile, own.name) && profile !== own.id) {
      return yield* ToolError.other(`an agent can only use its own profile's routines (${own.name})`)
    }
    return own
  })

  /** The action an agent gives: a message's task named by key, and only one of the project's. */
  const actionOf = Effect.fnUntraced(function* (caller: McpCaller, owner: CreationRequest["owner"], a: ActionParams, profile: string | null) {
    switch (a.kind) {
      case "create_task": {
        if (a.title === undefined) return yield* missing("action", "title")
        const out: ActionInput = {
          kind: "create_task",
          title: a.title,
          ...(a.description === undefined ? {} : { description: a.description }),
          ...(a.task_type === undefined ? {} : { task_type: a.task_type }),
          ...(a.labels === undefined ? {} : { labels: a.labels }),
          ...(a.claude_config_id === undefined ? {} : { claude_config_id: a.claude_config_id }),
          ...(a.model === undefined ? {} : { model: a.model }),
          ...(a.effort === undefined ? {} : { effort: a.effort }),
          ...(a.status === undefined ? {} : { status: a.status }),
          ...(a.start === undefined ? {} : { start: a.start }),
        }
        return out
      }
      case "send_to_task": {
        if (a.task_id === undefined) return yield* missing("action", "task_id")
        if (a.message === undefined) return yield* missing("action", "message")
        let taskId = a.task_id.trim()
        if (owner._tag === "Project") {
          const key = owner.project.key
          const t = yield* reach
            .task(caller, taskId, profile)
            .pipe(Effect.mapError((e) => (e.notFound ? ToolError.other(`task ${a.task_id ?? ""} not found in ${key}`) : e)))
          taskId = t.id
        }
        const out: ActionInput = { kind: "send_to_task", task_id: taskId, message: a.message }
        return out
      }
      case "message_assistant":
      default: {
        if (a.message === undefined) return yield* missing("action", "message")
        const out: ActionInput = { kind: "message_assistant", message: a.message, ...(a.mode === undefined ? {} : { mode: a.mode }) }
        return out
      }
    }
  })

  /** The owner a call names: the caller's routines, or a project on a board it can use. */
  const ownerOf = Effect.fnUntraced(function* (
    caller: McpCaller,
    p: { readonly routines?: boolean; readonly project_id?: string; readonly profile?: string; readonly action?: ActionParams },
  ) {
    if (wantsRoutines(caller, p)) {
      const own: CreationRequest["owner"] = { _tag: "Profile", profile: yield* ownRoutines(caller, given(p.profile)) }
      return own
    }
    const project = yield* reach.projectOrOwn(caller, given(p.project_id), given(p.profile))
    const out: CreationRequest["owner"] = { _tag: "Project", project }
    return out
  })

  /** The owner of an automation the caller can reach: its own profile's routine, or one in a project on a board it can use. */
  const ownerOfStored = Effect.fnUntraced(function* (caller: McpCaller, a: StoredAutomation, ref: string) {
    if (a.project_id === null) {
      if (a.profile_id !== caller.profile.id) return yield* ToolError.notFound(`automation ${ref}`)
      const own: CreationRequest["owner"] = { _tag: "Profile", profile: caller.profile }
      return own
    }
    const found = yield* reach.project(caller, a.project_id, null).pipe(Effect.option)
    if (found._tag === "None") return yield* ToolError.notFound(`automation ${ref}`)
    const out: CreationRequest["owner"] = { _tag: "Project", project: found.value }
    return out
  })

  /** The automation a call names: by id, or by name among the caller's routines or a project's automations. */
  const resolve = Effect.fnUntraced(function* (
    caller: McpCaller,
    p: { readonly automation_id: string; readonly routines?: boolean; readonly project_id?: string; readonly profile?: string },
  ) {
    const ref = p.automation_id.trim()
    const byId = yield* repo.get(ref)
    if (byId !== null) return { automation: byId, owner: yield* ownerOfStored(caller, byId, ref) }
    if (wantsRoutines(caller, p)) {
      const own = yield* ownRoutines(caller, given(p.profile))
      const named = (yield* repo.listRoutines(own.id)).filter((a) => sameText(a.name, ref))
      const [first] = named
      if (first === undefined) return yield* ToolError.notFound(`routine ${ref} (use list_automations with routines=true)`)
      if (named.length > 1) return yield* ToolError.other(`there are several routines named ${ref}; give its id (see list_automations)`)
      const owner: CreationRequest["owner"] = { _tag: "Profile", profile: own }
      return { automation: first, owner }
    }
    const project = yield* reach.projectOrOwn(caller, given(p.project_id), given(p.profile))
    const named = (yield* repo.list(project.id)).filter((a) => sameText(a.name, ref))
    const [first] = named
    if (first === undefined) return yield* ToolError.notFound(`automation ${ref} in ${project.key} (use list_automations)`)
    if (named.length > 1) return yield* ToolError.other(`${project.key} has several automations named ${ref}; give its id (see list_automations)`)
    const owner: CreationRequest["owner"] = { _tag: "Project", project }
    return { automation: first, owner }
  })

  const listAutomations = boardTool(ListAutomations, (params, caller) =>
    Effect.gen(function* () {
      const owner = yield* ownerOf(caller, params)
      if (owner._tag === "Profile") {
        const found = yield* repo.listRoutines(owner.profile.id)
        return {
          profile: owner.profile.name,
          routines: yield* Effect.forEach(found, approvals.json, { concurrency: 1 }),
          time_zone: yield* automations.timeZone,
        }
      }
      const p = owner.project
      const found = yield* repo.list(p.id)
      return {
        project: { id: p.id, key: p.key, name: p.name },
        automations: yield* Effect.forEach(found, approvals.json, { concurrency: 1 }),
        time_zone: yield* automations.timeZone,
      }
    }),
  )

  const createAutomation = boardTool(
    CreateAutomation,
    (params, caller) =>
      toldAll(
        approvals.create(
          asker(caller),
          Effect.gen(function* () {
            const owner = yield* ownerOf(caller, params)
            const request: CreationRequest = {
              owner,
              name: params.name,
              trigger: yield* triggerOf(params.trigger),
              action: yield* actionOf(caller, owner, params.action, given(params.profile)),
              enabled: params.enabled ?? null,
              guards: guardsOf(params),
              generateSecret: params.generate_secret === true,
              reason: given(params.reason),
            }
            return request
          }),
        ),
      ),
    { keepNulls: true, prepare: keepGuardNulls },
  )

  const updateAutomation = boardTool(
    UpdateAutomation,
    (params, caller) =>
      toldAll(
        approvals.update(
          asker(caller),
          Effect.gen(function* () {
            const { automation, owner } = yield* resolve(caller, params)
            return {
              automation,
              owner,
              name: params.name ?? null,
              trigger: params.trigger === undefined ? null : yield* triggerOf(params.trigger),
              action: params.action === undefined ? null : yield* actionOf(caller, owner, params.action, given(params.profile)),
              enabled: params.enabled ?? null,
              guards: guardsOf(params),
              generateSecret: params.generate_secret === true,
              removeSecret: params.remove_secret === true,
              rotateUrl: params.rotate_url === true,
              reason: given(params.reason),
            }
          }),
        ),
      ),
    { keepNulls: true, prepare: keepGuardNulls },
  )

  const deleteAutomation = boardTool(DeleteAutomation, (params, caller) =>
    toldAll(
      approvals.delete(
        asker(caller),
        Effect.map(resolve(caller, params), ({ automation, owner }) => ({ automation, owner, reason: given(params.reason) })),
      ),
    ),
  )

  const runAutomation = boardTool(RunAutomation, (params, caller) =>
    toldAll(
      Effect.gen(function* () {
        const { automation } = yield* resolve(caller, params)
        return yield* automations.runNow(automation.id, { payload: params.payload, event: given(params.event) })
      }),
    ),
  )

  return { listAutomations, createAutomation, updateAutomation, deleteAutomation, runAutomation }
})

/** Null clears a guard; any other null is "not given". */
const GUARDS: ReadonlySet<string> = new Set(["active_hours", "precheck", "budget_usd"])
const keepGuardNulls = (args: Readonly<Record<string, unknown>>) => Object.fromEntries(Object.entries(args).filter(([k, v]) => v !== null || GUARDS.has(k)))
