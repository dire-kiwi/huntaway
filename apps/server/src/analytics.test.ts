// Port of the tests in server/src/analytics.rs.
import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import * as db from "./db.ts";
import type { NewTask } from "./db.ts";
import * as testing from "./testing.ts";
import * as stats from "./review/stats.ts";
import { MERGE_PREFIX, START_TEXT, TEXT_LIMIT, classify, clip, report, token_report } from "./analytics.ts";

test("classifies_user_messages", () => {
  assert.equal(classify({ text: "fix the bug" }), "prompt");
  assert.equal(classify({ text: START_TEXT, auto: true }), "start");
  assert.equal(classify({ text: "Plan first.", auto: true, start: true }), "start");
  assert.equal(classify({ text: `${MERGE_PREFIX}. Merge branch \`x\``, auto: true }), "merge");
  assert.equal(classify({ text: "Address the review", auto: true }), null);
  assert.equal(classify({ text: "please rebase", from_agent: true }), null);
});

test("clips_long_prompts", () => {
  assert.equal(clip("short"), "short");
  assert.equal(Array.from(clip("é".repeat(TEXT_LIMIT + 5))).length, TEXT_LIMIT + 1);
});

test("reports_a_profiles_activity_in_range", () => {
  const c = new DatabaseSync(":memory:");
  c.exec(`CREATE TABLE projects (id TEXT, profile_id TEXT, name TEXT, key TEXT, created_at TEXT);
     CREATE TABLE tasks (id TEXT, profile_id TEXT, project_id TEXT, kind TEXT, number INTEGER, title TEXT,
       status TEXT, parent_id TEXT);
     CREATE TABLE messages (task_id TEXT, kind TEXT, data TEXT, created_at TEXT);
     CREATE TABLE runs (task_id TEXT, kind TEXT, created_at TEXT, ended_at TEXT);
     CREATE TABLE threads (task_id TEXT, converter INTEGER, error TEXT);
     CREATE TABLE thread_items (task_id TEXT, pos INTEGER, type TEXT, data TEXT, meta TEXT, created_at TEXT);
     INSERT INTO projects VALUES ('p1','me','Proj','PRJ','2026-01-01T00:00:00.000Z');
     INSERT INTO tasks VALUES ('t1','me','p1','task',1,'One','in_review',NULL),
       ('r1','me','p1','review',0,'Review','done','t1'),
       ('x1','other','p9','task',1,'Not mine','todo',NULL);
     ALTER TABLE tasks ADD COLUMN thread_items INTEGER NOT NULL DEFAULT 0;
     ALTER TABLE tasks ADD COLUMN thread_source TEXT NOT NULL DEFAULT 'messages';
     INSERT INTO messages VALUES
       ('t1','user','{"text":"Start working on this task.","auto":true}','2026-10-01T09:00:00.000Z'),
       ('t1','user','{"text":"looks good"}','2026-10-01T10:00:00.000Z'),
       ('t1','claude','{}','2026-10-01T10:00:01.000Z'),
       ('r1','user','{"text":"why?"}','2026-10-01T11:00:00.000Z'),
       ('t1','user','{"text":"too late"}','2026-10-02T00:00:00.000Z'),
       ('x1','user','{"text":"someone else"}','2026-10-01T10:00:00.000Z');
     INSERT INTO runs VALUES ('t1','prompt','2026-09-30T23:50:00.000Z','2026-10-01T00:10:00.000Z'),
       ('r1','review','2026-10-01T12:00:00.000Z',NULL),
       ('t1','prompt','2026-09-30T20:00:00.000Z','2026-09-30T21:00:00.000Z');`);
  const r = report(c, "me", "2026-10-01T00:00:00.000Z", "2026-10-02T00:00:00.000Z");
  assert.deepEqual(
    r.events.map((e) => [e.kind, e.task_id, e.text]),
    [
      ["start", "t1", ""],
      ["prompt", "t1", "looks good"],
      ["prompt", "t1", "why?"],
    ],
  );
  assert.deepEqual(
    r.runs.map((x) => [x.task_id, x.kind]),
    [
      ["t1", "prompt"],
      ["t1", "review"],
    ],
  );
  assert.equal(r.tasks.length, 1);
  assert.equal(r.projects.length, 1);
});

const new_task = (profile_id: string, kind: string): NewTask => ({
  profile_id, project_id: null, kind, title: "t", description: "", status: "in_review", use_worktree: false, model: null, effort: null, claude_config_id: null,
});

