import { Context, DateTime, Effect, Layer, Schema } from "effect"
import { SqlClient } from "effect/sql"
import type { SqlError } from "effect/sql"
import { Item, patched, SavedEvent, TaskId, ThreadRequest, Timestamp, UnknownEvent } from "@huntaway/contracts"
import type { ItemPage, ItemType, NewEvent, ProfileId, Snapshot } from "@huntaway/contracts"
import { JsonColumn, rowsOf, toJson } from "../platform/columns.ts"
import { ItemMeta, WriteNo } from "./model.ts"
import type { Entry, ItemMetas, StoredRequest } from "./model.ts"

// A task's thread as items (docs/plan/04-database.md, Thread tables): the `threads`, `thread_items`, `thread_requests`
// and `thread_events` rows, and the board's write counter. Items and requests are kept as they are now, updated in
// place as events come; a snapshot is a read of them. Events are kept a day (`KEEP_DAYS`), for clients catching up
// after a gap; the `threads` row keeps the last seq, so numbering goes on when the log is empty. Values are stored as
// the JSON given. Single statements and small groups; `SqlError` and `SchemaError` are defects. Nothing here waits.
// The old threads/store.ts, without `clear`, origins (an item's write is its `write_no`) and `items.removed`.

/** How long a thread's saved events are kept: by age only (a client away longer takes a fresh window). */
export const KEEP_DAYS = 1

/** A saved event as the log gives it back: one of this build's types, or a newer build's (counted, otherwise ignored). */
export type StoredEvent = SavedEvent | UnknownEvent

/** A thread's state without its own (`Thread`, which is its task's): a whole one, or a window of its last items. */
export type ThreadState = Omit<Snapshot, "thread">

export interface AppendOptions {
  /** When it happened: the items' and events' time, and what pruning counts back from. */
  readonly at: Timestamp
  /** The write the events come from: the `write_no` of the items and requests they add. */
  readonly writeNo?: WriteNo | undefined
  /** The metas of items the events add or change, each replacing what its item had. */
  readonly metas?: ItemMetas | undefined
}

/** A newest-first scan of one thread's items (the readers', inventory 08 §3.8). */
export interface Scan {
  readonly types: ReadonlyArray<ItemType>
  /** At most this many. */
  readonly limit: number
  /** Only items at or before this position. */
  readonly upto?: number | undefined
  /** Only items before this position. */
  readonly before?: number | undefined
  /** Only items made after this time. */
  readonly after?: Timestamp | undefined
  /** Only the item with this id, or whose meta's `call_id` is it. */
  readonly id?: string | undefined
  /** Only tool calls whose meta's `subagent_task` is this. */
  readonly subagentTask?: string | undefined
}

/** A user message of a profile's, for prompt analytics. */
export interface ProfileUserMessage {
  readonly task_id: TaskId
  readonly entry: Entry
}

