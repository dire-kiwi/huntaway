// A task's stored messages as thread items (threads/protocol.ts): the one translator from the slimmed messages the
// board keeps in `messages` (agent/runner/output.ts's slim, the board's own user, event, permission and question rows,
// and Codex's runs as agent/codex/output.ts shapes them like Claude's) to the events threads/store.ts saves.
//
// It's a fold: a Translator takes a task's messages one at a time, in id order, and gives for each the events it makes
// (`item.added`, `item.updated`, `request.opened`, `request.resolved`), what became of it (its disposition: converted
// into items or requests, redundant because other items say what it does, or kept only in the source, with a warning
// saying why), and what the board knows about the items that they don't say themselves (ItemMeta, kept in
// thread_items.meta). It's pure: it reads nothing and writes nothing. The live path (AppState.add_message, step 3 of
// docs/threads.md) and batch rebuilds (`huntaway threads-import`, and step 7's) call the same code. A Translator's state
// (the open tool calls, the subagents, the requests) can be rebuilt from the items, requests and metas it made
// (`Translator.from`), so a server that restarts goes on from the store.
//
// Ids are stable, so translating the same messages again gives the same events: tool calls keep Claude's (or Codex's)
// ids, other items are `legacy:<message id>` or `legacy:<message id>:<block>`, and requests keep the board's request
// ids. Turns aren't made up: items have no `turn_id`, and there are no turn events.
//
// The port of HA-128's server/src/threads/import.rs (on origin/ia/ha-128-implement-agent-threads-from-feasibility, at
// its converter version 6), which read a whole task's messages at once and looked ahead: a result, a prompt or a
// subagent's messages stored before their call were matched to it by an index of every call first. Here they wait for
// it instead (`early`, `waiting_prompts`, `missing_parents`): a result is held until its call comes, a prompt names the
// call by its id (which the call's item will have) or is linked when a call with its id and input comes, and an item
// names its parent by the parent's tool_use id, which is its call's item's. What's held is in memory only: a Translator rebuilt in between
// warns about them as if they never came (see `from`). `finish` says what a history that has ended leaves undone.

import type {
  Item, NewEvent, PermissionMode, PermissionRequest, Question, QuestionRequest, Resolution, Snapshot, SubagentState, SubagentStatus, ThreadRequest, ToolCall, ToolKind, ToolStatus,
} from "./protocol.ts";

/**
 * Changes when what the translator makes of the same messages does: threads built by it record it (`threads.converter`),
 * and `huntaway threads-rebuild` brings them up to date. 2: a merge-gate card settled as `replaced` is a cancel with a
 * message, without a warning; a prompt that's pending again reopens its request. 3 (HA-218, for the thread view on
 * items): items and requests carry the board's `metadata` (an auto message, a turn's cost and turns, a compaction's
 * tokens after, a request's stored prompt or question and its message id, replaced in place when it changes, a result's
 * text that no message said), subagents their `ended_at`,
 * and a routine's report is a notice (`routine_report`).
 */
export const CONVERTER_VERSION = 3;

/** How Claude Code's result for a call that was stopped starts. */
const REJECTED = "The user doesn't want to proceed with this tool use.";

/** Tool results longer than this were cut short when they were stored (agent/runner/output.ts's slim). */
const STORED_RESULT_MAX = 30_000;

// The tools whose prompts are questions or plans (mcp/permissions.ts's, which this doesn't import, to stay pure).
export const EXIT_PLAN = "ExitPlanMode";
export const ASK_USER = "AskUserQuestion";
export const CODEX_QUESTIONS = "request_user_input";
/** The MCP server whose tools are the app's own (`app` calls, not `mcp` ones), as agent-threads names it. */
const APP_SERVER = "app";

/** A stored message, as db/messages.ts reads it. */
export interface Message {
  id: number;
  kind: string;
  data: any;
  created_at: string;
}

/** What a stored message became. */
export type Disposition = "converted" | "redundant" | "retained";

export interface Warning {
  message_id: number | null;
  code: string;
  text: string;
}

/**
 * What the board knows about an item that the item doesn't say (HA-128's history::Origin), kept in thread_items.meta.
 * The message an item came from is in thread_item_origins, and a `legacy:<message id>[:<block>]` id says it too.
 */
export interface ItemMeta {
  /** A user_message the board sent for itself (the start of a task, review issues to fix, a merge). */
  auto?: boolean;
  /** A user_message that other agents sent all of (`send_to_task`). */
  from_agent?: boolean;
  /** Of a user_message sent along with other agents' messages, the user's own part. */
  user_text?: string;
  /** Of a tool_call, the harness's id for the call where the item's isn't it (a thread with two calls with one id). */
  call_id?: string;
  /** Of a tool_call, the harness's session it was made in: calls with one id are told apart by it. */
  session?: string;
  /** Of a subagent's tool_call, Claude's id for the subagent (its task_started's `task_id`), which its task_* messages name it by. */
  subagent_task?: string;
  /** Of a tool_call, the ids of the background tasks it started that other items show (a Bash command's run). */
  shown_tasks?: string[];
  /** Of a turn_result, the text its result gave (what the turn ended by saying, or its error): what the agent said last there. */
  result_text?: string;
  /** Of an assistant_message, it's a result's text that no message of its turn said: its turn_result's `result_text` has it. */
  from_result?: boolean;
}

/** What one message gave. */
export interface Step {
  message_id: number;
  disposition: Disposition;
  /** The events, to append (with the message's id as their origin). */
  events: NewEvent[];
  /** The items it made or changed, and the requests it made or resolved. */
  ids: string[];
  warnings: Warning[];
  /** The items whose meta it set, with all of their meta now. */
  meta: Map<string, ItemMeta>;
}

/** What `finish` gives: the events that end what the history left open, and the messages that never found their call. */
export interface Finish {
  events: NewEvent[];
  warnings: Warning[];
  /** Messages given as converted while they waited for their call (a result stored before it), which never came. */
  retained: number[];
  meta: Map<string, ItemMeta>;
}

/** A tool call so far. */
interface Call {
  item: string;
  /** The harness's id for it (the item's, but for a second call with one id). */
  call_id: string;
  kind: ToolKind;
  status: ToolStatus;
  title?: string;
  has_result: boolean;
  subagent?: SubagentState;
  /** The model its input asks for (a subagent's). */
  model?: string;
  /** The tool_use id of the subagent call it was made in, as its message said. */
  parent_raw: string | null;
  session?: string;
  input: unknown;
}

/** What a claude task_* message's `task_id` is about. */
type Job = { agent: string } | "shown";

/** A tool_result waiting for its call (stored before it). */
interface EarlyResult {
  message_id: number;
  created_at: string;
  block: any;
  meta: any;
  parent_raw: string | null;
  session?: string;
}

/** A prompt for a call with an id the thread has, but none of whose calls asked it: it waits for one with its input. */
interface WaitingPrompt {
  message_id: number;
  request: string;
  input: unknown;
  /** It's linked to the one call with the id for now. */
  linked: boolean;
}

