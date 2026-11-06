// Port of server/src/git/worktree/remove.rs.
/** Removing a task's worktree: `teardown`, and removing it once its work is merged (`remove_if_merged`, `remove_merged`). */
import { existsSync, statSync } from "node:fs";
import { lstat } from "node:fs/promises";
import { basename } from "node:path";
import * as db from "../../db.ts";
import type { Project, Task } from "../../db.ts";
import * as runner from "../../agent/runner.ts";
import * as leftovers from "../../agent/leftovers.ts";
import * as task_tmp from "../../agent/task_tmp.ts";
import * as checkpoints from "../checkpoints.ts";
import * as terminal from "../../hosts/terminal.ts";
import type { AppState } from "../../state.ts";
import { context, err_str, path_str, remove_dir_all_async, truncate } from "../../util.ts";
import {
  canonicalize,
  fetch,
  fetch_upstream,
  gh_json,
  git,
  git_env,
  git_ok,
  keep_starts,
  load,
  locked,
  output,
  path_starts_with,
  run_script,
  same_path,
  SCRIPT_LIMIT,
  script_env,
  upstream,
  upstream_name,
  type RawOutput,
} from "../worktree.ts";

/**
 * Whether `wt` may be removed by hand when git won't remove it as a worktree: a folder inside the project's worktrees
 * folder that isn't the repository (or another main checkout), so a stray folder there, or a misconfigured worktrees
 * folder, can't cost work kept elsewhere.
 */
export async function removable_by_hand(project: Project, repo: string, wt: string): Promise<boolean> {
  const canon = (p: string) => canonicalize(p) ?? p;
  const root = canon(project.worktrees_root),
    wt_c = canon(wt),
    repo_c = canon(repo);
  if (!path_starts_with(wt_c, root) || same_path(wt_c, root) || same_path(wt_c, repo_c)) return false;
  // A main checkout's git dir is its own `.git`; a linked worktree's is under the repository's.
  try {
    const o = await git(wt_c, ["rev-parse", "--absolute-git-dir"]);
    if (o.ok) return basename(o.stdout.trim()) !== ".git";
  } catch {}
  return true;
}

/**
 * What in worktree `wt` isn't committed (`git status --porcelain`, trimmed), whatever the repository's settings hide:
 * every untracked file, every submodule change, and changes to tracked files marked assume-unchanged or skip-worktree.
 * Ignored files don't count.
 */
export async function uncommitted(wt: string): Promise<string> {
  const status = await git_ok(wt, ["status", "--porcelain", "--untracked-files=all", "--ignore-submodules=none"]);
  const lines: string[] = status
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  // git status skips marked files, so they're compared with the index here: content and, with core.fileMode (git's
  // default), the executable bit. One that isn't on disk (left out of a sparse checkout, say) has nothing to lose. File
  // names are bytes, which needn't be UTF-8.
  const index = await git_bytes(wt, ["ls-files", "-v", "-s", "-z"]);
  let file_mode = true;
  try {
    file_mode = (await git(wt, ["config", "--type=bool", "core.fileMode"])).stdout.trim() !== "false";
  } catch {}
  for (const entry of split_nul(index)) {
    // "<tag> <mode> <object> <stage>\t<path>"; a lowercase tag is assume-unchanged, S skip-worktree.
    const tab = entry.indexOf(0x09);
    if (tab < 0) continue;
    const meta = entry.subarray(0, tab).toString(),
      path = entry.subarray(tab + 1);
    const [tag, mode, object] = meta.split(" ");
    if (tag === undefined || mode === undefined || object === undefined) continue;
    const assumed = [...tag].every((c) => c >= "a" && c <= "z");
    if (!(assumed || tag === "S")) continue;
    let file;
    try {
      file = await lstat(Buffer.concat([Buffer.from(wt + "/"), path]));
    } catch (e) {
      if (e.code === "ENOENT") continue;
      throw context(`checking ${path.toString()}`, e);
    }
    // Only a regular file is compared; anything else counts as changed.
    const executable = (file.mode & 0o100) !== 0;
    const same =
      file.isFile() && ["100644", "100755"].includes(mode) && (!file_mode || executable === (mode === "100755")) && (await hash_object(wt, path)) === object;
    if (!same) {
      const mark = assumed ? "assume-unchanged" : "skip-worktree";
      lines.push(` M ${path.toString()} (marked ${mark})`);
    }
  }
  return lines.join("\n");
}

