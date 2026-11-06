// Port of server/src/agent/codex/adapter.rs.
/** The adapter, `huntaway codex-run`: runs Codex turns for a run, with its MCP servers, input and approvals. */
import { readFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { REVIEW_PROFILE, thread_params, uses_profile, Spec_from_json, type Spec } from "../codex.ts";
import { own_thread } from "./output.ts";
import { Channel, Responder, Rpc } from "./rpc.ts";
import * as runner from "../runner.ts";
import * as gh_mcp from "../../mcp/gh_mcp.ts";
import * as wait from "../../mcp/wait.ts";
import * as approval_rules from "../approval_rules.ts";
import * as google from "../assistant/google.ts";
import { context, err_str, expand_tilde } from "../../util.ts";

export { Responder } from "./rpc.ts";

/** Notifications worth keeping in `out.jsonl`; the rest (output deltas, moderation, read state…) are noise or too bulky. */
const KEEP = [
  "thread/started",
  "thread/status/changed",
  "thread/closed",
  "turn/started",
  "turn/completed",
  "turn/plan/updated",
  "item/started",
  "item/completed",
  "item/agentMessage/delta",
  "thread/compacted",
  "thread/tokenUsage/updated",
  "account/rateLimits/updated",
  "error",
  "warning",
  "model/rerouted",
  "mcpServer/startupStatus/updated",
];

/** `v`, or null where serde_json would read a missing field as `Value::Null`. */
const g = (v: any) => (v === undefined ? null : v);
const is_obj = (v: any) => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v: any): string | null => (typeof v === "string" ? v : null);

/** Translate a Claude-style `mcpServers` entry into Codex's `mcp_servers` config. */
export function mcp_server_config(name: string, c: any, approved: boolean, disabled: string[], review_waits: boolean): any | null {
  const out: any = {};
  const type = str(c?.type) ?? "stdio";
  if (type === "stdio") {
    if (c.command === undefined) return null;
    out.command = c.command;
    for (const k of ["args", "env"]) if (c[k] !== undefined && c[k] !== null) out[k] = c[k];
  } else if (type === "http" || type === "streamable-http") {
    if (c.url === undefined) return null;
    out.url = c.url;
    if (is_obj(c.headers) && Object.keys(c.headers).length) out.http_headers = c.headers;
  } else {
    console.error(`skipping MCP server ${name}: Codex doesn't support ${type} servers`);
    return null;
  }
  if (name === runner.MCP_SERVER_NAME) {
    // send_to_task and friends can take a while (e.g. setting up a worktree), and wait
    // blocks for as long as it's asked to.
    out.tool_timeout_sec = wait.MAX_SECS + 300;
  } else if (name === gh_mcp.SERVER_NAME) {
    // As can gh.
    out.tool_timeout_sec = 600;
  } else if (google.is_google(name)) {
    // uvx fetches workspace-mcp the first time, which takes longer than Codex's 10s default for a start.
    out.startup_timeout_sec = 120;
  }
  if (approved || name === runner.MCP_SERVER_NAME) out.default_tools_approval_mode = "approve";
  if (name === runner.MCP_SERVER_NAME && review_waits) {
    // Every wait goes to the reviewer, which sees its arguments: a wait's command runs as
    // the agent's own commands would (see mcp/tools.rs).
    out.tools = { wait: { approval_mode: "prompt" } };
  }
  if (disabled.length) out.disabled_tools = disabled;
  return out;
}

