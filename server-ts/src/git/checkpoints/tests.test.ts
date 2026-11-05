// Port of server/src/git/checkpoints/tests.rs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as api from "../../api.ts";
import * as db from "../../db.ts";
import type { Run, Task } from "../../db.ts";
import type { Req } from "../../http.ts";
import type { AppState } from "../../state.ts";
import * as testing from "../../testing.ts";
import { path_str } from "../../util.ts";
import * as worktree from "../worktree.ts";
import {
  MAX_CHECKPOINTS,
  after_turn,
  before_run,
  conversation,
  creates_commit,
  diff,
  header_path,
  list,
  ref_name,
  ref_prefix,
  rewind,
  settled,
  turns,
  without,
  type Checkpoint,
  type Convo,
  type Rewind,
} from "../checkpoints.ts";

function sh(dir: string, args: string[]): string {
  const out = spawnSync("git", ["-C", dir, "-c", "protocol.file.allow=always", ...args], { encoding: "utf8" });
  assert.ok(out.status === 0, `git ${JSON.stringify(args)}: ${out.stderr}`);
  return out.stdout;
}

function write(dir: string, path: string, text: string) {
  const p = join(dir, path);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
}

function read(dir: string, path: string): string | null {
  try {
    return readFileSync(join(dir, path), "utf8");
  } catch {
    return null;
  }
}

const is_dir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/**
 * A task with a worktree, in a repository whose master has `f.txt`, `gone.txt` and a `.gitignore` for `*.log`,
 * reached through a symlink to it if `link`.
 */
async function task_repo(s: AppState, link: boolean): Promise<[Task, string, string]> {
  const profile = db.insert_profile(s.db(), "p", [], null);
  const repo = testing.temp_dir();
  sh(repo, ["init", "-q", "-b", "master"]);
  sh(repo, ["config", "user.name", "t"]);
  sh(repo, ["config", "user.email", "t@t"]);
  write(repo, "f.txt", Array.from({ length: 20 }, (_, i) => `${i + 1}\n`).join(""));
  write(repo, "gone.txt", "bye\n");
  write(repo, ".gitignore", "*.log\n");
  sh(repo, ["add", "."]);
  sh(repo, ["commit", "-qm", "init"]);
  let path = repo;
  if (link) {
    path = join(testing.temp_dir(), "link");
    symlinkSync(repo, path);
  }
  const b = { name: "x", repo_path: path_str(path), key: "X", base_branch: "master", use_worktrees: null };
  const p = await api.create_project_inner(s, profile.id, b as any);
  const t0 = api.create_task_inner(s, p.id, { title: "Do it" } as any);
  const t = await worktree.setup(s, t0.id);
  return [t, t.worktree_path!, repo];
}

/** A run of the task that's started with a message `text`: the run and the message's id. */
function start(s: AppState, task_id: string, text: string): [Run, number] {
  const c = s.db();
  const run = db.insert_run(c, task_id, "prompt");
  const m = db.insert_message(c, task_id, "user", { text });
  db.run(c, "UPDATE runs SET status='running', turn_message_id=?1, agent_at=?2 WHERE id=?3", m.id, `at-${m.id}`, run.id);
  return [db.get_run(c, run.id)!, m.id];
}

/** A turn of the agent's: its run starts (with its checkpoint), `work` changes the files, and the turn ends. */
async function turn(s: AppState, task_id: string, text: string, work: () => void): Promise<number> {
  const [run, m] = start(s, task_id, text);
  const task = db.get_task(s.db(), task_id)!;
  await before_run(s, task, run);
  work();
  after_turn(s, run.id, "done");
  await settled(s, task_id);
  return m;
}

function req(id: string, o: { query?: Record<string, string>; body?: any } = {}): Req {
  return { method: "GET", path: "", params: { id }, query: o.query ?? {}, query_string: "", headers: {}, body: o.body ?? {}, raw: Buffer.alloc(0) };
}

const get_turns = (s: AppState, id: string) => turns(s, req(id));
const get_diff = (s: AppState, id: string, from: number, to: number) => diff(s, req(id, { query: { from: String(from), to: String(to) } }));
const do_rewind = (s: AppState, id: string, message_id: number, conversation: boolean, branch: boolean) =>
  rewind(s, req(id, { body: { message_id, conversation, branch } }));

