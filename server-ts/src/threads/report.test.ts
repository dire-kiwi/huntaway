// HA-128's report.rs tests, ported, and what `--write` adds.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as db from "../db.ts";
import * as testing from "../testing.ts";
import * as store from "./store.ts";
import { open, run, summary, task_report } from "./report.ts";

/** A board database file with one task (key T-1's id) whose thread has a call with no result and an open question. */
function board(dir: string): { path: string; task: string } {
  const path = join(dir, "board.db");
  const c = db.open(path);
  const profile = db.insert_profile(c, "p", [], null);
  const task = db.insert_task(c, {
    profile_id: profile.id,
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
  db.insert_message(c, task.id, "user", { text: "hi" });
  db.insert_message(c, task.id, "claude", { type: "assistant", message: { content: [{ type: "tool_use", id: "x", name: "Bash", input: {} }] } });
  db.insert_message(c, task.id, "question", { question: "Which?", status: "pending" });
  c.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  c.close();
  return { path, task: task.id };
}

test("reports_what_stops_a_switch_over", () => {
  const dir = testing.temp_dir();
  const { path, task } = board(dir);
  const report = () => {
    const c = open(path);
    try {
      return task_report(c, db.get_task(c, task)!, "T-1").report;
    } finally {
      c.close();
    }
  };
  let r = report();
  assert.deepEqual(r.blockers, ["open_prompt"]);
  assert.deepEqual([r.messages, r.harness, r.items.tool_call, r.requests], [3, "claude", 1, 1]);
  assert.deepEqual(r.rows, { converted: 3, redundant: 0, retained: 0 });
  assert.deepEqual(r.warnings.map((w) => w.code), ["no_result", "open_prompt"]);
  assert.ok(r.event_bytes > 0 && r.item_bytes > 0);
  const c = db.open(path);
  db.queue(c, task, db.Queued_new("next", false));
  db.run(c, "UPDATE tasks SET running=1 WHERE id=?1", task);
  db.insert_run(c, task, "prompt");
  c.close();
  r = report();
  assert.deepEqual(r.blockers, ["running", "active_run", "queued_input", "open_prompt"]);
  const text = summary([r], 1, 2);
  assert.ok(text.startsWith("1 tasks, 3 messages"), text);
  assert.ok(text.includes("  open_prompt: 1 (T-1)"), text);
  assert.ok(text.includes("  no_result: 1 in 1 tasks\n    T-1: 1 tool calls have no result"), text);
});

test("reads_only_a_database_at_its_version", () => {
  const dir = testing.temp_dir();
  const old = join(dir, "old.db");
  const o = new DatabaseSync(old);
  o.exec("PRAGMA user_version=3;");
  o.close();
  assert.throws(() => open(old), /at database version 3/);
  const { path } = board(dir);
  const c = open(path);
  assert.throws(() => c.exec("CREATE TABLE x (y)"));
  c.close();
  // A data dir is its database file.
  assert.throws(() => open(dir), /no database/);
});

test("a_dry_run_changes_nothing_and_writes_the_threads_to_a_file_of_their_own", () => {
  const dir = testing.temp_dir();
  const { path, task } = board(dir);
  const before = readFileSync(path);
  let printed = "";
  const out = join(dir, "threads.db");
  const reports = run({ db: path, json: true, tasks: [], examples: 3, write: out }, (s) => (printed += s));
  assert.deepEqual(readFileSync(path), before, "the source is as it was");
  const json = JSON.parse(printed);
  assert.equal(json.tasks.length, 1);
  assert.equal(json.tasks[0].error, null);
  assert.ok(json.written.bytes > 0);
  const c = db.open(out);
  assert.deepEqual(store.items(c, task).map((i) => i.type), ["user_message", "tool_call"]);
  assert.equal(store.requests(c, task)[0]!.resolution?.outcome, "cancel");
  assert.equal(store.last_seq(c, task), reports[0]!.events);
  // Its origins are the messages, and the finished call's update has none.
  assert.deepEqual(store.item_origins(c, task, "x"), [2]);
  c.close();
  // It doesn't write over a file.
  assert.throws(() => run({ db: path, json: true, tasks: [], examples: 3, write: out }, () => {}), /there already/);
  // One task, by its key or id.
  printed = "";
  run({ db: path, json: false, tasks: [task], examples: 3, write: null }, (s) => (printed += s));
  assert.ok(printed.startsWith("1 tasks"), printed);
  assert.throws(() => run({ db: path, json: false, tasks: ["NOPE-1"], examples: 3, write: null }, () => {}), /no task NOPE-1/);
});
