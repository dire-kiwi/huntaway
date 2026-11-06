// New in HA-219 (no Rust original): permission prompts over Claude Code's control protocol, and (HA-221) the board's
// tools as an in-process MCP server over the same.
/**
 * A Claude run started with `--permission-prompt-tool stdio` asks for permission on its own output: a `can_use_tool`
 * `control_request` in `out.jsonl`, answered by a `control_response` written to its input (`input.jsonl`, which every
 * run but a compaction has). Each request is the `permission_prompt` call the MCP helper made before (see
 * mcp/tools/dispatch.ts's handle_control), recorded in `mcp_calls` as `stdio:<run id>:<request id>`, so the policy, the
 * thread's `permission` message and the request in `permission_requests` are those of mcp/permissions.ts, as they were.
 *
 * The board's tools are there too, for the Claude runs that take input (RUN_FORMAT 4, launch.ts's `tools_on_output`): the
 * board's MCP server is one of Claude Code's in-process ("SDK") servers, which the `initialize` request at the start of
 * the run's input names (`initialize_line`), so the run's `mcp.json` has no board server and no helper or HTTP server
 * takes its calls. Claude Code sends each MCP message to it as an `mcp_message` control request, answered with the
 * server's JSON-RPC response (`mcp_response`). A `tools/call` is a board call like a helper's (the same dispatch,
 * mcp/tools/dispatch.ts), recorded in `mcp_calls` under the same kind of id, so the call knows its run, and its task,
 * from the run it came in on. The handshake (`initialize`, `tools/list`) is answered at once, and is mostly skipped:
 * `initialize_line` gives Claude Code its results up front. A call Claude Code gives up on is a `notifications/cancelled`
 * message naming its JSON-RPC id (`on_mcp_cancelled`); a prompt it gives up on is a `control_cancel_request`.
 *
 * After a restart, the run's output is followed again from its saved offset, which is past the requests already read:
 * those still open (their calls executing: a prompt, a `wait`) are taken up again from `mcp_calls` (see
 * `resume_requests`), and answered when they're done, or told they were cut short, if they can't be run again. A request
 * read again (the server stopped before its offset was saved) finds the same call.
 */
import * as db from "../../db.ts";
import type { Run } from "../../db.ts";
import type { Shared } from "../../state.ts";
import { background, err_str } from "../../util.ts";
import * as runs from "../runs.ts";
import * as mcp from "../../mcp.ts";
import * as mcp_http from "../../mcp/http.ts";
import * as tools from "../../mcp/tools.ts";
import * as permissions from "../../mcp/permissions.ts";
import * as wait from "../../mcp/wait.ts";
import { MCP_SERVER_NAME } from "../runner.ts";
import { prompt_answer, respond as codex_respond, tool_answer, type CodexRequest } from "../codex/requests.ts";

/** What `--permission-prompt-tool` is for a run that's asked on its output. */
export const PROMPT_TOOL = "stdio";

const CALL_PREFIX = "stdio:";

/**
 * The MCP version whose handshake `initialize_line` gives Claude Code up front. One that asks for another version does
 * the handshake over `mcp_message`, as one that predates the manifests does.
 */
export const MCP_PROTOCOL = "2025-11-25";

/** The request id of a run's `initialize` (see `initialize_line`). */
const INIT_PREFIX = "huntaway-init-";

/** The board call (in `mcp_calls`, see dispatch's handle_control) that is run `run_id`'s request `request_id`. */
export function control_call_id(run_id: string, request_id: string): string {
  return `${CALL_PREFIX}${run_id}:${request_id}`;
}

/**
 * The `initialize` control request that starts the input of a run that calls the board's tools on its output: it
 * registers the board's in-process server, with no time limit on its calls (see mcp/http.ts's BOARD_TIMEOUT_MS) and none
 * of them moved to the background (they may wait on the user), and its handshake's results, so Claude Code needn't ask
 * for them before the first turn.
 */
export function initialize_line(run_id: string, review: boolean): string {
  const request = {
    subtype: "initialize",
    sdkMcpServers: [MCP_SERVER_NAME],
    sdkMcpServerConfigs: { [MCP_SERVER_NAME]: { timeout: mcp_http.BOARD_TIMEOUT_MS, disableAutoBackground: true } },
    sdkMcpServerManifests: { [MCP_SERVER_NAME]: { initializeResult: mcp.initialize_result(MCP_PROTOCOL), toolsListResult: { tools: mcp.tools(review) } } },
  };
  return JSON.stringify({ type: "control_request", request_id: `${INIT_PREFIX}${run_id}`, request });
}

/** Whether `v`, a `control_response` on the run's output, is Claude Code's answer to its `initialize` (see `initialize_line`). */
export function is_initialized(v: any): boolean {
  const id = v?.response?.request_id;
  return typeof id === "string" && id.startsWith(INIT_PREFIX);
}