async function rewind_error(p: Promise<any>): Promise<string> {
  try {
    await p;
  } catch (e: any) {
    return e.message;
  }
  assert.fail("expected the rewind to fail");
}

function files(dir: string): string {
  return sh(dir, ["status", "--porcelain", "--untracked-files=all"]);
}

test("a_checkpoint_leaves_the_index_branch_and_stashes_alone", async () => {
  const s = testing.state();
  const [t, wt] = await task_repo(s, false);
  write(wt, "f.txt", "stashed\n");
  sh(wt, ["stash", "push", "-q", "-m", "mine"]);
  write(wt, "staged.txt", "s\n");
  sh(wt, ["add", "staged.txt"]);
  write(wt, "f.txt", "changed\n");
  write(wt, "new/untracked.txt", "u\n");
  write(wt, "build.log", "ignored\n");
  const git_dir = sh(wt, ["rev-parse", "--absolute-git-dir"]).trim();
  const index = readFileSync(join(git_dir, "index"));
  const state = () => [sh(wt, ["rev-parse", "HEAD"]), sh(wt, ["branch", "--show-current"]), sh(wt, ["stash", "list", "--format=%H %gs"]), files(wt)];
  const before = state();

  let [run] = start(s, t.id, "go");
  await before_run(s, t, run);
  const cps = list(s.db(), t.id);
  assert.equal(cps.length, 1);
  assert.deepEqual([cps[0].kind, cps[0].head], ["start", before[0].trim()]);

  assert.deepEqual(readFileSync(join(git_dir, "index")), index, "the index is untouched");
  assert.deepEqual(state(), before);
  // Everything but ignored files, as it is on disk.
  const tree = sh(wt, ["ls-tree", "-r", "--name-only", ref_name(t.id, 0)]);
  assert.deepEqual(tree.trimEnd().split("\n"), [".gitignore", "f.txt", "gone.txt", "new/untracked.txt", "staged.txt"]);
  assert.equal(sh(wt, ["show", `${ref_name(t.id, 0)}:f.txt`]), "changed\n");
  assert.ok(readdirSync(git_dir).every((e) => !e.startsWith("huntaway-")), "no scratch index left");

  // Nothing new since: no second one.
  [run] = start(s, t.id, "again");
  await before_run(s, t, run);
  assert.equal(list(s.db(), t.id).length, 1);
});

test("a_file_rewritten_in_the_second_the_index_was_written_is_a_change", async () => {
  // HA-237: f.txt is rewritten at the same size and time as the index's entry for it, in the second the worktree's
  // index was written (as the agent's first edit after the checkout can be). Git reads such a file again rather than
  // trust the entry, which it can only tell from the index's own time. The ctime, which can't be set, is left out.
  const s = testing.state();
  const [t, wt] = await task_repo(s, false);
  sh(wt, ["config", "core.trustctime", "false"]);
  const second = Math.floor(Date.now() / 1000) - 100;
  utimesSync(join(wt, "f.txt"), second, second);
  sh(wt, ["update-index", "-q", "--refresh"]);
  const index = sh(wt, ["rev-parse", "--path-format=absolute", "--git-path", "index"]).trim();
  utimesSync(index, second, second);
  const before = read(wt, "f.txt")!;
  const after = before.replace("1\n", "x\n");
  assert.equal(after.length, before.length);
  await turn(s, t.id, "go", () => {
    write(wt, "f.txt", after);
    utimesSync(join(wt, "f.txt"), second, second);
  });
  const cp = list(s.db(), t.id).at(-1)!;
  assert.equal(cp.kind, "turn");
  assert.equal(cp.stats?.files, 1);
  assert.equal(sh(wt, ["show", `${cp.sha}:f.txt`]), after);
});

