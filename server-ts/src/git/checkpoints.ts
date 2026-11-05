// Port of server/src/git/checkpoints.rs.
//
// Checkpoints of a task's worktree (API 70), to see what each of its agent's turns changed and to rewind the task to
// before one of them.
//
// A checkpoint is a commit of everything in the worktree that git doesn't ignore (tracked files as they are on disk,
// and untracked ones), whose parent is the worktree's HEAD then, kept under `refs/huntaway/checkpoints/<task>/<n>`.
// It's made with a scratch index (a copy of the worktree's own, in `GIT_INDEX_FILE`), `git add -A`, `write-tree` and
// `commit-tree`, so the worktree's index, branch and stashes are never touched. One is taken before each run starts,
// when the files or HEAD have changed since the last one (the first run's is the task's baseline), and one when each
// of the agent's turns ends, including turns that were stopped or failed. Each is a row of `checkpoints`, which ties a
// turn's to its run, its number and the message that started it. Only tasks with a worktree of their own get them: the
// others work in their project's repository.
//
// A turn's changes are what differs between the checkpoint it started from and its own, without the files git brought
// in during the turn (a merge, pull or rebase) that the turn didn't change itself (see `brought_in`).
//
// Rewinding to before one of the user's messages restores the files to the checkpoint its turn started from (see
// `restore`), can move the branch back, and can have the agent's next run take its conversation back to before that
// message (see `Rewind`). The checkpoints taken after it are marked stale. Captures, rewinds and dropping a task's
// checkpoints run one at a time per task, in the order they were asked for (see `enqueue`).
import { all, one, run as exec, type Conn, type Task } from "../db.ts";
import type { AppState } from "../state.ts";

export * from "./checkpoints/git.ts";
export * from "./checkpoints/capture.ts";
export * from "./checkpoints/changed.ts";
export * from "./checkpoints/handlers.ts";
export * from "./checkpoints/restore.ts";

/** Checkpoints a task keeps; the oldest go first. */
export const MAX_CHECKPOINTS = 200;
/** Untracked files bigger than this are left out of checkpoints. */
export const MAX_UNTRACKED_FILE = 50 << 20;
/** With more untracked files than this (a folder that should be ignored, say), no checkpoint is taken. */
export const MAX_UNTRACKED = 20_000;
/** Commits a turn can bring in before its changes are shown without leaving any out. */
export const MAX_COMMITS = 5000;
/** Past this a diff isn't sent. */
export const MAX_DIFF = 4 << 20;

export function ref_prefix(task_id: string): string {
  return `refs/huntaway/checkpoints/${task_id}/`;
}

export function ref_name(task_id: string, n: number): string {
  return `${ref_prefix(task_id)}${n}`;
}

/** A conversation rollback that a task's next run makes, after a rewind (`tasks.rewind`). */
export interface Rewind {
  /** The turn it goes back to before. */
  turn: number;
  /** The message that turn started with. */
  message_id: number;
  /** The agent's session (Claude) or thread (Codex) it's for: a run on another one leaves it. */
  session: string;
  /** Claude: resume the session at this message (`--resume-session-at`). */
  resume_at?: string;
  /** Codex: revert the thread to before this turn (`thread/revert`). */
  before_turn?: string;
}

/** A checkpoint, as `checkpoints` keeps it. */
export interface Checkpoint {
  n: number;
  /** start (before a run), turn (after one of the agent's turns) or rewind (the files a rewind replaced). */
  kind: string;
  sha: string;
  tree: string;
  /** The worktree's HEAD then (null before its first commit). */
  head: string | null;
  /** A turn's: the checkpoint it started from. */
  before_n: number | null;
  run_id: string | null;
  /** A turn's number among the task's. */
  turn: number | null;
  /** A turn's: the user message it started with. */
  message_id: number | null;
  /** A turn's: done, stopped or failed. */
  status: string | null;
  /** The agent's session (Claude) or thread (Codex) then. */
  session: string | null;
  /**
   * A turn's place in the agent's conversation: Claude's last message in it (to resume after the turn), Codex's id for
   * the turn (to revert to before it).
   */
  agent_at: string | null;
  stats: Stats | null;
  /** 0, 1 once a rewind has gone back to before it, 2 when that took the conversation back too. */
  stale: number;
  created_at: string;
}

