// Port of server/src/agent/runner/output.rs: following a run: its stream-json output becomes thread messages, and its
// result or exit finishes the run and moves the task on.
import * as db from "../../db.ts";
import type { ClaudeConfig, Run, Task } from "../../db.ts";
import type { Shared } from "../../state.ts";
import { byte_len, err_str, now, truncate, reached } from "../../util.ts";
import * as codex from "../codex.ts";
import * as agent_tools from "../agent_tools.ts";
import * as context from "../context.ts";
import * as usage from "../usage.ts";
import * as documents from "../documents.ts";
import * as approval_rules from "../approval_rules.ts";
import * as memory from "../assistant/memory.ts";
import * as tokens from "../tokens.ts";
import * as wait from "../../mcp/wait.ts";
import * as permissions from "../../mcp/permissions.ts";
import * as checkpoints from "../../git/checkpoints.ts";
import * as worktree from "../../git/worktree.ts";
import * as review from "../../review.ts";
import * as workflows from "../../integrations/workflows.ts";
import * as automations from "../../integrations/automations.ts";
import * as summary from "../../review/summary.ts";
import * as merge_gate from "../../review/merge_gate.ts";
import * as threads from "../../threads/write.ts";
import type { Outcome } from "../runner.ts";
import { APPROVAL, start_next_merge } from "./merge.ts";
import * as plan from "./plan.ts";
import * as thread_source from "../../threads/source.ts";
import { is_initialized, on_control_cancel, on_control_request } from "./requests.ts";
import { background_changed, has_queued, requeue_steers, send_queued, set_writes_documents, steered, turn_ended, turn_started } from "./queue.ts";

const SUBAGENT_EVENTS = ["task_started", "task_progress", "task_updated", "task_notification"];

const is_obj = (v: any) => v != null && typeof v === "object" && !Array.isArray(v);

/** Strip bulky fields we never render from a stream-json event. */
function slim(v: any): any {
  if (is_obj(v)) {
    // An Agent/Task result says whether the subagent went to the background and which model ran it; keep just that.
    const r = v.tool_use_result;
    let agent: any = undefined;
    if (is_obj(r) && r.agentId !== undefined) {
      const KEEP = ["status", "isAsync", "agentId", "agentType", "resolvedModel", "totalDurationMs", "totalTokens", "totalToolUseCount"];
      agent = {};
      for (const k of KEEP) if (r[k] !== undefined) agent[k] = r[k];
    }
    delete v.tool_use_result;
    delete v.tool_result_meta;
    if (agent) v.tool_use_result = agent;
  }
  const blocks = v?.message?.content;
  if (Array.isArray(blocks)) {
    const kept = blocks.filter((b: any) => !(b?.type === "thinking" && !(typeof b.thinking === "string" && b.thinking)));
    for (const b of kept) {
      if (is_obj(b)) {
        delete b.signature;
        delete b.caller;
      }
      if (b?.type === "tool_result") {
        if (typeof b.content === "string") {
          if (byte_len(b.content) > 30_000) b.content = truncate(b.content, 30_000);
        } else if (Array.isArray(b.content)) {
          b.content = b.content.map((p: any) => {
            const t = p?.text;
            if (typeof t === "string" && byte_len(t) > 30_000) return { type: "text", text: truncate(t, 30_000) };
            if (p?.type === "image") return { type: "text", text: "[image]" };
            return p;
          });
        }
      }
    }
    v.message.content = kept;
  }
  if (is_obj(v?.message)) {
    delete v.message.usage;
    delete v.message.container;
    delete v.message.stop_details;
  }
  return v;
}

/**
 * Apply a chunk of a run's output (complete stream-json lines starting at byte `offset`). Chunks can repeat after a
 * reconnect; anything before the saved offset is skipped.
 */