test("turns_show_their_own_changes_and_rewind_restores_the_files", async () => {
  const s = testing.state();
  const [t, wt] = await task_repo(s, false);
  s.update_task(t.id, [["session_id", "sess"]]);
  write(wt, "build.log", "ignored\n");
  const m1 = await turn(s, t.id, "one", () => {
    write(wt, "f.txt", "one\n");
    write(wt, "a.txt", "a\n");
    sh(wt, ["add", "-A"]);
    sh(wt, ["commit", "-qm", "turn one"]);
    unlinkSync(join(wt, "gone.txt"));
  });
  const head_one = sh(wt, ["rev-parse", "HEAD"]);
  const m2 = await turn(s, t.id, "two", () => {
    write(wt, "f.txt", "two\n");
    write(wt, "dir/u.txt", "untracked\n");
    write(wt, "build.log", "ignored, changed\n");
    sh(wt, ["add", "f.txt"]);
    sh(wt, ["commit", "-qm", "turn two"]);
    write(wt, "a.txt", "a, changed\n");
  });

  let ts = await get_turns(s, t.id);
  const ls = ts.turns;
  assert.equal(ls.length, 2);
  assert.deepEqual([ls[0].turn, ls[0].message_id, ls[0].text], [1, m1, "one"]);
  assert.deepEqual([ls[1].turn, ls[1].stats.files], [2, 3]);
  assert.equal(ls[1].rewind.ok, true);
  assert.deepEqual(ls[1].rewind.conversation, { ok: true, fresh: false });
  // Turn 1 started the conversation: going back before it starts a new one.
  assert.deepEqual(ls[0].rewind.conversation, { ok: true, fresh: true });

  const d = await get_diff(s, t.id, ls[1].before_n, ls[1].n);
  const patch: string = d.patch;
  assert.ok(patch.includes("+two") && patch.includes("dir/u.txt") && patch.includes("a, changed"), patch);
  assert.ok(!patch.includes("gone.txt") && !patch.includes("build.log"), patch);

  // Back to before turn 2, with its conversation.
  const r = await do_rewind(s, t.id, m2, true, false);
  assert.deepEqual([r.written, r.removed], [2, 1]);
  assert.deepEqual([read(wt, "f.txt"), read(wt, "a.txt")], ["one\n", "a\n"]);
  assert.ok(!existsSync(join(wt, "dir")), "the folder it left empty goes too");
  assert.equal(read(wt, "build.log"), "ignored, changed\n", "ignored files are left alone");
  // The branch stays where it was: turn 2's commit is undone in the working tree.
  assert.equal(sh(wt, ["rev-parse", "HEAD^"]), head_one);
  assert.equal(files(wt), " M f.txt\n D gone.txt\n");
  let task = db.get_task(s.db(), t.id)!;
  const expected: Rewind = { turn: 2, message_id: m2, session: "sess", resume_at: `at-${m1}` };
  assert.deepEqual(task.rewind, expected);
  const stale = list(s.db(), t.id).map((c) => [c.kind, c.stale]);
  assert.deepEqual(stale, [["start", 0], ["turn", 0], ["turn", 2], ["rewind", 1]]);
  // The files the rewind replaced are kept.
  assert.equal(sh(wt, ["show", `${r.kept}:a.txt`]), "a, changed\n");
  await assert.rejects(do_rewind(s, t.id, m2, false, false), "a stale turn can't be rewound to again");

  // The next turn starts from the rewound files.
  await turn(s, t.id, "three", () => write(wt, "c.txt", "c\n"));
  ts = await get_turns(s, t.id);
  const three = ts.turns[2];
  assert.deepEqual([three.turn, three.stats.files, three.stale], [3, 1, false]);
  assert.equal(ts.turns[1].rewind.ok, false);

  // Back before turn 1 with the branch: the baseline, on its commit, and a new conversation.
  await do_rewind(s, t.id, m1, true, true);
  assert.notEqual(sh(wt, ["rev-parse", "HEAD"]), head_one);
  assert.equal(files(wt), "");
  assert.equal(read(wt, "gone.txt"), "bye\n");
  assert.ok(!existsSync(join(wt, "c.txt")) && !existsSync(join(wt, "a.txt")));
  task = db.get_task(s.db(), t.id)!;
  assert.deepEqual([task.session_id ?? null, task.rewind ?? null], [null, null]);
});

test("rewinding_waits_for_the_agent_and_its_reviews", async () => {
  const s = testing.state();
  const [t, wt] = await task_repo(s, false);
  const m = await turn(s, t.id, "one", () => write(wt, "a.txt", "a\n"));
  s.runs.set(t.id, { run_id: "r", cancel: null });
  const e = await rewind_error(do_rewind(s, t.id, m, false, false));
  assert.ok(e.includes("running"), e);
  assert.equal((await get_turns(s, t.id)).turns[0].rewind.ok, false);
  s.runs.clear();
  assert.ok(existsSync(join(wt, "a.txt")));
  await do_rewind(s, t.id, m, false, false);
  assert.ok(!existsSync(join(wt, "a.txt")));
});

