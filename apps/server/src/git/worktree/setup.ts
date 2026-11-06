// Port of server/src/git/worktree/setup.rs.
/** Setting up a task's worktree (`setup`), one at a time per task. */
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import * as db from "../../db.ts";
import type { Project, Task } from "../../db.ts";
import * as runner from "../../agent/runner.ts";
import * as relocate from "../relocate.ts";
import * as worktree_files from "../worktree_files.ts";
import { AsyncMutex, type AppState } from "../../state.ts";
import { context, err_str, path_str, slugify, truncate } from "../../util.ts";
import {
  current_branch,
  git,
  git_ok,
  is_git_repo,
  is_worktree_of,
  load,
  pick_start,
  run_script,
  SCRIPT_LIMIT,
  script_env,
  start_point,
  start_ref,
  type Picked,
  type Start,
} from "../worktree.ts";

/**
 * Worktree setups (and removals once merged) in progress, by task: one at a time per task, so that two runs needing the
 * same worktree (e.g. two of a subproject's tasks both setting up the subproject's first) don't both try to create it,
 * and a run doesn't set up a worktree that's being removed. Each with how many are using or waiting on it.
 */
const SETUPS = new Map<string, { lock: AsyncMutex; users: number }>();

/** Run `f` holding the task's setup lock. */
export async function locked<T>(task_id: string, f: () => Promise<T>): Promise<T> {
  let entry = SETUPS.get(task_id);
  if (!entry) {
    entry = { lock: new AsyncMutex(), users: 0 };
    SETUPS.set(task_id, entry);
  }
  entry.users++;
  try {
    const release = await entry.lock.lock();
    try {
      return await f();
    } finally {
      release();
    }
  } finally {
    // Forget the lock once nobody else is waiting on it.
    entry.users--;
    if (entry.users === 0 && SETUPS.get(task_id) === entry) SETUPS.delete(task_id);
  }
}

/** Create the worktree for a task (idempotent) and run the project's setup script. */
export async function setup(state: AppState, task_id: string): Promise<Task> {
  return setup_within(state, task_id, []);
}

/**
 * `setup`, for a task whose worktree the setups of `within` (outermost first) need first: a subproject's for its tasks,
 * a task's for one stacked on it. One of those can't need its own (it would wait for its own setup lock), which
 * `check_start_from` should have prevented.
 */
export async function setup_within(state: AppState, task_id: string, within: string[]): Promise<Task> {
  if (within.includes(task_id)) {
    throw new Error("its worktree can't be set up: the tasks it starts from (or the subproject it's in) start from it");
  }
  // Not from the repository folder the project is moving from, and the folder stays put until the worktree is stored.
  const project_id = db.get_task(state.db(), task_id)?.project_id ?? null;
  const holding = project_id !== null ? await relocate.hold(state, project_id) : null;
  try {
    const all = [...within, task_id];
    return await locked(task_id, () => setup_locked(state, task_id, all));
  } finally {
    holding?.drop();
  }
}

