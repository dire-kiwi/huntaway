import { Effect, Predicate, Result, Schema } from "effect"
import { Item, TaskId, ThreadRequest, Timestamp } from "@huntaway/contracts"
import type { Notice } from "@huntaway/contracts"
import { ThreadToolsRow } from "../../../agents/AgentToolsRepo.ts"
import { decodeLine } from "../../../agents/claude/lines.ts"
import { jsonText } from "../../../agents/claude/tools.ts"
import { stateFromItems, translate } from "../../../agents/claude/translate.ts"
import { EXPIRED } from "../../../permissions/prompts.ts"
import { encodeColumns } from "../../../platform/columns.ts"
import { ItemMeta, writeNoOf } from "../../../threads/model.ts"
import { ItemRow, RequestRow } from "../../../threads/ThreadStore.ts"
import { decodeOld, keyOf } from "../family.ts"
import type { Family, FamilyIo, NewRow, TableCheck } from "../family.ts"

// The threads family (docs/plan/11-migration.md, Table by table and Threads not yet items): `threads`,
// `thread_items` (with `thread_item_origins`), `thread_requests`, a kept `messages` row of a task on items, the
// `messages` sequence's high-water mark as the `thread_write` counter, and `review_thread_skills` with
// `thread_mcp_servers` as `thread_tools`. `thread_events` and `mcp_calls` are counted, not imported: `threads.seq` is
// kept, so a client's next watch gets a snapshot. A thread whose `converter` is an older translator's is imported as it
// is (its task is on items, and there are no messages left to rebuild it from). Values are kept as the JSON stored, so
// unknown fields survive; only a request whose record changes is written again.

// ---- old rows ------------------------------------------------------------------------------------------------------

const OldThread = Schema.Struct({ task_id: Schema.String, seq: Schema.Finite, created_at: Schema.String })
type OldThread = typeof OldThread.Type

/** An old item with its write: the lowest message id among its origins (null for none). */
export const OldItem = Schema.Struct({
  task_id: Schema.String,
  id: Schema.String,
  pos: Schema.Finite,
  type: Schema.String,
  parent_id: Schema.NullOr(Schema.String),
  data: Schema.String,
  meta: Schema.NullOr(Schema.String),
  created_at: Schema.String,
  updated_at: Schema.String,
  write_no: Schema.NullOr(Schema.Finite),
})
export type OldItem = typeof OldItem.Type

export const OldRequest = Schema.Struct({
  task_id: Schema.String,
  id: Schema.String,
  pos: Schema.Finite,
  type: Schema.String,
  tool_call_id: Schema.NullOr(Schema.String),
  open: Schema.Finite,
  data: Schema.String,
  created_at: Schema.String,
  updated_at: Schema.String,
})
export type OldRequest = typeof OldRequest.Type

/** A `messages` row, with its task's key for the report. */
export const OldMessage = Schema.Struct({
  id: Schema.Finite,
  task_id: Schema.String,
  kind: Schema.String,
  data: Schema.String,
  created_at: Schema.String,
  key: Schema.String,
})
export type OldMessage = typeof OldMessage.Type

/** One task's list in `review_thread_skills.skills` or `thread_mcp_servers.disabled`. */
export const OldList = Schema.Struct({ task_id: Schema.String, list: Schema.String })
export type OldList = typeof OldList.Type

// ---- new rows' checks ----------------------------------------------------------------------------------------------

const Strings = Schema.Array(Schema.String)

