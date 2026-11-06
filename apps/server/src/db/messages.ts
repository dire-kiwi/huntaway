// Port of server/src/db/messages.rs: a thread's messages, and the message queued for its next run.
import { all, one, run, tx, value, type Conn } from "../db.ts";
import { byte_len, now } from "../util.ts";
import { get_task, type Task } from "./tasks.ts";
import * as threads from "../threads/write.ts";
import * as source from "../threads/source.ts";

export interface Message {
  id: number;
  task_id: string;
  kind: string;
  data: any;
  created_at: string;
}

export function Message_from_row(r: any): Message {
  let data: any = null;
  try {
    data = JSON.parse(r.data);
  } catch {}
  return { id: r.id, task_id: r.task_id, kind: r.kind, data, created_at: r.created_at };
}

// ---------- queued messages ----------

/** A message to send, or queued for an agent: the user's, other agents' (MCP `send_to_task`), or both together. */
export interface Queued {
  text: string;
  /** Other agents sent all of it, so analytics don't take it for the user's. */
  from_agent: boolean;
  /** The parts the user sent, if any. */
  user_text: string | null;
  /**
   * An automation sent it, with nobody there to answer the run it starts (a routine's, see automations/routines.ts). Kept
   * while it's queued (`tasks.queued_routine`), as long as all that's queued is an automation's.
   */
  routine: boolean;
  /**
   * The automation runs (thread-mode routines, see automations/routines.ts, and project automations) whose messages are
   * in it: the run that takes it in is theirs, for its cost.
   */
  routine_runs: string[];
}

export function Queued_new(text: string, from_agent: boolean): Queued {
  return { text, from_agent, user_text: from_agent ? null : text, routine: false, routine_runs: [] };
}

/** Nothing: what's queued goes as it is (see runner::send_queued). */
export function Queued_empty(): Queued {
  return { text: "", from_agent: true, user_text: null, routine: false, routine_runs: [] };
}

/**
 * This message, then `next` after it. Rust's `Queued::then`, renamed: a module exporting `then` would make its
 * namespace object a thenable.
 */
export function queued_then(q: Queued, next: Queued): Queued {
  const join = (a: string, b: string) => (a.trim() === "" ? b : b.trim() === "" ? a : `${a}\n\n${b}`);
  const user_text = q.user_text != null && next.user_text != null ? join(q.user_text, next.user_text) : (q.user_text ?? next.user_text);
  // An empty part (nothing sent with what's queued) says nothing about who's there.
  const [a_empty, b_empty] = [q.text.trim() === "", next.text.trim() === ""];
  const routine = !a_empty && b_empty ? q.routine : a_empty && !b_empty ? next.routine : q.routine && next.routine;
  const routine_runs = [...(q.routine_runs ?? []), ...(next.routine_runs ?? [])];
  return { text: join(q.text, next.text), from_agent: q.from_agent && next.from_agent, user_text, routine, routine_runs };
}

/**
 * Add a message to the one queued on a thread. One with no text (an automation's start of a task it made, held back, see
 * runner::send_from_automation) leaves only its automation runs, for the next run of the thread (see `take_parked_runs`).
 */
export function queue(c: Conn, task_id: string, message: Queued): Task | null {
  const t = get_task(c, task_id);
  if (!t) return null;
  const message_runs = message.routine_runs ?? [];
  if (message.text.trim() === "") {
    if (message_runs.length) {
      const runs = [...queued_routine_runs(c, task_id), ...message_runs];
      run(c, "UPDATE tasks SET queued_routine_runs=?2 WHERE id=?1", task_id, JSON.stringify(runs));
    }
    return get_task(c, task_id);
  }
  const text = t.queued_message;
  let queued: Queued;
  if (text != null && text.trim() !== "") {
    const [from_agent, routine] = queued_from(c, task_id);
    queued = queued_then({ text, from_agent, user_text: t.queued_user_text, routine, routine_runs: queued_routine_runs(c, task_id) }, message);
  } else {
    // Runs left with no text go with it.
    queued = { ...message, routine: !!message.routine, routine_runs: [...queued_routine_runs(c, task_id), ...message_runs] };
  }
  run(
    c,
    "UPDATE tasks SET queued_message=?2, queued_from_agent=?3, queued_user_text=?4, queued_routine=?5, queued_routine_runs=?6, updated_at=?7 WHERE id=?1",
    task_id,
    queued.text,
    queued.from_agent,
    queued.user_text,
    queued.routine,
    JSON.stringify(queued.routine_runs),
    now(),
  );
  return get_task(c, task_id);
}

