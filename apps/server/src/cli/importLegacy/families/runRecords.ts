import { Effect, Schema } from "effect"
import { ContextStat, TaskId, Timestamp, TurnStats } from "@huntaway/contracts"
import { CallUsageRow, ReviewStatRow, RunUsageRow } from "../../../analytics/AnalyticsRepo.ts"
import { Checkpoint } from "../../../git/checkpoints/model.ts"
import { PrSummary } from "../../../github/prWatch/pr.ts"
import type { Seen } from "../../../github/prWatch/pr.ts"
import { WatchRow } from "../../../github/prWatch/seen.ts"
import { encodeColumns } from "../../../platform/columns.ts"
import { decodeOld, keyOf } from "../family.ts"
import type { FamilyIo, NewRow, TableCheck } from "../family.ts"

// The tables of the runs family that are copied as they are (docs/plan/11-migration.md, Table by table): token and
// context counts, review submissions, model calls that are not runs, task documents, pull request states, and the two
// with values in older forms, `checkpoints` (its `stats`) and `pr_watches` (its `state`), which are read as the old
// readers read them and written in the form the new ones read. `message_id` columns are `write_no`.

/** One old table copied into one new table: its old-row schema, the conversion, and the new table's check. */
export interface TableCopy<S extends Schema.Decoder<unknown>> {
  readonly old: string
  readonly table: string
  readonly schema: S
  readonly key: (row: Readonly<Record<string, unknown>>) => string
  readonly check: TableCheck
  /** The new row: values as the column has them, JSON values as values (written as JSON text). */
  readonly convert: (row: S["Type"]) => Readonly<Record<string, unknown>>
  /** A note on the row for the report, if it has one. */
  readonly note?: (row: S["Type"]) => string | null
  /** The old rows, when not every row of `old` in `rowid` order. */
  readonly rows?: Effect.Effect<ReadonlyArray<Readonly<Record<string, unknown>>>>
}

/** Reads, decodes, converts and writes one table; returns how many rows were written. */
export const copyTable = <S extends Schema.Decoder<unknown>>(io: FamilyIo, copy: TableCopy<S>) =>
  Effect.gen(function* () {
    const raw = yield* copy.rows ?? io.old.rows(copy.old)
    yield* io.report.old(copy.table, raw.length)
    const decoded = yield* decodeOld(io.report, copy.old, copy.schema, copy.key)(raw)
    const rows: Array<NewRow> = []
    for (const row of decoded) {
      const converted = yield* encodeColumns(copy.convert(row))
      const note = copy.note?.(row) ?? null
      if (note !== null) yield* io.report.note(copy.table, copy.check.key(converted), note)
      rows.push(converted)
    }
    return yield* io.write(copy.table, copy.check, rows)
  })

const Str = Schema.String
const NullStr = Schema.NullOr(Schema.String)
const Int = Schema.Int
const NullInt = Schema.NullOr(Schema.Int)

// ---- token_usage, call_usage, context_stats, review_stats: as they are --------------------------------------------

const { task_id: _usageTask, kind: _usageKind, created_at: _usageCreated, ...tokenUsageFields } = RunUsageRow.fields

/** A `token_usage` row (old and new have the same columns); the analytics' read without the run's columns. */
export const TokenUsageRow = Schema.Struct(tokenUsageFields)
/** A `call_usage` row: what the analytics read, with its id and config. */
export const CallUsageFullRow = Schema.Struct({ ...CallUsageRow.fields, id: Int, config_id: NullStr })
/** A `context_stats` row: the analytics' `ContextStat`, with its id and run. */
export const ContextStatsRow = Schema.Struct({ ...ContextStat.fields, id: Int, run_id: NullStr })
/** A `review_stats` row: what the analytics read, with its id. */
export const ReviewStatsRow = Schema.Struct({ ...ReviewStatRow.fields, id: Int })

/** Old rows of these four tables have the new columns already: the old row is the new row. */
export const asIs = <A extends Readonly<Record<string, unknown>>>(row: A): A => row

export const tokenUsageCopy: TableCopy<typeof TokenUsageRow> = {
  old: "token_usage",
  table: "token_usage",
  schema: TokenUsageRow,
  key: keyOf("run_id", "model"),
  check: { row: TokenUsageRow, key: keyOf("run_id", "model") },
  convert: asIs,
}

