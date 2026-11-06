// Port of server/src/update/admin.rs: rebuild-and-restart from the server's own source checkout, so changes merged to
// the branch it runs from can be picked up from the UI.
//
// The Rust server restarts by exec'ing (itself again, a rebuilt binary, or a release), which keeps its process id, its
// arguments and its environment. Node can't exec, so `bin/huntaway` supervises `node` for `serve` and does it for this
// server: `exec` writes what to run to the file the wrapper named (`IA_RESTART_FILE`) and exits with `EXEC_CODE`, and the
// wrapper, whose process id is the server's, execs that. See bin/huntaway.
import { BUILD_COMMIT } from "../hosts/proto.ts";
import { spawn } from "node:child_process";
import { accessSync, constants as fs_constants, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { writeFile, rm } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { ApiError } from "../http.ts";
import { default_exe, type AppState } from "../state.ts";
import { err_str, home_dir, new_id, now, path_str, reached, sleep, truncate } from "../util.ts";
import * as worktree from "../git/worktree.ts";
import * as release from "./release.ts";
import * as db_file from "../db/file.ts";
import type { Config } from "./release.ts";

const log = {
  info: (m: string) => console.error(`${new Date().toISOString()}  INFO huntaway::update::admin: ${m}`),
  warn: (m: string) => console.error(`${new Date().toISOString()}  WARN huntaway::update::admin: ${m}`),
  error: (m: string) => console.error(`${new Date().toISOString()} ERROR huntaway::update::admin: ${m}`),
};

/** Facts about this server process, captured at startup. */
export interface ServerMeta {
  boot_id: string;
  started_at: string;
  /** Repository root containing `server/` and `app/`, if known. */
  source_dir: string | null;
  /** HEAD of the source checkout when this process started. */
  running_commit: string | null;
  /** `--update-from`: a deployment of the board whose commit this host offers to update to. */
  update_from: string | null;
  /** `--release-updates`: the GitHub repository whose releases this server updates from (see update/release.ts). */
  release: Config | null;
  /** Arguments to re-exec with. */
  args: string[];
}

/** What a restart says it's doing, for the UI (`GET /admin/server`'s `restart`). */
export interface RestartJob {
  phase: string;
  log: string;
  error: string | null;
}

/** What `--update-from`'s deployment reported when last checked. */
export interface Deployed {
  /** The commit it runs (kept from an earlier check while it can't be reached). */
  commit: string | null;
  checked_at: string;
  error: string | null;
}

/**
 * How this server updates when a hub asks it to (API 89): `checkout` (fast-forward and rebuild its source checkout),
 * `releases` (installed from a release, with `--release-updates`: restart onto a newer release), or none.
 */
export function updates_from(meta: ServerMeta): "checkout" | "releases" | null {
  if (meta.source_dir !== null) return "checkout";
  if (meta.release !== null) return "releases";
  return null;
}

function job_active(j: RestartJob): boolean {
  return j.phase !== "failed";
}

const is_file = (p: string) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/** `--source-dir`, or the checkout this server runs from (`<root>/server-ts/src/update/admin.ts`). */
export function detect_source_dir(explicit: string | null): string | null {
  const root = explicit ?? join(dirname(fileURLToPath(import.meta.url)), "../../..");
  let real: string;
  try {
    real = realpathSync(root);
  } catch {
    return null;
  }
  return is_file(join(real, "server/Cargo.toml")) && is_file(join(real, "app/package.json")) ? real : null;
}

/**
 * The commit a server without a checkout runs: the one it was built from (`IA_BUILD_COMMIT` when it was compiled, which
 * release builds set; the TypeScript server is never built), else what its deployment says (`IA_COMMIT`). A release it
 * updated to, in `app/`, inherits the deployment's environment, so there `IA_COMMIT` is the deployed bundle's commit
 * rather than its own.
 */
export function bundle_commit(from_app: boolean): string | null {
  return pick_bundle_commit(BUILD_COMMIT, process.env.IA_COMMIT ?? null, from_app);
}

export function pick_bundle_commit(built: string | null, deployed: string | null, from_app: boolean): string | null {
  const clean = (c: string | null) => (c !== null && c.trim() ? c.trim() : null);
  return clean(built) ?? (from_app ? null : clean(deployed));
}

export async function head_commit(dir: string): Promise<string | null> {
  try {
    const o = await worktree.git(dir, ["rev-parse", "HEAD"]);
    return o.ok ? o.stdout.trim() : null;
  } catch {
    return null;
  }
}

export async function status(state: AppState): Promise<any> {
  const meta = state.meta;
  const v: any = {
    boot_id: meta.boot_id,
    started_at: meta.started_at,
    source_dir: meta.source_dir,
    running_commit: meta.running_commit,
    running_agents: state.runs.size,
    restart: state.restart,
  };
  // API 108: with the new database file (see db/file.ts), which file the database is in, and whether an older build has
  // changed the one it was copied from.
  const database = db_file.current(state.data_dir, state.db());
  if (database !== null) v.database = db_file.status_json(database);
  // API 88: with --release-updates, the release this server could update to.
  const rel = release.status(state);
  if (rel !== null) v.release = rel;
  const src = meta.source_dir;
  if (src === null) return v;
  const deployed = state.deployed;
  const head = await head_commit(src);
  const branch = await worktree.git(src, ["symbolic-ref", "--short", "HEAD"]).then((o) => (o.ok ? o.stdout.trim() : null), () => null);
  const dirty = await worktree.git(src, ["status", "--porcelain", "--untracked-files=no"]).then((o) => o.stdout.trim() !== "", () => false);
  let new_commits: string[] = [];
  if (meta.running_commit !== null && head !== null && meta.running_commit !== head) {
    const o = await worktree.git(src, ["log", "--format=%h %s", "-n", "30", `${meta.running_commit}..${head}`]);
    new_commits = lines(o.stdout);
  }
  v.source_commit = head;
  v.source_branch = branch;
  v.dirty = dirty;
  v.new_commits = new_commits;
  // API 65: what the deployment this host follows runs, and its commits that this server doesn't (only when it's
  // ahead: not for a checkout that has moved on or diverged from it).
  if (meta.update_from !== null) {
    let deployed_commits: string[] = [];
    const running = meta.running_commit, commit = deployed?.commit ?? null;
    if (running !== null && commit !== null && running !== commit && (await worktree.git(src, ["merge-base", "--is-ancestor", running, commit])).ok) {
      const o = await worktree.git(src, ["log", "--format=%h %s", "-n", "30", `${running}..${commit}`]);
      deployed_commits = lines(o.stdout);
    }
    v.update_from = meta.update_from;
    v.deployed = deployed;
    v.deployed_commits = deployed_commits;
  }
  return v;
}

/** Rust's `str::lines`. */
const lines = (s: string) => (s === "" ? [] : s.replace(/\n$/, "").split("\n"));

const DEPLOYED_EVERY = 5 * 60_000;

/**
 * With `--update-from`, check every few minutes which commit that deployment runs, and fetch it from origin, so
 * `status` can list its commits and the UI offer to update to it.
 */
export function start_update_check(state: AppState) {
  const url = state.meta.update_from;
  if (url === null) return;
  if (state.meta.source_dir === null) return void log.warn("--update-from needs a source checkout to update; ignoring it");
  log.info(`following the commit deployed at ${url}`);
  const check = () => check_deployed(state, url).catch((e) => log.warn(`checking ${url}: ${err_str(e)}`));
  check();
  setInterval(check, DEPLOYED_EVERY).unref();
}

/**
 * Ask `url` which commit it runs (its unauthenticated `/api/health`, API 65+) and make sure the source checkout has
 * it, then record the result in `state.deployed`.
 */
export async function check_deployed(state: AppState, url: string) {
  const previous = state.deployed;
  let deployed: Deployed;
  try {
    const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`HTTP status ${res.status} for url (${url}/api/health)`);
    const health: any = await res.json();
    const c = typeof health?.commit === "string" ? health.commit.trim() : "";
    if (!c) throw new Error(`${url} doesn't say which commit it runs (it needs API 65, and IA_COMMIT without a checkout)`);
    const src = state.meta.source_dir;
    if (src === null) throw new Error("no source checkout");
    if (state.meta.running_commit !== c && !(await has_commit(src, c))) {
      let timer: NodeJS.Timeout | undefined;
      const fetched = await Promise.race([
        worktree.git(src, ["fetch", "--quiet", "origin"]),
        new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error("git fetch origin timed out")), 120_000))),
      ]).finally(() => clearTimeout(timer));
      if (!fetched.ok) throw new Error(`git fetch origin failed: ${fetched.stderr.trim()}`);
      if (!(await has_commit(src, c))) throw new Error(`${url} runs ${c.slice(0, 7)}, which isn't on this checkout's origin`);
    }
    deployed = { commit: c, checked_at: now(), error: null };
  } catch (e) {
    log.warn(`checking ${url} for updates: ${err_str(e)}`);
    deployed = { commit: previous?.commit ?? null, checked_at: now(), error: err_str(e) };
  }
  state.deployed = deployed;
}

