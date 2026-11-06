// Port of server/src/hosts/ssh.rs: hosts reached over SSH.
//
// The hub has its own SSH key. On the target machine that key is restricted to a forced command, `huntaway ssh-host`,
// plus port forwarding to the host's port:
//
//   restrict,port-forwarding,permitopen="127.0.0.1:7878",command="/path/huntaway ssh-host --port 7878" ssh-ed25519 AAAA… huntaway-hub
//
// `ssh-host` starts a host if none is running (through the user's login shell, so agents get the usual PATH) and prints
// how to talk to it. The hub then reaches the host through an SSH tunnel, so the host can listen on localhost only and
// never needs to reach the hub. If the tunnel drops, agents keep running and the hub reconnects.
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { join } from "node:path";
import * as db from "../db.ts";
import type { Link } from "../db.ts";
import type { AppState } from "../state.ts";
import { default_exe } from "../state.ts";
import { run_cmd } from "../proc.ts";
import { background, context, err_str, path_str, sleep } from "../util.ts";
import * as hub from "./hub.ts";
import { exit_status } from "./broker.ts";

// ---------- on the target machine ----------

/** A GET with a 3-second timeout (and a bearer token): its status and body. */
async function get(url: string, token: string | null = null): Promise<{ status: number; text: string }> {
  const headers: Record<string, string> = token === null ? {} : { authorization: `Bearer ${token}` };
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(3000) });
  return { status: res.status, text: await res.text() };
}

/**
 * How long `ssh-host` waits for a host that's down to come back by itself before starting one: a restart or an Update
 * leaves the port closed for a second or two (longer with a database backup), and a host started meanwhile takes the
 * port from the release being started, which then fails to listen (and the started host marks that release bad, as
 * one that didn't start: HA-271).
 */
export const START_GRACE_MS = 15_000;

/**
 * `huntaway ssh-host`: make sure a host is running on `port` and print JSON describing it. With `start` false
 * (`--no-start`), a host that isn't running is an error rather than started, for a host that has its own supervisor.
 */
export async function ssh_host(port: number, data_dir: string, name: string | null, opts: { start?: boolean; grace_ms?: number } = {}): Promise<void> {
  const { start = true, grace_ms = START_GRACE_MS } = opts;
  const base = `http://127.0.0.1:${port}`;
  const healthy = async () => {
    try {
      const r = await get(`${base}/api/health`);
      return r.status >= 200 && r.status < 300;
    } catch {
      return false;
    }
  };
  /** Whether the host is up within `ms`, checking every 250 ms. */
  const up_within = async (ms: number) => {
    for (const end = Date.now() + ms; Date.now() < end;) {
      await sleep(250);
      if (await healthy()) return true;
    }
    return false;
  };
  let started = false;
  if (!(await healthy()) && !(await up_within(grace_ms))) {
    if (!start) throw new Error(`no host is running on port ${port} (ssh-host --no-start doesn't start one)`);
    start_detached(port, data_dir, name);
    started = true;
    if (!(await up_within(15_000))) throw new Error(`started a host on port ${port}, but it didn't come up; see ${path_str(join(data_dir, "serve.log"))}`);
  }
  // A running host on the default data dir uses its token file; IA_TOKEN isn't visible here.
  let token: string;
  try {
    token = readFileSync(join(data_dir, "auth_token"), "utf8").trim();
  } catch (e) {
    throw context(`no auth_token in ${data_dir}`, e);
  }
  const res = await get(`${base}/api/info`, token);
  const info = JSON.parse(res.text);
  if (typeof info?.host_id !== "string") throw new Error(`the host on port ${port} is too old to link; update it`);
  // serde_json's maps are sorted by key.
  console.log(JSON.stringify({ info, port, started, token }));
}

/** Start `huntaway serve` in its own session, via the user's login shell. */
function start_detached(port: number, data_dir: string, name: string | null) {
  mkdirSync(data_dir, { recursive: true });
  const exe = default_exe();
  const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
  let cmd_line = `exec ${quote(exe)} serve --host 127.0.0.1 --port ${port} --data-dir ${quote(data_dir)}`;
  if (name !== null) cmd_line += ` --name ${quote(name)}`;
  const log = openSync(join(data_dir, "serve.log"), "a");
  const shell = process.env.SHELL || "/bin/sh";
  try {
    // Outlive the SSH session: a session of its own (setsid), and not waited for.
    const child = spawn(shell, ["-lc", cmd_line], { stdio: ["ignore", log, log], detached: true });
    child.on("error", (e) => console.error(`starting huntaway serve: ${err_str(e)}`));
    child.unref();
  } finally {
    closeSync(log);
  }
}

