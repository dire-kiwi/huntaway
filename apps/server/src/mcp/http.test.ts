// Tests of the board's MCP servers over HTTP (mcp/http.ts, HA-180).
import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import * as db from "../db.ts";
import type { Task } from "../db.ts";
import type { Shared } from "../state.ts";
import * as testing from "../testing.ts";
import { sleep } from "../util.ts";
import * as runs from "../agent/runs.ts";
import { VIA_BROKER } from "../hosts/broker.ts";
import * as mcp_http from "./http.ts";
import * as permissions from "./permissions.ts";

/** A task with a run that's going, and the run's settings for its servers (as `runs::start` writes them). */
function running_task(s: Shared, settings: Partial<mcp_http.RunSettings> = {}): [Task, db.Run] {
  const profile = db.insert_profile(s.db(), "p", [], null);
  const t = {
    profile_id: profile.id,
    project_id: null,
    kind: "task",
    title: "t",
    description: "",
    status: "in_progress",
    use_worktree: false,
    model: null,
    effort: null,
    claude_config_id: null,
  };
  const task = db.insert_task(s.db(), t);
  const run = db.insert_run(s.db(), task.id, "prompt");
  db.run(s.db(), "UPDATE runs SET status='running' WHERE id=?1", run.id);
  s.runs.set(task.id, { run_id: run.id, cancel: null });
  const dir = runs.run_dir(s, run.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, mcp_http.SETTINGS_FILE), mcp_http.settings_json({ cwd: "/tmp", github_account: null, review: false, ...settings }));
  return [task, run];
}

/** This state's MCP servers on a port of their own, as `serve` has them: `url(run, server)` is where a run's are. */
async function listen(s: Shared): Promise<{ server: Server; base: string }> {
  const server = createServer((req, res) => {
    mcp_http.serve(s, req, res).catch((e) => res.destroy(e));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  s.internal_url = base;
  return { server, base };
}

/** The run's `mcpServers` entry for `name`, as Claude Code would use it. */
function entry(s: Shared, run: db.Run, name: string) {
  return mcp_http.servers(s, run.id)[name];
}

async function post(e: any, msg: any, accept = "application/json, text/event-stream", headers: Record<string, string> = {}) {
  return fetch(e.url, { method: "POST", headers: { ...e.headers, accept, "content-type": "application/json", ...headers }, body: JSON.stringify(msg) });
}

/** Server-sent events off a response, one at a time. */
function events(res: Response) {
  const reader = res.body!.getReader();
  let buf = "";
  return async (): Promise<{ id?: string; event?: string; data: string; retry?: string } | null> => {
    for (;;) {
      const end = buf.indexOf("\n\n");
      if (end >= 0) {
        const block = buf.slice(0, end);
        buf = buf.slice(end + 2);
        const ev: any = { data: "" };
        let fields = 0;
        for (const line of block.split("\n")) {
          if (line.startsWith(":")) continue;
          const i = line.indexOf(":");
          const [k, v] = i < 0 ? [line, ""] : [line.slice(0, i), line.slice(i + 1).replace(/^ /, "")];
          if (k === "data") ev.data += v;
          else ev[k] = v;
          fields++;
        }
        if (fields) return ev;
        continue;
      }
      const { value, done } = await reader.read();
      if (done) return null;
      buf += Buffer.from(value).toString();
    }
  };
}

async function until(f: () => boolean, what: string) {
  for (let i = 0; i < 500; i++) {
    if (f()) return;
    await sleep(10);
  }
  assert.fail(`timed out waiting for ${what}`);
}

test("a_runs_servers_take_only_its_own_secret", async () => {
  const s = testing.state();
  const [, run] = running_task(s);
  const [, other] = running_task(s);
  const { server } = await listen(s);
  try {
    const e = entry(s, run, "huntaway");
    assert.equal(e.type, "http");
    assert.ok(e.url.endsWith(`/api/mcp/${run.id}/huntaway`));
    assert.equal(e.headers.Authorization, `Bearer ${mcp_http.run_secret(s.token, run.id)}`);
    assert.notEqual(mcp_http.run_secret(s.token, run.id), mcp_http.run_secret(s.token, other.id));
    assert.notEqual(mcp_http.run_secret(s.token, run.id), s.token);
    // Claude Code gives an HTTP server's call 5 minutes without news unless the server's entry says otherwise.
    assert.ok(e.timeout >= 86_400_000 && entry(s, run, "gh").timeout >= 600_000);

    const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } };
    assert.equal((await post(e, init)).status, 200);
    // Another run's secret, the host's token, none at all.
    for (const auth of [`Bearer ${mcp_http.run_secret(s.token, other.id)}`, `Bearer ${s.token}`, ""]) {
      const r = await post({ ...e, headers: { Authorization: auth } }, init);
      assert.equal(r.status, 401, auth);
    }
    // Not through the broker, and only the board's two servers.
    assert.equal((await post(e, init, undefined, { [VIA_BROKER]: "1" })).status, 404);
    assert.equal((await post({ ...e, url: e.url.replace(/huntaway$/, "other") }, init)).status, 404);
    // A run whose launch didn't record its settings (one started with stdio helpers, say).
    const none = db.insert_run(s.db(), db.get_run(s.db(), run.id)!.task_id, "prompt");
    assert.equal((await post(entry(s, none, "huntaway"), init)).status, 404);
  } finally {
    server.close();
  }
});