/** What a turn changed, without the files git brought in. */
export interface Stats {
  files: number;
  additions: number;
  deletions: number;
  /** Files git brought in that are left out (the first 200), and how many there are. */
  excluded: string[];
  excluded_count: number;
}

export function Stats_default(): Stats {
  return { files: 0, additions: 0, deletions: 0, excluded: [], excluded_count: 0 };
}

function parse_stats(s: string | null): Stats | null {
  if (s == null) return null;
  try {
    const v = JSON.parse(s);
    if (typeof v !== "object" || v === null || typeof v.files !== "number" || typeof v.additions !== "number" || typeof v.deletions !== "number") return null;
    return { files: v.files, additions: v.additions, deletions: v.deletions, excluded: v.excluded ?? [], excluded_count: v.excluded_count ?? 0 };
  } catch {
    return null;
  }
}

export function Checkpoint_from_row(r: any): Checkpoint {
  return {
    n: r.n,
    kind: r.kind,
    sha: r.sha,
    tree: r.tree,
    head: r.head ?? null,
    before_n: r.before_n ?? null,
    run_id: r.run_id ?? null,
    turn: r.turn ?? null,
    message_id: r.message_id ?? null,
    status: r.status ?? null,
    session: r.session ?? null,
    agent_at: r.agent_at ?? null,
    stats: parse_stats(r.stats ?? null),
    stale: r.stale,
    created_at: r.created_at,
  };
}

/** A task's checkpoints, oldest first. */
export function list(c: Conn, task_id: string): Checkpoint[] {
  return all(c, "SELECT * FROM checkpoints WHERE task_id=?1 ORDER BY n", task_id).map(Checkpoint_from_row);
}

/** The latest checkpoint a rewind hasn't gone back past: where the next turn starts from. */
export function latest(c: Conn, task_id: string): Checkpoint | null {
  const r = one(c, "SELECT * FROM checkpoints WHERE task_id=?1 AND stale=0 ORDER BY n DESC LIMIT 1", task_id);
  return r ? Checkpoint_from_row(r) : null;
}

export function insert(c: Conn, task_id: string, cp: Checkpoint): void {
  exec(
    c,
    `INSERT INTO checkpoints (task_id,n,kind,sha,tree,head,before_n,run_id,turn,message_id,status,session,agent_at,stats,stale,created_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)`,
    task_id,
    cp.n,
    cp.kind,
    cp.sha,
    cp.tree,
    cp.head,
    cp.before_n,
    cp.run_id,
    cp.turn,
    cp.message_id,
    cp.status,
    cp.session,
    cp.agent_at,
    cp.stats ? JSON.stringify(cp.stats) : null,
    cp.stale,
    cp.created_at,
  );
}

// ---------- the queue ----------

export type Job = (s: AppState) => Promise<void>;

/** Each task's jobs: the last one asked for, which the next one waits on. */
const QUEUES = new Map<string, Promise<void>>();

/** Run `job` after the task's jobs asked for before it. */
export function enqueue(state: AppState, task_id: string, job: Job): void {
  const prev = QUEUES.get(task_id) ?? Promise.resolve();
  const next: Promise<void> = prev.then(() => job(state)).catch((e) => console.error(`a checkpoint job of task ${task_id} failed:`, e));
  QUEUES.set(task_id, next);
  // Nothing waiting: the queue goes, unless a job came in meanwhile.
  next.then(() => {
    if (QUEUES.get(task_id) === next) QUEUES.delete(task_id);
  });
}

/** Run `f` in the task's queue and wait for it (what it throws is thrown here). */
export function queued<T>(state: AppState, task_id: string, f: (s: AppState) => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    enqueue(state, task_id, async (s) => {
      try {
        resolve(await f(s));
      } catch (e) {
        reject(e);
      }
    });
  });
}

// ---------- runs ----------

/** The conversation rollback to make in a run of `task` on its session, if there's one for it. */
export function pending_rewind(task: Task): Rewind | null {
  const r: Rewind | null = (task as any).rewind ?? null;
  return r && task.session_id != null && task.session_id === r.session ? r : null;
}

/** For tests: a task's checkpoints once the ones asked for are taken. */
export function settled(state: AppState, task_id: string): Promise<Checkpoint[]> {
  return queued(state, task_id, async (s) => list(s.db(), task_id));
}
