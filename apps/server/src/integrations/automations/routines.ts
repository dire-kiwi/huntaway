// Port of server/src/integrations/automations/routines.rs (HA-122 and HA-161, on the HA-117 branch).
/**
 * Routines: a profile's automations, which wake its assistant (see agent/assistant.ts).
 *
 * A routine's message goes either to the assistant's own thread (`thread`, as `send_to_task` does), or by default
 * (`fresh`) to a new thread under it (`parent_id`, `task_type` `routine`, off the board), which works in the assistant's
 * workspace with its tools, config and model. When that thread's agent stops, its last message is posted in the
 * assistant's thread as a report (a `report` message), unless it's `NO_REPLY` or empty: a quiet run says nothing. The
 * assistant reads the reports it hasn't seen with the user's next message (see `unread_reports`), so the routine's work
 * stays out of its context. Routine threads are pruned after `KEEP_THREAD_DAYS`.
 */
import * as db from "../../db.ts";
import type { Conn, Task } from "../../db.ts";
import { ApiError } from "../../http.ts";
import * as api from "../../api.ts";
import * as assistant from "../../agent/assistant.ts";
import * as memory from "../../agent/assistant/memory.ts";
import * as runner from "../../agent/runner.ts";
import * as runs from "../../agent/runs.ts";
import * as worktree from "../../git/worktree.ts";
import type { Shared } from "../../state.ts";
import { err_str, expand_tilde, reached, truncate } from "../../util.ts";
import { Run_from_row, changed, days, fmt, get, parse_time, type Automation, type Outcome, type Run } from "../automations.ts";
import { Local, local_parts, to_local, from_local, type Tz } from "./check.ts";
import { cut, render, untrusted_note, type Vars } from "./delivery.ts";
import * as history from "../../threads/history.ts";

/** What a routine's agent says when it has nothing to report. */
export const NO_REPLY = "NO_REPLY";
/** How long a precheck may run before it's stopped (and the run fails). */
const PRECHECK_LIMIT = 120_000;
/** What a precheck prints that a template gets, at most. */
const MAX_PRECHECK_CHARS = 20_000;
/** Finished routine threads older than this are deleted (their runs and reports stay). */
export const KEEP_THREAD_DAYS = 14;
/** A report in the assistant's thread is cut to this. */
const MAX_REPORT_CHARS = 20_000;

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const p2 = (n: number) => String(n).padStart(2, "0");

/** `%a %-d %b %H:%M` of `t` in the host's time zone, e.g. `Thu 5 Nov 09:30`. */
function when_text(t: number): string {
  const local = to_local(Local, t);
  const l = local_parts(local);
  return `${DAY_NAMES[new Date(local).getUTCDay()]} ${l.d} ${MONTH_NAMES[l.mo - 1]} ${p2(l.h)}:${p2(l.mi)}`;
}

/** `%a %H:%M` of `t` in the host's time zone. */
function day_time_text(t: number): string {
  const local = to_local(Local, t);
  const l = local_parts(local);
  return `${DAY_NAMES[new Date(local).getUTCDay()]} ${p2(l.h)}:${p2(l.mi)}`;
}

const failed = (e: any): Outcome => ({ err: [null, e instanceof ApiError ? e.message : err_str(e)] });

/**
 * Sends routine `a`'s message (for its run `run_id`) to its profile's assistant, `mode` deciding where: the thread it
 * made or messaged (`{ok}`), or why it couldn't. The run is linked to that thread before its agent starts, so a run that
 * ends at once still finds it (see `finished`).
 */
