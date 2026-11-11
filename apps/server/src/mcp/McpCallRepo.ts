import { Context, Effect, Layer, Option, Schema } from "effect"
import { SqlSchema } from "effect/sql"
import type { SqlError } from "effect/sql"
import { CallId, RunId } from "@huntaway/contracts"
import type { Timestamp } from "@huntaway/contracts"
import { Db } from "../platform/Db.ts"

// The `mcp_calls` table (docs/plan/inventory/03-mcp.md 3): every board call, recorded `executing` before it runs and
// `done` with its result after, so a call runs at most once per call id (`ToolCalls`). Statements only.
//
// `find` and `begin` keep their `SqlError`: a call the board cannot record is not run, and the agent is told so (the
// old "couldn't record this call"). The rest treat it as a defect, as the other repositories do.

/** A call as recorded. `args` and `result` are JSON text. */
export const CallRow = Schema.Struct({
  run_id: Schema.String,
  task_id: Schema.String,
  tool: Schema.String,
  args: Schema.String,
  status: Schema.String,
  result: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
})
export type CallRow = typeof CallRow.Type

/** An executing call that came on a run's output, to be taken up again after a restart. */
export const OpenCall = Schema.Struct({ id: CallId, run_id: RunId, tool: Schema.String, args: Schema.String })
export type OpenCall = typeof OpenCall.Type

/** What a new call is recorded with. */
export interface NewCall {
  readonly id: CallId
  readonly run_id: string
  readonly task_id: string
  readonly tool: string
  /** JSON text. */
  readonly args: string
  readonly created_at: Timestamp
}

/** The id prefix of calls that came on a run's own output (Claude's `mcp_message`; Codex's dynamic tools, M5). */
export const CONTROL_PREFIX = "stdio:"

export interface McpCallRepoShape {
  readonly find: (id: CallId) => Effect.Effect<Option.Option<CallRow>, SqlError.SqlError>
  /** Records the call `executing` (a new row, or one found executing again). */
  readonly begin: (call: NewCall) => Effect.Effect<void, SqlError.SqlError>
  /** Records the call `done` with its result (JSON text) or its error. */
  readonly finish: (call: NewCall, outcome: { readonly result: string | null; readonly error: string | null }) => Effect.Effect<void, SqlError.SqlError>
  /** Calls that came on the output of a run that has not exited and are recorded `executing`, of one run or of all. */
  readonly openOnOutput: (run?: RunId) => Effect.Effect<ReadonlyArray<OpenCall>>
  /** The status of the prompt an approval rule raised for the call (`permission_requests`, kind `tool` with a rule), if any. */
  readonly ruledPrompt: (id: CallId) => Effect.Effect<Option.Option<string>>
  /** The status of the approval of `kind` the call asked for, if any. */
  readonly approval: (id: CallId, kind: string) => Effect.Effect<Option.Option<string>>
  /** Deletes up to `batch` calls made before `before` whose run is gone or exited before then; returns how many. */
  readonly prune: (before: Timestamp, batch: number) => Effect.Effect<number>
}

const Status = Schema.Struct({ status: Schema.String })

/** The `status` of a query's first row, if it has one. */
const statusOf = (query: Effect.Effect<ReadonlyArray<unknown>, SqlError.SqlError>) =>
  query.pipe(
    Effect.flatMap((rows) => Effect.map(Schema.decodeUnknownEffect(Schema.Array(Status))(rows), (found) => Option.fromNullishOr(found[0]?.status))),
    Effect.orDie,
  )

export class McpCallRepo extends Context.Service<McpCallRepo, McpCallRepoShape>()("huntaway-server/mcp/McpCallRepo") {
  static readonly layer = Layer.effect(
    McpCallRepo,
    Effect.gen(function* () {
      const { sql } = yield* Db
      const findRow = SqlSchema.findOneOption({
        Request: CallId,
        Result: CallRow,
        execute: (id) => sql`SELECT run_id, task_id, tool, args, status, result, error FROM mcp_calls WHERE id = ${id}`,
      })
      const open = SqlSchema.findAll({
        Request: Schema.NullOr(RunId),
        Result: OpenCall,
        execute: (run) => sql`
          SELECT m.id, m.run_id, m.tool, m.args FROM mcp_calls m JOIN runs r ON r.id = m.run_id
          WHERE m.status = 'executing' AND substr(m.id, 1, ${CONTROL_PREFIX.length}) = ${CONTROL_PREFIX} AND r.status != 'exited'
            AND (${run} IS NULL OR m.run_id = ${run})
          ORDER BY m.created_at, m.id`,
      })
      const write = (call: NewCall, status: "executing" | "done", result: string | null, error: string | null) =>
        sql`INSERT INTO mcp_calls (id, run_id, task_id, tool, args, status, result, error, created_at)
          VALUES (${call.id}, ${call.run_id}, ${call.task_id}, ${call.tool}, ${call.args}, ${status}, ${result}, ${error}, ${call.created_at})
          ON CONFLICT(id) DO UPDATE SET status = excluded.status, result = excluded.result, error = excluded.error`.pipe(Effect.asVoid)

      return McpCallRepo.of({
        find: (id) => findRow(id).pipe(Effect.catchTag("SchemaError", (e) => Effect.die(e))),
        begin: (call) => write(call, "executing", null, null),
        finish: (call, outcome) => write(call, "done", outcome.result, outcome.error),
        openOnOutput: (run) => open(run ?? null).pipe(Effect.orDie),
        ruledPrompt: (id) => statusOf(sql`SELECT status FROM permission_requests WHERE call_id = ${id} AND kind = 'tool' AND rule IS NOT NULL LIMIT 1`),
        approval: (id, kind) => statusOf(sql`SELECT status FROM permission_requests WHERE call_id = ${id} AND kind = ${kind} LIMIT 1`),
        prune: (before, batch) =>
          sql<{ readonly id: string }>`
            DELETE FROM mcp_calls WHERE rowid IN (
              SELECT m.rowid FROM mcp_calls m LEFT JOIN runs r ON r.id = m.run_id
              WHERE m.created_at < ${before} AND (r.id IS NULL OR (r.status = 'exited' AND COALESCE(r.ended_at, r.created_at) < ${before}))
              LIMIT ${batch})
            RETURNING id`.pipe(
            Effect.map((rows) => rows.length),
            Effect.orDie,
          ),
      })
    }),
  )
}
