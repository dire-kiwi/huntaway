import { DateTime, Effect, Result, Schema } from "effect"
import { Tool } from "effect/ai"
import { DocumentLabel, Effort, Resolution, Status } from "@huntaway/contracts"
import type { NewTask, Task, TaskPatch } from "@huntaway/contracts"
import { checkMarks, isMerged } from "../../tasks/checks.ts"
import { reaching } from "../../tasks/decide.ts"
import { checkPenName } from "../../tasks/penChecks.ts"
import { PenRepo } from "../../tasks/PenRepo.ts"
import { TaskRepo } from "../../tasks/TaskRepo.ts"
import { Tasks } from "../../tasks/Tasks.ts"
import { ProjectRepo } from "../../projects/ProjectRepo.ts"
import { Approvals } from "../../permissions/Approvals.ts"
import { Runs } from "../../runs/Runs.ts"
import { makeReach } from "../resolve.ts"
import { ApprovalKind, ForPlanning, ForReviewers, Rerunnable, ToolError } from "../tool.ts"
import type { McpCaller } from "../tool.ts"
import { asker, boardTool, given, Json, ProfileArg, TaskRefArg, told } from "./common.ts"
import { BAD_REMIND_AT, reminderTime } from "./reminders.ts"
import { field, makeTaskJson, overview, TASK_FIELD_DEFAULT_LIMIT, TASK_FIELD_MAX_LIMIT } from "./taskJson.ts"

// The board's task tools (docs/plan/inventory/03-mcp.md 2.5; the old mcp/schemas/tasks.ts and mcp/tools/local.ts):
// `list_tasks`, `get_task`, `get_task_field`, `create_task`, `update_task`, `delete_task` and `send_to_task`. Each
// handler finds what the agent names with `resolve.ts` and calls `Tasks` with the agent as the actor; `delete_task` asks
// the user first, through `Approvals`.

// ---- definitions --------------------------------------------------------------------------------------------------

const resolution = Resolution.annotate({ description: "How a done task ended. Only with status done; defaults to done." })
const labels = Schema.Array(DocumentLabel).annotate({
  description:
    "Documents the task's agent writes besides its other work, each shown in a tab of the task (get_task gives their files): 'plan', an HTML plan it writes first and iterates on with the user before doing the work; 'artifact', an HTML page (an explainer, dashboard or prototype); 'diagram', a Mermaid diagram. On update_task it replaces the task's labels; [] clears them.",
})
const dependsOnArg = Schema.Array(Schema.String).annotate({
  description:
    "Tasks in the same project (ids or keys like ABC-12) that have to be merged (done) before this task's agent starts. Until then, starting it queues it in in_progress. Replaces the task's current list; [] clears it.",
})
const startFrom = Schema.String.annotate({
  description:
    "What the task's git worktree starts from, before it's made (by default the project's base branch): another task's key (e.g. ABC-12), a branch (local or on the remote), a pull request (#12 or its URL), or a commit SHA. A task or pull request's branch is what this task's pull request targets and its changes are compared with. A task started from another task's branch lands on its own after that task: moved to ready_for_merge, it waits until that task is merged, then it's rebased onto where that went, its pull request retargeted, and it merges there. Once both tasks' pull requests are open on GitHub, the board links them into a stack there (GitHub's stacked pull requests: only then is it called stacked), and GitHub does that rebase; otherwise the board does. Prefix with task:, branch:, pr: or commit: if it could be read as another. Only before the task's branch exists; not for a subproject's tasks. Empty string resets it.",
})
const mergesInto = Schema.String.annotate({
  description:
    "Another task in the same project (its key, e.g. ABC-12) whose branch this task's work merges into, instead of the project's base branch: the way to split a piece of work into smaller tasks that each get reviewed and merged on their own, then land together with that task (unlike start_from another task, where each task lands on the base branch in turn). By default its worktree starts from that task's branch, and its pull request targets it; moved to ready_for_merge, it merges there (one at a time with the other tasks merging into the same task). Once that task is merged, it goes where that went. A task merges into one task at most; many can merge into one. Not once it's merging or done; empty string clears it.",
})
const starred = Schema.Boolean.annotate({ description: "Star the task (true) or unstar it (false): starred tasks are listed in the board's sidebar" })
const remindAt = Schema.String.annotate({
  description:
    "Remind the user of the task later: it's listed under Reminders in the board's sidebar, and shows as due from this time on. A delay from now (30m, 2h, 1d 12h, 1w), a time like 2026-05-01T09:00:00Z, or a date and time in the host's time zone (2026-05-01 09:00; a date alone means 9:00). Replaces any reminder it has; an empty string clears it.",
})
const reminder = Schema.String.annotate({
  description: "What the reminder is for, shown with it (with remind_at, or to change the note of the reminder the task has)",
})
const PROJECT_REF = "Project id, key or name (<profile>:<key> for another profile's board), or 'all'"
const pen = Schema.String.annotate({
  description:
    "Put the task in this pen (a named set of tasks the board shows as a tab, see list_pens), by its name; the pen is made if the profile has none by that name. A task is in one pen at most; an empty string takes it out of its pen.",
})
// A task's own model and effort, worded as an automation's create_task and update_project's model are.
const WHEN = "Set it only when the user asks or the task plainly calls for it; left out, the project's, profile's or board's default is used."
const NEXT_RUN =
  " Like the board's model picker, a change applies from the agent's next run: a run already going carries on with what it started with, and a task that has run picks it up with its next message."
