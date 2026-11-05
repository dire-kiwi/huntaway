// The tests of server/src/review/fanout.rs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MessageChannel, Worker, receiveMessageOnPort } from "node:worker_threads";
import * as db from "../db.ts";
import type { Task } from "../db.ts";
import * as api from "../api.ts";
import * as runner from "../agent/runner.ts";
import * as worktree from "../git/worktree.ts";
import * as gh_mcp from "../mcp/gh_mcp.ts";
import * as testing from "../testing.ts";
import { ApiError, AppState } from "../state.ts";
import type { Req } from "../http.ts";
import { Pick_default, get, pick_inner, type Pick } from "./fanout.ts";

function sh(dir: string, args: string[]) {
  execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { stdio: "ignore" });
}

function has_ref(dir: string, r: string): boolean {
  return spawnSync("git", ["-C", dir, "rev-parse", "--verify", "--quiet", r], { stdio: "ignore" }).status === 0;
}

const req = (id: string) => ({ params: { id }, query: {}, body: {} }) as unknown as Req;
const P = (p: Partial<Pick>): Pick => ({ ...Pick_default(), ...p });

/**
 * A repository (on master, pushed to a bare `origin`) with three tasks made from one prompt, each with a worktree and
 * a commit of its own: the folder everything is in, and the tasks.
 */
async function fanned_out(s: AppState): Promise<[string, Task[]]> {
  const profile = db.insert_profile(s.db(), "p", [], null);
  const root = testing.temp_dir();
  const [repo, origin] = [join(root, "repo"), join(root, "origin.git")];
  mkdirSync(repo, { recursive: true });
  sh(root, ["init", "-q", "--bare", "-b", "master", origin]);
  sh(repo, ["init", "-q", "-b", "master"]);
  writeFileSync(join(repo, "readme"), "hi\n");
  sh(repo, ["add", "."]);
  sh(repo, ["commit", "-qm", "init"]);
  sh(repo, ["remote", "add", "origin", origin]);
  sh(repo, ["push", "-q", "-u", "origin", "master"]);
  const p = await api.create_project_inner(s, profile.id, { name: "x", repo_path: repo, key: "X", base_branch: "master", use_worktrees: null });
  const tasks: Task[] = [];
  for (const model of ["opus", "sonnet", "haiku"]) {
    const t = api.create_task_inner(s, p.id, { ...api.CreateTask_default(), title: "Do it", model, fanout_id: "f-1" });
    const ready = await worktree.setup(s, t.id);
    const wt = ready.worktree_path!;
    writeFileSync(join(wt, model), `${model}\n`);
    sh(wt, ["add", "."]);
    sh(wt, ["commit", "-qm", model]);
    tasks.push(ready);
  }
  return [root, tasks];
}

const task = (s: AppState, id: string) => db.get_task(s.db(), id)!;

test("lists_how_long_each_ran_and_what_is_uncommitted", async () => {
  const s = testing.state();
  const [, ts] = await fanned_out(s);
  const wt = ts[1].worktree_path!;
  writeFileSync(join(wt, "loose"), "x");
  sh(wt, ["push", "-q", "-u", "origin", ts[1].branch!]);
  db.run(
    s.db(),
    "INSERT INTO runs (id,task_id,kind,status,created_at,ended_at) VALUES ('r1',?1,'prompt','exited','2026-01-01T10:00:00.000Z','2026-01-01T10:01:30.000Z')",
    ts[0].id,
  );
  db.run(
    s.db(),
    "INSERT INTO runs (id,task_id,kind,status,created_at,ended_at) VALUES ('r2',?1,'prompt','exited','2026-01-01T11:00:00.000Z','2026-01-01T11:00:30.000Z')",
    ts[0].id,
  );
  const v = await get(s, req(ts[2].id));
  const got = v.tasks;
  assert.deepEqual(
    got.map((f: any) => f.id),
    ts.map((t) => t.id),
  );
  assert.deepEqual([Math.round(got[0].run_secs), got[0].runs], [120, 2]);
  assert.deepEqual([got[1].uncommitted, got[1].uncommitted_count], [["?? loose"], 1]);
  assert.equal(got[1].pushed, `origin/${ts[1].branch}`);
  assert.deepEqual([got[0].uncommitted, got[0].pushed, got[0].branch], [[], null, ts[0].branch]);
});