export function message(
  s: Shared,
  a: Automation,
  run_id: string,
  vars: Vars,
  how: string,
  text: string,
  mode: "fresh" | "thread",
): { ok: string | null } | Outcome {
  let the_assistant: Task;
  try {
    the_assistant = assistant.get_or_create(s, a.profile_id);
  } catch (e) {
    return failed(e);
  }
  const [body, untrusted] = render(text, vars, "text");
  const note = untrusted ? untrusted_note(vars, false) : "";
  if (mode === "thread") {
    const msg = `From your routine "${a.name}", ${how}:\n\n${note}${body.trim()}`;
    // The assistant's run that takes the message in is the routine run's, for its cost: its id goes with the message,
    // through steering and the queue (see `taken_in`).
    try {
      db.run(s.db(), "UPDATE automation_runs SET task_id=?2 WHERE id=?1", run_id, the_assistant.id);
    } catch (e) {
      return failed(e);
    }
    try {
      runner.send_from_routine(s, the_assistant.id, msg, run_id);
    } catch (e) {
      try {
        db.run(s.db(), "UPDATE automation_runs SET task_id=NULL WHERE id=?1", run_id);
      } catch {}
      return failed(e);
    }
    return { ok: the_assistant.id };
  }
  const when = when_text(vars.now);
  let thread: Task;
  // Not under an assistant that's being deleted, which would take it along unstopped (see api.Deleting).
  if (s.deleting.has(the_assistant.id)) return { err: [null, "the assistant is being deleted"] };
  try {
    const c = s.db();
    thread = db.insert_routine_task(c, the_assistant, `${a.name} · ${when}`);
    db.run(c, "UPDATE automation_runs SET task_id=?2 WHERE id=?1", run_id, thread.id);
  } catch (e) {
    return failed(e);
  }
  s.emit_task(thread);
  reached("routine:thread");
  const msg =
    `This is a run of your routine "${a.name}", ${how} (${when}), in a thread of its own (A-${thread.number}).\n\n${note}${body.trim()}\n\n` +
    "When you're done, reply with a short report for the user: it's posted to your main thread. If there's nothing " +
    `new or worth telling them, reply with just ${NO_REPLY}, and nothing is posted.`;
  // Nobody's there to answer its prompts.
  try {
    runner.send_from_routine(s, thread.id, msg, null);
  } catch (e) {
    // It never started (the host can't run agents, say): an empty thread would only be in the way.
    try {
      db.run(s.db(), "UPDATE automation_runs SET task_id=NULL WHERE id=?1", run_id);
      db.run(s.db(), "DELETE FROM tasks WHERE id=?1 AND running=0", thread.id);
    } catch {}
    s.emit({ type: "task_deleted", id: thread.id, project_id: null });
    return failed(e);
  }
  return { ok: thread.id };
}

/**
 * The agent run `run_id` took in a message carrying these automation runs' (see runner.send_from_routine and
 * send_from_automation): they're its, for its cost. Called as it's recorded.
 */
export function taken_in(c: Conn, run_id: string, automation_runs: string[]): void {
  for (const id of automation_runs) db.run(c, "UPDATE automation_runs SET agent_run_id=?2 WHERE id=?1", id, run_id);
}

/**
 * An agent run ended: the automation runs it took the messages of (a thread-mode routine's, or a project automation's,
 * which it started with or was sent) record what it cost, split evenly between them when it took several (its other
 * work, such as the user's messages, counts too: a run can't be split by what each message cost).
 */
export function agent_run_ended(s: Shared, run_id: string): void {
  let ids: string[] = [];
  try {
    const c = s.db();
    try {
      db.run(
        c,
        `UPDATE automation_runs SET cost_usd=(SELECT cost_usd FROM runs WHERE id=?1) / (SELECT COUNT(*) FROM automation_runs WHERE agent_run_id=?1)
             WHERE agent_run_id=?1`,
        run_id,
      );
    } catch {}
    ids = db.all(c, "SELECT DISTINCT automation_id FROM automation_runs WHERE agent_run_id=?1", run_id).map((r: any) => r.automation_id);
  } catch {
    return;
  }
  for (const id of ids) {
    let a: Automation | null = null;
    try {
      a = get(s.db(), id);
    } catch {}
    if (a) changed(s, a);
  }
}

/**
 * Whether a routine's last message says it has nothing to report: empty, or `NO_REPLY` (on its own, or as its last line,
 * in backticks or bold or not).
 */
export function is_quiet(text: string): boolean {
  const lines = text.split("\n").map((l) => l.trim());
  const last = lines.findLast((l) => l !== "");
  if (last === undefined) return true;
  const strip = "`*_.\"' ";
  let [i, j] = [0, last.length];
  while (i < j && strip.includes(last[i])) i++;
  while (j > i && strip.includes(last[j - 1])) j--;
  return last.slice(i, j) === NO_REPLY;
}

/** The start of `now`'s day in `tz`, as a UTC time (the first moment of it, past any gap). */
function day_start(now: number, tz: Tz): number {
  const l = local_parts(to_local(tz, now));
  const date = Date.UTC(l.y, l.mo - 1, l.d);
  for (let m = 0; m < 24 * 60; m++) {
    const t = from_local(tz, date + m * 60_000);
    if (t !== null) return t;
  }
  return now;
}

/**
 * What a run's cost is counted as: as it recorded it, else its routine thread's so far, else its share of the agent run
 * that took its message in so far.
 */
