// Port of server/src/agent/runner.rs.
/**
 * Agent runs. A run is `claude -p` (or Codex, see agent/codex.ts) under an ia-shim (see `runs`); its output is followed
 * from disk (resuming from a saved offset after a restart), becomes thread messages, and its outcome moves the task
 * between board columns. Runs outlive server restarts: their durable state is the `runs` table plus the run's files.
 */
import * as db from "../db.ts";
import type { Conn, Message, Profile, Project, Queued, Run, Task } from "../db.ts";
import { ApiError } from "../http.ts";
import type { Shared } from "../state.ts";
import { err_str, expand_tilde, new_id, now, reached } from "../util.ts";
import * as runs from "./runs.ts";
import * as documents from "./documents.ts";
import * as permissions from "../mcp/permissions.ts";
import * as automations from "../integrations/automations.ts";
import { launch } from "./runner/launch.ts";
import { requeue_ahead, check_not_archived, start_unblocked } from "./runner/send.ts";
import { requeue_steers, set_writes_documents, write_steers, close_unless_taken_in, has_queued, send_queued, turn_ended } from "./runner/queue.ts";
import { finish } from "./runner/output.ts";
import { start_queued_merges } from "./runner/merge.ts";

export * from "./runner/access.ts";
export * from "./runner/merge.ts";
export * from "./runner/output.ts";
export * from "./runner/prompt.ts";
export * from "./runner/queue.ts";
export * from "./runner/send.ts";

export const MCP_SERVER_NAME = "huntaway";
/**
 * The board's MCP server name before the rename to Huntaway. Runs started by an older build, and their transcripts,
 * still call its tools `mcp__issue_agent__<tool>`.
 */
export const LEGACY_MCP_SERVER_NAME = "issue_agent";

/** Whether an MCP server name is the board's own server, under its current or old name. */
export function is_board_server(name: string): boolean {
  return name === MCP_SERVER_NAME || name === LEGACY_MCP_SERVER_NAME;
}

/** Whether this is a test process (Rust's `cfg!(test)`): `node --test` sets NODE_TEST_CONTEXT in its test processes. */
const IN_TEST = !!process.env.NODE_TEST_CONTEXT;

/** How long a stopped agent has to end its turn before its process is stopped (ms). */
export const STOP_GRACE = IN_TEST ? 1000 : 10_000;
/**
 * How long an agent that ended its turn with messages still waiting for it has to start the next turn with them (ms).
 * If it doesn't, its input is closed (it exits) and they're sent to the next run instead.
 */
export const STEER_GRACE = IN_TEST ? 1000 : 30_000;

/**
 * A session idle this long is compacted while its prompt cache (1 hour) is still warm, so compacting is cheap and the
 * next prompt starts from a small context (ms).
 */
export const AUTO_COMPACT_AFTER = 50 * 60_000;
/** Past this, the cache has expired: compacting would cost as much as it saves (ms). */
export const AUTO_COMPACT_UNTIL = 60 * 60_000;

/**
 * What a run's start does with the message queued on its thread. `Ahead`: it goes ahead of the run's message. `Only`:
 * the run is for it: it doesn't start if there's none (another run took it).
 */
export type Take = "No" | "Ahead" | "Only";

/**
 * How a run ended. As serde writes Rust's `Outcome` enum: `"Ok"`, `"Cancelled"`, or `{Failed: "why"}`.
 */
export type Outcome = "Ok" | "Cancelled" | { Failed: string };

export const Outcome_Failed = (e: string): Outcome => ({ Failed: e });

/** The error of a failed outcome, or null. */
export function outcome_error(o: Outcome): string | null {
  return typeof o === "object" ? o.Failed : null;
}

/** A copy of a row, with its fields serde skips (non-enumerable, see db::hidden) too. */
export function clone<T extends object>(v: T): T {
  return Object.defineProperties({}, Object.getOwnPropertyDescriptors(v)) as T;
}

/** A run's launch was stopped while it was being prepared. */
export class Cancelled extends Error {
  constructor() {
    super("cancelled");
  }
}

/**
 * Register a run on a thread and start it in the background. `kind` is the run's: prompt, compact or review. `take`
 * says what happens to the message queued on the thread. `record` adds the thread messages that explain the run, in
 * the transaction that registers it: if the server stops part way, either the queued message is still queued, or the
 * run, its messages and the queue's being emptied are all recorded.
 */
