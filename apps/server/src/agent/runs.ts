// Port of server/src/agent/runs.rs.
/**
 * Agent processes on this machine. Each run is launched under `ia-shim`, which detaches it
 * from this server and records everything in `<data>/runs/<run_id>/`:
 * `prompt`, `out.jsonl` (stream-json output), `err.log`, `pid`, `shim.pid` and, when it
 * finishes, `exit`. The server only follows those files, so it can restart freely and pick
 * up where it left off.
 *
 * From format 2, a run that takes input while it goes (stream-json input, see
 * runner::steer) also has `input.jsonl`: the shim feeds the agent `prompt`, then each line
 * the server appends there, and ends its input once the server writes `input.closed`. A
 * run with stream-json input only exits once its input is closed, so a server that doesn't
 * know to close it must not follow it.
 *
 * Those files are a stable format: shims and agents started by an older build keep running
 * after an upgrade, so a newer server must still read them. Changes must be additive; a
 * change that older readers can't handle needs a new `RUN_FORMAT`, and readers must keep
 * supporting the old one. `run.json` records the format (runs without it are format 1).
 *
 * `ia-shim` stays the Rust binary (rust/shim): see `shim_path`.
 */
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as db from "../db.ts";
import * as runner from "./runner.ts";
import * as gh_mcp from "../mcp/gh_mcp.ts";
import * as mcp_http from "../mcp/http.ts";
import * as tokens from "./tokens.ts";
import type { Spec } from "./codex.ts";
import * as codex from "./codex.ts";
import type { Shared } from "../state.ts";
import { VERSION } from "../hosts/proto.ts";
import { context, err_str, expand_tilde, IN_TEST, remove_dir_all, sleep } from "../util.ts";
import * as threads_store from "../threads/store.ts";

/** On-disk format of a run directory written by this build. */
export const RUN_FORMAT = 5;
/** The format from which a run's agent may ask for permission on its output. */
const ASKS_FORMAT = 3;
/** The format from which a run's agent may call the board's tools on its output. */
const TOOLS_FORMAT = 4;
/** The format of a Codex run whose adapter writes the app-server's requests to its output, for the board to answer on its input. */
const CODEX_REQUESTS_FORMAT = 5;

/**
 * Format 3 is a run whose agent asks for permission on its output and waits for the answer on its input (see
 * runner/requests.ts), and format 4 one whose agent calls the board's tools there too (an in-process MCP server, see
 * the same); format 5 is a Codex run whose adapter writes the app-server's requests (approvals, questions, the board's
 * tools) to its output, and waits for their answers on its input (agent/codex/requests.ts). A server that doesn't
 * answer them there would leave it waiting for good, so each run is written with the lowest format it needs, and a run
 * that needs none of that is still format 2, which older builds follow.
 */
const UNASKED_FORMAT = 2;

export interface Launch {
  run_id: string;
  cwd: string;
  args: string[];
  env: Array<[string, string]>;
  /** CLAUDE_CONFIG_DIR (CODEX_HOME for Codex), may start with `~`. */
  config_dir: string | null;
  prompt: string;
  /** The agent reads more input after `prompt` (see `write_input`), until `close_input`. */
  input: boolean;
  /** A review thread's run: its MCP helper also offers `submit_review`. */
  review: boolean;
  /** The project's own MCP servers (see agent/agent_tools.rs). */
  mcp_servers: Record<string, any>;
  /** The GitHub account the gh server acts as (see gh_mcp::Account), if not gh's active one. */
  github_account: string | null;
  /** Run Codex instead of Claude Code: `args` are ignored, and the adapter gets this as `codex.json` (see agent/codex.ts). */
  codex: Spec | null;
  /** Its agent asks for permission on its output (`--permission-prompt-tool stdio`, see runner/requests.ts). */
  asks_on_output?: boolean;
  /**
   * Its agent calls the board's tools on its output (an in-process MCP server, which its prompt's `initialize` request
   * names, see runner/requests.ts): its `mcp.json` has no board server, and the board's HTTP server refuses it.
   */
  tools_on_output?: boolean;
  /**
   * A Codex run whose session has the board's tools as dynamic tools (agent/codex/requests.ts): its `mcp.json` has no
   * board server, and the board's HTTP server refuses it.
   */
  board_tools_dynamic?: boolean;
}

