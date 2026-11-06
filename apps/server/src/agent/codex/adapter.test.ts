// The adapter (`huntaway codex-run`, adapter.ts) against a fake `codex app-server`: the board's tools go to a new
// thread as dynamic tools, the app-server's requests go to the run's output and their answers come back on its input,
// and with no input (a compaction) they're declined.
import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import * as testing from "../../testing.ts";
import { Spec_default } from "../codex.ts";
import { MCP_SERVER_NAME } from "../runner.ts";
import { BOARD_TOOLS } from "./output.ts";
import { board_tools } from "./requests.ts";

const MAIN = join(import.meta.dirname, "..", "..", "main.ts");

/**
 * A fake app-server: it records what it's sent (`sent.jsonl`), starts a thread, and for each turn asks for approval of
 * a command (request 10) and a dynamic tool call (request 11), then a third (request 12) it stops waiting for at once
 * (serverRequest/resolved), and ends the turn with an agent message saying what it was answered.
 */
const FAKE = String.raw`
const fs = require("node:fs");
const rl = require("node:readline").createInterface({ input: process.stdin });
const log = (m) => fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(m) + "\n");
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
const answers = {};
let turn = 0;
const t = { threadId: "th1" };
rl.on("line", (line) => {
  const m = JSON.parse(line);
  log(m);
  if (m.method === "initialize") return send({ id: m.id, result: {} });
  if (m.method === "thread/start" && m.params.dynamicTools && process.env.FAKE_NO_DYNAMIC_TOOLS)
    return send({ id: m.id, error: { code: -32600, message: "thread/start.dynamicTools requires experimentalApi capability" } });
  if (m.method === "thread/start") return send({ id: m.id, result: { thread: { id: "th1" }, model: "gpt-x" } });
  if (m.method === "thread/compact/start") {
    send({ id: m.id, result: {} });
    send({ id: 20, method: "item/commandExecution/requestApproval", params: { ...t, itemId: "c0", command: "ls" } });
    return;
  }
  if (m.method === "turn/start") {
    turn++;
    send({ id: m.id, result: { turn: { id: "turn" + turn } } });
    send({ method: "turn/started", params: { ...t, turn: { id: "turn" + turn } } });
    send({ method: "item/started", params: { ...t, item: { type: "commandExecution", id: "c1", command: "make" } } });
    send({ id: 10, method: "item/commandExecution/requestApproval", params: { ...t, itemId: "c1", command: "make" } });
    send({ id: 11, method: "item/tool/call", params: { ...t, callId: "d1", namespace: "huntaway", tool: "get_task", arguments: {} } });
    send({ id: 12, method: "item/tool/requestUserInput", params: { ...t, itemId: "q1", questions: [] } });
    send({ method: "serverRequest/resolved", params: { ...t, requestId: 12 } });
    return;
  }
  if (m.method === undefined && "id" in m) {
    answers[m.id] = m.result ?? m.error;
    if (m.id === 20) {
      send({ method: "thread/compacted", params: t });
      return;
    }
    if (answers[10] && answers[11]) {
      send({ method: "serverRequest/resolved", params: { ...t, requestId: 10 } });
      send({ method: "item/completed", params: { ...t, item: { type: "agentMessage", id: "m1", text: JSON.stringify(answers) } } });
      send({ method: "turn/completed", params: { ...t, turn: { id: "turn" + turn, status: "completed" } } });
    }
  }
});
`;

interface Ran {
  out: any[];
  sent: any[];
}

/** The board's MCP server, as launch.ts leaves it in a new session's `mcp.json`. */
const BOARD_SERVER = { type: "http", url: "http://127.0.0.1:1/mcp/run/huntaway", headers: { Authorization: "Bearer x" } };

/**
 * Runs the adapter with `spec`, answering each request on its output with `answer` (with input), until it exits.
 * `no_dynamic_tools`: the fake is a Codex that won't take dynamic tools.
 */