export interface ThreadStoreShape {
  /** The next board-wide write number (`counters` row `thread_write`; the first is 1). Inside the write's transaction. */
  readonly nextWriteNo: Effect.Effect<WriteNo>
  /**
   * Saves `events` for the task's thread (making its `threads` row if it has none), numbering them after its last, and
   * applies each to its items and requests in place: an item added with an id it has replaces it where it is, an
   * update to an item it lacks only goes in the log. Sets the metas given, bumps the thread's seq and prunes its events
   * older than a day. Returns the events as saved. Call it inside `Db.tx` with the rest of the write; the task must
   * exist (a missing one is a defect).
   */
  readonly append: (task: TaskId, events: ReadonlyArray<NewEvent>, options: AppendOptions) => Effect.Effect<ReadonlyArray<SavedEvent>>
  /** The seq of the thread's last saved event; 0 for none (or no thread). */
  readonly seq: (task: TaskId) => Effect.Effect<number>
  readonly item: (task: TaskId, id: string) => Effect.Effect<Entry | null>
  readonly request: (task: TaskId, id: string) => Effect.Effect<StoredRequest | null>
  /** Every item, in order, with what the board knows of it: what a translator is rebuilt from. */
  readonly entries: (task: TaskId) => Effect.Effect<ReadonlyArray<Entry>>
  /** Every request, oldest first: the open ones, and the resolved ones with their resolution. */
  readonly requests: (task: TaskId) => Effect.Effect<ReadonlyArray<ThreadRequest>>
  readonly openRequests: (task: TaskId) => Effect.Effect<ReadonlyArray<ThreadRequest>>
  /**
   * The thread whole, or (with a `limit` it is over) the window of its last `limit` items and what they need from
   * before them, read from the tables: the contracts' `snapshotWindow` of the whole state, without reading all of it.
   */
  readonly window: (task: TaskId, limit: number | undefined) => Effect.Effect<ThreadState>
  /** The items before index `before`, at most `limit`, with what they need: the contracts' `itemPage`, from the tables. */
  readonly page: (task: TaskId, before: number, limit: number) => Effect.Effect<ItemPage>
  /**
   * The saved events after `after`, oldest first; none if `after` is at or past the last; null if the log no longer
   * reaches back to `after + 1` (the client takes a fresh window).
   */
  readonly eventsAfter: (task: TaskId, after: number) => Effect.Effect<ReadonlyArray<StoredEvent> | null>
  /** Removes every thread's events from before `before`. Returns how many went. */
  readonly prune: (before: Timestamp) => Effect.Effect<number>
  /** The thread's items of `scan.types`, newest first. */
  readonly newest: (task: TaskId, scan: Scan) => Effect.Effect<ReadonlyArray<Entry>>
  /** The tool calls made after `after` (all of them for null), oldest first. */
  readonly toolCallsSince: (task: TaskId, after: Timestamp | null) => Effect.Effect<ReadonlyArray<Entry>>
  /** Whether a user message was added at or after `at`. */
  readonly userMessagedSince: (task: TaskId, at: Timestamp) => Effect.Effect<boolean>
  /** Whether a user message was written after write `n`. */
  readonly userMessageAfter: (task: TaskId, n: WriteNo) => Effect.Effect<boolean>
  /** The write number of the thread's first user message; null for none. */
  readonly firstUserMessage: (task: TaskId) => Effect.Effect<WriteNo | null>
  /** The user messages of the profile's tasks made at `from` or later and before `to`, oldest first. */
  readonly userMessagesBetween: (profile: ProfileId, from: Timestamp, to: Timestamp) => Effect.Effect<ReadonlyArray<ProfileUserMessage>>
  /** The open question requests, oldest first. */
  readonly openQuestions: (task: TaskId) => Effect.Effect<ReadonlyArray<StoredRequest>>
  /** Whether a question request's metadata names call `callId`. */
  readonly askedIn: (task: TaskId, callId: string) => Effect.Effect<boolean>
  /** The routines' report notices whose report is not `read`, oldest first. */
  readonly unreadReports: (task: TaskId) => Effect.Effect<ReadonlyArray<Entry>>
}

// ---- rows ------------------------------------------------------------------------------------------------------

const ItemRow = Schema.Struct({
  pos: Schema.Int,
  write_no: Schema.NullOr(WriteNo),
  created_at: Timestamp,
  data: Schema.fromJsonString(Item),
  meta: JsonColumn(ItemMeta, {}),
})
const toEntry = (row: typeof ItemRow.Type): Entry => ({ pos: row.pos, item: row.data, meta: row.meta, write_no: row.write_no, created_at: row.created_at })
const ITEM = "pos, write_no, created_at, data, meta"

const RequestRow = Schema.Struct({ write_no: Schema.NullOr(WriteNo), data: Schema.fromJsonString(ThreadRequest) })
const toStoredRequest = (row: typeof RequestRow.Type): StoredRequest => ({ request: row.data, write_no: row.write_no })

const EventRow = Schema.Struct({ data: Schema.fromJsonString(Schema.Union([SavedEvent, UnknownEvent])) })
const ProfileItemRow = Schema.Struct({ ...ItemRow.fields, task_id: TaskId })
const Pos = Schema.Struct({ pos: Schema.Int, parent_id: Schema.NullOr(Schema.String) })
const Id = Schema.Struct({ id: Schema.String })
const N = Schema.Struct({ n: Schema.NullOr(Schema.Finite) })

// Each row schema's reader, its decoder made once.
const itemRows = rowsOf(ItemRow)
const requestRows = rowsOf(RequestRow)
const eventRows = rowsOf(EventRow)
const profileItemRows = rowsOf(ProfileItemRow)
const posRows = rowsOf(Pos)
const idRows = rowsOf(Id)
const nRows = rowsOf(N)
const createdAtRows = rowsOf(Schema.Struct({ created_at: Timestamp }))
const seqRows = rowsOf(Schema.Struct({ seq: Schema.Int }))
/** A statement run for what it does. */
const run = (statement: Effect.Effect<ReadonlyArray<unknown>, SqlError.SqlError>) => Effect.asVoid(statement).pipe(Effect.orDie)
/** The `n` of a statement's first row; null for none or NULL. */
const number = (statement: Effect.Effect<ReadonlyArray<unknown>, SqlError.SqlError>) => Effect.map(nRows(statement), (rows) => rows[0]?.n ?? null)

