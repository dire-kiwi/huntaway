// How a Codex run is launched (agent/runner/launch.ts) since its requests go to its output (agent/codex/requests.ts): a
// new session gets the board's tools as dynamic tools and no board MCP server; one that started with them keeps them;
// one from before keeps the board's MCP server. A fake ia-shim takes the run (its folder written) and starts nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as db from "../../db.ts";
import type { Shared } from "../../state.ts";
import * as testing from "../../testing.ts";
import { sleep } from "../../util.ts";
import * as runs from "../runs.ts";
import { MCP_SERVER_NAME, stop } from "../runner.ts";
import { send } from "../runner/queue.ts";
import { set_test_models } from "./queries.ts";

const shim = join(testing.temp_dir(), "ia-shim");
// It writes the agent's pid (its own shell's, gone at once) and exits: the run is started, and nothing runs.
writeFileSync(shim, '#!/bin/sh\necho $$ > "$1/pid"\n', { mode: 0o755 });
process.env.IA_SHIM_BIN = shim;
runs.TEST_CAN_RUN.set(true);

function codex_task(state: Shared, kind = "scratch", session: string | null = null): string {
  const home = testing.temp_dir();
  set_test_models(home, []);
  const cfg = db.insert_claude_config(state.db(), "Codex", home, "codex");
  const p = db.insert_profile(state.db(), "p", [], null);
  const task = db.insert_task(state.db(), {
    profile_id: p.id,
    project_id: null,
    kind,
    title: "t",
    description: "",
    status: "in_progress",
    use_worktree: false,
    model: null,
    effort: null,
    claude_config_id: cfg.id,
  });
  if (session !== null) state.update_task(task.id, [["session_id", session]]);
  return task.id;
}

interface Launched {
  run_id: string;
  spec: any;
  servers: Record<string, any>;
  format: number;
}

/** Sends task `task_id` a message, and reads what its run was launched with. */
async function launched(state: Shared, task_id: string): Promise<Launched> {
  send(state, task_id, "go");
  const deadline = Date.now() + 5000;
  for (;;) {
    const run_id = state.runs.get(task_id)?.run_id;
    const dir = run_id ? runs.run_dir(state, run_id) : "";
    if (run_id && existsSync(join(dir, "pid"))) {
      const read = (f: string) => JSON.parse(readFileSync(join(dir, f), "utf8"));
      const out = { run_id, spec: read("codex.json"), servers: read("mcp.json").mcpServers, format: read("run.json").format };
      stop(state, task_id);
      return out;
    }
    assert.ok(Date.now() < deadline, "the run didn't start");
    await sleep(10);
  }
}

test("a_new_session_gets_the_boards_tools_as_dynamic_tools", async () => {
  const state = testing.state();
  const task = codex_task(state);
  const l = await launched(state, task);
  assert.equal(l.format, 5);
  assert.equal(l.spec.requests_on_output, true);
  assert.deepEqual([l.spec.board_tools.type, l.spec.board_tools.name], ["namespace", MCP_SERVER_NAME]);
  // No board server: the board's HTTP server refuses the run's calls, and gh's stays.
  assert.equal(l.servers[MCP_SERVER_NAME], undefined);
  assert.ok(l.servers.gh);
  assert.equal(db.value(state.db(), "SELECT board_tools FROM runs WHERE id=?1", l.run_id), 1);
});

test("a_session_that_started_with_them_keeps_them_and_one_from_before_keeps_the_mcp_server", async () => {
  const state = testing.state();
  // Its first run gave the session its dynamic tools.
  const kept = codex_task(state, "scratch", "s1");
  const first = db.insert_run(state.db(), kept, "prompt");
  db.set_run_session(state.db(), first.id, "s1");
  db.set_run_board_tools(state.db(), first.id);
  db.run(state.db(), "UPDATE runs SET status='exited' WHERE id=?1", first.id);
  let l = await launched(state, kept);
  assert.deepEqual([l.spec.thread_id, l.spec.board_tools, l.spec.requests_on_output], ["s1", null, true]);
  assert.equal(l.servers[MCP_SERVER_NAME], undefined);
  assert.equal(db.value(state.db(), "SELECT board_tools FROM runs WHERE id=?1", l.run_id), 0);

  // A session from before: its runs gave it none, so it has the board's server, which Codex's reviewer reviews in auto mode.
  const old = codex_task(state, "scratch", "s0");
  const before = db.insert_run(state.db(), old, "prompt");
  db.set_run_session(state.db(), before.id, "s0");
  db.run(state.db(), "UPDATE runs SET status='exited' WHERE id=?1", before.id);
  state.update_task(old, [["permission_mode", "auto"]]);
  l = await launched(state, old);
  assert.deepEqual([l.spec.board_tools, l.spec.requests_on_output, l.spec.review_waits], [null, true, true]);
  assert.ok(l.servers[MCP_SERVER_NAME]);
});

test("in_auto_mode_a_dynamic_wait_is_the_boards_to_ask_about", async () => {
  const state = testing.state();
  const task = codex_task(state);
  state.update_task(task, [["permission_mode", "auto"]]);
  const l = await launched(state, task);
  assert.deepEqual([l.spec.approvals_reviewer, l.spec.review_waits], ["auto_review", false]);
});
