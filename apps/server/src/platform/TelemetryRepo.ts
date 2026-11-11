import { Context, Effect, Layer, Redacted, Schema } from "effect"
import { SqlClient, SqlSchema } from "effect/sql"
import type { ProfileId, RunId, TaskId } from "@huntaway/contracts"

// Telemetry's rows (the old telemetry.ts's statements): its settings in `settings` (the password only here, as a
// `Redacted`; docs/plan/04-database.md, secrets), the outbox `telemetry_outbox`, and what its rows carry of a task, a
// profile and the host. Statements only; `Telemetry` decides.

/** The settings telemetry keeps in `settings`. */
export const KEYS = {
  url: "telemetry_url",
  database: "telemetry_database",
  user: "telemetry_user",
  password: "telemetry_password",
  logs: "telemetry_logs",
  agents: "telemetry_agents",
  inflight: "telemetry_inflight",
  dropped: "telemetry_dropped",
  /** When this host first sent: `huntaway telemetry backfill` sends its history from before then. */
  since: "telemetry_since",
} as const

/** The columns a task's rows carry. */
export interface TaskContext {
  readonly profile: string
  readonly project_id: string
  readonly project_key: string
  readonly task_id: string
  readonly task_key: string
  readonly task_title: string
}

const ContextRow = Schema.Struct({
  id: Schema.String,
  project_id: Schema.NullOr(Schema.String),
  number: Schema.Int,
  title: Schema.String,
  key: Schema.NullOr(Schema.String),
  name: Schema.String,
  telemetry: Schema.Int,
  telemetry_titles: Schema.Int,
})

const ProfileRow = Schema.Struct({ name: Schema.String, telemetry: Schema.Int, telemetry_titles: Schema.Int, claude_config_ids: Schema.String })

export const OutboxRow = Schema.Struct({ id: Schema.Int, row: Schema.String, at: Schema.String })
export type OutboxRow = typeof OutboxRow.Type

const n = (rows: ReadonlyArray<{ readonly n: number | null }>) => rows[0]?.n ?? 0

export interface TelemetryRepoShape {
  /** A setting as stored (untrimmed), null for none. */
  readonly setting: (key: string) => Effect.Effect<string | null>
  /** Stores a setting as given (a password is not trimmed); null or empty deletes it. */
  readonly setSetting: (key: string, value: string | null) => Effect.Effect<void>
  readonly password: Effect.Effect<Redacted.Redacted | null>
  readonly add: (target: string, row: string, at: string) => Effect.Effect<void>
  /** How many rows wait, and their size. */
  readonly size: Effect.Effect<{ readonly n: number; readonly bytes: number }>
  /** How many rows wait for each table. */
  readonly queued: Effect.Effect<ReadonlyArray<{ readonly target: string; readonly n: number }>>
  /** The table of the oldest row, if any. */
  readonly oldestTarget: Effect.Effect<string | null>
  /** The oldest `limit` rows of `target`. */
  readonly rowsOf: (target: string, limit: number) => Effect.Effect<ReadonlyArray<OutboxRow>>
  /** `target`'s rows with ids in `[first, last]`. */
  readonly rowsBetween: (target: string, first: number, last: number) => Effect.Effect<ReadonlyArray<OutboxRow>>
  readonly deleteBetween: (target: string, first: number, last: number) => Effect.Effect<void>
  readonly deleteTarget: (target: string) => Effect.Effect<void>
  readonly deleteAll: Effect.Effect<void>
  /** The id of the `n`th oldest row (from 1), if there are that many. */
  readonly nthId: (n: number) => Effect.Effect<number | null>
  /** Deletes the rows up to `id`: how many. */
  readonly deleteUpTo: (id: number) => Effect.Effect<number>
  /** A task's columns, if its profile sends (null when it doesn't, or the task is gone). */
  readonly taskContext: (task: TaskId) => Effect.Effect<TaskContext | null>
  /** A profile that sends: its name, whether titles go and its configs. Null when it doesn't (or is gone). */
  readonly profile: (profile: ProfileId) => Effect.Effect<{ readonly name: string; readonly titles: boolean; readonly configs: string } | null>
  /** The first profile that sends and has the config (by when it was made). */
  readonly profileWithConfig: (config: string) => Effect.Effect<string | null>
  readonly runTask: (run: RunId) => Effect.Effect<TaskId | null>
  /** The tasks needing attention and the runs going, for the minute's metrics. */
  readonly counts: Effect.Effect<{ readonly attention: number; readonly running: number }>
}