async function has_commit(dir: string, commit: string): Promise<boolean> {
  try {
    return (await worktree.git(dir, ["cat-file", "-e", `${commit}^{commit}`])).ok;
  } catch {
    return false;
  }
}

/** Start a restart in the background. With `rebuild`, the UI and server are rebuilt first and the restart is abandoned if either build fails. */
export function start(state: AppState, rebuild: boolean) {
  if (rebuild && state.meta.source_dir === null) throw ApiError.bad("source checkout not found; start the server with --source-dir");
  begin(state, (st) => run(st, rebuild));
}

/**
 * Copy the older builds' database into this build's again and restart onto it (see db/file.ts), as a restart job. Only
 * when an older build has changed it since it was copied: that discards what's been done since in this one.
 */
export function recopy_database(state: AppState) {
  const st = db_file.current(state.data_dir, state.db());
  if (st === null) throw ApiError.bad(`this server doesn't use ${db_file.FILE}, so there's nothing to copy again`);
  const older = st.older_changed;
  if (older === null) throw ApiError.bad("the older builds' database hasn't changed since it was copied");
  begin(state, async (s) => {
    log_line(s, `copying ${older} into ${st.file} again as the server restarts`);
    db_file.request_recopy(s.data_dir);
    await run(s, false);
  });
}

