// The board's readers of a task's thread (step 6 of docs/threads.md, plan decision D5): what review, summaries, titles,
// the wait tool, pr_watch, the API's and MCP tools' `last_message`, prompts, checkpoints and analytics read of a
// thread. Each reads the task's items (threads/store.ts's tables) when the task has them, and the messages, with the
// SQL the board has always used (db/messages.ts), otherwise. `huntaway threads-readers` (threads/readers.ts) runs
// each reader both ways on a copy of a board and reports where they differ.
//
// A task's readers read items (`source`) when its items are its thread's source (`thread_source`, step 10, see
// threads/source.ts: it has no messages since it moved onto them), or when it's flagged `thread_items`, its live writes
// haven't stopped on an error, and this build's translator wrote them (`threads.converter`): an older one's items may
// lack what the readers need (converter 3 added the metas they read), and the messages are still the source of a task
// on messages, so until `huntaway threads-rebuild` brings the thread up to date they read those.
//
// What the items readers go on is what the translator (threads/translate.ts) keeps: who sent a user message is in its
// meta (`auto`, `from_agent`, `user_text`, `start`, `routine`, `review_round`), a turn's result text is its
// turn_result's `result_text`, a subagent's id is its call's `subagent_task`, Claude's API errors are error notices with
// a `code`, and an item from a message names it by its id (`legacy:<message id>[:<block>]`) and in
// thread_item_origins. They give what the messages readers give, but where noted.
//
// The port of HA-128's server/src/threads/history.rs (on origin/ia/ha-128-implement-agent-threads-from-feasibility),
// which converted a legacy task's messages as it read them, and read an agent-threads task's snapshot: here a task's
// items are kept, so they're read in place, newest first, and only the item types a reader needs (tool results are
// most of a thread). Rust's `Said` is `said` here, and its readers keep the names the TS server's callers had.
import * as db from "../db.ts";
import type { Conn } from "../db.ts";
import type { Item, ToolCall } from "./protocol.ts";
import { CONVERTER_VERSION, type ItemMeta } from "./translate.ts";
import * as write from "./write.ts";

/** Where a task's thread is read from. */
export type Source = "items" | "messages";

/**
 * Where readers of several tasks read each from: `auto` is each task's own `source`. The compare command
 * (threads/readers.ts) reads all of them one way and then the other.
 */
export type Mode = "auto" | Source;

/** The SQL condition (on tasks aliased `t`) that a task's thread is read from its items: what `source` says. */
export function on_items(): string {
  return `(t.thread_source='items' OR (t.thread_items=1 AND EXISTS(SELECT 1 FROM threads h WHERE h.task_id=t.id AND h.error IS NULL AND h.converter=${CONVERTER_VERSION})))`;
}

/**
 * Where task `task_id`'s readers read its thread from (see the top of the file). A done task without items gets them
 * first (threads/write.ts's `ensure`, with the setting on): the batch (threads/batch.ts) leaves done tasks out, so they
 * get theirs when they're opened or read.
 */
export function source(c: Conn, task_id: string): Source {
  if (reads_items(c, task_id)) return "items";
  if (db.one(c, "SELECT 1 FROM tasks WHERE id=?1 AND status='done'", task_id) && write.ensure(c, task_id) && reads_items(c, task_id)) return "items";
  return "messages";
}

/** Whether task `task_id`'s readers read its items as things are, building none (`source`, without `ensure`). */
export function reads_items(c: Conn, task_id: string): boolean {
  return !!db.one(c, `SELECT 1 FROM tasks t WHERE t.id=?1 AND ${on_items()}`, task_id);
}

/**
 * The SQL condition, on tasks aliased `t`, for the tasks `mode` reads from `from`. Only `auto` knows tasks whose items
 * are their source (`thread_source`), whose messages stop where they moved onto them: `messages` is for migration 79's
 * backfill, which runs before there were items, and for comparing a board none of whose tasks are on items yet.
 */
export function reads(mode: Mode, from: Source): string {
  if (mode !== "auto") return mode === from ? "1" : "0";
  return from === "items" ? on_items() : `NOT ${on_items()}`;
}

// ---------- reading items ----------

/** An item as the readers read it: with its position in the thread and what the board knows about it. */
export interface Entry {
  pos: number;
  item: Item;
  meta: ItemMeta;
}

