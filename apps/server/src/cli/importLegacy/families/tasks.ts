import { Effect, Schema, Struct } from "effect"
import {
  Carries,
  ChangeSummary,
  Context,
  DocumentLabel,
  Effort,
  ExternalLink,
  PermissionMode,
  PrChecks,
  Review,
  Rewind,
  StartFrom,
  TaskId,
  threadKindOf,
  Timestamp,
  Todo,
  TrackedItem,
} from "@huntaway/contracts"
import { encodeColumns } from "../../../platform/columns.ts"
import { PenRow } from "../../../tasks/PenRepo.ts"
import { QueueRows, TaskRow } from "../../../tasks/TaskRepo.ts"
import type { MessageSource, QueuedRow } from "../../../tasks/TaskRepo.ts"
import { decodeOld, issueText, keyOf } from "../family.ts"
import type { Family, NewRow, TableCheck } from "../family.ts"
import { convertPen, OldPen } from "./pens.ts"
import {
  OldCarries,
  OldContext,
  OldExternalLink,
  OldPrChecks,
  OldReview,
  OldRewind,
  OldStartFrom,
  OldSteer,
  OldStrings,
  OldSummaries,
  OldTodo,
  OldTrackedItem,
  readJson,
} from "./taskJson.ts"

// `tasks` → `tasks`, `task_queue`, and `pens` → `pens` (docs/plan/11-migration.md, Tasks). Columns by name; `summary`
// becomes `summaries`; the queue's columns become `task_queue` rows; no run is live, so the run state is reset and a task
// left in In progress with nothing queued needs attention; subprojects become ordinary tasks and their tasks lose
// `parent_id`; and the legacy forms of docs/plan/inventory/09-data-model.md, section 9, are read: scratch chats
// (`kind='scratch'`), plan/artifact/diagram task types, `work_dir` relative to the old data folder, a summary kept as one
// object, and JSON values from before their newer fields.

const def = <S extends Schema.Top & { readonly DecodingServices: never; readonly EncodingServices: never }>(schema: S, value: S["Encoded"]) =>
  schema.pipe(Schema.withDecodingDefaultKey(Effect.succeed(value)))
const Text = def(Schema.NullOr(Schema.String), null)
const Bit = def(Schema.Finite, 0)

/**
 * An old `tasks` row, as it is there: every column a database at version 130 may lack (named migrations, branch builds)
 * defaults as its migration added it. `thread_items`, `thread_source`, `now_at` and `subproject`'s siblings that are
 * dropped are not read.
 */
export const OldTask = Schema.Struct({
  id: Schema.String,
  profile_id: Schema.String,
  project_id: Text,
  kind: Schema.Literals(["task", "review", "scratch"]),
  parent_id: Text,
  subproject: Bit,
  group_name: Text,
  created_by: Text,
  task_type: Text,
  labels: Text,
  work_dir: Text,
  document_at: Text,
  number: Schema.Int,
  pen_id: Text,
  fanout_id: Text,
  position: Schema.Finite,
  title: Schema.String,
  title_pinned: Bit,
  description: def(Schema.String, ""),
  status: Schema.String,
  resolution: Text,
  done_at: Text,
  attention_reason: Text,
  starred: Bit,
  remind_at: Text,
  reminder: Text,
  preview_url: Text,
  pr_url: Text,
  pr_checks: Text,
  external_links: Text,
  todos: Text,
  tracked: Text,
  context: Text,
  context_detail: Text,
  cost_usd: def(Schema.Finite, 0),
  last_activity_at: Schema.String,
  created_at: Schema.String,
  updated_at: Schema.String,
  use_worktree: Bit,
  worktree_path: Text,
  branch: Text,
  base_branch: Text,
  worktree_state: def(Schema.String, "none"),
  worktree_error: Text,
  start_from: Text,
  merges_into: Text,
  carries: Text,
  restack: Text,
  github_stack: def(Schema.NullOr(Schema.Finite), null),
  stack_title: Text,
  stack_description: Text,
  stack_pinned: Bit,
  stack_input: Text,
  stack_run: Text,
  merging: Bit,
  remerge: Bit,
  merge_approval: Text,
  depends_on: Text,
  waiting: Bit,
  session_id: Text,
  run_started_at: Text,
  limit_reset_at: Text,
  lost_background: Text,
  queued_message: Text,
  queued_user_text: Text,
  queued_from_agent: Bit,
  queued_routine: Bit,
  queued_routine_runs: Text,
  steering: Text,
  model: Text,
  effort: Text,
  permission_mode: Text,
  claude_config_id: Text,
  auto_allow: Text,
  review: Text,
  summary: Text,
  rewind: Text,
})
export type OldTask = typeof OldTask.Type

