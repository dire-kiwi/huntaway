// Port of server/src/mcp/permissions.rs.
/**
 * Tool-permission prompts from agents (`--permission-prompt-tool`).
 *
 * A request is keyed by the MCP call that raised it and its decision lives in the database, so when a host or the server
 * restarts mid-prompt the redelivered call finds the same request (and its answer, if the user already gave one).
 */
import * as db from "../db.ts";
import type { Task } from "../db.ts";
import { ApiError } from "../http.ts";
import type { Shared } from "../state.ts";
import { new_id, now } from "../util.ts";
import * as documents from "../agent/documents.ts";
import * as runner from "../agent/runner.ts";
import * as focus from "../agent/focus.ts";
import * as approval_rules from "../agent/approval_rules.ts";
import type { Rule } from "../agent/approval_rules.ts";

/** Why a request wasn't answered: its run ended or its thread was deleted first. */
export const EXPIRED = "Request expired";

/** Why a request from a routine run wasn't answered: nobody did in time (see `expire_due`). */
export const EXPIRED_UNANSWERED =
  "Nobody answered this in time, so it was denied. Carry on without this action, and say in your report what you couldn't do and why.";

export const DONT_ASK_DENIAL = 'Denied automatically: this thread is in "Don\'t ask" mode.';

/**
 * Claude Code's tool for asking the user multiple-choice questions. Allowed with the user's answers in its input
 * (`answers`, each question's text to its answer), it gives them to the agent.
 */
export const ASK_USER = "AskUserQuestion";
/**
 * What Codex's questions (`item/tool/requestUserInput`, see agent/codex.rs) are asked as: AskUserQuestion's input, with
 * each question's `id`, and answered with Codex's answers in `answers`.
 */
export const CODEX_QUESTIONS = "request_user_input";
/**
 * Claude Code's tool for presenting a plan in plan mode (its input's `plan`, in Markdown): allowed, the agent carries on
 * with it; denied, it keeps planning.
 */
export const EXIT_PLAN = "ExitPlanMode";

/**
 * Whether prompts for `tool` ask the user questions rather than for permission. Only the user can answer them: they're
 * asked whatever the thread's mode (except Don't ask) or always-allowed tools.
 */
export function is_question(tool: string): boolean {
  return tool === ASK_USER || tool === CODEX_QUESTIONS;
}

/**
 * Answer a permission prompt for `task`, asking the user if its mode requires it. `tool_use_id` lets the UI tell which
 * subagent (if any) made the call.
 */
export async function prompt(s: Shared, task: Task, call_id: string, tool_name: string, input: any, tool_use_id: string | null): Promise<any> {
  input = input === undefined ? null : input;
  const question = is_question(tool_name);
  const mode = mode_of(s, task);
  // The user's approval rules come first, whatever the mode (see agent/approval_rules.ts).
  const rules = approval_rules.for_task(s.db(), task);
  const rule = rules ? approval_rules.decide(approval_rules.for_mode(rules, mode), tool_name) : null;
  if (rule?.decision === "never") {
    approval_rules.log_decided(s, task, tool_name, input, rule, "blocked", "rule");
    return deny(approval_rules.blocked_reason(rule.tool));
  } else if (rule?.decision === "allow") {
    return allow(input);
  } else if (rule?.decision === "ask") {
    // Don't ask never asks: it's denied, as anything it would have asked is.
    if (mode === "dontAsk") {
      approval_rules.log_decided(s, task, tool_name, input, rule, "denied", "mode");
      return deny(DONT_ASK_DENIAL);
    }
  } else {
    // A labelled task's agent writes its documents in its own folder.
    if (!question && (task.auto_allow.includes(tool_name) || documents.writes_own_folder(s, task, tool_name, input))) return allow(input);
    // The run was started under an older mode; honour the one selected now.
    const live = decision_in(mode);
    if (live === true && !question) return allow(input);
    if (live === false) return deny(DONT_ASK_DENIAL);
  }
  const data = { tool_name, input, tool_use_id: tool_use_id ?? null };
  const id = request_ruled(s, task, call_id, "tool", tool_name, input, data, reason(tool_name, input), rule);
  const d = await decision(s, id);
  return d === null ? allowed(s, id, task.id, tool_name, input) : deny(d);
}