const CLEARS = ` An empty string clears it back to the default.${NEXT_RUN}`
const taskModel = (clears: string) =>
  Schema.String.annotate({
    description:
      "The model the task's agent runs on: an alias (fable, opus, sonnet, haiku), a full Claude model id (e.g. claude-opus-5-5), or, for a task whose agent " +
      `config is Codex, a Codex model (e.g. gpt-5.5). ${WHEN}${clears}`,
  })
const effortDescription = (clears: string) =>
  "How hard the task's agent thinks (reasoning effort). Claude runs ultra as max and minimal as low; on Codex, an effort the model doesn't take gives " +
  `way to the model's own default. ${WHEN}${clears}`

export const ListTasks = Tool.make("list_tasks", {
  description:
    "List tasks. Defaults to the current project (or, for a subproject and its tasks, the subproject's tasks); pass project_id='all' for every project on your profile's board (with profile, on that board; profile='all' for every board you can use).",
  parameters: Schema.Struct({
    project_id: Schema.optionalKey(Schema.String.annotate({ description: PROJECT_REF })),
    profile: Schema.optionalKey(ProfileArg),
    status: Schema.optionalKey(Status),
    subproject: Schema.optionalKey(
      Schema.String.annotate({ description: "Only the tasks of this subproject (task id or key), 'none' for top-level tasks only, or 'all'" }),
    ),
    include_assistant: Schema.optionalKey(
      Schema.Boolean.annotate({ description: "Also list your profile's assistant (key A-<n>), which is left out otherwise" }),
    ),
    pen: Schema.optionalKey(
      Schema.String.annotate({
        description: "Only the tasks in this pen (its name or id), or 'none' for those in no pen. Without project_id, from every project on the board.",
      }),
    ),
  }),
  success: Json,
})
  .annotate(Rerunnable, true)
  .annotate(ForReviewers, true)
  .annotate(ForPlanning, true)

export const GetTask = Tool.make("get_task", {
  description:
    "Get a bounded overview of a task. Small fields are included inline; field_lengths lists every available field's length in Unicode characters, and omitted_fields names fields too large to include. Read any field (e.g. description, last_message, review, created_tasks) with get_task_field. Lengths count plain text for strings and pretty JSON for other values, including null.",
  parameters: Schema.Struct({ task_id: TaskRefArg, profile: Schema.optionalKey(ProfileArg) }),
  success: Json,
})
  .annotate(Rerunnable, true)
  .annotate(ForReviewers, true)
  .annotate(ForPlanning, true)

