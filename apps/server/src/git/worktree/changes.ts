// Port of server/src/git/worktree/changes.rs.
/** A task's changes: what they're compared with (`changes_base`, its start ref) and `diff`. */
import { existsSync } from "node:fs";
import * as db from "../../db.ts";
import type { Project, Task } from "../../db.ts";
import type { AppState } from "../../state.ts";
import { path_str, truncate } from "../../util.ts";
import { commit, compare_ref, git, git_bytes, git_output, is_ancestor, is_git_repo, load } from "../worktree.ts";

/** Hooks for tests (Rust's `testing::reached` points): `diff_read` runs as a diff starts reading a folder's changes. */
export const changes_testing = {
  diff_read: null as (() => void) | null,
};

/** Where a task's changes are: its worktree once it's ready, else the project's repository. */
export function changes_dir(state: AppState, task_id: string): [string, Task, Project] {
  const [task, project] = load(state, task_id);
  const dir = task.worktree_path != null && task.worktree_state === "ready" ? task.worktree_path : project.repo_path;
  return [dir, task, project];
}

/**
 * Where a task that started from elsewhere (see db.StartFrom) started, kept in its repository so its changes can be told
 * from what it started on whatever happens to that (a branch deleted once merged, say): the commit its branch was made
 * at, moved on to the branch it's stacked on as the task takes in more of that (see `changes_base`). It goes with the task.
 */
export function start_ref(task_id: string): string {
  return `refs/huntaway/start/${task_id}`;
}

/** Drop a deleted task's start ref (see `start_ref`) from `repo`, if it has one. */
export async function forget_start(repo: string, task_id: string): Promise<void> {
  await git(repo, ["update-ref", "-d", start_ref(task_id)]).catch(() => {});
}

