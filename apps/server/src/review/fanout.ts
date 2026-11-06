// Port of server/src/review/fanout.rs.
/**
 * Tasks made together from one prompt, each run by another agent (a fan-out, API 61; see api::CreateTask::fanout_id).
 * The board's compare view shows them side by side (API 81): `GET /tasks/{id}/fanout` has what it can't read off the
 * tasks themselves (how long each one's agent ran, what's uncommitted in its worktree, its branch), and
 * `POST /tasks/{id}/fanout/pick` keeps that task and completes the others as not done, removing their worktrees, and
 * their branches and pull requests if asked to. Nothing uncommitted is lost unless `discard_uncommitted` says so: a
 * worktree with uncommitted changes is kept otherwise.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import * as db from "../db.ts";
import type { Task } from "../db.ts";
import * as api from "../api.ts";
import * as extract from "../api/extract.ts";
import * as runner from "../agent/runner.ts";
import * as worktree from "../git/worktree.ts";
import * as gh_mcp from "../mcp/gh_mcp.ts";
import * as permissions from "../mcp/permissions.ts";
import { ApiError, AsyncMutex, type AppState } from "../state.ts";
import type { Req } from "../http.ts";
import { err_str, expand_tilde, IN_TEST, now, sleep } from "../util.ts";

/** The most of a worktree's uncommitted changes listed. */
const LISTED = 20;

/** How long the agents of a task that wasn't picked have to stop before it's left as it is (ms; shorter in tests). */
const STOP_WAIT = IN_TEST ? 2_000 : 20_000;

/** How long deleting a pushed branch, or closing a pull request, may take (ms). */
const REMOTE_TIMEOUT = 60_000;

/** What the compare view shows of a task besides the task itself. */
export interface Facts {
  id: string;
  /** How long its agent has run, all of its runs together (one still going, up to now), and how many runs. */
  run_secs: number;
  runs: number;
  /** Its agent, or one of its reviewers, is at work. */
  working: boolean;
  /** Its worktree's uncommitted changes, as `git status --porcelain` lists them (the first `LISTED`), and how many. */
  uncommitted: string[];
  uncommitted_count: number;
  /** Why its worktree couldn't be checked for them. */
  uncommitted_error: string | null;
  /**
   * Commits in its worktree that no branch, remote branch or tag has (a detached HEAD's): only the worktree has them,
   * so it's kept when picking.
   */
  stray_commits: number;
  /** Its branch, if the repository has it, and its upstream (`origin/ia/x-1`) if it's been pushed. */
  branch: string | null;
  pushed: string | null;
}

/**
 * The tasks made from the same prompt as `t`, it among them, in the order they were made. Only its own profile's: a
 * fanout id is only a label, which a task elsewhere could have too.
 */
function siblings(s: AppState, t: Task): Task[] {
  const f = t.kind === "task" ? (t.fanout_id ?? null) : null;
  if (f == null) throw ApiError.bad("the task wasn't made from one prompt with others");
  return db.fanout_tasks(s.db(), t.profile_id, f);
}

function key(s: AppState, t: Task): string {
  return `${runner.task_key_prefix(s, t)}-${t.number}`;
}

function repo_of(s: AppState, t: Task): string | null {
  if (t.project_id == null) return null;
  let project;
  try {
    project = db.get_project(s.db(), t.project_id);
  } catch {
    return null;
  }
  return project ? expand_tilde(project.repo_path) : null;
}

/** `worktree::git`, or null if git couldn't be run. */
async function git(dir: string, args: string[]) {
  try {
    return await worktree.git(dir, args);
  } catch {
    return null;
  }
}

/** The task's branch, if the repository has it. */
async function branch_of(repo: string | null, t: Task): Promise<string | null> {
  const branch = t.branch ? t.branch : null;
  if (repo == null || branch == null) return null;
  const o = await git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
  return o?.ok ? branch : null;
}

/**
 * Where a branch is pushed: its upstream's remote and branch there, and its short name (`origin/ia/x-1`), if the
 * repository has a copy of it (it was pushed, and not deleted there since it was last fetched).
 */
interface Pushed {
  remote: string;
  remote_ref: string;
  short: string;
}

