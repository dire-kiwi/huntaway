/**
 * The board's MCP servers, served over HTTP (MCP's streamable HTTP transport) to the runs this host starts (HA-180):
 * the board's tools (`huntaway`, mcp.ts) and GitHub through gh (`gh`, mcp/gh_mcp.ts). Runs used to start a stdio helper
 * process for each (`huntaway mcp` and `huntaway gh-mcp`), which under Node cost about 90 MB apiece; those stay for runs
 * that were started with them. Claude runs that take input (all but a compaction's) call the board's tools on their
 * own output instead (HA-221, see agent/runner/requests.ts), so for them this serves only gh's; Codex runs and
 * compactions still call the board's here.
 *
 * Each run has its servers at `/api/mcp/<run id>/<server>` on the host's internal URL, with a secret of its own as its
 * bearer token (`run_secret`): a run can only act as itself, and never holds the host's token. What the gh server needs
 * of the run (its directory, its GitHub account) the launch keeps in the run's folder (`SETTINGS_FILE`), not in what the
 * agent sends.
 *
 * A tool call is answered as a server-sent event stream, which starts with an event that has an id and no data (MCP's
 * priming event) and a `retry` time. If the stream breaks, as it does when this server restarts, Claude Code and Codex
 * reconnect with a GET that names that id (`Last-Event-ID`), and the call's answer comes on that stream instead (see
 * `resume`). The id names the board call (`mcp_calls`), which carries on as a helper's retried call did: a permission
 * prompt or a `wait` keeps waiting, a finished call's answer is the one it recorded, and a call that a restart cut
 * short says so. Claude Code tries twice, `RETRY_MS` apart, before it gives up on a call (and the agent sees that it
 * failed); Codex keeps trying, with backoff. Claude Code also drops a call 90 seconds after its connection broke unless
 * it has had progress since, so its calls get progress notifications (see `reply`).
 */
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import * as db from "../db.ts";
import { readBody } from "../http.ts";
import * as mcp from "../mcp.ts";
import * as runner from "../agent/runner.ts";
import * as runs from "../agent/runs.ts";
import { VIA_BROKER } from "../hosts/broker.ts";
import * as merge_gate from "../review/merge_gate.ts";
import type { Shared } from "../state.ts";
import { background, err_str, new_id, same_secret } from "../util.ts";
import * as gh_mcp from "./gh_mcp.ts";
import * as tools from "./tools.ts";

/** Where runs' MCP servers are, under the host's internal URL. */
export const PREFIX = "/api/mcp/";

/** The run's settings the launch records for its servers, in the run's folder. */
export const SETTINGS_FILE = "mcp-run.json";

/**
 * How long a client waits before it reconnects to a call's broken stream, in ms. Claude Code tries twice, so a restart
 * that takes longer than about twice this fails the calls that were going (a restart takes a second or two).
 */
export const RETRY_MS = 5000;

/** A progress notification (or a comment) on a call's stream this often (see `reply`). */
const KEEPALIVE_MS = 20_000;

/** How long a gh call's answer is kept for a client that reconnects for it. */
const KEPT_MS = 10 * 60_000;

/** Claude Code's per-server `timeout` (ms): without one, it gives up on an HTTP server's call after 5 minutes without news. */
export const BOARD_TIMEOUT_MS = 86_400_000;
/** gh commands time out after 10 minutes (gh_mcp.ts's TIMEOUT). */
const GH_TIMEOUT_MS = 900_000;

export interface RunSettings {
  /** The run's directory, where gh calls without a `dir` run. */
  cwd: string;
  /** The GitHub account the gh server acts as (see gh_mcp::Account), if not gh's active one. */
  github_account: string | null;
  /** A review thread's run: the board's server offers the reviewers' tools. */
  review: boolean;
  /**
   * The run calls the board's tools on its own output (an in-process MCP server, see agent/runner/requests.ts), so it
   * has no board server here: only gh's.
   */
  in_process: boolean;
}

