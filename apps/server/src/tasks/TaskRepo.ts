import { Bit, JsonColumn } from "../platform/columns.ts"
import { Context, Effect, Layer, Schema, SchemaTransformation } from "effect"
import { SqlClient, SqlSchema } from "effect/sql"
import type { SqlError } from "effect/sql"
import {
  AgentConfigId,
  AgentWait,
  BackgroundWork,
  Carries,
  ChangeSummary,
  Context as TaskContext,
  DocumentLabel,
  Effort,
  ExternalLink,
  keyLetter,
  PenId,
  PermissionMode,
  PrChecks,
  ProfileId,
  ProjectId,
  Resolution,
  Review,
  Rewind,
  RunId,
  StartFrom,
  Status,
  TaskId,
  TaskKind,
  TaskServer,
  TaskType,
  threadKindOf,
  Timestamp,
  Todo,
  TrackedItem,
  WorktreeState,
} from "@huntaway/contracts"
import type { Steer, Task, TaskFilter } from "@huntaway/contracts"
import type { ProjectFacts } from "./checks.ts"
import type { NewRow, NumberFamily, TaskColumns } from "./decide.ts"

// The `tasks` table and the queue and steer rows that hang off it (docs/plan/04-database.md, Access). Single
// statements and small groups; `SqlError` and `SchemaError` are defects. Nothing here waits: no process, network, file
// system or sleep (a transaction holds the one connection).

// ---- columns ----------------------------------------------------------------------------------------------------

const JsonText = Schema.fromJsonString(Schema.Unknown)
/** A value as JSON text. */
const encodeJson = (value: unknown) => Schema.encodeEffect(JsonText)(value).pipe(Effect.orDie)

/** `restack`: `due` or `conflict`; anything else reads as null. */
const Restack = Schema.NullOr(Schema.String).pipe(
  Schema.decodeTo(
    Schema.NullOr(Schema.Literals(["due", "conflict"])),
    SchemaTransformation.transform<"due" | "conflict" | null, string | null>({
      decode: (v) => (v === "due" || v === "conflict" ? v : null),
      encode: (v) => v,
    }),
  ),
)

const Text = Schema.NullOr(Schema.String)
const Time = Schema.NullOr(Timestamp)

/**
 * Who sent a message for a task's agent (docs/plan/04-database.md, The queue and steers): the user, another agent
 * (`send_to_task`), a routine (the assistant's), a project automation, or the board itself at the user's asking.
 */
export const MessageSource = Schema.Literals(["user", "agent", "routine", "automation", "board"])
export type MessageSource = typeof MessageSource.Type

/**
 * Whether a message counts as another agent's rather than the user's (the old `from_agent`): another agent's, a
 * routine's, and an automation's with text (one with none only starts the task it made).
 */
export const fromAgent = (source: string, text: string): boolean =>
  source === "agent" || source === "routine" || (source === "automation" && text.trim() !== "")

/** A message waiting for the task's next run (`task_queue`). */
const QueueRow = Schema.Struct({ text: Schema.String, source: Schema.String, automation_run_id: Text })
/** A message steered into a live run (`task_steers`). */
const SteerRow = Schema.Struct({
  id: Schema.String,
  run_id: RunId,
  text: Schema.String,
  source: Schema.String,
  automation_run_id: Text,
  written: Schema.Int,
})

/** A queued message as its row has it. */
export interface QueuedRow {
  readonly text: string
  readonly source: MessageSource
  readonly automation_run_id: string | null
}

/** A steered message as its row has it. */
export interface SteerRowOf {
  readonly id: string
  readonly run_id: RunId
  readonly text: string
  readonly source: MessageSource
  readonly automation_run_id: string | null
  readonly written: boolean
}

const QueueRows = Schema.Struct({ text: Schema.String, source: MessageSource, automation_run_id: Text })
const SteerRows = Schema.Struct({ id: Schema.String, run_id: RunId, text: Schema.String, source: MessageSource, automation_run_id: Text, written: Bit })