test("files_git_hides_are_left_alone", async () => {
  const s = testing.state();
  const [t, wt] = await task_repo(s, false);
  // A submodule, a file marked skip-worktree and one marked assume-unchanged, each changed locally.
  const sub = testing.temp_dir();
  sh(sub, ["init", "-q", "-b", "master"]);
  sh(sub, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "one"]);
  sh(wt, ["submodule", "add", "-q", path_str(sub), "sub"]);
  write(wt, "local.cfg", "shared\n");
  write(wt, "au.txt", "shared\n");
  sh(wt, ["add", "-A"]);
  sh(wt, ["commit", "-qm", "setup"]);
  sh(wt, ["update-index", "--skip-worktree", "local.cfg"]);
  sh(wt, ["update-index", "--assume-unchanged", "au.txt"]);
  write(wt, "local.cfg", "mine\n");
  write(wt, "au.txt", "mine\n");
  const m = await turn(s, t.id, "one", () => {
    sh(join(wt, "sub"), ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "two"]);
    write(wt, "a.txt", "a\n");
    write(wt, "local.cfg", "mine, changed\n");
  });
  const sub_head = sh(join(wt, "sub"), ["rev-parse", "HEAD"]);
  const r = await do_rewind(s, t.id, m, false, false);
  assert.ok(!existsSync(join(wt, "a.txt")));
  assert.deepEqual(r.skipped, ["sub"]);
  assert.equal(sh(join(wt, "sub"), ["rev-parse", "HEAD"]), sub_head, "the submodule's checkout is its own");
  assert.deepEqual([read(wt, "local.cfg"), read(wt, "au.txt")], ["mine, changed\n", "mine\n"]);
  assert.equal(sh(wt, ["ls-files", "-v", "local.cfg", "au.txt"]), "h au.txt\nS local.cfg\n");
});

test("a_rewind_never_writes_over_what_the_checkpoints_dont_have", async () => {
  const s = testing.state();
  const [t, wt] = await task_repo(s, false);
  write(wt, "x", "a file\n");
  write(wt, "sub/file", "a folder\n");
  write(wt, "local.cfg", "old\n");
  const git = (dir: string, args: string[]) => sh(dir, ["-c", "user.name=t", "-c", "user.email=t@t", ...args]);
  const m = await turn(s, t.id, "one", () => {
    // A file becomes a folder, with an ignored file and another repository in it.
    unlinkSync(join(wt, "x"));
    write(wt, "x/a", "a\n");
    write(wt, "x/keep.log", "ignored\n");
    write(wt, "x/vendor/f", "theirs\n");
    git(join(wt, "x/vendor"), ["init", "-q"]);
    git(join(wt, "x/vendor"), ["add", "f"]);
    git(join(wt, "x/vendor"), ["commit", "-qm", "v"]);
    write(wt, "x/vendor/wip", "uncommitted\n");
    // A folder becomes another repository.
    rmSync(join(wt, "sub"), { recursive: true });
    write(wt, "sub/mine", "mine\n");
    git(join(wt, "sub"), ["init", "-q"]);
    git(join(wt, "sub"), ["add", "mine"]);
    git(join(wt, "sub"), ["commit", "-qm", "s"]);
    // A file the checkpoints had becomes ignored, and changes.
    write(wt, ".gitignore", "*.log\nlocal.cfg\n");
    write(wt, "local.cfg", "new\n");
  });
  const r = await do_rewind(s, t.id, m, false, false);
  const skipped: string[] = [...r.skipped].sort();
  assert.deepEqual(skipped, ["local.cfg", "sub", "sub/file", "x", "x/vendor"]);
  assert.ok(!existsSync(join(wt, "x/a")));
  assert.equal(read(wt, "x/keep.log"), "ignored\n");
  assert.equal(read(wt, "x/vendor/wip"), "uncommitted\n");
  assert.ok(is_dir(join(wt, "x/vendor/.git")));
  assert.deepEqual([read(wt, "sub/mine"), read(wt, "sub/file")], ["mine\n", null]);
  assert.equal(read(wt, "local.cfg"), "new\n");
  assert.equal(read(wt, ".gitignore"), "*.log\n");
});

