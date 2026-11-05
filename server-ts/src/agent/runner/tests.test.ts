// Port of server/src/agent/runner/tests.rs.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as db from "../../db.ts";
import type { Run, Task } from "../../db.ts";
import type { Shared } from "../../state.ts";
import * as testing from "../../testing.ts";
import { new_id, path_str, sleep } from "../../util.ts";
import * as runs from "../runs.ts";
import * as codex from "../codex.ts";
import * as documents from "../documents.ts";
import * as context from "../context.ts";
import * as title from "../title.ts";
import * as usage from "../usage.ts";
import * as agent_tools from "../agent_tools.ts";
import * as assistant from "../assistant.ts";
import * as prompts from "../prompts.ts";
import * as analytics from "../../analytics.ts";
import * as api from "../../api.ts";
import * as review from "../../review.ts";
import * as summary from "../../review/summary.ts";
import * as automations from "../../integrations/automations.ts";
import { ApiError } from "../../http.ts";
import type { Req } from "../../http.ts";
import type { Github } from "../../git/worktree.ts";
import {
  STEER_GRACE,
  STOP_GRACE,
  abandon,
  launch_ended,
  load_active,
  start_run,
  stop,
  work_dir,
  // access
  approves_own_waits,
  board_tools_allowed,
  cache_dirs_in,
  codex_effort,
  codex_run_effort,
  gh_allowed,
  gh_hook_settings,
  gh_note,
  github_account,
  ignored_dirs,
  review_filesystem,
  uses_gh_server,
  // merge
  as_told,
  stacked_merge,
  // output
  finish,
  handle_line,
  on_exit,
  on_output,
  // prompt
  preview,
  profiles_note,
  key_prefix,
  start_prompt,
  system_prompt,
  // queue
  requeue_steers,
  send,
  set_writes_documents,
  unqueue,
  write_steers,
  writes_documents,
  // send
  compact,
  send_fixes,
  send_from_agent,
  send_message,
  start_unblocked,
  start_waiting,
} from "../runner.ts";
import { claude_effort, record_effort } from "./launch.ts";

// Rust's tests find no ia-shim beside the test binary, so only TEST_CAN_RUN makes a test host run agents; runs.ts would
// find the checkout's built ia-shim, and real agents would start.
process.env.IA_SHIM_BIN = "/nonexistent/ia-shim";
// The reaper's waits, as Rust's are under cfg(test).
runs.timing.REAP_WAIT = 5000;
runs.timing.REAP_GRACE = 1000;

beforeEach(() => {
  runs.TEST_CAN_RUN.set(false);
  title.TEST.reset();
});

const new_project = (c: db.Conn, p: Partial<db.NewProject> & { profile_id: string }): db.Project =>
  db.insert_project(c, {
    id: "pr",
    name: "x",
    key: "X",
    repo_path: "/x",
    scratch_path: "/s",
    worktrees_root: "/w",
    base_branch: null,
    use_worktrees: false,
    ...p,
  });

const new_task = (c: db.Conn, t: Partial<db.NewTask> & { profile_id: string }): Task =>
  db.insert_task(c, {
    project_id: null,
    kind: "task",
    title: "t",
    description: "",
    status: "todo",
    use_worktree: false,
    model: null,
    effort: null,
    claude_config_id: null,
    ...t,
  });

/** Runs git in `dir`, asserting it succeeds. */
const git_in = (dir: string, args: string[]) => assert.equal(spawnSync("git", args, { cwd: dir, stdio: "ignore" }).status, 0, `git ${args.join(" ")}`);

/** Whether a process has exited. */
const exited = (p: ChildProcess) => p.exitCode !== null || p.signalCode !== null;

/** A process in a process group of its own, as ia-shim starts the agent. */
const agent_process = (cmd: string, args: string[]) => spawn(cmd, args, { detached: true, stdio: "ignore" });

const kill_group = (p: ChildProcess) => {
  try {
    process.kill(-p.pid!, "SIGKILL");
  } catch {}
};

/** Wait for `f` to hold, for up to 5s. */
const until = async (f: () => boolean) => {
  const deadline = Date.now() + 5000;
  while (!f()) {
    assert.ok(Date.now() < deadline, "timed out");
    await sleep(20);
  }
};

/** Let spawned work (title refreshes) finish. */
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};

/** A handler's request, for calling it directly. */
const req = (params: Record<string, string>, body: any = {}): Req =>
  ({ method: "GET", path: "", params, query: {}, query_string: "", headers: {}, body, raw: Buffer.alloc(0) }) as Req;

test("caches_are_writable_before_their_first_use", () => {
  const home = testing.temp_dir();
  // A bare home directory: no `~/.cargo` (a system Cargo) or `~/.local/share` yet.
  let found = cache_dirs_in(home, () => null);
  assert.deepEqual(found, [".cache", ".npm", ".cargo/registry", ".cargo/git", ".local/share/pnpm"].map((d) => path_str(join(home, d))));
  assert.ok(found.every((d) => existsSync(d)));
  // Where the environment moves them.
  const env = (k: string) =>
    ({ XDG_CACHE_HOME: path_str(join(home, "xdg/cache")), XDG_DATA_HOME: path_str(join(home, "xdg/data")), CARGO_HOME: path_str(join(home, "cargo")) })[k] ??
    "";
  found = cache_dirs_in(home, env);
  assert.deepEqual(found, ["xdg/cache", ".npm", "cargo/registry", "cargo/git", "xdg/data/pnpm"].map((d) => path_str(join(home, d))));
  assert.ok(found.every((d) => existsSync(d)));
});

test("many_long_ignored_directories_dont_block_the_launch", async () => {
  const dir = testing.temp_dir();
  // More than check-ignore's input and output pipes hold together (64 KiB each): 200 paths of ~730 bytes.
  const long = "x".repeat(240);
  const expected: string[] = [];
  for (let i = 0; i < 10; i++) {
    for (let j = 0; j < 20; j++) {
      const parent = join(dir, `${i}${long}/${j}${long}`);
      mkdirSync(parent, { recursive: true });
      writeFileSync(join(parent, "tracked"), "1");
      const d = join(parent, `${long}.ign`);
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, "f"), "1");
      expected.push(path_str(d));
    }
  }
  writeFileSync(join(dir, ".gitignore"), "*.ign\n");
  git_in(dir, ["init", "-q", "."]);
  git_in(dir, ["add", "."]);
  const found = (await ignored_dirs(path_str(dir))).sort();
  expected.sort();
  const base = path_str(dir).length;
  assert.ok(expected.map((p) => p.length - base).reduce((a, b) => a + b, 0) > 140 * 1024);
  assert.deepEqual(found, expected);
});

test("a_reviewers_work_stays_read_only_inside_a_cache", () => {
  const fs = review_filesystem(["/home/me/.cache", "/home/me/.cache/w/target"], ["/home/me/.cache/w", "/home/me/.cache/repo/.git"]);
  assert.deepEqual(Object.entries(fs), [
    ["/home/me/.cache", "write"],
    ["/home/me/.cache/repo/.git", "read"],
    ["/home/me/.cache/w", "read"],
    ["/home/me/.cache/w/target", "write"],
  ]);
});

test("a_reviewer_may_write_the_directories_git_ignores_whole", async () => {
  const dir = testing.temp_dir();
  for (const d of ["target/debug", "app/node_modules/x", "build", ".claude", "src"]) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, ".gitignore"), "target\nnode_modules\nbuild\n.claude\n.env\n");
  for (const f of ["build/tracked", "build/untracked", ".env", "src/a.rs", "app/node_modules/x/i", ".claude/settings.local.json"]) writeFileSync(join(dir, f), "1");
  git_in(dir, ["init", "-q", "."]);
  git_in(dir, ["add", ".gitignore", "src"]);
  git_in(dir, ["add", "-f", "build/tracked"]);
  const found = (await ignored_dirs(path_str(dir))).sort();
  // Not `build`, which holds a tracked file, nor the agents' settings.
  assert.deepEqual(found, [path_str(join(dir, "app/node_modules")), path_str(join(dir, "target"))]);
  assert.deepEqual(await ignored_dirs(path_str(join(testing.temp_dir(), "no-such-dir"))), []);
});

test("only_merging_tasks_merge_without_asking", async () => {
  const gh_mcp = await import("../../mcp/gh_mcp.ts");
  const c = db.open(":memory:");
  const p = db.insert_profile(c, "p", [], null);
  new_project(c, { profile_id: p.id });
  const task = new_task(c, { profile_id: p.id, project_id: "pr", status: "in_review" });
  assert.deepEqual(gh_allowed(task), [...gh_mcp.READ_ONLY]);
  const merging = { ...task, merging: true, status: "ready_for_merge" };
  assert.deepEqual(gh_allowed(merging), [...gh_mcp.READ_ONLY, "pr_merge"]);
  // Still merging while it waits on the user, so their reply's run can merge too.
  assert.ok(gh_allowed({ ...merging, status: "needs_attention" }).includes("pr_merge"));
  assert.ok(!gh_allowed({ ...merging, kind: "review" }).includes("pr_merge"));
});

test("a_message_queued_during_a_run_waits_for_new_dependencies", () => {
  const state = testing.state();
  const c = state.db();
  const p = db.insert_profile(c, "p", [], null);
  new_project(c, { profile_id: p.id });
  const a = new_task(c, { profile_id: p.id, project_id: "pr", title: "a" });
  let b = new_task(c, { profile_id: p.id, project_id: "pr", title: "b" });
  runs.TEST_CAN_RUN.set(true);

  // B's agent is running; it gets a dependency on A and a message is queued meanwhile.
  const run = db.insert_run(state.db(), b.id, "prompt");
  state.runs.set(b.id, { run_id: run.id, cancel: null });
  state.update_task(b.id, [["running", true], ["status", "in_progress"], ["depends_on", [a.id]]]);
  send(state, b.id, "and then this");
  finish(state, run.id, "Ok");

  b = db.get_task(state.db(), b.id)!;
  assert.ok(!state.is_running(b.id));
  assert.deepEqual([b.running, b.waiting, b.status], [false, true, "in_progress"]);
  assert.equal(b.queued_message, "and then this");
});

test("an_effort_a_codex_model_doesnt_take_gives_way_to_its_default", async () => {
  const model = (id: string, is_default: boolean, efforts: string[], default_effort: string | null): codex.Model =>
    ({ id, name: id, is_default, efforts, default_effort }) as codex.Model;
  const models = [model("gpt-5.5", true, ["low", "medium", "high", "xhigh"], "medium"), model("gpt-6", false, ["low", "max"], null), model("odd", false, [], null)];
  const e = (effort: string, m: string | null) => codex_effort(effort, m, models);
  assert.equal(e("max", "gpt-5.5"), "medium");
  assert.equal(e("high", "gpt-5.5"), "high");
  // No model: the default one's.
  assert.equal(e("max", null), "medium");
  assert.equal(e("max", "gpt-6"), "max");
  assert.equal(e("high", "gpt-6"), null, "no default of its own: Codex picks");
  // A model it doesn't know, or one that doesn't list its efforts, keeps it.
  assert.equal(e("max", "gpt-7"), "max");
  assert.equal(e("max", "odd"), "max");
  assert.equal(codex_effort(null, "gpt-5.5", models), null);

  // A run checks the model it runs with, its own or inherited, with the config's models (as Codex lists them).
  const home = `/tmp/ia-codex-${new_id()}`;
  codex.set_test_models(home, [...models]);
  const s = testing.state();
  const cfg = db.insert_claude_config(s.db(), "Codex", home, "codex");
  assert.equal(await codex_run_effort(cfg, "gpt-5.5", "max"), "medium");
  assert.equal(await codex_run_effort(cfg, "gpt-6", "max"), "max");
  assert.equal(await codex_run_effort(cfg, null, "max"), "medium");
  assert.equal(await codex_run_effort(cfg, "gpt-5.5", null), null);
});

/** A task whose agent is running a run that takes input (or not), with no process behind it. */
export function running(input: boolean): [Shared, Task, Run] {
  const state = testing.state();
  const p = db.insert_profile(state.db(), "p", [], null);
  const task = new_task(state.db(), { profile_id: p.id, status: "in_progress" });
  const run = db.insert_run(state.db(), task.id, "prompt");
  db.run(state.db(), "UPDATE runs SET status='running' WHERE id=?1", run.id);
  const dir = runs.run_dir(state, run.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "out.jsonl"), "");
  if (input) writeFileSync(join(dir, "input.jsonl"), "");
  state.runs.set(task.id, { run_id: run.id, cancel: null });
  const t = state.update_task(task.id, [["running", true]])!;
  return [state, t, db.get_run(state.db(), run.id)!];
}

/** The agent writes `lines` to its output. */
function output(state: Shared, run: Run, lines: any[]) {
  const offset = db.get_run(state.db(), run.id)!.out_offset;
  const data = lines.map((l) => `${JSON.stringify(l)}\n`).join("");
  on_output(state, run.id, offset, data);
}

/** What the agent has been sent after its prompt. */
function input(state: Shared, run: Run): any[] {
  const text = readFileSync(join(runs.run_dir(state, run.id), "input.jsonl"), "utf8");
  return text
    .split("\n")
    .filter((l) => l)
    .map((l) => JSON.parse(l));
}

const input_closed = (state: Shared, run: Run) => existsSync(join(runs.run_dir(state, run.id), "input.closed"));

const reload = (state: Shared, id: string) => db.get_task(state.db(), id)!;

const user_messages = (state: Shared, id: string) =>
  db
    .list_messages(state.db(), id)
    .filter((m) => m.kind === "user")
    .map((m) => m.data);

const replay = (id: string, text: string) => ({ type: "user", isReplay: true, uuid: id, message: { role: "user", content: text } });

const result = (subtype: string, total_cost: number): any => ({
  type: "result",
  subtype,
  is_error: subtype !== "success",
  total_cost_usd: total_cost,
  num_turns: 1,
});

/** Whether `f` fails (Rust's `is_err()` on an ApiResult). */
const fails = (f: () => unknown) => {
  try {
    f();
    return false;
  } catch {
    return true;
  }
};
const fails_async = async (f: () => Promise<unknown>) => {
  try {
    await f();
    return false;
  } catch {
    return true;
  }
};
/** The error `f` throws. */
const error_of = (f: () => unknown): any => {
  try {
    f();
  } catch (e) {
    return e;
  }
  assert.fail("expected an error");
};

