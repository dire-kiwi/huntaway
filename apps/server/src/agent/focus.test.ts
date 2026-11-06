// Port of the tests in server/src/agent/focus.rs.
import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import * as db from "../db.ts";
import type { Task } from "../db.ts";
import type { Shared } from "../state.ts";
import * as testing from "../testing.ts";
import { DEFAULT_EXPIRY_HOURS, EXPIRY_SETTING, expire, expiry_hours, put_in_now } from "./focus.ts";

function task(s: Shared): Task {
  const c = s.db();
  const p = db.list_profiles(c)[0] ?? db.insert_profile(c, "p", [], null);
  return db.insert_task(c, {
    profile_id: p.id,
    project_id: null,
    kind: "task",
    title: "t",
    description: "",
    status: "in_progress",
    use_worktree: false,
    model: null,
    effort: null,
    claude_config_id: null,
  });
}

const ago = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();

/** Puts the task in "now" and makes its last activity `now_hours_ago` and `activity_hours_ago` hours old. */
function aged(s: Shared, t: Task, now_hours_ago: number, activity_hours_ago: number) {
  db.run(s.db(), "UPDATE tasks SET now_at=?1, last_activity_at=?2 WHERE id=?3", ago(now_hours_ago), ago(activity_hours_ago), t.id);
}

const now_at = (s: Shared, t: Task) => db.get_task(s.db(), t.id)!.now_at ?? null;

test("tasks_are_in_later_until_put_in_now", () => {
  const s = testing.state();
  const t = task(s);
  assert.equal(t.now_at ?? null, null);
  assert.notEqual(put_in_now(s, t.id)!.now_at ?? null, null);
});

test("a_task_with_no_activity_for_a_day_goes_back_to_later", () => {
  const s = testing.state();
  const [idle, busy, fresh, later] = [task(s), task(s), task(s), task(s)];
  aged(s, idle, 30, 30);
  // Put in now long ago, but something happened on its thread since.
  aged(s, busy, 30, 2);
  // Prompted a moment ago: put in now again, though its thread is old.
  aged(s, fresh, 1, 30);
  assert.equal(expire(s), 1);
  assert.equal(now_at(s, idle), null);
  assert.notEqual(now_at(s, busy), null);
  assert.notEqual(now_at(s, fresh), null);
  assert.equal(now_at(s, later), null);
});

test("a_task_whose_agent_is_running_stays_in_now", () => {
  const s = testing.state();
  const t = task(s);
  aged(s, t, 30, 30);
  db.run(s.db(), "UPDATE tasks SET running=1 WHERE id=?1", t.id);
  assert.equal(expire(s), 0);
  assert.notEqual(now_at(s, t), null);
});

test("the_setting_changes_how_long_a_task_stays_in_now", () => {
  const s = testing.state();
  const t = task(s);
  aged(s, t, 30, 30);
  db.set_setting(s.db(), EXPIRY_SETTING, "48");
  assert.equal(expire(s), 0);
  db.set_setting(s.db(), EXPIRY_SETTING, "12");
  assert.equal(expire(s), 1);
  assert.equal(now_at(s, t), null);
});

test("zero_hours_keeps_tasks_in_now", () => {
  const s = testing.state();
  const t = task(s);
  aged(s, t, 24 * 100, 24 * 100);
  db.set_setting(s.db(), EXPIRY_SETTING, "0");
  assert.equal(expire(s), 0);
  assert.notEqual(now_at(s, t), null);
});

test("a_setting_that_is_not_a_number_is_the_default", () => {
  const s = testing.state();
  assert.equal(expiry_hours(s.db()), DEFAULT_EXPIRY_HOURS);
  db.set_setting(s.db(), EXPIRY_SETTING, "soon");
  assert.equal(expiry_hours(s.db()), DEFAULT_EXPIRY_HOURS);
  db.set_setting(s.db(), EXPIRY_SETTING, "6");
  assert.equal(expiry_hours(s.db()), 6);
});
