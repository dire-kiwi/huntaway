import { Context, Effect, Layer, Schema, SchemaTransformation } from "effect"
import { SqlSchema } from "effect/sql"
import type { SqlError } from "effect/sql"
import { PenColor, PenId, ProfileId, TaskId, Timestamp } from "@huntaway/contracts"
import type { Pen } from "@huntaway/contracts"
import { Db } from "../platform/Db.ts"
import { Bit } from "../platform/columns.ts"
import { penColorOf } from "./penChecks.ts"

// The `pens` table (docs/plan/04-database.md), and `tasks.pen_id`. Single statements and small groups; `SqlError` and
// `SchemaError` are defects. Nothing here waits: no process, network, file system or sleep.

/** A colour column read leniently: one that isn't a colour (a pen from before colours) reads as the first. */
const ColorColumn = Schema.String.pipe(Schema.decodeTo(PenColor, SchemaTransformation.transform<PenColor, string>({ decode: penColorOf, encode: (c) => c })))

/** A `pens` row as the wire's `Pen`, with how many tasks (not review threads) are in it. */
export const PenRow = Schema.Struct({
  id: PenId,
  profile_id: ProfileId,
  name: Schema.String,
  position: Schema.Finite,
  active: Bit,
  thread_id: Schema.NullOr(TaskId),
  color: ColorColumn,
  created_at: Timestamp,
  updated_at: Timestamp,
  task_count: Schema.Int,
})

const SELECT = `SELECT p.id, p.profile_id, p.name, p.position, p.active, p.thread_id, p.color, p.created_at, p.updated_at,
  (SELECT COUNT(*) FROM tasks t WHERE t.pen_id = p.id AND t.kind = 'task') AS task_count
FROM pens p`

/** The pens a statement returns. */
const penRows = <Req extends Schema.Constraint>(Request: Req, execute: (r: Req["Encoded"]) => Effect.Effect<ReadonlyArray<unknown>, SqlError.SqlError>) => {
  const find = SqlSchema.findAll({ Request, Result: PenRow, execute })
  return (r: Req["Type"]): Effect.Effect<ReadonlyArray<Pen>, never, Req["EncodingServices"]> => find(r).pipe(Effect.orDie)
}
const first = <A>(found: Effect.Effect<ReadonlyArray<A>>) => Effect.map(found, (list) => list[0] ?? null)

/** What a change to a pen writes; what is left out stays. */
export interface PenColumns {
  readonly name?: string | undefined
  readonly active?: boolean | undefined
  readonly color?: PenColor | undefined
}

export interface PenRepoShape {
  /** Every profile's pens, each profile's in their tabs' order. */
  readonly all: Effect.Effect<ReadonlyArray<Pen>>
  /** A profile's pens, in their tabs' order. */
  readonly list: (profile: ProfileId) => Effect.Effect<ReadonlyArray<Pen>>
  readonly get: (id: string) => Effect.Effect<Pen | null>
  /** A profile's pen by its name, in any case. */
  readonly byName: (profile: ProfileId, name: string) => Effect.Effect<Pen | null>
  /** Adds a pen at the end of the profile's tabs. */
  readonly insert: (pen: {
    readonly id: PenId
    readonly profile_id: ProfileId
    readonly name: string
    readonly active: boolean
    readonly color: PenColor
    readonly now: Timestamp
  }) => Effect.Effect<void>
  /** Writes `columns`, and `updated_at`. */
  readonly update: (id: PenId, columns: PenColumns, now: Timestamp) => Effect.Effect<void>
  /** Puts the pens in this order: positions 1 to n. */
  readonly order: (ids: ReadonlyArray<PenId>) => Effect.Effect<void>
  /** Deletes a pen; its tasks are in no pen after. The ids of those tasks. */
  readonly delete: (id: PenId) => Effect.Effect<ReadonlyArray<TaskId>>
}

/** The repository of pens. */
export class PenRepo extends Context.Service<PenRepo, PenRepoShape>()("huntaway-server/tasks/PenRepo") {
  static readonly layer = Layer.effect(
    PenRepo,
    Effect.gen(function* () {
      const { sql } = yield* Db
      const select = sql.literal(SELECT)
      const all = penRows(Schema.Void, () => sql`${select} ORDER BY p.profile_id, p.position, p.created_at`)
      const ofProfile = penRows(Schema.String, (profile) => sql`${select} WHERE p.profile_id = ${profile} ORDER BY p.position, p.created_at`)
      const byId = penRows(Schema.String, (id) => sql`${select} WHERE p.id = ${id}`)
      const named = penRows(
        Schema.Struct({ profile: Schema.String, name: Schema.String }),
        ({ profile, name }) => sql`${select} WHERE p.profile_id = ${profile} AND p.name = ${name.trim()} COLLATE NOCASE`,
      )

      const insert: PenRepoShape["insert"] = (pen) =>
        sql`INSERT INTO pens (id, profile_id, name, position, active, color, created_at, updated_at)
          VALUES (${pen.id}, ${pen.profile_id}, ${pen.name}, (SELECT COALESCE(MAX(position), 0) + 1 FROM pens WHERE profile_id = ${pen.profile_id}),
                  ${pen.active ? 1 : 0}, ${pen.color}, ${pen.now}, ${pen.now})`.pipe(Effect.asVoid, Effect.orDie)

      const update: PenRepoShape["update"] = (id, columns, now) => {
        const values: Record<string, string | number> = { updated_at: now }
        if (columns.name !== undefined) values.name = columns.name
        if (columns.active !== undefined) values.active = columns.active ? 1 : 0
        if (columns.color !== undefined) values.color = columns.color
        return sql`UPDATE pens SET ${sql.update(values)} WHERE id = ${id}`.pipe(Effect.asVoid, Effect.orDie)
      }

      const order: PenRepoShape["order"] = (ids) =>
        Effect.forEach(ids, (id, i) => sql`UPDATE pens SET position = ${i + 1} WHERE id = ${id}`, { concurrency: 1, discard: true }).pipe(Effect.orDie)

      const remove: PenRepoShape["delete"] = (id) =>
        Effect.gen(function* () {
          const left = yield* sql<{ readonly id: TaskId }>`UPDATE tasks SET pen_id = NULL WHERE pen_id = ${id} RETURNING id`
          yield* sql`DELETE FROM pens WHERE id = ${id}`
          return left.map((r) => r.id)
        }).pipe(Effect.orDie)

      return PenRepo.of({
        all: all(undefined),
        list: ofProfile,
        get: (id) => first(byId(id)),
        byName: (profile, name) => first(named({ profile, name })),
        insert,
        update,
        order,
        delete: remove,
      })
    }),
  )
}
