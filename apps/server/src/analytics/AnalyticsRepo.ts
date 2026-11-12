import { Context, Effect, Layer, Schema } from "effect"
import { SqlClient, SqlSchema } from "effect/sql"
import { AnalyticsProject, AnalyticsTask, ContextStat } from "@huntaway/contracts"
import type { ProfileId } from "@huntaway/contracts"

// The analytics' reads (the old analytics.ts's and disk.ts's statements): runs, `context_stats`, `token_usage`,
// `call_usage`, `review_stats` and the tasks and projects they're about, for one profile and a range. Statements only.

/** A review thread's activity belongs to the task under review. */
const OWNER = "COALESCE(CASE WHEN t.kind = 'review' THEN t.parent_id END, t.id)"

const Int = Schema.Int
const NullInt = Schema.NullOr(Schema.Int)
const NullNum = Schema.NullOr(Schema.Finite)
const NullStr = Schema.NullOr(Schema.String)

export const RunSpanRow = Schema.Struct({ owner: Schema.String, kind: Schema.String, created_at: Schema.String, ended_at: NullStr })
export const OwnerRow = Schema.Struct({ id: Schema.String, owner: Schema.String })
export const RunUsageRow = Schema.Struct({
  run_id: Schema.String,
  task_id: Schema.String,
  kind: Schema.String,
  created_at: Schema.String,
  model: Schema.String,
  runtime: Schema.String,
  input_tokens: Int,
  output_tokens: Int,
  cache_read_tokens: Int,
  cache_write_tokens: Int,
  cache_write_1h_tokens: NullInt,
  cache_write_5m_tokens: NullInt,
  reasoning_tokens: Int,
  cost_usd: NullNum,
  estimated: Int,
})
export const CallUsageRow = Schema.Struct({
  task_id: NullStr,
  purpose: Schema.String,
  at: Schema.String,
  model: Schema.String,
  runtime: Schema.String,
  input_tokens: Int,
  output_tokens: Int,
  cache_read_tokens: Int,
  cache_write_tokens: Int,
  reasoning_tokens: Int,
  cost_usd: NullNum,
  call_id: NullStr,
  cache_write_1h_tokens: NullInt,
  cache_write_5m_tokens: NullInt,
})
export const ReviewStatRow = Schema.Struct({
  task_id: Schema.String,
  thread_id: Schema.String,
  at: Schema.String,
  verdict: Schema.String,
  serious: Int,
  minor: NullInt,
  minor_noted: Int,
  label: NullStr,
  run_id: NullStr,
  round: Schema.String,
  effort: NullStr,
})
export const RoundStatRow = Schema.Struct({ round: Schema.String, verdict: Schema.String, serious: Int })
export const FollowUpRow = Schema.Struct({ id: Schema.String, created_by: Schema.String, created_at: Schema.String })
export const TaskExtraRow = Schema.Struct({ parent_id: NullStr, task_type: NullStr, group_name: NullStr, model: NullStr })

/** What the disk report needs of a project. */
export const DiskProjectRow = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  key: Schema.String,
  repo_path: Schema.String,
  scratch_path: Schema.String,
  worktrees_root: Schema.String,
})
export type DiskProjectRow = typeof DiskProjectRow.Type
export const WorktreeRow = Schema.Struct({
  id: Schema.String,
  kind: Schema.String,
  number: Int,
  title: Schema.String,
  status: Schema.String,
  path: Schema.String,
})
export type WorktreeRow = typeof WorktreeRow.Type
const RunProjectRow = Schema.Struct({ id: Schema.String, project_id: NullStr })
const PathRow = Schema.Struct({ p: Schema.String })
const ModelRow = Schema.Struct({ model: NullStr })
const IdRow = Schema.Struct({ id: Schema.String })
const CountRow = Schema.Struct({ n: Int })

const first = <A>(rows: ReadonlyArray<A>) => rows[0] ?? null