export function start_run(
  state: Shared,
  task_id: string,
  message: Queued,
  kind: string,
  take: Take,
  record: (c: Conn, task: Task, message: Queued) => Message[],
): Task {
  const compact = kind === "compact";
  if (!runs.can_run_agents(state)) throw ApiError.bad("This host can't run agents (it has no claude or codex CLI, or no ia-shim)");
  const task = db.get_task(state.db(), task_id);
  if (!task) throw ApiError.not_found("task");
  const agent = db.task_is_codex(state.db(), task) ? "codex" : "claude";
  if (!runs.has_agent(agent)) throw ApiError.bad(`This host has no ${agent} CLI for this thread's config`);
  if (compact && task.session_id == null) throw ApiError.bad("There's no conversation to compact yet");
  if (state.runs.has(task_id)) throw ApiError.conflict("an agent is already running on this thread");
  // Checked with the runs map as it is, as archiving is (see api::archive).
  check_not_archived(state, task);
  const c = state.db();
  const { run, text, taken, recorded } = db.tx(c, () => {
    const taken = take === "No" ? null : db.take_queued(c, task_id);
    if (take === "Only" && !taken) throw ApiError.conflict("nothing is queued to send");
    const msg = taken ? db.queued_then(taken, message) : { ...message, routine_runs: [...(message.routine_runs ?? [])] };
    // An automation's start of a task it made, held back (for a usage limit, say), left its run for the task's first run
    // (see db.queue).
    if (!taken && kind === "prompt" && task.session_id == null) msg.routine_runs.push(...db.take_parked_runs(c, task_id));
    const run = db.insert_run(c, task_id, kind);
    // The routines whose messages it starts with are this run's, for its cost.
    automations.routines.taken_in(c, run.id, msg.routine_runs);
    const recorded = record(c, task, msg);
    return { run, text: msg.text, taken, recorded };
  });
  // The launch's end (Rust's `select!` between the launch and its cancelling): the first of the two settles it.
  let pending = true;
  let cancelled = false;
  const ended = (launched: boolean | Error) => {
    if (!pending) return;
    pending = false;
    queueMicrotask(() => {
      try {
        launch_ended(state, run, launched);
      } catch (e) {
        console.error(`run ${run.id}: ending its launch: ${err_str(e)}`);
      }
    });
  };
  // Stops the launch while it's being prepared (Rust's oneshot): false once the launch is over.
  const cancel = (): boolean => {
    if (!pending) return false;
    cancelled = true;
    ended(false);
    return true;
  };
  state.runs.set(task_id, { run_id: run.id, cancel });
  for (const m of recorded) state.emit_message(m);
  // The message its first turn starts with (see git/checkpoints.rs).
  const first = recorded.find((m) => m.kind === "user");
  if (first) {
    try {
      db.run(c, "UPDATE runs SET turn_message_id=?1 WHERE id=?2", first.id, run.id);
    } catch {}
  }
  reached("run:started");
  const fields: Array<[string, any]> = [
    ["running", true],
    ["steerable", !compact],
  ];
  // A queued message sent as the last run ends carries on the same stretch of work.
  if (!task.running) fields.push(["run_started_at", now()]);
  if (!compact) {
    fields.push(["attention_reason", null], ["waiting", false], ["limit_reset_at", null]);
    if (task.kind === "task") fields.push(["status", db.working_status(task)]);
  }
  let updated: Task | null;
  try {
    updated = state.update_task(task_id, fields);
  } catch (e) {
    // Deleted meanwhile, say: the run never starts, and what it took goes back.
    abandon(state, run, taken);
    throw e;
  }
  if (!updated) {
    abandon(state, run, taken);
    throw ApiError.not_found("task");
  }

  launch(state, run, text, () => cancelled).then(
    () => ended(true),
    // A launch that goes on after it was stopped throws Cancelled at its next step (see launch's `check`).
    (e) => ended(e instanceof Cancelled ? false : e instanceof Error ? e : new Error(String(e))),
  );
  return updated;
}

/**
 * Drop a run that was registered but can't start: its handle and row go, and the messages it took (queued, or sent to
 * it meanwhile) are queued again.
 */
export function abandon(state: Shared, run: Run, taken: Queued | null) {
  const task_id = run.task_id;
  try {
    if (taken) requeue_ahead(state, task_id, taken);
    requeue_steers(state, task_id, run.id);
    // Without its row, the run before it writes its end as it would have (see end_run).
    db.run(state.db(), "DELETE FROM runs WHERE id=?1", run.id);
    // Unless that run has ended already, and left its end to this one: the task isn't running.
    const idle = (c: Conn) => (db.get_task(c, task_id)?.running ?? false) && !db.has_active_run(c, task_id);
    state.update_task_if(task_id, [["running", false]], idle);
  } catch (e) {
    console.error(`task ${task_id} run ${run.id}: dropping a run that couldn't start: ${err_str(e)}`);
  }
  if (state.runs.get(task_id)?.run_id === run.id) state.runs.delete(task_id);
  set_writes_documents(run.id, false);
}

/**
 * A run's launch is over: it started (`true`), was stopped while it was being prepared (`false`) or failed (an
 * Error). Unless it started, nothing it launched may go on: an agent that reads its input as it works would wait for
 * more forever, and one started after the launch gave up on it would work unseen.
 */