const is_obj = (v: unknown): v is Record<string, any> => v !== null && typeof v === "object" && !Array.isArray(v);
/** A string field, if it's a string that isn't empty. */
const str = (v: any, name: string): string | undefined => {
  const s = is_obj(v) ? v[name] : undefined;
  return typeof s === "string" && s !== "" ? s : undefined;
};
const uint = (v: unknown): number | undefined => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : undefined);
/** Whether two sessions can be the same one: they are, or one isn't known. */
const same_session = (a: string | undefined, b: string | undefined) => a === undefined || b === undefined || a === b;
/** Deep equality of JSON values (the order of objects' keys doesn't count). */
function same_json(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => same_json(x, b[i]));
  if (!is_obj(a) || !is_obj(b)) return (a ?? null) === (b ?? null);
  const ka = Object.keys(a).filter((k) => a[k] !== undefined);
  const kb = Object.keys(b).filter((k) => b[k] !== undefined);
  return ka.length === kb.length && ka.every((k) => k in b && same_json(a[k], b[k]));
}
const legacy_message = (id: string) => {
  const m = /^legacy:(\d+)/.exec(id);
  return m ? Number(m[1]) : undefined;
};

export class Translator {
  /** Every item's id, so none is added twice. */
  private items = new Set<string>();
  /** The tool calls, by item id. */
  private calls = new Map<string, Call>();
  /** The items of the calls with each tool_use id, in order. */
  private by_call = new Map<string, string[]>();
  /** Claude's task ids (task_started) → what they are. */
  private jobs = new Map<string, Job>();
  private requests = new Map<string, ThreadRequest>();
  private meta = new Map<string, ItemMeta>();
  /** By parent ("" for the main conversation), the latest item if it's a compaction, which a synthetic summary goes into. */
  private compaction = new Map<string, string>();
  /** The session the messages were last in. */
  private last_session: string | undefined;
  /** The session the messages were last in, as far as they said. */
  get session(): string | undefined {
    return this.last_session;
  }
  /**
   * The text of the main conversation's latest assistant message with some, since the last turn ended or the user's last
   * message: what a turn's result usually says again.
   */
  private last_text: string | null = null;
  // Held for what hasn't come yet (in memory only: see the top of the file).
  private early = new Map<string, EarlyResult[]>();
  private waiting_prompts = new Map<string, WaitingPrompt[]>();
  /** Messages whose parent call isn't in the thread (yet), by its tool_use id: if it never comes, they're warned about. */
  private missing_parents = new Map<string, number[]>();
  private step!: Step;