/** The object id git would give file `path` (bytes, relative to `wt`), read through `--stdin-paths` so it needn't be UTF-8. */
async function hash_object(wt: string, path: Buffer): Promise<string> {
  const out = await git_output_input(wt, ["hash-object", "--stdin-paths"], Buffer.concat([path, Buffer.from("\n")]));
  if (!out.success) throw new Error(`git hash-object -- ${path.toString()} failed: ${out.stderr.toString().trim()}`);
  return out.stdout.toString().trim();
}

/** The parts of a NUL-separated list, without empty ones at the end. */
export function split_nul(b: Buffer): Buffer[] {
  const out: Buffer[] = [];
  let start = 0;
  for (let i = 0; i <= b.length; i++) {
    if (i === b.length || b[i] === 0) {
      out.push(b.subarray(start, i));
      start = i + 1;
    }
  }
  return out;
}

async function git_output_input(dir: string, args: string[], input?: Buffer): Promise<RawOutput> {
  try {
    return await output("git", ["-C", dir, ...args], { env: git_env(), input });
  } catch (e) {
    throw context("failed to run git", e);
  }
}

/** Run git in `dir`, whether it succeeds or not, with its output as bytes (for file names, which needn't be UTF-8). */
export async function git_output(dir: string, args: string[]): Promise<RawOutput> {
  return git_output_input(dir, args);
}

/** Run git in `dir`, returning what it prints as bytes (for file names, which needn't be UTF-8). */
export async function git_bytes(dir: string, args: string[]): Promise<Buffer> {
  const out = await git_output(dir, args);
  if (!out.success) throw new Error(`git ${args.join(" ")} failed: ${out.stderr.toString().trim()}`);
  return out.stdout;
}

/** Run the teardown script and remove the worktree. Refuses when the worktree has uncommitted changes unless `force` is set. */
export async function teardown(state: AppState, task_id: string, force: boolean, delete_branch: boolean): Promise<Task> {
  const [task, project] = load(state, task_id);
  const repo = project.repo_path;
  const wt = task.worktree_path;
  if (wt == null) throw new Error("task has no worktree");
  const branch = task.branch ?? "";
  // The tasks stacked on it keep where they took its branch up to before it's gone.
  await keep_starts(state, task_id);

  if (existsSync(wt)) {
    if (!force) {
      let status: string;
      try {
        status = await uncommitted(wt);
      } catch (e) {
        throw context("checking the worktree for uncommitted changes", e);
      }
      if (status) throw new Error(`worktree has uncommitted changes:\n${truncate(status.trim(), 2000)}`);
    }
    state.update_task(task_id, [["worktree_state", "tearing_down"]]);
    // Its terminal would be left in a deleted directory.
    await terminal.kill_all(state, task_id);
    // And the test servers its agents started from it, which would run on with their build gone.
    try {
      const scope = { tmp: [task_tmp.dir(state, task)], worktrees: [wt], data_dir: state.data_dir, tmp_root: task_tmp.root(state) };
      await leftovers.stop_task(scope, `task ${task_id}`);
    } catch (e) {
      state.add_event(task_id, "warn", "Couldn't stop what the task left running", err_str(e));
    }
    if (project.teardown_script.trim()) {
      try {
        const log = await run_script(project.teardown_script, wt, script_env(project, task, wt, branch), SCRIPT_LIMIT);
        state.add_event(task_id, "info", "Teardown script finished", truncate(log, 20000));
      } catch (e) {
        if (force) state.add_event(task_id, "warn", "Teardown script failed (continuing)", err_str(e));
        else {
          state.update_task(task_id, [["worktree_state", "ready"]]);
          throw e;
        }
      }
    }
    const wt_s = path_str(wt);
    if (force) {
      const o = await git(repo, ["worktree", "remove", "--force", wt_s]);
      if (!o.ok && existsSync(wt)) {
        if (await removable_by_hand(project, repo, wt)) await remove_dir_all_async(wt).catch(() => {});
        else {
          const text = `Left ${wt} in place: git won't remove it as a worktree (${o.stderr.trim()}) and it isn't in the project's worktrees folder`;
          state.add_event(task_id, "warn", text, null);
        }
      }
    } else {
      // What the teardown script left would be lost too, so it's checked again, and git's own check (without --force)
      // has the last word.
      let kept: Error | null = null;
      try {
        let left: string;
        try {
          left = await uncommitted(wt);
        } catch (e) {
          throw context("checking the worktree for uncommitted changes", e);
        }
        if (!left) {
          const o = await git(repo, ["worktree", "remove", wt_s]);
          if (!(o.ok || !existsSync(wt))) kept = new Error(`git worktree remove failed: ${o.stderr.trim()}`);
        } else kept = new Error(`the teardown script left uncommitted changes:\n${truncate(left, 2000)}`);
      } catch (e) {
        kept = e;
      }
      if (kept) {
        state.update_task(task_id, [["worktree_state", "ready"]]);
        throw kept;
      }
    }
  }
  await git(repo, ["worktree", "prune"]).catch(() => {});
  // Its checkpoints are of files that are gone now (or were already), and the next run takes a new baseline. Not before:
  // a teardown that keeps the worktree keeps them too.
  await checkpoints.forget(state, task_id, repo);
  const fields: Array<[string, any]> = [
    ["worktree_state", "none"],
    ["worktree_path", null],
    ["worktree_error", null],
  ];
  if (delete_branch && branch) {
    const o = await git(repo, ["branch", "-D", branch]);
    if (o.ok) {
      fields.push(["branch", null]);
      state.add_event(task_id, "info", `Deleted branch ${branch}`, null);
    } else state.add_event(task_id, "warn", `Could not delete branch ${branch}`, o.stderr);
  }
  state.add_event(task_id, "info", "Worktree removed", null);
  return state.update_task(task_id, fields)!;
}

