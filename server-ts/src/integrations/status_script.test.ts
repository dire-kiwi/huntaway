// Port of the tests in server/src/integrations/status_script.rs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as db from "../db.ts";
import type { Project, Task } from "../db.ts";
import * as worktree from "../git/worktree.ts";
import type { Shared } from "../state.ts";
import * as testing from "../testing.ts";
import { sleep } from "../util.ts";
import { QUEUES } from "./status_script.ts";

function project_and_task(s: Shared, repo: string): [Project, Task] {
  const c = s.db();
  const p = db.insert_profile(c, "p", [], null);
  const np = { id: "pr", profile_id: p.id, name: "x", key: "X", repo_path: repo, scratch_path: "/s", worktrees_root: "/w", base_branch: null, use_worktrees: false };
  const project = db.insert_project(c, np);
  const t = {
    profile_id: p.id, project_id: "pr", kind: "task", title: "t", description: "", status: "todo", use_worktree: false, model: null, effort: null,
    claude_config_id: null,
  };
  return [project, db.insert_task(c, t as any)];
}

function events(s: Shared, task_id: string): any[] {
  return testing.messages(s.db(), task_id).filter((m: any) => m.kind === "event").map((m: any) => m.data);
}

async function settled(task_id: string) {
  while (QUEUES.has(task_id)) await sleep(20);
}

test("runs_the_script_for_each_status_change_in_order", async () => {
  const s = testing.state();
  const repo = testing.temp_dir();
  const log = join(repo, "log");
  const [project, task] = project_and_task(s, repo);
  const script = `echo "$IA_TASK_KEY $IA_OLD_STATUS $IA_NEW_STATUS $PWD" >> ${log}\necho moved`;
  db.update_project(s.db(), project.id, [["status_script", script]]);

  s.update_task(task.id, [["status", "in_progress"]]);
  // Not a status change.
  s.update_task(task.id, [["title", "Renamed"]]);
  s.update_task(task.id, [["status", "in_progress"]]);
  s.update_task(task.id, [["status", "in_review"]]);
  s.update_task(task.id, [["status", "done"]]);

  await settled(task.id);
  const key = `${project.key}-${task.number}`;
  assert.equal(readFileSync(log, "utf8"), `${key} todo in_progress ${repo}\n${key} in_progress in_review ${repo}\n${key} in_review done ${repo}\n`);
  let ev = events(s, task.id);
  assert.equal(ev.length, 3);
  assert.equal(ev[0].text, "Status script ran (To do → In progress)");
  assert.equal(ev[0].detail, "moved");

  // A failing script says so in the thread.
  db.update_project(s.db(), project.id, [["status_script", "echo nope >&2; exit 3"]]);
  s.update_task(task.id, [["status", "todo"]]);
  await settled(task.id);
  ev = events(s, task.id);
  assert.equal(ev.at(-1).text, "Status script failed (Done → To do)");
  assert.ok(ev.at(-1).detail.includes("nope"));
});

test("a_column_script_runs_when_a_task_moves_into_its_column", async () => {
  const s = testing.state();
  const repo = testing.temp_dir();
  const log = join(repo, "log");
  const [project, task] = project_and_task(s, repo);
  const scripts = { done: `echo "done $IA_OLD_STATUS" >> ${log}`, in_review: `echo review >> ${log}` };
  db.update_project(s.db(), project.id, [["status_scripts", JSON.stringify(scripts)]]);

  for (const st of ["in_progress", "in_review", "in_progress", "done"]) s.update_task(task.id, [["status", st]]);
  await settled(task.id);
  assert.equal(readFileSync(log, "utf8"), "review\ndone in_progress\n");
  const ev = events(s, task.id).map((e) => e.text);
  assert.deepEqual(ev, ["In review script ran (In progress → In review)", "Done script ran (In progress → Done)"]);

  // The status script runs too, before the column's.
  db.update_project(s.db(), project.id, [["status_script", `echo any >> ${log}`]]);
  s.update_task(task.id, [["status", "in_review"]]);
  s.update_task(task.id, [["status", "todo"]]);
  await settled(task.id);
  assert.equal(readFileSync(log, "utf8"), "review\ndone in_progress\nany\nreview\nany\n");
});

test("nothing_runs_without_a_script", () => {
  const s = testing.state();
  const [, task] = project_and_task(s, "/nonexistent");
  s.update_task(task.id, [["status", "in_progress"]]);
  assert.ok(!QUEUES.has(task.id));
  assert.equal(events(s, task.id).length, 0);
});

test("changes_made_at_once_run_in_the_order_they_were_made", async () => {
  const s = testing.state();
  const repo = testing.temp_dir();
  const log = join(repo, "log");
  const [project, task] = project_and_task(s, repo);
  db.update_project(s.db(), project.id, [["status_script", `echo "$IA_OLD_STATUS $IA_NEW_STATUS" >> ${log}`]]);

  // Several movers at once (interleaved, as there's one thread), each with its own sequence.
  const movers = [0, 1, 2, 3].map(async (i) => {
    for (let n = 0; n < 25; n++) {
      const st = db.STATUSES[(i * 3 + n) % db.STATUSES.length];
      s.update_task(task.id, [["status", st]]);
      await sleep(0);
    }
  });
  await Promise.all(movers);
  await settled(task.id);
  // Each script starts where the one before it left off, and the last ends where the task is.
  const text = readFileSync(log, "utf8");
  let at = "todo";
  const lines = text.split("\n").filter((l) => l);
  for (const line of lines) {
    const [old, next] = line.split(" ");
    assert.equal(old, at, `out of order:\n${text}`);
    at = next;
  }
  assert.ok(lines.length > 10);
  assert.equal(at, db.get_task(s.db(), task.id)!.status);
});

test("a_script_that_runs_over_is_stopped_with_what_it_started", async () => {
  const dir = testing.temp_dir();
  const pid_file = join(dir, "pid");
  const script = `sleep 600 & echo $! > ${pid_file}; echo started; wait`;
  let err = "";
  await assert.rejects(worktree.run_script(script, dir, [], 500), (e: any) => {
    err = e.message + String(e.cause ?? "");
    return true;
  });
  assert.ok(err.includes("stopped it") && err.includes("started"), err);
  const pid = readFileSync(pid_file, "utf8").trim();
  // Killed: gone, or a zombie until it's reaped.
  const alive = () => {
    try {
      return !readFileSync(`/proc/${pid}/stat`, "utf8").includes(") Z ");
    } catch {
      return false;
    }
  };
  for (let i = 0; i < 50 && alive(); i++) await sleep(20);
  assert.ok(!alive(), `sleep ${pid} is still running`);
});