const threadsCheck: TableCheck = {
  row: Schema.Struct({ task_id: TaskId, seq: Schema.Int, created_at: Timestamp }),
  key: keyOf("task_id"),
}
const itemsCheck: TableCheck = {
  row: Schema.Struct({
    ...ItemRow.fields,
    task_id: TaskId,
    id: Schema.String,
    type: Schema.String,
    parent_id: Schema.NullOr(Schema.String),
    updated_at: Timestamp,
  }),
  json: { data: Item, meta: ItemMeta },
  key: keyOf("task_id", "id"),
}
const requestsCheck: TableCheck = {
  row: Schema.Struct({
    ...RequestRow.fields,
    task_id: TaskId,
    id: Schema.String,
    pos: Schema.Int,
    type: Schema.String,
    tool_call_id: Schema.NullOr(Schema.String),
    open: Schema.Int,
    created_at: Timestamp,
    updated_at: Timestamp,
  }),
  json: { data: ThreadRequest },
  key: keyOf("task_id", "id"),
}
const toolsCheck: TableCheck = {
  row: Schema.Struct({ ...ThreadToolsRow.fields, task_id: TaskId }),
  json: { skills: Strings, disabled_mcp_servers: Strings },
  key: keyOf("task_id"),
}
const countersCheck: TableCheck = {
  row: Schema.Struct({ name: Schema.Literal("thread_write"), value: Schema.Int }),
  key: keyOf("name"),
}

// ---- conversions ---------------------------------------------------------------------------------------------------

const parseJson = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Unknown))
/** A stored JSON text's value; undefined for text that is not JSON. */
const parsed = (text: string): unknown => Result.getOrUndefined(parseJson(text))

const decodeItem = Schema.decodeUnknownResult(Schema.fromJsonString(Item))
const decodeMeta = Schema.decodeUnknownResult(Schema.fromJsonString(ItemMeta))
const decodeRequest = Schema.decodeUnknownResult(Schema.fromJsonString(ThreadRequest))

/** A write number as stored: a whole number, or digits (null for anything else). */
export const writeNumber = (value: unknown): number | null => {
  const n = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.floor(n) : null
}

export const threadRow = (old: OldThread): NewRow => ({ task_id: old.task_id, seq: old.seq, created_at: old.created_at })

/** An item as it was, with the write that made it; `turn_id` and `live` are not carried. */
export const itemRow = (old: OldItem): NewRow => ({
  task_id: old.task_id,
  id: old.id,
  pos: old.pos,
  type: old.type,
  parent_id: old.parent_id,
  write_no: old.write_no === null ? null : writeNumber(old.write_no),
  data: old.data,
  meta: old.meta,
  created_at: old.created_at,
  updated_at: old.updated_at,
})

/**
 * A request, its write from `metadata.message_id`. Its record is changed in two cases, and only then written again:
 * a workflow's approval stored with `kind: 'automation'` says `workflow` (inventory 09, section 9, item 12, as the old
 * migration 100 rewrote them); and a prompt whose `permission_requests` row was still pending (`promptPending`), which
 * the import records as expired, is expired here too, as the new server expires one (`Permissions.expireOne`): its
 * status `expired`, and, if it was open, cancelled with "Request expired". `open` follows the resolution, as the store
 * writes it.
 */
export const requestRow = (old: OldRequest, promptPending: boolean): Readonly<Record<string, unknown>> => {
  const value = parsed(old.data)
  const base = {
    task_id: old.task_id,
    id: old.id,
    pos: old.pos,
    type: old.type,
    tool_call_id: old.tool_call_id,
    created_at: old.created_at,
    updated_at: old.updated_at,
  }
  if (!Predicate.isObject(value)) return { ...base, write_no: null, open: old.open, data: old.data }
  let request: Readonly<Record<string, unknown>> = value
  let metadata: Readonly<Record<string, unknown>> | undefined = Predicate.isObject(value["metadata"]) ? value["metadata"] : undefined
  let changed = false
  const input = request["input"]
  if (request["type"] === "permission" && metadata?.["kind"] === "automation" && Predicate.isObject(input) && input["workflow"] != null) {
    metadata = { ...metadata, kind: "workflow" }
    changed = true
  }
  if (promptPending) {
    metadata = { ...metadata, status: "expired" }
    if (request["resolution"] === undefined) request = { ...request, resolution: { outcome: "cancel", message: EXPIRED } }
    changed = true
  }
  if (changed) request = { ...request, metadata }
  return {
    ...base,
    write_no: writeNumber(metadata?.["message_id"]),
    open: request["resolution"] === undefined ? 1 : 0,
    data: changed ? request : old.data,
  }
}

/** The old board's prompts still pending (`permission_requests` rows): their ids and their message ids. */
export interface PendingPrompts {
  readonly ids: ReadonlySet<string>
  readonly writes: ReadonlySet<number>
}

