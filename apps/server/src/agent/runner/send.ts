// Port of server/src/agent/runner/send.rs: sending a message on a thread, and what holds a run back: dependencies,
// usage limits and compaction.
import * as db from "../../db.ts";
import type { Conn, Queued, Task } from "../../db.ts";
import { ApiError } from "../../http.ts";
import type { Shared } from "../../state.ts";
import { err_str } from "../../util.ts";
import * as runs from "../runs.ts";
import * as documents from "../documents.ts";
import * as title from "../title.ts";
import * as usage from "../usage.ts";
import * as prompts from "../prompts.ts";
import * as review from "../../review.ts";
import * as workflows from "../../integrations/workflows.ts";
import * as summary from "../../review/summary.ts";
import * as merge_gate from "../../review/merge_gate.ts";
import { AUTO_COMPACT_AFTER, AUTO_COMPACT_UNTIL, start_run, type Take } from "../runner.ts";
import { key_prefix } from "./prompt.ts";
import { steer_or_queue } from "./queue.ts";

/** `/compact [instructions]`: Claude Code summarises the conversation so far, shrinking the context later prompts start from. */
export function is_compact(text: string): boolean {
  const t = text.trim();
  if (!t.startsWith("/compact")) return false;
  const rest = t.slice("/compact".length);
  return rest === "" || /^\s/.test(rest);
}

/** `auto` marks the message as sent by the board rather than typed by the user. */
export function send_as(state: Shared, task_id: string, text: string, auto: boolean): Task {
  return send_run(state, task_id, text, auto, false, "prompt");
}

/**
 * Like `send`, for a message the board wrote at the user's asking (Fix broken checks, see mcp/pr_watch.rs's
 * fix_checks): it isn't in the user's words, so the task isn't re-titled from it.
 */
export function send_for_user(state: Shared, task_id: string, text: string): Task {
  return send_message(state, task_id, db.Queued_new(text, false), false, "prompt", null);
}

/**
 * Send a review's issues back to the task's agent to fix: round `round` of fixes, which the message is marked with
 * (`review_round`, see git/checkpoints.rs).
 */
export function send_fixes(state: Shared, task_id: string, text: string, round: number): Task {
  return send_message(state, task_id, db.Queued_new(text, false), true, "prompt", round);
}

/** Like `send`, for a message another thread's agent sent (MCP `send_to_task`). It's marked so prompt analytics don't count it as the user's. */
export function send_from_agent(state: Shared, task_id: string, text: string): Task {
  return send_run(state, task_id, text, false, true, "prompt");
}

/**
 * Send a routine's message (see automations/routines.ts) as another agent's: one that starts a run makes it a routine
 * run, with nobody there to answer its prompts (`routine` on its message), and a thread-mode routine's (for its
 * automation run `automation_run`) is charged to that automation run by the run that takes it in, whether it starts with
 * it, is steered it or takes it from the queue later (see routines.taken_in).
 */
export function send_from_routine(state: Shared, task_id: string, text: string, automation_run: string | null): Task {
  const message: Queued = { ...db.Queued_new(text, true), routine: true, routine_runs: automation_run != null ? [automation_run] : [] };
  return send_message(state, task_id, message, false, "prompt", null);
}

/**
 * Send a project automation's message (for its run `automation_run`), as another agent's, or with no text, start a task
 * it made: the agent run that takes it in, whether it starts with it, is steered it or takes it from the queue later, is
 * charged to that automation run, for its budget (see routines.taken_in). Unlike a routine's, it isn't a routine run: a
 * project's task has the user's approval rules, not the assistant's.
 */
export function send_from_automation(state: Shared, task_id: string, text: string, automation_run: string): Task {
  const message: Queued = { ...db.Queued_new(text, text.trim() !== ""), routine_runs: [automation_run] };
  return send_message(state, task_id, message, false, "prompt", null);
}

/** Start a review round on a review thread (see review.rs): a prompt whose outcome is the review's. */
export function send_review(state: Shared, thread_id: string, text: string): Task {
  return send_run(state, thread_id, text, true, false, "review");
}

function send_run(state: Shared, task_id: string, text: string, auto: boolean, from_agent: boolean, kind: string): Task {
  let task = send_message(state, task_id, db.Queued_new(text, from_agent), auto, kind, null);
  // `/plan` gives the task the plan label now, so it shows the Plan tab whether the message starts a run, goes to the
  // one going or waits.
  if (kind === "prompt" && task.kind === "task" && documents.plan_command(text) != null) task = documents.add_plan(state, task);
  // The user's prompt may have moved the task on, so its title follows (see title::refresh).
  if (kind === "prompt" && !auto && !from_agent && title.worth_asking(text) && !is_compact(text)) title.refresh(state, task_id);
  return task;
}