/** `huntaway codex-run <run-dir>/codex.json`, with the prompt on stdin. Exits the process once it's done. */
export async function run_adapter(spec_path: string): Promise<void> {
  let raw: string;
  try {
    raw = readFileSync(spec_path, "utf8");
  } catch (e) {
    throw context("reading codex.json", e);
  }
  const spec = Spec_from_json(JSON.parse(raw));
  if (!spec) throw new Error("codex.json isn't a run's spec");
  const dir = dirname(spec_path);
  let mcp_raw: string;
  try {
    mcp_raw = readFileSync(join(dir, "mcp.json"), "utf8");
  } catch (e) {
    throw context("reading mcp.json", e);
  }
  const mcp_json = JSON.parse(mcp_raw);
  let rpc: Rpc | null = null;
  let children: ChildThreads | null = null;
  try {
    const input = spec.input ? read_input() : null;
    // The app-server's requests the board hasn't answered yet (see Requests).
    const requests = new Requests(spec.requests_on_output && input !== null);
    let prompt: string;
    if (input) {
      const first = await input.recv();
      if (!first || first.type !== "user") throw new Error("the run's input didn't start with the prompt");
      prompt = first.text;
    } else {
      prompt = await read_stdin();
    }

    const servers: Record<string, any> = {};
    const all = is_obj(mcp_json?.mcpServers) ? mcp_json.mcpServers : {};
    for (const name of Object.keys(all).sort()) {
      const disabled = spec.disabled_mcp_tools[name] ?? [];
      const cfg = mcp_server_config(name, all[name], spec.approved_mcp_servers.includes(name), disabled, spec.review_waits);
      // The user's approval rules (see agent/approval_rules.ts) may ask about its calls, or turn it off.
      const on = spec.approval_rules && is_obj(cfg) ? approval_rules.codex_server(spec.approval_rules, name, cfg) : true;
      if (cfg && on) servers[name] = cfg;
    }
    const cwd = expand_tilde(spec.cwd);
    // CODEX_HOME comes from the shim's environment, if the config has its own.
    rpc = Rpc.start(null, cwd);
    await rpc.initialize();
    if (spec.skills_dir != null) {
      try {
        await rpc.request("skills/extraRoots/set", { extraRoots: [spec.skills_dir] });
      } catch (e) {
        console.error(`couldn't add the project's skills: ${err_str(e)}`);
      }
    }

    const params = thread_params(spec, cwd, servers);
    let started: any;
    if (spec.thread_id != null) {
      params.threadId = spec.thread_id;
      params.excludeTurns = true;
      started = await rpc.request("thread/resume", params);
    } else {
      started = await start_thread(rpc, params, spec.board_tools);
    }
    const thread_id = str(started?.thread?.id);
    if (thread_id === null) throw new Error("no thread id");
    if (spec.revert_before_turn != null && spec.thread_id != null) {
      try {
        await rpc.request("thread/revert", { threadId: thread_id, beforeTurnId: spec.revert_before_turn });
      } catch (e) {
        throw context("couldn't take the conversation back to before the turn a rewind went back to", e);
      }
    }
    // A Codex without permission profiles ignores ours: its turns are made read-only instead.
    const read_only = uses_profile(spec) && started?.activePermissionProfile?.id !== REVIEW_PROFILE;
    if (read_only) console.error(`codex didn't take the ${REVIEW_PROFILE} permission profile, so the sandbox is read-only`);
    if (spec.thread_id == null) {
      // So the session is known even if `thread/started` is missed.
      emit({ method: "thread/started", params: { thread: { id: thread_id } } });
    }

    const reply = rpc.sender();
    // Items seen so far, for approvals that only name theirs.
    const items = new Map<string, any>();
    children = new ChildThreads(thread_id);
    if (spec.compact) {
      await rpc.request("thread/compact/start", { threadId: thread_id });
      for (;;) {
        const msg = await rpc.incoming.recv();
        if (msg === null) break;
        const method = str(msg.method) ?? "";
        if (on_incoming(requests, reply, items, children, msg)) continue;
        if ((method === "turn/completed" || method === "thread/compacted") && own_thread(msg.params, thread_id)) return finish(rpc, children);
      }
      throw new Error("codex app-server exited before compacting the conversation");
    }

    const model = spec.model ?? str(started?.model);
    // For the board's count of the tokens each model used (see agent/tokens.rs).
    if (model != null) emit({ method: "huntaway/model", params: { threadId: thread_id, model } });
    const turn = new Turn(thread_id, spec, model, read_only);
    let turn_id: string | null = await turn.start(rpc, prompt);
    // Steered into the turn, but the model hasn't acted since: (uuid, text).
    let steered: Array<[string, string]> = [];
    let input_open = input !== null;
    let next_msg: Promise<any> | null = null;
    let next_line: Promise<Input | null> | null = null;
    for (;;) {
      next_msg ??= rpc.incoming.recv();
      if (input_open) next_line ??= input!.recv();
      const arms: Array<Promise<{ k: "msg" | "line"; v: any }>> = [next_msg.then((v) => ({ k: "msg" as const, v }))];
      if (input_open && next_line) arms.push(next_line.then((v) => ({ k: "line" as const, v })));
      const got = await Promise.race(arms);
      if (got.k === "msg") {
        next_msg = null;
        const msg = got.v;
        if (msg === null) {
          const status = rpc.exit_status();
          throw new Error(`codex app-server exited before the turn ended${status ? ` (${status})` : ""}`);
        }
        const method = str(msg.method) ?? "";
        // The model has moved on, so it has seen what was steered in before.
        if (method === "item/started" && own_thread(msg.params, thread_id) && msg.params?.item?.type !== "userMessage") {
          for (const [id, text] of steered.splice(0)) replay(id, text);
        }
        if (on_incoming(requests, reply, items, children, msg)) continue;
        if (method === "turn/completed" && own_thread(msg.params, thread_id) && turn_id !== null && str(msg.params?.turn?.id) === turn_id) {
          turn_id = null;
          // Steered in too late to be acted on (or the turn was interrupted): they start
          // the next turn, as Claude Code does with messages still queued.
          if (steered.length) {
            const taken = steered.splice(0);
            turn_id = await turn.start(rpc, taken.map(([, t]) => t).join("\n\n"));
            for (const [id, text] of taken) replay(id, text);
          } else if (!input_open) break;
        }
      } else {
        next_line = null;
        const line: Input | null = got.v;
        if (line === null) {
          input_open = false;
          requests.closed(reply);
          if (turn_id === null) break;
        } else if (line.type === "response") {
          requests.answered(reply, line);
        } else if (line.type === "user") {
          if (turn_id !== null) {
            const params = {
              threadId: thread_id,
              expectedTurnId: turn_id,
              clientUserMessageId: line.id,
              input: [{ type: "text", text: line.text, text_elements: [] }],
            };
            try {
              await rpc.request("turn/steer", params);
            } catch (e) {
              // The turn is over already: this starts the next one, below.
              console.error(`steering failed, sending it as the next turn: ${err_str(e)}`);
            }
            steered.push([line.id, line.text]);
          } else {
            turn_id = await turn.start(rpc, line.text);
            replay(line.id, line.text);
          }
        } else if (turn_id !== null) {
          try {
            await rpc.request("turn/interrupt", { threadId: thread_id, turnId: turn_id });
          } catch (e) {
            console.error(`interrupting the turn failed: ${err_str(e)}`);
          }
        }
      }
    }
    return finish(rpc, children);
  } finally {
    // As Rust drops them: the app-server is killed, and the children it can no longer report are closed.
    children?.drop();
    rpc?.kill();
  }
}