/**
 * Whether a request is a prompt still pending in the old board: its id is the prompt's, or its `metadata.message_id`
 * is the prompt's `message_id` (what the old `expire` went by, `set_message_status(message_id, "expired")`). A board
 * question (`legacy:<n>`) has no prompt row, so it is not one: it stays answerable after its run, on the new server
 * as on the old.
 */
export const isPendingPrompt = (old: OldRequest, pending: PendingPrompts): boolean => {
  if (pending.ids.has(old.id)) return true
  const value = parsed(old.data)
  const metadata = Predicate.isObject(value) && Predicate.isObject(value["metadata"]) ? value["metadata"] : undefined
  const write = writeNumber(metadata?.["message_id"])
  return write !== null && pending.writes.has(write)
}

/** `review_thread_skills` and `thread_mcp_servers`, merged by task: one `thread_tools` row each. */
export const toolsRows = (skills: ReadonlyArray<OldList>, disabled: ReadonlyArray<OldList>): ReadonlyArray<NewRow> => {
  const rows = new Map<string, { task_id: string; skills: string; disabled_mcp_servers: string }>()
  for (const s of skills) rows.set(s.task_id, { task_id: s.task_id, skills: s.list, disabled_mcp_servers: "[]" })
  for (const d of disabled) rows.set(d.task_id, { task_id: d.task_id, skills: rows.get(d.task_id)?.skills ?? "[]", disabled_mcp_servers: d.list })
  return [...rows.values()]
}

/** The `thread_write` counter: the highest of the write numbers given (the old sequence's mark, and every one kept). */
export const counterValue = (marks: Iterable<unknown>): number => {
  let max = 0
  for (const mark of marks) {
    const n = writeNumber(mark)
    if (n !== null && n > max) max = n
  }
  return max
}

/** What a carried `messages` row says: the old board kept it as a row because it could not make items of it. */
export const LEGACY_MESSAGE = "A message the old board could not show"

/** A thread's items before a kept message, which the translator goes on from. */
export interface Prior {
  readonly items: ReadonlyArray<Item>
  readonly requests: ReadonlyArray<ThreadRequest>
  readonly meta: (id: string) => ItemMeta | undefined
  /** Every item id the thread has (a new item must not take one). */
  readonly ids: ReadonlySet<string>
}

export interface MessageEntry {
  readonly item: Item
  readonly meta: ItemMeta | null
}

/** A kept `messages` row as items: `converted` by the new translator, or `carried` as one notice. */
export interface MessageItems {
  readonly how: "converted" | "carried"
  readonly entries: ReadonlyArray<MessageEntry>
}

/**
 * A `claude` message (a slimmed stream-json line) through the new Claude translator, from the state of the thread
 * before it, with the row's id as the write number. Only a line that adds items, each with an id the thread does not
 * have, is converted: one that changes items already there (a tool's result) or makes nothing is not.
 */
const fromClaude = (m: OldMessage, prior: Prior): ReadonlyArray<MessageEntry> | null => {
  const line = decodeLine(m.data)
  if (Result.isFailure(line)) return null
  const value = parsed(m.data)
  const data = Predicate.isObject(value) ? value : {}
  const cost = data["total_cost_usd"]
  const turn =
    line.success.type === "result"
      ? { turn: { cost: typeof cost === "number" ? cost : 0, stopping: data["interrupted"] === true, compact: data["compact"] === true } }
      : {}
  const state = stateFromItems(prior.items, prior.requests, prior.meta)
  const made = translate(state, line.success, { writeNo: m.id, at: Timestamp.make(m.created_at), ...turn })
  if (made.events.length === 0) return null
  const seen = new Set(prior.ids)
  const out: Array<MessageEntry> = []
  for (const e of made.events) {
    if (e.type !== "item.added" || seen.has(e.item.id)) return null
    seen.add(e.item.id)
    out.push({ item: e.item, meta: made.metas.get(e.item.id) ?? null })
  }
  return out
}