test("a_rewind_that_fails_part_way_leaves_the_branch_alone", async () => {
  const s = testing.state();
  const [t, wt] = await task_repo(s, false);
  const m = await turn(s, t.id, "one", () => {
    write(wt, "a.txt", "a\n");
    sh(wt, ["add", "a.txt"]);
    sh(wt, ["commit", "-qm", "a"]);
    write(wt, "ro/f.txt", "f\n");
  });
  const head = sh(wt, ["rev-parse", "HEAD"]);
  // A file it can't remove.
  const ro = join(wt, "ro");
  chmodSync(ro, 0o555);
  const e = await rewind_error(do_rewind(s, t.id, m, false, true));
  chmodSync(ro, 0o755);
  assert.ok(e.includes("part way") && e.includes(ref_prefix(t.id)), e);
  assert.equal(sh(wt, ["rev-parse", "HEAD"]), head);
  // Once it can, it goes through, branch and all.
  await do_rewind(s, t.id, m, false, true);
  assert.equal(sh(wt, ["rev-parse", "HEAD"]), sh(wt, ["rev-parse", "master"]));
  assert.equal(files(wt), "");
});

test("a_rewind_goes_to_before_the_first_turn_a_message_started", async () => {
  const s = testing.state();
  const [t, wt] = await task_repo(s, false);
  const [run, m] = start(s, t.id, "go");
  const task = db.get_task(s.db(), t.id)!;
  await before_run(s, task, run);
  write(wt, "a.txt", "a\n");
  after_turn(s, run.id, "done");
  // The agent goes on by itself (a background task finished), with no message of the user's.
  write(wt, "b.txt", "b\n");
  after_turn(s, run.id, "done");
  const cps = await settled(s, t.id);
  const ts = cps.filter((c) => c.kind === "turn").map((c) => [c.turn, c.message_id]);
  assert.deepEqual(ts, [[1, m], [2, null]]);
  await do_rewind(s, t.id, m, false, false);
  assert.ok(!existsSync(join(wt, "a.txt")) && !existsSync(join(wt, "b.txt")));
});

test("a_rewind_never_follows_a_symlink_out_of_the_worktree", async () => {
  const s = testing.state();
  const [t, wt] = await task_repo(s, false);
  const outside = testing.temp_dir();
  write(outside, "keep.txt", "keep\n");
  const m = await turn(s, t.id, "one", () => {
    symlinkSync(outside, join(wt, "out"));
    write(wt, "d/x.txt", "x\n");
  });
  // A folder the turn made becomes a symlink to the outside afterwards.
  rmSync(join(wt, "d"), { recursive: true });
  symlinkSync(outside, join(wt, "d"));
  write(outside, "x.txt", "outside\n");
  await do_rewind(s, t.id, m, false, false);
  assert.throws(() => lstatSync(join(wt, "out")));
  assert.equal(read(outside, "keep.txt"), "keep\n");
  assert.equal(read(outside, "x.txt"), "outside\n");
});

test("files_a_merge_brought_in_are_left_out_of_a_turn", async () => {
  const s = testing.state();
  const [t, wt, repo] = await task_repo(s, false);
  write(wt, "mine.txt", "mine\n");
  sh(wt, ["add", "-A"]);
  sh(wt, ["commit", "-qm", "mine"]);
  // Master moves on meanwhile, in the main checkout.
  write(repo, "theirs.txt", "theirs\n");
  write(repo, "f.txt", "master's\n");
  sh(repo, ["add", "-A"]);
  sh(repo, ["commit", "-qm", "theirs"]);
  await turn(s, t.id, "merge", () => {
    // A merge with a conflict, resolved, and a change of its own.
    write(wt, "f.txt", "branch's\n");
    sh(wt, ["commit", "-qam", "branch f"]);
    const out = spawnSync("git", ["-C", wt, "merge", "-q", "master"]);
    assert.notEqual(out.status, 0);
    write(wt, "f.txt", "resolved\n");
    sh(wt, ["add", "f.txt"]);
    sh(wt, ["commit", "-q", "--no-edit"]);
    write(wt, "own.txt", "own\n");
  });
  const ts = await get_turns(s, t.id);
  const one = ts.turns[0];
  assert.deepEqual(one.stats.excluded, ["theirs.txt"]);
  const d = await get_diff(s, t.id, one.before_n, one.n);
  const patch: string = d.patch;
  assert.ok(patch.includes("+resolved") && patch.includes("own.txt") && !patch.includes("theirs.txt"), patch);
  assert.deepEqual(d.excluded, ["theirs.txt"]);
});

