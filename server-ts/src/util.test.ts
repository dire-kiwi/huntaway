// Port of server/src/util.rs's tests.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { temp_dir } from "./testing.ts";
import { has_commits, is_git_root, make_private, path_str } from "./util.ts";
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