export const GetTaskField = Tool.make("get_task_field", {
  description:
    "Read one task field in bounded pages. Use a field name from get_task's field_lengths. Strings return plain text; other values return pretty JSON (format says which). offset, limit, length and total_length count Unicode characters, starting at offset 0. Follow next_offset until null; an offset at or past the end returns empty content. Reads use the current field value, so a task changing between calls may change the pages.",
  parameters: Schema.Struct({
    task_id: TaskRefArg,
    profile: Schema.optionalKey(ProfileArg),
    field: Schema.String.annotate({
      description: "Top-level field name from get_task's field_lengths (e.g. description, last_message, review or created_tasks)",
    }),
    offset: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).annotate({ default: 0, description: "Zero-based character offset" })),
    limit: Schema.optionalKey(
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: TASK_FIELD_MAX_LIMIT })).annotate({
        default: TASK_FIELD_DEFAULT_LIMIT,
        description: "Maximum number of characters to return",
      }),
    ),
  }),
  success: Json,
})
  // Read-only, so safe to run again (the old list left it out, which the inventory calls a gap).
  .annotate(Rerunnable, true)
  .annotate(ForReviewers, true)
  .annotate(ForPlanning, true)

export const CreateTask = Tool.make("create_task", {
  description:
    'Create a task on the board. By default its agent starts straight away (in its own git worktree by default) and the task moves to in_progress; with depends_on, it\'s queued in in_progress and its agent starts once those tasks are merged. Pass start=false only when the user asks for the task not to be started (e.g. "add a task but don\'t start it", "put it in the backlog", "just note it"): it then waits in todo for the user. A task created with a status other than todo or in_progress (backlog or done, say) isn\'t started unless you pass start=true. A task in another profile\'s project runs under that profile\'s Claude config and login.',
  parameters: Schema.Struct({
    title: Schema.String,
    description: Schema.optionalKey(Schema.String.annotate({ description: "Full instructions for the agent that will work on it (markdown)" })),
    project_id: Schema.optionalKey(
      Schema.String.annotate({
        description: "Defaults to the current project. Also takes a key or name, or <profile>:<key> for a project on another profile's board (e.g. work:SD)",
      }),
    ),
    profile: Schema.optionalKey(ProfileArg),
    status: Schema.optionalKey(Status),
    resolution: Schema.optionalKey(resolution),
    use_worktree: Schema.optionalKey(Schema.Boolean),
    model: Schema.optionalKey(taskModel("")),
    effort: Schema.optionalKey(Effort.annotate({ description: effortDescription("") })),
    start: Schema.optionalKey(
      Schema.Boolean.annotate({
        description:
          "Whether to start the task's agent now. Defaults to true (false with a status other than todo or in_progress, such as backlog): pass false only when the user asks for the task not to be started.",
      }),
    ),
    subproject: Schema.optionalKey(
      Schema.String.annotate({
        description:
          "Add the task to this existing subproject (task id or key): it branches from the subproject's branch and merges back into it. Defaults to your own subproject, if you're in one; 'none' for a top-level task. New subprojects can't be made: for new work, use merges_into.",
      }),
    ),
    labels: Schema.optionalKey(labels),
    type: Schema.optionalKey(
      Schema.Literal("scratch").annotate({
        description:
          "'scratch' for a scratch task, whose agent works in its own folder for whatever the user asks, without a worktree, branch or merge: in no project (keyed S-<n>) unless you give project_id or subproject, where it can read the repository (and the subproject's worktree). Leave out for a normal task.",
      }),
    ),
    depends_on: Schema.optionalKey(dependsOnArg),
    start_from: Schema.optionalKey(startFrom),
    merges_into: Schema.optionalKey(mergesInto),
    starred: Schema.optionalKey(starred),
    remind_at: Schema.optionalKey(remindAt),
    reminder: Schema.optionalKey(reminder),
    pen: Schema.optionalKey(pen),
  }),
  success: Json,
})