/** The notice a kept message is carried as: its `kind` and `data` whole in `detail`, at its id. */
const legacyNotice = (m: OldMessage, ids: ReadonlySet<string>): Notice => {
  const id = ids.has(`legacy:${m.id}`) ? `legacy:${m.id}:message` : `legacy:${m.id}`
  const data = parsed(m.data)
  return {
    id,
    type: "notice",
    level: "warning",
    code: "legacy_message",
    text: LEGACY_MESSAGE,
    detail: jsonText({ kind: m.kind, data: data === undefined ? m.data : data }),
    created_at: Timestamp.make(m.created_at),
  }
}

/** A kept `messages` row of a task on items, as the items to write at its id. */
export const messageItems = (m: OldMessage, prior: Prior): MessageItems => {
  const converted = m.kind === "claude" ? fromClaude(m, prior) : null
  if (converted !== null) return { how: "converted", entries: converted }
  return { how: "carried", entries: [{ item: legacyNotice(m, prior.ids), meta: null }] }
}

/** Where an item written by write `writeNo` goes among a thread's items: before the first one written after it. */
export const insertionIndex = (written: ReadonlyArray<number | null>, writeNo: number): number => {
  const i = written.findIndex((w) => w !== null && w > writeNo)
  return i === -1 ? written.length : i
}

/** One item of a thread being put together: its row (without `pos`), its write, and, decoded, what it is. */
interface Slot {
  readonly row: Readonly<Record<string, unknown>>
  readonly writeNo: number | null
  readonly item: Item | undefined
  readonly meta: ItemMeta | undefined
}

const slotOf = (old: OldItem): Slot => {
  const row = itemRow(old)
  const item = decodeItem(old.data)
  const meta = old.meta === null ? undefined : decodeMeta(old.meta)
  return {
    row,
    writeNo: typeof row["write_no"] === "number" ? row["write_no"] : null,
    item: Result.isSuccess(item) ? item.success : undefined,
    meta: meta !== undefined && Result.isSuccess(meta) ? meta.success : undefined,
  }
}

/**
 * A thread's items with its kept messages put in at their writes: each message, oldest first, made into items (as
 * `messageItems` says) from the items before it, and placed before the first item written after it. Positions are
 * numbered again from 0 in that order. Returns the rows and how each message went, oldest first.
 */
export const withMessages = (
  items: ReadonlyArray<OldItem>,
  messages: ReadonlyArray<OldMessage>,
  requests: ReadonlyArray<ThreadRequest>,
): {
  readonly rows: ReadonlyArray<Readonly<Record<string, unknown>>>
  readonly how: ReadonlyArray<{ readonly message: OldMessage; readonly how: MessageItems["how"] }>
} => {
  const slots: Array<Slot> = items.map(slotOf)
  const how: Array<{ readonly message: OldMessage; readonly how: MessageItems["how"] }> = []
  for (const m of [...messages].toSorted((a, b) => a.id - b.id)) {
    const at = insertionIndex(
      slots.map((s) => s.writeNo),
      m.id,
    )
    const before = slots.slice(0, at)
    const metas = new Map(before.flatMap((s) => (s.item !== undefined && s.meta !== undefined ? [[s.item.id, s.meta] as const] : [])))
    const made = messageItems(m, {
      items: before.flatMap((s) => (s.item === undefined ? [] : [s.item])),
      requests,
      meta: (id) => metas.get(id),
      ids: new Set(slots.map((s) => String(s.row["id"]))),
    })
    how.push({ message: m, how: made.how })
    const added = made.entries.map((e): Slot => ({
      row: {
        task_id: m.task_id,
        id: e.item.id,
        type: e.item.type,
        parent_id: e.item.parent_id ?? null,
        write_no: m.id,
        data: e.item,
        meta: e.meta,
        created_at: e.item.created_at ?? m.created_at,
        updated_at: m.created_at,
      },
      writeNo: m.id,
      item: e.item,
      meta: e.meta ?? undefined,
    }))
    slots.splice(at, 0, ...added)
  }
  return { rows: slots.map((s, pos) => Object.assign({}, s.row, { pos })), how }
}

// ---- the family ----------------------------------------------------------------------------------------------------

