// Port of server/src/db/projects.rs: projects: a repository and the settings its tasks inherit.
import { all, hidden, json_list, json_or_default, one, run, update_generic, type Conn } from "../db.ts";
import * as pr_watch from "../mcp/pr_watch.ts";
import { has_commits, is_git_root, now } from "../util.ts";
import { summarizers_column } from "./profiles.ts";
import { Reviewer_from_json, json_opt, json_vec, type Reviewer } from "./task_data.ts";

export interface Project {
  id: string;
  profile_id: string;
  name: string;
  key: string;
  /**
   * The keys the project had before its key was changed, newest last, so its tasks' old keys (e.g. `OS-2` after `OS`
   * became `OMS`) still name them.
   */
  former_keys: string[];
  repo_path: string;
  /**
   * What the repository folder was when last seen, to tell whether a folder it has moved to is the same repository: its
   * root commits, `git` for one without commits, empty for a folder that isn't a git repository, or None if not looked
   * at yet (see git/relocate.rs). `#[serde(skip)]`: non-enumerable.
   */
  repo_root: string | null;
  scratch_path: string;
  worktrees_root: string;
  base_branch: string | null;
  setup_script: string;
  teardown_script: string;
  /**
   * Ignored files copied into each new task worktree from the repository folder, as .gitignore-style patterns, one per
   * line (see git/worktree_files.rs).
   */
  copy_files: string;
  /** Ignored folders of the repository linked into each new task worktree, one per line. */
  link_folders: string;
  /** Runs whenever one of the project's tasks changes status (see integrations/status_script.rs). */
  status_script: string;
  /** A script per status, run when one of the project's tasks moves into it (a BTreeMap: sorted by status). */
  status_scripts: Record<string, string>;
  /**
   * Whether new tasks get their own worktree. Kept while the repo isn't a git repository yet, and only applies once it
   * is (see `is_git`).
   */
  use_worktrees: boolean;
  /** Whether the repo is a git repository (looked up when the project is loaded). */
  is_git: boolean;
  /**
   * Whether it has a commit checked out, which a worktree needs to branch from (looked up when the project is loaded;
   * false when it isn't a git repository).
   */
  has_commits: boolean;
  /**
   * The task whose thread helps the user get the folder ready for worktrees (a git repository with a commit), which the
   * board shows in its place until it is (API 73).
   */
  setup_task_id: string | null;
  /** Falls back to the host's default mode when unset. */
  permission_mode: string | null;
  model: string | null;
  /** Overrides the profile's Claude configs when set. */
  claude_config_ids: string[] | null;
  /** Review each task's work when it moves to "In review" (see review.rs). */
  auto_review: boolean;
  /** Move a task to Done when its pull request is merged on GitHub (see review/merged.rs). */
  done_when_merged: boolean;
  /**
   * Agents open a pull request for their task's branch when the repository is on GitHub (see runner::system_prompt).
   * Subprojects themselves follow it too. (The method `pull_requests(p, in_subproject)` reads it.)
   */
  pull_requests: boolean;
  /** The same for the tasks in the project's subprojects, whose pull requests target the subproject's branch. */
  subproject_pull_requests: boolean;
  /** How many times in a row a review's serious issues go back to the agent to fix before the task is left for the user. */
  review_rounds: number;
  /** Who reviews each task's work, each in a review thread of its own. Empty uses the profile's (see `reviewers_for`). */
  reviewers: Reviewer[];
  /** Summarise each task's changes once its review passes, for the user to read before merging (see review/summary.rs). */
  auto_summary: boolean;
  /** Who writes those summaries, each in a thread of its own (API 103). Empty uses the profile's (see `summarizers_for`). */
  summarizers: Reviewer[];
  /** The first of `summarizers`, for clients from before there could be several (API 87). */
  summarizer: Reviewer | null;
  /** Whether its merges wait for the user's approval (see review/merge_gate.rs). None follows its profile's `merge_approval`. */
  merge_approval: boolean | null;
  /**
   * Whether a task can only go to "Ready for merge" once its pull request has an approving review on GitHub (API 95).
   * None follows its profile's `require_pr_approval`.
   */
  require_pr_approval: boolean | null;
  /**
   * The project's instructions for the prompts sent when a task's agent starts, when its work is reviewed and when it's
   * merged; None uses the default (see agent/prompts.rs).
   */
  start_prompt: string | null;
  review_prompt: string | null;
  merge_prompt: string | null;
  /**
   * The group the project is in on the sidebar, which also has a board of all its projects' tasks. Projects on a host
   * with the same group name are in the same group.
   */
  group_name: string | null;
  /**
   * When the project was archived: it's left off the board (and out of its group and of agents' project lists) until
   * it's unarchived in the board's settings.
   */
  archived_at: string | null;
  /** Overrides the profile's GitHub account when set (see Profile.github_account). */
  github_account: string | null;
  /**
   * Which news about the pull request of a task in "In review" wakes its agent: off, failures (failed checks and
   * conflicts) or all (comments and reviews too). See pr_watch::watch_in_review.
   */
  watch_pull_requests: string;
  /**
   * Where a task's pull request is previewed, with `{pr}` for its number: a task gets it as its `preview_url` once it
   * has a pull request (see `preview_for`).
   */
  pr_preview_url: string | null;
  created_at: string;
}

const optbool = (v: any): boolean | null => (v == null ? null : !!v);

/** A JSON object of strings, as serde reads a `BTreeMap<String, String>` (with its keys in order), or else `{}`. */
function string_map(v: string | null | undefined): Record<string, string> {
  const m = json_or_default<any>(v, null);
  if (m === null || typeof m !== "object" || Array.isArray(m) || !Object.values(m).every((x) => typeof x === "string")) return {};
  return Object.fromEntries(Object.entries(m).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) as Record<string, string>;
}

