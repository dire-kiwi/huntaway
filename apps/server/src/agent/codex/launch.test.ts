// How a Codex run is launched (agent/runner/launch.ts) since its requests go to its output (agent/codex/requests.ts): a
// new session gets the board's tools as dynamic tools (and the board's MCP server only if its Codex won't take them);
// one that started with them keeps them; one from before, or whose Codex wouldn't take them, has the board's MCP
// server. A fake ia-shim takes the run (its folder written) and starts nothing.
import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as db from "../../db.ts";
import type { Shared } from "../../state.ts";
import * as testing from "../../testing.ts";
import { sleep } from "../../util.ts";
import * as runs from "../runs.ts";
import * as agent_tools from "../agent_tools.ts";
import { MCP_SERVER_NAME, stop } from "../runner.ts";
import { send } from "../runner/queue.ts";
import * as mcp_http from "../../mcp/http.ts";
import { BOARD_TOOLS, handle_line } from "./output.ts";
import { set_test_models } from "./queries.ts";

const shim = join(testing.temp_dir(), "ia-shim");
// It writes the agent's pid (its own shell's, gone at once) and exits: the run is started, and nothing runs.
writeFileSync(shim, '#!/bin/sh\necho $$ > "$1/pid"\n', { mode: 0o755 });
process.env.IA_SHIM_BIN = shim;
runs.TEST_CAN_RUN.set(true);

function codex_task(state: Shared, kind = "scratch", session: string | null = null, project = false): string {
  const home = testing.temp_dir();
  set_test_models(home, []);
  const cfg = db.insert_claude_config(state.db(), "Codex", home, "codex");
  const p = db.insert_profile(state.db(), "p", [], null);
  const dir = testing.temp_dir();
  const pr = project
    ? db.insert_project(state.db(), {
        id: `pr-${p.id}`,
        profile_id: p.id,
        name: "x",
        key: "X",
        repo_path: dir,
        scratch_path: dir,
        worktrees_root: dir,
        base_branch: null,
        use_worktrees: false,
      })
    : null;
  const task = db.insert_task(state.db(), {
    profile_id: p.id,
    project_id: pr?.id ?? null,
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
  // The board's server stays in mcp.json, for the adapter to give the thread only if Codex won't take the dynamic
  // tools (adapter.test.ts), and gh's.
  assert.ok(l.servers[MCP_SERVER_NAME]);
  assert.ok(l.servers.gh);
  assert.equal(JSON.parse(readFileSync(join(runs.run_dir(state, l.run_id), mcp_http.SETTINGS_FILE), "utf8")).in_process, false);
  assert.equal(db.value(state.db(), "SELECT board_tools FROM runs WHERE id=?1", l.run_id), 1);
});

test("a_session_whose_codex_wouldnt_take_them_has_the_mcp_server_in_its_later_runs", async () => {
  const state = testing.state();
  const task = codex_task(state);
  // Its first run was to give the session them, and the adapter says Codex wouldn't take them (adapter.ts's
  // start_thread) before the thread starts.
  const first = db.insert_run(state.db(), task, "prompt");
  db.set_run_board_tools(state.db(), first.id);
  handle_line(state, first, { method: BOARD_TOOLS, params: { dynamic: false } });
  handle_line(state, first, { method: "thread/started", params: { thread: { id: "s1" } } });
  assert.equal(db.value(state.db(), "SELECT board_tools FROM runs WHERE id=?1", first.id), 0);
  db.run(state.db(), "UPDATE runs SET status='exited' WHERE id=?1", first.id);
  const next = await launched(state, task);
  assert.deepEqual([next.spec.thread_id, next.spec.board_tools], ["s1", null]);
  assert.ok(next.servers[MCP_SERVER_NAME]);
  assert.equal(JSON.parse(readFileSync(join(runs.run_dir(state, next.run_id), mcp_http.SETTINGS_FILE), "utf8")).in_process, false);
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

test("every_run_has_the_docs_server_and_uses_it_without_asking", async () => {
  // HA-280: Codex approves its tools up front, Claude has it in --allowedTools, and both are told of it.
  const state = testing.state();
  const codex = await launched(state, codex_task(state));
  assert.ok(codex.servers.docs?.url.endsWith(`/api/mcp/${codex.run_id}/docs`));
  assert.ok(codex.spec.approved_mcp_servers.includes("docs"));
  assert.ok(codex.spec.developer_instructions.includes("`docs.publish_document`"), codex.spec.developer_instructions);

  const claude = codex_task(state);
  db.run(state.db(), "UPDATE tasks SET claude_config_id=NULL WHERE id=?1", claude);
  send(state, claude, "go");
  const deadline = Date.now() + 5000;
  let dir = "";
  while (!dir || !existsSync(join(dir, "pid"))) {
    assert.ok(Date.now() < deadline, "the run didn't start");
    await sleep(10);
    const run_id = state.runs.get(claude)?.run_id;
    dir = run_id ? runs.run_dir(state, run_id) : "";
  }
  const args: string[] = JSON.parse(readFileSync(join(dir, "spec.json"), "utf8")).args;
  const allowed = args.slice(args.indexOf("--allowedTools") + 1);
  assert.ok(
    allowed
      .slice(
        0,
        allowed.findIndex((a) => a.startsWith("--")),
      )
      .includes("mcp__docs"),
    args.join(" "),
  );
  assert.ok(JSON.parse(readFileSync(join(dir, "mcp.json"), "utf8")).mcpServers.docs);
  assert.ok(readFileSync(join(dir, "system-prompt.md"), "utf8").includes("mcp__docs__publish_document"));
  stop(state, claude);
});

test("a_project_that_turns_the_docs_server_off_gets_no_docs_server", async () => {
  // HA-286: not only unapproved and untold, but not in the run's mcp.json at all.
  const state = testing.state();
  const task = codex_task(state, "scratch", null, true);
  const project = db.get_task(state.db(), task)!.project_id!;
  agent_tools.set_overrides(state.db(), project, { disabled_skills: [], disabled_mcp_servers: ["docs"], seen: {} });
  const l = await launched(state, task);
  assert.deepEqual(Object.keys(l.servers).sort(), ["gh", "huntaway"]);
  assert.ok(!l.spec.approved_mcp_servers.includes("docs"));
  assert.ok(!l.spec.developer_instructions.includes("publish_document"));
  // A project that doesn't has it.
  assert.ok((await launched(state, codex_task(state, "scratch", null, true))).servers.docs);
});