async function pushed(repo: string, branch: string): Promise<Pushed | null> {
  const format = "--format=%(upstream:remotename)%00%(upstream:remoteref)%00%(upstream)%00%(upstream:short)";
  const o = await git(repo, ["for-each-ref", format, `refs/heads/${branch}`]);
  if (!o) return null;
  const line = o.stdout.split("\n")[0];
  if (line === undefined || (line === "" && o.stdout === "")) return null;
  const fields = line.replace(/\r$/, "").split("\0");
  if (fields.length !== 4) return null;
  const [remote, remote_ref, tracking, short] = fields;
  if (remote === "" || !remote_ref.startsWith("refs/heads/") || tracking === "") return null;
  const there = await git(repo, ["rev-parse", "--verify", "--quiet", tracking]);
  return there?.ok ? { remote, remote_ref, short } : null;
}

export async function facts(s: AppState, t: Task): Promise<Facts> {
  const [run_secs, runs] = db.run_time(s.db(), t.id, now());
  const repo = repo_of(s, t);
  const branch = await branch_of(repo, t);
  const up = repo != null && branch != null ? ((await pushed(repo, branch))?.short ?? null) : null;
  let uncommitted: string[] = [];
  let uncommitted_error: string | null = null;
  let stray_commits = 0;
  const wt = t.worktree_path ?? null;
  if (wt != null && t.worktree_state === "ready" && existsSync(wt)) {
    try {
      const status: string = await worktree.uncommitted(wt);
      uncommitted = status.split("\n").filter((l) => l.trim() !== "").map((l) => l.replace(/\r$/, ""));
    } catch (e) {
      uncommitted_error = err_str(e);
    }
    stray_commits = await stray(wt).catch(() => 0);
  }
  const uncommitted_count = uncommitted.length;
  uncommitted = uncommitted.slice(0, LISTED);
  const working = worktree.agent_in_worktree(s, t.id);
  return { id: t.id, run_secs, runs, working, uncommitted, uncommitted_count, uncommitted_error, stray_commits, branch, pushed: up };
}

/**
 * How many commits a worktree's HEAD has that no branch, remote branch or tag has: a detached HEAD's, which nothing but
 * the worktree keeps (they'd be garbage once it's gone).
 */
async function stray(wt: string): Promise<number> {
  const o = await worktree.git(wt, ["rev-list", "--count", "HEAD", "--not", "--branches", "--remotes", "--tags"]);
  if (!o.ok) throw new Error(`git rev-list failed: ${o.stderr.trim()}`);
  const t = o.stdout.trim();
  if (!/^\d+$/.test(t)) throw new Error("invalid digit found in string");
  return Number(t);
}

/** `GET /tasks/{id}/fanout`: `{tasks: [Facts]}` for the tasks made from the same prompt as this one, it among them. */
export async function get(s: AppState, r: Req): Promise<any> {
  const t = db.get_task(s.db(), r.params.id);
  if (!t) throw ApiError.not_found("task");
  const out: Facts[] = [];
  for (const sibling of siblings(s, t)) out.push(await facts(s, sibling));
  return { tasks: out };
}

/** What to do with the tasks that aren't picked, besides completing them as not done and removing their worktrees. */
export interface Pick {
  /** Delete their branches, and the copies pushed of them (unless a pull request that's kept open has them). */
  delete_branches: boolean;
  /** Close their pull requests. */
  close_prs: boolean;
  /** Remove their worktrees even with uncommitted changes in them, which are lost. Otherwise those worktrees are kept. */
  discard_uncommitted: boolean;
}

export function Pick_default(): Pick {
  return { delete_branches: false, close_prs: false, discard_uncommitted: false };
}

/** A request's body as a `Pick`, refused as axum's `Json` extractor refuses one that isn't. */
function Pick_from_body(r: Req): Pick {
  const b = extract.json_map(r);
  return {
    delete_branches: extract.def_bool(b, "delete_branches"),
    close_prs: extract.def_bool(b, "close_prs"),
    discard_uncommitted: extract.def_bool(b, "discard_uncommitted"),
  };
}

/** What picking did with a task that wasn't picked. */
export interface Outcome {
  id: string;
  key: string;
  /** Its agent (or a reviewer) was at work, and was stopped. */
  stopped: boolean;
  /** Completed as not done now (rather than done already). */
  completed: boolean;
  /**
   * What became of its worktree, branch, pushed branch and pull request: `removed` or `deleted` or `closed`, `kept`, or
   * `none` when it had none.
   */
  worktree: string;
  branch: string;
  pushed_branch: string;
  pr: string;
  /** What didn't go as asked, and why. */
  notes: string[];
}

/**
 * `POST /tasks/{id}/fanout/pick` (`Pick`): keeps the task, and completes the others made from the same prompt as not
 * done, cleaning up after them. `{task, results: [Outcome]}`, the picked task as it is now and one result for each of
 * the others.
 */
