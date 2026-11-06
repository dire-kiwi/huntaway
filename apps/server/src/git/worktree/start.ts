// Port of server/src/git/worktree/start.rs.
/**
 * Tasks that start from something other than their project's base branch (db.StartFrom): where they start
 * (`pick_start`), stacked tasks (`unstack`, `remote_base`), and the branches to pick from.
 */
import * as db from "../../db.ts";
import type { Project, StartFrom, Task } from "../../db.ts";
import * as runner from "../../agent/runner.ts";
import * as gh_mcp from "../../mcp/gh_mcp.ts";
import type { AppState } from "../../state.ts";
import { context, err_str, expand_tilde } from "../../util.ts";
import {
  commit,
  current_branch,
  fetch,
  gh_json,
  git,
  git_env,
  git_ok,
  github,
  keep_starts,
  lines,
  push_remote,
  remote_branch,
  run_fetch,
  setup_within,
  start_ref,
  upstream,
  type GitCmd,
} from "../worktree.ts";

/** Where a task asked to start from something other than its project's base branch starts (see db.StartFrom), worked out as its worktree is first made. */
export interface Picked {
  /** Its base branch, which its pull request targets and its changes are compared with; None for the project's. */
  base: string | null;
  /**
   * The commit its branch starts at, and what it is for the task log, when that isn't its base branch's latest (a commit;
   * a pull request from a fork).
   */
  commit: [string, string] | null;
  /** Events for the task log: level and text. */
  notes: Array<[string, string]>;
}

/**
 * Work out where task `task` starts from `sf`. A task it's stacked on that has no branch yet has its worktree set up
 * first, as a subproject's is for its tasks; one that's merged already has its task start from where it was merged. So
 * does a merged pull request; one from a fork (or closed) starts from its head commit, fetched by its SHA, with the pull
 * request's base as the task's. None when it comes to the project's base branch after all.
 */