test("files_a_rebase_went_onto_are_left_out_of_a_turn", async () => {
  const s = testing.state();
  const [t, wt, repo] = await task_repo(s, false);
  write(wt, "mine.txt", "mine\n");
  sh(wt, ["add", "-A"]);
  sh(wt, ["commit", "-qm", "mine"]);
  write(repo, "more.txt", "more\n");
  sh(repo, ["add", "-A"]);
  sh(repo, ["commit", "-qm", "more"]);
  await turn(s, t.id, "rebase", () => {
    write(wt, "own.txt", "own\n");
    sh(wt, ["add", "-A"]);
    sh(wt, ["commit", "-qm", "own"]);
    sh(wt, ["rebase", "-q", "master"]);
  });
  let ts = await get_turns(s, t.id);
  const one = ts.turns[0];
  assert.deepEqual(one.stats.excluded, ["more.txt"], JSON.stringify(one));
  assert.equal(one.stats.files, 1);
  // Pulled in by a fast-forward: all of it is left out.
  write(repo, "ff.txt", "ff\n");
  sh(repo, ["add", "-A"]);
  sh(repo, ["commit", "-qm", "ff"]);
  const master = sh(repo, ["rev-parse", "master"]);
  await turn(s, t.id, "ff", () => {
    sh(wt, ["reset", "-q", "--hard", master.trim()]);
  });
  ts = await get_turns(s, t.id);
  const two = ts.turns[1];
  assert.equal(two.stats.files, 2, JSON.stringify(two));
});

test("checkpoints_go_with_the_worktree", async () => {
  const s = testing.state();
  // The project's repository is reached through a symlink.
  const [t, wt, repo] = await task_repo(s, true);
  await turn(s, t.id, "one", () => write(wt, "a.txt", "a\n"));
  assert.equal(sh(repo, ["for-each-ref", "--format=%(refname)", ref_prefix(t.id)]).trimEnd().split("\n").length, 2);
  await worktree.teardown(s, t.id, true, false);
  assert.equal(sh(repo, ["for-each-ref", ref_prefix(t.id)]), "");
  assert.equal(list(s.db(), t.id).length, 0);
  // Nothing landed in the repository the tests run in.
  const here = execFileSync("git", ["for-each-ref", ref_prefix(t.id)], { encoding: "utf8" });
  assert.equal(here, "");
});

test("checkpoints_stay_while_the_worktree_does", async () => {
  const s = testing.state();
  const [t, wt, repo] = await task_repo(s, false);
  await turn(s, t.id, "one", () => {
    write(wt, "a.txt", "a\n");
    sh(wt, ["add", "a.txt"]);
    sh(wt, ["commit", "-qm", "a"]);
  });
  const refs = () => sh(repo, ["for-each-ref", "--format=%(refname)", ref_prefix(t.id)]).split("\n").filter((l) => l).length;
  const rows = () => list(s.db(), t.id).length;
  assert.deepEqual([refs(), rows()], [2, 2]);
  // A teardown script that fails, or leaves changes, keeps the worktree: its checkpoints stay.
  for (const script of ["exit 1", "echo left > left.txt"]) {
    db.run(s.db(), "UPDATE projects SET teardown_script=?1 WHERE id=?2", script, t.project_id);
    await assert.rejects(worktree.teardown(s, t.id, false, false), script);
    assert.ok(is_dir(wt));
    assert.deepEqual([refs(), rows()], [2, 2], script);
    rmSync(join(wt, "left.txt"), { force: true });
  }
  // A worktree folder deleted by hand: they go with it.
  db.run(s.db(), "UPDATE projects SET teardown_script='' WHERE id=?1", t.project_id);
  rmSync(wt, { recursive: true });
  await worktree.teardown(s, t.id, false, false);
  assert.deepEqual([refs(), rows()], [0, 0]);
});

