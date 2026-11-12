import { Effect, Schema } from "effect"
import { ActionRow } from "../../../agents/ApprovalRulesRepo.ts"
import { OpRow } from "../../../desktop/DesktopOpRepo.ts"
import { PromptRow } from "../../../permissions/PermissionRepo.ts"
import { EXPIRED } from "../../../permissions/prompts.ts"
import { Run, RunPhase } from "../../../runs/Run.ts"
import type { StopState } from "../../../runs/Run.ts"
import { keyOf } from "../family.ts"
import type { Family, FamilyIo } from "../family.ts"
import {
  callUsageCopy,
  checkpointsCopy,
  contextStatsCopy,
  copyTable,
  documentsCopy,
  prStatesCopy,
  prWatchesCopy,
  reviewStatsCopy,
  tokenUsageCopy,
} from "./runRecords.ts"
import type { TableCopy } from "./runRecords.ts"

// The runs family (docs/plan/11-migration.md, Table by table; docs/plan/07-agents.md, The run): `runs` in the old
// `rowid` order, so `seq` keeps the order runs started in (inventory 09, section 9: run order is by rowid, not time),
// and every run exited; what hangs off runs and their turns (`runRecords.ts`); prompts, none left pending; the action
// log, none left pending; the desktop's journal, none left running. Then each task's cost against its runs'.

const Str = Schema.String
const NullStr = Schema.NullOr(Schema.String)
const Int = Schema.Int
const NullInt = Schema.NullOr(Schema.Int)
const NullNum = Schema.NullOr(Schema.Finite)

// ---- runs ----------------------------------------------------------------------------------------------------

/** An old `runs` row at version 130, with its `rowid`. The "unknown" markers (nulls of inventory 09, 9.10) are kept. */
export const OldRun = Schema.Struct({
  old_rowid: Int,
  id: Str,
  task_id: Str,
  status: Schema.Literals(["preparing", "running", "exited"]),
  out_offset: Int,
  /** 0 none, 1 a stop was asked, 2 the interrupted turn ended. */
  stop_requested: Schema.Literals([0, 1, 2]),
  attention: NullStr,
  result_error: NullStr,
  saw_result: Int,
  created_at: Str,
  ended_at: NullStr,
  kind: Str,
  cost_usd: Schema.Finite,
  stop_id: NullStr,
  between_turns: Int,
  turn_message_id: NullInt,
  agent_at: NullStr,
  turn_start_tokens: NullInt,
  turn_tokens: NullInt,
  session_id: NullStr,
  session_cost: NullNum,
  usage_at: NullStr,
  usage_session: NullStr,
  usage_snapshot: NullStr,
  usage_tail: NullStr,
  effort: NullStr,
  config_dir: NullStr,
  board_tools: Int,
  finished: Int,
})
export type OldRun = typeof OldRun.Type

const { phase: _phase, ...runFields } = Run.fields

/** A `runs` row as written: what `Run` reads (`status` its `phase`), and the token counting's `usage_*` columns. */
export const RunRow = Schema.Struct({
  ...runFields,
  status: RunPhase,
  usage_at: NullStr,
  usage_session: NullStr,
  usage_snapshot: NullStr,
  usage_tail: NullStr,
})

/** A saved snapshot or tail: an object of per-model (or, for Codex, per-thread) counts, which the counting reads leniently. */
const UsageJson = Schema.Record(Str, Schema.Unknown)

export const STOP_STATES: Readonly<Record<0 | 1 | 2, StopState>> = { 0: "none", 1: "requested", 2: "interrupted" }

/**
 * A run as the new board has it. A run the old database has not exited (imported with `--force` or `--rehearsal`) is
 * recorded as interrupted: exited at `now`, its stop `interrupted`.
 */
export const convertRun = (old: OldRun, now: string): Readonly<Record<string, unknown>> => {
  const { old_rowid, stop_requested, turn_message_id, status, ended_at, ...rest } = old
  const live = status !== "exited"
  return {
    ...rest,
    seq: old_rowid,
    status: "exited",
    stop: live ? "interrupted" : STOP_STATES[stop_requested],
    write_no: turn_message_id,
    ended_at: live ? (ended_at ?? now) : ended_at,
  }
}

