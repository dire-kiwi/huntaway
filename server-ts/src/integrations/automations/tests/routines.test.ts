// Port of server/src/integrations/automations/tests/routines.rs (HA-122 and HA-161, on the HA-117 branch).
// Routines: a profile's automations that wake its assistant, and what's new for every automation (cron and at triggers,
// active hours, prechecks and budgets).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as db from "../../../db.ts";
import type { Project, Task } from "../../../db.ts";
import * as api from "../../../api.ts";
import type { Req } from "../../../http.ts";
import type { Shared } from "../../../state.ts";
import * as testing from "../../../testing.ts";
import * as approval_rules from "../../../agent/approval_rules.ts";
import * as assistant from "../../../agent/assistant.ts";
import * as memory from "../../../agent/assistant/memory.ts";
import * as documents from "../../../agent/documents.ts";
import * as runner from "../../../agent/runner.ts";
import {
  KEEP_RUNS,
  Local,
  Run_new,
  check_active_hours,
  check_trigger,
  create,
  create_routine,
  fmt,
  from_local,
  get,
  get_run,
  hook_path,
  insert_run,
  is_routine,
  list,
  list_routines,
  list_routines_handler,
  local_parts,
  next_after,
  next_run,
  parse_at,
  parse_time,
  prune,
  routines,
  run_handler,
  runs,
  start_due,
  tick,
  to_local,
  update_handler,
  ActiveHours_contains,
  type ActiveHours,
  type Automation,
  type Run,
  type Trigger,
  type Tz,
} from "../../automations.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** New Zealand's daylight saving (as in tests.test.ts): +13 from 2026-09-27 02:00 until 2027-04-04 03:00, else +12. */
const Nz: Tz = {
  offset(utc) {
    const start = Date.UTC(2026, 8, 26, 14), end = Date.UTC(2027, 3, 3, 14);
    return (utc >= start && utc < end ? 13 : 12) * 3600;
  },
};

const utc = (s: string): number => parse_time(s)!;

function nz(s: string): number {
  const [d, t] = s.split(" ");
  const [y, mo, da] = d.split("-").map(Number);
  const [h, mi] = t.split(":").map(Number);
  return from_local(Nz, Date.UTC(y, mo - 1, da, h, mi))!;
}

function profile(s: Shared): db.Profile {
  return db.insert_profile(s.db(), "personal", [], null);
}

function setup(): [Shared, Project] {
  const s = testing.state();
  s.local_router = api.router(s);
  const p = db.insert_profile(s.db(), "work", [], null);
  const project = db.insert_project(s.db(), {
    id: "web", profile_id: p.id, name: "Web", key: "WEB", repo_path: "/src/web", scratch_path: "/s", worktrees_root: "/w", base_branch: null, use_worktrees: false,
  });
  return [s, project];
}

function routine(s: Shared, profile_id: string, v: any): Automation {
  return create_routine(s, profile_id, v);
}

const cron = (expr: string): Trigger => ({ kind: "cron", expr });

/** Makes `task_id` look as if its agent were running, so a message sent to it is queued. */
function busy(s: Shared, task_id: string) {
  s.runs.set(task_id, { run_id: "none", cancel: null });
}

function last_run(s: Shared, a: Automation): Run {
  return runs(s.db(), a.id, 1)[0];
}

function statuses(s: Shared, a: Automation): string[] {
  return runs(s.db(), a.id, 100).reverse().map((r) => r.status);
}

function set_next(s: Shared, a: Automation, at: number) {
  db.run(s.db(), "UPDATE automations SET next_run_at=?2 WHERE id=?1", a.id, fmt(at));
}

/** The agent's reply in a thread, as Claude Code (and Codex, as the board records it) writes it. */
function said(s: Shared, task_id: string, text: string) {
  db.insert_message(s.db(), task_id, "user", { text: "go" });
  db.insert_message(s.db(), task_id, "claude", { type: "assistant", message: { content: [{ type: "text", text }] } });
}

function reports(s: Shared, task_id: string): any[] {
  return db.list_messages(s.db(), task_id).filter((m) => m.kind === "report").map((m) => m.data);
}

function req(params: Record<string, string>, body: any = {}): Req {
  return { params, query: {}, body, headers: {}, raw: Buffer.from(JSON.stringify(body)) } as any;
}

const run_now = async (s: Shared, a: Automation) => await run_handler(s, req({ id: a.id }));
const update = async (s: Shared, a: Automation, b: any) => await update_handler(s, req({ id: a.id }, b));

/** A delivery through the board's API. */
async function deliver(s: Shared, path: string, body: string): Promise<[number, any]> {
  const raw = Buffer.from(body);
  const a = await api.dispatch(s, api.makeReq("POST", path, { "content-type": "application/json" }, raw));
  let v = null;
  try {
    v = JSON.parse(a.body.toString("utf8"));
  } catch {}
  return [a.status, v];
}

/** The run a delivery from outside was answered with (`running`, its action carrying on by itself), once it's over. */
async function ran(s: Shared, answer: any): Promise<Run> {
  assert.equal(answer?.status, "running", JSON.stringify(answer));
  for (let i = 0; i < 500; i++) {
    const r = get_run(s.db(), answer.run)!;
    if (r.status !== "running") return r;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`run ${answer.run} is still running`);
}

const count = (s: Shared, sql: string) => Number(db.value(s.db(), sql));