test("the_oldest_checkpoints_go_past_the_cap", async () => {
  const s = testing.state();
  const [t, wt] = await task_repo(s, false);
  for (let i = 0; i < MAX_CHECKPOINTS + 3; i++) {
    const [run] = start(s, t.id, "go");
    write(wt, "n.txt", `${i}\n`);
    after_turn(s, run.id, "done");
  }
  const cps = await settled(s, t.id);
  assert.equal(cps.length, MAX_CHECKPOINTS);
  assert.equal(cps[0].n, 3);
  const refs = sh(wt, ["for-each-ref", "--format=%(refname)", ref_prefix(t.id)]);
  assert.equal(refs.split("\n").filter((l) => l).length, MAX_CHECKPOINTS);
  assert.ok(!refs.includes(`${ref_name(t.id, 2)}\n`));
});

function cp(n: number, turn: number | null, session: string, at: string | null, stale: number): Checkpoint {
  return {
    n,
    kind: turn !== null ? "turn" : "start",
    sha: "",
    tree: "",
    head: null,
    before_n: n - 1,
    run_id: null,
    turn,
    message_id: turn !== null ? turn * 10 : null,
    status: null,
    session,
    agent_at: at,
    stats: null,
    stale,
    created_at: "",
  };
}

test("the_conversation_goes_back_to_the_turn_before_still_in_it", () => {
  const c = db.open(":memory:");
  const p = db.insert_profile(c, "p", [], null);
  const nt = { profile_id: p.id, project_id: null, kind: "task", title: "t", description: "", status: "todo", use_worktree: false, model: null, effort: null, claude_config_id: null };
  const task: Task = { ...db.insert_task(c, nt as any), session_id: "s" };
  const rows = [cp(0, null, "s", null, 0), cp(1, 1, "s", "u1", 0), cp(2, 2, "s", "u2", 2), cp(3, 3, "s", "u3", 1), cp(4, 4, "s", "u4", 0)];
  const back = (turn: Checkpoint, codex: boolean) => conversation(task, rows, turn, codex, 10);
  const resume = (at: string, turn: number): { ok: Convo } => ({ ok: { kind: "Back", rewind: { turn, message_id: turn * 10, session: "s", resume_at: at } } });
  // Turn 2 was taken out of the conversation already; turn 3 only had its files rewound.
  assert.deepEqual(back(rows[4], false), resume("u3", 4));
  assert.deepEqual(back(rows[3], false), resume("u1", 3));
  assert.deepEqual(back(rows[1], false), { ok: { kind: "Fresh" } });
  assert.deepEqual(back(rows[4], true), { ok: { kind: "Back", rewind: { turn: 4, message_id: 40, session: "s", before_turn: "u4" } } });
  assert.deepEqual(back(rows[1], true), { ok: { kind: "Fresh" } });
  // A new session since, or no record of where the conversation was.
  const other: Task = { ...task, session_id: "other" };
  assert.ok("err" in conversation(other, rows, rows[4], false, 10));
  assert.ok("err" in conversation(other, rows, rows[4], true, 10));
  assert.ok("err" in conversation(task, rows, rows[1], false, 5));
  assert.deepEqual(conversation({ ...task, session_id: null }, rows, rows[4], false, 10), { ok: { kind: "Nothing" } });
});

test("reads_diff_headers", () => {
  assert.equal(header_path("diff --git a/x y b/x y"), "x y");
  assert.equal(header_path("diff --git a/a b/c b/a b/c"), "a b/c");
  assert.equal(header_path('diff --git "a/t\\tab" "b/t\\tab"'), "t\tab");
  assert.equal(header_path('diff --git "a/\\303\\251" "b/\\303\\251"'), "é");
  const patch = "diff --git a/k b/k\n+k\ndiff --git a/x b/x\n+x\ndiff --git a/k2 b/k2\n+k2\n";
  assert.equal(without(patch, new Set(["x"])), "diff --git a/k b/k\n+k\ndiff --git a/k2 b/k2\n+k2\n");
  const cases: Array<[string, boolean]> = [
    ["commit: x", true],
    ["commit (amend): x", true],
    ["commit (merge): Merge branch 'master'", true],
    ["merge master: Merge made by the 'ort' strategy.", true],
    ["rebase (pick): x", true],
    ["pull --rebase (pick): x", true],
    ["cherry-pick: x", true],
    ["merge master: Fast-forward", false],
    ["pull: Fast-forward", false],
    ["rebase (finish): returning to refs/heads/x", false],
    ["rebase (start): checkout master", false],
    ["reset: moving to HEAD~1", false],
    ["checkout: moving from a to b", false],
  ];
  for (const [subject, made] of cases) assert.equal(creates_commit(subject), made, subject);
});