test("a_merge_that_needs_changes_lets_the_queue_go_and_rejoins_it", async () => {
  let [state, a, run] = running(false);
  a = state.update_task(a.id, [["status", "ready_for_merge"], ["merging", true]])!;
  let b = new_task(state.db(), { profile_id: a.profile_id, title: "b", status: "ready_for_merge" });
  b = state.update_task(b.id, [["merging", true], ["position", a.position + 1.0]])!;
  const slot = (s: Shared) => db.active_merge(s.db(), null, null)?.id ?? null;
  const queue = (s: Shared) => db.queued_merges(s.db(), null, null).map((t) => t.id);
  assert.deepEqual([slot(state), queue(state)], [a.id, [b.id]]);
  const update = (s: Shared, id: string, body: any) => api.update_task_inner(s, id, body);

  // Only a merging task steps out, into In progress.
  assert.ok(await fails_async(() => update(state, a.id, { status: "in_review", remerge: true })));
  assert.ok(await fails_async(() => update(state, a.id, { status: "in_progress", remerge: "yes" })));
  let t = await update(state, a.id, { status: "in_progress", remerge: true });
  assert.deepEqual([t.status, t.merging, t.remerge, t.running], ["in_progress", false, true, true]);
  assert.ok(await fails_async(() => update(state, b.id, { status: "in_progress", remerge: true })));
  // B can merge while A makes its changes.
  assert.deepEqual([slot(state), queue(state)], [null, [b.id]]);
  // Waiting on the user keeps its place to come back to.
  t = await update(state, a.id, { status: "needs_attention" });
  assert.ok(t.remerge);
  assert.equal(slot(state), null);
  await update(state, a.id, { status: "in_progress" });

  // Done, it rejoins the end of the queue, rather than going to In review.
  finish(state, run.id, "Ok");
  t = reload(state, a.id);
  assert.deepEqual([t.status, t.merging, t.remerge, t.running], ["ready_for_merge", true, false, false]);
  assert.ok(t.position > b.position);
  assert.deepEqual([slot(state), queue(state)], [null, [b.id, a.id]]);

  // Moved to another column meanwhile, it's out of the queue for good.
  {
    const [state, c, run] = running(false);
    state.update_task(c.id, [["status", "ready_for_merge"], ["merging", true]]);
    await update(state, c.id, { status: "in_progress", remerge: true });
    const t = await update(state, c.id, { status: "todo" });
    assert.deepEqual([t.merging, t.remerge], [false, false]);
    await update(state, c.id, { status: "in_progress" });
    finish(state, run.id, "Ok");
    assert.equal(reload(state, c.id).status, "in_review");
  }

  // A run that fails leaves it for the user, still to rejoin once its agent is done.
  {
    const [state, d, run] = running(false);
    state.update_task(d.id, [["status", "ready_for_merge"], ["merging", true]]);
    await update(state, d.id, { status: "in_progress", remerge: true });
    finish(state, run.id, { Failed: "boom" });
    let t = reload(state, d.id);
    assert.deepEqual([t.status, t.merging, t.remerge], ["needs_attention", false, true]);
    // Moved on by the board rather than the user (a review starting puts it in In review), it drops its place all the
    // same: work after that goes to review, not to the queue.
    state.update_task(d.id, [["status", "in_review"], ["attention_reason", null]]);
    assert.ok(!reload(state, d.id).remerge);
    await update(state, d.id, { status: "in_progress" });
    const next = db.insert_run(state.db(), d.id, "prompt");
    state.runs.set(d.id, { run_id: next.id, cancel: null });
    state.update_task(d.id, [["running", true]]);
    finish(state, next.id, "Ok");
    t = reload(state, d.id);
    assert.deepEqual([t.status, t.merging, t.remerge], ["in_review", false, false]);
  }
});

test("steers_a_message_into_the_running_turn", () => {
  const [state, task, run] = running(true);
  let t = send(state, task.id, "  also do this  ");
  assert.equal(t.queued_message, null);
  assert.equal(t.steering.length, 1);
  const steer = t.steering[0];
  assert.ok(steer.written);
  assert.deepEqual(input(state, run), [{ type: "user", uuid: steer.id, message: { role: "user", content: "also do this" } }]);
  // Nothing in the thread until the agent takes it in.
  assert.deepEqual(user_messages(state, task.id), []);

  output(state, run, [replay("the prompt's id", "the prompt"), replay(steer.id, "also do this")]);
  assert.deepEqual(user_messages(state, task.id), [{ text: "also do this", steered: true }]);
  assert.ok(reload(state, task.id).steering.length === 0);
  assert.ok(!input_closed(state, run));

  // Nothing left waiting, so the turn's end ends the run.
  output(state, run, [result("success", 0.5)]);
  assert.ok(input_closed(state, run));
  // A message sent now can't reach this run any more: it waits for the next.
  t = send(state, task.id, "too late");
  assert.equal(t.queued_message, "too late");
  assert.equal(t.steering.length, 0);
});

test("plan_labels_the_task_and_tells_its_agent_how", () => {
  {
    // A run that started without labels, working in a worktree, may not be let write the task's folder (Codex's
    // writable roots don't have it): `/plan` waits for the next run, which starts with the label.
    const [state, task, run] = running(true);
    const t = send(state, task.id, "/plan  the cache ");
    assert.deepEqual(t.labels, ["plan"]);
    assert.ok(existsSync(documents.dir(state, task.id)));
    assert.deepEqual([t.queued_message, t.steering.length], ["/plan  the cache", 0]);
    assert.deepEqual(input(state, run), []);
    // An ordinary message still goes to it.
    assert.equal(send(state, task.id, "and this").steering.length, 1);
  }
  {
    // One that can write it (it started with a label, say) takes it in its turn.
    const [state, task, run] = running(true);
    set_writes_documents(run.id, true);
    let t = send(state, task.id, "/plan  the cache ");
    assert.deepEqual(t.labels, ["plan"]);
    const file = documents.path(state, t, "plan")!;
    assert.ok(existsSync(join(file, "..")));
    // Its system prompt may not say how to write the plan, so the message does.
    const sent: string = input(state, run)[0].message.content;
    assert.ok(sent.includes(path_str(file)) && sent.includes('<ol class="steps">') && sent.endsWith("What to plan: the cache"), sent);
    // The thread shows the command, as it was sent.
    const steer = t.steering[0];
    output(state, run, [replay(steer.id, sent)]);
    assert.deepEqual(user_messages(state, task.id), [{ text: "/plan  the cache", steered: true }]);
    // Its labels stay as they are, and a command that only starts the same way isn't it.
    t = state.update_task(task.id, [["labels", ["plan", "diagram"]]])!;
    assert.deepEqual(send(state, t.id, "/plan").labels, ["plan", "diagram"]);
    // Its end forgets it.
    finish(state, run.id, "Ok");
    assert.ok(!writes_documents(run.id));
  }
  {
    const [state, task, run] = running(true);
    send(state, task.id, "/planner go");
    assert.equal(input(state, run)[0].message.content, "/planner go");
    assert.deepEqual(reload(state, task.id).labels, []);
  }
});

test("the_end_of_a_turn_or_run_ends_a_wait", () => {
  const [state, task, run] = running(true);
  const wait = (call_id: string) => {
    const w = { since: new Date().toISOString(), until: new Date().toISOString(), tasks: [], call_id, run_id: run.id };
    state.update_task(task.id, [["agent_wait", w]]);
  };
  // Its own thread calling another tool means it's working again; a subagent's doesn't.
  const tool_use = (parent: any) => ({
    type: "assistant",
    parent_tool_use_id: parent,
    message: { content: [{ type: "tool_use", id: "t", name: "Bash", input: {} }] },
  });
  wait("c0");
  output(state, run, [tool_use("toolu_sub")]);
  assert.ok(reload(state, task.id).agent_wait != null);
  output(state, run, [tool_use(null)]);
  assert.equal(reload(state, task.id).agent_wait, null);
  // The agent gave up on the call (it was interrupted, say): the turn's end clears it.
  wait("c1");
  output(state, run, [result("success", 0.1)]);
  assert.equal(reload(state, task.id).agent_wait, null);
  wait("c2");
  finish(state, run.id, "Ok");
  const t = reload(state, task.id);
  assert.deepEqual([t.agent_wait, t.running], [null, false]);
});

test("a_message_that_misses_the_turn_starts_the_next", () => {
  const [state, task, run] = running(true);
  const steer = send(state, task.id, "one more thing").steering[0];
  // The turn ends before the agent took it in: it starts the next turn instead.
  output(state, run, [result("success", 0.1)]);
  assert.ok(!input_closed(state, run));
  output(state, run, [replay(steer.id, "one more thing"), result("success", 0.25)]);
  assert.ok(input_closed(state, run));
  assert.equal(user_messages(state, task.id).length, 1);
  // Each turn's result shows that turn's cost; the task adds them up.
  const costs = db
    .list_messages(state.db(), task.id)
    .filter((m) => m.data.type === "result")
    .map((m) => m.data.total_cost_usd);
  assert.equal(costs.length, 2);
  assert.ok(Math.abs(costs[1] - 0.15) < 1e-9, String(costs));
  assert.ok(Math.abs(reload(state, task.id).cost_usd - 0.25) < 1e-9);
});

// HA-108: Claude Code's total for a session it resumes goes on from what the session's earlier runs cost, which were
// charged to the task again.
test("a_run_that_resumes_a_session_is_charged_only_what_it_adds", () => {
  const [state, task, first] = running(true);
  const init = (session: string) => ({ type: "system", subtype: "init", session_id: session });
  const total = (session: string, t: number) => {
    const r = result("success", t);
    r.session_id = session;
    r.modelUsage = { "claude-x": { costUSD: t } };
    return r;
  };
  const next = (kind: string) => {
    const run = db.insert_run(state.db(), task.id, kind);
    db.run(state.db(), "UPDATE runs SET status='running' WHERE id=?1", run.id);
    const dir = runs.run_dir(state, run.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "out.jsonl"), "");
    return run;
  };
  const ended = (run: Run) => db.run(state.db(), "UPDATE runs SET status='exited' WHERE id=?1", run.id);
  const close = (a: number, b: number) => Math.abs(a - b) < 1e-9;
  const charged = (run: Run): [number, number] => [reload(state, task.id).cost_usd, db.get_run(state.db(), run.id)!.cost_usd];
  const last_result = () =>
    db
      .list_messages(state.db(), task.id)
      .reverse()
      .find((m) => m.data.type === "result")!.data;

  // Two turns of a session.
  output(state, first, [init("s1"), total("s1", 1.0), total("s1", 1.5)]);
  ended(first);
  let [t, r] = charged(first);
  assert.ok(close(t, 1.5) && close(r, 1.5), `${t} ${r}`);
  // A run that resumes it: its first total goes on from 1.5.
  let resumed = next("compact");
  output(state, resumed, [init("s1"), total("s1", 1.75)]);
  ended(resumed);
  [t, r] = charged(resumed);
  assert.ok(close(t, 1.75) && close(r, 0.25), `${t} ${r}`);
  assert.ok(close(last_result().total_cost_usd, 0.25));
  resumed = next("prompt");
  output(state, resumed, [init("s1"), total("s1", 2.0), total("s1", 2.5)]);
  ended(resumed);
  [t, r] = charged(resumed);
  assert.ok(close(t, 2.5) && close(r, 0.75), `${t} ${r}`);
  // A turn that failed before the model counted anything says a total of 0 (Claude Code's own result for it): it
  // charges nothing, and the next run goes on from the last total.
  const failed = next("prompt");
  const error = { type: "result", subtype: "error_during_execution", is_error: true, session_id: "s1", total_cost_usd: 0, modelUsage: {} };
  output(state, failed, [init("s1"), error]);
  ended(failed);
  assert.deepEqual(charged(failed), [2.5, 0.0]);
  resumed = next("prompt");
  output(state, resumed, [init("s1"), total("s1", 2.75)]);
  ended(resumed);
  [t, r] = charged(resumed);
  assert.ok(close(t, 2.75) && close(r, 0.25), `${t} ${r}`);

  // A new session (a review round's, a rewind's) starts from nothing, even after a run that started it and ended
  // before its first result.
  const killed = next("prompt");
  output(state, killed, [init("s2")]);
  ended(killed);
  const fresh = next("prompt");
  output(state, fresh, [init("s2"), total("s2", 3.0)]);
  ended(fresh);
  [t, r] = charged(fresh);
  assert.ok(close(t, 5.75) && close(r, 3.0), `${t} ${r}`);
  // So does a session whose total went down: Claude Code started counting again.
  const again = next("prompt");
  output(state, again, [init("s2"), total("s2", 0.5)]);
  [t, r] = charged(again);
  assert.ok(close(t, 6.25) && close(r, 0.5), `${t} ${r}`);
  // A result without a total charges nothing, and the next goes on from the last.
  output(state, again, [{ type: "result", subtype: "success", session_id: "s2" }, total("s2", 0.75)]);
  [t, r] = charged(again);
  assert.ok(close(t, 6.5) && close(r, 0.75), `${t} ${r}`);
});

test("messages_the_agent_never_took_in_go_to_the_next_run", () => {
  const [state, task, run] = running(true);
  send(state, task.id, "first");
  send_from_agent(state, task.id, "second");
  // Closed meanwhile (e.g. the agent exited), so this one is queued behind them.
  runs.close_input(state, run.id);
  send(state, task.id, "third");
  requeue_steers(state, task.id, run.id);
  const t = reload(state, task.id);
  assert.deepEqual(t.steering, []);
  assert.equal(t.queued_message, "first\n\nsecond\n\nthird");
  // Not all of it came from other agents, so it counts as the user's.
  assert.deepEqual(db.take_queued(state.db(), task.id), { text: "first\n\nsecond\n\nthird", from_agent: false, user_text: "first\n\nthird", routine: false, routine_runs: [] });
});

test("the_users_messages_retitle_the_task", async () => {
  const [state, task, run] = running(true);
  title.TEST.reply = "Deploy the fix";
  send_from_agent(state, task.id, "from another agent");
  await settle();
  assert.equal(reload(state, task.id).title, "t");
  assert.equal(title.TEST.asked.length, 0);

  send(state, task.id, "now deploy it");
  await settle();
  assert.equal(reload(state, task.id).title, "Deploy the fix");
  const asked = title.TEST.asked;
  // Still waiting for the agent to take it in, it counts all the same; other agents' messages don't.
  assert.ok(asked.length === 1 && asked[0].includes("now deploy it") && !asked[0].includes("another agent"), String(asked));

  // Queued for the next run, it counts too.
  runs.close_input(state, run.id);
  title.TEST.reply = "Deploy and tag the fix";
  assert.equal(send(state, task.id, "and tag it").queued_message, "and tag it");
  await settle();
  assert.equal(reload(state, task.id).title, "Deploy and tag the fix");
  const asked2: string[] = title.TEST.asked;
  assert.ok(asked2.length === 2 && asked2[1].includes("and tag it"));
});

test("a_reply_the_agent_hasnt_taken_in_yet_goes_with_what_it_answers", async () => {
  const [state, task, run] = running(true);
  const said = (text: string) => ({ type: "assistant", message: { content: [{ type: "text", text }] } });
  output(state, run, [said("A: add a search cache; B: replace the database index")]);
  title.TEST.reply = "Replace the database index";
  const t = send(state, task.id, "Use option B");
  assert.equal(t.steering.length, 1);
  await settle();
  const asked = title.TEST.asked;
  assert.ok(asked[0]?.includes("<agent>A: add a search cache; B: replace the database index</agent>\nUse option B"), String(asked));
  assert.equal(reload(state, task.id).title, "Replace the database index");
});

test("keeps_marking_messages_from_other_agents", () => {
  const [state, task, run] = running(true);
  const steer = send_from_agent(state, task.id, "from another agent").steering[0];
  assert.ok(steer.from_agent);
  output(state, run, [replay(steer.id, "from another agent")]);
  assert.deepEqual(user_messages(state, task.id), [{ text: "from another agent", steered: true, from_agent: true }]);
});

test("stop_interrupts_the_turn", () => {
  const [state, task, run] = running(true);
  assert.ok(stop(state, task.id));
  const sent = input(state, run);
  assert.deepEqual([sent.length, sent[0].type, sent[0].request.subtype], [1, "control_request", "interrupt"]);
  assert.ok(!input_closed(state, run));
  output(state, run, [result("error_during_execution", 0.0)]);
  assert.ok(input_closed(state, run));
  const r = db.get_run(state.db(), run.id)!;
  assert.ok(r.stop_requested);
  const last = db.list_messages(state.db(), task.id).pop()!;
  assert.equal(last.data.interrupted, true);
});

test("a_message_waiting_when_stopped_starts_the_next_turn", () => {
  const [state, task, run] = running(true);
  const steer = send(state, task.id, "do this instead").steering[0];
  db.run(state.db(), "UPDATE runs SET attention='a question' WHERE id=?1", run.id);
  stop(state, task.id);
  // The agent ends the interrupted turn, then starts the next with the message.
  output(state, run, [result("error_during_execution", 0.0)]);
  assert.ok(!input_closed(state, run));
  output(state, run, [replay(steer.id, "do this instead")]);
  const r = db.get_run(state.db(), run.id)!;
  // That turn goes ahead, so the run isn't stopped any more (and the user answered).
  assert.ok(!r.stop_requested);
  assert.equal(r.attention, null);
  output(state, run, [result("success", 0.0)]);
  assert.ok(input_closed(state, run));
  assert.equal(db.get_run(state.db(), run.id)!.result_error, null);
});