test("reports_tokens_reviews_and_follow_ups", () => {
  const s = testing.state();
  const c = s.db();
  const p = db.insert_profile(c, "p", [], null);
  const other = db.insert_profile(c, "o", [], null);
  const sub = db.insert_task(c, new_task(p.id, "task"));
  const child = db.insert_task(c, new_task(p.id, "task"));
  const thread = db.insert_task(c, new_task(p.id, "review"));
  const follow = db.insert_task(c, new_task(p.id, "task"));
  const theirs = db.insert_task(c, new_task(other.id, "task"));
  db.run(c, "UPDATE tasks SET subproject=1 WHERE id=?1", sub.id);
  db.run(c, "UPDATE tasks SET parent_id=?1 WHERE id=?2", sub.id, child.id);
  db.run(c, "UPDATE tasks SET parent_id=?1 WHERE id=?2", child.id, thread.id);
  db.run(c, "UPDATE tasks SET created_by=?1 WHERE id=?2", child.id, follow.id);
  const run = (task: string, at: string, model: string, out: number) => {
    const r = db.insert_run(c, task, "prompt");
    db.run(c, "UPDATE runs SET created_at=?1, status='exited', usage_at=?1 WHERE id=?2", at, r.id);
    db.run(c, "INSERT INTO token_usage (run_id, model, runtime, output_tokens, cost_usd) VALUES (?1, ?2, 'claude', ?3, 0.5)", r.id, model, out);
    return r.id;
  };
  run(child.id, "2026-10-01T01:00:00.000Z", "opus", 100);
  run(child.id, "2026-10-01T02:00:00.000Z", "haiku", 300);
  run(child.id, "2026-10-01T03:00:00.000Z", "opus", 250);
  const review_run = run(thread.id, "2026-10-01T04:00:00.000Z", "gpt", 50);
  run(child.id, "2026-09-01T00:00:00.000Z", "opus", 1);
  run(theirs.id, "2026-10-01T01:00:00.000Z", "opus", 1);
  // Ended, not counted yet.
  const r0 = db.insert_run(c, child.id, "prompt");
  db.run(c, "UPDATE runs SET created_at='2026-10-01T05:00:00.000Z', status='exited' WHERE id=?1", r0.id);
  stats.record(
    c,
    { task_id: child.id, thread_id: thread.id, round: null, run_id: review_run, verdict: "issues", serious: 2, minor: 1, summary: null, label: "Codex · gpt" },
    "2026-10-01T04:30:00.000Z",
  );

  const r = token_report(c, p.id, "2026-10-01T00:00:00.000Z", "2026-10-02T00:00:00.000Z");
  assert.equal(r.usage.length, 4);
  assert.equal(r.pending, 1);
  assert.equal(r.reviews.length, 1);
  assert.deepEqual([r.reviews[0].serious, r.reviews[0].minor, r.reviews[0].model], [2, 1, "gpt"]);
  const ids = r.tasks.map((t) => t.id);
  for (const t of [sub, child, thread, follow]) assert.ok(ids.includes(t.id), `${t.id} missing`);
  assert.ok(!ids.includes(theirs.id));
  assert.deepEqual(
    r.follow_ups.map((f) => [f.task_id, f.created_by]),
    [[follow.id, child.id]],
  );
  const task = (id: string) => r.tasks.find((t) => t.id === id)!;
  // The model it used most, its earlier runs' included.
  assert.equal(task(child.id).model, "opus");
  assert.equal(task(child.id).parent_id, sub.id);
  assert.ok(task(sub.id).subproject);
});

test("review_rounds_are_numbered_from_the_tasks_first_whatever_the_range", () => {
  const s = testing.state();
  const c = s.db();
  const p = db.insert_profile(c, "p", [], null);
  const task = db.insert_task(c, { ...new_task(p.id, "task") });
  const sub = (thread: string, round: string, at: string, verdict: string, serious: number) =>
    stats.record(c, { task_id: task.id, thread_id: thread, round, run_id: null, verdict, serious, minor: 0, summary: null, label: thread }, at);
  // Round 1, the day before: A found issues, B passed.
  sub("A", "2026-10-01T10:00:00.000Z", "2026-10-01T10:05:00.000Z", "issues", 2);
  sub("B", "2026-10-01T10:00:00.000Z", "2026-10-01T10:06:00.000Z", "pass", 0);
  // Round 2.
  sub("A", "2026-10-02T09:00:00.000Z", "2026-10-02T09:05:00.000Z", "pass", 0);
  sub("B", "2026-10-02T09:00:00.000Z", "2026-10-02T09:06:00.000Z", "issues", 1);
  // Round 3: a reviewer added since (another thread); A didn't submit.
  sub("C", "2026-10-02T12:00:00.000Z", "2026-10-02T12:05:00.000Z", "issues", 1);
  // Round 4, a minute after: C didn't submit, and B did. Rounds are kept apart however close they started.
  sub("B", "2026-10-02T12:01:00.000Z", "2026-10-02T12:03:00.000Z", "issues", 1);

  const r = token_report(c, p.id, "2026-10-02T00:00:00.000Z", "2026-10-03T00:00:00.000Z");
  assert.deepEqual(
    r.reviews.map((v) => [v.label, v.round]),
    [
      ["A", 2],
      ["B", 2],
      ["B", 4],
      ["C", 3],
    ],
  );
  assert.deepEqual(
    r.rounds.map((x) => [x.round, x.verdict, x.serious, x.reviewers]),
    [
      [1, "issues", 2, 2],
      [2, "issues", 1, 2],
      [3, "issues", 1, 1],
      [4, "issues", 1, 1],
    ],
  );
});
