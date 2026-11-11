import { Context, Effect, Layer, Option, Redacted, Schema } from "effect"
import { SqlSchema } from "effect/sql"
import { Agent, AgentConfigId, Timestamp } from "@huntaway/contracts"
import { Db } from "../platform/Db.ts"
import { Bit, encodeColumns, JsonColumn, toJson } from "../platform/columns.ts"

/** An `agent_configs` row as the wire's `AgentConfig` without `settings_api_url` (read from its folder). Keys are not selected: only whether it has them. */
export const AgentConfigRow = Schema.Struct({
  id: AgentConfigId,
  name: Schema.String,
  config_dir: Schema.String,
  agent: Agent,
  show_usage: Bit,
  restart_window: Bit,
  api_url: Schema.NullOr(Schema.String),
  has_api_key: Bit,
  has_management_key: Bit,
  created_at: Timestamp,
})
export type AgentConfigRow = typeof AgentConfigRow.Type

const SELECT = `SELECT id, name, config_dir, agent, show_usage, restart_window, api_url, api_key IS NOT NULL AS has_api_key,
  management_key IS NOT NULL AS has_management_key, created_at FROM agent_configs`

/** The columns a write may set. */
export type AgentConfigColumns = {
  readonly name?: string
  readonly config_dir?: string
  readonly agent?: Agent
  readonly show_usage?: boolean
  readonly restart_window?: boolean
  readonly api_url?: string | null
  readonly api_key?: string | null
  readonly management_key?: string | null
}

/** A config's proxy keys: secrets, read only here. */
export interface AgentConfigKeys {
  readonly api_key: Redacted.Redacted | null
  readonly management_key: Redacted.Redacted | null
}

const count = (rows: ReadonlyArray<{ readonly n: number }>) => rows[0]?.n ?? 0
const secret = (v: string | null | undefined) => (v == null ? null : Redacted.make(v))

const IdList = JsonColumn(Schema.Array(Schema.String), [])

export interface AgentConfigRepoShape {
  /** By name whatever its case, then age. */
  readonly list: Effect.Effect<ReadonlyArray<AgentConfigRow>>
  readonly get: (id: AgentConfigId) => Effect.Effect<Option.Option<AgentConfigRow>>
  readonly insert: (id: AgentConfigId, createdAt: Timestamp, columns: AgentConfigColumns) => Effect.Effect<void>
  readonly update: (id: AgentConfigId, columns: AgentConfigColumns) => Effect.Effect<void>
  /** The one read of a config's keys. */
  readonly keys: (id: AgentConfigId) => Effect.Effect<AgentConfigKeys>
  /** The oldest Claude Code config on `dir`, if any (the old `config_for_dir`). */
  readonly byDir: (dir: string) => Effect.Effect<Option.Option<AgentConfigId>>
  /** How many threads have a conversation in the config. */
  readonly sessions: (id: AgentConfigId) => Effect.Effect<number>
  /** How many threads run an agent with the config. */
  readonly running: (id: AgentConfigId) => Effect.Effect<number>
  /**
   * Delete the config and take it off every profile and project: a profile's assistant or threads pick goes back to
   * its default, and a project's own list left empty goes back to its profile's.
   */
  readonly delete: (id: AgentConfigId) => Effect.Effect<void>
}

/** The `agent_configs` table (was `claude_configs`). */
export class AgentConfigRepo extends Context.Service<AgentConfigRepo, AgentConfigRepoShape>()("huntaway-server/profiles/AgentConfigRepo") {
  static readonly layer = Layer.effect(
    AgentConfigRepo,
    Effect.gen(function* () {
      const { sql } = yield* Db
      const findAll = SqlSchema.findAll({
        Request: Schema.Void,
        Result: AgentConfigRow,
        execute: () => sql.unsafe(`${SELECT} ORDER BY name COLLATE NOCASE, created_at`),
      })
      const findOne = SqlSchema.findOneOption({ Request: AgentConfigId, Result: AgentConfigRow, execute: (id) => sql.unsafe(`${SELECT} WHERE id = ?`, [id]) })
      const decodeIds = Schema.decodeUnknownEffect(IdList)

      const insert = (id: AgentConfigId, createdAt: Timestamp, columns: AgentConfigColumns) =>
        Effect.gen(function* () {
          const row = yield* encodeColumns({ ...columns, id, created_at: createdAt })
          yield* sql`INSERT INTO agent_configs ${sql.insert(row)}`
        }).pipe(Effect.orDie)

      const update = (id: AgentConfigId, columns: AgentConfigColumns) =>
        Effect.gen(function* () {
          const row = yield* encodeColumns(columns)
          if (Object.keys(row).length === 0) return
          yield* sql`UPDATE agent_configs SET ${sql.update(row)} WHERE id = ${id}`
        }).pipe(Effect.orDie)

      const keys = (id: AgentConfigId) =>
        sql<{
          readonly api_key: string | null
          readonly management_key: string | null
        }>`SELECT api_key, management_key FROM agent_configs WHERE id = ${id}`.pipe(
          Effect.map((rows) => {
            const row = rows[0]
            return { api_key: secret(row?.api_key), management_key: secret(row?.management_key) }
          }),
          Effect.orDie,
        )

      const byDir = (dir: string) =>
        sql<{
          readonly id: AgentConfigId
        }>`SELECT id FROM agent_configs WHERE config_dir = ${dir.trim()} AND agent = 'claude' ORDER BY created_at LIMIT 1`.pipe(
          Effect.map((rows) => Option.fromNullishOr(rows[0]?.id)),
          Effect.orDie,
        )

      const remove = (id: AgentConfigId) =>
        Effect.gen(function* () {
          yield* sql`DELETE FROM agent_configs WHERE id = ${id}`
          for (const p of yield* sql<{ readonly id: string; readonly ids: string }>`SELECT id, claude_config_ids AS ids FROM profiles`) {
            const list = yield* decodeIds(p.ids)
            if (list.includes(id)) yield* sql`UPDATE profiles SET claude_config_ids = ${yield* toJson(list.filter((x) => x !== id))} WHERE id = ${p.id}`
          }
          yield* sql`UPDATE profiles SET assistant_config_id = NULL WHERE assistant_config_id = ${id}`
          yield* sql`UPDATE profiles SET threads_config_id = NULL WHERE threads_config_id = ${id}`
          for (const p of yield* sql<{
            readonly id: string
            readonly ids: string
          }>`SELECT id, claude_config_ids AS ids FROM projects WHERE claude_config_ids IS NOT NULL`) {
            const list = yield* decodeIds(p.ids)
            if (!list.includes(id)) continue
            const rest = list.filter((x) => x !== id)
            yield* sql`UPDATE projects SET claude_config_ids = ${rest.length === 0 ? null : yield* toJson(rest)} WHERE id = ${p.id}`
          }
        }).pipe(Effect.orDie)

      return AgentConfigRepo.of({
        list: findAll(undefined).pipe(Effect.orDie),
        get: (id) => findOne(id).pipe(Effect.orDie),
        insert,
        update,
        keys,
        byDir,
        sessions: (id) =>
          sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM tasks WHERE claude_config_id = ${id} AND session_id IS NOT NULL`.pipe(
            Effect.map(count),
            Effect.orDie,
          ),
        running: (id) =>
          sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM tasks WHERE claude_config_id = ${id} AND running = 1`.pipe(Effect.map(count), Effect.orDie),
        delete: remove,
      })
    }),
  )
}