/** Whether what's queued on a task is all other agents' (`from_agent`), and all automations' (`routine`). */
function queued_from(c: Conn, task_id: string): [boolean, boolean] {
  const r = one(c, "SELECT queued_from_agent, queued_routine FROM tasks WHERE id=?1", task_id);
  if (!r) throw new Error("Query returned no rows");
  return [!!r.queued_from_agent, !!r.queued_routine];
}

function queued_routine_runs(c: Conn, task_id: string): string[] {
  const v = value<string | null>(c, "SELECT queued_routine_runs FROM tasks WHERE id=?1", task_id);
  if (v === undefined) throw new Error("Query returned no rows");
  try {
    const l = v == null ? [] : JSON.parse(v);
    return Array.isArray(l) ? l.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/**
 * The automation runs left on a thread with no text (see `queue`), taken by the run that starts. None while a message
 * is queued: the runs are its, for the run that takes it in (an automatic prompt, such as a review's fixes, starts
 * without it).
 */
export function take_parked_runs(c: Conn, task_id: string): string[] {
  const t = get_task(c, task_id);
  if (!t) return [];
  if (t.queued_message != null && t.queued_message.trim() !== "") return [];
  const runs = queued_routine_runs(c, task_id);
  if (runs.length) run(c, "UPDATE tasks SET queued_routine_runs=NULL WHERE id=?1", task_id);
  return runs;
}

/** Take the message queued on a thread. With none, automation runs left with no text stay (see `take_parked_runs`). */
export function take_queued(c: Conn, task_id: string): Queued | null {
  const t = get_task(c, task_id);
  let queued: Queued | null = null;
  if (t && t.queued_message != null && t.queued_message.trim() !== "") {
    const [from_agent, routine] = queued_from(c, task_id);
    queued = { text: t.queued_message, from_agent, user_text: t.queued_user_text, routine, routine_runs: queued_routine_runs(c, task_id) };
  }
  if (queued) clear_queued(c, task_id);
  return queued;
}

export function clear_queued(c: Conn, task_id: string): Task | null {
  run(
    c,
    "UPDATE tasks SET queued_message=NULL, queued_from_agent=0, queued_user_text=NULL, queued_routine=0, queued_routine_runs=NULL, updated_at=?2 WHERE id=?1",
    task_id,
    now(),
  );
  return get_task(c, task_id);
}

// ---------- messages ----------

// Every write of a message goes through these three (plan decision D3 of docs/threads.md), so that a task whose thread
// is kept as items (`tasks.thread_items`) gets them written in the same transaction (threads/write.ts), and a task
// whose items are its thread's source (`tasks.thread_source`, threads/source.ts) gets only them, with no messages row.
// What they return carries the thread's events, for AppState.emit_message (or emit_message_updated) to send once
// committed.

export function insert_message(c: Conn, task_id: string, kind: string, data: any): Message {
  return tx(c, () => {
    const ts = now();
    const json = JSON.stringify(data ?? null);
    const t = one<{ thread_items: number; thread_source: string }>(
      c,
      "UPDATE tasks SET last_activity_at=?1 WHERE id=?2 RETURNING thread_items, thread_source",
      ts,
      task_id,
    );
    // A quiet task still on messages moves onto items first (a new one with its first message).
    const how = t ? (t.thread_source === "items" ? "items" : source.flip(c, task_id)) : null;
    if (how !== null) {
      const m: Message = { id: source.next_id(c), task_id, kind, data: JSON.parse(json), created_at: ts };
      source.note_moved(m, how);
      source.journal(c, m);
      if (threads.wrote_items(c, m, true)) return m;
      // Its items couldn't be written (logged): it's kept as a row with the id it was given, so it isn't lost.
      run(c, "INSERT INTO messages (id,task_id,kind,data,created_at) VALUES (?1,?2,?3,?4,?5)", m.id, task_id, kind, json, ts);
      return m;
    }
    const id = run(c, "INSERT INTO messages (task_id,kind,data,created_at) VALUES (?1,?2,?3,?4)", task_id, kind, json, ts).lastInsertRowid;
    // A copy of `data` as it's stored (Rust's `data.clone()`), so changing one doesn't change the other.
    const m: Message = { id, task_id, kind, data: JSON.parse(json), created_at: ts };
    threads.written(c, m, !!t?.thread_items, true);
    return m;
  });
}

/**
 * The task message `id` is in: its row's, or for a message of an items task (which has none), its prompt's
 * (`permission_requests.message_id`). Undefined if neither knows it.
 */
function task_of(c: Conn, id: number): string | undefined {
  return (
    value<string>(c, "SELECT task_id FROM messages WHERE id=?1", id) ??
    value<string>(c, "SELECT task_id FROM permission_requests WHERE message_id=?1 LIMIT 1", id)
  );
}

/**
 * Message `id` (of task `task_id`, if given) as it is now: its row, or for a task whose items are its source, what its
 * request or item keeps of it (threads/source.ts's `kept`: a prompt's, a question's or a routine's report, the messages
 * changed in place). An items task's rows from before it moved onto items aren't read: its items have them. Null if
 * there's no such message.
 */
export function get_message(c: Conn, id: number, task_id?: string): Message | null {
  const task = task_id ?? task_of(c, id);
  if (task === undefined) return null;
  if (source.of(c, task) === "items") return source.kept(c, task, id);
  const r = one(c, "SELECT * FROM messages WHERE id=?1 AND task_id=?2", id, task);
  return r ? Message_from_row(r) : null;
}

/** Changes message `id`'s data (of task `task_id`, if given): its row, or for an items task, its items (see get_message). */
export function update_message_data(c: Conn, id: number, data: any, task_id?: string): Message | null {
  return tx(c, () => {
    const task = task_id ?? task_of(c, id);
    if (task !== undefined && source.of(c, task) === "items") return source.update(c, task, id, data, false);
    if (!run(c, "UPDATE messages SET data=?1 WHERE id=?2", JSON.stringify(data ?? null), id).changes) return null;
    return updated(c, id);
  });
}

/**
 * update_message_data, if the message's status is still `pending`: in one statement, so of two answers at once only one
 * is taken. Null if it isn't (or there's no such message).
 */
export function update_pending_message(c: Conn, id: number, data: any, task_id?: string): Message | null {
  return tx(c, () => {
    const task = task_id ?? task_of(c, id);
    if (task !== undefined && source.of(c, task) === "items") return source.update(c, task, id, data, true);
    const sql = "UPDATE messages SET data=?1 WHERE id=?2 AND json_extract(data, '$.status')='pending'";
    if (!run(c, sql, JSON.stringify(data ?? null), id).changes) return null;
    return updated(c, id);
  });
}

function updated(c: Conn, id: number): Message | null {
  const r = one(c, "SELECT m.*, t.thread_items FROM messages m JOIN tasks t ON t.id = m.task_id WHERE m.id=?1", id);
  if (!r) return null;
  const m = Message_from_row(r);
  threads.written(c, m, !!r.thread_items, false);
  return m;
}

export function list_messages(c: Conn, task_id: string): Message[] {
  return all(c, "SELECT * FROM messages WHERE task_id=?1 ORDER BY id", task_id).map(Message_from_row);
}

// Queries of one task's messages that also filter on `kind` write it `+kind`, which keeps it from using an index: without
// the database's statistics (it's never ANALYZEd), SQLite takes the (kind, created_at) index over (task_id, id) for
// `task_id=? AND kind=?`, and reads every message of that kind on the board, not the task's (80 ms a query on a board of
// 280,000 messages, on every thread's first page: HA-188, and on each subagent's start and end: HA-193).
//
// Statistics would fix them all at once, but SQLite then plans from averages that go stale (an ANALYZE says each kind has
// a fifth of the messages, when nearly all are `claude`, and `PRAGMA optimize`'s sampled ones kept `user_wrote_since` on
// the kind index), and the tests' fresh databases, which have none, wouldn't check the plans the board runs. Queries
// for `kind='question'` keep the index: questions are rare (under a hundred on that board), so reading the board's is
// quicker than reading a long thread.

/** A page stops once it has this much message data, even short of its limit (some tool results are huge). */
export const PAGE_BYTES = 1 << 20;

const I64_MIN = -(2n ** 63n);
const I64_MAX = 2n ** 63n - 1n;

/** `v[k]` as serde_json's `Index` reads it: null for a missing key, or for a value that isn't an object. */
const get = (v: any, k: string): any => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v[k] ?? null) : null);
const is_null = (v: any) => v === null || v === undefined;