const entry = (r: { pos: number; data: string; meta: string | null }): Entry => ({ pos: r.pos, item: JSON.parse(r.data), meta: r.meta ? JSON.parse(r.meta) : {} });

/** What was said: user messages, the agent's messages, turns' results and notices (not tool calls, the bulk of a thread). */
const SAID = "('user_message', 'assistant_message', 'turn_result', 'notice')";

/** The task's items of the types in `types` (an SQL list) and `where`, newest first, read as they're needed. */
function* newest(c: Conn, task_id: string, types: string, where = "", ...params: any[]): Generator<Entry> {
  const st = c.prepare(`SELECT pos, data, meta FROM thread_items WHERE task_id=?1 AND type IN ${types} ${where} ORDER BY pos DESC`);
  for (const r of st.iterate(task_id, ...params) as Iterable<any>) yield entry(r);
}

/** The message an item made from one names in its id (`legacy:<message id>` or `legacy:<message id>:<block>`). */
export function message_of(item_id: string): number | undefined {
  const m = /^legacy:(\d+)(?::|$)/.exec(item_id);
  return m ? Number(m[1]) : undefined;
}

/** The harness's id for a tool call: its item's, but for a second call with one id (whose item is `legacy:…`). */
export const call_id = (e: Entry): string => e.meta.call_id ?? e.item.id;

/** A tool's name as the harness gave it (`mcp__<server>__<tool>` for an MCP tool), from its item's fields. */
export function tool_name(t: ToolCall): string {
  if (t.kind === "app") return `mcp__app__${t.name}`;
  if (t.server !== undefined) return `mcp__${t.server}__${t.name}`;
  return t.name;
}

/** A user_message as its message's data has it: its text, and what the board knows of it (its meta). */
function user_data(e: Entry): any {
  const out: any = { text: e.item.type === "user_message" ? e.item.text : "" };
  for (const k of ["auto", "from_agent", "user_text", "start", "routine", "review_round"] as const) if (e.meta[k] !== undefined) out[k] = e.meta[k];
  return out;
}

/** The user's own words in a user_message, trimmed: not the board's messages, nor other agents'. */
function users_text(e: Entry): string | null {
  if (e.item.type !== "user_message" || e.meta.auto || e.meta.from_agent) return null;
  const text = (e.meta.user_text ?? e.item.text).trim();
  return text !== "" ? text : null;
}

/** Something said, as `said` sees it. */
type Said =
  /** A user message (anyone's), with the user's own words if they wrote it. */
  | { kind: "user"; text: string | null; pos: number }
  /** One of the agent's messages (a message's text blocks, joined by newlines), or an API error in its place. */
  | { kind: "agent"; text: string }
  /** What a turn's result said: null if it said nothing, which only `ends` gives. */
  | { kind: "ended"; text: string | null; pos: number };

/**
 * What was said in the task's thread, newest first, from position `upto` back if given. The text blocks of one of the
 * agent's messages are items of their own (`legacy:<message>:<block>`), which come together: they're joined into one,
 * as the messages readers read them. A result's text that no message said (the translator's `from_result`
 * assistant_message) is left to its turn_result. With `ends`, every turn's end is given, the ones whose result said
 * nothing too.
 */
function* said(c: Conn, task_id: string, { upto = null, ends = false }: { upto?: number | null; ends?: boolean } = {}): Generator<Said> {
  let agent: { message: number | undefined; texts: string[] } | null = null;
  const entries = upto === null ? newest(c, task_id, SAID) : newest(c, task_id, SAID, "AND pos<=?2", upto);
  for (const e of entries) {
    const item = e.item;
    if (agent) {
      const m = message_of(item.id);
      if (item.type === "assistant_message" && !e.meta.from_result && m !== undefined && m === agent.message) {
        agent.texts.push(item.text);
        continue;
      }
      yield { kind: "agent", text: agent.texts.reverse().join("\n") };
      agent = null;
    }
    switch (item.type) {
      case "user_message":
        yield { kind: "user", text: users_text(e), pos: e.pos };
        break;
      case "assistant_message":
        if (!e.meta.from_result) agent = { message: message_of(item.id), texts: [item.text] };
        break;
      case "turn_result":
        if (e.meta.result_text || ends) yield { kind: "ended", text: e.meta.result_text || null, pos: e.pos };
        break;
      case "notice":
        // Claude Code's API errors (a usage limit, say), which it gives as the assistant's text, have a code; the
        // board's own events have none, and an interrupt's is info. A routine's report (a failed run's is an error) is
        // the board's, which the messages readers don't read either.
        if (item.level === "error" && item.code !== undefined && item.code !== "routine_report" && item.text !== "") yield { kind: "agent", text: item.text };
        break;
    }
  }
  if (agent) yield { kind: "agent", text: agent.texts.reverse().join("\n") };
}