export const callUsageCopy: TableCopy<typeof CallUsageFullRow> = {
  old: "call_usage",
  table: "call_usage",
  schema: CallUsageFullRow,
  key: keyOf("id"),
  check: { row: CallUsageFullRow, key: keyOf("id") },
  convert: asIs,
}

export const contextStatsCopy: TableCopy<typeof ContextStatsRow> = {
  old: "context_stats",
  table: "context_stats",
  schema: ContextStatsRow,
  key: keyOf("id"),
  check: { row: ContextStatsRow, key: keyOf("id") },
  convert: asIs,
}

export const reviewStatsCopy: TableCopy<typeof ReviewStatsRow> = {
  old: "review_stats",
  table: "review_stats",
  schema: ReviewStatsRow,
  key: keyOf("id"),
  check: { row: ReviewStatsRow, key: keyOf("id") },
  convert: asIs,
}

// ---- documents, pr_states: as they are -------------------------------------------------------------------------

/** A `documents` row as `TaskDocumentRepo` reads it. */
export const DocumentRow = Schema.Struct({
  id: Int,
  task_id: TaskId,
  label: Str,
  version: Int,
  content: Str,
  open: Schema.Literals([0, 1]),
  created_at: Timestamp,
  updated_at: Timestamp,
})

export const documentsCopy: TableCopy<typeof DocumentRow> = {
  old: "documents",
  table: "documents",
  schema: DocumentRow,
  key: keyOf("id"),
  check: { row: DocumentRow, key: keyOf("id") },
  convert: asIs,
}

/** A `pr_states` row as `PrWatchRepo` reads it: GitHub's state in lower case. */
export const PrStateRow = Schema.Struct({ task_id: TaskId, pr_url: Str, state: Str, updated_at: Timestamp })

export const prStatesCopy: TableCopy<typeof PrStateRow> = {
  old: "pr_states",
  table: "pr_states",
  schema: PrStateRow,
  key: keyOf("task_id", "pr_url"),
  check: { row: PrStateRow, key: keyOf("task_id", "pr_url") },
  convert: asIs,
}

// ---- checkpoints: `message_id` is `write_no`; `stats` as the old reader read it -------------------------------------

export const OldCheckpoint = Schema.Struct({
  task_id: Str,
  n: Int,
  kind: Str,
  sha: Str,
  tree: Str,
  head: NullStr,
  before_n: NullInt,
  run_id: NullStr,
  turn: NullInt,
  message_id: NullInt,
  status: NullStr,
  session: NullStr,
  agent_at: NullStr,
  stats: NullStr,
  stale: Int,
  created_at: Str,
})
export type OldCheckpoint = typeof OldCheckpoint.Type

/** A `checkpoints` row as `CheckpointRepo` reads it, with its task. */
export const CheckpointRow = Schema.Struct({ ...Checkpoint.fields, task_id: TaskId })

/** Stats as the old `parse_stats` took them: the three counts, and the files left out (none before they were kept). */
const OldStats = Schema.fromJsonString(
  Schema.Struct({
    files: Int,
    additions: Int,
    deletions: Int,
    excluded: Schema.optional(Schema.NullOr(Schema.Array(Str))),
    excluded_count: Schema.optional(Schema.NullOr(Int)),
  }),
)
const decodeOldStats = Schema.decodeUnknownOption(OldStats)

/** A checkpoint's stats as the old reader read them: null when they were not there or could not be read. */
export const checkpointStats = (text: string | null): TurnStats | null => {
  if (text === null) return null
  const stats = decodeOldStats(text)
  if (stats._tag === "None") return null
  const s = stats.value
  return { files: s.files, additions: s.additions, deletions: s.deletions, excluded: s.excluded ?? [], excluded_count: s.excluded_count ?? 0 }
}

export const convertCheckpoint = (old: OldCheckpoint): Readonly<Record<string, unknown>> => {
  const { message_id, stats, ...rest } = old
  return { ...rest, write_no: message_id, stats: checkpointStats(stats) }
}

export const checkpointsCopy: TableCopy<typeof OldCheckpoint> = {
  old: "checkpoints",
  table: "checkpoints",
  schema: OldCheckpoint,
  key: keyOf("task_id", "n"),
  check: { row: CheckpointRow, json: { stats: TurnStats }, key: keyOf("task_id", "n") },
  convert: convertCheckpoint,
  note: (old) => (old.stats !== null && checkpointStats(old.stats) === null ? "its stats could not be read (the old board showed none): left out" : null),
}