export interface AnalyticsRepoShape {
  readonly profileExists: (profile: ProfileId) => Effect.Effect<boolean>
  /** Each task of the profile and the task its activity counts for (a review thread's parent). */
  readonly owners: (profile: ProfileId) => Effect.Effect<ReadonlyArray<typeof OwnerRow.Type>>
  /** The runs of the profile's tasks going at some time in `[from, to)`, by their owner. */
  readonly runSpans: (profile: ProfileId, from: string, to: string) => Effect.Effect<ReadonlyArray<typeof RunSpanRow.Type>>
  readonly task: (id: string) => Effect.Effect<AnalyticsTask | null>
  readonly projects: (profile: ProfileId) => Effect.Effect<ReadonlyArray<AnalyticsProject>>
  readonly contextStats: (profile: ProfileId, from: string, to: string) => Effect.Effect<ReadonlyArray<ContextStat>>
  readonly runUsage: (profile: ProfileId, from: string, to: string) => Effect.Effect<ReadonlyArray<typeof RunUsageRow.Type>>
  /**
   * The model calls that weren't runs in `[from, to)`: titles of the profile's tasks, and the window restarts of the
   * configs it's the first profile to use (a config none uses, in the first profile's).
   */
  readonly callUsage: (profile: ProfileId, from: string, to: string) => Effect.Effect<ReadonlyArray<typeof CallUsageRow.Type>>
  readonly reviewStats: (profile: ProfileId, from: string, to: string) => Effect.Effect<ReadonlyArray<typeof ReviewStatRow.Type>>
  /** The model a run used most, by output. */
  readonly runModel: (run: string) => Effect.Effect<string | null>
  /** The model a task's own agent used most in its latest counted prompt run that started before `before`. */
  readonly taskModelBefore: (task: string, before: string) => Effect.Effect<string | null>
  /** Every submission for a task, by round. */
  readonly rounds: (task: string) => Effect.Effect<ReadonlyArray<typeof RoundStatRow.Type>>
  readonly parentOf: (task: string) => Effect.Effect<string | null>
  readonly followUps: (profile: ProfileId) => Effect.Effect<ReadonlyArray<typeof FollowUpRow.Type>>
  readonly taskExtra: (task: string) => Effect.Effect<typeof TaskExtraRow.Type | null>
  /** The profile's runs that ended and whose tokens aren't counted yet. */
  readonly pending: (profile: ProfileId) => Effect.Effect<number>
  /** Every worktree and repository on the host, whatever its profile. */
  readonly ownedPaths: Effect.Effect<ReadonlyArray<string>>
  /** The profile's runs, with their tasks' projects. */
  readonly profileRuns: (profile: ProfileId) => Effect.Effect<ReadonlyArray<typeof RunProjectRow.Type>>
  /** The profile's projects, oldest first. */
  readonly diskProjects: (profile: ProfileId) => Effect.Effect<ReadonlyArray<DiskProjectRow>>
  readonly worktrees: (project: string) => Effect.Effect<ReadonlyArray<WorktreeRow>>
}