test("a_message_taken_in_before_a_stop_doesnt_undo_it", () => {
  const [state, task, run] = running(true);
  const steer = send(state, task.id, "and this").steering[0];
  stop(state, task.id);
  // Taken in before the interrupt landed: the stop still ends the turn and the run.
  output(state, run, [replay(steer.id, "and this"), result("error_during_execution", 0.0)]);
  assert.ok(db.get_run(state.db(), run.id)!.stop_requested);
  assert.ok(input_closed(state, run));
});

test("an_earlier_stop_doesnt_cut_a_later_one_short", async () => {
  const [state, task, run] = running(true);
  const steer = send(state, task.id, "do this instead").steering[0];
  stop(state, task.id);
  // The stop ends the turn, and the waiting message starts the next.
  output(state, run, [result("error_during_execution", 0.0), replay(steer.id, "do this instead")]);
  await sleep(STOP_GRACE / 2);
  // Stopped again: the first stop's time is up before this one's.
  stop(state, task.id);
  await sleep((STOP_GRACE * 3) / 4);
  assert.ok(!input_closed(state, run));
  // This one's isn't, and its turn hasn't ended.
  await sleep(STOP_GRACE / 2);
  assert.ok(input_closed(state, run));
});

/** The server restarts while the run is in `state`. */
function restart(state: Shared, task: Task) {
  state.runs.delete(task.id);
  load_active(state);
}

test("after_a_restart_messages_still_have_to_start_the_next_turn", async () => {
  const [state, task, run] = running(true);
  send(state, task.id, "one more thing");
  // The turn ended (before the restart) and the agent never took it in.
  db.run(state.db(), "UPDATE runs SET saw_result=1, between_turns=1 WHERE id=?1", run.id);
  restart(state, task);
  assert.ok(reload(state, task.id).steerable);
  await sleep(STEER_GRACE / 2);
  assert.ok(!input_closed(state, run));
  await sleep(STEER_GRACE);
  assert.ok(input_closed(state, run));
});

test("after_a_restart_a_turn_that_ended_with_nothing_waiting_ends_the_run", () => {
  const [state, task, run] = running(true);
  // The server stopped after the turn's end was recorded, before its input was closed.
  db.run(state.db(), "UPDATE runs SET saw_result=1, between_turns=1 WHERE id=?1", run.id);
  restart(state, task);
  assert.ok(input_closed(state, run));
});

test("after_a_restart_messages_the_agent_wasnt_sent_are_sent", async () => {
  const [state, task, run] = running(true);
  // Sent as the turn ended, and kept, before the server stopped, to be written to its input.
  const steer = { id: "s1", text: "one more thing", from_agent: false, run_id: run.id, written: false };
  state.update_task(task.id, [["steering", [steer]]]);
  db.run(state.db(), "UPDATE runs SET saw_result=1, between_turns=1 WHERE id=?1", run.id);
  restart(state, task);
  assert.equal(input(state, run).at(-1).message.content, "one more thing");
  assert.ok(reload(state, task.id).steering[0].written);
  // It starts the next turn, or the run ends and it goes to the next.
  assert.ok(!input_closed(state, run));
  await sleep((STEER_GRACE * 3) / 2);
  assert.ok(input_closed(state, run));
});

/** Claude Code's list of the background tasks the agent has going (`n` of them). */
const background = (n: number) => ({
  type: "system",
  subtype: "background_tasks_changed",
  tasks: Array.from({ length: n }, (_, i) => ({ task_id: `b${i}`, task_type: "local_bash", description: "a server" })),
});

// HA-187: an agent that left a background shell going (a server for the user) doesn't exit when its input is closed,
// and a message sent to it was queued until the shell ended, up to two hours later.
test("a_message_sent_while_background_tasks_go_starts_a_turn", () => {
  const [state, task, run] = running(true);
  output(state, run, [background(1), result("success", 0.1)]);
  assert.ok(!input_closed(state, run));
  const t = send(state, task.id, "please read my comments");
  assert.equal(t.queued_message, null);
  const steer = t.steering[0];
  assert.ok(steer.written);
  assert.equal(input(state, run).at(-1).message.content, "please read my comments");
  output(state, run, [replay(steer.id, "please read my comments"), result("success", 0.2)]);
  assert.deepEqual(user_messages(state, task.id), [{ text: "please read my comments", steered: true }]);
  // Still going: the next message can start a turn too.
  assert.ok(!input_closed(state, run));
  // Once they've ended, it takes a turn on them and exits.
  output(state, run, [background(0)]);
  assert.ok(input_closed(state, run));
  assert.equal(runs.background_tasks(state, run.id), 0);
});

test("background_tasks_that_end_in_a_turn_leave_its_end_to_close_the_input", () => {
  const [state, task, run] = running(true);
  output(state, run, [background(2), result("success", 0.1)]);
  const steer = send(state, task.id, "stop the server").steering[0];
  output(state, run, [replay(steer.id, "stop the server"), background(1)]);
  assert.ok(!input_closed(state, run));
  output(state, run, [background(0)]);
  // Mid-turn: the turn's end closes it.
  assert.ok(!input_closed(state, run));
  output(state, run, [result("success", 0.2)]);
  assert.ok(input_closed(state, run));
});

test("a_stop_ends_a_run_kept_going_by_background_tasks", async () => {
  // During a turn: the stop interrupts it, and its end ends the run.
  {
    const [state, task, run] = running(true);
    const agent = agent_process("sleep", ["60"]);
    writeFileSync(join(runs.run_dir(state, run.id), "pid"), `${agent.pid}`);
    try {
      output(state, run, [background(1)]);
      stop(state, task.id);
      assert.equal(input(state, run).at(-1).request.subtype, "interrupt");
      output(state, run, [result("error_during_execution", 0.0)]);
      assert.ok(input_closed(state, run));
      await until(() => exited(agent));
    } finally {
      kill_group(agent);
    }
  }
  // Between turns, there's no turn to interrupt.
  {
    const [state, task, run] = running(true);
    const agent = agent_process("sleep", ["60"]);
    writeFileSync(join(runs.run_dir(state, run.id), "pid"), `${agent.pid}`);
    try {
      output(state, run, [background(1), result("success", 0.1)]);
      stop(state, task.id);
      assert.ok(!input(state, run).some((l) => l.request?.subtype === "interrupt"));
      assert.ok(input_closed(state, run));
      await until(() => exited(agent));
    } finally {
      kill_group(agent);
    }
  }
});

test("after_a_restart_a_run_kept_going_by_background_tasks_still_takes_messages", () => {
  const [state, task, run] = running(true);
  output(state, run, [background(1), result("success", 0.1)]);
  restart(state, task);
  assert.ok(!input_closed(state, run));
  assert.ok(send(state, task.id, "one more thing").steering[0].written);
});

test("a_turns_end_closes_the_input_even_if_it_cant_be_recorded", () => {
  // The disk is full, say, as the turn's result goes in the thread, or as its cost is added up.
  for (const failing of ["BEFORE INSERT ON messages", "BEFORE UPDATE OF cost_usd ON tasks"]) {
    const [state, , run] = running(true);
    state.db().exec(`CREATE TRIGGER full ${failing} BEGIN SELECT RAISE(FAIL, 'database or disk is full'); END;`);
    output(state, run, [result("success", 0.1)]);
    assert.ok(input_closed(state, run), failing);
  }
});

test("a_run_from_a_newer_build_is_stopped_rather_than_left_unfollowed", async () => {
  const [state, task, run] = running(true);
  const dir = runs.run_dir(state, run.id);
  writeFileSync(join(dir, "run.json"), '{"format": 99}');
  writeFileSync(join(dir, "spec.json"), "{}");
  // Its agent, in a process group of its own as ia-shim starts it.
  const agent = agent_process("sleep", ["60"]);
  writeFileSync(join(dir, "pid"), String(agent.pid));
  try {
    restart(state, task);
    assert.equal(db.get_run(state.db(), run.id)!.status, "exited");
    assert.ok(input_closed(state, run));
    const deadline = Date.now() + 5000;
    while (!exited(agent)) {
      assert.ok(Date.now() < deadline, "the agent is still running");
      await sleep(20);
    }
  } finally {
    kill_group(agent);
  }
});

test("after_a_restart_a_message_can_wait_for_the_agents_next_step", async () => {
  const [state, task, run] = running(true);
  // Mid-turn, in a later turn than the one that ended.
  db.run(state.db(), "UPDATE runs SET saw_result=1 WHERE id=?1", run.id);
  send(state, task.id, "when you get to it");
  restart(state, task);
  await sleep(STEER_GRACE * 2);
  assert.ok(!input_closed(state, run));
});

test("follows_how_full_the_context_is", async () => {
  const [state, task, run] = running(true);
  const ctx = () => reload(state, task.id).context!;
  const reply = (parent: any, written: number) => {
    const usage = { input_tokens: 2, cache_creation_input_tokens: written, cache_read_input_tokens: 1000, output_tokens: 50 };
    return { type: "assistant", parent_tool_use_id: parent, message: { model: "claude-x", content: [{ type: "text", text: "hi" }], usage } };
  };
  output(state, run, [reply(null, 500)]);
  assert.deepEqual([ctx().tokens, ctx().max_tokens ?? null], [1502, null]);
  // A subagent's context is its own.
  output(state, run, [reply("toolu_sub", 90_000)]);
  assert.equal(ctx().tokens, 1502);

  // The turn's end gives the model's window, and asks for the breakdown before the input is closed.
  const end = result("success", 0.1);
  end.modelUsage = { "claude-haiku": { contextWindow: 1000 }, "claude-x": { contextWindow: 200_000 } };
  output(state, run, [end]);
  assert.equal(ctx().max_tokens, 200_000);
  assert.ok(input_closed(state, run));
  const sent = input(state, run);
  const ask = sent.at(-1);
  assert.deepEqual([ask.type, ask.request.subtype], ["control_request", "get_context_usage"]);
  // Not the full recount, which calls the token-counting API.
  assert.equal(ask.request.detail, "summary");
  assert.equal(ctx().detail_at ?? null, null);

  // Other control responses aren't breakdowns.
  output(state, run, [{ type: "control_response", response: { subtype: "success", request_id: "stop-1", response: { totalTokens: 5 } } }]);
  assert.equal(ctx().tokens, 1502);
  const breakdown = {
    categories: [{ id: "messages", name: "Messages", tokens: 600, kind: "used" }],
    totalTokens: 1600,
    maxTokens: 1_000_000,
    autoCompactThreshold: 967_000,
    isAutoCompactEnabled: true,
    model: "claude-x",
    gridRows: [[{ color: "x" }]],
  };
  output(state, run, [{ type: "control_response", response: { subtype: "success", request_id: ask.request_id, response: breakdown } }]);
  const c = ctx();
  assert.deepEqual([c.tokens, c.max_tokens, c.compact_at, c.model], [1600, 1_000_000, 967_000, "claude-x"]);
  assert.ok(c.detail_at != null);
  const got = await context.get(state, req({ id: task.id }));
  assert.equal(got.detail.categories[0].tokens, 600);
  assert.equal(got.detail.gridRows, undefined);

  // Compacting starts again from the summary.
  output(state, run, [{ type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "auto", pre_tokens: 1600, post_tokens: 300 } }]);
  assert.deepEqual([ctx().tokens, ctx().max_tokens], [300, 1_000_000]);
});

test("records_context_sizes_and_compactions", () => {
  const [state, task, run] = running(true);
  const stats = () =>
    db
      .all(state.db(), "SELECT run_id, kind, tokens, post_tokens, source, cost_usd FROM context_stats ORDER BY id")
      .map((r: any) => [r.run_id, r.kind, r.tokens, r.post_tokens, r.source, r.cost_usd]);
  const starts = () => db.all(state.db(), "SELECT start_tokens FROM context_stats WHERE kind='turn' ORDER BY id").map((r: any) => r.start_tokens);
  const reply = (written: number) => {
    const usage = { input_tokens: 2, cache_creation_input_tokens: written, cache_read_input_tokens: 1000 };
    return { type: "assistant", parent_tool_use_id: null, message: { model: "claude-x", content: [{ type: "text", text: "hi" }], usage } };
  };
  // Each turn's end records the context it started from (its first request) and leaves, and what it cost.
  output(state, run, [reply(100), reply(500), result("success", 0.25)]);
  const turn = [run.id, "turn", 1502, null, null, 0.25];
  assert.deepEqual(stats(), [turn]);
  assert.deepEqual(starts(), [1102]);
  // The breakdown asked for at the turn's end changes the task's context, but a turn the model then didn't answer
  // isn't one to count.
  const ask = input(state, run).at(-1);
  const breakdown = { totalTokens: 1600, maxTokens: 200_000, model: "claude-x" };
  output(state, run, [{ type: "control_response", response: { subtype: "success", request_id: ask.request_id, response: breakdown } }]);
  output(state, run, [result("error_during_execution", 0.25)]);
  assert.equal(stats().length, 1);
  // A session started afresh on the thread (as reviews and summaries do) starts small, whatever the last turn left.
  output(state, run, [reply(10), result("success", 0.3)]);
  assert.deepEqual([stats().length, stats()[1][2]], [2, 1012]);
  assert.deepEqual(starts(), [1102, 1012]);
  const turn2 = stats()[1];

  // The agent compacting by itself mid-turn.
  output(state, run, [{ type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "auto", pre_tokens: 1600, post_tokens: 300 } }]);
  assert.deepEqual(stats()[2], [run.id, "compact", 1600, 300, "auto", null]);
  // A compaction alone isn't a turn either.
  output(state, run, [result("success", 0.0)]);
  assert.equal(stats().length, 3);
  db.run(state.db(), "UPDATE runs SET status='done' WHERE id=?1", run.id);

  // The board's `/compact` after the session sat idle, and the user's.
  const manual = { trigger: "manual", pre_tokens: 300, post_tokens: 100 };
  const idle = db.insert_run(state.db(), task.id, "compact");
  context.on_compacted(state, idle, manual);
  const user = db.insert_run(state.db(), task.id, "compact");
  db.insert_message(state.db(), task.id, "user", { text: "/compact" });
  context.on_compacted(state, user, manual);
  // Without `pre_tokens` (Codex), it's the latest count.
  context.on_compacted(state, user, { trigger: "manual" });
  const sources = stats()
    .slice(3)
    .map((s) => [s[0], s[2], s[4]]);
  assert.deepEqual(sources, [
    [idle.id, 300, "idle"],
    [user.id, 300, "user"],
    [user.id, 100, "user"],
  ]);
  // A `/compact`'s turn isn't one of the agent's.
  context.record_turn(state, user, 0.01);
  assert.equal(stats().length, 6);

  // The report has the profile's, in range.
  const all = analytics.context_report(state.db(), task.profile_id, "2000-01-01T00:00:00.000Z", "2100-01-01T00:00:00.000Z");
  assert.deepEqual([all.stats.length, all.tasks.length], [6, 1]);
  const first = all.stats[0];
  assert.deepEqual([first.kind, first.start_tokens, first.tokens, first.cost_usd], ["turn", 1102, 1502, 0.25]);
  assert.equal(all.stats[1].tokens, turn2[2]);
  const none = analytics.context_report(state.db(), "someone-else", "2000-01-01T00:00:00.000Z", "2100-01-01T00:00:00.000Z");
  assert.equal(none.stats.length, 0);
  const later = analytics.context_report(state.db(), task.profile_id, "2100-01-01T00:00:00.000Z", "2100-01-02T00:00:00.000Z");
  assert.equal(later.stats.length, 0);
});

test("says_whether_the_running_agent_takes_messages", () => {
  const [state, t0] = running(false);
  const task = state.update_task(t0.id, [["steerable", true]])!;
  // Started by an older build, whose agents read only their prompt.
  restart(state, task);
  assert.ok(!reload(state, task.id).steerable);
});

test("messages_sent_while_preparing_go_once_the_agent_starts", () => {
  const [state, task, run] = running(true);
  db.run(state.db(), "UPDATE runs SET status='preparing' WHERE id=?1", run.id);
  const dir = runs.run_dir(state, run.id);
  rmSync(dir, { recursive: true, force: true });
  let t = send(state, task.id, "early");
  assert.ok(!t.steering[0].written);
  // `started`, once the shim is up.
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "input.jsonl"), "");
  t = write_steers(state, task.id)!;
  assert.ok(t.steering[0].written);
  assert.equal(input(state, run)[0].message.content, "early");
});

