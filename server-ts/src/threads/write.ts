// Writing a task's thread as items live, as its messages are written (step 3 of docs/threads.md, plan decision D3).
//
// Every message write goes through db/messages.ts's insert_message and update_message_data (or update_pending_message),
// which call `written` in the caller's transaction: for a task flagged `thread_items`, the message goes through the
// translator (threads/translate.ts) and its events into the store (threads/store.ts) in that same transaction, so the
// message and its items are written together or not at all. The events are kept with the message object
// (`events_of`), for whoever emits the message once it's committed (AppState.emit_message) to send them on too.
//
// The switch (plan decision D4) is the host setting `thread_items` (Settings, "Keep threads as items"), off by default:
// a task whose first message is written while it's on is flagged (`tasks.thread_items`), and keeps its items written
// from then on, so a flagged task's items have no gaps. Turning it off flags no more tasks; flagged ones carry on.
//
// Messages stay the source: `rebuild` derives a thread's items from its messages again (after a translator fix, say),
// and `compare` says how the items differ from a rebuild. Each server keeps a Translator per thread in memory (its open
// calls, subagents and requests), checked against the thread's `writes` count before each use: a write rolled back, a
// rebuild by `huntaway threads-rebuild` or another process, or one this server doesn't have yet, gets one rebuilt
// from the store instead. If translating or storing a message fails, the message is still written: the thread records
// the error and gets no more live writes until it's rebuilt (store.has_thread is false for it meanwhile).
import { all, get_setting, one, run, tx, value, type Conn } from "../db.ts";
import type { Message } from "../db/messages.ts";
import { err_str, now, reached } from "../util.ts";
import type { Item, SavedEvent, ThreadEvent, ThreadRequest } from "./protocol.ts";
import * as store from "./store.ts";
import { CONVERTER_VERSION, Translator, type ItemMeta, type Warning } from "./translate.ts";

/** The host setting: "true" flags new tasks to keep their threads as items. */
export const SETTING = "thread_items";

export function setting_on(c: Conn): boolean {
  return get_setting(c, SETTING) === "true";
}

/** How many threads' translators a server keeps in memory; the least recently written go first. */
const CACHED = 64;

interface Live {
  t: Translator;
  /** The thread's `writes` this translator is in step with. */
  writes: number;
}

const live = new WeakMap<Conn, Map<string, Live>>();
const written_events = new WeakMap<object, SavedEvent[]>();

/** The thread events written with message `m` (as insert_message or update_message_data returned it), to send once committed. */
export function events_of(m: object): SavedEvent[] {
  return written_events.get(m) ?? [];
}

/** Whether the task has a message before `m`. */
const has_earlier = (c: Conn, m: Message) => !!one(c, "SELECT 1 FROM messages WHERE task_id=?1 AND id<?2 LIMIT 1", m.task_id, m.id);

/**
 * Message `m` was just inserted (`inserted`) or its data changed, in the caller's transaction, for a task whose
 * `thread_items` is `flagged`. For a flagged task (or one this message flags: its first, with the setting on), it
 * translates it and writes its items, requests and events.
 */
export function written(c: Conn, m: Message, flagged: boolean, inserted: boolean): void {
  if (!flagged) {
    if (!inserted || !setting_on(c) || has_earlier(c, m)) return;
    run(c, "UPDATE tasks SET thread_items=1 WHERE id=?1", m.task_id);
  }
  // Between the message's row and its items: a throw here (a crash, for the tests) leaves neither.
  reached("threads:write");
  const row = one<{ writes: number; error: string | null }>(c, "SELECT writes, error FROM threads WHERE task_id=?1", m.task_id);
  if (row?.error) return;
  try {
    tx(c, () => {
      if (!row) {
        // A flagged task's thread starts with its first message. One flagged later some other way (by hand) gets its
        // whole history.
        if (!inserted || has_earlier(c, m)) return void rebuild_rows(c, m.task_id);
        run(c, "INSERT INTO threads (task_id, converter, created_at) VALUES (?1, ?2, ?3)", m.task_id, CONVERTER_VERSION, now());
      }
      const writes = row?.writes ?? 0;
      const l = translator(c, m.task_id, writes);
      const step = l.t.message({ id: m.id, kind: m.kind, data: m.data, created_at: m.created_at });
      // A translator or store bug, for the tests.
      reached("threads:translated");
      const saved = store.append(c, m.task_id, step.events, { message_id: m.id });
      for (const [id, meta] of step.meta) store.set_item_meta(c, m.task_id, id, meta);
      run(c, "UPDATE threads SET writes=?2 WHERE task_id=?1", m.task_id, writes + 1);
      l.writes = writes + 1;
      if (saved.length) written_events.set(m, saved);
    });
  } catch (e) {
    forget(c, m.task_id);
    const why = `message ${m.id}: ${err_str(e)}`;
    console.error(`${now()} ERROR huntaway: task ${m.task_id}'s thread stops being written as items (until huntaway threads-rebuild): ${why}`);
    run(c, "INSERT INTO threads (task_id, error, created_at) VALUES (?1, ?2, ?3) ON CONFLICT (task_id) DO UPDATE SET error=excluded.error", m.task_id, why, now());
  }
  // The agent's message is saved: what streamed into it is in its items now.
  if (inserted && m.kind === "claude" && m.data?.type === "assistant" && m.data?.parent_tool_use_id == null) streams.get(c)?.delete(m.task_id);
}