/**
 * Start a restart job that runs `job` in the background, unless one is running. `job` only returns on failure, which the
 * job then shows (the restart log has whatever it logged). Release updates use it too (see update/release.ts), with the
 * phases `downloading`, `verifying` and `installing` before `restarting`.
 */
export function begin(state: AppState, job: (s: AppState) => Promise<void>) {
  if (state.restart && job_active(state.restart)) throw ApiError.conflict("a restart is already in progress");
  state.restart = { phase: "starting", log: "", error: null };
  // Started on the next tick, as tokio::spawn's task would be: the request that began it is answered first.
  setImmediate(() =>
    job(state).then(
      () => {},
      (e) => {
        const msg = err_str(e);
        log.error(`restart failed: ${msg}`);
        set_phase(state, "failed", msg);
      },
    ),
  );
}

export function set_phase(state: AppState, phase: string, error: string | null) {
  if (state.restart) {
    state.restart.phase = phase;
    state.restart.error = error;
  }
  state.emit({ type: "restart", phase, error });
}

export function log_line(state: AppState, line: string) {
  const job = state.restart;
  if (job) {
    job.log += `${line}\n`;
    // Keep the tail; build logs can be long.
    if (job.log.length > 200_000) job.log = job.log.slice(job.log.length - 150_000);
  }
  state.emit({ type: "restart_log", line });
}

/** The environment build steps run in: this process's, with ~/.cargo/bin on PATH. */
function build_env(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // Servers launched from a desktop session may not have ~/.cargo/bin on PATH.
  const home = home_dir();
  if (home !== null) {
    const cargo_bin = join(home, ".cargo/bin");
    const paths = (env.PATH ?? "").split(delimiter).filter((p) => p !== "");
    if (is_dir(cargo_bin) && !paths.includes(cargo_bin)) env.PATH = [...paths, cargo_bin].join(delimiter);
  }
  return env;
}

/**
 * Whether a rebuild builds ia-shim with cargo: unless there's no cargo on `path` and `ts_dir` (server-ts) has a prebuilt
 * one in `bin/`, from a release (scripts/install.sh puts it there on a machine without Rust). The shim seldom changes.
 */
export function builds_shim(path: string | undefined, ts_dir: string): boolean {
  const cargo = (path ?? "").split(delimiter).some((d) => d !== "" && is_file(join(d, "cargo")));
  return cargo || !is_file(join(ts_dir, "bin/ia-shim"));
}

