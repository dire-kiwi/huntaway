export type Resolution = "done" | "not_done" | "wont_fix";

export type Status = "todo" | "in_progress" | "needs_attention" | "in_review" | "ready_for_merge" | "done" | "backlog";

export const STATUSES: { id: Status; label: string }[] = [
  { id: "todo", label: "To do" },
  { id: "in_progress", label: "In progress" },
  { id: "needs_attention", label: "Needs attention" },
  { id: "in_review", label: "In review" },
  { id: "ready_for_merge", label: "Ready for merge" },
  { id: "done", label: "Done" },
  // Parked work: the board puts it first, in a collapsible column (see TaskBoard).
  { id: "backlog", label: "Backlog" },
];

export const PERMISSION_MODES = [
  { id: "default", label: "Ask", description: "Approve each tool call in the thread" },
  { id: "acceptEdits", label: "Accept edits", description: "Approve file edits automatically, ask for the rest" },
  { id: "auto", label: "Auto", description: "Claude's classifier approves routine actions and blocks risky ones" },
  { id: "plan", label: "Plan", description: "Explore read-only and propose a plan for approval first" },
  { id: "dontAsk", label: "Don't ask", description: "Never prompt; deny anything not already allowed" },
  { id: "bypassPermissions", label: "Bypass", description: "Approve everything without asking" },
] as const;

export type PermissionMode = (typeof PERMISSION_MODES)[number]["id"];

/** The host API version this UI was built against (server: proto::API_VERSION). */
export const UI_API_VERSION = 24;
/** Oldest host API this UI can still drive. Hosts reporting no version are 0. */
export const UI_MIN_HOST_API = 0;

/**
 * How a host's version relates to this UI:
 * ok, outdated (older but usable; newer features are hidden for it),
 * incompatible (too old for this UI), or board_outdated (the host no longer serves a UI this old).
 */
export type Compat = "ok" | "outdated" | "incompatible" | "board_outdated";

export function hostCompat(h: Host): Compat {
  if (h.local) return "ok";
  const api = h.api_version ?? 0;
  if ((h.api_compat ?? 0) > UI_API_VERSION) return "board_outdated";
  if (api < UI_MIN_HOST_API) return "incompatible";
  if (api < UI_API_VERSION) return "outdated";
  return "ok";
}

/** Hosts that don't say are assumed to be able to run agents. */
export const canRunAgents = (h: Host | undefined) => !!h && h.connected && h.agents !== false;

/** Waiting in "Ready for merge" for another task in its project to finish merging. */
export const mergeQueued = (t: Task) => !!t.merging && t.status === "ready_for_merge" && !t.running;

/** Stepped out of the merge queue to make changes, and rejoins it when its agent is done. */
export const rejoinsMerge = (t: Task) => !!t.remerge && (t.status === "in_progress" || t.status === "needs_attention");

/** Its agent is running but waiting for something (the `wait` tool), not working. */
export const agentWaiting = (t: Task) => (t.running && t.agent_wait) || null;

/** Queued in "In progress" until the tasks it depends on are merged. */
export const dependencyQueued = (t: Task) => !!t.waiting && t.status === "in_progress" && !t.running && !t.limit_reset_at;

/** Queued in "In progress" until its config's usage limit resets (API 81), when its agent carries on. */
export const limitQueued = (t: Task) => !!t.waiting && t.status === "in_progress" && !t.running && !!t.limit_reset_at;

/** Its agent stopped because its config ran out of usage, which hasn't reset yet: it can wait for the reset (API 81). */
export const outOfUsage = (t: Task, now = Date.now()) => !t.waiting && !t.running && !!t.limit_reset_at && new Date(t.limit_reset_at).getTime() > now;

/** The API that tells when a config is out of usage and holds tasks until it resets. */
export const LIMITS_API = 81;

/** Whether a task counts as merged for the tasks that depend on it (server: db::is_merged). */
/** Whether new tasks in the project get their own worktree: only once its repo is a git repository. */
export const worktreesOn = (p: Project) => p.use_worktrees && p.is_git !== false;

/** Whether the project wants worktrees but its folder can't have them yet (not a git repository, or one with no
 * commit to branch from), so the board shows its setup thread instead of its tasks (API 73). */
export const needsWorktreeSetup = (p: Project, h: Host | undefined) => hostSupports(h, 73) && p.use_worktrees && !(p.is_git && p.has_commits);

export const isMerged = (t: Task) => t.status === "done" && (t.resolution ?? "done") === "done";

/** How long a task stays in Done before it's archived. */
export const ARCHIVE_AFTER_MS = 2 * 24 * 3600_000;

/** Done for ARCHIVE_AFTER_MS by `now`: off the kanban board, in the list view's Archived section. Hosts
 *  before API 53 don't say when a task was done, so the last time it changed stands in. */
export const isArchived = (t: Task, now: number) => {
  const since = t.status === "done" ? t.done_at ?? (t.done_at === undefined ? t.updated_at : null) : null;
  return !!since && Date.parse(since) <= now - ARCHIVE_AFTER_MS;
};

/** In review, and the agent hasn't gone back to work since: its review passed, or it wasn't
 * reviewed (the project doesn't review automatically, it has no code changes, or it isn't in a
 * project). One being reviewed, or whose review found issues or didn't finish, isn't ready yet. */
export const readyToCheck = (t: Task) => t.status === "in_review" && !t.running && (!t.review || t.review.state === "passed");

/** Statuses a host knows about ("Ready for merge" needs API 4). */
export const hostStatuses = (h: Host | undefined) =>
  STATUSES.filter((s) => (s.id !== "ready_for_merge" || hostSupports(h, 4)) && (s.id !== "backlog" || hostSupports(h, 5)));

/** Whether a host's API is at least `minApi`. */
export const hostSupports = (h: Host | undefined, minApi: number) => !!h && (h.local || (h.api_version ?? 0) >= minApi);

/** Whether a message sent to the task's running agent goes to it straight away (see runner::steer)
 *  rather than being queued for when its run ends. Hosts before API 30 don't say, and from API 28
 *  most runs take them. */
export const runningAgentSteers = (h: Host | undefined, t: Task) => (hostSupports(h, 30) ? !!t.steerable : hostSupports(h, 28));

/** The Stop button's title for the task's running agent. */
export const stopTitle = (t: Task, steers: boolean) =>
  t.queued_message
    ? "Stop and send the queued message now"
    : !steers
      ? "Stop the agent"
      : t.steering?.length
        ? "Stop: the agent ends its turn, then reads your message"
        : "Stop: the agent ends its turn, and you can reply to carry on";

/** A machine running Huntaway. Every profile, project and task lives on exactly one. */
export interface Host {
  id: string;
  name: string;
  /** The host this UI is served from. */
  local: boolean;
  connected: boolean;
  /** local, outbound (we connect to it), inbound (it dials us) or ssh (we start it and tunnel to it). */
  mode: "local" | "outbound" | "inbound" | "ssh";
  /** Whether it can run agents (false for a hub that only shows other hosts). */
  agents?: boolean;
  url?: string | null;
  version?: string;
  api_version?: number;
  api_compat?: number;
  /** Commit the host runs, if it runs from a git checkout. */
  commit?: string | null;
  last_seen?: string | null;
  /** When the hub last heard from a connected host (API 78); pings keep it within about 20s. */
  last_message_at?: string;
}

export interface Profile {
  /** Set by the UI from the host it was loaded from. */
  host_id: string;
  id: string;
  name: string;
  /** The Claude configs its threads can use, the default first (API 20). */
  claude_config_ids?: string[];
  /** The default config's directory (before API 20, the profile's only one). */
  claude_config_dir: string;
  default_model: string | null;
  /** Other profiles (by name, `*` for all) whose agents may use this profile's board through their board tools (API 23). */
  agent_access?: string[];
  /** The GitHub account its agents' gh tools act as on this host: a login, or `HOST/LOGIN`; null is gh's active account (API 50). */
  github_account?: string | null;
  /** The folder the new project dialog's GitHub tab clones repositories into on this host; null is `~/<name>` (API 55). */
  clone_dir?: string | null;
  /** Who its Asana token is for, when it's connected to Asana on this host (API 57). Set with `asana_token`, which is never sent back. */
  asana_user?: string | null;
  /** Whether it uses Asana (API 60; missing is on): off, the board leaves Asana out and the host won't search it. The token is kept. */
  asana_enabled?: boolean;
  /** A task whose config runs out of usage waits for the limit to reset and then carries on (API 81). */
  limit_wait?: boolean;
  /** A task that hasn't started yet starts on the next of its configs with room when its own is out of usage (API 81). */
  limit_switch?: boolean;
  created_at: string;
}

/** A task elsewhere (only Asana's so far) that a task is for (API 57). */
export interface ExternalLink {
  provider: "asana";
  /** Its id there (an Asana task's gid). */
  id: string;
  url: string;
  /** Its name there, when it was linked. */
  title: string;
}

