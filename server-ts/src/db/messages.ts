// Port of server/src/db/messages.rs: a thread's messages, and the message queued for its next run.
import { all, one, run, value, type Conn } from "../db.ts";
import { byte_len, now } from "../util.ts";
import { get_task, type Task } from "./tasks.ts";

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
}

export function Queued_new(text: string, from_agent: boolean): Queued {
  return { text, from_agent, user_text: from_agent ? null : text };
}

/** Nothing: what's queued goes as it is (see runner::send_queued). */
export function Queued_empty(): Queued {
  return { text: "", from_agent: true, user_text: null };
}

/**
 * This message, then `next` after it. Rust's `Queued::then`, renamed: a module exporting `then` would make its
 * namespace object a thenable.
 */
export function queued_then(q: Queued, next: Queued): Queued {
  const join = (a: string, b: string) => (a.trim() === "" ? b : b.trim() === "" ? a : `${a}\n\n${b}`);
  const user_text = q.user_text != null && next.user_text != null ? join(q.user_text, next.user_text) : (q.user_text ?? next.user_text);
  return { text: join(q.text, next.text), from_agent: q.from_agent && next.from_agent, user_text };
}

/** Add a message to the one queued on a thread. */
export function queue(c: Conn, task_id: string, message: Queued): Task | null {
  const t = get_task(c, task_id);
  if (!t) return null;
  const text = t.queued_message;
  const queued =
    text != null && text.trim() !== "" ? queued_then({ text, from_agent: queued_from_agent(c, task_id), user_text: t.queued_user_text }, message) : message;
  run(
    c,
    "UPDATE tasks SET queued_message=?2, queued_from_agent=?3, queued_user_text=?4, updated_at=?5 WHERE id=?1",
    task_id, queued.text, queued.from_agent, queued.user_text, now(),
  );
  return get_task(c, task_id);
}

function queued_from_agent(c: Conn, task_id: string): boolean {
  const v = value(c, "SELECT queued_from_agent FROM tasks WHERE id=?1", task_id);
  if (v === undefined) throw new Error("Query returned no rows");
  return !!v;
}

/** Take the message queued on a thread. */
export function take_queued(c: Conn, task_id: string): Queued | null {
  const t = get_task(c, task_id);
  let queued: Queued | null = null;
  if (t && t.queued_message != null && t.queued_message.trim() !== "") {
    queued = { text: t.queued_message, from_agent: queued_from_agent(c, task_id), user_text: t.queued_user_text };
  }
  clear_queued(c, task_id);
  return queued;
}

export function clear_queued(c: Conn, task_id: string): Task | null {
  run(c, "UPDATE tasks SET queued_message=NULL, queued_from_agent=0, queued_user_text=NULL, updated_at=?2 WHERE id=?1", task_id, now());
  return get_task(c, task_id);
}

// ---------- messages ----------

export function insert_message(c: Conn, task_id: string, kind: string, data: any): Message {
  const ts = now();
  const json = JSON.stringify(data ?? null);
  const id = run(c, "INSERT INTO messages (task_id,kind,data,created_at) VALUES (?1,?2,?3,?4)", task_id, kind, json, ts).lastInsertRowid;
  run(c, "UPDATE tasks SET last_activity_at=?1 WHERE id=?2", ts, task_id);
  // A copy of `data` as it's stored (Rust's `data.clone()`), so changing one doesn't change the other.
  return { id, task_id, kind, data: JSON.parse(json), created_at: ts };
}

