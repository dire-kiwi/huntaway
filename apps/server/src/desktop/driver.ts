// The host's one Cua Driver (see desktop.ts): `cua-driver mcp`, a child of this server that we speak MCP to over its
// stdio (newline-delimited JSON-RPC). On Linux it owns the driver's runtime for as long as its stdin is open, so every
// task's calls go through this one process. It starts when a call needs it and stops after `IDLE_MS` without one.
import { spawn, type ChildProcess } from "node:child_process";
import { readdirSync } from "node:fs";
import { run_cmd } from "../proc.ts";
import type { Shared } from "../state.ts";
import { err_str } from "../util.ts";
import * as desktop from "../desktop.ts";

/** Stop the driver after this long without a call. */
export const IDLE_MS = 10 * 60_000;
/** How long the driver has to start (and answer `initialize`). */
const START_MS = 30_000;
/** A call's default time limit. */
export const CALL_MS = 120_000;

/** The environment of the user's graphical session, which a server started as a service may not have. */
const SESSION_VARS = [
  "WAYLAND_DISPLAY",
  "DISPLAY",
  "XAUTHORITY",
  "DBUS_SESSION_BUS_ADDRESS",
  "XDG_CURRENT_DESKTOP",
  "XDG_SESSION_TYPE",
  "XDG_SESSION_DESKTOP",
  "HYPRLAND_INSTANCE_SIGNATURE",
  "SWAYSOCK",
  "NIRI_SOCKET",
];

/**
 * The driver's environment: ours, and on Linux what's missing of the graphical session's from the user's systemd
 * environment (which compositors import theirs into), else a Wayland socket in `XDG_RUNTIME_DIR`. Wayland needs
 * `CUA_DRIVER_RS_ENABLE_WAYLAND`, as T3 Code sets it.
 */
export async function session_env(base: NodeJS.ProcessEnv = process.env): Promise<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = { ...base };
  if (process.platform === "linux" && !env.WAYLAND_DISPLAY && !env.DISPLAY) {
    try {
      const out = await run_cmd("systemctl", ["--user", "show-environment"], { timeout: 5000 });
      for (const line of out.stdout.split("\n")) {
        const eq = line.indexOf("=");
        const k = line.slice(0, eq);
        if (eq > 0 && SESSION_VARS.includes(k) && !env[k]) env[k] = line.slice(eq + 1);
      }
    } catch {}
    const dir = env.XDG_RUNTIME_DIR;
    if (!env.WAYLAND_DISPLAY && !env.DISPLAY && dir) {
      try {
        const sock = readdirSync(dir).find((f) => /^wayland-\d+$/.test(f));
        if (sock) env.WAYLAND_DISPLAY = sock;
      } catch {}
    }
  }
  if (env.WAYLAND_DISPLAY && !env.CUA_DRIVER_RS_ENABLE_WAYLAND) env.CUA_DRIVER_RS_ENABLE_WAYLAND = "1";
  return env;
}

/** What kind of desktop the driver sees: "wayland", "x11", or null for none (or not Linux: "macos"). */
export function session_kind(env: NodeJS.ProcessEnv): string | null {
  if (process.platform === "darwin") return "macos";
  return env.WAYLAND_DISPLAY ? "wayland" : env.DISPLAY ? "x11" : null;
}

/** Screen lockers, which a locked screen on Linux is running even when logind isn't told. */
const LOCKERS = ["hyprlock", "swaylock", "gtklock", "waylock", "i3lock", "xsecurelock", "slock"];

let lock_cache: { at: number; locked: boolean | null } | null = null;

/**
 * Whether the screen is locked: true, false, or null where we can't tell (not Linux). logind's `LockedHint` for the
 * user's graphical session, or a screen locker running. Kept for a couple of seconds.
 */
export async function locked(env: NodeJS.ProcessEnv = process.env): Promise<boolean | null> {
  if (process.env.IA_DESKTOP_LOCKED) return process.env.IA_DESKTOP_LOCKED === "1";
  if (process.platform !== "linux") return null;
  if (lock_cache && Date.now() - lock_cache.at < 2000) return lock_cache.locked;
  let is = false;
  try {
    const user = await run_cmd("loginctl", ["show-user", String(process.getuid?.() ?? ""), "-p", "Display", "--value"], { timeout: 3000 });
    const session = env.XDG_SESSION_ID || user.stdout.trim();
    if (session) {
      const hint = await run_cmd("loginctl", ["show-session", session, "-p", "LockedHint", "--value"], { timeout: 3000 });
      is = hint.stdout.trim() === "yes";
    }
  } catch {}
  if (!is) {
    try {
      const p = await run_cmd("pgrep", ["-u", String(process.getuid?.() ?? ""), "-x", LOCKERS.join("|")], { timeout: 3000 });
      is = p.success && p.stdout.trim() !== "";
    } catch {}
  }
  lock_cache = { at: Date.now(), locked: is };
  return is;
}

/** A tool the driver offers: its name and input schema's properties (which say what arguments it takes). */
export interface DriverTool {
  name: string;
  properties: Record<string, any>;
}

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