test("cron_expressions_follow_their_fields_and_daylight_saving", () => {
  const next = (e: string, after: number) => next_after(cron(e), after, Nz)!;
  // 2026-09-25 is a Friday.
  assert.equal(next("0 8 * * mon-fri", nz("2026-09-25 08:00")), nz("2026-09-28 08:00"));
  assert.equal(next("*/15 9-17 * * *", nz("2026-09-25 17:50")), nz("2026-09-26 09:00"));
  assert.equal(next("*/15 9-17 * * *", nz("2026-09-25 10:01")), nz("2026-09-25 10:15"));
  assert.equal(next("30 7 1 * *", nz("2026-09-25 00:00")), nz("2026-10-01 07:30"));
  assert.equal(next("0 12 * jan,jul *", nz("2026-09-25 00:00")), nz("2027-01-01 12:00"));
  // Both day fields restricted: either one will do, as in Vixie cron.
  assert.equal(next("0 9 13 * fri", nz("2026-09-25 10:00")), nz("2026-10-02 09:00"));
  assert.equal(next("0 9 1 * fri", nz("2026-09-26 10:00")), nz("2026-10-01 09:00"));
  // Sunday is 0 or 7, and @daily is midnight.
  assert.equal(next("0 10 * * 7", nz("2026-09-25 00:00")), next("0 10 * * sun", nz("2026-09-25 00:00")));
  assert.equal(next("@daily", nz("2026-09-25 13:00")), nz("2026-09-26 00:00"));
  // 2:30 doesn't exist on 2026-09-27 (the clocks go forward): it runs at 3:00, once.
  assert.equal(next("30 2 * * *", nz("2026-09-26 03:00")), nz("2026-09-27 03:00"));
  assert.equal(next("30 2 * * *", nz("2026-09-27 03:00")), nz("2026-09-28 02:30"));
  // 2:30 happens twice on 2027-04-04: the first, and not the second.
  const first = next("30 2 * * *", nz("2027-04-04 01:00"));
  assert.equal(first, utc("2027-04-03T13:30:00Z"));
  assert.equal(next("30 2 * * *", first), utc("2027-04-04T14:30:00Z"));
  // A 29 February comes round.
  assert.equal(next("0 0 29 2 *", nz("2026-09-25 00:00")), nz("2028-02-29 00:00"));

  for (const bad of ["", "* * * *", "60 * * * *", "* 24 * * *", "0 0 0 * *", "0 0 * 13 *", "0 0 * * 8", "5-1 * * * *", "*/0 * * * *", "0 0 * * someday"]) {
    assert.throws(() => check_trigger(cron(bad)), Error, bad);
  }
  assert.throws(() => check_trigger(cron("0 0 30 2 *")), (e: any) => e.message.includes("never matches"));
  assert.deepEqual(check_trigger(cron("  0  8 * *   mon-fri ")), cron("0 8 * * mon-fri"));
});

test("active_hours_hold_back_a_schedule_until_they_start", () => {
  const hours = (start: string, end: string, days: string[]): ActiveHours => ({ start, end, weekdays: [...days] });
  const night = hours("22:00", "06:00", []);
  assert.ok(ActiveHours_contains(night, nz("2026-09-25 23:30"), Nz));
  assert.ok(ActiveHours_contains(night, nz("2026-09-26 05:59"), Nz));
  assert.ok(!ActiveHours_contains(night, nz("2026-09-26 06:00"), Nz));
  assert.ok(!ActiveHours_contains(night, nz("2026-09-25 12:00"), Nz));
  // Past midnight belongs to the day the hours started: Friday night's run into Saturday.
  const friday_night = hours("22:00", "02:00", ["fri"]);
  assert.ok(ActiveHours_contains(friday_night, nz("2026-09-26 01:00"), Nz));
  assert.ok(!ActiveHours_contains(friday_night, nz("2026-09-27 01:00"), Nz));

  const day = hours("08:00", "18:00", ["mon", "tue", "wed", "thu", "fri"]);
  const every: Trigger = { kind: "interval", every_minutes: 30 };
  // An interval outside them starts again when they do: Friday evening waits for Monday.
  assert.equal(next_run(every, day, nz("2026-09-25 17:45"), Nz), nz("2026-09-28 08:00"));
  assert.equal(next_run(every, day, nz("2026-09-25 10:00"), Nz), nz("2026-09-25 10:30"));
  // A cron expression waits for its next time in them.
  assert.equal(next_run(cron("15 * * * *"), day, nz("2026-09-25 17:20"), Nz), nz("2026-09-28 08:15"));
  // An at keeps its time.
  const at: Trigger = { kind: "at", at: fmt(nz("2026-09-26 03:00")) };
  assert.equal(next_run(at, day, nz("2026-09-25 17:20"), Nz), nz("2026-09-26 03:00"));

  assert.throws(() => check_active_hours({ start: "08:00", end: "08:00" }));
  assert.throws(() => check_active_hours({ start: "8", end: "18:00" }));
  assert.deepEqual(check_active_hours({ start: "8:00", end: "18:00", weekdays: ["fri", "mon"] }), hours("08:00", "18:00", ["mon", "fri"]));
  assert.equal(check_active_hours(null), null);
});

/** `%Y-%m-%d %H:%M` of `t` in the host's time zone. */
function local_minute(t: number): string {
  const l = local_parts(to_local(Local, t));
  const p = (n: number) => String(n).padStart(2, "0");
  return `${l.y}-${p(l.mo)}-${p(l.d)} ${p(l.h)}:${p(l.mi)}`;
}

test("an_at_runs_once_however_late_then_turns_itself_off", async () => {
  const s = testing.state();
  const p = profile(s);
  const the_assistant = assistant.get_or_create(s, p.id);
  busy(s, the_assistant.id);
  // In the past, it can't be set.
  const past = { name: "Late", trigger: { kind: "at", at: "2020-01-01 09:00" }, action: { kind: "message_assistant", message: "x" } };
  assert.throws(() => routine(s, p.id, past), (e: any) => e.message.includes("passed"));
  const at = local_minute(Date.now() + HOUR);
  let a = routine(s, p.id, {
    name: "Remind me",
    trigger: { kind: "at", at },
    action: { kind: "message_assistant", mode: "thread", message: "Remind them to call Sam." },
  });
  // Stored in UTC, and due then.
  const due = parse_time(a.next_run_at)!;
  assert.equal(due, parse_at(at, Local));
  assert.ok(a.trigger.kind === "at" && parse_time(a.trigger.at) === due);
  // Hours late (the server was down), it still runs, once.
  await tick(s, due + 3 * HOUR);
  await tick(s, due + 4 * HOUR);
  a = get(s.db(), a.id)!;
  assert.deepEqual([a.enabled, a.next_run_at], [false, null]);
  const r = runs(s.db(), a.id, 10);
  assert.equal(r.length, 1);
  assert.deepEqual([r[0].status, r[0].task_id], ["ok", the_assistant.id]);
  const queued = db.get_task(s.db(), the_assistant.id)!.queued_message!;
  assert.ok(queued.startsWith('From your routine "Remind me", on its schedule:\n\nRemind them to call Sam.'), queued);
  // Turned on again with its time gone, it says so.
  db.run(s.db(), "UPDATE automations SET trigger=?2 WHERE id=?1", a.id, JSON.stringify({ kind: "at", at: fmt(Date.now() - MINUTE) }));
  await assert.rejects(update(s, a, { enabled: true }), (e: any) => e.message.includes("passed"));
});