  /**
   * A translator that goes on from a thread's stored state: its items in order, its requests, and their metas. What it
   * held in memory for messages that hadn't found their call is lost: those messages are as if their call never came.
   */
  static from(items: readonly Item[], requests: readonly ThreadRequest[], meta: (id: string) => ItemMeta | null | undefined): Translator {
    const t = new Translator();
    t.step = new_step(0);
    for (const r of requests) t.requests.set(r.id, r);
    for (const item of items) {
      t.items.add(item.id);
      const m = meta(item.id);
      if (m) t.meta.set(item.id, m);
      t.note_compaction(item);
      if (item.type !== "tool_call") continue;
      const call_id = m?.call_id ?? item.id;
      const parent = item.parent_id ? t.calls.get(item.parent_id) : undefined;
      const input = item.input;
      t.add_call({
        item: item.id,
        call_id,
        kind: item.kind,
        status: item.status,
        title: item.title,
        has_result: item.result !== undefined,
        subagent: item.subagent,
        model: str(input, "model"),
        parent_raw: parent ? parent.call_id : (item.parent_id ?? null),
        session: m?.session,
        input,
      });
      if (m?.session) t.last_session = m.session;
      if (m?.subagent_task) t.jobs.set(m.subagent_task, { agent: item.id });
      for (const job of m?.shown_tasks ?? []) t.jobs.set(job, "shown");
    }
    // What the latest turn has said so far: its latest main assistant message with text.
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i]!;
      if (item.type === "user_message" || item.type === "turn_result") break;
      if (item.type !== "assistant_message" || item.parent_id) continue;
      const message = legacy_message(item.id);
      const texts: string[] = [];
      for (let j = i; j >= 0; j--) {
        const it = items[j]!;
        if (it.type === "user_message" || it.type === "turn_result") break;
        if (it.type === "assistant_message" && !it.parent_id && message !== undefined && legacy_message(it.id) === message) texts.unshift(it.text);
      }
      t.last_text = texts.length ? texts.join("\n") : item.text;
      break;
    }
    return t;
  }

  /** What message `m` gives. Messages go in id order. */
  message(m: Message): Step {
    this.step = new_step(m.id);
    const data = is_obj(m.data) ? m.data : {};
    const msg = { ...m, data };
    let d: Disposition;
    switch (m.kind) {
      case "user":
        d = this.user(msg);
        break;
      case "event":
        d = this.event(msg);
        break;
      case "permission":
        d = this.permission(msg);
        break;
      case "question":
        d = this.question(msg);
        break;
      case "claude":
        d = this.claude(msg);
        break;
      case "report":
        d = this.report(msg);
        break;
      default:
        d = this.retain(m.id, "unknown_kind", `a message of kind ${m.kind}`);
    }
    this.step.disposition = d;
    return this.step;
  }

  /**
   * The history has ended (an import of a task's messages, which nothing will add to): calls still waiting for a result
   * never got one, and are cancelled; subagents that never said they ended are stopped; prompts nobody answered are
   * cancelled; and what waited for a call that never came is warned about.
   */
  finish(): Finish {
    this.step = new_step(0);
    let calls = 0;
    let agents = 0;
    for (const c of this.calls.values()) {
      const running = c.status === "running" || c.status === "pending";
      const agent = c.subagent?.status === "running";
      if (!running && !agent) continue;
      const patch: Record<string, unknown> = {};
      if (running) {
        patch.status = c.status = "cancelled";
        calls++;
      }
      if (agent) {
        patch.subagent = c.subagent = { ...c.subagent!, status: "stopped" };
        agents++;
      }
      this.update(c.item, patch);
    }
    if (calls) this.warn(null, "no_result", `${calls} tool calls have no result; imported as cancelled`);
    if (agents) this.warn(null, "subagent_running", `${agents} subagents never said they ended; imported as stopped`);
    for (const r of this.requests.values()) {
      if (r.resolution) continue;
      this.warn(null, "open_prompt", `request ${r.id} is still waiting for an answer; imported as cancelled`);
      this.resolve(r.id, { outcome: "cancel", message: "Not answered before the thread was imported" });
    }
    const retained: number[] = [];
    for (const [call, list] of this.early) {
      for (const e of list) {
        this.warn(e.message_id, "orphan_result", `a result for call ${JSON.stringify(call)}, which isn't in the thread`);
        retained.push(e.message_id);
      }
    }
    for (const [call, list] of this.waiting_prompts) {
      for (const p of list.filter((p) => !p.linked)) this.warn(p.message_id, "ambiguous_call", `a prompt for call ${call}, which no call with the id and its input asked`);
    }
    for (const [parent, list] of this.missing_parents) {
      for (const id of list) this.warn(id, "missing_parent", `its parent call ${parent} isn't in the thread`);
    }
    this.early.clear();
    this.waiting_prompts.clear();
    this.missing_parents.clear();
    const { events, warnings, meta } = this.step;
    return { events, warnings, retained: [...new Set(retained)], meta };
  }

  // ---------- building events ----------

  private warn(message_id: number | null, code: string, text: string): void {
    this.step.warnings.push({ message_id, code, text });
  }

  private retain(message_id: number, code: string, text: string): Disposition {
    this.warn(message_id, code, text);
    return "retained";
  }

  private touch(id: string): void {
    if (!this.step.ids.includes(id)) this.step.ids.push(id);
  }

  private note_compaction(item: Item): void {
    const parent = item.parent_id ?? "";
    if (item.type === "compaction") this.compaction.set(parent, item.id);
    else this.compaction.delete(parent);
  }

  private add(item: Item): void {
    if (this.items.has(item.id)) throw new Error(`item ${item.id} added twice`);
    this.items.add(item.id);
    this.note_compaction(item);
    this.touch(item.id);
    this.step.events.push({ type: "item.added", item });
  }

  private update(id: string, patch: Record<string, unknown>): void {
    this.touch(id);
    this.step.events.push({ type: "item.updated", item_id: id, patch });
  }

  private set_meta(id: string, fields: ItemMeta): void {
    const next: ItemMeta = { ...this.meta.get(id) };
    let changed = false;
    for (const [k, v] of Object.entries(fields) as [keyof ItemMeta, any][]) {
      if (v === undefined || v === false || same_json(next[k], v)) continue;
      (next as any)[k] = v;
      changed = true;
    }
    if (!changed) return;
    this.meta.set(id, next);
    this.step.meta.set(id, next);
  }

  /** Opens `request`, or replaces the one with its id in place (with `request`'s resolution, so none reopens it). */
  private open(request: ThreadRequest): void {
    this.requests.set(request.id, request);
    this.touch(request.id);
    this.step.events.push({ type: "request.opened", request });
  }

  private resolve(id: string, resolution: Resolution): void {
    const r = this.requests.get(id);
    if (r) this.requests.set(id, { ...r, resolution });
    this.touch(id);
    this.step.events.push({ type: "request.resolved", request_id: id, resolution });
  }

  private add_call(c: Call): void {
    this.calls.set(c.item, c);
    const list = this.by_call.get(c.call_id);
    if (list) list.push(c.item);
    else this.by_call.set(c.call_id, [c.item]);
  }

  private calls_with(call_id: string): Call[] {
    return (this.by_call.get(call_id) ?? []).map((id) => this.calls.get(id)!);
  }

  /** Whether the call's prompt was denied (or its plan sent back), so its error result is a denial. */
  private denied(item: string): boolean {
    for (const r of this.requests.values()) if (r.tool_call_id === item && r.type !== "question" && r.resolution?.outcome === "deny") return true;
    return false;
  }

  // ---------- parents ----------

  /**
   * The item of the subagent call that `parent` (a tool_use id) names, for an item's `parent_id`, made in `session`: the
   * one with the id in the same session. A call the thread doesn't have keeps its id (its item's, if it comes later).
   * Err (with a warning) if there's no telling which call it is: the item can't be put in the main conversation instead.
   */
  private parent(message_id: number, parent: string | undefined, session: string | undefined): { ok: string | undefined } | null {
    if (parent === undefined) return { ok: undefined };
    const all = this.calls_with(parent);
    if (!all.length) {
      // A subagent's messages can be stored before its call: it may come yet.
      const list = this.missing_parents.get(parent);
      if (list) list.push(message_id);
      else this.missing_parents.set(parent, [message_id]);
      return { ok: parent };
    }
    const found = all.filter((c) => same_session(c.session, session));
    if (found.length !== 1) {
      this.warn(message_id, "ambiguous_parent", `its parent call ${parent} could be any of ${found.length} calls with the id`);
      return null;
    }
    const c = found[0]!;
    if (c.kind !== "subagent") this.warn(message_id, "parent_not_subagent", `its parent ${parent} is a ${c.kind} call, not a subagent's`);
    return { ok: c.item };
  }

  private parent_of(m: Message): { ok: string | undefined } | null {
    return this.parent(m.id, str(m.data, "parent_tool_use_id"), str(m.data, "session_id"));
  }

  // ---------- the board's messages ----------

  private user(m: Message): Disposition {
    const d = m.data;
    this.last_text = null;
    const id = `legacy:${m.id}`;
    const item: Item = { id, type: "user_message", text: typeof d.text === "string" ? d.text : "", created_at: m.created_at };
    if (d.steered === true) item.steered = true;
    if (d.auto === true) item.metadata = { auto: true };
    this.add(item);
    this.set_meta(id, { auto: d.auto === true, from_agent: d.from_agent === true, user_text: typeof d.user_text === "string" ? d.user_text : undefined });
    return "converted";
  }

  private event(m: Message): Disposition {
    const d = m.data;
    let level: "info" | "warning" | "error";
    if (d.level === "error") level = "error";
    else if (d.level === "warn" || d.level === "warning") level = "warning";
    else if (d.level === "info") level = "info";
    else {
      this.warn(m.id, "unknown_level", `an event of level ${JSON.stringify(d.level ?? null)}, shown as info`);
      level = "info";
    }
    const item: Item = { id: `legacy:${m.id}`, type: "notice", level, text: typeof d.text === "string" ? d.text : "", created_at: m.created_at };
    const detail = str(d, "detail");
    if (detail !== undefined) item.detail = detail;
    this.add(item);
    return "converted";
  }

  /** A routine's report in the assistant's thread (API 110): a notice, with the whole report as its metadata. */
  private report(m: Message): Disposition {
    const d = m.data;
    const level = d.outcome === "failed" ? "error" : "info";
    this.add({ id: `legacy:${m.id}`, type: "notice", level, code: "routine_report", text: str(d, "text") ?? "", created_at: m.created_at, metadata: { ...d } });
    return "converted";
  }

  /** A prompt's resolution from its stored status; undefined while it's waiting for an answer. */
  private resolution(m: Message, what: string): Resolution | undefined {
    const note = str(m.data, "note");
    const with_note = (outcome: "allow" | "deny"): Resolution => (note !== undefined ? { outcome, message: note } : { outcome });
    switch (m.data.status) {
      case "allowed":
        return with_note("allow");
      case "denied":
        return with_note("deny");
      case "expired":
        return { outcome: "cancel", message: "Expired: its run ended before it was answered" };
      case "replaced":
        // A merge-gate card (review/merge_gate.ts's settle).
        return { outcome: "cancel", message: "No longer asked: its merge was left, or a newer question replaced it" };
      case "pending":
        return undefined;
      default:
        this.warn(m.id, "unknown_status", `${what} has status ${JSON.stringify(m.data.status ?? null)}; imported as cancelled`);
        return { outcome: "cancel" };
    }
  }

  /**
   * Opens `request` with `resolution`, or for a message seen before (its status changed since), resolves the request it
   * made with what its status says now: a question or plan whose run ended (expired, so cancelled) can still be answered
   * late (mcp/permissions.ts's `answer`), and the stored status is the truth. One that's waiting again (a question whose
   * answer couldn't be sent is answerable again, see mcp/questions.ts) is opened again, with no resolution, as a rebuild
   * from the message would have it. Redundant if that changes nothing.
   */
  private request(request: ThreadRequest, resolution: Resolution | undefined): Disposition {
    const was = this.requests.get(request.id);
    if (was) {
      // What the board keeps of it changed (its status, a note, a plan's mode...): it's replaced in place, keeping its
      // resolution, which a request.resolved then changes.
      const changed = !same_json(was.metadata, request.metadata);
      if (!resolution) {
        if (!was.resolution && !changed) return "redundant";
        this.open(request);
        return "converted";
      }
      const resolved = !same_json(was.resolution, resolution);
      if (!resolved && !changed) return "redundant";
      if (changed) this.open(was.resolution ? { ...request, resolution: was.resolution } : request);
      if (resolved) this.resolve(request.id, resolution);
      return "converted";
    }
    this.open(request);
    if (resolution) this.resolve(request.id, resolution);
    return "converted";
  }

  /**
   * The call a prompt for tool_use id `id` (with `input`) is for. With no call with the id yet, it's the one to come (the
   * first call with an id has it as its item's). With one, it's that one if it could still ask (it has no result) or has
   * the input; with several, the one with the input that could still ask in the current session. With none that could,
   * the prompt waits for a call with its id and input to come (`waiting_prompts`); with several, there's no telling.
   */
  private prompted(message_id: number, request_id: string, id: string, input: unknown): Call | string | undefined {
    const all = this.calls_with(id);
    if (!all.length) return id;
    const found = all.filter((c) => !c.has_result && same_session(c.session, this.last_session) && same_json(c.input, input));
    if (found.length === 1) return found[0];
    if (found.length > 1) {
      this.warn(message_id, "ambiguous_call", `a prompt for call ${id}, which ${found.length} calls with the id and its input could have asked`);
      return undefined;
    }
    if (all.length === 1 && same_json(all[0]!.input, input)) return all[0];
    // The one call that could still ask, whose input the prompt's needn't be quite (Codex's approvals say less): its
    // for now, unless a call with the id and the input comes.
    const only = all.length === 1 && !all[0]!.has_result ? all[0] : undefined;
    const list = this.waiting_prompts.get(id);
    const p = { message_id, request: request_id, input, linked: !!only };
    if (list) list.push(p);
    else this.waiting_prompts.set(id, [p]);
    return only;
  }

  private permission(m: Message): Disposition {
    const d = m.data;
    const id = str(d, "request_id") ?? `legacy:${m.id}`;
    const tool = typeof d.tool_name === "string" ? d.tool_name : "";
    const input = d.input ?? {};
    const call = str(d, "tool_use_id");
    const base: { id: string; created_at: string; tool_call_id?: string; parent_id?: string; metadata?: { [k: string]: unknown } } = { id, created_at: m.created_at };
    // The call it's for, the first time the thread sees it.
    if (call !== undefined && !this.requests.has(id)) {
      const c = this.prompted(m.id, id, call, input);
      if (typeof c === "string") base.tool_call_id = c;
      else if (c) {
        base.tool_call_id = c.item;
        const p = this.calls.get(c.item)!;
        const parent = p.parent_raw === null ? undefined : (this.calls_with(p.parent_raw).find((x) => same_session(x.session, p.session))?.item ?? p.parent_raw);
        if (parent !== undefined) base.parent_id = parent;
      }
    } else if (this.requests.has(id)) {
      const was = this.requests.get(id)!;
      if (was.tool_call_id) base.tool_call_id = was.tool_call_id;
      if (was.parent_id) base.parent_id = was.parent_id;
    }
    let resolution = this.resolution(m, "a prompt");
    // The prompt as the board keeps it, for its card (a plan's or question's input too, which the request only has in
    // part), and the message it's kept in, which the board orders and keys it by.
    base.metadata = { ...d, message_id: m.id };
    let request: ThreadRequest;
    if (tool === EXIT_PLAN) {
      request = { ...base, type: "plan", plan: typeof input?.plan === "string" ? input.plan : "" };
      // The mode the user approved it to carry on in.
      const mode = typeof d.mode === "string" ? permission_mode(d.mode) : undefined;
      if (resolution?.outcome === "allow" && mode) resolution = { ...resolution, permission_mode: mode };
    } else if (tool === ASK_USER || tool === CODEX_QUESTIONS) {
      const asked: any[] = Array.isArray(input?.questions) ? input.questions : [];
      // Claude's questions are told apart by their text (unless two have the same), and always offer an answer of one's own.
      const texts = asked.map((q) => (typeof q?.question === "string" ? q.question : ""));
      const by_text = tool === ASK_USER && texts.every((t, i) => t && texts.indexOf(t) === i);
      const questions = asked.map((q: any, i: number) => {
        const out = question(q, str(q, "id") ?? (by_text ? texts[i]! : String(i)));
        if (tool === ASK_USER) out.allow_other = true;
        return out;
      });
      if (!questions.length) return this.retain(m.id, "empty_question", "a question prompt with no questions");
      if (resolution?.outcome === "allow") {
        const answers = answers_of(d.answers, questions);
        if (!answers) this.warn(m.id, "missing_answers", "an answered question prompt whose answers can't be read");
        resolution = { outcome: "answer", answers: answers ?? {} };
      } else if (resolution?.outcome === "deny") {
        resolution = { ...resolution, outcome: "cancel" };
      }
      request = { ...base, type: "question", questions: questions as QuestionRequest["questions"] };
    } else {
      const fields = tool_fields(tool, input);
      // The board's own approvals (a project change, deleting a task, an automation) are for its tools.
      const kind: ToolKind = typeof d.kind === "string" && d.kind !== "tool" ? "app" : fields.kind;
      const { input: _, ...metadata } = base.metadata!;
      const r: PermissionRequest = { ...base, metadata, type: "permission", kind, name: fields.name, input };
      if (fields.server !== undefined && kind === "mcp") r.server = fields.server;
      r.title = title(fields);
      request = r;
    }
    return this.request(request, resolution);
  }

  /** A question asked with the board's request_user_input (or the merge gate's card). */
  private question(m: Message): Disposition {
    const d = m.data;
    const q = question(d, "q");
    let resolution: Resolution | undefined;
    if (d.status === "answered") {
      const answer: string[] = Array.isArray(d.answer?.choices) ? d.answer.choices.filter((c: unknown) => typeof c === "string") : [];
      const text = str(d.answer, "text");
      if (text !== undefined) answer.push(text);
      resolution = { outcome: "answer", answers: { q: answer } };
    } else if (d.status === "replied") {
      resolution = { outcome: "cancel", message: "Answered with a message instead" };
    } else {
      resolution = this.resolution(m, "a question");
    }
    return this.request({ id: `legacy:${m.id}`, type: "question", questions: [q], created_at: m.created_at, metadata: { ...d, message_id: m.id } }, resolution);
  }

  // ---------- Claude's messages (and Codex's, shaped like them) ----------

  private claude(m: Message): Disposition {
    const d = m.data;
    const session = str(d, "session_id");
    if (session !== undefined) this.last_session = session;
    const type = d.type;
    const sub = d.subtype;
    if (type === "assistant") return this.assistant(m);
    if (type === "user") return this.claude_user(m);
    if (type === "system" && sub === "compact_boundary") {
      const meta = is_obj(d.compact_metadata) ? d.compact_metadata : {};
      const item: Item = { id: `legacy:${m.id}`, type: "compaction", created_at: m.created_at };
      // A subagent's own conversation compacted (Codex's children).
      const parent = this.parent_of(m);
      if (!parent) return "retained";
      if (parent.ok !== undefined) item.parent_id = parent.ok;
      if (meta.trigger === "auto" || meta.trigger === "manual") item.trigger = meta.trigger;
      const tokens = uint(meta.pre_tokens);
      if (tokens !== undefined) item.tokens_before = tokens;
      const after = uint(meta.post_tokens);
      if (after !== undefined) item.metadata = { post_tokens: after };
      this.add(item);
      return "converted";
    }
    if (type === "system" && typeof sub === "string" && sub.startsWith("task_")) return this.job(m, sub);
    if (type === "result") return this.result(m);
    return this.retain(m.id, "unknown_claude", `a Claude message of type ${JSON.stringify(type ?? null)}, subtype ${JSON.stringify(sub ?? null)}`);
  }

  private assistant(m: Message): Disposition {
    const d = m.data;
    const parent = this.parent_of(m);
    if (!parent) return "retained";
    const with_parent = <T extends Item>(item: T): T => (parent.ok !== undefined ? { ...item, parent_id: parent.ok } : item);
    const blocks: any[] = Array.isArray(d.message?.content) ? d.message.content : [];
    // An API error (a usage limit, say) Claude Code shows as the assistant's text.
    if (d.is_api_error_message === true) {
      const text = blocks.filter((b) => typeof b?.text === "string").map((b) => b.text);
      // Always with a code, which tells it from the board's own errors (the readers take it as the agent's).
      const code = str(d, "api_error") ?? str(d, "error") ?? "api_error";
      this.add(with_parent({ id: `legacy:${m.id}`, type: "notice", level: "error", text: text.join("\n"), code, created_at: m.created_at }));
      return "converted";
    }
    let any = false;
    const texts: string[] = [];
    blocks.forEach((block, i) => {
      const key = `legacy:${m.id}:${i}`;
      switch (block?.type) {
        case "text": {
          const text = block.text;
          if (typeof text !== "string" || !text.trim()) return;
          this.add(with_parent({ id: key, type: "assistant_message", text, created_at: m.created_at }));
          texts.push(text);
          any = true;
          return;
        }
        case "thinking": {
          const text = block.thinking;
          if (typeof text !== "string" || !text.trim()) return;
          this.add(with_parent({ id: key, type: "reasoning", text, created_at: m.created_at }));
          any = true;
          return;
        }
        case "redacted_thinking":
          return;
        case "tool_use":
          this.tool_use(m, i, block, parent.ok);
          any = true;
          return;
        default:
          this.warn(m.id, "unknown_block", `an assistant block of type ${JSON.stringify(block?.type ?? null)}`);
      }
    });
    if (parent.ok === undefined && texts.length) this.last_text = texts.join("\n");
    return any ? "converted" : "redundant";
  }

  private tool_use(m: Message, i: number, block: any, parent: string | undefined): void {
    const call_id = typeof block.id === "string" ? block.id : "";
    // A call keeps its id as its item's, but for the first: one with an id an earlier call has is `legacy:<message>:<block>`.
    const key = `legacy:${m.id}:${i}`;
    const id = call_id && !this.items.has(call_id) ? call_id : key;
    if (id !== call_id) this.warn(m.id, "duplicate_call", `tool call ${JSON.stringify(call_id)} is there twice; this one is ${key}`);
    const name = typeof block.name === "string" ? block.name : "";
    const fields = tool_fields(name, block.input);
    const item: ToolCall = { id, type: "tool_call", ...fields, status: "running", created_at: m.created_at };
    if (parent !== undefined) item.parent_id = parent;
    this.add(item);
    const session = str(m.data, "session_id");
    this.set_meta(id, { call_id: id !== call_id ? call_id : undefined, session });
    const parent_raw = str(m.data, "parent_tool_use_id") ?? null;
    const c: Call = { item: id, call_id, kind: fields.kind, status: "running", title: fields.title, has_result: false, model: str(block.input, "model"), parent_raw, session, input: fields.input };
    this.add_call(c);
    // What was stored before it: its subagent's messages named it already, and its prompt or result may have come.
    this.missing_parents.delete(call_id);
    for (const r of this.requests.values()) {
      if (r.tool_call_id === id && parent !== undefined && !r.parent_id) this.open({ ...r, parent_id: parent });
    }
    const prompts = this.waiting_prompts.get(call_id);
    const p = prompts?.findIndex((w) => same_json(w.input, fields.input)) ?? -1;
    if (prompts && p >= 0) {
      const [w] = prompts.splice(p, 1);
      if (!prompts.length) this.waiting_prompts.delete(call_id);
      const r = this.requests.get(w!.request);
      if (r) {
        const linked: ThreadRequest = { ...r, tool_call_id: id };
        if (parent !== undefined) linked.parent_id = parent;
        this.open(linked);
      }
    }
    const early = this.early.get(call_id);
    const e = early?.findIndex((x) => x.parent_raw === parent_raw && same_session(x.session, session)) ?? -1;
    if (early && e >= 0) {
      const [x] = early.splice(e, 1);
      if (!early.length) this.early.delete(call_id);
      this.tool_result(x!.message_id, x!.created_at, c, x!.block, x!.meta);
    }
  }

  private claude_user(m: Message): Disposition {
    const d = m.data;
    const content = d.message?.content;
    if (typeof content === "string") {
      // The summary a compacted conversation goes on from: the latest compaction of the same conversation.
      const parent = this.parent_of(m);
      if (!parent) return "retained";
      const id = this.compaction.get(parent.ok ?? "");
      if (d.isSynthetic === true && id !== undefined) {
        this.update(id, { summary: content });
        return "converted";
      }
      return this.retain(m.id, "unplaced_text", "user text from Claude Code that isn't a compaction's summary");
    }
    let any = false;
    const warned = this.step.warnings.length;
    const parent_raw = str(d, "parent_tool_use_id");
    for (const block of Array.isArray(content) ? content : []) {
      const type = block?.type;
      if (type === "tool_result") {
        const call = typeof block.tool_use_id === "string" ? block.tool_use_id : "";
        if (this.result_for(m, call, block)) any = true;
      } else if (type === "text" && d.isSynthetic === true) {
        // What Claude Code adds for the model after an image, say.
      } else if (type === "text" && parent_raw !== undefined && !String(block.text ?? "").startsWith("[Request interrupted")) {
        // A subagent's prompt, which its call's input has.
      } else if (type === "text") {
        const text = typeof block.text === "string" ? block.text : "";
        if (text.startsWith("[Request interrupted")) {
          const parent = this.parent_of(m);
          if (parent) {
            const item: Item = { id: `legacy:${m.id}`, type: "notice", level: "info", code: "interrupted", text, created_at: m.created_at };
            if (parent.ok !== undefined) item.parent_id = parent.ok;
            this.add(item);
            any = true;
          }
        } else {
          this.warn(m.id, "unplaced_text", "user text from Claude Code that isn't a tool's result");
        }
      } else {
        this.warn(m.id, "unknown_block", `a user block of type ${JSON.stringify(type ?? null)}`);
      }
    }
    if (any) return "converted";
    return this.step.warnings.length > warned ? "retained" : "redundant";
  }

  /**
   * A tool_result block for call `id` in message `m`: for the call with the id in the same subagent and session that's
   * still waiting for its result. With no call with the id yet, it waits for it (it was stored before its call). Whether
   * it went anywhere.
   */
  private result_for(m: Message, id: string, block: any): boolean {
    const parent_raw = str(m.data, "parent_tool_use_id") ?? null;
    const session = str(m.data, "session_id");
    const all = this.calls_with(id);
    const found = all.filter((c) => c.parent_raw === parent_raw && same_session(c.session, session) && !c.has_result);
    if (found.length === 1) {
      this.tool_result(m.id, m.created_at, found[0]!, block, m.data.tool_use_result);
      return true;
    }
    if (found.length > 1) {
      this.warn(m.id, "ambiguous_call", `a result for call ${id}, which ${found.length} calls with the id are waiting for`);
    } else if (all.length) {
      this.warn(m.id, "unmatched_result", `a result for call ${id}, which no call with the id is waiting for`);
    } else {
      // Stored before its call: given to it when it comes.
      const e = { message_id: m.id, created_at: m.created_at, block, meta: m.data.tool_use_result, parent_raw, session };
      const list = this.early.get(id);
      if (list) list.push(e);
      else this.early.set(id, [e]);
      return true;
    }
    return false;
  }

  /** A tool_result block for call `c` (`meta`: its message's tool_use_result), stored `at`. */
  private tool_result(message_id: number, at: string, c: Call, block: any, meta: any): void {
    const text = result_text(block.content);
    const is_error = block.is_error === true;
    // Claude Code's result for a call a stop cut short (a denied call's is the denial's message).
    const interrupted = text.startsWith("[Request interrupted") || text.startsWith(REJECTED);
    const status: ToolStatus = !is_error ? "completed" : this.denied(c.item) ? "denied" : interrupted ? "cancelled" : "failed";
    const result: { content: string; truncated?: boolean } = { content: text };
    // Cut short when it was stored (agent/runner/output.ts's slim and util.ts's truncate).
    if (text.length > STORED_RESULT_MAX && text.includes("\n… [truncated ")) result.truncated = true;
    const patch: Record<string, unknown> = { status, result };
    if (c.has_result) this.warn(message_id, "second_result", `call ${c.call_id} has a result already; this one replaces it`);
    c.status = status;
    c.has_result = true;
    if (c.kind === "subagent") {
      const s = subagent_result(c.subagent, is_error, interrupted, is_obj(meta) ? meta : {}, text, at);
      if (s) patch.subagent = c.subagent = s;
    }
    this.update(c.item, patch);
  }

  /**
   * A task_* system message: how a subagent (or a Bash command's run) is getting on. Claude Code's say which task by
   * `task_id` (and started ones which call, by `tool_use_id`); the ones the board writes for Codex's subagents
   * (agent/codex/output.ts) have no `task_type`, and say which call by `tool_use_id` alone.
   */
  private job(m: Message, subtype: string): Disposition {
    const d = m.data;
    const task = typeof d.task_id === "string" ? d.task_id : "";
    const call = typeof d.tool_use_id === "string" ? d.tool_use_id : "";
    const session = str(d, "session_id");
    const calls = this.calls_with(call).filter((c) => same_session(c.session, session));
    if (subtype === "task_started") {
      const type = d.task_type ?? null;
      if (type !== null && type !== "local_agent") {
        if (task) this.jobs.set(task, "shown");
        if (calls.length === 1 && task) this.set_meta(calls[0]!.item, { shown_tasks: [...(this.meta.get(calls[0]!.item)?.shown_tasks ?? []), task] });
        if (type === "local_bash") return "redundant";
        return this.retain(m.id, "unknown_task_type", `a background task of type ${JSON.stringify(type)}`);
      }
      if (calls.length !== 1) {
        if (task) this.jobs.set(task, "shown");
        if (!calls.length) return this.retain(m.id, "missing_parent", `a subagent started by call ${JSON.stringify(call)}, which isn't in the thread`);
        return this.retain(m.id, "ambiguous_call", `a subagent started by call ${call}, which ${calls.length} calls have as their id`);
      }
      const c = calls[0]!;
      // Started again (Codex says so when a child's details come late): how it's getting on stays.
      const s = subagent_started(c.subagent, d, c.model);
      if (c.subagent) s.status = c.subagent.status;
      c.subagent = s;
      const patch: Record<string, unknown> = { subagent: s };
      // A Skill forked into an agent has no Agent call: its call becomes the subagent's.
      if (c.kind !== "subagent") {
        patch.kind = c.kind = "subagent";
        const title = str(d, "description");
        if (title !== undefined && !c.title) patch.title = c.title = title;
      }
      // A background subagent's call is done once it has started it. Claude Code says so with a result too, later; the
      // board's Codex children have none.
      if (s.background && c.status === "running" && !c.has_result) patch.status = c.status = "completed";
      if (task) {
        this.set_meta(c.item, { subagent_task: task });
        this.jobs.set(task, { agent: c.item });
      }
      this.update(c.item, patch);
      return "converted";
    }
    let job = this.jobs.get(task);
    if (job === undefined && calls.length === 1 && calls[0]!.subagent) job = { agent: calls[0]!.item };
    if (job === undefined) return this.retain(m.id, "unknown_task", `a ${subtype} for a background task that never started (${JSON.stringify(task)})`);
    if (job === "shown") return "redundant";
    const c = this.calls.get(job.agent);
    if (!c?.subagent) return "redundant";
    const next = subagent_task(c.subagent, d, m.created_at);
    if (same_json(next, c.subagent)) return "redundant";
    c.subagent = next;
    this.update(c.item, { subagent: next });
    return "converted";
  }

  private result(m: Message): Disposition {
    const d = m.data;
    const ok = d.subtype === "success" && d.is_error !== true;
    // What the turn ended by saying, if no message of its said it (Claude Code gives the result of a turn that a
    // background subagent's report started that way, say). The readers have it from the turn's end.
    const said = this.last_text;
    this.last_text = null;
    const text = str(d, "result");
    if (text !== undefined && ok && text.trim() && said?.trim() !== text.trim()) {
      const id = `legacy:${m.id}:result`;
      // The board's view doesn't draw it (it shows the turn's end): its metadata says so.
      this.add({ id, type: "assistant_message", text, created_at: m.created_at, metadata: { from_result: true } });
      this.set_meta(id, { from_result: true });
    }
    const id = `legacy:${m.id}`;
    const item: Item = { id, type: "turn_result", ok, created_at: m.created_at };
    if (d.interrupted === true) item.interrupted = true;
    // An interrupted turn's result says nothing more than that.
    if (!ok && (text !== undefined || d.interrupted !== true)) item.error = text ?? str(d, "subtype") ?? "error";
    const ms = uint(d.duration_ms);
    if (ms !== undefined) item.duration_ms = ms;
    // What the board shows of it that the item doesn't say.
    const metadata: { [k: string]: unknown } = {};
    if (typeof d.subtype === "string") metadata.subtype = d.subtype;
    if (typeof d.num_turns === "number") metadata.num_turns = d.num_turns;
    if (typeof d.total_cost_usd === "number") metadata.total_cost_usd = d.total_cost_usd;
    if (Object.keys(metadata).length) item.metadata = metadata;
    this.add(item);
    // What its result said, whichever way the turn went: the readers take it as what the agent said last there.
    this.set_meta(id, { result_text: text });
    return "converted";
  }
}

