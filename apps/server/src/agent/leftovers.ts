/**
 * Stopping what a task's agent left running (HA-186): test servers it started with `scripts/test-server.sh` (or by hand),
 * the ia-shim runs those servers started, and their agents. Test servers keep their data in the task's temp folder (see
 * `task_tmp`), and run its worktree's build, so once the folder or the worktree goes they'd run on with nothing left of
 * them, holding memory and a port. They're stopped first.
 *
 * A process is a task's when it's one of this user's and:
 * - a server (`… huntaway serve`, `… main.ts serve`, with a `--data-dir`) whose data dir is in the task's temp folder, or
 *   whose executable, script or working directory is in the task's worktree (and whose data dir isn't another task's
 *   temp folder);
 * - an ia-shim whose run folder is in one of those servers' data dirs or in the temp folder, or whose executable is in the
 *   worktree; or the agent under one of those shims, with its process group;
 * - or started by one of those servers (a TS server's `node` under its `sh` wrapper, its MCP helpers).
 *
 * Never the board itself or what runs its own agents: not this process or its parents, no server on the board's data dir,
 * and no shim with a run in the board's `runs` folder. Processes are found by what `/proc` says of them (their command
 * line, executable and working directory), or `ps` and `lsof` where there's no `/proc` (macOS), never by a pattern given
 * to `pkill`, and stopped by pid: TERM, then KILL if they're still there after `GRACE_MS`, if they're still the same
 * process (by when they started).
 */
import { readFile, readdir, readlink, stat } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { run_cmd } from "../proc.ts";
import { err_str, sleep } from "../util.ts";

/** How long a process has to stop after TERM before it's killed. */
export const GRACE_MS = 5000;

export interface Proc {
  pid: number;
  ppid: number;
  pgid: number;
  uid: number;
  /** When it started, as `/proc/<pid>/stat` or `ps -o lstart` tells it: with the pid, which process this is. */
  start: string;
  /** Its arguments, where they're known one by one (`/proc`); null with `ps`, which only gives `cmd`. */
  argv: string[] | null;
  /** Its command line, its arguments joined with spaces. */
  cmd: string;
  /** Its executable (`/proc/<pid>/exe`), if it can be read. */
  exe: string | null;
  /** Its working directory, read when it's needed (see `cwd`). */
  cwd?: string | null;
}

/** What belongs to a task, and what must be left alone. */
export interface Scope {
  /** The task's temp folder, as the board names it and by its real path (see `variants`); none to go by the worktrees alone. */
  tmp: string[];
  /** The task's worktrees (one for a task; a temp folder may be shared by tasks whose ids start alike). */
  worktrees: string[];
  /** The board's data dir: its server and its runs' shims are never stopped. */
  data_dir: string;
  /** The folder all of the board's tasks' temp folders are in: a server whose data dir is in another task's isn't this task's. */
  tmp_root: string | null;
}

/** All of this user's processes, or null if they can't be listed. */
export async function list(): Promise<Proc[] | null> {
  try {
    return process.platform === "linux" ? await list_proc() : await list_ps();
  } catch (e) {
    console.warn(`listing processes: ${err_str(e)}`);
    return null;
  }
}

/** One process from `/proc`, or null if it's gone or isn't this user's. */
export async function read_proc(pid: number): Promise<Proc | null> {
  const d = `/proc/${pid}`;
  try {
    const uid = (await stat(d)).uid;
    if (uid !== process.geteuid!()) return null;
    const statf = await readFile(`${d}/stat`, "utf8");
    // `pid (comm) state ppid pgrp …`: comm may hold spaces and parentheses, so fields are counted from the last ')'.
    const f = statf.slice(statf.lastIndexOf(")") + 2).split(" ");
    const raw = await readFile(`${d}/cmdline`);
    if (!raw.length) return null; // a kernel thread or a zombie
    const argv = raw.toString("utf8").replace(/\0$/, "").split("\0");
    let exe: string | null = null;
    try {
      exe = (await readlink(`${d}/exe`)).replace(/ \(deleted\)$/, "");
    } catch {}
    return { pid, ppid: Number(f[1]), pgid: Number(f[2]), uid, start: f[19], argv, cmd: argv.join(" "), exe };
  } catch {
    return null;
  }
}

async function list_proc(): Promise<Proc[]> {
  const pids = (await readdir("/proc")).filter((n) => /^\d+$/.test(n)).map(Number);
  const out: Proc[] = [];
  for (const pid of pids) {
    const p = await read_proc(pid);
    if (p) out.push(p);
  }
  return out;
}

/** `ps`'s fixed-width `lstart` (`Thu Nov  5 10:00:00 2026`) comes before the command line, which may hold anything. */
const PS_LINE = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S{3} \S{3} [ \d]\d \d\d:\d\d:\d\d \d{4})\s(.*)$/;

