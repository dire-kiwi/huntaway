import { Context, Effect, Layer, Result, Schema } from "effect"
import type { AgentConfigId, ProfileId, ProjectId, RunId, TaskId, Timestamp } from "@huntaway/contracts"
import { Db } from "../platform/Db.ts"

// What review and summaries keep beside a task's `review` and `summaries` (docs/plan/04-database.md; inventory 04, 3.1
// and 3.3): their threads' rows, the skills each thread runs with (`thread_tools`), the rows of `review_stats`, and the
// order of a thread's runs. Statements only, so any of them may run in a transaction.

/** A review or summary thread to add under a task. */
export interface NewThread {
  readonly profile_id: ProfileId
  readonly project_id: ProjectId
  readonly parent_id: TaskId
  /** `summary` for a summary thread; null for a reviewer's. */
  readonly task_type: "summary" | null
  readonly title: string
  /** A summary thread's variant (`variantKey`); "" otherwise. */
  readonly description: string
  readonly model: string | null
  readonly effort: string | null
  readonly claude_config_id: AgentConfigId | null
}

/** What one `submit_review` reported (the old `Submission`). */
export interface StatRow {
  readonly task_id: TaskId
  readonly thread_id: TaskId
  /** When its round started. */
  readonly round: Timestamp
  readonly run_id: RunId
  readonly verdict: "pass" | "issues"
  readonly serious: number
  /** Null for a submission that didn't list minor issues. */
  readonly minor: number | null
  readonly minor_noted: boolean
  /** Which agent reviewed, e.g. "Codex · gpt-5.1". */
  readonly label: string | null
}

const jsonText = Schema.encodeResult(Schema.fromJsonString(Schema.Array(Schema.String)))

const Found = Schema.Struct({ found: Schema.Finite })
const decodeFound = Schema.decodeUnknownEffect(Schema.Array(Found))
/** An `EXISTS(…) AS found` row's answer. */
const found = (rows: ReadonlyArray<unknown>) => Effect.map(decodeFound(rows), (r) => (r[0]?.found ?? 0) > 0)

/** Trimmed, or null when blank. */
const blank = (s: string | null | undefined) => {
  const t = s?.trim() ?? ""
  return t === "" ? null : t
}

export interface ReviewRepoShape {
  /** Adds a review or summary thread under a task: kind `review`, numbered 0, in To do, with no worktree of its own. */
  readonly insertThread: (id: TaskId, row: NewThread, at: Timestamp) => Effect.Effect<void>
  /** The skills the board turns on in the thread (6.4 reads them): none deletes the row's list. */
  readonly setSkills: (thread: TaskId, skills: ReadonlyArray<string>) => Effect.Effect<void>
  readonly skills: (thread: TaskId) => Effect.Effect<ReadonlyArray<string>>
  /**
   * Keeps a submission made at `at`, replacing what its run submitted before, with the effort the work reviewed was done
   * at (`workEffort`). Returns that effort.
   */
  readonly addStat: (row: StatRow, at: Timestamp) => Effect.Effect<string | null>
  /**
   * The effort the work reviewed was done at: that of the task's latest prompt run before `at`, as its agent was given
   * it, so a later change of the task's effort or the host's default doesn't move it; with no such run, the task's own
   * effort, else the host's default. Null is the agent's own default.
   */
  readonly workEffort: (task: TaskId, at: Timestamp) => Effect.Effect<string | null>
  /**
   * Whether `run` is a run of `thread` started after run `after` (any of its runs when `after` is "" or not a run); any
   * run at all with no `after` (a part or summary from before they kept it).
   */
  readonly runAfter: (thread: TaskId, run: RunId, after: RunId | undefined) => Effect.Effect<boolean>
  /** The id of the thread's latest run, if it has one. */
  readonly latestRun: (thread: TaskId) => Effect.Effect<RunId | null>
  /** Whether a run of the task has started since run `after` (since ever, for none). */
  readonly laterRun: (task: TaskId, after: RunId | null) => Effect.Effect<boolean>
  /** The tasks with a review or a summary running (Recovery). */
  readonly unsettled: Effect.Effect<ReadonlyArray<TaskId>>
}