test("picking_one_completes_the_others_and_keeps_uncommitted_work", async () => {
  const s = testing.state();
  const [root, ts] = await fanned_out(s);
  const [a, b, c] = ts;
  const c_wt = c.worktree_path!;
  writeFileSync(join(c_wt, "draft"), "not committed");
  let v = await pick_inner(s, a.id, Pick_default());
  let r = v.results;
  assert.equal(r.length, 2);
  assert.deepEqual([r[0].key, r[0].completed, r[0].worktree, r[0].branch, r[0].pr], ["X-2", true, "removed", "kept", "none"]);
  assert.deepEqual([r[1].completed, r[1].worktree], [true, "kept"]);
  assert.ok(r[1].notes[0].includes("uncommitted changes"), JSON.stringify(r[1].notes));
  for (const t of [b, c]) {
    const now = task(s, t.id);
    assert.deepEqual([now.status, now.resolution], ["done", "not_done"]);
  }
  // Picked, it stays as it was; the others' commits are still on their branches.
  assert.equal(task(s, a.id).status, a.status);
  assert.ok(existsSync(a.worktree_path!));
  assert.ok(!existsSync(b.worktree_path!));
  assert.ok(existsSync(join(c_wt, "draft")));
  const repo = join(root, "repo");
  assert.ok(has_ref(repo, `refs/heads/${b.branch}`));
  const said = testing.messages(s.db(), b.id);
  assert.ok(said.some((m: any) => typeof m.data.text === "string" && m.data.text.includes("X-1, made from the same prompt, was picked")));

  // A task completed as not done isn't picked over the one that was, until it's moved out of Done.
  await assert.rejects(pick_inner(s, b.id, Pick_default()), (e) => e instanceof ApiError && e.status === 409);
  assert.equal(task(s, a.id).status, a.status);

  // Asked again to discard what's uncommitted and delete the branches: the ones done already are cleaned up too.
  v = await pick_inner(s, a.id, P({ delete_branches: true, discard_uncommitted: true }));
  r = v.results;
  assert.deepEqual([r[0].completed, r[0].worktree, r[0].branch], [false, "none", "deleted"]);
  assert.deepEqual([r[1].worktree, r[1].branch, r[1].notes], ["removed", "deleted", []]);
  assert.ok(!existsSync(c_wt));
  for (const t of [b, c]) {
    assert.ok(!has_ref(repo, `refs/heads/${t.branch}`));
    assert.equal(task(s, t.id).branch, null);
  }
  assert.ok(has_ref(repo, `refs/heads/${a.branch}`));
});

test("deletes_pushed_branches_and_closes_pull_requests_only_when_asked", async () => {
  const s = testing.state();
  const [root, ts] = await fanned_out(s);
  const [repo, origin] = [join(root, "repo"), join(root, "origin.git")];
  for (const t of ts.slice(1)) sh(t.worktree_path!, ["push", "-q", "-u", "origin", t.branch!]);
  // No real GitHub: gh says what it was asked to do.
  const log = join(root, "gh.log");
  const gh = join(root, "gh");
  writeFileSync(gh, `#!/bin/sh\necho "$*" >> '${log}'\n`);
  chmodSync(gh, 0o755);
  gh_mcp.TEST_GH_PROGRAM.set(gh);
  try {
    const pr = "https://github.com/o/r/pull/7";
    s.update_task(ts[1].id, [["pr_url", pr]]);

    // Branches deleted, pull requests kept open: the pull request's branch is kept, here and where it's pushed.
    let v = await pick_inner(s, ts[0].id, P({ delete_branches: true }));
    let r = v.results;
    assert.deepEqual([r[0].branch, r[0].pushed_branch, r[0].pr], ["kept", "kept", "kept"]);
    assert.ok(r[0].notes[0].includes("its pull request is still open"), JSON.stringify(r[0].notes));
    assert.deepEqual([r[1].branch, r[1].pushed_branch], ["deleted", "deleted"]);
    const b1 = `refs/heads/${ts[1].branch}`;
    assert.ok(has_ref(origin, b1) && has_ref(repo, b1));
    assert.ok(!has_ref(origin, `refs/heads/${ts[2].branch}`));
    assert.ok(!existsSync(log));
    // So the board still offers to delete it.
    const f = await get(s, req(ts[0].id));
    assert.equal(f.tasks[1].pushed, `origin/${ts[1].branch}`);

    // HA-51 review: asked to close it on a later pick, it's closed, and then its branch goes too, from both.
    v = await pick_inner(s, ts[0].id, P({ close_prs: true, delete_branches: true }));
    r = v.results[0];
    assert.deepEqual([r.pr, r.branch, r.pushed_branch, r.notes], ["closed", "deleted", "deleted", []]);
    assert.equal(readFileSync(log, "utf8"), `pr close ${pr}\n`);
    assert.ok(!has_ref(origin, b1) && !has_ref(repo, b1));
    assert.ok(has_ref(repo, `refs/heads/${ts[0].branch}`));
  } finally {
    gh_mcp.TEST_GH_PROGRAM.set(null);
  }
});