export function on_output(state: Shared, run_id: string, offset: number, data: string) {
  let run: Run | null;
  try {
    run = db.get_run(state.db(), run_id);
  } catch {
    return;
  }
  if (!run || run.status === "exited") return;
  const saved = run.out_offset;
  const bytes = Buffer.from(data);
  const end = offset + bytes.length;
  if (end <= saved) return;
  const fresh = offset < saved ? bytes.subarray(saved - offset).toString("utf8") : data;
  if (offset > saved) console.warn(`run ${run_id}: output gap: expected offset ${saved}, got ${offset}`);
  for (const line of lines(fresh)) {
    try {
      handle_line(state, run, line);
    } catch (e) {
      console.warn(`failed to handle claude output: ${err_str(e)}`);
    }
  }
  try {
    db.run(state.db(), "UPDATE runs SET out_offset=?1 WHERE id=?2", end, run_id);
  } catch {}
}

/** Rust's `str::lines`: split on `\n`, dropping a final empty line and a `\r` before each `\n`. */
function lines(s: string): string[] {
  const out = s.split("\n");
  if (out.length && out[out.length - 1] === "") out.pop();
  return out.map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
}

export function on_exit(state: Shared, run_id: string, code: number | null, signal: number | null, error: string | null, stderr_tail: string) {
  let run: Run | null = null;
  try {
    run = db.get_run(state.db(), run_id);
  } catch {}
  if (!run) return forget(state, run_id);
  if (run.status === "exited") return;
  let outcome: Outcome;
  if (run.stop_requested) outcome = "Cancelled";
  else if (run.result_error != null) outcome = { Failed: run.result_error };
  else if (code === 0 && run.saw_result) outcome = "Ok";
  else {
    const how =
      error != null
        ? error
        : code != null
          ? `the agent exited with code ${code}`
          : signal != null
            ? `the agent was killed by signal ${signal}`
            : "the agent exited unexpectedly";
    const stderr = stderr_tail.trim();
    outcome = { Failed: !stderr ? how : `${how}\n${truncate(stderr, 4000)}` };
  }
  finish(state, run_id, outcome);
}

function task_config(state: Shared, task_id: string): ClaudeConfig | null {
  const c = state.db();
  const t = db.get_task(c, task_id);
  return t ? db.task_claude_config(c, t) : null;
}

/** On a config's rate limit event: its usage, or its proxy's accounts' (see agent/usage.rs). */
function rate_limit_event(state: Shared, config: ClaudeConfig, v: any) {
  if (db.proxy(config) != null) usage.on_proxy_rate_limit_event(state, config.id, v);
  else usage.on_rate_limit_event(state, config.id, v);
}

