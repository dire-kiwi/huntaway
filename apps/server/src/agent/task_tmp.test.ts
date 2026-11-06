// Port of the tests in server/src/agent/task_tmp.rs.
import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as db from "../db.ts";
import type { Task } from "../db.ts";
import type { Shared } from "../state.ts";
import * as testing from "../testing.ts";
import * as api from "../api.ts";
import { new_id, path_str, sleep } from "../util.ts";
import { REMOVING, dir, ensure, fnv1a, folder, remove, remove_all, root, root_in, sweep } from "./task_tmp.ts";

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

/** Waits (up to 5s) for `done`. */
async function until(done: () => boolean) {
  for (let i = 0; i < 500; i++) {
    if (done()) return;
    await sleep(10);
  }
  assert.fail("timed out");
}

const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

test("a_review_thread_uses_its_tasks_folder", () => {
  const s = testing.state();
  const t = task(s);
  const r = { ...t, id: "r", kind: "review", parent_id: t.id };
  assert.equal(dir(s, r), dir(s, t));
  assert.equal(dir(s, t), join(root(s), t.id.replaceAll("-", "").slice(0, 12)));
});

test("the_path_leaves_room_for_sockets_in_it", () => {
  const d = join(root_in("/tmp", "/home/someone-with-a-long-name/.local/share/issue-agent"), folder(new_id()));
  const len = path_str(d).length;
  assert.equal(len, "/tmp/ha-0123abcd/0123456789ab".length, d);
  // Chromium's socket (46 bytes), in ui-check.mjs's folder for the browser (20), fits in a socket path (107 bytes),
  // with room to spare.
  assert.ok(len + "/ia-ui-check-XXXXXX".length + "/org.chromium.Chromium.XXXXXX/SingletonSocket".length <= 100);
});

test("tasks_whose_ids_start_alike_share_a_folder_until_both_are_done", async () => {
  const s = testing.state();
  const [a, b] = [task(s), task(s)];
  const b_id = `${a.id.slice(0, 14)}${b.id.slice(14)}`;
  db.run(s.db(), "UPDATE tasks SET id=?1 WHERE id=?2", b_id, b.id);
  const b2 = db.get_task(s.db(), b_id)!;
  const d = ensure(s, a)!;
  assert.equal(ensure(s, b2), d);
  db.update_task(s.db(), a.id, [["status", "done"]]);
  assert.equal(await sweep(s), 0);
  db.update_task(s.db(), b2.id, [["status", "done"]]);
  assert.equal(await sweep(s), 1);
  assert.ok(!existsSync(d));
});

test("the_root_is_per_data_dir_and_stable", () => {
  const b = (s: string) => Buffer.from(s);
  assert.equal(fnv1a(b("/home/me/.local/share/huntaway")), fnv1a(b("/home/me/.local/share/huntaway")));
  assert.notEqual(fnv1a(b("/home/me/.local/share/huntaway")), fnv1a(b("/tmp/ia-test-x")));
  assert.equal(fnv1a(b("")), 0xcbf29ce484222325n);
});

test("the_folder_goes_once_the_task_is_done_and_idle", async () => {
  const s = testing.state();
  const t = task(s);
  const d = ensure(s, t)!;
  mkdirSync(join(d, "ia-test-1/repo"), { recursive: true });
  writeFileSync(join(d, "ia-test-1/repo/x"), "x");
  // Not while the agent still runs, though the task is done.
  s.update_task(t.id, [["running", true]]);
  s.update_task(t.id, [["status", "done"]]);
  await sleep(100);
  assert.ok(existsSync(d));
  assert.equal(await sweep(s), 0);
  // Its run ending takes it.
  s.update_task(t.id, [["running", false]]);
  await until(() => readdirSync(root(s)).length === 0);
  // It's set up again if the agent runs again.
  s.update_task(t.id, [["status", "in_progress"]]);
  assert.equal(ensure(s, t), d);
  s.update_task(t.id, [["title", "renamed"]]);
  await sleep(100);
  assert.ok(existsSync(d));
});

test("a_sweep_takes_done_and_deleted_tasks_folders", async () => {
  const s = testing.state();
  const [open, done] = [task(s), task(s)];
  const [open_dir, done_dir] = [ensure(s, open)!, ensure(s, done)!];
  // Done while the server was down, so nothing saw it change.
  db.update_task(s.db(), done.id, [["status", "done"]]);
  const deleted = join(root(s), folder(new_id()));
  mkdirSync(deleted, { recursive: true });
  const unfinished = join(root(s), `${REMOVING}x-1`);
  mkdirSync(join(unfinished, "y"), { recursive: true });
  assert.equal(await sweep(s), 2);
  assert.ok(existsSync(open_dir) && !existsSync(done_dir) && !existsSync(deleted) && !existsSync(unfinished));
});