export class ReviewRepo extends Context.Service<ReviewRepo, ReviewRepoShape>()("huntaway-server/review/ReviewRepo") {
  static readonly layer = Layer.effect(
    ReviewRepo,
    Effect.gen(function* () {
      const { sql } = yield* Db

      const workEffort = (task: TaskId, at: Timestamp) =>
        Effect.gen(function* () {
          const runs = yield* sql<{ readonly effort: string }>`
            SELECT effort FROM runs WHERE task_id = ${task} AND kind = 'prompt' AND effort IS NOT NULL AND created_at < ${at}
            ORDER BY created_at DESC, seq DESC LIMIT 1`
          const run = runs[0]
          if (run !== undefined) return blank(run.effort)
          const own = (yield* sql<{ readonly effort: string | null }>`SELECT effort FROM tasks WHERE id = ${task}`)[0]?.effort ?? null
          if (blank(own) !== null) return blank(own)
          const host = (yield* sql<{ readonly value: string }>`SELECT value FROM settings WHERE key = 'default_effort'`)[0]?.value ?? null
          return blank(host)
        }).pipe(Effect.orDie)

      return ReviewRepo.of({
        insertThread: (id, row, at) =>
          sql`INSERT INTO tasks ${sql.insert({
            id,
            profile_id: row.profile_id,
            project_id: row.project_id,
            kind: "review",
            parent_id: row.parent_id,
            task_type: row.task_type,
            title: row.title,
            description: row.description,
            status: "todo",
            use_worktree: 0,
            model: row.model,
            effort: row.effort,
            claude_config_id: row.claude_config_id,
            number: 0,
            last_activity_at: at,
            created_at: at,
            updated_at: at,
          })}`.pipe(Effect.asVoid, Effect.orDie),
        setSkills: (thread, skills) =>
          (skills.length === 0
            ? sql`UPDATE thread_tools SET skills = '[]' WHERE task_id = ${thread}`
            : sql`INSERT INTO thread_tools (task_id, skills) VALUES (${thread}, ${Result.getOrElse(jsonText(skills), () => "[]")})
                ON CONFLICT(task_id) DO UPDATE SET skills = excluded.skills`
          ).pipe(Effect.asVoid, Effect.orDie),
        skills: (thread) =>
          sql<{ readonly skills: string }>`SELECT skills FROM thread_tools WHERE task_id = ${thread}`.pipe(
            Effect.map((rows) => {
              const text = rows[0]?.skills
              if (text === undefined) return []
              const decoded = Schema.decodeOption(Schema.fromJsonString(Schema.Array(Schema.String)))(text)
              return decoded._tag === "Some" ? decoded.value : []
            }),
            Effect.orDie,
          ),
        addStat: (row, at) =>
          Effect.gen(function* () {
            // What the run submitted before: this replaces it.
            yield* sql`DELETE FROM review_stats WHERE thread_id = ${row.thread_id} AND run_id = ${row.run_id}`
            const effort = yield* workEffort(row.task_id, at)
            yield* sql`INSERT INTO review_stats ${sql.insert({
              task_id: row.task_id,
              thread_id: row.thread_id,
              round: row.round,
              run_id: row.run_id,
              at,
              verdict: row.verdict,
              serious: row.serious,
              minor: row.minor,
              minor_noted: row.minor_noted ? 1 : 0,
              label: row.label === "" ? null : row.label,
              effort,
            })}`
            return effort
          }).pipe(Effect.orDie),
        workEffort,
        runAfter: (thread, run, after) =>
          after === undefined
            ? Effect.succeed(true)
            : sql`SELECT EXISTS(SELECT 1 FROM runs WHERE id = ${run} AND task_id = ${thread}
                AND seq > COALESCE((SELECT seq FROM runs WHERE id = ${after}), -1)) AS found`.pipe(Effect.flatMap(found), Effect.orDie),
        latestRun: (thread) =>
          sql<{ readonly id: RunId }>`SELECT id FROM runs WHERE task_id = ${thread} ORDER BY seq DESC LIMIT 1`.pipe(
            Effect.map((rows) => rows[0]?.id ?? null),
            Effect.orDie,
          ),
        laterRun: (task, after) =>
          sql`SELECT EXISTS(SELECT 1 FROM runs WHERE task_id = ${task}
                AND seq > COALESCE((SELECT seq FROM runs WHERE id = ${after ?? ""}), -1)) AS found`.pipe(Effect.flatMap(found), Effect.orDie),
        unsettled: sql<{ readonly id: TaskId }>`SELECT id FROM tasks WHERE json_extract(review, '$.state') = 'running'
            OR EXISTS (SELECT 1 FROM json_each(tasks.summaries) WHERE json_extract(value, '$.state') = 'running')
            ORDER BY created_at`.pipe(
          Effect.map((rows) => rows.map((r) => r.id)),
          Effect.orDie,
        ),
      })
    }),
  )
}
