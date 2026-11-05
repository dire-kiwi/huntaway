// Clients' view of a task's thread kept as items (docs/threads-api.md): its snapshot and windows, pages of earlier
// items, its saved events after a seq, the commands it takes, and its events on the server's broadcast (`/api/ws`,
// relayed by a hub with each host's id like every other event).
//
// The port of HA-145's server/src/threads/live.rs and its handlers (on origin/ia/ha-128-implement-agent-threads-from-
// feasibility), changed for step 1's model: there's no backend or engine, the thread is read from threads/store.ts's
// tables (items kept in place, a short event log, no stored snapshots), and its own state is its task's. Commands go
// onto the board's own routes for sending, stopping, answering prompts, the mode and rewinding, unchanged.
//
// What writes a thread's items (step 3 of docs/threads.md) sends its events with `send_events` once they're
// committed, streamed text with `send_delta`, and `send_resync` when it changes a thread in a way its log doesn't
// describe (a rebuild).
import * as db from "../db.ts";
import type { Task } from "../db.ts";
import { ApiError, Reply } from "../http.ts";
import type { AppState } from "../state.ts";
import * as api from "../api.ts";
import * as store from "./store.ts";
import type {
  ItemPage, PermissionMode, QuestionRequest, Resolution, SavedEvent, Snapshot, Thread, ThreadEvent, ThreadStatus,
} from "./protocol.ts";

/** The most events `events` gives at once. */
export const MAX_EVENTS = 1000;
/** How many items a page has unless asked for another number. */
export const PAGE_ITEMS = 100;

// ---------- the thread ----------

/** Huntaway's permission modes (db.PERMISSION_MODES) as the model names them, and back. */
const MODES: Record<string, PermissionMode> = {
  default: "default",
  acceptEdits: "accept_edits",
  auto: "auto",
  plan: "plan",
  dontAsk: "dont_ask",
  bypassPermissions: "bypass",
};
const BOARD_MODES: Record<string, string> = Object.fromEntries(Object.entries(MODES).map(([board, mode]) => [mode, board]));

/**
 * Task `task_id`, if it has a thread kept as items: a 404 if there's no such task, or it has none (its thread is its
 * messages, at `/tasks/{id}/messages`).
 */
export function open(s: AppState, task_id: string): Task {
  const c = s.db();
  const task = db.get_task(c, task_id);
  if (!task) throw ApiError.not_found("task");
  if (!store.has_thread(c, task.id)) throw new ApiError(404, `task ${task.id} has no thread kept as items`);
  return task;
}

/** The task's thread's own state, which is the task's: none of it is kept with the items. */
export function thread_of(s: AppState, task: Task): Thread {
  const c = s.db();
  const running = s.is_running(task.id);
  const status: ThreadStatus = !running ? "idle" : store.open_requests(c, task.id).length ? "waiting" : "running";
  const t: Thread = { id: task.id, harness: db.task_is_codex(c, task) ? "codex" : "claude", status, title: task.title, created_at: task.created_at };
  if (task.model) t.model = task.model;
  if (task.effort) t.effort = task.effort;
  const mode = task.permission_mode ? MODES[task.permission_mode] : undefined;
  if (mode) t.permission_mode = mode;
  if (task.worktree_path) t.cwd = task.worktree_path;
  if (task.session_id) t.session_id = task.session_id;
  if (task.updated_at) t.updated_at = task.updated_at;
  return t;
}

/** The whole thread, or (with a `limit` it's over) a window of its last `limit` items, with the text streamed so far. */
export function window(s: AppState, task: Task, limit?: number): Snapshot {
  const w = store.window(s.db(), thread_of(s, task), limit);
  return with_streamed(s, w);
}

/** The thread's items before index `before` (a window's start), at most `limit` of them. */
export function page(s: AppState, task: Task, before: number, limit = PAGE_ITEMS): ItemPage {
  return store.page(s.db(), task.id, before, limit);
}

/** A page of a thread's saved events (see `events`). */
export interface Events {
  events: SavedEvent[];
  /** There are more after these: ask again after `seq`. */
  more: boolean;
  /**
   * How far these go, unknown events after the last of them included: where the next page starts, and (once they're
   * applied) the client's state's seq.
   */
  seq: number;
  /** The log doesn't go back to the seq asked for (or the client is past the thread's last): take a fresh window. */
  resync?: true;
}

/** The event types this build knows; a newer one's are left out of `events`, but gone past. */
const KNOWN = new Set(["thread.updated", "turn.started", "turn.completed", "item.added", "item.updated", "items.removed", "request.opened", "request.resolved"]);

/**
 * The thread's saved events after `after` that this build knows, at most `limit` of them. Event types it doesn't know
 * (a newer build's, read after a rollback) are left out but counted, so it reads on until it has `limit` and one more,
 * or there are no more. A client further behind than the log (or ahead of the thread, whose state is from something
 * else) is told to resync.
 */