// ---------- what the agent said ----------

/**
 * The last thing the agent said in `task_id`'s thread: its latest message, or what its latest turn's result said
 * (the API's and MCP tools' `last_message`, and what review and summaries go on when the work is somewhere else).
 * The messages reader reads the latest `window` of the agent's messages; the items one reads back as far as it takes.
 */
export function last_assistant_text(c: Conn, task_id: string, from = source(c, task_id), window = 50): string | null {
  if (from === "messages") return db.last_assistant_text(c, task_id, window);
  for (const s of said(c, task_id)) if (s.kind !== "user") return s.text;
  return null;
}

/**
 * What the agent said after the latest message it was sent (the user's, the board's or another agent's): what it
 * answered with, such as a summary or a routine's report it was asked for. Not trimmed. The messages reader reads the
 * latest `window` of the agent's messages after it, as last_assistant_text does.
 */
export function said_since_asked(c: Conn, task_id: string, from = source(c, task_id), window = 50): string | null {
  if (from === "messages") {
    const asked = db.value<number>(c, "SELECT COALESCE(MAX(id), 0) FROM messages WHERE task_id=?1 AND kind='user'", task_id) ?? 0;
    return db.last_assistant_text_after(c, task_id, asked, window);
  }
  for (const s of said(c, task_id)) {
    if (s.kind === "user") return null;
    return s.text;
  }
  return null;
}

/**
 * What the agent said in the turn that ended with message `message_id` (its result): its result's text, or its latest
 * message since the latest message it was sent and the turn before's end (so a turn that said nothing doesn't say the
 * one before's again). Telegram's reply to the user. Not trimmed. The messages reader reads the latest `window` of the
 * agent's messages in the turn, as last_assistant_text does; the items one is null if the thread has no such turn end.
 */
export function said_in_turn(c: Conn, task_id: string, message_id: number, from = source(c, task_id), window = 50): string | null {
  if (from === "messages") {
    const asked =
      db.value<number>(
        c,
        `SELECT COALESCE(MAX(id), 0) FROM messages WHERE task_id=?1 AND id < ?2
           AND (kind='user' OR (kind='claude' AND json_extract(data,'$.type')='result'))`,
        task_id,
        message_id,
      ) ?? 0;
    return db.last_assistant_text_after(c, task_id, asked, window, message_id);
  }
  const end = db.value<number>(c, "SELECT pos FROM thread_items WHERE task_id=?1 AND id=?2 AND type='turn_result'", task_id, `legacy:${message_id}`);
  if (end === undefined) return null;
  for (const s of said(c, task_id, { upto: end, ends: true })) {
    if (s.kind === "user") return null;
    if (s.kind === "agent") return s.text;
    // The turn before's end.
    if (s.pos !== end) return null;
    if (s.text !== null) return s.text;
  }
  return null;
}

/**
 * How a turn ended, for Telegram (integrations/telegram.ts): only a turn that went as it should is a reply. `compact`: a
 * compaction's end (a `/compact` run's, the user's or the board's after the thread was idle a while), which answers
 * nothing. `failed`: it failed (an error, or the usage limit) or was stopped part way: its needs attention says so.
 */
export type TurnEnd = "reply" | "compact" | "failed";

/** How the turn that `result` (a `result` message's data) ended went. */
export function turn_end(result: any): TurnEnd {
  if (result?.compact === true) return "compact";
  if (result?.is_error === true || result?.interrupted === true || (typeof result?.subtype === "string" && result.subtype.startsWith("error"))) return "failed";
  return "reply";
}

