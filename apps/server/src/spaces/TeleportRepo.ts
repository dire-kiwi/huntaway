import { Context, Effect, Layer, Option, Schema } from "effect"
import { SqlSchema } from "effect/sql"
import { TeleportImport } from "@huntaway/contracts"
import { Db } from "../platform/Db.ts"

// The `space_teleports` table (HE-49): the teleports that landed in a Space, kept so "Remove sign-ins" can wipe them
// (`WipeImport`) and the host's page can list them. Spaces have no table of their own; this one does, because an
// `import_id` the server chose must survive a restart for the wipe to find it.

export interface TeleportRepoShape {
  /** Record a teleport that committed into a Space. */
  readonly add: (row: TeleportImport) => Effect.Effect<void>
  /** A Space's teleports, newest first. */
  readonly forSpace: (spaceId: string) => Effect.Effect<ReadonlyArray<TeleportImport>>
  /** One by its import id. */
  readonly get: (importId: string) => Effect.Effect<TeleportImport | null>
  /** Forget a teleport (it was wiped). */
  readonly remove: (importId: string) => Effect.Effect<void>
  /** Forget every teleport of a Space (its container is gone). */
  readonly removeSpace: (spaceId: string) => Effect.Effect<void>
}

export class TeleportRepo extends Context.Service<TeleportRepo, TeleportRepoShape>()("huntaway-server/spaces/TeleportRepo") {
  static readonly layer = Layer.effect(
    TeleportRepo,
    Effect.gen(function* () {
      const { sql } = yield* Db
      const insert = SqlSchema.void({
        Request: TeleportImport,
        execute: (r) =>
          sql`INSERT INTO space_teleports (import_id, space_id, app, label, site_count, expires_at, created_at)
              VALUES (${r.import_id}, ${r.space_id}, ${r.app}, ${r.label}, ${r.site_count}, ${r.expires_at}, ${r.created_at})`,
      })
      const bySpace = SqlSchema.findAll({
        Request: Schema.String,
        Result: TeleportImport,
        execute: (id) => sql`SELECT * FROM space_teleports WHERE space_id = ${id} ORDER BY created_at DESC`,
      })
      const byId = SqlSchema.findOneOption({
        Request: Schema.String,
        Result: TeleportImport,
        execute: (id) => sql`SELECT * FROM space_teleports WHERE import_id = ${id}`,
      })
      return TeleportRepo.of({
        add: (row) => insert(row).pipe(Effect.orDie),
        forSpace: (id) => bySpace(id).pipe(Effect.orDie),
        get: (id) => byId(id).pipe(Effect.map(Option.getOrNull), Effect.orDie),
        remove: (id) => sql`DELETE FROM space_teleports WHERE import_id = ${id}`.pipe(Effect.asVoid, Effect.orDie),
        removeSpace: (id) => sql`DELETE FROM space_teleports WHERE space_id = ${id}`.pipe(Effect.asVoid, Effect.orDie),
      })
    }),
  )
}