/** An Asana task, as a profile's Asana search finds it (API 57). */
export interface AsanaTask {
  gid: string;
  name: string;
  url: string;
  completed: boolean;
  /** Its description, as plain text. */
  notes: string;
  assignee: string | null;
  projects: string[];
  workspace: string | null;
}

export const asanaLink = (t: AsanaTask): ExternalLink => ({ provider: "asana", id: t.gid, url: t.url, title: t.name });

/** A GitHub repository gh can reach on a host, which a new project can be cloned from (API 55). */
export interface GithubRepo {
  /** `OWNER/NAME`. */
  full_name: string;
  name: string;
  description: string | null;
  private: boolean;
  fork: boolean;
  archived: boolean;
  pushed_at: string | null;
  url: string | null;
}

/** The repositories an account can clone, or why there are none (`error`). `account` is who gh acts as. */
export interface GithubRepoList {
  account: string | null;
  repos: GithubRepo[];
  error: string | null;
}

/** A GitHub account gh is signed in to on a host (API 50). `account` is what a profile or project saves. */
export interface GithubAccount {
  account: string;
  host: string;
  login: string;
  /** The account gh uses by default on its host. */
  active: boolean;
  /** Whether gh's login for it works. */
  ok: boolean;
}

/** A Claude Code config directory (login, settings, history) on a host (API 20). Profiles and projects pick from them. */
export interface ClaudeConfig {
  /** Set by the UI from the host it was loaded from. */
  host_id: string;
  id: string;
  name: string;
  /** Passed as CLAUDE_CONFIG_DIR (CODEX_HOME for Codex); blank is the agent's default (~/.claude, ~/.codex). */
  config_dir: string;
  /** Which agent CLI runs its threads (API 25); older hosts only run Claude Code. */
  agent?: Agent;
  /** Whether the host fetches its plan's usage limits for the sidebar (API 52). Older hosts fetch every config's. */
  show_usage?: boolean;
  created_at: string;
}

export const AGENTS = [
  { id: "claude", label: "Claude Code", dir: "~/.claude", env: "CLAUDE_CONFIG_DIR" },
  { id: "codex", label: "Codex", dir: "~/.codex", env: "CODEX_HOME" },
] as const;
export type Agent = (typeof AGENTS)[number]["id"];
export const agentOf = (c: Pick<ClaudeConfig, "agent"> | undefined): Agent => c?.agent ?? "claude";
export const agentInfo = (a: Agent) => AGENTS.find((x) => x.id === a)!;

/** A model a Codex config offers (API 25). */
export interface AgentModel {
  id: string;
  name: string;
  is_default: boolean;
  efforts: string[];
  default_effort: string | null;
}

/** One of a profile's Claude plan limits (API 9). */
export interface UsageLimit {
  /** `session`, `weekly`, or `weekly:<model>`. */
  id: string;
  label: string;
  /** 0–100, how much of the limit is used. */
  percent: number;
  resets_at: string | null;
}

/** The user's activity on a profile's threads in a time range (API 16). Review threads count as the task they review. */
export interface AnalyticsReport {
  /** `prompt` was typed by the user; `start` started a task; `merge` moved it to Ready for merge. */
  events: { at: string; task_id: string; kind: "prompt" | "start" | "merge"; text: string }[];
  /** Agent runs overlapping the range; `ended_at` is null while one is going. */
  runs: { task_id: string; kind: string; started_at: string; ended_at: string | null }[];
  tasks: { id: string; project_id: string | null; kind: string; number: number; title: string; status: Status }[];
  projects: { id: string; name: string; key: string }[];
}

/** Bytes on disk and the number of files, as `du` counts them. */
export interface DiskSize {
  bytes: number;
  files: number;
}

/** How much space a profile's projects take up on a host (API 35). */
export interface DiskUsageReport {
  projects: {
    id: string;
    name: string;
    key: string;
    repo_path: string;
    /** The repository folder, `.git` included; null when it's gone. */
    repo: DiskSize | null;
    git: DiskSize | null;
    /** Task worktrees, biggest first. `task_id` is null for a worktree of the repository, in the worktrees folder, that no task on the host has. */
    worktrees: { task_id: string | null; kind: string | null; number: number | null; title: string | null; status: Status | null; path: string; size: DiskSize }[];
    /** The scratch folder and the rest of the project's data folder. */
    other: DiskSize;
    /** Its tasks' agent runs' folders (API 59). */
    runs?: DiskSize;
  }[];
  /** The profile's own scratch folder. */
  scratch: DiskSize;
  /** The agent runs' folders of the profile's tasks in no project (API 59). */
  runs?: DiskSize;
  /** How many days a finished run's folder is kept (API 59). */
  runs_kept_days?: number;
  /** What the host's database takes up, every profile's data together (API 59). */
  database?: number | null;
  /** The disk the host's data dir is on. */
  filesystem: { total: number; free: number } | null;
  elapsed_ms: number;
}

/** A Claude login's subscription usage (API 9): per Claude config from API 20, per profile before. */
export interface Usage {
  /** Set by the UI from the host it was loaded from. */
  host_id: string;
  config_id?: string;
  profile_id?: string;
  limits: UsageLimit[];
  plan: string | null;
  updated_at: string | null;
  /** Why the last check failed; `limits` may still hold older numbers. */
  error: string | null;
  /** Until when it's out of usage: a run on it was refused for its limit, which resets then (API 81). */
  out_until?: string | null;
}

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
  /** Who reviews each task, each in its own review thread; empty is one reviewer with the task's config (API 29). */
  reviewers?: Reviewer[];
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
}

export type ReviewState = "running" | "passed" | "issues" | "failed" | "stopped";

/** One reviewer's part of a review (API 29). */
export interface ReviewerRun {
  thread_id: string;
  /** Which agent reviews, e.g. "Codex · gpt-5.1"; blank in reviews from before API 29. */
  label: string;
  state: ReviewState;
  summary: string | null;
  issues: string[];
}

/** A task's latest automatic review (API 12). With several reviewers, the rest combines their parts. */
export interface Review {
  /** The (first) review thread: a task of kind "review" whose parent is the reviewed task. */
  thread_id: string;
  state: ReviewState;
  /** The commit reviewed. */
  head: string | null;
  summary: string | null;
  /** Serious issues, sent to the task's agent to fix. */
  issues: string[];
  /** Reviews in a row that sent issues back to the agent. */
  fixes: number;
  updated_at: string;
  /** Each reviewer's part (API 29). */
  reviewers?: ReviewerRun[];
}

/** A message sent to a running agent, until it reads it (API 28). */
export interface Steer {
  id: string;
  text: string;
  from_agent?: boolean;
}

/** What an agent waiting in the `wait` tool is waiting for (API 36). */
export interface AgentWait {
  reason?: string | null;
  since: string;
  /** When the wait ends at the latest. */
  until: string;
  /** Tasks whose next change of status ends it. */
  tasks?: { id: string; key: string; status: Status }[];
  /** A shell command whose exit ends it (API 41). */
  command?: string | null;
  /** A pull request whose news ends it (API 62): the `events` it picked of its checks failing or passing, comments
   *  and reviews, and a conflict, and always its being merged or closed. */
  pull_request?: { url: string; repo: string; number: number; events: PrWaitEvent[] } | null;
}

export type PrWaitEvent = "checks_failed" | "checks_passed" | "comments" | "conflicts";

export { documentsOnly, LABELS, taskLabels, type DocumentType } from "./labels";
import type { DocumentType } from "./labels";

/** Hosts from this API version on take labels (before, the board made a task of a label's type instead). */
export const LABELS_API = 71;

/** What a task is, if not a code task: a scratch task (in no project, API 47, or in one, API 51). On hosts before API 71,
 *  also a plan, artifact or diagram task. */
export type TaskType = "scratch";

/** A scratch task: its agent works in the task's own folder, with no worktree, on whatever it's asked. In no project
 *  it has no repository (API 47); in a project (API 51) it reads the project's. */
export const isScratch = (t: Pick<Task, "kind" | "task_type">) => t.kind === "task" && t.task_type === "scratch";

/** Where the task's agent works, if not where its kind and project say and the folder is one to show: one in the host's
 *  data dir (a task that makes only documents) is given relative to it. */
export const ownWorkDir = (t: Pick<Task, "work_dir">) => (t.work_dir && /^[/~]/.test(t.work_dir) ? t.work_dir : null);

/** One version of a task's document for one of its labels; `open` while the agent's turn is still writing it. */
export interface DocumentVersion {
  version: number;
  open: boolean;
  created_at: string;
  updated_at: string;
  size: number;
}

export interface TaskDocument {
  /** Which of its labels' documents it is (API 71). */
  label?: DocumentType;
  /** Where the agent writes it, on the task's host. */
  file: string | null;
  versions: DocumentVersion[];
  /** The version `content` is, or null before the agent has written anything. */
  version: number | null;
  content: string | null;
}