export class AnalyticsRepo extends Context.Service<AnalyticsRepo, AnalyticsRepoShape>()("huntaway-server/analytics/AnalyticsRepo") {
  static readonly layer = Layer.effect(
    AnalyticsRepo,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      type Range = { readonly profile: string; readonly from: string; readonly to: string }
      const RangeRequest = Schema.Struct({ profile: Schema.String, from: Schema.String, to: Schema.String })
      const ranged = <A, AI>(Result: Schema.Codec<A, AI>, execute: (r: Range) => ReturnType<typeof sql.unsafe>) => {
        const q = SqlSchema.findAll({ Request: RangeRequest, Result, execute })
        return (profile: ProfileId, from: string, to: string) => q({ profile, from, to }).pipe(Effect.orDie)
      }
      const all = <A, AI, I>(Request: Schema.Codec<I, I>, Result: Schema.Codec<A, AI>, execute: (r: I) => ReturnType<typeof sql.unsafe>) => {
        const q = SqlSchema.findAll({ Request, Result, execute })
        return (request: I) => q(request).pipe(Effect.orDie)
      }

      const runModelQ = all(
        Schema.String,
        ModelRow,
        (run) => sql`SELECT u.model FROM token_usage u WHERE u.run_id = ${run} ORDER BY u.output_tokens DESC, u.cost_usd DESC LIMIT 1`,
      )
      const taskModelQ = all(
        Schema.Struct({ task: Schema.String, before: Schema.String }),
        ModelRow,
        ({ task, before }) =>
          sql`SELECT u.model FROM token_usage u WHERE u.run_id = (
              SELECT r.id FROM runs r WHERE r.task_id = ${task} AND r.kind = 'prompt' AND r.created_at < ${before}
                AND EXISTS (SELECT 1 FROM token_usage x WHERE x.run_id = r.id) ORDER BY r.created_at DESC LIMIT 1)
            ORDER BY u.output_tokens DESC, u.cost_usd DESC LIMIT 1`,
      )

      return AnalyticsRepo.of({
        profileExists: (profile) =>
          all(Schema.String, IdRow, (id) => sql`SELECT id FROM profiles WHERE id = ${id}`)(profile).pipe(Effect.map((rows) => rows.length > 0)),
        owners: all(Schema.String, OwnerRow, (profile) => sql.unsafe(`SELECT t.id, ${OWNER} AS owner FROM tasks t WHERE t.profile_id = ?`, [profile])),
        runSpans: ranged(RunSpanRow, ({ profile, from, to }) =>
          sql.unsafe(
            `SELECT ${OWNER} AS owner, r.kind AS kind, r.created_at AS created_at, r.ended_at AS ended_at FROM runs r JOIN tasks t ON t.id = r.task_id
              WHERE t.profile_id = ? AND r.created_at < ? AND (r.ended_at IS NULL OR r.ended_at > ?) ORDER BY r.created_at`,
            [profile, to, from],
          ),
        ),
        task: (id) =>
          all(
            Schema.String,
            AnalyticsTask,
            (x) => sql`SELECT id, project_id, kind, number, title, status FROM tasks WHERE id = ${x}`,
          )(id).pipe(Effect.map(first)),
        projects: all(Schema.String, AnalyticsProject, (profile) => sql`SELECT id, name, key FROM projects WHERE profile_id = ${profile} ORDER BY created_at`),
        // Review threads count as themselves here: their contexts are their own.
        contextStats: ranged(
          ContextStat,
          ({ profile, from, to }) =>
            sql`SELECT s.at, s.task_id, s.kind, s.tokens, s.start_tokens, s.post_tokens, s.max_tokens, s.model, s.source, s.cost_usd, s.duration_ms
                FROM context_stats s JOIN tasks t ON t.id = s.task_id
                WHERE t.profile_id = ${profile} AND s.at >= ${from} AND s.at < ${to} ORDER BY s.at`,
        ),
        runUsage: ranged(
          RunUsageRow,
          ({ profile, from, to }) =>
            sql`SELECT u.run_id, r.task_id, r.kind, r.created_at, u.model, u.runtime, u.input_tokens, u.output_tokens, u.cache_read_tokens,
                u.cache_write_tokens, u.cache_write_1h_tokens, u.cache_write_5m_tokens, u.reasoning_tokens, u.cost_usd, u.estimated
              FROM token_usage u JOIN runs r ON r.id = u.run_id JOIN tasks t ON t.id = r.task_id
              WHERE t.profile_id = ${profile} AND r.created_at >= ${from} AND r.created_at < ${to} ORDER BY r.created_at`,
        ),
        // Profiles made in the same millisecond come in the order they were made.
        callUsage: ranged(
          CallUsageRow,
          ({ profile, from, to }) =>
            sql`SELECT u.task_id, u.purpose, u.at, u.model, u.runtime, u.input_tokens, u.output_tokens, u.cache_read_tokens, u.cache_write_tokens,
                u.reasoning_tokens, u.cost_usd, u.call_id, u.cache_write_1h_tokens, u.cache_write_5m_tokens
              FROM call_usage u LEFT JOIN tasks t ON t.id = u.task_id
              WHERE u.at >= ${from} AND u.at < ${to} AND (t.profile_id = ${profile} OR (u.task_id IS NULL AND ${profile} = COALESCE(
                (SELECT p.id FROM profiles p WHERE EXISTS (SELECT 1 FROM json_each(p.claude_config_ids) j WHERE j.value = u.config_id)
                 ORDER BY p.created_at, p.rowid LIMIT 1),
                (SELECT id FROM profiles ORDER BY created_at, rowid LIMIT 1))))
              ORDER BY u.at`,
        ),
        reviewStats: ranged(
          ReviewStatRow,
          ({ profile, from, to }) =>
            sql`SELECT s.task_id, s.thread_id, s.at, s.verdict, s.serious, s.minor, s.minor_noted, s.label, s.run_id, s.round, s.effort
                FROM review_stats s JOIN tasks t ON t.id = s.task_id
                WHERE t.profile_id = ${profile} AND s.at >= ${from} AND s.at < ${to} ORDER BY s.at`,
        ),
        runModel: (run) => Effect.map(runModelQ(run), (rows) => first(rows)?.model ?? null),
        taskModelBefore: (task, before) => Effect.map(taskModelQ({ task, before }), (rows) => first(rows)?.model ?? null),
        rounds: all(Schema.String, RoundStatRow, (task) => sql`SELECT round, verdict, serious FROM review_stats WHERE task_id = ${task} ORDER BY round`),
        parentOf: (task) =>
          all(
            Schema.String,
            IdRow,
            (x) => sql`SELECT parent_id AS id FROM tasks WHERE id = ${x} AND parent_id IS NOT NULL`,
          )(task).pipe(Effect.map((rows) => first(rows)?.id ?? null)),
        followUps: all(
          Schema.String,
          FollowUpRow,
          (profile) => sql`SELECT id, created_by, created_at FROM tasks WHERE created_by IS NOT NULL AND profile_id = ${profile}`,
        ),
        taskExtra: (task) =>
          all(
            Schema.String,
            TaskExtraRow,
            (x) =>
              sql`SELECT parent_id, task_type, group_name,
                  (SELECT u.model FROM token_usage u JOIN runs r ON r.id = u.run_id WHERE r.task_id = tasks.id
                   GROUP BY u.model ORDER BY SUM(u.output_tokens) DESC, SUM(u.cost_usd) DESC LIMIT 1) AS model
                FROM tasks WHERE id = ${x}`,
          )(task).pipe(Effect.map(first)),
        pending: (profile) =>
          all(
            Schema.String,
            CountRow,
            (p) =>
              sql`SELECT COUNT(*) AS n FROM runs r JOIN tasks t ON t.id = r.task_id WHERE t.profile_id = ${p} AND r.status = 'exited' AND r.usage_at IS NULL`,
          )(profile).pipe(Effect.map((rows) => first(rows)?.n ?? 0)),
        ownedPaths: all(
          Schema.Void,
          PathRow,
          () => sql`SELECT worktree_path AS p FROM tasks WHERE worktree_path IS NOT NULL AND worktree_path <> '' UNION SELECT repo_path AS p FROM projects`,
        )(undefined).pipe(Effect.map((rows) => rows.map((r) => r.p))),
        profileRuns: all(
          Schema.String,
          RunProjectRow,
          (p) => sql`SELECT r.id, t.project_id FROM runs r JOIN tasks t ON t.id = r.task_id WHERE t.profile_id = ${p}`,
        ),
        // In the order analytics lists them, which the UI's colours follow.
        diskProjects: all(
          Schema.String,
          DiskProjectRow,
          (p) => sql`SELECT id, name, key, repo_path, scratch_path, worktrees_root FROM projects WHERE profile_id = ${p} ORDER BY created_at`,
        ),
        worktrees: all(
          Schema.String,
          WorktreeRow,
          (project) =>
            sql`SELECT id, kind, number, title, status, worktree_path AS path FROM tasks
                WHERE project_id = ${project} AND worktree_path IS NOT NULL AND worktree_path <> '' ORDER BY number`,
        ),
      })
    }),
  )
}
