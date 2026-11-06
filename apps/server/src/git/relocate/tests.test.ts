// Port of server/src/git/relocate/tests.rs.
import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import * as api from "../../api.ts";
import * as db from "../../db.ts";
import type { Project, Task } from "../../db.ts";
import type { AppState } from "../../state.ts";
import * as testing from "../../testing.ts";
import { path_str, sleep } from "../../util.ts";
import * as worktree from "../worktree.ts";
import { claude_project_dir, fingerprint, is_history, record_fingerprints, settled, worktree_list } from "../relocate.ts";

process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";

function sh(dir: string, args: string[]) {
  try {
    execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { stdio: ["ignore", "ignore", "pipe"] });
  } catch (e: any) {
    throw new Error(`git ${JSON.stringify(args)}: ${e.stderr}`);
  }
}

function temp(name: string): string {
  return join(realpathSync(testing.temp_dir()), name);
}

/** `Path::with_file_name`. */
const with_file_name = (p: string, name: string) => join(dirname(p), name);

function repo(path: string) {
  mkdirSync(path, { recursive: true });
  sh(path, ["init", "-q", "-b", "master"]);
  // (Unlike another made in the same second, which would be the same commit.)
  sh(path, ["commit", "-q", "--allow-empty", "-m", `init ${path}`]);
}

/** A project in a new repository at `<tmp>/<name>`, with a task in a worktree … in the repository's folder `worktrees` (in the board's data otherwise). */
async function project_with_worktree(s: AppState, name: string, worktrees: string | null = null): Promise<[Project, Task]> {
  let p = await git_project(s, name);
  if (worktrees !== null) p = db.update_project(s.db(), p.id, [["worktrees_root", path_str(join(p.repo_path, worktrees))]])!;
  let t = api.create_task_inner(s, p.id, { ...api.CreateTask_default(), title: "Do it" });
  t = await worktree.setup(s, t.id);
  return [p, t];
}

/** A project in a new repository at `<tmp>/<name>`. */
async function git_project(s: AppState, name: string): Promise<Project> {
  const profile = db.insert_profile(s.db(), "p", [], null);
  const path = temp(name);
  repo(path);
  return api.create_project_inner(s, profile.id, { name, repo_path: path_str(path), key: "X", base_branch: "master", use_worktrees: null });
}

/** A Claude config in a new folder, and a thread of `t`'s in it that ran in `cwd`. */
function conversation(s: AppState, t: Task, cwd: string): string {
  const config_dir = temp("claude");
  const config = db.insert_claude_config(s.db(), "Claude", path_str(config_dir), "claude");
  db.update_task(s.db(), t.id, [
    ["session_id", "s1"],
    ["claude_config_id", config.id],
  ]);
  const dir = join(config_dir, "projects", claude_project_dir(cwd));
  mkdirSync(join(dir, "s1/subagents"), { recursive: true });
  writeFileSync(join(dir, "s1.jsonl"), "{}\n");
  writeFileSync(join(dir, "s1/subagents/a.jsonl"), "{}\n");
  return config_dir;
}

function has_conversation(config_dir: string, cwd: string): boolean {
  const dir = join(config_dir, "projects", claude_project_dir(cwd));
  return existsSync(join(dir, "s1.jsonl")) && existsSync(join(dir, "s1/subagents/a.jsonl"));
}