export async function pick(s: AppState, r: Req): Promise<any> {
  return pick_inner(s, r.params.id, Pick_from_body(r));
}

/** One pick at a time, so two at once (of two of them) can't complete them all as not done. */
let PICKING: AsyncMutex | null = null;

export async function pick_inner(s: AppState, id: string, b: Pick): Promise<any> {
  const release = await (PICKING ??= new AsyncMutex()).lock();
  try {
    const t = db.get_task(s.db(), id);
    if (!t) throw ApiError.not_found("task");
    const picked = key(s, t);
    if (t.status === "done" && t.resolution === "not_done") {
      throw ApiError.conflict(`${picked} was completed as not done: move it out of Done to pick it`);
    }
    const others = siblings(s, t).filter((o) => o.id !== t.id);
    if (!others.length) throw ApiError.bad("there are no other tasks from the same prompt");
    const results: Outcome[] = [];
    for (const o of others) results.push(await retire(s, o, picked, b));
    const keys = results.map((r) => r.key);
    s.add_event(t.id, "info", `Picked over ${keys.join(", ")}, made from the same prompt`);
    const task = db.get_task(s.db(), id);
    if (!task) throw ApiError.not_found("task");
    return { task, results };
  } finally {
    release();
  }
}

/** Until the task's agents (its own and its reviewers') have stopped, for `STOP_WAIT` at most: whether they have. */
async function stopped(s: AppState, id: string): Promise<boolean> {
  const until = Date.now() + STOP_WAIT;
  for (;;) {
    let reviews: Task[] = [];
    try {
      reviews = db.review_threads(s.db(), id);
    } catch {}
    // The run's end is written to the task (its column, `running`) after the run is marked exited: until then the
    // runner could put it back in a column after it's been completed.
    const marked = (t: string) => {
      try {
        return db.get_task(s.db(), t)?.running ?? false;
      } catch {
        return true;
      }
    };
    const active_run = (t: string) => {
      try {
        return db.has_active_run(s.db(), t);
      } catch {
        return true;
      }
    };
    const active = (t: string) => s.is_running(t) || active_run(t) || marked(t);
    if (!active(id) && !reviews.some((r) => active(r.id))) return true;
    if (Date.now() >= until) return false;
    await sleep(200);
  }
}