/**
 * The latest turn's end in `task_id`'s thread: its result's message id, and how it went (`turn_end`). From items, a
 * turn_result that isn't `ok` failed (its result was an error, or its subtype wasn't `success`), and one that was
 * interrupted too.
 */
export function last_turn_end(c: Conn, task_id: string, from = source(c, task_id)): { id: number; end: TurnEnd } | null {
  if (from === "messages") {
    const r = db.one<{ id: number; data: string }>(
      c,
      "SELECT id, data FROM messages WHERE task_id=?1 AND kind='claude' AND json_extract(data,'$.type')='result' ORDER BY id DESC LIMIT 1",
      task_id,
    );
    if (!r) return null;
    let data: any = null;
    try {
      data = JSON.parse(r.data);
    } catch {}
    return { id: r.id, end: turn_end(data) };
  }
  const e = newest(c, task_id, "('turn_result')").next();
  if (e.done || e.value.item.type !== "turn_result") return null;
  const id = message_of(e.value.item.id);
  if (id === undefined) return null;
  const t = e.value.item;
  return { id, end: e.value.meta.compact ? "compact" : !t.ok || t.interrupted ? "failed" : "reply" };
}

/**
 * The user's own messages in `task_id`'s thread (db/messages.ts's UserReplies), the latest `limit` of them if given,
 * each with what the agent said last before it. Read newest first, so a long thread is only read back as far as those.
 */
export function user_replies(c: Conn, task_id: string, limit: number | null, from = source(c, task_id)): db.UserReplies {
  if (from === "messages") return db.user_replies(c, task_id, limit);
  const out: db.UserReplies = { replies: [], since: null, earlier: 0 };
  // Nothing from the user yet (going back), so what the agent says is what it said `since`.
  let latest = true;
  // The reply found last (its position and text), until what the agent said before it is.
  let pending: [number, string] | null = null;
  // Where a limit cut them: the replies before this position were left out.
  let cut: number | null = null;
  for (const s of said(c, task_id)) {
    if (s.kind === "user") {
      if (s.text === null) continue;
      latest = false;
      // Nothing from the agent between the two.
      if (pending) out.replies.push([null, pending[1]]);
      pending = null;
      if (limit != null && out.replies.length >= limit) {
        cut = s.pos + 1;
        break;
      }
      pending = [s.pos, s.text];
    } else if (s.kind === "agent" && (latest || pending)) {
      if (latest) {
        out.since = s.text;
        latest = false;
      } else if (pending) {
        const [at, p] = pending;
        pending = null;
        out.replies.push([s.text, p]);
        if (limit != null && out.replies.length >= limit) {
          cut = at;
          break;
        }
      }
    }
  }
  if (pending) out.replies.push([null, pending[1]]);
  out.replies.reverse();
  if (cut != null) {
    for (const e of newest(c, task_id, "('user_message')", "AND pos<?2", cut)) if (users_text(e) !== null) out.earlier++;
  }
  return out;
}

// ---------- who wrote ----------

/** Whether the user (not the board or another agent) sent `task_id`'s agent a message after `since` (pr_watch). */
export function user_wrote_since(c: Conn, task_id: string, since: string, from = source(c, task_id)): boolean {
  if (from === "messages") return db.user_wrote_since(c, task_id, since);
  for (const e of newest(c, task_id, "('user_message')", "AND created_at>?2", since)) if (!e.meta.auto && !e.meta.from_agent) return true;
  return false;
}

/** Whether `task_id`'s agent was sent a message (anyone's, the board's too) at or after `at`. */
export function user_messaged_since(c: Conn, task_id: string, at: string, from = source(c, task_id)): boolean {
  if (from === "messages") return db.user_messaged_since(c, task_id, at);
  // `+type`: the task's items, not the board's user messages since then (thread_items_user_time, see db/messages.ts).
  return !!db.value<number>(c, "SELECT EXISTS(SELECT 1 FROM thread_items WHERE task_id=?1 AND +type='user_message' AND created_at>=?2)", task_id, at);
}

/**
 * Whether the conversation in `task_id`'s thread has moved on since message `message_id` (a question's or a prompt's):
 * a message has been sent to the agent after it (by the user, the board or another agent).
 */
