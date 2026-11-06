// Port of server/src/git/worktree/tests.rs.
import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as api from "../../api.ts";
import * as db from "../../db.ts";
import type { Project, Task } from "../../db.ts";
import * as leftovers from "../../agent/leftovers.ts";
import * as runner from "../../agent/runner.ts";
import * as runs from "../../agent/runs.ts";
import * as gh_mcp from "../../mcp/gh_mcp.ts";
import type { AppState } from "../../state.ts";
import * as testing from "../../testing.ts";
import { new_id, path_str, sleep } from "../../util.ts";
import {
  changes_base,
  changes_testing,
  commit,
  compare_ref,
  current_branch,
  diff,
  folder_name,
  git,
  github,
  has_work_to_merge,
  is_github_com,
  pr_testing,
  pr_view_args,
  push_repo,
  remote_base,
  remote_repo,
  remote_testing,
  removable_by_hand,
  remove_if_merged,
  remove_merged,
  setup,
  start_ref,
  teardown,
  uncommitted,
  unmerged,
  work_scope,
  type Removal,
} from "../worktree.ts";

// Git as the tests set it up: no user or system config of the machine's, and an identity for commits.
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";
// Tests read their own SSH config, not the user's.
remote_testing.SSH_CONFIG = "/dev/null";

function sh(dir: string, args: string[]): string {
  try {
    return execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e: any) {
    throw new Error(`git ${JSON.stringify(args)}: ${e.stderr}`);
  }
}

function rev(dir: string, r: string): string {
  try {
    return execFileSync("git", ["-C", dir, "rev-parse", r], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch (e: any) {
    return String(e.stdout ?? "").trim();
  }
}

/** `OWNER/REPO` from a remote URL on github.com. */
function github_repo(url: string): string | null {
  const r = remote_repo(url);
  return r && is_github_com(r[0]) ? r[1] : null;
}

/** The error a promise fails with. */
async function fails(p: Promise<any>): Promise<any> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  assert.fail("expected an error");
}

/** The error a call fails with. */
function throws(f: () => any): any {
  try {
    f();
  } catch (e) {
    return e;
  }
  assert.fail("expected an error");
}

const ct = (title: string, more: Partial<api.CreateTask> = {}): api.CreateTask => ({ ...api.CreateTask_default(), title, ...more });

async function project_on(s: AppState, repo: string): Promise<Project> {
  const profile = db.insert_profile(s.db(), "p", [], null);
  return api.create_project_inner(s, profile.id, { name: "x", repo_path: path_str(repo), key: "X", base_branch: "master", use_worktrees: null });
}

test("reads_github_remotes", () => {
  for (const url of [
    "git@github.com:o/r.git",
    "github.com:o/r",
    "https://github.com/o/r",
    "https://github.com/o/r.git/",
    "https://x:token@github.com/o/r.git",
    "ssh://git@ssh.github.com:443/o/r.git",
    "git://GitHub.com/o/r",
  ]) {
    assert.equal(github_repo(url), "o/r", url);
  }
  for (const url of [
    "git@gitlab.com:o/r.git",
    "https://example.com/github.com/o/r",
    "/srv/git/o/r.git",
    "./github.com:o/r",
    "https://github.com/o",
    "https://github.com/o/r/pull/1",
  ]) {
    assert.equal(github_repo(url), null, url);
  }
});

test("finds_the_github_remote_pull_requests_go_to", async () => {
  const repo = testing.temp_dir();
  sh(repo, ["init", "-q", "-b", "master"]);
  assert.equal(await github(repo, "master"), null);
  sh(repo, ["remote", "add", "history", "git@github.com:o/history.git"]);
  assert.deepEqual(await github(repo, "master"), { remote: "history", repo: "o/history" });
  sh(repo, ["remote", "add", "origin", "https://github.com/o/r.git"]);
  const origin = { remote: "origin", repo: "o/r" };
  assert.deepEqual(await github(repo, "master"), origin);
  assert.deepEqual(await github(repo, null), origin);
  // The base branch's upstream comes first.
  sh(repo, ["config", "branch.master.remote", "history"]);
  assert.equal((await github(repo, "master"))?.remote, "history");
  sh(repo, ["remote", "set-url", "history", "git@gitlab.com:o/history.git"]);
  assert.equal(await github(repo, "master"), null);
  // It's where the branch is pushed that counts, not where it's fetched from.
  sh(repo, ["remote", "set-url", "--push", "history", "git@github.com:o/mirror.git"]);
  assert.equal((await github(repo, "master"))?.repo, "o/mirror");
  sh(repo, ["remote", "set-url", "--push", "origin", "git@gitlab.com:o/r.git"]);
  assert.equal(await github(repo, null), null);

  // The pull request is looked up where the branch is pushed, not where gh would look.
  assert.deepEqual(await pr_view_args(repo, "master", "ia/x-1"), ["pr", "view", "ia/x-1", "--json", "url", "--repo", "o/mirror"]);
  sh(repo, ["config", "--unset", "branch.master.remote"]);
  assert.deepEqual(await pr_view_args(repo, "master", "ia/x-1"), ["pr", "view", "ia/x-1", "--json", "url"]);
});

test("an_ssh_host_alias_is_the_host_it_stands_for", async () => {
  const dir = testing.temp_dir();
  const repo = join(dir, "repo");
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(dir, "ssh_config"), "Host github-work\n  HostName github.com\n  IdentityFile ~/.ssh/work\nHost ghe\n  HostName GHE.acme.com\n");
  remote_testing.SSH_CONFIG = join(dir, "ssh_config");
  try {
    sh(repo, ["init", "-q", "-b", "master"]);
    sh(repo, ["remote", "add", "origin", "git@github-work:o/r.git"]);
    assert.deepEqual(await push_repo(repo, null), ["github.com", "o/r"]);
    assert.equal((await github(repo, null))?.repo, "o/r");
    sh(repo, ["remote", "set-url", "origin", "ssh://git@ghe/o/r.git"]);
    assert.deepEqual(await push_repo(repo, null), ["ghe.acme.com", "o/r"]);
    assert.equal(await github(repo, null), null);
    // Only SSH remotes' hosts are aliases.
    sh(repo, ["remote", "set-url", "origin", "https://github-work/o/r.git"]);
    assert.deepEqual(await push_repo(repo, null), ["github-work", "o/r"]);
    // A host the config doesn't name is as it is.
    sh(repo, ["remote", "set-url", "origin", "git@gitlab.com:o/r.git"]);
    assert.deepEqual(await push_repo(repo, null), ["gitlab.com", "o/r"]);
  } finally {
    remote_testing.SSH_CONFIG = "/dev/null";
  }
});

/**
 * A repository (on master, ignoring target/) with a task whose worktree has a commit: the repository, the task and its
 * worktree and branch.
 */
async function task_with_work(s: AppState): Promise<[string, Task, string, string]> {
  const repo = testing.temp_dir();
  sh(repo, ["init", "-q", "-b", "master"]);
  writeFileSync(join(repo, ".gitignore"), "target/\n");
  sh(repo, ["add", "."]);
  sh(repo, ["commit", "-qm", "init"]);
  const p = await project_on(s, repo);
  let t = api.create_task_inner(s, p.id, ct("Do it"));
  t = await setup(s, t.id);
  const wt = t.worktree_path!,
    branch = t.branch!;
  writeFileSync(join(wt, "a"), "a");
  sh(wt, ["add", "a"]);
  sh(wt, ["commit", "-qm", "a"]);
  return [repo, t, wt, branch];
}

// HA-42: untracked files were listed without -z, so a name git quotes (not ASCII) or one starting with `-` dropped out
// of the branch's diff.
test("the_diff_has_every_untracked_file_whatever_its_name", async () => {
  const s = testing.state();
  const [, t, wt] = await task_with_work(s);
  for (const name of ["café.txt", "-n.txt", "plain.txt"]) writeFileSync(join(wt, name), `in ${name}\n`);
  const d = await diff(s, t.id);
  const untracked = [...d.untracked].sort();
  assert.deepEqual(untracked, ["-n.txt", "café.txt", "plain.txt"]);
  for (const name of ["café.txt", "-n.txt", "plain.txt"]) assert.ok(d.patch.includes(`+in ${name}\n`), `${name}: ${d.patch}`);
});