/** Run a build step, streaming stdout and stderr into the restart log. */
async function step(state: AppState, dir: string, program: string, args: string[]) {
  log_line(state, `$ ${program} ${args.join(" ")}`);
  const env = build_env();
  const child = spawn(program, args, { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] });
  const lines = (stream: NodeJS.ReadableStream) =>
    new Promise<void>((done) => {
      const rl = createInterface({ input: stream, crlfDelay: Infinity });
      rl.on("line", (l) => log_line(state, l));
      rl.on("close", () => done());
    });
  const exited = new Promise<[number | null, NodeJS.Signals | null]>((ok, fail) => {
    child.once("error", (e) => fail(new Error(`failed to run ${program}`, { cause: e })));
    child.once("close", (code, signal) => ok([code, signal]));
  });
  await Promise.all([lines(child.stdout!), lines(child.stderr!)]);
  const [code, signal] = await exited;
  if (code !== 0) throw new Error(`\`${program} ${args.join(" ")}\` failed with ${signal ? `signal: ${signal}` : `exit status: ${code}`}`);
}

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
    return null;
  }
};

/**
 * Whether `npm ci` has to run in `dir` (server-ts): its lockfile is newer than the one npm keeps of what it installed
 * (`node_modules/.package-lock.json`), as after a pull that changed it, or nothing is installed.
 */
export function lockfile_changed(dir: string): boolean {
  const lock = mtime(join(dir, "package-lock.json"));
  const installed = mtime(join(dir, "node_modules/.package-lock.json"));
  return lock !== null && (installed === null || lock > installed);
}

async function run(state: AppState, rebuild: boolean) {
  let exe = state.exe;
  if (rebuild) {
    const src = state.meta.source_dir;
    if (src === null) throw new Error("source checkout not found");
    set_phase(state, "building_ui", null);
    // --no-save, so the build never rewrites the tracked package-lock.json: a hub's Update refuses a checkout with
    // uncommitted changes, so that would stop the next one.
    await step(state, join(src, "app"), "npm", ["install", "--no-save", "--no-audit", "--no-fund"]);
    await step(state, join(src, "app"), "npm", ["run", "build"]);
    set_phase(state, "building_server", null);
    // The TypeScript server runs from its sources: what it builds is its dependencies, when its lockfile changed, and the
    // Rust ia-shim its agents run under (see agent/runs.ts's shim_path).
    const ts = join(src, "server-ts");
    if (lockfile_changed(ts)) await step(state, ts, "npm", ["ci", "--no-audit", "--no-fund"]);
    if (builds_shim(build_env().PATH, ts)) await step(state, join(src, "server"), "cargo", ["build", "--release", "-p", "ia-shim"]);
    else log_line(state, "no cargo on PATH: using the prebuilt ia-shim in server-ts/bin/");
    exe = join(ts, "bin/huntaway");
  }
  throw await restart_into(state, exe, []);
}

/**
 * Replace this process with `exe`, run with this one's arguments and environment (and `env` on top), in the
 * `restarting` phase. Only returns on failure.
 */
export async function restart_into(state: AppState, exe: string, env: Array<[string, string]>): Promise<Error> {
  // Agents keep running under ia-shim; the new process resumes following them.
  set_phase(state, "restarting", null);
  // Give the websocket a moment to deliver the final events.
  await sleep(300);
  log.info(`re-executing ${exe}`);
  return exec(exe, restart_args(state.meta.args), env);
}

/**
 * The serve flags that ask the start they're given to for something once (copying the database again, see db/file.ts).
 * A restart leaves them out: an older build that Roll back starts wouldn't know the flag and would exit, and a newer one
 * would do it again. Their environment variable, `IA_RECOPY_DB`, is only given to the first server `bin/huntaway` starts.
 */
const ONE_SHOT_ARGS = ["--recopy-db"];

/** This server's arguments, for a restart: without `ONE_SHOT_ARGS`. */
export function restart_args(args: string[]): string[] {
  return args.filter((a) => !ONE_SHOT_ARGS.includes(a));
}

/** The exit code with which this server asks `bin/huntaway` to exec what it wrote to its restart file. */
export const EXEC_CODE = 75;

/** `bin/huntaway`'s restart file, and its process id, when it started this server (see `take_supervisor`). */
let supervisor: { file: string; pid: number } | null = null;

/**
 * Take `bin/huntaway`'s `IA_RESTART_FILE` and `IA_SUPERVISOR_PID` out of the environment, so that nothing this server
 * starts sees them, and keep them when they're this process's parent's. Call first thing in `serve`.
 */
export function take_supervisor() {
  const file = process.env.IA_RESTART_FILE, pid = Number(process.env.IA_SUPERVISOR_PID);
  delete process.env.IA_RESTART_FILE;
  delete process.env.IA_SUPERVISOR_PID;
  supervisor = file && pid > 1 && process.ppid === pid ? { file, pid } : null;
}

