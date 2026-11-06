// Port of server/src/agent/codex/output.rs.
/**
 * Codex's output: each line goes to agent/codex/requests.ts (a request) or agent/codex/driver.ts (a notification, which
 * writes the task's items straight from it), with the helpers here: what a Codex item shows as (a tool call, its
 * result), and a turn's end. Until step 13 of docs/threads.md, this made a task on messages Claude-shaped messages.
 */
import * as db from "../../db.ts";
import type { Run } from "../../db.ts";
import type { Shared } from "../../state.ts";
import { display_command, file_changes } from "./adapter.ts";
import * as agent_tools from "../agent_tools.ts";
import * as usage from "../usage.ts";
import * as runner from "../runner.ts";
import * as thread_source from "../../threads/source.ts";
import * as write from "../../threads/write.ts";
import * as driver from "./driver.ts";
import { on_request, on_resolved } from "./requests.ts";

const g = (v: any) => (v === undefined ? null : v);
/**
 * The adapter's own notification (not Codex's) of whether a new thread took the board's tools as dynamic tools: it says
 * `{"dynamic": false}` when Codex wouldn't, and the thread has the board's MCP server instead (see adapter.ts's
 * start_thread).
 */
export const BOARD_TOOLS = "huntaway/boardTools";
const str = (v: any): string | null => (typeof v === "string" ? v : null);

/**
 * A child keeps the same row across spawn, wait, follow-up and resumed runs. Its messages can
 * arrive before the spawn call returns, so use its thread id rather than the spawn's item id.
 */
export function subagent_id(thread_id: string): string {
  return `codex-agent-${thread_id}`;
}

export function own_thread(params: any, session: string | null): boolean {
  const id = str(params?.threadId);
  return id === null || (session !== null && session === id);
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
    case "dynamicToolCall": {
      // The board's tools (agent/codex/requests.ts's board_tools) are named as its MCP server's are.
      const ns = str(item.namespace);
      const tool = str(item.tool) ?? "tool";
      return [ns !== null && ns !== "" ? `${agent_tools.tool_prefix(ns)}__${tool}` : tool, g(item.arguments)];
    }
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
export function shown_at_start(kind: string): boolean {
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

/**
 * Apply one line of a Codex run's output: an app-server request (see agent/codex/requests.ts), or a notification,
 * mapped onto the task's items (agent/codex/driver.ts). A task still on messages (a run from before the server's start
 * moved its task onto items) has its items brought up to date first, so they're its whole thread when it moves.
 */
export function handle_line(state: Shared, run: Run, v: any): void {
  if ("id" in v) return on_request(state, run, v);
  if (v.method === "serverRequest/resolved") return on_resolved(state, run, v.params?.requestId);
  // Its session's later runs have the board's MCP server too (see launch.ts).
  if (v.method === BOARD_TOOLS) return void (v.params?.dynamic === false && db.set_run_board_tools(state.db(), run.id, false));
  if (thread_source.of(state.db(), run.task_id) !== "items") write.ensure(state.db(), run.task_id);
  driver.handle(state, run, v);
}

export function finish_turn(state: Shared, run: Run, turn: any) {
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
