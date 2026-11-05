// New in HA-223 (no Rust original): step 11 of docs/threads.md.
/**
 * A Codex run's output, for a task whose items are its source (threads/source.ts): each app-server notification the
 * adapter writes (`out.jsonl`) is mapped straight onto the thread model's events (threads/protocol.ts), with no message
 * shaped like Claude Code's in between (agent/codex/output.ts still does that for a task on messages). The board's own
 * messages in the thread (the user's, its events, prompts and questions, each turn's result) are written as before,
 * through the translator, which is told of what's written here (threads/native.ts).
 *
 * What it makes is what the messages path's items are, so the thread view, the readers and the tool calls' names don't
 * change between the two (see `map`, and docs/threads.md's "Codex writes items directly" for every difference): tool
 * calls have the board's names (Bash, ApplyPatch, `mcp__<server>__<tool>`, WebSearch and WebFetch, Read, TodoWrite)
 * with their normalized fields, and Codex's ids; a subagent (a child thread) is an Agent call, `codex-agent-<thread
 * id>`, which its items have as their parent; the agent's messages, reasoning and compactions are items with Codex's
 * ids. The rest of a notification's effects (the session, the context meter, rate limits, the wait tool, the task's
 * documents, a turn's end) are the messages path's, in `handle`.
 *
 * `map` is pure: it reads the thread through a View (the store, in `handle`'s transaction), so a server that restarts
 * mid-run goes on from what's stored, and a notification read again (its offset wasn't saved) changes nothing more.
 */
import * as db from "../../db.ts";
import type { Run } from "../../db.ts";
import type { Shared } from "../../state.ts";
import { err_str, now, truncate } from "../../util.ts";
import type { Item, NewEvent, SubagentState, SubagentStatus, ToolCall, ToolStatus } from "../../threads/protocol.ts";
import { tool_fields, type ItemMeta } from "../../threads/translate.ts";
import * as store from "../../threads/store.ts";
import * as native from "../../threads/native.ts";
import * as live from "../../threads/live.ts";
import * as wait from "../../mcp/wait.ts";
import * as context from "../context.ts";
import * as documents from "../documents.ts";
import * as usage from "../usage.ts";
import { limits } from "./queries.ts";
import { finish_turn, own_thread, shown_at_start, subagent_id, tool_output, tool_use } from "./output.ts";

const str = (v: any): string | null => (typeof v === "string" ? v : null);
/** A string that isn't empty, as the translator reads one (threads/translate.ts's `str`). */
const text_of = (v: any): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const is_obj = (v: any) => v !== null && typeof v === "object" && !Array.isArray(v);
const g = (v: any) => (v === undefined ? null : v);

/** Deep equality of JSON values (the order of objects' keys doesn't count). */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => same(x, b[i]));
  if (!is_obj(a) || !is_obj(b)) return (a ?? null) === (b ?? null);
  const ka = Object.keys(a as object).filter((k) => (a as any)[k] !== undefined);
  const kb = Object.keys(b as object).filter((k) => (b as any)[k] !== undefined);
  return ka.length === kb.length && ka.every((k) => k in (b as object) && same((a as any)[k], (b as any)[k]));
}

/** Tool results longer than this (in UTF-8 bytes) are cut short, as the messages path stores them. */
const RESULT_MAX = 30_000;
/** How long a subagent's description is, from its prompt. */
const DESCRIPTION_MAX = 200;

/** The thread as it's stored: its items, by id. */
export interface View {
  item(id: string): Item | null | undefined;
  /** The main conversation's tool calls that have no result yet (that a turn's end cancels). */
  open_calls(): string[];
}

/** What the mapping needs to know of the run. */
export interface Ctx {
  /** The task's Codex session: its main thread's id. Notifications from other threads are its subagents'. */
  session: string | null;
  /** The run is a compaction (`/compact`). */
  compact: boolean;
  /** When the notification came, for items' `created_at` and subagents' `ended_at`. */
  at: string;
}

/** A subagent's status as a notification changed it, for the wait tool (see `handle`). */
export interface SubagentNews {
  id: string;
  status: SubagentStatus;
  summary: string | null;
}

/** What a notification gives: the events, the metas of the items it made, and what it said of subagents. */
export interface Mapped {
  events: NewEvent[];
  meta: Map<string, ItemMeta>;
  subagents: SubagentNews[];
}

