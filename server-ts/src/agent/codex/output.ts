// Port of server/src/agent/codex/output.rs.
/** Codex's output turned into thread messages shaped like Claude Code's stream-json, subagents' included. */
import * as db from "../../db.ts";
import type { Run } from "../../db.ts";
import type { Shared } from "../../state.ts";
import { truncate } from "../../util.ts";
import { display_command, file_changes } from "./adapter.ts";
import { limits } from "./queries.ts";
import * as wait from "../../mcp/wait.ts";
import * as agent_tools from "../agent_tools.ts";
import * as context from "../context.ts";
import * as documents from "../documents.ts";
import * as usage from "../usage.ts";
import * as runner from "../runner.ts";

const g = (v: any) => (v === undefined ? null : v);
const str = (v: any): string | null => (typeof v === "string" ? v : null);
const is_obj = (v: any) => v !== null && typeof v === "object" && !Array.isArray(v);

function assistant(content: any): any {
  return { type: "assistant", message: { role: "assistant", content }, parent_tool_use_id: null };
}

function tool_result(id: string, content: string, is_error: boolean): any {
  return {
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: truncate(content, 30_000), is_error }] },
    parent_tool_use_id: null,
  };
}

/**
 * A child keeps the same row across spawn, wait, follow-up and resumed runs. Its messages can
 * arrive before the spawn call returns, so use its thread id rather than the spawn's item id.
 */
function subagent_id(thread_id: string): string {
  return `codex-agent-${thread_id}`;
}

export function own_thread(params: any, session: string | null): boolean {
  const id = str(params?.threadId);
  return id === null || (session !== null && session === id);
}

function thread_message(state: Shared, task_id: string, parent: string | null, message: any) {
  message.parent_tool_use_id = parent;
  state.add_message(task_id, "claude", message);
}

function subagent_started(state: Shared, task_id: string, session: string | null, thread: string, sender: string | null, meta: any) {
  if (thread === session) return;
  const id = subagent_id(thread);
  const exists = db.has_assistant_block(state.db(), task_id, id);
  const parent = sender !== null && sender !== session ? subagent_id(sender) : null;
  const prompt = str(meta.prompt) ?? "";
  const description = truncate(prompt === "" ? (str(meta.description) ?? "") : prompt, 200);
  if (!exists) {
    const input = { description, prompt, model: g(meta.model), subagent_type: g(meta.subagent_type), run_in_background: true };
    thread_message(state, task_id, parent, assistant([{ type: "tool_use", id, name: "Agent", input }]));
  }
  // Metadata can arrive after the row (thread/started and the spawn's completion can race).
  const started: any = {
    type: "system",
    subtype: "task_started",
    tool_use_id: id,
    task_id: thread,
    prompt,
    description,
    model: g(meta.model),
    subagent_type: g(meta.subagent_type),
    is_backgrounded: true,
  };
  if (sender !== null) started.parent_tool_use_id = parent;
  state.add_message(task_id, "claude", started);
}

function subagent_status(state: Shared, run: Run, thread: string, status: string, summary: string | null) {
  const message =
    status === "running"
      ? { type: "system", subtype: "task_updated", tool_use_id: subagent_id(thread), patch: { status } }
      : { type: "system", subtype: "task_notification", tool_use_id: subagent_id(thread), status, summary: summary !== null ? truncate(summary, 30_000) : null };
  const m = state.add_message(run.task_id, "claude", message);
  wait.subagent_finished(state, run, m.data);
}

/**
 * The older collab tool items and newer hosted subAgentActivity items describe the same
 * children. Normalize both to the lifecycle used by Claude's Agent/Task calls.
 */