export function events(s: AppState, task: Task, after: number, limit = MAX_EVENTS): Events {
  const c = s.db();
  limit = Math.max(1, Math.min(limit, MAX_EVENTS));
  const last = store.last_seq(c, task.id);
  if (after > last) return { events: [], more: false, seq: last, resync: true };
  const out: SavedEvent[] = [];
  let scanned = after;
  while (out.length <= limit) {
    const want = limit + 1 - out.length;
    const batch = store.events_after(c, task.id, scanned, want);
    if (batch === null) return { events: [], more: false, seq: last, resync: true };
    for (const e of batch) {
      scanned = Math.max(scanned, e.seq);
      if (KNOWN.has(e.type)) out.push(e);
    }
    if (batch.length < want) break;
  }
  const more = out.length > limit;
  out.length = Math.min(out.length, limit);
  // With more to come, the next page starts after the last event given; otherwise after all it read.
  return { events: out, more, seq: more ? out.at(-1)!.seq : scanned };
}

// ---------- live events ----------

/** The text streamed into each thread's items since they were last saved: task id → item id → text. */
interface Streamed {
  kind: "text" | "reasoning";
  text: string;
}
const streaming = new WeakMap<AppState, Map<string, Map<string, Streamed>>>();

function streamed_of(s: AppState, task_id: string, make: true): Map<string, Streamed>;
function streamed_of(s: AppState, task_id: string, make?: false): Map<string, Streamed> | undefined;
function streamed_of(s: AppState, task_id: string, make = false): Map<string, Streamed> | undefined {
  let all = streaming.get(s);
  if (!all) {
    if (!make) return undefined;
    streaming.set(s, (all = new Map()));
  }
  let mine = all.get(task_id);
  if (!mine && make) all.set(task_id, (mine = new Map()));
  return mine;
}

/** `state` with the text streamed into its items since they were saved (a snapshot taken mid-message, say). */
function with_streamed(s: AppState, state: Snapshot): Snapshot {
  const mine = streamed_of(s, state.thread.id);
  if (!mine?.size) return state;
  let changed = false;
  const items = state.items.map((item) => {
    const st = mine.get(item.id);
    if (!st || item.type !== (st.kind === "text" ? "assistant_message" : "reasoning")) return item;
    if (st.text.length <= item.text.length || !st.text.startsWith(item.text)) return item;
    changed = true;
    return { ...item, text: st.text };
  });
  return changed ? { ...state, items } : state;
}

/** Sends one thread event of task `task_id`'s to clients: `{type: "thread_event", task_id, event}`. */
function send(s: AppState, task_id: string, event: ThreadEvent): void {
  s.emit({ type: "thread_event", task_id, event });
}

/**
 * Sends task `task_id`'s saved events (as store.append returned them) to clients, once they're committed. What they
 * save of an item's text ends what was streamed into it.
 */
export function send_events(s: AppState, task_id: string, events: SavedEvent[]): void {
  const mine = streamed_of(s, task_id);
  for (const e of events) {
    if (mine?.size) {
      if (e.type === "item.added") mine.delete(e.item.id);
      else if (e.type === "item.updated" && "text" in e.patch) mine.delete(e.item_id);
      else if (e.type === "items.removed") for (const id of e.item_ids) mine.delete(id);
    }
    send(s, task_id, e);
  }
}

/**
 * Sends `text` streamed into item `item_id` (an assistant_message for `text`, a reasoning item for `reasoning`) of task
 * `task_id`'s thread to clients, as a delta from the text it has so far, with the seq of the thread's last saved event.
 * It isn't saved, but snapshots taken before the item's text is saved include it. Returns the event, or null if the
 * thread has no such item.
 */
export function send_delta(s: AppState, task_id: string, item_id: string, kind: "text" | "reasoning", text: string): ThreadEvent | null {
  const mine = streamed_of(s, task_id, true);
  let st = mine.get(item_id);
  if (!st || st.kind !== kind) {
    const item = store.get_item(s.db(), task_id, item_id);
    if (!item || item.type !== (kind === "text" ? "assistant_message" : "reasoning")) return null;
    st = { kind, text: item.text };
    mine.set(item_id, st);
  }
  const event: ThreadEvent = { type: "delta", thread_id: task_id, seq: store.last_seq(s.db(), task_id), item_id, kind, offset: st.text.length, text };
  st.text += text;
  send(s, task_id, event);
  return event;
}

/**
 * Tells clients that task `task_id`'s thread changed in a way its log doesn't say (its items were rebuilt, say), so
 * they take a fresh window: `{type: "thread_resync", task_id}`.
 */
