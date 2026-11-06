// HA-198: a run that only wrote or revised its task's plan leaves the task in "Needs attention", waiting for the user.
import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as api from "../../api.ts";
import * as db from "../../db.ts";
import type { Run, Task } from "../../db.ts";
import type { AppState } from "../../state.ts";
import * as testing from "../../testing.ts";
import { path_str, sleep } from "../../util.ts";
import * as worktree from "../../git/worktree.ts";
import * as checkpoints from "../../git/checkpoints.ts";
import * as documents from "../documents.ts";
import { finish, load_active } from "../runner.ts";
import { PLAN_READY, settle, unsettled as plan_unsettled } from "./plan.ts";

function sh(dir: string, args: string[]): string {
  const out = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  assert.ok(out.status === 0, `git ${JSON.stringify(args)}: ${out.stderr}`);
  return out.stdout;
}

function write(dir: string, path: string, text: string) {
  const p = join(dir, path);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
}

/** A task with the plan label and a worktree of its own, in a repository with one commit. */
async function plan_task(s: AppState, fields: object = {}): Promise<Task> {
  const profile = db.insert_profile(s.db(), "p", [], null);
  const repo = testing.temp_dir();
  sh(repo, ["init", "-q", "-b", "master"]);
  sh(repo, ["config", "user.name", "t"]);
  sh(repo, ["config", "user.email", "t@t"]);
  write(repo, "f.txt", "1\n");
  sh(repo, ["add", "."]);
  sh(repo, ["commit", "-qm", "init"]);
  const b = { name: "x", repo_path: path_str(repo), key: "X", base_branch: "master", use_worktrees: null };
  const p = await api.create_project_inner(s, profile.id, b as any);
  const t0 = api.create_task_inner(s, p.id, { title: "Plan it", labels: ["plan"], ...fields } as any);
  return await worktree.setup(s, t0.id);
}

/** A task with the plan label that works in its own folder (made as a plan task before labels, see documents_only). */
async function folder_task(s: AppState): Promise<Task> {
  const profile = db.insert_profile(s.db(), "p", [], null);
  const p = await api.create_project_inner(s, profile.id, { name: "y", repo_path: path_str(testing.temp_dir()), key: "Y", use_worktrees: false } as any);
  const t = api.create_task_inner(s, p.id, { title: "Plan it", labels: ["plan"] } as any);
  mkdirSync(documents.dir(s, t.id), { recursive: true });
  return s.update_task(t.id, [["work_dir", `documents/${t.id}`]])!;
}

/**
 * One run of `task`'s agent, of one turn: its checkpoint before it, `work` (which may write the plan or change the
 * worktree), the turn's end and the run's. Resolves once the task's column is settled.
 */
async function run(s: AppState, task: Task, work: (t: Task) => void): Promise<Task> {
  const c = s.db();
  const r: Run = db.insert_run(c, task.id, "prompt");
  const m = db.insert_message(c, task.id, "user", { text: "Go on" });
  db.run(c, "UPDATE runs SET status='running', turn_message_id=?1 WHERE id=?2", m.id, r.id);
  s.update_task(task.id, [["status", "in_progress"], ["running", true], ["attention_reason", null]]);
  await checkpoints.before_run(s, task, db.get_run(c, r.id)!);
  // A new version of the plan has a later time than the run's start.
  await sleep(5);
  work(db.get_task(c, task.id)!);
  checkpoints.after_turn(s, r.id, "done");
  documents.turn_ended(s, task.id);
  finish(s, r.id, "Ok");
  await checkpoints.settled(s, task.id);
  // The column is set once the checkpoints are read, after them in the queue.
  for (let i = 0; i < 100 && db.get_task(c, task.id)!.status === "in_progress"; i++) await sleep(10);
  return db.get_task(c, task.id)!;
}

const write_plan = (s: AppState) => (t: Task) => {
  mkdirSync(documents.dir(s, t.id), { recursive: true });
  writeFileSync(documents.path(s, t, "plan")!, `<h1>Plan</h1><p>${Math.random()}</p>`);
};

test("a_run_that_only_writes_the_plan_waits_for_the_user", async () => {
  const s = testing.state();
  const task = await plan_task(s);
  let t = await run(s, task, write_plan(s));
  assert.deepEqual([t.status, t.attention_reason, t.running], ["needs_attention", PLAN_READY, false]);
  // Feedback on it, and a revision: it waits again.
  t = await run(s, t, write_plan(s));
  assert.deepEqual([t.status, t.attention_reason], ["needs_attention", PLAN_READY]);
});