export function handle_line(state: Shared, run: Run, line: string) {
  const task_id = run.task_id;
  let v: any;
  try {
    v = JSON.parse(line);
  } catch {
    return;
  }
  // Codex runs write app-server notifications; Claude Code's stream-json has no `method`.
  if (is_obj(v) && v.method !== undefined) return codex.handle_line(state, run, v);
  const type = typeof v?.type === "string" ? v.type : "";
  if (type === "system" && v.subtype === "init") {
    if (typeof v.session_id === "string") {
      state.update_task(task_id, [["session_id", v.session_id]]);
      db.set_run_session(state.db(), run.id, v.session_id);
    }
    const c = state.db();
    const t = db.get_task(c, task_id);
    // A turn starting, unless it's the one a message sent to the agent starts (see queue::steered).
    if (!t?.steering.some((s) => s.run_id === run.id)) turn_started(state, run);
    if (t && t.project_id != null) {
      const config = db.task_claude_config(c, t);
      // The skills a review thread has on top of its project's aren't the project's to list or turn off.
      const init = structuredClone(v);
      if (t.kind === "review") {
        const extra = db.thread_skills(c, t.id);
        if (Array.isArray(init.skills)) init.skills = init.skills.filter((s: any) => !(typeof s === "string" && extra.includes(s)));
      }
      agent_tools.record_seen(c, t.project_id, config?.id ?? null, init);
    }
  } else if (type === "system" && v.subtype === "compact_boundary") {
    // From `/compact`, or Claude Code compacting by itself when the context fills up.
    state.add_message(task_id, "claude", { type: "system", subtype: "compact_boundary", compact_metadata: v.compact_metadata ?? null });
    context.on_compacted(state, run, v.compact_metadata ?? null);
  } else if (type === "system" && v.subtype === "background_tasks_changed") {
    // The background tasks it has going, all of them: they keep it from exiting (see queue::turn_ended).
    if (Array.isArray(v.tasks)) background_changed(state, run, v.tasks.length);
  } else if (type === "system" && typeof v.subtype === "string" && SUBAGENT_EVENTS.includes(v.subtype)) {
    // Subagent lifecycle (Agent/Task tool), keyed by the launching `tool_use_id`.
    delete v.output_file;
    delete v.uuid;
    delete v.session_id;
    if (v.usage !== undefined) {
      const u = v.usage;
      v.usage = { total_tokens: u?.total_tokens ?? null, tool_uses: u?.tool_uses ?? null, duration_ms: u?.duration_ms ?? null };
    }
    const message = state.add_message(task_id, "claude", v);
    wait.subagent_finished(state, run, message.data);
  } else if (type === "rate_limit_event") {
    const config = task_config(state, task_id);
    if (config) rate_limit_event(state, config, v);
  } else if (type === "stream_event") {
    // Only the top-level thread streams a preview.
    if (v.parent_tool_use_id != null) return;
    const ev = v.event;
    if (ev?.type === "message_start") turn_started(state, run);
    if (ev?.type === "content_block_delta" && ev?.delta?.type === "text_delta") {
      if (typeof ev.delta.text === "string") state.emit_delta(task_id, ev.delta.text);
    } else if (ev?.type === "message_start" || ev?.type === "content_block_start") {
      // Each text block is a message (an item) of its own when it's saved.
      if (ev.type === "message_start") state.emit_delta_reset(task_id);
      else threads.stream_reset(state, task_id);
    }
  } else if (type === "assistant" || type === "user") {
    // Claude Code's message for a turn refused for the usage limit says when it resets.
    if (v.api_error === "usage_limit_reached" && is_obj(v.api_error_params?.rate_limit_info)) {
      const config = task_config(state, task_id);
      if (config) rate_limit_event(state, config, { rate_limit_info: v.api_error_params.rate_limit_info });
    }
    if (type === "user" && v.isReplay === true) {
      if (typeof v.uuid === "string") steered(state, run, v.uuid);
      return;
    }
    if (wait.is_activity(v)) wait.resumed(state, task_id, run.id);
    if (type === "assistant" && v.parent_tool_use_id == null) turn_started(state, run);
    if (type === "assistant") context.on_assistant(state, run, v);
    const s = slim(v);
    if (Array.isArray(s?.message?.content) && s.message.content.length === 0) return;
    const tool_result = type === "user" && Array.isArray(s?.message?.content) && s.message.content.some((b: any) => b?.type === "tool_result");
    // The conversation's latest message, where a rewind can resume it (see checkpoints::Rewind).
    if (typeof s.uuid === "string" && s.parent_tool_use_id == null) {
      db.run(state.db(), "UPDATE runs SET agent_at=?1 WHERE id=?2", s.uuid, run.id);
    }
    // Calls the approval rules' hook blocked go in the action log.
    if (tool_result) {
      const task = db.get_task(state.db(), task_id);
      let applies = false;
      try {
        applies = !!task && approval_rules.applies_to(state.db(), task);
      } catch {}
      if (task && applies) approval_rules.on_tool_results(state, task, s);
    }
    state.add_message(task_id, "claude", s);
    // A tool call may have changed the task's document: the task shows it as it's written.
    if (tool_result) documents.follow(state, task_id);
  } else if (type === "control_request") {
    // A permission prompt (see requests.ts).
    on_control_request(state, run, v);
  } else if (type === "control_cancel_request") {
    on_control_cancel(state, run, v);
  } else if (type === "control_response") {
    if (is_initialized(v)) {
      // Claude Code refused the `initialize` that gives it the board's tools (see requests.ts): the agent goes on without.
      if (v.response?.subtype !== "success") {
        const why = typeof v.response?.error === "string" && v.response.error ? v.response.error : "no reason given";
        console.warn(`task ${task_id} run ${run.id}: Claude Code refused the board's tools: ${why}`);
        state.add_event(task_id, "warn", `Claude Code didn't take the board's tools (${why}), so this run goes on without them.`);
      }
      return;
    }
    context.on_control_response(state, task_id, v);
  } else if (type === "result") {
    let failed: unknown = null;
    try {
      claude_result(state, run, v);
    } catch (e) {
      failed = e;
    }
    // Whatever of it failed to be recorded (see `record_result`).
    turn_ended(state, run);
    if (failed) throw failed;
  }
}