// HA-186: test servers started from a worktree's build ran on after the worktree went.
test("removing_a_worktree_stops_the_test_servers_started_from_it", async () => {
  const s = testing.state();
  const [, t, wt] = await task_with_work(s);
  // A build of the worktree's (ignored, so the worktree is clean), serving data kept elsewhere.
  const bin = join(wt, "target", "debug", "huntaway");
  mkdirSync(join(wt, "target", "debug"), { recursive: true });
  writeFileSync(bin, "setInterval(() => {}, 1e9);\n");
  const tag = `wt-server-${new_id()}`;
  const child = spawn(process.execPath, [bin, "serve", "--data-dir", testing.temp_dir(), "--name", tag], { stdio: "ignore", detached: true });
  const up = async () => ((await leftovers.list()) ?? []).some((p) => p.pid === child.pid && p.cmd.includes(tag));
  try {
    for (let i = 0; i < 200 && !(await up()); i++) await sleep(25);
    assert.ok(await up(), "the server started");
    await teardown(s, t.id, false, false);
    assert.ok(!existsSync(wt));
    assert.ok(!(await up()), "the server is stopped");
  } finally {
    child.kill("SIGKILL");
  }
});

// HA-51: a task whose worktree was removed showed the project folder's changes as its own.
test("without_its_worktree_the_diff_is_its_branchs", async () => {
  const s = testing.state();
  const [repo, t, , branch] = await task_with_work(s);
  writeFileSync(join(repo, "main-only"), "not the task's\n");
  await teardown(s, t.id, false, false);
  let d = await diff(s, t.id);
  assert.deepEqual([d.available, d.branch], [true, branch]);
  assert.ok(d.patch.includes("+++ b/a") && !d.patch.includes("main-only"), d.patch);
  assert.ok(d.commits.includes(" a\n"), JSON.stringify(d));
  assert.deepEqual(d.untracked, []);
  sh(repo, ["branch", "-D", branch]);
  d = await diff(s, t.id);
  assert.equal(d.available, false);
  assert.ok(d.reason.includes("is gone"), JSON.stringify(d));
});

// HA-92: a worktree removed while its diff was being read (picking one of a set's tasks tears the others' down) failed
// the request with git's "cannot change to" the folder.
test("a_worktree_removed_while_its_diff_is_read_gives_its_branchs", async () => {
  const s = testing.state();
  const [repo, t, wt, branch] = await task_with_work(s);
  // The task as the diff loaded it, still "ready", with the folder gone by the time git runs in it.
  sh(repo, ["worktree", "remove", "--force", path_str(wt)]);
  const d = await diff(s, t.id);
  assert.deepEqual([d.available, d.branch], [true, branch]);
  assert.ok(d.patch.includes("+++ b/a"), JSON.stringify(d));
});

// HA-90: the same, with the folder going after the diff checked for it, while git runs in it.
test("a_worktree_removed_while_git_reads_its_diff_gives_its_branchs", async () => {
  const s = testing.state();
  const [, t, wt, branch] = await task_with_work(s);
  writeFileSync(join(wt, "draft"), "uncommitted\n");
  const gone = wt + ".gone";
  changes_testing.diff_read = () => renameSync(wt, gone);
  let d = await diff(s, t.id);
  assert.deepEqual([d.available, d.branch], [true, branch], JSON.stringify(d));
  assert.ok(d.patch.includes("+++ b/a"), JSON.stringify(d));
  // Back in place, it's the worktree's again, uncommitted work and all.
  renameSync(gone, wt);
  d = await diff(s, t.id);
  assert.ok(d.branch === undefined && JSON.stringify(d.untracked) === JSON.stringify(["draft"]), JSON.stringify(d));
});

const kept = (why: string): Removal => ({ Kept: why });
const removed = (into: string): Removal => ({ Removed: into });

test("removes_a_done_tasks_worktree_once_merged_and_clean", async () => {
  const s = testing.state();
  const [repo, t0, wt, branch] = await task_with_work(s);
  const remove = () => remove_if_merged(s, t0.id, true);

  assert.deepEqual(await remove(), kept("it isn't done"));
  db.update_task(s.db(), t0.id, [["status", "done"]]);
  assert.deepEqual(await remove(), kept("its work isn't merged into master"));
  sh(repo, ["merge", "-q", "--no-ff", "-m", "merge", branch]);
  // Untracked files would be lost, even when git status is set not to show them; ignored ones (build output) wouldn't matter.
  sh(repo, ["config", "status.showUntrackedFiles", "no"]);
  writeFileSync(join(wt, "notes"), "n");
  assert.deepEqual(await remove(), kept("it has 1 uncommitted or untracked file"));
  unlinkSync(join(wt, "notes"));
  mkdirSync(join(wt, "target"), { recursive: true });
  writeFileSync(join(wt, "target/out"), "o");
  assert.deepEqual(await remove(), removed("master"));

  assert.ok(!existsSync(wt));
  let t = db.get_task(s.db(), t0.id)!;
  assert.deepEqual([t.status, t.worktree_state, t.branch], ["done", "none", branch]);
  assert.ok((await git(repo, ["rev-parse", "--verify", `refs/heads/${branch}`])).ok);
  assert.deepEqual(await remove(), kept("it has no worktree"));

  // Run again (after a rename), it gets its folder back, on its branch.
  db.update_task(s.db(), t.id, [
    ["title", "Renamed"],
    ["status", "in_progress"],
  ]);
  t = await setup(s, t.id);
  assert.equal(t.worktree_path, path_str(wt));
  assert.equal(await current_branch(wt), branch);

  // The project's sweep removes it once it's done again, and leaves other tasks alone.
  const pid = t.project_id!;
  let other = api.create_task_inner(s, pid, ct("Other"));
  other = await setup(s, other.id);
  assert.deepEqual(await remove_merged(s, pid), []);
  db.update_task(s.db(), t.id, [["status", "done"]]);
  const results = await remove_merged(s, pid);
  assert.equal(results.length, 1);
  assert.deepEqual([results[0].task_id, results[0].removed, results[0].detail], [t.id, true, "merged into master"]);
  assert.ok(!existsSync(wt));
  assert.ok(existsSync(other.worktree_path!));
});

test("a_branch_merged_upstream_counts_as_merged", async () => {
  const s = testing.state();
  const root = testing.temp_dir();
  const origin = join(root, "origin"),
    repo = join(root, "repo"),
    other = join(root, "other");
  sh(root, ["init", "-q", "--bare", "-b", "master", path_str(origin)]);
  sh(root, ["clone", "-q", path_str(origin), path_str(repo)]);
  sh(repo, ["commit", "-q", "--allow-empty", "-m", "init"]);
  sh(repo, ["push", "-q", "-u", "origin", "master"]);
  const p = await project_on(s, repo);
  let t = api.create_task_inner(s, p.id, ct("Do it"));
  t = await setup(s, t.id);
  const wt = t.worktree_path!,
    branch = t.branch!;
  sh(wt, ["commit", "-q", "--allow-empty", "-m", "work"]);
  sh(wt, ["push", "-q", "origin", branch]);
  db.update_task(s.db(), t.id, [["status", "done"]]);
  assert.deepEqual(await remove_if_merged(s, t.id, true), kept("its work isn't merged into master"));

  // Merged elsewhere (as a pull request is), so the local master is behind.
  sh(root, ["clone", "-q", path_str(origin), path_str(other)]);
  sh(other, ["merge", "-q", "--no-ff", "-m", "merge", `origin/${branch}`]);
  sh(other, ["push", "-q", "origin", "master"]);
  // The sweep fetches it.
  const results = await remove_merged(s, p.id);
  assert.deepEqual([results[0].removed, results[0].detail], [true, "merged into origin/master"]);
  assert.ok(!existsSync(wt));
});

// HA-32: setup took over any folder at the worktree's path, and a forced teardown removed whatever was there when git
// wouldn't, so a shared or misconfigured worktrees folder could cost work kept elsewhere.
test("a_folder_in_the_worktrees_way_is_neither_adopted_nor_removed", async () => {
  const s = testing.state();
  const root = testing.temp_dir();
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  sh(repo, ["init", "-q", "-b", "master"]);
  writeFileSync(join(repo, "notes"), "1");
  sh(repo, ["add", "notes"]);
  sh(repo, ["commit", "-qm", "init"]);
  const p = await project_on(s, repo);
  let t = api.create_task_inner(s, p.id, ct("fix it"));
  // Someone's folder where the task's worktree would go.
  const wt = join(p.worktrees_root, folder_name(p, t));
  mkdirSync(wt, { recursive: true });
  writeFileSync(join(wt, "precious"), "mine");
  const err = (await fails(setup(s, t.id))).message;
  assert.ok(err.includes("in the way"), err);
  assert.equal(readFileSync(join(wt, "precious"), "utf8"), "mine");
  t = db.get_task(s.db(), t.id)!;
  assert.deepEqual([t.worktree_state, t.worktree_path], ["error", null], "the failure is the task's to show, the folder nobody's");

  // Only a folder inside the worktrees folder, other than a main checkout, is removed by hand.
  assert.ok(await removable_by_hand(p, repo, wt), "a stray folder in the worktrees folder");
  assert.ok(!(await removable_by_hand(p, repo, repo)), "the repository");
  assert.ok(!(await removable_by_hand(p, repo, root)), "outside the worktrees folder");
  assert.ok(!(await removable_by_hand(p, repo, p.worktrees_root)), "the worktrees folder itself");
  const checkout = join(p.worktrees_root, "checkout");
  sh(root, ["clone", "-q", path_str(repo), path_str(checkout)]);
  assert.ok(!(await removable_by_hand(p, repo, checkout)), "another main checkout");
});

