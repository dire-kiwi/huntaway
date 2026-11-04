// Port of server/src/util.rs's tests.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { temp_dir } from "./testing.ts";
import { has_commits, is_git_root, path_str } from "./util.ts";

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