/** The end of one of Claude Code's turns (its `result`, `v`), but for closing its input (see `turn_ended`). */
function claude_result(state: Shared, run: Run, v: any) {
  const task_id = run.task_id;
  // The turn was refused: its config is out of usage (see agent/usage.rs).
  if (v.api_error === "usage_limit_reached") {
    const config = task_config(state, task_id);
    if (config) usage.ran_out(state, task_id, config.id);
  }
  context.on_result(state, task_id, v);
  // Before the turn's end closes its input (see `turn_ended`).
  context.request(state, run);
  const dud = never_answered(state, run, v);
  // A running total for the session, which goes on over its turns and the runs that resume it.
  let cost = 0.0;
  if (typeof v.total_cost_usd === "number") {
    const counted = is_obj(v.modelUsage) && Object.keys(v.modelUsage).length > 0;
    cost = db.add_cost(state.db(), run.id, typeof v.session_id === "string" ? v.session_id : null, v.total_cost_usd, counted);
  }
  const t = db.get_task(state.db(), task_id);
  if (t) {
    const fields: Array<[string, any]> = [["cost_usd", t.cost_usd + cost]];
    if (dud) fields.push(["session_id", null]);
    else if (typeof v.session_id === "string") fields.push(["session_id", v.session_id]);
    state.update_task(task_id, fields);
    if (dud) console.log(`task ${task_id} run ${run.id}: session ${v.session_id} was never answered, so the next run starts a new one`);
  }
  let result_error: string | null = null;
  if (v.is_error === true || (typeof v.subtype === "string" && v.subtype !== "success")) {
    if (typeof v.result === "string") result_error = v.result;
    else if (Array.isArray(v.errors)) result_error = v.errors.filter((x: any) => typeof x === "string").join("\n");
    else result_error = `run ended with ${JSON.stringify(v.subtype ?? null)}`;
  }
  const slimmed = {
    type: "result",
    subtype: v.subtype ?? null,
    is_error: v.is_error ?? null,
    result: v.result ?? null,
    duration_ms: v.duration_ms ?? null,
    num_turns: v.num_turns ?? null,
    total_cost_usd: cost,
  };
  record_turn_end(state, run, result_error, slimmed);
}

/**
 * Whether Claude Code's result `v` ends a task's conversation that this run started and the model never answered: it
 * failed before reaching the API (not logged in, say), with nothing spent in it, and wasn't stopped. Kept, such a session would be resumed by
 * the next run, which is started again from the task's description instead; and in another config folder (one that has
 * the login, if this one had none) the agent couldn't find it ("No conversation found with session ID").
 */
function never_answered(state: Shared, run: Run, v: any): boolean {
  if (v.is_error !== true || typeof v.session_id !== "string") return false;
  if (v.duration_api_ms !== 0 || (v.total_cost_usd ?? 0) !== 0) return false;
  const c = state.db();
  // Only a task's: its next run starts again from its description (see runner::launch), while a review's or the
  // assistant's would start with no more than the next message, without the prompt or message the session has.
  if (db.get_task(c, run.task_id)?.kind !== "task") return false;
  // A first turn the user stopped before the model answered: the stop keeps its session to resume (see runner::stop).
  if (db.value<number>(c, "SELECT stop_requested FROM runs WHERE id=?1", run.id) !== 0) return false;
  const first = db.value<string>(c, "SELECT id FROM runs WHERE task_id=?1 AND session_id=?2 ORDER BY rowid LIMIT 1", run.task_id, v.session_id);
  if (first !== run.id) return false;
  // Nor in an earlier turn of this run.
  return (db.value<number>(c, "SELECT cost_usd FROM runs WHERE id=?1", run.id) ?? 0) === 0;
}

