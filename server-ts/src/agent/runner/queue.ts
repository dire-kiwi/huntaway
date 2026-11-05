// Port of server/src/agent/runner/queue.rs: messages for a task's agent while it runs: steering them into its turn, or
// queueing them for the next run, which starts once this one ends.
import * as db from "../../db.ts";
import type { Queued, Run, Steer, Task } from "../../db.ts";
import { ApiError } from "../../http.ts";
import type { RunHandle, Shared } from "../../state.ts";
import { err_str, new_id, path_str } from "../../util.ts";
import * as runs from "../runs.ts";
import * as documents from "../documents.ts";
import { STEER_GRACE } from "../runner.ts";
import { is_compact, send_as, send_message } from "./send.ts";

/**
 * Send a user message on a thread and start an agent run for it. Returns immediately; the run continues in the
 * background. While an agent is running the message goes to it straight away instead (see `steer`), or, for runs that
 * can't take it, is queued (added to any already queued) and sent once that run ends, including when it's stopped.
 */
export function send(state: Shared, task_id: string, text: string): Task {
  return send_as(state, task_id, text, false);
}

/**
 * Steering: an agent run reads stream-json input while it works (Claude Code's `--input-format stream-json`, or the
 * Codex adapter's `turn/steer`). A message sent while it runs is written to its input at once, and the agent takes it in
 * at its next step (after the tool call it's in), in the same turn. It's kept on the task (`steering`) until the agent
 * echoes it back, and goes in the thread at that point. Claude Code echoes a message when it takes it in, not when it
 * receives it (checked with 2.1.306): one that arrives as a turn ends, during the final reply, is echoed after that
 * turn's `result`, and starts the next turn of the same process. When a turn ends with nothing waiting, the input is
 * closed so the agent exits and the run ends; whatever the agent never took in is sent as the next prompt (see
 * `finish`).
 */
function can_steer(state: Shared, run: Run): boolean {
  // A run being prepared will take input once it starts (see `started`).
  return run.kind !== "compact" && (run.status === "preparing" || runs.accepts_input(state, run.id));
}

/**
 * Send `text` to the agent running on the thread, if there is one: into its current turn if it takes input as it works
 * (see `can_steer`), else queued for when the run ends. Synchronous, so a run can't end between the check and the write
 * without picking the message up (see `finish`).
 */
export function steer_or_queue(state: Shared, task_id: string, message: Queued): Task | null {
  const handle = state.runs.get(task_id);
  if (!handle) return null;
  let task = db.get_task(state.db(), task_id);
  if (!task) throw ApiError.not_found("task");
  const text = message.text.trim();
  const from_agent = message.from_agent;
  if (!text) return task;
  const plan = task.kind === "task" && documents.plan_command(text) != null;
  const r = db.get_run(state.db(), handle.run_id);
  const run = r && !is_compact(text) && !(plan && !writes_documents(r.id)) && can_steer(state, r) ? r : null;
  let t: Task | null;
  if (run) {
    const steering: Steer[] = [...task.steering, { id: new_id(), text, from_agent, run_id: run.id, written: false }];
    db.update_task(state.db(), task_id, [["steering", steering]]);
    t = write_steers(state, task_id);
  } else {
    t = db.queue(state.db(), task_id, { ...message, text });
  }
  if (!t) throw ApiError.not_found("task");
  task = t;
  state.emit_task(task);
  return task;
}

/**
 * The runs that can write their task's own folder (see agent/documents.rs), as they started with labels or work in it.
 * A `/plan` sent to any other run waits for the next instead: its sandbox (Codex's writable roots, Claude Code's
 * directories) may not let it write the plan.
 */
const WRITE_DOCUMENTS = new Set<string>();

export function writes_documents(run_id: string): boolean {
  return WRITE_DOCUMENTS.has(run_id);
}

export function set_writes_documents(run_id: string, writes: boolean) {
  if (writes) WRITE_DOCUMENTS.add(run_id);
  else WRITE_DOCUMENTS.delete(run_id);
}

/** A stream-json user message, as the agent's input takes it. */
export function user_input(id: string, text: string): string {
  return JSON.stringify({ type: "user", uuid: id, message: { role: "user", content: text } });
}

/** Write the steered messages the thread's run hasn't been sent yet to its input. */
export function write_steers(state: Shared, task_id: string): Task | null {
  const task = db.get_task(state.db(), task_id);
  if (!task) return null;
  let wrote = false;
  // `/plan` (only steered into a run that can write the plan, see WRITE_DOCUMENTS): the run may have started without
  // the plan label, so its system prompt may not say how.
  const plan_path = task.kind === "task" ? documents.path(state, task, "plan") : null;
  const plan_file = plan_path != null ? path_str(plan_path) : null;
  for (const s of task.steering.filter((s) => !s.written)) {
    const rest = plan_file != null ? documents.plan_command(s.text) : null;
    const plan = plan_file != null && rest != null ? documents.plan_prompt(plan_file, rest, false) : null;
    if (!runs.write_input(state, s.run_id, user_input(s.id, plan ?? s.text))) break; // keep the order: the rest wait with it
    s.written = true;
    wrote = true;
  }
  if (wrote) return db.update_task(state.db(), task_id, [["steering", task.steering]]);
  return task;
}