test("a_run_that_calls_the_board_on_its_output_has_only_the_gh_server_here", async () => {
  // HA-221: a Claude run's board tools are an in-process server (agent/runner/requests.ts), not this one.
  const s = testing.state();
  const [, run] = running_task(s, { in_process: true });
  const [, other] = running_task(s);
  const { server } = await listen(s);
  try {
    const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } };
    assert.equal((await post(entry(s, run, "huntaway"), init)).status, 404);
    const call = { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_projects", arguments: {} } };
    assert.equal((await post(entry(s, run, "huntaway"), call)).status, 404);
    assert.equal((await post(entry(s, run, "gh"), init)).status, 200);
    assert.equal((await post(entry(s, other, "huntaway"), init)).status, 200);
  } finally {
    server.close();
  }
});

test("lists_and_calls_the_board_tools_over_http", async () => {
  const s = testing.state();
  const [task, run] = running_task(s);
  const { server } = await listen(s);
  try {
    const e = entry(s, run, "huntaway");
    const init = (await (await post(e, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } })).json()) as any;
    assert.equal(init.result.protocolVersion, "2025-11-25");
    assert.equal(init.result.serverInfo.name, "huntaway");
    // Notifications get no answer; nor do GETs for a stream of the server's own, or sessions to end.
    assert.equal((await post(e, { jsonrpc: "2.0", method: "notifications/initialized" })).status, 202);
    assert.equal((await fetch(e.url, { headers: { ...e.headers, accept: "text/event-stream" } })).status, 405);
    assert.equal((await fetch(e.url, { method: "DELETE", headers: e.headers })).status, 405);
    assert.equal((await post(e, [{ jsonrpc: "2.0", id: 1, method: "ping" }])).status, 400);
    const unknown = (await (await post(e, { jsonrpc: "2.0", id: 2, method: "server/discover" })).json()) as any;
    assert.equal(unknown.error.code, -32601);

    const list = (await (await post(e, { jsonrpc: "2.0", id: 3, method: "tools/list" })).json()) as any;
    const names = list.result.tools.map((t: any) => t.name);
    assert.ok(names.includes("update_task") && !names.includes("submit_review"));

    // A call is answered on an event stream: its priming event (an id, a retry time, no data), then the answer.
    const res = await post(e, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "get_task", arguments: { task_id: task.id } } });
    assert.equal(res.headers.get("content-type"), "text/event-stream");
    const next = events(res);
    const prime = (await next())!;
    assert.deepEqual([prime.data, prime.retry], ["", String(mcp_http.RETRY_MS)]);
    assert.ok(prime.id);
    const msg = (await next())!;
    assert.equal(msg.event, "message");
    const v = JSON.parse(msg.data);
    assert.equal(v.id, 4);
    assert.ok(!v.result.isError, msg.data);
    assert.equal(JSON.parse(v.result.content[0].text).id, task.id);
    // The call went to the board as the run's.
    assert.equal(db.value(s.db(), "SELECT run_id FROM mcp_calls WHERE tool='get_task'"), run.id);

    // A client that doesn't take event streams gets JSON.
    const plain = (await (
      await post(e, { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "get_task", arguments: { task_id: task.id } } }, "application/json")
    ).json()) as any;
    assert.equal(JSON.parse(plain.result.content[0].text).id, task.id);
  } finally {
    server.close();
  }
});