test("queues_for_runs_that_cant_take_messages", () => {
  {
    // Started by an older build, whose agents read only their prompt.
    const [state, task] = running(false);
    const t = send(state, task.id, "later");
    assert.deepEqual([t.queued_message, t.steering.length], ["later", 0]);
  }
  // `/compact` can't go into a turn.
  const [state, task, run] = running(true);
  const t = send(state, task.id, "/compact");
  assert.deepEqual([t.queued_message, t.steering.length], ["/compact", 0]);
  assert.deepEqual(input(state, run), []);
});

test("tells_agents_which_boards_they_reach", () => {
  const c = db.open(":memory:");
  const [personal, work, lab] = ["personal", "work", "lab"].map((n) => db.insert_profile(c, n, [], null));
  db.update_profile(c, work.id, [["agent_access", ["personal"]]]);
  let note = profiles_note(db.list_profiles(c), personal);
  assert.ok(note.includes("also reach these profiles' boards: work."), note);
  assert.ok(note.includes("their projects aren't listed: lab."), note);
  note = profiles_note(db.list_profiles(c), lab);
  assert.ok(!note.includes("also reach") && note.includes("personal, work"), note);
});

test("an_archived_projects_agents_dont_start", () => {
  runs.TEST_CAN_RUN.set(true);
  const state = testing.state();
  const p = db.insert_profile(state.db(), "p", [], null);
  new_project(state.db(), { profile_id: p.id, name: "Old", key: "OLD" });
  const task = new_task(state.db(), { profile_id: p.id, project_id: "pr", title: "Fix it", status: "in_review" });
  db.update_task(state.db(), task.id, [["session_id", "sess"]]);
  db.update_project(state.db(), "pr", [["archived_at", "2026-01-01T00:00:00.000Z"]]);
  // Neither a message (from the user or another agent) nor a compaction starts one.
  for (const err of [error_of(() => send(state, task.id, "Carry on")), error_of(() => compact(state, task.id, "idle"))]) {
    assert.ok(err.message.includes('"Old" is archived'), err.message);
  }
  assert.ok(!state.is_running(task.id));
  assert.ok(!db.get_task(state.db(), task.id)!.running);
  assert.equal(db.value(state.db(), "SELECT COUNT(*) FROM runs WHERE task_id=?1", task.id), 0, "no run was registered");
});

test("an_archived_projects_queued_messages_wait_for_it", () => {
  runs.TEST_CAN_RUN.set(true);
  const state = testing.state();
  const p = db.insert_profile(state.db(), "p", [], null);
  new_project(state.db(), { profile_id: p.id, name: "Old", key: "OLD" });
  const make = (title: string) => new_task(state.db(), { profile_id: p.id, project_id: "pr", title });
  const [first, waits, blocked] = [make("First"), make("Waits"), make("Blocked")];
  for (const t of [waits, blocked]) state.update_task(t.id, [["depends_on", [first.id]]]);
  // One already waiting for its dependency, with what it was asked queued.
  send(state, waits.id, "Do the thing");
  const get = (id: string) => db.get_task(state.db(), id)!;
  assert.ok(get(waits.id).waiting);
  db.update_project(state.db(), "pr", [["archived_at", "2026-01-01T00:00:00.000Z"]]);

  // A message behind dependencies is refused rather than queued where nothing sends it.
  const err = error_of(() => send(state, blocked.id, "Go"));
  assert.ok(err.message.includes("is archived"), err.message);
  let b = get(blocked.id);
  assert.deepEqual([b.status, b.waiting, b.queued_message], ["todo", false, null]);

  // Its dependency merged, the waiting one keeps waiting with its message.
  state.update_task(first.id, [["status", "done"]]);
  start_unblocked(state, "pr");
  const w = get(waits.id);
  assert.deepEqual([w.waiting, w.status, w.queued_message], [true, "in_progress", "Do the thing"]);
  // A message to it now is refused, and leaves the queued one.
  assert.ok(fails(() => send(state, waits.id, "And this")));
  assert.equal(get(waits.id).queued_message, "Do the thing");

  // Archived after start_unblocked picked it: it waits again, message and all.
  db.update_project(state.db(), "pr", [["archived_at", null]]);
  db.queue(state.db(), blocked.id, db.Queued_new("Go", false));
  state.update_task(blocked.id, [["waiting", true], ["status", "in_progress"]]);
  const picked = get(blocked.id);
  db.update_project(state.db(), "pr", [["archived_at", "2026-01-02T00:00:00.000Z"]]);
  start_waiting(state, picked);
  b = get(blocked.id);
  assert.deepEqual([b.waiting, b.status, b.attention_reason, b.queued_message], [true, "in_progress", null, "Go"]);
});

test("a_queued_message_stays_when_its_run_cant_start", () => {
  // This host can't run agents, which start_run finds after the queued message is taken.
  const state = testing.state();
  const p = db.insert_profile(state.db(), "p", [], null);
  const t = new_task(state.db(), { profile_id: p.id, kind: "scratch" });
  db.queue(state.db(), t.id, db.Queued_new("First", true));
  assert.ok(fails(() => send(state, t.id, "Second")));
  assert.deepEqual(db.take_queued(state.db(), t.id), db.Queued_new("First", true));
});

test("starts_with_the_projects_instructions", () => {
  const c = db.open(":memory:");
  const p = db.insert_profile(c, "p", [], null);
  const project = new_project(c, { profile_id: p.id });
  let task = new_task(c, { profile_id: p.id, project_id: "pr", title: "Fix it", description: "It's broken." });
  let text = start_prompt(task, project, "");
  assert.equal(text, `# X-1: Fix it\n\nIt's broken.\n\n---\n\n${prompts.DEFAULT_START}\n`);
  project.start_prompt = "Write a plan and ask me about it first.";
  text = start_prompt(task, project, "Only the server.");
  assert.ok(text.endsWith("---\n\nWrite a plan and ask me about it first.\n\nOnly the server.\n"), text);
  // A skill's command goes first, where Claude Code expands it, with the task as its arguments.
  text = start_prompt(task, project, " /code-review the server\n");
  assert.equal(text, "/code-review the server\n\n# X-1: Fix it\n\nIt's broken.\n\n---\n\nWrite a plan and ask me about it first.\n");
  text = start_prompt(task, project, "/plugin:skill");
  assert.ok(text.startsWith("/plugin:skill\n\n# X-1"), text);
  // A path isn't a command.
  text = start_prompt(task, project, "/home/me/x.log has the error");
  assert.ok(text.startsWith("# X-1") && text.endsWith("\n/home/me/x.log has the error\n"), text);
  // Followed by what it's for elsewhere.
  const links = [{ provider: "asana", id: "12", url: "https://app.asana.com/0/1/12", title: "Fix signup" }];
  task = db.update_task(c, task.id, [["external_links", links]])!;
  text = start_prompt(task, project, "");
  assert.ok(text.startsWith("# X-1: Fix it\n\nIt's broken.\n\nThis task is for:\n- Asana task: Fix signup (https://app.asana.com/0/1/12)\n\n---\n"), text);
});

/**
 * A system prompt is in paragraphs, with a blank line between them: none is empty, and no line starts or ends with a
 * space (as a sentence joined on to the one before would).
 */
function assert_paragraphs(text: string) {
  assert.ok(text.includes("\n\n") && !text.includes("\n\n\n"), text);
  assert.ok(
    text.split("\n").every((l) => l.trim() === l) && text.split("\n\n").every((p) => p.trim() !== ""),
    JSON.stringify(text),
  );
}

test("a_group_task_is_told_its_groups_projects", () => {
  const c = db.open(":memory:");
  const p = db.insert_profile(c, "p", [], null);
  new_project(c, { profile_id: p.id, name: "Web", key: "WEB", repo_path: "/src/web" });
  db.update_project(c, "pr", [["group_name", "Shop"]]);
  const task = db.insert_group_task(
    c,
    { profile_id: p.id, project_id: null, kind: "task", title: "Plan it", description: "", status: "todo", use_worktree: false, model: null, effort: null, claude_config_id: null },
    "Shop",
  );
  const group = db.group_projects(c, p.id, "Shop");
  const text = system_prompt(task, null, null, group, [], null, true);
  assert.ok(text.includes('task G-1 ("Plan it"') && text.includes("Web (key WEB, id pr, repository /src/web)"), text);
  assert_paragraphs(text);
  assert.ok(start_prompt(task, null, "").startsWith("# G-1: Plan it\n"));
});

test("the_assistant_is_told_what_it_is", () => {
  const s = testing.state();
  const p = db.insert_profile(s.db(), "p", [], null);
  const task = assistant.get_or_create(s, p.id);
  const text = system_prompt(task, null, null, [], [], null, true);
  assert.ok(text.includes(`thread A-1 (id ${task.id})`), text);
  assert.ok(text.includes("personal assistant") && text.includes("aren't a coding agent"), text);
  assert.ok(text.includes(`(assistants/${task.id} in the board's data dir)`), text);
  assert.ok(text.includes("`create_task`") && text.includes("list_projects") && text.includes("request_user_input"), text);
  assert.ok(!text.includes('In review".'), text);
  assert_paragraphs(text);
  // Its first prompt is the user's message, not a task to start on.
  assert.equal(start_prompt(task, null, " What's on today?\n"), "What's on today?");
  assert.ok(!start_prompt(task, null, "Hi").includes(prompts.DEFAULT_START));
});

test("a_routine_thread_is_told_what_it_is_and_works_in_the_assistants_workspace", () => {
  const s = testing.state();
  const p = db.insert_profile(s.db(), "p", [], null);
  const a = assistant.get_or_create(s, p.id);
  const task = db.insert_routine_task(s.db(), a, "Inbox");
  const text = system_prompt(task, null, null, [], [], null, true);
  assert.ok(text.includes(`thread A-2 (id ${task.id})`) && text.includes(`(id ${a.id})`), text);
  assert.ok(text.includes(`(assistants/${a.id} in the board's data dir)`), text);
  assert.ok(text.includes("NO_REPLY") && text.includes("posted to your"), text);
  assert_paragraphs(text);
  // The assistant is told about routines, and to make a reminder an `at` one.
  const told = system_prompt(a, null, null, [], [], null, true);
  assert.ok(told.includes("`at` routine") && told.includes("message_assistant"), told);
  assert_paragraphs(told);
  // Its first prompt is the routine's as it's given.
  assert.equal(start_prompt(task, null, "Check the inbox.\n"), "Check the inbox.");
  // Claude and Codex runs both work where the assistant does.
  assert.equal(work_dir(s, task), work_dir(s, a));
  assert.equal(key_prefix(task, null), "A");
});

test("previews_what_a_new_thread_in_a_project_is_told", async () => {
  const state = testing.state();
  const repo = testing.temp_dir();
  git_in(repo, ["init", "-q", "-b", "main"]);
  git_in(repo, ["remote", "add", "origin", "git@github.com:o/web.git"]);
  const p = db.insert_profile(state.db(), "me", [], null);
  const project = new_project(state.db(), {
    profile_id: p.id,
    name: "Web",
    key: "WEB",
    repo_path: path_str(repo),
    base_branch: "main",
    use_worktrees: true,
  });
  const show = async (q: any) => {
    const r = await preview(state, project, q);
    assert_paragraphs(r[0]);
    return r;
  };

  // A task as the project's new ones are, numbered as its next.
  let [text, is_codex, mode] = await show({});
  assert.ok(!is_codex && mode === "default");
  assert.ok(text.startsWith('You are an agent working on task WEB-1 ("Task title") on the Huntaway board.'), text);
  assert.ok(text.includes("worktree at /w/1-task-title on branch `ia/web-1-task-title` (branched from `main`)"), text);
  assert.ok(text.includes("on GitHub (o/web)") && text.includes("pr_create with repo `o/web`, head `ia/web-1-task-title` and base `main`"), text);
  const profiles = db.list_profiles(state.db());
  assert.ok(text.includes(gh_note(null)) && text.endsWith(profiles_note(profiles, profiles[0])), text);
  // Making it doesn't make a task, or take the number.
  const [again] = await show({});
  assert.equal(again, text);
  assert.deepEqual(db.list_tasks_for_project(state.db(), "pr", "task"), []);

  // The options a new thread is made with.
  [text] = await show({ labels: "plan,diagram" });
  assert.ok(text.includes("This task has the labels plan, diagram on the board") && text.includes("<task id>/plan.html"), text);
  [text] = await show({ worktree: false });
  assert.ok(!text.includes("worktree") && !text.includes("open a pull request"), text);
  [text] = await show({ type: "scratch" });
  assert.ok(text.includes("This scratch task is in the project Web") && !text.includes("worktree at"), text);
  [text] = await show({ type: "subproject", worktree: false });
  assert.ok(text.includes("This task is a subproject") && text.includes("worktree at /w/1-task-title"), text);
  [text, is_codex, mode] = await show({ runtime: "codex", permission_mode: "plan" });
  assert.ok(is_codex && mode === "plan" && text.includes("You are in plan mode") && text.includes("`gh.pr_view`") && !text.includes(gh_note(null)), text);
  [text] = await show({ permission_mode: "plan" });
  assert.ok(!text.includes("You are in plan mode"), `Claude Code tells Claude itself: ${text}`);
  // A thread inherits the host's mode, when the project has none.
  db.set_setting(state.db(), "default_permission_mode", "plan");
  [text, , mode] = await show({ runtime: "codex" });
  assert.ok(mode === "plan" && text.includes("You are in plan mode"), text);
  [text, , mode] = await show({ runtime: "codex", permission_mode: "default" });
  assert.ok(mode === "default" && !text.includes("You are in plan mode"), text);

  for (const bad of [{ type: "review" }, { labels: "nope" }, { runtime: "gpt" }, { permission_mode: "yolo" }]) {
    await assert.rejects(preview(state, project, bad), (e: any) => e instanceof ApiError && e.status === 400);
  }
});

test("agents_are_told_to_ask_rather_than_leave_a_question_in_their_summary", () => {
  // HA-198: a question left in a summary puts the task in "In review", where it looks finished.
  const c = db.open(":memory:");
  const p = db.insert_profile(c, "p", [], null);
  const project = new_project(c, { profile_id: p.id, name: "Web", key: "WEB", repo_path: "/src/web" });
  const task = new_task(c, { profile_id: p.id, project_id: "pr", title: "Fix it" });
  const scratch = { ...task, task_type: "scratch", project_id: null };
  const group = { ...task, project_id: null, group_name: "Shop" };
  for (const [t, pr] of [[task, project], [scratch, null], [group, null]] as const) {
    const text = system_prompt(t, pr, null, [], [], null, true);
    assert.ok(text.includes("You must call `request_user_input` before you end a turn whose last message needs something from the user"), text);
    assert.ok(text.includes("The one exception is an offer of something extra once everything the user asked for is done"), text);
    assert_paragraphs(text);
  }
});

test("a_task_on_github_is_told_to_open_a_pull_request", () => {
  const c = db.open(":memory:");
  const p = db.insert_profile(c, "p", [], null);
  const project = new_project(c, { profile_id: p.id, name: "Web", key: "WEB", repo_path: "/src/web", base_branch: "main", use_worktrees: true });
  const task = new_task(c, { profile_id: p.id, project_id: "pr", title: "Fix it", use_worktree: true });
  task.worktree_path = "/w/1-fix-it";
  task.branch = "ia/web-1-fix-it";
  // Pushed to a mirror: gh is told which repository, as it would pick the fetch remote's.
  const gh: Github = { remote: "origin", repo: "o/web-mirror" };
  let text = system_prompt(task, project, null, [], [], gh, false);
  assert.ok(text.includes("Do not merge or switch branches unless asked."), text);
  assert.ok(text.includes("on GitHub (o/web-mirror)") && text.includes("`git push -u origin ia/web-1-fix-it`"), text);
  assert.ok(text.includes("into `main` in o/web-mirror (`gh pr create --repo o/web-mirror --head ia/web-1-fix-it --base main`"), text);
  // With the gh server, which turns away gh in Bash, through its tools.
  text = system_prompt(task, project, null, [], [], gh, true);
  assert.ok(text.includes("in o/web-mirror (the gh tools' pr_create with repo `o/web-mirror`, head `ia/web-1-fix-it` and base `main`)"), text);
  assert.ok(!text.includes("gh pr create"), text);

  // Without GitHub (or a branch of its own), it leaves pushing to the user.
  text = system_prompt(task, project, null, [], [], null, false);
  assert.ok(text.includes("Do not push, merge, or switch branches unless asked.") && !text.includes("open a pull request"), text);
  task.branch = null;
  assert.ok(!system_prompt(task, project, null, [], [], gh, false).includes("open a pull request"));
  // Every agent is told it can wait on one, though.
  assert.ok(text.includes("For CI or reviews on a pull request, give it the `pull_request`"), text);
});