test("a_run_that_does_the_work_goes_to_review", async () => {
  const s = testing.state();
  const task = await plan_task(s);
  const wt = task.worktree_path!;
  // It ticks off the plan's steps as it changes the code...
  let t = await run(s, task, (t) => {
    write_plan(s)(t);
    write(wt, "f.txt", "2\n");
  });
  assert.deepEqual([t.status, t.attention_reason], ["in_review", null]);
  // ...or commits it.
  t = await run(s, t, (t) => {
    write_plan(s)(t);
    write(wt, "g.txt", "new\n");
    sh(wt, ["add", "."]);
    sh(wt, ["commit", "-qm", "work"]);
  });
  assert.equal(t.status, "in_review");
  // A commit of a change made before the run (by the user, say) moves HEAD only.
  write(wt, "f.txt", "3\n");
  t = await run(s, t, (t) => {
    write_plan(s)(t);
    sh(wt, ["commit", "-qam", "more"]);
  });
  assert.equal(t.status, "in_review");
  // Breaking the approved plan into tasks is doing the work too.
  t = await run(s, t, (t) => {
    write_plan(s)(t);
    const sub = api.create_task_inner(s, t.project_id!, { title: "Step 1" } as any);
    s.update_task(sub.id, [["created_by", t.id]]);
  });
  assert.equal(t.status, "in_review");
});

test("a_run_that_leaves_the_plan_alone_goes_to_review", async () => {
  const s = testing.state();
  const task = await plan_task(s);
  let t = await run(s, task, write_plan(s));
  assert.equal(t.status, "needs_attention");
  // A question answered without touching the plan, and a task without the label.
  t = await run(s, t, () => {});
  assert.deepEqual([t.status, t.attention_reason], ["in_review", null]);
  t = s.update_task(t.id, [["labels", []]])!;
  t = await run(s, t, () => {});
  assert.equal(t.status, "in_review");
});

test("a_task_that_works_in_its_own_folder_has_no_code_to_change", async () => {
  const s = testing.state();
  const task = await folder_task(s);
  const t = await run(s, task, write_plan(s));
  assert.deepEqual([t.status, t.attention_reason], ["needs_attention", PLAN_READY]);
});

test("a_task_moved_or_run_again_meanwhile_is_left_alone", async () => {
  const s = testing.state();
  const task = await plan_task(s);
  const t = await run(s, task, write_plan(s));
  const r = db.get_run(s.db(), db.value<string>(s.db(), "SELECT id FROM runs WHERE task_id=?1", task.id)!)!;
  // Settled, it starts what entering its column starts (a review, the column's workflows), with the task as it's left.
  const seen: string[] = [];
  s.update_task(t.id, [["status", "in_progress"]]);
  await settle(s, { ...t, status: "in_progress" }, r, (x) => seen.push(x.status));
  assert.deepEqual(seen, ["needs_attention"]);
  // Moved by the user before the column was settled.
  s.update_task(t.id, [["status", "todo"]]);
  let entered = 0;
  await settle(s, { ...t, status: "in_progress" }, r, () => entered++);
  assert.equal(db.get_task(s.db(), t.id)!.status, "todo");
  // Sent another message, which started another run.
  s.update_task(t.id, [["status", "in_progress"]]);
  await sleep(5);
  db.insert_run(s.db(), t.id, "prompt");
  await settle(s, { ...t, status: "in_progress" }, r, () => entered++);
  assert.deepEqual([db.get_task(s.db(), t.id)!.status, entered], ["in_progress", 0]);
});

/**
 * A run of `task` that ended as `run`'s do, but with the server stopping once `finish` wrote it, before its column was
 * settled: the task is left in "In progress" with no agent.
 */