export function send_resync(s: AppState, task_id: string): void {
  streaming.get(s)?.delete(task_id);
  s.emit({ type: "thread_resync", task_id });
}

/** Forgets what was streamed into a thread's items: its run ended without saving it (or the task went). */
export function forget_streamed(s: AppState, task_id: string): void {
  streaming.get(s)?.delete(task_id);
}

// ---------- commands ----------

const COMMANDS = ["send", "interrupt", "respond", "set_options", "rewind", "new_session", "compact"];

/** `body[k]`, if it's a string (or absent); a 400 otherwise. */
function str_field(body: any, k: string, required = false): string | undefined {
  const v = body[k];
  if (v === undefined || v === null) {
    if (required) throw ApiError.bad(`${k} is required`);
    return undefined;
  }
  if (typeof v !== "string") throw ApiError.bad(`${k} must be a string`);
  return v;
}

function bool_field(body: any, k: string): boolean | undefined {
  const v = body[k];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "boolean") throw ApiError.bad(`${k} must be true or false`);
  return v;
}

/**
 * Carries out `body`, a protocol Command, on task `task`'s thread, through the board's own route for it, which answers
 * as it does for the board (its result, or its error). Its `thread_id` may be left out: it's the task's, and another
 * task's is refused. Returns `{ok: true, result}`, with what the route answered.
 */
export async function command(s: AppState, task: Task, body: any): Promise<any> {
  if (body === null || typeof body !== "object" || Array.isArray(body)) throw ApiError.bad("a command is a JSON object");
  if (body.thread_id !== undefined && body.thread_id !== null && body.thread_id !== task.id) {
    throw ApiError.bad(`thread ${JSON.stringify(body.thread_id)} isn't this task's (its thread is ${task.id})`);
  }
  const type = body.type;
  if (typeof type !== "string" || !COMMANDS.includes(type)) throw ApiError.bad(`type must be one of ${COMMANDS.join(", ")}`);
  const id = encodeURIComponent(task.id);
  switch (type) {
    case "send": {
      const text = str_field(body, "text", true)!;
      // The composer uploads files (POST /attachments) and links them in the text.
      if (Array.isArray(body.attachments) && body.attachments.length) {
        throw ApiError.bad("attachments aren't taken here: upload them with POST /api/attachments and link them in the text");
      }
      return await route(s, "POST", `/api/tasks/${id}/messages`, { text });
    }
    case "compact":
      // As the composer's `/compact`: it waits for a running turn to end.
      return await route(s, "POST", `/api/tasks/${id}/messages`, { text: "/compact" });
    case "interrupt":
      return await route(s, "POST", `/api/tasks/${id}/stop`, null);
    case "set_options": {
      const patch: Record<string, any> = {};
      for (const k of ["model", "effort"]) {
        if (body[k] !== undefined) patch[k] = body[k];
      }
      if (body.permission_mode !== undefined && body.permission_mode !== null) {
        const mode = BOARD_MODES[body.permission_mode];
        if (!mode) throw ApiError.bad(`permission_mode must be one of ${Object.keys(BOARD_MODES).join(", ")}`);
        patch.permission_mode = mode;
      }
      if (!Object.keys(patch).length) throw ApiError.bad("set_options needs model, effort or permission_mode");
      return await route(s, "PATCH", `/api/tasks/${id}`, patch);
    }
    case "rewind":
      return await route(s, "POST", `/api/tasks/${id}/rewind`, rewind_body(s, task, body));
    case "respond":
      return await respond(s, task, body);
    case "new_session":
      return { ok: true, result: new_session(s, task) };
  }
  throw ApiError.bad(`type must be one of ${COMMANDS.join(", ")}`);
}

/** A request to this host's own API, as the board makes it: `{ok: true, result}`, or the route's error as it is. */
async function route(s: AppState, method: string, path: string, body: any): Promise<any> {
  const [status, out] = await api.local_request(s, method, path, body === null ? null : Buffer.from(JSON.stringify(body)));
  if (status >= 400) return new Reply(status, out);
  return { ok: true, result: out };
}

/**
 * The rewind route's body for a `rewind` command: back to before the user message `item_id` (Huntaway's), or the
 * first of turn `turn_id`'s, with `conversation` and `branch` as the route takes them.
 */