/** The adapter is done: nothing it started (approvals still waiting on the board, stdin) keeps the process alive. */
function finish(rpc: Rpc, children: ChildThreads): never {
  children.drop();
  rpc.kill();
  process.stdin.destroy();
  process.exit(0);
}

/** Starts the run's turns. */
class Turn {
  thread_id: string;
  spec: Spec;
  model: string | null;
  /** Override the thread's sandbox with a read-only one. */
  read_only: boolean;
  constructor(thread_id: string, spec: Spec, model: string | null, read_only: boolean) {
    this.thread_id = thread_id;
    this.spec = spec;
    this.model = model;
    this.read_only = read_only;
  }

  /** Start a turn with `text` as its input. Returns its id. */
  async start(rpc: Rpc, text: string): Promise<string> {
    const turn: any = { threadId: this.thread_id, input: [{ type: "text", text, text_elements: [] }], summary: "detailed" };
    if (this.spec.effort != null) turn.effort = this.spec.effort;
    if (this.read_only) turn.sandboxPolicy = { type: "readOnly" };
    if (this.spec.plan && this.model != null) {
      turn.collaborationMode = { mode: "plan", settings: { model: this.model, reasoning_effort: this.spec.effort ?? null } };
    }
    const r = await rpc.request("turn/start", turn);
    const id = str(r?.turn?.id);
    if (id === null) throw new Error("turn/start returned no turn id");
    return id;
  }
}

/**
 * Handle a notification or request from the app-server: requests (approvals, questions, the board's tools) go to the
 * board (see Requests), and the notifications worth keeping to stdout. Returns true for requests.
 */