test("a_routine_belongs_to_a_profile_and_only_messages_its_assistant", async () => {
  const [s, project] = setup();
  const p = db.get_profile(s.db(), project.profile_id)!;
  const msg = { kind: "message_assistant", message: "Check the mail" };
  // A routine can't make tasks, nor a project's automation wake the assistant.
  const task = { name: "x", trigger: { kind: "interval", every_minutes: 60 }, action: { kind: "create_task", title: "x" } };
  assert.throws(() => routine(s, p.id, task), (e: any) => e.message.includes("only message the assistant"));
  const wake = { name: "x", trigger: { kind: "interval", every_minutes: 60 }, action: msg };
  assert.throws(() => create(s, project.id, wake), (e: any) => e.message.includes("profile's routines"));
  const a = routine(s, p.id, wake);
  assert.deepEqual([a.project_id, a.profile_id, is_routine(a)], [null, p.id, true]);
  assert.deepEqual(a.action, { kind: "message_assistant", message: "Check the mail", mode: "fresh" });
  // Listed with the profile's routines, not the project's automations.
  assert.deepEqual(list_routines(s.db(), p.id).map((x) => x.id), [a.id]);
  assert.deepEqual(list(s.db(), project.id), []);
  const listed = await list_routines_handler(s, req({ id: p.id }));
  assert.equal(listed.automations[0].profile_id, p.id);
  assert.equal(listed.automations[0].cost_today_usd, 0);
  // Changing its action keeps to the same rule.
  await assert.rejects(update(s, a, { action: { kind: "create_task", title: "x" } }));
  // It goes with its profile.
  db.run(s.db(), "DELETE FROM profiles WHERE id=?1", p.id);
  assert.equal(get(s.db(), a.id), null);
});

test("a_fresh_run_works_in_a_thread_of_its_own_under_the_assistant", async () => {
  const s = testing.state();
  const p = profile(s);
  let the_assistant = assistant.get_or_create(s, p.id);
  db.run(s.db(), "UPDATE tasks SET model='opus', permission_mode='acceptEdits' WHERE id=?1", the_assistant.id);
  the_assistant = db.get_task(s.db(), the_assistant.id)!;
  const a = routine(s, p.id, { name: "Inbox", trigger: { kind: "cron", expr: "0 8 * * *" }, action: { kind: "message_assistant", message: "Anything new in the inbox?" } });
  // Tests can't start agents: here, a send would be refused. It's queued for the thread's (pretend) run.
  testing.when("routine:thread", () => {
    busy(s, db.value<string>(s.db(), "SELECT id FROM tasks WHERE task_type='routine' ORDER BY created_at DESC LIMIT 1")!);
  });
  const r = await run_now(s, a);
  assert.equal(r.status, "ok", JSON.stringify(r));
  const thread = db.get_task(s.db(), r.task_id)!;
  assert.ok(db.is_routine(thread) && db.is_assistants(thread) && !db.is_assistant(thread));
  assert.deepEqual([thread.parent_id, thread.project_id], [the_assistant.id, null]);
  // Keyed after the assistant, A-2, in its workspace, with its model and permission mode.
  assert.deepEqual([thread.number, r.task.key], [2, "A-2"]);
  assert.equal(thread.work_dir, the_assistant.work_dir);
  assert.equal(documents.work_dir(s, thread), documents.work_dir(s, the_assistant));
  assert.ok(!documents.documents_only(thread));
  assert.deepEqual([thread.model, thread.permission_mode, thread.claude_config_id], ["opus", "acceptEdits", the_assistant.claude_config_id]);
  assert.ok(thread.title.startsWith("Inbox · "), thread.title);
  // Its prompt is the routine's, with how to stay quiet.
  const text = thread.queued_message!;
  assert.ok(text.startsWith('This is a run of your routine "Inbox", by hand, from the board'), text);
  assert.ok(text.includes("Anything new in the inbox?") && text.includes("NO_REPLY"), text);
  // Off the board: not in the profile's tasks, nor its tasks in no project, even with the assistant.
  const ids = (ts: Task[]) => ts.map((t) => t.id);
  assert.ok(!ids(db.list_tasks_for_profile(s.db(), p.id, true)).includes(thread.id));
  assert.ok(!ids(db.list_group_tasks(s.db(), p.id, true)).includes(thread.id));
  assert.equal(db.assistant_task_by_number(s.db(), p.id, 2)?.id, thread.id);
});