/** The output of `git merge-base a b` in `dir`, if it has one. */
async function merge_base(dir: string, a: string, b: string): Promise<string | null> {
  try {
    const o = await git(dir, ["merge-base", a, b]);
    return o.ok ? o.stdout.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Move task `task`'s start ref (see `start_ref`) on to as much of the branch it's stacked on as the task's work at `head`
 * in `dir` has taken in (that branch may have more since), while that branch is there, so what it took in of it later
 * isn't counted as its own either, even once it's gone.
 */
async function keep_start(dir: string, task: Task, head: string): Promise<void> {
  const kept = start_ref(task.id);
  const at = await commit(dir, kept);
  const b = task.base_branch;
  if (at === null || b == null) return;
  const tip = await compare_ref(dir, b);
  const taken = await merge_base(dir, tip, head);
  if (taken === null) return;
  if (taken !== at && (await is_ancestor(dir, at, taken))) await git(dir, ["update-ref", kept, taken, at]).catch(() => {});
}

/**
 * `keep_start` for task `task_id`'s branch and those of the tasks stacked on it. Called as its agent's run ends, when
 * it's done and before its worktree or branch goes, so its own start, and theirs on its branch, keep up without anyone
 * reading their changes before that branch is deleted.
 */
export async function keep_starts(state: AppState, task_id: string): Promise<void> {
  const c = state.db();
  let tasks: Task[] = [];
  try {
    tasks = db.stacked_on(c, task_id);
  } catch {}
  try {
    const t = db.get_task(c, task_id);
    if (t) tasks.push(t);
  } catch {}
  const found: Array<[Task, string, string]> = [];
  for (const t of tasks) {
    if (t.start_from == null) continue;
    let p: Project | null = null;
    try {
      p = t.project_id ? db.get_project(c, t.project_id) : null;
    } catch {}
    if (!p || !t.branch) continue;
    found.push([t, p.repo_path, t.branch]);
  }
  for (const [t, repo, branch] of found) await keep_start(repo, t, `refs/heads/${branch}`);
}

/**
 * The base branch a task's changes are compared with (see db.task_base), and where its work starts (only known in the
 * task's own worktree): its merge base with the base branch or, when it started from somewhere else that's later, that.
 * That's where it started (see `start_ref`) or a commit it started from that the base branch doesn't have, or the branch
 * of the task it's stacked on once that's merged, until it's brought up to date with where that went (which squashed or
 * rebased it, say, or deleted its branch).
 */
export async function changes_base(state: AppState, dir: string, task: Task, project: Project): Promise<[string | null, string | null]> {
  if (task.worktree_state !== "ready") return [db.task_base(state.db(), task, project) ?? null, null];
  return changes_base_at(state, dir, task, project, "HEAD");
}

/**
 * What a review or a summary of a task's work in its worktree `dir` compares it with: its base branch (that or its
 * upstream, see `compare_ref`) or, for a task started from somewhere else (a commit its base branch doesn't have, a task
 * stacked on that's merged since), the commit where the Changes tab has its work start. True when that's later than
 * where it left its base branch, so a pull request's diff has more than its own work.
 */
export async function work_scope(state: AppState, dir: string, task: Task, project: Project): Promise<[string | null, boolean]> {
  const b = db.task_base(state.db(), task, project);
  const base = b != null ? await compare_ref(dir, b) : null;
  if (task.start_from == null) return [base, false];
  const start = (await changes_base(state, dir, task, project))[1];
  if (start === null) return [base, false];
  const left = base !== null ? await merge_base(dir, base, "HEAD") : null;
  return [start, left !== start];
}

/** `changes_base` for the task's work at `head` in `dir` (its worktree's HEAD, or its branch when it has no worktree). */
async function changes_base_at(state: AppState, dir: string, task: Task, project: Project, head: string): Promise<[string | null, string | null]> {
  const base = db.task_base(state.db(), task, project) ?? null;
  const from: string[] = [];
  // The task may have started from the base branch's upstream.
  if (base !== null) from.push(await compare_ref(dir, base));
  const sf = task.start_from;
  if (sf?.type === "task") {
    if (task.base_branch != null && task.base_branch !== base) from.push(await compare_ref(dir, task.base_branch));
  } else if (sf?.type === "commit") from.push(sf.commit);
  if (sf != null) {
    const kept = start_ref(task.id);
    await keep_start(dir, task, head);
    if ((await commit(dir, kept)) !== null) from.push(kept);
  }
  let start: string | null = null;
  for (const rev of from) {
    const mb = await merge_base(dir, rev, head);
    if (mb === null) continue;
    if (start !== null && !(await is_ancestor(dir, start, mb))) continue;
    start = mb;
  }
  return [base, start];
}

/** Diff of the task's work against the merge-base with its base branch, including uncommitted and untracked changes. */
export async function diff(state: AppState, task_id: string): Promise<any> {
  const [dir, task, project] = changes_dir(state, task_id);
  // A task with a worktree of its own that isn't there (not set up yet, or removed, even since the task was loaded, as a
  // teardown does while it's read): what its branch has, if anything, rather than the project folder's changes, which
  // aren't its own.
  const repo = project.repo_path;
  const gone = () => task.use_worktree && (task.worktree_state !== "ready" || !existsSync(dir));
  const from = gone() ? repo : dir;
  if (!(await is_git_repo(from))) return { available: false, reason: "not a git repository" };
  if (gone()) return branch_diff(state, repo, task, project);
  try {
    return await dir_diff(state, dir, task, project);
  } catch (e) {
    if (gone()) return branch_diff(state, repo, task, project);
    throw e;
  }
}

/** `diff` of the changes in `dir`, the task's worktree or the project's folder. */
async function dir_diff(state: AppState, dir: string, task: Task, project: Project): Promise<any> {
  const hook = changes_testing.diff_read;
  if (hook) {
    changes_testing.diff_read = null;
    hook();
  }
  const [base, mb] = await changes_base(state, dir, task, project);
  const from = mb ?? "HEAD";
  // Mark untracked files as intent-to-add would mutate the index; instead diff them separately.
  const tracked = (await git(dir, ["diff", "--no-color", "--no-ext-diff", "--stat=200", from])).stdout;
  const patch = (await git(dir, ["diff", "--no-color", "--no-ext-diff", "--src-prefix=a/", "--dst-prefix=b/", from])).stdout;
  // NUL-separated, so names git would quote (not ASCII, or with a newline) come as they are, and after `--`, so a name
  // starting with `-` isn't taken for an option.
  const untracked_list = await git_bytes(dir, ["ls-files", "-z", "--others", "--exclude-standard"]);
  const untracked = untracked_list
    .toString()
    .split("\0")
    .filter((f) => f);
  let untracked_patch = "";
  for (const f of untracked.slice(0, 50)) {
    // It exits 1 when the files differ, which they do.
    const o = await git_output(dir, ["diff", "--no-color", "--no-ext-diff", "--src-prefix=a/", "--dst-prefix=b/", "--no-index", "--", "/dev/null", f]);
    untracked_patch += o.stdout.toString();
  }
  const commits = mb !== null ? (await git(dir, ["log", "--oneline", `${mb}..HEAD`])).stdout : "";
  return {
    available: true,
    dir: path_str(dir),
    base,
    merge_base: mb,
    commits,
    stat: tracked,
    patch: truncate(patch + untracked_patch, 2_000_000),
    untracked,
  };
}

/** The committed work on a task's branch with no worktree (API 81, see `diff`): from where it left its base branch. */
async function branch_diff(state: AppState, repo: string, task: Task, project: Project): Promise<any> {
  const branch = task.branch;
  if (!branch) return { available: false, reason: "the task has no worktree or branch" };
  const head = `refs/heads/${branch}`;
  if (!(await git(repo, ["rev-parse", "--verify", "--quiet", head])).ok) {
    return { available: false, reason: `the task has no worktree, and its branch ${branch} is gone` };
  }
  const [base, mb] = await changes_base_at(state, repo, task, project, head);
  const from = mb ?? head;
  const stat = (await git(repo, ["diff", "--no-color", "--no-ext-diff", "--stat=200", from, head])).stdout;
  const patch = (await git(repo, ["diff", "--no-color", "--no-ext-diff", "--src-prefix=a/", "--dst-prefix=b/", from, head])).stdout;
  const commits = mb !== null ? (await git(repo, ["log", "--oneline", `${mb}..${head}`])).stdout : "";
  return {
    available: true,
    dir: path_str(repo),
    base,
    merge_base: mb,
    commits,
    stat,
    patch: truncate(patch, 2_000_000),
    untracked: [],
    branch,
  };
}