test("a_reviews_server_offers_the_reviewers_tools", async () => {
  const s = testing.state();
  const [, run] = running_task(s, { review: true });
  const { server } = await listen(s);
  try {
    const list = (await (await post(entry(s, run, "huntaway"), { jsonrpc: "2.0", id: 1, method: "tools/list" })).json()) as any;
    const names = list.result.tools.map((t: any) => t.name);
    assert.ok(names.includes("submit_review") && !names.includes("update_task"));
  } finally {
    server.close();
  }
});

/** A permission prompt for `ls` over HTTP, its stream read up to its priming event. */
async function prompt(s: Shared, run: db.Run, controller: AbortController) {
  const e = entry(s, run, "huntaway");
  const res = await fetch(e.url, {
    method: "POST",
    headers: { ...e.headers, accept: "application/json, text/event-stream", "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "permission_prompt", arguments: { tool_name: "Bash", input: { command: "ls" }, tool_use_id: "toolu_1" } },
    }),
    signal: controller.signal,
  });
  const prime = (await events(res)())!;
  return prime.id!;
}

/** Reconnect for the answer to the call whose stream had event id `last`, as a client does once its stream broke. */
async function resume(s: Shared, run: db.Run, last: string) {
  const e = entry(s, run, "huntaway");
  const res = await fetch(e.url, { headers: { ...e.headers, accept: "text/event-stream", "last-event-id": last } });
  assert.equal(res.status, 200);
  const next = events(res);
  const prime = (await next())!;
  // The new stream has the same id, so it can be resumed in turn.
  assert.equal(prime.id, last);
  const msg = (await next())!;
  return JSON.parse(msg.data);
}

const request_for = (s: Shared, run: db.Run) =>
  db.value<string>(s.db(), "SELECT p.id FROM permission_requests p JOIN mcp_calls m ON m.id=p.call_id WHERE m.run_id=?1", run.id);

test("a_call_whose_stream_broke_is_answered_when_the_client_reconnects", async () => {
  const s = testing.state();
  const [, run] = running_task(s);
  const { server } = await listen(s);
  try {
    const controller = new AbortController();
    const last = await prompt(s, run, controller);
    await until(() => request_for(s, run) !== undefined, "the prompt");
    // The connection goes (the client's, or a proxy's): the prompt stays.
    controller.abort();
    const answer = resume(s, run, last);
    await sleep(50);
    permissions.decide(s, request_for(s, run)!, true, false, null);
    const v = await answer;
    assert.equal(v.id, 7);
    assert.deepEqual(JSON.parse(v.result.content[0].text), { behavior: "allow", updatedInput: { command: "ls" } });
    // Once only.
    assert.equal(db.value(s.db(), "SELECT count(*) FROM permission_requests"), 1);

    // Answered while the client was away: its answer is the one recorded.
    assert.deepEqual(JSON.parse((await resume(s, run, last)).result.content[0].text).behavior, "allow");
  } finally {
    server.close();
  }
});

test("a_call_with_a_progress_token_makes_progress_on_its_stream_and_after_a_reconnect", async () => {
  // Claude Code drops a call 90 seconds after its stream broke unless it has had progress since: a prompt answered more
  // than a minute and a half after a restart was lost without it.
  const s = testing.state();
  const [, run] = running_task(s);
  const { server } = await listen(s);
  try {
    const e = entry(s, run, "huntaway");
    const controller = new AbortController();
    const res = await fetch(e.url, {
      method: "POST",
      headers: { ...e.headers, accept: "application/json, text/event-stream", "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "permission_prompt",
          arguments: { tool_name: "Bash", input: { command: "ls" } },
          _meta: { progressToken: 3, "claudecode/toolUseId": "toolu_9" },
        },
      }),
      signal: controller.signal,
    });
    const next = events(res);
    const last = (await next())!.id!;
    const first = JSON.parse((await next())!.data);
    assert.equal(first.method, "notifications/progress");
    assert.equal(first.params.progressToken, 3);
    await until(() => request_for(s, run) !== undefined, "the prompt");
    controller.abort();

    s.calls_inflight.clear();
    const r = await fetch(e.url, { headers: { ...e.headers, accept: "text/event-stream", "last-event-id": last } });
    const again = events(r);
    assert.equal((await again())!.id, last);
    const note = JSON.parse((await again())!.data);
    assert.deepEqual([note.method, note.params.progressToken], ["notifications/progress", 3]);
    assert.ok(note.params.progress >= first.params.progress);
    permissions.decide(s, request_for(s, run)!, true, false, null);
    let v: any;
    do v = JSON.parse((await again())!.data);
    while (v.method === "notifications/progress");
    assert.deepEqual([v.id, JSON.parse(v.result.content[0].text).behavior], [3, "allow"]);
  } finally {
    server.close();
  }
});

