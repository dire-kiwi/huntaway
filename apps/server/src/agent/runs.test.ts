// Port of the tests in server/src/agent/runs.rs.
import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, futimesSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as db from "../db.ts";
import type { Shared } from "../state.ts";
import * as testing from "../testing.ts";
import { new_id, sleep } from "../util.ts";
import {
  RUN_FORMAT,
  SERVE_ENV,
  boot_id,
  follow_inner,
  pid_reused,
  prune,
  remove_finished,
  resume_reaping,
  run_dir,
  start,
  stop_orphan,
  timing,
  type Launch,
} from "./runs.ts";
import * as mcp_http from "../mcp/http.ts";

// As Rust's are under cfg(test).
timing.REAP_WAIT = 5_000;
timing.REAP_GRACE = 1_000;

function new_task(state: Shared, status: string): string {
  const p = db.list_profiles(state.db())[0] ?? db.insert_profile(state.db(), "p", [], null);
  const t = {
    profile_id: p.id,
    project_id: null,
    kind: "task",
    title: "t",
    description: "",
    status,
    use_worktree: false,
    model: null,
    effort: null,
    claude_config_id: null,
  };
  return db.insert_task(state.db(), t).id;
}

/** A running run with output `out` so far, and the task it's for. */
function run_with_output(out: string): [Shared, string, string] {
  const state = testing.state();
  const task = new_task(state, "in_progress");
  const run = db.insert_run(state.db(), task, "prompt");
  db.run(state.db(), "UPDATE runs SET status='running' WHERE id=?1", run.id);
  const dir = run_dir(state, run.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "out.jsonl"), out);
  return [state, task, run.id];
}

/** A tool result with an image that makes its line over 1 MiB, as a Read of a big screenshot does. */
function screenshot(): string {
  const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "A".repeat(3 << 20) } };
  return JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [image] }] } });
}

function said(text: string): string {
  return JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
}

function thread(state: Shared, task_id: string): any[] {
  return testing
    .messages(state.db(), task_id)
    .filter((m) => m.kind === "claude")
    .map((m) => m.data);
}

function image_result(m: any): boolean {
  return JSON.stringify(m.message.content[0].content) === JSON.stringify([{ type: "text", text: "[image]" }]);
}

/** A run of `task_id` with a folder, ended at `ended` (still running if null) and finished on disk if `exit`. */
function run_in(state: Shared, task_id: string, ended: string | null, exit: boolean): string {
  const run = db.insert_run(state.db(), task_id, "prompt");
  if (ended !== null) db.run(state.db(), "UPDATE runs SET status='exited', ended_at=?1 WHERE id=?2", ended, run.id);
  const dir = run_dir(state, run.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "out.jsonl"), "{}\n");
  if (exit) writeFileSync(join(dir, "exit"), `{"code":0}`);
  return run.id;
}

function call(state: Shared, run_id: string, at: string) {
  db.run(
    state.db(),
    "INSERT INTO mcp_calls (id,run_id,task_id,tool,args,status,result,created_at) VALUES (?1,?2,'t','wait','{}','done','{}',?3)",
    new_id(),
    run_id,
    at,
  );
}

test("prunes_old_finished_runs_and_their_calls_and_finished_runs_of_deleted_tasks", () => {
  const state = testing.state();
  const [task, gone] = [new_task(state, "todo"), new_task(state, "todo")];
  const now = new Date("2026-10-28T12:00:00Z");
  const old = "2026-10-01T12:00:00.000Z";
  const lately = "2026-10-27T12:00:00.000Z";
  const old_run = run_in(state, task, old, true);
  const recent_run = run_in(state, task, lately, true);
  // Started weeks ago and still going.
  const running = run_in(state, task, null, false);
  db.run(state.db(), "UPDATE runs SET created_at=?1 WHERE id=?2", old, running);
  const gone_done = run_in(state, gone, lately, true);
  const gone_running = run_in(state, gone, null, false);
  // Its shim (this process, for the test) is still stopping it.
  writeFileSync(join(run_dir(state, gone_running), "shim.pid"), String(process.pid));
  const gone_dead = run_in(state, gone, null, false);
  writeFileSync(join(run_dir(state, gone_dead), "shim.pid"), "999999999");
  for (const r of [old_run, recent_run, running, gone_done]) call(state, r, old);
  call(state, recent_run, "2026-10-28T11:59:00.000Z");
  db.run(state.db(), "DELETE FROM tasks WHERE id=?1", gone);

  assert.deepEqual(prune(state, now), { runs: 3, calls: 3 });
  const kept = (id: string) => existsSync(run_dir(state, id));
  assert.ok(!kept(old_run) && kept(recent_run) && kept(running));
  assert.ok(!kept(gone_done) && kept(gone_running) && !kept(gone_dead));
  // A call of the recent run made in the last hour stays, as do the running run's.
  const calls = db.all(state.db(), "SELECT run_id FROM mcp_calls ORDER BY created_at").map((r: any) => r.run_id);
  assert.deepEqual(calls, [running, recent_run]);
  assert.deepEqual(prune(state, now), { runs: 0, calls: 0 });
});