// HA-51 review: a pushed copy that couldn't be deleted was forgotten with the branch here, so picking again couldn't
// delete it.
test("a_pushed_branch_that_cant_be_deleted_is_deleted_by_picking_again", async () => {
  const s = testing.state();
  const [root, ts] = await fanned_out(s);
  const [repo, origin] = [join(root, "repo"), join(root, "origin.git")];
  sh(ts[1].worktree_path!, ["push", "-q", "-u", "origin", ts[1].branch!]);
  const hook = join(origin, "hooks/pre-receive");
  writeFileSync(hook, "#!/bin/sh\necho no deleting >&2\nexit 1\n");
  chmodSync(hook, 0o755);
  const del = P({ delete_branches: true });
  let v = await pick_inner(s, ts[0].id, del);
  let r = v.results[0];
  assert.deepEqual([r.worktree, r.branch, r.pushed_branch], ["removed", "kept", "kept"]);
  assert.ok(r.notes[0].includes("no deleting"), JSON.stringify(r.notes));
  const b1 = `refs/heads/${ts[1].branch}`;
  assert.ok(has_ref(repo, b1) && has_ref(origin, b1));
  rmSync(hook);
  v = await pick_inner(s, ts[0].id, del);
  r = v.results[0];
  assert.deepEqual([r.branch, r.pushed_branch, r.notes], ["deleted", "deleted", []]);
  assert.ok(!has_ref(repo, b1) && !has_ref(origin, b1));
});

// HA-51 review: commits on a detached HEAD are on no branch, so removing the worktree lost them.
test("a_worktree_with_commits_on_no_branch_is_kept", async () => {
  const s = testing.state();
  const [, ts] = await fanned_out(s);
  const wt = ts[1].worktree_path!;
  sh(wt, ["checkout", "-q", "--detach"]);
  writeFileSync(join(wt, "loose"), "x");
  sh(wt, ["add", "."]);
  sh(wt, ["commit", "-qm", "detached"]);
  const f = await get(s, req(ts[0].id));
  assert.deepEqual([f.tasks[1].stray_commits, f.tasks[1].uncommitted_count, f.tasks[2].stray_commits], [1, 0, 0]);
  const v = await pick_inner(s, ts[0].id, P({ delete_branches: true, discard_uncommitted: true, close_prs: true }));
  const r = v.results;
  assert.deepEqual([r[0].completed, r[0].worktree, r[0].branch], [true, "kept", "kept"]);
  assert.ok(r[0].notes[0].includes("1 commit on no branch"), JSON.stringify(r[0].notes));
  assert.ok(existsSync(join(wt, "loose")));
  assert.deepEqual([r[1].worktree, r[1].branch], ["removed", "deleted"]);
});

/**
 * Task `t`'s agent at work, as the runner has it: a run, its handle (which stopping cancels) and the task marked
 * running. The run ends as the runner ends one that's stopped, a moment after.
 */
function at_work(s: AppState, t: Task) {
  const run = db.insert_run(s.db(), t.id, "prompt");
  db.run(s.db(), "UPDATE runs SET status='running', between_turns=1 WHERE id=?1", run.id);
  const cancel = () => {
    setTimeout(() => runner.finish(s, run.id, "Cancelled"), 300);
  };
  s.runs.set(t.id, { run_id: run.id, cancel });
  // With a pull request, the run's end doesn't look one up with gh.
  s.update_task(t.id, [
    ["running", true],
    ["status", "in_progress"],
    ["pr_url", "https://github.com/o/r/pull/1"],
  ]);
}

test("an_agent_at_work_is_stopped_before_its_task_is_completed", async () => {
  const s = testing.state();
  const [, ts] = await fanned_out(s);
  at_work(s, ts[1]);
  const v = await pick_inner(s, ts[0].id, Pick_default());
  const r = v.results[0];
  assert.deepEqual([r.stopped, r.completed, r.worktree, r.notes], [true, true, "removed", []]);
  const t = task(s, ts[1].id);
  assert.deepEqual([t.status, t.resolution, t.running], ["done", "not_done", false]);
});

/**
 * Runs `pick_inner(<a state on the database at db_path>, id, Pick_default())` to its end on a worker thread, with this
 * thread blocked meanwhile: as Rust's test picks on a runtime of its own from inside `runner::finish`. (`finish` is
 * synchronous here, so a pick on this thread could only run once it has returned.) The worker's state has a database
 * connection of its own and no runs (`finish` has taken the run out of `s.runs` by then).
 */