/**
 * Send `message` on a thread. A message the user (or another agent) sent goes with the one queued there, if any.
 * Without one, it sends just that, and nothing if another run has (see `send_queued`).
 */
export function send_message(state: Shared, task_id: string, message_in: Queued | null, auto: boolean, kind: string, review_round: number | null): Task {
  const only_queued = message_in == null;
  const message = message_in ?? db.Queued_empty();
  const task = db.get_task(state.db(), task_id);
  if (!task) throw ApiError.not_found("task");
  // Sending what's queued: it may be a `/compact`, which is queued for after the run it came in.
  const queued = !auto && !message.text.trim() ? task.queued_message : null;
  const compact = is_compact(message.text) || (queued != null && is_compact(queued));
  // Before the message is queued for later (behind dependencies, say), where nothing would send it.
  check_not_archived(state, task);
  // One waiting for the user's approval isn't in the queue yet, so it can be talked to.
  if (task.merging && !auto && !merge_gate.is_pending(task)) {
    // A merge waiting for its turn can't run alongside the one in progress.
    const other = db.active_merge(state.db(), task.project_id, task.parent_id);
    if (other && other.id !== task.id) {
      throw ApiError.conflict(`this task is queued to merge after "${other.title}"; move it out of Ready for merge to talk to its agent now`);
    }
  }
  if (!auto) {
    const t = steer_or_queue(state, task_id, message);
    if (t) return t;
  }
  if (!auto && !compact && kind === "prompt" && task.kind === "task" && !task.merging && runs.can_run_agents(state)) {
    const unmet = db.unmet_dependencies(state.db(), task);
    if (unmet.length) return wait_for_dependencies(state, task, unmet, only_queued ? null : message);
  }
  // A config that's out of usage would refuse the run (see agent/usage.rs).
  if (!compact && kind === "prompt" && task.kind === "task" && !task.merging && runs.can_run_agents(state) && !state.is_running(task_id)) {
    const t = usage.before_run(state, task, only_queued ? null : { ...message });
    if (t) return t;
  }
  // A message left queued on a thread that isn't running (e.g. one sent while it waited for its dependencies, before it
  // was moved out of "In progress") goes with this one, unless this one compacts the conversation first.
  const take: Take = only_queued ? "Only" : !auto && (!is_compact(message.text) || queued != null) ? "Ahead" : "No";
  const run_kind = compact ? "compact" : kind;
  const started = start_run(state, task_id, message, run_kind, take, (c, task, message) => {
    const text = message.text;
    const first_run = task.session_id == null;
    if (text.trim()) {
      const msg: any = { text };
      if (auto) msg.auto = true;
      if (review_round != null) msg.review_round = review_round;
      if (message.from_agent) msg.from_agent = true;
      // Sent with other agents' messages queued alongside (see db::user_replies).
      else if (message.user_text != null && message.user_text !== text) msg.user_text = message.user_text;
      if (message.routine) msg.routine = true;
      return [db.insert_message(c, task_id, "user", msg)];
    } else if (first_run && task.kind === "task") {
      const project = task.project_id != null ? db.get_project(c, task.project_id) : null;
      const start = prompts.start_task(task, project);
      const msg: any = { text: start, auto: true, start: true };
      if (message.routine) msg.routine = true;
      return [db.insert_message(c, task_id, "user", msg)];
    }
    return [];
  });
  if (run_kind === "prompt" && started.kind === "task") {
    // The agent is changing the work under review; it's reviewed again when it finishes.
    review.supersede(state, started);
    summary.supersede(state, started);
    workflows.supersede(state, started);
  }
  return started;
}

/**
 * Queue a task whose agent was asked to start while tasks it depends on aren't merged yet: it waits in "In progress",
 * keeping `text` as its queued message, and starts once they're merged (see `start_unblocked`).
 */