test("following_stops_when_a_deleted_tasks_run_folder_goes_before_its_exit_is_seen", async () => {
  const [state, task_id, run_id] = run_with_output(`${said("working")}\n`);
  const following = follow_inner(state, run_id, 0);
  while (thread(state, task_id).length === 0) await sleep(20);
  // The agent exits between two polls, and its task is deleted before the next.
  writeFileSync(join(run_dir(state, run_id), "exit"), `{"code":0}`);
  db.run(state.db(), "DELETE FROM tasks WHERE id=?1", task_id);
  remove_finished(state, [run_id]);
  assert.ok(!existsSync(run_dir(state, run_id)));
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([following, new Promise((_, reject) => (timer = setTimeout(() => reject(new Error("still following a removed run")), 3000)))]);
  clearTimeout(timer);
});

/**
 * An agent as ia-shim starts it (running `script`), in a process group of its own, recorded in
 * the run's `pid`, on this boot as `start` records it.
 */
function agent(state: Shared, run_id: string, script: string): ChildProcess {
  const child = spawn("sh", ["-c", script], { detached: true, stdio: "ignore" });
  const dir = run_dir(state, run_id);
  writeFileSync(join(dir, "pid"), String(child.pid));
  writeFileSync(join(dir, "run.json"), JSON.stringify({ boot: boot_id(), format: RUN_FORMAT }));
  return child;
}

const running = (c: ChildProcess) => c.exitCode === null && c.signalCode === null;

async function exits(agent: ChildProcess, within: number) {
  const deadline = Date.now() + within;
  while (running(agent)) {
    assert.ok(Date.now() < deadline, "the agent is still running");
    await sleep(20);
  }
}

function stop(agent: ChildProcess) {
  try {
    process.kill(-agent.pid!, "SIGKILL");
  } catch {}
}

/** Once the agent's script has `exec`ed `sleep` (so it has run `trap`). */
async function is_sleeping(agent: ChildProcess) {
  const comm = `/proc/${agent.pid}/comm`;
  for (;;) {
    let c: string;
    try {
      c = readFileSync(comm, "utf8");
    } catch {
      return;
    }
    if (c.trim() === "sleep") return;
    await sleep(10);
  }
}

test("an_agent_that_outlives_its_shim_is_stopped", async () => {
  const [state, task_id, run_id] = run_with_output(`${said("working")}\n`);
  const a = agent(state, run_id, "exec sleep 60");
  try {
    // Its shim was killed (by hand, or by the OOM killer).
    writeFileSync(join(run_dir(state, run_id), "shim.pid"), "999999999");
    await follow_inner(state, run_id, 0);
    const run = db.get_run(state.db(), run_id)!;
    assert.equal(run.status, "exited");
    assert.ok(!db.get_task(state.db(), task_id)!.running);
    await exits(a, 5000);
    const deadline = Date.now() + 2000;
    while (existsSync(join(run_dir(state, run_id), "orphan"))) {
      assert.ok(Date.now() < deadline, "still marked to stop");
      await sleep(20);
    }
  } finally {
    stop(a);
  }
});

test("an_orphan_ignoring_sigterm_is_killed_after_a_restart_too", async () => {
  const [state, , run_id] = run_with_output("");
  const a = agent(state, run_id, "trap '' TERM; exec sleep 60");
  try {
    const dir = run_dir(state, run_id);
    await is_sleeping(a);
    // The server stopped as it waited for the agent to go, after its run ended.
    writeFileSync(join(dir, "orphan"), "");
    process.kill(-a.pid!, "SIGTERM");
    writeFileSync(join(dir, "exit"), `{"code":null,"signal":null,"error":"the run's supervisor (ia-shim) disappeared"}`);
    await sleep(200);
    assert.ok(running(a));
    resume_reaping(state);
    await exits(a, timing.REAP_GRACE + 2000);
  } finally {
    stop(a);
  }
});