/**
 * What a request is asked with: the helper's `permission_prompt` arguments, and the request it answers (Claude's control
 * request, or with `codex`, a Codex run's request, see agent/codex/requests.ts).
 */
export interface Asked {
  tool_name: string;
  input: any;
  tool_use_id: string | null;
  request_id: string;
  codex?: CodexRequest;
}

/**
 * A board tool called through `mcp_message`, as its call is recorded (in `mcp_calls.args`): the tool's arguments, and
 * the request and the JSON-RPC id its answer goes back with.
 */
export interface Called {
  request_id: string;
  rpc_id: string | number;
  arguments: any;
  codex?: CodexRequest;
}

/** The calls Claude no longer wants answered (see `cancel_call`), while their prompts settle. */
const cancelled = new Set<string>();

/** A `control_request` from the run's agent (`v`): a permission prompt, an MCP message, or one this board doesn't take. */
export function on_control_request(state: Shared, run: Run, v: any): void {
  const request_id = v?.request_id;
  if (typeof request_id !== "string" || !request_id) return;
  const req = v.request;
  if (req?.subtype === "mcp_message") return on_mcp_message(state, run, request_id, req);
  if (req?.subtype !== "can_use_tool") {
    write(state, run.id, { subtype: "error", request_id, error: `the board doesn't handle ${JSON.stringify(req?.subtype ?? null)} requests` });
    return;
  }
  const asked: Asked = {
    tool_name: typeof req.tool_name === "string" ? req.tool_name : "",
    input: req.input ?? null,
    tool_use_id: typeof req.tool_use_id === "string" ? req.tool_use_id : null,
    request_id,
  };
  ask_permission(state, run.id, control_call_id(run.id, request_id), asked);
}

/** A message for one of the run's in-process MCP servers: the board's is the only one. */
function on_mcp_message(state: Shared, run: Run, request_id: string, req: any): void {
  const msg = req.message !== null && typeof req.message === "object" && !Array.isArray(req.message) ? req.message : {};
  const answer = (mcp_response: any) => write(state, run.id, { subtype: "success", request_id, response: { mcp_response } });
  const rpc_id = msg.id;
  if (req.server_name !== MCP_SERVER_NAME) {
    const message = `there's no MCP server ${JSON.stringify(req.server_name ?? null)} in process`;
    return answer({ jsonrpc: "2.0", id: rpc_id ?? 0, error: { code: -32601, message } });
  }
  // A notification (`notifications/initialized`, `notifications/cancelled`): Claude Code still waits for its control
  // response.
  if (typeof rpc_id !== "string" && typeof rpc_id !== "number") {
    if (msg.method === "notifications/cancelled") on_mcp_cancelled(state, run, msg.params?.requestId);
    return answer({ jsonrpc: "2.0", id: 0, result: {} });
  }
  if (msg.method === "tools/call") {
    const name = typeof msg.params?.name === "string" ? msg.params.name : "";
    call_tool(state, run.id, control_call_id(run.id, request_id), name, { request_id, rpc_id, arguments: msg.params?.arguments ?? null });
    return;
  }
  // The handshake, and pings. It calls nothing.
  const caller: mcp.Caller = { review: reviews(state, run), call: () => Promise.reject(new Error("not a call")) };
  background(`run ${run.id}: MCP ${msg.method}`, mcp.handle(caller, msg).then(answer));
}

/** Whether `run` is a review thread's, which gets the reviewers' tools (as the launch recorded it for the run's servers). */
function reviews(state: Shared, run: Run): boolean {
  const set = mcp_http.settings(state, run.id);
  if (set) return set.review;
  try {
    return db.get_task(state.db(), run.task_id)?.kind === "review";
  } catch {
    return false;
  }
}

/**
 * Claude no longer wants request `v.request_id` answered (its turn was interrupted, say): a permission prompt expires,
 * as it would when the run ends, and the agent isn't answered. (A board call is cancelled with a `notifications/cancelled`
 * instead, see `on_mcp_cancelled`.)
 */
export function on_control_cancel(state: Shared, run: Run, v: any): void {
  const request_id = v?.request_id;
  if (typeof request_id !== "string" || !request_id) return;
  cancel_call(state, run, control_call_id(run.id, request_id));
}

/**
 * Claude Code no longer wants the board call it sent with JSON-RPC id `rpc_id` answered (a sibling tool call failed, or
 * its turn was interrupted): it says so with a `notifications/cancelled` to the in-process server, not a
 * `control_cancel_request`, so the call is found by the id its answer would go back with (saved in `mcp_calls.args`),
 * and ends as one `on_control_cancel` ends.
 */