function subagent_item(state: Shared, run: Run, session: string | null, params: any) {
  const task_id = run.task_id;
  const item = params?.item ?? {};
  const sender = str(item.senderThreadId) ?? str(params?.threadId);
  if (item.type === "subAgentActivity") {
    const thread = str(item.agentThreadId);
    if (thread === null || thread === session) return;
    if (item.kind === "started") subagent_started(state, task_id, session, thread, sender, { model: g(item.model), description: g(item.agentPath) });
    const status = item.kind === "started" ? "running" : item.kind === "completed" ? "completed" : item.kind === "interrupted" ? "stopped" : null;
    if (status === null) return;
    return subagent_status(state, run, thread, status, null);
  }
  if (item.type !== "collabAgentToolCall") return;
  const tool = str(item.tool) ?? "";
  const receivers: string[] = (Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds : []).filter((t: any) => typeof t === "string" && t !== session);
  for (const thread of receivers) {
    if (tool === "spawnAgent" && item.status !== "failed") {
      subagent_started(state, task_id, session, thread, sender, { prompt: g(item.prompt), model: g(item.model) });
    }
    if (item.status !== "failed") {
      const status = ["resumeAgent", "sendInput", "followupTask"].includes(tool) ? "running" : ["closeAgent", "interruptAgent"].includes(tool) ? "stopped" : null;
      if (status !== null) subagent_status(state, run, thread, status, null);
    }
  }
  const states = is_obj(item.agentsStates) ? item.agentsStates : {};
  for (const thread of Object.keys(states).sort()) {
    if (thread === session) continue;
    const s = states[thread];
    const normalized = (
      { pendingInit: "running", running: "running", completed: "completed", errored: "failed", notFound: "failed", shutdown: "stopped", interrupted: "stopped" } as Record<
        string,
        string
      >
    )[str(s?.status) ?? ""];
    if (normalized === undefined) continue;
    subagent_status(state, run, thread, normalized, str(s?.message));
  }
}

/** The tool call an item shows as: (name, input). None for items that aren't tool calls. */
export function tool_use(item: any): [string, any] | null {
  const type = str(item?.type);
  switch (type) {
    case "commandExecution":
      return ["Bash", { command: display_command(str(item.command) ?? ""), cwd: g(item.cwd) }];
    case "fileChange":
      return ["ApplyPatch", { changes: file_changes(item) }];
    case "mcpToolCall":
      return [`${agent_tools.tool_prefix(str(item.server) ?? "")}__${str(item.tool) ?? ""}`, g(item.arguments)];
    case "dynamicToolCall":
      return [str(item.tool) ?? "tool", g(item.arguments)];
    case "webSearch": {
      const url = str(item.action?.url);
      return url !== null ? ["WebFetch", { url }] : ["WebSearch", { query: g(item.query) }];
    }
    case "imageView":
      return ["Read", { file_path: g(item.path) }];
    case "collabAgentToolCall":
      // Spawning succeeds before the child finishes. Its row is created from the child's
      // thread, not from this short-lived tool call; other collab calls aren't new agents.
      if (item.tool === "spawnAgent" && item.status !== "failed") return null;
      return [str(item.tool) ?? "collab", { prompt: g(item.prompt), receiver_thread_ids: g(item.receiverThreadIds) }];
    default:
      return null;
  }
}

/** Items whose call is shown when they start; the others only once they're done. */
function shown_at_start(kind: string): boolean {
  return ["commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall", "collabAgentToolCall"].includes(kind);
}

/** What a finished tool item returned: (output, is_error). */
export function tool_output(item: any): [string, boolean] {
  const status = str(item?.status) ?? "completed";
  switch (str(item?.type) ?? "") {
    case "commandExecution": {
      let out = str(item.aggregatedOutput) ?? "";
      const code = Number.isInteger(item.exitCode) ? (item.exitCode as number) : null;
      if (status === "declined") return ["The command was declined.", true];
      if (code !== null && code !== 0) out += `${out === "" || out.endsWith("\n") ? "" : "\n"}(exit code ${code})`;
      return [out, status === "failed" || (code !== null && code !== 0)];
    }
    case "fileChange":
      if (status === "declined") return ["The change was declined.", true];
      if (status === "failed") return ["The change couldn't be applied.", true];
      return ["Applied.", false];
    case "mcpToolCall": {
      const e = str(item.error?.message);
      if (e !== null) return [e, true];
      const content: any[] = Array.isArray(item.result?.content) ? item.result.content : [];
      const text = content.map((c) => str(c?.text) ?? `[${str(c?.type) ?? "content"}]`);
      return [text.join("\n"), status === "failed"];
    }
    case "dynamicToolCall": {
      const content: any[] = Array.isArray(item.contentItems) ? item.contentItems : [];
      const text = content.map((c) => str(c?.text)).filter((t) => t !== null);
      return [text.join("\n"), item.success === false || status === "failed"];
    }
    case "webSearch":
      return [Array.isArray(item.results) ? `${item.results.length} results` : "", false];
    case "collabAgentToolCall":
      return [JSON.stringify(g(item.agentsStates), null, 2), status === "failed"];
    default:
      return ["", status === "failed"];
  }
}