export function wait_for_dependencies(state: Shared, task: Task, unmet: Task[], message: Queued | null): Task {
  // One with no text keeps only its automation runs, for the run that starts it (see db.queue).
  if (message) db.queue(state.db(), task.id, { ...message, text: message.text.trim() });
  // Without a message, for the one queued: unless it was sent or taken back meanwhile (checked as the task is changed,
  // so neither can slip in between).
  const only_queued = message == null;
  const queued = (c: Conn) => {
    if (!only_queued) return true;
    const q = db.get_task(c, task.id)?.queued_message;
    return q != null && !!q.trim();
  };
  const fields: Array<[string, any]> = [
    ["waiting", true],
    ["status", "in_progress"],
    ["attention_reason", null],
  ];
  const updated = state.update_task_if(task.id, fields, queued);
  if (!updated) {
    if (only_queued) throw ApiError.conflict("nothing is queued to send");
    throw ApiError.not_found("task");
  }
  if (!task.waiting) {
    const key = task_key_prefix(state, task);
    const list = unmet.map((t) => `${key}-${t.number}`);
    state.add_event(task.id, "info", `Queued until ${list.join(", ")} ${list.length === 1 ? "is" : "are"} merged`);
  }
  // Reached from `finish` (a message queued during a run, sent as it ends) before the run's end is written: unless
  // another has started since, no run goes on, so the task isn't running any more.
  const stopped = state.update_task_if(task.id, [["running", false]], (c) => updated.running && !db.has_active_run(c, task.id));
  return stopped ?? updated;
}

/**
 * Queue a task whose config (`config_name`) is out of usage until `until`: like `wait_for_dependencies`, it waits in "In
 * progress", keeping `message` as its queued message, and its agent carries on once the limit resets (see
 * usage::resume_loop).
 */
export function wait_for_limit(state: Shared, task: Task, config_name: string, until: string, message: Queued | null): Task {
  // One with no text keeps only its automation runs, for the run that starts it (see db.queue).
  if (message) db.queue(state.db(), task.id, { ...message, text: message.text.trim() });
  const fields: Array<[string, any]> = [
    ["waiting", true],
    ["limit_reset_at", until],
    ["status", "in_progress"],
    ["attention_reason", null],
  ];
  const updated = state.update_task_if(task.id, fields, (c) => !db.has_active_run(c, task.id));
  if (!updated) throw ApiError.conflict("an agent is already running on this thread");
  if (!(task.waiting && task.limit_reset_at === until)) {
    state.add_event(task.id, "info", `Waiting for ${config_name}'s usage limit to reset`, `It resets at ${until}`);
  }
  const stopped = state.update_task_if(task.id, [["running", false]], (c) => updated.running && !db.has_active_run(c, task.id));
  return stopped ?? updated;
}

/**
 * A task waiting for its config's usage limit to reset was moved to another config before its agent started: it no
 * longer waits for that reset, and starts on the new config, unless that one holds it too (see usage::before_run) or
 * what it depends on isn't merged yet.
 */
export function config_changed(state: Shared, task_id: string) {
  let t: Task | null;
  try {
    t = db.get_task(state.db(), task_id);
  } catch {
    return;
  }
  if (!t || !(t.waiting && t.limit_reset_at != null) || state.is_running(task_id)) return;
  // Still waiting, for start_unblocked to start it (or leave it for its dependencies).
  try {
    state.update_task(task_id, [["limit_reset_at", null]]);
  } catch {}
  state.add_event(task_id, "info", "Its config changed, so it no longer waits for the old one's usage limit");
  start_unblocked(state, t.project_id);
}

export function task_key_prefix(state: Shared, task: Task): string {
  let project: db.Project | null = null;
  if (task.project_id != null) {
    try {
      project = db.get_project(state.db(), task.project_id);
    } catch {}
  }
  return key_prefix(task, project);
}

/**
 * Start the agents of tasks queued for their dependencies whose dependencies are now all merged, in a project (every
 * project for null). Call whenever a task may have been merged, deleted, or had its dependencies changed. (Synchronous,
 * so two callers can't both start the same task: Rust's UNBLOCKING.)
 */
export function start_unblocked(state: Shared, project_id: string | null) {
  if (!runs.can_run_agents(state)) return;
  const c = state.db();
  let waiting: Task[];
  try {
    waiting = db.waiting_tasks(c, project_id);
  } catch (e) {
    console.error(`checking queued tasks: ${err_str(e)}`);
    waiting = [];
  }
  const ready = waiting
    .filter((t) => t.limit_reset_at == null || usage.reset_due(t.limit_reset_at))
    .filter((t) => {
      try {
        return db.unmet_dependencies(c, t).length === 0;
      } catch {
        return false;
      }
    });
  for (const t of ready) start_waiting(state, t);
}

