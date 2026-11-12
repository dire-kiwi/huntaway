import { Context, Effect, Layer, Schema } from "effect"
import { SqlSchema } from "effect/sql"
import { SyncLost } from "@huntaway/contracts"
import type { SyncEntry } from "@huntaway/contracts"
import { Db } from "../platform/Db.ts"
import { canon, parseJson } from "./settingsSync/merge.ts"

// The `setting_versions` table (docs/plan/04-database.md; inventory 05 §3.1): settings sync's entry for each synced field,
// with what this host's own tables held when it was last compared (`seen`). JSON is written canonically (sorted keys),
// so two hosts write one value the same way. Single statements; `SqlError` is a defect. Nothing here waits.

/** An entry with `seen`: the canonical JSON of what this host's tables had when last compared; null when the field's profile isn't here. */
export interface SyncRow extends SyncEntry {
  readonly seen: string | null
}

/** A `setting_versions` row as stored. */
export const SettingVersionRow = Schema.Struct({
  name: Schema.String,
  value: Schema.String,
  vv: Schema.String,
  changed_at: Schema.String,
  changed_by: Schema.String,
  lost: Schema.String,
  seen: Schema.NullOr(Schema.String),
  since: Schema.String,
})

const Counters = Schema.Record(Schema.String, Schema.Int)
const isCounters = Schema.is(Counters)
const isLost = Schema.is(Schema.Array(SyncLost))

/** A row as an entry; null for one that can't be read (dropped, as the old server did, with a warning). */
const rowOf = (r: typeof SettingVersionRow.Type): SyncRow | null => {
  const vv = parseJson(r.vv)
  const lost = parseJson(r.lost)
  if (!isCounters(vv) || !isLost(lost)) return null
  return { name: r.name, value: parseJson(r.value), vv, changed_at: r.changed_at, changed_by: r.changed_by, since: r.since, lost, seen: r.seen }
}

export interface SettingsSyncRepoShape {
  /** Every entry, by name. */
  readonly all: Effect.Effect<Map<string, SyncRow>>
  /** Writes an entry, as it is. */
  readonly put: (row: SyncRow) => Effect.Effect<void>
}

export class SettingsSyncRepo extends Context.Service<SettingsSyncRepo, SettingsSyncRepoShape>()("huntaway-server/hosts/SettingsSyncRepo") {
  static readonly layer = Layer.effect(
    SettingsSyncRepo,
    Effect.gen(function* () {
      const { sql } = yield* Db
      const findAll = SqlSchema.findAll({
        Request: Schema.Void,
        Result: SettingVersionRow,
        execute: () => sql`SELECT name, value, vv, changed_at, changed_by, lost, seen, since FROM setting_versions ORDER BY name`,
      })
      const all = Effect.gen(function* () {
        const out = new Map<string, SyncRow>()
        for (const r of yield* findAll(undefined)) {
          const row = rowOf(r)
          if (row === null) yield* Effect.logWarning(`settings sync: dropping the entry for ${r.name}, which can't be read`)
          else out.set(row.name, row)
        }
        return out
      }).pipe(Effect.orDie)
      const put = (r: SyncRow) =>
        sql`INSERT INTO setting_versions (name, value, vv, changed_at, changed_by, lost, seen, since)
            VALUES (${r.name}, ${canon(r.value)}, ${canon(r.vv)}, ${r.changed_at}, ${r.changed_by}, ${canon(r.lost)}, ${r.seen}, ${r.since})
            ON CONFLICT (name) DO UPDATE SET value = excluded.value, vv = excluded.vv, changed_at = excluded.changed_at,
              changed_by = excluded.changed_by, lost = excluded.lost, seen = excluded.seen, since = excluded.since`.pipe(Effect.asVoid, Effect.orDie)
      return SettingsSyncRepo.of({ all, put })
    }),
  )
}