test("a_task_with_commits_its_base_lacks_is_unmerged", async () => {
  const s = testing.state();
  const repo = testing.temp_dir();
  sh(repo, ["init", "-q", "-b", "master"]);
  sh(repo, ["commit", "-q", "--allow-empty", "-m", "init"]);
  const p = await project_on(s, repo);
  let t = api.create_task_inner(s, p.id, ct("Do it"));
  t = await setup(s, t.id);
  const wt = t.worktree_path!,
    branch = t.branch!;
  // Nothing done yet.
  assert.ok(!(await unmerged(s, t)));
  writeFileSync(join(wt, "notes"), "1");
  assert.ok(await unmerged(s, t));
  sh(wt, ["add", "notes"]);
  sh(wt, ["commit", "-qm", "work"]);
  assert.ok(await unmerged(s, t));
  // A document is kept by the board, not merged.
  const doc = db.update_task(s.db(), t.id, [["task_type", "plan"]])!;
  assert.ok(!(await unmerged(s, doc)));
  t = db.update_task(s.db(), t.id, [["task_type", null]])!;
  sh(repo, ["merge", "-q", "--no-ff", "-m", "merge", branch]);
  assert.ok(!(await unmerged(s, t)));
});

function log_texts(s: AppState, task_id: string): string[] {
  return testing
    .messages(s.db(), task_id)
    .filter((m) => m.kind === "event")
    .map((m) => (typeof m.data?.text === "string" ? m.data.text : ""));
}

test("task_branches_start_from_the_latest_base", async () => {
  const s = testing.state();
  const root = testing.temp_dir();
  const origin = join(root, "origin"),
    repo = join(root, "repo"),
    other = join(root, "other");
  sh(root, ["init", "-q", "--bare", "-b", "master", path_str(origin)]);
  sh(root, ["clone", "-q", path_str(origin), path_str(repo)]);
  writeFileSync(join(repo, "notes"), "1");
  sh(repo, ["add", "notes"]);
  sh(repo, ["commit", "-qm", "init"]);
  sh(repo, ["push", "-q", "-u", "origin", "master"]);
  sh(root, ["clone", "-q", path_str(origin), path_str(other)]);
  // Someone else pushes to master.
  const push = (file: string) => {
    writeFileSync(join(other, file), new_id());
    sh(other, ["add", file]);
    sh(other, ["commit", "-qm", file]);
    sh(other, ["push", "-q", "origin", "HEAD"]);
    return rev(other, "HEAD");
  };
  const p = await project_on(s, repo);
  // A task's worktree: the task, the commit it starts from, whether its branch tracks anything, and its log's warnings
  // and notes. It has nothing of its own to show or merge.
  const task = async (title: string, base: string | null): Promise<[Task, string, boolean, string]> => {
    let t = api.create_task_inner(s, p.id, ct(title));
    db.update_task(s.db(), t.id, [["base_branch", base]]);
    t = await setup(s, t.id);
    const wt = t.worktree_path!;
    const tracks = (await git(wt, ["rev-parse", "--abbrev-ref", "@{upstream}"])).ok;
    const log = log_texts(s, t.id);
    assert.ok(!(await has_work_to_merge(s, t)), title);
    const d = await diff(s, t.id);
    assert.deepEqual([d.merge_base, d.commits, d.patch], [rev(wt, "HEAD"), "", ""], title);
    return [t, rev(wt, "HEAD"), tracks, log.join("\n")];
  };
  const compared = (base: string) => compare_ref(repo, base);

  // The main checkout is on master, with a change in the way of pulling it.
  let latest = push("notes");
  writeFileSync(join(repo, "notes"), "mine");
  let [, head, tracks, log] = await task("Dirty", null);
  assert.equal(head, latest, log);
  assert.equal(await compared("master"), "origin/master");
  assert.ok(!tracks);
  assert.ok(log.includes("Branching from origin/master, 1 commit ahead of master, which couldn't be fast-forwarded"), log);
  assert.ok(log.includes("(from origin/master)"), log);
  assert.notEqual(rev(repo, "master"), latest);
  assert.equal(readFileSync(join(repo, "notes"), "utf8"), "mine");

  // Clean, it's pulled.
  sh(repo, ["checkout", "-q", "notes"]);
  latest = push("b");
  [, head, , log] = await task("Clean", null);
  assert.deepEqual([head, rev(repo, "master")], [latest, latest]);
  assert.equal(await compared("master"), "master");
  assert.ok(log.includes("Pulled master from origin/master (2 new commits)"), log);

  // Local commits that aren't pushed are kept.
  sh(repo, ["commit", "-q", "--allow-empty", "-m", "local"]);
  const local = rev(repo, "master");
  [, head, , log] = await task("Ahead", null);
  assert.equal(head, local, log);
  assert.equal(await compared("master"), "master");

  // Diverged: the upstream, where its pull request goes.
  latest = push("c");
  [, head, , log] = await task("Diverged", null);
  assert.equal(head, latest);
  assert.equal(await compared("master"), "origin/master");
  assert.ok(log.includes("master has diverged from origin/master; branching from origin/master, without the 1 commit only master has"), log);
  assert.equal(rev(repo, "master"), local);

  // Pushed without -u, the branch of the same name on origin counts.
  sh(repo, ["reset", "-q", "--hard", "origin/master"]);
  sh(repo, ["branch", "-q", "--unset-upstream"]);
  latest = push("d");
  [, head, , log] = await task("No upstream", null);
  assert.equal(head, latest, log);
  assert.equal(await compared("master"), "master");

  // A base branch only on the remote.
  sh(other, ["push", "-q", "origin", "HEAD:dev"]);
  let t: Task;
  [t, head, tracks, log] = await task("Remote only", "dev");
  assert.equal(head, latest, log);
  assert.ok(!tracks && log.includes("(from origin/dev)"), log);
  assert.equal(await compared("dev"), "origin/dev");
  // Its work shows up in its diff.
  const wt = t.worktree_path!;
  writeFileSync(join(wt, "feature"), "f");
  sh(wt, ["add", "feature"]);
  sh(wt, ["commit", "-qm", "feature"]);
  const d = await diff(s, t.id);
  assert.equal(d.merge_base, latest);
  assert.equal(d.commits.split("\n").filter((l: string) => l).length, 1);
  assert.ok(d.patch.includes("+++ b/feature"));

  // Unreachable, it goes by the last fetch.
  sh(repo, ["remote", "set-url", "origin", path_str(join(root, "gone"))]);
  push("e");
  [, head, , log] = await task("Offline", null);
  assert.equal(head, latest, log);
  assert.ok(log.includes("Could not fetch origin/master; branching from the copy fetched before"), log);
});

/**
 * A repository cloned from a bare `origin`, with a commit on master pushed, and another clone of it to push from as
 * someone else would; a project on it with key X.
 */
async function stacking_repo(s: AppState): Promise<[string, string, string, Project]> {
  const root = testing.temp_dir();
  const origin = join(root, "origin"),
    repo = join(root, "repo"),
    other = join(root, "other");
  sh(root, ["init", "-q", "--bare", "-b", "master", path_str(origin)]);
  sh(root, ["clone", "-q", path_str(origin), path_str(repo)]);
  writeFileSync(join(repo, "notes"), "1");
  sh(repo, ["add", "notes"]);
  sh(repo, ["commit", "-qm", "init"]);
  sh(repo, ["push", "-q", "-u", "origin", "master"]);
  sh(root, ["clone", "-q", path_str(origin), path_str(other)]);
  const p = await project_on(s, repo);
  return [root, repo, other, p];
}

/** Commit a new file `name` in `dir`, returning the commit. */
function commit_file(dir: string, name: string): string {
  writeFileSync(join(dir, name), new_id());
  sh(dir, ["add", name]);
  sh(dir, ["commit", "-qm", name]);
  return rev(dir, "HEAD");
}

function log_of(s: AppState, task_id: string): string {
  return log_texts(s, task_id).join("\n");
}