export function launch_ended(state: Shared, run: Run, launched: boolean | Error) {
  if (launched === true) return; // output now arrives from the host
  runs.reap(state, run.id);
  if (launched === false) finish(state, run.id, "Cancelled");
  else finish(state, run.id, { Failed: err_str(launched) });
}

/** Stop the run on this thread at once and drop any queued message, e.g. before deleting the thread. */
export function abort(state: Shared, task_id: string): boolean {
  try {
    db.clear_queued(state.db(), task_id);
  } catch {}
  try {
    db.update_task(state.db(), task_id, [["steering", []]]);
  } catch {}
  return stop_run(state, task_id, true);
}

/**
 * Ask the run on this thread to stop. An agent that takes input while it works is asked to end its turn (like Esc in
 * Claude Code), so its session stays resumable; any message it hasn't taken in yet then starts its next turn. Others
 * are stopped. Their exit is picked up from the run's files, and a queued message is sent as soon as it has stopped.
 */
export function stop(state: Shared, task_id: string): boolean {
  return stop_run(state, task_id, false);
}

function stop_run(state: Shared, task_id: string, kill: boolean): boolean {
  const h = state.runs.get(task_id);
  if (!h) return false;
  const run_id = h.run_id;
  const cancel = h.cancel;
  h.cancel = null;
  // 1 until the turn it interrupts ends, then 2 (see `record_result`). A later stop gets its own id, so the timer of
  // an earlier one (see `stop_unless_interrupted`) leaves it alone.
  const stop_id = `stop-${new_id()}`;
  try {
    db.run(state.db(), "UPDATE runs SET stop_requested=1, stop_id=?2 WHERE id=?1", run_id, stop_id);
  } catch {}
  if (cancel && (cancel as () => boolean | void)() !== false) return true;
  // Between turns, an agent kept going by its background tasks (see queue::turn_ended) has no turn to interrupt.
  if (!kill && runs.background_tasks(state, run_id) > 0) kill = idle(state, run_id);
  if (!kill && interrupt(state, run_id, stop_id)) return true;
  runs.close_input(state, run_id);
  if (!runs.kill(state, run_id) && !runs.exists(state, run_id)) {
    // Never got as far as starting claude.
    finish(state, run_id, "Cancelled");
  }
  return true;
}

/** Whether the run is between turns, with no message sent to it waiting to start the next. */
function idle(state: Shared, run_id: string): boolean {
  try {
    const run = db.get_run(state.db(), run_id);
    if (!run?.between_turns) return false;
    return !db.get_task(state.db(), run.task_id)?.steering.some((s) => s.run_id === run_id);
  } catch {
    return false;
  }
}

/** Ask the agent to end its turn now, for the stop `stop_id`. Returns false if it doesn't take input any more. */
function interrupt(state: Shared, run_id: string, stop_id: string): boolean {
  const line = { type: "control_request", request_id: stop_id, request: { subtype: "interrupt" } };
  try {
    if (!runs.write_input(state, run_id, JSON.stringify(line))) return false;
  } catch (e) {
    console.warn(`run ${run_id}: couldn't interrupt the agent: ${err_str(e)}`);
    return false;
  }
  stop_unless_interrupted(state, run_id, stop_id);
  return true;
}

/** Stop the run's process if the turn the stop `stop_id` interrupts hasn't ended within STOP_GRACE. */
function stop_unless_interrupted(state: Shared, run_id: string, stop_id: string) {
  setTimeout(() => {
    let stopping: number | undefined;
    try {
      stopping = db.value<number>(
        state.db(),
        "SELECT stop_requested FROM runs WHERE id=?1 AND COALESCE(stop_id, '')=?2 AND status != 'exited'",
        run_id,
        stop_id,
      );
    } catch {}
    if (stopping === 1) {
      console.warn(`run ${run_id}: the agent didn't end its turn when stopped; stopping its process`);
      runs.close_input(state, run_id);
      runs.kill(state, run_id);
    }
  }, STOP_GRACE).unref();
}

export function load(state: Shared, task_id: string): [Task, Project | null, Profile] {
  const c = state.db();
  const task = db.get_task(c, task_id);
  if (!task) throw new Error("task not found");
  const project = task.project_id ? db.get_project(c, task.project_id) : null;
  const profile = db.get_profile(c, task.profile_id);
  if (!profile) throw new Error("profile not found");
  return [task, project, profile];
}