/** The reason a task the move left in In progress, with nothing to send it, needs attention. */
export const INTERRUPTED = "Interrupted by the move to the new server"

// ---- the queue --------------------------------------------------------------------------------------------------

/** What an old task had queued: its `queued_*` columns, and the steers its run never took in. */
export interface OldQueue {
  readonly message: string | null
  /** The user's own parts of `message` (`queued_user_text`). */
  readonly userText: string | null
  readonly fromAgent: boolean
  readonly routine: boolean
  /** The automation runs the queued text carries, or parked with no text (`queued_routine_runs`). */
  readonly routineRuns: ReadonlyArray<string>
  readonly steers: ReadonlyArray<typeof OldSteer.Type>
}

const sourceOf = (routine: boolean, fromAgent: boolean): MessageSource => (routine ? "routine" : fromAgent ? "agent" : "user")
const join = (a: string, b: string) => (a === "" ? b : b === "" ? a : `${a}\n\n${b}`)
const row = (text: string, source: MessageSource, automation_run_id: string | null = null): QueuedRow => ({ text, source, automation_run_id })

/**
 * Automation runs as parked rows (no text, the run charged with whichever run takes them, as `Runs.send` parks an
 * automation's start of a task it made). With other agents' text only, they take its source, so they don't make what is
 * sent read as the user's; otherwise they are an automation's (`fromAgent` reads an empty automation part as nobody's).
 */
const parked = (runs: ReadonlyArray<string>, text: ReadonlyArray<QueuedRow>): ReadonlyArray<QueuedRow> => {
  const first = text[0]
  const source = first !== undefined && text.every((r) => r.source !== "user") ? first.source : "automation"
  return runs.map((run) => row("", source, run))
}

/**
 * The `task_queue` rows of an old task's queue, in order: the steers its run never took in first (a run's end puts them
 * ahead of what is queued), then the queued text, then its automation runs as parked rows. The queued text is one row,
 * from a routine if `queued_routine`, another agent if `queued_from_agent`, else the user; when the user's part differs
 * from the whole, the user's part and the rest are two rows in that order (the rest from another agent). A user's part
 * not found whole in the text (their parts were between others') leaves the text one row, the user's.
 */
export const queueOf = (q: OldQueue): ReadonlyArray<QueuedRow> => {
  const steered = q.steers.flatMap((s) => {
    const text = s.text.trim()
    const own = text === "" ? [] : [row(text, sourceOf(s.routine, s.from_agent))]
    return [...own, ...parked(s.routine_runs, own)]
  })
  const text = q.message?.trim() ?? ""
  const user = q.userText?.trim() ?? ""
  const queued: Array<QueuedRow> = []
  if (text !== "") {
    const at = user === "" ? -1 : text.indexOf(user)
    if (user === "") queued.push(row(text, sourceOf(q.routine, q.fromAgent)))
    else if (user === text || at < 0) queued.push(row(text, "user"))
    else {
      queued.push(row(user, "user"))
      const rest = join(text.slice(0, at).trim(), text.slice(at + user.length).trim())
      if (rest !== "") queued.push(row(rest, "agent"))
    }
  }
  return [...steered, ...queued, ...parked(q.routineRuns, queued)]
}

// ---- a task -----------------------------------------------------------------------------------------------------

/** What the conversion knows besides the task rows: the old data folder and the old projects. */
export interface TaskFacts {
  readonly oldDataDir: string
  /** The old projects' keys and scratch folders, by id. */
  readonly projects: ReadonlyMap<string, { readonly key: string; readonly scratch_path: string }>
}

/** A task as it is written: its key for the report, its columns (JSON values as values), and its queue. */
export interface ConvertedTask {
  readonly id: string
  readonly key: string
  readonly columns: Readonly<Record<string, unknown>>
  readonly queue: ReadonlyArray<QueuedRow>
  /** When its queue rows were queued, as near as the old row says: when the task last changed. */
  readonly queuedAt: string
}