function update(s: AppState, p: Project, body: any): Promise<Project> {
  return api.update_project_inner(s, p.id, body);
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

function works(wt: string): boolean {
  return spawnSync("git", ["-C", wt, "status", "--short"], { stdio: "ignore" }).status === 0;
}

const is_dir = (p: string) => statSync(p, { throwIfNoEntry: false })?.isDirectory() ?? false;

test("moves_the_folder_and_reconnects_its_worktrees", async () => {
  const s = testing.state();
  const [p, t] = await project_with_worktree(s, "os-sandbox");
  const wt = t.worktree_path!;
  const old = p.repo_path;
  const n = with_file_name(old, "omarchy-sandbox");

  // Not over another folder, and not without a path to move to.
  mkdirSync(n, { recursive: true });
  let e = await fails(update(s, p, { repo_path: path_str(n), move_repo: true }));
  assert.ok(e.message.includes("already exists"), e.message);
  rmdirSync(n);
  e = await fails(update(s, p, { name: "omarchy-sandbox", move_repo: true }));
  assert.ok(e.message.includes("needs a new repo_path"), e.message);

  const moved = await update(s, p, { name: "omarchy-sandbox", repo_path: path_str(n), move_repo: true });
  assert.deepEqual([moved.name, moved.repo_path], ["omarchy-sandbox", path_str(n)]);
  assert.ok(!existsSync(old) && is_dir(join(n, ".git")));
  assert.ok(works(wt));
  assert.ok(readFileSync(join(wt, ".git"), "utf8").includes(path_str(n)));
});

test("points_at_a_folder_moved_elsewhere", async () => {
  const s = testing.state();
  let [p, t] = await project_with_worktree(s, "os-sandbox");
  const wt = t.worktree_path!;
  const old = p.repo_path;
  const n = with_file_name(old, "omarchy-sandbox");
  renameSync(old, n);
  assert.ok(!works(wt));

  // Another repository, or a folder that isn't one, isn't the project's.
  const other = with_file_name(old, "other");
  repo(other);
  let e = await fails(update(s, p, { repo_path: path_str(other) }));
  assert.ok(e.message.includes("doesn't have the task worktree"), e.message);
  e = await fails(update(s, p, { repo_path: path_str(with_file_name(old, "missing")) }));
  assert.ok(e.message.includes("isn't a folder"), e.message);
  e = await fails(update(s, p, { repo_path: "relative/path" }));
  assert.ok(e.message.includes("absolute"), e.message);

  p = await update(s, p, { repo_path: path_str(n) });
  assert.equal(p.repo_path, path_str(n));
  assert.ok(works(wt));
});

test("points_at_a_link_target_so_the_link_can_go", async () => {
  const s = testing.state();
  const [p, t] = await project_with_worktree(s, "os-sandbox");
  const wt = t.worktree_path!;
  const old = p.repo_path;
  const n = with_file_name(old, "omarchy-sandbox");
  renameSync(old, n);
  symlinkSync(n, old);
  assert.ok(works(wt));

  // While the old folder is there, only the same repository will do.
  const other = with_file_name(old, "other");
  repo(other);
  let e = await fails(update(s, p, { repo_path: path_str(other) }));
  assert.ok(e.message.includes("isn't the project's repository"), e.message);
  e = await fails(update(s, p, { repo_path: path_str(with_file_name(other, "elsewhere")), move_repo: true }));
  assert.ok(e.message.includes("is a link to"), e.message);

  await update(s, p, { repo_path: path_str(n) });
  unlinkSync(old);
  assert.ok(works(wt));
});

test("copies_conversations_that_ran_in_the_folder", async () => {
  const s = testing.state();
  const profile = db.insert_profile(s.db(), "p", [], null);
  const old = temp("notes");
  mkdirSync(old, { recursive: true });
  const p = await api.create_project_inner(s, profile.id, { name: "notes", repo_path: path_str(old), key: null, base_branch: null, use_worktrees: null });
  const t = api.create_task_inner(s, p.id, { ...api.CreateTask_default(), title: "Write" });
  const config_dir = conversation(s, t, old);

  const n = with_file_name(old, "journal");
  await update(s, p, { repo_path: path_str(n), move_repo: true });
  assert.ok(has_conversation(config_dir, n));
  assert.ok(has_conversation(config_dir, old));
});

/** Moved back to where it was, a project's conversations carry on from where they got to. */
test("brings_conversations_up_to_date_when_moving_back", async () => {
  const s = testing.state();
  const profile = db.insert_profile(s.db(), "p", [], null);
  const a = temp("notes");
  mkdirSync(a, { recursive: true });
  let p = await api.create_project_inner(s, profile.id, { name: "notes", repo_path: path_str(a), key: null, base_branch: null, use_worktrees: null });
  const t = api.create_task_inner(s, p.id, { ...api.CreateTask_default(), title: "Write" });
  const config_dir = conversation(s, t, a);
  const b = with_file_name(a, "journal");
  p = await update(s, p, { repo_path: path_str(b), move_repo: true });

  // It carries on at B…
  const at = (dir: string) => join(config_dir, "projects", claude_project_dir(dir));
  const later = new Date(Date.now() + 60_000);
  for (const [f, text] of [
    ["s1.jsonl", '{}\n{"more": 1}\n'],
    ["s1/subagents/a.jsonl", '{"sub": 2}\n'],
    ["s1/subagents/b.jsonl", "{}\n"],
  ]) {
    writeFileSync(join(at(b), f), text);
    utimesSync(join(at(b), f), later, later);
  }
  // …and moving back to A, which has the copy from before, brings that up to date.
  await update(s, p, { repo_path: path_str(a), move_repo: true });
  assert.equal(readFileSync(join(at(a), "s1.jsonl"), "utf8"), '{}\n{"more": 1}\n');
  assert.equal(readFileSync(join(at(a), "s1/subagents/a.jsonl"), "utf8"), '{"sub": 2}\n');
  assert.ok(existsSync(join(at(a), "s1/subagents/b.jsonl")));
});

/**
 * Worktrees kept inside the repository move with it, whether the board moves it or it was moved before, and so does
 * the worktrees folder (or new tasks would recreate the old one).
 */
test("worktrees_inside_the_folder_move_with_it", async () => {
  for (const move_folder of [true, false]) {
    const s = testing.state();
    let [p, t] = await project_with_worktree(s, "os-sandbox", ".worktrees");
    const old_wt = t.worktree_path!;
    const old = p.repo_path;
    assert.ok(old_wt.startsWith(join(old, ".worktrees") + "/"));
    const config_dir = conversation(s, t, old_wt);
    const n = with_file_name(old, "omarchy-sandbox");
    if (!move_folder) renameSync(old, n);

    p = await update(s, p, { repo_path: path_str(n), move_repo: move_folder });
    assert.equal(p.worktrees_root, path_str(join(n, ".worktrees")));
    t = db.get_task(s.db(), t.id)!;
    const wt = join(n, old_wt.slice(old.length + 1));
    assert.equal(t.worktree_path, path_str(wt));
    assert.ok(works(path_str(wt)), `move_folder=${move_folder}`);
    assert.ok((await worktree_list(n)).has(wt));
    assert.ok(has_conversation(config_dir, wt));
    assert.ok(!existsSync(old));
  }
});

/** Without worktrees to go by, a moved repository is told by the history it started from. */
test("tells_a_moved_repository_by_its_history", async () => {
  const s = testing.state();
  let p = await git_project(s, "os-sandbox");
  assert.ok(p.repo_root != null && p.repo_root.length === 40);
  const old = p.repo_path;
  const n = with_file_name(old, "omarchy-sandbox");
  renameSync(old, n);
  const other = with_file_name(old, "other");
  repo(other);
  const plain = with_file_name(old, "plain");
  mkdirSync(plain, { recursive: true });
  let e = await fails(update(s, p, { repo_path: path_str(other) }));
  assert.ok(e.message.includes("none of the commits"), e.message);
  e = await fails(update(s, p, { repo_path: path_str(plain) }));
  assert.ok(e.message.includes("isn't a git repository"), e.message);
  p = await update(s, p, { repo_path: path_str(n) });
  assert.equal(p.repo_path, path_str(n));

  // When the board didn't see what was there, it can't tell.
  db.update_project(s.db(), p.id, [["repo_root", null]]);
  p = db.get_project(s.db(), p.id)!;
  renameSync(n, old);
  e = await fails(update(s, p, { repo_path: path_str(old) }));
  assert.ok(e.message.includes("can't tell"), e.message);
  // It looks while the folder is there.
  renameSync(old, n);
  await record_fingerprints(s);
  p = db.get_project(s.db(), p.id)!;
  assert.ok(p.repo_root != null);
  renameSync(n, old);
  await update(s, p, { repo_path: path_str(old) });

  // A repository without commits isn't the one that had them.
  renameSync(old, n);
  const empty = with_file_name(old, "empty");
  mkdirSync(empty, { recursive: true });
  sh(empty, ["init", "-q"]);
  e = await fails(update(s, p, { repo_path: path_str(empty) }));
  assert.ok(e.message.includes("has no commits"), e.message);
});

// HA-42: a shallow clone's history starts where it was cut off, so once the rest was fetched its moved folder had none
// of the commits the board had seen it start from.
test("tells_a_moved_shallow_clone_once_its_history_is_fetched", async () => {
  const s = testing.state();
  const upstream = temp("upstream");
  repo(upstream);
  for (let n = 1; n <= 3; n++) sh(upstream, ["commit", "-q", "--allow-empty", "-m", `commit ${n}`]);
  const old = temp("shallow");
  const url = `file://${path_str(upstream)}`;
  sh(upstream, ["clone", "-q", "--depth", "1", url, path_str(old)]);
  const profile = db.insert_profile(s.db(), "p", [], null);
  let p = await api.create_project_inner(s, profile.id, { name: "s", repo_path: path_str(old), key: "X", base_branch: "master", use_worktrees: null });
  const n = with_file_name(old, "unshallowed");
  renameSync(old, n);
  sh(n, ["fetch", "-q", "--unshallow"]);
  assert.notEqual(await fingerprint(n), p.repo_root);
  p = await update(s, p, { repo_path: path_str(n) });
  assert.equal(p.repo_path, path_str(n));
});

/** A repository seen before its first commit is told by its history once it has one; until the board has seen that, it can't tell. */
test("a_repository_without_commits_yet_is_no_proof", async () => {
  const s = testing.state();
  const profile = db.insert_profile(s.db(), "p", [], null);
  const old = temp("fresh");
  mkdirSync(old, { recursive: true });
  sh(old, ["init", "-q", "-b", "master"]);
  let p = await api.create_project_inner(s, profile.id, { name: "fresh", repo_path: path_str(old), key: null, base_branch: null, use_worktrees: null });
  assert.equal(p.repo_root, "git");
  sh(old, ["commit", "-q", "--allow-empty", "-m", "first"]);
  const n = with_file_name(old, "moved");
  const other = with_file_name(old, "other");
  repo(other);

  renameSync(old, n);
  let e = await fails(update(s, p, { repo_path: path_str(other) }));
  assert.ok(e.message.includes("can't tell"), e.message);

  renameSync(n, old);
  await record_fingerprints(s);
  p = db.get_project(s.db(), p.id)!;
  assert.ok(p.repo_root != null && is_history(p.repo_root));
  renameSync(old, n);
  e = await fails(update(s, p, { repo_path: path_str(other) }));
  assert.ok(e.message.includes("none of the commits"), e.message);
  await update(s, p, { repo_path: path_str(n) });
});

/**
 * A folder that wasn't a repository when the board looked may be one by the time it moves, so that's no proof either;
 * setting up a worktree has the board look again.
 */
test("a_folder_that_wasnt_a_repository_is_no_proof", async () => {
  const s = testing.state();
  const profile = db.insert_profile(s.db(), "p", [], null);
  const old = temp("notes");
  mkdirSync(old, { recursive: true });
  const p = await api.create_project_inner(s, profile.id, { name: "notes", repo_path: path_str(old), key: null, base_branch: "master", use_worktrees: null });
  assert.equal(p.repo_root, "");
  sh(old, ["init", "-q", "-b", "master"]);
  sh(old, ["commit", "-q", "--allow-empty", "-m", "first"]);

  const n = with_file_name(old, "moved");
  renameSync(old, n);
  const other = with_file_name(old, "other");
  repo(other);
  const plain = with_file_name(old, "plain");
  mkdirSync(plain, { recursive: true });
  for (const wrong of [other, plain]) {
    const e = await fails(update(s, p, { repo_path: path_str(wrong) }));
    assert.ok(e.message.includes("can't tell"), e.message);
  }

  renameSync(n, old);
  const t = api.create_task_inner(s, p.id, { ...api.CreateTask_default(), title: "Do it" });
  await worktree.setup(s, t.id);
  const root = db.get_project(s.db(), p.id)!.repo_root;
  assert.ok(root != null && is_history(root));
});

/** A worktree moved with its repository may have been repaired before the board is told. */
test("knows_a_worktree_repaired_before_the_board_was_told", async () => {
  const s = testing.state();
  const [p, t0] = await project_with_worktree(s, "os-sandbox", ".worktrees");
  const old_wt = t0.worktree_path!;
  const old = p.repo_path;
  const n = with_file_name(old, "omarchy-sandbox");
  renameSync(old, n);
  const wt = join(n, old_wt.slice(old.length + 1));
  sh(n, ["worktree", "repair", path_str(wt)]);
  assert.ok(works(path_str(wt)));

  await update(s, p, { repo_path: path_str(n) });
  const t = db.get_task(s.db(), t0.id)!;
  assert.equal(t.worktree_path, path_str(wt));
});

/** A task whose worktree was removed (once merged, say) gets its folder back when it runs again, in the worktrees folder's new place, and its conversation needs to be there. */
test("copies_conversations_of_removed_worktrees_to_where_they_come_back", async () => {
  const s = testing.state();
  let [p, t] = await project_with_worktree(s, "os-sandbox", ".worktrees");
  const old_wt = t.worktree_path!;
  const config_dir = conversation(s, t, old_wt);
  t = await worktree.teardown(s, t.id, false, false);
  assert.deepEqual([t.worktree_path, t.branch != null], [null, true]);
  const old = p.repo_path;
  const n = with_file_name(old, "omarchy-sandbox");

  p = await update(s, p, { repo_path: path_str(n), move_repo: true });
  const wt = join(n, old_wt.slice(old.length + 1));
  assert.ok(has_conversation(config_dir, wt));
  // Even after the key changes, it comes back there.
  await update(s, p, { key: "Y" });
  t = await worktree.setup(s, t.id);
  assert.equal(t.worktree_path, path_str(wt));
});

/** Another checkout of the same repository is another folder: the project's hasn't moved. */
test("another_checkout_of_the_repository_isnt_the_folder", async () => {
  const s = testing.state();
  const [p, t] = await project_with_worktree(s, "os-sandbox", ".worktrees");
  const checkout = with_file_name(p.repo_path, "checkout");
  sh(p.repo_path, ["worktree", "add", "-q", "-b", "other", path_str(checkout)]);
  const e = await fails(update(s, p, { repo_path: path_str(checkout) }));
  assert.ok(e.message.includes("still at"), e.message);
  const after = db.get_task(s.db(), t.id)!;
  assert.equal(after.worktree_path, t.worktree_path);
  assert.equal(db.get_project(s.db(), p.id)!.worktrees_root, p.worktrees_root);
});

/** A review thread works in the worktree of the task it reviews. */
test("copies_a_review_threads_conversation_from_the_worktree_it_reviewed", async () => {
  const s = testing.state();
  const [p, t] = await project_with_worktree(s, "os-sandbox", ".worktrees");
  const old_wt = t.worktree_path!;
  let review = db.insert_task(s.db(), {
    profile_id: p.profile_id,
    project_id: p.id,
    kind: "review",
    title: "Review of X-1",
    description: "",
    status: "todo",
    use_worktree: false,
    model: null,
    effort: null,
    claude_config_id: null,
  });
  review = s.update_task(review.id, [["parent_id", t.id]])!;
  const config_dir = conversation(s, review, old_wt);
  const old = p.repo_path;
  const n = with_file_name(old, "omarchy-sandbox");

  await update(s, p, { repo_path: path_str(n), move_repo: true });
  assert.ok(has_conversation(config_dir, join(n, old_wt.slice(old.length + 1))));
});

test("a_change_that_cant_be_stored_leaves_the_folder_where_it_is", async () => {
  const s = testing.state();
  const [p, t] = await project_with_worktree(s, "os-sandbox");
  const old = p.repo_path;
  const n = with_file_name(old, "omarchy-sandbox");
  const e = await fails(update(s, p, { repo_path: path_str(n), move_repo: true, use_worktrees: null }));
  assert.ok(e.message.includes("use_worktrees"), e.message);
  assert.ok(is_dir(old) && !existsSync(n));
  const now = db.get_project(s.db(), p.id)!;
  assert.deepEqual([now.repo_path, now.use_worktrees], [p.repo_path, p.use_worktrees]);
  assert.ok(works(t.worktree_path!));
});

test("a_key_taken_while_the_folder_moves_isnt_taken_twice", async () => {
  const s = testing.state();
  const [p] = await project_with_worktree(s, "os-sandbox");
  const q = await api.create_project_inner(s, p.profile_id, { name: "q", repo_path: path_str(temp("q")), key: "Q", base_branch: null, use_worktrees: null });
  const n = with_file_name(p.repo_path, "omarchy-sandbox");
  // The second starts while the first waits on git.
  const [moving, taking] = await Promise.allSettled([update(s, p, { repo_path: path_str(n), move_repo: true, key: "NEW" }), update(s, q, { key: "NEW" })]);
  assert.equal(moving.status, "fulfilled");
  assert.equal((moving as PromiseFulfilledResult<Project>).value.key, "NEW");
  assert.equal(taking.status, "rejected");
  const e = (taking as PromiseRejectedResult).reason;
  assert.ok(e.message.includes("already has the key NEW"), e.message);
  assert.equal(db.get_project(s.db(), q.id)!.key, "Q");
});

test("a_rename_while_the_folder_moves_keeps_every_old_key", async () => {
  const s = testing.state();
  const [p] = await project_with_worktree(s, "os-sandbox");
  const n = with_file_name(p.repo_path, "omarchy-sandbox");
  await Promise.all([update(s, p, { repo_path: path_str(n), move_repo: true, key: "NEW" }), update(s, p, { key: "MIDDLE" })]);
  const now = db.get_project(s.db(), p.id)!;
  const keys = [...now.former_keys, now.key].sort();
  assert.deepEqual(keys, ["MIDDLE", "NEW", "X"]);
  assert.equal(now.repo_path, path_str(n));
});

test("submodules_checked_out_in_worktrees_keep_working", async () => {
  const s = testing.state();
  const profile = db.insert_profile(s.db(), "p", [], null);
  const lib = temp("lib");
  repo(lib);
  const old = temp("os-sandbox");
  repo(old);
  sh(old, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", path_str(lib), "lib"]);
  sh(old, ["commit", "-q", "-m", "lib"]);
  const p = await api.create_project_inner(s, profile.id, { name: "os", repo_path: path_str(old), key: "X", base_branch: "master", use_worktrees: null });
  const t = api.create_task_inner(s, p.id, { ...api.CreateTask_default(), title: "Do it" });
  const wt = (await worktree.setup(s, t.id)).worktree_path!;
  sh(wt, ["-c", "protocol.file.allow=always", "submodule", "update", "-q", "--init"]);
  assert.ok(works(path_str(join(wt, "lib"))));

  const n = with_file_name(old, "omarchy-sandbox");
  await update(s, p, { repo_path: path_str(n), move_repo: true });
  for (const dir of [wt, join(wt, "lib"), join(n, "lib")]) assert.ok(works(path_str(dir)), dir);
  // Still relative, as git keeps them, so they survive the folders moving together.
  assert.ok(readFileSync(join(n, "lib/.git"), "utf8").startsWith("gitdir: .."));
});

test("agents_start_once_the_folder_has_moved", async () => {
  const s = testing.state();
  const [p] = await project_with_worktree(s, "os-sandbox");
  const n = with_file_name(p.repo_path, "omarchy-sandbox");
  // The second starts while the first waits on git, as launching an agent would.
  const [, starting] = await Promise.all([
    update(s, p, { repo_path: path_str(n), move_repo: true }),
    (async () => {
      // As tokio::join! polls the first until it waits on something (git): past its microtasks.
      await new Promise((r) => setImmediate(r));
      await settled(s, p.id);
      return db.get_project(s.db(), p.id)!;
    })(),
  ]);
  assert.equal(starting.repo_path, path_str(n));
});

test("a_worktree_being_set_up_keeps_the_folder_where_it_is", async () => {
  const s = testing.state();
  const [p] = await project_with_worktree(s, "os-sandbox", ".worktrees");
  const signals = temp("signals");
  mkdirSync(signals, { recursive: true });
  const started = join(signals, "started"),
    go = join(signals, "go");
  const script = `touch ${started}; while [ ! -e ${go} ]; do sleep 0.05; done`;
  db.update_project(s.db(), p.id, [["setup_script", script]]);
  const t = api.create_task_inner(s, p.id, { ...api.CreateTask_default(), title: "Another" });
  const n = with_file_name(p.repo_path, "omarchy-sandbox");
  const [set_up, moving] = await Promise.allSettled([
    worktree.setup(s, t.id),
    (async () => {
      while (!existsSync(started)) await sleep(20);
      try {
        return await update(s, p, { repo_path: path_str(n), move_repo: true });
      } finally {
        writeFileSync(go, "");
      }
    })(),
  ]);
  assert.equal(moving.status, "rejected");
  const e = (moving as PromiseRejectedResult).reason;
  assert.ok(e.message.includes("being set up"), e.message);
  assert.equal(set_up.status, "fulfilled");
  let wt = (set_up as PromiseFulfilledResult<Task>).value.worktree_path!;
  assert.ok(wt.startsWith(p.repo_path) && works(wt));
  // Once it's set up, the folder moves with it.
  await update(s, p, { repo_path: path_str(n), move_repo: true });
  wt = db.get_task(s.db(), t.id)!.worktree_path!;
  assert.ok(wt.startsWith(path_str(n)) && works(wt));
});

test("submodules_of_a_project_that_is_a_linked_checkout_keep_working", async () => {
  const s = testing.state();
  const profile = db.insert_profile(s.db(), "p", [], null);
  const lib = temp("lib");
  repo(lib);
  const main = temp("main");
  repo(main);
  sh(main, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", path_str(lib), "lib"]);
  sh(main, ["commit", "-q", "-m", "lib"]);
  const old = with_file_name(main, "linked-old");
  sh(main, ["worktree", "add", "-q", "-b", "linked", path_str(old)]);
  sh(old, ["-c", "protocol.file.allow=always", "submodule", "update", "-q", "--init"]);
  let p = await api.create_project_inner(s, profile.id, { name: "linked", repo_path: path_str(old), key: "X", base_branch: "linked", use_worktrees: null });
  p = db.update_project(s.db(), p.id, [["worktrees_root", path_str(join(old, ".worktrees"))]])!;
  const t = api.create_task_inner(s, p.id, { ...api.CreateTask_default(), title: "Do it" });
  let wt = (await worktree.setup(s, t.id)).worktree_path!;
  sh(wt, ["-c", "protocol.file.allow=always", "submodule", "update", "-q", "--init"]);

  const n = with_file_name(old, "linked-new");
  await update(s, p, { repo_path: path_str(n), move_repo: true });
  wt = join(n, wt.slice(old.length + 1));
  for (const dir of [n, join(n, "lib"), wt, join(wt, "lib"), main, join(main, "lib")]) assert.ok(works(path_str(dir)), dir);
});