/** `at` less the days the log keeps: the time before which a thread's events are pruned. */
export const keepFrom = (at: Timestamp): Timestamp => Timestamp.make(DateTime.formatIso(DateTime.subtract(DateTime.makeUnsafe(at), { days: KEEP_DAYS })))

/** The repository of threads. */
export class ThreadStore extends Context.Service<ThreadStore, ThreadStoreShape>()("huntaway-server/threads/ThreadStore") {
  static readonly layer = Layer.effect(
    ThreadStore,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient

      const nextWriteNo = Effect.map(
        number(sql`INSERT INTO counters (name, value) VALUES ('thread_write', 1)
          ON CONFLICT (name) DO UPDATE SET value = value + 1 RETURNING value AS n`),
        (n) => WriteNo.make(n ?? 1),
      )

      const seq = (task: TaskId) => Effect.map(number(sql`SELECT seq AS n FROM threads WHERE task_id = ${task}`), (n) => n ?? 0)

      const item = (task: TaskId, id: string) =>
        Effect.map(itemRows(sql`SELECT ${sql.literal(ITEM)} FROM thread_items WHERE task_id = ${task} AND id = ${id}`), (rows) => {
          const row = rows[0]
          return row === undefined ? null : toEntry(row)
        })
      const request = (task: TaskId, id: string) =>
        Effect.map(requestRows(sql`SELECT write_no, data FROM thread_requests WHERE task_id = ${task} AND id = ${id}`), (rows) => {
          const row = rows[0]
          return row === undefined ? null : toStoredRequest(row)
        })

      /** Writes an item: in place if the thread has one with its id, else after its last. Its first write's number stays. */
      const putItem = Effect.fnUntraced(function* (task: TaskId, value: Item, at: Timestamp, writeNo: WriteNo | null) {
        const data = yield* toJson(value)
        yield* run(sql`INSERT INTO thread_items (task_id, id, pos, type, parent_id, write_no, data, created_at, updated_at)
          VALUES (${task}, ${value.id}, (SELECT COALESCE(MAX(pos) + 1, 0) FROM thread_items WHERE task_id = ${task}), ${value.type},
                  ${value.parent_id ?? null}, ${writeNo}, ${data}, ${value.created_at ?? at}, ${at})
          ON CONFLICT (task_id, id) DO UPDATE SET type = excluded.type, parent_id = excluded.parent_id, data = excluded.data,
            updated_at = excluded.updated_at`)
      })

      /** Writes a request: in place if the thread has one with its id, else after its last. */
      const putRequest = Effect.fnUntraced(function* (task: TaskId, value: ThreadRequest, at: Timestamp, writeNo: WriteNo | null) {
        const data = yield* toJson(value)
        const open = value.resolution === undefined ? 1 : 0
        yield* run(sql`INSERT INTO thread_requests (task_id, id, pos, type, tool_call_id, write_no, open, data, created_at, updated_at)
          VALUES (${task}, ${value.id}, (SELECT COALESCE(MAX(pos) + 1, 0) FROM thread_requests WHERE task_id = ${task}), ${value.type},
                  ${value.tool_call_id ?? null}, ${writeNo}, ${open}, ${data}, ${value.created_at ?? at}, ${at})
          ON CONFLICT (task_id, id) DO UPDATE SET type = excluded.type, tool_call_id = excluded.tool_call_id, open = excluded.open,
            data = excluded.data, updated_at = excluded.updated_at`)
      })

      const apply = Effect.fnUntraced(function* (task: TaskId, event: SavedEvent, at: Timestamp, writeNo: WriteNo | null) {
        switch (event.type) {
          case "item.added":
            yield* putItem(task, event.item, at, writeNo)
            break
          case "item.updated": {
            const found = yield* item(task, event.item_id)
            const next = found === null ? null : patched(found.item, event.patch)
            if (next !== null && next !== found?.item) yield* putItem(task, next, at, writeNo)
            break
          }
          case "request.opened":
            yield* putRequest(task, event.request, at, writeNo)
            break
          case "request.resolved": {
            const found = yield* request(task, event.request_id)
            if (found !== null) yield* putRequest(task, { ...found.request, resolution: event.resolution }, at, writeNo)
            break
          }
        }
      })

      const append = Effect.fnUntraced(function* (task: TaskId, events: ReadonlyArray<NewEvent>, options: AppendOptions) {
        const { at } = options
        const writeNo = options.writeNo ?? null
        if (events.length === 0 && (options.metas === undefined || options.metas.size === 0)) return []
        // The thread, made with its first write, and the numbers of the events taken for them, in one statement: `last`
        // is its last event's before them.
        const n = events.length
        let last =
          (yield* number(
            sql`INSERT INTO threads (task_id, seq, created_at) VALUES (${task}, ${n}, ${at})
              ON CONFLICT (task_id) DO UPDATE SET seq = seq + ${n} RETURNING seq - ${n} AS n`,
          )) ?? 0
        const saved: Array<SavedEvent> = []
        for (const e of events) {
          last += 1
          // Its thread and number are the store's, whatever it was given.
          const event: SavedEvent = { ...e, thread_id: task, seq: last }
          yield* run(
            sql`INSERT INTO thread_events (task_id, seq, type, data, created_at) VALUES (${task}, ${last}, ${event.type}, ${yield* toJson(event)}, ${at})`,
          )
          yield* apply(task, event, at, writeNo)
          saved.push(event)
        }
        for (const [id, meta] of options.metas ?? new Map()) {
          yield* run(sql`UPDATE thread_items SET meta = ${yield* toJson(meta)} WHERE task_id = ${task} AND id = ${id}`)
        }
        // The thread's events from before the log's day, without reading its log if its oldest is not.
        const from = keepFrom(at)
        const oldest = yield* createdAtRows(sql`SELECT created_at FROM thread_events WHERE task_id = ${task} ORDER BY seq LIMIT 1`)
        const first = oldest[0]
        if (first !== undefined && first.created_at < from) yield* run(sql`DELETE FROM thread_events WHERE task_id = ${task} AND created_at < ${from}`)
        return saved
      })

      const entries = (task: TaskId) =>
        Effect.map(itemRows(sql`SELECT ${sql.literal(ITEM)} FROM thread_items WHERE task_id = ${task} ORDER BY pos`), (rows) => rows.map(toEntry))
      const requests = (task: TaskId) =>
        Effect.map(requestRows(sql`SELECT write_no, data FROM thread_requests WHERE task_id = ${task} ORDER BY pos`), (rows) => rows.map((r) => r.data))
      const openRequests = (task: TaskId) =>
        Effect.map(requestRows(sql`SELECT write_no, data FROM thread_requests WHERE task_id = ${task} AND open = 1 ORDER BY pos`), (rows) =>
          rows.map((r) => r.data),
        )

      // ---- windows and pages ----

      const count = (task: TaskId) => Effect.map(number(sql`SELECT COUNT(*) AS n FROM thread_items WHERE task_id = ${task}`), (n) => n ?? 0)
      /** `n` items from index `start`. */
      const slice = (task: TaskId, start: number, n: number) =>
        Effect.map(itemRows(sql`SELECT ${sql.literal(ITEM)} FROM thread_items WHERE task_id = ${task} ORDER BY pos LIMIT ${n} OFFSET ${start}`), (rows) =>
          rows.map(toEntry),
        )
      /** The index of the item at `pos`: how many are before it. */
      const indexAt = (task: TaskId, pos: number) =>
        Effect.map(number(sql`SELECT COUNT(*) AS n FROM thread_items WHERE task_id = ${task} AND pos < ${pos}`), (n) => n ?? 0)
      /** The position of a request's anchor, its tool call; null if it has none or the thread lacks it. */
      const anchor = (task: TaskId, r: ThreadRequest) =>
        r.tool_call_id === undefined ? Effect.succeed(null) : number(sql`SELECT pos AS n FROM thread_items WHERE task_id = ${task} AND id = ${r.tool_call_id}`)

      /** The items below `from` with an id in `need`, and their parents however nested, in order. */
      const contextOf = Effect.fnUntraced(function* (task: TaskId, need: ReadonlySet<string>, from: number) {
        const out = new Set<number>()
        const seen = new Set<string>()
        for (const first of need) {
          let id: string | null = first
          while (id !== null && id !== "" && !seen.has(id)) {
            seen.add(id)
            const found: ReadonlyArray<typeof Pos.Type> = yield* posRows(sql`SELECT pos, parent_id FROM thread_items WHERE task_id = ${task} AND id = ${id}`)
            const row = found[0]
            if (row === undefined) break
            if (row.pos < from) out.add(row.pos)
            id = row.parent_id
          }
        }
        const positions = [...out].toSorted((a, b) => a - b)
        if (positions.length === 0) return []
        const rows = yield* itemRows(sql`SELECT ${sql.literal(ITEM)} FROM thread_items WHERE task_id = ${task} AND ${sql.in("pos", positions)} ORDER BY pos`)
        return rows.map(toEntry)
      })
      const indicesOf = (task: TaskId, context: ReadonlyArray<Entry>) => Effect.forEach(context, (e) => indexAt(task, e.pos), { concurrency: 1 })

      const whole = Effect.fnUntraced(function* (task: TaskId) {
        const state: ThreadState = {
          items: (yield* entries(task)).map((e) => e.item),
          requests: yield* requests(task),
          seq: yield* seq(task),
        }
        return state
      })

      const window = Effect.fnUntraced(function* (task: TaskId, limit: number | undefined) {
        const n = yield* count(task)
        if (limit === undefined || n <= limit) return yield* whole(task)
        const start = n - Math.max(0, Math.floor(limit))
        const rows = yield* slice(task, start, n - start)
        // What is before the window is what is below its first item's position.
        const from = rows[0]?.pos ?? Number.MAX_SAFE_INTEGER
        const all = yield* requests(task)
        const need = new Set<string>()
        for (const r of rows) if (r.item.parent_id !== undefined) need.add(r.item.parent_id)
        for (const r of all) {
          if (r.resolution !== undefined) continue
          if (r.parent_id !== undefined) need.add(r.parent_id)
          if (r.tool_call_id !== undefined) need.add(r.tool_call_id)
        }
        // Every subagent's call (the contracts' `snapshotWindow`): a quiet one may go on, and a client lists them all.
        const subagents = yield* idRows(sql`SELECT id FROM thread_items WHERE task_id = ${task} AND +type = 'tool_call' AND pos < ${from}
            AND json_extract(data, '$.kind') = 'subagent' ORDER BY pos`)
        for (const r of subagents) need.add(r.id)
        const context = yield* contextOf(task, need, from)
        const kept: Array<ThreadRequest> = []
        for (const r of all) {
          if (r.resolution === undefined) kept.push(r)
          else {
            const a = yield* anchor(task, r)
            if (a === null || a >= from) kept.push(r)
          }
        }
        const indices = yield* indicesOf(task, context)
        const state: ThreadState = {
          items: [...context, ...rows].map((e) => e.item),
          requests: kept,
          seq: yield* seq(task),
          ...(start > 0 ? { start } : {}),
          ...(start > 0 && indices.length > 0 ? { context: indices } : {}),
        }
        return state
      })

      const page = Effect.fnUntraced(function* (task: TaskId, before: number, limit: number) {
        const n = yield* count(task)
        const end = Math.max(0, Math.min(Math.floor(before), n))
        const start = Math.max(0, end - Math.max(0, Math.floor(limit)))
        const rows = start < end ? yield* slice(task, start, end - start) : []
        const need = new Set<string>()
        for (const r of rows) if (r.item.parent_id !== undefined) need.add(r.item.parent_id)
        const from = rows[0]?.pos ?? Number.MAX_SAFE_INTEGER
        const to = rows.at(-1)?.pos ?? -1
        const context = yield* contextOf(task, need, from)
        const anchored: Array<ThreadRequest> = []
        if (rows.length > 0) {
          for (const r of yield* requests(task)) {
            const a = yield* anchor(task, r)
            if (a !== null && a >= from && a <= to) anchored.push(r)
          }
        }
        const result: ItemPage = {
          thread_id: task,
          items: [...context, ...rows].map((e) => e.item),
          requests: anchored,
          start,
          context: yield* indicesOf(task, context),
          seq: yield* seq(task),
        }
        return result
      })

      // ---- the log ----

      const eventsAfter = Effect.fnUntraced(function* (task: TaskId, after: number) {
        const last = yield* seq(task)
        if (after >= last) return []
        const first = (yield* number(sql`SELECT MIN(seq) AS n FROM thread_events WHERE task_id = ${task}`)) ?? last + 1
        if (after < first - 1) return null
        const rows = yield* eventRows(sql`SELECT data FROM thread_events WHERE task_id = ${task} AND seq > ${after} ORDER BY seq`)
        return rows.map((r): StoredEvent => r.data)
      })

      const prune = (before: Timestamp) => Effect.map(seqRows(sql`DELETE FROM thread_events WHERE created_at < ${before} RETURNING seq`), (rows) => rows.length)

      // ---- the readers' scans ----

      const newest = (task: TaskId, scan: Scan) =>
        Effect.map(
          itemRows(
            // `+type`: the task's items by position, not the board's user messages by time (thread_items_user_time).
            sql`SELECT ${sql.literal(ITEM)} FROM thread_items WHERE task_id = ${task} AND ${sql.and([
              sql`+type IN ${sql.in(scan.types)}`,
              ...(scan.upto === undefined ? [] : [sql`pos <= ${scan.upto}`]),
              ...(scan.before === undefined ? [] : [sql`pos < ${scan.before}`]),
              ...(scan.after === undefined ? [] : [sql`created_at > ${scan.after}`]),
              ...(scan.id === undefined ? [] : [sql`(id = ${scan.id} OR json_extract(meta, '$.call_id') = ${scan.id})`]),
              ...(scan.subagentTask === undefined ? [] : [sql`json_extract(meta, '$.subagent_task') = ${scan.subagentTask}`]),
            ])} ORDER BY pos DESC LIMIT ${scan.limit}`,
          ),
          (rows) => rows.map(toEntry),
        )

      const toolCallsSince = (task: TaskId, after: Timestamp | null) =>
        Effect.map(
          itemRows(
            sql`SELECT ${sql.literal(ITEM)} FROM thread_items WHERE task_id = ${task} AND +type = 'tool_call' AND created_at > ${after ?? ""} ORDER BY pos`,
          ),
          (rows) => rows.map(toEntry),
        )

      const exists = (statement: Effect.Effect<ReadonlyArray<unknown>, SqlError.SqlError>) => Effect.map(number(statement), (n) => n === 1)
      const userMessagedSince = (task: TaskId, at: Timestamp) =>
        exists(sql`SELECT EXISTS(SELECT 1 FROM thread_items WHERE task_id = ${task} AND +type = 'user_message' AND created_at >= ${at}) AS n`)
      const userMessageAfter = (task: TaskId, n: WriteNo) =>
        exists(sql`SELECT EXISTS(SELECT 1 FROM thread_items WHERE task_id = ${task} AND +type = 'user_message' AND write_no > ${n}) AS n`)
      const firstUserMessage = (task: TaskId) =>
        Effect.map(number(sql`SELECT MIN(write_no) AS n FROM thread_items WHERE task_id = ${task} AND +type = 'user_message'`), (n) =>
          n === null ? null : WriteNo.make(n),
        )

      const userMessagesBetween = (profile: ProfileId, from: Timestamp, to: Timestamp) =>
        Effect.map(
          profileItemRows(sql`SELECT i.task_id, i.pos, i.write_no, i.created_at, i.data, i.meta FROM thread_items i JOIN tasks t ON t.id = i.task_id
              WHERE i.type = 'user_message' AND i.created_at >= ${from} AND i.created_at < ${to} AND t.profile_id = ${profile}
              ORDER BY i.created_at, i.task_id, i.pos`),
          (rows) => rows.map((r): ProfileUserMessage => ({ task_id: r.task_id, entry: toEntry(r) })),
        )

      const openQuestions = (task: TaskId) =>
        Effect.map(
          requestRows(sql`SELECT write_no, data FROM thread_requests WHERE task_id = ${task} AND +type = 'question' AND open = 1 ORDER BY pos`),
          (rows) => rows.map(toStoredRequest),
        )
      const askedIn = (task: TaskId, callId: string) =>
        exists(
          sql`SELECT EXISTS(SELECT 1 FROM thread_requests WHERE task_id = ${task} AND +type = 'question'
            AND json_extract(data, '$.metadata.call_id') = ${callId}) AS n`,
        )
      const unreadReports = (task: TaskId) =>
        Effect.map(
          itemRows(sql`SELECT ${sql.literal(ITEM)} FROM thread_items WHERE task_id = ${task} AND +type = 'notice'
              AND json_extract(data, '$.code') = 'routine_report' AND json_extract(data, '$.metadata.read') IS NOT 1 ORDER BY pos`),
          (rows) => rows.map(toEntry),
        )

      return ThreadStore.of({
        nextWriteNo,
        append,
        seq,
        item,
        request,
        entries,
        requests,
        openRequests,
        window,
        page,
        eventsAfter,
        prune,
        newest,
        toolCallsSince,
        userMessagedSince,
        userMessageAfter,
        firstUserMessage,
        userMessagesBetween,
        openQuestions,
        askedIn,
        unreadReports,
      })
    }),
  )
}