/** The task's translator, in step with its stored thread at `writes`: the one in memory, or one rebuilt from the store. */
function translator(c: Conn, task_id: string, writes: number): Live {
  let mine = live.get(c);
  if (!mine) live.set(c, (mine = new Map()));
  let l = mine.get(task_id);
  mine.delete(task_id);
  if (!l || l.writes !== writes) {
    const metas = store.metas(c, task_id);
    l = { t: Translator.from(store.items(c, task_id), store.requests(c, task_id), (id) => metas.get(id)), writes };
  }
  mine.set(task_id, l);
  if (mine.size > CACHED) mine.delete(mine.keys().next().value!);
  return l;
}

function forget(c: Conn, task_id: string): void {
  live.get(c)?.delete(task_id);
}

// ---------- rebuilds ----------

export interface Rebuilt {
  task_id: string;
  messages: number;
  items: number;
  requests: number;
  warnings: Warning[];
}

/**
 * Derives task `task_id`'s thread from its messages again, in one transaction, and flags the task: its items, requests
 * and origins are written afresh, and its seq goes up by one with none of its events logged, so clients from before it
 * take a fresh window (a server sends `thread_resync` for a rebuild of its own, see api). A thread whose live writes
 * stopped on an error starts again.
 */
export function rebuild(c: Conn, task_id: string): Rebuilt {
  return tx(c, () => rebuild_rows(c, task_id));
}

function rebuild_rows(c: Conn, task_id: string, keep = true): Rebuilt {
  if (!one(c, "SELECT 1 FROM tasks WHERE id=?1", task_id)) throw new Error(`no task ${task_id}`);
  store.clear(c, task_id);
  const t = new Translator();
  const warnings: Warning[] = [];
  let messages = 0;
  for (const r of all(c, "SELECT id, kind, data, created_at FROM messages WHERE task_id=?1 ORDER BY id", task_id)) {
    let data: any = null;
    try {
      data = JSON.parse(r.data);
    } catch {}
    const step = t.message({ id: r.id, kind: r.kind, data, created_at: r.created_at });
    store.append(c, task_id, step.events, { message_id: r.id, log: false });
    for (const [id, meta] of step.meta) store.set_item_meta(c, task_id, id, meta);
    warnings.push(...step.warnings);
    messages++;
  }
  run(c, "UPDATE tasks SET thread_items=1 WHERE id=?1", task_id);
  run(c, "UPDATE threads SET converter=?2, error=NULL, rebuilt_at=?3, writes=writes+1 WHERE task_id=?1", task_id, CONVERTER_VERSION, now());
  if (keep) {
    // This translator has what a rebuilt one wouldn't: results and prompts still waiting for their calls.
    forget(c, task_id);
    const writes = value<number>(c, "SELECT writes FROM threads WHERE task_id=?1", task_id)!;
    let mine = live.get(c);
    if (!mine) live.set(c, (mine = new Map()));
    mine.set(task_id, { t, writes });
  }
  const count = (table: string) => value<number>(c, `SELECT COUNT(*) FROM ${table} WHERE task_id=?1`, task_id)!;
  return { task_id, messages, items: count("thread_items"), requests: count("thread_requests"), warnings };
}

/** What a thread is, to compare: its items in order and their metas, its requests in order, and their origins. */
interface Rows {
  items: Array<{ item: Item; meta: ItemMeta | null; live: number }>;
  requests: Array<{ request: ThreadRequest; open: number }>;
  origins: string[];
}