/** The events of one notification so far, over the thread as stored: what they add and change is seen by what follows. */
class Out implements Mapped {
  events: NewEvent[] = [];
  meta = new Map<string, ItemMeta>();
  subagents: SubagentNews[] = [];
  private changed = new Map<string, Item>();
  private view: View;
  readonly ctx: Ctx;
  constructor(view: View, ctx: Ctx) {
    this.view = view;
    this.ctx = ctx;
  }

  item(id: string): Item | undefined {
    return this.changed.get(id) ?? this.view.item(id) ?? undefined;
  }

  add(item: Item): void {
    this.changed.set(item.id, item);
    this.events.push({ type: "item.added", item });
  }

  /** Sets the fields of `patch` (those that would change) on item `id`, if the thread has it. */
  update(id: string, patch: Record<string, unknown>): void {
    const it = this.item(id) as Record<string, unknown> | undefined;
    if (!it) return;
    const changes = Object.entries(patch).filter(([k, v]) => k !== "id" && k !== "type" && (v === null ? k in it : !same(it[k], v)));
    if (!changes.length) return;
    const next: Record<string, unknown> = { ...it };
    for (const [k, v] of changes) {
      if (v === null) delete next[k];
      else next[k] = v;
    }
    this.changed.set(id, next as unknown as Item);
    this.events.push({ type: "item.updated", item_id: id, patch: Object.fromEntries(changes) });
  }
}

/** The events Codex notification `v` (as the adapter wrote it to the run's output) makes in the thread `view` holds. */
export function map(view: View, ctx: Ctx, v: any): Mapped {
  const out = new Out(view, ctx);
  const p = v?.params ?? {};
  const own = own_thread(p, ctx.session);
  const thread_id = str(p.threadId);
  const parent = thread_id !== null && !own ? subagent_id(thread_id) : undefined;
  switch (str(v?.method) ?? "") {
    case "thread/started": {
      const thread = p.thread ?? {};
      const id = str(thread.id);
      if (id === null) break;
      // v2 says subAgent; older notifications subagent.
      const src = is_obj(thread.source) ? thread.source : {};
      const sub = "subAgent" in src ? src.subAgent : "subagent" in src ? src.subagent : undefined;
      const spawn = sub?.thread_spawn ?? {};
      const sender = str(thread.parentThreadId) ?? str(spawn.parent_thread_id);
      if (sender !== null) {
        const role = str(thread.agentRole) ?? str(spawn.agent_role);
        subagent_started(out, id, sender, { prompt: g(thread.preview), description: g(thread.agentNickname), subagent_type: role });
      }
      break;
    }
    case "turn/started":
      if (!own && thread_id !== null) subagent_status(out, thread_id, "running", null);
      break;
    case "item/started": {
      const item = p.item ?? {};
      const kind = str(item.type) ?? "";
      if (!shown_at_start(kind) || (kind === "collabAgentToolCall" && item.tool === "spawnAgent")) break;
      const id = str(item.id);
      const tu = tool_use(item);
      if (id !== null && tu !== null && !out.item(id)) add_call(out, id, tu[0], tu[1], parent);
      break;
    }
    case "item/completed":
      completed(out, p, parent);
      break;
    case "turn/plan/updated": {
      // The turn's plan, one call a turn (and thread), as its latest update has it.
      const todos = (Array.isArray(p.plan) ? p.plan : []).map((s: any) => {
        const status = s?.status === "inProgress" ? "in_progress" : s?.status === "completed" ? "completed" : "pending";
        return { content: g(s?.step), status };
      });
      const turn = str(p.turnId) ?? (Number.isInteger(v.emittedAtMs) ? String(v.emittedAtMs) : "");
      const id = `plan-${thread_id ?? ""}-${turn}`;
      const fields = tool_fields("TodoWrite", { todos });
      if (out.item(id)) out.update(id, { input: fields.input, todos: fields.todos });
      else add_call(out, id, "TodoWrite", { todos }, parent, { status: "completed", result: { content: "" } });
      break;
    }
    case "turn/completed":
      if (!own) {
        if (thread_id === null) break;
        const st = p.turn?.status;
        const status = st === "completed" ? "completed" : st === "interrupted" ? "stopped" : "failed";
        subagent_status(out, thread_id, status, str(p.turn?.error?.message));
      } else {
        // Codex never completes a call its turn's interruption cut short: it ends with the turn.
        for (const id of view.open_calls()) out.update(id, { status: "cancelled" });
      }
      break;
    case "thread/status/changed":
      if (!own && p.status?.type === "systemError" && thread_id !== null) subagent_status(out, thread_id, "failed", null);
      break;
    case "thread/closed":
      if (!own && thread_id !== null) subagent_status(out, thread_id, "stopped", null);
      break;
  }
  return out;
}