/** `huntaway ssh-host [--port N] [--data-dir DIR] [--name NAME] [--no-start]`, the forced command on an SSH target. */
export async function ssh_host_cli(argv: string[]): Promise<void> {
  let port = 7878;
  let data_dir: string | null = process.env.IA_DATA_DIR || null;
  let name: string | null = null;
  let start = true;
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i];
    let val: string | undefined;
    const eq = arg.indexOf("=");
    if (arg.startsWith("--") && eq > 0) {
      val = arg.slice(eq + 1);
      arg = arg.slice(0, eq);
    }
    const next = () => {
      if (val !== undefined) return val;
      if (i + 1 >= argv.length) throw new Error(`a value is required for '${arg}'`);
      return argv[++i];
    };
    switch (arg) {
      case "--port": {
        const v = next();
        port = Number(v);
        if (!/^\d+$/.test(v) || port > 65535) throw new Error(`invalid value '${v}' for '--port <PORT>'`);
        break;
      }
      case "--data-dir":
        data_dir = next();
        break;
      case "--name":
        name = next();
        break;
      case "--no-start":
        start = false;
        break;
      default:
        throw new Error(`unexpected argument '${argv[i]}'`);
    }
  }
  const { default_data_dir } = await import("../serve.ts");
  await ssh_host(port, data_dir ?? default_data_dir(), name, { start });
}

// ---------- on the hub ----------

/** How to reach an SSH host; stored as JSON in `links.ssh`. */
export interface Target {
  /** `user@host` */
  target: string;
  ssh_port: number;
  /** The host's port on that machine. */
  remote_port: number;
}

/** A `Target` from its JSON, as serde reads it (ports default to 22 and 7878). Throws serde's message on a bad one. */
export function Target_from_json(v: any): Target {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("invalid type: expected struct Target");
  if (v.target === undefined) throw new Error("missing field `target`");
  if (typeof v.target !== "string") throw new Error("invalid type for `target`: expected a string");
  const port = (k: string, def: number) => {
    if (v[k] === undefined) return def;
    if (!Number.isInteger(v[k]) || v[k] < 0 || v[k] > 65535) throw new Error(`invalid value for \`${k}\`: expected u16`);
    return v[k] as number;
  };
  return { target: v.target, ssh_port: port("ssh_port", 22), remote_port: port("remote_port", 7878) };
}

/** A link's `ssh` column as a target, if it is one. */
export function parse_target(json: string | null | undefined): Target | null {
  if (!json) return null;
  try {
    return Target_from_json(JSON.parse(json));
  } catch {
    return null;
  }
}

function ssh_dir(s: AppState): string {
  return join(s.data_dir, "ssh");
}

/** The hub's SSH key, created on first use. Returns the public key line. */
export async function public_key(s: AppState): Promise<string> {
  const dir = ssh_dir(s);
  const key = join(dir, "id_ed25519");
  if (!existsSync(key)) {
    mkdirSync(dir, { recursive: true });
    const comment = `huntaway-hub@${s.host_name}`;
    let out;
    try {
      out = await run_cmd("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", comment, "-f", key]);
    } catch (e) {
      throw context("ssh-keygen not found (the hub needs openssh-client)", e);
    }
    if (!out.success) throw new Error(`ssh-keygen failed: ${out.stderr.trim()}`);
  }
  return readFileSync(`${key}.pub`, "utf8").trim();
}

/** `ssh`'s arguments to reach `t` with the hub's key, then `more`. */
export function ssh_args(s: AppState, t: Target, more: string[]): string[] {
  const dir = ssh_dir(s);
  return [
    "-i",
    join(dir, "id_ed25519"),
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
    // Trust on first use; later changes of the host key are refused.
    "-o",
    `UserKnownHostsFile=${path_str(join(dir, "known_hosts"))}`,
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-p",
    String(t.ssh_port),
    t.target,
    ...more,
  ];
}

/**
 * Runs `ssh` with `args`, its stdin closed. If the hub dies, its ssh processes (tunnels) go with it: Rust sets
 * PR_SET_PDEATHSIG, which node can't, so a watchdog in ssh's process group kills the group once the pipe only this
 * server holds closes (as the broker's tunnel connector does). `stop` kills it.
 */
function ssh_spawn(args: string[], stdout: "pipe" | "ignore"): { child: ChildProcess; exited: Promise<string>; stop: () => void } {
  const LAUNCH = `exec 3<&0 </dev/null; (read -r _ <&3; kill -KILL 0) & exec 3<&-; exec "$@"`;
  const child = spawn("bash", ["-c", LAUNCH, "huntaway-ssh", process.env.IA_SSH_BIN || "ssh", ...args], {
    stdio: ["pipe", stdout, "pipe"],
    detached: true,
  });
  const alive = child.stdin!;
  alive.on("error", () => {});
  const exited = new Promise<string>((resolve) => {
    child.once("error", (e) => resolve(`couldn't start: ${err_str(e)}`));
    child.once("exit", (code, signal) => resolve(exit_status(code, signal)));
  });
  background(
    "an ssh connection",
    exited.then(() => alive.destroy()),
  );
  const stop = () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    alive.destroy();
  };
  return { child, exited, stop };
}

