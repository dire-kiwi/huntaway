// Port of server/src/hosts/terminal.rs: terminals in the browser: each task can have a tmux session in its working
// directory.
//
// The sessions live on a tmux server of our own (`tmux -L ia-<host>`), so they keep running when the browser
// disconnects or this server restarts. Each websocket runs `tmux attach-session` in a pty and relays it:
//
// * server → client: binary frames with terminal output, and JSON text frames for control (`{"type":"ready"}`);
// * client → server: binary frames with input, and JSON text frames `{"type":"resize","cols","rows"}` and
//   `{"type":"ack","bytes"}`.
//
// The client acknowledges output once xterm has processed it, and we stop reading the pty while too much is
// unacknowledged, so a flood of output can't pile up in the browser.
//
// Besides its shell, a task can have a session per *terminal tool*: a TUI program (lazygit, an editor, a script…)
// configured in the host's settings, run in the same directory. Tool sessions last as long as a board has them open:
// the board renews a lease on each while it is open, and sessions that nobody is attached to and whose lease ran out
// are ended.
import { mkdirSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import type WebSocket from "ws";
import * as db from "../db.ts";
import type { Conn, Task } from "../db.ts";
import { ApiError } from "../http.ts";
import type { AppState } from "../state.ts";
import { run_cmd, type Output } from "../proc.ts";
import { background, err_str, expand_tilde, new_id, path_str } from "../util.ts";
import * as documents from "../agent/documents.ts";
import * as memory from "../agent/assistant/memory.ts";
import * as task_tmp from "../agent/task_tmp.ts";
import * as runs from "../agent/runs.ts";
import { Pty } from "./pty.ts";
import { close } from "./relay.ts";

/** Output we send ahead of the client's acknowledgements. */
const MAX_UNACKED = 384 << 10;
const PING_EVERY = 15_000;
/** How long a tool session nobody is attached to outlives the board's last keepalive. */
const TOOL_LEASE = 90_000;
const REAP_EVERY = 30_000;

/**
 * A TUI program the board offers as a shortcut in each task's terminal (host setting `terminal_tools`). `command` is
 * run by the user's login shell in the task's directory.
 */
export interface Tool {
  id: string;
  name: string;
  command: string;
}

/** The host's terminal tools. */
export function tools(c: Conn): Tool[] {
  try {
    const v = db.get_setting(c, "terminal_tools");
    if (v === null) return [];
    const list = JSON.parse(v);
    if (!Array.isArray(list) || !list.every((t) => typeof t?.id === "string" && typeof t?.name === "string" && typeof t?.command === "string")) return [];
    return list.map((t) => ({ id: t.id, name: t.name, command: t.command }));
  } catch {
    return [];
  }
}

/**
 * Check and normalise a new list of tools; tools without a usable id get one. (Rust's `Err(String)` is thrown as an
 * `ApiError.bad` with that message.)
 */
export function parse_tools(v: any): Tool[] {
  if (!Array.isArray(v)) throw ApiError.bad("terminal_tools must be a list");
  const out: Tool[] = [];
  for (const item of v) {
    const field = (k: string) => (item && typeof item === "object" && typeof item[k] === "string" ? (item[k] as string).trim() : "");
    const name = field("name"), command = field("command");
    if (!name || !command) throw ApiError.bad("each terminal tool needs a name and a command");
    let id = field("id");
    if (!valid_tool_id(id) || out.some((t) => t.id === id)) id = new_id().slice(0, 8);
    out.push({ id, name, command });
  }
  return out;
}

/** Tool ids end up in tmux session names. */
function valid_tool_id(id: string): boolean {
  return id.length > 0 && id.length <= 32 && /^[A-Za-z0-9_-]+$/.test(id);
}

/**
 * Runs a tool in the user's login shell (so its PATH is the one their shells see). If it fails, the message stays on
 * screen until Enter instead of the session vanishing.
 */
const TOOL_WRAPPER = `"\${SHELL:-/bin/sh}" -lc "$IA_TOOL_COMMAND"; s=$?; [ "$s" -eq 0 ] || { printf '\\n%s exited with status %d. Press Enter to close.' "$IA_TOOL_NAME" "$s"; read -r _; }`;

let found: boolean | null = null;

/** Whether tmux is installed. */
export function available(): boolean {
  if (found === null) {
    found = (process.env.PATH ?? "").split(delimiter).some((d) => {
      try {
        return d !== "" && statSync(join(d, "tmux")).isFile();
      } catch {
        return false;
      }
    });
  }
  return found;
}

/** Our own tmux server, one per data dir, so test servers don't share the live sessions. */
function socket(s: AppState): string {
  return `ia-${s.host_id.slice(0, 12)}`;
}

/** `ia-<task>` for the task's shell, `ia-<task>~<tool>` for a tool. */
function session_name(task_id: string, tool: string | null): string {
  return tool !== null ? `ia-${task_id}~${tool}` : `ia-${task_id}`;
}

/** `=name` matches the session exactly instead of by prefix. */
function target(task_id: string, tool: string | null): string {
  return `=${session_name(task_id, tool)}`;
}

/** tmux's environment and its first arguments. */
export function tmux_command(s: AppState): [string[], NodeJS.ProcessEnv] {
  // Shells inherit the tmux server's environment: keep this server's settings and secrets out of it, as an agent's run
  // does (a `huntaway serve` typed there mustn't pick them up), and let it work when this server itself runs inside tmux.
  const env = runs.agent_env();
  for (const v of ["TMUX", "TMUX_PANE"]) delete env[v];
  Object.assign(env, { TERM: "xterm-256color", COLORTERM: "truecolor", TERM_PROGRAM: "huntaway" });
  return [["-L", socket(s)], env];
}

async function tmux(s: AppState, args: string[]): Promise<Output> {
  const [base, env] = tmux_command(s);
  try {
    return await run_cmd("tmux", [...base, ...args], { env });
  } catch (e) {
    throw new Error("running tmux", { cause: e });
  }
}

export async function session_exists(s: AppState, task_id: string, tool: string | null): Promise<boolean> {
  if (!available()) return false;
  try {
    return (await tmux(s, ["has-session", "-t", target(task_id, tool)])).success;
  } catch {
    return false;
  }
}

/** Our sessions, with how many clients are attached to each. */
async function list_sessions(s: AppState): Promise<Array<[string, number]>> {
  let o: Output;
  try {
    o = await tmux(s, ["list-sessions", "-F", "#{session_name} #{session_attached}"]);
  } catch {
    return [];
  }
  const out: Array<[string, number]> = [];
  for (const l of o.stdout.split("\n")) {
    const i = l.lastIndexOf(" ");
    if (i < 0) continue;
    out.push([l.slice(0, i), Number.parseInt(l.slice(i + 1)) || 0]);
  }
  return out;
}

const is_dir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** Where a task's terminal starts: its worktree once there is one, otherwise where its agent would run. */
export function working_dir(s: AppState, task: Task): string {
  // The assistant's workspace, if it's its own (not a symlink to another's, see assistant/memory.checked).
  if (db.is_assistant(task)) return path_str(memory.checked(s, task));
  // A scratch task's shell (or one that makes only documents) opens in its folder, where its agent works.
  const d = documents.work_dir(s, task);
  if (d) return path_str(d);
  const project = task.project_id ? db.get_project(s.db(), task.project_id) : null;
  let dir: string;
  if (project && task.worktree_path && is_dir(expand_tilde(task.worktree_path))) dir = task.worktree_path;
  else if (project) dir = project.repo_path;
  else dir = path_str(s.profile_scratch_dir(task.profile_id));
  return path_str(expand_tilde(dir));
}

async function ensure_session(s: AppState, task: Task, tool: Tool | null, cols: number, rows: number) {
  const tool_id = tool?.id ?? null;
  if (await session_exists(s, task.id, tool_id)) return;
  const cwd = working_dir(s, task);
  try {
    mkdirSync(cwd, { recursive: true });
  } catch {}
  const c = s.db();
  const config_dir = db.task_config_dir(c, task);
  const codex = db.task_is_codex(c, task);
  const cfg = db.task_claude_config(c, task);
  const proxy_env: Array<[string, string]> = cfg ? db.api_env(cfg) : [];
  const name = session_name(task.id, tool_id);
  const env: string[] = [];
  // `claude` (or `codex`) in the terminal uses the task's config.
  if (config_dir) env.push(`${codex ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR"}=${path_str(expand_tilde(config_dir))}`);
  // And its proxy, as agents do (see ClaudeConfig::api_env).
  for (const [k, v] of proxy_env) env.push(`${k}=${v}`);
  // The temp folder the task's agents use (see agent/task_tmp.ts), until it's done and the folder goes.
  const tmp = task.status !== "done" ? task_tmp.ensure(s, task) : null;
  if (tmp) env.push(`TMPDIR=${path_str(tmp)}`);
  if (tool) {
    env.push(`IA_TOOL_NAME=${tool.name}`);
    env.push(`IA_TOOL_COMMAND=${tool.command}`);
  }
  const args = ["new-session", "-d", "-s", name, "-c", cwd, "-x", String(cols), "-y", String(rows)];
  for (const e of env) args.push("-e", e);
  // More than one argument: tmux runs it directly rather than through its default shell, which may not be a POSIX one.
  if (tool) {
    args.push("--", "/bin/sh", "-c", TOOL_WRAPPER);
    touch(name);
  }
  const o = await tmux(s, args);
  if (!o.success && !(await session_exists(s, task.id, tool_id))) throw new Error(`tmux new-session failed: ${o.stderr.trim()}`);
  // The board already says which task this is. With the mouse on, the wheel scrolls tmux's history instead of sending
  // arrow keys, and selections reach the browser's clipboard (OSC 52); Shift+drag still selects in xterm itself.
  const t = `${target(task.id, tool_id)}:`;
  await tmux(s, ["set-option", "-t", t, "status", "off", ";", "set-option", "-t", t, "mouse", "on"]);
}

/** End a task's shell session (or one of its tool sessions), if it has one. */
export async function kill(s: AppState, task_id: string, tool: string | null) {
  if (await session_exists(s, task_id, tool)) await tmux(s, ["kill-session", "-t", target(task_id, tool)]).catch(() => {});
  if (tool !== null) leases.delete(session_name(task_id, tool));
}

/** End all of a task's sessions: its shell and its tools. */
export async function kill_all(s: AppState, task_id: string) {
  if (!available()) return;
  const shell = session_name(task_id, null);
  const tools = `${shell}~`;
  for (const [name] of await list_sessions(s)) {
    if (name === shell || name.startsWith(tools)) {
      await tmux(s, ["kill-session", "-t", `=${name}`]).catch(() => {});
      leases.delete(name);
    }
  }
}

export async function status(s: AppState, task: Task, tool: Tool | null) {
  if (!available()) return { available: false, running: false, reason: "tmux is not installed on this host" };
  const running = await session_exists(s, task.id, tool?.id ?? null);
  let cwd: string | null = null;
  try {
    cwd = working_dir(s, task);
  } catch {}
  return { available: true, running, cwd, tool };
}

/** When a board last said it still has each tool session open, by session name. */
const leases = new Map<string, number>();

function touch(name: string) {
  leases.set(name, Date.now());
}

/** A board still has this tool session open. */
export function keepalive(task_id: string, tool: string) {
  touch(session_name(task_id, tool));
}

/** End tool sessions that no board has kept open: nobody attached and the lease ran out. */
export function start_reaper(s: AppState) {
  if (!available()) return;
  setInterval(() => background("ending tool terminals no board has open", reap(s)), REAP_EVERY).unref();
}

async function reap(s: AppState) {
  const sessions = await list_sessions(s);
  const expired: string[] = [];
  for (const name of [...leases.keys()]) if (!sessions.some(([n]) => n === name)) leases.delete(name);
  for (const [name, attached] of sessions.filter(([n]) => n.startsWith("ia-") && n.includes("~"))) {
    // Sessions from before a restart get a full lease to be claimed again.
    if (!leases.has(name)) leases.set(name, Date.now());
    if (attached > 0) leases.set(name, Date.now());
    else if (Date.now() - leases.get(name)! > TOOL_LEASE) expired.push(name);
  }
  for (const name of expired) {
    console.error(`terminal: ending ${name}, no board has it open`);
    await tmux(s, ["kill-session", "-t", `=${name}`]).catch(() => {});
    leases.delete(name);
  }
}

/** Attach a websocket to the task's session (or a tool's), creating the session if needed. */
export async function serve(s: AppState, task: Task, tool: Tool | null, cols: number, rows: number, ws: WebSocket) {
  ws.on("error", () => {});
  try {
    await attach(s, task, tool, cols, rows, ws);
  } catch (e) {
    const reason = err_str(e);
    console.error(`terminal (task ${task.id}): ${reason}`);
    await close(ws, [1011, Array.from(reason).slice(0, 120).join("")]);
  }
}

async function attach(s: AppState, task: Task, tool: Tool | null, cols: number, rows: number, ws: WebSocket) {
  await ensure_session(s, task, tool, cols, rows);
  if (ws.readyState !== ws.OPEN) return;
  const tool_id = tool?.id ?? null;
  const t = target(task.id, tool_id);
  const [base, env] = tmux_command(s);
  // Copying in tmux reaches the browser's clipboard (OSC 52). When the session ends, the client should end with it
  // rather than switch to another task's session.
  // prettier-ignore
  const args = [
    ...base,
    "set-option", "-q", "-s", "set-clipboard", "external", ";",
    "set-option", "-t", `${t}:`, "detach-on-destroy", "on", ";",
    "attach-session", "-t", t,
  ];
  const pty = await Pty.spawn("tmux", args, env, cols, rows);
  ws.send(JSON.stringify({ type: "ready" }));

  let unacked = 0;
  let paused = false;
  let gone = false;
  const out = pty.output;
  out.on("data", (chunk: Buffer) => {
    if (gone || ws.readyState !== ws.OPEN) return;
    unacked += chunk.length;
    ws.send(chunk);
    if (unacked >= MAX_UNACKED && !paused) {
      paused = true;
      out.pause();
    }
  });
  const ping = setInterval(() => {
    if (tool_id !== null) keepalive(task.id, tool_id);
    try {
      ws.ping();
    } catch {}
  }, PING_EVERY);
  ws.on("message", (data, binary) => {
    const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as any);
    if (binary) return pty.write(buf);
    let m: any;
    try {
      m = JSON.parse(buf.toString("utf8"));
    } catch {
      return;
    }
    if (m?.type === "resize" && Number.isInteger(m.cols) && Number.isInteger(m.rows) && m.cols > 1 && m.rows > 1 && m.cols <= 65535 && m.rows <= 65535) {
      pty.resize(Math.min(m.cols, 1000), Math.min(m.rows, 1000));
    } else if (m?.type === "ack" && Number.isInteger(m.bytes) && m.bytes >= 0) {
      unacked = Math.max(0, unacked - m.bytes);
      if (paused && unacked < MAX_UNACKED) {
        paused = false;
        out.resume();
      }
    }
  });
  await new Promise<void>((done) => {
    // The shell or tool exited (or the session was killed): the attach client has gone too.
    out.on("end", () => {
      if (gone) return;
      gone = true;
      clearInterval(ping);
      background("closing an ended terminal's websocket", (async () => {
        try {
          await pty.wait();
          await close(ws, [1000, "Session ended"]);
        } finally {
          done();
        }
      })());
    });
    ws.on("close", () => {
      clearInterval(ping);
      if (!gone) {
        gone = true;
        pty.kill();
      }
      done();
    });
  });
}