function new_step(message_id: number): Step {
  return { message_id, disposition: "converted", events: [], ids: [], warnings: [], meta: new Map() };
}

// ---------- converting a whole history ----------

/** What a task's messages convert to (see `convert`). */
export interface Conversion {
  /** The saved events (unnumbered), in order. */
  events: NewEvent[];
  /** What folding them gives. */
  items: Item[];
  requests: ThreadRequest[];
  /** What each message became. */
  rows: Array<{ message_id: number; disposition: Disposition; ids: string[] }>;
  /** The items' metas, by id. */
  meta: Map<string, ItemMeta>;
  warnings: Warning[];
  /** The session the messages were last in. */
  last_session: string | undefined;
}

/**
 * All of a task's messages, translated one at a time and then finished (see Translator.finish): the history as an import
 * would take it. `finished` false leaves what's open as it is, as a thread that goes on would have it.
 */
export function convert(messages: Iterable<Message>, o: { finished?: boolean; from?: Translator } = {}): Conversion {
  const t = o.from ?? new Translator();
  const events: NewEvent[] = [];
  const rows: Conversion["rows"] = [];
  const meta = new Map<string, ItemMeta>();
  const warnings: Warning[] = [];
  const at = new Map<number, number>();
  for (const m of messages) {
    const s = t.message(m);
    events.push(...s.events);
    at.set(m.id, rows.length);
    rows.push({ message_id: m.id, disposition: s.disposition, ids: s.ids });
    for (const [k, v] of s.meta) meta.set(k, v);
    warnings.push(...s.warnings);
  }
  if (o.finished !== false) {
    const f = t.finish();
    events.push(...f.events);
    warnings.push(...f.warnings);
    for (const [k, v] of f.meta) meta.set(k, v);
    for (const id of f.retained) {
      const i = at.get(id);
      if (i !== undefined) rows[i]!.disposition = "retained";
    }
  }
  const state = fold(events);
  return { events, items: state.items, requests: state.requests, rows, meta, warnings, last_session: t.session };
}

