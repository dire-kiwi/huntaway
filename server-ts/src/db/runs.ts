// Port of server/src/db/runs.rs: agent runs (see agent/runner.rs and agent/runs.rs).
import { all, one, run, value, type Conn } from "../db.ts";
import { new_id, now } from "../util.ts";

export interface Run {
  id: string;
  task_id: string;
  /** prompt, or compact (summarising the conversation, see runner::compact) */
  kind: string;
  /** preparing (worktree setup etc.), running, exited */
  status: string;
  out_offset: number;
  stop_requested: boolean;
  attention: string | null;
  result_error: string | null;
  saw_result: boolean;
  /** What the agent has cost in this run so far (see `add_cost`). */
  cost_usd: number;
  /** Its last turn has ended, and no message has started another yet. */
  between_turns: boolean;
  /** The user message its turn started with (see git/checkpoints.rs). */
  turn_message_id: number | null;
  /** Where its conversation is (see checkpoints::Checkpoint::agent_at). */
  agent_at: string | null;
  created_at: string;
  ended_at: string | null;
}

export function Run_from_row(r: any): Run {
  return {
    id: r.id,
    task_id: r.task_id,
    kind: r.kind,
    status: r.status,
    out_offset: r.out_offset,
    stop_requested: !!r.stop_requested,
    attention: r.attention ?? null,
    result_error: r.result_error ?? null,
    saw_result: !!r.saw_result,
    cost_usd: r.cost_usd,
    between_turns: !!r.between_turns,
    turn_message_id: r.turn_message_id ?? null,
    agent_at: r.agent_at ?? null,
    created_at: r.created_at,
    ended_at: r.ended_at ?? null,
  };
}

export function insert_run(c: Conn, task_id: string, kind: string): Run {
  const id = new_id();
  run(c, "INSERT INTO runs (id,task_id,kind,status,created_at) VALUES (?1,?2,?3,'preparing',?4)", id, task_id, kind, now());
  return get_run(c, id)!;
}

export function get_run(c: Conn, id: string): Run | null {
  const r = one(c, "SELECT * FROM runs WHERE id=?1", id);
  return r ? Run_from_row(r) : null;
}

/** The task's latest run (of `kind`, if given). */
export function latest_run(c: Conn, task_id: string, kind: string | null): string | null {
  return value<string>(c, "SELECT id FROM runs WHERE task_id=?1 AND (?2 IS NULL OR kind=?2) ORDER BY rowid DESC LIMIT 1", task_id, kind) ?? null;
}

/** Whether `run_id` is a run of the task started after run `after` (any of its runs if `after` isn't one). */
export function run_after(c: Conn, task_id: string, run_id: string, after: string): boolean {
  return !!value(
    c,
    "SELECT EXISTS(SELECT 1 FROM runs WHERE id=?1 AND task_id=?2 AND rowid > COALESCE((SELECT rowid FROM runs WHERE id=?3), -1))",
    run_id, task_id, after,
  );
}

/**
 * Whether a run has been started on the task since `run_id` was. The latest run's start and end set the task's running
 * state and column; an earlier run that ends after it must leave them.
 */
export function later_run(c: Conn, task_id: string, run_id: string): boolean {
  return !!value(c, "SELECT EXISTS(SELECT 1 FROM runs WHERE task_id=?1 AND rowid > COALESCE((SELECT rowid FROM runs WHERE id=?2), -1))", task_id, run_id);
}

/**
 * Add what run `run_id`'s agent has cost since it last said, from `total`, the `total_cost_usd` of a Claude Code `result`
 * in `session`, and return that. The total is the session's: a run that resumes one starts from what its earlier runs
 * cost (Claude Code keeps a session's cost for it), so what the run adds is the increase over the session's last total,
 * the run's own or else its task's latest earlier run's in that session. A new session (a review round's, say) starts
 * from nothing, as does one whose total went down in a result that `counted` the model's use (it has `modelUsage`):
 * Claude Code started counting again. A lower total in a result that didn't (Claude Code's own for a turn that failed,
 * with a total of 0) is no count at all, and charges nothing.
 */
export function add_cost(c: Conn, run_id: string, session: string | null, total: number, counted: boolean): number {
  const b = value<number>(
    c,
    `SELECT o.session_cost FROM runs r JOIN runs o ON o.task_id=r.task_id AND o.rowid <= r.rowid
             WHERE r.id=?1 AND o.session_cost IS NOT NULL AND (o.session_id=?2 OR (o.id=r.id AND ?2 IS NULL))
             ORDER BY o.rowid DESC LIMIT 1`,
    run_id, session,
  );
  let before = 0;
  if (b !== undefined && b > total && !counted) return 0;
  if (b !== undefined && b <= total) before = b;
  const cost = total - before;
  run(c, "UPDATE runs SET cost_usd=cost_usd+?1, session_id=COALESCE(?2, session_id), session_cost=?3 WHERE id=?4", cost, session, total, run_id);
  return cost;
}

/** The Claude Code session run `run_id` is in, from its `init` (see `add_cost`). */
export function set_run_session(c: Conn, run_id: string, session: string): void {
  run(c, "UPDATE runs SET session_id=?1 WHERE id=?2", session, run_id);
}

/** The folder run `run_id`'s agent is started with (see `session_config_dir`): '' for the agent's default. */
export function set_run_config_dir(c: Conn, run_id: string, dir: string | null): void {
  run(c, "UPDATE runs SET config_dir=?1 WHERE id=?2", dir ?? "", run_id);
}

/**
 * The folder the task's conversation `session` is kept in: the one its first run (the one that started it) was given,
 * '' for the agent's default. Undefined if that isn't known (a session from before runs kept their folder).
 */
export function session_config_dir(c: Conn, task_id: string, session: string): string | undefined {
  const r = one(c, "SELECT config_dir FROM runs WHERE task_id=?1 AND session_id=?2 ORDER BY rowid LIMIT 1", task_id, session);
  return typeof r?.config_dir === "string" ? r.config_dir : undefined;
}

/** Whether a run on the task hasn't exited yet. */
export function has_active_run(c: Conn, task_id: string): boolean {
  return !!value(c, "SELECT EXISTS(SELECT 1 FROM runs WHERE task_id=?1 AND status != 'exited')", task_id);
}

/** Runs that haven't exited, oldest first. */
export function active_runs(c: Conn): Run[] {
  return all(c, "SELECT * FROM runs WHERE status != 'exited' ORDER BY created_at").map(Run_from_row);
}

/**
 * Threads to compact because they've been idle since `idle_since`, but not since before `not_before`: their last run
 * was a prompt that ended in that window, and nothing has happened on them since. Finished tasks, merges waiting for
 * their turn, tasks being reviewed and archived projects' threads are left alone.
 */
export function idle_sessions(c: Conn, idle_since: string, not_before: string): string[] {
  return all(
    c,
    `SELECT t.id FROM tasks t JOIN runs r ON r.id = (SELECT id FROM runs WHERE task_id=t.id ORDER BY created_at DESC LIMIT 1)
         WHERE t.session_id IS NOT NULL AND t.running=0 AND t.status != 'done' AND t.last_activity_at <= ?1
           AND NOT (t.merging=1 AND t.status='ready_for_merge')
           AND (t.review IS NULL OR json_extract(t.review, '$.state') != 'running')
           AND (t.project_id IS NULL OR t.project_id NOT IN (SELECT id FROM projects WHERE archived_at IS NOT NULL))
           AND r.kind='prompt' AND r.status='exited' AND r.ended_at <= ?1 AND r.ended_at > ?2`,
    idle_since, not_before,
  ).map((r) => r.id);
}
