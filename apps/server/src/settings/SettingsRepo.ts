import { Context, Effect, Layer, Schema } from "effect"
import { SqlSchema } from "effect/sql"
import { Db } from "../platform/Db.ts"

const SettingRow = Schema.Struct({ key: Schema.String, value: Schema.String })

export interface SettingsRepoShape {
  /** Every row of `settings`, by key. */
  readonly all: Effect.Effect<ReadonlyMap<string, string>>
  readonly get: (key: string) => Effect.Effect<string | null>
  /**
   * Store a setting's value, trimmed; null or blank deletes the row, so "unset" is always "no row"
   * (docs/plan/inventory/09-data-model.md, section 3d).
   */
  readonly set: (key: string, value: string | null) => Effect.Effect<void>
  /** Whether `id` is a linked host (a `links` row): what a setting naming one must be. */
  readonly linkExists: (id: string) => Effect.Effect<boolean>
}

/** The `settings` table: one text value per key. */
export class SettingsRepo extends Context.Service<SettingsRepo, SettingsRepoShape>()("huntaway-server/settings/SettingsRepo") {
  static readonly layer = Layer.effect(
    SettingsRepo,
    Effect.gen(function* () {
      const { sql } = yield* Db
      const findAll = SqlSchema.findAll({ Request: Schema.Void, Result: SettingRow, execute: () => sql`SELECT key, value FROM settings` })
      const findOne = SqlSchema.findOneOption({
        Request: Schema.String,
        Result: SettingRow,
        execute: (key) => sql`SELECT key, value FROM settings WHERE key = ${key}`,
      })
      const all = findAll(undefined).pipe(
        Effect.map((rows) => new Map(rows.map((r) => [r.key, r.value]))),
        Effect.orDie,
      )
      const get = (key: string) =>
        findOne(key).pipe(
          Effect.map((row) => (row._tag === "Some" ? row.value.value : null)),
          Effect.orDie,
        )
      const linkExists = (id: string) =>
        sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM links WHERE id = ${id}`.pipe(
          Effect.map((rows) => (rows[0]?.n ?? 0) > 0),
          Effect.orDie,
        )
      const set = (key: string, value: string | null) => {
        const text = value?.trim() ?? ""
        return (
          text === ""
            ? sql`DELETE FROM settings WHERE key = ${key}`
            : sql`INSERT INTO settings (key, value) VALUES (${key}, ${text}) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
        ).pipe(Effect.asVoid, Effect.orDie)
      }
      return SettingsRepo.of({ all, get, set, linkExists })
    }),
  )
}