export function Project_from_row(r: any): Project {
  const p: any = {
    id: r.id,
    profile_id: r.profile_id,
    name: r.name,
    key: r.key,
    former_keys: json_list(r.former_keys),
    repo_path: r.repo_path,
  };
  hidden(p, "repo_root", r.repo_root ?? null);
  Object.assign(p, {
    scratch_path: r.scratch_path,
    worktrees_root: r.worktrees_root,
    base_branch: r.base_branch ?? null,
    setup_script: r.setup_script,
    teardown_script: r.teardown_script,
    copy_files: r.copy_files,
    link_folders: r.link_folders,
    status_script: r.status_script,
    status_scripts: string_map(r.status_scripts),
    use_worktrees: !!r.use_worktrees,
    is_git: is_git_root(r.repo_path),
    has_commits: has_commits(r.repo_path),
    setup_task_id: r.setup_task_id ?? null,
    permission_mode: r.permission_mode ?? null,
    model: r.model ?? null,
    claude_config_ids: r.claude_config_ids == null ? null : json_list(r.claude_config_ids),
    auto_review: !!r.auto_review,
    done_when_merged: !!r.done_when_merged,
    pull_requests: !!r.pull_requests,
    subproject_pull_requests: !!r.subproject_pull_requests,
    review_rounds: r.review_rounds,
    reviewers: json_vec(r.reviewers, Reviewer_from_json),
    auto_summary: !!r.auto_summary,
    summarizers: summarizers_column(r.summarizers, r.summarizer),
    summarizer: json_opt(r.summarizer, Reviewer_from_json),
    merge_approval: optbool(r.merge_approval),
    require_pr_approval: optbool(r.require_pr_approval),
    start_prompt: r.start_prompt ?? null,
    review_prompt: r.review_prompt ?? null,
    merge_prompt: r.merge_prompt ?? null,
    group_name: r.group_name ?? null,
    archived_at: r.archived_at ?? null,
    github_account: r.github_account ?? null,
    watch_pull_requests: r.watch_pull_requests,
    pr_preview_url: r.pr_preview_url ?? null,
    created_at: r.created_at,
  });
  return p;
}

/**
 * Whether agents open pull requests for the project's tasks (`in_subproject`: for a subproject's tasks, while a
 * subproject itself is one of the project's). Rust's `Project::pull_requests` method: the field of the same name is
 * `p.pull_requests`.
 */
export function pull_requests(p: Project, in_subproject: boolean): boolean {
  return in_subproject ? p.subproject_pull_requests : p.pull_requests;
}

/**
 * Where pull request `pr_url` is previewed (see `pr_preview_url`): None if the project doesn't preview them or it isn't
 * a pull request's URL.
 */
export function preview_for(p: Project, pr_url: string | null | undefined): string | null {
  const template = p.pr_preview_url;
  if (template == null || pr_url == null) return null;
  let pr;
  try {
    pr = pr_watch.Target_parse(pr_url, null);
  } catch {
    return null;
  }
  return template.replaceAll("{pr}", String(pr.number));
}

// ---------- projects ----------

export function list_projects(c: Conn, profile_id: string): Project[] {
  return all(c, "SELECT * FROM projects WHERE profile_id=?1 ORDER BY name COLLATE NOCASE", profile_id).map(Project_from_row);
}

export function get_project(c: Conn, id: string): Project | null {
  const r = one(c, "SELECT * FROM projects WHERE id=?1", id);
  return r ? Project_from_row(r) : null;
}

export interface NewProject {
  id: string;
  profile_id: string;
  name: string;
  key: string;
  repo_path: string;
  scratch_path: string;
  worktrees_root: string;
  base_branch: string | null;
  use_worktrees: boolean;
}

export function insert_project(c: Conn, p: NewProject): Project {
  run(
    c,
    `INSERT INTO projects (id,profile_id,name,key,repo_path,scratch_path,worktrees_root,base_branch,use_worktrees,created_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)`,
    p.id, p.profile_id, p.name, p.key, p.repo_path, p.scratch_path, p.worktrees_root, p.base_branch, p.use_worktrees, now(),
  );
  return get_project(c, p.id)!;
}

const PROJECT_COLUMNS = [
  "name", "key", "repo_path", "scratch_path", "worktrees_root", "base_branch", "setup_script",
  "teardown_script", "status_script", "status_scripts", "use_worktrees", "permission_mode", "model", "auto_review", "review_rounds", "claude_config_ids",
  "reviewers", "auto_summary", "summarizer", "summarizers", "merge_approval", "require_pr_approval", "done_when_merged", "pull_requests", "subproject_pull_requests", "start_prompt", "review_prompt", "merge_prompt", "group_name", "former_keys", "repo_root",
  "archived_at", "github_account", "watch_pull_requests", "setup_task_id", "pr_preview_url",
  "copy_files", "link_folders",
];

export function update_project(c: Conn, id: string, fields: Array<[string, any]>): Project | null {
  update_generic(c, "projects", PROJECT_COLUMNS, id, fields);
  return get_project(c, id);
}

/** The project as `update_project` would leave it, without changing it. */
export function preview_project_update(c: Conn, id: string, fields: Array<[string, any]>): Project | null {
  // A savepoint rolled back afterwards (Rust's dropped transaction), which works inside a transaction too.
  c.exec("SAVEPOINT preview_project_update");
  try {
    return update_project(c, id, fields);
  } finally {
    c.exec("ROLLBACK TO preview_project_update; RELEASE preview_project_update");
  }
}