/** The items and requests `events` make, from none (protocol.ts's reducer, without a thread). */
export function fold(events: Iterable<NewEvent>, from: Pick<Snapshot, "items" | "requests"> = { items: [], requests: [] }): { items: Item[]; requests: ThreadRequest[] } {
  // A Map by id keeps this linear on long threads; protocol.ts's apply_event is the reference, and the tests compare.
  const items = new Map<string, Item>(from.items.map((i) => [i.id, i]));
  const requests = new Map<string, ThreadRequest>(from.requests.map((r) => [r.id, r]));
  for (const e of events) {
    switch (e.type) {
      case "item.added":
        items.set(e.item.id, e.item);
        break;
      case "item.updated": {
        const item = items.get(e.item_id);
        if (!item) break;
        const next: any = { ...item };
        for (const [k, v] of Object.entries(e.patch)) {
          if (k === "id" || k === "type") continue;
          if (v === null) delete next[k];
          else next[k] = v;
        }
        items.set(e.item_id, next);
        break;
      }
      case "items.removed":
        for (const id of e.item_ids) items.delete(id);
        break;
      case "request.opened":
        requests.set(e.request.id, e.request);
        break;
      case "request.resolved": {
        const r = requests.get(e.request_id);
        if (r) requests.set(e.request_id, { ...r, resolution: e.resolution });
        break;
      }
    }
  }
  return { items: [...items.values()], requests: [...requests.values()] };
}