// ---- pr_watches: `state` as the old reader read it --------------------------------------------------------------

export const OldPrWatch = Schema.Struct({ task_id: Str, pr: Str, state: Str, updated_at: Str })
export type OldPrWatch = typeof OldPrWatch.Type

/** A `pr_watches` row as `PrWatchRepo` reads it; its `state` is checked as a `WatchRow`. */
export const PrWatchRow = Schema.Struct({ task_id: TaskId, pr: Str, state: Str, updated_at: Timestamp })

const Strings = Schema.optional(Schema.NullOr(Schema.Array(Str)))
const Flag = Schema.optional(Schema.NullOr(Schema.Boolean))
const OldSeen = Schema.Struct({ head: Schema.optional(NullStr), failed: Strings, passed: Flag, remarks: Strings, conflicting: Flag })
/** The old `Row_from_json`'s reading: missing fields are their defaults; a field of the wrong type fails the row. */
const OldWatchState = Schema.fromJsonString(
  Schema.Struct({
    seen: Schema.optional(Schema.NullOr(OldSeen)),
    pending: Schema.optional(Schema.NullOr(Schema.Struct({ call_id: Str, told: OldSeen, superseded: Schema.optional(Schema.Unknown) }))),
    last: Schema.optional(Schema.Unknown),
    polled_at: Schema.optional(Schema.Unknown),
    comment_wakes: Schema.optional(Schema.Unknown),
    woke_at: Schema.optional(Schema.Unknown),
    comments_paused: Schema.optional(Schema.Unknown),
  }),
)
const decodeWatchState = Schema.decodeUnknownOption(OldWatchState)
const decodeSummary = Schema.decodeUnknownOption(PrSummary)

const seenOf = (s: typeof OldSeen.Type | null | undefined): Seen => ({
  head: s?.head ?? null,
  failed: s?.failed ?? [],
  passed: s?.passed ?? false,
  remarks: s?.remarks ?? [],
  conflicting: s?.conflicting ?? false,
})

/** What an old `pr_watches` state becomes, and why it changed, if it did. */
export interface WatchState {
  readonly state: WatchRow
  readonly note: string | null
}

/**
 * An old `pr_watches` state as the old reader read it (`Row_from_json`): missing fields are their defaults, and a state
 * it could not read is the empty row, as the old server took it (as nothing told yet). Its `last` (what the latest read
 * found) is kept when it is the summary the new reader reads, else dropped (the next read fills it).
 */
export const watchState = (text: string): WatchState => {
  const decoded = decodeWatchState(text)
  if (decoded._tag === "None")
    return {
      state: { seen: seenOf(null), last: null, polled_at: "", comment_wakes: 0, comments_paused: false },
      note: "its state could not be read (the old board read it as nothing told yet): written as that",
    }
  const v = decoded.value
  const last = v.last === undefined || v.last === null ? null : decodeSummary(v.last)
  const pending = v.pending === undefined || v.pending === null ? null : v.pending
  const state: WatchRow = {
    seen: seenOf(v.seen),
    ...(pending === null
      ? {}
      : { pending: { call_id: pending.call_id, told: seenOf(pending.told), ...(pending.superseded === true ? { superseded: true } : {}) } }),
    last: last === null || last._tag === "None" ? null : last.value,
    polled_at: typeof v.polled_at === "string" ? v.polled_at : "",
    comment_wakes: typeof v.comment_wakes === "number" && Number.isInteger(v.comment_wakes) ? v.comment_wakes : 0,
    ...(typeof v.woke_at === "string" ? { woke_at: v.woke_at } : {}),
    comments_paused: v.comments_paused === true,
  }
  return {
    state,
    note: last !== null && last._tag === "None" ? "its last read is in a form the new reader does not take: dropped (the next read fills it)" : null,
  }
}

export const convertPrWatch = (old: OldPrWatch): Readonly<Record<string, unknown>> => ({ ...old, state: watchState(old.state).state })

export const prWatchesCopy: TableCopy<typeof OldPrWatch> = {
  old: "pr_watches",
  table: "pr_watches",
  schema: OldPrWatch,
  key: keyOf("task_id", "pr"),
  check: { row: PrWatchRow, json: { state: WatchRow }, key: keyOf("task_id", "pr") },
  convert: convertPrWatch,
  note: (old) => watchState(old.state).note,
}