test("a_quiet_run_posts_nothing_and_a_report_reaches_the_assistant_once", () => {
  const s = testing.state();
  const p = profile(s);
  const the_assistant = assistant.get_or_create(s, p.id);
  const a = routine(s, p.id, { name: "Inbox", trigger: { kind: "interval", every_minutes: 60 }, action: { kind: "message_assistant", message: "x" } });
  const thread = (n: string): [Task, string] => {
    const t = db.insert_routine_task(s.db(), the_assistant, n);
    const r = Run_new(a.id, "schedule", "ok", Date.now());
    r.task_id = t.id;
    insert_run(s.db(), r);
    db.run(s.db(), "UPDATE tasks SET cost_usd=0.25 WHERE id=?1", t.id);
    return [db.get_task(s.db(), t.id)!, r.id];
  };
  for (const quiet of ["NO_REPLY", "  `NO_REPLY`\n", "Checked: nothing new.\n\n**NO_REPLY**", ""]) {
    const [t, run] = thread("q");
    if (quiet !== "") said(s, t.id, quiet);
    routines.finished(s, t, "Ok", null);
    assert.deepEqual(reports(s, the_assistant.id), [], JSON.stringify(quiet));
    const r = get_run(s.db(), run)!;
    assert.deepEqual([r.outcome, r.cost_usd], ["quiet", 0.25], JSON.stringify(quiet));
  }
  let [t, run] = thread("r");
  said(s, t.id, "Two new mails from the bank; one needs a reply by Friday.");
  routines.finished(s, t, "Ok", null);
  const posted = reports(s, the_assistant.id);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].text, "Two new mails from the bank; one needs a reply by Friday.");
  assert.deepEqual([posted[0].automation, posted[0].key, posted[0].outcome], ["Inbox", `A-${t.number}`, "reported"]);
  assert.equal(get_run(s.db(), run)!.outcome, "reported");
  // A failure is posted too, so the user knows.
  [t] = thread("f");
  routines.finished(s, t, { Failed: "Out of usage\nmore" }, null);
  assert.equal(reports(s, the_assistant.id)[1].outcome, "failed");
  assert.equal(reports(s, the_assistant.id)[1].text, "Out of usage");
  // The assistant reads them with its next prompt, once.
  const [unread, ids] = routines.unread_reports(s, the_assistant.id)!;
  routines.mark_read(s, ids);
  assert.ok(unread.includes('"Inbox" reported') && unread.includes("Two new mails from the bank") && unread.includes('"Inbox" failed'), unread);
  assert.equal(routines.unread_reports(s, the_assistant.id), null);
});

test("a_routine_threads_run_ending_marks_it_done_and_reports", () => {
  const s = testing.state();
  const p = profile(s);
  const the_assistant = assistant.get_or_create(s, p.id);
  const t = db.insert_routine_task(s.db(), the_assistant, "Inbox");
  const run = db.insert_run(s.db(), t.id, "prompt");
  s.runs.set(t.id, { run_id: run.id, cancel: null });
  s.update_task(t.id, [["running", true], ["status", "in_progress"]]);
  said(s, t.id, "The deploy failed overnight.");
  runner.finish(s, run.id, "Ok");
  const after = db.get_task(s.db(), t.id)!;
  assert.deepEqual([after.status, after.running], ["done", false]);
  assert.equal(reports(s, the_assistant.id)[0].text, "The deploy failed overnight.");
});

test("a_precheck_skips_a_run_or_fills_in_what_it_found", async () => {
  const [s, p] = setup();
  const dir = testing.temp_dir();
  db.run(s.db(), "UPDATE projects SET repo_path=?2 WHERE id=?1", p.id, dir);
  writeFileSync(join(dir, "feed.txt"), "New: <b>release 2.0</b>");
  const t = api.create_task_inner(s, p.id, { title: "Watch" } as any);
  busy(s, t.id);
  const a = create(s, p.id, {
    name: "Feed",
    trigger: { kind: "interval", every_minutes: 60 },
    precheck: "test -s feed.txt || exit 1; cat feed.txt",
    action: { kind: "send_to_task", task_id: t.id, message: "Look: {{precheck}}" },
  });
  assert.equal(a.precheck, "test -s feed.txt || exit 1; cat feed.txt");
  set_next(s, a, Date.now() - 1000);
  await tick(s, Date.now());
  assert.equal(last_run(s, a).status, "ok");
  const q = db.get_task(s.db(), t.id)!.queued_message!;
  // It ran in the project's folder, and what it printed is data from outside.
  assert.ok(q.includes("Look: <untrusted-data>New: &lt;b&gt;release 2.0&lt;/b&gt;</untrusted-data>"), q);
  assert.ok(q.includes('**Note:** parts of this come from what the precheck command of the automation "Feed" printed'), q);

  // Exit 1: nothing new, so the run is skipped, and says what it printed.
  writeFileSync(join(dir, "feed.txt"), "");
  let r = await run_now(s, a);
  assert.equal(r.status, "skipped");
  assert.ok(r.detail.startsWith("Skipped: its precheck found nothing to do (exit 1)"), JSON.stringify(r));
  // Any other exit fails the run.
  await update(s, a, { precheck: "echo broken >&2; exit 3" });
  r = await run_now(s, a);
  assert.equal(r.status, "failed");
  assert.ok(r.detail.includes("broken"), JSON.stringify(r));
  // Blank clears it.
  assert.equal((await update(s, a, { precheck: "  " })).precheck, null);
});

test("a_routines_precheck_runs_in_the_assistants_workspace", async () => {
  const s = testing.state();
  const p = profile(s);
  const the_assistant = assistant.get_or_create(s, p.id);
  busy(s, the_assistant.id);
  const a = routine(s, p.id, {
    name: "Where",
    trigger: { kind: "interval", every_minutes: 60 },
    precheck: "pwd",
    action: { kind: "message_assistant", mode: "thread", message: "{{precheck}}" },
  });
  await run_now(s, a);
  const q = db.get_task(s.db(), the_assistant.id)!.queued_message!;
  const ws = realpathSync(documents.work_dir(s, the_assistant)!);
  assert.ok(q.includes(`<untrusted-data>${ws}</untrusted-data>`), q);
});

/** The start of today in the host's time zone. */
function routines_day_start(now: number): number {
  const l = local_parts(to_local(Local, now));
  return from_local(Local, Date.UTC(l.y, l.mo - 1, l.d))!;
}