/** A row of `tasks`, with its project's key and its queue and steer rows (`SELECT_TASK`). */
export const TaskRow = Schema.Struct({
  id: TaskId,
  profile_id: ProfileId,
  project_id: Schema.NullOr(ProjectId),
  kind: TaskKind,
  parent_id: Schema.NullOr(TaskId),
  group_name: Text,
  created_by: Schema.NullOr(TaskId),
  task_type: Schema.NullOr(TaskType),
  labels: JsonColumn(Schema.Array(DocumentLabel), []),
  work_dir: Text,
  document_at: Time,
  number: Schema.Int,
  pen_id: Schema.NullOr(PenId),
  fanout_id: Text,
  position: Schema.Finite,
  title: Schema.String,
  title_pinned: Bit,
  description: Schema.String,
  status: Status,
  resolution: Schema.NullOr(Resolution),
  done_at: Time,
  attention_reason: Text,
  starred: Bit,
  remind_at: Time,
  reminder: Text,
  preview_url: Text,
  pr_url: Text,
  pr_checks: JsonColumn(Schema.NullOr(PrChecks), null),
  external_links: JsonColumn(Schema.Array(ExternalLink), []),
  todos: JsonColumn(Schema.Array(Todo), []),
  tracked: JsonColumn(Schema.Array(TrackedItem), []),
  context: JsonColumn(Schema.NullOr(TaskContext), null),
  cost_usd: Schema.Finite,
  last_activity_at: Timestamp,
  created_at: Timestamp,
  updated_at: Timestamp,
  use_worktree: Bit,
  worktree_path: Text,
  branch: Text,
  base_branch: Text,
  worktree_state: WorktreeState,
  worktree_error: Text,
  start_from: JsonColumn(Schema.NullOr(StartFrom), null),
  merges_into: Schema.NullOr(TaskId),
  carries: JsonColumn(Schema.NullOr(Carries), null),
  restack: Restack,
  github_stack: Schema.NullOr(Schema.Int),
  stack_title: Text,
  stack_description: Text,
  stack_pinned: Bit,
  stack_run: Text,
  merging: Bit,
  remerge: Bit,
  merge_approval: Schema.NullOr(Schema.Literals(["pending", "approved"])),
  depends_on: JsonColumn(Schema.Array(TaskId), []),
  waiting: Bit,
  session_id: Text,
  running: Bit,
  run_started_at: Time,
  limit_reset_at: Time,
  agent_wait: JsonColumn(Schema.NullOr(AgentWait), null),
  background_work: JsonColumn(Schema.NullOr(BackgroundWork), null),
  servers: JsonColumn(Schema.Array(TaskServer), []),
  steerable: Bit,
  model: Text,
  effort: Schema.NullOr(Effort),
  permission_mode: Schema.NullOr(PermissionMode),
  claude_config_id: Schema.NullOr(AgentConfigId),
  auto_allow: JsonColumn(Schema.Array(Schema.String), []),
  review: JsonColumn(Schema.NullOr(Review), null),
  summaries: JsonColumn(Schema.Array(ChangeSummary), []),
  rewind: JsonColumn(Schema.NullOr(Rewind), null),
  project_key: Text,
  queue_rows: JsonColumn(Schema.Array(QueueRow), []),
  steer_rows: JsonColumn(Schema.Array(SteerRow), []),
})
export type TaskRow = typeof TaskRow.Type

/**
 * The wire `Task` of a row (docs/plan/04-database.md, The queue and steers): its key from its project's key and number
 * (or `G-`, `S-`, `A-`, `keyLetter`), `queued_message` the queue's texts joined with a blank line, and `steering` the
 * steer rows. Who sent a steer: `from_agent` when another agent did, `routine` for an automation's.
 */
export const toTask = (row: TaskRow): Task => {
  const { project_key, queue_rows, steer_rows, ...task } = row
  const queued = queue_rows.map((q) => q.text).filter((t) => t !== "")
  const steering = steer_rows.map((s): Steer => {
    const steer: { -readonly [K in keyof Steer]: Steer[K] } = {
      id: s.id,
      text: s.text,
      from_agent: fromAgent(s.source, s.text),
      run_id: s.run_id,
      written: s.written !== 0,
    }
    if (s.automation_run_id !== null) steer.routine_runs = [s.automation_run_id]
    if (s.source === "routine" || s.source === "automation") steer.routine = true
    return steer
  })
  return {
    ...task,
    key: `${keyLetter(threadKindOf(task), project_key)}-${row.number}`,
    queued_message: queued.length === 0 ? null : queued.join("\n\n"),
    steering,
  }
}

