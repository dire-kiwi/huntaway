// Port of server/src/git/worktree/pr.rs.
/** A task's pull request and its work to merge: `has_work_to_merge`, `unmerged`, approvals, and looking up its pull request with gh (`find_pr`). */
import * as db from "../../db.ts";
import type { Project, Task } from "../../db.ts";
import * as runner from "../../agent/runner.ts";
import type * as gh_mcp from "../../mcp/gh_mcp.ts";
import type { AppState } from "../../state.ts";
import { err_str } from "../../util.ts";
import { commit, current_branch, git, github, is_git_repo, output, remote_base, upstream } from "../worktree.ts";

/** Hooks for tests (Rust's `#[cfg(test)]` thread-locals). */
export const pr_testing = {
  /** The gh `gh_json` runs (gh on the PATH when unset). */
  GH: null as string | null,
};

/**
 * Whether a task has work to merge: commits on its branch that its base branch doesn't have, or uncommitted changes
 * where its agent works. When it can't tell (e.g. the branch or its base is missing locally), it says yes, so the task's
 * agent sorts the merge out.
 */
export async function has_work_to_merge(state: AppState, task: Task): Promise<boolean> {
  let project: Project | null = null;
  try {
    project = task.project_id ? db.get_project(state.db(), task.project_id) : null;
  } catch {}
  if (!project) return false;
  const repo = project.repo_path;
  if (!(await is_git_repo(repo))) return false;
  // A subproject's tasks were merged into its branch on the remote, which may be ahead of ours. Its scratch tasks have no
  // branch, so they don't count (a failed read counts as work).
  if (task.subproject) {
    let all_scratch = false;
    try {
      all_scratch = db.subproject_tasks(state.db(), task.id).every((t) => db.is_scratch(t));
    } catch {}
    if (!all_scratch) return true;
  }
  const base = db.task_base(state.db(), task, project) ?? null;
  const dirty = async (dir: string) => {
    try {
      const o = await git(dir, ["status", "--porcelain"]);
      return !o.ok || o.stdout.trim() !== "";
    } catch {
      return true;
    }
  };
  const branch = task.branch;
  if (branch == null) {
    // No worktree: the agent worked in the repository's own checkout, on its base branch unless it switched to another.
    if (task.use_worktree && task.worktree_state === "none") return false;
    return base === null || (await current_branch(repo)) !== base || (await dirty(repo));
  }
  if (base === null) return true;
  // It may have started from the base branch's upstream, ahead of the local branch (or with no local branch at all).
  const bases = [`refs/heads/${base}`];
  const up = await upstream(repo, base);
  if (up) bases.push(up.tracking);
  const args = ["rev-list", "--count", `refs/heads/${branch}`];
  for (const b of bases) if ((await commit(repo, b)) !== null) args.push(`^${b}`);
  if (args.length === 3) return true;
  try {
    const o = await git(repo, args);
    if (!(o.ok && o.stdout.trim() === "0")) return true;
  } catch {
    return true;
  }
  if (task.worktree_path != null && task.worktree_state === "ready") return dirty(task.worktree_path);
  return false;
}

