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

/** Its agent is running but waiting for something (the `wait` tool), not working. */
export const agentWaiting = (t: Task) => (t.running && t.agent_wait) || null;

/** Queued in "In progress" until the tasks it depends on are merged. */
export const dependencyQueued = (t: Task) => !!t.waiting && t.status === "in_progress" && !t.running;

/** Whether a task counts as merged for the tasks that depend on it (server: db::is_merged). */
/** Whether new tasks in the project get their own worktree: only once its repo is a git repository. */
export const worktreesOn = (p: Project) => p.use_worktrees && p.is_git !== false;

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
  /** Falls back to the host's default mode when null (API 2; always set by older hosts). */
  permission_mode: PermissionMode | null;
  model: string | null;
  /** Overrides the profile's Claude configs when set (API 20). */
  claude_config_ids?: string[] | null;
  /** Review each task's work when it moves to "In review" (API 12). */
  auto_review?: boolean;
  /** How many times in a row a review's serious issues go back to the agent to fix (API 12). */
  review_rounds?: number;
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
  created_at: string;
}

export type PromptField = "start_prompt" | "review_prompt" | "merge_prompt";

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

/** A task that makes a document instead of code: an HTML plan or artifact, or a Mermaid diagram (API 42). */
export type DocumentType = "plan" | "artifact" | "diagram";

/** What a task makes, if not code: a document, or for a scratch task (in no project, API 47, or in one, API 51) nothing in particular. */
export type TaskType = DocumentType | "scratch";

/** A scratch task: its agent works in the task's own folder, with no worktree, on whatever it's asked. In no project
 *  it has no repository (API 47); in a project (API 51) it reads the project's. */
export const isScratch = (t: Pick<Task, "kind" | "task_type">) => t.kind === "task" && t.task_type === "scratch";

/** The document a task makes, if it's a plan, artifact or diagram task. */
export const documentType = (t: Pick<Task, "task_type">): DocumentType | undefined => (t.task_type && t.task_type !== "scratch" ? t.task_type : undefined);

/** One version of a plan, artifact or diagram task's document; `open` while the agent's turn is still writing it. */
export interface DocumentVersion {
  version: number;
  open: boolean;
  created_at: string;
  updated_at: string;
  size: number;
}