/** A tool call, `id`, of tool `name` with `input` (the board's names, see the top of the file), running unless `extra` says. */
function add_call(out: Out, id: string, name: string, input: any, parent: string | undefined, extra: Partial<ToolCall> = {}): ToolCall {
  const call: ToolCall = { id, type: "tool_call", ...tool_fields(name, input), status: "running", created_at: out.ctx.at, ...extra };
  if (parent !== undefined) call.parent_id = parent;
  out.add(call);
  return call;
}

function completed(out: Out, p: any, parent: string | undefined): void {
  const item = p.item ?? {};
  const kind = str(item.type) ?? "";
  const id = str(item.id) ?? "";
  subagent_item(out, p);
  const under = <T extends Item>(it: T): T => (parent !== undefined ? { ...it, parent_id: parent } : it);
  if (kind === "agentMessage" || kind === "plan") {
    const text = str(item.text);
    if (text !== null && text.trim() !== "") put(out, under({ id, type: "assistant_message", text, created_at: out.ctx.at }));
  } else if (kind === "reasoning") {
    const parts = (k: string): string[] => (Array.isArray(item[k]) ? item[k].filter((s: any) => typeof s === "string") : []);
    let text = parts("summary");
    if (!text.length) text = parts("content");
    const joined = text.join("\n\n");
    if (joined.trim() !== "") put(out, under({ id, type: "reasoning", text: joined, created_at: out.ctx.at }));
  } else if (kind === "contextCompaction") {
    put(out, under({ id, type: "compaction", trigger: out.ctx.compact ? "manual" : "auto", created_at: out.ctx.at }));
  } else {
    const tu = tool_use(item);
    if (tu === null) return;
    if (!out.item(id)) add_call(out, id, tu[0], tu[1], parent);
    const [text, is_error] = tool_output(item);
    const content = truncate(text, RESULT_MAX);
    const result: { content: string; truncated?: boolean; exit_code?: number } = { content };
    if (content !== text) result.truncated = true;
    if (kind === "commandExecution" && Number.isInteger(item.exitCode)) result.exit_code = item.exitCode;
    const status: ToolStatus = item.status === "declined" ? "denied" : is_error ? "failed" : "completed";
    out.update(id, { status, result });
  }
}

/** An item that's written once, when it's complete: added, or (read again) left as it is. */
function put(out: Out, item: Item): void {
  if (!out.item(item.id)) out.add(item);
}

/**
 * A subagent (child thread `thread`, spawned by thread `sender`) has started, with what's known of it (`meta`): its
 * Agent call, the first time, and its details, which can come later than the call (thread/started and the spawn's
 * completion race). A call that's running in the background is done once it has started it.
 */
function subagent_started(out: Out, thread: string, sender: string | null, meta: { prompt?: any; description?: any; model?: any; subagent_type?: any }): void {
  const ctx = out.ctx;
  if (thread === ctx.session) return;
  const id = subagent_id(thread);
  const parent = sender !== null && sender !== ctx.session ? subagent_id(sender) : undefined;
  const prompt = str(meta.prompt) ?? "";
  const description = truncate(prompt === "" ? (str(meta.description) ?? "") : prompt, DESCRIPTION_MAX);
  let it = out.item(id);
  const fresh = !it;
  if (!it) {
    const input = { description, prompt, model: g(meta.model), subagent_type: g(meta.subagent_type), run_in_background: true };
    it = { id, type: "tool_call", ...tool_fields("Agent", input), status: "running", created_at: ctx.at };
    if (parent !== undefined) it.parent_id = parent;
  }
  if (it.type !== "tool_call") return;
  const s: SubagentState = { ...(it.subagent ?? { status: "running" }), status: it.subagent?.status ?? "running", background: true };
  const type = text_of(meta.subagent_type);
  if (type !== undefined) s.agent_type = type;
  const model = text_of(meta.model) ?? text_of((it.input as any)?.model);
  if (model !== undefined) s.model = model;
  // What the board shows as its description and prompt, as the latest says them.
  const said: { [k: string]: unknown } = { ...it.metadata };
  if (description !== "") said.description = description;
  if (prompt !== "") said.prompt = prompt;
  const patch: Record<string, unknown> = { subagent: s };
  if (Object.keys(said).length) patch.metadata = said;
  if (it.status === "running" && it.result === undefined) patch.status = "completed";
  if (fresh) {
    out.add({ ...it, ...patch } as ToolCall);
    // Codex's id for it, as the messages path's task_started gave it.
    out.meta.set(id, { subagent_task: thread });
  } else out.update(id, patch);
}

