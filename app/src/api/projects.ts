import type { Agent } from "./claudeConfigs";
import { type Host, hostSupports } from "./hosts";
import { enc, on } from "./http";
import type { PermissionMode, Status, Task } from "./tasks";

/** Whether a task counts as merged for the tasks that depend on it (server: db::is_merged). */
/** Whether new tasks in the project get their own worktree: only once its repo is a git repository. */
export const worktreesOn = (p: Project) => p.use_worktrees && p.is_git !== false;

/** Whether the project wants worktrees but its folder can't have them yet (not a git repository, or one with no
 * commit to branch from), so the board shows its setup thread instead of its tasks (API 73). */
export const needsWorktreeSetup = (p: Project, h: Host | undefined) => hostSupports(h, 73) && p.use_worktrees && !(p.is_git && p.has_commits);

/** What removing merged worktrees did with a done task's worktree: removed, or kept and why. */
export interface MergedWorktreeResult {
  task_id: string;
  number: number;
  title: string;
  removed: boolean;
  detail: string;
}

export interface Project {
  host_id: string;
  id: string;
  profile_id: string;
  name: string;
  key: string;
  /** Keys the project had before, which still name its tasks (API 40). */
  former_keys?: string[];
  repo_path: string;
  scratch_path: string;
  worktrees_root: string;
  base_branch: string | null;
  setup_script: string;
  teardown_script: string;
  /** Ignored files copied into each new worktree from the repository, as .gitignore-style patterns, one per line (API 82). */
  copy_files?: string;
  /** Ignored folders of the repository symlinked into each new worktree, one per line (API 82). */
  link_folders?: string;
  /** Runs whenever one of the project's tasks changes status (API 37). */
  status_script?: string;
  /** A script per status, run when a task moves into it (API 38). */
  status_scripts?: Partial<Record<Status, string>>;
  /** Kept while the repo isn't a git repository yet; see worktreesOn. */
  use_worktrees: boolean;
  /** Whether the repo is a git repository (API 31). */
  is_git?: boolean;
  /** Whether it has a commit checked out for worktrees to branch from (API 73). */
  has_commits?: boolean;
  /** The task whose thread helps get the folder ready for worktrees (API 73). */
  setup_task_id?: string | null;
  /** Falls back to the host's default mode when null (API 2; always set by older hosts). */
  permission_mode: PermissionMode | null;
  model: string | null;
  /** Overrides the profile's Claude configs when set (API 20). */
  claude_config_ids?: string[] | null;
  /** Review each task's work when it moves to "In review" (API 12). */
  auto_review?: boolean;
  /** How many times in a row a review's serious issues go back to the agent to fix (API 12). */
  review_rounds?: number;
  /** Move a task in In review or Needs attention to Done when its pull request is merged on GitHub (API 68). */
  done_when_merged?: boolean;
  /** Agents open a pull request for each task's branch when the repository is on GitHub; subprojects follow it too (API 85). */
  pull_requests?: boolean;
  /** The same for the tasks in its subprojects, whose pull requests target the subproject's branch (API 85). */
  subproject_pull_requests?: boolean;
  /** Who reviews each task, each in its own review thread (API 29); empty uses the profile's (API 87), before that one reviewer with the task's config. */
  reviewers?: Reviewer[];
  /** Once a task's review passes, an agent summarises its changes for you to read before merging (API 84). */
  auto_summary?: boolean;
  /** Who writes those summaries (API 84); null uses the profile's (API 87), before that the task's config with the default model and effort. */
  summarizer?: Reviewer | null;
  /** Whether its merges wait for your approval of a summary; null follows the profile's (API 92). */
  merge_approval?: boolean | null;
  /** null follows the profile's (API 95). */
  require_pr_approval?: boolean | null;
  /** The project's instructions for the prompts sent when a task's agent starts, when its work is
   * reviewed and when it's merged; null uses the host's default (API 27). */
  start_prompt?: string | null;
  review_prompt?: string | null;
  merge_prompt?: string | null;
  /** The sidebar group it's in, shared with the host's projects of the same name; null for none (API 32). */
  group_name?: string | null;
  /** When it was archived: it's off the board until it's unarchived in Settings (API 46). */
  archived_at?: string | null;
  /** Overrides the profile's GitHub account; null uses the profile's (API 50). */
  github_account?: string | null;
  /** Which news about an In review task's pull request wakes its agent (API 72). */
  watch_pull_requests?: WatchPullRequests;
  /** Where its tasks' pull requests are previewed, with {pr} for the number: a task with a pull request gets it as its preview_url (API 79). */
  pr_preview_url?: string | null;
  created_at: string;
}