function adapter(fields: Partial<ReturnType<typeof Spec_default>>, answer: (req: any) => any, no_dynamic_tools = false): Promise<Ran> {
  const dir = testing.temp_dir();
  const fake = join(dir, "fake-codex.cjs");
  writeFileSync(fake, `#!/usr/bin/env node\n${FAKE}`, { mode: 0o755 });
  const spec = Spec_default({ cwd: dir, approval_policy: "untrusted", approvals_reviewer: "user", sandbox: "workspace-write", ...fields });
  writeFileSync(join(dir, "codex.json"), JSON.stringify(spec));
  writeFileSync(join(dir, "mcp.json"), JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: BOARD_SERVER } }));
  const log = join(dir, "sent.jsonl");
  writeFileSync(log, "");
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", MAIN, "codex-run", join(dir, "codex.json")], {
    env: { ...process.env, IA_CODEX_BIN: fake, FAKE_LOG: log, ...(no_dynamic_tools ? { FAKE_NO_DYNAMIC_TOOLS: "1" } : {}) },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const out: any[] = [];
  const prompt = { type: "user", uuid: "u1", message: { role: "user", content: "Go" } };
  child.stdin.write(spec.input ? `${JSON.stringify(prompt)}\n` : "Go");
  if (!spec.input) child.stdin.end();
  createInterface({ input: child.stdout }).on("line", (line) => {
    const v = JSON.parse(line);
    out.push(v);
    if (!spec.input) return;
    if ("id" in v && v.method) child.stdin.write(`${JSON.stringify({ type: "codex_response", id: v.id, ...answer(v) })}\n`);
    if (v.method === "turn/completed") child.stdin.end();
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`the adapter didn't exit: ${JSON.stringify(out)}`));
    }, 20_000);
    child.on("exit", () => {
      clearTimeout(timer);
      const sent = readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
      resolve({ out, sent });
    });
  });
}

test("requests_go_to_the_output_and_their_answers_come_back_on_the_input", async () => {
  const tools = board_tools(false);
  const { out, sent } = await adapter({ input: true, requests_on_output: true, board_tools: tools }, (req) =>
    req.method === "item/tool/call" ? { result: { contentItems: [{ type: "inputText", text: "task" }], success: true } } : { result: { decision: "accept" } },
  );
  // The board's tools, on the new thread, and not its MCP server.
  const start = sent.find((m) => m.method === "thread/start");
  assert.deepEqual(start.params.dynamicTools, [tools]);
  assert.equal(start.params.config.mcp_servers[MCP_SERVER_NAME], undefined);
  assert.ok(!out.some((v) => v.method === BOARD_TOOLS));
  // Each request on the output, an approval with the item it's about.
  const requests = out.filter((v) => "id" in v && v.method);
  assert.deepEqual(requests.map((r) => r.id), [10, 11, 12]);
  assert.deepEqual(requests[0].item, { type: "commandExecution", id: "c1", command: "make" });
  // Their answers, passed on.
  const answers = sent.filter((m) => m.method === undefined && [10, 11, 12].includes(m.id));
  assert.deepEqual(answers.map((a) => [a.id, a.result]), [
    [10, { decision: "accept" }],
    [11, { contentItems: [{ type: "inputText", text: "task" }], success: true }],
  ]);
  // What the app-server stopped waiting for is told only of one the board hadn't answered.
  assert.deepEqual(out.filter((v) => v.method === "serverRequest/resolved").map((v) => v.params.requestId), [12]);
  assert.ok(out.some((v) => v.method === "turn/completed"));
});

test("a_resumed_thread_gets_no_dynamic_tools", async () => {
  // thread/resume can't change them: the fake starts a thread, which is what's checked here.
  const { sent } = await adapter({ input: true, requests_on_output: true, board_tools: null }, () => ({ result: { decision: "accept" } }));
  const start = sent.find((m) => m.method === "thread/start");
  assert.equal(start.params.dynamicTools, undefined);
  // The board's MCP server instead.
  assert.ok(start.params.config.mcp_servers[MCP_SERVER_NAME]);
});

test("a_codex_that_wont_take_dynamic_tools_gets_the_boards_mcp_server_and_says_so", async () => {
  const tools = board_tools(false);
  const { out, sent } = await adapter({ input: true, requests_on_output: true, board_tools: tools }, () => ({ result: { decision: "accept" } }), true);
  const starts = sent.filter((m) => m.method === "thread/start");
  assert.equal(starts.length, 2);
  assert.deepEqual(starts[0].params.dynamicTools, [tools]);
  assert.equal(starts[0].params.config.mcp_servers[MCP_SERVER_NAME], undefined);
  // Started again without them, with the board's server.
  assert.equal(starts[1].params.dynamicTools, undefined);
  assert.equal(starts[1].params.config.mcp_servers[MCP_SERVER_NAME].url, BOARD_SERVER.url);
  // It says so: a warning, and the notification the server records it from.
  assert.match(out.find((v) => v.method === "warning").params.message, /doesn't take the board's tools as dynamic tools .* on the board's MCP server instead/);
  assert.deepEqual(out.find((v) => v.method === BOARD_TOOLS).params, { dynamic: false });
  assert.ok(out.some((v) => v.method === "turn/completed"));
});

test("with_no_input_requests_are_declined", async () => {
  const { out, sent } = await adapter({ input: false, compact: true, requests_on_output: false }, () => ({}));
  assert.deepEqual(sent.find((m) => m.id === 20 && m.method === undefined).result, { decision: "decline" });
  assert.equal(out.filter((v) => "id" in v && v.method).length, 0);
});