/**
 * Child thread `thread`'s subagent is running again, or has ended (`status`, with its report or error, `summary`). A
 * background subagent's report is kept; its end, the first time.
 */
function subagent_status(out: Out, thread: string, status: SubagentStatus, summary: string | null): void {
  const id = subagent_id(thread);
  const it = out.item(id);
  if (it?.type !== "tool_call") return;
  if (status !== "running") out.subagents.push({ id, status, summary: summary !== null ? truncate(summary, RESULT_MAX) : null });
  const s = it.subagent;
  if (!s) return;
  const next: SubagentState = { ...s };
  if (status === "running") {
    next.status = "running";
    delete next.summary;
    delete next.ended_at;
  } else {
    if (s.status === "running") {
      next.status = status;
      next.ended_at ??= out.ctx.at;
    }
    if (s.background && text_of(summary) !== undefined) next.summary = truncate(summary!, RESULT_MAX);
  }
  out.update(id, { subagent: next });
}

/**
 * Codex's collab tool calls (spawning, waiting on, messaging and closing a child thread) and its hosted
 * subAgentActivity items say how its children are getting on: each child is one Agent call.
 */
function subagent_item(out: Out, p: any): void {
  const session = out.ctx.session;
  const item = p?.item ?? {};
  const sender = str(item.senderThreadId) ?? str(p?.threadId);
  if (item.type === "subAgentActivity") {
    const thread = str(item.agentThreadId);
    if (thread === null || thread === session) return;
    if (item.kind === "started") subagent_started(out, thread, sender, { model: g(item.model), description: g(item.agentPath) });
    const status = item.kind === "started" ? "running" : item.kind === "completed" ? "completed" : item.kind === "interrupted" ? "stopped" : null;
    if (status !== null) subagent_status(out, thread, status, null);
    return;
  }
  if (item.type !== "collabAgentToolCall") return;
  const tool = str(item.tool) ?? "";
  const receivers: string[] = (Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds : []).filter((t: any) => typeof t === "string" && t !== session);
  for (const thread of receivers) {
    if (tool === "spawnAgent" && item.status !== "failed") subagent_started(out, thread, sender, { prompt: g(item.prompt), model: g(item.model) });
    if (item.status !== "failed") {
      const status = ["resumeAgent", "sendInput", "followupTask"].includes(tool) ? "running" : ["closeAgent", "interruptAgent"].includes(tool) ? "stopped" : null;
      if (status !== null) subagent_status(out, thread, status, null);
    }
  }
  const states = is_obj(item.agentsStates) ? item.agentsStates : {};
  const STATES: Record<string, SubagentStatus> = {
    pendingInit: "running",
    running: "running",
    completed: "completed",
    errored: "failed",
    notFound: "failed",
    shutdown: "stopped",
    interrupted: "stopped",
  };
  for (const thread of Object.keys(states).sort()) {
    if (thread === session) continue;
    const s = states[thread];
    const status = STATES[str(s?.status) ?? ""];
    if (status !== undefined) subagent_status(out, thread, status, str(s?.message));
  }
}

// ---------- applying it ----------

/** Task `task_id`'s thread as the store has it, for `map`. */
export function stored(state: Shared, task_id: string): View {
  const c = state.db();
  return {
    item: (id) => store.get_item(c, task_id, id),
    open_calls: () =>
      db
        .all<{ id: string }>(
          c,
          `SELECT id FROM thread_items WHERE task_id=?1 AND type='tool_call' AND parent_id IS NULL
           AND json_extract(data, '$.status') IN ('running', 'pending') AND json_extract(data, '$.kind') <> 'subagent' ORDER BY pos`,
          task_id,
        )
        .map((r) => r.id),
  };
}

/**
 * One line of a Codex run's output (an app-server notification), for a task whose items are its source: its items
 * (`map`), written in one transaction and sent to clients once committed, and its other effects, as the messages path
 * has them (agent/codex/output.ts's handle_line).
 */
