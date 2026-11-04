// Port of server/src/update/admin.rs: rebuild-and-restart from the server's own source checkout, so changes merged to
// the branch it runs from can be picked up from the UI.
//
// Thin in the TypeScript server: what the server reports (`status`, `updates_from`, the commit `--update-from`'s
// deployment runs) is ported, and so is the bundle a hub sends a linked host, but this process can't replace itself
// (Node has no exec), so restarting, rebuilding and updating from a hub answer with an error.
import { readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ApiError } from "../http.ts";
import type { AppState } from "../state.ts";
import { err_str, now, path_str } from "../util.ts";
import * as worktree from "../git/worktree.ts";
import * as release from "./release.ts";
import type { Config } from "./release.ts";

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

/** What the TypeScript server says when asked to restart. */
export const NO_RESTART = "restarting isn't supported by the TypeScript server; restart it by hand";

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
 * The commit a server without a checkout runs: what its deployment says (`IA_COMMIT`). (Rust release builds also
 * know the commit they were built from, which this server never is.)
 */
export function bundle_commit(from_app: boolean): string | null {
  return pick_bundle_commit(null, process.env.IA_COMMIT ?? null, from_app);
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
  if (state.meta.source_dir === null) return void console.error("--update-from needs a source checkout to update; ignoring it");
  console.error(`following the commit deployed at ${url}`);
  const check = () => check_deployed(state, url).catch((e) => console.error(`checking ${url}: ${err_str(e)}`));
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
    console.error(`checking ${url} for updates: ${err_str(e)}`);
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

/**
 * Start a restart in the background. With `rebuild`, the UI and server are rebuilt first. Not in the TypeScript
 * server: it can't replace itself.
 */
export function start(state: AppState, rebuild: boolean) {
  if (rebuild && state.meta.source_dir === null) throw ApiError.bad("source checkout not found; start the server with --source-dir");
  throw ApiError.bad(NO_RESTART);
}

/**
 * Start a restart job that runs `job` in the background, unless one is running. `job` only returns on failure, which
 * the job then shows (the restart log has whatever it logged). Release updates use it too (see update/release.ts).
 */
export function begin(state: AppState, job: (s: AppState) => Promise<void>) {
  if (state.restart && job_active(state.restart)) throw ApiError.conflict("a restart is already in progress");
  state.restart = { phase: "starting", log: "", error: null };
  job(state).then(
    () => {},
    (e) => {
      const msg = err_str(e);
      console.error(`restart failed: ${msg}`);
      set_phase(state, "failed", msg);
    },
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

/**
 * Replace this process with `exe`, in the `restarting` phase. Only returns on failure, which here it always is: Node
 * can't exec.
 */
export async function restart_into(_state: AppState, _exe: string, _env: Array<[string, string]>): Promise<Error> {
  return new Error(NO_RESTART);
}

/**
 * Reap the children this process inherited from the server it replaced. A TypeScript server never replaces another
 * process (it can't exec), and Node can't wait on a process it didn't start, so there's nothing to do.
 */
export function reap_inherited() {}

// ---------- updating from a hub ----------

/** The source checkout's current branch and commit, packed as a git bundle (base64), for a linked host to update from. */
export async function bundle(state: AppState): Promise<any> {
  const src = state.meta.source_dir;
  if (src === null) throw ApiError.bad("this hub has no source checkout to share");
  const b = await worktree.git(src, ["symbolic-ref", "--short", "HEAD"]);
  if (!b.ok) throw ApiError.bad("the hub's checkout isn't on a branch");
  const branch = b.stdout.trim();
  const commit = await head_commit(src);
  if (commit === null) throw ApiError.bad("can't read the hub's commit");
  const path = join(state.data_dir, "outgoing.bundle");
  const o = await worktree.git(src, ["bundle", "create", path_str(path), branch]);
  if (!o.ok) throw ApiError.bad(`git bundle failed: ${o.stderr.trim()}`);
  const bytes = readFileSync(path);
  rmSync(path, { force: true });
  return { branch, commit, bundle: bytes.toString("base64") };
}

/** Fast-forward this host's checkout to a hub's bundle, then rebuild and restart: not in the TypeScript server. */
export async function update_from_bundle(state: AppState, _branch: string, _commit: string, _bundle_b64: string): Promise<any> {
  if (state.meta.source_dir === null) throw ApiError.bad("this host isn't running from a source checkout; update it by hand");
  throw ApiError.bad(NO_RESTART);
}

/** Fast-forward this host's checkout to `commit`, then rebuild and restart: not in the TypeScript server. */
export async function update_from_origin(state: AppState, commit: string): Promise<any> {
  if (state.meta.source_dir === null) throw ApiError.bad("this host isn't running from a source checkout; update it by hand");
  if (state.meta.running_commit === commit) return { ok: true, up_to_date: true };
  throw ApiError.bad(NO_RESTART);
}