const SELECT_TASK = `SELECT t.*, p.key AS project_key,
  (SELECT json_group_array(json_object('text', q.text, 'source', q.source, 'automation_run_id', q.automation_run_id))
     FROM (SELECT * FROM task_queue WHERE task_id = t.id ORDER BY seq) q) AS queue_rows,
  (SELECT json_group_array(json_object('id', s.id, 'run_id', s.run_id, 'text', s.text, 'source', s.source,
                                       'automation_run_id', s.automation_run_id, 'written', s.written))
     FROM (SELECT * FROM task_steers WHERE task_id = t.id ORDER BY seq) s) AS steer_rows
FROM tasks t LEFT JOIN projects p ON p.id = t.project_id`

/** Columns as SQLite keeps them: booleans as 0/1, lists and objects as JSON text. */
const columnsToSql = Effect.fnUntraced(function* (columns: TaskColumns) {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(columns)) {
    if (v === undefined) continue
    out[k] = typeof v === "boolean" ? (v ? 1 : 0) : v !== null && typeof v === "object" ? yield* encodeJson(v) : v
  }
  return out
})

/** The rows a statement returns, as tasks. */
const taskRows = <Req extends Schema.Constraint>(Request: Req, execute: (r: Req["Encoded"]) => Effect.Effect<ReadonlyArray<unknown>, SqlError.SqlError>) => {
  const find = SqlSchema.findAll({ Request, Result: TaskRow, execute })
  return (r: Req["Type"]) => Effect.map(find(r), (found) => found.map(toTask)).pipe(Effect.orDie)
}
const first = <A>(effect: Effect.Effect<ReadonlyArray<A>>) => Effect.map(effect, (found) => found[0] ?? null)
const bit = (b: boolean | undefined) => (b === true ? 1 : 0)
/** The rows a statement returns, decoded with `Result`. */
const decoded = <S extends Schema.Constraint>(Result: S, statement: Effect.Effect<ReadonlyArray<unknown>, SqlError.SqlError>) =>
  SqlSchema.findAll({ Request: Schema.Void, Result, execute: () => statement })(undefined).pipe(Effect.orDie)
/** The `n` of a statement's first row. */
const count = (statement: Effect.Effect<ReadonlyArray<unknown>, SqlError.SqlError>) => Effect.map(decoded(Count, statement), (found) => found[0]?.n ?? 0)

// ---- the other rows a task's rules read -------------------------------------------------------------------------

const ProjectRow = Schema.Struct({
  id: ProjectId,
  profile_id: ProfileId,
  name: Schema.String,
  key: Schema.String,
  former_keys: JsonColumn(Schema.Array(Schema.String), []),
  archived_at: Text,
  base_branch: Text,
  use_worktrees: Bit,
  is_git: Bit,
  pr_preview_url: Text,
  claude_config_ids: JsonColumn(Schema.NullOr(Schema.Array(AgentConfigId)), null),
})

/** A project, as a task's rules read it. */
export interface ProjectRef extends ProjectFacts {
  /** Its own configs, which override its profile's when not empty. */
  readonly claude_config_ids: ReadonlyArray<AgentConfigId> | null
}

const toProject = (row: typeof ProjectRow.Type): ProjectRef => ({
  id: row.id,
  profile_id: row.profile_id,
  name: row.name,
  key: row.key,
  former_keys: row.former_keys,
  archived: row.archived_at !== null,
  base_branch: row.base_branch,
  use_worktrees: row.use_worktrees,
  is_git: row.is_git,
  pr_preview_url: row.pr_preview_url,
  claude_config_ids: row.claude_config_ids,
})

const ProfileRow = Schema.Struct({ id: ProfileId, name: Schema.String, claude_config_ids: JsonColumn(Schema.Array(AgentConfigId), []) })
export type ProfileRef = typeof ProfileRow.Type