test("a_prompt_cut_short_by_a_restart_carries_on_when_the_client_reconnects", async () => {
  const s = testing.state();
  const [, run] = running_task(s);
  const { server } = await listen(s);
  try {
    const controller = new AbortController();
    const last = await prompt(s, run, controller);
    await until(() => request_for(s, run) !== undefined, "the prompt");
    controller.abort();
    // As a restarted server has it: the call recorded as going, but nothing in this process waiting on it.
    s.calls_inflight.clear();
    const answer = resume(s, run, last);
    await sleep(50);
    permissions.decide(s, request_for(s, run)!, false, false, "no");
    const v = await answer;
    assert.equal(JSON.parse(v.result.content[0].text).behavior, "deny");
    assert.equal(db.value(s.db(), "SELECT count(*) FROM permission_requests"), 1);
  } finally {
    server.close();
  }
});

test("a_resumed_call_the_board_never_got_or_another_runs_is_refused", async () => {
  const s = testing.state();
  const [, run] = running_task(s);
  const [, other] = running_task(s);
  const { server } = await listen(s);
  try {
    // The server stopped before it recorded the call: it wasn't run, so the agent can call it again.
    const id = `huntaway.c0.${Buffer.from("9").toString("base64url")}`;
    const v = await resume(s, run, id);
    assert.equal(v.id, 9);
    assert.ok(v.result.isError && v.result.content[0].text.includes("wasn't run"), JSON.stringify(v));

    const controller = new AbortController();
    const last = await prompt(s, run, controller);
    controller.abort();
    const e = entry(s, other, "huntaway");
    const res = await fetch(e.url, { headers: { ...e.headers, accept: "text/event-stream", "last-event-id": last } });
    assert.equal(res.status, 404);
    // Nor on the other server, or garbled.
    const gh = entry(s, run, "gh");
    for (const bad of [last, "nonsense"]) {
      const r = await fetch(gh.url, { headers: { ...gh.headers, accept: "text/event-stream", "last-event-id": bad } });
      assert.equal(r.status, 404, bad);
    }
  } finally {
    server.close();
  }
});

test("the_gh_server_is_the_runs", async () => {
  const s = testing.state();
  const [, run] = running_task(s, { github_account: "octo-bot" });
  const { server } = await listen(s);
  try {
    const e = entry(s, run, "gh");
    const init = (await (await post(e, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } })).json()) as any;
    assert.equal(init.result.serverInfo.name, "huntaway-gh");
    assert.ok(init.result.instructions.includes("the GitHub account octo-bot"), init.result.instructions);
    const list = (await (await post(e, { jsonrpc: "2.0", id: 2, method: "tools/list" })).json()) as any;
    assert.ok(list.result.tools.some((t: any) => t.name === "pr_create"));
    // A gh call's stream that broke after a restart: its output is gone, and the agent is told so.
    const r = await fetch(e.url, {
      headers: { ...e.headers, accept: "text/event-stream", "last-event-id": `gh.x1.${Buffer.from("3").toString("base64url")}` },
    });
    const next = events(r);
    await next();
    const v = JSON.parse((await next())!.data);
    assert.ok(v.result.isError && v.result.content[0].text.includes("restarted"), JSON.stringify(v));
  } finally {
    server.close();
  }
});

test("only_a_run_launched_with_the_desktop_server_reaches_it", async () => {
  // HA-273's review: a run's secret is its gh and docs servers' too, so one launched while computer use was off
  // mustn't get desktop answers with it.
  const s = testing.state();
  const { server } = await listen(s);
  try {
    const msg = { jsonrpc: "2.0", id: 1, method: "tools/list" };
    const [, without] = running_task(s);
    assert.equal((await post(entry(s, without, "desktop"), msg)).status, 404);
    const [, with_it] = running_task(s, { desktop: true });
    const res = await post(entry(s, with_it, "desktop"), msg, "application/json");
    assert.equal(res.status, 200);
    const body: any = await res.json();
    assert.ok(body.result.tools.some((t: any) => t.name === "act"));
  } finally {
    server.close();
  }
});
