import type { DocumentType } from "./labels";
import type { Effort } from "./claudeConfigs";
import { type Host, hostSupports } from "./hosts";
import { enc, on } from "./http";
import type { ContextSummary, PendingRewind } from "./thread";

export { documentsOnly, LABELS, taskLabels, type DocumentType } from "./labels";

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

/** Waiting in "Ready for merge" for another task in its project to finish merging. */
export const mergeQueued = (t: Task) => !!t.merging && t.status === "ready_for_merge" && !t.running && !mergeAwaitsApproval(t);

/** Its merge waits for the user's approval (API 92): its agent summarises what will be merged, then the user approves or denies it. */
export const mergeAwaitsApproval = (t: Task) => !!t.merging && t.merge_approval === "pending";

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

/** Profiles and projects can have merges wait for the user's approval of a summary. */
export const MERGE_APPROVAL_API = 92;

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

/** A task elsewhere (only Asana's so far) that a task is for (API 57). */
export interface ExternalLink {
  provider: "asana";
  /** Its id there (an Asana task's gid). */
  id: string;
  url: string;
  /** Its name there, when it was linked. */
  title: string;
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
  /** Rounds of fixes you added, past the project's review_rounds, after the task ran out of them (API 93). */
  extra_rounds?: number;
  updated_at: string;
  /** Each reviewer's part (API 29). */
  reviewers?: ReviewerRun[];
}

export type SummaryState = "running" | "done" | "failed" | "stopped";

/** A summary of a task's changes, written once its review passed (API 84). */
export interface ChangeSummary {
  /** The summary thread: a task of kind "review" and type "summary" whose parent is the task. */
  thread_id: string;
  /** Who writes it, e.g. "Claude · haiku". */
  label: string;
  state: SummaryState;
  /** The commit summarised. */
  head: string | null;
  /** The summary (Markdown), or why there's none. */
  text: string | null;
  updated_at: string;
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

/** Hosts from this API version on take labels (before, the board made a task of a label's type instead). */
export const LABELS_API = 71;

/** What a task is, if not a code task: a scratch task (in no project, API 47, or in one, API 51). On hosts before API 71,
 *  also a plan, artifact or diagram task. */
export type TaskType = "scratch";

/** A scratch task: its agent works in the task's own folder, with no worktree, on whatever it's asked. In no project
 *  it has no repository (API 47); in a project (API 51) it reads the project's. */
/** A review thread that summarises its task's changes rather than reviewing them (API 84): its type is "summary". */
export const isSummaryThread = (t: Pick<Task, "kind" | "task_type">) => t.kind === "review" && (t.task_type as string | null | undefined) === "summary";

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
  /** Where its merge is with your approval, when its project asks for it (API 92): `pending` while its agent summarises it and you decide. */
  merge_approval?: "pending" | "approved" | null;
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
  /** How its pull request's checks stood when the board last read them (API 94); see `failedChecks`. */
  pr_checks?: PrChecks | null;
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
  /** When it was put in Now (API 95); unset for the tasks in Later, where tasks start. */
  now_at?: string | null;
  /** The latest automatic review of its work (API 12). */
  review?: Review | null;
  /** The latest summary of its changes (API 84). */
  summary?: ChangeSummary | null;
  /** How full its agent's context window is, as of its latest reply (API 40). */
  context?: ContextSummary | null;
  /** The conversation rollback its agent's next run makes, after a rewind (API 70). */
  rewind?: PendingRewind | null;
  cost_usd: number;
  last_activity_at: string;
  created_at: string;
  updated_at: string;
}

/** A pull request's head commit's checks, as a read found them (API 94): by a wait on it, while it's watched in review, when it's read for "Done when merged", or by Fix broken checks. */
export interface PrChecks {
  /** The pull request read; the task's `pr_url` may have changed since. */
  url: string;
  head: string;
  outcome: "failed" | "passed" | "pending" | "none";
  failed: { name: string; conclusion: string; url: string | null }[];
  /** How many more failed than are listed. */
  more_failed: number;
  pending: number;
  passed: number;
  /** When a read first found them like this. */
  since: string;
}

/** The host API version that reads tasks' checks and has Fix broken checks. */
export const CHECKS_API = 94;

const prKey = (url: string) => url.match(/^https?:\/\/(?:www\.)?([^/]+\/[^/]+\/[^/]+)\/pull\/(\d+)/i)?.slice(1).join("#").toLowerCase();