export const UpdateTask = Tool.make("update_task", {
  description:
    "Update a task's title, description, status (and, for a done task, its resolution), pull request, preview URL, labels, model and effort, dependencies, the task it merges into, or what its worktree starts from (before it's made), star it, or set a reminder to come back to it later (remind_at, e.g. when the user asks to be reminded or work has to wait until a later date). Moving a task to ready_for_merge asks its agent to merge its work (where merges need the user's approval, to summarize it first, and to merge once the user approves), after which the agent sets it to done (a task with no changes to merge goes straight to done). Tasks merge one at a time: a merge that needs changes moves its task to in_progress with remerge, to let the next task merge while it makes them. Moving a todo or backlog task that hasn't run yet to in_progress starts its agent, as dragging it there on the board does (queued, if what it depends on isn't merged yet); to start or resume one that has run, use send_to_task. A task in in_progress whose agent's todo list (TodoWrite, or its plan) has unfinished items can't leave it, except for needs_attention, until the list is complete: finish them, or mark them completed if they no longer apply.",
  parameters: Schema.Struct({
    task_id: TaskRefArg,
    profile: Schema.optionalKey(ProfileArg),
    title: Schema.optionalKey(Schema.String),
    description: Schema.optionalKey(Schema.String),
    status: Schema.optionalKey(Status),
    resolution: Schema.optionalKey(resolution),
    pr_url: Schema.optionalKey(
      Schema.String.annotate({ description: "The task's pull request; the board links it from the task's card. Empty string clears it." }),
    ),
    preview_url: Schema.optionalKey(
      Schema.String.annotate({
        description:
          "Where the task's work can be tried (e.g. its PR's preview deployment); the board shows whether it's up. A project that previews its pull requests fills it in from pr_url. Empty string clears it.",
      }),
    ),
    labels: Schema.optionalKey(labels),
    model: Schema.optionalKey(taskModel(CLEARS)),
    // The empty string too, where it clears it.
    effort: Schema.optionalKey(Schema.Literals([...Effort.literals, ""]).annotate({ description: effortDescription(CLEARS) })),
    remerge: Schema.optionalKey(
      Schema.Boolean.annotate({
        description:
          "With status in_progress, on a task that's merging: it steps out of the merge queue so the next task can merge, and rejoins the end of the queue when its agent's run ends, rather than going to in_review.",
      }),
    ),
    depends_on: Schema.optionalKey(dependsOnArg),
    start_from: Schema.optionalKey(startFrom),
    merges_into: Schema.optionalKey(mergesInto),
    starred: Schema.optionalKey(starred),
    remind_at: Schema.optionalKey(remindAt),
    reminder: Schema.optionalKey(reminder),
    pen: Schema.optionalKey(pen),
  }),
  success: Json,
})

export const SendToTask = Tool.make("send_to_task", {
  description:
    "Send a message to a task's agent, starting or resuming it. If that agent is currently running, the message goes to it straight away and it reads it after its current step (or, if it can't take messages while it works, it's queued and delivered when its run ends).",
  parameters: Schema.Struct({ task_id: TaskRefArg, profile: Schema.optionalKey(ProfileArg), message: Schema.String }),
  success: Json,
})