/** The board's permission mode (db.PERMISSION_MODES) in the protocol's terms. */
export function permission_mode(mode: string): PermissionMode | undefined {
  const modes: Record<string, PermissionMode> = { default: "default", acceptEdits: "accept_edits", auto: "auto", plan: "plan", dontAsk: "dont_ask", bypassPermissions: "bypass" };
  return modes[mode];
}

// ---------- what tools are ----------

/** What a tool does, by its name, as agent-threads' Claude driver says it. */
export function kind_of(name: string): ToolKind {
  switch (name) {
    case "Bash":
    case "BashOutput":
      return "shell";
    case "Read":
    case "NotebookRead":
      return "read";
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "NotebookEdit":
    case "ApplyPatch":
      return "edit";
    case "Glob":
    case "Grep":
      return "search";
    case "WebFetch":
    case "WebSearch":
      return "web";
    case "Task":
    case "Agent":
      return "subagent";
    case "TodoWrite":
      return "todo";
    default:
      return "other";
  }
}

type ToolFields = Pick<ToolCall, "name" | "kind" | "input" | "server" | "command" | "path" | "query" | "url" | "title" | "changes" | "todos">;

/**
 * A tool_call's fields (name, kind, input and what its kind has) for a stored tool_use: the same as agent-threads' Claude
 * driver makes, and Codex's file changes (stored as ApplyPatch) as edits.
 */