/** A note for the report on a task (`key`, or `key.column`). */
export interface TaskNote {
  readonly key: string
  readonly text: string
}

/** A path as the new board stores it: absolute, a path relative to the old data folder made so (`~` paths stay, as the server expands them). */
export const absolutePath = (path: string, oldDataDir: string): string =>
  path.startsWith("/") || path === "~" || path.startsWith("~/") ? path : `${oldDataDir}/${path.replace(/^(\.\/)+/u, "")}`

const DOCUMENT_TYPES: ReadonlySet<string> = new Set(["plan", "artifact", "diagram"])
const S_FAMILY: ReadonlySet<string> = new Set(["scratch", "pens", "pen"])
const EFFORTS: ReadonlySet<string> = new Set(Effort.literals)
const MODES: ReadonlySet<string> = new Set(PermissionMode.literals)

const readers = {
  labels: readJson(OldStrings, []),
  depends_on: readJson(OldStrings, []),
  auto_allow: readJson(OldStrings, []),
  pr_checks: readJson(OldPrChecks, null),
  external_links: readJson(Schema.Array(OldExternalLink), []),
  todos: readJson(Schema.Array(OldTodo), []),
  tracked: readJson(Schema.Array(OldTrackedItem), []),
  context: readJson(OldContext, null),
  start_from: readJson(OldStartFrom, null),
  carries: readJson(OldCarries, null),
  review: readJson(OldReview, null),
  summaries: readJson(OldSummaries, []),
  rewind: readJson(OldRewind, null),
  lost_background: readJson(Schema.Array(Schema.Unknown), []),
  steering: readJson(Schema.Array(OldSteer), []),
  routine_runs: readJson(OldStrings, []),
}

/** The old key of a task, for the report: its project's key and number, else its id (as `run.ts` `taskKeySql`). */
const oldKey = (t: OldTask, facts: TaskFacts) => {
  const project = t.project_id === null ? undefined : facts.projects.get(t.project_id)
  return project === undefined ? t.id : `${project.key}-${t.number}`
}

const bit = (n: number) => (n !== 0 ? 1 : 0)