/** A value tests can set (Rust's thread-local `Cell`). */
export class Cell<T> {
  private v: T;
  constructor(v: T) {
    this.v = v;
  }
  get(): T {
    return this.v;
  }
  set(v: T) {
    this.v = v;
  }
}

/** Lets a test act as a host that runs agents, without starting any. */
export const TEST_CAN_RUN = new Cell(false);

/**
 * The watches for agents to stop (`watch_to_reap`, `watch_orphan`) that are going: the server's, as a Rust runtime's
 * spawned tasks are. `end_watches` ends them where they are (leaving their marker files), as a server that stops does:
 * Rust's tests end a runtime for that.
 */
let watches = 0;
export function end_watches() {
  watches++;
}

const log = {
  info: (...a: any[]) => console.error(new Date().toISOString(), " INFO runs:", ...a),
  warn: (...a: any[]) => console.error(new Date().toISOString(), " WARN runs:", ...a),
  error: (...a: any[]) => console.error(new Date().toISOString(), " ERROR runs:", ...a),
};

const is_file = (p: string) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};
const is_dir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const mtime = (p: string) => {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return -1;
  }
};

export function run_dir(state: Shared, run_id: string): string {
  return join(state.data_dir, "runs", run_id);
}

/** This checkout's Cargo `target/` (the Rust workspace is the repository's root, with `ia-shim` in rust/shim). */
const TARGET_DIR = fileURLToPath(new URL("../../../../target/", import.meta.url));

/**
 * The Rust `ia-shim`: `$IA_SHIM_BIN`, else `target/{release,debug}/ia-shim` in this checkout (the newer one),
 * else `ia-shim` beside `bin/huntaway`.
 */
export function shim_path(state: Shared): string {
  const env = process.env.IA_SHIM_BIN;
  if (env) return env;
  // Not in tests, which mustn't start real agents unless they ask to (TEST_CAN_RUN), as the Rust tests can't: their
  // binary has no ia-shim beside it.
  const built = IN_TEST ? [] : ["release", "debug"].map((p) => join(TARGET_DIR, p, "ia-shim")).filter(is_file);
  if (built.length) return built.sort((a, b) => mtime(b) - mtime(a))[0];
  return join(dirname(state.exe), "ia-shim");
}

/** `v` with its objects' keys sorted, as serde_json (without `preserve_order`) writes a `json!` value. */
function sort_keys(v: any): any {
  if (Array.isArray(v)) return v.map(sort_keys);
  if (v && typeof v === "object") {
    const out: any = {};
    for (const k of Object.keys(v).sort()) out[k] = sort_keys(v[k]);
    return out;
  }
  return v;
}

/**
 * The board's servers as stdio helper processes (`huntaway mcp` and `huntaway gh-mcp`), as runs had them before HA-180,
 * for `IA_MCP_STDIO=1`. Each costs a process per run (about 90 MB under Node), which calls back into this server.
 */
function stdio_servers(state: Shared, l: Launch): Record<string, any> {
  const servers: Record<string, any> = {
    [runner.MCP_SERVER_NAME]: {
      type: "stdio",
      command: state.exe,
      args: ["mcp"],
      env: { IA_URL: state.internal_url, IA_TOKEN: state.token, IA_RUN_ID: l.run_id } as Record<string, string>,
    },
    // It asks this server whether the run may merge (see review/merge_gate.rs).
    [gh_mcp.SERVER_NAME]: {
      type: "stdio",
      command: state.exe,
      args: ["gh-mcp"],
      env: { IA_CWD: l.cwd, IA_URL: state.internal_url, IA_TOKEN: state.token, IA_RUN_ID: l.run_id } as Record<string, string>,
    },
  };
  if (l.review) servers[runner.MCP_SERVER_NAME].env.IA_REVIEW = "1";
  if (l.github_account != null) servers[gh_mcp.SERVER_NAME].env[gh_mcp.ACCOUNT_ENV] = l.github_account;
  // Claude Code gives a stdio server's call 30 minutes without news (a permission prompt, say) unless told otherwise.
  servers[runner.MCP_SERVER_NAME].timeout = mcp_http.BOARD_TIMEOUT_MS;
  return servers;
}

/**
 * The settings `huntaway serve` takes from its environment (see serve.ts's `parse_serve_args`, and update/release.ts),
 * which a service manager or the desktop app may have given this server. Agents' runs don't get them (HA-185): a
 * server an agent starts itself (`huntaway serve` in a checkout, say) would otherwise use this one's data dir, port,
 * hubs, broker, tokens and release updates, and could Roll back to the desktop app's own server.
 */