export function moved_on(c: Conn, task_id: string, message_id: number, from = source(c, task_id)): boolean {
  if (from === "messages") {
    return !!db.value<number>(c, "SELECT EXISTS(SELECT 1 FROM messages WHERE task_id=?1 AND kind='user' AND id>?2)", task_id, message_id);
  }
  return !!db.value<number>(
    c,
    `SELECT EXISTS(SELECT 1 FROM thread_items i JOIN thread_item_origins o ON o.task_id=i.task_id AND o.item_id=i.id
     WHERE i.task_id=?1 AND i.type='user_message' AND o.message_id>?2)`,
    task_id,
    message_id,
  );
}

/** The id of the task's first user message (anyone's), which a rewind to before it starts the conversation afresh at. */
export function first_user_message(c: Conn, task_id: string, from = source(c, task_id)): number | null {
  if (from === "messages") return db.value<number>(c, "SELECT MIN(id) FROM messages WHERE task_id=?1 AND kind='user'", task_id) ?? null;
  return (
    db.value<number>(
      c,
      `SELECT MIN(o.message_id) FROM thread_items i JOIN thread_item_origins o ON o.task_id=i.task_id AND o.item_id=i.id
       WHERE i.task_id=?1 AND i.type='user_message'`,
      task_id,
    ) ?? null
  );
}

/**
 * Message `message_id` of `task_id`'s thread, a user message (a checkpoint's turn's, or a run's), as its data says what
 * the readers need of it: its `text`, the user's own part (`user_text`), and whether the board sent it (`auto`), for a
 * routine run (`routine`), or to fix a review round's issues (`review_round`). Undefined if the thread has no such
 * message; read from items, also if it isn't a user message. Null for data that isn't JSON.
 */
export function user_message(c: Conn, task_id: string, message_id: number, from = source(c, task_id)): any | undefined {
  if (from === "messages") {
    const d = db.value<string>(c, "SELECT data FROM messages WHERE id=?1 AND task_id=?2", message_id, task_id);
    if (d === undefined) return undefined;
    try {
      return JSON.parse(d);
    } catch {
      return null;
    }
  }
  const r = db.one<any>(c, "SELECT pos, data, meta FROM thread_items WHERE task_id=?1 AND id=?2 AND type='user_message'", task_id, `legacy:${message_id}`);
  if (!r) return undefined;
  return user_data(entry(r));
}

// ---------- tool calls ----------

/**
 * The tool calls the agent made in `task_id`'s thread (subagents' too) after `since` (a timestamp; all of them if null),
 * oldest first, each with its result if it has one: as Claude's `tool_use` and `tool_result` blocks, which
 * git/changes.ts's `changes_code` reads (review). From items: a call's name as the harness gave it, its input, and
 * its result's text, an error unless the call completed.
 */
export function tool_calls_since(c: Conn, task_id: string, since: string | null, from = source(c, task_id)): Array<[any, any | null]> {
  if (from === "messages") return db.tool_calls_since(c, task_id, since);
  const st = c.prepare("SELECT pos, data, meta FROM thread_items WHERE task_id=?1 AND type='tool_call' AND created_at>?2 ORDER BY pos");
  const out: Array<[any, any | null]> = [];
  for (const r of st.iterate(task_id, since ?? "") as Iterable<any>) {
    const e = entry(r);
    if (e.item.type !== "tool_call") continue;
    const t = e.item;
    const id = call_id(e);
    const call = { type: "tool_use", id, name: tool_name(t), input: t.input };
    const result = t.result ? { type: "tool_result", tool_use_id: id, content: t.result.content, is_error: t.status !== "completed" } : null;
    out.push([call, result]);
  }
  return out;
}

/**
 * The name and input of tool call `id` (the harness's id) in `task_id`'s thread, the latest with the id. The messages
 * reader reads the latest `window` messages that mention the id (a call's results and its subagent's progress do too),
 * the items one the calls with the id.
 */