/** Run ssh to completion, with its output; `on_stop` gets what kills it (a link that goes stops its ssh). */
async function run_ssh(args: string[], on_stop: (stop: () => void) => void): Promise<{ success: boolean; stdout: string; stderr: string; status: string }> {
  const { child, exited, stop } = ssh_spawn(args, "pipe");
  on_stop(stop);
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  child.stdout!.on("data", (d) => out.push(d));
  child.stderr!.on("data", (d) => err.push(d));
  const status = await exited;
  if (status.startsWith("couldn't start")) throw context("running ssh", new Error(status));
  // Wait for what's left in the pipes.
  await Promise.all([child.stdout!, child.stderr!].map((p) => (p.readableEnded || p.destroyed ? null : new Promise((r) => p.once("close", r)))));
  return { success: child.exitCode === 0, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8"), status };
}

/** Run the target's forced command: starts its host if needed and returns its details. */
export async function ensure(s: AppState, t: Target, on_stop: (stop: () => void) => void = () => {}): Promise<any> {
  await public_key(s);
  const out = await run_ssh(ssh_args(s, t, ["ensure"]), on_stop);
  const line = out.stdout
    .split("\n")
    .reverse()
    .find((l) => l.trimStart().startsWith("{"));
  if (out.success && line !== undefined) return JSON.parse(line);
  const err = out.stderr.trim();
  if (err.includes("Permission denied")) throw new Error(`${t.target} refused the hub's key; add the authorized_keys line shown in Settings → Hosts`);
  throw new Error(`ssh ${t.target} failed: ${err || out.stdout.trim()}`);
}

/** Keep an SSH host linked: start it if needed, tunnel to it, follow it; retry on failure. Returns the function that stops it. */
export function run(s: AppState, link: Link): () => void {
  const t = parse_target(link.ssh);
  if (!t) {
    console.error(`ssh link ${link.name} has no target`);
    return () => {};
  }
  let stopped = false;
  let abort: (() => void) | null = null;
  background(
    "keeping an ssh host connected",
    (async () => {
      let backoff = 1;
      while (!stopped) {
        try {
          await connect_once(
            s,
            link,
            t,
            (a) => (abort = a),
            () => stopped,
          );
          backoff = 1;
        } catch (e) {
          if (!stopped) console.error(`ssh host ${link.name}: ${err_str(e)}`);
        }
        abort = null;
        if (stopped) break;
        await new Promise<void>((r) => {
          const timer = setTimeout(r, backoff * 1000);
          abort = () => {
            clearTimeout(timer);
            r();
          };
        });
        abort = null;
        backoff = Math.min(backoff * 2, 30);
      }
    })(),
  );
  return () => {
    stopped = true;
    abort?.();
  };
}

/** A free port on 127.0.0.1. */
function free_port(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as any).port;
      srv.close(() => resolve(port));
    });
  });
}

const can_connect = (port: number) =>
  new Promise<boolean>((resolve) => {
    const c = createConnection(port, "127.0.0.1");
    c.once("connect", () => {
      c.destroy();
      resolve(true);
    });
    c.once("error", () => resolve(false));
  });

/**
 * One connection: ensure the host, open the tunnel, follow it until either ends. `on_abort` gets the function that ends
 * it (Rust aborts the task, which kills its ssh processes).
 */
async function connect_once(s: AppState, link: Link, t: Target, on_abort: (abort: () => void) => void, stopped: () => boolean): Promise<void> {
  const details = await ensure(s, t, on_abort);
  if (stopped()) return;
  const token = typeof details?.token === "string" ? (details.token as string) : null;
  if (token === null) throw new Error("no token from ssh-host");
  const port = Number.isInteger(details.port) && details.port >= 0 ? (details.port as number) : t.remote_port;

  // Forward a free local port to the host's port on the target.
  const local = await free_port();
  const tunnel = ssh_spawn(ssh_args(s, t, ["-N", "-o", "ExitOnForwardFailure=yes", "-L", `127.0.0.1:${local}:127.0.0.1:${port}`]), "ignore");
  tunnel.child.stderr!.resume();
  const tunnel_state: { status: string | null } = { status: null };
  background(
    "an ssh tunnel",
    tunnel.exited.then((st) => (tunnel_state.status = st)),
  );
  const outbound: { abort: (() => void) | null } = { abort: null };
  on_abort(() => {
    tunnel.stop();
    outbound.abort?.();
  });
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (stopped()) return;
      if (await can_connect(local)) {
        ready = true;
        break;
      }
      const status = tunnel_state.status;
      if (status !== null) {
        if (status.startsWith("couldn't start")) throw context("starting the ssh tunnel", new Error(status));
        throw new Error(`ssh tunnel exited (${status})`);
      }
      await sleep(100);
    }
    if (!ready) throw new Error("ssh tunnel didn't open");
    const via: Link = { ...link, url: `http://127.0.0.1:${local}` };
    db.hidden(via, "token", token);
    const closed = tunnel.exited.then((st) => {
      throw new Error(`ssh tunnel closed (${st})`);
    });
    await Promise.race([hub.run_outbound(s, via, "ssh", (a) => (outbound.abort = a)), closed]);
  } finally {
    // The tunnel goes with the connection (Rust's kill_on_drop), and the connection with the tunnel.
    tunnel.stop();
    outbound.abort?.();
  }
}