/** Where the running agent of `task` works, as `launch` picked it (its worktree is set up by now). */
export function work_dir(state: Shared, task: Task): string {
  const d = documents.work_dir(state, task);
  if (d) return d;
  const project = task.project_id ? db.get_project(state.db(), task.project_id) : null;
  let dir: string;
  if (task.kind === "review" && project) {
    const parent = task.parent_id ? db.get_task(state.db(), task.parent_id) : null;
    if (parent && parent.use_worktree) {
      if (parent.worktree_path == null) throw new Error("the task's worktree isn't set up");
      dir = parent.worktree_path;
    } else {
      dir = project.repo_path;
    }
  } else if (project && task.use_worktree) {
    if (task.worktree_path == null) throw new Error("worktree path missing");
    dir = task.worktree_path;
  } else if (project) {
    dir = project.repo_path;
  } else {
    return state.profile_scratch_dir(task.profile_id);
  }
  return expand_tilde(dir);
}

/** Startup: resume following runs that were active when the server stopped. */
export function load_active(state: Shared) {
  runs.resume_reaping(state);
  const active = db.active_runs(state.db());
  for (const run of active) {
    state.runs.set(run.task_id, { run_id: run.id, cancel: null });
    if (runs.exists(state, run.id) && runs.format(state, run.id) > runs.RUN_FORMAT) {
      // Written by a newer build (a downgrade); we can't follow it safely, so its agent is stopped rather than left
      // working (and calling the board's tools) unfollowed.
      runs.reap(state, run.id);
      finish(state, run.id, { Failed: "This run was started by a newer huntaway; update this host to follow it" });
    } else if (runs.exists(state, run.id)) {
      if (run.status === "preparing") db.run(state.db(), "UPDATE runs SET status='running' WHERE id=?1", run.id);
      console.log(`run ${run.id}: resuming run at offset ${run.out_offset}`);
      runs.follow(state, run.id, run.out_offset);
      const takes_input = runs.accepts_input(state, run.id);
      const task = db.get_task(state.db(), run.task_id);
      // A run started before steering, or by a build that queued its messages, doesn't.
      const steerable = run.kind !== "compact" && takes_input;
      if (task && task.steerable !== steerable) state.update_task(run.task_id, [["steerable", steerable]]);
      const row = db.one<{ stop_requested: number; stop_id: string | null; between_turns: number }>(
        state.db(),
        "SELECT stop_requested, stop_id, between_turns FROM runs WHERE id=?1",
        run.id,
      );
      if (!row) throw new Error("Query returned no rows");
      if (row.stop_requested === 1 && takes_input) stop_unless_interrupted(state, run.id, row.stop_id ?? "");
      // Its turn ended, maybe before the end was seen to (see `turn_ended`): the messages it has been sent start the
      // next one, written now if they weren't, or else its input is closed so it exits.
      if (row.between_turns && takes_input) {
        // Those it can't be sent are taken back once it doesn't take them in (see `finish`).
        let t: Task | null = task;
        try {
          t = write_steers(state, run.task_id);
        } catch (e) {
          console.error(`run ${run.id}: sending the agent the messages it was sent: ${err_str(e)}`);
        }
        const waiting = (t?.steering ?? []).filter((s) => s.run_id === run.id).map((s) => s.id);
        if (waiting.length) close_unless_taken_in(state, run, waiting);
        else turn_ended(state, run);
      }
    } else {
      // We stopped while preparing (e.g. setting up the worktree), before claude started, or before ia-shim wrote its
      // output: an agent it starts now is stopped.
      runs.reap(state, run.id);
      finish(state, run.id, { Failed: "Interrupted by a server restart before the agent started" });
    }
  }
  // Threads marked running without a run: their last one ended as the server stopped, before its end was written (or
  // they're from a build that predates durable runs).
  const orphans = db.all<{ id: string }>(state.db(), "SELECT id FROM tasks WHERE running=1").map((r) => r.id);
  for (const id of orphans.filter((id) => !state.is_running(id))) {
    // What was queued for after it goes now, as it would have.
    if (has_queued(state, state.runs, id) && send_queued(state, id)) continue;
    state.add_event(id, "warn", "Run interrupted by server restart");
    const t = db.get_task(state.db(), id);
    const fields: Array<[string, any]> = [["running", false]];
    if (t?.kind === "task") fields.push(["status", "needs_attention"], ["attention_reason", "Interrupted by server restart"]);
    state.update_task(id, fields);
  }
  // Prompts from runs that no longer exist can never be answered.
  const stale = db
    .all<{ task_id: string }>(
      state.db(),
      `SELECT DISTINCT p.task_id FROM permission_requests p WHERE p.status='pending'
       AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.task_id=p.task_id AND r.status != 'exited')`,
    )
    .map((r) => r.task_id);
  for (const task_id of stale) permissions.expire_for_task(state, task_id);
  // Subprojects from before their status followed their tasks.
  for (const sp of db.subprojects(state.db())) state.sync_subproject(sp);
  start_queued_merges(state);
  start_unblocked(state, null);
}