/** off; failures: failed checks and conflicts; all: comments and reviews too. */
export type WatchPullRequests = "off" | "failures" | "all";

export type PromptField = "start_prompt" | "review_prompt" | "merge_prompt";

/** The options of a new thread that change what its agent is told (see api.systemPromptPreview). Unset ones are as a new
 *  task in the project has them. */
export interface SystemPromptOptions {
  type?: "task" | "subproject" | "scratch";
  /** Some of LABELS, comma-separated. */
  labels?: string;
  worktree?: boolean;
  runtime?: Agent;
  permission_mode?: PermissionMode;
}

/** One of a project's reviewers (API 29). Null fields use the task's config and the default model and effort. */
export interface Reviewer {
  claude_config_id: string | null;
  model: string | null;
  effort: string | null;
  /** Its own instructions, over the project's In review prompt (a summarizer's: over the default summary instructions). Unset follows the project's (API 101). */
  prompt?: string | null;
  /** Names of board skills that are on in its thread whether or not they are for the project (API 101). */
  skills?: string[];
}

/** From this API a reviewer and the summarizer can have instructions and skills of their own. */
export const REVIEWER_OPTIONS_API = 101;

export const projectsApi = {
  /** The profile's projects, or with `archived` its archived ones (API 46), which are left out otherwise. */
  projects: (h: string, profileId: string, archived = false) => on(h).get<Project[]>(`/profiles/${enc(profileId)}/projects${archived ? "?archived=true" : ""}`),
  createProject: (h: string, profileId: string, b: { name: string; repo_path: string; key?: string }) =>
    on(h).post<Project>(`/profiles/${enc(profileId)}/projects`, b),
  /** Clone a GitHub repository (`OWNER/REPO`) as the profile's GitHub account into `repo_path` and add it as a project (API 55). */
  cloneProject: (h: string, profileId: string, b: { repo: string; repo_path: string; name: string; key?: string }) =>
    on(h).post<Project>(`/profiles/${enc(profileId)}/projects/clone`, b),
  getProject: (h: string, id: string) => on(h).get<Project>(`/projects/${enc(id)}`),
  /** move_repo with a new repo_path moves the folder there (API 40). */
  /** `archived` archives the project or unarchives it (API 46). */
  updateProject: (h: string, id: string, b: Partial<Project> & { move_repo?: boolean; archived?: boolean }) => on(h).patch<Project>(`/projects/${enc(id)}`, b),
  deleteProject: (h: string, id: string) => on(h).del(`/projects/${enc(id)}`),
  /** Remove the worktrees of the project's done tasks that are merged and have nothing uncommitted (API 39). */
  startSetupThread: (h: string, id: string, message: string) => on(h).post<Task>(`/projects/${enc(id)}/setup-thread`, { message }),
  removeMergedWorktrees: (h: string, id: string) => on(h).post<{ results: MergedWorktreeResult[] }>(`/projects/${enc(id)}/remove-merged-worktrees`),
  /** The prompt instructions a project without its own uses (API 27). */
  defaultPrompts: (h: string) => on(h).get<Record<PromptField, string> & { summary_prompt?: string }>("/default-prompts"),
  /** The branches of the project's repository, latest first; those only on a remote named with it (API 96). */
  projectBranches: (h: string, id: string) => on(h).get<{ branches: { name: string; remote: boolean }[] }>(`/projects/${enc(id)}/branches`),
  /** What the agent of a new thread in the project is told on top of its agent's own system prompt, with these options (API 80). */
  systemPromptPreview: (h: string, id: string, q: SystemPromptOptions) =>
    on(h).get<{ text: string; runtime: Agent; permission_mode: PermissionMode }>(
      `/projects/${enc(id)}/system-prompt?${new URLSearchParams(Object.entries(q).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)]))}`,
    ),
};