export function tool_fields(name: string, input_: unknown): ToolFields {
  const input: any = input_ === null || input_ === undefined ? {} : input_;
  let tool = name;
  let kind = kind_of(name);
  let server: string | undefined;
  if (name.startsWith("mcp__")) {
    const rest = name.slice(5);
    const at = rest.indexOf("__");
    server = (at < 0 ? rest : rest.slice(0, at)) || undefined;
    tool = at < 0 ? "" : rest.slice(at + 2);
    kind = "mcp";
    // The app's own tools, on its in-process server (agent-threads' `app`).
    if (server === APP_SERVER) {
      kind = "app";
      server = undefined;
    }
  }
  const t: ToolFields = { name: tool, kind } as ToolFields;
  if (server !== undefined) t.server = server;
  const set = (k: "command" | "path" | "query" | "url" | "title", v: string | undefined) => {
    if (v !== undefined) t[k] = v;
  };
  switch (kind) {
    case "shell":
      set("command", typeof input.command === "string" ? input.command : undefined);
      break;
    case "read":
      set("path", str(input, "file_path"));
      break;
    case "search":
      set("query", str(input, "pattern"));
      set("path", str(input, "path"));
      break;
    case "web":
      set("url", str(input, "url"));
      set("query", str(input, "query"));
      break;
    case "subagent":
      set("title", str(input, "description"));
      break;
  }
  if (kind === "edit" && name === "ApplyPatch") {
    t.changes = (Array.isArray(input.changes) ? input.changes : []).flatMap((c: any) => {
      const path = str(c, "path");
      if (path === undefined) return [];
      const change: NonNullable<ToolCall["changes"]>[number] = { path, op: c.kind === "add" ? "add" : c.kind === "delete" ? "delete" : "update" };
      const diff = str(c, "diff");
      if (diff !== undefined) change.diff = diff;
      const to = str(c, "move_path");
      if (to !== undefined) change.move_to = to;
      return [change];
    });
  } else if (kind === "edit") {
    const p = str(input, "file_path") ?? str(input, "notebook_path");
    if (p !== undefined) t.changes = [{ path: p, op: "update" }];
  } else if (kind === "todo") {
    t.todos = (Array.isArray(input.todos) ? input.todos : []).map((x: any) => {
      const c = x?.content;
      const text = typeof c === "string" ? c : c === null || c === undefined ? "" : JSON.stringify(c);
      const status = x?.status === "in_progress" || x?.status === "completed" ? x.status : "pending";
      return { text, status };
    });
  }
  t.input = input;
  return t;
}

