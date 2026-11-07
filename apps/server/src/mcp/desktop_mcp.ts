/**
 * The `desktop` MCP server (HA-273, see desktop.ts): the host's desktop, for agents, through its Cua Driver. Shaped
 * after `agentcast` (pingdotgg/t3code#28050), which took fewer calls and less time than Cua's own server with the same
 * engine: a few tools that each do one job, read-only ones that need no approval (`READS`), and the rest (`WRITES`),
 * which ask as any tool does. What it adds to the driver:
 *
 * - One session per task (`huntaway-<key>`), which Cua's own state (cursors, snapshots) is kept under.
 * - A locked screen stops everything but `health` and `op_status`: nobody's there, and the agent mustn't unlock it.
 * - One task drives the desktop at a time (desktop.ts's `claim`): tasks' agents share one keyboard, pointer and focus.
 * - Actions are journaled (db/desktop.ts). One the agent names with `op_id` runs at most once, so after a lost answer it
 *   asks `op_status` instead of acting again, and the board shows what each task did.
 *
 * Every run on a host with computer use on gets it, served over HTTP beside the board's own servers (mcp/http.ts).
 */
import * as db from "../db.ts";
import * as desktop_db from "../db/desktop.ts";
import * as desktop from "../desktop.ts";
import * as driver from "../desktop/driver.ts";
import { VERSION } from "../hosts/proto.ts";
import * as runner from "../agent/runner.ts";
import type { Shared } from "../state.ts";
import { err_str, truncate } from "../util.ts";

export const SERVER_NAME = "desktop";

/** The tools that only look. */
export const READS = ["health", "apps", "windows", "read", "screen", "zoom", "verify", "op_status"] as const;
/** The tools that change something, which ask first unless the run may do anything. */
export const WRITES = ["act", "launch", "clipboard"] as const;

const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

/** Sent with `initialize`; Claude Code adds it to the agent's system prompt. */
export const INSTRUCTIONS =
  "`desktop` drives native apps on the desktop of the computer you run on, through Cua Driver. Use it only when the " +
  "shell, files or other tools can't do the job. Find the app with `windows` (or `apps`, then `launch`), `read` its " +
  'window\'s accessibility tree (start with `query` to keep it small; `since: "latest"` gets only what changed), then ' +
  "`act` with a batch of steps on `element_token`s from that read: it reports what changed, so you rarely need another " +
  "read. Use `screen` to look, and pixels only for what the tree can't reach. Keep delivery in the background (the " +
  'default): don\'t bring windows to the front just to look, and use `delivery_mode: "foreground"` only when the user ' +
  "allows it. Target windows by `pid` and `window_id`. Give each `act`, `launch` and `clipboard` an `op_id`; if an " +
  "answer is lost, call `op_status` with it instead of acting again. The person at this computer may be using it: " +
  "leave it as you found it (close the windows you opened, not theirs). If the screen is locked or another task is " +
  "using the desktop, stop and say so; don't try to unlock it.";

const ID_PROPS = {
  pid: { type: "integer", description: "The app's process id (from `windows` or `apps`)." },
  window_id: { type: "integer", description: "The window's id from `windows`. Omitted: the app's focused or largest window." },
};
const OP_ID = { type: "string", description: "Your name for this action, unique in this task, so a retry after a lost answer doesn't run it twice." };