test("a_routine_over_its_budget_today_is_skipped", async () => {
  const s = testing.state();
  const p = profile(s);
  const the_assistant = assistant.get_or_create(s, p.id);
  busy(s, the_assistant.id);
  const a = routine(s, p.id, {
    name: "Pricey",
    trigger: { kind: "interval", every_minutes: 60 },
    budget_usd: 1.0,
    action: { kind: "message_assistant", mode: "thread", message: "x" },
  });
  assert.equal(a.budget_usd, 1.0);
  const now = Date.now();
  // Yesterday's runs don't count; today's do, ended or still working.
  const old = Run_new(a.id, "schedule", "ok", routines_day_start(now) - MINUTE);
  old.cost_usd = 5.0;
  insert_run(s.db(), old);
  const ended = Run_new(a.id, "schedule", "ok", now);
  ended.cost_usd = 0.6;
  insert_run(s.db(), ended);
  assert.ok(Math.abs(routines.spent_today(s.db(), a.id, now, Local) - 0.6) < 1e-9);
  set_next(s, a, now - 1000);
  await tick(s, now);
  assert.equal(last_run(s, a).status, "ok");

  const working = db.insert_routine_task(s.db(), the_assistant, "w");
  db.run(s.db(), "UPDATE tasks SET cost_usd=0.5 WHERE id=?1", working.id);
  const w = Run_new(a.id, "schedule", "ok", now);
  w.task_id = working.id;
  insert_run(s.db(), w);
  set_next(s, a, now - 1000);
  await tick(s, now);
  const r = last_run(s, a);
  assert.equal(r.status, "skipped");
  assert.ok(r.detail!.startsWith("Skipped: over budget (its runs today cost $1.10, and its budget is $1.00 a day)"), r.detail!);
  // Run now isn't held to it.
  assert.equal((await run_now(s, a)).status, "ok");
});

test("deliveries_outside_active_hours_are_skipped_and_a_still_running_thread_holds_the_next_run", async () => {
  const s = testing.state();
  s.local_router = api.router(s);
  const p = profile(s);
  const the_assistant = assistant.get_or_create(s, p.id);
  // Hours that are never now: from an hour from now to two hours from now.
  const h = (d: number) => local_minute(Date.now() + d * HOUR).slice(11);
  const a = routine(s, p.id, {
    name: "Hook",
    trigger: { kind: "webhook" },
    active_hours: { start: h(1), end: h(2) },
    action: { kind: "message_assistant", message: "{{body.x}}" },
  });
  let [, v] = await deliver(s, hook_path(a), `{"x": 1}`);
  let r = await ran(s, v);
  assert.equal(r.status, "skipped");
  assert.ok(r.detail!.startsWith("Skipped: outside its active hours"), JSON.stringify(r));
  // In them, a fresh run makes a thread; while it's still working, the next is skipped.
  await update(s, a, { active_hours: null });
  const t = db.insert_routine_task(s.db(), the_assistant, "w");
  db.run(s.db(), "UPDATE tasks SET running=1 WHERE id=?1", t.id);
  const w = Run_new(a.id, "webhook", "ok", Date.now());
  w.task_id = t.id;
  insert_run(s.db(), w);
  [, v] = await deliver(s, hook_path(a), `{"x": 2}`);
  r = await ran(s, v);
  assert.equal(r.status, "skipped");
  assert.equal(r.detail, `Skipped: its last run (A-${t.number}) is still going`);
});

test("old_routine_threads_are_pruned_whatever_their_status_and_the_workspace_stays", async () => {
  const s = testing.state();
  const p = profile(s);
  const the_assistant = assistant.get_or_create(s, p.id);
  const ws = documents.work_dir(s, the_assistant)!;
  writeFileSync(join(ws, "MEMORY.md"), "remember");
  const thread = (status: string, reason: string | null) => {
    const t = db.insert_routine_task(s.db(), the_assistant, status);
    db.run(s.db(), "UPDATE tasks SET status=?2, attention_reason=?3 WHERE id=?1", t.id, status, reason);
    return t;
  };
  const done = thread("done", null);
  // A run that failed (out of usage, say), one stopped, and one that asked: all left in Needs attention.
  const failed = thread("needs_attention", "Run failed: boom");
  const stopped = thread("needs_attention", "Stopped by user");
  const asked = thread("needs_attention", "Which inbox?");
  const recent = thread("needs_attention", "Run failed: boom");
  const running = thread("in_progress", null);
  const waiting = thread("in_progress", null);
  const long_ago = fmt(Date.now() - (routines.KEEP_THREAD_DAYS + 1) * DAY);
  for (const t of [done, failed, stopped, asked, running, waiting]) db.run(s.db(), "UPDATE tasks SET last_activity_at=?2 WHERE id=?1", t.id, long_ago);
  db.run(s.db(), "UPDATE tasks SET running=1 WHERE id=?1", running.id);
  // Waiting for its usage limit to reset.
  db.run(s.db(), "UPDATE tasks SET waiting=1 WHERE id=?1", waiting.id);
  await routines.prune_threads(s, Date.now());
  const left = (t: Task) => db.get_task(s.db(), t.id) !== null;
  for (const t of [done, failed, stopped, asked]) assert.ok(!left(t), t.title);
  // Recent ones stay, as do ones still going or waiting.
  assert.ok(left(recent) && left(running) && left(waiting) && left(the_assistant));
  assert.equal(readFileSync(join(ws, "MEMORY.md"), "utf8"), "remember");
});