/** The files a task's Changes tab shows. */
async function changed_files(s: AppState, task_id: string): Promise<string[]> {
  const d = await diff(s, task_id);
  return (d.patch as string)
    .split("\n")
    .filter((l) => l.startsWith("+++ b/"))
    .map((l) => l.slice("+++ b/".length));
}

const patch_task = (s: AppState, id: string, body: any) => api.update_task_inner(s, id, body);

test("a_task_stacked_on_another_starts_from_its_branch_and_compares_with_it", async () => {
  const s = testing.state();
  const [, repo, , p] = await stacking_repo(s);
  const make = (title: string, from?: any) => api.create_task_inner(s, p.id, ct(title, from !== undefined ? { start_from: from } : {}));

  const a = await setup(s, make("First").id);
  const a_wt = a.worktree_path!;
  commit_file(a_wt, "a-file");
  const a_branch = a.branch!;

  // Stacked on it by its key: from its branch, which it's compared with (and its pull request targets).
  let b = make("Second", "x-1");
  assert.deepEqual(b.start_from, { type: "task", task_id: a.id });
  b = await setup(s, b.id);
  const b_wt = b.worktree_path!;
  assert.equal(rev(b_wt, "HEAD"), rev(a_wt, "HEAD"));
  assert.equal(b.base_branch, a_branch);
  assert.ok(log_of(s, b.id).includes("Stacked on X-1: starting from its branch"), log_of(s, b.id));
  assert.ok(!(await has_work_to_merge(s, b)));
  commit_file(b_wt, "b-file");
  assert.deepEqual(await changed_files(s, b.id), ["b-file"]);
  assert.ok(await has_work_to_merge(s, b));
  // It started where it did: what it starts from can't change now, even once the worktree is gone.
  await fails(patch_task(s, b.id, { start_from: null }));

  // A task to stack on with no branch yet has its worktree set up first.
  let c = make("Third");
  const d = await setup(s, make("Fourth", `task:${c.id}`).id);
  c = db.get_task(s.db(), c.id)!;
  assert.equal(c.worktree_state, "ready");
  assert.equal(d.base_branch, c.branch);
  assert.ok(log_of(s, d.id).includes("Setting up X-3's worktree first"));

  // Merged into master by way of First's branch: Second's worktree goes, though First's branch doesn't have its work.
  sh(repo, ["merge", "-q", "--ff-only", b.branch!]);
  db.update_task(s.db(), b.id, [["status", "done"]]);
  assert.deepEqual(await remove_if_merged(s, b.id, false), removed("master"));

  // Once First is merged, a task stacked on it starts from where it went.
  db.update_task(s.db(), a.id, [["status", "done"]]);
  const e = await setup(s, make("Fifth", "X-1").id);
  assert.equal(e.base_branch, "master");
  assert.equal(rev(e.worktree_path!, "HEAD"), rev(repo, "master"));
  assert.ok(log_of(s, e.id).includes("X-1 is merged already, so starting from master"));
});

test("a_stacked_task_keeps_its_base_when_its_setup_script_fails", async () => {
  const s = testing.state();
  const [, , , p] = await stacking_repo(s);
  const a = await setup(s, api.create_task_inner(s, p.id, ct("First")).id);
  let b = api.create_task_inner(s, p.id, ct("Second", { start_from: "X-1" }));
  db.update_project(s.db(), p.id, [["setup_script", "exit 1"]]);
  await fails(setup(s, b.id));
  const failed = db.get_task(s.db(), b.id)!;
  assert.deepEqual([failed.worktree_state, failed.base_branch], ["error", a.branch]);
  // Its branch is made, so what it starts from can't change now.
  const e = await fails(patch_task(s, b.id, { start_from: "master" }));
  assert.equal(e.status, 409);
  // Set up again once the script is fixed, it's still stacked on First.
  db.update_project(s.db(), p.id, [["setup_script", ""]]);
  b = await setup(s, b.id);
  assert.equal(b.base_branch, a.branch);
});

test("a_subproject_cant_start_from_its_own_task", async () => {
  const s = testing.state();
  const [, , , p] = await stacking_repo(s);
  const sp = api.create_task_inner(s, p.id, ct("Sub", { subproject: true }));
  const child = api.create_task_inner(s, p.id, ct("Part", { parent_id: sp.id }));
  const other = api.create_task_inner(s, p.id, ct("Other", { start_from: `task:${child.id}` }));
  for (const from of [child.id, other.id]) {
    const err = await fails(patch_task(s, sp.id, { start_from: `task:${from}` }));
    assert.ok(err.message.includes("needs this task's worktree first"), err.message);
  }
  // Had it got there some other way, setting up says so rather than waiting on itself.
  db.update_task(s.db(), sp.id, [["start_from", { type: "task", task_id: other.id }]]);
  const err = (await fails(setup(s, sp.id))).message;
  assert.ok(err.includes("start from it"), err);
});

test("a_stacked_task_merges_where_the_task_it_stacks_on_went", async () => {
  const s = testing.state();
  const [, repo, , p] = await stacking_repo(s);
  const a = await setup(s, api.create_task_inner(s, p.id, ct("First")).id);
  commit_file(a.worktree_path!, "parent-file");
  let b = api.create_task_inner(s, p.id, ct("Second", { start_from: "X-1" }));
  b = await setup(s, b.id);
  const b_wt = b.worktree_path!;
  commit_file(b_wt, "child-file");

  // First is squashed into master and done: Second now merges into master, and its changes are still only its own,
  // before and after it's rebased onto master.
  sh(repo, ["merge", "-q", "--squash", a.branch!]);
  sh(repo, ["commit", "-qm", "First"]);
  db.update_task(s.db(), a.id, [["status", "done"]]);
  assert.equal(db.task_base(s.db(), b, p), "master");
  assert.deepEqual(await changed_files(s, b.id), ["child-file"]);
  assert.equal((await diff(s, b.id)).base, "master");
  sh(b_wt, ["rebase", "-q", "--onto", "master", a.branch!]);
  assert.deepEqual(await changed_files(s, b.id), ["child-file"]);
  assert.equal((await diff(s, b.id)).merge_base, rev(repo, "master"));
  // And with First's branch gone too.
  sh(repo, ["worktree", "remove", "--force", a.worktree_path!]);
  sh(repo, ["branch", "-q", "-D", a.branch!]);
  assert.deepEqual(await changed_files(s, b.id), ["child-file"]);
});

test("a_task_started_from_a_merged_task_goes_where_that_went", async () => {
  // Third is made as Second is merged into First, or once First is merged into master too.
  for (const after_first of [false, true]) {
    const s = testing.state();
    const [, repo, , p] = await stacking_repo(s);
    const make = (title: string, from: string) => api.create_task_inner(s, p.id, ct(title, { start_from: from }));
    const a = await setup(s, api.create_task_inner(s, p.id, ct("First")).id);
    const a_wt = a.worktree_path!,
      a_branch = a.branch!;
    commit_file(a_wt, "parent-file");
    const b = await setup(s, make("Second", "X-1").id);
    commit_file(b.worktree_path!, "child-file");
    // Second is squashed into First and done.
    sh(a_wt, ["merge", "-q", "--squash", b.branch!]);
    sh(a_wt, ["commit", "-qm", "Second"]);
    db.update_task(s.db(), b.id, [["status", "done"]]);
    const first_merged = async () => {
      sh(repo, ["merge", "-q", "--squash", a_branch]);
      sh(repo, ["commit", "-qm", "First"]);
      db.update_task(s.db(), a.id, [["status", "done"]]);
      await teardown(s, a.id, true, true);
    };
    if (after_first) await first_merged();
    let c = await setup(s, make("Third", "X-2").id);
    const c_wt = c.worktree_path!;
    const went = after_first ? "master" : a_branch;
    assert.equal(c.base_branch, went, String(after_first));
    assert.ok(log_of(s, c.id).includes(`X-2 is merged already, so starting from ${went}`), log_of(s, c.id));
    assert.equal(rev(c_wt, "HEAD"), rev(repo, went));
    commit_file(c_wt, "third-file");
    // First is merged afterwards: Third goes to master too.
    if (!after_first) await first_merged();
    c = db.get_task(s.db(), c.id)!;
    assert.equal(db.task_base(s.db(), c, p), "master", String(after_first));
    assert.deepEqual(await changed_files(s, c.id), ["third-file"], String(after_first));
  }
});