export const DeleteTask = Tool.make("delete_task", {
  description:
    "Delete a task: stop its agent, delete its thread and remove its worktree, discarding uncommitted changes (a subproject's tasks go with it). " +
    "It asks the user to confirm first (say why in reason): the call waits for their answer, and if they don't confirm, nothing is deleted. " +
    "Only when the user asks for it, or a task you created is no longer wanted; you can't delete your own task or the subproject you're in. " +
    "To close a task while keeping it, set it to done (with a resolution) with update_task instead.",
  parameters: Schema.Struct({
    task_id: TaskRefArg,
    profile: Schema.optionalKey(ProfileArg),
    delete_branch: Schema.optionalKey(
      Schema.Boolean.annotate({ description: "Also delete the task's git branch (and its tasks' branches, for a subproject); kept by default" }),
    ),
    reason: Schema.optionalKey(Schema.String.annotate({ description: "Why it should be deleted, shown to the user when they're asked to confirm" })),
  }),
  success: Json,
}).annotate(ApprovalKind, "delete_task")

// ---- handlers -----------------------------------------------------------------------------------------------------

/** What an agent is told when it asked for a task to start on a host where agents can't. */
export const NOT_STARTED = "The task wasn't started: this host can't run agents (it has no claude or codex CLI, or no ia-shim)."

/**
 * Whether `create_task` starts its new task's agent when it's given no `start`: it does, unless the task is created
 * somewhere that isn't waiting for an agent (a status other than todo or in_progress, e.g. backlog or done). `status:
 * todo` isn't an opt-out: it's where tasks go by default.
 */
export const startsByDefault = (status: Task["status"] | undefined): boolean => status === undefined || status === "todo" || status === "in_progress"

/** `starred`, `remind_at` and `reminder` as the agent gave them, with the time made absolute; the API checks the rest. */
const marksOf = (params: { readonly starred?: boolean; readonly remind_at?: string; readonly reminder?: string }, now: DateTime.Utc) =>
  Effect.gen(function* () {
    const patch: { starred?: boolean; remind_at?: string; reminder?: string } = {}
    if (params.starred !== undefined) patch.starred = params.starred
    if (params.reminder !== undefined) patch.reminder = params.reminder
    if (params.remind_at !== undefined) {
      const at = reminderTime(params.remind_at, now, DateTime.zoneMakeLocal())
      if (at === null) return yield* ToolError.other(BAD_REMIND_AT)
      patch.remind_at = at
    }
    return patch
  })

/** The caller's agent, as the actor of what it changes. */
const agent = (caller: McpCaller) => ({ _tag: "Agent", task_id: caller.task?.id ?? null }) as const