async function run_cut_short(s: AppState, task: Task, work: (t: Task) => void): Promise<Run> {
  const c = s.db();
  const r: Run = db.insert_run(c, task.id, "prompt");
  const m = db.insert_message(c, task.id, "user", { text: "Go on" });
  db.run(c, "UPDATE runs SET status='running', turn_message_id=?1 WHERE id=?2", m.id, r.id);
  s.update_task(task.id, [["status", "in_progress"], ["running", true], ["attention_reason", null]]);
  await checkpoints.before_run(s, task, db.get_run(c, r.id)!);
  await sleep(5);
  work(db.get_task(c, task.id)!);
  checkpoints.after_turn(s, r.id, "done");
  documents.turn_ended(s, task.id);
  await checkpoints.settled(s, task.id);
  db.run(c, "UPDATE runs SET status='exited', ended_at=?1 WHERE id=?2", new Date().toISOString(), r.id);
  s.update_task(task.id, [["running", false]]);
  return db.get_run(c, r.id)!;
}

async function restart(s: AppState, task: Task): Promise<Task> {
  load_active(s);
  await checkpoints.settled(s, task.id);
  for (let i = 0; i < 100 && db.get_task(s.db(), task.id)!.status === "in_progress"; i++) await sleep(10);
  return db.get_task(s.db(), task.id)!;
}

test("a_restart_settles_a_column_it_left_unsettled", async () => {
  const s = testing.state();
  const task = await plan_task(s);
  await run_cut_short(s, task, write_plan(s));
  assert.deepEqual([db.get_task(s.db(), task.id)!.status, db.get_task(s.db(), task.id)!.running], ["in_progress", false]);
  let t = await restart(s, task);
  assert.deepEqual([t.status, t.attention_reason, t.running], ["needs_attention", PLAN_READY, false]);
  // One that did the work goes to review.
  await run_cut_short(s, t, (t) => {
    write_plan(s)(t);
    write(t.worktree_path!, "f.txt", "2\n");
  });
  t = await restart(s, t);
  assert.deepEqual([t.status, t.attention_reason], ["in_review", null]);
});

test("a_restart_leaves_other_tasks_in_progress_alone", async () => {
  const s = testing.state();
  const task = await plan_task(s);
  // Its latest run left the plan alone, so `finish` set its column: it was put back in this one since.
  await run_cut_short(s, task, () => {});
  assert.equal((await restart(s, task)).status, "in_progress");
  // Waiting for its dependencies or a usage limit's reset, or for its queued message to be sent.
  await run_cut_short(s, task, write_plan(s));
  s.update_task(task.id, [["waiting", true]]);
  assert.equal(plan_unsettled(s).length, 0);
  s.update_task(task.id, [["waiting", false], ["queued_message", "And then"]]);
  assert.equal(plan_unsettled(s).length, 0);
  // A run that failed or asked for attention.
  s.update_task(task.id, [["queued_message", null]]);
  const r = db.get_run(s.db(), db.latest_run(s.db(), task.id, null)!)!;
  db.run(s.db(), "UPDATE runs SET result_error='boom' WHERE id=?1", r.id);
  assert.equal(plan_unsettled(s).length, 0);
  db.run(s.db(), "UPDATE runs SET result_error=NULL, attention='Question' WHERE id=?1", r.id);
  assert.equal(plan_unsettled(s).length, 0);
  db.run(s.db(), "UPDATE runs SET attention=NULL WHERE id=?1", r.id);
  assert.equal(plan_unsettled(s).length, 1);
});

test("a_restart_leaves_a_subproject_its_tasks_hold_in_progress_alone", async () => {
  const s = testing.state();
  const sp = await plan_task(s, { subproject: true });
  const child = api.create_task_inner(s, sp.project_id!, { title: "Step 1", parent_id: sp.id } as any);
  s.update_task(child.id, [["status", "in_progress"]]);
  // Its run revised the plan and changed its worktree: it went to review, and its task in progress brought it back.
  const t = await run(s, sp, (t) => {
    write_plan(s)(t);
    write(t.worktree_path!, "f.txt", "2\n");
  });
  assert.deepEqual([t.status, t.running], ["in_progress", false]);
  assert.deepEqual(plan_unsettled(s), []);
  // A restart doesn't move it to review only for its task to bring it back (running its status scripts twice).
  const moves: string[] = [];
  const update_task_if = s.update_task_if.bind(s);
  s.update_task_if = (id, fields, cond) => {
    const t = update_task_if(id, fields, cond);
    if (t && id === sp.id) for (const [k, v] of fields) if (k === "status") moves.push(v);
    return t;
  };
  load_active(s);
  await checkpoints.settled(s, sp.id);
  await sleep(50);
  assert.deepEqual([moves, db.get_task(s.db(), sp.id)!.status], [[], "in_progress"]);
});
