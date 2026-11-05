// A task's thread as items (threads/protocol.ts), on the board's own database and connection, so a message and the
// items made from it can be written in one transaction (the `thread_*` tables, see SCHEMA_V89 in db/schema.ts). The
// thread's id is its task's, and its rows are deleted with the task.
//
// Items and requests are kept as they are now, updated in place as events come: a snapshot is a read of them, and no
// snapshot is stored. The events themselves are kept for a day (KEEP_MS), for clients catching up after a gap; one
// further behind than that takes a fresh snapshot. The thread's `threads` row keeps its last seq, so numbering goes on
// when the log is empty. Deltas aren't saved. `thread.updated` events are logged but not kept as state: the thread's
// own state is its task's, which the caller gives a snapshot.
//
// The useful parts of HA-128's server/src/threads/store.rs (agent-threads' `Store` on the board's database), without the
// generic interface: this is the only store. Values are kept as the JSON they were given, so fields this build doesn't
// know survive. threads/write.ts writes it, for tasks flagged `thread_items` (see docs/threads.md).
import { all, one, run, tx, value, type Conn } from "../db.ts";
import { now } from "../util.ts";
import {
  is_running_subagent, patched,
  type Item, type ItemPage, type NewEvent, type SavedEvent, type Snapshot, type Thread, type ThreadRequest,
} from "./protocol.ts";

/**
 * How long a thread's saved events are kept. By age only: a client that has been away longer takes a fresh window,
 * which is cheap, and a count kept for good would keep nearly every thread's whole log (HA-214's dry run: 761 MB of
 * events beside 755 MB of items on the live board, for a count of 1,000).
 */
export const KEEP_MS = 24 * 60 * 60 * 1000;

export interface AppendOptions {
  /** The message the events were made from: the items they add or change are recorded as coming from it. */
  message_id?: number;
  /** When it happened, as an RFC 3339 time: now by default. */
  at?: string;
  /** False: apply them without saving them in the log (a rebuild, see threads/write.ts), and return none. */
  log?: boolean;
}

/**
 * Saves `events` for task `task_id`'s thread, numbering them after its last, and applies each to its items and requests
 * in place. It prunes the thread's older events as it goes. Returns the events as saved (with `thread_id` and `seq`), to
 * send on. In a transaction (a savepoint within the caller's), so all of it is written or none.
 */
export function append(c: Conn, task_id: string, events: NewEvent[], o: AppendOptions = {}): SavedEvent[] {
  if (!events.length) return [];
  const at = o.at ?? now();
  return tx(c, () => {
    let seq = last_seq(c, task_id);
    const saved: SavedEvent[] = [];
    if (o.log === false) {
      // Applied without saving them: the thread's seq still goes up, so clients from before it take a fresh window.
      for (const e of events) {
        if ((e.type as string) === "delta") throw new Error("deltas aren't saved");
        apply(c, task_id, { ...e, thread_id: task_id, seq } as SavedEvent, at, o.message_id);
      }
      return saved;
    }
    for (const e of events) {
      if ((e.type as string) === "delta") throw new Error("deltas aren't saved");
      // type, thread_id and seq first, as in the examples, whatever the event was given.
      const numbered = { thread_id: task_id, seq: ++seq };
      const event = Object.assign({ type: e.type, ...numbered }, e, numbered) as SavedEvent;
      run(c, "INSERT INTO thread_events (task_id, seq, type, data, created_at) VALUES (?1, ?2, ?3, ?4, ?5)", task_id, seq, event.type, JSON.stringify(event), at);
      apply(c, task_id, event, at, o.message_id);
      saved.push(event);
    }
    set_seq(c, task_id, seq, at);
    prune_thread(c, task_id, at);
    return saved;
  });
}