/** The secret run `run_id` gives as its bearer token. Derived from the host's token, so a restart needn't keep it. */
export function run_secret(token: string, run_id: string): string {
  return createHmac("sha256", token).update(`mcp:${run_id}`).digest("hex");
}

/** Whether a request's `Authorization` is run `run_id`'s secret. */
export function run_authorized(s: Shared, run_id: string, headers: Record<string, any>): boolean {
  const auth = headers["authorization"];
  return typeof auth === "string" && auth.startsWith("Bearer ") && same_secret(auth.slice(7), run_secret(s.token, run_id));
}

export function server_url(s: Shared, run_id: string, server: string): string {
  return `${s.internal_url}${PREFIX}${encodeURIComponent(run_id)}/${server}`;
}

/** The run's `mcpServers` entries for the board's two servers. */
export function servers(s: Shared, run_id: string): Record<string, any> {
  const headers = { Authorization: `Bearer ${run_secret(s.token, run_id)}` };
  return {
    [runner.MCP_SERVER_NAME]: { type: "http", url: server_url(s, run_id, runner.MCP_SERVER_NAME), headers, timeout: BOARD_TIMEOUT_MS },
    [gh_mcp.SERVER_NAME]: { type: "http", url: server_url(s, run_id, gh_mcp.SERVER_NAME), headers, timeout: GH_TIMEOUT_MS },
  };
}

/** What the launch kept for run `run_id`'s servers (see `settings_json`), or null for a run it kept nothing for. */
export function settings(s: Shared, run_id: string): RunSettings | null {
  try {
    const v = JSON.parse(readFileSync(join(runs.run_dir(s, run_id), SETTINGS_FILE), "utf8"));
    return {
      cwd: String(v.cwd ?? ""),
      github_account: typeof v.github_account === "string" ? v.github_account : null,
      review: v.review === true,
      in_process: v.in_process === true,
    };
  } catch {
    return null;
  }
}

/** The board's server for a run: its calls go straight to the board's tools, as call `call_id`. */
function board(s: Shared, run_id: string, set: RunSettings, call_id: string): mcp.Caller {
  return { review: set.review, call: (tool, args) => tools.handle_mcp(s, { run_id, call_id, tool, args, task_fields: true }) };
}

/** The gh server's run: the board decides on merges itself. */
function gh_run(s: Shared, run_id: string, set: RunSettings): gh_mcp.GhRun {
  const account = set.github_account === null ? null : gh_mcp.Account.parse(set.github_account);
  return {
    cwd: set.cwd || null,
    account,
    merge_gate: async () => {
      const c = s.db();
      const run = db.get_run(c, run_id);
      const task = run ? db.get_task(c, run.task_id) : undefined;
      return task ? (merge_gate.blocked(c, task) ?? null) : null;
    },
  };
}

/** gh calls' answers, by their streams' event id, while they run and for `KEPT_MS` after. Board calls are in `mcp_calls`. */
const gh_calls = new Map<string, Promise<any>>();

const b64 = (v: any) => Buffer.from(JSON.stringify(v ?? null)).toString("base64url");
const unb64 = (s: string) => JSON.parse(Buffer.from(s, "base64url").toString());

/**
 * A call's stream's event id: which server, its board call (or a gh call's own id), the request's JSON-RPC id, and its
 * progress token if it has one (see `reply`).
 */
function event_id(server: string, call_id: string, rpc_id: any, progress: any): string {
  return `${server}.${call_id}.${b64(rpc_id)}${progress === undefined ? "" : `.${b64(progress)}`}`;
}

function parse_event_id(id: string): { server: string; call_id: string; rpc_id: any; progress: any } | null {
  const m = /^([a-z_]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]*)(?:\.([A-Za-z0-9_-]*))?$/.exec(id);
  if (!m) return null;
  try {
    return { server: m[1], call_id: m[2], rpc_id: unb64(m[3]), progress: m[4] === undefined ? undefined : unb64(m[4]) };
  } catch {
    return null;
  }
}