export interface Task {
  host_id: string;
  id: string;
  profile_id: string;
  project_id: string | null;
  /** `scratch` for scratch chats, on hosts before API 47 (they're scratch tasks since). */
  kind: "task" | "scratch" | "review";
  /** For a review thread, the task it reviews (API 12). For a task, the subproject it's in (API 17). */
  parent_id?: string | null;
  /** A subproject: it has its own board of tasks, which branch from and merge into its branch (API 17). */
  subproject?: boolean;
  /** A group task: in no project, it plans the work of the group's projects and creates their tasks (API 34). */
  group_name?: string | null;
  /** The task whose agent created this one (API 34). */
  created_by?: string | null;
  /** What the task is, if not a code task: a scratch task (API 47). On hosts before API 71, also a plan, artifact or
   *  diagram task (API 42), whose agent writes a document the board keeps and shows: see `taskLabels`. */
  task_type?: TaskType | DocumentType | null;
  /** The documents its agent writes besides its other work, each shown in a tab of the task (API 71). */
  labels?: DocumentType[];
  /** When one of its documents last changed (API 42). */
  document_at?: string | null;
  /** Where a scratch task made from a scratch chat works: the chat's folder (API 47). For a task that makes only
   *  documents, its own folder, relative to the host's data dir (API 71): see `ownWorkDir`. */
  work_dir?: string | null;
  number: number;
  title: string;
  /** Renamed by hand, so it keeps its title; otherwise each message the user sends re-titles it (API 49). */
  title_pinned?: boolean;
  description: string;
  status: Status;
  /** How a done task ended; set only while it's done (API 19). */
  resolution?: Resolution | null;
  /** When it moved into Done; set only while it's done (API 53). See isArchived. */
  done_at?: string | null;
  position: number;
  use_worktree: boolean;
  worktree_path: string | null;
  branch: string | null;
  base_branch: string | null;
  worktree_state: "none" | "setting_up" | "ready" | "tearing_down" | "error";
  worktree_error: string | null;
  session_id: string | null;
  running: boolean;
  /** When its agent started working, kept across queued messages (API 15). */
  run_started_at?: string | null;
  /** Its agent is merging it (moved to "Ready for merge" and not done yet). Hosts before API 4 omit it. */
  merging?: boolean;
  /** Its agent stepped out of the merge queue to make changes; it rejoins the queue when the agent is done (API 69). */
  remerge?: boolean;
  attention_reason: string | null;
  /** Tasks (ids) in the same project that have to be merged before its agent starts (API 24). */
  depends_on?: string[];
  /** Queued in "In progress": its agent starts once every task in `depends_on` is merged (API 24), or once `limit_reset_at` has passed. */
  waiting?: boolean;
  /** When the usage limit its agent last ran out of resets; cleared when it runs again (API 81). See `limitQueued`, `outOfUsage`. */
  limit_reset_at?: string | null;
  /** Its running agent is waiting (the `wait` tool) rather than working; it stays in its column (API 36). Not `waiting`. */
  agent_wait?: AgentWait | null;
  /** Sent while the agent was running; goes out when the run ends or is stopped (API 10). */
  queued_message?: string | null;
  /** Sent to the running agent, which hasn't read them yet; each goes in the thread where it does (API 28). */
  steering?: Steer[];
  /** While it runs: its agent takes messages as it works (see `steering`) rather than queueing them (API 30). */
  steerable?: boolean;
  model: string | null;
  /** Overrides the host's default effort when set (API 14). */
  effort?: Effort | null;
  /** Overrides the project's (or host's) permission mode when set. */
  permission_mode: PermissionMode | null;
  /** The Claude config it runs with, picked when it's created (API 20). */
  claude_config_id?: string | null;
  auto_allow: string[];
  /** Where the work can be tried, e.g. its PR's preview deployment (API 8). */
  preview_url?: string | null;
  /** Its pull request, set by its agent or found with `gh` (API 26). */
  pr_url?: string | null;
  /** The tasks elsewhere (Asana) it's for (API 57). */
  external_links?: ExternalLink[];
  /** Shared by the tasks made together from one prompt, each run by another agent (a model or config) (API 61). */
  fanout_id?: string | null;
  /** Listed in the sidebar's Starred section (API 48). */
  starred?: boolean;
  /** When to remind the user of it (API 48): listed under Reminders in the sidebar, due from then on. */
  remind_at?: string | null;
  /** What the reminder is for (API 48). */
  reminder?: string | null;
  /** The latest automatic review of its work (API 12). */
  review?: Review | null;
  /** How full its agent's context window is, as of its latest reply (API 40). */
  context?: ContextSummary | null;
  /** The conversation rollback its agent's next run makes, after a rewind (API 70). */
  rewind?: PendingRewind | null;
  cost_usd: number;
  last_activity_at: string;
  created_at: string;
  updated_at: string;
}

export interface ContextSummary {
  /** Tokens in the context window as of the agent's latest reply. */
  tokens: number;
  /** The model's context window, once known. */
  max_tokens: number | null;
  /** Where Claude Code compacts the session by itself, if it does. */
  compact_at: number | null;
  model: string | null;
  updated_at: string;
  /** When the breakdown (`api.context`) was taken, if there is one. */
  detail_at: string | null;
}

/** A row of Claude Code's `/context` breakdown. */
export interface ContextCategory {
  id: string;
  name: string;
  tokens: number;
  /** used, deferred (listed, loaded on demand), buffer (kept free for compacting) or free. */
  kind?: "used" | "deferred" | "buffer" | "free";
  isDeferred?: boolean;
}

/** Claude Code's answer to `get_context_usage`: what `/context` shows. */
export interface ContextDetail {
  categories: ContextCategory[];
  totalTokens: number;
  maxTokens: number;
  model?: string;
  autoCompactThreshold?: number;
  isAutoCompactEnabled?: boolean;
  memoryFiles?: { path: string; type: string; tokens: number }[];
  mcpTools?: { name: string; serverName: string; tokens: number; isLoaded?: boolean }[];
  agents?: { agentType: string; source: string; tokens: number }[];
  skills?: { totalSkills: number; includedSkills: number; tokens: number; skillFrontmatter?: { name: string; source: string; tokens: number }[] };
  messageBreakdown?: {
    toolCallTokens: number;
    toolResultTokens: number;
    attachmentTokens: number;
    assistantMessageTokens: number;
    userMessageTokens: number;
    toolCallsByType?: { name: string; callTokens: number; resultTokens: number }[];
    attachmentsByType?: { name: string; tokens: number }[];
  };
}

export interface Message {
  id: number;
  task_id: string;
  /** `question`: one asked with request_user_input (API 64). */
  kind: "user" | "claude" | "event" | "permission" | "question";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any;
  created_at: string;
}

/** One page of a thread (API 56): see `api.messagePage`. */
export interface MessagePage {
  messages: Message[];
  /** There are older messages than these (after `after`, if given). */
  more: boolean;
  /** For the latest page (no `before` or `after`): what lists the subagents started before it, cut down (db::subagent_messages on the server). */
  subagents: Message[];
}

export interface DiffResult {
  available: boolean;
  reason?: string;
  dir?: string;
  base?: string | null;
  merge_base?: string | null;
  commits?: string;
  stat?: string;
  patch?: string;
  untracked?: string[];
}

/** A file with changes, as in `git status --short`: its index (`x`) and working tree (`y`) state (API 62). */
export interface GitFile {
  path: string;
  /** Where a renamed or copied file came from. */
  orig_path: string | null;
  /** `M`, `A`, `D`, `R`, `C`, `T`, a space for none, `?` for untracked, `U` (and `AA`, `DD`) for a conflict. */
  x: string;
  y: string;
}

export interface GitCommit {
  sha: string;
  subject: string;
  author: string;
  /** Unix seconds. */
  time: number;
  /** Made on the task's branch (after where it left its base), as opposed to before it. */
  on_branch: boolean;
  /** Not on the branch's upstream yet. */
  unpushed: boolean;
}

export interface GitStash {
  index: number;
  sha: string;
  subject: string;
  time: number;
}

/** A conversation rollback waiting for a task's next run (API 70): it goes on from before turn `turn`. */
export interface PendingRewind {
  turn: number;
  message_id: number;
  session: string;
}

/** What a turn changed, without the files git brought in by a merge, pull or rebase (API 70). */
export interface TurnStats {
  files: number;
  additions: number;
  deletions: number;
  /** The files left out (the first 200), and how many. */
  excluded: string[];
  excluded_count: number;
}