const COST = `COALESCE(SUM(COALESCE(r.cost_usd, t.cost_usd, x.cost_usd / (SELECT COUNT(*) FROM automation_runs y WHERE y.agent_run_id = r.agent_run_id), 0)), 0)
  FROM automation_runs r
    LEFT JOIN tasks t ON t.id = r.task_id AND t.task_type = 'routine'
    LEFT JOIN runs x ON x.id = r.agent_run_id`;

/**
 * What an automation's runs today (in `tz`) have cost: those that have ended as they recorded it, and those whose thread
 * (or for a thread-mode routine, the assistant's run that took its message) is still working, as far as they've got.
 */
export function spent_today(c: Conn, automation_id: string, now: number, tz: Tz): number {
  return Number(db.value(c, `SELECT ${COST} WHERE r.automation_id = ?1 AND r.created_at >= ?2`, automation_id, fmt(day_start(now, tz))) ?? 0);
}

/** What all of an automation's runs kept have cost. */
export function spent(c: Conn, automation_id: string): number {
  return Number(db.value(c, `SELECT ${COST} WHERE r.automation_id = ?1`, automation_id) ?? 0);
}

/** A routine's thread from an earlier run that's still working, or waiting for its usage limit to reset, if any: another run waits for it. */
export function still_running(c: Conn, a: Automation): Task | null {
  if (!(a.action.kind === "message_assistant" && a.action.mode === "fresh")) return null;
  const id = db.value<string>(
    c,
    `SELECT t.id FROM automation_runs r JOIN tasks t ON t.id = r.task_id
         WHERE r.automation_id = ?1 AND t.task_type = 'routine' AND (t.running = 1 OR t.waiting = 1) ORDER BY r.created_at DESC LIMIT 1`,
    a.id,
  );
  return id == null ? null : db.get_task(c, id);
}

/** Where a precheck runs: the assistant's workspace for a routine, the project's folder for a project's automation. */
function precheck_dir(s: Shared, a: Automation): string {
  const fail = (e: string): Outcome => ({ err: [null, `couldn't run its precheck: ${e}`] });
  if (a.project_id !== null) {
    let p;
    try {
      p = db.get_project(s.db(), a.project_id);
    } catch (e) {
      throw fail(err_str(e));
    }
    if (!p) throw fail("the project is gone");
    return expand_tilde(p.repo_path);
  }
  // Only its own workspace: not one that's become a symlink, which could be another's (as a run checks).
  let t: Task;
  try {
    t = assistant.get_or_create(s, a.profile_id);
  } catch (e) {
    throw fail(e instanceof ApiError ? e.message : err_str(e));
  }
  try {
    return memory.checked(s, t);
  } catch (e) {
    throw fail(`the assistant's workspace: ${err_str(e)}`);
  }
}

/**
 * Runs an automation's precheck (with bash, in `precheck_dir`, for up to `PRECHECK_LIMIT`): exit 0 goes on, with what it
 * printed for `{{precheck}}`; exit 1 skips the run; anything else fails it. Throws the Outcome that ends the run.
 */
export async function precheck(s: Shared, a: Automation, cmd: string): Promise<string> {
  const dir = precheck_dir(s, a);
  let out;
  try {
    out = await worktree.run_limited(cmd, dir, runs.agent_env(), PRECHECK_LIMIT);
  } catch (e) {
    throw { err: [null, `its precheck failed: ${err_str(e)}`] } satisfies Outcome;
  }
  const stdout = out.stdout.toString().trim();
  const stderr = out.stderr.toString().trim();
  const tail = (t: string) => truncate(t, 2000);
  if (out.code === 0) return cut(stdout, MAX_PRECHECK_CHARS);
  if (out.code === 1) {
    const t = [stdout, stderr].find((x) => x !== "");
    const said = t !== undefined ? `: ${tail(t)}` : "";
    throw { skipped: `Skipped: its precheck found nothing to do (exit 1)${said}` } satisfies Outcome;
  }
  const said = stderr === "" ? tail(stdout) : tail(stderr);
  const status = out.code !== null ? `exit status: ${out.code}` : `signal: ${out.signal}`;
  throw { err: [null, `its precheck failed (${status})${said === "" ? "" : `: ${said}`}`] } satisfies Outcome;
}

/** The run a routine thread is for. */
function run_of(c: Conn, task_id: string): Run | null {
  const r = db.one(c, "SELECT * FROM automation_runs WHERE task_id=?1 ORDER BY created_at DESC, rowid DESC LIMIT 1", task_id);
  return r ? Run_from_row(r) : null;
}

/**
 * A routine thread's agent stopped (see runner.output): its report goes to the assistant, unless it had nothing to say,
 * and its run records how it ended and what it cost.
 */