export function tool_use(c: Conn, task_id: string, id: string, from = source(c, task_id), window = 5): [string, any] | null {
  if (from === "messages") {
    const rows = db.all<{ data: string }>(
      c,
      "SELECT data FROM messages WHERE task_id=?1 AND kind='claude' AND instr(data, ?2) > 0 ORDER BY id DESC LIMIT ?3",
      task_id,
      id,
      Number.isFinite(window) ? window : -1,
    );
    for (const { data } of rows) {
      let v: any;
      try {
        v = JSON.parse(data);
      } catch {
        continue;
      }
      if (!Array.isArray(v?.message?.content)) continue;
      const b = v.message.content.find((b: any) => b?.type === "tool_use" && b?.id === id);
      if (b) return [typeof b.name === "string" ? b.name : "unknown", b.input ?? null];
    }
    return null;
  }
  for (const e of newest(c, task_id, "('tool_call')", "AND (id=?2 OR json_extract(meta, '$.call_id')=?2)", id)) {
    if (e.item.type === "tool_call" && call_id(e) === id) return [tool_name(e.item), e.item.input ?? null];
  }
  return null;
}

/**
 * Whether `task_id`'s thread has tool call `id` (the harness's id): agent/codex/output.ts writes a subagent's call once.
 * The messages reader looks at each assistant message's first block, where the board writes those calls.
 */
export function has_call(c: Conn, task_id: string, id: string, from = source(c, task_id)): boolean {
  if (from === "messages") return db.has_assistant_block(c, task_id, id);
  return !!db.value<number>(
    c,
    "SELECT EXISTS(SELECT 1 FROM thread_items WHERE task_id=?1 AND type='tool_call' AND (id=?2 OR json_extract(meta, '$.call_id')=?2))",
    task_id,
    id,
  );
}

/**
 * The Agent or Task call (the harness's id for it) that a subagent's lifecycle message (`event`, a task_* one) in
 * `task_id`'s thread is about (the wait tool's `subagent_finished`): the call it names, or the one the latest
 * task_started for its `task_id` started. Null if that's no Agent or Task call in the thread (a forked Skill, a
 * background shell command).
 */
export function subagent_call(c: Conn, task_id: string, event: any, from = source(c, task_id)): string | null {
  const named = typeof event?.tool_use_id === "string" ? (event.tool_use_id as string) : null;
  const subagent = typeof event?.task_id === "string" ? (event.task_id as string) : null;
  if (from === "messages") {
    const id = named ?? db.subagent_call(c, task_id, subagent);
    return id !== null && db.is_subagent_call(c, task_id, id) ? id : null;
  }
  let id = named;
  if (id === null) {
    if (subagent === null) return null;
    const e = newest(c, task_id, "('tool_call')", "AND json_extract(meta, '$.subagent_task')=?2", subagent).next();
    if (e.done) return null;
    id = call_id(e.value);
  }
  for (const e of newest(c, task_id, "('tool_call')", "AND (id=?2 OR json_extract(meta, '$.call_id')=?2)", id)) {
    if (e.item.type === "tool_call" && call_id(e) === id && ["Agent", "Task"].includes(tool_name(e.item))) return id;
  }
  return null;
}

// ---------- requests ----------

/**
 * A pending approval (a project change, a deletion, an automation: `permission_requests` row `p`) as its thread message
 * has it, for mcp/permissions.ts's pending_approvals: what the request asked, from the thread's request (its input as
 * it was asked), and the rest from the row. Null if it's no approval.
 */
export function approval(c: Conn, p: any): any | null {
  if (!["project", "delete_task", "automation"].includes(p.kind)) return null;
  const r = db.one<{ data: string }>(c, "SELECT data FROM thread_requests WHERE task_id=?1 AND id=?2", p.task_id, p.id);
  let input: any = null;
  try {
    input = r ? (JSON.parse(r.data).input ?? null) : JSON.parse(p.input);
  } catch {}
  const v: any = { kind: p.kind, tool_name: p.tool_name, input, request_id: p.id, status: p.status };
  if (p.expires_at != null) v.expires_at = p.expires_at;
  // Only an ask rule asks for an approval (see permissions.approve).
  if (p.rule != null) v.rule = { tool: p.rule, decision: "ask" };
  const task = db.get_task(c, p.task_id);
  if (task && db.task_claude_config(c, task)?.agent === "codex") v.agent = "codex";
  return v;
}

// ---------- every task's ----------

/**
 * The user messages (anyone's) of `profile_id`'s tasks made at `from` or later and before `to`, oldest first, for prompt
 * analytics: when, the task whose activity it is (`owner`, an SQL expression on tasks `t`), and its data, as the
 * message has it, or as user_message gives it from an item.
 */