const runsCopy = (io: FamilyIo): TableCopy<typeof OldRun> => ({
  old: "runs",
  table: "runs",
  schema: OldRun,
  key: keyOf("id"),
  check: { row: RunRow, json: { usage_snapshot: UsageJson, usage_tail: UsageJson }, key: keyOf("id") },
  convert: (old) => convertRun(old, io.ctx.now),
  note: (old) => (old.status === "exited" ? null : `was ${old.status} in the old database: recorded as interrupted`),
  rows: io.old.query(`SELECT rowid AS old_rowid, * FROM runs ORDER BY rowid`),
})

// ---- permission_requests ------------------------------------------------------------------------------------

export const OldPrompt = Schema.Struct({
  id: Str,
  task_id: Str,
  message_id: Int,
  tool_name: Str,
  input: Str,
  status: Str,
  created_at: Str,
  call_id: NullStr,
  note: NullStr,
  kind: Str,
  expires_at: NullStr,
  rule: NullStr,
})
export type OldPrompt = typeof OldPrompt.Type

/**
 * A prompt as the new board has it: one still pending is expired as the old server expired one whose run went away
 * (`Request expired`), since no run is live to answer it. Which run asked, its control request and whether its answer
 * was sent are not in the old row: null, null and no.
 */
export const convertPrompt = (old: OldPrompt): Readonly<Record<string, unknown>> => {
  const { message_id, ...rest } = old
  const pending = old.status === "pending"
  return {
    ...rest,
    write_no: message_id,
    status: pending ? "expired" : old.status,
    note: pending ? EXPIRED : old.note,
    run_id: null,
    control_id: null,
    answered: 0,
  }
}

const promptsCopy: TableCopy<typeof OldPrompt> = {
  old: "permission_requests",
  table: "permission_requests",
  schema: OldPrompt,
  key: keyOf("id"),
  check: { row: PromptRow, key: keyOf("id") },
  convert: convertPrompt,
  note: (old) => (old.status === "pending" ? "was pending: expired (no run is live to answer it)" : null),
}

// ---- approval_log ------------------------------------------------------------------------------------------

export const OldAction = Schema.Struct({
  id: Str,
  profile_id: Str,
  task_id: Str,
  request_id: NullStr,
  tool_name: Str,
  summary: Str,
  rule: Str,
  decision: Str,
  outcome: Str,
  answered_by: NullStr,
  created_at: Str,
  decided_at: NullStr,
})
export type OldAction = typeof OldAction.Type

/**
 * An action log entry as the new board has it: one still pending is settled as the old server settled one whose
 * prompt expired with its run (`expired`, by `ended`, at `now`), since its prompt is expired by the import.
 */
export const convertAction = (old: OldAction, now: string): Readonly<Record<string, unknown>> =>
  old.outcome === "pending" ? { ...old, outcome: "expired", answered_by: "ended", decided_at: now } : old

const actionsCopy = (io: FamilyIo): TableCopy<typeof OldAction> => ({
  old: "approval_log",
  table: "approval_log",
  schema: OldAction,
  key: keyOf("id"),
  check: { row: ActionRow, key: keyOf("id") },
  convert: (old) => convertAction(old, io.ctx.now),
})

// ---- desktop_ops -------------------------------------------------------------------------------------------

export const OldDesktopOp = Schema.Struct({
  id: Str,
  task_id: Str,
  run_id: NullStr,
  op_id: NullStr,
  tool: Str,
  summary: Str,
  args: Str,
  status: Str,
  result: NullStr,
  boot: Str,
  created_at: Str,
  finished_at: NullStr,
})
export type OldDesktopOp = typeof OldDesktopOp.Type

/** A `desktop_ops` row as written: what the journal reads, and the agent's arguments as JSON. */
export const DesktopOpRow = Schema.Struct({ ...OpRow.fields, args: Str })

/** An op as the new board has it: one still running was cut short by the old server's end, so it is `interrupted`. */
export const convertDesktopOp = (old: OldDesktopOp): Readonly<Record<string, unknown>> => (old.status === "running" ? { ...old, status: "interrupted" } : old)