test("a_stacked_task_targets_the_branch_it_stacks_on_until_that_task_is_merged", () => {
  const s = testing.state();
  const p = db.insert_profile(s.db(), "p", [], null);
  const project = new_project(s.db(), { profile_id: p.id, name: "Web", key: "WEB", repo_path: "/src/web", base_branch: "main", use_worktrees: true });
  const make = (title: string) => new_task(s.db(), { profile_id: p.id, project_id: "pr", title, status: "in_review", use_worktree: true });
  let first = make("First");
  first = s.update_task(first.id, [["branch", "ia/web-1-first"], ["base_branch", "main"]])!;
  let second = make("Second");
  const sf = { type: "task", task_id: first.id };
  second = s.update_task(second.id, [["branch", "ia/web-2-second"], ["base_branch", "ia/web-1-first"], ["start_from", sf], ["worktree_path", "/w/2-second"]])!;
  const gh: Github = { remote: "origin", repo: "o/web" };
  let text = system_prompt(second, project, null, [], [], gh, true);
  assert.ok(text.includes("stacked on another task: `ia/web-1-first` is that task's branch"), text);
  assert.ok(text.includes("head `ia/web-2-second` and base `ia/web-1-first`"), text);

  // While First is open, Second merges into its branch.
  let base = db.task_base(s.db(), second, project);
  assert.equal(base, "ia/web-1-first");
  let said = stacked_merge(s, second, project, base);
  assert.ok(said.includes('stacked on WEB-1 ("First", in review), which isn\'t merged yet'), said);
  // Once it's merged, where First went, and its agent is told its pull request goes there.
  s.update_task(first.id, [["status", "done"]]);
  base = db.task_base(s.db(), second, project);
  assert.equal(base, "main");
  said = stacked_merge(s, second, project, base);
  assert.ok(said.includes("if its pull request still targets `ia/web-1-first`, change its base to `main` first"), said);
  const told = as_told(s, second, project);
  text = system_prompt(told, project, null, [], [], gh, true);
  assert.ok(text.includes("head `ia/web-2-second` and base `main`") && !text.includes("stacked on"), text);
  // A task that isn't stacked is told nothing more.
  base = db.task_base(s.db(), first, project);
  assert.equal(stacked_merge(s, first, project, base), "");
  assert.equal(base, "main");
});

test("projects_and_their_subprojects_can_turn_pull_requests_off", () => {
  const c = db.open(":memory:");
  const p = db.insert_profile(c, "p", [], null);
  const project = new_project(c, { profile_id: p.id, name: "Web", key: "WEB", repo_path: "/src/web", base_branch: "main", use_worktrees: true });
  const sp = new_task(c, { profile_id: p.id, project_id: "pr", title: "Big", use_worktree: true });
  Object.assign(sp, { subproject: true, worktree_path: "/w/1-big", branch: "ia/web-1-big", base_branch: "main" });
  const part = new_task(c, { profile_id: p.id, project_id: "pr", title: "Part", use_worktree: true });
  Object.assign(part, { parent_id: sp.id, worktree_path: "/w/2-part", branch: "ia/web-2-part", base_branch: "ia/web-1-big" });
  const gh: Github = { remote: "origin", repo: "o/web" };
  const opens = (text: string) => text.includes("so before you finish, open a pull request") && text.includes("Do not merge or switch branches unless asked.");
  const off = "This project's settings turn off pull requests";

  // On by default, for both.
  let text = system_prompt(sp, project, null, [], [], gh, true);
  assert.ok(opens(text) && text.includes("(through pull requests that target it, if the project uses them)") && !text.includes(off), text);
  text = system_prompt(part, project, sp, [], [], gh, true);
  assert.ok(opens(text) && text.includes("If you open a pull request, target `ia/web-1-big` (e.g. pr_create with base `ia/web-1-big`)"), text);
  assert.ok(text.includes("head `ia/web-2-part` and base `ia/web-1-big`") && !text.includes(off), text);

  // Off for the subproject's tasks: the subproject itself still opens one.
  project.subproject_pull_requests = false;
  text = system_prompt(sp, project, null, [], [], gh, true);
  assert.ok(opens(text) && text.includes("(without pull requests, which the project's settings turn off for subprojects' tasks)"), text);
  text = system_prompt(part, project, sp, [], [], gh, true);
  assert.ok(!opens(text) && !text.includes("pr_create with") && text.includes("Do not push, merge, or switch branches unless asked."), text);
  assert.ok(text.includes("When you merge, merge into `ia/web-1-big`, which is checked out in the subproject's worktree at /w/1-big."), text);
  assert.ok(text.includes(`${off} for its subprojects' tasks, so don't push this task's branch`), text);

  // Off for the project's tasks: its subprojects' tasks follow their own setting.
  project.pull_requests = false;
  project.subproject_pull_requests = true;
  text = system_prompt(sp, project, null, [], [], gh, true);
  assert.ok(!opens(text) && text.includes(`${off} for its tasks, so don't push`), text);
  assert.ok(text.includes("(through pull requests that target it, if the project uses them)"), text);
  text = system_prompt(part, project, sp, [], [], gh, true);
  assert.ok(opens(text) && !text.includes(off), text);
  // A task without a branch of its own isn't told about them.
  const plain = { ...part, parent_id: null, worktree_path: null, branch: null };
  assert.ok(!system_prompt(plain, project, null, [], [], gh, true).includes(off));
});

test("the_github_account_is_the_projects_or_the_profiles", () => {
  const c = db.open(":memory:");
  const profile = db.insert_profile(c, "p", [], null);
  const project = new_project(c, { profile_id: profile.id, name: "Web", key: "WEB", repo_path: "/src/web" });
  assert.equal(github_account(project, profile), null);
  profile.github_account = "me";
  assert.equal(github_account(project, profile), "me");
  assert.equal(github_account(null, profile), "me");
  project.github_account = "work-me";
  assert.equal(github_account(project, profile), "work-me");
  project.github_account = " ";
  assert.equal(github_account(project, profile), "me");
  assert.ok(gh_note("work-me").includes("as the GitHub account work-me") && !gh_note(null).includes("account"));
});

test("the_gh_hook_runs_this_binary", () => {
  const settings = JSON.parse(gh_hook_settings("/opt/it's here/huntaway"));
  const hook = settings.hooks.PreToolUse[0];
  assert.equal(hook.matcher, "Bash");
  assert.equal(hook.hooks[0].command, "'/opt/it'\\''s here/huntaway' gh-hook");
  // A project that turns the gh server off, or has its own, gets neither.
  const tools = agent_tools.RunTools_default();
  assert.ok(uses_gh_server(tools));
  tools.disallowed.push("mcp__gh");
  assert.ok(!uses_gh_server(tools));
  tools.disallowed.length = 0;
  tools.mcp_servers.gh = {};
  assert.ok(!uses_gh_server(tools));
});

test("a_plan_task_from_before_labels_is_told_to_make_only_its_plan", () => {
  const c = db.open(":memory:");
  const p = db.insert_profile(c, "p", [], null);
  const project = new_project(c, { profile_id: p.id, name: "Web", key: "WEB", repo_path: "/src/web" });
  project.start_prompt = "Write a failing test first.";
  let task = new_task(c, { profile_id: p.id, project_id: "pr", title: "Plan search" });
  // As the migration to labels leaves it.
  task = db.update_task(c, task.id, [["labels", ["plan"]], ["work_dir", `documents/${task.id}`]])!;
  const docs: Array<[string, string]> = [["plan", "/data/documents/t/plan.html"]];
  const text = system_prompt(task, project, null, [], docs, null, true);
  assert.ok(text.includes('task WEB-1 ("Plan search"') && text.includes("a plan (HTML) to /data/documents/t/plan.html"), text);
  assert.ok(text.includes("Rather than changing code") && text.includes("break it into tasks"), text);
  assert_paragraphs(text);
  assert.ok(text.includes("repository /src/web, which you can read") && !text.includes("worktree"), text);
  assert.ok(!text.includes("label plan") && !text.includes("carry it out in this task"), text);
  // It's told about the plan theme's components.
  assert.ok(text.includes('<ol class="steps">') && text.includes("<ia-html><template>"), text);
  // The project's start instructions are for its code tasks.
  assert.ok(start_prompt(task, project, "").includes(prompts.DEFAULT_START));
});

test("a_labelled_task_is_told_to_write_its_documents_besides_its_work", () => {
  const c = db.open(":memory:");
  const p = db.insert_profile(c, "p", [], null);
  const project = new_project(c, { profile_id: p.id, name: "Web", key: "WEB", repo_path: "/src/web", use_worktrees: true });
  project.start_prompt = "Write a failing test first.";
  const task = new_task(c, { profile_id: p.id, project_id: "pr", title: "Search", use_worktree: true });
  task.branch = "ia/web-1-search";
  task.worktree_path = "/w/1";
  const plain = system_prompt(task, project, null, [], [], null, true);
  assert.ok(!plain.includes("label") && !plain.includes('<ol class="steps">'), plain);
  task.labels = ["plan", "diagram"];
  const docs: Array<[string, string]> = [
    ["plan", "/d/plan.html"],
    ["diagram", "/d/diagram.mmd"],
  ];
  const text = system_prompt(task, project, null, [], docs, null, true);
  // A code task still, in its worktree.
  assert.ok(text.startsWith(plain) && text.includes("dedicated git worktree at /w/1"), text);
  assert.ok(text.includes("the labels plan, diagram") && text.includes("a plan (HTML) to /d/plan.html and a Mermaid diagram to /d/diagram.mmd"), text);
  assert.ok(text.includes("don't commit them") && text.includes("The plan comes first") && text.includes("carry it out in this task"), text);
  assert.ok(text.includes('<ol class="steps">') && text.includes("Mermaid source") && !text.includes("Rather than changing code"), text);
  assert.ok(text.includes("<ia-diagram><pre>flowchart LR") && text.includes("Always use Mermaid for plan diagrams"), text);
  assert.ok(!text.includes("<ia-diagram><svg"), text);
  // And it starts with the project's instructions.
  assert.ok(start_prompt(task, project, "").includes("Write a failing test first."));
});

test("a_reviewer_is_told_what_it_reviews_and_not_to_change_it", () => {
  const c = db.open(":memory:");
  const p = db.insert_profile(c, "p", [], null);
  const project = new_project(c, { profile_id: p.id, name: "Web", key: "WEB", repo_path: "/src/web", use_worktrees: true });
  const t = (kind: string, title: string) => new_task(c, { profile_id: p.id, project_id: "pr", kind, title, use_worktree: true });
  const parent = t("task", "Fix it");
  Object.assign(parent, { worktree_path: "/w/1", branch: "ia/web-1-fix-it", worktree_state: "ready" });
  const rev = t("review", "Review");
  rev.kind = "review";
  let text = system_prompt(rev, project, parent, [], [], null, true);
  assert.ok(text.startsWith('You are the code reviewer for task WEB-1 ("Fix it")') && text.includes("worktree at /w/1 on branch `ia/web-1-fix-it`"), text);
  assert.ok(text.includes("\n\nReview only:") && text.includes("call `submit_review` exactly once"), text);
  assert_paragraphs(text);
  rev.task_type = summary.SUMMARY;
  text = system_prompt(rev, project, parent, [], [], null, true);
  assert.ok(text.startsWith("You summarise the changes made for task WEB-1") && text.includes("\n\nRead only:"), text);
  assert_paragraphs(text);
});

test("a_scratch_task_is_told_it_has_no_repository", () => {
  const c = db.open(":memory:");
  const p = db.insert_profile(c, "p", [], null);
  const task = db.insert_scratch_task(c, {
    profile_id: p.id,
    project_id: null,
    kind: "task",
    title: "Ask",
    description: "",
    status: "todo",
    use_worktree: false,
    model: null,
    effort: null,
    claude_config_id: null,
  });
  let text = system_prompt(task, null, null, [], [], null, true);
  assert.ok(text.includes('scratch task S-1 ("Ask"') && text.includes("isn't in a project or a repository"), text);
  assert.ok(text.includes("the task's own folder") && text.includes("write freely") && !text.includes("worktree"), text);
  // One from a scratch chat isn't told its (maybe shared) folder is free to write in.
  task.work_dir = "/data/profiles/p/scratch";
  text = system_prompt(task, null, null, [], [], null, true);
  assert.ok(text.includes("a scratch folder") && !text.includes("write freely"), text);
  assert_paragraphs(text);
  assert.ok(start_prompt(task, null, "").startsWith("# S-1: Ask"));
});

test("a_scratch_task_in_a_project_reads_it", () => {
  const c = db.open(":memory:");
  const p = db.insert_profile(c, "p", [], null);
  const project = new_project(c, { profile_id: p.id, name: "Web", key: "WEB", repo_path: "/src/web", use_worktrees: true });
  const t = (title: string) => new_task(c, { profile_id: p.id, project_id: "pr", title });
  const sp = t("Search");
  Object.assign(sp, { subproject: true, branch: "ia/web-1-search", worktree_path: "/w/1", worktree_state: "ready" });
  let task = t("Ask");
  task = db.update_task(c, task.id, [["task_type", "scratch"]])!;
  let text = system_prompt(task, project, null, [], [], null, true);
  assert.ok(text.includes('scratch task WEB-2 ("Ask"') && text.includes("in the project Web") && text.includes("repository /src/web, which you can read"), text);
  assert.ok(text.includes("Don't change the repository") && !text.includes("subproject") && !text.includes("isn't in a project"), text);
  // In a subproject, it's told about the subproject's branch and worktree.
  text = system_prompt(task, project, sp, [], [], null, true);
  assert.ok(text.includes('part of the subproject WEB-1 ("Search"), whose branch `ia/web-1-search`') && text.includes("worktree at /w/1, which you can read"), text);
  assert_paragraphs(text);
  assert.ok(start_prompt(task, project, "").startsWith("# WEB-2: Ask"));
});

test("in_auto_mode_claude_reviews_waits_itself", () => {
  const args = (mode: string, review: boolean) => [
    "-p",
    "--permission-mode",
    mode,
    "--allowedTools",
    ...board_tools_allowed(mode, review),
    "mcp__gh__pr_view",
    "--disallowedTools",
    "mcp__gh__pr_merge",
    "--add-dir",
    "/a",
  ];
  for (const mode of ["default", "acceptEdits", "plan", "dontAsk", "bypassPermissions"]) {
    assert.deepEqual(board_tools_allowed(mode, false), ["mcp__huntaway"]);
    assert.ok(!approves_own_waits(args(mode, false)), mode);
  }
  for (const review of [false, true]) {
    const auto = board_tools_allowed("auto", review);
    assert.ok(auto.includes("mcp__huntaway__get_task") && auto.includes("mcp__huntaway__permission_prompt"));
    assert.ok(auto.includes("mcp__huntaway__get_task_field"));
    assert.ok(!auto.some((t) => t === "mcp__huntaway__wait" || t === "mcp__huntaway"), String(auto));
    assert.equal(auto.includes("mcp__huntaway__submit_review"), review);
    assert.ok(approves_own_waits(args("auto", review)));
  }
  // Runs started by an older build had every board tool pre-approved, under the board's current or (before the
  // rename) old server name, whatever their mode.
  const old = (mode: string, allowed: string) => ["-p", "--permission-mode", mode, "--allowedTools", allowed, "mcp__gh__pr_view", "--add-dir", "/a"];
  for (const mode of ["auto", "default", "dontAsk", "plan"]) {
    for (const allowed of ["mcp__huntaway", "mcp__issue_agent", "mcp__issue_agent__wait", "mcp__gh__pr_list,mcp__issue_agent"]) {
      assert.ok(!approves_own_waits(old(mode, allowed)), `${mode} ${allowed}`);
    }
  }
  // Only auto mode leaves waits to Claude, however the board tools are listed.
  assert.ok(approves_own_waits(old("auto", "mcp__huntaway__get_task")));
  for (const mode of ["default", "dontAsk", "plan", "acceptEdits", "bypassPermissions"]) {
    assert.ok(!approves_own_waits(old(mode, "mcp__huntaway__get_task")), mode);
  }
  // A Codex run's arguments are the adapter's.
  assert.ok(!approves_own_waits(["codex-run", "/runs/r/codex.json"]));
  assert.ok(!approves_own_waits([]));
});