/** Apply one line of a Codex run's output (an app-server notification). */
export function handle_line(state: Shared, run: Run, v: any): void {
  const task_id = run.task_id;
  const p = v?.params ?? {};
  const session = db.get_task(state.db(), task_id)?.session_id ?? null;
  const own = own_thread(p, session);
  const thread_id = str(p.threadId);
  const parent = thread_id !== null && !own ? subagent_id(thread_id) : null;
  const method = str(v?.method) ?? "";
  if (method === "thread/started") {
    const thread = p.thread ?? {};
    const id = str(thread.id);
    if (id !== null) {
      // v2 uses subAgent; older notifications used subagent. Normalize both before
      // extracting a spawned thread's parent or excluding an internal subagent.
      const src = is_obj(thread.source) ? thread.source : {};
      const subagent = "subAgent" in src ? src.subAgent : "subagent" in src ? src.subagent : undefined;
      const source = subagent?.thread_spawn ?? {};
      const sender = str(thread.parentThreadId) ?? str(source.parent_thread_id);
      if (sender !== null) {
        const role = str(thread.agentRole) ?? str(source.agent_role);
        subagent_started(state, task_id, session, id, sender, { prompt: g(thread.preview), description: g(thread.agentNickname), subagent_type: role });
      } else if (subagent === undefined && session !== id) {
        state.update_task(task_id, [["session_id", id]]);
      }
    }
  } else if (method === "turn/started" && !own) {
    if (thread_id !== null) subagent_status(state, run, thread_id, "running", null);
  } else if (method === "turn/started") {
    // Where a rewind to before this turn takes the thread back to (see checkpoints::Rewind).
    const turn = str(p.turn?.id);
    if (turn !== null) db.run(state.db(), "UPDATE runs SET agent_at=?1 WHERE id=?2", turn, run.id);
    state.emit({ type: "delta_reset", task_id });
  } else if (method === "item/agentMessage/delta" && own) {
    const t = str(p.delta);
    if (t !== null) state.emit({ type: "delta", task_id, text: t });
  } else if (method === "item/started") {
    const item = p.item ?? {};
    const kind = str(item.type) ?? "";
    // A tool call of its own thread means it's working again (see mcp/wait.rs). Hosted
    // subAgentActivity items are notifications, not the parent calling a tool.
    const tu = tool_use(item);
    if (own && (kind === "collabAgentToolCall" || (tu !== null && !wait.is_wait_tool(tu[0])))) wait.resumed(state, task_id, run.id);
    if (kind === "agentMessage" && own) {
      state.emit({ type: "delta_reset", task_id });
    } else if (shown_at_start(kind) && !(kind === "collabAgentToolCall" && item.tool === "spawnAgent")) {
      const id = str(item.id);
      if (id !== null && tu !== null) thread_message(state, task_id, parent, assistant([{ type: "tool_use", id, name: tu[0], input: tu[1] }]));
    }
  } else if (method === "item/completed") {
    const item = p.item ?? {};
    const kind = str(item.type) ?? "";
    const id = str(item.id) ?? "";
    subagent_item(state, run, session, p);
    if (kind === "agentMessage" || kind === "plan") {
      if (own) state.emit({ type: "delta_reset", task_id });
      const text = str(item.text);
      if (text !== null && text.trim() !== "") thread_message(state, task_id, parent, assistant([{ type: "text", text }]));
    } else if (kind === "reasoning") {
      const parts = (k: string): string[] => (Array.isArray(item[k]) ? item[k].filter((s: any) => typeof s === "string") : []);
      let text = parts("summary");
      if (!text.length) text = parts("content");
      const joined = text.join("\n\n");
      if (joined.trim() !== "") thread_message(state, task_id, parent, assistant([{ type: "thinking", thinking: joined }]));
    } else if (kind === "contextCompaction") {
      const meta = { trigger: run.kind === "compact" ? "manual" : "auto" };
      thread_message(state, task_id, parent, { type: "system", subtype: "compact_boundary", compact_metadata: meta });
      if (parent === null) context.on_compacted(state, run, meta);
    } else {
      const tu = tool_use(item);
      if (tu === null) return;
      const [name, input] = tu;
      if (!shown_at_start(kind) || (kind === "collabAgentToolCall" && item.tool === "spawnAgent")) {
        thread_message(state, task_id, parent, assistant([{ type: "tool_use", id, name, input }]));
      }
      const [out, is_error] = tool_output(item);
      thread_message(state, task_id, parent, tool_result(id, out, is_error));
      // A tool call may have changed the task's document: the task shows it as it's written.
      documents.follow(state, task_id);
    }
  } else if (method === "turn/plan/updated") {
    const todos = (Array.isArray(p.plan) ? p.plan : []).map((s: any) => {
      const status = s?.status === "inProgress" ? "in_progress" : s?.status === "completed" ? "completed" : "pending";
      return { content: g(s?.step), status };
    });
    const at = Number.isInteger(v.emittedAtMs) ? v.emittedAtMs : Date.now();
    const id = `plan-${str(p.threadId) ?? ""}-${at}`;
    thread_message(state, task_id, parent, assistant([{ type: "tool_use", id, name: "TodoWrite", input: { todos } }]));
    thread_message(state, task_id, parent, tool_result(id, "", false));
  } else if (method === "error" && p.willRetry === true) {
    state.add_event(task_id, "warn", `Codex: ${str(p.error?.message) ?? "error"} (retrying)`, null);
  } else if (method === "warning") {
    const m = str(p.message);
    if (m !== null) state.add_event(task_id, "warn", `Codex: ${m}`, null);
  } else if (method === "mcpServer/startupStatus/updated" && p.status === "failed") {
    state.add_event(task_id, "warn", `MCP server ${str(p.name) ?? "?"} failed to start`, str(p.error));
  } else if (method === "account/rateLimits/updated") {
    const c = state.db();
    const t = db.get_task(c, task_id);
    const config = t ? db.task_claude_config(c, t) : null;
    if (config) usage.set_limits(state, config.id, limits(p.rateLimits), str(p.rateLimits?.planType));
  } else if (method === "thread/tokenUsage/updated") {
    context.on_codex_usage(state, run, p);
  } else if (method === "turn/completed" && !own) {
    if (thread_id !== null) {
      const st = p.turn?.status;
      const status = st === "completed" ? "completed" : st === "interrupted" ? "stopped" : "failed";
      subagent_status(state, run, thread_id, status, str(p.turn?.error?.message));
    }
  } else if (method === "thread/status/changed" && !own && p.status?.type === "systemError") {
    if (thread_id !== null) subagent_status(state, run, thread_id, "failed", null);
  } else if (method === "thread/closed" && !own) {
    if (thread_id !== null) subagent_status(state, run, thread_id, "stopped", null);
  } else if (method === "turn/completed") {
    finish_turn(state, run, p.turn ?? {});
  } else if (method === "thread/compacted" && own && run.kind === "compact") {
    // `/compact` ends here when its turn isn't reported.
    finish_turn(state, run, { status: "completed" });
  }
}

function finish_turn(state: Shared, run: Run, turn: any) {
  const status = str(turn.status) ?? "completed";
  const error =
    status === "completed" ? null : status === "interrupted" ? "The turn was interrupted" : (str(turn.error?.message) ?? `the turn ended as ${status}`);
  // Refused for the account's usage limit (see agent/usage.rs).
  if (turn.error?.codexErrorInfo === "usageLimitExceeded") {
    const c = state.db();
    const t = db.get_task(c, run.task_id);
    const config = t ? db.task_claude_config(c, t) : null;
    if (config) {
      usage.codex_refused(state, config.id);
      usage.ran_out(state, run.task_id, config.id);
    }
  }
  // `/compact` may report its end twice (see handle_line); other runs can go several turns.
  const saw = db.value<number>(state.db(), "SELECT saw_result FROM runs WHERE id=?1", run.id);
  if (saw === undefined) throw new Error("Query returned no rows");
  if (saw && run.kind === "compact") return;
  const result = {
    type: "result",
    subtype: error !== null ? "error_during_execution" : "success",
    is_error: error !== null,
    result: error,
    duration_ms: g(turn.durationMs),
    num_turns: run.kind === "compact" ? 0 : 1,
  };
  runner.record_result(state, run, error, result);
}