/**
 * The latest messages of a thread with ids between `after` and `before` (both exclusive, if given), oldest first, and
 * whether there are older ones in that range. With a `limit`, the page holds that many of the main conversation's
 * messages (or about a megabyte of messages), with the subagents' own messages among them; it starts with a
 * main-conversation message.
 */
export function message_page(c: Conn, task_id: string, after: number | null, before: number | null, limit: number | null): [Message[], boolean] {
  const st = c.prepare("SELECT * FROM messages WHERE task_id=?1 AND id>?2 AND id<?3 ORDER BY id DESC");
  const page: Message[] = [];
  let main = 0;
  let bytes = 0;
  for (const r of st.iterate(task_id, after ?? I64_MIN, before ?? I64_MAX) as Iterable<any>) {
    // Subagents' messages carry the call that started them. Those don't count, and a page doesn't stop among them.
    const full = limit != null && (main >= Math.max(limit, 1) || bytes >= PAGE_BYTES);
    if (full && page.length && is_null(get(page[page.length - 1].data, "parent_tool_use_id"))) {
      page.reverse();
      return [page, true];
    }
    bytes += typeof r.data === "string" ? byte_len(r.data) : 0;
    const m = Message_from_row(r);
    if (is_null(get(m.data, "parent_tool_use_id"))) main++;
    page.push(m);
  }
  page.reverse();
  return [page, false];
}