const desktopCopy: TableCopy<typeof OldDesktopOp> = {
  old: "desktop_ops",
  table: "desktop_ops",
  schema: OldDesktopOp,
  key: keyOf("id"),
  check: { row: DesktopOpRow, json: { args: Schema.Unknown }, key: keyOf("id") },
  convert: convertDesktopOp,
}

// ---- each task's cost --------------------------------------------------------------------------------------

/** A task's cost on the new board, and its runs' costs summed on the old one. */
export interface TaskCost {
  readonly key: string
  readonly task: number
  readonly runs: number
}

/** Dollars two sums of the same costs may differ by in floating point. */
const CENT_FRACTION = 1e-6

/** The tasks whose cost is not the sum of their runs' costs, with what each says (a note: costs are not changed). */
export const costDifferences = (costs: ReadonlyArray<TaskCost>): ReadonlyArray<readonly [string, string]> =>
  costs
    .filter((c) => Math.abs(c.task - c.runs) > CENT_FRACTION)
    .map((c) => [c.key, `its cost is $${c.task.toFixed(6)} and its runs' on the old board sum to $${c.runs.toFixed(6)} (left as it was)`] as const)

const OldRunCost = Schema.Struct({ id: Str, key: Str, runs: Schema.Finite })
const NewTaskCost = Schema.Struct({ id: Str, cost_usd: Schema.Finite })
const decodeOldCosts = Schema.decodeUnknownEffect(Schema.Array(OldRunCost))
const decodeNewCosts = Schema.decodeUnknownEffect(Schema.Array(NewTaskCost))

/** Each imported task's cost against the sum of its runs' costs as the old board had them: a note for each that differs. */
const checkCosts = (io: FamilyIo) =>
  Effect.gen(function* () {
    const old = yield* decodeOldCosts(
      yield* io.old.query(`SELECT t.id AS id, CASE WHEN p.key IS NOT NULL THEN p.key || '-' || t.number ELSE t.id END AS key,
          COALESCE((SELECT SUM(r.cost_usd) FROM runs r WHERE r.task_id = t.id), 0) AS runs
        FROM tasks t LEFT JOIN projects p ON p.id = t.project_id ORDER BY t.created_at, t.rowid`),
    ).pipe(Effect.orDie)
    const imported = new Map((yield* decodeNewCosts(yield* io.exec(`SELECT id, cost_usd FROM tasks`)).pipe(Effect.orDie)).map((t) => [t.id, t.cost_usd]))
    const costs: Array<TaskCost> = []
    for (const t of old) {
      const task = imported.get(t.id)
      if (task !== undefined) costs.push({ key: t.key, task, runs: t.runs })
    }
    for (const [key, text] of costDifferences(costs)) yield* io.report.note("tasks", key, text)
  })

// ---- the family --------------------------------------------------------------------------------------------

export const runsFamily: Family = {
  name: "runs",
  reads: [
    "runs",
    "token_usage",
    "context_stats",
    "review_stats",
    "checkpoints",
    "permission_requests",
    "approval_log",
    "desktop_ops",
    "documents",
    "pr_watches",
    "pr_states",
    "call_usage",
  ],
  writes: [
    "runs",
    "token_usage",
    "context_stats",
    "review_stats",
    "checkpoints",
    "permission_requests",
    "approval_log",
    "desktop_ops",
    "documents",
    "pr_watches",
    "pr_states",
    "call_usage",
  ],
  run: (io) =>
    Effect.gen(function* () {
      yield* copyTable(io, runsCopy(io))
      yield* copyTable(io, tokenUsageCopy)
      yield* copyTable(io, contextStatsCopy)
      yield* copyTable(io, reviewStatsCopy)
      yield* copyTable(io, checkpointsCopy)
      yield* copyTable(io, promptsCopy)
      yield* copyTable(io, actionsCopy(io))
      yield* copyTable(io, desktopCopy)
      yield* copyTable(io, documentsCopy)
      yield* copyTable(io, prWatchesCopy)
      yield* copyTable(io, prStatesCopy)
      yield* copyTable(io, callUsageCopy)
      yield* checkCosts(io)
    }),
}
