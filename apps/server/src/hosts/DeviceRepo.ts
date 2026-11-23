import { Context, Effect, Layer, Option, Schema } from "effect"
import { SqlSchema } from "effect/sql"
import { DeviceId, Timestamp } from "@huntaway/contracts"
import type { Device } from "@huntaway/contracts"
import { Db } from "../platform/Db.ts"

// The `device_tokens` table (HE-91; docs/plan/inventory/05-hosts-update.md, 3.1): a paired device, and its token as a
// SHA-256 hash only. Single statements; `SqlError` and `SchemaError` are defects.

const DeviceRow = Schema.Struct({
  id: DeviceId,
  name: Schema.String,
  token_hash: Schema.String,
  created_at: Timestamp,
  last_used_at: Schema.NullOr(Timestamp),
})

/** A device as the board keeps it: what it shows, and its token's hash. */
export interface StoredDevice extends Device {
  readonly token_hash: string
}

const run = <A, E>(statement: Effect.Effect<A, E>) => Effect.orDie(Effect.asVoid(statement))

export class DeviceRepo extends Context.Service<
  DeviceRepo,
  {
    /** Every device, oldest first. */
    readonly list: Effect.Effect<ReadonlyArray<StoredDevice>>
    readonly get: (id: DeviceId) => Effect.Effect<StoredDevice | null>
    readonly insert: (device: StoredDevice) => Effect.Effect<void>
    readonly touch: (id: DeviceId, at: Timestamp) => Effect.Effect<void>
    /** Whether there was one to delete. */
    readonly delete: (id: DeviceId) => Effect.Effect<boolean>
  }
>()("huntaway-server/hosts/DeviceRepo") {
  static readonly layer = Layer.effect(
    DeviceRepo,
    Effect.gen(function* () {
      const { sql } = yield* Db
      const all = SqlSchema.findAll({
        Request: Schema.Void,
        Result: DeviceRow,
        execute: () => sql`SELECT * FROM device_tokens ORDER BY created_at, id`,
      })
      const one = SqlSchema.findOneOption({
        Request: DeviceId,
        Result: DeviceRow,
        execute: (id) => sql`SELECT * FROM device_tokens WHERE id = ${id}`,
      })
      return DeviceRepo.of({
        list: Effect.orDie(all(undefined)),
        get: (id) => one(id).pipe(Effect.map(Option.getOrNull), Effect.orDie),
        insert: (d) =>
          run(sql`INSERT INTO device_tokens (id, name, token_hash, created_at, last_used_at)
            VALUES (${d.id}, ${d.name}, ${d.token_hash}, ${d.created_at}, ${d.last_used_at})`),
        touch: (id, at) => run(sql`UPDATE device_tokens SET last_used_at = ${at} WHERE id = ${id}`),
        delete: (id) =>
          sql`DELETE FROM device_tokens WHERE id = ${id} RETURNING id`.pipe(
            Effect.map((rows) => rows.length > 0),
            Effect.orDie,
          ),
      })
    }),
  )
}