/** The tools, as `tools/list` gives them. Their arguments are Cua's, passed on, with Cua's names. */
export const TOOLS = [
  {
    name: "health",
    description: "Whether the desktop can be used now: the driver, the session (Wayland or X11), a locked screen, and which task is using it.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: "apps",
    description: "Installed and running apps, with what `launch` takes to start them.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: "windows",
    description: "Open windows: pid, window_id, app, title, bounds, and how near the front they are (larger z_index is nearer).",
    inputSchema: {
      type: "object",
      properties: {
        pid: { type: "integer", description: "Only this process's windows." },
        app: { type: "string", description: "Only windows of apps whose name contains this." },
        on_screen_only: { type: "boolean" },
      },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "read",
    description:
      'A window\'s accessibility tree, as rows `[N] role "label"`; act on row N with element_token `<snapshot_id>:N`. Start with `query` to get only matching rows (and their ancestors); `since: "latest"` returns only what changed since your last read of that window.',
    inputSchema: {
      type: "object",
      required: ["pid"],
      properties: {
        ...ID_PROPS,
        query: { type: "string", description: "Case-insensitive text to match rows against." },
        since: { type: "string", description: '"latest", or a snapshot_id: only the rows that changed since.' },
        max_elements: { type: "integer", description: "Most nodes to walk (default 250)." },
        max_depth: { type: "integer" },
        include_screenshot: { type: "boolean", description: "Also return the window's image (default false: use `screen` to look)." },
      },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "screen",
    description: "An image of a window (with pid), or of the whole desktop (without). Pixels in a window's image are what `act` steps' x, y mean for it.",
    inputSchema: { type: "object", properties: { ...ID_PROPS, pid: { type: "integer", description: "The app's process id; omitted for the whole desktop." } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: "zoom",
    description: "A region of a window's last image at full resolution, from x1,y1 (top left) to x2,y2 (bottom right), in that image's pixels.",
    inputSchema: {
      type: "object",
      required: ["pid", "x1", "y1", "x2", "y2"],
      properties: { ...ID_PROPS, x1: { type: "number" }, y1: { type: "number" }, x2: { type: "number" }, y2: { type: "number" } },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "verify",
    description:
      'Check a window against what you expect, e.g. expect: [{"element": {"selector": {"label_contains": "Saved"}, "exists": true}}]. Answers satisfied, unsatisfied or unknown (with why).',
    inputSchema: {
      type: "object",
      required: ["pid", "expect"],
      properties: { ...ID_PROPS, expect: { type: "array", items: { type: "object" } }, include_screenshot: { type: "boolean" } },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "op_status",
    description: "What became of an `act`, `launch` or `clipboard` you gave an op_id: running, ok, failed, or interrupted (unknown: look before acting again).",
    inputSchema: { type: "object", required: ["op_id"], properties: { op_id: { type: "string" } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: "act",
    description:
      'Run steps on a window, in order, stopping at the first that fails, then report what changed. A step is {"tool": click | double_click | right_click | type_text | set_value | press_key | hotkey | scroll | drag | move_cursor, "args": {...}}, e.g. {"tool": "click", "args": {"element_token": "s0000002a:14"}}, {"tool": "type_text", "args": {"element_token": "s0000002a:15", "text": "hi"}}, {"tool": "press_key", "args": {"key": "return"}}, {"tool": "hotkey", "args": {"keys": ["ctrl", "s"]}}, or pixels: {"tool": "click", "args": {"x": 120, "y": 40}}. pid and window_id here apply to every step.',
    inputSchema: {
      type: "object",
      required: ["pid", "steps"],
      properties: {
        ...ID_PROPS,
        steps: {
          type: "array",
          items: { type: "object", required: ["tool"], properties: { tool: { type: "string" }, args: { type: "object" } } },
          maxItems: 64,
        },
        observe: { description: "What to read after the last step: true or read's arguments (default: what changed); false to read nothing." },
        delivery_mode: {
          type: "string",
          enum: ["background", "foreground"],
          description: "Default background. Foreground takes focus and the pointer: only if the user allows it.",
        },
        delay_ms: { type: "integer", description: "Pause between steps." },
        op_id: OP_ID,
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  {
    name: "launch",
    description: "Start an app (by name, or the launch_path `apps` gave), optionally opening URLs or files in it. Returns its pid and windows.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        launch_path: { type: "string" },
        bundle_id: { type: "string", description: "macOS." },
        urls: { type: "array", items: { type: "string" } },
        additional_arguments: { type: "array", items: { type: "string" } },
        op_id: OP_ID,
      },
    },
    annotations: { readOnlyHint: false },
  },
  {
    name: "clipboard",
    description: "Read the clipboard's text, or with `text`, set it.",
    inputSchema: { type: "object", properties: { text: { type: "string" }, op_id: OP_ID } },
    annotations: { readOnlyHint: false },
  },
];

/** Who's calling: the run, its task, and the session it drives the desktop under. */
export interface DesktopRun {
  run_id: string;
  task_id: string;
  /** The task's key, e.g. HA-12. */
  key: string;
}

/** Run `run_id`'s caller, or null for a run that's gone. */
export function run_caller(s: Shared, run_id: string): DesktopRun | null {
  const c = s.db();
  const run = db.get_run(c, run_id);
  const task = run ? db.get_task(c, run.task_id) : undefined;
  if (!task) return null;
  return { run_id, task_id: task.id, key: `${runner.task_key_prefix(s, task)}-${task.number}` };
}

class ToolError extends Error {}

/** What a call is told while computer use is off for the host. */
const OFF = (s: Shared) =>
  `Computer use has been turned off on ${s.host_name}, so its desktop can't be used. Don't try to work around it: tell the user if the task needs it.`;

const text = (t: string, isError = false) => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });

const obj = (v: any): Record<string, any> => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
const int = (v: any): number | null => (typeof v === "number" && Number.isInteger(v) ? v : null);

/** `a`'s keys in `keys` that are set. */
function pick(a: Record<string, any>, keys: string[]): Record<string, any> {
  const out: Record<string, any> = {};
  for (const k of keys) if (a[k] !== undefined && a[k] !== null) out[k] = a[k];
  return out;
}

/** The text of a result, without its images, for the journal. */
function result_text(r: any): string {
  const parts = (r?.content ?? []).filter((c: any) => c?.type === "text").map((c: any) => String(c.text));
  return truncate(parts.join("\n"), 20_000);
}

/** The most of a result's structured fields given to the agent as JSON. */
const STRUCTURED_MAX = 30_000;

/**
 * A driver's result as the agent gets it: its text and images, and its structured fields (`structuredContent`) as one
 * more line of JSON, without those whose text is in the text already. Not as `structuredContent`: Claude Code gives the
 * model a result's structured content in place of its text when it has some, which would hide the tree rows and
 * hints Cua writes as text.
 */
export function for_agent(r: any): any {
  if (!r || typeof r !== "object") return r;
  const content = Array.isArray(r.content) ? [...r.content] : [];
  const sc = r.structuredContent;
  if (sc && typeof sc === "object" && !Array.isArray(sc)) {
    const said = content
      .filter((c: any) => c?.type === "text")
      .map((c: any) => String(c.text))
      .join("\n");
    const rest = Object.fromEntries(Object.entries(sc).filter(([, v]) => !(typeof v === "string" && v.length > 40 && said.includes(v))));
    if (Object.keys(rest).length) content.push({ type: "text", text: truncate(JSON.stringify(rest), STRUCTURED_MAX) });
  }
  return { content, ...(r.isError ? { isError: true } : {}) };
}

/** A line for the board saying what an `act` does. */
function act_summary(a: Record<string, any>): string {
  const steps = Array.isArray(a.steps) ? a.steps : [];
  const say = (st: any) => {
    const t = String(st?.tool ?? "?");
    const args = obj(st?.args);
    if ((t === "type_text" || t === "type") && typeof args.text === "string") return `type ${JSON.stringify(truncate(args.text, 40))}`;
    if (t === "set_value" && args.value !== undefined) return `set ${JSON.stringify(truncate(String(args.value), 40))}`;
    if ((t === "press_key" || t === "press") && args.key) return `press ${args.key}`;
    if (t === "hotkey" && Array.isArray(args.keys)) return `press ${args.keys.join("+")}`;
    return t.replace(/_/g, " ");
  };
  const listed = steps.slice(0, 4).map(say).join(", ");
  return steps.length > 4 ? `${listed}, … (${steps.length} steps)` : listed || "no steps";
}

/** The tools' answers for one caller. */
class Server {
  d: driver.Driver;
  s: Shared;
  r: DesktopRun;
  constructor(s: Shared, r: DesktopRun) {
    [this.s, this.r, this.d] = [s, r, driver.of(s)];
  }

  get session(): string {
    return `huntaway-${this.r.key}`;
  }

  /** `args` for the driver's `tool`, with our session if the tool takes one. */
  private args(tool: string, a: Record<string, any>): Record<string, any> {
    return this.d.has(tool, "session") ? { ...a, session: this.session } : a;
  }

  /** Call the driver's `tool`: its result as it is (see `for_agent` for what the agent gets). */
  private async drive_raw(tool: string, a: Record<string, any>): Promise<any> {
    await this.d.start();
    return await this.d.call(tool, this.args(tool, a));
  }

  private async drive(tool: string, a: Record<string, any>): Promise<any> {
    return for_agent(await this.drive_raw(tool, a));
  }

  private note_target(a: Record<string, any>) {
    const pid = int(a.pid);
    if (pid !== null) desktop.set_target(this.r.task_id, pid, int(a.window_id));
  }

  /** Refuse on a locked screen. */
  private async check_lock() {
    if (await driver.locked(this.d.env)) {
      throw new ToolError(
        `The screen of ${this.s.host_name} is locked, so its desktop can't be used until someone unlocks it. Don't try to unlock it: tell the user.`,
      );
    }
  }

  /** Refuse when another task is driving the desktop; else this task holds it. */
  private check_claim() {
    const h = desktop.claim(this.r.task_id);
    if (!h) return;
    const t = db.get_task(this.s.db(), h.task_id);
    const who = t ? `${runner.task_key_prefix(this.s, t)}-${t.number} ("${truncate(t.title, 60)}")` : "another task";
    const ago = Math.round((Date.now() - h.at) / 1000);
    throw new ToolError(
      `${who} is using this desktop (its last action was ${ago}s ago), and only one task drives it at a time. Wait a couple of minutes and try again, or tell the user.`,
    );
  }

  async health(): Promise<any> {
    const found = desktop.find(this.s);
    const on = desktop.enabled(this.s.db());
    let error: string | null = on ? null : OFF(this.s);
    // Off, it only says so: the driver isn't started for it.
    if (found && on) {
      try {
        await this.d.start();
      } catch (e) {
        error = err_str(e);
      }
    }
    const h = desktop.current_holder();
    const holder = h ? db.get_task(this.s.db(), h.task_id) : undefined;
    const out: any = {
      host: this.s.host_name,
      platform: process.platform,
      session: driver.session_kind(this.d.env),
      driver: found
        ? { path: found.path, version: this.d.status.version ?? found.version, state: this.d.status.state, error: error ?? this.d.status.error }
        : null,
      locked: await driver.locked(this.d.env),
      in_use_by: holder && holder.id !== this.r.task_id ? `${runner.task_key_prefix(this.s, holder)}-${holder.number}` : null,
      you: this.session,
    };
    if (this.d.has("check_permissions")) {
      try {
        out.permissions = result_text(await this.drive("check_permissions", {}));
      } catch (e) {
        out.permissions = `couldn't check: ${err_str(e)}`;
      }
    }
    return text(JSON.stringify(out, null, 2));
  }

  async op_status(a: Record<string, any>): Promise<any> {
    if (typeof a.op_id !== "string") throw new ToolError("op_status needs an op_id");
    const op = desktop_db.find_op(this.s.db(), this.r.task_id, a.op_id);
    if (!op) return text(`No op ${JSON.stringify(a.op_id)} in this task: it never started, so it didn't run.`);
    const how =
      op.status === "interrupted" ? " (the board's server stopped while it ran: whether it took effect isn't known, so look before acting again)" : "";
    return text(`op ${op.op_id}: ${op.tool} ${op.summary}: ${op.status}${how}${op.result ? `\n\n${op.result}` : ""}`);
  }

  async read_only(name: string, a: Record<string, any>): Promise<any> {
    await this.check_lock();
    switch (name) {
      case "apps":
        return await this.drive("list_apps", {});
      case "windows":
        return await this.drive("list_windows", pick(a, ["pid", "app", "on_screen_only"]));
      case "read": {
        this.note_target(a);
        const args = {
          include_screenshot: false,
          ...pick(a, ["pid", "window_id", "query", "since", "max_elements", "max_depth", "include_screenshot", "tree_format"]),
        };
        return await this.drive("get_window_state", args);
      }
      case "screen": {
        if (int(a.pid) === null) return await this.drive("get_desktop_state", {});
        this.note_target(a);
        const args: Record<string, any> = { ...pick(a, ["pid", "window_id"]), include_screenshot: true };
        // A look that keeps the tree's tokens valid, where the driver can.
        if (this.d.has("get_window_state", "include_accessibility_tree")) args.include_accessibility_tree = false;
        return await this.drive("get_window_state", args);
      }
      case "zoom":
        this.note_target(a);
        return await this.drive("zoom", pick(a, ["pid", "window_id", "x1", "y1", "x2", "y2"]));
      case "verify":
        this.note_target(a);
        return await this.drive("verify_state", pick(a, ["pid", "window_id", "expect", "include_screenshot"]));
    }
    return null;
  }

  /** An action: claimed, journaled, and run once per op_id. */
  async write(name: string, a: Record<string, any>): Promise<any> {
    const c = this.s.db();
    const op_id = typeof a.op_id === "string" && a.op_id ? a.op_id : null;
    if (op_id) {
      const done = desktop_db.find_op(c, this.r.task_id, op_id);
      if (done) {
        return text(
          `op ${op_id} already ran (${done.status}${done.status === "interrupted" ? ": whether it took effect isn't known; look before acting again" : ""}), so it wasn't run again.` +
            (done.result ? `\n\n${done.result}` : ""),
          done.status === "failed",
        );
      }
    }
    await this.check_lock();
    this.check_claim();
    let tool: string, args: Record<string, any>, summary: string;
    if (name === "act") {
      if (!Array.isArray(a.steps) || a.steps.length === 0) throw new ToolError("act needs steps: [{tool, args}, …]");
      this.note_target(a);
      tool = "run_steps";
      args = { observe: {}, ...pick(a, ["pid", "window_id", "steps", "observe", "delivery_mode", "delay_ms"]) };
      if (args.observe === false) delete args.observe;
      summary = act_summary(a);
    } else if (name === "launch") {
      tool = "launch_app";
      args = pick(a, ["name", "launch_path", "bundle_id", "urls", "additional_arguments"]);
      summary = `launch ${a.name ?? a.launch_path ?? a.bundle_id ?? "an app"}`;
    } else {
      const set = typeof a.text === "string";
      tool = set ? "clipboard_write" : "clipboard_read";
      // Cua's clipboard_read says only what's on the clipboard (its types) unless it's asked for the text.
      if (!set) await this.d.start();
      args = set ? { text: a.text } : this.d.has("clipboard_read", "include_text") ? { include_text: true } : {};
      summary = set ? `copy ${JSON.stringify(truncate(a.text, 40))}` : "read the clipboard";
    }
    let op: desktop_db.DesktopOp;
    try {
      op = desktop_db.start_op(c, { task_id: this.r.task_id, run_id: this.r.run_id, op_id, tool: name, summary, args: a });
    } catch (e) {
      // The same op_id at once from two calls: the other's running it.
      if (op_id && /UNIQUE/i.test(err_str(e))) return text(`op ${op_id} is already running; call op_status with it later.`, true);
      throw e;
    }
    let result: any;
    try {
      result = await this.drive_raw(tool, args);
    } catch (e) {
      desktop_db.finish_op(c, op.id, "failed", err_str(e));
      throw e;
    }
    desktop_db.finish_op(c, op.id, result?.isError ? "failed" : "ok", result_text(for_agent(result)));
    const pid = int(result?.structuredContent?.pid);
    if (name === "launch" && pid !== null) desktop.set_target(this.r.task_id, pid, int(result?.structuredContent?.windows?.[0]?.window_id));
    return for_agent(result);
  }
}

/** Tool `name`'s answer (an MCP `tools/call` result), or null for a tool it doesn't have. */
export async function call(s: Shared, r: DesktopRun, name: string, args: any): Promise<any> {
  const a = obj(args);
  const server = new Server(s, r);
  try {
    if (name === "health") return await server.health();
    if (name === "op_status") return await server.op_status(a);
    // Turned off since the run started (the host's page stops the driver then): nothing starts it again.
    if (!desktop.enabled(s.db()) && [...READS, ...WRITES].includes(name as any)) return text(OFF(s), true);
    if ((READS as readonly string[]).includes(name)) return await server.read_only(name, a);
    if ((WRITES as readonly string[]).includes(name)) return await server.write(name, a);
    return null;
  } catch (e) {
    return text(err_str(e), true);
  }
}

/** Answer a JSON-RPC message from run `r`'s agent; null for a notification, which gets none. */
export async function handle(s: Shared, msg: any, r: DesktopRun | null): Promise<any> {
  if (msg === null || typeof msg !== "object" || !Object.hasOwn(msg, "id")) return null;
  const id = msg.id;
  const method = typeof msg.method === "string" ? msg.method : "";
  const params = msg.params ?? {};
  const error = (code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
  let result: any;
  switch (method) {
    case "initialize": {
      const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      result = {
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "huntaway-desktop", title: "Desktop", version: VERSION },
        instructions: INSTRUCTIONS,
      };
      break;
    }
    case "ping":
      result = {};
      break;
    case "tools/list":
      result = { tools: TOOLS };
      break;
    case "tools/call": {
      if (!r) return error(-32000, "unknown run");
      const name = typeof params.name === "string" ? params.name : "";
      result = await call(s, r, name, params.arguments ?? {});
      if (result === null) return error(-32602, `unknown tool ${JSON.stringify(name)}`);
      break;
    }
    case "resources/list":
      result = { resources: [] };
      break;
    case "prompts/list":
      result = { prompts: [] };
      break;
    default:
      return error(method ? -32601 : -32600, method ? `method not found: ${method}` : "invalid request");
  }
  return { jsonrpc: "2.0", id, result };
}