function on_incoming(requests: Requests, reply: Responder, items: Map<string, any>, children: ChildThreads, msg: any): boolean {
  children.observe(msg);
  const method = str(msg.method) ?? "";
  if ("id" in msg) {
    const item_id = str(msg.params?.itemId);
    const item = item_id !== null ? (items.get(item_id) ?? null) : null;
    requests.asked(reply, msg, item);
    return true;
  }
  if (method === "item/started") {
    const id = str(msg.params?.item?.id);
    if (id !== null) items.set(id, msg.params.item);
  }
  if (method === "serverRequest/resolved") requests.resolved(msg);
  else if (KEEP.includes(method)) emit(msg);
  return false;
}

/**
 * The app-server's requests, answered by the board (with `Spec::requests_on_output`): each is written to stdout as it
 * is (with the item it's about, which an approval only names, as `item`), and its answer comes back on stdin as a
 * `codex_response` line, which is passed on. One the app-server stops waiting for (`serverRequest/resolved`: the turn
 * was interrupted, say) is told to the board, unless the board answered it already. Without the board (a compaction,
 * which takes no input), requests are declined here.
 */
class Requests {
  private open = new Map<string, any>();
  private board: boolean;
  constructor(board: boolean) {
    this.board = board;
  }

  asked(reply: Responder, msg: any, item: any | null) {
    if (!this.board) return decline(reply, msg);
    this.open.set(JSON.stringify(msg.id ?? null), msg);
    emit(item !== null ? { ...msg, item } : msg);
  }

  /** The board can't answer any more (the run's input ended): what it hasn't answered is declined. */
  closed(reply: Responder) {
    this.board = false;
    for (const msg of this.open.values()) decline(reply, msg);
    this.open.clear();
  }

  /** The board's answer to request `r.id`. */
  answered(reply: Responder, r: { id: any; result?: any; error?: any }) {
    if (!this.open.delete(JSON.stringify(r.id ?? null))) return;
    if (r.error !== undefined) reply.error(r.id, typeof r.error?.message === "string" ? r.error.message : "the board couldn't answer this");
    else reply.result(r.id, r.result ?? null);
  }

  resolved(msg: any) {
    if (this.open.delete(JSON.stringify(msg.params?.requestId ?? null))) emit(msg);
  }
}

/** A request answered with no board to ask: approvals are declined, questions unanswered, the board's tools unavailable. */
function decline(reply: Responder, msg: any) {
  const id = g(msg.id);
  const p = msg.params ?? {};
  switch (str(msg.method) ?? "") {
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval":
      return reply.result(id, { decision: "decline" });
    case "item/permissions/requestApproval":
      return reply.result(id, { permissions: {}, scope: "turn" });
    case "mcpServer/elicitation/request":
      return reply.result(id, { action: "decline" });
    case "item/tool/requestUserInput":
      return reply.result(id, { answers: {} });
    case "item/tool/call":
      return reply.result(id, { contentItems: [{ type: "inputText", text: `The board's ${str(p.tool) ?? ""} tool isn't available in this run.` }], success: false });
    default:
      reply.error(id, `Method not supported by Huntaway: ${str(msg.method) ?? ""}`);
  }
}

/**
 * `thread/start`, with the board's tools as dynamic tools (`Spec::board_tools`). A Codex that doesn't take dynamic
 * tools starts the thread without them, and says so.
 */
async function start_thread(rpc: Rpc, params: any, tools: any | null): Promise<any> {
  if (tools === null) return rpc.request("thread/start", params);
  try {
    return await rpc.request("thread/start", { ...params, dynamicTools: [tools] });
  } catch (e) {
    if (!/dynamic.?tools|experimental|unknown field/i.test(err_str(e))) throw e;
    emit({ method: "warning", params: { message: `This Codex doesn't take the board's tools (${err_str(e)}), so the agent hasn't them.` } });
    return rpc.request("thread/start", params);
  }
}

/**
 * Killing the app-server stops its children too, but it can't report their closure after it
 * exits. Keep that outcome in the transcript so old children stay stopped on the next run.
 */
class ChildThreads {
  main: string;
  ids = new Set<string>();
  private dropped = false;
  constructor(main: string) {
    this.main = main;
  }