/**
 * Tell `bin/huntaway` that the server is up (it's listening, and has told the desktop app so), by writing `started`
 * beside its restart file. From then on, the wrapper starts the server again if it crashes; one that exits before then
 * (a port in use, say) isn't started again, so whatever started it sees the failure at once.
 */
export function supervisor_started() {
  if (supervisor === null) return;
  try {
    writeFileSync(join(dirname(supervisor.file), "started"), `${process.pid}\n`);
  } catch (e) {
    log.warn(`telling bin/huntaway the server is up: ${err_str(e)}`);
  }
}

/** Whether this server can exec (`bin/huntaway` started it). */
export function can_exec(): boolean {
  return supervisor !== null;
}

/** Call `gone` once `bin/huntaway` has gone (killed with SIGKILL, say), so this server doesn't outlive its process id. */
export function watch_supervisor(gone: () => void) {
  const sup = supervisor;
  if (sup === null) return;
  const timer = setInterval(() => {
    if (process.ppid !== sup.pid) {
      clearInterval(timer);
      log.warn(`bin/huntaway (${sup.pid}) has gone; shutting down`);
      gone();
    }
  }, 1000);
  timer.unref();
}

/** The path this server runs as (Rust's `current_exe`): `bin/huntaway`. */
export function current_exe(): string {
  return default_exe();
}

/** An argument for `sh`, single-quoted. */
const sh_quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

/**
 * Replace this process with `exe`. Only returns on failure. `bin/huntaway` does it: this writes what to run to its
 * restart file and exits with `EXEC_CODE`, and the wrapper execs it, as the same process.
 *
 * Tests can see what would have been exec'd at `reached("exec")` (and the environment it would have added in
 * `exec_env`); a test isn't run by `bin/huntaway`, so then it fails.
 */
export function exec(exe: string, args: string[], env: Array<[string, string]>): Error {
  EXEC_ENV = env.map(([k, v]) => [k, v]);
  EXEC_ARGS = [...args];
  reached("exec");
  if (supervisor === null) return new Error(`failed to exec ${exe}: not started by bin/huntaway, which execs for this server`);
  try {
    accessSync(exe, fs_constants.X_OK);
    if (!statSync(exe).isFile()) throw new Error("Permission denied (os error 13)");
  } catch (e) {
    return new Error(`failed to exec ${exe}: ${truncate(err_str(e), 500)}`);
  }
  const bad = env.find(([k]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k));
  if (bad) return new Error(`failed to exec ${exe}: ${JSON.stringify(bad[0])} isn't a variable name`);
  const script = [`next=${sh_quote(exe)}`, `set -- ${args.map(sh_quote).join(" ")}`, ...env.map(([k, v]) => `${k}=${sh_quote(v)}; export ${k}`)].join("\n");
  const tmp = `${supervisor.file}.${new_id()}.tmp`;
  try {
    writeFileSync(tmp, `${script}\n`, { mode: 0o600 });
    renameSync(tmp, supervisor.file);
  } catch (e) {
    rmSync(tmp, { force: true });
    return new Error(`failed to exec ${exe}: writing ${supervisor.file}: ${truncate(err_str(e), 500)}`);
  }
  process.exit(EXEC_CODE);
}

let EXEC_ENV: Array<[string, string]> | null = null;
let EXEC_ARGS: string[] | null = null;

/** Tests: the arguments of the last exec (see `exec`). */
export function exec_args(): string[] | null {
  return EXEC_ARGS;
}

/** Tests: the environment the last exec would have added (see `exec`). */
export function exec_env(): Array<[string, string]> | null {
  return EXEC_ENV;
}

// ---------- updating from a hub ----------

/**
 * The source checkout's current branch and commit, packed as a git bundle (base64), for a linked host to update from.
 * With `since`, the commit the host runs, it holds only the commits after that one when it's an ancestor of the branch:
 * the whole branch is several MB, more than a host takes in a request body (2 MB, before the TypeScript server's
 * `/admin/update` took more), and the host has the rest.
 */