/** Completes task `o`, which wasn't picked (`picked` was), as not done and cleans up after it as `b` asks. */
async function retire(s: AppState, o: Task, picked: string, b: Pick): Promise<Outcome> {
  const out: Outcome = { id: o.id, key: key(s, o), stopped: false, completed: false, worktree: "", branch: "", pushed_branch: "", pr: "", notes: [] };
  const why = `${picked}, made from the same prompt, was picked`;
  // Its agents first: one at work would carry on in a worktree that's going.
  let reviews: Task[] = [];
  try {
    reviews = db.review_threads(s.db(), o.id);
  } catch {}
  for (const id of [o.id, ...reviews.map((r) => r.id)]) {
    out.stopped = runner.abort(s, id) || out.stopped;
    permissions.expire_for_task(s, id);
  }
  if (out.stopped) s.add_event(o.id, "warn", `Stopped: ${why}`);
  const repo = repo_of(s, o);
  const had = (v: boolean) => (v ? "kept" : "none");
  [out.worktree, out.branch, out.pushed_branch, out.pr] = [had(o.worktree_path != null), had(o.branch != null), "none", had(o.pr_url != null)];
  let fresh: Task | null = null;
  if (await stopped(s, o.id)) {
    try {
      fresh = db.get_task(s.db(), o.id);
    } catch {}
  }
  if (!fresh) {
    out.notes.push("Its agent didn't stop in time, so it was left as it is");
    return out;
  }
  o = fresh;
  if (o.status !== "done") {
    try {
      await api.update_task_inner(s, o.id, { status: "done", resolution: "not_done" });
      out.completed = true;
      s.add_event(o.id, "info", `Completed as not done: ${why}`);
    } catch (e) {
      out.notes.push(`Couldn't complete it as not done: ${err_str(e)}`);
    }
  }

  out.pr = had(o.pr_url != null);
  const url = b.close_prs ? (o.pr_url ?? null) : null;
  if (url != null) {
    const failed = await close_pr(s, o, repo, url);
    if (failed == null) {
      out.pr = "closed";
      s.add_event(o.id, "info", `Closed pull request ${url}`);
    } else {
      out.notes.push(`Couldn't close its pull request ${url}: ${failed}`);
    }
  }

  const branch = await branch_of(repo, o);
  const up = repo != null && branch != null ? await pushed(repo, branch) : null;
  [out.branch, out.pushed_branch, out.worktree] = [had(branch != null), had(up != null), had(o.worktree_path != null)];
  // The worktree first, keeping the branch: the branch goes once its pushed copy has (or there's none), so that what
  // can't be done now (a pull request kept open, a push that fails) can be done by picking again.
  const wt = o.worktree_path ?? null;
  if (wt != null) {
    let strays: number | null = null;
    let stray_error: unknown = null;
    try {
      strays = existsSync(wt) ? await stray(wt) : 0;
    } catch (e) {
      stray_error = e;
    }
    if (strays === 0) {
      try {
        await worktree.teardown(s, o.id, b.discard_uncommitted, false);
        out.worktree = "removed";
      } catch (e) {
        out.notes.push(`Kept its worktree: ${err_str(e)}`);
      }
    } else if (strays != null) {
      out.notes.push(`Kept its worktree: it has ${strays} commit${strays === 1 ? "" : "s"} on no branch (a detached HEAD), which would be lost`);
    } else {
      out.notes.push(`Kept its worktree: couldn't check it for commits on no branch: ${err_str(stray_error)}`);
    }
  }
  if (repo == null || !b.delete_branches || branch == null) return out;
  const br = branch;
  if (out.worktree === "kept") {
    out.notes.push("Kept its branch, as its worktree is kept");
    return out;
  }
  if (up) {
    if (out.pr === "kept") {
      // Deleting a pull request's branch closes it.
      out.notes.push(`Kept its branch and the pushed copy ${up.short}: its pull request is still open`);
      return out;
    }
    let failed: string | null;
    try {
      const g = await with_timeout(worktree.git(repo, ["push", up.remote, "--delete", up.remote_ref]), REMOTE_TIMEOUT);
      failed = g == null ? "git push timed out" : g.ok ? null : g.stderr.trim();
    } catch (e) {
      failed = err_str(e);
    }
    if (failed != null) {
      out.notes.push(`Kept its branch, as its pushed copy ${up.short} couldn't be deleted: ${failed}`);
      return out;
    }
    out.pushed_branch = "deleted";
    s.add_event(o.id, "info", `Deleted the pushed branch ${up.short}`);
  }
  try {
    const g = await worktree.git(repo, ["branch", "-D", br]);
    if (g.ok) {
      out.branch = "deleted";
      s.add_event(o.id, "info", `Deleted branch ${br}`);
      try {
        s.update_task(o.id, [["branch", null]]);
      } catch (e) {
        console.warn(`task ${o.id}: couldn't clear the deleted branch: ${err_str(e)}`);
      }
    } else {
      out.notes.push(`Couldn't delete its branch ${br}: ${g.stderr.trim()}`);
    }
  } catch (e) {
    out.notes.push(`Couldn't delete its branch ${br}: ${err_str(e)}`);
  }
  return out;
}

/** `p`'s value, or null if it takes longer than `ms`. */
async function with_timeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<null>((r) => (timer = setTimeout(() => r(null), ms)));
  try {
    return await Promise.race([p, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** Closes pull request `url` with gh, as the task's GitHub account (gh's active one when it has none). Null, or what went wrong. */
async function close_pr(s: AppState, t: Task, repo: string | null, url: string): Promise<string | null> {
  let env: any;
  try {
    env = await runner.task_gh_env(s, t);
  } catch (e) {
    return err_str(e);
  }
  const args = ["pr", "close", url];
  const vars: NodeJS.ProcessEnv = { ...process.env };
  if (env) {
    try {
      env.check(args, null);
    } catch (e) {
      return err_str(e);
    }
    env.apply(vars);
  }
  Object.assign(vars, { GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1" });
  return await new Promise<string | null>((resolve) => {
    let stderr = "";
    let done = false;
    const finish = (v: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(v);
    };
    const child = spawn(gh_mcp.gh_program(), args, { cwd: repo ?? undefined, env: vars, stdio: ["ignore", "ignore", "pipe"] });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish("gh timed out");
    }, REMOTE_TIMEOUT);
    child.stderr!.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (e) => finish(`couldn't run gh: ${e.message}`));
    child.on("close", (code) => finish(code === 0 ? null : strip_gh(stderr.trim())));
  });
}

/** gh's error without its `gh: ` prefixes. */
function strip_gh(s: string): string {
  while (s.startsWith("gh: ")) s = s.slice(4);
  return s;
}