test("a_stacked_task_keeps_its_own_changes_when_the_branch_it_stacks_on_is_deleted", async () => {
  // Second takes in some of First's later work, and the board hears of it as Second's run ends, as First is done or as
  // First's worktree and branch are removed, without anyone reading Second's changes before First's branch is gone.
  for (const how of ["run", "done", "teardown"]) {
    const s = testing.state();
    const [, repo, , p] = await stacking_repo(s);
    const a = await setup(s, api.create_task_inner(s, p.id, ct("First")).id);
    const a_wt = a.worktree_path!;
    commit_file(a_wt, "parent-file");
    let b = api.create_task_inner(s, p.id, ct("Second", { start_from: "X-1" }));
    b = await setup(s, b.id);
    const b_wt = b.worktree_path!;
    const a_branch = a.branch!;
    const taken_in = commit_file(a_wt, "more-parent-file");
    sh(b_wt, ["merge", "-q", "--no-edit", a_branch]);
    commit_file(b_wt, "child-file");
    // First moves on again, past what Second took in.
    commit_file(a_wt, "latest-parent-file");
    // Until the board has moved Second's start on to what it took in of First.
    const moved = async () => {
      const deadline = Date.now() + 10_000;
      while ((await commit(repo, start_ref(b.id))) !== taken_in) {
        if (Date.now() > deadline) assert.fail(`Second's start didn't move on (${how})`);
        await sleep(20);
      }
    };
    if (how === "run") {
      // Second's agent did that, and its run ends.
      runs.TEST_CAN_RUN.set(true);
      try {
        runner.send(s, b.id, "take in First's work");
        const run = s.runs.get(b.id)!.run_id;
        runner.on_exit(s, run, 0, null, null, "");
      } finally {
        runs.TEST_CAN_RUN.set(false);
      }
      await moved();
    }

    // First is squashed into master, done, and its branch deleted (pushed and fetched too), before Second is brought up
    // to date: its changes are still only its own.
    sh(repo, ["merge", "-q", "--squash", a_branch]);
    sh(repo, ["commit", "-qm", "First"]);
    sh(repo, ["push", "-q", "origin", "master", `${a_branch}:${a_branch}`]);
    sh(repo, ["fetch", "-q", "origin"]);
    if (how === "done") {
      s.update_task(a.id, [["status", "done"]]);
      await moved();
    } else db.update_task(s.db(), a.id, [["status", "done"]]);
    if (how === "teardown") await teardown(s, a.id, true, true);
    else {
      sh(repo, ["worktree", "remove", "--force", path_str(a_wt)]);
      sh(repo, ["branch", "-q", "-D", a_branch]);
    }
    assert.equal(await commit(repo, `refs/heads/${a_branch}`), null);
    sh(repo, ["push", "-q", "origin", "--delete", a_branch]);
    sh(repo, ["fetch", "-q", "--prune", "origin"]);
    assert.deepEqual(await changed_files(s, b.id), ["child-file"], how);
    // So do a review and a summary, which compare with the same commit, rather than the pull request's diff, which would
    // have First's later work.
    let [, start] = await changes_base(s, b_wt, b, p);
    assert.equal(start, rev(b_wt, "HEAD~1"), how);
    assert.deepEqual(await work_scope(s, b_wt, b, p), [taken_in, true], how);
    // And its branch's, with its worktree removed.
    await teardown(s, b.id, false, false);
    assert.deepEqual(await changed_files(s, b.id), ["child-file"], how);
    await setup(s, b.id);

    // Rebased onto master (First's commits dropped), it's compared with master.
    sh(b_wt, ["rebase", "-q", "--onto", "master", "HEAD~1"]);
    assert.deepEqual(await changed_files(s, b.id), ["child-file"], how);
    assert.equal((await diff(s, b.id)).merge_base, rev(repo, "master"));
    [, start] = await changes_base(s, b_wt, b, p);
    assert.equal(start, rev(repo, "master"), how);
    // And its pull request's diff is its own again.
    assert.deepEqual(await work_scope(s, b_wt, b, p), [rev(repo, "master"), false], how);

    // Deleting the task drops what it kept.
    await api.delete_task_inner(s, b, false);
    assert.equal(await commit(repo, start_ref(b.id)), null);
  }
});

test("a_remotes_branch_is_that_remotes", async () => {
  const s = testing.state();
  const [root, repo, other, p] = await stacking_repo(s);
  // Another remote with a feature branch of its own, and origin's, neither fetched.
  const fork = join(root, "fork");
  sh(root, ["clone", "-q", "--bare", path_str(join(root, "origin")), path_str(fork)]);
  sh(repo, ["remote", "add", "upstream", path_str(fork)]);
  sh(other, ["checkout", "-q", "-b", "feature"]);
  const theirs = commit_file(other, "fork-file");
  sh(other, ["push", "-q", path_str(fork), "feature"]);
  sh(other, ["reset", "-q", "--hard", "origin/master"]);
  const ours = commit_file(other, "origin-file");
  sh(other, ["push", "-q", "origin", "feature"]);
  const make = (title: string, from: string) => api.create_task_inner(s, p.id, ct(title, { start_from: from }));

  // Upstream's isn't a branch this task's pull request, which goes to origin's repository, can target: it starts from
  // its latest commit, and its pull request targets master.
  let t = await setup(s, make("Fork's", "upstream/feature").id);
  const wt = t.worktree_path!;
  assert.deepEqual([rev(wt, "HEAD"), t.base_branch], [theirs, "master"]);
  assert.ok(log_of(s, t.id).includes("upstream/feature is on upstream, which this task's pull request doesn't go to"), log_of(s, t.id));
  commit_file(wt, "mine");
  assert.deepEqual(await changed_files(s, t.id), ["mine"]);
  t = db.get_task(s.db(), t.id)!;
  assert.ok(await has_work_to_merge(s, t));
  // What its agent is told, with origin and upstream different repositories on GitHub.
  sh(repo, ["remote", "set-url", "--push", "origin", "https://github.com/o/origin.git"]);
  sh(repo, ["remote", "set-url", "--push", "upstream", "https://github.com/o/upstream.git"]);
  const gh = (await github(repo, t.base_branch))!;
  const told = runner.system_prompt(t, p, null, [], [], gh, true);
  const branch = t.branch!;
  assert.ok(told.includes(`pr_create with repo \`o/origin\`, head \`${branch}\` and base \`master\``), told);
  assert.ok(!told.includes("upstream/feature"), told);
  // A review and a summary read its changes from where it started, not its pull request's diff.
  assert.deepEqual(await work_scope(s, wt, t, p), [theirs, true]);

  // Origin's, never fetched: fetched, and its pull request goes to feature there.
  t = await setup(s, make("Origin's", "origin/feature").id);
  assert.deepEqual([rev(t.worktree_path!, "HEAD"), t.base_branch], [ours, "feature"]);
});

test("a_task_can_start_from_a_commit_or_a_remote_branch", async () => {
  const s = testing.state();
  const [, repo, other, p] = await stacking_repo(s);
  const make = (title: string, from: any) => api.create_task_inner(s, p.id, ct(title, { start_from: from }));
  const first = rev(repo, "master");
  commit_file(repo, "later");

  // An older commit of master, by a short SHA: it starts there, and merges into master.
  let t = make("Old", first.slice(0, 8));
  assert.deepEqual(t.start_from, { type: "commit", commit: first.slice(0, 8) });
  t = await setup(s, t.id);
  let wt = t.worktree_path!;
  assert.deepEqual([rev(wt, "HEAD"), t.base_branch], [first, "master"]);
  assert.ok(log_of(s, t.id).includes(`Starting from commit ${first.slice(0, 12)}`));

  // A commit on a branch master doesn't have: its changes are only what's after it.
  sh(repo, ["checkout", "-q", "-b", "side", first]);
  const side = commit_file(repo, "side-file");
  sh(repo, ["checkout", "-q", "master"]);
  t = await setup(s, make("Side", `commit:${side}`).id);
  wt = t.worktree_path!;
  commit_file(wt, "mine");
  assert.deepEqual(await changed_files(s, t.id), ["mine"]);
  assert.equal((await diff(s, t.id)).merge_base, side);

  // A commit only on the remote, by its full SHA, is fetched.
  sh(other, ["checkout", "-q", "-b", "elsewhere"]);
  const elsewhere = commit_file(other, "elsewhere-file");
  sh(other, ["push", "-q", "origin", "elsewhere"]);
  sh(other, ["push", "-q", "origin", "--delete", "elsewhere"]);
  sh(other, ["push", "-q", "origin", "elsewhere:refs/keep/elsewhere"]);
  t = await setup(s, make("Fetched", elsewhere).id);
  assert.equal(rev(t.worktree_path!, "HEAD"), elsewhere);
  // One that's nowhere fails, saying so.
  t = make("Nowhere", "deadbeefdeadbeef");
  const err = (await fails(setup(s, t.id))).message;
  assert.ok(err.includes("commit deadbeefdeadbeef isn't in the repository (give its full SHA to fetch it)"), err);
  assert.equal(db.get_task(s.db(), t.id)!.worktree_state, "error");
  // It can be put right, and set up again.
  t = await patch_task(s, t.id, { start_from: first.slice(0, 8) });
  assert.deepEqual([t.worktree_state, t.worktree_error], ["none", null]);
  assert.equal(rev((await setup(s, t.id)).worktree_path!, "HEAD"), first);

  // A branch only on the remote, named with it, is that branch: fetched, and its base.
  sh(other, ["checkout", "-q", "-b", "feature", "origin/master"]);
  const feature = commit_file(other, "feature-file");
  sh(other, ["push", "-q", "origin", "feature"]);
  sh(repo, ["fetch", "-q", "origin"]);
  t = await setup(s, make("Feature", "origin/feature").id);
  assert.deepEqual([rev(t.worktree_path!, "HEAD"), t.base_branch], [feature, "feature"]);
});

