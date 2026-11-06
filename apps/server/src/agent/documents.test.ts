// Port of the tests in server/src/agent/documents.rs.
import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { closeSync, existsSync, mkdirSync, openSync, futimesSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as db from "../db.ts";
import type { NewTask, Task } from "../db.ts";
import type { Shared } from "../state.ts";
import * as testing from "../testing.ts";
import { path_str } from "../util.ts";
import * as runner from "./runner.ts";
import * as codex from "./codex.ts";
import * as terminal from "../hosts/terminal.ts";
import {
  check_labels,
  dir,
  documents_only,
  follow,
  labels,
  path,
  paths,
  plan_command,
  plan_prompt,
  turn_ended,
  work_dir,
  writes_own_folder,
} from "./documents.ts";

function task_of(state: Shared, ls: string[]): Task {
  const p = db.insert_profile(state.db(), "p", [], null);
  const t = db.insert_task(state.db(), {
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
  return db.update_task(state.db(), t.id, [["labels", ls]])!;
}

function labelled(state: Shared, id: string): Array<[string, number, string, boolean]> {
  return db
    .all(state.db(), "SELECT label, version, content, open FROM documents WHERE task_id=?1 ORDER BY label, version", id)
    .map((r) => [r.label, r.version, r.content, !!r.open]);
}

function versions(state: Shared, id: string): Array<[number, string, boolean]> {
  return labelled(state, id).map(([, v, c, o]) => [v, c, o]);
}

/** Writes the file with a modification time of its own, as the next edit would have. */
function write(file: string, text: string, secs: number) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  const fd = openSync(file, "r+");
  futimesSync(fd, 1_000_000 + secs, 1_000_000 + secs);
  closeSync(fd);
}

test("plan_command", () => {
  assert.equal(plan_command("/plan"), "");
  assert.equal(plan_command("  /plan the cache\n"), "the cache");
  assert.equal(plan_command("/planner"), null);
  assert.equal(plan_command("make a /plan"), null);
  // Told already, it doesn't repeat the instructions.
  const told = plan_prompt("/d/plan.html", "", true);
  assert.ok(told.includes("/d/plan.html") && !told.includes('<ol class="steps">') && told.endsWith("for the work this task is about."), told);
  const full = plan_prompt("/d/plan.html", "the cache", false);
  assert.ok(full.startsWith("This task has the label plan") && full.includes("<ia-question") && full.endsWith("What to plan: the cache"), full);
});

test("a_version_follows_the_file_during_a_turn_and_the_next_turn_starts_another", () => {
  const state = testing.state();
  const task = task_of(state, ["diagram"]);
  const file = path(state, task, "diagram")!;
  assert.ok(file.endsWith("diagram.mmd"));

  // Nothing written yet: no version.
  follow(state, task.id);
  turn_ended(state, task.id);
  assert.deepEqual(versions(state, task.id), []);

  write(file, "flowchart LR\n  a", 1);
  follow(state, task.id);
  write(file, "flowchart LR\n  a --> b", 2);
  follow(state, task.id);
  assert.deepEqual(versions(state, task.id), [[1, "flowchart LR\n  a --> b", true]]);
  assert.notEqual(db.get_task(state.db(), task.id)!.document_at ?? null, null);
  turn_ended(state, task.id);
  assert.deepEqual(versions(state, task.id), [[1, "flowchart LR\n  a --> b", false]]);

  // A turn that doesn't change it adds nothing; the next change is version 2.
  turn_ended(state, task.id);
  write(file, "flowchart LR\n  a --> c", 3);
  turn_ended(state, task.id);
  const v = versions(state, task.id);
  assert.deepEqual(
    v.map(([n, , open]) => [n, open]),
    [
      [1, false],
      [2, false],
    ],
  );
  assert.equal(v[1][1], "flowchart LR\n  a --> c");

  // A task with no labels has no documents.
  const code = task_of(state, []);
  assert.deepEqual(paths(state, code), []);
  write(path(state, code, "plan")!, "<h1>Plan</h1>", 1);
  turn_ended(state, code.id);
  assert.deepEqual(versions(state, code.id), []);
});

test("a_task_keeps_a_document_for_each_label", () => {
  const state = testing.state();
  let task = task_of(state, ["diagram", "plan"]);
  assert.deepEqual(labels(task), ["plan", "diagram"]);
  const plan = path(state, task, "plan")!,
    diagram = path(state, task, "diagram")!;
  write(plan, "<h1>Plan</h1>", 1);
  write(diagram, "flowchart LR", 1);
  follow(state, task.id);
  assert.deepEqual(labelled(state, task.id), [
    ["diagram", 1, "flowchart LR", true],
    ["plan", 1, "<h1>Plan</h1>", true],
  ]);
  turn_ended(state, task.id);
  write(plan, "<h1>Plan 2</h1>", 2);
  // Taking a label off mid-turn closes its version all the same, and stops following its file.
  follow(state, task.id);
  task = db.update_task(state.db(), task.id, [["labels", ["diagram"]]])!;
  write(plan, "<h1>Plan 3</h1>", 3);
  turn_ended(state, task.id);
  assert.deepEqual(labelled(state, task.id), [
    ["diagram", 1, "flowchart LR", false],
    ["plan", 1, "<h1>Plan</h1>", false],
    ["plan", 2, "<h1>Plan 2</h1>", false],
  ]);
});

test("its_labels_are_known_ones_in_order", () => {
  assert.deepEqual(check_labels(["diagram", " plan", "plan"]), ["plan", "diagram"]);
  assert.deepEqual(check_labels(null), []);
  assert.throws(() => check_labels(["scratch"]));
  assert.throws(() => check_labels("plan"));
});

test("its_shell_and_wait_commands_run_in_its_folder", () => {
  const state = testing.state();
  const p = db.insert_profile(state.db(), "p", [], null);
  db.insert_project(state.db(), {
    id: "pr",
    profile_id: p.id,
    name: "Web",
    key: "WEB",
    repo_path: "/src/web",
    scratch_path: "/s",
    worktrees_root: "/w",
    base_branch: null,
    use_worktrees: false,
  });
  db.update_project(state.db(), "pr", [["group_name", "Shop"]]);
  const new_task = (project_id: string | null): NewTask => ({
    profile_id: p.id,
    project_id,
    kind: "task",
    title: "t",
    description: "",
    status: "todo",
    use_worktree: false,
    model: null,
    effort: null,
    claude_config_id: null,
  });
  // A task made as a diagram task before they were labels, as the migration leaves it.
  const typed = (t: Task) =>
    db.update_task(state.db(), t.id, [
      ["labels", ["diagram"]],
      ["work_dir", `documents/${t.id}`],
    ])!;
  const in_project = typed(db.insert_task(state.db(), new_task("pr")));
  const in_group = typed(db.insert_group_task(state.db(), new_task(null), "Shop"));
  for (const t of [in_project, in_group]) {
    const d = dir(state, t.id);
    assert.equal(work_dir(state, t), d);
    // Where `wait` runs its command, and where the task's terminal opens.
    assert.equal(runner.work_dir(state, t), d);
    assert.equal(terminal.working_dir(state, t), path_str(d));
  }
  // Labels don't move a task out of the repository.
  let code = db.insert_task(state.db(), new_task("pr"));
  code = db.update_task(state.db(), code.id, [["labels", ["diagram"]]])!;
  assert.ok(!documents_only(code));
  assert.equal(work_dir(state, code), null);
  assert.equal(runner.work_dir(state, code), "/src/web");
});

test("a_codex_edit_shows_before_its_turn_ends", () => {
  const state = testing.state();
  const task = task_of(state, ["plan"]);
  const run = db.insert_run(state.db(), task.id, "prompt");
  const file = path(state, task, "plan")!;
  write(file, "<h1>Plan</h1>", 1);
  const item = { type: "fileChange", id: "f1", status: "completed", changes: [{ path: path_str(file), kind: { type: "add" }, diff: "+<h1>Plan</h1>" }] };
  codex.handle_line(state, run, { method: "item/completed", params: { item } });
  assert.deepEqual(versions(state, task.id), [[1, "<h1>Plan</h1>", true]]);
  assert.notEqual(db.get_task(state.db(), task.id)!.document_at ?? null, null);
});

test("the_agent_writes_its_own_folder_without_asking", () => {
  const state = testing.state();
  const task = task_of(state, ["plan"]);
  const d = dir(state, task.id);
  const own = (tool: string, file: string) => writes_own_folder(state, task, tool, { file_path: path_str(file) });
  assert.ok(own("Write", join(d, "plan.html")));
  assert.ok(own("Edit", join(d, "notes/a.md")));
  assert.ok(!own("Bash", join(d, "plan.html")));
  assert.ok(!own("Write", `${d}/../other/plan.html`));
  assert.ok(!own("Write", join(state.data_dir, "x.html")));
  assert.ok(!writes_own_folder(state, task, "Write", { file_path: "plan.html" }));
  // Not through a link out of the folder.
  mkdirSync(d, { recursive: true });
  const outside = join(state.data_dir, "elsewhere");
  mkdirSync(outside, { recursive: true });
  symlinkSync(outside, join(d, "out"));
  assert.ok(!own("Write", join(d, "out/x.html")));
  // Nor through one to a file that doesn't exist yet, which writing would create.
  symlinkSync(join(outside, "missing.html"), join(d, "link.html"));
  assert.ok(!own("Write", join(d, "link.html")));
  symlinkSync(join(outside, "gone/x"), join(d, "deep"));
  assert.ok(!own("Write", join(d, "deep/y.html")));
  assert.ok(!existsSync(join(outside, "missing.html")));
  assert.ok(own("Write", join(d, "new/dir/x.html")));
  const code = task_of(state, []);
  assert.ok(!writes_own_folder(state, code, "Write", { file_path: path_str(join(dir(state, code.id), "a")) }));
});