test("an_orphan_is_still_stopped_when_its_task_is_deleted_meanwhile", async () => {
  const [state, task_id, run_id] = run_with_output("");
  const a = agent(state, run_id, "trap '' TERM; exec sleep 60");
  try {
    const dir = run_dir(state, run_id);
    await is_sleeping(a);
    // Its shim vanished, and its task is deleted while the agent is given time to go.
    stop_orphan(dir);
    writeFileSync(join(dir, "exit"), `{"code":null,"signal":null,"error":"the run's supervisor (ia-shim) disappeared"}`);
    db.run(state.db(), "DELETE FROM runs WHERE id=?1", run_id);
    db.run(state.db(), "DELETE FROM tasks WHERE id=?1", task_id);
    remove_finished(state, [run_id]);
    assert.equal(prune(state, new Date()).runs, 0);
    assert.ok(existsSync(join(dir, "orphan")) && existsSync(join(dir, "pid")));
    await exits(a, timing.REAP_GRACE + 2000);
    // Then its folder goes as any other of a deleted task's.
    const deadline = Date.now() + 2000;
    while (existsSync(join(dir, "orphan"))) {
      assert.ok(Date.now() < deadline, "still marked to stop");
      await sleep(20);
    }
    assert.equal(prune(state, new Date()).runs, 1);
  } finally {
    stop(a);
  }
});

test("a_live_shim_isnt_taken_for_gone_when_the_clock_jumps", async () => {
  const [state, , run_id] = run_with_output(`${said("working")}\n`);
  const a = agent(state, run_id, "exec sleep 60");
  try {
    const dir = run_dir(state, run_id);
    // Its shim (this process, for the test) is running, and the clock has jumped forward two hours
    // since it started (a VM resumed, say): its files look that much older than its processes.
    writeFileSync(join(dir, "shim.pid"), String(process.pid));
    const earlier = (Date.now() - 7200_000) / 1000;
    for (const f of ["pid", "shim.pid", "run.json"]) {
      const fd = openSync(join(dir, f), "r+");
      futimesSync(fd, earlier, earlier);
      closeSync(fd);
    }
    const following = follow_inner(state, run_id, 0);
    // Past the follower's check on the shim.
    await sleep(2600);
    assert.ok(!existsSync(join(dir, "exit")));
    assert.ok(running(a));
    assert.equal(db.get_run(state.db(), run_id)!.status, "running");
    writeFileSync(join(dir, "exit"), `{"code":0}`);
    await following;
  } finally {
    stop(a);
  }
});

test("a_process_that_took_an_agents_pid_after_a_reboot_isnt_stopped", async () => {
  const [state, , run_id] = run_with_output("");
  const other = agent(state, run_id, "exec sleep 60");
  try {
    const dir = run_dir(state, run_id);
    assert.ok(!pid_reused(dir));
    // The agent's pid was recorded before a reboot, and this process has it now.
    writeFileSync(join(dir, "run.json"), JSON.stringify({ boot: "an-earlier-boot", format: RUN_FORMAT }));
    assert.ok(pid_reused(dir));
    stop_orphan(dir);
    await sleep(300);
    assert.ok(running(other), "another process was stopped");
    // As by a run from before boot ids were recorded, which goes by whether the pid is alive.
    writeFileSync(join(dir, "run.json"), JSON.stringify({ format: RUN_FORMAT }));
    assert.ok(!pid_reused(dir));
  } finally {
    stop(other);
  }
});

test("follows_a_running_agent_past_a_line_over_a_chunk", async () => {
  const result = JSON.stringify({ type: "result", subtype: "success", is_error: false, total_cost_usd: 0.5, num_turns: 1 });
  const out = `${said("checking the screenshot")}\n${screenshot()}\n${said("looks right")}\n${result}\n`;
  const [state, task_id, run_id] = run_with_output(out);
  const following = follow_inner(state, run_id, 0);
  // All of it reaches the thread while the agent is still running.
  const deadline = Date.now() + 10_000;
  while (thread(state, task_id).length < 4) {
    assert.ok(Date.now() < deadline, `the thread stopped at ${JSON.stringify(thread(state, task_id).at(-1))?.slice(0, 200)}`);
    await sleep(50);
  }
  const msgs = thread(state, task_id);
  assert.ok(image_result(msgs[1]));
  assert.equal(msgs[2].message.content[0].text, "looks right");
  assert.equal(msgs[3].type, "result");
  const run = db.get_run(state.db(), run_id)!;
  assert.equal(run.out_offset, Buffer.byteLength(out));

  writeFileSync(join(run_dir(state, run_id), "exit"), `{"code":0}`);
  await following;
  assert.equal(db.get_run(state.db(), run_id)!.status, "exited");
});