/** How the checks of the task's pull request stood at the board's latest read of it, if it has read the one the task has now. */
export function prChecks(t: Task): PrChecks | null {
  const c = t.pr_checks;
  if (!c || !t.pr_url) return null;
  const key = prKey(t.pr_url);
  return key && key === prKey(c.url) ? c : null;
}

/** The failed checks of an open task's pull request, if the board's latest read of it found some. */
export function failedChecks(t: Task): PrChecks | null {
  const c = prChecks(t);
  return c && c.outcome === "failed" && t.status !== "done" ? c : null;
}

/** What the compare view shows of a task made from one prompt with others, besides the task (API 81). */
export interface FanoutFacts {
  id: string;
  /** How long its agent has run, all of its runs together, and how many runs. */
  run_secs: number;
  runs: number;
  /** Its agent, or one of its reviewers, is at work. */
  working: boolean;
  /** Its worktree's uncommitted changes as `git status --porcelain` lists them (the first 20), and how many. */
  uncommitted: string[];
  uncommitted_count: number;
  uncommitted_error: string | null;
  /** Commits in its worktree that no branch, remote branch or tag has (a detached HEAD's): picking keeps the worktree. */
  stray_commits?: number;
  /** Its branch, if the repository has it, and where it's pushed (`origin/ia/x-1`). */
  branch: string | null;
  pushed: string | null;
}

/** What picking one of them did with another (API 81). */
export interface PickOutcome {
  id: string;
  key: string;
  stopped: boolean;
  /** Completed as not done (rather than done already). */
  completed: boolean;
  worktree: "removed" | "kept" | "none";
  branch: "deleted" | "kept" | "none";
  pushed_branch: "deleted" | "kept" | "none";
  pr: "closed" | "kept" | "none";
  /** What didn't go as asked, and why. */
  notes: string[];
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

/** A file saved on a host for prompts to refer to (see attachments.ts). */
export interface Attachment {
  id: string;
  name: string;
  /** Where it is on the host; prompts list it for the agent to read. */
  path: string;
  size: number;
  mime: string;
}

export type TaskDetail = { task: Task; last_message: string | null; pending_permissions: number };

export const tasksApi = {
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
  updateTask: (h: string, id: string, b: Partial<Task> & { now?: boolean }) => {
    // Noted before the request: the task event it causes reaches every tab before the response does.
    if (b.status) noteMove(h, id, b.status);
    return on(h).patch<Task>(`/tasks/${enc(id)}`, b);
  },
  deleteTask: (h: string, id: string, deleteBranch = false) => on(h).del(`/tasks/${enc(id)}?delete_branch=${deleteBranch}`),
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
  /** A task whose review still found serious issues after its rounds of fixes gets as many again, starting with those issues (API 93). */
  extendReview: (h: string, id: string) => on(h).post<Task>(`/tasks/${enc(id)}/review/extend`),
  summarize: (h: string, id: string) => on(h).post<Task | null>(`/tasks/${enc(id)}/summary`),
  /** Sends the agent its pull request's failed checks, with the ends of their logs (API 94). */
  fixChecks: (h: string, id: string) => on(h).post<Task>(`/tasks/${enc(id)}/fix_checks`),
  setupWorktree: (h: string, id: string) => on(h).post<Task>(`/tasks/${enc(id)}/worktree/setup`),
  teardownWorktree: (h: string, id: string, b: { force?: boolean; delete_branch?: boolean }) => on(h).post<Task>(`/tasks/${enc(id)}/worktree/teardown`, b),
  /** The tasks made from the same prompt as this one, it among them (API 81). */
  fanout: (h: string, id: string) => on(h).get<{ tasks: FanoutFacts[] }>(`/tasks/${enc(id)}/fanout`),
  /** Keeps this task, and completes the others made from the same prompt as not done, cleaning up after them (API 81). */
  pickFanout: (h: string, id: string, b: { delete_branches: boolean; close_prs: boolean; discard_uncommitted: boolean }) =>
    on(h).post<{ task: Task; results: PickOutcome[] }>(`/tasks/${enc(id)}/fanout/pick`, b),
  /** Whether moving the task to Done would leave its work unmerged (API 75). */
  unmerged: (h: string, id: string) => on(h).get<{ unmerged: boolean }>(`/tasks/${enc(id)}/unmerged`),
  /** A task's document for one of its labels (API 71; a host before then has the one its type makes, API 42): the
   *  latest version, or `version`. */
  document: (h: string, id: string, label: DocumentType, version?: number) =>
    on(h).get<TaskDocument>(`/tasks/${enc(id)}/document?label=${label}${version ? `&version=${version}` : ""}`),
};