/**
 * Start the agent of a task picked by `start_unblocked`. If its project has been archived since, it goes back to
 * waiting, queued message and all, for when the project is unarchived.
 */
export function start_waiting(state: Shared, t: Task) {
  if (state.is_running(t.id)) return;
  try {
    state.update_task(t.id, [
      ["waiting", false],
      ["limit_reset_at", null],
    ]);
  } catch {}
  const limit = t.limit_reset_at != null;
  const why = limit
    ? "Its usage limit has reset, so its agent is carrying on"
    : !t.depends_on.length
      ? "Its agent is starting"
      : "Nothing it depends on is left to merge, so its agent is starting";
  state.add_event(t.id, "info", why);
  try {
    const q = db.get_task(state.db(), t.id)?.queued_message;
    if (q != null && q.trim()) {
      // It stays queued until the run's start takes it.
      send_message(state, t.id, null, false, "prompt", null);
    } else if (t.session_id == null) {
      send_as(state, t.id, "", true);
    } else if (limit) {
      send_as(state, t.id, "The usage limit you ran into has reset, so carry on where you left off.", true);
    } else {
      send_as(state, t.id, "The tasks this one was waiting for are merged (or no longer needed), so carry on with it.", true);
    }
    return;
  } catch (e) {
    // (send refuses an archived project's thread before it changes anything.)
    let archived = false;
    try {
      check_not_archived(state, t);
    } catch {
      archived = true;
    }
    if (archived) {
      try {
        state.update_task(t.id, [
          ["waiting", true],
          ["limit_reset_at", t.limit_reset_at],
        ]);
      } catch {}
      state.add_event(t.id, "info", "Its project was archived, so it waits until the project is unarchived");
      return;
    }
    const reason = `Couldn't start the agent: ${err_str(e)}`;
    state.add_event(t.id, "error", reason);
    try {
      state.update_task(t.id, [
        ["status", "needs_attention"],
        ["attention_reason", reason],
      ]);
    } catch {}
  }
}

/** Queue `text` on a thread again, ahead of anything queued since it was taken. */
export function requeue_ahead(state: Shared, task_id: string, queued: Queued) {
  const c = state.db();
  const later = db.take_queued(c, task_id);
  db.queue(c, task_id, queued);
  if (later) db.queue(c, task_id, later);
}

/** Compact the conversation on a thread. Unlike a prompt, this leaves the task in its column. */
export function compact(state: Shared, task_id: string, why: string): Task {
  return start_run(state, task_id, db.Queued_new("/compact", false), "compact", "No", (c) => [
    db.insert_message(c, task_id, "event", { level: "info", text: why, detail: null }),
  ]);
}

/** Background loop: compact sessions that have been idle for `AUTO_COMPACT_AFTER`. */
export function auto_compact(state: Shared) {
  const tick = () => {
    if (!runs.can_run_agents(state)) return;
    const now = Date.now();
    const ts = (d: number) => new Date(now - d).toISOString();
    let idle: string[];
    try {
      idle = db.idle_sessions(state.db(), ts(AUTO_COMPACT_AFTER), ts(AUTO_COMPACT_UNTIL));
    } catch (e) {
      console.warn(`finding idle sessions failed: ${err_str(e)}`);
      return;
    }
    for (const id of idle) {
      // Compacting while the prompt cache is warm is a Claude saving.
      let is_codex = false;
      try {
        const c = state.db();
        const t = db.get_task(c, id);
        is_codex = !!t && db.task_is_codex(c, t);
      } catch {}
      if (is_codex) continue;
      const why = `Compacting the conversation after ${AUTO_COMPACT_AFTER / 60_000} minutes idle`;
      try {
        compact(state, id, why);
      } catch (e) {
        console.warn(`task ${id}: auto-compact failed: ${err_str(e)}`);
      }
    }
  };
  // tokio's interval ticks at once, then every minute.
  setTimeout(tick, 0).unref();
  setInterval(tick, 60_000).unref();
}

/** Refuses a thread in an archived project: its tasks are off the board, so its agents would work out of sight. */
export function check_not_archived(state: Shared, task: Task) {
  const p = task.project_id != null ? db.get_project(state.db(), task.project_id) : null;
  if (p && p.archived_at != null) {
    throw ApiError.conflict(`the project "${p.name}" is archived; unarchive it in the board's settings to run its agents`);
  }
}