/** One old task as the new board keeps it, with the notes it gives. `subprojects` are the ids of the old subprojects. */
export const convertTask = (
  t: OldTask,
  facts: TaskFacts,
  subprojects: ReadonlySet<string>,
): { readonly task: ConvertedTask; readonly notes: ReadonlyArray<TaskNote> } => {
  const key = oldKey(t, facts)
  const notes: Array<TaskNote> = []
  const read = <K extends keyof typeof readers>(column: K, text: string | null): ReturnType<(typeof readers)[K]>["value"] => {
    const result = readers[column](text)
    if (result.problem !== null) notes.push({ key: `${key}.${column}`, text: `the old board read it as empty too: ${result.problem}` })
    return result.value
  }
  const summaries = read("summaries", t.summary)
  const steers = read("steering", t.steering) ?? []
  const queue = queueOf({
    message: t.queued_message,
    userText: t.queued_user_text,
    fromAgent: t.queued_from_agent !== 0,
    routine: t.queued_routine !== 0,
    routineRuns: read("routine_runs", t.queued_routine_runs) ?? [],
    steers,
  })
  // Plan, artifact and diagram tasks became labels (migration 59), working in their own folder.
  const documentType = t.task_type !== null && DOCUMENT_TYPES.has(t.task_type) ? t.task_type : null
  const labels = [...(read("labels", t.labels) ?? [])]
  if (documentType !== null && !labels.includes(documentType)) labels.push(documentType)
  // A scratch chat (before migration 43): a scratch task in no project, done, working in its project's scratch folder
  // or its profile's. Its number and position are given with the others' (`convertTasks`).
  const chat = t.kind === "scratch"
  const kind = chat ? "task" : t.kind
  const taskType = chat ? "scratch" : documentType !== null ? null : t.task_type
  const chatFolder = chat && t.project_id !== null ? (facts.projects.get(t.project_id)?.scratch_path ?? "") : ""
  let workDir = chat
    ? chatFolder !== ""
      ? chatFolder
      : `profiles/${t.profile_id}/scratch`
    : (t.work_dir ?? (documentType !== null ? `documents/${t.id}` : null))
  // A scratch task's and a pen's thread's folder was the task's own in the old data folder when it had none.
  if (workDir === null && kind === "task" && (taskType === "scratch" || taskType === "pen")) workDir = `documents/${t.id}`
  // A task inside a subproject loses `parent_id`; review threads and routine threads keep theirs.
  const parent = kind === "task" && t.parent_id !== null && subprojects.has(t.parent_id) ? null : t.parent_id
  const effort = t.effort === null || t.effort === "" ? null : EFFORTS.has(t.effort) ? t.effort : null
  if (t.effort !== null && t.effort !== "" && effort === null) notes.push({ key: `${key}.effort`, text: `"${t.effort}" is no effort: read as the default` })
  const mode = t.permission_mode !== null && MODES.has(t.permission_mode) ? t.permission_mode : null
  if (t.permission_mode !== null && mode === null)
    notes.push({ key: `${key}.permission_mode`, text: `"${t.permission_mode}" is no permission mode: read as inherited` })
  // No run is live: a task left in In progress with nothing to send needs attention, as a restart does.
  const queued = queue.some((q) => q.text !== "")
  const interrupted = kind === "task" && t.status === "in_progress" && !queued && !chat
  const status = chat ? "done" : interrupted ? "needs_attention" : t.status
  const columns: Record<string, unknown> = {
    id: t.id,
    profile_id: t.profile_id,
    project_id: chat ? null : t.project_id,
    kind,
    parent_id: parent,
    group_name: t.group_name,
    created_by: t.created_by,
    task_type: taskType,
    labels,
    work_dir: workDir === null ? null : absolutePath(workDir, facts.oldDataDir),
    document_at: t.document_at,
    number: t.number,
    pen_id: t.pen_id,
    fanout_id: t.fanout_id,
    position: t.position,
    title: t.title,
    title_pinned: bit(t.title_pinned),
    description: t.description,
    status,
    resolution: chat ? (t.resolution ?? "done") : t.resolution,
    done_at: chat ? (t.done_at ?? t.updated_at) : t.done_at,
    attention_reason: interrupted ? INTERRUPTED : t.attention_reason,
    starred: bit(t.starred),
    remind_at: t.remind_at,
    reminder: t.reminder,
    preview_url: t.preview_url,
    pr_url: t.pr_url,
    pr_checks: read("pr_checks", t.pr_checks),
    external_links: read("external_links", t.external_links),
    todos: read("todos", t.todos),
    tracked: read("tracked", t.tracked),
    context: read("context", t.context),
    context_detail: t.context_detail,
    cost_usd: t.cost_usd,
    last_activity_at: t.last_activity_at,
    created_at: t.created_at,
    updated_at: t.updated_at,
    use_worktree: bit(t.use_worktree),
    worktree_path: t.worktree_path,
    branch: t.branch,
    base_branch: t.base_branch,
    worktree_state: t.worktree_state,
    worktree_error: t.worktree_error,
    start_from: read("start_from", t.start_from),
    merges_into: t.merges_into,
    carries: read("carries", t.carries),
    restack: t.restack === "due" || t.restack === "conflict" ? t.restack : null,
    github_stack: t.github_stack !== null && Number.isInteger(t.github_stack) ? t.github_stack : null,
    stack_title: t.stack_title,
    stack_description: t.stack_description,
    stack_pinned: bit(t.stack_pinned),
    stack_input: t.stack_input,
    stack_run: t.stack_run,
    merging: bit(t.merging),
    remerge: bit(t.remerge),
    merge_approval: t.merge_approval === "pending" || t.merge_approval === "approved" ? t.merge_approval : null,
    depends_on: read("depends_on", t.depends_on) ?? [],
    waiting: interrupted ? 0 : bit(t.waiting),
    session_id: t.session_id,
    // The run state: no run is live on the new board.
    running: 0,
    run_started_at: t.run_started_at,
    limit_reset_at: t.limit_reset_at,
    agent_wait: null,
    background_work: null,
    servers: null,
    lost_background: read("lost_background", t.lost_background),
    steerable: 0,
    model: t.model,
    effort,
    permission_mode: mode,
    claude_config_id: t.claude_config_id,
    auto_allow: read("auto_allow", t.auto_allow) ?? [],
    review: read("review", t.review),
    summaries: summaries === null ? [] : Array.isArray(summaries) ? summaries : [summaries],
    rewind: read("rewind", t.rewind),
  }
  return { task: { id: t.id, key, columns, queue, queuedAt: t.updated_at }, notes }
}

