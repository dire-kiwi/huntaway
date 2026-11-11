import { Context, Effect, Layer, Option, Schema } from "effect"
import type { ProfileId } from "@huntaway/contracts"
import { RequestId, RunId, TaskId, Timestamp } from "@huntaway/contracts"
import { Db } from "../platform/Db.ts"
import { Bit } from "../platform/columns.ts"

// The `permission_requests` table (docs/plan/inventory/03-mcp.md 3): a prompt's durable record, and its one source of
// truth (docs/plan/07-agents.md, Threads: the thread's request is written from it). Statements only; `SqlError` and
// `SchemaError` are defects. Nothing here waits.

export const PromptStatus = Schema.Literals(["pending", "allowed", "denied", "expired"])
export type PromptStatus = typeof PromptStatus.Type

/** A prompt as stored. `input` is JSON text (or, for a row an old board wrote, text that isn't). */
export const PromptRow = Schema.Struct({
  id: RequestId,
  task_id: TaskId,
  write_no: Schema.Int,
  tool_name: Schema.String,
  input: Schema.String,
  status: PromptStatus,
  kind: Schema.String,
  call_id: Schema.NullOr(Schema.String),
  note: Schema.NullOr(Schema.String),
  expires_at: Schema.NullOr(Timestamp),
  rule: Schema.NullOr(Schema.String),
  created_at: Timestamp,
  run_id: Schema.NullOr(RunId),
  control_id: Schema.NullOr(Schema.String),
  answered: Bit,
})
export type PromptRow = typeof PromptRow.Type

const COLUMNS = Object.keys(PromptRow.fields).join(", ")
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(PromptRow))

/** A new prompt. */
export type NewPrompt = Omit<PromptRow, "status" | "note" | "answered">

/** Which pending prompts to expire (`Permissions.expireFor`). */
export type ExpireScope =
  /** A thread's: its run ended (and no later one started), or it is being deleted. */
  | { readonly _tag: "Task"; readonly task: TaskId }
  /** A run's (a later run's on its thread stay). */
  | { readonly _tag: "Run"; readonly run: RunId }
  /** The one call `call` raised, which its agent no longer wants answered. */
  | { readonly _tag: "Call"; readonly call: string }
  /** Approvals of changes to a project being deleted (and of deleting its tasks, and of its automations). */
  | { readonly _tag: "Project"; readonly project: string }
  /** Requests to delete a task that is being deleted anyway. */
  | { readonly _tag: "DeletionsOf"; readonly task: TaskId }
  /** Requests to change or delete an automation or workflow that has been deleted. */
  | { readonly _tag: "Automation"; readonly automation: string }
  | { readonly _tag: "Workflow"; readonly workflow: string }

export interface PermissionRepoShape {
  readonly get: (id: RequestId) => Effect.Effect<Option.Option<PromptRow>>
  /** The prompt call `call` raised for `tool` (one call can ask twice: a rule, then the tool itself). */
  readonly byCall: (call: string, tool: string) => Effect.Effect<Option.Option<PromptRow>>
  readonly insert: (prompt: NewPrompt) => Effect.Effect<void>
  /** Settles prompt `id` if it is still `from`: the one conditional update that makes the first answer win. */
  readonly settle: (
    id: RequestId,
    from: PromptStatus,
    to: { readonly status: PromptStatus; readonly note: string | null; readonly input: string },
  ) => Effect.Effect<boolean>
  /** Its answer is on the run's input. */
  readonly markAnswered: (id: RequestId) => Effect.Effect<void>
  /** Pending prompts, oldest first: all of them, a task's, or a profile's tasks'. */
  readonly pending: (filter: { readonly task?: TaskId | undefined; readonly profile?: ProfileId | undefined }) => Effect.Effect<ReadonlyArray<PromptRow>>
  /** Whether the task has a prompt pending. */
  readonly anyPending: (task: TaskId) => Effect.Effect<boolean>
  /** The pending prompts `scope` covers. */
  readonly pendingIn: (scope: ExpireScope) => Effect.Effect<ReadonlyArray<PromptRow>>
  /** Pending prompts whose expiry is at or before `at`. */
  readonly due: (at: Timestamp) => Effect.Effect<ReadonlyArray<PromptRow>>
  /** Pending prompts whose run has exited or is gone (or that have none): Recovery expires them. */
  readonly orphans: Effect.Effect<ReadonlyArray<PromptRow>>
  /** `can_use_tool` prompts of runs that have not exited whose answer is not on the input yet: Recovery takes them up. */
  readonly unanswered: Effect.Effect<ReadonlyArray<PromptRow>>
  /** The board's own approvals (not tool prompts) still pending, oldest first. */
  readonly approvals: Effect.Effect<ReadonlyArray<PromptRow>>
  /** What a board approval call `call` asked the user, if it asked (its input as saved). */
  readonly asked: (call: string) => Effect.Effect<Option.Option<PromptRow>>
}

