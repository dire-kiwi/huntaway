import { Context, Effect, Layer, Option, Redacted, Schema } from "effect"
import { SqlSchema } from "effect/sql"
import { Db } from "./Db.ts"

// Secrets by name (docs/plan/06-server.md, Platform): values the board makes once and keeps, never shown or logged.
// Kept in the `settings` table under their name, as the old board kept its VAPID key; `HostSettings` reads only the
// keys of its own schema. 6.8 added it for the VAPID key; the telemetry password (6.9) goes here too.

export interface SecretsShape {
  /** The secret `name`, if it has been made. */
  readonly get: (name: string) => Effect.Effect<Option.Option<Redacted.Redacted>>
  /**
   * The secret `name`; the first time, `make`'s value, kept. Two first uses at once both get the one kept (the first
   * to be written wins).
   */
  readonly getOrMake: <E, R>(name: string, make: Effect.Effect<string, E, R>) => Effect.Effect<Redacted.Redacted, E, R>
}

const Row = Schema.Struct({ value: Schema.String })

export class Secrets extends Context.Service<Secrets, SecretsShape>()("huntaway-server/platform/Secrets") {
  static readonly layer = Layer.effect(
    Secrets,
    Effect.gen(function* () {
      const { sql } = yield* Db
      const find = SqlSchema.findOneOption({
        Request: Schema.String,
        Result: Row,
        execute: (name) => sql`SELECT value FROM settings WHERE key = ${name}`,
      })
      const get = (name: string) => find(name).pipe(Effect.map(Option.map((row) => Redacted.make(row.value, { label: name }))), Effect.orDie)
      const getOrMake = <E, R>(name: string, make: Effect.Effect<string, E, R>) =>
        Effect.flatMap(get(name), (found) =>
          Option.isSome(found)
            ? Effect.succeed(found.value)
            : Effect.flatMap(make, (value) =>
                sql`INSERT INTO settings (key, value) VALUES (${name}, ${value}) ON CONFLICT(key) DO NOTHING`.pipe(
                  Effect.orDie,
                  Effect.andThen(get(name)),
                  Effect.map(Option.getOrElse(() => Redacted.make(value, { label: name }))),
                ),
              ),
        )
      return Secrets.of({ get, getOrMake })
    }),
  )
}