/** One running `cua-driver mcp`. */
class Process {
  child: ChildProcess;
  next = 1;
  pending = new Map<number, Pending>();
  buf = "";
  stderr = "";
  exited: string | null = null;
  constructor(path: string, env: NodeJS.ProcessEnv, on_exit: (why: string) => void) {
    this.child = spawn(path, ["mcp"], { env, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout!.setEncoding("utf8");
    this.child.stdout!.on("data", (d: string) => this.read(d));
    this.child.stderr!.setEncoding("utf8");
    this.child.stderr!.on("data", (d: string) => (this.stderr = (this.stderr + d).slice(-4000)));
    const end = (why: string) => {
      if (this.exited !== null) return;
      this.exited = why;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error(`Cua Driver ${why}${this.stderr.trim() ? `: ${this.stderr.trim().split("\n").slice(-3).join(" / ")}` : ""}`));
      }
      this.pending.clear();
      on_exit(why);
    };
    this.child.on("error", (e) => end(`couldn't start (${err_str(e)})`));
    this.child.on("exit", (code, signal) => end(signal ? `stopped (${signal})` : `exited (${code})`));
    this.child.stdin!.on("error", () => {});
  }
  private read(d: string) {
    this.buf += d;
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      // Its own requests (it has none we take) and notifications are dropped.
      if (typeof msg?.id !== "number" || Object.hasOwn(msg, "method")) continue;
      const p = this.pending.get(msg.id);
      if (!p) continue;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(String(msg.error.message ?? JSON.stringify(msg.error))));
      else p.resolve(msg.result);
    }
  }
  request(method: string, params: any, ms: number): Promise<any> {
    if (this.exited !== null) return Promise.reject(new Error(`Cua Driver ${this.exited}`));
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Cua Driver didn't answer ${method === "tools/call" ? params?.name : method} within ${Math.round(ms / 1000)}s`));
      }, ms);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }
  notify(method: string, params: any = {}) {
    if (this.exited === null) this.child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }
  stop() {
    // EOF on stdin ends the runtime cleanly; a kill if it hasn't gone a few seconds later.
    this.child.stdin!.end();
    const t = setTimeout(() => this.child.kill("SIGKILL"), 5000);
    t.unref();
    this.child.once("exit", () => clearTimeout(t));
  }
}

export interface DriverStatus {
  state: "stopped" | "starting" | "running" | "failed";
  /** The driver's own version, from its `initialize` answer. */
  version: string | null;
  error: string | null;
  started_at: string | null;
  last_call_at: string | null;
  tools: number;
}

/** The host's driver: started when `call` needs it. */
export class Driver {
  private proc: Process | null = null;
  private ready: Promise<void> | null = null;
  private idle: NodeJS.Timeout | null = null;
  tools = new Map<string, DriverTool>();
  status: DriverStatus = { state: "stopped", version: null, error: null, started_at: null, last_call_at: null, tools: 0 };
  /** The environment it was started with (for `session_kind`). */
  env: NodeJS.ProcessEnv = process.env;
  s: Shared;
  constructor(s: Shared) {
    this.s = s;
  }

  /** Start it if it isn't running; rejects if it can't start. */
  start(): Promise<void> {
    if (this.ready) return this.ready;
    const found = desktop.find(this.s);
    if (!found) return Promise.reject(new Error("Cua Driver isn't installed on this host: install it from the host's page in Settings → Hosts"));
    this.status = { ...this.status, state: "starting", error: null, started_at: new Date().toISOString() };
    const ready = (async () => {
      this.env = await session_env();
      const p = new Process(found.path, this.env, (why) => {
        if (this.proc !== p) return;
        this.proc = null;
        this.ready = null;
        this.tools.clear();
        this.status = { ...this.status, state: why.startsWith("stopped") || why === "exited (0)" ? "stopped" : "failed", error: `Cua Driver ${why}`, tools: 0 };
      });
      this.proc = p;
      const init = await p.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "huntaway", version: "1" } }, START_MS);
      p.notify("notifications/initialized");
      const list = await p.request("tools/list", {}, START_MS);
      this.tools.clear();
      for (const t of list?.tools ?? []) {
        if (typeof t?.name === "string") this.tools.set(t.name, { name: t.name, properties: t.inputSchema?.properties ?? {} });
      }
      this.status = { ...this.status, state: "running", version: init?.serverInfo?.version ?? null, tools: this.tools.size };
    })();
    this.ready = ready;
    ready.catch((e) => {
      if (this.ready !== ready) return;
      this.status = { ...this.status, state: "failed", error: err_str(e) };
      this.proc?.stop();
      this.proc = null;
      this.ready = null;
    });
    return ready;
  }

  /** Whether the running driver offers `tool` (and, with `arg`, takes that argument). */
  has(tool: string, arg?: string): boolean {
    const t = this.tools.get(tool);
    return !!t && (arg === undefined || Object.hasOwn(t.properties, arg));
  }

  /** Call one of the driver's tools; its MCP result (content, structuredContent, isError). */
  async call(tool: string, args: Record<string, any>, ms = CALL_MS): Promise<any> {
    await this.start();
    if (!this.tools.has(tool)) throw new Error(`this host's Cua Driver (${this.status.version ?? "unknown version"}) has no ${tool} tool`);
    this.touch();
    try {
      return await this.proc!.request("tools/call", { name: tool, arguments: args }, ms);
    } finally {
      this.touch();
    }
  }

  private touch() {
    this.status.last_call_at = new Date().toISOString();
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => this.stop(), IDLE_MS);
    this.idle.unref();
  }

  /** Stop it (it starts again on the next call). */
  stop(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    const p = this.proc;
    this.proc = null;
    this.ready = null;
    this.tools.clear();
    if (p) {
      p.stop();
      this.status = { ...this.status, state: "stopped", error: null, tools: 0 };
    }
  }

  /** The last lines it wrote to stderr, for the host's page. */
  stderr(): string {
    return this.proc?.stderr ?? "";
  }
}

const drivers = new WeakMap<Shared, Driver>();

/** The host's driver. */
export function of(s: Shared): Driver {
  let d = drivers.get(s);
  if (!d) drivers.set(s, (d = new Driver(s)));
  return d;
}