const json = (res: ServerResponse, status: number, v: any, headers: Record<string, string> = {}) => {
  res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(v));
};
const rpc_error = (id: any, code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
const tool_error = (id: any, text: string) => ({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], isError: true } });

/** Answer `req` (a request under `PREFIX`). */
export async function serve(s: Shared, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = (req.url ?? "/").split("?")[0];
  const m = /^\/api\/mcp\/([^/]+)\/([^/]+)$/.exec(path);
  // Only for agents on this host: not through the broker, as no route under /api/mcp is.
  if (!m || req.headers[VIA_BROKER] !== undefined) return json(res, 404, { error: "not found" });
  let run_id: string;
  try {
    run_id = decodeURIComponent(m[1]);
  } catch {
    return json(res, 404, { error: "not found" });
  }
  const server = m[2];
  if (server !== runner.MCP_SERVER_NAME && server !== gh_mcp.SERVER_NAME) return json(res, 404, { error: "not found" });
  if (!run_authorized(s, run_id, req.headers)) return json(res, 401, { error: "unauthorized" });
  const set = settings(s, run_id);
  if (!set) return json(res, 404, { error: "unknown run" });
  // Its board tools are answered on its own output.
  if (set.in_process && server === runner.MCP_SERVER_NAME) return json(res, 404, { error: "not found" });

  if (req.method === "GET") {
    const last = req.headers["last-event-id"];
    // No stream of the server's own: it sends nothing but answers.
    if (typeof last !== "string") return json(res, 405, rpc_error(null, -32000, "Method not allowed"), { allow: "POST" });
    return resume(s, res, run_id, server, set, last);
  }
  if (req.method !== "POST") return json(res, 405, rpc_error(null, -32000, "Method not allowed"), { allow: "POST" });

  let msg: any;
  try {
    msg = JSON.parse((await readBody(req, 32 << 20)).toString("utf8"));
  } catch {
    return json(res, 400, rpc_error(null, -32700, "Parse error"));
  }
  if (Array.isArray(msg)) return json(res, 400, rpc_error(null, -32600, "batches aren't supported"));
  // Notifications (`initialized`, `cancelled`) and responses get no answer.
  if (!msg || typeof msg !== "object" || typeof msg.method !== "string" || !Object.hasOwn(msg, "id")) return void res.writeHead(202).end();

  if (msg.method !== "tools/call") {
    const caller = board(s, run_id, set, new_id());
    const answer = server === gh_mcp.SERVER_NAME ? await gh_mcp.handle(msg, gh_run(s, run_id, set)) : await mcp.handle(caller, msg);
    return json(res, 200, answer);
  }
  const call_id = new_id();
  const token = msg.params?._meta?.progressToken;
  const progress = typeof token === "string" || typeof token === "number" ? token : undefined;
  const id = event_id(server, call_id, msg.id, progress);
  let answer: Promise<any>;
  if (server === gh_mcp.SERVER_NAME) {
    answer = gh_mcp.handle(msg, gh_run(s, run_id, set));
    gh_calls.set(id, answer);
    const forget = () => setTimeout(() => gh_calls.delete(id), KEPT_MS).unref();
    answer.then(forget, forget);
  } else {
    answer = mcp.handle(board(s, run_id, set, call_id), msg);
  }
  reply(req, res, id, msg.id, progress, answer);
}

/**
 * Answer a call: on an event stream, if the client takes one (both do), else as JSON once it's done. A call with a
 * progress token (Claude Code's) gets a progress notification when its stream opens and every `KEEPALIVE_MS`: Claude
 * Code drops a call 90 seconds after its connection broke unless the call has made progress since (so a call that
 * reconnected after a restart would be lost a minute and a half later), and gives up on a call after a while without
 * any (see `BOARD_TIMEOUT_MS`).
 */
