import { enc, on } from "./http";
import type { Status } from "./tasks";

/** The user's activity on a profile's threads in a time range (API 16). Review threads count as the task they review. */
export interface AnalyticsReport {
  /** `prompt` was typed by the user; `start` started a task; `merge` moved it to Ready for merge. */
  events: { at: string; task_id: string; kind: "prompt" | "start" | "merge"; text: string }[];
  /** Agent runs overlapping the range; `ended_at` is null while one is going. */
  runs: { task_id: string; kind: string; started_at: string; ended_at: string | null }[];
  tasks: { id: string; project_id: string | null; kind: string; number: number; title: string; status: Status }[];
  projects: { id: string; name: string; key: string }[];
}

/** How big a profile's threads' contexts were at each turn's end, and their compactions (API 86). */
export interface ContextStatsReport {
  stats: {
    at: string;
    task_id: string;
    kind: "turn" | "compact";
    /** A turn's: the context it left. A compaction's: the context before it. */
    tokens: number | null;
    /** A turn's: what its first request to the model held. */
    start_tokens: number | null;
    /** A compaction's: the context after it, if the agent says. */
    post_tokens: number | null;
    max_tokens: number | null;
    model: string | null;
    /** A compaction's: the agent's own as its context filled up (`auto`), `/compact` (`user`) or the board's after a session sat idle (`idle`). */
    source: "auto" | "user" | "idle" | null;
    cost_usd: number | null;
    duration_ms: number | null;
  }[];
  tasks: AnalyticsReport["tasks"];
  projects: AnalyticsReport["projects"];
}

/** The tokens a profile's runs used, per run and model, what reviewers reported, and the follow-up tasks agents created (API 98). */
export interface TokenStatsReport {
  /** Runs' rows, and from API 99 the model calls that aren't runs (task titles and window restarts). */
  usage: {
    /** Null for a call that isn't a run. */
    run_id: string | null;
    /** The thread the run was in: a task, or a review or summary thread. A title's task; null for a window restart. */
    task_id: string | null;
    /** The run's: `prompt`, `compact` or `review`; or the call's: `title` or `window`. */
    kind: string;
    at: string;
    model: string;
    runtime: "claude" | "codex";
    /** What wasn't read from or written to the cache. */
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
    /** The part of the output the model thought in. */
    reasoning_tokens: number;
    /** Claude Code's; Codex doesn't say. */
    cost_usd: number | null;
    /** From the run's cost alone (its output was gone), or scaled to it. */
    estimated: boolean;
  }[];
  reviews: {
    /** The task reviewed. */
    task_id: string;
    thread_id: string;
    at: string;
    verdict: "pass" | "issues";
    serious: number;
    /** Null for reviews from before minor issues were listed. */
    minor: number | null;
    /** It listed minor issues, or its summary mentions some. */
    minor_noted: boolean;
    label: string | null;
    /** The model the reviewer's run used most. */
    model: string | null;
    /** Which of its task's rounds of review it was in, from 1. */
    round: number;
  }[];
  /** Every round of review of the tasks `reviews` are for, those before the range included. */
  rounds: { task_id: string; round: number; at: string; verdict: "pass" | "issues"; serious: number; reviewers: number }[];
  /** Tasks created by the agents of the tasks listed. */
  follow_ups: { task_id: string; created_by: string; at: string }[];
  tasks: (AnalyticsReport["tasks"][number] & {
    parent_id: string | null;
    task_type: string | null;
    subproject: boolean;
    group_name: string | null;
    /** The model its own runs used most. */
    model: string | null;
  })[];
  projects: AnalyticsReport["projects"];
  /** Runs that have ended but whose tokens aren't counted yet. */
  pending: number;
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

export const analyticsApi = {
  /** The profile's prompts and agent runs in [from, to) (API 16). */
  analytics: (h: string, profileId: string, from: string, to: string) =>
    on(h).get<AnalyticsReport>(`/profiles/${enc(profileId)}/analytics?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),

  /** Context sizes at the end of the profile's turns, and compactions, in [from, to) (API 86). */
  contextStats: (h: string, profileId: string, from: string, to: string) =>
    on(h).get<ContextStatsReport>(`/profiles/${enc(profileId)}/context-stats?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),

  /** The tokens the profile's runs that started in [from, to) used, and its reviews then (API 98). */
  tokenStats: (h: string, profileId: string, from: string, to: string) =>
    on(h).get<TokenStatsReport>(`/profiles/${enc(profileId)}/token-stats?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),

  /** How much space the profile's projects and their worktrees take up (API 35). */
  diskUsage: (h: string, profileId: string) => on(h).get<DiskUsageReport>(`/profiles/${enc(profileId)}/disk-usage`),
};