test("a_database_at_version_90_keeps_its_automations_and_runs", () => {
  const path = join(testing.temp_dir(), "huntaway.db");
  {
    const c = db.open(path);
    c.exec(`DROP TABLE automation_runs; DROP TABLE automations;
      CREATE TABLE automations (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1, trigger TEXT NOT NULL, action TEXT NOT NULL, token TEXT NOT NULL, secret TEXT,
        next_run_at TEXT, last_run_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE INDEX automations_project ON automations(project_id);
      CREATE TABLE automation_runs (
        id TEXT PRIMARY KEY, automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE, source TEXT NOT NULL,
        status TEXT NOT NULL, detail TEXT, task_id TEXT, delivery_id TEXT, event TEXT, count INTEGER NOT NULL DEFAULT 1,
        batch_key TEXT, batch_id TEXT, payload TEXT, due_at TEXT, created_at TEXT NOT NULL, finished_at TEXT);
      ALTER TABLE tasks DROP COLUMN queued_routine_runs; ALTER TABLE tasks DROP COLUMN queued_routine;
      PRAGMA user_version=90;
      INSERT INTO profiles (id,name,created_at) VALUES ('p','p','1');
      INSERT INTO projects (id,profile_id,name,key,repo_path,scratch_path,worktrees_root,created_at) VALUES ('pr','p','P','P','/x','/s','/w','1');
      INSERT INTO automations VALUES ('a1','pr','Nightly',1,'{"kind":"interval","every_minutes":60}','{"kind":"create_task","title":"x"}',
        'tok','sec','2026-01-01T00:00:00.000Z','2025-12-31T23:00:00.000Z','2025-01-01','2025-01-02');
      INSERT INTO automation_runs (id,automation_id,source,status,detail,task_id,count,payload,created_at,finished_at)
        VALUES ('r1','a1','schedule','ok','fine','t1',2,'{}','2025-12-31T23:00:00.000Z','2025-12-31T23:00:01.000Z');`);
    c.close();
  }
  const c = db.open(path);
  assert.equal(db.value(c, "PRAGMA user_version"), db.VERSION);
  const a = get(c, "a1")!;
  assert.deepEqual([a.profile_id, a.project_id, a.name, a.enabled], ["p", "pr", "Nightly", true]);
  assert.deepEqual([a.token, a.secret], ["tok", "sec"]);
  assert.deepEqual([a.next_run_at, a.last_run_at], ["2026-01-01T00:00:00.000Z", "2025-12-31T23:00:00.000Z"]);
  assert.deepEqual([a.created_at, a.updated_at], ["2025-01-01", "2025-01-02"]);
  assert.deepEqual([a.trigger, a.active_hours, a.precheck, a.budget_usd], [{ kind: "interval", every_minutes: 60 }, null, null, null]);
  const r = runs(c, "a1", 10);
  assert.equal(r.length, 1);
  assert.deepEqual([r[0].id, r[0].status, r[0].detail, r[0].task_id, r[0].count], ["r1", "ok", "fine", "t1", 2]);
  assert.deepEqual([r[0].outcome, r[0].cost_usd], [null, null]);
  // The tasks' queue columns came back.
  assert.equal(db.value(c, "SELECT COUNT(*) FROM pragma_table_info('tasks') WHERE name IN ('queued_routine_runs','queued_routine')"), 2);
  // Its project's no longer required, and the runs still go with their automation.
  db.run(c, "INSERT INTO automations (id,profile_id,name,trigger,action,token,created_at,updated_at) VALUES ('a2','p','R','{}','{}','t','1','1')");
  db.run(c, "DELETE FROM automations WHERE id='a1'");
  assert.deepEqual(runs(c, "a1", 10), []);
  assert.equal(db.value(c, "SELECT COUNT(*) FROM pragma_foreign_key_check"), 0);
  // Opened again, nothing changes (the migration's parts are each done once).
  c.close();
  const again = db.open(path);
  assert.equal(db.value(again, "SELECT COUNT(*) FROM automations"), 1);
  again.close();
});

test("a_fresh_run_that_cant_start_leaves_no_thread", async () => {
  const s = testing.state();
  const p = profile(s);
  const a = routine(s, p.id, { name: "Inbox", trigger: { kind: "interval", every_minutes: 60 }, action: { kind: "message_assistant", message: "x" } });
  // Tests can't run agents, as a host without them can't.
  const r = await run_now(s, a);
  assert.deepEqual([r.status, r.task_id], ["failed", null], JSON.stringify(r));
  assert.ok(r.detail.includes("can't run agents"), JSON.stringify(r));
  assert.equal(count(s, "SELECT COUNT(*) FROM tasks WHERE task_type='routine'"), 0);
});

test("deleting_the_assistant_stops_its_routine_threads_first", async () => {
  const s = testing.state();
  const p = profile(s);
  const the_assistant = assistant.get_or_create(s, p.id);
  const t = db.insert_routine_task(s.db(), the_assistant, "w");
  busy(s, t.id);
  await api.delete_task_inner(s, the_assistant, false);
  assert.equal(db.get_task(s.db(), t.id), null);
  // Its agent was stopped, not left running for a thread that's gone.
  assert.ok(!s.is_running(t.id));
});

test("an_assistant_run_that_took_several_routines_messages_splits_its_cost_between_them", () => {
  const s = testing.state();
  const p = profile(s);
  const the_assistant = assistant.get_or_create(s, p.id);
  const a = routine(s, p.id, { name: "Ping", trigger: { kind: "interval", every_minutes: 60 }, action: { kind: "message_assistant", mode: "thread", message: "p" } });
  const run = db.insert_run(s.db(), the_assistant.id, "prompt");
  const ids = [0, 1].map(() => {
    const r = Run_new(a.id, "schedule", "ok", Date.now());
    insert_run(s.db(), r);
    return r.id;
  });
  routines.taken_in(s.db(), run.id, ids);
  db.run(s.db(), "UPDATE runs SET cost_usd=3 WHERE id=?1", run.id);
  // While it works, and once it's ended.
  assert.ok(Math.abs(routines.spent(s.db(), a.id) - 3.0) < 1e-9);
  routines.agent_run_ended(s, run.id);
  for (const id of ids) assert.equal(get_run(s.db(), id)!.cost_usd, 1.5);
});

test("a_fresh_run_that_ends_before_its_send_returns_still_records_how_it_went", async () => {
  const s = testing.state();
  const p = profile(s);
  const a = routine(s, p.id, { name: "Fast", trigger: { kind: "interval", every_minutes: 60 }, action: { kind: "message_assistant", message: "x" } });
  // The thread's run ends before the send that started it has returned.
  testing.when("routine:thread", () => {
    const id = db.value<string>(s.db(), "SELECT id FROM tasks WHERE task_type='routine'")!;
    busy(s, id);
    said(s, id, "Done already.");
    routines.finished(s, db.get_task(s.db(), id)!, "Ok", null);
  });
  const r0 = await run_now(s, a);
  const r = get_run(s.db(), r0.id)!;
  assert.deepEqual([r.status, r.outcome], ["ok", "reported"]);
  const the_assistant = assistant.get_or_create(s, p.id);
  assert.equal(reports(s, the_assistant.id)[0].automation_id, a.id);
});

test("a_routine_thread_waiting_on_its_usage_limit_holds_back_the_next_run", async () => {
  const s = testing.state();
  const p = profile(s);
  const the_assistant = assistant.get_or_create(s, p.id);
  const a = routine(s, p.id, { name: "Inbox", trigger: { kind: "interval", every_minutes: 60 }, action: { kind: "message_assistant", message: "x" } });
  const t = db.insert_routine_task(s.db(), the_assistant, "w");
  db.run(s.db(), "UPDATE tasks SET waiting=1, running=0 WHERE id=?1", t.id);
  const w = Run_new(a.id, "schedule", "ok", Date.now());
  w.task_id = t.id;
  insert_run(s.db(), w);
  set_next(s, a, Date.now() - 1000);
  await tick(s, Date.now());
  const r = last_run(s, a);
  assert.deepEqual([r.status, r.detail], ["skipped", `Skipped: its last run (A-${t.number}) is still going`]);
});