export function finished(s: Shared, thread: Task, outcome: runner.Outcome, attention: string | null): void {
  const assistant_id = thread.parent_id;
  if (!assistant_id) return;
  let run: Run | null;
  try {
    run = run_of(s.db(), thread.id);
  } catch (e) {
    console.error(`task ${thread.id}: finding a routine thread's run: ${err_str(e)}`);
    return;
  }
  let automation: Automation | null = null;
  try {
    automation = run ? get(s.db(), run.automation_id) : null;
  } catch {}
  const name = automation ? automation.name : thread.title.split(" · ")[0];
  let kind: string;
  let text: string | null;
  if (outcome === "Cancelled") [kind, text] = ["stopped", null];
  else if (typeof outcome === "object") [kind, text] = ["failed", outcome.Failed.split("\n")[0]];
  else if (attention !== null) [kind, text] = ["asked", attention];
  else {
    let said = "";
    try {
      said = history.said_since_asked(s.db(), thread.id) ?? "";
    } catch {}
    [kind, text] = is_quiet(said) ? ["quiet", null] : ["reported", cut(said.trim(), MAX_REPORT_CHARS)];
  }
  if (text !== null) {
    const data = {
      automation_id: automation ? automation.id : null,
      automation: name,
      task_id: thread.id,
      key: `${db.ASSISTANT_TASK_KEY}-${thread.number}`,
      outcome: kind,
      text,
    };
    try {
      s.add_message(assistant_id, "report", data);
    } catch (e) {
      console.error(`task ${thread.id}: posting a routine's report: ${err_str(e)}`);
    }
  }
  if (run) {
    let cost = thread.cost_usd;
    try {
      cost = db.get_task(s.db(), thread.id)?.cost_usd ?? thread.cost_usd;
    } catch {}
    try {
      db.run(s.db(), "UPDATE automation_runs SET outcome=?2, cost_usd=?3 WHERE id=?1", run.id, kind, cost);
    } catch {}
    if (automation) changed(s, automation);
  }
}

/**
 * The reports posted in the assistant's thread since it last read them, as a preface for its next prompt, and their
 * messages, to mark read (`mark_read`) once that prompt has gone to its agent; none if there are none.
 */
export function unread_reports(s: Shared, assistant_id: string): [string, number[]] | null {
  let reports: db.Message[];
  try {
    reports = history.unread_reports(s.db(), assistant_id);
  } catch {
    return null;
  }
  if (!reports.length) return null;
  let text = "Since your last turn, your routines posted these in this thread (the user has seen them):\n";
  for (const m of reports) {
    const d = m.data ?? {};
    const t = parse_time(m.created_at);
    const at = t !== null ? day_time_text(t) : "";
    const what = d.outcome === "failed" ? "failed" : d.outcome === "asked" ? "is waiting for the user" : "reported";
    const str = (v: any, def: string) => (typeof v === "string" ? v : def);
    text += `\n### "${str(d.automation, "A routine")}" ${what} (${str(d.key, "")}, ${at})\n\n${str(d.text, "").trim()}\n`;
  }
  text += "\n---\n\n";
  return [text, reports.map((m) => m.id)];
}

/** The assistant's agent has started with these reports (see `unread_reports`): they're read. */
export function mark_read(s: Shared, task_id: string, ids: number[]): void {
  for (const id of ids) {
    try {
      // Its row, or for a thread whose items are its source, its notice's record of it (see db.get_message).
      const m = db.get_message(s.db(), id, task_id);
      const v = m?.data;
      if (m?.kind !== "report" || v === null || typeof v !== "object" || Array.isArray(v)) continue;
      v.read = true;
      db.update_message_data(s.db(), id, v, task_id);
    } catch {}
  }
}

/**
 * Deletes routine threads that finished more than KEEP_THREAD_DAYS ago (their runs and reports stay; the assistant's
 * workspace, which they worked in, is the assistant's).
 */
export async function prune_threads(s: Shared, now: number): Promise<void> {
  const cutoff = fmt(now - days(KEEP_THREAD_DAYS));
  let old: Task[];
  try {
    old = db.old_routine_tasks(s.db(), cutoff);
  } catch (e) {
    console.error(`finding old routine threads: ${err_str(e)}`);
    return;
  }
  for (const t of old) {
    try {
      await api.delete_one(s, t, false);
    } catch (e) {
      console.warn(`task ${t.id}: pruning an old routine thread: ${e instanceof ApiError ? e.message : err_str(e)}`);
    }
  }
}