export async function pick_start(state: AppState, task: Task, project: Project, repo: string, sf: StartFrom, within: string[]): Promise<Picked | null> {
  const picked = (base: string, note: string): Picked => ({ base, commit: null, notes: [["info", note]] });
  switch (sf.type) {
    case "branch": {
      const branch = sf.branch;
      // A remote's branch (`origin/feature`) is the branch of that name when that's the remote the name alone follows
      // (where its pull request goes).
      let base = branch;
      const rb = await remote_branch(repo, branch);
      if (rb && (await commit(repo, `refs/heads/${branch}`)) === null) {
        const [remote, name] = rb;
        const up = await upstream(repo, name);
        if (up && up.remote === remote && up.merge === `refs/heads/${name}`) base = name;
        else {
          // Another remote's (`upstream/feature`) isn't a branch the task's pull request can target, which goes to the
          // push remote's repository: like a pull request from a fork, its latest commit it is (fetched), and the base
          // branch the project's.
          const up = await upstream(repo, branch);
          if (!up) throw new Error(`couldn't tell where ${branch} is fetched from`);
          const account = runner.task_github_account(state, task);
          try {
            await fetch(repo, up, account ?? null);
          } catch (e) {
            console.warn(`task ${task.id}: fetching ${branch}: ${err_str(e)}`);
          }
          const tip = await commit(repo, up.tracking);
          if (tip === null) throw new Error(`branch ${branch} isn't in the repository (fetching it failed)`);
          const note =
            `${branch} is on ${remote}, which this task's pull request doesn't go to, so starting from its latest commit ${tip.slice(0, 12)}: ` +
            "this task's pull request targets the base branch, with its commits too";
          return { base: null, commit: [tip, branch], notes: [["info", note]] };
        }
      }
      return picked(base, `Starting from branch ${base}`);
    }
    case "task": {
      const other = db.get_task(state.db(), sf.task_id);
      if (!other) throw new Error("the task this one starts from was deleted");
      const key = `${runner.key_prefix(other, project)}-${other.number}`;
      if (db.is_merged(other)) {
        // Where it went: that's merged too when it was stacked on another task (see db.task_base).
        const base = db.task_base(state.db(), other, project);
        const note = `${key} is merged already, so starting from ${base ?? "the base branch"}`;
        return { base, commit: null, notes: [["info", note]] };
      }
      let branch: string;
      if (other.branch != null) branch = other.branch;
      else if (other.use_worktree) {
        state.add_event(task.id, "info", `Setting up ${key}'s worktree first, to start from its branch…`, null);
        let set_up: Task;
        try {
          set_up = await setup_within(state, other.id, within);
        } catch (e) {
          throw context(`setting up ${key}'s worktree`, e);
        }
        if (set_up.branch == null) throw new Error(`${key} has no branch to start from`);
        branch = set_up.branch;
      } else throw new Error(`${key} has no branch to start from: it doesn't use a worktree`);
      return picked(branch, `Stacked on ${key}: starting from its branch ${branch}, which this task's pull request targets`);
    }
    case "pull_request": {
      const number = sf.number, named = sf.repo ?? null;
      // Where the project's tasks open their pull requests: its base branch's remote's repository.
      const def = await project_base(repo, project);
      const gh = await github(repo, def);
      if (!gh) throw new Error(`${project.repo_path} isn't on GitHub, so it has no pull request #${number}`);
      if (named !== null && named.toLowerCase() !== gh.repo.toLowerCase()) {
        throw new Error(`pull request #${number} is in ${named}, not in the project's repository ${gh.repo}`);
      }
      const env = await runner.task_gh_env(state, task);
      let pr: any;
      try {
        const fields = "state,headRefName,baseRefName,headRefOid,isCrossRepository";
        pr = await gh_json(repo, ["pr", "view", String(number), "--repo", gh.repo, "--json", fields], env);
      } finally {
        env?.drop();
      }
      if (pr == null) throw new Error(`couldn't read pull request #${number} of ${gh.repo} with gh`);
      const text = (k: string): string | null => (typeof pr[k] === "string" && pr[k] ? pr[k] : null);
      const head = text("headRefName"), base = text("baseRefName"), oid = text("headRefOid");
      if (head === null || base === null || oid === null) throw new Error(`gh didn't say where pull request #${number} of ${gh.repo} is`);
      if (pr.state === "MERGED") return picked(base, `Pull request #${number} is merged already, so starting from its base ${base}`);
      // Its branch, if the name alone follows the remote it's on (where this task's pull request goes too).
      const up = await upstream(repo, head);
      const follows = up !== null && up.remote === gh.remote && up.merge === `refs/heads/${head}`;
      if (pr.state === "OPEN" && pr.isCrossRepository === false && follows) {
        return picked(head, `Starting from pull request #${number}'s branch ${head}, which this task's pull request targets`);
      }
      // Its branch isn't one the task's pull request can target: its commit it is.
      const account = runner.task_github_account(state, task);
      try {
        await fetch_commit(repo, gh.remote, oid, account ?? null);
      } catch (e) {
        throw context(`fetching pull request #${number}'s head ${oid}`, e);
      }
      let why: string;
      if (pr.state === "OPEN") why = pr.isCrossRepository === false ? `has its branch on ${gh.remote}, which ${head} alone doesn't follow here` : "is from a fork";
      else why = "is closed";
      const note =
        `Pull request #${number} ${why}, so starting from its head commit ${oid.slice(0, 12)} on top of ${base}: ` +
        `this task's pull request targets ${base}, with its commits too`;
      return { base, commit: [oid, `pull request #${number}`], notes: [["info", note]] };
    }
    case "commit": {
      const sha = sf.commit;
      let found = await commit(repo, sha);
      if (found === null) {
        // GitHub (like most hosts) hands out a commit that's on one of its branches by its full SHA.
        const remote = (await push_remote(repo, await project_base(repo, project)))?.[0] ?? null;
        const account = runner.task_github_account(state, task);
        if (remote !== null && sha.length === 40) {
          try {
            await fetch_commit(repo, remote, sha, account ?? null);
          } catch (e) {
            throw context(`fetching commit ${sha}`, e);
          }
        } else throw new Error(`commit ${sha} isn't in the repository (give its full SHA to fetch it)`);
        found = await commit(repo, sha);
        if (found === null) throw new Error(`commit ${sha} isn't in the repository`);
      }
      const short = found.slice(0, 12);
      return { base: null, commit: [found, short], notes: [["info", `Starting from commit ${short}`]] };
    }
  }
  return null;
}

/** The base branch a task in `project` (in `repo`) gets when it doesn't say: the project's, or the branch checked out in its repository. */
async function project_base(repo: string, project: Project): Promise<string | null> {
  return project.base_branch ? project.base_branch : await current_branch(repo);
}

/**
 * Before task `gone` is deleted, if it's merged: the tasks stacked on it keep going where it went (see db.task_base),
 * which they'd no longer find. When that's the branch of a task it was stacked on that isn't merged yet, they're stacked
 * on that one instead. Otherwise one with a branch starts, from then on, from the commit where its own work starts (see
 * `start_ref`), so its changes are still only its own; one without is a task on that branch.
 */