/** A permission's title: what it's about, in a few words. */
function title(t: ToolFields): string {
  if (t.command) return t.command;
  if (t.path) return t.path;
  if (t.changes?.length) return t.changes.map((c) => c.path).join(", ");
  return t.name;
}

/** A tool result's content as text: text blocks joined by newlines (images were stored as [image]). */
export function result_text(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .flatMap((b: any) => {
        if (b?.type === "text") return [typeof b.text === "string" ? b.text : ""];
        if (b?.type === "image") return ["[image]"];
        if (b?.type === "tool_reference" && typeof b.tool_name === "string") return [b.tool_name];
        return [];
      })
      .join("\n");
  }
  if (content === null || content === undefined) return "";
  return JSON.stringify(content);
}

/** A protocol Question from an AskUserQuestion question, a Codex request_user_input one, or a request_user_input card. */
function question(q: any, id: string): Question {
  const out: Question = { id, question: typeof q?.question === "string" ? q.question : "" };
  const header = str(q, "header");
  if (header !== undefined) out.header = header;
  const options = (Array.isArray(q?.options) ? q.options : []).flatMap((o: any) => {
    const label = typeof o === "string" ? o : typeof o?.label === "string" ? o.label : undefined;
    if (label === undefined) return [];
    const option: { label: string; description?: string } = { label };
    const d = str(o, "description");
    if (d !== undefined) option.description = d;
    return [option];
  });
  if (options.length) out.options = options;
  if (q?.multi_select === true || q?.multiSelect === true) out.multi_select = true;
  if (q?.allow_other === true || q?.isOther === true) out.allow_other = true;
  if (q?.isSecret === true || q?.secret === true) out.secret = true;
  return out;
}

/**
 * The answers stored on an answered question prompt, by the converted questions' ids. The board keeps them as a list of
 * answers for each question, in order (permissions.ts's shown answers: a secret's are "(hidden)"); a map of each
 * question's text (or id) to its answers is read too. Undefined if they're neither.
 */
function answers_of(stored: unknown, questions: Question[]): { [k: string]: string[] } | undefined {
  const strings = (v: unknown): string[] | undefined => {
    if (typeof v === "string") return [v];
    if (Array.isArray(v)) return v.every((x) => typeof x === "string") ? (v as string[]) : undefined;
    // Codex's answers by id, as its tool takes them.
    if (is_obj(v) && Array.isArray(v.answers)) return v.answers.every((x: unknown) => typeof x === "string") ? v.answers : undefined;
    return undefined;
  };
  const out: { [k: string]: string[] } = {};
  if (Array.isArray(stored)) {
    for (let i = 0; i < Math.min(questions.length, stored.length); i++) {
      const list = strings(stored[i]);
      if (!list) return undefined;
      if (list.length) out[questions[i]!.id] = list;
    }
    return out;
  }
  if (is_obj(stored)) {
    for (const q of questions) {
      const found = q.question in stored ? stored[q.question] : stored[q.id];
      if (found === undefined) continue;
      const list = strings(found);
      if (!list) return undefined;
      out[q.id] = list;
    }
    return out;
  }
  return undefined;
}

// ---------- subagents ----------

/** How Claude says a subagent ended, as a SubagentStatus; undefined if what it says isn't an end. */
function subagent_end(status: unknown): SubagentStatus | undefined {
  switch (status) {
    case "completed":
    case "success":
      return "completed";
    case "failed":
    case "error":
      return "failed";
    case "killed":
    case "stopped":
    case "cancelled":
    case "interrupted":
      return "stopped";
    default:
      return undefined;
  }
}

/** A subagent call's subagent, as a task_started (of a local_agent) says it has started. */
function subagent_started(s: SubagentState | undefined, m: any, model: string | undefined): SubagentState {
  const next: SubagentState = { ...(s ?? { status: "running" }), status: "running" };
  if (m.is_backgrounded === true) next.background = true;
  const type = str(m, "subagent_type");
  if (type !== undefined) next.agent_type = type;
  const mdl = str(m, "model") ?? model;
  if (mdl !== undefined) next.model = mdl;
  return next;
}

/** A subagent's state with it ended, `status`, at `at` (the first time it ended, if it ran again since). */
function ended(next: SubagentState, status: SubagentStatus, at: string): void {
  next.status = status;
  next.ended_at ??= at;
}

/** A subagent after a task_progress, task_updated or task_notification about it, stored `at`. */
function subagent_task(s: SubagentState, m: any, at: string): SubagentState {
  const next: SubagentState = { ...s };
  const running = s.status === "running";
  const tool_uses = uint(m.usage?.tool_uses);
  switch (m.subtype) {
    case "task_progress": {
      const d = str(m, "description");
      if (d !== undefined) next.activity = d;
      if (tool_uses !== undefined) next.tool_uses = tool_uses;
      break;
    }
    case "task_updated": {
      // Continued (with SendMessage) after it ended, it runs again.
      if (m.patch?.status === "running") {
        next.status = "running";
        delete next.summary;
        delete next.ended_at;
      } else {
        const end = subagent_end(m.patch?.status);
        if (end && running) ended(next, end, at);
      }
      break;
    }
    case "task_notification": {
      const end = subagent_end(m.status);
      if (end && running) ended(next, end, at);
      if (tool_uses !== undefined) next.tool_uses = tool_uses;
      // A foreground subagent's report is its call's result.
      const summary = str(m, "summary");
      if (s.background && summary !== undefined) next.summary = summary;
      break;
    }
  }
  return next;
}

/**
 * A subagent call's subagent, as its result says (`meta`: the result's tool_use_result, which the board keeps for Agent
 * calls); undefined for a call whose subagent never started.
 */
function subagent_result(s: SubagentState | undefined, is_error: boolean, interrupted: boolean, meta: any, text: string, at: string): SubagentState | undefined {
  if (!s && is_error) return undefined;
  const next: SubagentState = { ...(s ?? { status: "running" }) };
  const model = str(meta, "resolvedModel");
  if (model !== undefined) next.model = model;
  const type = str(meta, "agentType");
  if (type !== undefined) next.agent_type = type;
  const n = uint(meta.totalToolUseCount);
  if (n !== undefined) next.tool_uses = n;
  // A background subagent's call returns as soon as it has started it.
  if (meta.isAsync === true || meta.status === "async_launched" || text.trimStart().startsWith("Async agent launched")) {
    next.background = true;
  } else if (next.status === "running") {
    ended(next, is_error ? (interrupted ? "stopped" : "failed") : (subagent_end(meta.status) ?? "completed"), at);
  }
  return next;
}