const Count = Schema.Struct({ n: Schema.Finite })
const Id = Schema.Struct({ id: Schema.String })

/** The task types numbered together in a profile: `S-` for scratch tasks and the pens threads, `A-` for the assistant and its routines. */
const familyTypes: { readonly [F in Exclude<NumberFamily, "project" | "group">]: ReadonlyArray<string> } = {
  scratch: ["scratch", "pens", "pen"],
  assistant: ["assistant", "routine"],
}

export interface TaskRepoShape {
  readonly get: (id: string) => Effect.Effect<Task | null>
  readonly getMany: (ids: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<Task>>
  /**
   * Every task a client keeps, in one read (the board's snapshot): what the old client's `loadAll` loaded. Every
   * project's tasks and review threads, and every profile's tasks in no project with its assistant, pens thread and
   * pens' threads; not the routine threads. Unlike `loadAll`, archived projects' tasks too: the client keeps them off
   * the board, and unarchiving a project then shows them with no load beside the stream.
   */
  readonly all: Effect.Effect<ReadonlyArray<Task>>
  /** The old list queries: review threads only when a project's are asked for; never the routine threads. */
  readonly list: (filter: TaskFilter) => Effect.Effect<ReadonlyArray<Task>>
  /** A project's tasks (not its review threads), in board order. */
  readonly projectTasks: (project: ProjectId) => Effect.Effect<ReadonlyArray<Task>>
  /** The review, summary and workflow-step threads under a task. */
  readonly reviewThreads: (id: TaskId) => Effect.Effect<ReadonlyArray<Task>>
  /** A project's task by number (its key's `n`), or a profile's projectless task by family and number. */
  readonly byNumber: (project: ProjectId, n: number) => Effect.Effect<Task | null>
  readonly projectlessByNumber: (profile: ProfileId, family: Exclude<NumberFamily, "project">, n: number) => Effect.Effect<Task | null>
  /** Adds a task, numbered (its project's next number, or the next of its family in its profile) and placed last in its column. */
  readonly insert: (id: TaskId, row: NewRow, now: Timestamp) => Effect.Effect<void>
  /** Writes columns, and `updated_at`. */
  readonly write: (id: TaskId, columns: TaskColumns, now: Timestamp) => Effect.Effect<void>
  /** Deletes the task's queue and steer rows, then the row (the database cascades to its threads, runs and the rest). */
  readonly delete: (id: TaskId) => Effect.Effect<void>
  /** A position after every task in a column. */
  readonly endPosition: (project: ProjectId | null, status: Task["status"]) => Effect.Effect<number>
  readonly project: (id: ProjectId) => Effect.Effect<ProjectRef | null>
  readonly projects: Effect.Effect<ReadonlyArray<ProjectRef>>
  readonly profile: (id: ProfileId) => Effect.Effect<ProfileRef | null>
  /** Every profile, oldest first. */
  readonly profiles: Effect.Effect<ReadonlyArray<ProfileRef>>
  /** The configs a thread may use (huntaway's `available_configs`): its project's if it has any, else its profile's, that exist. */
  readonly configs: (profile: ProfileId, project: ProjectRef | null) => Effect.Effect<ReadonlyArray<AgentConfigId>>
  /** How many of a profile's projects that aren't archived are in a group. */
  readonly groupProjects: (profile: ProfileId, group: string) => Effect.Effect<number>

  // The queue and steers (docs/plan/04-database.md): the rows the task's `queued_message` and `steering` are read from.
  /** The messages queued for the task's next run, in order. */
  readonly queued: (task: TaskId) => Effect.Effect<ReadonlyArray<QueuedRow>>
  /** Queue a message after the others. */
  readonly enqueue: (task: TaskId, row: QueuedRow, now: Timestamp) => Effect.Effect<void>
  /** Take every queued message: they are deleted and returned, in order. */
  readonly takeQueued: (task: TaskId) => Effect.Effect<ReadonlyArray<QueuedRow>>
  /** Queue `rows` ahead of whatever is queued now. */
  readonly queueAhead: (task: TaskId, rows: ReadonlyArray<QueuedRow>, now: Timestamp) => Effect.Effect<void>
  /** The messages steered into a run of the task (all runs' if none is named), in the order they were sent. */
  readonly steers: (task: TaskId, run?: RunId) => Effect.Effect<ReadonlyArray<SteerRowOf>>
  /** A message steered into run `row.run_id`, not written to its input yet. */
  readonly addSteer: (task: TaskId, row: Omit<SteerRowOf, "written">, now: Timestamp) => Effect.Effect<void>
  /** The steer was written to its run's input. */
  readonly steerWritten: (id: string) => Effect.Effect<void>
  /** Takes the steer away (its agent took it in): returned, or null when there was none by that id for the task. */
  readonly takeSteer: (task: TaskId, id: string) => Effect.Effect<SteerRowOf | null>
  /** Takes away the steers of `run` (every run's if none is named), returning them in order. */
  readonly takeSteers: (task: TaskId, run?: RunId) => Effect.Effect<ReadonlyArray<SteerRowOf>>
}

/** The repository of tasks. */
export class TaskRepo extends Context.Service<TaskRepo, TaskRepoShape>()("huntaway-server/tasks/TaskRepo") {
  static readonly layer = Layer.effect(
    TaskRepo,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const select = sql.literal(SELECT_TASK)

      const byId = taskRows(Schema.String, (id) => sql`${select} WHERE t.id = ${id}`)
      const everything = taskRows(
        Schema.Void,
        () =>
          sql`${select} WHERE t.project_id IS NOT NULL OR t.task_type IS NOT 'routine'
            ORDER BY t.project_id, t.position, t.created_at`,
      )
      const byIds = taskRows(Schema.Array(Schema.String), (ids) => sql`${select} WHERE ${sql.in("t.id", ids)}`)
      const ofProject = taskRows(
        Schema.Struct({ project: Schema.String, kind: Schema.String }),
        ({ project, kind }) => sql`${select} WHERE t.project_id = ${project} AND t.kind = ${kind} ORDER BY t.position, t.created_at`,
      )
      // The profile's tasks in every project and none, without its routine threads and pens threads, and without its
      // assistant unless asked for.
      const ofProfile = taskRows(
        Schema.Struct({ profile: Schema.String, assistant: Schema.Int }),
        ({ profile, assistant }) =>
          sql`${select} WHERE t.profile_id = ${profile} AND t.kind = 'task' AND (${assistant} OR t.task_type IS NOT 'assistant')
            AND t.task_type IS NOT 'routine' AND t.task_type IS NOT 'pens' AND t.task_type IS NOT 'pen'
            ORDER BY t.project_id, t.position`,
      )
      // The profile's tasks in no project: group and scratch tasks, and the assistant, the pens thread and the pens'
      // own threads when asked for. Never the routine threads.
      const projectless = taskRows(
        Schema.Struct({ profile: Schema.String, assistant: Schema.Int, pens: Schema.Int, penThreads: Schema.Int }),
        ({ profile, assistant, pens, penThreads }) =>
          sql`${select} WHERE t.profile_id = ${profile} AND t.project_id IS NULL AND t.kind = 'task'
            AND (${assistant} OR t.task_type IS NOT 'assistant') AND t.task_type IS NOT 'routine'
            AND (${pens} OR t.task_type IS NOT 'pens') AND (${penThreads} OR t.task_type IS NOT 'pen')
            ORDER BY t.position`,
      )
      const reviews = taskRows(Schema.String, (id) => sql`${select} WHERE t.parent_id = ${id} AND t.kind = 'review' ORDER BY t.created_at`)
      const numbered = taskRows(
        Schema.Struct({ project: Schema.String, n: Schema.Int }),
        ({ project, n }) => sql`${select} WHERE t.project_id = ${project} AND t.kind = 'task' AND t.number = ${n} ORDER BY t.position, t.created_at LIMIT 1`,
      )
      const projectlessNumbered = taskRows(Schema.Struct({ profile: Schema.String, family: Schema.String, n: Schema.Int }), ({ profile, family, n }) => {
        const which =
          family === "group" ? sql`t.group_name IS NOT NULL` : sql.in("t.task_type", family === "scratch" ? familyTypes.scratch : familyTypes.assistant)
        return sql`${select} WHERE t.profile_id = ${profile} AND t.project_id IS NULL AND t.kind = 'task' AND ${which} AND t.number = ${n}`
      })

      const list = (filter: TaskFilter) => {
        if (filter._tag === "ByProject") return ofProject({ project: filter.project_id, kind: filter.kind ?? "task" })
        if (filter._tag === "ByProfile") return ofProfile({ profile: filter.profile_id, assistant: bit(filter.include_assistant) })
        return projectless({
          profile: filter.profile_id,
          assistant: bit(filter.include_assistant),
          pens: bit(filter.include_pens),
          penThreads: bit(filter.include_pen_threads),
        })
      }

      const endPosition = (project: ProjectId | null, status: Task["status"]) =>
        count(sql`SELECT COALESCE(MAX(position), 0) + 1 AS n FROM tasks WHERE project_id IS ${project} AND status = ${status} AND kind = 'task'`)

      // A project's next number, kept on the project so numbers are never reused; else the next of the task's family
      // among the profile's tasks in no project (a deleted highest number is used again, as before).
      const nextNumber = (row: NewRow): Effect.Effect<number> => {
        if (row.family === "project") {
          return count(sql`UPDATE projects SET next_number = next_number + 1 WHERE id = ${row.project_id} RETURNING next_number - 1 AS n`)
        }
        const which = row.family === "group" ? sql`group_name IS NOT NULL` : sql.in("task_type", familyTypes[row.family])
        return count(sql`SELECT COALESCE(MAX(number), 0) + 1 AS n FROM tasks
          WHERE profile_id = ${row.profile_id} AND project_id IS NULL AND kind = 'task' AND ${which}`)
      }

      const insert = Effect.fnUntraced(function* (id: TaskId, row: NewRow, now: Timestamp) {
        const number = yield* nextNumber(row)
        const position = row.columns.position ?? (yield* endPosition(row.project_id, row.columns.status ?? "todo"))
        const values = {
          ...(yield* columnsToSql(row.columns)),
          id,
          profile_id: row.profile_id,
          project_id: row.project_id,
          kind: "task",
          number,
          position,
          last_activity_at: now,
          created_at: now,
          updated_at: now,
        }
        yield* sql`INSERT INTO tasks ${sql.insert(values)}`.pipe(Effect.orDie)
      })

      const write = Effect.fnUntraced(function* (id: TaskId, columns: TaskColumns, now: Timestamp) {
        const values = { ...(yield* columnsToSql(columns)), updated_at: now }
        yield* sql`UPDATE tasks SET ${sql.update(values)} WHERE id = ${id}`.pipe(Effect.orDie)
      })

      const remove = (id: TaskId) =>
        Effect.all(
          [sql`DELETE FROM task_queue WHERE task_id = ${id}`, sql`DELETE FROM task_steers WHERE task_id = ${id}`, sql`DELETE FROM tasks WHERE id = ${id}`],
          { concurrency: 1, discard: true },
        ).pipe(Effect.orDie)

      const selectProjects = sql.literal(
        "SELECT id, profile_id, name, key, former_keys, archived_at, base_branch, use_worktrees, is_git, pr_preview_url, claude_config_ids FROM projects",
      )
      const project = (id: ProjectId) => first(Effect.map(decoded(ProjectRow, sql`${selectProjects} WHERE id = ${id}`), (found) => found.map(toProject)))
      const projects = Effect.map(decoded(ProjectRow, sql`${selectProjects} ORDER BY created_at`), (found) => found.map(toProject))
      const profile = (id: ProfileId) => first(decoded(ProfileRow, sql`SELECT id, name, claude_config_ids FROM profiles WHERE id = ${id}`))
      const profiles = decoded(ProfileRow, sql`SELECT id, name, claude_config_ids FROM profiles ORDER BY created_at`)

      const configs = Effect.fnUntraced(function* (profileId: ProfileId, of: ProjectRef | null) {
        const own = of?.claude_config_ids ?? []
        const ids = own.length > 0 ? own : ((yield* profile(profileId))?.claude_config_ids ?? [])
        if (ids.length === 0) return []
        const existing = new Set((yield* decoded(Id, sql`SELECT id FROM agent_configs WHERE ${sql.in("id", ids)}`)).map((r) => r.id))
        return ids.filter((id) => existing.has(id))
      })

      const groupProjects = (profileId: ProfileId, group: string) =>
        count(sql`SELECT COUNT(*) AS n FROM projects WHERE profile_id = ${profileId} AND group_name = ${group} AND archived_at IS NULL`)

      const queued = (task: TaskId) => decoded(QueueRows, sql`SELECT text, source, automation_run_id FROM task_queue WHERE task_id = ${task} ORDER BY seq`)
      const enqueue = (task: TaskId, row: QueuedRow, now: Timestamp) =>
        sql`INSERT INTO task_queue (task_id, text, source, automation_run_id, created_at)
          VALUES (${task}, ${row.text}, ${row.source}, ${row.automation_run_id}, ${now})`.pipe(Effect.asVoid, Effect.orDie)
      const takeQueued = (task: TaskId) =>
        Effect.gen(function* () {
          const rows = yield* queued(task)
          if (rows.length > 0) yield* sql`DELETE FROM task_queue WHERE task_id = ${task}`.pipe(Effect.orDie)
          return rows
        })
      // Ahead: what is queued now goes back behind them, so that the order is by seq.
      const queueAhead = (task: TaskId, rows: ReadonlyArray<QueuedRow>, now: Timestamp) =>
        Effect.gen(function* () {
          if (rows.length === 0) return
          const later = yield* takeQueued(task)
          for (const row of [...rows, ...later]) yield* enqueue(task, row, now)
        })
      const steers = (task: TaskId, run?: RunId) =>
        decoded(
          SteerRows,
          sql`SELECT id, run_id, text, source, automation_run_id, written FROM task_steers
            WHERE task_id = ${task} AND (${run ?? null} IS NULL OR run_id = ${run ?? null}) ORDER BY seq`,
        )
      const addSteer = (task: TaskId, row: Omit<SteerRowOf, "written">, now: Timestamp) =>
        sql`INSERT INTO task_steers (id, seq, task_id, run_id, text, source, automation_run_id, written, created_at)
          VALUES (${row.id}, (SELECT COALESCE(MAX(seq), 0) + 1 FROM task_steers WHERE task_id = ${task}), ${task}, ${row.run_id}, ${row.text},
            ${row.source}, ${row.automation_run_id}, 0, ${now})`.pipe(Effect.asVoid, Effect.orDie)
      const takeSteer = (task: TaskId, id: string) =>
        Effect.gen(function* () {
          const found = (yield* steers(task)).find((s) => s.id === id) ?? null
          if (found !== null) yield* sql`DELETE FROM task_steers WHERE id = ${id}`.pipe(Effect.orDie)
          return found
        })
      const takeSteers = (task: TaskId, run?: RunId) =>
        Effect.gen(function* () {
          const rows = yield* steers(task, run)
          for (const row of rows) yield* sql`DELETE FROM task_steers WHERE id = ${row.id}`.pipe(Effect.orDie)
          return rows
        })

      return TaskRepo.of({
        queued,
        enqueue,
        takeQueued,
        queueAhead,
        steers,
        addSteer,
        steerWritten: (id) => sql`UPDATE task_steers SET written = 1 WHERE id = ${id}`.pipe(Effect.asVoid, Effect.orDie),
        takeSteer,
        takeSteers,
        get: (id) => first(byId(id)),
        getMany: (ids) => (ids.length === 0 ? Effect.succeed([]) : byIds(ids)),
        all: everything(undefined),
        list,
        projectTasks: (id) => ofProject({ project: id, kind: "task" }),
        reviewThreads: (id) => reviews(id),
        byNumber: (id, n) => first(numbered({ project: id, n })),
        projectlessByNumber: (profileId, family, n) => first(projectlessNumbered({ profile: profileId, family, n })),
        insert,
        write,
        delete: remove,
        endPosition,
        project,
        projects,
        profile,
        profiles,
        configs,
        groupProjects,
      })
    }),
  )
}