/** Clips a string to 200 characters (Unicode scalar values, as Rust's `chars`). */
function clip(s: any): any {
  if (typeof s !== "string") return s;
  const chars = Array.from(s);
  return chars.length > 200 ? chars.slice(0, 200).join("") : s;
}

/**
 * What the UI needs to list a thread's subagents from before message `before` (it shows their count and state with only
 * the latest messages loaded): the messages with their launching calls, the results of those calls, and their task_*
 * system messages (only the latest progress of each). They're cut down to the parts about subagents, with their prompts
 * and reports clipped: the thread loads back to a subagent to show it in full.
 */
export function subagent_messages(c: Conn, task_id: string, before: number): Message[] {
  // Forked Skills have no Agent/Task call: their local_agent lifecycle identifies the call.
  // Look beyond `before` too, as a page can start between the launch and task_started.
  // `+kind` keeps SQLite off the (kind, created_at) index, which reads every agent message on the board (see message_page).
  const starts = all(
    c,
    `SELECT json_extract(data, '$.tool_use_id') AS id FROM messages WHERE task_id=?1 AND +kind='claude'
         AND data LIKE '%"task_started"%' AND json_extract(data, '$.type')='system'
         AND json_extract(data, '$.subtype')='task_started' AND json_extract(data, '$.task_type')='local_agent'
         AND json_type(data, '$.tool_use_id')='text'`,
    task_id,
  );
  const calls = new Set<string>(starts.map((r) => r.id));
  const st = c.prepare("SELECT * FROM messages WHERE task_id=?1 AND id<?2 AND kind='claude' ORDER BY id");
  // The ids Claude's task_* messages give subagents, besides the calls.
  const task_ids = new Set<string>();
  const progress = new Map<string, number>();
  const out: Array<Message | null> = [];
  // One pass over a message for all the calls, rather than one per call (HA-183: 70 ms down to 50 ms on a thread with 136
  // subagents). The loop adds calls as it finds them (only ever adds), which makes the pattern again.
  let any_call: RegExp | null = null;
  let any_call_of = 0;
  const has_call = (data: string) => {
    if (!calls.size) return false;
    if (any_call === null || any_call_of !== calls.size) {
      any_call = new RegExp([...calls].map((id) => id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"));
      any_call_of = calls.size;
    }
    return any_call.test(data);
  };
  for (const r of st.iterate(task_id, before) as Iterable<any>) {
    const data: string = r.data;
    const call = data.includes('"tool_use"') && (data.includes('"name":"Agent"') || data.includes('"name":"Task"') || has_call(data));
    const result = calls.size > 0 && data.includes('"tool_result"') && has_call(data);
    const system = data.includes('"subtype":"task_');
    if (!call && !result && !system) continue;
    const m = Message_from_row(r);
    const d = m.data;
    const type = get(d, "type");
    if (type === "assistant" && call) {
      const content = get(get(d, "message"), "content");
      const blocks: any[] = (Array.isArray(content) ? content : []).filter(
        (b) =>
          get(b, "type") === "tool_use" && (get(b, "name") === "Agent" || get(b, "name") === "Task" || (typeof get(b, "id") === "string" && calls.has(b.id))),
      );
      if (!blocks.length) continue;
      for (const b of blocks) {
        const input = get(b, "input");
        if (input !== null && typeof input === "object" && !Array.isArray(input) && "prompt" in input) input.prompt = clip(input.prompt);
      }
      for (const b of blocks) if (typeof get(b, "id") === "string") calls.add(b.id);
      d.message = { content: blocks };
    } else if (type === "user" && result) {
      const content = get(get(d, "message"), "content");
      const blocks = (Array.isArray(content) ? content : [])
        .filter((b) => get(b, "type") === "tool_result" && typeof get(b, "tool_use_id") === "string" && calls.has(b.tool_use_id))
        .map((b) => {
          // The start of the report is enough to tell a background subagent's launch.
          const ct = get(b, "content");
          const text =
            typeof ct === "string"
              ? ct
              : Array.isArray(ct)
                ? ct
                    .map((x) => get(x, "text"))
                    .filter((x) => typeof x === "string")
                    .join("\n")
                : "";
          return { type: "tool_result", tool_use_id: get(b, "tool_use_id"), is_error: get(b, "is_error"), content: clip(text) };
        });
      if (!blocks.length) continue;
      const meta = get(d, "tool_use_result");
      const keep = ["resolvedModel", "agentType", "totalToolUseCount", "isAsync", "status"];
      const kept: any = {};
      for (const k of keep) if (!is_null(get(meta, k))) kept[k] = get(meta, k);
      m.data = { type: "user", parent_tool_use_id: get(d, "parent_tool_use_id"), message: { content: blocks }, tool_use_result: kept };
    } else if (type === "system" && system) {
      const tk = get(d, "task_id");
      const task: string | null = typeof tk === "string" ? tk : null;
      const tu = get(d, "tool_use_id");
      if (typeof tu === "string") {
        if (!calls.has(tu)) continue;
        if (task != null) task_ids.add(task);
      } else if (!(task != null && task_ids.has(task))) {
        continue;
      }
      if ("prompt" in d) d.prompt = clip(d.prompt);
      if ("summary" in d) d.summary = clip(d.summary);
      if (get(d, "subtype") === "task_progress") {
        const key = typeof tu === "string" ? tu : (task ?? "");
        const i = progress.get(key);
        progress.set(key, out.length);
        if (i !== undefined) out[i] = null;
      }
    } else {
      continue;
    }
    out.push(m);
  }
  return out.filter((m): m is Message => m !== null);
}

/** What the user said in a thread themselves (not the board's messages, nor other agents'): see threads/history.ts's `user_replies`. */
export interface UserReplies {
  /** Oldest first, each with what the agent said last before it (the question it answers, say), if anything. */
  replies: Array<[string | null, string]>;
  /** What the agent has said since the last of them, if anything. */
  since: string | null;
  /** How many earlier ones a `limit` left out. */
  earlier: number;
}