function reply(req: IncomingMessage, res: ServerResponse, event: string, rpc_id: any, progress: any, answer: Promise<any>) {
  const done = answer.catch((e) => rpc_error(rpc_id, -32603, err_str(e)));
  const accept = String(req.headers.accept ?? "");
  if (!accept.includes("text/event-stream")) {
    background(
      "answering an MCP call",
      done.then((v) => {
        if (!res.destroyed) json(res, 200, v);
      }),
    );
    return;
  }
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  res.write(`id: ${event}\nretry: ${RETRY_MS}\ndata: \n\n`);
  const tick = () => {
    if (progress === undefined) return void res.write(": keepalive\n\n");
    // Its value only has to grow, across a restart too.
    const note = { jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: progress, progress: Math.floor(Date.now() / 1000) } };
    res.write(`id: ${event}\nevent: message\ndata: ${JSON.stringify(note)}\n\n`);
  };
  tick();
  const keepalive = setInterval(tick, KEEPALIVE_MS);
  keepalive.unref();
  res.on("close", () => clearInterval(keepalive));
  background(
    "answering an MCP call",
    done.then((v) => {
      clearInterval(keepalive);
      if (!res.destroyed && !res.writableEnded) res.end(`id: ${event}\nevent: message\ndata: ${JSON.stringify(v)}\n\n`);
    }),
  );
}

/** A client reconnecting for a call's answer (its stream broke): the call's answer comes on this stream. */
function resume(s: Shared, res: ServerResponse, run_id: string, server: string, set: RunSettings, last: string) {
  const ev = parse_event_id(last);
  if (!ev || ev.server !== server) return json(res, 404, rpc_error(null, -32000, "unknown event id"));
  console.error(`${new Date().toISOString()}  INFO mcp: run=${run_id} reconnected for its ${server} call ${ev.call_id}`);
  const fake = { headers: { accept: "text/event-stream" } } as unknown as IncomingMessage;
  if (server === gh_mcp.SERVER_NAME) {
    const kept = gh_calls.get(last);
    const answer =
      kept ??
      Promise.resolve(
        tool_error(
          ev.rpc_id,
          "The board's server restarted while this gh call ran, so its output is lost: it may or may not have taken effect. Check before you run it again.",
        ),
      );
    return reply(fake, res, last, ev.rpc_id, ev.progress, answer);
  }
  // The board's call, which picks up where it was (see tools::handle_mcp): its record has what it was.
  let row: any;
  try {
    row = db.one(s.db(), "SELECT run_id, tool, args FROM mcp_calls WHERE id=?1", ev.call_id);
  } catch (e) {
    return reply(
      fake,
      res,
      last,
      ev.rpc_id,
      ev.progress,
      Promise.resolve(tool_error(ev.rpc_id, `The board couldn't look up this call: ${err_str(e)}. Call it again.`)),
    );
  }
  if (row && row.run_id !== run_id) return json(res, 404, rpc_error(null, -32000, "unknown event id"));
  // Not recorded, so it never ran: the server stopped before it got to it.
  if (!row)
    return reply(
      fake,
      res,
      last,
      ev.rpc_id,
      ev.progress,
      Promise.resolve(tool_error(ev.rpc_id, "The board's server restarted before this call ran, so it wasn't run: call it again.")),
    );
  let args: any = null;
  try {
    args = JSON.parse(row.args);
  } catch {}
  const msg = { jsonrpc: "2.0", id: ev.rpc_id, method: "tools/call", params: { name: row.tool, arguments: args } };
  reply(fake, res, last, ev.rpc_id, ev.progress, mcp.handle(board(s, run_id, set, ev.call_id), msg));
}

/** What the launch keeps for the run's servers (see `settings`). */
export function settings_json(l: { cwd: string; github_account: string | null; review: boolean; in_process?: boolean }): string {
  const v: RunSettings = { cwd: l.cwd, github_account: l.github_account, review: l.review, in_process: l.in_process === true };
  return JSON.stringify(v, null, 2);
}
