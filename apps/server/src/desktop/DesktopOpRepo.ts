import { Context, Effect, Layer, Schema } from "effect"
import { DesktopOpStatus, RunId, TaskId, Timestamp } from "@huntaway/contracts"
import type { DesktopOp } from "@huntaway/contracts"
import { rowsOf, toJson } from "../platform/columns.ts"
import { Db } from "../platform/Db.ts"
import { Events } from "../platform/Events.ts"

// The desktop's journal (huntaway's db/desktop.ts; docs/plan/inventory/05-hosts-update.md 3.1): what each task's agent
// did on the host's desktop through the `desktop` server: its actions, launches and clipboard use, not its reads. An
// action the agent named (`op_id`) runs at most once: a retry after a lost answer gets the recorded one. Each row records
// the process that started it (`boot`, `Events.boot`): one still `running` with another's was cut short by a restart,
// and reads as `interrupted`. Statements only.

/** A `desktop_ops` row as the journal reads it (all but `args`). */
export const OpRow = Schema.Struct({
  id: Schema.String,
  task_id: TaskId,
  run_id: Schema.NullOr(RunId),
  op_id: Schema.NullOr(Schema.String),
  tool: Schema.Literals(["act", "launch", "clipboard"]),
  summary: Schema.String,
  status: DesktopOpStatus,
  result: Schema.NullOr(Schema.String),
  boot: Schema.String,
  created_at: Timestamp,
  finished_at: Schema.NullOr(Timestamp),
})
const readOps = rowsOf(OpRow)

/** An op as it starts. */
export interface NewOp {
  readonly id: string
  readonly task_id: TaskId
  readonly run_id: RunId | null
  readonly op_id: string | null
  readonly tool: DesktopOp["tool"]
  readonly summary: string
  /** The agent's arguments, as given. */
  readonly args: unknown
  readonly now: Timestamp
}

export interface DesktopOpRepoShape {
  /**
   * Record an op as it starts: `started` true and the op, or, for an `op_id` the task already has (one that ran, or that
   * another call is running now), `started` false and that op. In one transaction, so two calls with one `op_id` can't
   * both start it.
   */
  readonly start: (op: NewOp) => Effect.Effect<{ readonly started: boolean; readonly op: DesktopOp }>
  readonly finish: (id: string, status: "ok" | "failed", result: string, now: Timestamp) => Effect.Effect<void>
  /** Task `task`'s op that the agent named `opId`. */
  readonly find: (task: TaskId, opId: string) => Effect.Effect<DesktopOp | null>
  /** A task's latest ops, newest first. */
  readonly ofTask: (task: TaskId, limit?: number) => Effect.Effect<ReadonlyArray<DesktopOp>>
}

export class DesktopOpRepo extends Context.Service<DesktopOpRepo, DesktopOpRepoShape>()("huntaway-server/desktop/DesktopOpRepo") {
  static readonly layer = Layer.effect(
    DesktopOpRepo,
    Effect.gen(function* () {
      const { sql, tx } = yield* Db
      const { boot } = yield* Events

      /** One left running by an earlier process was cut short: whether it took effect isn't known. */
      const fromRow = ({ boot: stamp, ...row }: typeof OpRow.Type): DesktopOp =>
        row.status === "running" && stamp !== boot ? Object.assign({}, row, { status: "interrupted" as const }) : row

      const one = <E>(statement: Effect.Effect<ReadonlyArray<unknown>, E>) =>
        Effect.map(readOps(statement), (rows) => (rows[0] === undefined ? null : fromRow(rows[0])))
      const byOpId = (task: TaskId, opId: string) => one(sql`SELECT * FROM desktop_ops WHERE task_id = ${task} AND op_id = ${opId}`)

      return DesktopOpRepo.of({
        start: (op) =>
          tx(
            Effect.gen(function* () {
              if (op.op_id !== null) {
                const there = yield* byOpId(op.task_id, op.op_id)
                if (there !== null) return { started: false, op: there }
              }
              const args = yield* toJson(op.args ?? null)
              yield* sql`INSERT INTO desktop_ops (id, task_id, run_id, op_id, tool, summary, args, status, boot, created_at)
                VALUES (${op.id}, ${op.task_id}, ${op.run_id}, ${op.op_id}, ${op.tool}, ${op.summary}, ${args}, 'running', ${boot}, ${op.now})`.pipe(
                Effect.orDie,
              )
              const made = yield* one(sql`SELECT * FROM desktop_ops WHERE id = ${op.id}`)
              return made === null ? yield* Effect.die(new Error("the op just recorded isn't there")) : { started: true, op: made }
            }),
          ),
        finish: (id, status, result, now) =>
          sql`UPDATE desktop_ops SET status = ${status}, result = ${result}, finished_at = ${now} WHERE id = ${id}`.pipe(Effect.asVoid, Effect.orDie),
        find: byOpId,
        ofTask: (task, limit = 50) =>
          Effect.map(readOps(sql`SELECT * FROM desktop_ops WHERE task_id = ${task} ORDER BY created_at DESC, rowid DESC LIMIT ${limit}`), (rows) =>
            rows.map(fromRow),
          ),
      })
    }),
  )
}