/** Processes from `ps` (macOS, or anywhere without `/proc`). Exported to be tested on Linux. */
export async function list_ps(): Promise<Proc[]> {
  const o = await run_cmd("ps", ["-axww", "-o", "pid=,ppid=,pgid=,uid=,lstart=,command="], { env: { ...process.env, LC_ALL: "C" }, timeout: 20_000 });
  if (!o.success) throw new Error(`ps: ${o.stderr.trim() || `exit ${o.code}`}`);
  const me = process.geteuid!();
  const out: Proc[] = [];
  for (const line of o.stdout.split("\n")) {
    const m = PS_LINE.exec(line);
    if (!m || Number(m[4]) !== me) continue;
    const cmd = m[6].trim();
    out.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), uid: me, start: m[5], argv: null, cmd, exe: null });
  }
  return out;
}

/** `p`'s working directory: `/proc/<pid>/cwd`, or `lsof` without `/proc`. */
export async function cwd(p: Proc): Promise<string | null> {
  if (p.cwd !== undefined) return p.cwd;
  p.cwd = null;
  if (process.platform === "linux") {
    try {
      p.cwd = await readlink(`/proc/${p.pid}/cwd`);
    } catch {}
  } else {
    const o = await run_cmd("lsof", ["-a", "-p", String(p.pid), "-d", "cwd", "-Fn"], { timeout: 10_000 }).catch(() => null);
    const n = o?.stdout.split("\n").find((l) => l.startsWith("n"));
    if (n) p.cwd = n.slice(1);
  }
  return p.cwd;
}

/** A path and, if it resolves to another, its real path: a process may name a folder either way. */
export function variants(p: string): string[] {
  const out = [trim(p)];
  try {
    const real = trim(realpathSync(p));
    if (!out.includes(real)) out.push(real);
  } catch {}
  return out;
}

function trim(p: string): string {
  let s = p.replace(/\/+/g, "/");
  while (s.length > 1 && s.endsWith("/")) s = s.slice(0, -1);
  return s;
}

/** Whether path `p` is `base` or inside it, for any of `bases` (by whole components). */
function within(p: string, bases: string[]): boolean {
  const a = trim(p);
  return bases.some((b) => a === b || a.startsWith(b === "/" ? "/" : `${b}/`));
}

/** Whether the joined command line `cmd` names a path in one of `bases` (a path in it may hold spaces, so it's searched). */
function names(cmd: string, bases: string[]): boolean {
  return bases.some((b) => cmd.startsWith(`${b}/`) || cmd.includes(` ${b}/`) || cmd.includes(`=${b}/`));
}

/** The words of `p`'s command line up to `serve`, if it's a huntaway server (`…/huntaway serve`, `…/main.ts serve`). */
function server_words(p: Proc): string[] | null {
  const words = p.argv ?? p.cmd.split(" ");
  const i = words.indexOf("serve");
  if (i < 1 || !words.slice(0, i).some((w) => /^(huntaway|issue-agent|main\.[jt]s)$/.test(basename(w)))) return null;
  if (!words.slice(i + 1).some((w) => w === "--data-dir" || w.startsWith("--data-dir="))) return null;
  return words.slice(0, i);
}

/** A server's `--data-dir`, absolute (resolved from its working directory if it isn't). */
async function data_dir_of(p: Proc): Promise<string | null> {
  let d: string | null = null;
  if (p.argv) {
    const i = p.argv.findIndex((w) => w === "--data-dir" || w.startsWith("--data-dir="));
    if (i >= 0) d = p.argv[i].startsWith("--data-dir=") ? p.argv[i].slice("--data-dir=".length) : (p.argv[i + 1] ?? null);
  } else {
    // Up to the next option: test-server.sh puts `--name` after it.
    d = / --data-dir[= ](.+?)(?= --?[A-Za-z]|$)/.exec(p.cmd)?.[1] ?? null;
  }
  if (!d) return null;
  if (isAbsolute(d)) return trim(d);
  const c = await cwd(p);
  return c ? resolve(c, d) : null;
}

/** An ia-shim's executable and run folder (`…/ia-shim <run dir> -- <agent…>`). */
function shim_of(p: Proc): { exe: string; run: string } | null {
  if (p.argv) {
    const i = p.argv.findIndex((w) => basename(w) === "ia-shim");
    return i >= 0 && i < 2 && p.argv[i + 1] ? { exe: p.argv[i], run: p.argv[i + 1] } : null;
  }
  const m = /^(.*?\/?ia-shim) (.+?) -- /.exec(p.cmd);
  return m ? { exe: m[1], run: m[2] } : null;
}

/** `p`'s ancestors' pids, by the parents in `procs`. */
function ancestors(pid: number, by_pid: Map<number, Proc>): Set<number> {
  const out = new Set<number>();
  for (let p = by_pid.get(pid); p && !out.has(p.ppid) && p.ppid > 1; p = by_pid.get(p.ppid)) out.add(p.ppid);
  return out;
}

