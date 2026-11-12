import { Context, Effect, Layer, Schema } from "effect"
import { SqlSchema } from "effect/sql"
import { ApprovalAction, ApprovalRule, ProfileId, RequestId } from "@huntaway/contracts"
import type { ActionOutcome, AnsweredBy, Timestamp } from "@huntaway/contracts"
import type { Rules } from "@huntaway/shared"
import { Db } from "../platform/Db.ts"
import { NullableJsonColumn, toJson } from "../platform/columns.ts"
import { DEFAULT_EXPIRY_MINUTES } from "./rules.ts"

// A profile's approval rules (`profiles.approval_rules`, JSON, null for the defaults) and its action log
// (`approval_log`; docs/plan/04-database.md). Single statements and small groups; `SqlError` and `SchemaError` are
// defects. Nothing here waits.

/** How many entries a profile's action log keeps: older ones go. */
export const KEEP = 5000

/** Rules as stored: an old board's may have no `expiry_minutes`, which is the default then. */
const StoredRules = Schema.Struct({ rules: Schema.Array(ApprovalRule), expiry_minutes: Schema.optional(Schema.Int) })

/** The rules column, read leniently: text that doesn't parse, or rules of the wrong shape, read as none (the defaults). */
const RulesRow = Schema.Struct({ approval_rules: NullableJsonColumn(StoredRules) })

/** An `approval_log` row as the wire's `ApprovalAction`, with its profile. */
export const ActionRow = Schema.Struct({ ...ApprovalAction.fields, profile_id: ProfileId })
export interface ActionRow extends Schema.Schema.Type<typeof ActionRow> {}

const ACTION_COLUMNS = Object.keys(ApprovalAction.fields).join(", ")

export interface ApprovalRulesRepoShape {
  /** The rules a profile saved, if it has (and they read): null for the defaults, or for a profile that isn't there. */
  readonly saved: (profile: ProfileId) => Effect.Effect<Rules | null>
  /** Saves a profile's rules; null goes back to the defaults. */
  readonly save: (profile: ProfileId, rules: Rules | null) => Effect.Effect<void>
  /** Adds an entry to the action log, and drops the profile's entries past the newest `KEEP`. */
  readonly insert: (profile: ProfileId, action: ApprovalAction) => Effect.Effect<void>
  /** Prompt `request` was answered: its pending entry, settled, if it had one. */
  readonly settle: (request: RequestId, outcome: ActionOutcome, by: AnsweredBy, at: Timestamp) => Effect.Effect<ActionRow | null>
  /** A profile's action log, newest first: `limit` entries. */
  readonly list: (profile: ProfileId, limit: number) => Effect.Effect<ReadonlyArray<ApprovalAction>>
}

/** The repository of approval rules and the action log. */
export class ApprovalRulesRepo extends Context.Service<ApprovalRulesRepo, ApprovalRulesRepoShape>()("huntaway-server/agents/ApprovalRulesRepo") {
  static readonly layer = Layer.effect(
    ApprovalRulesRepo,
    Effect.gen(function* () {
      const { sql } = yield* Db
      const findRules = SqlSchema.findOneOption({
        Request: ProfileId,
        Result: RulesRow,
        execute: (id) => sql`SELECT approval_rules FROM profiles WHERE id = ${id}`,
      })
      const findSettled = SqlSchema.findOneOption({
        Request: RequestId,
        Result: ActionRow,
        execute: (id) => sql.unsafe(`SELECT ${ACTION_COLUMNS}, profile_id FROM approval_log WHERE request_id = ?`, [id]),
      })
      const findAll = SqlSchema.findAll({
        Request: Schema.Struct({ profile: ProfileId, limit: Schema.Int }),
        Result: ApprovalAction,
        execute: ({ profile, limit }) =>
          sql.unsafe(`SELECT ${ACTION_COLUMNS} FROM approval_log WHERE profile_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`, [profile, limit]),
      })

      const saved = (profile: ProfileId) =>
        findRules(profile).pipe(
          Effect.map((found): Rules | null => {
            if (found._tag === "None") return null
            const stored = found.value.approval_rules
            if (stored === null) return null
            const expiry = stored.expiry_minutes ?? DEFAULT_EXPIRY_MINUTES
            return expiry < 0 ? null : { rules: stored.rules, expiry_minutes: expiry }
          }),
          Effect.orDie,
        )

      const save = (profile: ProfileId, rules: Rules | null) =>
        Effect.gen(function* () {
          const value = rules === null ? null : yield* toJson({ rules: rules.rules, expiry_minutes: rules.expiry_minutes })
          yield* sql`UPDATE profiles SET approval_rules = ${value} WHERE id = ${profile}`
        }).pipe(Effect.orDie)

      const insert = (profile: ProfileId, a: ApprovalAction) =>
        Effect.gen(function* () {
          yield* sql`INSERT INTO approval_log ${sql.insert({
            id: a.id,
            profile_id: profile,
            task_id: a.task_id,
            request_id: a.request_id,
            tool_name: a.tool_name,
            summary: a.summary,
            rule: a.rule,
            decision: a.decision,
            outcome: a.outcome,
            answered_by: a.answered_by,
            created_at: a.created_at,
            decided_at: a.decided_at,
          })}`
          yield* sql`DELETE FROM approval_log WHERE profile_id = ${profile} AND id NOT IN
            (SELECT id FROM approval_log WHERE profile_id = ${profile} ORDER BY created_at DESC, rowid DESC LIMIT ${KEEP})`
        }).pipe(Effect.orDie)

      const settle = (request: RequestId, outcome: ActionOutcome, by: AnsweredBy, at: Timestamp) =>
        Effect.gen(function* () {
          const changed = yield* sql<{ readonly id: string }>`UPDATE approval_log SET outcome = ${outcome}, answered_by = ${by}, decided_at = ${at}
            WHERE request_id = ${request} AND outcome = 'pending' RETURNING id`
          if (changed.length === 0) return null
          const row = yield* findSettled(request)
          return row._tag === "Some" ? row.value : null
        }).pipe(Effect.orDie)

      return ApprovalRulesRepo.of({
        saved,
        save,
        insert,
        settle,
        list: (profile, limit) => findAll({ profile, limit }).pipe(Effect.orDie),
      })
    }),
  )
}