/**
 * The end of one of the agent's turns (Claude Code's `result`, or a Codex turn completing): record its outcome and add
 * `result` (shaped like Claude Code's) to the thread. The last turn's outcome is the run's.
 */
export function record_result(state: Shared, run: Run, error: string | null, result: any) {
  let failed: unknown = null;
  try {
    record_turn_end(state, run, error, result);
  } catch (e) {
    failed = e;
  }
  // Even if that failed (the disk is full, say): the result's line has been read, so it isn't seen again, and an input
  // left open would keep the agent (and the run) waiting for good.
  turn_ended(state, run);
  if (failed) throw failed;
}

function record_turn_end(state: Shared, run: Run, error: string | null, result: any) {
  const stopping = db.value<number>(state.db(), "SELECT stop_requested FROM runs WHERE id=?1", run.id);
  if (stopping === undefined) throw new Error("Query returned no rows");
  if (stopping === 1) {
    // The turn a stop interrupted: from here, a message it takes in starts a new one.
    db.run(state.db(), "UPDATE runs SET stop_requested=2 WHERE id=?1", run.id);
    if (error != null) result.interrupted = true;
  }
  db.run(state.db(), "UPDATE runs SET saw_result=1, between_turns=1, result_error=?1 WHERE id=?2", error, run.id);
  const status = stopping === 1 ? "stopped" : error != null ? "failed" : "done";
  // A compaction's end isn't a reply (see telegram.ts's `on_turn_end`), though it's recorded as a turn's.
  if (run.kind === "compact") result.compact = true;
  checkpoints.after_turn(state, run.id, status);
  // A turn that ended isn't waiting any more, even if the agent gave up on the call.
  wait.ended(state, run.task_id, run.id);
  documents.turn_ended(state, run.task_id);
  memory.turn_ended(state, run.task_id);
  context.record_turn(state, run, typeof result.total_cost_usd === "number" ? result.total_cost_usd : null);
  state.add_message(run.task_id, "claude", result);
}

/** Forget a run whose row is gone (its task was deleted while it ran). */
function forget(state: Shared, run_id: string) {
  for (const [k, h] of [...state.runs]) if (h.run_id === run_id) state.runs.delete(k);
}

/**
 * Write the end of run `run_id` to its task, unless a run has started on it since: the task's running state and column
 * are then that run's (see db::later_run).
 */
function end_run(state: Shared, task_id: string, run_id: string, fields: Array<[string, any]>): Task | null {
  return state.update_task_if(task_id, fields, (c) => !db.later_run(c, task_id, run_id));
}