function rows_of(c: Conn, task_id: string): Rows {
  return {
    items: all(c, "SELECT data, meta, live FROM thread_items WHERE task_id=?1 ORDER BY pos", task_id).map((r) => ({
      item: JSON.parse(r.data),
      meta: r.meta ? JSON.parse(r.meta) : null,
      live: r.live,
    })),
    requests: all(c, "SELECT data, open FROM thread_requests WHERE task_id=?1 ORDER BY pos", task_id).map((r) => ({ request: JSON.parse(r.data), open: r.open })),
    origins: all(c, "SELECT item_id, message_id FROM thread_item_origins WHERE task_id=?1 ORDER BY item_id, message_id", task_id).map(
      (r) => `${r.item_id}<-${r.message_id}`,
    ),
  };
}

const ROLL_BACK = Symbol("roll back");

/**
 * How task `task_id`'s thread differs from a rebuild of it from its messages (a list of differences, empty if none).
 * The rebuild is rolled back, so nothing changes.
 */
export function compare(c: Conn, task_id: string): string[] {
  const now_rows = rows_of(c, task_id);
  let rebuilt: Rows | undefined;
  try {
    tx(c, () => {
      rebuild_rows(c, task_id, false);
      rebuilt = rows_of(c, task_id);
      throw ROLL_BACK;
    });
  } catch (e) {
    if (e !== ROLL_BACK) throw e;
  }
  return differences(now_rows, rebuilt!);
}

function differences(a: Rows, b: Rows): string[] {
  const out: string[] = [];
  const json = (v: unknown) => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort()) : x));
  const list = <T>(what: string, xs: T[], ys: T[], id: (x: T) => string) => {
    if (xs.length !== ys.length) out.push(`${what}: ${xs.length} written, ${ys.length} rebuilt`);
    for (let i = 0; i < Math.max(xs.length, ys.length); i++) {
      const [x, y] = [xs[i], ys[i]];
      if (x === undefined || y === undefined || json(x) !== json(y)) {
        out.push(`${what} ${i} (${x === undefined ? "-" : id(x)}): written ${x === undefined ? "nothing" : json(x)}, rebuilt ${y === undefined ? "nothing" : json(y)}`);
      }
    }
  };
  list("item", a.items, b.items, (x) => x.item.id);
  list("request", a.requests, b.requests, (x) => x.request.id);
  const [ao, bo] = [new Set(a.origins), new Set(b.origins)];
  const only_a = a.origins.filter((o) => !bo.has(o));
  const only_b = b.origins.filter((o) => !ao.has(o));
  if (only_a.length || only_b.length) out.push(`origins: only written ${only_a.join(", ") || "none"}; only rebuilt ${only_b.join(", ") || "none"}`);
  return out;
}

// ---------- streamed text ----------

/** What a task's agent is streaming into its next message, before the message is saved. */
interface Streaming {
  /** The preview's id: `stream:<server>:<n>`, an item the thread doesn't have. */
  item_id: string;
  offset: number;
}

const streams = new WeakMap<Conn, Map<string, Streaming>>();
let stream_count = 0;
/** Previews' ids are this server's own, so a client doesn't take one from before a restart for a new one. */
const STREAM_PREFIX = `stream:${Date.now().toString(36)}`;

/** What emitting needs: AppState's. */
interface Emitter {
  db(): Conn;
  emit(ev: any): void;
}

/**
 * The agent of task `task_id` streamed `text` into the message it's writing, which isn't saved yet: for a thread kept
 * as items, a `delta` thread event for the preview item `stream:<server>:<n>`, which the thread doesn't have (see
 * protocol.ts's DeltaEvent). The board's own `delta` event is sent as before, by the caller.
 */
export function stream_text(s: Emitter, task_id: string, text: string): ThreadEvent | null {
  if (!text) return null;
  const c = s.db();
  let mine = streams.get(c);
  if (!mine) streams.set(c, (mine = new Map()));
  let st = mine.get(task_id);
  if (!st) {
    if (!store.has_thread(c, task_id)) return null;
    mine.set(task_id, (st = { item_id: `${STREAM_PREFIX}:${++stream_count}`, offset: 0 }));
  }
  const event: ThreadEvent = { type: "delta", thread_id: task_id, seq: store.last_seq(c, task_id), item_id: st.item_id, kind: "text", offset: st.offset, text };
  st.offset += text.length;
  s.emit({ type: "thread_event", task_id, event });
  return event;
}

/** The streamed message ended, or another starts (the board's `delta_reset`): the next text streams into a new preview. */
export function stream_reset(s: Emitter, task_id: string): void {
  streams.get(s.db())?.delete(task_id);
}