/** Whether an agent is working in the task's worktree: its own, or one of its reviewers, whose threads run there too. */
export function agent_in_worktree(state: AppState, task_id: string): boolean {
  let reviews: Task[] | null = null;
  try {
    reviews = db.review_threads(state.db(), task_id);
  } catch {}
  return state.is_running(task_id) || (reviews !== null && reviews.some((r) => r.running || state.is_running(r.id)));
}

/**
 * What `remove_if_merged` did with a done task's worktree: `{Removed: into}` (its work is merged into this: a branch, or
 * a pull request's base and URL), or `{Kept: why}`, as serde writes the enum.
 */
export type Removal = { Removed: string } | { Kept: string };

/**
 * Remove a done task's worktree if its work is merged and nothing in it would be lost: its HEAD is in its base branch
 * (here or upstream) or is the head of its merged pull request, and it has no uncommitted or untracked files (ignored
 * ones, such as build output, don't count). The task and its branch are kept; if its agent runs again, the worktree is
 * set up again in the same folder. With `fetch`, the base branch's upstream is fetched first.
 */
export async function remove_if_merged(state: AppState, task_id: string, do_fetch: boolean): Promise<Removal> {
  const kept = (why: string): Removal => ({ Kept: why });
  return locked(task_id, async () => {
    const [task, project] = load(state, task_id);
    const busy = () => agent_in_worktree(state, task_id);
    if (task.kind !== "task" || task.status !== "done") return kept("it isn't done");
    const wt = task.worktree_path;
    if (wt == null || task.worktree_state !== "ready" || !is_dir(wt)) return kept("it has no worktree");
    if (task.running || busy()) return kept("an agent is working in it");
    // A subproject's worktree is where its tasks get merged; it stays while any are open (other than scratch tasks,
    // which only read it).
    if (task.subproject && db.subproject_tasks(state.db(), task_id).some((t) => t.status !== "done" && !db.is_scratch(t))) {
      return kept("the subproject still has open tasks");
    }
    const repo = project.repo_path;
    const base = db.task_base(state.db(), task, project);
    if (base == null) return kept("it has no base branch to be merged into");
    const status = await uncommitted(wt);
    if (status) {
      const n = status.split("\n").length;
      return kept(`it has ${n} uncommitted or untracked file${n === 1 ? "" : "s"}`);
    }
    const head = (await git_ok(wt, ["rev-parse", "--verify", "HEAD"])).trim();
    const account = runner.task_github_account(state, task) ?? null;
    let gh_env: { ok: any } | { err: unknown };
    try {
      gh_env = { ok: await runner.task_gh_env(state, task) };
    } catch (e) {
      gh_env = { err: e };
    }
    try {
      let found = await merged_into(repo, wt, base, task.branch ?? null, head, do_fetch, account, gh_env);
      // One stacked on another task's branch may have gone into the project's base branch with it, or after it (its pull
      // request retargeted there); its own pull request was asked about already.
      const stacked = task.start_from?.type === "task" || task.start_from?.type === "pull_request";
      const main = project.base_branch;
      if (found === null && stacked && main && main !== base) found = await merged_into(repo, wt, main, null, head, do_fetch, account, gh_env);
      if (found === null) return kept(`its work isn't merged into ${base}`);
      // Started meanwhile (fetching takes a while)?
      if (busy()) return kept("an agent is working in it");
      const branch = task.branch != null ? `The task and branch ${task.branch} are` : "The task is";
      state.add_event(
        task_id,
        "info",
        `Removing the worktree: its work is merged into ${found} and nothing in it is uncommitted. ${branch} kept; the worktree is set up again if the agent runs again.`,
        null,
      );
      // Not forced, so teardown checks again just before removing it.
      await teardown(state, task_id, false, false);
      return { Removed: found };
    } finally {
      if ("ok" in gh_env) gh_env.ok?.drop();
    }
  });
}

