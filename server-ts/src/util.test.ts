// Port of server/src/util.rs's tests.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { temp_dir } from "./testing.ts";
import { has_commits, is_git_root, make_private, path_str, remove_dir_all, remove_dir_all_async } from "./util.ts";
import * as db from "./db.ts";

function git(dir: string, args: string[]) {
  execFileSync("git", ["-C", dir, ...args], { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" }, stdio: "ignore" });
}

test("tells_a_repository_with_commits", () => {
  const dir = temp_dir();
  const repo = join(dir, "repo");
  mkdirSync(repo, { recursive: true });
  assert.ok(!is_git_root(repo) && !has_commits(repo));
  git(repo, ["init", "-q", "-b", "main"]);
  assert.ok(is_git_root(repo) && !has_commits(repo));
  git(repo, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "first"]);
  assert.ok(has_commits(repo));
  // Packed, as `git gc` leaves them.
  git(repo, ["pack-refs", "--all"]);
  assert.ok(!existsSync(join(repo, ".git/refs/heads/main")) && has_commits(repo));
  // Detached, and on a branch with no commits yet.
  git(repo, ["checkout", "-q", "--detach"]);
  assert.ok(has_commits(repo));
  git(repo, ["checkout", "-q", "--orphan", "fresh"]);
  assert.ok(!has_commits(repo));
  git(repo, ["checkout", "-q", "main"]);
  // A linked worktree, whose `.git` is a file and whose branches are in the repository's git dir.
  const linked = join(dir, "linked");
  git(repo, ["worktree", "add", "-q", "-b", "side", path_str(linked)]);
  assert.ok(statSync(join(linked, ".git")).isFile() && has_commits(linked));
});

// HA-120: the live data dir was 0755 and its database 0644, readable by any user on the machine.
test("makes_an_existing_data_dir_private", { skip: process.platform === "win32" }, () => {
  const root = temp_dir();
  const dir = join(root, "data");
  mkdirSync(join(dir, "runs"), { recursive: true });
  const mode = (p: string) => statSync(p).mode & 0o777;
  // As a server from before left it: a database open in WAL mode, and other files.
  const c = db.open(join(dir, "huntaway.db"));
  c.exec("CREATE TABLE t (x); INSERT INTO t VALUES (1);");
  for (const f of ["huntaway.db-wal", "huntaway.db-shm"]) assert.ok(existsSync(join(dir, f)), f);
  writeFileSync(join(dir, "serve.log"), "log");
  writeFileSync(join(root, "elsewhere.db"), "");
  symlinkSync(join(root, "elsewhere.db"), join(dir, "linked.db"));
  for (const f of ["huntaway.db", "huntaway.db-wal", "huntaway.db-shm", "serve.log"]) chmodSync(join(dir, f), 0o644);
  chmodSync(join(root, "elsewhere.db"), 0o644);
  chmodSync(dir, 0o755);
  // Reached through a symlink, as a --data-dir can be.
  const via = join(root, "via");
  symlinkSync(dir, via);
  make_private(via);
  assert.equal(mode(dir), 0o700);
  for (const f of ["huntaway.db", "huntaway.db-wal", "huntaway.db-shm"]) assert.equal(mode(join(dir, f)), 0o600, f);
  // Other files keep their mode (the folder keeps others out), and a link's target is left alone.
  assert.equal(mode(join(dir, "serve.log")), 0o644);
  assert.equal(mode(join(root, "elsewhere.db")), 0o644);
  assert.equal(mode(join(dir, "runs")), 0o755);
  // The database still works, and a second start changes nothing.
  c.exec("INSERT INTO t VALUES (2);");
  make_private(dir);
  assert.equal(mode(dir), 0o700);
  c.close();
});

test("a_folder_is_removed_when_a_file_in_it_goes_meanwhile", () => removed_while_a_file_goes(remove_dir_all));

test("a_folder_is_removed_when_a_file_in_it_goes_meanwhile_async", () => removed_while_a_file_goes(remove_dir_all_async));

test("a_folder_is_removed_while_files_are_written_in_it", () => removed_while_written(remove_dir_all));

test("a_folder_is_removed_while_files_are_written_in_it_async", () => removed_while_written(remove_dir_all_async));

async function removed_while_written(remove: (dir: string) => void | Promise<void>) {
  // As an agent still writing in its run's or temp folder does (HA-253): another thread writes a few files in the folder
  // as it's removed, once a round, which makes rm fail with ENOTEMPTY when one comes after it emptied the folder.
  const dir = join(temp_dir(), "busy");
  // [the round being removed, the round whose files are written]; -1 in the first stops it.
  const s = new Int32Array(new SharedArrayBuffer(8));
  const worker = new Worker(
    `const { workerData: [dir, s] } = require("node:worker_threads");
    const fs = require("node:fs");
    for (let i = 1; ; i++) {
      Atomics.wait(s, 0, i - 1);
      if (Atomics.load(s, 0) < 0) break;
      for (let j = 0; j < 3; j++) {
        const until = performance.now() + Math.random() * 0.3;
        while (performance.now() < until);
        try { fs.writeFileSync(dir + "/w" + j, "x"); } catch {}
      }
      Atomics.store(s, 1, i);
    }`,
    { eval: true, workerData: [dir, s] },
  );
  try {
    for (let i = 1; i <= 100; i++) {
      mkdirSync(dir);
      for (let j = 0; j < 200; j++) writeFileSync(join(dir, `f${j}`), "x");
      Atomics.store(s, 0, i);
      Atomics.notify(s, 0);
      await remove(dir);
      assert.ok(!existsSync(dir), `round ${i}: the folder is still there`);
      // (The writes that came after it went don't make it again.)
      while (Atomics.load(s, 1) < i) await new Promise((r) => setImmediate(r));
      assert.ok(!existsSync(dir), `round ${i}: the folder is back`);
    }
  } finally {
    Atomics.store(s, 0, -1);
    Atomics.notify(s, 0);
    await worker.terminate();
  }
}

async function removed_while_a_file_goes(remove: (dir: string) => void | Promise<void>) {
  // As a detached `git maintenance` does with `objects/maintenance.lock` (HA-252): another thread makes the lock before
  // the folder's other files (so it's listed last) and removes it a moment after the removal starts, once a round.
  const dir = join(temp_dir(), "objects");
  // [the round asked for, the round whose lock is made, the round being removed]; -1 in the first stops it.
  const s = new Int32Array(new SharedArrayBuffer(12));
  const worker = new Worker(
    `const { workerData: [lock, s] } = require("node:worker_threads");
    const fs = require("node:fs");
    for (let i = 1; ; i++) {
      Atomics.wait(s, 0, i - 1);
      if (Atomics.load(s, 0) < 0) break;
      fs.writeFileSync(lock, "");
      Atomics.store(s, 1, i);
      while (Atomics.load(s, 2) < i && Atomics.load(s, 0) >= 0);
      const until = performance.now() + Math.random() * 0.02;
      while (performance.now() < until);
      try { fs.unlinkSync(lock); } catch {}
    }`,
    { eval: true, workerData: [join(dir, "maintenance.lock"), s] },
  );
  try {
    for (let i = 1; i <= 300; i++) {
      mkdirSync(dir);
      Atomics.store(s, 0, i);
      Atomics.notify(s, 0);
      while (Atomics.load(s, 1) < i);
      for (let j = 0; j < 20; j++) writeFileSync(join(dir, `f${j}`), "x");
      Atomics.store(s, 2, i);
      await remove(dir);
      assert.ok(!existsSync(dir), `round ${i}: the folder is still there`);
    }
  } finally {
    Atomics.store(s, 0, -1);
    Atomics.notify(s, 0);
    await worker.terminate();
  }
}