export const SERVE_ENV = [
  "IA_HOST", "IA_PORT", "IA_DATA_DIR", "IA_UI_DIR", "IA_SOURCE_DIR", "IA_UPDATE_FROM", "IA_RELEASE_UPDATES", "IA_RELEASE_API", "IA_NAME",
  "IA_HUB", "IA_HUB_TOKEN", "IA_BROKER", "IA_BROKER_TOKEN", "IA_BROKER_NAME", "IA_TOKEN", "IA_DEMO", "IA_OPEN_TOKEN", "IA_PROFILES",
  "IA_DESKTOP_VERSION", "IA_DESKTOP_SHELL", "IA_DESKTOP_INSTALL", "IA_BUNDLED_SERVER",
];

/** The environment an agent's run starts with: this server's, without `SERVE_ENV`. */
export function agent_env(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of SERVE_ENV) delete env[k];
  return env;
}

/** Start the agent (claude, or the Codex adapter) under ia-shim. Returns once its process exists. */
export async function start(state: Shared, l: Launch): Promise<void> {
  const dir = run_dir(state, l.run_id);
  if (existsSync(join(dir, "pid")) || existsSync(join(dir, "exit"))) {
    throw new Error(`run ${l.run_id} was already started`);
  }
  const shim = shim_path(state);
  if (!existsSync(shim)) {
    throw new Error(`ia-shim not found next to ${state.exe} (build it with \`cargo build --release -p ia-shim\` at the top of the checkout)`);
  }
  await mkdir(dir, { recursive: true });
  // The boot tells whether its pids are still its own later (see `pid_reused`).
  const format = l.codex?.requests_on_output ? CODEX_REQUESTS_FORMAT : l.tools_on_output ? TOOLS_FORMAT : l.asks_on_output ? ASKS_FORMAT : UNASKED_FORMAT;
  const run = { boot: boot_id(), format, version: VERSION };
  await writeFile(join(dir, "run.json"), JSON.stringify(run));
  await writeFile(join(dir, "prompt"), l.prompt);
  if (l.input) await writeFile(join(dir, "input.jsonl"), "");

  // The board's tools, and GitHub through gh (outside the agent's sandbox; a server of the project's own by this name
  // replaces it). This server serves both over HTTP (see mcp/http.ts), with what they need of the run kept here; the URL
  // stays valid across restarts. A run that calls the board's tools on its output has only gh's here, but for one
  // that gives a new Codex session them as dynamic tools: the adapter gives it the board's server only if Codex won't
  // take them (agent/codex/adapter.ts's start_thread).
  const in_process = !!l.tools_on_output || (!!l.board_tools_dynamic && !l.codex?.board_tools);
  await writeFile(
    join(dir, mcp_http.SETTINGS_FILE),
    mcp_http.settings_json({ cwd: l.cwd, github_account: l.github_account, review: l.review, in_process }),
  );
  const servers: Record<string, any> = process.env.IA_MCP_STDIO === "1" ? stdio_servers(state, l) : mcp_http.servers(state, l.run_id);
  if (in_process) delete servers[runner.MCP_SERVER_NAME];
  for (const [name, server] of Object.entries(l.mcp_servers ?? {})) {
    if (name !== runner.MCP_SERVER_NAME) servers[name] = server;
  }
  const mcp_path = join(dir, "mcp.json");
  await writeFile(mcp_path, JSON.stringify(sort_keys({ mcpServers: servers }), null, 2));
  let program: string;
  let args: string[];
  if (l.codex) {
    const spec_path = join(dir, "codex.json");
    await writeFile(spec_path, JSON.stringify(l.codex, null, 2));
    [program, args] = [state.exe, ["codex-run", spec_path]];
  } else {
    [program, args] = [claude_program(), [...l.args, "--mcp-config", mcp_path]];
  }
  await writeFile(join(dir, "spec.json"), JSON.stringify({ args, config_dir: l.config_dir ?? null, cwd: l.cwd }, null, 2));

  const cwd = expand_tilde(l.cwd);
  if (!is_dir(cwd)) throw new Error(`working directory ${cwd} does not exist`);
  const env = agent_env();
  for (const [k, v] of l.env ?? []) env[k] = v;
  const cd = l.config_dir;
  if (cd != null && cd.trim() !== "") env[l.codex ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR"] = expand_tilde(cd);
  // The shim forks; the process we spawned exits right away.
  const status = await new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
    const child = spawn(shim, [dir, "--", program, ...args], { cwd, env, stdio: "ignore" });
    child.on("error", (e) => reject(context("failed to launch ia-shim", e)));
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });
  if (status.code !== 0) {
    throw new Error(`ia-shim exited with ${status.code !== null ? `exit status: ${status.code}` : `signal: ${status.signal}`}`);
  }
  for (let i = 0; i < 100; i++) {
    if (existsSync(join(dir, "pid"))) return;
    const exit = read_exit(dir);
    if (exit) throw new Error(typeof exit.error === "string" ? exit.error : "the run exited immediately");
    await sleep(50);
  }
  throw new Error("the run did not start within 5s");
}