/** Resolves to `undefined` after `ms`, or to what `p` resolves to first. */
function within<T>(ms: number, p: Promise<T>): Promise<T | undefined> {
  let timer: NodeJS.Timeout;
  const late = new Promise<undefined>((r) => (timer = setTimeout(() => r(undefined), ms)));
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

/**
 * Whether moving a task to Done would leave work of its unmerged (API 75), for the board to ask first: it has work to
 * merge (see `has_work_to_merge`) and its pull request, if it has one, isn't merged on GitHub (squashed or rebased, its
 * commits aren't in its base branch). Tasks with a document (kept by the board) have none. A pull request that can't be
 * read in a few seconds counts as not merged.
 */
export async function unmerged(state: AppState, task: Task): Promise<boolean> {
  if (task.kind !== "task" || task.task_type != null || !(await has_work_to_merge(state, task))) return false;
  const url = task.pr_url;
  if (url == null) return true;
  const pr = async () => {
    let project: Project | null = null;
    try {
      project = task.project_id ? db.get_project(state.db(), task.project_id) : null;
    } catch {}
    if (!project) return null;
    // Not as another account when the task's isn't signed in.
    let env;
    try {
      env = await runner.task_gh_env(state, task);
    } catch {
      return null;
    }
    try {
      return await gh_json(project.repo_path, ["pr", "view", url, "--json", "state"], env);
    } finally {
      env?.drop();
    }
  };
  const got = await within(5000, pr().catch(() => null));
  return !(got != null && got.state === "MERGED");
}

/**
 * Whether the setting that a task needs an approving review on its pull request to go to "Ready for merge" applies to
 * `task`: its project's, or else its profile's (API 95). It doesn't where the task's merge goes through no pull request
 * (the project's settings open none for it).
 */
export async function pr_approval_required(state: AppState, task: Task): Promise<boolean> {
  const c = state.db();
  let project: Project | null = null, in_subproject = false, required = false;
  try {
    project = task.project_id ? db.get_project(c, task.project_id) : null;
  } catch {}
  try {
    in_subproject = !!(task.parent_id && db.get_task(c, task.parent_id)?.subproject);
  } catch {}
  if (project && project.require_pr_approval != null) required = project.require_pr_approval;
  else {
    try {
      required = !!db.get_profile(c, task.profile_id)?.require_pr_approval;
    } catch {}
  }
  if (project && !db.pull_requests(project, in_subproject)) project = null;
  // Agents open a pull request only for a task with its own branch, in a repository pushed to GitHub (see agent/runner/launch.rs).
  if (!project || !required || task.branch == null) return false;
  const base = await remote_base(state, task, project);
  return (await github(project.repo_path, base)) !== null;
}

/**
 * Whether a pull request (as `gh pr view --json reviewDecision,reviews` prints it) is approved: GitHub's decision if it
 * has one, else each reviewer's standing verdict from their reviews in order (comments keep it, a dismissal clears it)
 * is an approval with no change request standing.
 */
export function approved_by_reviews(pr: any): boolean {
  const decision = pr?.reviewDecision;
  if (decision === "APPROVED") return true;
  // Required reviews GitHub doesn't count as met (too few, or not from people who can write), or changes asked for.
  if (decision === "CHANGES_REQUESTED" || decision === "REVIEW_REQUIRED") return false;
  const verdicts = new Map<string, string>();
  for (const r of Array.isArray(pr?.reviews) ? pr.reviews : []) {
    const who = r?.author?.login, st = r?.state;
    if (typeof who !== "string" || typeof st !== "string") continue;
    // Anyone can review a public repository's pull request: only those with a say in the repository count.
    const assoc = typeof r.authorAssociation === "string" ? r.authorAssociation : "";
    if (st === "APPROVED" && !["OWNER", "MEMBER", "COLLABORATOR"].includes(assoc)) continue;
    if (st === "APPROVED" || st === "CHANGES_REQUESTED") verdicts.set(who, st);
    else if (st === "DISMISSED") verdicts.delete(who);
  }
  const vs = [...verdicts.values()];
  return vs.includes("APPROVED") && !vs.includes("CHANGES_REQUESTED");
}

/**
 * Whether the pull request at `url` (the one the task will have) is approved on GitHub. Throws an Error saying why it
 * can't be told (no pull request, or GitHub couldn't be read): Rust's `Result<bool, String>`.
 */
export async function pr_approved(state: AppState, task: Task, url: string | null | undefined): Promise<boolean> {
  if (url == null) throw new Error("the task has no pull request yet; open one and get it approved on GitHub first");
  let project: Project | null = null;
  try {
    project = task.project_id ? db.get_project(state.db(), task.project_id) : null;
  } catch {}
  if (!project) throw new Error("the task has no project");
  let env;
  try {
    env = await runner.task_gh_env(state, task);
  } catch (e) {
    throw new Error(`couldn't read the pull request: ${err_str(e)}`);
  }
  let pr;
  try {
    pr = await gh_json(project.repo_path, ["pr", "view", url, "--json", "reviewDecision,reviews"], env);
  } finally {
    env?.drop();
  }
  if (pr == null) throw new Error("couldn't read the pull request's reviews from GitHub");
  return approved_by_reviews(pr);
}

/**
 * Look up the pull request for a task's branch with `gh` once its agent's run ends, and keep its URL on the task. Skipped
 * when the task already has one; quietly gives up when `gh` isn't installed or signed in, or the branch has no pull
 * request yet.
 */
export function find_pr(state: AppState, task: Task): void {
  const branch = task.branch;
  if (branch == null || task.pr_url != null || task.kind !== "task") return;
  const look = async () => {
    const project = task.project_id ? db.get_project(state.db(), task.project_id) : null;
    if (!project) return;
    const dir = task.worktree_path != null && task.worktree_state === "ready" ? task.worktree_path : project.repo_path;
    const base = await remote_base(state, task, project);
    const args = await pr_view_args(project.repo_path, base, branch);
    // Not as another account when the task's isn't signed in.
    let env;
    try {
      env = await runner.task_gh_env(state, task);
    } catch (e) {
      console.warn(`task ${task.id}: couldn't look up the pull request: ${err_str(e)}`);
      return;
    }
    let url;
    try {
      url = await pr_url(dir, args, env);
    } finally {
      env?.drop();
    }
    if (url == null) return;
    // Unless it was set meanwhile.
    if (db.get_task(state.db(), task.id)?.pr_url == null) {
      try {
        state.update_task(task.id, [["pr_url", url]]);
      } catch (e) {
        console.warn(`task ${task.id}: couldn't save the pull request: ${err_str(e)}`);
      }
    }
  };
  look().catch((e) => console.warn(`task ${task.id}: looking up the pull request: ${err_str(e)}`));
}

/**
 * The `gh` arguments that look up the pull request of a task's `branch` (branched from `base` in `repo`): in the GitHub
 * repository it's pushed to (see `github`), which gh wouldn't pick from the remotes' fetch URLs if they're elsewhere, or
 * else wherever gh finds it.
 */
export async function pr_view_args(repo: string, base: string | null | undefined, branch: string): Promise<string[]> {
  const args = ["pr", "view", branch, "--json", "url"];
  const gh = await github(repo, base);
  if (gh) args.push("--repo", gh.repo);
  return args;
}

/** The URL of a pull request, from `gh` run in `dir` with `pr_view_args` (and `env`, see runner.task_gh_env). */
async function pr_url(dir: string, args: string[], env: gh_mcp.GhEnv | null): Promise<string | null> {
  const pr = await gh_json(dir, args, env);
  const url = pr?.url;
  return typeof url === "string" && url.startsWith("https://") ? url : null;
}

/**
 * The JSON a `gh` command run in `dir` prints, or None when it fails (e.g. `gh` isn't installed or signed in, or there's
 * no such pull request). `env` is the task's `GhEnv` (see runner.task_gh_env), if it has an account.
 */
export async function gh_json(dir: string, args: string[], env: gh_mcp.GhEnv | null | undefined): Promise<any | null> {
  const cmd = { args: [] as string[], env: { ...process.env, GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0" } as NodeJS.ProcessEnv };
  if (env) {
    try {
      env.check(args, null);
    } catch {
      return null;
    }
    env.apply(cmd.env);
  }
  let out;
  try {
    out = await output(pr_testing.GH ?? "gh", args, { cwd: dir, env: cmd.env, timeout: 30_000 });
  } catch {
    return null;
  }
  if (!out.success) return null;
  try {
    return JSON.parse(out.stdout.toString());
  } catch {
    return null;
  }
}