/** The condition (with its one parameter) that picks the prompts of `scope`. */
const scopeWhere = (scope: ExpireScope): readonly [string, string] => {
  const where: { readonly [K in ExpireScope["_tag"]]: string } = {
    Task: "task_id = ?",
    Run: "run_id = ?",
    Call: "call_id = ?",
    Project: "kind IN ('project','delete_task','automation') AND json_extract(input, '$.project.id') = ?",
    DeletionsOf: "kind = 'delete_task' AND json_extract(input, '$.delete.id') = ?",
    Automation: "kind = 'automation' AND json_extract(input, '$.automation.id') = ?",
    Workflow: "kind = 'automation' AND json_extract(input, '$.workflow.id') = ?",
  }
  const value =
    scope._tag === "Task" || scope._tag === "DeletionsOf"
      ? scope.task
      : scope._tag === "Run"
        ? scope.run
        : scope._tag === "Call"
          ? scope.call
          : scope._tag === "Project"
            ? scope.project
            : scope._tag === "Automation"
              ? scope.automation
              : scope.workflow
  return [where[scope._tag], value]
}

export class PermissionRepo extends Context.Service<PermissionRepo, PermissionRepoShape>()("huntaway-server/permissions/PermissionRepo") {
  static readonly layer = Layer.effect(
    PermissionRepo,
    Effect.gen(function* () {
      const { sql } = yield* Db
      const select = (where: string, params: ReadonlyArray<unknown>, order = "") =>
        sql.unsafe(`SELECT ${COLUMNS} FROM permission_requests WHERE ${where}${order}`, params).pipe(Effect.flatMap(decodeRows), Effect.orDie)
      const one = (where: string, params: ReadonlyArray<unknown>) => Effect.map(select(where, params), (found) => Option.fromNullishOr(found[0]))
      const BY_AGE = " ORDER BY created_at, rowid"
      const PENDING = "status = 'pending'"

      const pendingIn = (scope: ExpireScope) => {
        const [where, value] = scopeWhere(scope)
        return select(`${PENDING} AND ${where}`, [value], BY_AGE)
      }

      return PermissionRepo.of({
        get: (id) => one("id = ?", [id]),
        byCall: (call, tool) => one("call_id = ? AND tool_name = ?", [call, tool]),
        insert: (p) =>
          sql`INSERT INTO permission_requests ${sql.insert({
            id: p.id,
            task_id: p.task_id,
            write_no: p.write_no,
            tool_name: p.tool_name,
            input: p.input,
            status: "pending",
            kind: p.kind,
            call_id: p.call_id,
            expires_at: p.expires_at,
            rule: p.rule,
            created_at: p.created_at,
            run_id: p.run_id,
            control_id: p.control_id,
          })}`.pipe(Effect.asVoid, Effect.orDie),
        settle: (id, from, to) =>
          sql<{ readonly id: string }>`UPDATE permission_requests SET status = ${to.status}, note = ${to.note}, input = ${to.input}
            WHERE id = ${id} AND status = ${from} RETURNING id`.pipe(
            Effect.map((changed) => changed.length > 0),
            Effect.orDie,
          ),
        markAnswered: (id) => sql`UPDATE permission_requests SET answered = 1 WHERE id = ${id}`.pipe(Effect.asVoid, Effect.orDie),
        pending: (filter) =>
          select(
            `${PENDING} AND (? IS NULL OR task_id = ?) AND (? IS NULL OR task_id IN (SELECT id FROM tasks WHERE profile_id = ?))`,
            [filter.task ?? null, filter.task ?? null, filter.profile ?? null, filter.profile ?? null],
            BY_AGE,
          ),
        anyPending: (task) =>
          sql<{ readonly found: number }>`SELECT EXISTS(SELECT 1 FROM permission_requests WHERE task_id = ${task} AND status = 'pending') AS found`.pipe(
            Effect.map((found) => (found[0]?.found ?? 0) !== 0),
            Effect.orDie,
          ),
        pendingIn,
        due: (at) => select(`${PENDING} AND expires_at IS NOT NULL AND expires_at <= ?`, [at], BY_AGE),
        orphans: select(`${PENDING} AND (run_id IS NULL OR NOT EXISTS (SELECT 1 FROM runs r WHERE r.id = run_id AND r.status != 'exited'))`, [], BY_AGE),
        unanswered: select(
          `control_id IS NOT NULL AND answered = 0 AND EXISTS (SELECT 1 FROM runs r WHERE r.id = run_id AND r.status != 'exited')`,
          [],
          BY_AGE,
        ),
        approvals: select(`kind != 'tool' AND ${PENDING}`, [], BY_AGE),
        asked: (call) => one("call_id = ? AND kind IN ('project','delete_task','automation')", [call]),
      })
    }),
  )
}
