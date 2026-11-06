// New in HA-223 (no Rust original): step 11 of docs/threads.md.
/**
 * What a Codex run asks the board, on its output: with `Spec::requests_on_output` (run format 5), the adapter writes
 * each of the app-server's requests to `out.jsonl` as it is (an approval with the item it's about as `item`), and the
 * board answers it on the run's input (`{"type": "codex_response", "id", "result" | "error"}`), as Claude's control
 * requests are answered (agent/runner/requests.ts, whose `ask` and `call` these go through: each is recorded in
 * `mcp_calls` as `stdio:<run id>:codex:<id>`, at most once, and taken up again after a restart). So no helper or HTTP
 * server takes a Codex run's calls:
 *
 * - **Approvals** (a command, a file change, more permissions, an MCP server's elicitation) are permission prompts, by
 *   mcp/permissions.ts's policy, as the adapter asked the board's `permission_prompt` before (as Bash, ApplyPatch,
 *   Permissions, or the MCP tool), so the thread's request and `permission_requests` are those of a Claude run's.
 * - **Questions** (`item/tool/requestUserInput`) are the `request_user_input` prompt, answered with Codex's answers.
 * - **The board's tools** are Codex dynamic tools (`board_tools`, a namespace named for the board's server, given to a
 *   new thread), each `item/tool/call` a call through the board's dispatch (mcp/tools/dispatch.ts), as Claude's
 *   in-process server's are. A session from before has them on the board's MCP server instead (see launch.ts).
 */
import type { Run } from "../../db.ts";
import type { Shared } from "../../state.ts";
import * as mcp from "../../mcp.ts";
import * as runs from "../runs.ts";
import * as permissions from "../../mcp/permissions.ts";
import * as agent_tools from "../agent_tools.ts";
import { MCP_SERVER_NAME, is_board_server } from "../runner.ts";
import { ask_permission, call_tool, cancel_call, control_call_id } from "../runner/requests.ts";
import { display_command, file_changes } from "./adapter.ts";

const g = (v: any) => (v === undefined ? null : v);
const str = (v: any): string | null => (typeof v === "string" ? v : null);
const is_obj = (v: any) => v !== null && typeof v === "object" && !Array.isArray(v);

/** Codex's request as an answer to it needs it: its JSON-RPC id and method (and an approval's permissions, which it grants). */
export interface CodexRequest {
  id: string | number;
  method: string;
  permissions?: any;
}

/**
 * The board's tools as one Codex dynamic tool, a namespace named for the board's MCP server, whose calls are named as
 * that server's are (agent/codex/output.ts's tool_use). Not `permission_prompt`, the helper's way of asking: Codex's
 * approvals come as requests of their own.
 */
export function board_tools(review: boolean): any {
  const tools = mcp
    .tools(review)
    .filter((t) => t.name !== "permission_prompt")
    .map((t) => ({ type: "function", name: t.name, description: t.description ?? "", inputSchema: t.inputSchema ?? { type: "object" } }));
  return { type: "namespace", name: MCP_SERVER_NAME, description: mcp.INSTRUCTIONS, tools };
}

/** The request id a Codex request is recorded under (`stdio:<run id>:codex:<id>`, see runner/requests.ts). */
function request_id(id: string | number): string {
  return `codex:${typeof id === "string" ? JSON.stringify(id) : id}`;
}

/** A request from the app-server (`v`, as the adapter wrote it to the run's output), answered on the run's input. */
export function on_request(state: Shared, run: Run, v: any): void {
  const id = v?.id;
  if (typeof id !== "number" && typeof id !== "string") return;
  const method = str(v.method) ?? "";
  const p = v.params ?? {};
  const rid = request_id(id);
  const call_id = control_call_id(run.id, rid);
  const req: CodexRequest = { id, method };
  const ask = (tool_name: string, input: any) =>
    ask_permission(state, run.id, call_id, { tool_name, input, tool_use_id: str(p.itemId), request_id: rid, codex: req });
  switch (method) {
    case "item/commandExecution/requestApproval": {
      const input: any = { command: typeof p.command === "string" ? display_command(p.command) : "", cwd: g(p.cwd) };
      if (typeof p.reason === "string") input.description = p.reason;
      return ask("Bash", input);
    }
    case "item/fileChange/requestApproval": {
      // The changes are the item's, which the adapter sends with it: it has every item of the run that's started, and
      // the thread's are from the same notifications.
      const item = v.item ?? null;
      const input: any = { changes: file_changes(item) };
      if (typeof p.reason === "string") input.reason = p.reason;
      if (typeof p.grantRoot === "string") input.grant_root = p.grantRoot;
      return ask("ApplyPatch", input);
    }
    case "item/permissions/requestApproval":
      req.permissions = g(p.permissions);
      return ask("Permissions", { permissions: g(p.permissions), reason: g(p.reason), cwd: g(p.cwd) });
    case "mcpServer/elicitation/request":
      return elicitation(state, run, id, p, ask);
    // Its questions are asked in the thread as Claude's AskUserQuestion is, and answered with the user's answers by
    // question id. Unanswered, the agent carries on with its own judgement.
    case "item/tool/requestUserInput": {
      const questions = (Array.isArray(p.questions) ? p.questions : []).map((q: any) => ({
        id: g(q?.id),
        header: g(q?.header),
        question: g(q?.question),
        multiSelect: false,
        options: Array.isArray(q?.options) ? q.options : [],
        isOther: g(q?.isOther),
        isSecret: g(q?.isSecret),
      }));
      return ask(permissions.CODEX_QUESTIONS, { questions });
    }
    case "item/tool/call": {
      const tool = str(p.tool) ?? "";
      const namespace = str(p.namespace);
      if (namespace === null || !is_board_server(namespace)) {
        return respond(state, run.id, id, { result: tool_answer({ err: `There's no tool ${namespace !== null ? `${namespace}.` : ""}${tool}.` }) });
      }
      return call_tool(state, run.id, call_id, tool, { request_id: rid, rpc_id: id, arguments: g(p.arguments), codex: req });
    }
    default:
      respond(state, run.id, id, { error: { code: -32601, message: `Method not supported by Huntaway: ${method}` } });
  }
}