function is_dir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Where `head` (the HEAD of a task's worktree `wt`) has been merged: `base`, its upstream (fetched first with
 * `do_fetch`), or the base of `branch`'s merged pull request (squashed or rebased) whose head it is (looked up with gh,
 * with `gh_env`, see runner.task_gh_env; not when that failed, rather than as another account).
 */
async function merged_into(
  repo: string,
  wt: string,
  base: string,
  branch: string | null,
  head: string,
  do_fetch: boolean,
  account: string | null,
  gh_env: { ok: any } | { err: unknown },
): Promise<string | null> {
  const contains = async (rev: string) => {
    try {
      return (await git(repo, ["merge-base", "--is-ancestor", head, rev])).ok;
    } catch {
      return false;
    }
  };
  if (await contains(`refs/heads/${base}`)) return base;
  const up = await upstream(repo, base);
  if (up) {
    if (do_fetch) await fetch(repo, up, account).catch(() => {});
    if (await contains(up.tracking)) return upstream_name(up);
  }
  if (!("ok" in gh_env) || branch === null) return null;
  const pr = await gh_json(wt, ["pr", "view", branch, "--json", "state,headRefOid,baseRefName,url"], gh_env.ok);
  if (pr == null || !(pr.state === "MERGED" && pr.headRefOid === head)) return null;
  return typeof pr.url === "string" && typeof pr.baseRefName === "string" ? `${pr.baseRefName} (${pr.url})` : base;
}

/**
 * Remove the worktrees of a project's done tasks that are merged and have nothing uncommitted (see `remove_if_merged`),
 * one at a time, fetching each base branch's upstream once first. Returns what happened to each done task that had a
 * worktree.
 */
export async function remove_merged(state: AppState, project_id: string): Promise<any[]> {
  const c = state.db();
  const project = db.get_project(c, project_id);
  if (!project) throw new Error("project not found");
  const tasks = db
    .list_tasks_for_project(c, project_id, "task")
    .filter((t) => t.status === "done" && t.worktree_state === "ready")
    .sort((a, b) => a.number - b.number);
  const repo = project.repo_path;
  const bases = [...new Set(tasks.map((t) => db.task_base(state.db(), t, project)).filter((b): b is string => b != null))].sort();
  const profile = db.get_profile(state.db(), project.profile_id);
  if (!profile) throw new Error("profile not found");
  const account = runner.github_account(project, profile) ?? null;
  for (const base of bases) {
    try {
      await fetch_upstream(repo, base, account);
    } catch (e) {
      console.warn(`project ${project_id}: couldn't fetch ${base}'s upstream: ${err_str(e)}`);
    }
  }
  const results: any[] = [];
  for (const t of tasks) {
    let removed: boolean, detail: string;
    try {
      const r = await remove_if_merged(state, t.id, false);
      if ("Removed" in r) [removed, detail] = [true, `merged into ${r.Removed}`];
      else [removed, detail] = [false, r.Kept];
    } catch (e) {
      [removed, detail] = [false, err_str(e)];
    }
    results.push({ task_id: t.id, number: t.number, title: t.title, removed, detail });
  }
  return results;
}