export async function unstack(state: AppState, gone: Task): Promise<void> {
  if (!db.is_merged(gone)) return;
  await keep_starts(state, gone.id);
  let stacked: Task[];
  try {
    stacked = db.stacked_on(state.db(), gone.id);
  } catch {
    stacked = [];
  }
  const heir = db.stacked_base(state.db(), gone);
  for (const t of stacked) {
    let project: Project | null = null;
    try {
      project = t.project_id ? db.get_project(state.db(), t.project_id) : null;
    } catch {}
    const base = db.task_base(state.db(), t, project);
    const key = (t: Task) => `${runner.key_prefix(t, project)}-${t.number}`;
    let fields: Array<[string, any]>, text: string;
    if (heir) {
      fields = [["start_from", { type: "task", task_id: heir.id }], ["base_branch", t.branch != null ? base : null]];
      text = `${key(gone)}, which this task was stacked on, was deleted: it's merged into ${key(heir)}, so this task is stacked on that now`;
    } else {
      const kept = project && t.branch != null ? await commit(expand_tilde(project.repo_path), start_ref(t.id)) : null;
      let from: any;
      if (t.branch != null) from = kept !== null ? { type: "commit", commit: kept } : (t.start_from ?? null);
      else from = null;
      const to = base ?? "the base branch";
      fields = [["base_branch", base], ["start_from", from]];
      text = `${key(gone)}, which this task was stacked on, was deleted: it's merged, so this task goes to ${to}`;
    }
    try {
      state.update_task(t.id, fields);
    } catch (e) {
      console.warn(`task ${t.id}: keeping where it goes as ${key(gone)} is deleted: ${err_str(e)}`);
      continue;
    }
    state.add_event(t.id, "info", text, null);
  }
}

/**
 * The branch whose remote task `task`'s pull request goes to (see `github`): its base branch (see db.task_base) or, while
 * that's the branch of a task it's stacked on that has no remote of its own (made by the board and not pushed yet), that
 * task's, and so on.
 */
export async function remote_base(state: AppState, task: Task, project: Project): Promise<string | null> {
  const repo = expand_tilde(project.repo_path);
  let t = task;
  for (let i = 0; i < 16; i++) {
    const base = db.task_base(state.db(), t, project);
    const on = db.stacked_base(state.db(), t);
    if (base == null || !on) return base ?? null;
    let own = false;
    try {
      own = (await git(repo, ["config", `branch.${base}.remote`])).stdout.trim() !== "";
    } catch {}
    if (own) return base;
    t = on;
  }
  return null;
}

/**
 * Fetch commit `sha` (in full) from `remote`, as a pull request's head or a commit a task starts from, so it's in the
 * repository; the branch made from it keeps it.
 */
async function fetch_commit(repo: string, remote: string, sha: string, account: string | null): Promise<void> {
  if ((await commit(repo, sha)) !== null) return;
  const cmd: GitCmd = { args: [], env: git_env() };
  const started = Date.now();
  await gh_mcp.authenticate_fetch(cmd, repo, remote, account);
  const left = Math.max(1, 60_000 - (Date.now() - started));
  await run_fetch(
    cmd,
    repo,
    ["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", remote, sha],
    left,
    (e) => `git fetch ${remote} ${sha} failed: ${e}`,
    `git fetch ${remote} timed out`,
  );
}

/**
 * The branches of `repo`, newest commits first, up to a few hundred: `{name, remote}` for each, those only on a remote
 * named with it (`origin/feature`), as a task's `start_from` takes them.
 */
export async function branches(repo: string): Promise<any[]> {
  let list: string;
  try {
    list = await git_ok(repo, ["for-each-ref", "--sort=-committerdate", "--count=400", "--format=%(refname)", "refs/heads", "refs/remotes"]);
  } catch {
    return [];
  }
  const refs = lines(list).map((r) => r.trim());
  const local = refs.filter((r) => r.startsWith("refs/heads/")).map((r) => r.slice("refs/heads/".length));
  const out: any[] = [];
  for (const r of refs) {
    if (out.length >= 200) break;
    if (r.startsWith("refs/heads/")) out.push({ name: r.slice("refs/heads/".length), remote: false });
    else if (r.startsWith("refs/remotes/")) {
      // Not a remote's HEAD, nor a branch that's here too.
      const name = r.slice("refs/remotes/".length);
      const i = name.indexOf("/");
      if (i < 0) continue;
      const b = name.slice(i + 1);
      if (b !== "HEAD" && !local.includes(b)) out.push({ name, remote: true });
    }
  }
  return out;
}