export function finish(state: Shared, run_id: string, outcome: Outcome) {
  set_writes_documents(run_id, false);
  let run: Run | null = null;
  try {
    run = db.get_run(state.db(), run_id);
  } catch {}
  if (!run) return forget(state, run_id);
  const task_id = run.task_id;
  const failed = typeof outcome === "object" ? outcome.Failed : null;
  // A turn the agent never ended (stopped, failed or killed) gets its checkpoint here, while the run still holds the
  // thread: before a rewind or the next run (a queued message) can ask for theirs.
  if (run.status === "running" && !run.between_turns && run.kind !== "compact") {
    checkpoints.after_turn(state, run_id, failed != null ? "failed" : "stopped");
  }
  if (state.runs.get(task_id)?.run_id === run_id) state.runs.delete(task_id);
  // What the agent never took in goes with the next prompt.
  try {
    requeue_steers(state, task_id, run_id);
  } catch (e) {
    console.error(`task ${task_id}: requeueing messages the agent didn't take in: ${err_str(e)}`);
  }
  // Before any other run can start: once one has, the thread's prompts may be its.
  let later: boolean | null = null;
  try {
    later = db.later_run(state.db(), task_id, run_id);
  } catch {}
  if (later === false) permissions.expire_for_task(state, task_id);
  else permissions.expire_for_run(state, run_id);
  wait.ended(state, task_id, run_id);
  const queued = has_queued(state, state.runs, task_id);
  reached("finish:released");
  try {
    db.run(state.db(), "UPDATE runs SET status='exited', ended_at=?1 WHERE id=?2", now(), run_id);
  } catch {}
  reached("finish:exited");
  // Quiet now (unless a prompt is waiting, or another run has started), it moves onto items (threads/source.ts).
  thread_source.settled(state, task_id);
  tokens.on_run_ended(state, task_id);
  // What a stopped or failed run had written of its document.
  documents.turn_ended(state, task_id);
  memory.turn_ended(state, task_id);
  state.emit_delta_reset(task_id);
  let task: Task | null = null;
  try {
    task = db.get_task(state.db(), task_id);
  } catch {}
  if (!task) return;
  // What its agent took in of the branch it's stacked on (see worktree::keep_starts), and what the tasks stacked on it
  // did of its own.
  if (task.kind === "task") {
    const id = task.id;
    worktree.keep_starts(state, id).catch((e: any) => console.error(`keeping the starts of tasks on ${id}: ${err_str(e)}`));
  }
  if (run.kind === "review" && workflows.is_workflow(task)) workflows.finished(state, task, run_id, outcome, run.attention);
  else if (run.kind === "review" && summary.is_summary(task)) summary.finished(state, task, run_id, outcome, run.attention);
  else if (run.kind === "review") review.finished(state, task, run_id, outcome, run.attention);
  if (run.kind === "compact") {
    if (outcome === "Cancelled") state.add_event(task_id, "warn", "Compacting stopped");
    else if (failed != null) state.add_event(task_id, "error", "Compacting failed", failed);
    if (queued && send_queued(state, task_id)) return;
    try {
      end_run(state, task_id, run_id, [["running", false]]);
    } catch (e) {
      console.error(`failed to finalize run: ${err_str(e)}`);
    }
    start_next_merge(state, task.project_id);
    return;
  }
  // What the automation runs whose messages it took cost (before a queued message carries on the thread).
  automations.routines.agent_run_ended(state, run_id);
  const is_task = task.kind === "task";
  // It stopped because its config is out of usage, which resets then (see usage::ran_out).
  const limit = failed != null && task.limit_reset_at != null && !usage.reset_due(task.limit_reset_at) ? task.limit_reset_at : null;
  // Its profile has it wait for the reset rather than need attention.
  let wait_reset = false;
  if (limit != null && is_task && !task.merging) {
    try {
      wait_reset = !!db.get_profile(state.db(), task.profile_id)?.limit_wait;
    } catch {}
  }
  const attention = run.attention;
  let status: string | null;
  let reason: string | null;
  if (outcome === "Cancelled") {
    state.add_event(task_id, "warn", "Run stopped");
    [status, reason] = ["needs_attention", "Stopped by user"];
  } else if (failed != null && limit != null) {
    let config = "Its config";
    try {
      config = task_config(state, task_id)?.name ?? config;
    } catch {}
    state.add_event(task_id, "warn", `${config} is out of usage`, failed);
    if (wait_reset) {
      state.add_event(task_id, "info", `Waiting for ${config}'s usage limit to reset`, `It resets at ${limit}`);
      [status, reason] = ["in_progress", null];
    } else {
      [status, reason] = ["needs_attention", first_line(failed) ?? "Out of usage"];
    }
  } else if (failed != null) {
    state.add_event(task_id, "error", "Run failed", failed);
    [status, reason] = ["needs_attention", `Run failed: ${first_line(failed) ?? ""}`];
  } else if (run.attention != null) {
    [status, reason] = ["needs_attention", run.attention];
  } else if (task.status === "done") {
    // The agent marked its own task done (e.g. after merging it).
    [status, reason] = [null, null];
  } else if (task.merging && merge_gate.is_pending(task)) {
    // It summarised the merge, which waits for the user's approval (see review/merge_gate.rs).
    [status, reason] = ["needs_attention", APPROVAL];
  } else if (task.merging) {
    [status, reason] = ["needs_attention", "The agent finished without marking the task merged"];
  } else if (task.remerge) {
    // It stepped out of the merge queue to make changes, and now rejoins it.
    [status, reason] = ["ready_for_merge", null];
  } else if (db.is_assistant(task)) {
    // The assistant never goes to review: it waits for the user's next message.
    [status, reason] = ["todo", null];
  } else if (db.is_routine(task)) {
    // A routine's run is done once it's reported (see automations/routines.ts).
    [status, reason] = ["done", null];
  } else {
    [status, reason] = ["in_review", null];
  }
  // A run that may have only written or revised the task's plan: its column waits for its checkpoints (see plan.ts).
  const plan_check = is_task && status === "in_review" && plan.candidate(state, task, run);
  // The queued message carries on the conversation, so the task stays where it is. Out of usage, it would only be
  // refused too: it stays queued for when the limit resets.
  if (queued && limit == null && send_queued(state, task_id)) return;
  const fields: Array<[string, any]> = [
    ["running", false],
    ["attention_reason", reason],
  ];
  if (wait_reset) fields.push(["waiting", true]);
  if (is_task) {
    if (status != null && !plan_check) fields.push(["status", status]);
    if (status === "ready_for_merge") {
      // At the back of the queue, as the tasks behind it moved up while it was away.
      let end = task.position;
      try {
        end = db.end_position(state.db(), task.project_id, "ready_for_merge", "task");
      } catch {}
      fields.push(["merging", true], ["remerge", false], ["position", end]);
      state.add_event(task_id, "info", "Back in the merge queue");
    }
  }
  let updated: Task | null = null;
  try {
    updated = end_run(state, task_id, run_id, fields);
  } catch (e) {
    console.error(`failed to finalize run: ${err_str(e)}`);
  }
  // Its report goes to the assistant, unless the run was quiet.
  if (is_task && db.is_routine(task)) automations.routines.finished(state, updated ?? task, outcome, attention);
  if (is_task && reason === APPROVAL) {
    try {
      merge_gate.ask(state, task_id);
    } catch (e) {
      console.error(`task ${task_id}: asking for a merge's approval: ${err_str(e)}`);
    }
  }
  if (is_task) {
    start_next_merge(state, task.project_id);
    worktree.find_pr(state, task);
  }
  if (updated && is_task && plan_check) {
    // Its column waits for its checkpoints (see plan.ts), and so does what follows from the task entering it.
    settle_plan(state, updated, run);
  } else {
    if (updated && is_task && updated.status === "in_review" && status === "in_review") review.on_in_review(state, updated);
    // The task's workflows that start when it enters the column its run ended in.
    if (updated && is_task && status === updated.status && updated.status !== task.status) workflows.on_status(state, updated);
  }
}

/** Settle the column of `task` at the end of its run `run` (see plan.ts), and start what entering it starts. */
function settle_plan(state: Shared, task: Task, run: Run) {
  plan
    .settle(state, task, run, (t) => {
      if (t.status === "in_review") review.on_in_review(state, t);
      workflows.on_status(state, t);
    })
    .catch((e) => console.error(`task ${task.id}: settling its column: ${err_str(e)}`));
}

/** Startup: settle the columns of the tasks a restart left in "In progress" before they were (see plan::unsettled). */
export function settle_plans(state: Shared) {
  let left: Array<[Task, Run]> = [];
  try {
    left = plan.unsettled(state);
  } catch (e) {
    console.error(`finding plan tasks left in progress: ${err_str(e)}`);
  }
  for (const [task, run] of left) {
    console.log(`task ${task.id}: settling the column its run ${run.id} ended in before the server stopped`);
    settle_plan(state, task, run);
  }
}

/** Rust's `s.lines().next()`. */
function first_line(s: string): string | null {
  return s ? lines(s)[0] ?? null : null;
}