/** A task's key in the old database, for the report (as run.ts's `taskKeySql`): its project's key and number, else its id. */
const TASK_KEY = `COALESCE(CASE WHEN p.key IS NOT NULL THEN p.key || '-' || t.number ELSE t.id END, m.task_id)`

/** The largest of `expr` over old `table`, if it has `column`. */
const oldMax = (io: FamilyIo, table: string, column: string, expr: string) =>
  io.old.columns(table).has(column) ? Effect.map(io.old.query(`SELECT MAX(${expr}) AS n FROM "${table}"`), (rows) => rows[0]?.["n"]) : Effect.succeed(null)

const count = (io: FamilyIo, table: string) =>
  io.old.tables.has(table) ? Effect.map(io.old.query(`SELECT COUNT(*) AS n FROM "${table}"`), (rows) => Number(rows[0]?.["n"] ?? 0)) : Effect.succeed(0)

const encodeAll = (rows: ReadonlyArray<Readonly<Record<string, unknown>>>) => Effect.forEach(rows, encodeColumns, { concurrency: 1 })

const run = Effect.fnUntraced(function* (io: FamilyIo) {
  const marks: Array<unknown> = []

  // threads
  const threads = yield* decodeOld(io.report, "threads", OldThread, keyOf("task_id"))(yield* io.old.rows("threads", "task_id"))
  yield* io.report.old("threads", threads.length)
  yield* io.write("threads", threadsCheck, threads.map(threadRow))

  // thread_requests, with the prompts still pending in the old board's permission_requests
  const pendingRows = io.old.columns("permission_requests").has("message_id")
    ? yield* io.old.query(`SELECT id, message_id FROM permission_requests WHERE status = 'pending'`)
    : []
  const pending: PendingPrompts = {
    ids: new Set(pendingRows.map((r) => String(r["id"]))),
    writes: new Set(pendingRows.flatMap((r) => [writeNumber(r["message_id"])].filter((n) => n !== null))),
  }
  const oldRequests = yield* decodeOld(io.report, "thread_requests", OldRequest, keyOf("task_id", "id"))(yield* io.old.rows("thread_requests", "task_id, pos"))
  yield* io.report.old("thread_requests", oldRequests.length)
  const requestRows = oldRequests.map((r) => requestRow(r, isPendingPrompt(r, pending)))
  for (const r of requestRows) marks.push(r["write_no"])
  yield* io.write("thread_requests", requestsCheck, yield* encodeAll(requestRows))
  /** Each task's requests as the translator takes them, for a task with kept messages. */
  const requestsOf = (task: string) =>
    requestRows.flatMap((r) => {
      if (r["task_id"] !== task) return []
      const data = r["data"]
      const decoded = decodeRequest(typeof data === "string" ? data : jsonText(data))
      return Result.isSuccess(decoded) ? [decoded.success] : []
    })

  // messages kept for tasks on items (the import refused tasks still on messages), by task
  const messages = io.old.tables.has("messages")
    ? yield* decodeOld(
        io.report,
        "messages",
        OldMessage,
        keyOf("id"),
      )(
        yield* io.old.query(`SELECT m.id, m.task_id, m.kind, m.data, m.created_at, ${TASK_KEY} AS key
          FROM messages m LEFT JOIN tasks t ON t.id = m.task_id LEFT JOIN projects p ON p.id = t.project_id ORDER BY m.id`),
      )
    : []
  const messagesOf = new Map<string, Array<OldMessage>>()
  for (const m of messages) messagesOf.set(m.task_id, [...(messagesOf.get(m.task_id) ?? []), m])

  // thread_items with their writes from thread_item_origins, a task at a time
  const origins = io.old.tables.has("thread_item_origins")
  const meta = io.old.columns("thread_items").has("meta") ? "i.meta" : "NULL AS meta"
  const write = origins ? "(SELECT MIN(o.message_id) FROM thread_item_origins o WHERE o.task_id = i.task_id AND o.item_id = i.id)" : "NULL"
  const itemTasks = io.old.tables.has("thread_items")
    ? (yield* io.old.query(`SELECT DISTINCT task_id FROM thread_items ORDER BY task_id`)).map((r) => String(r["task_id"]))
    : []
  const tasks = [...new Set([...itemTasks, ...messagesOf.keys()])]
  const decodeItems = decodeOld(io.report, "thread_items", OldItem, keyOf("task_id", "id"))
  let oldItems = 0
  for (const task of tasks) {
    const items = io.old.tables.has("thread_items")
      ? yield* decodeItems(
          yield* io.old.query(
            `SELECT i.task_id, i.id, i.pos, i.type, i.parent_id, i.data, ${meta}, i.created_at, i.updated_at, ${write} AS write_no
              FROM thread_items i WHERE i.task_id = ? ORDER BY i.pos`,
            [task],
          ),
        )
      : []
    oldItems += items.length
    const kept = messagesOf.get(task) ?? []
    let rows: ReadonlyArray<Readonly<Record<string, unknown>>> = items.map(itemRow)
    if (kept.length > 0) {
      const merged = withMessages(items, kept, requestsOf(task))
      rows = merged.rows
      for (const { message, how } of merged.how) yield* io.report.message(message.key, how)
    }
    for (const r of rows) {
      marks.push(r["write_no"])
      const id = r["id"]
      if (typeof id === "string") marks.push(writeNoOf(id))
    }
    yield* io.write("thread_items", itemsCheck, yield* encodeAll(rows))
  }
  yield* io.report.old("thread_items", oldItems)
  yield* io.report.old("thread_item_origins (as thread_items.write_no)", yield* count(io, "thread_item_origins"))

  // thread_tools
  const decodeList = decodeOld(io.report, "thread_tools", OldList, keyOf("task_id"))
  const skills = io.old.columns("review_thread_skills").has("skills")
    ? yield* decodeList(yield* io.old.query(`SELECT task_id, skills AS list FROM review_thread_skills ORDER BY task_id`))
    : []
  const disabled = io.old.columns("thread_mcp_servers").has("disabled")
    ? yield* decodeList(yield* io.old.query(`SELECT task_id, disabled AS list FROM thread_mcp_servers ORDER BY task_id`))
    : []
  yield* io.report.old("thread_tools", (yield* count(io, "review_thread_skills")) + (yield* count(io, "thread_mcp_servers")))
  yield* io.write("thread_tools", toolsCheck, toolsRows(skills, disabled))

  // Not imported: the event log (a client's next watch gets a snapshot) and the board tools' call records.
  yield* io.report.old("thread_events (not imported)", yield* count(io, "thread_events"))
  yield* io.report.old("mcp_calls (not imported)", yield* count(io, "mcp_calls"))

  // The write counter: the messages sequence's high-water mark, and at least every write number kept anywhere.
  const sequence = io.old.tables.has("sqlite_sequence") ? yield* io.old.query(`SELECT seq FROM sqlite_sequence WHERE name = 'messages'`) : []
  marks.push(sequence[0]?.["seq"])
  marks.push(yield* oldMax(io, "messages", "id", "id"))
  marks.push(yield* oldMax(io, "thread_item_origins", "message_id", "message_id"))
  marks.push(yield* oldMax(io, "permission_requests", "message_id", "message_id"))
  marks.push(yield* oldMax(io, "checkpoints", "message_id", "message_id"))
  marks.push(yield* oldMax(io, "runs", "turn_message_id", "turn_message_id"))
  marks.push(yield* oldMax(io, "tasks", "rewind", "CASE WHEN json_valid(rewind) THEN CAST(json_extract(rewind, '$.message_id') AS INTEGER) END"))
  yield* io.report.old("counters", sequence.length)
  const value = counterValue(marks)
  if (value > 0) yield* io.write("counters", countersCheck, [{ name: "thread_write", value }])
})

export const threadsFamily: Family = {
  name: "threads",
  reads: [
    "threads",
    "thread_items",
    "thread_item_origins",
    "thread_requests",
    "thread_events",
    "mcp_calls",
    "messages",
    "sqlite_sequence",
    "review_thread_skills",
    "thread_mcp_servers",
  ],
  writes: ["threads", "thread_requests", "thread_items", "thread_tools", "counters"],
  run,
}