/** `setup` while holding the task's setup lock: whatever another setup did before is seen here. */
async function setup_locked(state: AppState, task_id: string, within: string[]): Promise<Task> {
  const [task, project] = load(state, task_id);
  if (task.worktree_state === "ready" && task.worktree_path && existsSync(task.worktree_path)) return task;
  const repo = project.repo_path;
  if (!(await is_git_repo(repo))) throw new Error(`${project.repo_path} is not a git repository`);
  // It may have become one since the board last looked, or have its first commits.
  await relocate.record_fingerprint(state, project);
  // A subproject's task branches from the subproject's branch, which needs to exist first.
  const subproject = db.subproject_of(state.db(), task);
  let subproject_branch: string | null = null;
  if (subproject && task.base_branch == null) {
    if (subproject.branch != null) subproject_branch = subproject.branch;
    else {
      state.add_event(task_id, "info", "Setting up the subproject's worktree first…", null);
      let sp: Task;
      try {
        sp = await setup_within(state, subproject.id, within);
      } catch (e) {
        throw context("setting up the subproject's worktree", e);
      }
      subproject_branch = sp.branch ?? null;
    }
  }
  const name = folder_name(project, task);
  const branch = task.branch ?? `ia/${project.key.toLowerCase()}-${name}`;
  const wt = join(project.worktrees_root, name);
  await git(repo, ["worktree", "prune"]).catch(() => {});
  const branch_exists = (await git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])).ok;
  state.update_task(task_id, [
    ["worktree_state", "setting_up"],
    ["worktree_error", null],
  ]);
  // What it was asked to start from counts until its branch exists: that's where it started. Its base branch is saved
  // with the branch (see below), but one made before that was (a setup cut short) is worked out again.
  const fresh = !branch_exists && !existsSync(wt);
  let picked: Picked | null = null;
  if (task.start_from != null && (fresh || (task.branch == null && task.base_branch == null))) {
    try {
      picked = await pick_start(state, task, project, repo, task.start_from, within);
    } catch (e) {
      throw setup_failed(state, task_id, e);
    }
  }

  let result: [string, string, string];
  try {
    const given = picked?.base ?? task.base_branch ?? subproject_branch;
    let base: string;
    if (given != null) base = given;
    else if (project.base_branch) base = project.base_branch;
    else base = (await current_branch(repo)) ?? "HEAD";
    await mkdir(project.worktrees_root, { recursive: true });

    let from = base;
    // A folder there already is the task's worktree from before (a setup that didn't finish, say); anything else is in
    // the way, not something to take over and later remove.
    if (existsSync(wt) && !(await is_worktree_of(repo, wt))) throw new Error(`${wt} is in the way: it isn't a worktree of ${repo}`);
    if (!existsSync(wt)) {
      const wt_s = path_str(wt);
      if (branch_exists) {
        await git_ok(repo, ["worktree", "add", wt_s, branch]);
      } else {
        for (const [level, text] of picked?.notes ?? []) state.add_event(task_id, level, text, null);
        let start: Start;
        if (picked?.commit) {
          // A commit is where it starts, whatever the base branch has since.
          const [rev, what] = picked.commit;
          start = { rev, from: what, notes: [] };
        } else {
          const account = runner.task_github_account(state, task);
          start = await start_point(repo, base, account ?? null);
        }
        for (const [level, text, detail] of start.notes) state.add_event(task_id, level, text, detail);
        // Not tracking the branch it starts from (git would for a remote-tracking one).
        await git_ok(repo, ["worktree", "add", "--no-track", "-b", branch, wt_s, start.rev]);
        from = start.from;
        if (task.start_from != null) await git_ok(repo, ["update-ref", start_ref(task_id), `refs/heads/${branch}`]);
      }
    }
    // Saved as soon as git has them, so a setup script that fails (or a restart meanwhile) doesn't lose where the branch
    // started: setting up again keeps it, and so does the API, which only lets what it starts from change before there's
    // a branch.
    state.update_task(task_id, [
      ["worktree_path", path_str(wt)],
      ["branch", branch],
      ["base_branch", base],
    ]);
    state.add_event(task_id, "info", `Worktree ready at ${wt} on branch ${branch} (from ${from})`, null);

    // Before the setup script, which can rely on them. Nothing already there is overwritten, so a setup that didn't
    // finish can do it again.
    try {
      const report = await worktree_files.bring_in(project, wt);
      const ev = worktree_files.event(report);
      if (ev) state.add_event(task_id, ev[0], ev[1], ev[2]);
    } catch (e) {
      state.add_event(task_id, "warn", "Couldn't copy or link the project's files into the worktree", err_str(e));
    }
    if (project.setup_script.trim()) {
      state.add_event(task_id, "info", "Running setup script…", null);
      const log = await run_script(project.setup_script, wt, script_env(project, task, wt, branch), SCRIPT_LIMIT);
      state.add_event(task_id, "info", "Setup script finished", truncate(log, 20000));
    }
    result = [wt, branch, base];
  } catch (e) {
    throw setup_failed(state, task_id, e);
  }
  const [wt2, branch2, base2] = result;
  return state.update_task(task_id, [
    ["worktree_state", "ready"],
    ["worktree_path", path_str(wt2)],
    ["branch", branch2],
    ["base_branch", base2],
  ])!;
}

/** Record that a task's worktree couldn't be set up, returning the error. */
function setup_failed(state: AppState, task_id: string, e: unknown): Error {
  const msg = err_str(e);
  try {
    state.update_task(task_id, [
      ["worktree_state", "error"],
      ["worktree_error", msg],
    ]);
  } catch (e) {
    console.warn(`task ${task_id}: couldn't record the failed worktree setup: ${err_str(e)}`);
  }
  state.add_event(task_id, "error", "Worktree setup failed", msg);
  return new Error(msg);
}

/**
 * The name of a task's worktree folder in the project's worktrees folder. A task that had a worktree before (removed once
 * merged, say) gets its folder back, named after its branch (even if the project's key has changed since), so its
 * agent's conversation, which is kept by folder, carries on even if the task was renamed.
 */
export function folder_name(project: Project, task: Task): string {
  const keys = [project.key, ...(project.former_keys ?? [])];
  let from_branch: string | null = null;
  if (task.branch) {
    for (const k of keys) {
      const prefix = `ia/${k.toLowerCase()}-`;
      if (task.branch.startsWith(prefix)) {
        from_branch = task.branch.slice(prefix.length);
        break;
      }
    }
  }
  if (from_branch && !from_branch.includes("/")) return from_branch;
  const slug = slugify(task.title, 40);
  return slug ? `${task.number}-${slug}` : `${task.number}`;
}