function rewind_body(s: AppState, task: Task, body: any): any {
  const c = s.db();
  const item_id = str_field(body, "item_id");
  const turn_id = str_field(body, "turn_id");
  if (!item_id && !turn_id) throw ApiError.bad("rewind needs the user message's item_id (or a turn_id)");
  let item = item_id ? store.get_item(c, task.id, item_id) : null;
  if (!item_id) item = store.items(c, task.id).find((i) => i.type === "user_message" && i.turn_id === turn_id) ?? null;
  if (!item) throw ApiError.not_found(item_id ? "item" : "turn");
  if (item.type !== "user_message") throw ApiError.bad("a rewind goes back to before a user message");
  const message_id = store.item_origins(c, task.id, item.id)[0];
  if (message_id === undefined) throw ApiError.conflict("the message this item came from isn't known");
  const out: Record<string, any> = { message_id };
  for (const k of ["conversation", "branch"]) {
    const v = bool_field(body, k);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/**
 * Answers the thread's request `request_id` with `resolution`: a permission prompt (a tool's, a plan's or Claude's
 * questions) through POST /permissions/{id}, and a question the agent asked with request_user_input through POST
 * /tasks/{id}/questions/{message_id}. Only the task's own requests are reached.
 */
async function respond(s: AppState, task: Task, body: any): Promise<any> {
  const request_id = str_field(body, "request_id", true)!;
  const res: Resolution = body.resolution;
  if (res === null || typeof res !== "object" || Array.isArray(res)) throw ApiError.bad("resolution must be an object");
  if (!["allow", "deny", "answer", "cancel"].includes(res.outcome)) throw ApiError.bad("resolution.outcome must be allow, deny, answer or cancel");
  const c = s.db();
  const request = store.get_request(c, task.id, request_id);
  if (!request) throw ApiError.not_found("request");
  const message = typeof res.message === "string" ? res.message : null;
  // A permission prompt's request has its permission_requests row's id.
  if (db.one(c, "SELECT 1 FROM permission_requests WHERE id=?1 AND task_id=?2", request_id, task.id)) {
    const path = `/api/permissions/${encodeURIComponent(request_id)}`;
    if (request.type === "question") {
      if (res.outcome !== "answer") return await route(s, "POST", path, { decision: "deny", message });
      return await route(s, "POST", path, { decision: "allow", answers: answers_in_order(request, res) });
    }
    if (res.outcome === "answer") throw ApiError.bad(`a ${request.type} request is answered with allow or deny`);
    const allow = res.outcome === "allow";
    if (request.type === "plan") {
      const mode = res.permission_mode ? BOARD_MODES[res.permission_mode] : undefined;
      if (res.permission_mode && !mode) throw ApiError.bad(`permission_mode must be one of ${Object.keys(BOARD_MODES).join(", ")}`);
      // Denied, its message is the user's feedback on the plan.
      return await route(s, "POST", path, allow ? { decision: "allow", mode: mode ?? null } : { decision: "deny", feedback: message });
    }
    return await route(s, "POST", path, { decision: allow ? (res.always ? "allow_always" : "allow") : "deny", message });
  }
  // A request_user_input question's is `legacy:<its message's id>`.
  const m = /^legacy:(\d+)$/.exec(request_id);
  if (request.type === "question" && m && db.one(c, "SELECT 1 FROM messages WHERE id=?1 AND task_id=?2 AND kind='question'", Number(m[1]), task.id)) {
    if (res.outcome !== "answer") throw ApiError.bad("this question is answered (outcome answer), or replied to with a send");
    const options = new Set((request.questions[0].options ?? []).map((o) => o.label));
    const given = answers_in_order(request, res)[0] ?? [];
    const choices = given.filter((a) => options.has(a));
    const typed = given.filter((a) => !options.has(a));
    if (typed.length > 1) throw ApiError.bad("this question takes one answer of your own");
    return await route(s, "POST", `/api/tasks/${encodeURIComponent(task.id)}/questions/${m[1]}`, { choices, text: typed[0] ?? null });
  }
  throw ApiError.conflict(`request ${request_id} can't be answered: the board isn't waiting on it`);
}

/** A question request's answers, as lists in the order of its questions (as the permission route takes them). */
function answers_in_order(request: QuestionRequest, res: Resolution): string[][] {
  const given = res.answers;
  if (given === undefined || given === null || typeof given !== "object" || Array.isArray(given)) throw ApiError.bad("resolution.answers must be an object");
  return request.questions.map((q) => {
    const a = given[q.id] ?? [];
    if (!Array.isArray(a) || !a.every((x) => typeof x === "string")) throw ApiError.bad(`resolution.answers.${q.id} must be a list of strings`);
    return a;
  });
}

/** The next message starts a new conversation with the agent; the thread's items stay. Refused while it runs. */
function new_session(s: AppState, task: Task): Task {
  if (s.is_running(task.id)) throw ApiError.conflict("The agent is running: stop it before starting a new conversation");
  if (task.session_id == null) return task;
  const t = s.update_task(task.id, [["session_id", null], ["rewind", null], ["context", null]]);
  if (!t) throw ApiError.not_found("task");
  s.add_event(task.id, "info", "The next message starts a new conversation with the agent");
  return t;
}