/** Writes a fake gh to `path`. */
function fake_gh(path: string, script: string) {
  writeFileSync(path, script);
  chmodSync(path, 0o755);
}

test("a_task_can_start_from_a_pull_request", async () => {
  const s = testing.state();
  const [root, repo, other, p] = await stacking_repo(s);
  // On GitHub as far as the board can tell, with gh faked.
  sh(repo, ["remote", "set-url", "--push", "origin", "git@github.com:o/r.git"]);
  sh(other, ["checkout", "-q", "-b", "feature"]);
  const feature = commit_file(other, "feature-file");
  sh(other, ["push", "-q", "origin", "feature"]);
  sh(other, ["checkout", "-q", "-b", "fork", "master"]);
  const fork = commit_file(other, "fork-file");
  sh(other, ["push", "-q", "origin", "fork:refs/pull/8/head"]);
  const gh = join(root, "gh");
  const pr = (state: string, head: string, oid: string, cross: boolean) =>
    `{"state":"${state}","headRefName":"${head}","baseRefName":"master","headRefOid":"${oid}","isCrossRepository":${cross}}`;
  fake_gh(
    gh,
    `#!/bin/sh\necho "$@" >> ${path_str(join(root, "gh.log"))}\ncase "$3" in\n` +
      `7) echo '${pr("OPEN", "feature", feature, false)}' ;;\n8) echo '${pr("OPEN", "patch-1", fork, true)}' ;;\n` +
      `9) echo '${pr("MERGED", "done", feature, false)}' ;;\n*) echo 'no such pull request' >&2; exit 1 ;;\nesac\n`,
  );
  pr_testing.GH = gh;
  try {
    const make = (title: string, from: string) => api.create_task_inner(s, p.id, ct(title, { start_from: from }));

    // An open one from the repository: its branch, which its pull request targets.
    let t = make("On a PR", "#7");
    assert.deepEqual(t.start_from, { type: "pull_request", number: 7 });
    t = await setup(s, t.id);
    const wt = t.worktree_path!;
    assert.deepEqual([rev(wt, "HEAD"), t.base_branch], [feature, "feature"]);
    assert.ok(readFileSync(join(root, "gh.log"), "utf8").includes("pr view 7 --repo o/r --json"));
    commit_file(wt, "mine");
    assert.deepEqual(await changed_files(s, t.id), ["mine"]);

    // From a fork: its head commit, fetched, on top of its base.
    t = await setup(s, make("On a fork's PR", "https://github.com/o/r/pull/8/files").id);
    assert.deepEqual([rev(t.worktree_path!, "HEAD"), t.base_branch], [fork, "master"]);
    assert.ok(log_of(s, t.id).includes("Pull request #8 is from a fork"));
    // Merged: where it went.
    t = await setup(s, make("On a merged PR", "pr:9").id);
    assert.equal(t.base_branch, "master");
    // One in another repository, or that gh can't find, fails.
    let err = (await fails(setup(s, make("Elsewhere", "https://github.com/o/other/pull/7").id))).message;
    assert.ok(err.includes("pull request #7 is in o/other, not in the project's repository o/r"), err);
    err = (await fails(setup(s, make("Missing", "#10").id))).message;
    assert.ok(err.includes("couldn't read pull request #10 of o/r with gh"), err);
  } finally {
    pr_testing.GH = null;
  }
});

test("a_pull_request_is_looked_up_where_the_projects_tasks_open_theirs", async () => {
  const s = testing.state();
  const [root, repo, other, p] = await stacking_repo(s);
  // Origin and upstream are different repositories on GitHub, and master follows upstream's, so the project's tasks open
  // their pull requests there.
  const up = join(root, "upstream");
  sh(root, ["clone", "-q", "--bare", path_str(join(root, "origin")), path_str(up)]);
  sh(repo, ["remote", "add", "upstream", path_str(up)]);
  sh(repo, ["remote", "set-url", "--push", "origin", "git@github.com:o/origin.git"]);
  sh(repo, ["remote", "set-url", "--push", "upstream", "git@github.com:o/upstream.git"]);
  sh(repo, ["fetch", "-q", "upstream"]);
  sh(repo, ["branch", "-q", "-u", "upstream/master", "master"]);
  sh(other, ["checkout", "-q", "-b", "feature"]);
  const feature = commit_file(other, "feature-file");
  sh(other, ["push", "-q", path_str(up), "feature"]);
  const gh = join(root, "gh");
  const pr = `{"state":"OPEN","headRefName":"feature","baseRefName":"master","headRefOid":"${feature}","isCrossRepository":false}`;
  const log = join(root, "gh.log");
  fake_gh(
    gh,
    `#!/bin/sh\necho "$@" >> ${path_str(log)}\ncase "$3 $5" in\n'7 o/upstream') echo '${pr}' ;;\n*) echo 'no such pull request' >&2; exit 1 ;;\nesac\n`,
  );
  pr_testing.GH = gh;
  try {
    const make = (title: string, from: string) => api.create_task_inner(s, p.id, ct(title, { start_from: from }));
    const told = async (t: Task) => {
      const g = (await github(repo, t.base_branch))!;
      return runner.system_prompt(t, p, null, [], [], g, true);
    };

    // Its branch isn't one `feature` alone follows here (that would be origin's): its head commit, fetched from upstream,
    // on top of its base, where the task's pull request goes.
    for (const from of ["https://github.com/o/upstream/pull/7", "#7"]) {
      const t = await setup(s, make("On upstream's PR", from).id);
      assert.deepEqual([rev(t.worktree_path!, "HEAD"), t.base_branch], [feature, "master"], from);
      assert.ok(log_of(s, t.id).includes("Pull request #7 has its branch on upstream"), log_of(s, t.id));
      const text = await told(t);
      assert.ok(text.includes(`repo \`o/upstream\`, head \`${t.branch}\` and base \`master\``), text);
    }
    assert.ok(
      readFileSync(log, "utf8")
        .split("\n")
        .filter((l) => l)
        .every((l) => l.includes("--repo o/upstream")),
    );
    // With a local feature that follows upstream's, it's that branch, and the task's pull request targets it there.
    sh(repo, ["fetch", "-q", "upstream"]);
    sh(repo, ["branch", "-q", "--track", "feature", "upstream/feature"]);
    const t = await setup(s, make("On upstream's branch", "#7").id);
    assert.equal(t.base_branch, "feature");
    const text = await told(t);
    assert.ok(text.includes(`repo \`o/upstream\`, head \`${t.branch}\` and base \`feature\``), text);
  } finally {
    pr_testing.GH = null;
  }
});