export function handle(state: Shared, run: Run, v: any): void {
  const task_id = run.task_id;
  const p = v?.params ?? {};
  const session = db.get_task(state.db(), task_id)?.session_id ?? null;
  const own = own_thread(p, session);
  const method = str(v?.method) ?? "";
  // What comes before its items.
  switch (method) {
    case "thread/started": {
      const thread = p.thread ?? {};
      const id = str(thread.id);
      const src = is_obj(thread.source) ? thread.source : {};
      const sub = "subAgent" in src ? src.subAgent : "subagent" in src ? src.subagent : undefined;
      const sender = str(thread.parentThreadId) ?? str(sub?.thread_spawn?.parent_thread_id);
      if (id !== null && sender === null && sub === undefined && session !== id) {
        state.update_task(task_id, [["session_id", id]]);
        // The run that started the thread, which says where it's kept (see db.task_config_dir).
        db.set_run_session(state.db(), run.id, id);
      }
      break;
    }
    case "turn/started":
      if (own) {
        // Where a rewind to before this turn takes the thread back to (see checkpoints::Rewind).
        const turn = str(p.turn?.id);
        if (turn !== null) db.run(state.db(), "UPDATE runs SET agent_at=?1 WHERE id=?2", turn, run.id);
        state.emit_delta_reset(task_id);
      }
      break;
    case "item/agentMessage/delta":
      if (own) {
        const t = str(p.delta);
        if (t !== null) state.emit_delta(task_id, t);
      }
      return;
    case "item/started": {
      const item = p.item ?? {};
      const kind = str(item.type) ?? "";
      // A tool call of its own thread means it's working again (see mcp/wait.ts). Hosted subAgentActivity items are
      // notifications, not the parent calling a tool.
      const tu = tool_use(item);
      if (own && (kind === "collabAgentToolCall" || (tu !== null && !wait.is_wait_tool(tu[0])))) wait.resumed(state, task_id, run.id);
      if (kind === "agentMessage" && own) state.emit_delta_reset(task_id);
      break;
    }
    case "item/completed": {
      const kind = str(p.item?.type) ?? "";
      if ((kind === "agentMessage" || kind === "plan") && own) state.emit_delta_reset(task_id);
      break;
    }
    case "error":
      if (p.willRetry === true) state.add_event(task_id, "warn", `Codex: ${str(p.error?.message) ?? "error"} (retrying)`, null);
      return;
    case "warning": {
      const m = str(p.message);
      if (m !== null) state.add_event(task_id, "warn", `Codex: ${m}`, null);
      return;
    }
    case "mcpServer/startupStatus/updated":
      if (p.status === "failed") state.add_event(task_id, "warn", `MCP server ${str(p.name) ?? "?"} failed to start`, str(p.error));
      return;
    case "account/rateLimits/updated": {
      const c = state.db();
      const t = db.get_task(c, task_id);
      const config = t ? db.task_claude_config(c, t) : null;
      if (config) usage.set_limits(state, config.id, limits(p.rateLimits), str(p.rateLimits?.planType));
      return;
    }
    case "thread/tokenUsage/updated":
      context.on_codex_usage(state, run, p);
      return;
  }
  // Its items. A failure to make or write them (nothing of them is written) is logged, and the rest of its effects go
  // on: a turn's end still records the run's result, and a subagent's still ends the wait for it.
  let mapped: Mapped = { events: [], meta: new Map(), subagents: [] };
  try {
    mapped = map(stored(state, task_id), { session, compact: run.kind === "compact", at: now() }, v);
    const saved = native.append(state.db(), task_id, mapped.events, mapped.meta);
    if (saved.length) live.send_events(state, task_id, saved);
  } catch (e) {
    console.error(`${now()} ERROR huntaway: run ${run.id}: Codex's ${method || "notification"} couldn't be written to task ${task_id}'s items: ${err_str(e)}`);
  }
  // What comes after them, which reads them.
  for (const s of mapped.subagents) {
    wait.subagent_finished(state, run, { subtype: "task_notification", tool_use_id: s.id, status: s.status, summary: s.summary });
  }
  if (method === "item/completed") {
    const item = p.item ?? {};
    const kind = str(item.type) ?? "";
    if (kind === "contextCompaction") {
      if (own) context.on_compacted(state, run, { trigger: run.kind === "compact" ? "manual" : "auto" });
    } else if (!["agentMessage", "plan", "reasoning"].includes(kind) && tool_use(item) !== null) {
      // A tool call may have changed the task's document: the task shows it as it's written.
      documents.follow(state, task_id);
    }
  } else if (method === "turn/completed" && own) {
    finish_turn(state, run, p.turn ?? {});
  } else if (method === "thread/compacted" && own && run.kind === "compact") {
    // `/compact` ends here when its turn isn't reported.
    finish_turn(state, run, { status: "completed" });
  }
}