export function user_messages_between(c: Conn, profile_id: string, from: string, to: string, owner: string, mode: Mode = "auto"): Array<{ at: string; owner: string; data: any }> {
  const out: Array<{ at: string; owner: string; data: any }> = [];
  const parse = (d: string) => {
    try {
      return JSON.parse(d);
    } catch {
      return null;
    }
  };
  for (const r of db.all<any>(
    c,
    `SELECT m.created_at AS at, ${owner} AS owner, m.data AS data FROM messages m JOIN tasks t ON t.id=m.task_id
       WHERE m.kind='user' AND m.created_at >= ?2 AND m.created_at < ?3 AND t.profile_id=?1 AND ${reads(mode, "messages")}
       ORDER BY m.created_at`,
    profile_id, from, to,
  )) {
    out.push({ at: r.at, owner: r.owner, data: parse(r.data) });
  }
  const items = db.all<any>(
    c,
    `SELECT i.created_at AS at, ${owner} AS owner, i.pos, i.data, i.meta FROM thread_items i JOIN tasks t ON t.id=i.task_id
       WHERE i.type='user_message' AND i.created_at >= ?2 AND i.created_at < ?3 AND t.profile_id=?1 AND ${reads(mode, "items")}
       ORDER BY i.created_at, i.task_id, i.pos`,
    profile_id, from, to,
  );
  for (const r of items) {
    out.push({ at: r.at, owner: r.owner, data: user_data(entry(r)) });
  }
  // By time, as the one query did (a stable sort keeps each's own order among messages made at once).
  if (items.length) out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  return out;
}

/** A `submit_review` call in a review thread, for review/stats.ts's backfill. */
export interface Submitted {
  thread_id: string;
  /** The task it reviews. */
  parent_id: string;
  at: string;
  id: string;
  input: any;
}

/**
 * Every `submit_review` call in review threads (not summaries' or workflows' steps'), but those the board refused (its
 * result says there was nothing to submit: a round that had ended), oldest first in each thread.
 */
export function submissions(c: Conn, mode: Mode = "auto"): Submitted[] {
  const reviews = "t.kind='review' AND COALESCE(t.task_type, '') NOT IN ('summary', 'workflow') AND t.parent_id IS NOT NULL";
  const out: Submitted[] = [];
  const rows = db.all<{ task_id: string; parent_id: string; created_at: string; data: string }>(
    c,
    `SELECT m.task_id, t.parent_id, m.created_at, m.data FROM messages m JOIN tasks t ON t.id=m.task_id
     WHERE ${reviews} AND ${reads(mode, "messages")} AND m.kind='claude' AND m.data LIKE '%submit_review%'
     ORDER BY m.id`,
  );
  // The calls the board refused: its answer says so.
  const refused = new Set<string>();
  const refusing = db.all<{ task_id: string; data: string }>(
    c,
    `SELECT m.task_id, m.data FROM messages m JOIN tasks t ON t.id=m.task_id
     WHERE t.kind='review' AND ${reads(mode, "messages")} AND m.kind='claude' AND m.data LIKE '%nothing to submit%'`,
  );
  for (const { task_id, data } of refusing) {
    let m: any;
    try {
      m = JSON.parse(data);
    } catch {
      continue;
    }
    const blocks = m?.message?.content;
    if (!Array.isArray(blocks)) continue;
    for (const b of blocks) {
      if (b?.type === "tool_result" && JSON.stringify(b).includes("nothing to submit") && typeof b.tool_use_id === "string") refused.add(`${task_id}\0${b.tool_use_id}`);
    }
  }
  for (const { task_id, parent_id, created_at, data } of rows) {
    let v: any;
    try {
      v = JSON.parse(data);
    } catch {
      continue;
    }
    const blocks = v?.message?.content;
    if (!Array.isArray(blocks)) continue;
    for (const b of blocks) {
      if (!(b?.type === "tool_use" && typeof b.name === "string" && b.name.endsWith("submit_review"))) continue;
      const id = typeof b.id === "string" ? b.id : "";
      if (refused.has(`${task_id}\0${id}`)) continue;
      out.push({ thread_id: task_id, parent_id, at: created_at, id, input: b.input });
    }
  }
  // (Reading messages only, it's run where the threads' tables may not be there yet: migration 79's backfill.)
  if (mode === "messages") return out;
  const calls = db.all<any>(
    c,
    `SELECT i.task_id, t.parent_id, i.pos, i.data, i.meta FROM thread_items i JOIN tasks t ON t.id=i.task_id
     WHERE ${reviews} AND ${reads(mode, "items")} AND i.type='tool_call' AND json_extract(i.data, '$.name') LIKE '%submit\\_review' ESCAPE '\\'
     ORDER BY i.task_id, i.pos`,
  );
  for (const r of calls) {
    const e = entry(r);
    if (e.item.type !== "tool_call" || !tool_name(e.item).endsWith("submit_review")) continue;
    if (e.item.result && JSON.stringify(e.item.result.content).includes("nothing to submit")) continue;
    out.push({ thread_id: r.task_id, parent_id: r.parent_id, at: e.item.created_at ?? "", id: call_id(e), input: e.item.input });
  }
  return out;
}