test("a_stacked_task_still_goes_where_its_merged_parent_went_once_that_is_deleted", async () => {
  const s = testing.state();
  const [, repo, , p] = await stacking_repo(s);
  sh(repo, ["remote", "set-url", "--push", "origin", "git@github.com:o/r.git"]);
  let a = await setup(s, api.create_task_inner(s, p.id, ct("First")).id);
  const a_tip = commit_file(a.worktree_path!, "parent-file");
  const make = (title: string) => api.create_task_inner(s, p.id, ct(title, { start_from: "X-1" }));
  let b = await setup(s, make("Second").id);
  commit_file(b.worktree_path!, "child-file");
  // Third isn't set up yet.
  let c = make("Third");

  // First is squashed into master, done, torn down with its branch, and deleted.
  sh(repo, ["merge", "-q", "--squash", a.branch!]);
  sh(repo, ["commit", "-qm", "First"]);
  s.update_task(a.id, [["status", "done"]]);
  await teardown(s, a.id, true, true);
  a = db.get_task(s.db(), a.id)!;
  await api.delete_task_inner(s, a, false);

  // Second goes to master, its changes still only its own.
  b = db.get_task(s.db(), b.id)!;
  assert.deepEqual([b.base_branch, b.start_from], ["master", { type: "commit", commit: a_tip }]);
  assert.equal(db.task_base(s.db(), b, p), "master");
  assert.deepEqual(await changed_files(s, b.id), ["child-file"]);
  assert.ok(log_of(s, b.id).includes("X-1, which this task was stacked on, was deleted: it's merged, so this task goes to master"), log_of(s, b.id));
  // Its agent is told its pull request targets master, and not that it's stacked.
  const gh = (await github(repo, b.base_branch))!;
  const told = runner.system_prompt(b, p, null, [], [], gh, true);
  assert.ok(told.includes(`head \`${b.branch}\` and base \`master\``) && !told.includes("stacked"), told);
  // Third is a task on master.
  c = db.get_task(s.db(), c.id)!;
  assert.deepEqual([c.base_branch, c.start_from], ["master", null]);
  c = await setup(s, c.id);
  assert.equal(rev(c.worktree_path!, "HEAD"), rev(repo, "master"));
});

test("deleting_a_merged_middle_task_stacks_its_tasks_on_the_one_below", async () => {
  const s = testing.state();
  const [, repo, , p] = await stacking_repo(s);
  const make = (title: string, from: string | null) => api.create_task_inner(s, p.id, ct(title, from !== null ? { start_from: from } : {}));
  const a = await setup(s, make("First", null).id);
  const a_wt = a.worktree_path!;
  commit_file(a_wt, "first-file");
  let b = await setup(s, make("Second", "X-1").id);
  commit_file(b.worktree_path!, "second-file");
  // Third has a branch on Second's, Fourth isn't set up yet.
  let c = await setup(s, make("Third", "X-2").id);
  commit_file(c.worktree_path!, "third-file");
  let d = make("Fourth", "X-2");

  // Second is squashed into First, done and deleted with its branch, before First is merged.
  sh(a_wt, ["merge", "-q", "--squash", b.branch!]);
  sh(a_wt, ["commit", "-qm", "Second"]);
  s.update_task(b.id, [["status", "done"]]);
  b = db.get_task(s.db(), b.id)!;
  await api.delete_task_inner(s, b, true);
  const task = (id: string) => db.get_task(s.db(), id)!;
  const on_first = { type: "task", task_id: a.id };
  c = task(c.id);
  d = task(d.id);
  assert.deepEqual([c.start_from, c.base_branch], [on_first, a.branch]);
  assert.deepEqual([d.start_from, d.base_branch], [on_first, null]);
  assert.ok(
    log_of(s, c.id).includes("X-2, which this task was stacked on, was deleted: it's merged into X-1, so this task is stacked on that now"),
    log_of(s, c.id),
  );
  assert.deepEqual(await changed_files(s, c.id), ["third-file"]);

  // First is squashed into master, done and its branch deleted: both go to master.
  sh(repo, ["merge", "-q", "--squash", a.branch!]);
  sh(repo, ["commit", "-qm", "First"]);
  s.update_task(a.id, [["status", "done"]]);
  await teardown(s, a.id, true, true);
  for (const t of [c, d]) assert.equal(db.task_base(s.db(), task(t.id), p), "master", t.title);
  assert.deepEqual(await changed_files(s, c.id), ["third-file"]);
  assert.equal((await diff(s, c.id)).base, "master");
  d = await setup(s, d.id);
  assert.deepEqual([rev(d.worktree_path!, "HEAD"), d.base_branch], [rev(repo, "master"), "master"]);
});

test("a_task_stacked_on_an_unpushed_branch_opens_its_pull_request_where_that_ones_goes", async () => {
  const s = testing.state();
  const [root, repo, , p] = await stacking_repo(s);
  // Origin and upstream are different repositories on GitHub, and master follows upstream's.
  const up = join(root, "upstream");
  sh(root, ["clone", "-q", "--bare", path_str(join(root, "origin")), path_str(up)]);
  sh(repo, ["remote", "add", "upstream", path_str(up)]);
  sh(repo, ["remote", "set-url", "--push", "origin", "git@github.com:o/origin.git"]);
  sh(repo, ["remote", "set-url", "--push", "upstream", "git@github.com:o/upstream.git"]);
  sh(repo, ["fetch", "-q", "upstream"]);
  sh(repo, ["branch", "-q", "-u", "upstream/master", "master"]);
  const make = (title: string, from: string | null) => api.create_task_inner(s, p.id, ct(title, from !== null ? { start_from: from } : {}));
  // Second stacks on First, which isn't set up yet: it is, without a remote of its own.
  let a = make("First", null);
  const b = await setup(s, make("Second", "X-1").id);
  a = db.get_task(s.db(), a.id)!;
  const a_branch = a.branch!;
  assert.equal(b.base_branch, a_branch);
  const told = async (t: Task) => {
    const gh = (await github(repo, await remote_base(s, t, p)))!;
    return runner.system_prompt(t, p, null, [], [], gh, true);
  };
  let text = await told(a);
  assert.ok(text.includes(`\`git push -u upstream ${a_branch}\``) && text.includes("repo `o/upstream`"), text);
  text = await told(b);
  const b_branch = b.branch!;
  assert.ok(text.includes(`\`git push -u upstream ${b_branch}\``), text);
  assert.ok(text.includes(`repo \`o/upstream\`, head \`${b_branch}\` and base \`${a_branch}\``), text);
  // Once First's branch has a remote of its own, that's where.
  sh(repo, ["config", `branch.${a_branch}.remote`, "origin"]);
  assert.ok((await told(b)).includes("repo `o/origin`"));
});

test("start_from_is_checked_and_only_changes_before_the_branch_exists", async () => {
  const s = testing.state();
  const [, , , p] = await stacking_repo(s);
  const make = (from: any) => api.create_task_inner(s, p.id, ct("t", { start_from: from }));
  let a = make(null);
  assert.equal(a.start_from, null);
  const read = (v: any): { ok: any } | { err: string } => {
    try {
      return { ok: make(v).start_from };
    } catch (e) {
      return { err: e.message };
    }
  };
  assert.deepEqual(read("feature/x"), { ok: { type: "branch", branch: "feature/x" } });
  assert.deepEqual(read("branch:abcdef12"), { ok: { type: "branch", branch: "abcdef12" } });
  assert.deepEqual(read("ABCDEF12"), { ok: { type: "commit", commit: "abcdef12" } });
  assert.deepEqual(read({ type: "pull_request", number: 3 }), { ok: { type: "pull_request", number: 3 } });
  assert.deepEqual(read(" X-1 "), { ok: { type: "task", task_id: a.id } });
  for (const [bad, why] of [
    ["a..b", "isn't a valid branch name"],
    ["task:X-99", "no task X-99"],
    ["commit:xyz", "isn't a commit's SHA"],
    ["pr:#0", "starts at 1"],
    [3, "must be null, a string or an object"],
  ] as Array<[any, string]>) {
    const r = read(bad);
    assert.ok("err" in r && r.err.includes(why), `${JSON.stringify(bad)}: ${JSON.stringify(r)}`);
  }
  // Not without a worktree, nor in a subproject, nor round in a circle.
  const no_wt = throws(() => api.create_task_inner(s, p.id, ct("t", { use_worktree: false, start_from: "dev" })));
  assert.ok(no_wt.message.includes("for a task with a worktree"));
  const sp = api.create_task_inner(s, p.id, ct("sp", { subproject: true }));
  const child = throws(() => api.create_task_inner(s, p.id, ct("c", { parent_id: sp.id, start_from: "dev" })));
  assert.ok(child.message.includes("a subproject's tasks start from its branch"));
  const b = make(`task:${a.id}`);
  let err = await fails(patch_task(s, a.id, { start_from: `X-${b.number}` }));
  assert.ok(err.message.includes("needs this task's worktree first"), err.message);
  assert.ok((await fails(patch_task(s, a.id, { start_from: "X-1" }))).message.includes("can't start from itself"));

  // start_from and base_branch take each other's place.
  let t = await patch_task(s, a.id, { base_branch: "dev" });
  assert.deepEqual([t.base_branch, t.start_from], ["dev", null]);
  t = await patch_task(s, a.id, { start_from: "#4" });
  assert.deepEqual([t.base_branch, t.start_from], [null, { type: "pull_request", number: 4 }]);
  await fails(patch_task(s, a.id, { start_from: "x", base_branch: "y" }));
  t = await patch_task(s, a.id, { start_from: "" });
  assert.equal(t.start_from, null);

  // Once there's a worktree, it's what it started from.
  a = await setup(s, a.id);
  err = await fails(patch_task(s, a.id, { start_from: "dev" }));
  assert.equal(err.status, 409);
});