test("no_routine_thread_is_made_under_an_assistant_being_deleted", async () => {
  const s = testing.state();
  const p = profile(s);
  const the_assistant = assistant.get_or_create(s, p.id);
  const a = routine(s, p.id, { name: "Inbox", trigger: { kind: "interval", every_minutes: 60 }, action: { kind: "message_assistant", message: "x" } });
  const deleting = api.Deleting_new(s, the_assistant.id);
  const r = await run_now(s, a);
  assert.equal(r.status, "failed");
  assert.ok(r.detail.includes("being deleted"), JSON.stringify(r));
  assert.equal(count(s, "SELECT COUNT(*) FROM tasks WHERE task_type='routine'"), 0);
  deleting.drop();
});

test("reports_stay_unread_until_the_assistant_has_started_with_them", () => {
  const s = testing.state();
  const p = profile(s);
  const the_assistant = assistant.get_or_create(s, p.id);
  s.add_message(the_assistant.id, "report", { automation: "Inbox", key: "A-2", outcome: "reported", text: "New mail." });
  // A launch that fails before the agent starts reads them again next time.
  const [text, ids] = routines.unread_reports(s, the_assistant.id)!;
  assert.ok(text.includes("New mail."));
  assert.deepEqual(routines.unread_reports(s, the_assistant.id)![1], ids);
  routines.mark_read(s, ids);
  assert.equal(routines.unread_reports(s, the_assistant.id), null);
});

test("a_day_field_that_starts_with_a_star_keeps_its_steps_and_must_match_too", () => {
  const next = (e: string, after: number) => next_after(cron(e), after, Nz)!;
  // Stepped days of the month: the 1st, 3rd, … 27th, 29th (2026-09-25 is a Friday).
  assert.equal(next("0 9 */2 * *", nz("2026-09-25 10:00")), nz("2026-09-27 09:00"));
  assert.equal(next("0 9 */2 * *", nz("2026-09-29 10:00")), nz("2026-10-01 09:00"));
  // Stepped weekdays: Sunday, Tuesday, Thursday and Saturday.
  assert.equal(next("0 9 * * */2", nz("2026-09-27 10:00")), nz("2026-09-29 09:00"));
  // With the other field restricted, a day has to match both: an odd day that's a Monday (2026-10-05).
  assert.equal(next("0 9 */2 * mon", nz("2026-09-25 10:00")), nz("2026-10-05 09:00"));
  // The 1st, on a Sunday, Tuesday, Thursday or Saturday: 2026-10-01 is a Thursday.
  assert.equal(next("0 9 1 * */2", nz("2026-09-25 10:00")), nz("2026-10-01 09:00"));
  // Two restricted fields: either will do, so the next Wednesday (2026-09-30) comes before the 1st.
  assert.equal(next("0 9 1 * wed", nz("2026-09-25 10:00")), nz("2026-09-30 09:00"));
  // But `*/31` (the 1st) starts with `*`: the 1st when it's a Wednesday, not until 2027-09-01.
  assert.equal(next("0 9 */31 * wed", nz("2026-09-25 10:00")), nz("2027-09-01 09:00"));
});

test("a_routine_thread_has_its_assistants_workspace_and_memory", async () => {
  const s = testing.state();
  const p = profile(s);
  const a = assistant.get_or_create(s, p.id);
  const t = db.insert_routine_task(s.db(), a, "Inbox");
  assert.equal(assistant.whose_workspace(t, a)?.id, a.id);
  assert.equal(assistant.whose_workspace(a, null)?.id, a.id);
  // So its run is told the assistant's memory, as the assistant's are.
  const told = await memory.for_run(s, assistant.whose_workspace(t, a)!);
  assert.ok(told.includes("## Your memory") && told.includes('<memory-file path="USER.md">'), told);
  // Without its assistant, or in another folder, it doesn't run.
  assert.throws(() => assistant.whose_workspace(t, null));
  assert.throws(() => assistant.whose_workspace({ ...t, work_dir: "elsewhere" }, a));
  assert.equal(assistant.whose_workspace({ ...t, task_type: null }, null), null);
});

// HA-122 review: a webhook sender that hangs up during a slow precheck dropped the handler's future, which killed the
// precheck and left the run `running` with nothing done. HA-161: and one that waited for it past its timeout (GitHub's
// is 10 seconds) counted the delivery as failed, though it ran: a delivery is answered as soon as its run is recorded.
test("a_delivery_is_answered_at_once_and_its_slow_precheck_carries_on", async () => {
  const s = testing.state();
  s.local_router = api.router(s);
  const p = profile(s);
  const the_assistant = assistant.get_or_create(s, p.id);
  busy(s, the_assistant.id);
  const a = routine(s, p.id, {
    name: "Hook",
    trigger: { kind: "webhook" },
    precheck: "sleep 1; echo found it",
    action: { kind: "message_assistant", mode: "thread", message: "{{precheck}}" },
  });
  const started = Date.now();
  const [status, v] = await deliver(s, hook_path(a), "{}");
  assert.ok(Date.now() - started < 500, "answered before its precheck is done");
  assert.deepEqual([status, v.status], [202, "running"], JSON.stringify(v));
  assert.equal(db.get_task(s.db(), the_assistant.id)!.queued_message, null);
  const r = await ran(s, v);
  assert.deepEqual([r.status, r.task_id], ["ok", the_assistant.id], r.detail ?? "");
  const queued = db.get_task(s.db(), the_assistant.id)!.queued_message!;
  assert.ok(queued.includes("found it"), queued);
});