/**
 * An MCP server's elicitation. Only forms that need nothing filled in (e.g. "allow this tool call?") can be accepted.
 * The board's own server (a session from before its tools were dynamic tools) needs no approval but for a `wait` that
 * Codex's reviewer didn't take (see Spec::review_waits), which is asked about as the command it runs.
 */
function elicitation(state: Shared, run: Run, id: string | number, p: any, ask: (tool: string, input: any) => void): void {
  const props = p.requestedSchema?.properties;
  const fields = is_obj(props) ? Object.keys(props).length : 0;
  const server = str(p.serverName) ?? "mcp";
  const message = str(p.message) ?? "";
  // "Allow the x MCP server to run tool "y"?" asks about a tool call.
  let tool = "elicitation";
  const at = message.indexOf('tool "');
  if (at >= 0) {
    const r = message.slice(at + 6);
    const q = r.indexOf('"');
    if (q >= 0) tool = r.slice(0, q);
  }
  const params = p._meta?.tool_params;
  const cmd = typeof params?.command === "string" ? params.command.trim() : "";
  if (p.mode === "url" || fields > 0) return respond(state, run.id, id, { result: { action: "decline" } });
  if (is_board_server(server) && tool === "wait" && (cmd !== "" || !is_obj(params))) {
    if (cmd !== "") {
      const reason = typeof params.reason === "string" ? `: ${params.reason}` : "";
      return ask("Bash", { command: cmd, description: `Run while waiting${reason}` });
    }
    return ask(`${agent_tools.tool_prefix(server)}__wait`, { message });
  }
  if (is_board_server(server)) return respond(state, run.id, id, { result: { action: "accept", content: {} } });
  // With what it's called with, when Codex says (for the user, and the action log).
  const input: any = { message };
  if (is_obj(params)) input.arguments = params;
  ask(`${agent_tools.tool_prefix(server)}__${tool}`, input);
}

/** Codex's answer to request `req`, from the board's permission decision (`permission_prompt`'s: `{behavior, ...}`). */
export function prompt_answer(req: CodexRequest, decision: any): any {
  const ok = decision?.behavior === "allow";
  switch (req.method) {
    case "item/permissions/requestApproval":
      return { permissions: ok ? (req.permissions ?? {}) : {}, scope: "turn" };
    case "mcpServer/elicitation/request":
      return { action: ok ? "accept" : "decline", content: ok ? {} : null };
    case "item/tool/requestUserInput": {
      const answers = ok ? g(decision?.updatedInput?.answers) : {};
      return { answers: is_obj(answers) ? answers : {} };
    }
    default:
      return { decision: ok ? "accept" : "decline" };
  }
}

/** Codex's answer to a board tool's call (`r`, its dispatch's result), as the board's MCP server would have given it. */
export function tool_answer(r: { ok: any } | { err: string }): any {
  const result = mcp.call_result(r);
  const text = (Array.isArray(result.content) ? result.content : []).map((c: any) => str(c?.text) ?? "").join("\n");
  return { contentItems: [{ type: "inputText", text }], success: result.isError !== true };
}

/** Answers the app-server's request `id` on run `run_id`'s input (see the top of the file). */
export function respond(state: Shared, run_id: string, id: string | number, answer: { result: any } | { error: any }): void {
  const line = JSON.stringify({ type: "codex_response", id, ...answer });
  let sent = false;
  try {
    sent = runs.write_input(state, run_id, line);
  } catch (e) {
    console.warn(`run ${run_id}: answering Codex's request ${id}: ${e}`);
    return;
  }
  if (!sent) console.warn(`run ${run_id}: the agent no longer takes input, so Codex's request ${id} wasn't answered`);
}

/** The app-server no longer wants request `id` answered (the adapter says so only of one the board hasn't answered). */
export function on_resolved(state: Shared, run: Run, id: unknown): void {
  if (typeof id !== "number" && typeof id !== "string") return;
  cancel_call(state, run, control_call_id(run.id, request_id(id)));
}