/** Whether a task counts as merged for what targets its branch (the old `is_merged`). */
const isMerged = (t: OldTask) => t.status === "done" && (t.resolution === null || t.resolution === "done")

/**
 * Every old task as the new board keeps it, in their order, with the notes for the report: a scratch chat gets the next
 * `S-` number of its profile and the next place among the done tasks in no project (as migration 43 gave them), and an
 * unmerged task that still targets a subproject's branch is named so it can be given `merges_into` by hand.
 */
export const convertTasks = (
  rows: ReadonlyArray<OldTask>,
  facts: TaskFacts,
): { readonly tasks: ReadonlyArray<ConvertedTask>; readonly notes: ReadonlyArray<TaskNote> } => {
  const subprojects = new Map(rows.filter((t) => t.subproject !== 0).map((t) => [t.id, t] as const))
  const ids = new Set(subprojects.keys())
  const notes: Array<TaskNote> = []
  const converted = rows.map((t) => {
    const { task, notes: own } = convertTask(t, facts, ids)
    notes.push(...own)
    return task
  })
  // Scratch chats, numbered and placed after what is there.
  const sNumbers = new Map<string, number>()
  let donePosition = 0
  rows.forEach((t, i) => {
    const c = converted[i]?.columns
    if (t.kind === "scratch" || c === undefined || c["kind"] !== "task" || t.project_id !== null) return
    if (t.task_type !== null && S_FAMILY.has(t.task_type)) sNumbers.set(t.profile_id, Math.max(sNumbers.get(t.profile_id) ?? 0, t.number))
    if (c["status"] === "done") donePosition = Math.max(donePosition, t.position)
  })
  const chats = rows
    .flatMap((t, i) => (t.kind === "scratch" ? [i] : []))
    .toSorted((a, b) => {
      const x = rows[a]
      const y = rows[b]
      return x === undefined || y === undefined ? 0 : x.created_at.localeCompare(y.created_at) || x.id.localeCompare(y.id)
    })
  const out = [...converted]
  for (const i of chats) {
    const t = rows[i]
    const c = converted[i]
    if (t === undefined || c === undefined) continue
    const number = (sNumbers.get(t.profile_id) ?? 0) + 1
    sNumbers.set(t.profile_id, number)
    donePosition += 1
    out[i] = { ...c, columns: { ...c.columns, number, position: donePosition } }
  }
  // Tasks still aimed at a subproject's branch.
  for (const t of rows) {
    if (t.kind !== "task" || t.subproject !== 0 || isMerged(t) || t.base_branch === null || t.merges_into !== null) continue
    const target = [...subprojects.values()].find((s) => s.project_id === t.project_id && s.branch === t.base_branch)
    if (target === undefined) continue
    notes.push({
      key: oldKey(t, facts),
      text: `targets the branch ${t.base_branch} of the subproject ${oldKey(target, facts)}, which is an ordinary task now: give it merges_into ${oldKey(target, facts)} by hand if it should still merge there`,
    })
  }
  return { tasks: out, notes }
}

// ---- checks -----------------------------------------------------------------------------------------------------

/** A `tasks` row as the server reads it (`TaskRow` without what `SELECT_TASK` joins). */
const TaskColumnsRow = TaskRow.mapFields(Struct.omit(["project_key", "queue_rows", "steer_rows"]))

export const taskCheck: TableCheck = {
  row: TaskColumnsRow,
  json: {
    labels: Schema.Array(DocumentLabel),
    pr_checks: PrChecks,
    external_links: Schema.Array(ExternalLink),
    todos: Schema.Array(Todo),
    tracked: Schema.Array(TrackedItem),
    context: Context,
    start_from: StartFrom,
    carries: Carries,
    depends_on: Schema.Array(TaskId),
    auto_allow: Schema.Array(Schema.String),
    review: Review,
    summaries: Schema.Array(ChangeSummary),
    rewind: Rewind,
    lost_background: Schema.Array(Schema.Struct({ kind: Schema.String, label: Schema.String })),
  },
  key: keyOf("id"),
}