export interface TaskDocument {
  task_type: DocumentType | null;
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
  /** What the task makes, if not code: its agent writes a document the board keeps and shows (API 42), or for
   *  a scratch task nothing in particular (API 47). */
  task_type?: TaskType | null;
  /** When its document last changed (API 42). */
  document_at?: string | null;
  /** Where a scratch task made from a scratch chat works: the chat's folder (API 47). */
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
  attention_reason: string | null;
  /** Tasks (ids) in the same project that have to be merged before its agent starts (API 24). */
  depends_on?: string[];
  /** Queued in "In progress": its agent starts once every task in `depends_on` is merged (API 24). */
  waiting?: boolean;
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
  /** `question`: one asked with request_user_input (API 62). */
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

/** Servers started with `--open-token` (PR previews) hand out their token; sign in with it. */
export async function fetchOpenToken() {
  try {
    const res = await fetch("/api/open-token");
    const data = res.ok ? await res.json() : null;
    if (typeof data?.token === "string" && data.token) setToken(data.token);
  } catch {
    /* not offered */
  }
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

let onUnauthorized: () => void = () => {};
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${getToken()}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    onUnauthorized();
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

/** A task deletion waiting for the user to confirm it, like a project change (API 58). */
export interface DeletionApproval extends ApprovalRequest {
  kind: "delete_task";
  tool_name: "delete_task";
  input: TaskDeletion;
}

/** What only the user decides for an agent, whatever its thread's permission mode. */
export type Approval = ProjectApproval | DeletionApproval;

export type TaskDetail = { task: Task; last_message: string | null; pending_permissions: number };

/** What the user answered a question or plan prompt with, besides allowing or denying it (API 62). */
export type PermissionReply = { answers?: string[][]; mode?: PermissionMode; feedback?: string };

export interface HostInfo {
  host_id: string;
  host_name: string;
  version: string;
  data_dir: string;
  hostname: string;
  home: string | null;
}

export const api = {
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
  removeMergedWorktrees: (h: string, id: string) => on(h).post<{ results: MergedWorktreeResult[] }>(`/projects/${enc(id)}/remove-merged-worktrees`),
  /** The prompt instructions a project without its own uses (API 27). */
  defaultPrompts: (h: string) => on(h).get<Record<PromptField, string>>("/default-prompts"),
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
      task_type?: DocumentType;
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
      /** A scratch task in the project needs API 51. */
      task_type?: TaskType;
      external_links?: ExternalLink[];
      /** Shared by the tasks made from one prompt (API 61). */
      fanout_id?: string;
    },
  ) => on(h).post<Task>(`/projects/${enc(projectId)}/tasks`, b),
  task: (h: string, id: string) => on(h).get<TaskDetail>(`/tasks/${enc(id)}`),
  updateTask: (h: string, id: string, b: Partial<Task>) => {
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
  /** Review the task's work now (API 12). */
  review: (h: string, id: string) => on(h).post<Task | null>(`/tasks/${enc(id)}/review`),
  setupWorktree: (h: string, id: string) => on(h).post<Task>(`/tasks/${enc(id)}/worktree/setup`),
  teardownWorktree: (h: string, id: string, b: { force?: boolean; delete_branch?: boolean }) => on(h).post<Task>(`/tasks/${enc(id)}/worktree/teardown`, b),
  diff: (h: string, id: string) => on(h).get<DiffResult>(`/tasks/${enc(id)}/diff`),
  /** How full the agent's context is, with the latest breakdown (API 40). */
  context: (h: string, id: string) => on(h).get<{ context: ContextSummary | null; detail: ContextDetail | null }>(`/tasks/${enc(id)}/context`),
  /** The skills the task's agent can be asked to use, for the composer's `/` menu (API 54). */
  taskSkills: (h: string, id: string) => on(h).get<TaskSkills>(`/tasks/${enc(id)}/skills`),
  /** A plan, artifact or diagram task's document: the latest version, or `version` (API 42). */
  document: (h: string, id: string, version?: number) => on(h).get<TaskDocument>(`/tasks/${enc(id)}/document${version ? `?version=${version}` : ""}`),
  /** The task's shell, or with `tool` one of the host's terminal tools (API 13). */
  terminal: (h: string, id: string, tool?: string) => on(h).get<TerminalStatus>(`/tasks/${enc(id)}/terminal${toolQuery(tool)}`),
  killTerminal: (h: string, id: string, tool?: string) => on(h).del(`/tasks/${enc(id)}/terminal${toolQuery(tool)}`),
  /** Tool sessions end once no board renews them (and nobody is attached). */
  keepTerminal: (h: string, id: string, tool: string) => on(h).post(`/tasks/${enc(id)}/terminal/keepalive${toolQuery(tool)}`),
  /** With `reply` (API 62): a question's answers, by question (each a list of picked labels and typed text); the
   *  mode an approved plan carries on in; or the feedback a plan's sent back with. */
  resolvePermission: (h: string, id: string, decision: "allow" | "allow_always" | "deny", message?: string, reply?: PermissionReply) =>
    on(h).post(`/permissions/${enc(id)}`, { decision, message, ...reply }),
  /** Answer a question an agent asked with request_user_input, from its card (API 62): sent as the user's message. */
  answerQuestion: (h: string, taskId: string, messageId: number, answer: { choices: string[]; text: string | null }) =>
    on(h).post<Task>(`/tasks/${enc(taskId)}/questions/${messageId}`, answer),
  /** Project changes agents are waiting for the user to approve, oldest first (API 44). */
  /** Older hosts ignore `all` and list project changes only. */
  projectApprovals: (h: string) => on(h).get<Approval[]>("/project-approvals?all=true"),
  dirs: (h: string, path?: string) => on(h).get<DirListing>(`/fs/dirs${path ? `?path=${encodeURIComponent(path)}` : ""}`),
  settings: (h: string) => on(h).get<HostSettings>("/settings"),
  updateSettings: (h: string, b: Partial<HostSettings>) => on(h).patch<HostSettings>("/settings", b),
  serverStatus: (h: string) => on(h).get<ServerStatus>("/admin/server"),
  restartServer: (h: string, b: { rebuild: boolean }) => on(h).post(`/admin/restart`, b),
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