/** Whether the run's agent is still reading input (see `write_input`). */
export function accepts_input(state: Shared, run_id: string): boolean {
  const dir = run_dir(state, run_id);
  return existsSync(join(dir, "input.jsonl")) && !existsSync(join(dir, "input.closed")) && !existsSync(join(dir, "exit"));
}

/** Send the agent a line of input (a stream-json message). Returns false if it no longer takes any. */
export function write_input(state: Shared, run_id: string, line: string): boolean {
  if (!accepts_input(state, run_id)) return false;
  // One write, so the shim never relays half a line followed by someone else's.
  appendFileSync(join(run_dir(state, run_id), "input.jsonl"), `${line.trimEnd()}\n`);
  return true;
}

/**
 * How many background tasks (shells started with `run_in_background`, background subagents) Claude Code last said the
 * run's agent has going, in its `background_tasks_changed` event. While it has any, closing its input doesn't make it
 * exit: it stays until they end, then takes a turn on what they did, so its input is left open between turns to take
 * the messages sent meanwhile (see queue::turn_ended). Kept in the run's folder, `background`, for a restarted server.
 */
export function background_tasks(state: Shared, run_id: string): number {
  try {
    const n = Number.parseInt(readFileSync(join(run_dir(state, run_id), "background"), "utf8"), 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

export function set_background_tasks(state: Shared, run_id: string, count: number): void {
  const path = join(run_dir(state, run_id), "background");
  try {
    if (count > 0) writeFileSync(path, `${count}\n`);
    else rmSync(path, { force: true });
  } catch (e) {
    log.error(`run=${run_id} recording the agent's background tasks: ${err_str(e)}`);
  }
}

/**
 * Whether the run's background tasks last ended during a turn (see queue::background_changed), for an agent that asks on
 * its output: the turn on their outcome follows that turn. Kept in the run's folder, `background-ended`.
 */
export function background_ended(state: Shared, run_id: string): boolean {
  return existsSync(join(run_dir(state, run_id), "background-ended"));
}

export function set_background_ended(state: Shared, run_id: string, ended: boolean): void {
  const path = join(run_dir(state, run_id), "background-ended");
  try {
    if (ended) writeFileSync(path, "");
    else rmSync(path, { force: true });
  } catch (e) {
    log.error(`run=${run_id} recording that the agent's background tasks ended: ${err_str(e)}`);
  }
}

/** End the agent's input: it exits once it has dealt with what it was sent. */
export function close_input(state: Shared, run_id: string): void {
  const dir = run_dir(state, run_id);
  if (existsSync(join(dir, "input.jsonl")) && !existsSync(join(dir, "input.closed"))) {
    try {
      writeFileSync(join(dir, "input.closed"), "");
    } catch (e) {
      log.error(`run=${run_id} closing the agent's input: ${err_str(e)}`);
    }
  }
}

/** `kill(2)`, ignoring failures. */
function signal(pid: number, sig: NodeJS.Signals | 0): boolean {
  try {
    process.kill(pid, sig);
    return true;
  } catch {
    return false;
  }
}

/** Signal the agent's process group; escalate if it hasn't exited after 10s. */
export function kill(state: Shared, run_id: string): boolean {
  const dir = run_dir(state, run_id);
  if (existsSync(join(dir, "exit"))) return false;
  const pid = read_pid(dir, "pid");
  if (pid === null) return false;
  signal(-pid, "SIGTERM");
  setTimeout(() => {
    if (!existsSync(join(dir, "exit"))) signal(-pid, "SIGKILL");
  }, 10_000).unref();
  return true;
}

/**
 * How long `reap` waits for ia-shim to start an agent it may still start (`REAP_WAIT`), and how long an agent `reap`
 * stops has to exit before it's killed (`REAP_GRACE`), in milliseconds. Tests shorten them (Rust's are shorter under
 * `cfg(test)`: 5 s and 1 s).
 */
export const timing = { REAP_WAIT: 60_000, REAP_GRACE: 10_000 };

/**
 * Make sure nothing goes on of a run whose launch failed or was stopped: its input is closed
 * and its agent stopped, including one ia-shim starts only after this (if it's slow, or the
 * launch gave up waiting for it, or was stopped while it waited).
 */
export function reap(state: Shared, run_id: string): void {
  close_input(state, run_id);
  const dir = run_dir(state, run_id);
  // The shim is started once spec.json is written.
  if (!existsSync(join(dir, "spec.json")) || existsSync(join(dir, "exit"))) return;
  // Kept until the agent has exited or can't start any more, so a restart carries on (see `resume_reaping`).
  try {
    writeFileSync(join(dir, "reap"), "");
  } catch (e) {
    log.error(`run=${run_id} marking a run to stop: ${err_str(e)}`);
  }
  watch_to_reap(state, run_id);
}

/**
 * Carry on stopping the agents of failed launches (see `reap`) and of shims that vanished (see
 * `stop_orphan`, whose runs have ended) that a restart interrupted.
 */
export function resume_reaping(state: Shared): void {
  let names: string[];
  try {
    names = readdirSync(join(state.data_dir, "runs"));
  } catch {
    return;
  }
  for (const name of names) {
    const path = join(state.data_dir, "runs", name);
    if (existsSync(join(path, "orphan"))) watch_orphan(path);
    if (!existsSync(join(path, "reap"))) continue;
    close_input(state, name);
    watch_to_reap(state, name);
  }
}

/**
 * Stop the run's agent once ia-shim has started it (killing it if it doesn't exit in time), or
 * give up once the shim has had time to start it.
 */
function watch_to_reap(state: Shared, run_id: string): void {
  const dir = run_dir(state, run_id);
  const server = watches;
  (async () => {
    const since = Date.now();
    let stopping: number | null = null;
    while (!existsSync(join(dir, "exit"))) {
      if (watches !== server) return;
      const pid = read_pid(dir, "pid");
      if (pid === null) {
        if (Date.now() - since >= timing.REAP_WAIT) break;
      } else if (!alive(pid) || pid_reused(dir)) {
        // (One gone without its exit recorded went with a reboot, say, and another
        // process may have its pid since.)
        break;
      } else if (stopping === null) {
        log.warn(`run=${run_id} stopping an agent that started after its launch was given up on`);
        close_input(state, run_id);
        signal(-pid, "SIGTERM");
        stopping = Date.now();
      } else if (Date.now() - stopping >= timing.REAP_GRACE) {
        signal(-pid, "SIGKILL");
      }
      await sleep(stopping !== null ? 100 : 20);
    }
    rmSync(join(dir, "reap"), { force: true });
  })().catch((e) => log.error(`run=${run_id} reaping: ${err_str(e)}`));
}

function read_json(path: string): any {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * Whether run `run_id`'s agent asks for permission, or calls the board's tools, on its output (see runner/requests.ts):
 * it needs its input for any turn it takes, as Claude Code denies or fails those unasked once it's closed.
 */
export function asks_on_output(state: Shared, run_id: string): boolean {
  return format(state, run_id) >= ASKS_FORMAT && !is_codex_run(state, run_id);
}

/** Whether run `run_id` is Codex's (its adapter's `codex.json`). */
function is_codex_run(state: Shared, run_id: string): boolean {
  return existsSync(join(run_dir(state, run_id), "codex.json"));
}

/** Format of an existing run directory. */
export function format(state: Shared, run_id: string): number {
  const f = read_json(join(run_dir(state, run_id), "run.json"))?.format;
  return Number.isInteger(f) && f >= 0 ? f : 1;
}

/** The arguments a run's agent was started with (`spec.json`), none if it wasn't. */
export function launch_args(state: Shared, run_id: string): string[] {
  const args = read_json(join(run_dir(state, run_id), "spec.json"))?.args;
  return Array.isArray(args) && args.every((a) => typeof a === "string") ? args : [];
}

/** A Codex run's `codex.json`, as it was launched. */
export function codex_spec(state: Shared, run_id: string): Spec | null {
  const v = read_json(join(run_dir(state, run_id), "codex.json"));
  return v === undefined ? null : codex.Spec_from_json(v);
}

export function claude_program(): string {
  return process.env.IA_CLAUDE_BIN ?? "claude";
}

function on_path(name: string): boolean {
  if (isAbsolute(name) && existsSync(name)) return true;
  const path = process.env.PATH;
  return path !== undefined && path.split(delimiter).some((d) => is_file(join(d, name)));
}

/** Whether this host can run agents: it has ia-shim and a claude or codex CLI. */
export function can_run_agents(state: Shared): boolean {
  if (TEST_CAN_RUN.get()) return true;
  return existsSync(shim_path(state)) && (on_path(claude_program()) || on_path(codex.program()));
}

/** Whether this host has the CLI for `agent` (one of db::AGENTS). */
export function has_agent(agent: string): boolean {
  if (TEST_CAN_RUN.get()) return true;
  return on_path(agent === "codex" ? codex.program() : claude_program());
}

export function exists(state: Shared, run_id: string): boolean {
  const dir = run_dir(state, run_id);
  return existsSync(join(dir, "out.jsonl")) || existsSync(join(dir, "exit"));
}

/** Follow a run's output from `offset` until it exits, feeding the runner. */
export function follow(state: Shared, run_id: string, offset: number): void {
  follow_inner(state, run_id, offset).catch((e) => log.error(`run=${run_id} following output failed: ${err_str(e)}`));
}

/** How much of a run's output `follow_inner` reads at a time, unless a line is longer. */
const OUTPUT_CHUNK = 1 << 20;

export async function follow_inner(state: Shared, run_id: string, offset: number): Promise<void> {
  const dir = run_dir(state, run_id);
  const out_path = join(dir, "out.jsonl");
  let polls = 0;
  let want = OUTPUT_CHUNK;
  for (;;) {
    const exited = existsSync(join(dir, "exit"));
    const chunk = read_from(out_path, offset, want);
    // Whole lines only, unless the run is over and its last line lacks a newline.
    const nl = chunk.lastIndexOf(0x0a);
    let end: number;
    if (nl >= 0) end = nl + 1;
    else if (chunk.length === want) {
      // A line longer than the chunk (a tool result with an image, say): read more of it.
      want *= 2;
      continue;
    } else end = exited ? chunk.length : 0;
    if (end > 0) {
      runner.on_output(state, run_id, offset, chunk.subarray(0, end).toString("utf8"));
      offset += end;
      want = OUTPUT_CHUNK;
      continue;
    }
    if (exited) {
      const exit = read_exit(dir) ?? {};
      const int = (v: any) => (Number.isInteger(v) ? v : null);
      runner.on_exit(state, run_id, int(exit.code), int(exit.signal), typeof exit.error === "string" ? exit.error : null, tail(join(dir, "err.log"), 4000));
      return;
    }
    // Its folder was removed with its task (see `remove_finished` and `prune`), maybe before
    // its exit was seen here, so nothing will write one now. on_exit ends a run still recorded.
    if (!existsSync(dir)) {
      runner.on_exit(state, run_id, null, null, "the run's folder was removed", "");
      return;
    }
    // A shim that vanished without recording an exit (killed, or the machine rebooted).
    polls++;
    if (polls % 10 === 0) {
      const shim_pid = read_pid(dir, "shim.pid");
      if (shim_pid !== null && (!alive(shim_pid) || pid_reused(dir)) && !existsSync(join(dir, "exit"))) {
        // Its agent may have outlived it, and would go on working (and calling the
        // board's tools) for a run the board is about to end.
        stop_orphan(dir);
        writeFileSync(join(dir, "exit"), `{"code":null,"signal":null,"error":"the run's supervisor (ia-shim) disappeared"}`);
        continue;
      }
    }
    await sleep(200);
  }
}

function read_pid(dir: string, name: string): number | null {
  let t: string;
  try {
    t = readFileSync(join(dir, name), "utf8").trim();
  } catch {
    return null;
  }
  if (!/^[+-]?\d+$/.test(t)) return null;
  const n = Number(t);
  return n >= -2147483648 && n <= 2147483647 ? n : null;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === "EPERM";
  }
}

/**
 * Whether the pids the run recorded may name other processes now: the machine has rebooted since
 * it started (its `run.json` has another boot's id). Not told by comparing times, which a clock
 * that jumps (a VM resumed, NTP catching up) would get wrong. False for runs from before boot ids.
 */
export function pid_reused(dir: string): boolean {
  const then = read_json(join(dir, "run.json"))?.boot;
  const now = boot_id();
  return typeof then === "string" && now !== null && then !== now;
}

let BOOT_ID: string | null | undefined;

/** This boot of the machine's id, if it can be told. */
export function boot_id(): string | null {
  if (BOOT_ID === undefined) {
    let id: string | null = null;
    if (process.platform === "linux") {
      try {
        id = readFileSync("/proc/sys/kernel/random/boot_id", "utf8");
      } catch {}
    } else {
      const out = spawnSync("sysctl", ["-n", "kern.bootsessionuuid"], { encoding: "utf8" });
      if (out.status === 0) id = out.stdout;
    }
    id = id?.trim() || null;
    BOOT_ID = id;
  }
  return BOOT_ID;
}

/** Whether process group `pgid` has a process in it. */
function group_alive(pgid: number): boolean {
  return alive(-pgid);
}

/**
 * Stop the agent of a run whose ia-shim vanished: nothing else will (`kill` and `reap` go by the
 * exit the shim would have written). Marked `orphan` until it has gone, so a restart carries on
 * (see `resume_reaping`).
 */
export function stop_orphan(dir: string): void {
  const pid = read_pid(dir, "pid");
  if (pid === null || !alive(pid) || pid_reused(dir)) return;
  log.warn(`dir=${dir} stopping an agent whose supervisor (ia-shim) disappeared`);
  try {
    writeFileSync(join(dir, "orphan"), "");
  } catch (e) {
    log.error(`dir=${dir} marking an agent to stop: ${err_str(e)}`);
  }
  watch_orphan(dir);
}

/** Stop the agent of a run marked `orphan`, killing it if it hasn't gone in time. */
function watch_orphan(dir: string): void {
  const server = watches;
  (async () => {
    const since = Date.now();
    let sig: NodeJS.Signals = "SIGTERM";
    // Read once: the folder may yet go with its task (see `remove_finished`).
    const pid = read_pid(dir, "pid");
    if (pid === null || pid_reused(dir)) {
      rmSync(join(dir, "orphan"), { force: true });
      return;
    }
    // The group, which may outlive its leader. (Its id isn't given to a new process while it's in use.)
    while (group_alive(pid)) {
      if (watches !== server) return;
      if (sig === "SIGTERM" || Date.now() - since >= timing.REAP_GRACE) {
        signal(-pid, sig);
        sig = "SIGKILL";
      }
      await sleep(100);
    }
    rmSync(join(dir, "orphan"), { force: true });
  })().catch((e) => log.error(`dir=${dir} stopping an orphan: ${err_str(e)}`));
}

function read_exit(dir: string): any | null {
  const v = read_json(join(dir, "exit"));
  return v === undefined ? null : v;
}

/** Up to `max` bytes of `path` from `offset` (none if it can't be opened). */
function read_from(path: string, offset: number, max: number): Buffer {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return Buffer.alloc(0);
  }
  try {
    const size = statSync(path).size;
    const n = Math.max(0, Math.min(max, size - offset));
    const buf = Buffer.allocUnsafe(n);
    let got = 0;
    while (got < n) {
      const r = readSync(fd, buf, got, n - got, offset + got);
      if (r === 0) break;
      got += r;
    }
    return buf.subarray(0, got);
  } finally {
    closeSync(fd);
  }
}

function tail(path: string, max: number): string {
  let len = 0;
  try {
    len = statSync(path).size;
  } catch {}
  return read_from(path, Math.max(0, len - max), max).toString("utf8");
}

/**
 * How long a finished run's folder is kept: its output has every streamed delta, tool result and
 * image, and nothing reads it once the run has been taken in (see `prune`).
 */
export const KEEP_DAYS = 14;
/**
 * How long the results of a finished run's MCP calls are kept (ms). They're only needed while its
 * helper may deliver a call again (see tools::handle_mcp), which it can't once the run has ended.
 */
const KEEP_CALLS = 3600_000;
/** How long a folder of a run whose task is gone, with no sign of whether it's finished, is kept (ms). */
const KEEP_UNKNOWN = 3600_000;
const PRUNE_EVERY = 3600_000;
/** How many MCP calls are deleted at a time, so the database isn't held long. */
const CALLS_BATCH = 1000;

export interface Pruned {
  runs: number;
  calls: number;
}

/**
 * Remove the folders of runs that finished over `KEEP_DAYS` before `now`, and of finished runs
 * whose task is gone, and the MCP calls of runs that finished over `KEEP_CALLS` ago (or are gone).
 */
export function prune(state: Shared, now: Date): Pruned {
  const ts = (ms: number) => new Date(now.getTime() - ms).toISOString();
  const pruned: Pruned = { runs: 0, calls: 0 };
  // Listed before the runs are read: a run is added before its folder is made, so each folder
  // listed is either in what's read or its task is gone.
  let dirs: Array<[string, string]> = [];
  try {
    dirs = readdirSync(join(state.data_dir, "runs"), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => [e.name, join(state.data_dir, "runs", e.name)]);
  } catch (e: any) {
    if (e?.code !== "ENOENT") throw context("listing runs", e);
  }
  // Whether each run's folder is kept: it hasn't finished, or did lately.
  const keep = new Map<string, boolean>();
  const rows = db.all(state.db(), "SELECT id, status != 'exited' OR COALESCE(ended_at, created_at) > ?1 AS keep FROM runs", ts(KEEP_DAYS * 86400_000));
  for (const r of rows) keep.set(r.id, !!r.keep);
  for (const [id, dir] of dirs) {
    let remove: boolean;
    // Not while its agent is being stopped (see `stop_orphan`), which goes by its folder after a restart.
    if (existsSync(join(dir, "orphan"))) remove = false;
    else if (keep.has(id)) remove = !keep.get(id);
    else remove = finished(dir);
    if (remove) {
      try {
        remove_dir_all(dir);
        pruned.runs++;
      } catch (e) {
        log.warn(`run=${id} removing the run's folder: ${err_str(e)}`);
      }
    }
  }
  const before = ts(KEEP_CALLS);
  for (;;) {
    const n = db.run(
      state.db(),
      `DELETE FROM mcp_calls WHERE rowid IN (SELECT m.rowid FROM mcp_calls m LEFT JOIN runs r ON r.id=m.run_id
         WHERE m.created_at < ?1 AND (r.id IS NULL OR r.status='exited' AND COALESCE(r.ended_at, r.created_at) < ?1) LIMIT ?2)`,
      before,
      CALLS_BATCH,
    ).changes;
    pruned.calls += n;
    if (n < CALLS_BATCH) break;
  }
  return pruned;
}

/** Whether the run in `dir`, whose task is gone, has finished (it's stopped as its task is deleted). */
function finished(dir: string): boolean {
  if (existsSync(join(dir, "exit"))) return true;
  const pid = read_pid(dir, "shim.pid");
  if (pid !== null) return !alive(pid);
  // Never started, or from before shims recorded their pid.
  const m = mtime(dir);
  return m >= 0 && Date.now() - m > KEEP_UNKNOWN;
}

/**
 * Remove the folders of these runs that have finished, as their task is deleted. `prune` takes
 * the others once they have, and those whose agent is still being stopped (see `stop_orphan`).
 */
export function remove_finished(state: Shared, run_ids: string[]): void {
  for (const id of run_ids) {
    const dir = run_dir(state, id);
    if (existsSync(join(dir, "exit")) && !existsSync(join(dir, "orphan"))) {
      try {
        remove_dir_all(dir);
      } catch (e) {
        log.warn(`run=${id} removing the run's folder: ${err_str(e)}`);
      }
    }
  }
}

/** Prune runs (see `prune`) now and every hour, once the tokens they used are counted. */
export function start_pruner(state: Shared): void {
  const tick = () => {
    // Before their folders go (see agent/tokens.rs).
    try {
      const n = tokens.count_pending(state, null);
      if (n > 0) log.info(`runs: counted the tokens of ${n} finished runs`);
    } catch (e) {
      log.warn(`runs: counting tokens failed: ${err_str(e)}`);
    }
    try {
      const p = prune(state, new Date());
      if (p.runs || p.calls) log.info(`runs: removed ${p.runs} finished runs' folders and ${p.calls} MCP calls`);
    } catch (e) {
      log.warn(`runs: pruning failed: ${err_str(e)}`);
    }
    // Threads kept as items prune their own logs as they're written; this takes the quiet ones' (see threads/store.ts).
    try {
      threads_store.prune(state.db());
    } catch (e) {
      log.warn(`runs: pruning threads' events failed: ${err_str(e)}`);
    }
  };
  setTimeout(tick, 0).unref();
  setInterval(tick, PRUNE_EVERY).unref();
}