/** One of the agent's turns with a checkpoint after it (API 70). */
export interface Turn {
  /** Its number among the task's turns. */
  turn: number;
  /** Its checkpoint, and the one it started from (null when there's none, as for a turn from before checkpoints). */
  n: number;
  before_n: number | null;
  run_id: string | null;
  /** The user message it started with, and its text. */
  message_id: number | null;
  text: string;
  auto: boolean;
  /** Set for a round of fixes a review sent back. */
  review_round: number | null;
  /** done, stopped or failed */
  status: string | null;
  /** A rewind has gone back to before it. */
  stale: boolean;
  /** When it ended. */
  at: string;
  /** HEAD after it, and before it. */
  head: string | null;
  before_head: string | null;
  stats: TurnStats | null;
  /** Both of its checkpoints are there to diff. */
  diff: boolean;
  /** Whether the task can be rewound to before it, and its agent's conversation with it (`fresh`: it starts over). */
  rewind: { ok: true; conversation: { ok: true; fresh: boolean } | { ok: false; reason: string } } | { ok: false; reason: string };
}

export interface TurnsResult {
  available: boolean;
  reason?: string;
  turns: Turn[];
  head?: string | null;
  rewind?: PendingRewind | null;
  agent?: "claude" | "codex";
}

export interface TurnDiff {
  patch: string;
  too_large: boolean;
  stats: TurnStats;
  excluded: string[];
}

export interface RewindResult {
  task: Task;
  written: number;
  removed: number;
  /** Files left as they were: submodules, and ones marked skip-worktree or assume-unchanged. */
  skipped: string[];
  branch: { from: string; to: string } | null;
  /** The ref the replaced files are kept in. */
  kept: string;
  /** The message rewound to, to edit and send again. */
  message: { text: string | null; auto: boolean };
}

/** The Changes tab's view of a task's repository (API 62). */
export interface GitStatus {
  available: boolean;
  reason?: string;
  /** The top of the working tree. */
  dir?: string;
  /** Where the project's folder is in it (`web/`) when it's only part of the repository: the files and commits are its own (API 77). */
  folder?: string | null;
  /** Null before the first commit. */
  head?: string | null;
  /** Null when detached. */
  branch?: string | null;
  upstream?: string | null;
  ahead?: number;
  behind?: number;
  base?: string | null;
  merge_base?: string | null;
  /** What the repository is in the middle of: `merging`, `rebasing`, `cherry-picking` or `reverting`. */
  state?: string | null;
  files?: GitFile[];
  /** There were more files than were listed. */
  truncated?: boolean;
  commits?: GitCommit[];
  stashes?: GitStash[];
}

export interface GitCommitShown {
  sha: string;
  author: string;
  email: string;
  time: number;
  message: string;
  patch: string;
}

export interface RestartJob {
  phase: "starting" | "building_ui" | "building_server" | "restarting" | "failed";
  log: string;
  error: string | null;
}

export interface ServerStatus {
  boot_id: string;
  started_at: string;
  source_dir: string | null;
  running_commit: string | null;
  running_agents: number;
  restart: RestartJob | null;
  source_commit?: string | null;
  source_branch?: string | null;
  dirty?: boolean;
  /** `<short sha> <subject>` for commits in the checkout that this server isn't running yet. */
  new_commits?: string[];
  /** API 65, with `--update-from`: the deployment this host follows, and what it last said it runs. */
  update_from?: string;
  deployed?: { commit: string | null; checked_at: string; error: string | null } | null;
  /** `<short sha> <subject>` for the deployed commits this server isn't running (when it's ahead of it). */
  deployed_commits?: string[];
}

export interface DirListing {
  path: string;
  parent: string | null;
  /** API 11+: false for a folder that doesn't exist yet (it's created with the project). */
  exists?: boolean;
  is_git: boolean;
  /** `hidden` (dot folders) is API 11+; older hosts leave them out. */
  entries: { name: string; path: string; is_git: boolean; hidden?: boolean }[];
}

const TOKEN_KEY = "ia.token";

export function getToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

export function setToken(t: string) {
  try {
    localStorage.setItem(TOKEN_KEY, t);
  } catch {
    /* ignore */
  }
}

const MOVES_KEY = "ia.movedHere";
/** How long a move made in this browser keeps its notification away (see movedHere). */
const MOVE_MS = 15_000;

/** The columns tasks were moved to from this browser lately, and when, by `host:id`; kept for every tab. */
function readMoves(): Record<string, { status: Status; at: number }> {
  try {
    return JSON.parse(localStorage.getItem(MOVES_KEY) ?? "{}") ?? {};
  } catch {
    return {};
  }
}

function noteMove(h: string, id: string, status: Status) {
  const now = Date.now();
  const moves = Object.fromEntries(Object.entries(readMoves()).filter(([, m]) => now - m.at < MOVE_MS));
  moves[`${h}:${id}`] = { status, at: now };
  try {
    localStorage.setItem(MOVES_KEY, JSON.stringify(moves));
  } catch {
    /* then it may notify of the move */
  }
}

/** Whether a tab of this browser moved task `id` on host h to `status` in the last few seconds: nobody needs telling of their own moves. */
export function movedHere(h: string, id: string, status: Status) {
  const m = readMoves()[`${h}:${id}`];
  return !!m && m.status === status && Date.now() - m.at < MOVE_MS;
}

/** Pick up `?token=` from the URL (Electron and shared links pass it this way). */
export function captureTokenFromUrl() {
  const url = new URL(window.location.href);
  const t = url.searchParams.get("token");
  if (t) {
    setToken(t);
    url.searchParams.delete("token");
    window.history.replaceState(null, "", url.pathname + url.search + url.hash);
  }
}

// Whether this board handed out its token last time ("1") or not ("0"), so that a load with a token stored needn't wait
// for /api/open-token, nor ask a board that doesn't hand it out (and have the browser log the 404).
const OPEN_KEY = "ia.openBoard";
const openFlag = () => {
  try {
    return localStorage.getItem(OPEN_KEY);
  } catch {
    return null;
  }
};
let openBoard = openFlag() === "1";

/** Whether this board hands out its token (`--open-token`), as PR previews do and the user's own boards never do. */
export const isOpenBoard = () => openBoard;

/** Whether to ask for the open token on this load: always without a token, else unless the board didn't hand it out before. */
export const shouldFetchOpenToken = () => !getToken() || openFlag() !== "0";

let fetching: Promise<boolean> | null = null;
/**
 * Servers started with `--open-token` (PR previews) hand out their token; sign in with it. Resolves to whether that
 * changed the token (a rebuilt preview's is new). Calls made at once share one request.
 */
export function fetchOpenToken(): Promise<boolean> {
  return (fetching ??= (async () => {
    try {
      const res = await fetch("/api/open-token");
      const data = res.ok ? await res.json() : null;
      if (typeof data?.token === "string" && data.token) {
        openBoard = true;
        remember("1");
        if (data.token === getToken()) return false;
        setToken(data.token);
        return true;
      }
      if (res.status === 404) {
        openBoard = false;
        remember("0");
      }
    } catch {
      /* not offered */
    }
    return false;
  })().finally(() => (fetching = null)));
}