function pick_on_another_thread(db_path: string, data_dir: string, id: string): any {
  const url = (p: string) => new URL(p, import.meta.url).href;
  const done = new Int32Array(new SharedArrayBuffer(4));
  const { port1, port2 } = new MessageChannel();
  const code = `
    const { workerData: w } = require("node:worker_threads");
    (async () => {
      let out;
      try {
        const db = await import(w.db), { AppState } = await import(w.state), fanout = await import(w.fanout);
        const meta = { boot_id: "", started_at: "", source_dir: null, running_commit: null, update_from: null, release: null, args: [] };
        const ids = { host_id: "h", host_name: "desktop", token: "", hub_token: "", internal_url: "" };
        const s = new AppState(db.open(w.db_path), w.data_dir, ids, meta);
        out = { ok: await fanout.pick_inner(s, w.id, fanout.Pick_default()) };
      } catch (e) {
        out = { err: String(e && e.stack || e) };
      }
      w.port.postMessage(JSON.parse(JSON.stringify(out)));
      Atomics.store(w.done, 0, 1);
      Atomics.notify(w.done, 0);
    })();`;
  const workerData = { db: url("../db.ts"), state: url("../state.ts"), fanout: url("./fanout.ts"), db_path, data_dir, id, done, port: port2 };
  const worker = new Worker(code, { eval: true, workerData, transferList: [port2] });
  try {
    assert.equal(Atomics.wait(done, 0, 0, 30_000), "ok", "the pick on the worker didn't end");
    const out = receiveMessageOnPort(port1)!.message;
    if (out.err) throw new Error(out.err);
    return out.ok;
  } finally {
    worker.terminate();
    port1.close();
  }
}

// HA-51 review: the run was marked exited before the runner wrote its end to the task, and picking in between
// completed the task only for the runner to move it to Needs attention.
test("a_task_is_completed_only_once_the_runner_has_written_its_runs_end", async () => {
  // On a database file, which the worker's pick opens too.
  const dir = testing.temp_dir();
  const db_path = join(dir, "huntaway.db");
  const s = new AppState(db.open(db_path), dir, { host_id: "h", host_name: "desktop", token: "", hub_token: "", internal_url: "" }, testing.meta());
  const [, ts] = await fanned_out(s);
  const run = db.insert_run(s.db(), ts[1].id, "prompt");
  db.run(s.db(), "UPDATE runs SET status='running', between_turns=1 WHERE id=?1", run.id);
  s.runs.set(ts[1].id, { run_id: run.id, cancel: null });
  s.update_task(ts[1].id, [["running", true], ["status", "in_progress"], ["pr_url", "https://github.com/o/r/pull/1"]]);
  // Picked once the run is marked exited, before its end is written to the task.
  let v: any = null;
  testing.when("finish:exited", () => {
    v = pick_on_another_thread(db_path, dir, ts[0].id);
  });
  runner.finish(s, run.id, "Cancelled");
  const r = v.results[0];
  assert.deepEqual([r.completed, r.worktree], [false, "kept"]);
  assert.ok(r.notes[0].includes("didn't stop in time"), JSON.stringify(r.notes));
  // Left as the runner left it, not completed and then moved back.
  const t = task(s, ts[1].id);
  assert.deepEqual([t.status, t.resolution ?? null], ["needs_attention", null]);
});

test("one_whose_agent_does_not_stop_is_left_as_it_is", async () => {
  const s = testing.state();
  const [, ts] = await fanned_out(s);
  // A run that never ends (no agent to stop).
  db.run(s.db(), "INSERT INTO runs (id,task_id,kind,status,created_at) VALUES ('r1',?1,'prompt','running','2026-01-01T10:00:00.000Z')", ts[1].id);
  const v = await pick_inner(s, ts[0].id, P({ delete_branches: true, discard_uncommitted: true, close_prs: true }));
  const r = v.results;
  assert.deepEqual([r[0].completed, r[0].worktree, r[0].branch], [false, "kept", "kept"]);
  assert.ok(r[0].notes[0].includes("didn't stop in time"), JSON.stringify(r[0].notes));
  assert.equal(task(s, ts[1].id).status, ts[1].status);
  assert.ok(existsSync(ts[1].worktree_path!));
  assert.deepEqual([r[1].completed, r[1].worktree], [true, "removed"]);
});

test("only_the_profiles_own_tasks_are_picked_over", async () => {
  const s = testing.state();
  const [root, ts] = await fanned_out(s);
  // Another profile's task with the same fanout id.
  const other = db.insert_profile(s.db(), "q", [], null);
  mkdirSync(join(root, "other"), { recursive: true });
  const p = await api.create_project_inner(s, other.id, { name: "y", repo_path: join(root, "other"), key: "Y", base_branch: null, use_worktrees: false });
  const theirs = api.create_task_inner(s, p.id, { ...api.CreateTask_default(), title: "Theirs", fanout_id: "f-1" });
  const v = await get(s, req(ts[0].id));
  assert.equal(v.tasks.length, 3);
  const picked = await pick_inner(s, ts[0].id, Pick_default());
  assert.equal(picked.results.length, 2);
  assert.equal(task(s, theirs.id).status, theirs.status);
  // And theirs alone has nothing to be picked over.
  await assert.rejects(pick_inner(s, theirs.id, Pick_default()), (e) => e instanceof ApiError && e.status === 400);
});