export async function bundle(state: AppState, since: string | null = null): Promise<any> {
  const src = state.meta.source_dir;
  if (src === null) throw ApiError.bad("this hub has no source checkout to share");
  const b = await worktree.git(src, ["symbolic-ref", "--short", "HEAD"]);
  if (!b.ok) throw ApiError.bad("the hub's checkout isn't on a branch");
  const branch = b.stdout.trim();
  const commit = await head_commit(src);
  if (commit === null) throw ApiError.bad("can't read the hub's commit");
  const path = join(state.data_dir, "outgoing.bundle");
  const revs = [branch];
  // Not one the branch is at (git won't make an empty bundle), and not a commit this checkout lacks or has elsewhere.
  if (since !== null && /^[0-9a-f]{40}$/.test(since) && since !== commit && (await worktree.git(src, ["merge-base", "--is-ancestor", since, commit])).ok) {
    revs.push(`^${since}`);
  }
  const o = await worktree.git(src, ["bundle", "create", path_str(path), ...revs]);
  if (!o.ok) throw ApiError.bad(`git bundle failed: ${o.stderr.trim()}`);
  const bytes = readFileSync(path);
  rmSync(path, { force: true });
  return { branch, commit, bundle: bytes.toString("base64") };
}

/** Fast-forward this host's checkout to a hub's bundle, then rebuild and restart. */
export async function update_from_bundle(state: AppState, branch: string, commit: string, bundle_b64: string): Promise<any> {
  const src = state.meta.source_dir;
  if (src === null) throw ApiError.bad("this host isn't running from a source checkout; update it by hand");
  const current = (await worktree.git(src, ["symbolic-ref", "--short", "HEAD"])).stdout.trim();
  if (current !== branch) throw ApiError.conflict(`this host's checkout is on ${current}, the hub's on ${branch}`);
  if ((await head_commit(src)) === commit && state.meta.running_commit === commit) return { ok: true, up_to_date: true };
  const dirty = await worktree.git(src, ["status", "--porcelain", "--untracked-files=no"]);
  if (dirty.stdout.trim() !== "") throw ApiError.conflict("this host's checkout has uncommitted changes");
  const b64 = bundle_b64.trim();
  if (b64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) throw ApiError.bad("bad bundle: Invalid input");
  const bytes = Buffer.from(b64, "base64");
  const path = join(state.data_dir, "incoming.bundle");
  await writeFile(path, bytes);
  const refspec = `refs/heads/${branch}:refs/remotes/hub/${branch}`;
  const fetched = await worktree.git(src, ["fetch", "--quiet", path_str(path), refspec]);
  await rm(path, { force: true });
  if (!fetched.ok) throw ApiError.bad(`fetching the hub's bundle failed: ${fetched.stderr.trim()}`);
  const merged = await worktree.git(src, ["merge", "--ff-only", commit]);
  if (!merged.ok) throw ApiError.conflict(`can't fast-forward to the hub's ${branch}: ${merged.stderr.trim()}`);
  start(state, true);
  return { ok: true, commit };
}

/**
 * Fast-forward this host's checkout to `commit`, fetched from its own `origin`, then rebuild and restart. Only follows
 * the checkout's own branch: the commit must be on its upstream.
 */
export async function update_from_origin(state: AppState, commit: string): Promise<any> {
  const src = state.meta.source_dir;
  if (src === null) throw ApiError.bad("this host isn't running from a source checkout; update it by hand");
  if (state.meta.running_commit === commit) return { ok: true, up_to_date: true };
  const b = await worktree.git(src, ["symbolic-ref", "--short", "HEAD"]);
  if (!b.ok) throw ApiError.conflict("this host's checkout isn't on a branch");
  const branch = b.stdout.trim();
  const dirty = await worktree.git(src, ["status", "--porcelain", "--untracked-files=no"]);
  if (dirty.stdout.trim() !== "") throw ApiError.conflict("this host's checkout has uncommitted changes");
  const fetched = await worktree.git(src, ["fetch", "--quiet", "origin"]);
  if (!fetched.ok) throw ApiError.bad(`git fetch origin failed: ${fetched.stderr.trim()}`);
  const upstream = `origin/${branch}`;
  if (!(await worktree.git(src, ["merge-base", "--is-ancestor", commit, upstream])).ok) {
    throw ApiError.conflict(`${commit.slice(0, 7)} isn't on ${upstream}; push it, or update this host by hand`);
  }
  if ((await head_commit(src)) !== commit) {
    const merged = await worktree.git(src, ["merge", "--ff-only", commit]);
    if (!merged.ok) throw ApiError.conflict(`can't fast-forward ${branch}: ${merged.stderr.trim()}`);
  }
  start(state, true);
  return { ok: true, commit };
}