/** The agent took in a message sent to it while it worked (its input echoed back): the message goes in the thread here. */
export function steered(state: Shared, run: Run, id: string) {
  const task_id = run.task_id;
  const task = db.get_task(state.db(), task_id);
  if (!task) return;
  // Anything else is the prompt, or a message replayed after a restart.
  const steer = task.steering.find((s) => s.id === id);
  if (!steer) return;
  const rest = task.steering.filter((s) => s.id !== id);
  const updated = db.update_task(state.db(), task_id, [["steering", rest]]);
  // It answers a question the agent asked. Taken in after a turn ended, it starts a new one; after a stop ended the
  // turn, the run is then no longer stopped (see `stop`).
  const new_turn = db.value<number>(state.db(), "SELECT between_turns FROM runs WHERE id=?1", run.id);
  if (new_turn === undefined) throw new Error("Query returned no rows");
  db.run(
    state.db(),
    "UPDATE runs SET attention=NULL, between_turns=0, stop_requested = CASE WHEN stop_requested=2 THEN 0 ELSE stop_requested END WHERE id=?1",
    run.id,
  );
  const msg: any = { text: steer.text, steered: true };
  if (steer.from_agent) msg.from_agent = true;
  const message = state.add_message(task_id, "user", msg);
  if (new_turn) db.run(state.db(), "UPDATE runs SET turn_message_id=?1 WHERE id=?2", message.id, run.id);
  if (updated) state.emit_task(updated);
}

/**
 * The agent ended a turn. Unless it has messages waiting, which start its next turn, its input is closed so it exits and
 * the run ends. An agent with background tasks going doesn't exit until they end (see runs::background_tasks), so its
 * input stays open and what's sent to it meanwhile starts a turn at once, rather than being queued until they end
 * (HA-187); once they have, it's closed (see `background_changed`). A stopped turn's run is ended instead: the stop was
 * for all of it.
 */
export function turn_ended(state: Shared, run: Run) {
  let task: Task | null = null;
  try {
    task = db.get_task(state.db(), run.task_id);
  } catch {}
  const waiting = (task?.steering ?? []).filter((s) => s.run_id === run.id).map((s) => s.id);
  if (!waiting.length) {
    if (runs.background_tasks(state, run.id) > 0) {
      let stopped = false;
      try {
        stopped = !!db.value<number>(state.db(), "SELECT stop_requested FROM runs WHERE id=?1", run.id);
      } catch {}
      if (!stopped) return;
      runs.close_input(state, run.id);
      runs.kill(state, run.id);
      return;
    }
    runs.close_input(state, run.id);
    return;
  }
  close_unless_taken_in(state, run, waiting);
}

/**
 * Claude Code said how many background tasks the agent has going. Once none are left, between turns, its input is
 * closed as at the end of a turn without them: Claude Code still takes the turn it does on their outcome, then exits.
 */
export function background_changed(state: Shared, run: Run, count: number) {
  runs.set_background_tasks(state, run.id, count);
  if (count > 0) return;
  let between = false;
  try {
    between = !!db.value<number>(state.db(), "SELECT between_turns FROM runs WHERE id=?1 AND status != 'exited'", run.id);
  } catch {}
  if (between) turn_ended(state, run);
}

/**
 * The messages `waiting` should start the agent's next turn right away; if they don't, its input is closed so the run
 * ends and they go to the next one instead of waiting forever.
 */
export function close_unless_taken_in(state: Shared, run: Run, waiting: string[]) {
  const run_id = run.id;
  const task_id = run.task_id;
  setTimeout(() => {
    let task: Task | null = null;
    try {
      task = db.get_task(state.db(), task_id);
    } catch {}
    if (task && task.steering.some((s) => waiting.includes(s.id))) {
      console.warn(`run ${run_id}: the agent didn't take in the messages sent to it; ending its run`);
      runs.close_input(state, run_id);
    }
  }, STEER_GRACE).unref();
}

/** Requeue the messages a run that ended never took in, ahead of anything queued since. */
export function requeue_steers(state: Shared, task_id: string, run_id: string) {
  const task = db.get_task(state.db(), task_id);
  if (!task) return;
  const mine = task.steering.filter((s) => s.run_id === run_id);
  const rest = task.steering.filter((s) => s.run_id !== run_id);
  if (!mine.length) return;
  const c = state.db();
  const later = db.take_queued(c, task_id);
  for (const s of mine) db.queue(c, task_id, db.Queued_new(s.text, s.from_agent));
  if (later) db.queue(c, task_id, later);
  db.update_task(c, task_id, [["steering", rest]]);
}

/** Drop the message queued on a thread, if any. Returns the task as it was, so the text can be given back to the user. */
export function unqueue(state: Shared, task_id: string): Task {
  const task = db.get_task(state.db(), task_id);
  if (!task) throw ApiError.not_found("task");
  if (task.queued_message != null) {
    const t = db.clear_queued(state.db(), task_id);
    if (t) state.emit_task(t);
  }
  return task;
}

/** Whether a message is queued on a thread whose run has ended. `runs_map` is the runs map (Rust: the held runs lock). */
export function has_queued(state: Shared, runs_map: Map<string, RunHandle>, task_id: string): boolean {
  if (runs_map.has(task_id)) return false; // another run already took over the thread
  try {
    const q = db.get_task(state.db(), task_id)?.queued_message;
    return q != null && !!q.trim();
  } catch {
    return false;
  }
}

/**
 * Send the message that was queued while the last run went. It stays queued until the next run's start takes it (see
 * `start_run`), so it isn't lost if the server stops in between. Returns whether a new run started.
 */
export function send_queued(state: Shared, task_id: string): boolean {
  try {
    send_message(state, task_id, null, false, "prompt", null);
    return true;
  } catch (e) {
    // Unless another run has taken it, or is going to.
    let queued: string | null = null;
    try {
      const q = db.get_task(state.db(), task_id)?.queued_message ?? null;
      queued = q != null && q.trim() ? q : null;
    } catch {}
    if (queued != null && !state.is_running(task_id)) {
      state.add_event(task_id, "error", `Couldn't send the queued message: ${err_str(e)}`, queued);
    }
    return false;
  }
}