function apply(c: Conn, task_id: string, e: SavedEvent, at: string, message_id: number | undefined): void {
  switch (e.type) {
    case "item.added":
      put_item(c, task_id, e.item, at);
      add_origin(c, task_id, e.item.id, message_id);
      break;
    case "item.updated": {
      const item = get_item(c, task_id, e.item_id);
      if (!item) break;
      const next = patched(item, e.patch);
      if (next !== item) put_item(c, task_id, next, at);
      add_origin(c, task_id, item.id, message_id);
      break;
    }
    case "items.removed":
      for (const id of e.item_ids) {
        run(c, "DELETE FROM thread_items WHERE task_id=?1 AND id=?2", task_id, id);
        run(c, "DELETE FROM thread_item_origins WHERE task_id=?1 AND item_id=?2", task_id, id);
      }
      break;
    case "request.opened":
      put_request(c, task_id, e.request, at);
      break;
    case "request.resolved": {
      const request = get_request(c, task_id, e.request_id);
      if (request) put_request(c, task_id, { ...request, resolution: e.resolution }, at);
      break;
    }
    default:
      // thread.updated (the thread's state is its task's), turn.started and turn.completed only go in the log.
      break;
  }
}

/** Writes an item: in place if the thread has one with its id, or else after its last. */
function put_item(c: Conn, task_id: string, item: Item, at: string): void {
  const fields = [item.type, item.parent_id, item.turn_id, is_running_subagent(item), JSON.stringify(item), at];
  const sql = "UPDATE thread_items SET type=?3, parent_id=?4, turn_id=?5, live=?6, data=?7, updated_at=?8 WHERE task_id=?1 AND id=?2";
  if (run(c, sql, task_id, item.id, ...fields).changes) return;
  run(
    c,
    `INSERT INTO thread_items (task_id, id, pos, type, parent_id, turn_id, live, data, updated_at, created_at)
     VALUES (?1, ?2, (SELECT COALESCE(MAX(pos) + 1, 0) FROM thread_items WHERE task_id=?1), ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
    task_id, item.id, ...fields, item.created_at ?? at,
  );
}

/** Writes a request: in place if the thread has one with its id, or else after its last. */
function put_request(c: Conn, task_id: string, r: ThreadRequest, at: string): void {
  const fields = [r.type, r.tool_call_id, r.turn_id, !r.resolution, JSON.stringify(r), at];
  const sql = "UPDATE thread_requests SET type=?3, tool_call_id=?4, turn_id=?5, open=?6, data=?7, updated_at=?8 WHERE task_id=?1 AND id=?2";
  if (run(c, sql, task_id, r.id, ...fields).changes) return;
  run(
    c,
    `INSERT INTO thread_requests (task_id, id, pos, type, tool_call_id, turn_id, open, data, updated_at, created_at)
     VALUES (?1, ?2, (SELECT COALESCE(MAX(pos) + 1, 0) FROM thread_requests WHERE task_id=?1), ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
    task_id, r.id, ...fields, r.created_at ?? at,
  );
}

function add_origin(c: Conn, task_id: string, item_id: string, message_id: number | undefined): void {
  if (message_id === undefined) return;
  run(c, "INSERT OR IGNORE INTO thread_item_origins (task_id, item_id, message_id) VALUES (?1, ?2, ?3)", task_id, item_id, message_id);
}

// ---------- the log ----------

/**
 * The seq of the thread's last saved event; 0 for none. Its `threads` row keeps it when its events have been pruned
 * (or a rebuild saved none), so it never goes back.
 */
export function last_seq(c: Conn, task_id: string): number {
  const kept = value<number>(c, "SELECT seq FROM threads WHERE task_id=?1", task_id) ?? 0;
  const logged = value<number>(c, "SELECT MAX(seq) FROM thread_events WHERE task_id=?1", task_id) ?? 0;
  return Math.max(kept, logged);
}

/** Records `seq` as the thread's last (making its `threads` row if it has none). */
export function set_seq(c: Conn, task_id: string, seq: number, at = now()): void {
  run(c, "INSERT INTO threads (task_id, seq, created_at) VALUES (?1, ?2, ?3) ON CONFLICT (task_id) DO UPDATE SET seq=MAX(seq, excluded.seq)", task_id, seq, at);
}

/**
 * Whether the task has a thread kept as items: it has a `threads` row (threads/write.ts makes it with the task's first
 * message, or `append` with the first events), and live writes haven't stopped on an error since its last rebuild.
 */
export function has_thread(c: Conn, task_id: string): boolean {
  return !!one(c, "SELECT 1 FROM threads WHERE task_id=?1 AND error IS NULL", task_id);
}

/**
 * The thread's saved events after `after`, oldest first (at most `limit` of them); null if the log no longer goes back
 * that far, so the client takes a fresh snapshot instead.
 */
export function events_after(c: Conn, task_id: string, after: number, limit?: number): SavedEvent[] | null {
  const last = last_seq(c, task_id);
  if (after >= last) return [];
  const first = value<number>(c, "SELECT MIN(seq) FROM thread_events WHERE task_id=?1", task_id) ?? last + 1;
  if (after < first - 1) return null;
  const rows = all<{ data: string }>(c, "SELECT data FROM thread_events WHERE task_id=?1 AND seq>?2 ORDER BY seq LIMIT ?3", task_id, after, limit ?? -1);
  return rows.map((r) => JSON.parse(r.data));
}

/** Removes the thread's events older than `keep_ms` before `at`: none, without reading its log, if its oldest isn't. */
function prune_thread(c: Conn, task_id: string, at: string, keep_ms = KEEP_MS): void {
  const before = new Date(Date.parse(at) - keep_ms).toISOString();
  const oldest = value<string>(c, "SELECT created_at FROM thread_events WHERE task_id=?1 ORDER BY seq LIMIT 1", task_id);
  if (oldest === undefined || oldest >= before) return;
  run(c, "DELETE FROM thread_events WHERE task_id=?1 AND created_at<?2", task_id, before);
}

/** Removes every thread's events older than `keep_ms` before `at`. Returns how many went. */
export function prune(c: Conn, at = now(), keep_ms = KEEP_MS): number {
  const before = new Date(Date.parse(at) - keep_ms).toISOString();
  return run(c, "DELETE FROM thread_events WHERE created_at<?1", before).changes;
}

/**
 * Empties the thread, for a rebuild: its items, requests, origins and saved events go, and its seq goes up by one, so
 * a client from before it, even one that had every event, finds a gap and takes a fresh window. Its `threads` row stays.
 */
export function clear(c: Conn, task_id: string, at = now()): void {
  tx(c, () => {
    const seq = last_seq(c, task_id);
    for (const t of ["thread_items", "thread_requests", "thread_item_origins", "thread_events"]) run(c, `DELETE FROM ${t} WHERE task_id=?1`, task_id);
    set_seq(c, task_id, seq + 1, at);
  });
}

// ---------- items, requests and snapshots ----------

const parse = <T>(rows: { data: string }[]): T[] => rows.map((r) => JSON.parse(r.data) as T);

export function get_item(c: Conn, task_id: string, id: string): Item | null {
  const r = one<{ data: string }>(c, "SELECT data FROM thread_items WHERE task_id=?1 AND id=?2", task_id, id);
  return r ? JSON.parse(r.data) : null;
}

export function get_request(c: Conn, task_id: string, id: string): ThreadRequest | null {
  const r = one<{ data: string }>(c, "SELECT data FROM thread_requests WHERE task_id=?1 AND id=?2", task_id, id);
  return r ? JSON.parse(r.data) : null;
}

/** The thread's items, in order. */
export function items(c: Conn, task_id: string): Item[] {
  return parse(all(c, "SELECT data FROM thread_items WHERE task_id=?1 ORDER BY pos", task_id));
}

/** The thread's requests, oldest first: the open ones, and the resolved ones with their resolution. */
export function requests(c: Conn, task_id: string): ThreadRequest[] {
  return parse(all(c, "SELECT data FROM thread_requests WHERE task_id=?1 ORDER BY pos", task_id));
}

/** The thread's open requests, oldest first. */
export function open_requests(c: Conn, task_id: string): ThreadRequest[] {
  return parse(all(c, "SELECT data FROM thread_requests WHERE task_id=?1 AND open=1 ORDER BY pos", task_id));
}

/** The whole state of `thread` (whose id is its task's), as of its last saved event. */
export function snapshot(c: Conn, thread: Thread): Snapshot {
  return { thread, items: items(c, thread.id), requests: requests(c, thread.id), seq: last_seq(c, thread.id) };
}

const count = (c: Conn, task_id: string) => value<number>(c, "SELECT COUNT(*) FROM thread_items WHERE task_id=?1", task_id)!;

interface Row {
  id: string;
  pos: number;
  parent_id: string | null;
  data: string;
}

/** `count` items of the thread from index `start`. */
const slice = (c: Conn, task_id: string, start: number, count: number) =>
  all<Row>(c, "SELECT id, pos, parent_id, data FROM thread_items WHERE task_id=?1 ORDER BY pos LIMIT ?2 OFFSET ?3", task_id, count, start);

/**
 * The window of `thread`'s state with its last `limit` items, and what they need from before them, read from the tables:
 * the same as protocol.ts's snapshot_window of the whole snapshot, without reading all of it.
 */
export function window(c: Conn, thread: Thread, limit?: number): Snapshot {
  const task_id = thread.id;
  const n = count(c, task_id);
  if (limit === undefined || n <= limit) return snapshot(c, thread);
  const start = n - Math.max(0, Math.floor(limit));
  const rows = slice(c, task_id, start, n - start);
  // Positions have gaps where items were removed: what's before the window is what's below its first item's.
  const from = rows[0]?.pos ?? Infinity;
  const reqs = requests(c, task_id);
  const need = new Set<string>();
  for (const r of rows) if (r.parent_id) need.add(r.parent_id);
  for (const r of reqs) {
    if (r.resolution) continue;
    if (r.parent_id) need.add(r.parent_id);
    if (r.tool_call_id) need.add(r.tool_call_id);
  }
  // A subagent that's quiet now may go on: its items would come with no call to hang them from.
  for (const r of all<{ id: string }>(c, "SELECT id FROM thread_items WHERE task_id=?1 AND live=1 AND pos<?2", task_id, from)) need.add(r.id);
  const context = context_of(c, task_id, need, from);
  const w: Snapshot = {
    thread,
    items: [...context.map((r) => JSON.parse(r.data) as Item), ...parse<Item>(rows)],
    requests: reqs.filter((r) => {
      if (!r.resolution) return true;
      const a = anchor(c, task_id, r);
      return a === null || a >= from;
    }),
    seq: last_seq(c, task_id),
  };
  if (start) w.start = start;
  if (context.length) w.context = context.map((r) => index_at(c, task_id, r.pos));
  return w;
}

/**
 * The page of the thread's items before index `before` (a window's start), at most `limit` of them, with the subagent
 * calls they belong to and the requests anchored in them: the same as protocol.ts's item_page of the whole snapshot.
 */
export function page(c: Conn, task_id: string, before: number, limit: number): ItemPage {
  const n = count(c, task_id);
  const end = Math.max(0, Math.min(Math.floor(before), n));
  const start = Math.max(0, end - Math.max(0, Math.floor(limit)));
  const rows = start < end ? slice(c, task_id, start, end - start) : [];
  const need = new Set<string>();
  for (const r of rows) if (r.parent_id) need.add(r.parent_id);
  const from = rows[0]?.pos ?? Infinity;
  const to = rows.at(-1)?.pos ?? -Infinity;
  const context = context_of(c, task_id, need, from);
  return {
    thread_id: task_id,
    items: [...context.map((r) => JSON.parse(r.data) as Item), ...parse<Item>(rows)],
    requests: rows.length
      ? requests(c, task_id).filter((r) => {
          const a = anchor(c, task_id, r);
          return a !== null && a >= from && a <= to;
        })
      : [],
    start,
    context: context.map((r) => index_at(c, task_id, r.pos)),
    seq: last_seq(c, task_id),
  };
}

/** The index in the thread's items of the item at `pos`: the number before it. */
const index_at = (c: Conn, task_id: string, pos: number) => value<number>(c, "SELECT COUNT(*) FROM thread_items WHERE task_id=?1 AND pos<?2", task_id, pos)!;

/** The items below `from` with an id in `need`, and their parents, however nested, ordered by position. */
function context_of(c: Conn, task_id: string, need: Set<string>, from: number): Row[] {
  const out = new Map<number, string>();
  const seen = new Set<string>();
  for (const first of need) {
    for (let id: string | null = first; id && !seen.has(id); ) {
      seen.add(id);
      const r = one<{ pos: number; parent_id: string | null }>(c, "SELECT pos, parent_id FROM thread_items WHERE task_id=?1 AND id=?2", task_id, id);
      if (!r) break;
      if (r.pos < from) out.set(r.pos, id);
      id = r.parent_id;
    }
  }
  return [...out.keys()]
    .sort((a, b) => a - b)
    .map((pos) => one<Row>(c, "SELECT id, pos, parent_id, data FROM thread_items WHERE task_id=?1 AND pos=?2", task_id, pos)!);
}

/** The position of a request's anchor: its tool call, or else the last item of its turn; null if it has neither (protocol.ts's request_anchor). */
function anchor(c: Conn, task_id: string, r: ThreadRequest): number | null {
  if (r.tool_call_id) {
    const pos = value<number>(c, "SELECT pos FROM thread_items WHERE task_id=?1 AND id=?2", task_id, r.tool_call_id);
    if (pos !== undefined) return pos;
  }
  if (r.turn_id) return value<number | null>(c, "SELECT MAX(pos) FROM thread_items WHERE task_id=?1 AND turn_id=?2", task_id, r.turn_id) ?? null;
  return null;
}

// ---------- what the board knows about items ----------

/** The messages item `item_id` came from, oldest first. */
export function item_origins(c: Conn, task_id: string, item_id: string): number[] {
  return all<{ message_id: number }>(c, "SELECT message_id FROM thread_item_origins WHERE task_id=?1 AND item_id=?2 ORDER BY message_id", task_id, item_id).map(
    (r) => r.message_id,
  );
}

/** The ids of the items message `message_id` made or changed, in the thread's order. */
export function items_from(c: Conn, task_id: string, message_id: number): string[] {
  return all<{ id: string }>(
    c,
    `SELECT i.id FROM thread_item_origins o JOIN thread_items i ON i.task_id=o.task_id AND i.id=o.item_id
     WHERE o.task_id=?1 AND o.message_id=?2 ORDER BY i.pos`,
    task_id, message_id,
  ).map((r) => r.id);
}

/**
 * What the board knows about an item that the item doesn't say (HA-128's `Origin`: that the board sent a user_message
 * itself, or other agents did, say), as JSON; null for nothing. Kept until the item is removed.
 */
export function set_item_meta(c: Conn, task_id: string, item_id: string, meta: object | null): void {
  run(c, "UPDATE thread_items SET meta=?3 WHERE task_id=?1 AND id=?2", task_id, item_id, meta === null ? null : JSON.stringify(meta));
}

export function item_meta(c: Conn, task_id: string, item_id: string): any {
  const r = one<{ meta: string | null }>(c, "SELECT meta FROM thread_items WHERE task_id=?1 AND id=?2", task_id, item_id);
  return r?.meta ? JSON.parse(r.meta) : null;
}

/** Every item's meta that has one, by item id. */
export function metas(c: Conn, task_id: string): Map<string, any> {
  const rows = all<{ id: string; meta: string }>(c, "SELECT id, meta FROM thread_items WHERE task_id=?1 AND meta IS NOT NULL", task_id);
  return new Map(rows.map((r) => [r.id, JSON.parse(r.meta)]));
}
