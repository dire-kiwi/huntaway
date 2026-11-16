import { Context, Effect, Layer, Option, Redacted, Schema } from "effect"
import { SqlClient, SqlSchema } from "effect/sql"
import { SignIn } from "@huntaway/contracts"
import type { ProfileId, Timestamp } from "@huntaway/contracts"

// The `sign_ins` table (HE-48): a profile's saved logins for Spaces. Statements only; `SignIns` decides. The password
// column is read here alone, by `password`, as a `Redacted` (docs/plan/04-database.md, secrets): every other select
// leaves it out, so no row the board sends can carry it.

/** A new row. */
export interface SignInRow {
  readonly id: string
  readonly profile_id: ProfileId
  readonly origin: string
  readonly username: string
  readonly password: Redacted.Redacted
  readonly label: string | null
  readonly at: Timestamp
}

/** What an update sets; a field left out stays. */
export interface SignInSet {
  readonly username?: string | undefined
  readonly password?: Redacted.Redacted | undefined
  readonly label?: string | null | undefined
  readonly at: Timestamp
}

export interface SignInRepoShape {
  /** A profile's sign-ins (every profile's when null), by site then username. */
  readonly list: (profile: ProfileId | null) => Effect.Effect<ReadonlyArray<SignIn>>
  readonly get: (id: string) => Effect.Effect<Option.Option<SignIn>>
  /** A profile's sign-ins for `origin`. */
  readonly forOrigin: (profile: ProfileId, origin: string) => Effect.Effect<ReadonlyArray<SignIn>>
  /** The sign-in's password, if it's there. */
  readonly password: (id: string) => Effect.Effect<Option.Option<Redacted.Redacted>>
  readonly insert: (row: SignInRow) => Effect.Effect<void>
  /** Whether there was one to change. */
  readonly update: (id: string, set: SignInSet) => Effect.Effect<boolean>
  readonly used: (id: string, at: Timestamp) => Effect.Effect<void>
  /** Whether there was one to delete. */
  readonly remove: (id: string) => Effect.Effect<boolean>
}

const PasswordRow = Schema.Struct({ password: Schema.String })

export class SignInRepo extends Context.Service<SignInRepo, SignInRepoShape>()("huntaway-server/spaces/SignInRepo") {
  static readonly layer = Layer.effect(
    SignInRepo,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient

      const all = SqlSchema.findAll({
        Request: Schema.NullOr(Schema.String),
        Result: SignIn,
        execute: (profile) =>
          profile === null
            ? sql`SELECT id, profile_id, origin, username, label, created_at, updated_at, last_used_at FROM sign_ins ORDER BY origin, username`
            : sql`SELECT id, profile_id, origin, username, label, created_at, updated_at, last_used_at FROM sign_ins WHERE profile_id = ${profile} ORDER BY origin, username`,
      })
      const one = SqlSchema.findOneOption({
        Request: Schema.String,
        Result: SignIn,
        execute: (id) => sql`SELECT id, profile_id, origin, username, label, created_at, updated_at, last_used_at FROM sign_ins WHERE id = ${id}`,
      })
      const ofOrigin = SqlSchema.findAll({
        Request: Schema.Struct({ profile: Schema.String, origin: Schema.String }),
        Result: SignIn,
        execute: ({ profile, origin }) =>
          sql`SELECT id, profile_id, origin, username, label, created_at, updated_at, last_used_at FROM sign_ins WHERE profile_id = ${profile} AND origin = ${origin} ORDER BY username`,
      })
      const secret = SqlSchema.findOneOption({
        Request: Schema.String,
        Result: PasswordRow,
        execute: (id) => sql`SELECT password FROM sign_ins WHERE id = ${id}`,
      })

      const update = (id: string, set: SignInSet) =>
        sql<{ readonly id: string }>`UPDATE sign_ins SET
            username = COALESCE(${set.username ?? null}, username),
            password = COALESCE(${set.password === undefined ? null : Redacted.value(set.password)}, password),
            label = CASE WHEN ${set.label === undefined ? 0 : 1} = 1 THEN ${set.label ?? null} ELSE label END,
            updated_at = ${set.at}
          WHERE id = ${id} RETURNING id`.pipe(
          Effect.map((rows) => rows.length > 0),
          Effect.orDie,
        )

      return SignInRepo.of({
        list: (profile) => all(profile).pipe(Effect.orDie),
        get: (id) => one(id).pipe(Effect.orDie),
        forOrigin: (profile, origin) => ofOrigin({ profile, origin }).pipe(Effect.orDie),
        password: (id) => secret(id).pipe(Effect.map(Option.map((r) => Redacted.make(r.password, { label: "password" }))), Effect.orDie),
        insert: (r) =>
          sql`INSERT INTO sign_ins (id, profile_id, origin, username, password, label, created_at, updated_at)
              VALUES (${r.id}, ${r.profile_id}, ${r.origin}, ${r.username}, ${Redacted.value(r.password)}, ${r.label}, ${r.at}, ${r.at})`.pipe(
            Effect.asVoid,
            Effect.orDie,
          ),
        update,
        used: (id, at) => sql`UPDATE sign_ins SET last_used_at = ${at} WHERE id = ${id}`.pipe(Effect.asVoid, Effect.orDie),
        remove: (id) =>
          sql<{ readonly id: string }>`DELETE FROM sign_ins WHERE id = ${id} RETURNING id`.pipe(
            Effect.map((rows) => rows.length > 0),
            Effect.orDie,
          ),
      })
    }),
  )
}