test("takes_in_a_long_last_line_of_an_exited_run_whole", async () => {
  // The agent's last line has no newline: it was killed while writing, say.
  const out = `${said("checking the screenshot")}\n${screenshot()}`;
  const [state, task_id, run_id] = run_with_output(out);
  writeFileSync(join(run_dir(state, run_id), "exit"), `{"code":1}`);
  await follow_inner(state, run_id, 0);
  const msgs = thread(state, task_id);
  assert.equal(msgs.length, 2, JSON.stringify(msgs).slice(0, 500));
  assert.ok(image_result(msgs[1]));
  const run = db.get_run(state.db(), run_id)!;
  assert.deepEqual([run.out_offset, run.status], [Buffer.byteLength(out), "exited"]);
  rmSync(run_dir(state, run_id), { recursive: true, force: true });
});

test("an_agents_run_doesnt_get_the_servers_own_settings", async () => {
  // A service's or the desktop app's settings for `huntaway serve` (HA-185): a server the agent starts mustn't get them.
  const state = testing.state();
  const task = new_task(state, "in_progress");
  const run = db.insert_run(state.db(), task, "prompt");
  const dir = testing.temp_dir();
  // A stand-in ia-shim (`ia-shim <run dir> -- <program> <args>`) that writes down the environment it was started with.
  const shim = join(dir, "shim");
  writeFileSync(shim, `#!/bin/sh\nenv > "$1/env.txt"\necho $$ > "$1/pid"\n`, { mode: 0o755 });
  const set = { IA_SHIM_BIN: shim, IA_CLAUDE_BIN: "/bin/true", HA185_KEPT: "yes", ...Object.fromEntries(SERVE_ENV.map((k) => [k, `from-the-server-${k}`])) };
  const before = Object.fromEntries(Object.keys(set).map((k) => [k, process.env[k]]));
  Object.assign(process.env, set);
  try {
    const l = {
      run_id: run.id,
      cwd: dir,
      args: [],
      env: [["IA_FROM_LAUNCH", "1"]] as Array<[string, string]>,
      config_dir: null,
      prompt: "hi",
      input: false,
      review: false,
      mcp_servers: {},
      github_account: null,
      codex: null,
    };
    await start(state, l);
  } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  const env = new Map(
    readFileSync(join(run_dir(state, run.id), "env.txt"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );
  for (const k of SERVE_ENV) assert.equal(env.get(k), undefined, `${k} reached the agent`);
  assert.equal(env.get("HA185_KEPT"), "yes");
  assert.equal(env.get("IA_CLAUDE_BIN"), "/bin/true");
  assert.equal(env.get("IA_FROM_LAUNCH"), "1");
  assert.ok(env.get("PATH"));
});

test("a_run_that_calls_the_board_on_its_output_has_no_board_server_in_its_mcp_config", async () => {
  // HA-221: the board's tools are an in-process server (see runner/requests.ts) for a Claude run that takes input.
  const state = testing.state();
  const task = new_task(state, "in_progress");
  const dir = testing.temp_dir();
  const shim = join(dir, "shim");
  writeFileSync(shim, `#!/bin/sh\necho $$ > "$1/pid"\n`, { mode: 0o755 });
  const before = process.env.IA_SHIM_BIN;
  process.env.IA_SHIM_BIN = shim;
  const started = async (more: Partial<Launch>) => {
    const run = db.insert_run(state.db(), task, "prompt");
    const l: Launch = {
      run_id: run.id,
      cwd: dir,
      args: [],
      env: [],
      config_dir: null,
      prompt: "hi",
      input: true,
      review: false,
      mcp_servers: { own: { type: "stdio", command: "own" } },
      github_account: null,
      codex: null,
      ...more,
    };
    await start(state, l);
    const read = (f: string) => JSON.parse(readFileSync(join(run_dir(state, run.id), f), "utf8"));
    return { servers: Object.keys(read("mcp.json").mcpServers).sort(), format: read("run.json").format, in_process: read(mcp_http.SETTINGS_FILE).in_process };
  };
  try {
    assert.deepEqual(await started({ asks_on_output: true, tools_on_output: true }), { servers: ["gh", "own"], format: 4, in_process: true });
    // In Bypass, with nothing to ask: its tools still need its input.
    assert.deepEqual(await started({ tools_on_output: true }), { servers: ["gh", "own"], format: 4, in_process: true });
    // A compaction (no input), and older runs' formats.
    assert.deepEqual(await started({ input: false }), { servers: ["gh", "huntaway", "own"], format: 2, in_process: false });
    assert.deepEqual(await started({ asks_on_output: true }), { servers: ["gh", "huntaway", "own"], format: 3, in_process: false });
  } finally {
    if (before === undefined) delete process.env.IA_SHIM_BIN;
    else process.env.IA_SHIM_BIN = before;
  }
});