// HA-161: the scheduler ran due automations one after another, so one's slow precheck held up every other's schedule.
test("a_slow_precheck_doesnt_hold_up_another_automations_run", async () => {
  const [s, p] = setup();
  const t = api.create_task_inner(s, p.id, { title: "Watch" } as any);
  busy(s, t.id);
  const dir = testing.temp_dir();
  db.run(s.db(), "UPDATE projects SET repo_path=?2 WHERE id=?1", p.id, dir);
  const every_hour = (name: string, precheck: string | null) =>
    create(s, p.id, { name, trigger: { kind: "interval", every_minutes: 60 }, precheck, action: { kind: "send_to_task", task_id: t.id, message: name } });
  const slow = every_hour("Slow", "sleep 2");
  const quick = every_hour("Quick", null);
  const now = Date.now();
  for (const a of [slow, quick]) set_next(s, a, now - 1000);
  const started = start_due(s, now, Local);
  assert.equal(started.length, 2);
  let r = last_run(s, quick);
  for (let i = 0; i < 100 && r.status === "running"; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    r = last_run(s, quick);
  }
  assert.equal(r.status, "ok", r.detail ?? "");
  assert.equal(last_run(s, slow).status, "running", "its precheck takes two seconds");
  // Due again before its run is over, it isn't started again: it waits, still due.
  set_next(s, slow, now);
  assert.equal(start_due(s, now + 1000, Local).length, 0);
  assert.equal(runs(s.db(), slow.id, 10).length, 1);
  await Promise.all(started);
  assert.equal(last_run(s, slow).status, "ok");
  // Once it's over, it runs.
  await tick(s, now + 1000);
  assert.deepEqual(statuses(s, slow), ["ok", "ok"]);
});

// HA-122 review: a precheck ran wherever the assistant's workspace pointed, through a symlink.
test("a_precheck_doesnt_run_through_a_workspace_thats_become_a_symlink", async () => {
  const s = testing.state();
  const p = profile(s);
  const the_assistant = assistant.get_or_create(s, p.id);
  const ws = documents.work_dir(s, the_assistant)!;
  const elsewhere = join(testing.temp_dir(), "elsewhere");
  mkdirSync(elsewhere, { recursive: true });
  rmSync(ws, { recursive: true });
  symlinkSync(elsewhere, ws);
  const a = routine(s, p.id, {
    name: "Probe",
    trigger: { kind: "interval", every_minutes: 60 },
    precheck: "printf proof > precheck-marker; exit 1",
    action: { kind: "message_assistant", message: "x" },
  });
  const r = await run_now(s, a);
  assert.equal(r.status, "failed", JSON.stringify(r));
  assert.ok(r.detail.includes("the assistant's workspace"), JSON.stringify(r));
  assert.ok(!existsSync(join(elsewhere, "precheck-marker")));
});

// HA-122 review: pruning kept only the latest 1000 runs, so a busy routine's skipped deliveries pushed out today's paid
// runs, and its budget was forgotten.
test("pruning_keeps_the_runs_that_count_toward_todays_budget", async () => {
  const s = testing.state();
  const p = profile(s);
  const the_assistant = assistant.get_or_create(s, p.id);
  busy(s, the_assistant.id);
  const a = routine(s, p.id, {
    name: "Busy",
    trigger: { kind: "interval", every_minutes: 60 },
    budget_usd: 1.0,
    action: { kind: "message_assistant", mode: "thread", message: "x" },
  });
  // Midday today, so its runs half an hour back are today's whenever it runs (HA-247: just after midnight they were
  // yesterday's). It's on the same day as the clock its tick's budget check reads.
  const now = routines_day_start(Date.now()) + 12 * HOUR;
  const at = (m: number) => now - m * MINUTE;
  // A paid run, then one whose agent is still at work (no cost recorded yet, but its thread's counts).
  const paid = Run_new(a.id, "schedule", "ok", at(30));
  paid.cost_usd = 2.0;
  paid.task_id = the_assistant.id;
  insert_run(s.db(), paid);
  const working = db.insert_routine_task(s.db(), the_assistant, "w");
  const going = Run_new(a.id, "schedule", "ok", at(29));
  going.task_id = working.id;
  insert_run(s.db(), going);
  // Then more than KEEP_RUNS deliveries skipped, today.
  db.tx(s.db(), () => {
    for (let i = 0; i < KEEP_RUNS + 5; i++) insert_run(s.db(), Run_new(a.id, "webhook", "skipped", at(28) + i));
  });
  prune(s.db(), now);
  assert.ok(get_run(s.db(), paid.id) !== null && get_run(s.db(), going.id) !== null);
  assert.ok(runs(s.db(), a.id, 5000).length <= KEEP_RUNS + 2);
  assert.ok(Math.abs(routines.spent_today(s.db(), a.id, now, Local) - 2.0) < 1e-9);
  set_next(s, a, now - 1000);
  await tick(s, now);
  assert.ok((last_run(s, a).detail ?? "").startsWith("Skipped: over budget"));
  // Two days on, they go as any other would.
  prune(s.db(), now + 3 * DAY);
  assert.equal(get_run(s.db(), paid.id), null);
});

test("a_routines_messages_start_routine_runs_whose_prompts_expire", async () => {
  const s = testing.state();
  const p = profile(s);
  const the_assistant = assistant.get_or_create(s, p.id);
  busy(s, the_assistant.id);
  testing.when("routine:thread", () => {
    busy(s, db.value<string>(s.db(), "SELECT id FROM tasks WHERE task_type='routine' ORDER BY created_at DESC LIMIT 1")!);
  });
  const wake = (mode: string) => ({ name: mode, trigger: { kind: "cron", expr: "0 8 * * *" }, action: { kind: "message_assistant", message: "Inbox?", mode } });
  // Fresh: its thread's first message (waiting here, as no agent can start) is a routine's; so is a thread-mode
  // routine's in the assistant's thread. The approval rules, and expiry, hold in both.
  for (const mode of ["fresh", "thread"]) {
    const a = routine(s, p.id, wake(mode));
    const r = await run_now(s, a);
    assert.ok(approval_rules.applies_to(s.db(), db.get_task(s.db(), r.task_id)!), mode);
    const queued = db.take_queued(s.db(), r.task_id)!;
    assert.ok(queued.routine, mode);
  }
});