test("only_folders_named_like_tasks_are_swept", async () => {
  const s = testing.state();
  ensure(s, task(s));
  const elsewhere = testing.temp_dir();
  mkdirSync(join(elsewhere, "docs"), { recursive: true });
  writeFileSync(join(elsewhere, "docs/important.txt"), "x");
  const r = root(s);
  mkdirSync(join(r, "notes"));
  symlinkSync(elsewhere, join(r, folder(new_id())));
  assert.equal(await sweep(s), 0);
  assert.ok(isDir(join(r, "notes")) && existsSync(join(elsewhere, "docs/important.txt")));
});

test("nothing_is_removed_through_a_root_that_isnt_ours_alone", async () => {
  const s = testing.state();
  const t = task(s);
  db.update_task(s.db(), t.id, [["status", "done"]]);
  // Someone left a link where the root goes, to a folder with a done task's name in it.
  const elsewhere = testing.temp_dir();
  for (const d of [folder(t.id), folder(new_id()), `${REMOVING}x`, "docs"]) {
    mkdirSync(join(elsewhere, d), { recursive: true });
    writeFileSync(join(elsewhere, d, "important.txt"), "x");
  }
  const count = () => readdirSync(elsewhere).length;
  mkdirSync(dirname(root(s)), { recursive: true });
  symlinkSync(elsewhere, root(s));
  assert.equal(await sweep(s), 0);
  assert.ok(!(await remove(s, folder(t.id))));
  assert.equal(count(), 4);
  assert.equal(ensure(s, task(s)), null);
  // Nor through a root others can write to.
  unlinkSync(root(s));
  renameSync(elsewhere, root(s));
  chmodSync(root(s), 0o777);
  assert.equal(await sweep(s), 0);
  assert.equal(readdirSync(root(s)).length, 4);
  assert.equal(ensure(s, task(s)), null);
  // Once it's ours alone, the done task's folder goes.
  chmodSync(root(s), 0o700);
  assert.equal(await sweep(s), 2);
  assert.ok(existsSync(join(root(s), "docs/important.txt")));
});

test("a_run_starting_as_the_folder_goes_keeps_its_own", async () => {
  const s = testing.state();
  const t = task(s);
  ensure(s, t);
  db.update_task(s.db(), t.id, [["status", "done"]]);
  // Once the removal has found the task idle, a run starts: it's registered, then sets up its folder and writes in it.
  // (Rust starts it on another thread, which waits for the removal's lock; here it runs once the removal's
  // synchronous step is over.)
  const start = () => {
    s.runs.set(t.id, { run_id: "r", cancel: null });
    const d = ensure(s, t)!;
    writeFileSync(join(d, "work"), "x");
  };
  let started: Promise<void> | null = null;
  testing.when("task_tmp:removable", () => {
    started = new Promise((resolve, reject) =>
      setImmediate(() => {
        try {
          start();
          resolve();
        } catch (e) {
          reject(e);
        }
      }),
    );
  });
  assert.equal(await sweep(s), 1);
  assert.ok(started);
  await started;
  assert.ok(existsSync(join(dir(s, t), "work")));
  // And with it running, the folder stays.
  assert.equal(await sweep(s), 0);
  assert.ok(existsSync(join(dir(s, t), "work")));
});

test("deleting_a_task_takes_its_folder", async () => {
  const s = testing.state();
  const [kept, gone] = [task(s), task(s)];
  const [kept_dir, gone_dir] = [ensure(s, kept)!, ensure(s, gone)!];
  writeFileSync(join(gone_dir, "x"), "x");
  await api.delete_one(s, gone, false);
  assert.ok(existsSync(kept_dir) && !existsSync(gone_dir));
  assert.equal(readdirSync(root(s)).length, 1);
});

test("folders_without_write_permission_are_removed_too", () => {
  const tmp = testing.temp_dir();
  const d = join(tmp, "t");
  mkdirSync(join(d, "mod/pkg"), { recursive: true });
  writeFileSync(join(d, "mod/pkg/f"), "x");
  for (const p of ["mod/pkg", "mod"]) chmodSync(join(d, p), 0o555);
  remove_all(d);
  assert.ok(!existsSync(d));
});