export function update_message_data(c: Conn, id: number, data: any): Message | null {
  run(c, "UPDATE messages SET data=?1 WHERE id=?2", JSON.stringify(data ?? null), id);
  const r = one(c, "SELECT * FROM messages WHERE id=?1", id);
  return r ? Message_from_row(r) : null;
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

/** Whether the user sent `task_id`'s agent a message (any, the board's too) at or after `at`. */
export function user_messaged_since(c: Conn, task_id: string, at: string): boolean {
  return !!value(c, "SELECT EXISTS(SELECT 1 FROM messages WHERE task_id=?1 AND +kind='user' AND created_at>=?2)", task_id, at);
}

/** The call (`tool_use_id`) that started subagent `subagent_task_id` in `task_id`'s thread, from its latest `task_started`. */
export function subagent_call(c: Conn, task_id: string, subagent_task_id: string | null): string | null {
  return (
    value<string | null>(
      c,
      `SELECT json_extract(data,'$.tool_use_id') FROM messages WHERE task_id=?1 AND +kind='claude'
       AND json_extract(data,'$.subtype')='task_started' AND json_extract(data,'$.task_id')=?2 ORDER BY id DESC LIMIT 1`,
      task_id,
      subagent_task_id,
    ) ?? null
  );
}

/** Whether `tool_use_id` is an Agent or Task call (a subagent's launch) in `task_id`'s thread. */
export function is_subagent_call(c: Conn, task_id: string, tool_use_id: string): boolean {
  return !!value<number>(
    c,
    `SELECT EXISTS(SELECT 1 FROM messages m, json_each(m.data,'$.message.content') b
     WHERE m.task_id=?1 AND +m.kind='claude' AND json_extract(m.data,'$.type')='assistant'
     AND json_extract(b.value,'$.type')='tool_use' AND json_extract(b.value,'$.name') IN ('Agent','Task')
     AND json_extract(b.value,'$.id')=?2)`,
    task_id,
    tool_use_id,
  );
}

/** Whether `task_id`'s thread has an assistant message whose first block has id `id` (a call the board wrote for Codex). */
export function has_assistant_block(c: Conn, task_id: string, id: string): boolean {
  return !!value<number>(
    c,
    `SELECT EXISTS(SELECT 1 FROM messages WHERE task_id=?1 AND +kind='claude'
     AND json_extract(data,'$.type')='assistant' AND json_extract(data,'$.message.content[0].id')=?2)`,
    task_id,
    id,
  );
}

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
  const has_call = (data: string) => [...calls].some((id) => data.includes(id));
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
        (b) => get(b, "type") === "tool_use" && (get(b, "name") === "Agent" || get(b, "name") === "Task" || (typeof get(b, "id") === "string" && calls.has(b.id))),
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
            typeof ct === "string" ? ct : Array.isArray(ct) ? ct.map((x) => get(x, "text")).filter((x) => typeof x === "string").join("\n") : "";
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

/**
 * The tool calls (`tool_use` blocks) an agent made in a thread, each with its result (`tool_result` block) if it has
 * one, after `since` (a timestamp) if given, oldest first.
 */
export function tool_calls_since(c: Conn, task_id: string, since: string | null): Array<[any, any | null]> {
  const st = c.prepare("SELECT data FROM messages WHERE task_id=?1 AND +kind='claude' AND created_at>?2 AND data LIKE '%tool\\_use%' ESCAPE '\\' ORDER BY id");
  const calls: any[] = [];
  const results = new Map<string, any>();
  for (const r of st.iterate(task_id, since ?? "") as Iterable<any>) {
    let v: any = null;
    try {
      v = JSON.parse(r.data);
    } catch {}
    const blocks = get(get(v, "message"), "content");
    if (!Array.isArray(blocks)) continue;
    for (const b of blocks) {
      const vt = get(v, "type");
      const bt = get(b, "type");
      if (vt === "assistant" && bt === "tool_use") calls.push(b);
      else if (vt === "user" && bt === "tool_result") {
        const id = get(b, "tool_use_id");
        if (typeof id === "string") results.set(id, b);
      }
    }
  }
  return calls.map((call) => {
    const id = get(call, "id");
    let result = null;
    if (typeof id === "string" && results.has(id)) {
      result = results.get(id);
      results.delete(id);
    }
    return [call, result];
  });
}

/** The most recent assistant text in a thread (used for summaries in MCP tools). */
export function last_assistant_text(c: Conn, task_id: string): string | null {
  return last_assistant_text_after(c, task_id, 0);
}

/** The text blocks of an assistant message's content, joined, or null if there are none. */
function text_of(v: any): string | null {
  const blocks = get(get(v, "message"), "content");
  if (!Array.isArray(blocks)) return null;
  const text = blocks.filter((b) => get(b, "type") === "text").map((b) => get(b, "text")).filter((t) => typeof t === "string");
  return text.length ? text.join("\n") : null;
}

/** The most recent assistant text in a thread after message `after` (an id). */
export function last_assistant_text_after(c: Conn, task_id: string, after: number): string | null {
  const rows = all(c, "SELECT data FROM messages WHERE task_id=?1 AND kind='claude' AND id > ?2 ORDER BY id DESC LIMIT 50", task_id, after);
  for (const r of rows) {
    let v: any = null;
    try {
      v = JSON.parse(r.data);
    } catch {}
    if (get(v, "type") === "result") {
      const s = get(v, "result");
      if (typeof s === "string" && s !== "") return s;
    }
    if (get(v, "type") === "assistant") {
      const t = text_of(v);
      if (t != null) return t;
    }
  }
  return null;
}

/** What the user said in a thread themselves (not the board's messages, nor other agents'): see `user_replies`. */
export interface UserReplies {
  /** Oldest first, each with what the agent said last before it (the question it answers, say), if anything. */
  replies: Array<[string | null, string]>;
  /** What the agent has said since the last of them, if anything. */
  since: string | null;
  /** How many earlier ones a `limit` left out. */
  earlier: number;
}

/**
 * The user's own messages in a thread (`UserReplies`), the latest `limit` of them if given. Read newest first, so a long
 * thread is only read back as far as those, and the agent's messages are only parsed while looking for what it said
 * before one (tool results can be big).
 */
export function user_replies(c: Conn, task_id: string, limit: number | null): UserReplies {
  const st = c.prepare("SELECT id, kind, data FROM messages WHERE task_id=?1 AND kind IN ('claude','user') ORDER BY id DESC");
  const out: UserReplies = { replies: [], since: null, earlier: 0 };
  // Nothing from the user yet (going back), so what the agent says is what it said `since`.
  let latest = true;
  // The reply found last (id and text), until what the agent said before it is.
  let pending: [number, string] | null = null;
  // The id of a reply past the limit: it and those before it are left out.
  let cut: number | null = null;
  for (const r of st.iterate(task_id) as Iterable<any>) {
    const id: number = r.id;
    if (r.kind === "user") {
      const text = reply_text(r.data);
      if (text == null) continue;
      latest = false;
      // Nothing from the agent between the two.
      if (pending) out.replies.push([null, pending[1]]);
      pending = null;
      if (limit != null && out.replies.length >= limit) {
        cut = id + 1;
        break;
      }
      pending = [id, text];
    } else if (latest || pending) {
      const text = agent_text(r.data);
      if (text == null) continue;
      if (latest) {
        out.since = text;
        latest = false;
      } else if (pending) {
        const [pid, p] = pending;
        pending = null;
        out.replies.push([text, p]);
        if (limit != null && out.replies.length >= limit) {
          cut = pid;
          break;
        }
      }
    }
  }
  if (pending) out.replies.push([null, pending[1]]);
  out.replies.reverse();
  if (cut != null) {
    for (const r of c.prepare("SELECT data FROM messages WHERE task_id=?1 AND kind='user' AND id<?2").iterate(task_id, cut) as Iterable<any>) {
      if (reply_text(r.data) != null) out.earlier++;
    }
  }
  return out;
}

/** A user message's text, if the user wrote it themselves. */
function reply_text(data: string): string | null {
  let v: any;
  try {
    v = JSON.parse(data);
  } catch {
    return null;
  }
  // A message sent with other agents' (queued together) has the user's part apart.
  const ut = get(v, "user_text");
  const t = get(v, "text");
  const text = (typeof ut === "string" ? ut : typeof t === "string" ? t : "").trim();
  return get(v, "auto") !== true && get(v, "from_agent") !== true && text !== "" ? text : null;
}

/** The text of one of the agent's messages, if it has any. */
function agent_text(data: string): string | null {
  // Most of a thread is tool calls and their results, which needn't be parsed.
  if (!data.includes('"assistant"') || !data.includes('"text"')) return null;
  let v: any;
  try {
    v = JSON.parse(data);
  } catch {
    return null;
  }
  if (get(v, "type") !== "assistant") return null;
  return text_of(v);
}