/** The task tools' handlers, in the order runs are shown them. */
export const taskTools = Effect.gen(function* () {
  const reach = yield* makeReach
  const json = yield* makeTaskJson(reach)
  const tasks = yield* Tasks
  const repo = yield* TaskRepo
  const pens = yield* PenRepo
  const projects = yield* ProjectRepo
  const runs = yield* Runs
  const approvals = yield* Approvals

  /** The pen whose own thread the caller is: where its new tasks go, and whose tasks it lists, by default. */
  const ownPen = Effect.fnUntraced(function* (caller: McpCaller, profile: string | null) {
    if (profile !== null || caller.task === null || caller.task.task_type !== "pen") return null
    const own = caller.task.id
    return (yield* pens.all).find((p) => p.thread_id === own) ?? null
  })

  /** The tasks a `depends_on` names (ids or keys), as ids. */
  const dependencyIds = (caller: McpCaller, refs: ReadonlyArray<string> | undefined, profile: string | null) =>
    refs === undefined ? Effect.undefined : Effect.forEach(refs, (r) => Effect.map(reach.task(caller, r, profile), (t) => t.id), { concurrency: 1 })

  /** The task a `merges_into` names (an id or key), as its id; null for none (blank). */
  const mergeTarget = (caller: McpCaller, v: string | undefined, profile: string | null) =>
    v === undefined ? Effect.undefined : v.trim() === "" ? Effect.succeed(null) : Effect.map(reach.task(caller, v.trim(), profile), (t) => t.id)

  /** A subproject named by an agent: there are none any more, so only "not a subproject". */
  const subproject = (caller: McpCaller, ref: string, profile: string | null) =>
    Effect.flatMap(reach.task(caller, ref, profile), () => Effect.fail(ToolError.other(`${ref} is not a subproject`)))

  /** Which tasks are in pen `name` (a name or id) on the boards `profile` picks, or with "none" in no pen. */
  const penFilter = Effect.fnUntraced(function* (caller: McpCaller, name: string, profile: string | null) {
    if (name.toLowerCase() === "none") return (t: Task) => t.pen_id === null
    const ids = new Set<string>()
    for (const b of yield* reach.pickBoards(caller, profile)) {
      const p = (yield* pens.get(name)) ?? (yield* pens.byName(b.id, name))
      if (p !== null && p.profile_id === b.id) ids.add(p.id)
    }
    if (ids.size === 0) return yield* ToolError.notFound(`pen ${name}`)
    return (t: Task) => t.pen_id !== null && ids.has(t.pen_id)
  })

  const listTasks = boardTool(ListTasks, (params, caller) =>
    Effect.gen(function* () {
      const profile = given(params.profile)
      const projectId = given(params.project_id)
      const sp = given(params.subproject)
      // Subprojects are gone: "none" is every task (they're all top-level), "all" too, and a named one is refused.
      if (sp !== null && sp !== "all" && sp !== "none") return yield* subproject(caller, sp, profile)
      // A pen's thread lists its pen's tasks unless it asks for others.
      const own = yield* ownPen(caller, profile)
      const penName = given(params.pen) ?? (own !== null && projectId === null && sp === null ? own.id : null)
      // A pen's tasks are from every project, unless it's given one.
      const pid = projectId ?? (penName !== null || profile !== null ? null : (caller.task?.project_id ?? null))
      let list: ReadonlyArray<Task>
      if (pid === null || pid === "all") {
        // Every task on the named board(s), else on the caller's own.
        const boards = yield* reach.ownBoards(caller, profile)
        const found: Array<Task> = []
        for (const b of boards) {
          const archived = new Set((yield* projects.list(b.id)).filter((p) => p.archived_at !== null).map((p) => p.id))
          // The assistant only when asked for, and only the caller's own.
          const assistant = params.include_assistant === true && b.id === caller.profile.id
          const all = yield* repo.list({ _tag: "ByProfile", profile_id: b.id, include_assistant: assistant })
          found.push(...all.filter((t) => t.project_id === null || !archived.has(t.project_id)))
        }
        list = found
      } else {
        const p = yield* reach.project(caller, pid, profile)
        list = yield* repo.list({ _tag: "ByProject", project_id: p.id, kind: "task" })
      }
      if (penName !== null) {
        const inPen = yield* penFilter(caller, penName, profile)
        list = list.filter(inPen)
      }
      const status = params.status
      return yield* Effect.forEach(
        list.filter((t) => status === undefined || t.status === status),
        json.summarize,
        { concurrency: 1 },
      )
    }),
  )

  const getTask = boardTool(GetTask, (params, caller) =>
    Effect.gen(function* () {
      const t = yield* reach.task(caller, params.task_id, given(params.profile))
      return yield* overview(yield* json.details(caller, t))
    }),
  )

  const getTaskField = boardTool(
    GetTaskField,
    (params, caller) =>
      Effect.gen(function* () {
        const t = yield* reach.task(caller, params.task_id, given(params.profile))
        return yield* field(yield* json.details(caller, t), params.field, params.offset ?? 0, params.limit ?? TASK_FIELD_DEFAULT_LIMIT)
      }),
    // A null offset or limit is refused, as before, rather than read as the default.
    { keepNulls: true },
  )

  /** Task `t`, just made, in pen `name`, or (none given) in the caller's own pen if it's on the same board. */
  const intoPen = Effect.fnUntraced(function* (caller: McpCaller, t: Task, name: string | null, givenPen: string | undefined, profile: string | null) {
    if (name !== null) return yield* tasks.update(t.id, { pen: name }, agent(caller))
    const own = yield* ownPen(caller, profile)
    if (givenPen !== undefined || own === null || own.profile_id !== t.profile_id) return t
    return yield* tasks.update(t.id, { pen_id: own.id }, agent(caller))
  })

  const createTask = boardTool(CreateTask, (params, caller) =>
    Effect.gen(function* () {
      const profile = given(params.profile)
      // Said outright, so that a task created somewhere that isn't waiting for an agent isn't started.
      const start = params.start ?? startsByDefault(params.status)
      // The star, reminder and pen are checked before the task is made: a call that fails leaves nothing behind for a
      // retry to duplicate.
      const marks = yield* marksOf(params, yield* DateTime.now)
      const checked = checkMarks(null, marks)
      if (Result.isFailure(checked)) return yield* ToolError.other(checked.failure.reason)
      const penName = params.pen === undefined || params.pen === "" ? null : checkPenName(params.pen)
      if (penName !== null && Result.isFailure(penName)) return yield* ToolError.other(penName.failure.reason)
      const fields = {
        title: params.title,
        description: params.description ?? "",
        ...(params.status === undefined ? {} : { status: params.status }),
        ...(params.resolution === undefined ? {} : { resolution: params.resolution }),
        model: given(params.model),
        effort: params.effort ?? null,
        ...(params.labels === undefined ? {} : { labels: params.labels }),
      }
      const sp = given(params.subproject)
      let input: NewTask
      if (params.type === "scratch" && given(params.project_id) === null && (sp === null || sp === "none")) {
        // A scratch task is in no project unless it's given one, on the caller's own board unless it names another.
        const boards = yield* reach.pickBoards(caller, profile)
        const board = profile === null ? (boards.find((b) => b.id === caller.profile.id) ?? boards[0]) : boards[0]
        if (board === undefined) return yield* ToolError.notFound("your profile's board")
        input = { ...fields, profile_id: board.id }
      } else {
        if (sp !== null && sp !== "none") return yield* subproject(caller, sp, profile)
        const project = yield* reach.projectOrOwn(caller, given(params.project_id), profile)
        const dependsOn = yield* dependencyIds(caller, params.depends_on, profile)
        const into = yield* mergeTarget(caller, params.merges_into, profile)
        input = {
          ...fields,
          project_id: project.id,
          ...(params.type === undefined ? {} : { task_type: params.type }),
          ...(params.use_worktree === undefined ? {} : { use_worktree: params.use_worktree }),
          ...(dependsOn === undefined ? {} : { depends_on: dependsOn }),
          ...(params.start_from === undefined ? {} : { start_from: params.start_from }),
          ...(into === undefined ? {} : { merges_into: into }),
        }
      }
      let t = yield* tasks.create(input, agent(caller))
      if (Object.keys(marks).length > 0) t = yield* tasks.update(t.id, marks, agent(caller))
      t = yield* intoPen(caller, t, penName === null ? null : penName.success, params.pen, profile)
      // Its agent starts (or it's queued for what it depends on). Refused, the task is made all the same and the agent
      // told why it didn't start, rather than given an error it might make the task again for.
      let note: string | null = null
      if (start) {
        const sent = yield* Effect.result(runs.send(t.id, { text: "", source: "agent" }))
        if (Result.isSuccess(sent)) t = sent.success
        else if (sent.failure._tag === "SendRefused")
          note = sent.failure.reason === "no_agents" ? NOT_STARTED : `The task was made, but not started: ${sent.failure.detail}`
        else return yield* sent.failure
      }
      const v = yield* json.summarize(t)
      if (note !== null) v["note"] = note
      return v
    }).pipe(told),
  )

  const updateTask = boardTool(UpdateTask, (params, caller) =>
    Effect.gen(function* () {
      const profile = given(params.profile)
      const found = yield* reach.task(caller, params.task_id, profile)
      const patch: { -readonly [K in keyof TaskPatch]?: TaskPatch[K] } = {}
      if (params.title !== undefined) patch.title = params.title
      if (params.description !== undefined) patch.description = params.description
      if (params.status !== undefined) patch.status = params.status
      if (params.resolution !== undefined) patch.resolution = params.resolution
      if (params.preview_url !== undefined) patch.preview_url = params.preview_url
      if (params.pr_url !== undefined) patch.pr_url = params.pr_url
      if (params.remerge !== undefined) patch.remerge = params.remerge
      if (params.labels !== undefined) patch.labels = params.labels
      if (params.start_from !== undefined) patch.start_from = params.start_from
      // Blank goes back to the default, as the board's model picker sends it.
      if (params.model !== undefined) patch.model = params.model === "" ? null : params.model
      if (params.effort !== undefined) patch.effort = params.effort === "" ? null : params.effort
      const dependsOn = yield* dependencyIds(caller, params.depends_on, profile)
      if (dependsOn !== undefined) patch.depends_on = dependsOn
      Object.assign(patch, yield* marksOf(params, yield* DateTime.now))
      if (params.pen !== undefined) patch.pen = params.pen
      const into = yield* mergeTarget(caller, params.merges_into, profile)
      if (into !== undefined) patch.merges_into = into
      // Not out of In progress while its todo list isn't complete: `Tasks` holds an agent to that.
      let t = yield* tasks.update(found.id, patch, agent(caller))
      // Moved into In progress from To do or the backlog before it has run, its agent starts, as when the user drags it
      // there (one waiting for what it depends on stays queued). One that has run (parked back in To do, say) isn't:
      // its session would be resumed with an empty prompt.
      const starts =
        params.status === "in_progress" &&
        (found.status === "todo" || found.status === "backlog") &&
        t.kind === "task" &&
        t.session_id === null &&
        t.status === "in_progress" &&
        !t.waiting &&
        t.id !== caller.task?.id &&
        !(yield* runs.isRunning(t.id))
      if (starts) {
        // On a host that can't run agents, it's left in In progress, as before.
        t = yield* runs.send(t.id, { text: "", source: "agent" }).pipe(
          Effect.catchIf(
            (e) => e._tag === "SendRefused" && e.reason === "no_agents",
            () => Effect.succeed(t),
          ),
        )
      }
      const v = yield* json.summarize(t)
      // Closed without being merged, the tasks merging into it wait for the user to say where they go.
      const held = t.status === "done" && !isMerged(t) && t.project_id !== null ? reaching(yield* repo.projectTasks(t.project_id), t.id) : []
      if (held.length > 0) {
        v["note"] =
          `Tasks merge into this one and aren't done: ${held.map((x) => x.key).join(", ")}. Their merges wait until the user says where ` +
          "they go now (where this task was going, one of them in its place, or closed too): ask the user with request_user_input, then set " +
          "merges_into on each with update_task, or leave it to them on the board."
      }
      return v
    }).pipe(told),
  )

  const sendToTask = boardTool(SendToTask, (params, caller) =>
    Effect.gen(function* () {
      const found = yield* reach.task(caller, params.task_id, given(params.profile))
      if (found.id === caller.task?.id) return yield* ToolError.other("cannot send a message to your own task")
      return yield* json.summarize(yield* runs.send(found.id, { text: params.message, source: "agent" }))
    }).pipe(told),
  )

  const deleteTask = boardTool(DeleteTask, (params, caller) =>
    // Read only when the call hasn't asked before: a retried call carries on with the deletion it asked about.
    approvals
      .deleteTask(
        asker(caller),
        Effect.map(reach.task(caller, params.task_id, given(params.profile)), (task) => ({
          task,
          deleteBranch: params.delete_branch === true,
          reason: given(params.reason),
        })),
      )
      .pipe(told),
  )

  return { listTasks, getTask, getTaskField, createTask, updateTask, deleteTask, sendToTask }
})