function on_mcp_cancelled(state: Shared, run: Run, rpc_id: unknown): void {
  if (typeof rpc_id !== "string" && typeof rpc_id !== "number") return;
  let rows: Array<{ id: string; tool: string; args: string }>;
  try {
    rows = open_calls(state, run.id);
  } catch (e) {
    console.warn(`run ${run.id}: finding the board call Claude Code cancelled (${JSON.stringify(rpc_id)}): ${err_str(e)}`);
    return;
  }
  for (const r of rows) {
    let saved: any;
    try {
      saved = JSON.parse(r.args);
    } catch {
      continue;
    }
    if (saved?.rpc_id === rpc_id && !saved.codex) cancel_call(state, run, r.id);
  }
}

/** The permission prompts and board calls of run `run_id` that were executing, as `mcp_calls` has them. */
function open_calls(state: Shared, run_id: string): Array<{ id: string; tool: string; args: string }> {
  return db.all(
    state.db(),
    "SELECT id, tool, args FROM mcp_calls WHERE run_id=?1 AND status='executing' AND substr(id, 1, ?2)=?3",
    run_id,
    CALL_PREFIX.length,
    CALL_PREFIX,
  );
}

/** The agent no longer wants call `call` answered: a prompt it asked expires, a `wait` ends, and it isn't answered. */
export function cancel_call(state: Shared, run: Run, call: string): void {
  // Unless it's been answered already.
  if (!state.calls_inflight.has(call)) return;
  cancelled.add(call);
  try {
    permissions.expire_for_call(state, call);
    wait.clear(state, run.task_id, call);
  } catch (e) {
    console.warn(`run ${run.id}: ending a call the agent no longer wants answered: ${err_str(e)}`);
  }
}

/** After a restart: take up again the requests run `run` was waiting on (see the top of this file). */
export function resume_requests(state: Shared, run: Run): void {
  let rows: Array<{ id: string; tool: string; args: string }>;
  try {
    rows = open_calls(state, run.id);
  } catch (e) {
    console.error(`run ${run.id}: finding its open permission prompts and board calls: ${err_str(e)}`);
    return;
  }
  for (const r of rows) {
    let saved: any;
    try {
      saved = JSON.parse(r.args);
    } catch {
      continue;
    }
    if (typeof saved?.request_id !== "string") continue;
    if (Object.hasOwn(saved, "rpc_id")) {
      console.log(`run ${run.id}: carrying on with board call ${saved.request_id} (${r.tool})`);
      call_tool(state, run.id, r.id, r.tool, saved);
    } else {
      console.log(`run ${run.id}: waiting again on permission prompt ${saved.request_id}`);
      ask_permission(state, run.id, r.id, saved);
    }
  }
}

/** Permission prompt `asked`, call `call_id` of run `run_id`: asked by the board's policy, and answered on the run's input. */
export function ask_permission(state: Shared, run_id: string, call_id: string, asked: Asked): void {
  const respond = (r: { ok: any } | { err: string }) => {
    if (cancelled.delete(call_id)) return;
    // An error is a denial that says what went wrong, as the helper's error result was.
    const response = "ok" in r ? r.ok : { behavior: "deny", message: r.err };
    if (asked.codex) codex_respond(state, run_id, asked.codex.id, { result: prompt_answer(asked.codex, response) });
    else write(state, run_id, { subtype: "success", request_id: asked.request_id, response });
  };
  const call = tools.handle_control(state, { run_id, call_id, tool: "permission_prompt", args: asked }, respond);
  background(`run ${run_id}: permission prompt ${asked.request_id}`, call.finally(() => cancelled.delete(call_id)));
}

/**
 * Board tool `name`'s call, `c`: run at most once, answered with its result as the board's MCP server's response (or,
 * for a Codex run's dynamic tool, as its `item/tool/call`'s).
 */
export function call_tool(state: Shared, run_id: string, call_id: string, name: string, c: Called): void {
  const respond = (r: { ok: any } | { err: string }) => {
    if (cancelled.delete(call_id)) return;
    if (c.codex) return codex_respond(state, run_id, c.codex.id, { result: tool_answer(r, name) });
    const mcp_response = { jsonrpc: "2.0", id: c.rpc_id, result: mcp.call_result(name, r) };
    write(state, run_id, { subtype: "success", request_id: c.request_id, response: { mcp_response } });
  };
  const saved: Called = { request_id: c.request_id, rpc_id: c.rpc_id, arguments: c.arguments };
  if (c.codex) saved.codex = c.codex;
  const p = tools.handle_control(state, { run_id, call_id, tool: name, args: c.arguments, task_fields: true }, respond, saved);
  background(`run ${run_id}: board call ${name} (${c.request_id})`, p.finally(() => cancelled.delete(call_id)));
}

function write(state: Shared, run_id: string, response: any): void {
  const line = JSON.stringify({ type: "control_response", response });
  let sent = false;
  try {
    sent = runs.write_input(state, run_id, line);
  } catch (e) {
    console.warn(`run ${run_id}: answering the agent's ${response.request_id}: ${err_str(e)}`);
    return;
  }
  if (!sent) console.warn(`run ${run_id}: the agent no longer takes input, so its ${response.request_id} wasn't answered`);
}