test("worktree_fetches_use_the_project_account_before_the_profile_account", async () => {
  const s = testing.state();
  const [repo, task] = await task_with_work(s);
  const gh = join(repo, "fake-gh");
  // No real login or network: make gh fail and identify the account it was asked for.
  fake_gh(gh, '#!/bin/sh\necho "$*" >&2\nexit 1\n');
  gh_mcp.TEST_GH_PROGRAM.set(path_str(gh));
  try {
    sh(repo, ["remote", "add", "origin", "https://github.com/o/r.git"]);
    sh(repo, ["update-ref", "refs/remotes/origin/master", "master"]);
    sh(repo, ["branch", "--set-upstream-to=origin/master", "master"]);
    const pid = task.project_id!;
    db.run(s.db(), "UPDATE profiles SET github_account='profile-login' WHERE id=?1", task.profile_id);
    db.run(s.db(), "UPDATE projects SET github_account='project-login' WHERE id=?1", pid);
    for (const [title, expected] of [
      ["Project account", "project-login"],
      ["Profile account", "profile-login"],
    ]) {
      let t = api.create_task_inner(s, pid, ct(title));
      t = await setup(s, t.id);
      const log = testing.messages(s.db(), t.id);
      const warning = log.find((m) => m.kind === "event" && m.data?.level === "warn")!;
      const detail: string = warning.data.detail;
      assert.ok(detail.includes(`--user=${expected}`), detail);
      assert.equal(rev(t.worktree_path!, "HEAD"), rev(repo, "master"));
      db.run(s.db(), "UPDATE projects SET github_account=NULL WHERE id=?1", pid);
    }
  } finally {
    gh_mcp.TEST_GH_PROGRAM.set(null);
  }
});

test("keeps_what_the_teardown_script_leaves", async () => {
  const s = testing.state();
  const [repo, t, wt, branch] = await task_with_work(s);
  sh(repo, ["merge", "-q", "--no-ff", "-m", "merge", branch]);
  db.update_task(s.db(), t.id, [["status", "done"]]);
  const pid = t.project_id!;
  db.run(s.db(), "UPDATE projects SET teardown_script='printf backup > notes' WHERE id=?1", pid);

  const e = await fails(remove_if_merged(s, t.id, true));
  assert.ok(e.message.includes("notes"), e.message);
  assert.equal(readFileSync(join(wt, "notes"), "utf8"), "backup");
  assert.equal(db.get_task(s.db(), t.id)!.worktree_state, "ready");
  // The sweep says why.
  unlinkSync(join(wt, "notes"));
  const results = await remove_merged(s, pid);
  assert.equal(results[0].removed, false);
  assert.ok(results[0].detail.includes("teardown script left uncommitted changes"));
});

test("keeps_it_while_a_reviewer_works_in_it", async () => {
  const s = testing.state();
  const [repo, t, wt, branch] = await task_with_work(s);
  sh(repo, ["merge", "-q", "--no-ff", "-m", "merge", branch]);
  const r = db.insert_task(s.db(), {
    profile_id: t.profile_id,
    project_id: t.project_id,
    kind: "review",
    title: "Review",
    description: "",
    status: "todo",
    use_worktree: false,
    model: null,
    effort: null,
    claude_config_id: null,
  });
  db.update_task(s.db(), r.id, [
    ["parent_id", t.id],
    ["running", true],
  ]);
  db.update_task(s.db(), t.id, [["status", "done"]]);

  assert.deepEqual(await remove_if_merged(s, t.id, true), kept("an agent is working in it"));
  assert.ok(existsSync(wt));
  db.update_task(s.db(), r.id, [["running", false]]);
  assert.deepEqual(await remove_if_merged(s, t.id, true), removed("master"));
});

test("keeps_changes_git_status_is_told_to_skip", async () => {
  const s = testing.state();
  const [repo, t, wt, branch] = await task_with_work(s);
  sh(repo, ["merge", "-q", "--no-ff", "-m", "merge", branch]);
  db.update_task(s.db(), t.id, [["status", "done"]]);
  const remove = () => remove_if_merged(s, t.id, true);

  // Marked but unchanged, it's clean.
  sh(wt, ["update-index", "--assume-unchanged", "a"]);
  sh(wt, ["update-index", "--skip-worktree", ".gitignore"]);
  assert.equal(await uncommitted(wt), "");
  for (const [file, mark] of [
    ["a", "assume-unchanged"],
    [".gitignore", "skip-worktree"],
  ]) {
    writeFileSync(join(wt, file), "local edit");
    assert.ok((await uncommitted(wt)).includes(`${file} (marked ${mark})`));
    assert.deepEqual(await remove(), kept("it has 1 uncommitted or untracked file"));
    assert.equal(readFileSync(join(wt, file), "utf8"), "local edit");
    sh(wt, ["update-index", `--no-${mark}`, file]);
    sh(wt, ["checkout", "--", file]);
  }
  // The sweep keeps it too.
  sh(wt, ["update-index", "--assume-unchanged", "a"]);
  writeFileSync(join(wt, "a"), "local edit");
  const results = await remove_merged(s, t.project_id!);
  assert.deepEqual([results[0].removed, results[0].detail], [false, "it has 1 uncommitted or untracked file"]);
  assert.equal(readFileSync(join(wt, "a"), "utf8"), "local edit");
  // A skip-worktree file that isn't there (as in a sparse checkout) has nothing to lose.
  sh(wt, ["update-index", "--no-assume-unchanged", "a"]);
  sh(wt, ["checkout", "--", "a"]);
  sh(wt, ["update-index", "--skip-worktree", "a"]);
  unlinkSync(join(wt, "a"));
  assert.deepEqual(await remove(), removed("master"));
});

test("keeps_mode_changes_and_files_whatever_their_names", async () => {
  const s = testing.state();
  const [repo, t, wt, branch] = await task_with_work(s);
  // A name that isn't UTF-8: node's fs takes it as bytes.
  const odd = Buffer.concat([Buffer.from("config-"), Buffer.from([0xff])]);
  const odd_path = Buffer.concat([Buffer.from(wt + "/"), odd]);
  writeFileSync(odd_path, "x");
  sh(wt, ["add", "."]);
  sh(wt, ["commit", "-qm", "odd"]);
  sh(repo, ["merge", "-q", "--no-ff", "-m", "merge", branch]);
  db.update_task(s.db(), t.id, [["status", "done"]]);
  const pid = t.project_id!;
  // Paths that aren't UTF-8 can't be command-line arguments in node, so the index is told through --stdin.
  const mark = (file: Buffer, flag: string) => {
    execFileSync("git", ["-C", wt, "update-index", flag, "-z", "--stdin"], { input: Buffer.concat([file, Buffer.from([0])]) });
  };
  const teardown_script = (script: string) => db.run(s.db(), "UPDATE projects SET teardown_script=?1 WHERE id=?2", script, pid);
  const chmod = (file: string, mode: number) => chmodSync(join(wt, file), mode);
  const sweep = async () => {
    const results = await remove_merged(s, pid);
    return [results[0].removed, results[0].detail];
  };
  const one_file = [false, "it has 1 uncommitted or untracked file"];

  // Only the executable bit of a marked file changed.
  mark(Buffer.from("a"), "--assume-unchanged");
  chmod("a", 0o755);
  assert.deepEqual(await sweep(), one_file);
  chmod("a", 0o644);
  assert.equal(await uncommitted(wt), "");
  // ...by the teardown script.
  teardown_script("chmod +x a");
  let e = await fails(remove_if_merged(s, t.id, true));
  assert.ok(e.message.includes("a (marked assume-unchanged)"), e.message);
  assert.equal(db.get_task(s.db(), t.id)!.worktree_state, "ready");
  chmod("a", 0o644);
  teardown_script("");

  // A marked file whose name isn't UTF-8.
  mark(odd, "--skip-worktree");
  writeFileSync(odd_path, "local edit");
  assert.deepEqual(await sweep(), one_file);
  assert.equal(readFileSync(odd_path, "utf8"), "local edit");
  writeFileSync(odd_path, "x");
  assert.equal(await uncommitted(wt), "");
  // ...edited by the teardown script.
  teardown_script("printf more >> config-$'\\xff'");
  e = await fails(remove_if_merged(s, t.id, true));
  assert.ok(e.message.includes("config-"), e.message);
  assert.equal(readFileSync(odd_path, "utf8"), "xmore");
  assert.ok(existsSync(wt));
});