export const queueCheck: TableCheck = {
  row: Schema.Struct({ ...QueueRows.fields, task_id: TaskId, created_at: Timestamp }),
  key: keyOf("task_id"),
}

export const penCheck: TableCheck = { row: PenRow.mapFields(Struct.omit(["task_count"])), key: keyOf("id") }

/**
 * Why `threadKindOf` cannot classify a written row, or null when it can: every row is some kind, so this names the rows
 * whose kind is not what their columns say (a thread under a task with no task, a routine with no assistant, a task
 * with a review thread's type).
 */
export const unclassified = (t: TaskRow): string | null => {
  const kind = threadKindOf(t)
  if (t.kind === "review" && t.parent_id === null) return `a thread under a task (${kind._tag}) with no task to be under`
  if (kind._tag === "Routine" && t.parent_id === null) return "a routine's thread with no assistant"
  if (t.kind === "task" && (t.task_type === "summary" || t.task_type === "workflow")) return `a task with a review thread's type (${t.task_type})`
  return null
}

const decodeTaskRow = Schema.decodeUnknownResult(TaskRow)

// ---- the family -------------------------------------------------------------------------------------------------

const decodeProject = Schema.decodeUnknownResult(Schema.Struct({ id: Schema.String, key: Schema.String, scratch_path: def(Schema.String, "") }))

export const tasksPens: Family = {
  name: "tasks-pens",
  reads: ["tasks", "pens"],
  writes: ["pens", "tasks", "task_queue"],
  run: (io) =>
    Effect.gen(function* () {
      // The projects' own family reports a project that does not read.
      const projects = (yield* io.old.rows("projects")).flatMap((r) => {
        const result = decodeProject(r)
        return result._tag === "Success" ? [result.success] : []
      })
      const facts: TaskFacts = {
        oldDataDir: io.ctx.oldDataDir,
        projects: new Map(projects.map((p) => [p.id, { key: p.key, scratch_path: p.scratch_path }])),
      }

      const oldPens = yield* io.old.rows("pens")
      yield* io.report.old("pens", oldPens.length)
      const pens = (yield* decodeOld(io.report, "pens", OldPen, keyOf("id"))(oldPens)).map(convertPen)
      yield* io.write(
        "pens",
        penCheck,
        pens.map((p): NewRow => p),
      )

      const oldTasks = yield* io.old.rows("tasks")
      yield* io.report.old("tasks", oldTasks.length)
      const decoded = yield* decodeOld(io.report, "tasks", OldTask, keyOf("id"))(oldTasks)
      const { tasks, notes } = convertTasks(decoded, facts)
      // The queue's rows come from the tasks that had something queued.
      yield* io.report.old("task_queue", tasks.filter((t) => t.queue.length > 0).length)
      for (const note of notes) yield* io.report.note("tasks", note.key, note.text)
      const rows: Array<NewRow> = []
      for (const task of tasks) rows.push(yield* encodeColumns(task.columns))
      yield* io.write("tasks", taskCheck, rows)

      // Every row a kind: read back as the server reads it.
      const written = yield* io.exec(`SELECT t.*, p.key AS project_key, '[]' AS queue_rows, '[]' AS steer_rows
        FROM tasks t LEFT JOIN projects p ON p.id = t.project_id ORDER BY t.rowid`)
      const ids = new Set<unknown>()
      for (const r of written) {
        ids.add(r["id"])
        const result = decodeTaskRow(r)
        const why = result._tag === "Success" ? unclassified(result.success) : `it does not read: ${issueText(result.failure)}`
        if (why !== null) yield* io.report.failure("tasks", String(r["id"]), `threadKindOf cannot classify it: ${why}`)
      }

      // The queues of the tasks written (a task that failed is in the report already).
      const queue: Array<NewRow> = []
      for (const task of tasks) {
        if (!ids.has(task.id)) continue
        for (const q of task.queue) queue.push({ task_id: task.id, ...q, created_at: task.queuedAt })
      }
      yield* io.write("task_queue", queueCheck, queue)
    }),
}