/** Run `b` starts on `task`, asks permission (as call `call`) and waits. */
function start_next(state: Shared, task_id: string, call: string): string {
  const b = db.insert_run(state.db(), task_id, "prompt");
  state.runs.set(task_id, { run_id: b.id, cancel: null });
  state.update_task(task_id, [["running", true], ["status", "in_progress"]]);
  ask(state, task_id, b.id, call);
  const wait = { since: "", until: "", call_id: `${call}-wait`, run_id: b.id };
  state.update_task(task_id, [["agent_wait", wait]]);
  return b.id;
}

/** Run `run_id` asks permission, as call `call`. */
function ask(state: Shared, task_id: string, run_id: string, call: string) {
  db.run(
    state.db(),
    "INSERT INTO mcp_calls (id,run_id,task_id,tool,args,status,created_at) VALUES (?1,?2,?3,'permission_prompt','{}','executing','')",
    call,
    run_id,
    task_id,
  );
  db.run(
    state.db(),
    "INSERT INTO permission_requests (id,task_id,message_id,tool_name,input,status,created_at,call_id) VALUES (?1,?2,0,'Bash','{}','pending','',?1)",
    call,
    task_id,
  );
}

const prompt_status = (state: Shared, call: string) => db.value<string>(state.db(), "SELECT status FROM permission_requests WHERE call_id=?1", call);

test("a_run_that_starts_as_the_last_one_ends_keeps_the_task_running", () => {
  {
    const [state, task, run] = running(false);
    // A message starts the next run once the last one's handle is gone, before its end is written.
    let next = "";
    testing.when("finish:released", () => {
      next = start_next(state, task.id, "b1");
    });
    finish(state, run.id, "Ok");
    const t = reload(state, task.id);
    assert.deepEqual([t.running, t.status, t.attention_reason], [true, "in_progress", null]);
    assert.equal(state.runs.get(task.id)?.run_id, next);
    // Its prompt and wait are left alone.
    assert.equal(prompt_status(state, "b1"), "pending");
    assert.equal(t.agent_wait?.run_id, next);
  }
  {
    // Started before the last one's end is handled at all (a stop, then a message): the last one's prompt expires, the
    // next one's doesn't.
    const [state, task, run] = running(false);
    ask(state, task.id, run.id, "a2");
    state.runs.delete(task.id);
    const next = start_next(state, task.id, "b2");
    finish(state, run.id, "Cancelled");
    let t = reload(state, task.id);
    assert.deepEqual([t.running, t.status], [true, "in_progress"]);
    assert.deepEqual([prompt_status(state, "a2"), prompt_status(state, "b2")], ["expired", "pending"]);
    assert.equal(t.agent_wait?.run_id, next);
    // Its own end clears them.
    finish(state, next, "Ok");
    t = reload(state, task.id);
    assert.deepEqual([t.running, prompt_status(state, "b2"), t.agent_wait], [false, "expired", null]);
  }
});

test(
  "a_reviewer_that_exits_late_doesnt_end_the_next_round",
  // Rust starts the next round inside the finish:released hook, blocking on review::start; here the hook can't wait
  // for an async function, so the round's start goes on (from its first await) once finish has returned.
  async () => {
    const [s, thread, run] = running(false);
    const dir = testing.temp_dir();
    git_in(dir, ["init", "-q"]);
    git_in(dir, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "work"]);
    const path = path_str(dir);
    new_project(s.db(), { profile_id: thread.profile_id, repo_path: path, scratch_path: path, worktrees_root: path, use_worktrees: true });
    const parent = new_task(s.db(), { profile_id: thread.profile_id, project_id: "pr", title: "parent", status: "in_review" });
    s.update_task(parent.id, [["worktree_path", path], ["worktree_state", "ready"], ["branch", "ia/x"]]);
    db.run(s.db(), "UPDATE tasks SET kind='review', parent_id=?1, project_id='pr' WHERE id=?2", parent.id, thread.id);
    db.run(s.db(), "UPDATE runs SET kind='review' WHERE id=?1", run.id);
    // A round from before reviewers' runs were kept.
    const part = { ...db.ReviewerRun_default(), thread_id: thread.id, state: "running" };
    const old = { ...db.Review_default(), thread_id: thread.id, state: "running", reviewers: [part] };
    s.update_task(parent.id, [["review", old]]);
    // The user stops it and starts another as soon as the reviewer's handle goes, before its end is recorded.
    review.stop(s, parent.id);
    let started: Promise<any> | null = null;
    testing.when("finish:released", () => {
      runs.TEST_CAN_RUN.set(true);
      started = review.start(s, parent.id, true);
    });
    finish(s, run.id, "Cancelled");
    await started;
    const newer = s.runs.get(thread.id)!.run_id;
    assert.notEqual(newer, run.id);
    const r = reload(s, parent.id).review!;
    assert.deepEqual([r.state, r.reviewers[0].state, r.reviewers[0].after_run], ["running", "running", run.id]);
    // Its own end does.
    finish(s, newer, "Cancelled");
    assert.equal(reload(s, parent.id).review!.state, "stopped");
  },
);

test("a_message_queued_as_a_run_ends_is_sent_after_a_restart", () => {
  runs.TEST_CAN_RUN.set(true);
  const [state, task, run] = running(false);
  state.update_task(task.id, [["steerable", false]]);
  send(state, task.id, "and then this");
  // The server stops once the run is recorded as ended, before the message is sent.
  testing.when("finish:exited", () => {
    throw new Error("the server stopped");
  });
  assert.throws(() => finish(state, run.id, "Ok"));
  assert.equal(reload(state, task.id).queued_message, "and then this");
  load_active(state);
  const t = reload(state, task.id);
  assert.ok(state.is_running(task.id));
  assert.deepEqual([t.running, t.queued_message, t.status], [true, null, "in_progress"]);
  stop(state, task.id);
});

test("a_run_that_cant_start_as_the_last_one_ends_leaves_the_task_idle", () => {
  runs.TEST_CAN_RUN.set(true);
  // The next run is registered once the last one's handle is gone, but can't be marked running.
  const fail_next = (state: Shared, task: Task) => () => {
    state.db().exec("CREATE TRIGGER no_start BEFORE UPDATE OF running ON tasks WHEN NEW.running=1 BEGIN SELECT RAISE(ABORT, 'disk full'); END");
    assert.ok(error_of(() => send(state, task.id, "next")).message.includes("disk full"));
    state.db().exec("DROP TRIGGER no_start");
  };
  {
    const [state, task, run] = running(false);
    testing.when("finish:released", fail_next(state, task));
    finish(state, run.id, "Ok");
    const t = reload(state, task.id);
    // (Its sender hears that it failed.)
    assert.deepEqual([t.running, t.status], [false, "in_review"]);
    assert.ok(!state.is_running(task.id));
  }
  {
    // Or once the last one has ended, leaving its end to the next.
    const [state, task, run] = running(false);
    let next: Run | null = null;
    testing.when("finish:released", () => {
      const b = db.insert_run(state.db(), task.id, "prompt");
      state.runs.set(task.id, { run_id: b.id, cancel: null });
      next = b;
    });
    finish(state, run.id, "Ok");
    assert.ok(reload(state, task.id).running);
    abandon(state, next!, null);
    assert.ok(!reload(state, task.id).running);
    assert.ok(!state.is_running(task.id));
  }
});

test("a_queued_message_another_run_sent_isnt_sent_again", () => {
  runs.TEST_CAN_RUN.set(true);
  const [s, task, a] = running(false);
  send(s, task.id, "queued");
  // Once A's handle goes, another message starts B with what's queued, and B ends, before A carries on.
  testing.when("finish:released", () => {
    send(s, task.id, "and this");
    const b = s.runs.get(task.id)!.run_id;
    finish(s, b, "Ok");
  });
  finish(s, a.id, "Ok");
  const t = reload(s, task.id);
  const count = db.value(s.db(), "SELECT COUNT(*) FROM runs WHERE task_id=?1", task.id);
  assert.deepEqual([t.running, t.status, t.queued_message, count], [false, "in_review", null, 2]);
  assert.ok(!s.is_running(task.id));
  const events = db.value(s.db(), "SELECT COUNT(*) FROM messages WHERE task_id=?1 AND data LIKE '%queued message%'", task.id);
  assert.equal(events, 0);
});

test("an_agent_that_starts_late_is_stopped_after_a_restart", async () => {
  const [s, , run] = running(true);
  writeFileSync(join(runs.run_dir(s, run.id), "spec.json"), "{}");
  launch_ended(s, run, new Error("the agent didn't start in time"));
  // The server stops (with its watch for the agent), and ia-shim starts the agent once it's back.
  runs.end_watches();
  load_active(s);
  const agent = agent_process("sleep", ["30"]);
  writeFileSync(join(runs.run_dir(s, run.id), "pid"), String(agent.pid));
  const since = Date.now();
  while (!exited(agent) && Date.now() - since < 3000) await sleep(20);
  const stopped = exited(agent);
  if (!stopped) kill_group(agent);
  assert.ok(stopped, "the agent was left running");
  assert.ok(input_closed(s, run));
  // Done with it: a later restart doesn't watch it again.
  await sleep(100);
  assert.ok(!existsSync(join(runs.run_dir(s, run.id), "reap")));
});

test("an_agent_being_stopped_is_killed_after_a_restart", async () => {
  const [s, , run] = running(true);
  const dir = runs.run_dir(s, run.id);
  writeFileSync(join(dir, "spec.json"), "{}");
  launch_ended(s, run, new Error("the agent didn't start in time"));
  // The agent starts late, and ignores being asked to stop.
  const ready = join(dir, "ready");
  const script = "import signal, sys, time; signal.signal(signal.SIGTERM, signal.SIG_IGN); open(sys.argv[1], 'w').close(); time.sleep(30)";
  const agent = agent_process("python3", ["-c", script, ready]);
  let since = Date.now();
  while (!existsSync(ready) && Date.now() - since < 3000) await sleep(20);
  writeFileSync(join(dir, "pid"), String(agent.pid));
  await sleep(300);
  assert.ok(existsSync(join(dir, "reap")));
  // The server stops before killing it.
  runs.end_watches();
  assert.ok(!exited(agent));
  load_active(s);
  since = Date.now();
  while (!exited(agent) && Date.now() - since < 5000) await sleep(50);
  const stopped = exited(agent);
  if (!stopped) kill_group(agent);
  assert.ok(stopped, "the agent was left running");
  await sleep(300);
  assert.ok(!existsSync(join(dir, "reap")));
});

test("a_queued_message_taken_back_as_its_run_ends_doesnt_wait_for_dependencies", () => {
  runs.TEST_CAN_RUN.set(true);
  const [s, task, run] = running(false);
  new_project(s.db(), { profile_id: task.profile_id });
  const dependency = new_task(s.db(), { profile_id: task.profile_id, project_id: "pr", title: "dependency" });
  db.run(s.db(), "UPDATE tasks SET project_id='pr' WHERE id=?1", task.id);
  s.update_task(task.id, [["depends_on", [dependency.id]]]);
  send(s, task.id, "queued");
  // The user takes the message back as the run ends.
  testing.when("finish:released", () => {
    unqueue(s, task.id);
  });
  finish(s, run.id, "Ok");
  const t = reload(s, task.id);
  assert.deepEqual([t.waiting, t.running, t.status, t.queued_message], [false, false, "in_review", null]);
  // Nothing starts once the dependency is merged.
  s.update_task(dependency.id, [["status", "done"]]);
  start_unblocked(s, "pr");
  assert.equal(db.value(s.db(), "SELECT COUNT(*) FROM runs WHERE task_id=?1", task.id), 1);
  assert.ok(!s.is_running(task.id));
});

test("an_agent_launched_just_before_a_restart_is_stopped", async () => {
  // ia-shim was launched as the server stopped, and hasn't written its output yet.
  const [s, task, run] = running(true);
  const dir = runs.run_dir(s, run.id);
  unlinkSync(join(dir, "out.jsonl"));
  writeFileSync(join(dir, "spec.json"), "{}");
  s.runs.clear();
  load_active(s);
  const t = reload(s, task.id);
  assert.deepEqual([t.running, t.status], [false, "needs_attention"]);
  assert.ok(input_closed(s, run));
  // Then it starts the agent.
  const agent = agent_process("sleep", ["30"]);
  writeFileSync(join(dir, "pid"), String(agent.pid));
  const since = Date.now();
  while (!exited(agent) && Date.now() - since < 3000) await sleep(20);
  const stopped = exited(agent);
  if (!stopped) kill_group(agent);
  assert.ok(stopped, "the agent was left running");
});

test("a_run_that_cant_be_recorded_isnt_left_running", () => {
  runs.TEST_CAN_RUN.set(true);
  const state = testing.state();
  const p = db.insert_profile(state.db(), "p", [], null);
  const task = new_task(state.db(), { profile_id: p.id });
  const active = (id: string) => db.value(state.db(), "SELECT COUNT(*) FROM runs WHERE task_id=?1 AND status != 'exited'", id);
  db.queue(state.db(), task.id, db.Queued_new("queued", false));
  let err = error_of(() =>
    start_run(state, task.id, db.Queued_new("go", false), "prompt", "Ahead", () => {
      throw new Error("disk full");
    }),
  );
  assert.ok(err.message.includes("disk full"), err.message);
  assert.ok(!state.is_running(task.id));
  assert.equal(active(task.id), 0);
  const t = reload(state, task.id);
  assert.deepEqual([t.running, t.queued_message], [false, "queued"]);
  // Deleted meanwhile: an error, not a panic, and nothing left behind.
  err = error_of(() =>
    start_run(state, task.id, db.Queued_new("go", false), "prompt", "Ahead", (c, t) => {
      db.run(c, "DELETE FROM tasks WHERE id=?1", t.id);
      return [];
    }),
  );
  assert.ok(err instanceof ApiError && err.status === 404, String(err));
  assert.ok(!state.is_running(task.id));
});

test("a_queued_message_survives_a_crash_as_its_run_ends", () => {
  const [state, task, run] = running(false);
  state.update_task(task.id, [["steerable", false]]);
  send(state, task.id, "and then this");
  assert.equal(reload(state, task.id).queued_message, "and then this");
  // The server goes down (a crash, or a restart's exec) as the run ends.
  testing.when("finish:released", () => {
    throw new Error("the server stopped");
  });
  assert.throws(() => finish(state, run.id, "Ok"));
  assert.equal(reload(state, task.id).queued_message, "and then this");
});

test("a_launch_that_fails_leaves_no_agent_behind", async () => {
  for (const outcome of [new Error("the run did not start within 5s"), false]) {
    const stopped = outcome === false;
    const [state, task, run] = running(true);
    const dir = runs.run_dir(state, run.id);
    writeFileSync(join(dir, "spec.json"), "{}");
    // Given up on (or stopped) before ia-shim had started the agent, which it does after.
    launch_ended(state, run, outcome);
    assert.ok(input_closed(state, run), "an agent that reads its input as it works isn't left waiting for more");
    const agent = agent_process("sleep", ["30"]);
    writeFileSync(join(dir, "pid"), String(agent.pid));
    const since = Date.now();
    try {
      while (!exited(agent)) {
        assert.ok(Date.now() - since < 3000, "the agent was left running");
        await sleep(20);
      }
    } finally {
      kill_group(agent);
    }
    const t = reload(state, task.id);
    assert.ok(!state.is_running(task.id) && !t.running);
    assert.equal(t.attention_reason?.startsWith(stopped ? "Stopped" : "Run failed"), true);
  }
});