/** Thread `task`'s permission mode now (its own, or the one it inherits). */
function mode_of(s: Shared, task: Task): string {
  const project = task.project_id ? db.get_project(s.db(), task.project_id) : null;
  return db.effective_permission_mode(task, s.db(), project);
}

const one_line = (s: string) => s.split(/\s+/).filter(Boolean).join(" ");

/** What a task waiting on a prompt for `tool_name` says it's waiting for (its attention reason). */
export function reason(tool_name: string, input: any): string {
  if (is_question(tool_name)) {
    const questions: any[] = Array.isArray(input?.questions) ? input.questions : [];
    const found = questions.find((q) => typeof q?.question === "string");
    const first = found ? one_line(found.question) : "";
    if (!first) return "The agent has questions for you";
    const n = questions.length;
    if (n <= 1) return first;
    return `${first} (and ${n - 1} more question${n === 2 ? "" : "s"})`;
  }
  if (tool_name === EXIT_PLAN) {
    // The plan's title, if it starts with one ("# Plan: add a cache").
    let title: string | null = null;
    if (typeof input?.plan === "string") {
      const line = input.plan.split("\n").map((l: string) => l.trim()).find((l: string) => l !== "");
      if (line?.startsWith("#")) {
        const t = one_line(line.slice(1).replace(/^#+/, ""));
        title = t.startsWith("Plan:") ? t.slice(5).trim() : t;
      }
    }
    return title ? `Plan ready for approval: ${title}` : "Plan ready for approval";
  }
  return `Approve ${tool_name}?`;
}

/**
 * What the agent is told when the user allowed request `id`: its input as the user approved it (with their answers, for a
 * question), and for an approved plan, the mode the thread carries on in.
 */
function allowed(s: Shared, id: string, task_id: string, tool_name: string, input: any): any {
  const stored = db.value<string>(s.db(), "SELECT input FROM permission_requests WHERE id=?1", id);
  let approved = input;
  if (stored !== undefined) {
    try {
      approved = JSON.parse(stored);
    } catch {}
  }
  const answer: any = allow(approved);
  // Claude Code leaves plan mode for Ask: another mode it can switch to is set for the rest of the run (Bypass can't be
  // switched to, but the board allows everything for it, see live_decision).
  if (tool_name === EXIT_PLAN) {
    const t = db.get_task(s.db(), task_id);
    let mode: string | null = null;
    if (t) {
      const project = t.project_id ? db.get_project(s.db(), t.project_id) : null;
      mode = db.effective_permission_mode(t, s.db(), project);
    }
    if (mode && ["acceptEdits", "auto"].includes(mode)) answer.updatedPermissions = [{ type: "setMode", mode, destination: "session" }];
  }
  return answer;
}

/**
 * Ask the user to approve what an agent asked for with `tool` (see mcp/tools.rs), a request of `kind`: a new project or a
 * change to one (`project`, from create_project and update_project), deleting a task (`delete_task`), or creating,
 * changing or deleting one of a project's automations (`automation`, from the automation tools). Only the user decides
 * these, whatever the thread's permission mode: `{ok: input}` once they approve it, with the input they approved (the
 * first asked for this call, if it's retried), or `{err: reason}` if they deny it or the run ends first.
 */
export async function approve(s: Shared, task: Task, call_id: string, kind: string, tool: string, input: any): Promise<{ ok: any } | { err: string }> {
  const data = { kind, tool_name: tool, input };
  let question: string;
  if (kind === "delete_task") question = "Delete a task?";
  else if (kind === "automation" && input?.workflow != null && input?.op === "delete") question = "Delete a workflow?";
  else if (kind === "automation" && input?.workflow != null) question = "Approve a workflow?";
  else if (kind === "automation" && input?.op === "delete") question = "Delete an automation?";
  else if (kind === "automation") question = "Approve an automation?";
  else if (kind === "project" && tool === "create_project") question = "Add a project?";
  else question = "Approve a project change?";
  // An ask rule on the tool doesn't ask again (see dispatch's check_rules): this request is its asking, and goes in the
  // action log.
  const rules = approval_rules.for_task(s.db(), task);
  let rule: Rule | null = null;
  if (rules && approval_rules.ASKS_ITSELF.includes(tool)) {
    const r = approval_rules.board_rule(rules, tool)?.[1] ?? null;
    if (r?.decision === "ask") rule = r;
  }
  const id = request_ruled(s, task, call_id, kind, tool, input, data, question, rule);
  const d = await decision(s, id);
  if (d !== null) return { err: d };
  const approved = db.value<string>(s.db(), "SELECT input FROM permission_requests WHERE id=?1", id);
  return approved === undefined ? { err: EXPIRED } : { ok: JSON.parse(approved) };
}

/** What MCP call `call_id` asked the user to approve (a project change, a deletion or an automation), if it asked. */
export function asked(s: Shared, call_id: string): any | null {
  let input: string | undefined;
  try {
    input = db.value<string>(s.db(), "SELECT input FROM permission_requests WHERE call_id=?1 AND kind IN ('project','delete_task','automation')", call_id);
  } catch {
    input = undefined;
  }
  return input === undefined ? null : JSON.parse(input);
}

/**
 * The request for MCP call `call_id`, raised (with `data` as its thread message) if it's new. One that approval rule
 * `rule` asks about is asked whatever the mode, and goes in the action log. A request from a routine run expires (see
 * `expiry`).
 */
function request_ruled(
  s: Shared, task: Task, call_id: string, kind: string, tool_name: string, input: any, data: any, reason: string, rule: Rule | null,
): string {
  // By tool too: one call can ask more than once, an approval rule first and then the tool itself (an update_project, or
  // a wait's command), and each has its own answer.
  let existing: string | undefined;
  try {
    existing = db.value<string>(s.db(), "SELECT id FROM permission_requests WHERE call_id=?1 AND tool_name=?2", call_id, tool_name);
  } catch {}
  if (existing !== undefined) return existing;
  // Checked against the runs this host holds, so that the call's run can't have ended in between: runner::finish expires
  // its thread's prompts as it lets go of it. One from a run that has ended would flag its thread for nothing.
  const run_id = db.value<string>(s.db(), "SELECT run_id FROM mcp_calls WHERE id=?1", call_id);
  if (run_id !== undefined && run_id !== null && s.runs.get(task.id)?.run_id !== run_id) throw new Error("this call's run has ended on the board");
  const id = new_id();
  data = { ...data, request_id: id, status: "pending" };
  const expires_at = expiry(s, task, call_id);
  if (expires_at !== null) data.expires_at = expires_at;
  if (rule) data.rule = { tool: rule.tool, decision: rule.decision };
  // So the thread names the agent that asked.
  const config = db.task_claude_config(s.db(), task);
  if (config?.agent === "codex") data.agent = "codex";
  const msg = s.add_message(task.id, "permission", data);
  db.run(
    s.db(),
    `INSERT INTO permission_requests (id,task_id,message_id,tool_name,input,status,created_at,call_id,kind,expires_at,rule)
     VALUES (?1,?2,?3,?4,?5,'pending',?6,?7,?8,?9,?10)`,
    id,
    task.id,
    msg.id,
    tool_name,
    JSON.stringify(input ?? null),
    now(),
    call_id,
    kind,
    expires_at,
    rule?.tool ?? null,
  );
  if (rule) {
    // An approval of the board's own (a deletion, say) by the tool's name, as rules name it.
    const logged = kind === "tool" ? tool_name : `mcp__${runner.MCP_SERVER_NAME}__${tool_name}`;
    approval_rules.log_asked(s.db(), task, id, logged, input, rule);
  }
  const fields: Array<[string, any]> = [["attention_reason", reason]];
  if (task.kind === "task") fields.push(["status", "needs_attention"]);
  s.update_task(task.id, fields);
  return id;
}

/**
 * When a request raised by MCP call `call_id` in `task`'s thread is denied unanswered: for a call from a routine run, the
 * profile's expiry after now (see approval_rules.Rules.expiry_minutes).
 */
function expiry(s: Shared, task: Task, call_id: string): string | null {
  // Only the assistant's and its threads' (where the rules hold): project tasks an automation starts wait for their
  // prompts as they always did.
  if (!approval_rules.applies_to(s.db(), task) || !routine_call(s.db(), call_id)) return null;
  const minutes = approval_rules.get(s.db(), task.profile_id).expiry_minutes;
  return minutes > 0 ? new Date(Date.now() + minutes * 60_000).toISOString() : null;
}

/**
 * Whether MCP call `call_id` comes from a routine run: one whose turn an automation started, with nobody there to answer
 * (its message is marked `routine`, see runner.send_from_routine).
 */
export function routine_call(c: db.Conn, call_id: string): boolean {
  const data = db.value<string>(
    c,
    "SELECT m.data FROM mcp_calls k JOIN runs r ON r.id=k.run_id JOIN messages m ON m.id=r.turn_message_id WHERE k.id=?1",
    call_id,
  );
  if (data == null) return false;
  try {
    return JSON.parse(data)?.routine === true;
  } catch {
    return false;
  }
}

/** Waits for the user to decide request `id`: null if they allowed it, else the reason. */
async function decision(s: Shared, id: string): Promise<string | null> {
  for (;;) {
    // Register before reading so a decision can't slip in between.
    let woken!: () => void;
    const rx = new Promise<void>((r) => (woken = r));
    const list = s.perm_waiters.get(id) ?? [];
    list.push(woken);
    s.perm_waiters.set(id, list);
    const row = db.one<{ status: string; note: string | null }>(s.db(), "SELECT status, note FROM permission_requests WHERE id=?1", id);
    // Gone with its thread (deleted, which expires it first, but may delete it before this reads the expiry).
    if (!row) {
      s.perm_waiters.delete(id);
      return EXPIRED;
    }
    if (row.status === "allowed") return null;
    if (row.status !== "pending") return row.note ?? "The user denied this action.";
    await rx;
  }
}

function allow(input: any): any {
  return { behavior: "allow", updatedInput: input ?? null };
}

function deny(message: string): any {
  return { behavior: "deny", message };
}

/**
 * What a thread's current permission mode decides for any prompt without asking the user: approve everything (bypass),
 * deny everything (don't ask), or ask (null).
 */
export function live_decision(s: Shared, task: Task): boolean | null {
  return decision_in(mode_of(s, task));
}

function decision_in(mode: string): boolean | null {
  if (mode === "bypassPermissions") return true;
  if (mode === "dontAsk") return false;
  return null;
}

/**
 * After a thread's mode changes, settle the prompts it is waiting on that the new mode decides (not project changes or
 * deletions, which only the user decides, nor in Bypass what an approval rule asks).
 */
export function apply_mode_to_pending(s: Shared, task: Task): void {
  const allow = live_decision(s, task);
  if (allow === null) return;
  const rows = db.all<{ id: string; tool_name: string; ruled: number }>(
    s.db(),
    "SELECT id, tool_name, rule IS NOT NULL AS ruled FROM permission_requests WHERE task_id=?1 AND status='pending' AND kind='tool'",
    task.id,
  );
  // Bypass doesn't answer questions for the user (see prompt).
  const ids = rows.filter((r) => !(allow && (is_question(r.tool_name) || !!r.ruled))).map((r) => r.id);
  const message = allow ? null : DONT_ASK_DENIAL;
  for (const id of ids) {
    // Another client may have answered it in the meantime.
    try {
      answer_by(s, id, allow, false, message, {}, "mode");
    } catch {}
  }
}

/** Prompts waiting for an answer, oldest first: all of this host's, or one task's. */
export function pending(s: Shared, task_id: string | null, profile_id: string | null = null): any[] {
  const rows = db.all<{ id: string; task_id: string; tool_name: string; input: string; created_at: string; expires_at: string | null; rule: string | null }>(
    s.db(),
    `SELECT id, task_id, tool_name, input, created_at, expires_at, rule FROM permission_requests
     WHERE status='pending' AND (?1 IS NULL OR task_id=?1)
       AND (?2 IS NULL OR task_id IN (SELECT id FROM tasks WHERE profile_id=?2)) ORDER BY created_at, rowid`,
    task_id,
    profile_id,
  );
  return rows.map((r) => {
    let input: any;
    try {
      input = JSON.parse(r.input);
    } catch {
      input = r.input;
    }
    return { id: r.id, task_id: r.task_id, tool_name: r.tool_name, input, created_at: r.created_at, expires_at: r.expires_at, rule: r.rule };
  });
}

/** Answer request `id` as the user, on the board (see `answer_by`). */
export function decide(s: Shared, id: string, allow: boolean, always: boolean, message: string | null): "allowed" | "denied" {
  return answer(s, id, allow, always, message, {});
}

/** What the user answered a question or a plan with, besides allowing or denying it (API 64). */
export interface Reply {
  /**
   * For a question (see is_question), allowed: each question's answers, in order. An answer is a chosen option's label or
   * what the user typed; a question with none is left unanswered.
   */
  answers?: string[][] | null;
  /** For a plan (ExitPlanMode), approved: the permission mode the thread carries on in. */
  mode?: string | null;
  /** For a plan, denied: what the user wants changed, sent to the agent as it keeps planning. */
  feedback?: string | null;
}

/** `answer_by` the user, on the board. */
export function answer(s: Shared, id: string, allow: boolean, always: boolean, message: string | null, reply: Reply): "allowed" | "denied" {
  return answer_by(s, id, allow, always, message, reply, "user");
}

/**
 * Allow or deny request `id`, with what the user answered (see Reply). Answering a question or a plan whose run ended
 * first (expired) sends the answer to the agent as the user's message instead. Only the first answer counts: another
 * (from another tab, say) is refused. `by` is who answered, for the action log (see approval_rules.Action.answered_by).
 */
export function answer_by(s: Shared, id: string, allow: boolean, always: boolean, message: string | null, reply: Reply, by: string): "allowed" | "denied" {
  const row = db.one<{ task_id: string; message_id: number; tool_name: string; status: string; kind: string; input: string; rule: string | null }>(
    s.db(),
    "SELECT task_id, message_id, tool_name, status, kind, input, rule FROM permission_requests WHERE id=?1",
    id,
  );
  if (!row) throw ApiError.not_found("permission request");
  const { task_id, message_id, tool_name, status: current, kind, rule } = row;
  const question = is_question(tool_name);
  const plan = tool_name === EXIT_PLAN && kind === "tool";
  // Each project change and deletion is approved on its own, and each question answered. What an approval rule asks is
  // asked each time.
  always = always && kind === "tool" && !question && rule === null;
  // A question or plan the agent's run ended on can still be answered, by message.
  const late = current === "expired" && (question || plan);
  if (current !== "pending" && !late) throw ApiError.conflict("this request is no longer pending");
  if (late && moved_on(s, task_id, message_id)) {
    throw ApiError.conflict("the conversation has moved on since this was asked: reply in the thread instead");
  }
  const picked_mode = plan && allow && typeof reply.mode === "string" ? reply.mode : null;
  if (picked_mode !== null && (picked_mode === "plan" || !db.PERMISSION_MODES.includes(picked_mode))) {
    throw ApiError.bad("mode must be one of the permission modes other than plan");
  }
  let input: any;
  try {
    input = JSON.parse(row.input);
  } catch {
    input = null;
  }
  const answers = question && allow && reply.answers ? check_answers(input, reply.answers) : null;
  if (answers) {
    if (!input || typeof input !== "object" || Array.isArray(input)) input = {};
    input.answers = tool_answers(tool_name, input, answers);
  }
  const fb = typeof reply.feedback === "string" ? reply.feedback.trim() : "";
  const feedback = plan && !allow && fb ? fb : null;
  let note: string | null;
  if (message !== null && message !== undefined) note = message;
  else if (feedback !== null) note = `The user wants you to keep planning rather than start on this plan. Their feedback:\n\n${feedback}`;
  else if (plan && !allow) note = "The user wants you to keep planning rather than start on this plan.";
  else note = null;
  const status = allow ? "allowed" : "denied";
  // In one statement, so of two answers at once only one is taken.
  const taken = db.run(
    s.db(),
    "UPDATE permission_requests SET status=?1, note=?2, input=?3 WHERE id=?4 AND status=?5",
    status,
    note,
    JSON.stringify(input),
    id,
    current,
  ).changes;
  if (taken === 0) throw ApiError.conflict("this request is no longer pending");
  if (rule !== null) approval_rules.settle(s, id, status, by);
  const task = db.get_task(s.db(), task_id);
  // Approving a plan ends plan mode for this thread, otherwise the next run would plan again (as the one a late
  // approval's message starts would).
  const mode = task && allow && plan ? mode_after_plan(s, task, picked_mode) : undefined;
  if (mode !== undefined) set_mode(s, task_id, mode);
  if (late) {
    // Its run is over: what the user answered goes to the agent as their message.
    let text: string | null;
    if (question) text = allow && answers ? late_answers(input, answers) : null; // dismissed: nothing to tell it
    else if (allow) text = "Your plan is approved: go ahead and implement it.";
    else text = feedback !== null ? `Keep planning: don't start on the plan yet.\n\n${feedback}` : "Keep planning: don't start on the plan yet.";
    if (text !== null) {
      try {
        runner.send(s, task_id, text);
      } catch (e) {
        // Answerable again, as it was.
        try {
          db.run(s.db(), "UPDATE permission_requests SET status='expired', note=NULL WHERE id=?1", id);
        } catch {}
        if (task && mode !== undefined) {
          try {
            s.update_task(task_id, [["permission_mode", task.permission_mode ?? null]]);
          } catch {}
        }
        throw e;
      }
    }
  }
  update_message(s, message_id, (v) => {
    v.status = status;
    if (note !== null) v.note = note;
    if (answers) v.answers = shown_answers(input, answers);
    if (feedback !== null) v.feedback = feedback;
    if (picked_mode !== null) v.mode = picked_mode;
    if (late) v.late = true;
  });
  // The user's answers to the agent's questions are a prompt to it: they put the task in "now", like a message does
  // (not the other permission decisions, which only let the agent carry on).
  if (answers) focus.put_in_now(s, task_id);
  if (always && task) {
    const list = [...task.auto_allow];
    if (!list.includes(tool_name)) list.push(tool_name);
    s.update_task(task_id, [["auto_allow", JSON.stringify(list)]]);
  }
  wake(s, id);
  if (late) return status;
  back_to_work(s, task_id);
  return status;
}

/** A prompt of `task_id`'s was settled while its agent runs: it's back to work if no other prompt is waiting. */
function back_to_work(s: Shared, task_id: string): void {
  const still_pending = db.value<number>(s.db(), "SELECT COUNT(*) FROM permission_requests WHERE task_id=?1 AND status='pending'", task_id) ?? 0;
  if (still_pending === 0 && s.is_running(task_id)) {
    const fields: Array<[string, any]> = [["attention_reason", null]];
    const t = db.get_task(s.db(), task_id);
    if (t && t.kind === "task") fields.push(["status", db.working_status(t)]);
    s.update_task(task_id, fields);
  }
}

/**
 * The permission mode thread `t` carries on in once its plan is approved, if it changes (undefined if it doesn't): the one
 * the user picked (or the thread's default, if that's it, as null), or else the thread's default if it's planning (Ask
 * if that's Plan too).
 */
function mode_after_plan(s: Shared, t: Task, picked: string | null): string | null | undefined {
  const project = t.project_id ? db.get_project(s.db(), t.project_id) : null;
  const inherited = db.inherited_permission_mode(s.db(), project);
  const current = t.permission_mode ?? inherited;
  if (picked !== null) {
    // The mode it's in (the agent went into plan mode by itself): a thread's own mode stays its own.
    if (picked === current && current !== "plan") return undefined;
    if (picked === inherited) return null;
    return picked;
  }
  if (current === "plan") return inherited === "plan" ? "default" : null;
  return undefined;
}

/**
 * Whether the conversation in `task_id`'s thread has moved on since message `message_id`: a message has been sent to the
 * agent after it (by the user, the board or another agent). A question or plan asked before then isn't answered any more.
 */
export function moved_on(s: Shared, task_id: string, message_id: number): boolean {
  return !!db.value<number>(s.db(), "SELECT EXISTS(SELECT 1 FROM messages WHERE task_id=?1 AND kind='user' AND id>?2)", task_id, message_id);
}

function set_mode(s: Shared, task_id: string, mode: string | null): void {
  const t = s.update_task(task_id, [["permission_mode", mode]]);
  if (t) apply_mode_to_pending(s, t);
}

/** A question prompt's questions (see is_question). */
function questions(input: any): any[] {
  return Array.isArray(input?.questions) ? input.questions : [];
}

/**
 * The answers to a question prompt's questions, trimmed, checked against them: one list per question, and a question
 * that takes one answer (a Codex question) gets at most one.
 */
function check_answers(input: any, answers: string[][]): string[][] {
  const qs = questions(input);
  if (answers.length !== qs.length) throw ApiError.bad(`answers must have one list for each of the ${qs.length} questions`);
  return qs.map((q, i) => {
    const a = (answers[i] ?? []).map((x) => String(x).trim()).filter((x) => x !== "");
    if (a.length > 1 && q?.multiSelect !== true) throw ApiError.bad(`"${typeof q?.question === "string" ? q.question : "?"}" takes one answer`);
    return a;
  });
}

/**
 * The answers as the agent's tool takes them in its input's `answers`: Claude Code's by question, with the answers to one
 * question joined by commas; Codex's by question id.
 */
function tool_answers(tool_name: string, input: any, answers: string[][]): any {
  const out: Record<string, any> = {};
  questions(input).forEach((q, i) => {
    const a = answers[i];
    if (!a || !a.length) return;
    if (tool_name === CODEX_QUESTIONS) out[typeof q?.id === "string" ? q.id : ""] = { answers: a };
    else out[typeof q?.question === "string" ? q.question : ""] = a.join(", ");
  });
  return out;
}

/** The answers as the thread shows them: a secret's hidden (Codex can ask for one). */
function shown_answers(input: any, answers: string[][]): string[][] {
  return questions(input)
    .slice(0, answers.length)
    .map((q, i) => (q?.isSecret === true && answers[i].length ? ["(hidden)"] : answers[i]));
}

/** The user's message with the answers to questions asked in a run that ended first. */
function late_answers(input: any, answers: string[][]): string {
  const shown = shown_answers(input, answers);
  const lines = questions(input)
    .slice(0, shown.length)
    .map((q, i) => {
      const asked = typeof q?.question === "string" ? q.question : "?";
      const a = shown[i];
      return a.length ? `- ${asked}\n  ${a.join(", ")}` : `- ${asked}\n  (no answer)`;
    });
  const what = lines.length === 1 ? "answer to the question" : "answers to the questions";
  return `My ${what} you asked:\n\n${lines.join("\n")}`;
}

/**
 * The project changes agents are waiting for the user to approve, oldest first, each with the thread that asked, with
 * `deletions` the tasks they're waiting to delete too, and with `automations` the automations they're waiting to create,
 * change or delete (older UIs only know project changes, or those and deletions).
 */
export function pending_approvals(s: Shared, deletions: boolean, automations: boolean, workflows = false): any[] {
  // Workflows' approvals are asked as automations' are, with `workflow` in place of `automation`: a UI from before them
  // (API 107) isn't shown them.
  const rows = db.all<{ task_id: string; created_at: string; data: string }>(
    s.db(),
    `SELECT p.task_id, p.created_at, m.data FROM permission_requests p JOIN messages m ON m.id=p.message_id
     WHERE (p.kind='project' OR (?1 AND p.kind='delete_task')
            OR (?2 AND p.kind='automation' AND (?3 OR json_extract(p.input, '$.workflow') IS NULL))) AND p.status='pending' ORDER BY p.created_at`,
    deletions,
    automations,
    workflows,
  );
  return rows.map((r) => {
    let v: any;
    try {
      v = JSON.parse(r.data);
    } catch {
      v = {};
    }
    if (!v || typeof v !== "object" || Array.isArray(v)) v = {};
    v.task_id = r.task_id;
    v.created_at = r.created_at;
    return v;
  });
}

function wake(s: Shared, id: string): void {
  const list = s.perm_waiters.get(id) ?? [];
  s.perm_waiters.delete(id);
  for (const w of list) w();
}

export function set_message_status(s: Shared, message_id: number, status: string, note: string | null): void {
  update_message(s, message_id, (v) => {
    v.status = status;
    if (note !== null) v.note = note;
  });
}

/** Change message `message_id`'s data with `f`, and tell the UI. */
function update_message(s: Shared, message_id: number, f: (v: any) => void): void {
  const data = db.value<string>(s.db(), "SELECT data FROM messages WHERE id=?1", message_id);
  if (data === undefined) return;
  let v: any;
  try {
    v = JSON.parse(data);
  } catch {
    v = {};
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) v = {};
  f(v);
  const m = db.update_message_data(s.db(), message_id, v);
  if (m) s.emit_message_updated(m);
}

/** Expire unanswered permission prompts for a thread whose run ended. */
export function expire_for_task(s: Shared, task_id: string): void {
  expire(s, "SELECT id, message_id FROM permission_requests WHERE task_id=?1 AND status='pending'", task_id);
}

/** Expire the unanswered prompts run `run_id` raised (a later run's on its thread stay). */
export function expire_for_run(s: Shared, run_id: string): void {
  expire(s, "SELECT id, message_id FROM permission_requests WHERE status='pending' AND call_id IN (SELECT id FROM mcp_calls WHERE run_id=?1)", run_id);
}

/**
 * Expire the unanswered approvals of changes to a project that's being deleted (and of deleting its tasks, and of its
 * automations), asked from any thread.
 */
export function expire_for_project(s: Shared, project_id: string): void {
  expire(
    s,
    "SELECT id, message_id FROM permission_requests WHERE kind IN ('project','delete_task','automation') AND status='pending' AND json_extract(input, '$.project.id')=?1",
    project_id,
  );
}

/** Expire the unanswered requests to delete a task that's being deleted anyway, asked from any thread. */
export function expire_deletions_of(s: Shared, task_id: string): void {
  expire(s, "SELECT id, message_id FROM permission_requests WHERE kind='delete_task' AND status='pending' AND json_extract(input, '$.delete.id')=?1", task_id);
}

/** Expire the unanswered requests to change or delete an automation that's been deleted, asked from any thread. */
export function expire_for_automation(s: Shared, automation_id: string): void {
  expire(
    s,
    "SELECT id, message_id FROM permission_requests WHERE kind='automation' AND status='pending' AND json_extract(input, '$.automation.id')=?1",
    automation_id,
  );
}

/** Expire the unanswered requests to change or delete a workflow that's been deleted, asked from any thread. */
export function expire_for_workflow(s: Shared, workflow_id: string): void {
  expire(
    s,
    "SELECT id, message_id FROM permission_requests WHERE kind='automation' AND status='pending' AND json_extract(input, '$.workflow.id')=?1",
    workflow_id,
  );
}

function expire(s: Shared, query: string, arg: string): void {
  let rows: Array<{ id: string; message_id: number }>;
  try {
    rows = db.all(s.db(), query, arg);
  } catch {
    return;
  }
  for (const { id, message_id } of rows) {
    // Unless the user answered it since it was looked up.
    let n = 0;
    try {
      n = db.run(s.db(), "UPDATE permission_requests SET status='expired', note=?2 WHERE id=?1 AND status='pending'", id, EXPIRED).changes;
    } catch {}
    if (n > 0) {
      try {
        set_message_status(s, message_id, "expired", null);
      } catch {}
      try {
        approval_rules.settle(s, id, "expired", "ended");
      } catch {}
      wake(s, id);
    }
  }
}

/**
 * Deny the prompts from routine runs that nobody answered before they expired (`expires_at`, see `expiry`) by `at`,
 * telling their agents to carry on without them. Prompts raised before prompts expired have no `expires_at`, so they wait
 * as they did. Returns how many it denied.
 */
export function expire_due(s: Shared, at: Date): number {
  let rows: Array<{ id: string; message_id: number; task_id: string }>;
  try {
    rows = db.all(
      s.db(),
      "SELECT id, message_id, task_id FROM permission_requests WHERE status='pending' AND expires_at IS NOT NULL AND expires_at <= ?1",
      at.toISOString(),
    );
  } catch {
    return 0;
  }
  let denied = 0;
  for (const { id, message_id, task_id } of rows) {
    // Unless it was answered since it was looked up.
    let n = 0;
    try {
      n = db.run(s.db(), "UPDATE permission_requests SET status='expired', note=?2 WHERE id=?1 AND status='pending'", id, EXPIRED_UNANSWERED).changes;
    } catch {}
    if (n > 0) {
      denied += 1;
      try {
        set_message_status(s, message_id, "expired", EXPIRED_UNANSWERED);
      } catch {}
      try {
        approval_rules.settle(s, id, "expired", "expiry");
      } catch {}
      wake(s, id);
      try {
        back_to_work(s, task_id);
      } catch (e) {
        console.warn(`task ${task_id}: after a prompt expired: ${e}`);
      }
    }
  }
  return denied;
}

/** How often the sweeper looks for prompts that have expired, in milliseconds. */
const SWEEP_EVERY = 15_000;

/**
 * Denies prompts as they expire (see `expire_due`), from now on: at once, for those that expired while the board was
 * down, and then every few seconds.
 */
export function start_sweeper(s: Shared): void {
  const sweep = () => {
    try {
      expire_due(s, new Date());
    } catch (e) {
      console.warn(`permissions: expiring prompts: ${e}`);
    }
  };
  sweep();
  setInterval(sweep, SWEEP_EVERY).unref();
}
