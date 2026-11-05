// New in HA-219 (no Rust original): permission prompts over Claude Code's control protocol.
/**
 * A Claude run started with `--permission-prompt-tool stdio` asks for permission on its own output: a `can_use_tool`
 * `control_request` in `out.jsonl`, answered by a `control_response` written to its input (`input.jsonl`, which every
 * run but a compaction has). Each request is the `permission_prompt` call the MCP helper made before (see
 * mcp/tools/dispatch.ts's handle_control), recorded in `mcp_calls` as `stdio:<run id>:<request id>`, so the policy, the
 * thread's `permission` message and the request in `permission_requests` are those of mcp/permissions.ts, as they were.
 *
 * After a restart, the run's output is followed again from its saved offset, which is past the requests already read:
 * those still open (their calls executing) are taken up again from `mcp_calls` (see `resume_requests`), and answered
 * when the user answers. A request read again (the server stopped before its offset was saved) finds the same call.
 */
import * as db from "../../db.ts";
import type { Run } from "../../db.ts";
import type { Shared } from "../../state.ts";
import { background, err_str } from "../../util.ts";
import * as runs from "../runs.ts";
import * as tools from "../../mcp/tools.ts";
import * as permissions from "../../mcp/permissions.ts";

/** What `--permission-prompt-tool` is for a run that's asked on its output. */
export const PROMPT_TOOL = "stdio";

const CALL_PREFIX = "stdio:";

/** The board call (in `mcp_calls`, see dispatch's handle_control) that is run `run_id`'s request `request_id`. */
export function control_call_id(run_id: string, request_id: string): string {
  return `${CALL_PREFIX}${run_id}:${request_id}`;
}

/** What a request is asked with: the helper's `permission_prompt` arguments, and the request it answers. */
interface Asked {
  tool_name: string;
  input: any;
  tool_use_id: string | null;
  request_id: string;
}

/** The calls Claude no longer wants answered (see `on_control_cancel`), while their prompts settle. */
const cancelled = new Set<string>();

/** A `control_request` from the run's agent (`v`): a permission prompt, or one this board doesn't take. */
export function on_control_request(state: Shared, run: Run, v: any): void {
  const request_id = v?.request_id;
  if (typeof request_id !== "string" || !request_id) return;
  const req = v.request;
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
  ask(state, run.id, control_call_id(run.id, request_id), asked);
}

/**
 * Claude no longer wants request `v.request_id` answered (its turn was interrupted, say): the prompt expires, as it
 * would when the run ends, and the agent isn't answered.
 */
export function on_control_cancel(state: Shared, run: Run, v: any): void {
  const request_id = v?.request_id;
  if (typeof request_id !== "string" || !request_id) return;
  const call = control_call_id(run.id, request_id);
  // Unless it's been answered already.
  if (!state.calls_inflight.has(call)) return;
  cancelled.add(call);
  try {
    permissions.expire_for_call(state, call);
  } catch (e) {
    console.warn(`run ${run.id}: expiring a prompt the agent no longer wants answered: ${err_str(e)}`);
  }
}

/** After a restart: take up again the requests run `run` was waiting on (see the top of this file). */
export function resume_requests(state: Shared, run: Run): void {
  let rows: Array<{ id: string; args: string }>;
  try {
    rows = db.all(state.db(), "SELECT id, args FROM mcp_calls WHERE run_id=?1 AND status='executing' AND substr(id, 1, ?2)=?3", run.id, CALL_PREFIX.length, CALL_PREFIX);
  } catch (e) {
    console.error(`run ${run.id}: finding its open permission prompts: ${err_str(e)}`);
    return;
  }
  for (const r of rows) {
    let asked: Asked;
    try {
      asked = JSON.parse(r.args);
    } catch {
      continue;
    }
    if (typeof asked?.request_id !== "string") continue;
    console.log(`run ${run.id}: waiting again on permission prompt ${asked.request_id}`);
    ask(state, run.id, r.id, asked);
  }
}

function ask(state: Shared, run_id: string, call_id: string, asked: Asked): void {
  const respond = (r: { ok: any } | { err: string }) => {
    if (cancelled.delete(call_id)) return;
    // An error is a denial that says what went wrong, as the helper's error result was.
    const response = "ok" in r ? r.ok : { behavior: "deny", message: r.err };
    write(state, run_id, { subtype: "success", request_id: asked.request_id, response });
  };
  const call = tools.handle_control(state, { run_id, call_id, tool: "permission_prompt", args: asked }, respond);
  background(`run ${run_id}: permission prompt ${asked.request_id}`, call.finally(() => cancelled.delete(call_id)));
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