/** A profile with a config (and a second if `two`), set to `limit_wait`/`limit_switch`, and a task on the first. */
function out_of_usage_setup(state: Shared, agent: string, wait: boolean, sw: boolean, two: boolean): [Task, db.ClaudeConfig[]] {
  const c = state.db();
  const configs = [db.insert_claude_config(c, "Max", "/tmp/ia-max", agent)];
  if (two) configs.push(db.insert_claude_config(c, "Spare", "/tmp/ia-spare", agent));
  const p = db.insert_profile(
    c,
    "p",
    configs.map((c) => c.id),
    null,
  );
  db.update_profile(c, p.id, [["limit_wait", wait], ["limit_switch", sw]]);
  return [new_task(c, { profile_id: p.id, claude_config_id: configs[0].id }), configs];
}

/** What Claude Code prints when a turn is refused for the usage limit (from a real run). */
function refused_lines(resets: number): any[] {
  const info = { status: "rejected", resetsAt: resets, rateLimitType: "five_hour", overageStatus: "rejected", isUsingOverage: false };
  const event: any = { type: "rate_limit_event", rate_limit_info: structuredClone(info) };
  event.rate_limit_info.unifiedWindows = {
    five_hour: { utilization: 1, resetsAt: resets, status: "rejected" },
    seven_day: { utilization: 0.87, resetsAt: resets + 86400, status: "allowed_warning" },
  };
  const text = "You've hit your 5-hour limit · resets 6:30pm (Pacific/Auckland)";
  return [
    event,
    {
      type: "assistant",
      message: { model: "<synthetic>", role: "assistant", content: [{ type: "text", text }] },
      parent_tool_use_id: null,
      error: "rate_limit",
      api_error_status: 429,
      api_error: "usage_limit_reached",
      api_error_params: { rate_limit_info: info },
    },
    {
      type: "result",
      subtype: "success",
      is_error: true,
      api_error_status: 429,
      api_error: "usage_limit_reached",
      result: text,
      session_id: "s1",
      num_turns: 2,
      total_cost_usd: 0.1,
    },
  ];
}

/** A run of `task` that's refused for its usage limit, which resets at `resets`, and ends. */
function run_out(state: Shared, task: Task, resets: number) {
  const run = db.insert_run(state.db(), task.id, "prompt");
  state.runs.set(task.id, { run_id: run.id, cancel: null });
  state.update_task(task.id, [["running", true], ["status", "in_progress"]]);
  for (const line of refused_lines(resets)) handle_line(state, run, JSON.stringify(line));
  on_exit(state, run.id, 0, null, null, "");
}

/** RFC 3339 to the second, as chrono's `to_rfc3339_opts(Secs, true)`. */
const rfc3339_secs = (t: number) => new Date(t * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

function reset_in(hours: number): [number, string] {
  const t = Math.floor(Date.now() / 1000) + hours * 3600;
  return [t, rfc3339_secs(t)];
}

test("a_run_out_of_usage_waits_for_the_reset_and_carries_on", () => {
  const state = testing.state();
  const [task, configs] = out_of_usage_setup(state, "claude", true, false, false);
  const [resets, at] = reset_in(2);
  run_out(state, task, resets);
  const get = () => db.get_task(state.db(), task.id)!;
  let t = get();
  assert.deepEqual([t.status, t.waiting, t.running, t.attention_reason], ["in_progress", true, false, null]);
  assert.equal(t.limit_reset_at, at);
  assert.equal(usage.out_until(state, configs[0].id), at);

  // Not before the reset.
  runs.TEST_CAN_RUN.set(true);
  start_unblocked(state, null);
  assert.ok(get().waiting && !state.is_running(task.id));

  // Once it's reset, the agent carries on.
  const past = rfc3339_secs(resets - 3 * 3600);
  state.update_task(task.id, [["limit_reset_at", past]]);
  state.usage.get(configs[0].id).out_until = past;
  start_unblocked(state, null);
  runs.TEST_CAN_RUN.set(false);
  t = get();
  assert.ok(state.is_running(task.id));
  assert.deepEqual([t.waiting, t.limit_reset_at, t.status], [false, null, "in_progress"]);
  const last = db
    .list_messages(state.db(), task.id)
    .filter((m) => m.kind === "user")
    .at(-1)!;
  assert.ok(last.data.text.includes("has reset"), JSON.stringify(last.data));
  stop(state, task.id);
});

test("a_run_out_of_usage_offers_to_wait_and_keeps_its_queued_message", async () => {
  const state = testing.state();
  const [task] = out_of_usage_setup(state, "claude", false, false, false);
  const [resets, at] = reset_in(2);
  db.queue(state.db(), task.id, db.Queued_new("And then this", false));
  run_out(state, task, resets);
  const t = db.get_task(state.db(), task.id)!;
  assert.deepEqual([t.status, t.waiting, t.running], ["needs_attention", false, false]);
  assert.equal(t.attention_reason, "You've hit your 5-hour limit · resets 6:30pm (Pacific/Auckland)");
  assert.equal(t.limit_reset_at, at);
  // It would only be refused too, so it isn't sent.
  assert.equal(t.queued_message, "And then this");
  assert.ok(!state.is_running(task.id));

  // Asked to, it waits for the reset.
  const v = await usage.wait_for_reset(state, req({ id: task.id }));
  assert.deepEqual([v.status, v.waiting, v.limit_reset_at], ["in_progress", true, at]);

  // A run that fails for something else leaves nothing to wait for.
  const p = db.insert_profile(state.db(), "q", [], null);
  const other = new_task(state.db(), { profile_id: p.id });
  const run = db.insert_run(state.db(), other.id, "prompt");
  on_exit(state, run.id, 1, null, null, "boom");
  const o = db.get_task(state.db(), other.id)!;
  assert.deepEqual([o.status, o.limit_reset_at], ["needs_attention", null]);
  assert.ok(await fails_async(() => usage.wait_for_reset(state, req({ id: other.id }))));
});

test("a_task_started_on_a_config_out_of_usage_waits_or_moves_to_one_with_room", () => {
  const [resets, at] = reset_in(1);
  const refused = { type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: resets } };
  {
    // Waiting: it's queued, message and all, until the reset.
    const state = testing.state();
    const [task, configs] = out_of_usage_setup(state, "claude", true, false, true);
    usage.on_rate_limit_event(state, configs[0].id, refused);
    runs.TEST_CAN_RUN.set(true);
    let t = send(state, task.id, "Go");
    assert.deepEqual([t.status, t.waiting, t.limit_reset_at, t.queued_message], ["in_progress", true, at, "Go"]);
    assert.ok(!state.is_running(task.id));
    // Another message joins the queue rather than starting it.
    t = send(state, task.id, "And this");
    assert.ok(t.waiting && !state.is_running(task.id));
  }
  {
    // Switching: a task that hasn't started moves to the next config with room.
    const state = testing.state();
    const [task, configs] = out_of_usage_setup(state, "claude", true, true, true);
    usage.on_rate_limit_event(state, configs[0].id, refused);
    send(state, task.id, "Go");
    const t = db.get_task(state.db(), task.id)!;
    assert.equal(t.claude_config_id, configs[1].id);
    assert.ok(state.is_running(task.id) && !t.waiting);
    stop(state, task.id);
  }
  {
    // With every config out, it waits.
    const state = testing.state();
    const [task, configs] = out_of_usage_setup(state, "claude", true, true, true);
    for (const c of configs) usage.on_rate_limit_event(state, c.id, refused);
    const t = send(state, task.id, "Go");
    assert.deepEqual([t.claude_config_id, t.waiting], [configs[0].id, true]);
  }
  {
    // Neither set: it runs (and is refused as before).
    const state = testing.state();
    const [task, configs] = out_of_usage_setup(state, "claude", false, false, true);
    usage.on_rate_limit_event(state, configs[0].id, refused);
    send(state, task.id, "Go");
    assert.ok(state.is_running(task.id));
    stop(state, task.id);
  }
});

test("a_codex_turn_out_of_usage_waits_for_its_limits_reset", () => {
  const state = testing.state();
  const [task, configs] = out_of_usage_setup(state, "codex", true, false, false);
  const [resets, at] = reset_in(3);
  const run = db.insert_run(state.db(), task.id, "prompt");
  state.runs.set(task.id, { run_id: run.id, cancel: null });
  state.update_task(task.id, [["running", true], ["status", "in_progress"]]);
  const line = (method: string, params: any) => handle_line(state, run, JSON.stringify({ method, params }));
  line("thread/started", { thread: { id: "main" } });
  line("account/rateLimits/updated", {
    rateLimits: { primary: { usedPercent: 100, resetsAt: resets }, secondary: { usedPercent: 40, resetsAt: resets + 86400 } },
  });
  const error = { message: "You've hit your usage limit.", codexErrorInfo: "usageLimitExceeded" };
  line("turn/completed", { threadId: "main", turn: { id: "t1", status: "failed", error, items: [] } });
  on_exit(state, run.id, 0, null, null, "");
  const t = db.get_task(state.db(), task.id)!;
  assert.deepEqual([t.status, t.waiting, t.limit_reset_at], ["in_progress", true, at]);
  assert.equal(usage.out_until(state, configs[0].id), at);
});

test("a_message_to_a_task_waiting_for_its_reset_is_queued", async () => {
  runs.TEST_CAN_RUN.set(true);
  const get = (state: Shared, id: string) => db.get_task(state.db(), id)!;
  const [resets, at] = reset_in(2);
  {
    // Asked to wait, with neither setting on.
    const state = testing.state();
    const [task] = out_of_usage_setup(state, "claude", false, false, false);
    run_out(state, task, resets);
    await usage.wait_for_reset(state, req({ id: task.id }));
    const t = send(state, task.id, "x");
    assert.ok(!state.is_running(task.id));
    assert.deepEqual([t.waiting, t.limit_reset_at, t.queued_message], [true, at, "x"]);
    // An empty send (Start) doesn't start it either.
    send_message(state, task.id, db.Queued_new("", false), false, "prompt", null);
    assert.ok(!state.is_running(task.id) && get(state, task.id).waiting);
  }
  {
    // Waiting by itself, after a restart forgot that the config is out.
    const state = testing.state();
    const [task] = out_of_usage_setup(state, "claude", true, false, false);
    run_out(state, task, resets);
    state.usage.clear();
    const t = send(state, task.id, "y");
    assert.ok(!state.is_running(task.id));
    assert.deepEqual([t.waiting, t.limit_reset_at, t.queued_message], [true, at, "y"]);
  }
});

test("a_task_waiting_for_a_reset_moved_to_another_config_starts_there", async () => {
  runs.TEST_CAN_RUN.set(true);
  const [resets] = reset_in(2);
  const refused = { type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: resets } };
  {
    const state = testing.state();
    const [task, configs] = out_of_usage_setup(state, "claude", true, false, true);
    usage.on_rate_limit_event(state, configs[0].id, refused);
    assert.ok(send(state, task.id, "Go").waiting);
    await api.update_task_inner(state, task.id, { claude_config_id: configs[1].id });
    const t = db.get_task(state.db(), task.id)!;
    assert.ok(state.is_running(task.id));
    assert.deepEqual([t.waiting, t.limit_reset_at, t.claude_config_id, t.queued_message], [false, null, configs[1].id, null]);
    stop(state, task.id);
  }
  {
    // Moved to another config that's out too: it waits for that one's reset.
    const [later, at] = reset_in(3);
    const state = testing.state();
    const [task, configs] = out_of_usage_setup(state, "claude", true, false, true);
    usage.on_rate_limit_event(state, configs[0].id, refused);
    usage.on_rate_limit_event(state, configs[1].id, { rate_limit_info: { status: "rejected", resetsAt: later } });
    send(state, task.id, "Go");
    await api.update_task_inner(state, task.id, { claude_config_id: configs[1].id });
    const t = db.get_task(state.db(), task.id)!;
    assert.ok(!state.is_running(task.id));
    assert.deepEqual([t.waiting, t.limit_reset_at, t.queued_message], [true, at, "Go"]);
  }
});

test("a_config_on_extra_usage_isnt_out", () => {
  runs.TEST_CAN_RUN.set(true);
  const state = testing.state();
  const [task, configs] = out_of_usage_setup(state, "claude", true, true, true);
  // What a plan with extra usage reports on every turn past its limit, while the turns go on.
  const [resets] = reset_in(2);
  const info = {
    status: "rejected",
    resetsAt: resets,
    rateLimitType: "five_hour",
    overageStatus: "allowed",
    isUsingOverage: true,
    unifiedWindows: { five_hour: { utilization: 1, resetsAt: resets, status: "rejected" } },
  };
  usage.on_rate_limit_event(state, configs[0].id, { type: "rate_limit_event", rate_limit_info: info });
  assert.equal(usage.out_until(state, configs[0].id), null);
  const t = send(state, task.id, "Go");
  assert.ok(state.is_running(task.id));
  assert.deepEqual([t.waiting, t.claude_config_id], [false, configs[0].id], "neither held nor moved");
  stop(state, task.id);
});

test("a_merge_out_of_usage_keeps_its_place_in_the_merge_queue", async () => {
  const state = testing.state();
  const [task] = out_of_usage_setup(state, "claude", false, false, false);
  new_project(state.db(), { profile_id: task.profile_id });
  db.run(state.db(), "UPDATE tasks SET project_id='pr' WHERE id=?1", task.id);
  // Its merge run is refused for the usage limit.
  const [resets] = reset_in(2);
  const run = db.insert_run(state.db(), task.id, "prompt");
  state.runs.set(task.id, { run_id: run.id, cancel: null });
  state.update_task(task.id, [["running", true], ["status", "ready_for_merge"], ["merging", true]]);
  for (const line of refused_lines(resets)) handle_line(state, run, JSON.stringify(line));
  on_exit(state, run.id, 0, null, null, "");
  let t = db.get_task(state.db(), task.id)!;
  assert.deepEqual([t.status, t.merging, t.waiting], ["needs_attention", true, false]);
  assert.ok(t.limit_reset_at != null);

  // It can't wait out of the merge queue, where another merge could take its slot.
  await assert.rejects(usage.wait_for_reset(state, req({ id: task.id })), (e: any) => {
    assert.ok(e.message.includes("merge"), e.message);
    return true;
  });
  t = db.get_task(state.db(), task.id)!;
  assert.deepEqual([t.status, t.merging, t.waiting], ["needs_attention", true, false]);
  assert.equal(db.active_merge(state.db(), "pr", null)?.id, task.id, "it still holds the merge slot");
});

test("a_run_keeps_the_effort_its_agent_was_given", () => {
  // Claude has no `minimal` or `ultra`.
  assert.deepEqual([claude_effort("minimal"), claude_effort("ultra"), claude_effort("high")], ["low", "max", "high"]);
  const state = testing.state();
  const p = db.insert_profile(state.db(), "p", [], null);
  const task = new_task(state.db(), { profile_id: p.id, status: "in_progress" });
  const effort = (id: string) => db.value<string | null>(state.db(), "SELECT effort FROM runs WHERE id=?1", id) ?? null;
  const a = db.insert_run(state.db(), task.id, "prompt");
  const b = db.insert_run(state.db(), task.id, "prompt");
  // Not kept until it launches; the agent's own default is kept as an empty effort.
  assert.equal(effort(a.id), null);
  record_effort(state, a.id, claude_effort("minimal"));
  record_effort(state, b.id, null);
  assert.deepEqual([effort(a.id), effort(b.id)], ["low", ""]);
});

/**
 * A profile's assistant whose agent is running `run`, which takes messages as it works, and a thread-mode routine of the
 * profile with a budget of $1 a day.
 */