/** The processes of `procs` that belong to the task `s` describes (see the top of this file), servers first. */
export async function find(procs: Proc[], s: Scope): Promise<Proc[]> {
  const tmp = [...new Set(s.tmp.flatMap(variants))];
  const wts = s.worktrees.flatMap(variants);
  const board = variants(s.data_dir);
  const board_runs = board.map((d) => join(d, "runs"));
  const roots = s.tmp_root ? variants(s.tmp_root) : [];
  const by_pid = new Map(procs.map((p) => [p.pid, p]));
  // Never this server, or what started it.
  const keep = ancestors(process.pid, by_pid);
  keep.add(process.pid);
  const candidates = procs.filter((p) => !keep.has(p.pid));

  const servers: Proc[] = [];
  const data_dirs: string[] = [];
  for (const p of candidates) {
    const words = server_words(p);
    if (!words) continue;
    const d = await data_dir_of(p);
    if (!d || variants(d).some((v) => board.includes(v))) continue;
    let ours = tmp.length > 0 && within(d, tmp);
    // Started from the worktree, with its data somewhere other than another task's temp folder.
    if (!ours && wts.length && !(roots.length && within(d, roots))) {
      const c = await cwd(p);
      const exe_in = (p.exe !== null && within(p.exe, wts)) || words.some((w) => within(c && !isAbsolute(w) ? resolve(c, w) : w, wts));
      ours = exe_in || names(words.join(" "), wts) || (c !== null && within(c, wts));
    }
    if (ours) {
      servers.push(p);
      data_dirs.push(...variants(d));
    }
  }

  const shims: Proc[] = [];
  for (const p of candidates) {
    const sh = shim_of(p);
    if (!sh || within(sh.run, board_runs)) continue;
    const r = sh.run;
    // One of the worktree's builds, running a run that isn't another task's.
    const built = wts.length > 0 && (within(sh.exe, wts) || (p.exe !== null && within(p.exe, wts))) && !(roots.length && within(r, roots));
    if (within(r, data_dirs) || (tmp.length && within(r, tmp)) || built) shims.push(p);
  }

  // What the servers started, and the shims' agents with their process groups.
  const picked = new Set([...servers, ...shims].map((p) => p.pid));
  const agents = new Set<number>();
  for (const p of candidates) if (picked.has(p.ppid) && shims.some((sh) => sh.pid === p.ppid)) agents.add(p.pgid === p.pid ? p.pgid : p.pid);
  const under: Proc[] = [];
  for (const p of candidates) {
    if (picked.has(p.pid)) continue;
    const up = ancestors(p.pid, by_pid);
    const from_server = servers.some((sv) => up.has(sv.pid));
    const from_agent = agents.has(p.pgid) || [...shims].some((sh) => up.has(sh.pid));
    if (from_server || from_agent) under.push(p);
  }
  return [...servers, ...under, ...shims];
}

/** Stop `procs` by pid: TERM, then KILL those still there after `grace` ms that are still the same processes. */
export async function stop(procs: Proc[], grace = GRACE_MS): Promise<void> {
  const signal = (p: Proc, sig: NodeJS.Signals) => {
    try {
      process.kill(p.pid, sig);
    } catch {}
  };
  for (const p of procs) signal(p, "SIGTERM");
  const since = Date.now();
  let left = procs;
  for (;;) {
    left = await running(left);
    if (!left.length) return;
    if (Date.now() - since >= grace) break;
    await sleep(100);
  }
  for (const p of left) signal(p, "SIGKILL");
}

/** Those of `procs` that are still running as the same processes (not new ones given their pids), by when they started. */
async function running(procs: Proc[]): Promise<Proc[]> {
  if (process.platform === "linux") {
    // A zombie's cmdline is empty, so it reads as gone.
    const now = await Promise.all(procs.map((p) => read_proc(p.pid)));
    return procs.filter((p, i) => now[i]?.start === p.start);
  }
  const now = new Map((await list_ps().catch((): Proc[] => [])).map((q) => [q.pid, q.start] as const));
  return procs.filter((p) => now.get(p.pid) === p.start);
}

/** The task folders (named as `task_tmp.folder` names them) in `roots` that servers and shims in `procs` name. */
export function folders_in(procs: Proc[], roots: string[]): Set<string> {
  const out = new Set<string>();
  for (const p of procs) {
    if (!server_words(p) && !shim_of(p)) continue;
    for (const r of roots) {
      const re = new RegExp(`${r.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/([0-9a-f]{12})(?=/| |$)`, "g");
      for (const m of p.cmd.matchAll(re)) out.add(m[1]);
    }
  }
  return out;
}

/**
 * Stop the processes that belong to the task `s` describes (see the top of this file), of `procs` (else all of them),
 * and return them. `what` says why, in the log.
 */
export async function stop_task(s: Scope, what: string, procs?: Proc[]): Promise<Proc[]> {
  const all = procs ?? (await list());
  if (!all) return [];
  const found = await find(all, s);
  if (!found.length) return [];
  for (const p of found) console.log(`${what}: stopping pid ${p.pid}, left running by the task: ${p.cmd.slice(0, 300)}`);
  await stop(found);
  return found;
}