export class TelemetryRepo extends Context.Service<TelemetryRepo, TelemetryRepoShape>()("huntaway-server/platform/TelemetryRepo") {
  static readonly layer = Layer.effect(
    TelemetryRepo,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient

      const setting = (key: string) =>
        sql<{ readonly value: string }>`SELECT value FROM settings WHERE key = ${key}`.pipe(
          Effect.map((rows) => rows[0]?.value ?? null),
          Effect.orDie,
        )
      const setSetting = (key: string, value: string | null) =>
        (value === null || value === ""
          ? sql`DELETE FROM settings WHERE key = ${key}`
          : sql`INSERT INTO settings (key, value) VALUES (${key}, ${value}) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
        ).pipe(Effect.asVoid, Effect.orDie)

      const rowsOfQuery = SqlSchema.findAll({
        Request: Schema.Struct({ target: Schema.String, limit: Schema.Int }),
        Result: OutboxRow,
        execute: ({ target, limit }) => sql`SELECT id, row, at FROM telemetry_outbox WHERE target = ${target} ORDER BY id LIMIT ${limit}`,
      })
      const rowsBetweenQuery = SqlSchema.findAll({
        Request: Schema.Struct({ target: Schema.String, first: Schema.Int, last: Schema.Int }),
        Result: OutboxRow,
        execute: ({ target, first, last }) =>
          sql`SELECT id, row, at FROM telemetry_outbox WHERE target = ${target} AND id BETWEEN ${first} AND ${last} ORDER BY id`,
      })
      const contextQuery = SqlSchema.findOneOption({
        Request: Schema.String,
        Result: ContextRow,
        execute: (task) =>
          sql`SELECT t.id, t.project_id, t.number, t.title, p.key, f.name, f.telemetry, f.telemetry_titles
                FROM tasks t JOIN profiles f ON f.id = t.profile_id LEFT JOIN projects p ON p.id = t.project_id WHERE t.id = ${task}`,
      })
      const profileQuery = SqlSchema.findOneOption({
        Request: Schema.String,
        Result: ProfileRow,
        execute: (id) => sql`SELECT name, telemetry, telemetry_titles, claude_config_ids FROM profiles WHERE id = ${id}`,
      })

      return TelemetryRepo.of({
        setting,
        setSetting,
        password: Effect.map(setting(KEYS.password), (v) => (v === null ? null : Redacted.make(v, { label: "telemetry password" }))),
        add: (target, row, at) => sql`INSERT INTO telemetry_outbox (target, row, at) VALUES (${target}, ${row}, ${at})`.pipe(Effect.asVoid, Effect.orDie),
        size: sql<{ readonly n: number; readonly bytes: number }>`SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(row)), 0) AS bytes FROM telemetry_outbox`.pipe(
          Effect.map((rows) => ({ n: rows[0]?.n ?? 0, bytes: rows[0]?.bytes ?? 0 })),
          Effect.orDie,
        ),
        queued: sql<{ readonly target: string; readonly n: number }>`SELECT target, COUNT(*) AS n FROM telemetry_outbox GROUP BY target`.pipe(Effect.orDie),
        oldestTarget: sql<{ readonly target: string }>`SELECT target FROM telemetry_outbox ORDER BY id LIMIT 1`.pipe(
          Effect.map((rows) => rows[0]?.target ?? null),
          Effect.orDie,
        ),
        rowsOf: (target, limit) => rowsOfQuery({ target, limit }).pipe(Effect.orDie),
        rowsBetween: (target, first, last) => rowsBetweenQuery({ target, first, last }).pipe(Effect.orDie),
        deleteBetween: (target, first, last) =>
          sql`DELETE FROM telemetry_outbox WHERE target = ${target} AND id BETWEEN ${first} AND ${last}`.pipe(Effect.asVoid, Effect.orDie),
        deleteTarget: (target) => sql`DELETE FROM telemetry_outbox WHERE target = ${target}`.pipe(Effect.asVoid, Effect.orDie),
        deleteAll: sql`DELETE FROM telemetry_outbox`.pipe(Effect.asVoid, Effect.orDie),
        nthId: (k) =>
          sql<{ readonly id: number }>`SELECT id FROM telemetry_outbox ORDER BY id LIMIT 1 OFFSET ${k - 1}`.pipe(
            Effect.map((rows) => rows[0]?.id ?? null),
            Effect.orDie,
          ),
        deleteUpTo: (id) =>
          Effect.gen(function* () {
            const before = n(yield* sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM telemetry_outbox WHERE id <= ${id}`)
            yield* sql`DELETE FROM telemetry_outbox WHERE id <= ${id}`
            return before
          }).pipe(Effect.orDie),
        taskContext: (task) =>
          contextQuery(task).pipe(
            Effect.map((found) => {
              if (found._tag === "None" || found.value.telemetry === 0) return null
              const t = found.value
              const key = t.key ?? ""
              return {
                profile: t.name,
                project_id: t.project_id ?? "",
                project_key: key,
                task_id: t.id,
                task_key: key === "" ? "" : `${key}-${t.number}`,
                task_title: t.telemetry_titles === 0 ? "" : t.title,
              }
            }),
            Effect.orDie,
          ),
        profile: (id) =>
          profileQuery(id).pipe(
            Effect.map((found) =>
              found._tag === "None" || found.value.telemetry === 0
                ? null
                : { name: found.value.name, titles: found.value.telemetry_titles !== 0, configs: found.value.claude_config_ids },
            ),
            Effect.orDie,
          ),
        profileWithConfig: (config) =>
          sql<{ readonly id: string }>`SELECT p.id FROM profiles p WHERE p.telemetry = 1
              AND EXISTS (SELECT 1 FROM json_each(p.claude_config_ids) j WHERE j.value = ${config}) ORDER BY p.created_at, p.rowid LIMIT 1`.pipe(
            Effect.map((rows) => rows[0]?.id ?? null),
            Effect.orDie,
          ),
        runTask: (run) =>
          sql<{ readonly task_id: TaskId }>`SELECT task_id FROM runs WHERE id = ${run}`.pipe(
            Effect.map((rows) => rows[0]?.task_id ?? null),
            Effect.orDie,
          ),
        counts: Effect.gen(function* () {
          const attention = n(yield* sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM tasks WHERE status = 'needs_attention'`)
          const running = n(yield* sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM runs WHERE status != 'exited'`)
          return { attention, running }
        }).pipe(Effect.orDie),
      })
    }),
  )
}