function assistant_running_with_a_routine(): [Shared, Task, Run, automations.Automation] {
  const state = testing.state();
  const p = db.insert_profile(state.db(), "p", [], null);
  const a = assistant.get_or_create(state, p.id);
  const run = db.insert_run(state.db(), a.id, "prompt");
  db.run(state.db(), "UPDATE runs SET status='running' WHERE id=?1", run.id);
  const dir = runs.run_dir(state, run.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "out.jsonl"), "");
  writeFileSync(join(dir, "input.jsonl"), "");
  state.runs.set(a.id, { run_id: run.id, cancel: null });
  const t = state.update_task(a.id, [["running", true]])!;
  const b = {
    name: "Ping",
    trigger: { kind: "interval", every_minutes: 60 },
    budget_usd: 1.0,
    action: { kind: "message_assistant", mode: "thread", message: "ping" },
  };
  const routine = automations.create_routine(state, p.id, b);
  return [state, t, db.get_run(state.db(), run.id)!, routine];
}

/** The automation run's agent run (whose cost it's charged), and its cost once that's ended. */
function charged_to(state: Shared, automation_run: string): [string | null, number | null] {
  const r = db.one(state.db(), "SELECT agent_run_id, cost_usd FROM automation_runs WHERE id=?1", automation_run)!;
  return [r.agent_run_id ?? null, r.cost_usd ?? null];
}

/** The automation's scheduled run, now: over its budget, it's skipped. */
async function next_scheduled_is_over_budget(state: Shared, a: automations.Automation) {
  const now = Date.now();
  db.run(state.db(), "UPDATE automations SET next_run_at=?2 WHERE id=?1", a.id, new Date(now - 1000).toISOString());
  await automations.tick(state, now);
  const r = automations.runs(state.db(), a.id, 1)[0];
  assert.deepEqual([r.source, r.status], ["schedule", "skipped"], String(r.detail));
  assert.ok(r.detail?.startsWith("Skipped: over budget"), String(r.detail));
}

/** Waits (up to two seconds) for `f`. */
async function eventually(f: () => boolean) {
  for (let i = 0; i < 200 && !f(); i++) await sleep(10);
}

// HA-122 review: a thread-mode routine's message steered into the assistant's run is charged to the run that takes it in.
test("a_routines_message_steered_into_the_assistants_run_is_charged_its_cost", async () => {
  const [state, a, run, routine] = assistant_running_with_a_routine();
  const r = await automations.run_now(state, routine, {});
  const steer = reload(state, a.id).steering[0];
  assert.deepEqual(steer.routine_runs, [r.id]);
  // Not until the agent takes it in.
  assert.deepEqual(charged_to(state, r.id), [null, null]);
  output(state, run, [replay(steer.id, steer.text)]);
  assert.equal(charged_to(state, r.id)[0], run.id);
  db.run(state.db(), "UPDATE runs SET cost_usd=1.5 WHERE id=?1", run.id);
  finish(state, run.id, "Ok");
  assert.deepEqual(charged_to(state, r.id), [run.id, 1.5]);
  await next_scheduled_is_over_budget(state, routine);
});

// HA-122 review: one the run exited without taking in goes with its routine's run to the run that takes it from the
// queue, which is charged, not the one it was steered to.
test("a_routines_message_the_assistant_didnt_take_in_is_charged_to_the_run_that_does", async () => {
  runs.TEST_CAN_RUN.set(true);
  const [state, a, first, routine] = assistant_running_with_a_routine();
  const r = await automations.run_now(state, routine, {});
  assert.deepEqual(reload(state, a.id).steering[0].routine_runs, [r.id]);
  // The agent exits without taking it in: it's queued again, and the next run starts with it.
  db.run(state.db(), "UPDATE runs SET cost_usd=0.1 WHERE id=?1", first.id);
  runs.close_input(state, first.id);
  finish(state, first.id, "Ok");
  const next = state.runs.get(a.id)?.run_id;
  assert.ok(next, "the next run");
  assert.notEqual(next, first.id);
  assert.equal(charged_to(state, r.id)[0], next);
  // That run costs $2 (its launch fails here, ending it).
  db.run(state.db(), "UPDATE runs SET cost_usd=2 WHERE id=?1", next);
  await eventually(() => !state.is_running(a.id));
  assert.ok(!state.is_running(a.id));
  assert.deepEqual(charged_to(state, r.id), [next, 2]);
  await next_scheduled_is_over_budget(state, routine);
  runs.TEST_CAN_RUN.set(false);
});

/**
 * A project's task whose agent is running `run`, which takes messages as it works, and an automation of the project that
 * does `action`, with a budget of $1 a day.
 */
function project_task_running_with_an_automation(action: any): [Shared, Task, Run, automations.Automation] {
  const state = testing.state();
  const p = db.insert_profile(state.db(), "p", [], null);
  new_project(state.db(), { id: "web", profile_id: p.id, name: "Web", key: "WEB", repo_path: "/src/web" });
  const task = new_task(state.db(), { profile_id: p.id, project_id: "web", title: "Inbox", status: "in_progress" });
  const run = db.insert_run(state.db(), task.id, "prompt");
  db.run(state.db(), "UPDATE runs SET status='running' WHERE id=?1", run.id);
  const dir = runs.run_dir(state, run.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "out.jsonl"), "");
  writeFileSync(join(dir, "input.jsonl"), "");
  state.runs.set(task.id, { run_id: run.id, cancel: null });
  const t = state.update_task(task.id, [["running", true]])!;
  const act = action.kind === "send_to_task" ? { kind: "send_to_task", task_id: task.id, message: "ping" } : action;
  const b = { name: "Ping", trigger: { kind: "interval", every_minutes: 60 }, budget_usd: 1.0, action: act };
  const a = automations.create(state, "web", b);
  return [state, t, db.get_run(state.db(), run.id)!, a];
}

// HA-161: a project automation's budget never filled up, as what the tasks it made or messaged cost wasn't counted: the
// agent run that takes its message in is charged to it now, as a routine's is.
test("a_project_automations_message_is_charged_the_run_that_takes_it_in", async () => {
  const [state, task, run, a] = project_task_running_with_an_automation({ kind: "send_to_task" });
  const r = await automations.run_now(state, a, {});
  assert.deepEqual([r.status, r.task_id], ["ok", task.id], String(r.detail));
  const steer = reload(state, task.id).steering[0];
  assert.deepEqual(steer.routine_runs, [r.id]);
  assert.ok(steer.from_agent);
  output(state, run, [replay(steer.id, steer.text)]);
  assert.equal(charged_to(state, r.id)[0], run.id);
  // While it works, its run shows what it's cost so far.
  db.run(state.db(), "UPDATE runs SET cost_usd=1.5 WHERE id=?1", run.id);
  assert.equal(automations.run_json(state.db(), r).cost_usd, 1.5);
  finish(state, run.id, "Ok");
  assert.deepEqual(charged_to(state, r.id), [run.id, 1.5]);
  await next_scheduled_is_over_budget(state, a);
});

// HA-161: the task a project automation makes and starts has its first run charged to it (not the task's later work,
// which the user asks for).
test("a_project_automations_new_tasks_first_run_is_charged_to_it", async () => {
  runs.TEST_CAN_RUN.set(true);
  const [state, , , a] = project_task_running_with_an_automation({ kind: "create_task", title: "Look", start: true });
  const r = await automations.run_now(state, a, {});
  assert.equal(r.status, "ok", String(r.detail));
  const made = r.task_id!;
  const first = state.runs.get(made)?.run_id;
  assert.ok(first, "its first run");
  assert.equal(charged_to(state, r.id)[0], first);
  // It started as a task does, with the start prompt, not as another agent's message.
  const started = user_messages(state, made);
  assert.equal(started.length, 1);
  assert.equal(started[0].start, true, JSON.stringify(started));
  // That run costs $2 (its launch fails here, ending it).
  db.run(state.db(), "UPDATE runs SET cost_usd=2 WHERE id=?1", first);
  await eventually(() => !state.is_running(made));
  assert.ok(!state.is_running(made));
  assert.deepEqual(charged_to(state, r.id), [first, 2]);
  await next_scheduled_is_over_budget(state, a);
  runs.TEST_CAN_RUN.set(false);
});

// HA-161 review: the start of a task a project automation made, held back for its config's usage limit, dropped the
// automation run with its empty message, so the run it got once the limit reset wasn't charged to it.
test("a_project_automations_new_task_that_waits_for_a_usage_reset_is_charged_its_first_run", async () => {
  const state = testing.state();
  const [task, configs] = out_of_usage_setup(state, "claude", true, false, false);
  new_project(state.db(), { id: "web", profile_id: task.profile_id, name: "Web", key: "WEB", repo_path: "/src/web" });
  const b = {
    name: "Make",
    trigger: { kind: "interval", every_minutes: 60 },
    budget_usd: 1.0,
    action: { kind: "create_task", title: "Look", start: true, claude_config_id: configs[0].id },
  };
  const a = automations.create(state, "web", b);
  const [resets] = reset_in(1);
  usage.on_rate_limit_event(state, configs[0].id, { type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: resets } });
  runs.TEST_CAN_RUN.set(true);
  const r = await automations.run_now(state, a, {});
  assert.equal(r.status, "ok", String(r.detail));
  const made = r.task_id!;
  const get = () => db.get_task(state.db(), made)!;
  assert.ok(get().waiting && !state.is_running(made));
  assert.deepEqual(charged_to(state, r.id), [null, null]);

  // Once the limit resets, it starts as a task does, and that first run is the automation run's.
  const past = rfc3339_secs(resets - 3 * 3600);
  state.update_task(made, [["limit_reset_at", past]]);
  state.usage.get(configs[0].id).out_until = past;
  start_unblocked(state, null);
  const first = state.runs.get(made)?.run_id;
  assert.ok(first, "its first run");
  assert.equal(charged_to(state, r.id)[0], first);
  assert.equal(user_messages(state, made)[0].start, true);
  db.run(state.db(), "UPDATE runs SET cost_usd=2 WHERE id=?1", first);
  await eventually(() => !state.is_running(made));
  assert.ok(!state.is_running(made));
  runs.TEST_CAN_RUN.set(false);
  assert.deepEqual(charged_to(state, r.id), [first, 2]);
  await next_scheduled_is_over_budget(state, a);
});

// HA-161 review: with no queued text, the automation runs left on a thread stay for the run that starts it, and a
// message queued later takes them along.
test("automation_runs_left_with_no_text_go_to_the_next_run", () => {
  const state = testing.state();
  const p = db.insert_profile(state.db(), "p", [], null);
  const task = new_task(state.db(), { profile_id: p.id });
  const c = state.db();
  db.queue(c, task.id, { ...db.Queued_new("", false), routine_runs: ["a"] });
  assert.equal(db.get_task(c, task.id)!.queued_message, null);
  assert.equal(db.take_queued(c, task.id), null);
  db.queue(c, task.id, db.Queued_new("Hello", false));
  // While a message is queued, they're its, not for a run that starts without it.
  assert.deepEqual(db.take_parked_runs(c, task.id), []);
  assert.deepEqual(db.take_queued(c, task.id)!.routine_runs, ["a"]);
  assert.deepEqual(db.take_parked_runs(c, task.id), []);
  db.queue(c, task.id, { ...db.Queued_new(" ", true), routine_runs: ["b"] });
  assert.deepEqual(db.take_parked_runs(c, task.id), ["b"]);
  assert.deepEqual(db.take_parked_runs(c, task.id), []);
});

// HA-161 review: an automatic prompt (a review's fixes, say) that started while an automation's message was queued took
// that message's automation run with it, leaving the message, so the wrong run was charged, and the one that took the
// message in later wasn't.
test("an_automatic_prompt_leaves_a_queued_automation_message_its_run", async () => {
  const [state, task, run, a] = project_task_running_with_an_automation({ kind: "send_to_task" });
  // The task's agent isn't running: the automation's message waits in its queue (as it would for its dependencies).
  finish(state, run.id, "Ok");
  const r = automations.Run_new(a.id, "schedule", "ok", Date.now());
  automations.insert_run(state.db(), r);
  db.queue(state.db(), task.id, { ...db.Queued_new("From the automation", true), routine_runs: [r.id] });
  runs.TEST_CAN_RUN.set(true);
  send_fixes(state, task.id, "Fix these", 1);
  const fixes = state.runs.get(task.id)?.run_id;
  assert.ok(fixes, "the fixes run");
  assert.deepEqual(charged_to(state, r.id), [null, null]);
  assert.equal(reload(state, task.id).queued_message, "From the automation");
  // The run that takes the message in, once the fixes run ends, is charged.
  await eventually(() => charged_to(state, r.id)[0] !== null);
  runs.TEST_CAN_RUN.set(false);
  const charged = charged_to(state, r.id)[0];
  assert.ok(charged, "charged to the run that took its message in");
  assert.notEqual(charged, fixes);
  assert.equal(reload(state, task.id).queued_message, null);
});

// HA-161 merge: a steered message that went back to the queue was taken for a routine's (one with nobody there) if it
// carried automation runs, which a project automation's does too.
test("a_requeued_steer_is_a_routines_only_if_it_was_sent_as_one", async () => {
  const queued_routine = (state: Shared, id: string) => !!db.value(state.db(), "SELECT queued_routine FROM tasks WHERE id=?1", id);
  {
    const [state, task, run, a] = project_task_running_with_an_automation({ kind: "send_to_task" });
    await automations.run_now(state, a, {});
    assert.ok(!reload(state, task.id).steering[0].routine);
    runs.close_input(state, run.id);
    finish(state, run.id, "Ok");
    assert.ok(reload(state, task.id).queued_message != null);
    assert.ok(!queued_routine(state, task.id));
  }
  {
    const [state, a, run, routine] = assistant_running_with_a_routine();
    await automations.run_now(state, routine, {});
    assert.ok(reload(state, a.id).steering[0].routine);
    runs.close_input(state, run.id);
    finish(state, run.id, "Ok");
    assert.ok(reload(state, a.id).queued_message != null);
    assert.ok(queued_routine(state, a.id));
  }
});

// HA-238: a task's first run in a config folder with no login got a session that Claude Code never answered in ("Not
// logged in"). Kept, every later run resumed it, and in the folder that had the login none could find it.
test("a_session_the_model_never_answered_is_not_resumed", () => {
  const [state, task, first] = running(true);
  const not_logged_in = (session: string) => ({
    type: "result", subtype: "success", is_error: true, result: "Not logged in · Please run /login", session_id: session,
    duration_api_ms: 0, total_cost_usd: 0, num_turns: 1,
  });
  const init = (session: string) => ({ type: "system", subtype: "init", session_id: session });
  const next = () => {
    const run = db.insert_run(state.db(), task.id, "prompt");
    db.run(state.db(), "UPDATE runs SET status='running' WHERE id=?1", run.id);
    const dir = runs.run_dir(state, run.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "out.jsonl"), "");
    return run;
  };
  const ended = (run: Run) => db.run(state.db(), "UPDATE runs SET status='exited' WHERE id=?1", run.id);
  output(state, first, [init("s1"), not_logged_in("s1")]);
  ended(first);
  // The next run starts the conversation again, from the task's description.
  assert.equal(reload(state, task.id).session_id, null);
  assert.ok(db.list_messages(state.db(), task.id).some((m) => m.data.type === "result"));

  // One the model answered is kept, even if a later run's turn fails the same way: its conversation is there.
  const second = next();
  const answered = result("success", 0.5);
  answered.session_id = "s2";
  output(state, second, [init("s2"), answered]);
  ended(second);
  assert.equal(reload(state, task.id).session_id, "s2");
  const resumed = next();
  output(state, resumed, [init("s2"), not_logged_in("s2")]);
  ended(resumed);
  assert.equal(reload(state, task.id).session_id, "s2");

  // As is one whose first turn was answered in the same run.
  const third = next();
  const paid = result("success", 0.25);
  paid.session_id = "s3";
  output(state, third, [init("s3"), paid, { ...not_logged_in("s3"), total_cost_usd: 0.25 }]);
  assert.equal(reload(state, task.id).session_id, "s3");
});
