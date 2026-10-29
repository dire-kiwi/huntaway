import assert from "node:assert/strict";
import { test } from "node:test";
import { fromLocalInput, isDue, nextDue, reminderLabel, reminderPresets, reminderTasks, starredTasks, toLocalInput } from "../src/reminders.ts";

const task = (id, fields = {}) => ({ id, kind: "task", project_id: "a", number: 1, ...fields });

test("lists starred tasks by project in sidebar order, then by number, without review threads", () => {
  const tasks = [
    task("1", { starred: true, project_id: "b", number: 1 }),
    task("2", { starred: true, project_id: "a", number: 7 }),
    task("3", { starred: true, project_id: "a", number: 2 }),
    task("4", { starred: false }),
    task("5", { starred: true, kind: "review" }),
    task("6", { starred: true, project_id: null, number: 1 }),
  ];
  assert.deepEqual(starredTasks(tasks, ["a", "b"]).map((t) => t.id), ["3", "2", "1", "6"]);
});

test("lists reminders soonest first, and tells which are due", () => {
  const tasks = [
    task("late", { remind_at: "2026-10-27T09:00:00.000Z" }),
    task("none", { remind_at: null }),
    task("soon", { remind_at: "2026-10-26T09:00:00.000Z" }),
  ];
  assert.deepEqual(reminderTasks(tasks).map((t) => t.id), ["soon", "late"]);
  const now = Date.parse("2026-10-26T12:00:00.000Z");
  assert.deepEqual(tasks.map((t) => isDue(t, now)), [false, false, true]);
  // The next one to come round, for the sidebar to look again then.
  assert.equal(nextDue(tasks, now), 21 * 3600_000);
  assert.equal(nextDue([tasks[2]], now), null);
});

test("labels reminders briefly", () => {
  const now = new Date(2026, 9, 26, 10, 0).getTime();
  const at = (ms) => new Date(now + ms).toISOString();
  assert.equal(reminderLabel(at(0), now), "due");
  assert.equal(reminderLabel(at(-86400_000), now), "due");
  assert.equal(reminderLabel(at(20_000), now), "in 1m");
  assert.equal(reminderLabel(at(25 * 60_000), now), "in 25m");
  // Not "in 60m" just under the hour.
  assert.equal(reminderLabel(at(3600_000 - 500), now), "in 1h");
  assert.equal(reminderLabel(at(5 * 3600_000), now), "in 5h");
  // A Monday; then the Wednesday.
  assert.equal(reminderLabel(new Date(2026, 9, 28, 9, 5).toISOString(), now), "Wed 09:05");
  assert.equal(reminderLabel(new Date(2026, 10, 12, 9, 0).toISOString(), now), "12 Nov");
});

test("offers the next hours, tomorrow morning and next Monday", () => {
  const local = (d) => [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes()].join(" ");
  // A Monday afternoon: next Monday is a week on.
  const monday = new Date(2026, 9, 26, 15, 30);
  assert.deepEqual(reminderPresets(monday).map((p) => local(p.at)), ["2026 10 26 16 30", "2026 10 26 18 30", "2026 10 27 9 0", "2026 11 2 9 0"]);
  // From a Sunday it's the next day.
  assert.equal(local(reminderPresets(new Date(2026, 10, 1, 20, 0))[3].at), "2026 11 2 9 0");
});

test("reads and writes datetime-local values in local time", () => {
  const d = new Date(2026, 0, 2, 3, 4);
  assert.equal(toLocalInput(d), "2026-01-02T03:04");
  assert.equal(fromLocalInput("2026-01-02T03:04"), d.toISOString());
  assert.equal(fromLocalInput(""), null);
  assert.equal(fromLocalInput("nope"), null);
});