function remember(open: "0" | "1") {
  try {
    localStorage.setItem(OPEN_KEY, open);
  } catch {
    /* asked again next time */
  }
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Called when the server turns down a request, with the token it was made with and the request's path (see unauthorizedHere). */
let onUnauthorized: (token: string, path: string) => void = () => {};
export function setUnauthorizedHandler(fn: (token: string, path: string) => void) {
  onUnauthorized = fn;
}

/**
 * Whether a 401 for `path` means this board's token is wrong: a request to this hub, or to its own host
 * through it. A linked host answers 401 when the link's token no longer matches its own (its data dir
 * was made again, say), which is that host's trouble, not a reason to sign the user out of the board.
 */
export function unauthorizedHere(path: string, localHostId: string | null): boolean {
  const m = /^\/h\/([^/?#]+)/.exec(path);
  return !m || (localHostId !== null && decodeURIComponent(m[1]) === localHostId);
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = getToken();
  const res = await fetch(`/api${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    onUnauthorized(token, path);
    throw new ApiError(401, "Unauthorized");
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data?.error ?? res.statusText);
  return data as T;
}

const get = <T>(p: string) => request<T>("GET", p);
const post = <T>(p: string, b: unknown = {}) => request<T>("POST", p, b);
const patch = <T>(p: string, b: unknown) => request<T>("PATCH", p, b);
const del = <T>(p: string) => request<T>("DELETE", p);

/** An id in a path. */
const enc = encodeURIComponent;

/** Requests for one host, through this node's hub (`/api/h/<host>/...`). */
const on = (h: string) => ({
  get: <T>(p: string) => get<T>(`/h/${enc(h)}${p}`),
  post: <T>(p: string, b: unknown = {}) => post<T>(`/h/${enc(h)}${p}`, b),
  patch: <T>(p: string, b: unknown) => patch<T>(`/h/${enc(h)}${p}`, b),
  del: <T>(p: string) => del<T>(`/h/${enc(h)}${p}`),
});

/** A file saved on a host for prompts to refer to (see attachments.ts). */
export interface Attachment {
  id: string;
  name: string;
  /** Where it is on the host; prompts list it for the agent to read. */
  path: string;
  size: number;
  mime: string;
}

/** A skill for one project's agents, or a global one (API 22) that profiles and projects switch on. */
export interface ProjectSkill {
  id: string;
  /** null for a global skill. */
  project_id: string | null;
  name: string;
  description: string;
  /** The whole SKILL.md, frontmatter included. */
  content: string;
  /** Only means something for a project's own skill; global ones are switched per profile and project. */
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

/** An `mcpServers` entry, as in `.mcp.json`. */
export interface McpServerConfig {
  type?: "stdio" | "http" | "sse";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  [key: string]: unknown;
}

/** An MCP server for one project's agents, or a global one (API 22). */
export interface ProjectMcpServer {
  id: string;
  /** null for a global server. */
  project_id: string | null;
  name: string;
  config: McpServerConfig;
  enabled: boolean;
  /** Its tools run without asking. */
  auto_allow: boolean;
  created_at: string;
  updated_at: string;
}

/** A skill the user can call in a message to a task's agent: `/name` for Claude Code, `$name` for Codex (API 54). */
export interface TaskSkill {
  name: string;
  /** Blank when the host can't find its `SKILL.md` (skills bundled with Claude Code). */
  description: string;
}

export interface TaskSkills {
  agent: Agent;
  skills: TaskSkill[];
}

/** Skills and MCP servers a project's agent runs with one Claude config had, each with when a run last reported it. */
export interface SeenTools {
  skills: { name: string; at: string }[];
  mcp_servers: { name: string; status?: string; source?: string; at: string }[];
  /** The last run. */
  at: string;
}

export interface AgentTools {
  skills: ProjectSkill[];
  mcp_servers: ProjectMcpServer[];
  /** Skills and servers from Claude configs, plugins or the repository that the project turns off. */
  disabled_skills: string[];
  disabled_mcp_servers: string[];
  /** By Claude config id ("" for Claude's default). */
  seen: Record<string, SeenTools>;
  /** The host's global skills and servers (API 22). */
  global_skills?: ProjectSkill[];
  global_mcp_servers?: ProjectMcpServer[];
  /** Whether each global one is on by default in the project's profile, by id (unset: off). */
  profile_switches?: Record<string, boolean>;
  /** The project's overrides of those, by id (unset: the profile's default). */
  project_switches?: Record<string, boolean>;
}

/** A host's global skills and MCP servers, and each profile's defaults for them (API 22). */
export interface GlobalAgentTools {
  skills: ProjectSkill[];
  mcp_servers: ProjectMcpServer[];
  /** Profile id → item id → on (unset: off). */
  profile_switches: Record<string, Record<string, boolean>>;
}

/** What starts an automation (API 63): an interval, a time of day (in the host's time zone) on some weekdays, or a webhook delivery. */
export type AutomationTrigger =
  | { kind: "interval"; every_minutes: number }
  | { kind: "daily"; time: string; weekdays: Weekday[] }
  | { kind: "webhook"; filters: AutomationFilter[]; coalesce_seconds: number; coalesce_key: string };

export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export const FILTER_OPS = ["equals", "not_equals", "starts_with", "contains", "in", "not_in", "exists", "not_exists"] as const;
export type FilterOp = (typeof FILTER_OPS)[number];

/** A condition on a webhook delivery: `path` names a value as templates do (`event`, `action`, `labels`, `body.issue.title`…). */
export interface AutomationFilter {
  path: string;
  op: FilterOp;
  /** A string, or a list (or comma-separated string) for `in` and `not_in`. */
  value: string | string[] | null;
}

/** What an automation does: create a task in its project from templates, or send a message to one of its tasks. */
export type AutomationAction =
  | {
      kind: "create_task";
      title: string;
      description: string;
      /** A label as its type, in an action saved before API 71. */
      task_type: TaskType | DocumentType | null;
      /** API 71. */
      labels?: DocumentType[];
      claude_config_id: string | null;
      model: string | null;
      effort: string | null;
      status: "todo" | "backlog";
      start: boolean;
    }
  | { kind: "send_to_task"; task_id: string; message: string };

export type AutomationRunStatus = "pending" | "coalesced" | "running" | "ok" | "failed" | "skipped" | "filtered" | "duplicate" | "rejected";

/** A run of an automation, or a webhook delivery that didn't make one. */
export interface AutomationRun {
  id: string;
  automation_id: string;
  source: "schedule" | "webhook" | "manual";
  status: AutomationRunStatus;
  detail: string | null;
  task_id: string | null;
  /** The task it created or messaged, if it's still there. */
  task?: { key: string; title: string; status: Status };
  delivery_id: string | null;
  /** A delivery's event and action, e.g. `issues.opened`. */
  event: string | null;
  /** Deliveries coalesced into it. */
  count: number;
  batch_id: string | null;
  due_at: string | null;
  created_at: string;
  finished_at: string | null;
}

/** A project's automation (API 63). */
export interface Automation {
  id: string;
  project_id: string;
  name: string;
  enabled: boolean;
  trigger: AutomationTrigger;
  action: AutomationAction;
  /** When its schedule next runs; null for a webhook, or while it's off. */
  next_run_at: string | null;
  last_run_at: string | null;
  created_at: string;
  updated_at: string;
  /** A webhook's path on its host (`/api/hooks/<id>/<token>`). */
  hook_path?: string;
  /** Whether a webhook checks deliveries' signatures (the secret itself is never sent back). */
  has_secret?: boolean;
  last_run: AutomationRun | null;
}

export interface AutomationInput {
  name?: string;
  enabled?: boolean;
  trigger?: AutomationTrigger;
  action?: AutomationAction;
  /** A webhook's signing secret; "" removes it. */
  secret?: string;
  /** A new webhook URL (the old one stops working). */
  rotate_token?: boolean;
}

/** Agent defaults for a host. */
export interface HostSettings {
  /** Used when the thread, project and profile don't pick a model. */
  default_model: string | null;
  default_effort: Effort | null;
  /** Used when the thread and project don't pick a mode (API 2). */
  default_permission_mode?: PermissionMode | null;
  /** On a board that can't run agents: the linked host its scratch tasks go to (API 6). */
  scratch_host?: string | null;
  /** TUI programs offered as shortcuts in task terminals (API 13). New ones get an id when saved. */
  terminal_tools?: TerminalTool[];
  /** Where the host is reached from outside, which its webhook URLs are shown with (API 63). */
  public_url?: string | null;
}

/** A program run in its own tmux session in a task's directory, e.g. `lazygit` (API 13). */
export interface TerminalTool {
  id: string;
  name: string;
  command: string;
}

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

export const MODEL_ALIASES = ["fable", "opus", "sonnet", "haiku"];

/** A task's tmux terminal on its host (API 7). */
export interface TerminalStatus {
  /** False when the host has no tmux. */
  available: boolean;
  /** Whether the session exists (it outlives the browser and the server). */
  running: boolean;
  cwd?: string | null;
  reason?: string;
  /** The tool this session runs, when asked for one (API 13). */
  tool?: TerminalTool | null;
}

/** What an agent asked to change about a project, shown to the user to approve (API 44). */
export interface ProjectChange {
  project: { id: string; key: string; name: string; host?: string };
  /** The thread that asked. */
  task: { id: string; key?: string; title: string } | null;
  /** Each setting it changes. */
  changes: { field: string; from: unknown; to: unknown; needs_approval: boolean }[];
  /** Why, in the agent's words. */
  reason?: string | null;
}

/** A project an agent asked to add, shown to the user to approve: the folder its agents would work in (API 76). */
export interface ProjectCreation {
  op: "create";
  /** As it would be added (it has no id yet). */
  project: { id: string; key: string; name: string; host?: string };
  /** The thread that asked. */
  task: { id: string; key?: string; title: string } | null;
  /** The profile whose board it's added to. */
  board: string;
  /** The folder, with symlinks resolved. */
  repo_path: string;
  /** False when the folder is created. */
  exists: boolean;
  /** Whether it's a git repository. */
  git: boolean;
  /** The permission mode its tasks get: the host's default. */
  permission_mode: string;
  /** Why, in the agent's words. */
  reason?: string | null;
}

/** A task an agent asked to delete, shown to the user to confirm (API 58). */
export interface TaskDeletion {
  /** The deleted task's project, if it's in one. */
  project: { id: string; key: string; name: string; host?: string } | null;
  /** The thread that asked. */
  task: { id: string; key?: string; title: string } | null;
  delete: { id: string; key: string; title: string; status: Status; branch?: string | null; running?: boolean; subproject?: boolean };
  /** A subproject's tasks, deleted with it. */
  tasks_with_it: { id: string; key: string; title: string; status: Status }[];
  /** Whether the branch (and its tasks' branches) are deleted too. */
  delete_branch: boolean;
  /** Why, in the agent's words. */
  reason?: string | null;
}

interface ApprovalRequest {
  request_id: string;
  status: "pending" | "allowed" | "denied" | "expired";
  note?: string;
  task_id: string;
  created_at?: string;
}

/** A project change waiting for approval: its permission message's data, with the thread (API 44). */
export interface ProjectApproval extends ApprovalRequest {
  kind: "project";
  tool_name: "update_project";
  input: ProjectChange;
}

/** A project an agent asked to add, waiting for approval like a project change (API 76). */
export interface ProjectCreationApproval extends ApprovalRequest {
  kind: "project";
  tool_name: "create_project";
  input: ProjectCreation;
}

/** A task deletion waiting for the user to confirm it, like a project change (API 58). */
export interface DeletionApproval extends ApprovalRequest {
  kind: "delete_task";
  tool_name: "delete_task";
  input: TaskDeletion;
}

/** An automation as an approval shows it (API 67), with the task its message goes to and its tasks' agent config. */
export interface AutomationView {
  /** Empty for one that's being created. */
  id: string;
  name: string;
  enabled: boolean;
  trigger: AutomationTrigger;
  action: AutomationAction;
  /** Whether a webhook's deliveries must be signed with a secret. */
  signed: boolean;
  target?: { id: string; key: string; title: string; status: Status };
  config?: { id: string; name: string; agent: string };
}

/** An automation an agent asked to create, change or delete, shown to the user to approve (API 67). */
export interface AutomationChange {
  op: "create" | "update" | "delete";
  project: { id: string; key: string; name: string; host?: string };
  /** The thread that asked. */
  task: { id: string; key?: string; title: string } | null;
  /** The automation as it would be (or, to delete, as it is). */
  automation: AutomationView;
  /** For a change: the automation as it is. */
  before?: AutomationView;
  /** For a change, what it changes: name, trigger, action, enabled, generate_secret, secret (removed) or rotate_token. */
  changes?: string[];
  /** The host's time zone, which times of day are in. */
  time_zone?: { name: string | null; offset: string };
  /** Why, in the agent's words. */
  reason?: string | null;
}

/** An automation change waiting for the user to approve it, like a project change (API 67). */
export interface AutomationApproval extends ApprovalRequest {
  kind: "automation";
  tool_name: "create_automation" | "update_automation" | "delete_automation";
  input: AutomationChange;
}

/** What only the user decides for an agent, whatever its thread's permission mode. */
export type Approval = ProjectApproval | ProjectCreationApproval | DeletionApproval | AutomationApproval;

export type TaskDetail = { task: Task; last_message: string | null; pending_permissions: number };

/** What the user answered a question or plan prompt with, besides allowing or denying it (API 64). */
export type PermissionReply = { answers?: string[][]; mode?: PermissionMode; feedback?: string };

export interface HostInfo {
  host_id: string;
  host_name: string;
  version: string;
  data_dir: string;
  hostname: string;
  home: string | null;
}

/** Which of the board's notifications a device gets by push (see notifications.ts). */
export type PushEvents = Record<"attention" | "review" | "merge" | "done", boolean>;

/** A device that gets the board's notifications by Web Push (API 74; see server/src/push.rs). */
export interface PushDevice {
  id: string;
  /** Its push service's URL for it, which tells this browser's own from the others. */
  endpoint: string;
  name: string;
  events: PushEvents;
  created_at: string;
  last_sent_at: string | null;
  /** Why the last push to it failed, until one works. */
  last_error: string | null;
}

export const api = {
  // Push to devices (API 74): the board's key to subscribe with, and the devices that have.
  push: () => get<{ public_key: string; subscriptions: PushDevice[] }>("/push"),
  /** Adds this browser's subscription (`PushSubscription.toJSON()`), or updates it; events are kept unless given. */
  pushSubscribe: (b: { endpoint: string; keys: { p256dh: string; auth: string }; name: string; events?: PushEvents }) =>
    post<PushDevice>("/push/subscriptions", b),
  updatePushDevice: (id: string, b: { name?: string; events?: PushEvents }) => patch<PushDevice>(`/push/subscriptions/${enc(id)}`, b),
  removePushDevice: (id: string) => del(`/push/subscriptions/${enc(id)}`),
  testPush: (id: string) => post(`/push/subscriptions/${enc(id)}/test`),

  // Hub: the hosts on this board.
  hosts: () => get<Host[]>("/hosts"),
  addHost: (url: string, token: string) => post<Host>("/hosts", { url, token }),
  renameHost: (id: string, name: string) => patch(`/hosts/${enc(id)}`, { name }),
  removeHost: (id: string) => del(`/hosts/${enc(id)}`),
  /** Send this hub's code to a host, which updates its checkout and restarts. */
  updateHost: (id: string) => post<{ ok: boolean; up_to_date?: boolean }>(`/hosts/${enc(id)}/update`),
  sshKey: () => get<{ public_key: string }>("/hosts/ssh-key"),
  addSshHost: (b: { target: string; ssh_port?: number; remote_port?: number }) =>
    post<{ id: string; name: string; started: boolean }>("/hosts/ssh", b),
  joinInfo: () => get<{ hub_token: string; host_token: string; command: string }>("/hosts/join"),
  /** Copy a Claude config (API 20 hosts) or a profile's config (older hosts) to another host. */
  copyClaudeConfig: (b: { config?: string; profile?: string; from_host: string; to_host: string; config_dir?: string; overwrite?: boolean }) =>
    post<{ ok: boolean; files: string[] }>("/hosts/copy-claude-config", b),

  /** Whether a URL answers 200, checked by the server this UI is served from. */
  previewStatus: (url: string) => get<{ up: boolean; status: number | null }>(`/preview-status?url=${encodeURIComponent(url)}`),

  // Per host.
  info: (h: string) => on(h).get<HostInfo>("/info"),

  profiles: (h: string) => on(h).get<Profile[]>("/profiles"),
  /** `claude_config_dir` instead of `claude_config_ids` uses (or creates) the config with that directory. */
  createProfile: (
    h: string,
    b: {
      name: string;
      claude_config_ids?: string[];
      claude_config_dir?: string;
      default_model?: string | null;
      agent_access?: string[];
      github_account?: string | null;
      clone_dir?: string | null;
      asana_enabled?: boolean;
      limit_wait?: boolean;
      limit_switch?: boolean;
    },
  ) =>
    on(h).post<Profile>("/profiles", b),
  /** `asana_token` (API 57) is checked with Asana; null disconnects it. */
  updateProfile: (h: string, id: string, b: Partial<Profile> & { asana_token?: string | null }) => on(h).patch<Profile>(`/profiles/${enc(id)}`, b),
  /** The Asana tasks the profile's token finds for `q` (words, or a task's URL), open ones first (API 57). */
  asanaTasks: (h: string, profileId: string, q: string) => on(h).get<AsanaTask[]>(`/profiles/${enc(profileId)}/asana/tasks?q=${encodeURIComponent(q)}`),
  deleteProfile: (h: string, id: string) => on(h).del(`/profiles/${enc(id)}`),
  claudeConfigs: (h: string) => on(h).get<Omit<ClaudeConfig, "host_id">[]>("/claude-configs"),
  /** `agent` needs API 25. */
  createClaudeConfig: (h: string, b: { name: string; config_dir: string; agent?: Agent }) => on(h).post<ClaudeConfig>("/claude-configs", b),
  updateClaudeConfig: (h: string, id: string, b: { name?: string; config_dir?: string; agent?: Agent; show_usage?: boolean }) =>
    on(h).patch<ClaudeConfig>(`/claude-configs/${enc(id)}`, b),
  /** The models a Codex config offers (API 25); empty for Claude configs. */
  claudeConfigModels: (h: string, id: string) => on(h).get<AgentModel[]>(`/claude-configs/${enc(id)}/models`),
  /** The GitHub accounts gh is signed in to on the host (API 50); `error` says why there are none. */
  githubAccounts: (h: string) => on(h).get<{ accounts: GithubAccount[]; error: string | null }>("/github-accounts"),
  /**
   * The GitHub repositories `account` (gh's active one when null) can clone on the host (API 55): the ones it owns or collaborates on,
   * most recently pushed first, or with `q` the ones named like it among those and its organizations'.
   */
  githubRepos: (h: string, account: string | null, q?: string) => {
    const params = new URLSearchParams();
    if (account) params.set("account", account);
    if (q) params.set("q", q);
    const query = params.toString();
    return on(h).get<GithubRepoList>(`/github-repos${query ? `?${query}` : ""}`);
  },
  deleteClaudeConfig: (h: string, id: string) => on(h).del(`/claude-configs/${enc(id)}`),
  /** Claude usage for every Claude config (API 20; every profile before) on the host (API 9). */
  usage: (h: string, refresh = false) => on(h).get<Omit<Usage, "host_id">[]>(`/usage${refresh ? "?refresh=true" : ""}`),

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
  defaultPrompts: (h: string) => on(h).get<Record<PromptField, string>>("/default-prompts"),
  /** What the agent of a new thread in the project is told on top of its agent's own system prompt, with these options (API 80). */
  systemPromptPreview: (h: string, id: string, q: SystemPromptOptions) =>
    on(h).get<{ text: string; runtime: Agent; permission_mode: PermissionMode }>(
      `/projects/${enc(id)}/system-prompt?${new URLSearchParams(Object.entries(q).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)]))}`,
    ),
  /** The project's own skills and MCP servers, and the ones from elsewhere it turns off (API 21). */
  agentTools: (h: string, projectId: string) => on(h).get<AgentTools>(`/projects/${enc(projectId)}/agent-tools`),
  updateAgentTools: (h: string, projectId: string, b: { disabled_skills?: string[]; disabled_mcp_servers?: string[] }) =>
    on(h).patch<AgentTools>(`/projects/${enc(projectId)}/agent-tools`, b),
  createSkill: (h: string, projectId: string, b: { content: string; enabled?: boolean }) =>
    on(h).post<ProjectSkill>(`/projects/${enc(projectId)}/agent-tools/skills`, b),
  updateSkill: (h: string, projectId: string, id: string, b: { content?: string; enabled?: boolean }) =>
    on(h).patch<ProjectSkill>(`/projects/${enc(projectId)}/agent-tools/skills/${enc(id)}`, b),
  deleteSkill: (h: string, projectId: string, id: string) => on(h).del(`/projects/${enc(projectId)}/agent-tools/skills/${enc(id)}`),
  createMcpServer: (h: string, projectId: string, b: { name: string; config: McpServerConfig; enabled?: boolean; auto_allow?: boolean }) =>
    on(h).post<ProjectMcpServer>(`/projects/${enc(projectId)}/agent-tools/mcp-servers`, b),
  updateMcpServer: (h: string, projectId: string, id: string, b: { name?: string; config?: McpServerConfig; enabled?: boolean; auto_allow?: boolean }) =>
    on(h).patch<ProjectMcpServer>(`/projects/${enc(projectId)}/agent-tools/mcp-servers/${enc(id)}`, b),
  deleteMcpServer: (h: string, projectId: string, id: string) => on(h).del(`/projects/${enc(projectId)}/agent-tools/mcp-servers/${enc(id)}`),
  globalAgentTools: (h: string) => on(h).get<GlobalAgentTools>("/agent-tools"),
  createGlobalSkill: (h: string, b: { content: string }) => on(h).post<ProjectSkill>("/agent-tools/skills", b),
  updateGlobalSkill: (h: string, id: string, b: { content?: string }) => on(h).patch<ProjectSkill>(`/agent-tools/skills/${enc(id)}`, b),
  deleteGlobalSkill: (h: string, id: string) => on(h).del(`/agent-tools/skills/${enc(id)}`),
  createGlobalMcpServer: (h: string, b: { name: string; config: McpServerConfig; auto_allow?: boolean }) =>
    on(h).post<ProjectMcpServer>("/agent-tools/mcp-servers", b),
  updateGlobalMcpServer: (h: string, id: string, b: { name?: string; config?: McpServerConfig; auto_allow?: boolean }) =>
    on(h).patch<ProjectMcpServer>(`/agent-tools/mcp-servers/${enc(id)}`, b),
  deleteGlobalMcpServer: (h: string, id: string) => on(h).del(`/agent-tools/mcp-servers/${enc(id)}`),
  /** Switch a global skill or server on or off for a profile (its default) or a project; null clears it. */
  setAgentToolSwitch: (h: string, b: { scope: "profile" | "project"; scope_id: string; item_id: string; enabled: boolean | null }) =>
    on(h).post("/agent-tools/switches", b),

  /** The profile's prompts and agent runs in [from, to) (API 16). */
  analytics: (h: string, profileId: string, from: string, to: string) =>
    on(h).get<AnalyticsReport>(`/profiles/${enc(profileId)}/analytics?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),

  /** How much space the profile's projects and their worktrees take up (API 35). */
  diskUsage: (h: string, profileId: string) => on(h).get<DiskUsageReport>(`/profiles/${enc(profileId)}/disk-usage`),

  /** A scratch task, in no project (API 47). */
  createScratchTask: (
    h: string,
    profileId: string,
    b: {
      title?: string;
      description?: string;
      status?: Status;
      start?: boolean;
      model?: string;
      effort?: Effort;
      claude_config_id?: string;
      /** API 71. */
      labels?: DocumentType[];
      external_links?: ExternalLink[];
      fanout_id?: string;
    },
  ) => on(h).post<Task>(`/profiles/${enc(profileId)}/tasks`, b),
  /** The profile's tasks in no project: its group tasks (API 34) and scratch tasks (API 47). */
  groupTasks: (h: string, profileId: string) => on(h).get<Task[]>(`/profiles/${enc(profileId)}/group-tasks`),
  createGroupTask: (
    h: string,
    profileId: string,
    b: {
      group: string;
      description: string;
      status?: Status;
      start?: boolean;
      model?: string;
      effort?: Effort;
      claude_config_id?: string;
      /** A plan, artifact or diagram task, on hosts before API 71. */
      task_type?: DocumentType;
      /** API 71. */
      labels?: DocumentType[];
      external_links?: ExternalLink[];
      /** Shared by the tasks made from one prompt (API 61). */
      fanout_id?: string;
    },
  ) => on(h).post<Task>(`/profiles/${enc(profileId)}/group-tasks`, b),
  projectTasks: (h: string, projectId: string, kind: Task["kind"] = "task") => on(h).get<Task[]>(`/projects/${enc(projectId)}/tasks?kind=${kind}`),
  createTask: (
    h: string,
    projectId: string,
    b: {
      title?: string;
      description?: string;
      status?: Status;
      use_worktree?: boolean;
      start?: boolean | string;
      kind?: string;
      model?: string;
      effort?: Effort;
      parent_id?: string;
      subproject?: boolean;
      claude_config_id?: string;
      depends_on?: string[];
      /** A scratch task in the project needs API 51; a plan, artifact or diagram task is one on hosts before API 71. */
      task_type?: TaskType | DocumentType;
      /** API 71. */
      labels?: DocumentType[];
      external_links?: ExternalLink[];
      /** Shared by the tasks made from one prompt (API 61). */
      fanout_id?: string;
    },
  ) => on(h).post<Task>(`/projects/${enc(projectId)}/tasks`, b),
  task: (h: string, id: string) => on(h).get<TaskDetail>(`/tasks/${enc(id)}`),
  updateTask: (h: string, id: string, b: Partial<Task>) => {
    // Noted before the request: the task event it causes reaches every tab before the response does.
    if (b.status) noteMove(h, id, b.status);
    return on(h).patch<Task>(`/tasks/${enc(id)}`, b);
  },
  deleteTask: (h: string, id: string, deleteBranch = false) => on(h).del(`/tasks/${enc(id)}?delete_branch=${deleteBranch}`),
  messages: (h: string, id: string) => on(h).get<Message[]>(`/tasks/${enc(id)}/messages`),
  /**
   * The latest messages with ids between `after` and `before` (API 56): with a `limit`, that many of the
   * main conversation's, with the subagents' own messages among them.
   */
  messagePage: (h: string, id: string, q: { before?: number; after?: number; limit?: number }) =>
    on(h).get<MessagePage>(`/tasks/${enc(id)}/messages?${new URLSearchParams(Object.entries(q).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)]))}`),
  send: (h: string, id: string, text: string) => on(h).post<Task>(`/tasks/${enc(id)}/messages`, { text }),
  stop: (h: string, id: string) => on(h).post(`/tasks/${enc(id)}/stop`),
  /** Save a file on the host for a prompt to refer to (API 18). `data` is base64. */
  uploadAttachment: (h: string, name: string, data: string) => on(h).post<Attachment>("/attachments", { name, data }),
  attachment: (h: string, id: string, name: string) =>
    on(h).get<{ name: string; size: number; mime: string; data: string }>(`/attachments/${enc(id)}/${encodeURIComponent(name)}`),
  /** Drops the queued message; returns the task as it was, so the text can be edited again. */
  unqueue: (h: string, id: string) => on(h).del<Task>(`/tasks/${enc(id)}/queue`),
  /** A task whose agent ran out of usage waits for the limit to reset, and then its agent carries on (API 81). */
  waitForLimit: (h: string, id: string) => on(h).post<Task>(`/tasks/${enc(id)}/wait-for-limit`),
  /** Review the task's work now (API 12). */
  review: (h: string, id: string) => on(h).post<Task | null>(`/tasks/${enc(id)}/review`),
  setupWorktree: (h: string, id: string) => on(h).post<Task>(`/tasks/${enc(id)}/worktree/setup`),
  teardownWorktree: (h: string, id: string, b: { force?: boolean; delete_branch?: boolean }) => on(h).post<Task>(`/tasks/${enc(id)}/worktree/teardown`, b),
  diff: (h: string, id: string) => on(h).get<DiffResult>(`/tasks/${enc(id)}/diff`),
  /** Whether moving the task to Done would leave its work unmerged (API 75). */
  unmerged: (h: string, id: string) => on(h).get<{ unmerged: boolean }>(`/tasks/${enc(id)}/unmerged`),
  /**
   * The Changes tab's git (API 62): the status, a file's unstaged or staged diff, and a commit's or stash's. A diff that
   * isn't UTF-8 comes as a `preview` with `not_utf8` and no `patch`, as lines patched from it would be written back wrong.
   */
  gitStatus: (h: string, id: string) => on(h).get<GitStatus>(`/tasks/${enc(id)}/git`),
  gitDiff: (h: string, id: string, path: string, q: { staged?: boolean; untracked?: boolean }) =>
    on(h).get<{ patch: string; too_large?: boolean; not_utf8?: boolean; preview?: string }>(`/tasks/${enc(id)}/git/diff?${new URLSearchParams({ path, staged: String(!!q.staged), untracked: String(!!q.untracked) })}`),
  gitShow: (h: string, id: string, rev: string) => on(h).get<GitCommitShown>(`/tasks/${enc(id)}/git/show?rev=${enc(rev)}`),
  gitShowStash: (h: string, id: string, sha: string) => on(h).get<{ patch: string }>(`/tasks/${enc(id)}/git/show?rev=${enc(sha)}&stash=true`),
  /** Stages or unstages the files as they are, or with no paths everything. */
  gitStage: (h: string, id: string, paths: string[]) => on(h).post(`/tasks/${enc(id)}/git/stage`, { paths }),
  gitUnstage: (h: string, id: string, paths: string[]) => on(h).post(`/tasks/${enc(id)}/git/unstage`, { paths }),
  /** Throws away the files' unstaged changes, or with `staged` all of them; untracked files are deleted. */
  gitDiscard: (h: string, id: string, paths: string[], staged: boolean) => on(h).post(`/tasks/${enc(id)}/git/discard`, { paths, staged }),
  /** Applies a patch of chosen lines (changes.ts linesPatch) to the index, or the working tree. */
  gitApply: (h: string, id: string, patch: string, b: { cached: boolean; reverse: boolean }) => on(h).post(`/tasks/${enc(id)}/git/apply`, { patch, ...b }),
  gitCommit: (h: string, id: string, b: { message: string; amend?: boolean; reword?: boolean }) => on(h).post<{ head: string }>(`/tasks/${enc(id)}/git/commit`, b),
  gitStash: (h: string, id: string, b: { action: "push"; mode: "all" | "staged" | "unstaged"; message: string } | { action: "apply" | "pop" | "drop"; index: number; sha: string }) =>
    on(h).post<{ output: string }>(`/tasks/${enc(id)}/git/stash`, b),
  gitReset: (h: string, id: string, rev: string, mode: "soft" | "mixed" | "hard") => on(h).post(`/tasks/${enc(id)}/git/reset`, { rev, mode }),
  /** The task's turns with checkpoints, and the changes between two checkpoints (API 70). */
  turns: (h: string, id: string) => on(h).get<TurnsResult>(`/tasks/${enc(id)}/turns`),
  turnDiff: (h: string, id: string, from: number, to: number) => on(h).get<TurnDiff>(`/tasks/${enc(id)}/turns/diff?from=${from}&to=${to}`),
  /** Restores the files to before the turn `message_id` started, and optionally the branch and the agent's conversation. */
  rewind: (h: string, id: string, b: { message_id: number; conversation: boolean; branch: boolean }) => on(h).post<RewindResult>(`/tasks/${enc(id)}/rewind`, b),
  cancelRewind: (h: string, id: string) => on(h).del<Task>(`/tasks/${enc(id)}/rewind`),
  /** How full the agent's context is, with the latest breakdown (API 40). */
  context: (h: string, id: string) => on(h).get<{ context: ContextSummary | null; detail: ContextDetail | null }>(`/tasks/${enc(id)}/context`),
  /** The skills the task's agent can be asked to use, for the composer's `/` menu (API 54). */
  taskSkills: (h: string, id: string) => on(h).get<TaskSkills>(`/tasks/${enc(id)}/skills`),
  /** A task's document for one of its labels (API 71; a host before then has the one its type makes, API 42): the
   *  latest version, or `version`. */
  document: (h: string, id: string, label: DocumentType, version?: number) =>
    on(h).get<TaskDocument>(`/tasks/${enc(id)}/document?label=${label}${version ? `&version=${version}` : ""}`),
  /** The task's shell, or with `tool` one of the host's terminal tools (API 13). */
  terminal: (h: string, id: string, tool?: string) => on(h).get<TerminalStatus>(`/tasks/${enc(id)}/terminal${toolQuery(tool)}`),
  killTerminal: (h: string, id: string, tool?: string) => on(h).del(`/tasks/${enc(id)}/terminal${toolQuery(tool)}`),
  /** Tool sessions end once no board renews them (and nobody is attached). */
  keepTerminal: (h: string, id: string, tool: string) => on(h).post(`/tasks/${enc(id)}/terminal/keepalive${toolQuery(tool)}`),
  /** With `reply` (API 64): a question's answers, by question (each a list of picked labels and typed text); the
   *  mode an approved plan carries on in; or the feedback a plan's sent back with. */
  resolvePermission: (h: string, id: string, decision: "allow" | "allow_always" | "deny", message?: string, reply?: PermissionReply) =>
    on(h).post(`/permissions/${enc(id)}`, { decision, message, ...reply }),
  /** Answer a question an agent asked with request_user_input, from its card (API 64): sent as the user's message. */
  answerQuestion: (h: string, taskId: string, messageId: number, answer: { choices: string[]; text: string | null }) =>
    on(h).post<Task>(`/tasks/${enc(taskId)}/questions/${messageId}`, answer),
  /** Project changes agents are waiting for the user to approve, oldest first (API 44). */
  /** Older hosts ignore `all` and `automations` and list project changes only (or those and deletions). */
  projectApprovals: (h: string) => on(h).get<Approval[]>("/project-approvals?all=true&automations=true"),
  dirs: (h: string, path?: string) => on(h).get<DirListing>(`/fs/dirs${path ? `?path=${encodeURIComponent(path)}` : ""}`),
  /** The project's automations, and the time zone their times of day are in (API 63). */
  automations: (h: string, projectId: string) =>
    on(h).get<{ automations: Automation[]; time_zone: { name: string | null; offset: string } }>(`/projects/${enc(projectId)}/automations`),
  createAutomation: (h: string, projectId: string, b: AutomationInput) => on(h).post<Automation>(`/projects/${enc(projectId)}/automations`, b),
  updateAutomation: (h: string, id: string, b: AutomationInput) => on(h).patch<Automation>(`/automations/${enc(id)}`, b),
  deleteAutomation: (h: string, id: string) => on(h).del(`/automations/${enc(id)}`),
  /** Run it now; for a webhook, a test delivery of `payload` (else the latest delivery's) as `event`. */
  runAutomation: (h: string, id: string, b: { payload?: unknown; event?: string } = {}) => on(h).post<AutomationRun>(`/automations/${enc(id)}/run`, b),
  /** Its latest runs and deliveries, newest first, and the latest delivery's body and event. */
  automationRuns: (h: string, id: string) =>
    on(h).get<{ runs: AutomationRun[]; latest_delivery: { body: unknown; event: string | null } | null }>(`/automations/${enc(id)}/runs`),
  settings: (h: string) => on(h).get<HostSettings>("/settings"),
  updateSettings: (h: string, b: Partial<HostSettings>) => on(h).patch<HostSettings>("/settings", b),
  serverStatus: (h: string) => on(h).get<ServerStatus>("/admin/server"),
  restartServer: (h: string, b: { rebuild: boolean }) => on(h).post(`/admin/restart`, b),
  /** Fetch `commit` from the host's origin, fast-forward its checkout to it, then rebuild and restart. */
  updateServer: (h: string, commit: string) => on(h).post<{ ok: boolean; up_to_date?: boolean }>(`/admin/update`, { commit }),
};

export function wsUrl(path = "/ws") {
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  const sep = path.includes("?") ? "&" : "?";
  return `${proto}://${window.location.host}/api${path}${sep}token=${encodeURIComponent(getToken())}`;
}

const toolQuery = (tool?: string) => (tool ? `?tool=${encodeURIComponent(tool)}` : "");

/** Websocket attached to a task's terminal (or one of its tools); the session is created if needed. */
export const terminalWsUrl = (h: string, id: string, cols: number, rows: number, tool?: string) =>
  wsUrl(`/h/${enc(h)}/tasks/${enc(id)}/terminal/ws?cols=${cols}&rows=${rows}${tool ? `&tool=${encodeURIComponent(tool)}` : ""}`);