/**
 * The questions (request_user_input's and the merge gate's cards, `question` messages) still waiting for an answer in
 * `task_id`'s thread, oldest first, with their messages' data, which the caller updates (db.update_pending_message).
 * From items, they're the open question requests a `question` message made (`legacy:<message id>`; a question
 * prompt's request has the board's request id), and the data is their message's (db.get_message: its row, or for a
 * task whose items are its source, what the request keeps of it).
 */
export function open_questions(c: Conn, task_id: string, from = source(c, task_id)): Array<{ id: number; data: string }> {
  if (from === "messages") {
    return db.all(c, "SELECT id, data FROM messages WHERE task_id=?1 AND kind='question' AND json_extract(data, '$.status')='pending' ORDER BY id", task_id);
  }
  const out: Array<{ id: number; data: string }> = [];
  for (const r of db.all<{ id: string }>(c, "SELECT id FROM thread_requests WHERE task_id=?1 AND type='question' AND open=1 ORDER BY pos", task_id)) {
    const id = /^legacy:(\d+)$/.exec(r.id);
    if (!id) continue;
    const m = db.get_message(c, Number(id[1]), task_id);
    if (m?.kind === "question") out.push({ id: m.id, data: JSON.stringify(m.data) });
  }
  return out;
}

/**
 * Whether MCP call `call_id` has asked its question in `task_id`'s thread already (it's run again if a restart cuts it
 * short): a `question` message with its id, or for a task whose items are its source, a question request.
 */
export function asked(c: Conn, task_id: string, call_id: string): boolean {
  if (db.one(c, "SELECT 1 FROM tasks WHERE id=?1 AND thread_source='items'", task_id)) {
    return !!db.one(c, "SELECT 1 FROM thread_requests WHERE task_id=?1 AND type='question' AND json_extract(data, '$.metadata.call_id')=?2", task_id, call_id);
  }
  return !!db.one(c, "SELECT 1 FROM messages WHERE task_id=?1 AND kind='question' AND json_extract(data, '$.call_id')=?2", task_id, call_id);
}

/**
 * The routines' reports in the assistant's thread `task_id` it hasn't read yet (`read` isn't set), oldest first, as
 * their messages: `report` messages, or for a thread whose items are its source, `routine_report` notices, whose
 * metadata is the report (see db.get_message).
 */
export function unread_reports(c: Conn, task_id: string): db.Message[] {
  if (db.one(c, "SELECT 1 FROM tasks WHERE id=?1 AND thread_source='items'", task_id)) {
    const rows = db.all<{ id: string }>(
      c,
      `SELECT id FROM thread_items WHERE task_id=?1 AND type='notice' AND json_extract(data, '$.code')='routine_report'
       AND json_extract(data, '$.metadata.read') IS NOT 1 ORDER BY pos`,
      task_id,
    );
    return rows.flatMap((r) => {
      const id = message_of(r.id);
      const m = id === undefined ? null : db.get_message(c, id, task_id);
      return m ? [m] : [];
    });
  }
  return db.all(c, "SELECT * FROM messages WHERE task_id=?1 AND kind='report' AND json_extract(data,'$.read') IS NOT 1 ORDER BY id", task_id).map(db.Message_from_row);
}