  observe(msg: any) {
    const p = msg?.params ?? {};
    const item = p.item ?? {};
    const ids = [str(p.threadId), str(p.thread?.id), str(item.agentThreadId)];
    if (Array.isArray(item.receiverThreadIds)) ids.push(...item.receiverThreadIds.map(str));
    for (const id of ids) if (id !== null && id !== this.main) this.ids.add(id);
    if (msg?.method === "thread/closed") {
      const id = str(p.threadId);
      if (id !== null) this.ids.delete(id);
    }
  }

  /** Rust's `Drop`. */
  drop() {
    if (this.dropped) return;
    this.dropped = true;
    for (const id of [...this.ids].sort()) emit({ method: "thread/closed", params: { threadId: id } });
  }
}

/** A line of the adapter's stream-json input. */
type Input = { type: "user"; id: string; text: string } | { type: "interrupt" } | { type: "response"; id: any; result?: any; error?: any };

/** Read stdin's stream-json lines until it ends. */
function read_input(): Channel<Input> {
  const ch = new Channel<Input>();
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on("line", (line) => {
    let v: any;
    try {
      v = JSON.parse(line);
    } catch {
      return;
    }
    if (v?.type === "user") ch.send({ type: "user", id: str(v.uuid) ?? "", text: user_text(v.message?.content) });
    else if (v?.type === "control_request" && v.request?.subtype === "interrupt") ch.send({ type: "interrupt" });
    else if (v?.type === "codex_response" && "id" in v) ch.send({ type: "response", id: v.id, result: v.result, error: v.error });
  });
  lines.on("close", () => ch.close());
  return ch;
}

/** All of stdin. */
function read_stdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (c: Buffer) => chunks.push(c));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
}

/** A stream-json user message's text: a string, or text blocks. */
function user_text(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((b) => str(b?.text)).filter((t) => t !== null).join("\n\n");
  return "";
}

/** Echo a message back once the model has taken it in, shaped like Claude Code's `--replay-user-messages`. */
function replay(id: string, text: string) {
  emit({ type: "user", isReplay: true, uuid: id, message: { role: "user", content: text } });
}

/** A line of output (synchronously, so nothing is lost when the adapter exits). */
function emit(v: any) {
  try {
    writeSync(1, `${JSON.stringify(v)}\n`);
  } catch {}
}

/** `/usr/bin/bash -lc 'ls -la'` → `ls -la`: the command as the agent wrote it. */
export function display_command(cmd: string): string {
  for (const flag of [" -lc ", " -c "]) {
    const i = cmd.indexOf(flag);
    if (i < 0) continue;
    const shell = cmd.slice(0, i);
    const rest = cmd.slice(i + flag.length);
    if (shell.endsWith("sh") && !shell.includes(" ")) {
      const script = shell_word(rest.trim());
      if (script !== null) return script;
    }
  }
  return cmd;
}

/** `s` unquoted, if it is exactly one shell word (e.g. `'a b'"c"\'d`). */
function shell_word(s: string): string | null {
  let out = "";
  const chars = [...s];
  let i = 0;
  const next = (): string | null => (i < chars.length ? chars[i++] : null);
  for (;;) {
    const c = next();
    if (c === null) break;
    if (c === "'") {
      for (;;) {
        const n = next();
        if (n === null) return null;
        if (n === "'") break;
        out += n;
      }
    } else if (c === '"') {
      for (;;) {
        const n = next();
        if (n === null) return null;
        if (n === '"') break;
        if (n === "\\") {
          const e = next();
          if (e === null) return null;
          if (e === '"' || e === "\\" || e === "$" || e === "`") out += e;
          else if (e !== "\n") out += `\\${e}`;
        } else out += n;
      }
    } else if (c === "\\") {
      const n = next();
      if (n === null) return null;
      out += n;
    } else if (/\s/u.test(c)) {
      return null;
    } else out += c;
  }
  return out;
}

export function file_changes(item: any | null): any[] {
  const changes: any[] = Array.isArray(item?.changes) ? item.changes : [];
  return changes.map((c) => ({ path: g(c?.path), kind: g(c?.kind?.type), move_path: g(c?.kind?.move_path), diff: g(c?.diff) }));
}
