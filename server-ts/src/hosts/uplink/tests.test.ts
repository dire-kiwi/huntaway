// Port of server/src/hosts/uplink/tests.rs (HA-120, on the HA-117 branch).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as db from "../../db.ts";
import type { Task } from "../../db.ts";
import type { AppState } from "../../state.ts";
import { CreateTask_default, create_scratch_task_inner, create_task_inner } from "../../api/new_task.ts";
import * as assistant from "../../agent/assistant.ts";
import * as hub from "../hub.ts";
import type { ToolCall } from "../proto.ts";
import { handle_mcp, handle_up_call } from "../../mcp/tools.ts";
import { hubs, register } from "../uplink.ts";
import { call_api as api, follow, link_by_url, node, on_end, serve, until } from "./testing.ts";

// A run's launch fails rather than starting a real `claude`.
process.env.IA_SHIM_BIN = "/nonexistent/ia-shim";
process.env.IA_CLAUDE_BIN = "/nonexistent/claude";
process.env.IA_CODEX_BIN = "/nonexistent/codex";

function project(s: AppState, profile: db.Profile, id: string, key: string) {
  db.insert_project(s.db(), { id, profile_id: profile.id, name: id, key, repo_path: "/x", scratch_path: "/s", worktrees_root: "/w", base_branch: null, use_worktrees: false });
}

function task(s: AppState, project: string, title: string): Task {
  return create_task_inner(s, project, { ...CreateTask_default(), title, use_worktree: false });
}

type Result = { ok: any } | { err: string };

/** Rust's `Result<Value, String>`, from a call that throws its error. */
async function result(p: Promise<any>): Promise<Result> {
  try {
    return { ok: await p };
  } catch (e) {
    return { err: e instanceof Error ? e.message : String(e) };
  }
}

function ok(r: Result): any {
  assert.ok("ok" in r, `expected a result, got ${JSON.stringify(r)}`);
  return r.ok;
}

function err(r: Result): string {
  assert.ok("err" in r, `expected an error, got ${JSON.stringify(r)}`);
  return r.err;
}

/** An agent's tool call on `s`, from `run`. */
function agent_call(s: AppState, run: db.Run, call_id: string, tool: string, args: any): Promise<Result> {
  return result(handle_mcp(s, { run_id: run.id, call_id, tool, args, task_fields: true }));
}

interface Boards {
  hub: AppState;
  host: AppState;
  /** A run of the assistant on the host, whose calls these are. */
  run: db.Run;
  hub_task: Task;
  work_task: Task;
}

/** A hub with a personal and a work board, and a host (the assistant's) with a personal profile. */
function boards(): Boards {
  const [hub_s, host] = [node("hub", "desktop"), node("host", "homeserver")];
  const personal = db.insert_profile(hub_s.db(), "personal", [], null);
  // Its assistant runs on the host, so the host's agents in personal may use the hub's board.
  db.update_profile(hub_s.db(), personal.id, [["assistant_host", "host"]]);
  const work = db.insert_profile(hub_s.db(), "work", [], null);
  project(hub_s, personal, "hub-p", "HUB");
  project(hub_s, work, "hub-w", "WRK");
  const hub_task = task(hub_s, "hub-p", "On the hub");
  const work_task = task(hub_s, "hub-w", "Work only");
  const mine = db.insert_profile(host.db(), "personal", [], null);
  project(host, mine, "host-p", "LAP");
  task(host, "host-p", "On the host");
  const a = assistant.get_or_create(host, mine.id);
  const run = db.insert_run(host.db(), a.id, "prompt");
  return { hub: hub_s, host, run, hub_task, work_task };
}

async function let_in(hub_s: AppState, host: string, on: boolean) {
  assert.equal((await api(hub_s, "PATCH", `/api/hosts/${host}`, { uplink: on }))[0], 200);
}

const keys = (v: any): string[] => (v as any[]).map((p) => p.key).sort();

test("a_hosts_agents_use_the_hubs_board_only_when_it_lets_them", async () => {
  const b = boards();
  const { hub: hub_s, host, run } = b;
  await link_by_url(hub_s, host);
  const hosts = (await api(hub_s, "GET", "/api/hosts"))[1];
  assert.equal(hosts[1].uplink, false, JSON.stringify(hosts));

  // Off by default: not found, saying why it may be.
  let e = err(await agent_call(host, run, "c1", "get_task", { task_id: "HUB-1" }));
  assert.ok(e.startsWith("not found") && e.includes("desktop doesn't let this host's agents use its board"), e);
  assert.ok(e.includes("Let this host's agents use this board"), e);
  assert.deepEqual(keys(ok(await agent_call(host, run, "c2", "list_projects", {}))), ["LAP"]);

  await let_in(hub_s, "host", true);
  assert.equal((await api(hub_s, "GET", "/api/hosts"))[1][1].uplink, true);
  const t = ok(await agent_call(host, run, "c3", "get_task", { task_id: "HUB-1" }));
  assert.deepEqual([t.key, t.id], ["HUB-1", b.hub_task.id]);
  // By id too, and its own tasks are still its own.
  assert.equal(ok(await agent_call(host, run, "c4", "get_task", { task_id: b.hub_task.id })).key, "HUB-1");
  assert.equal(ok(await agent_call(host, run, "c5", "get_task", { task_id: "LAP-1" })).title, "On the host");
  // It creates and changes tasks there.
  const made = ok(await agent_call(host, run, "c6", "create_task", { project_id: "HUB", title: "From the assistant" }));
  assert.equal(db.get_task(hub_s.db(), made.id)?.title, "From the assistant");
  assert.equal(db.get_task(host.db(), made.id), null);
  ok(await agent_call(host, run, "c7", "update_task", { task_id: "HUB-1", title: "Renamed" }));
  assert.equal(db.get_task(hub_s.db(), b.hub_task.id)?.title, "Renamed");
  // Every board it can reach, each project once.
  assert.deepEqual(keys(ok(await agent_call(host, run, "c8", "list_projects", {}))), ["HUB", "LAP"]);
  // With `host`, the hub's board by its name.
  const listed = ok(await agent_call(host, run, "c9", "list_tasks", { project_id: "HUB", host: "desktop" }));
  assert.equal(listed.length, 2, JSON.stringify(listed));

  // The work board doesn't let personal agents in: not by key, by id, or in lists.
  for (const [i, r] of ["WRK-1", b.work_task.id].entries()) {
    e = err(await agent_call(host, run, `w${i}`, "get_task", { task_id: r }));
    assert.ok(e.startsWith("not found"), `${r}: ${e}`);
    e = err(await agent_call(host, run, `u${i}`, "update_task", { task_id: r, title: "Mine now" }));
    assert.ok(e.startsWith("not found"), `${r}: ${e}`);
    e = err(await agent_call(host, run, `s${i}`, "send_to_task", { task_id: r, message: "hi" }));
    assert.ok(e.startsWith("not found"), `${r}: ${e}`);
  }
  assert.equal(db.get_task(hub_s.db(), b.work_task.id)?.title, "Work only");
  e = err(await agent_call(host, run, "w9", "create_task", { project_id: "WRK", title: "Sneaky" }));
  assert.ok(e.startsWith("not found"), e);
  const all = ok(await agent_call(host, run, "w10", "list_tasks", { project_id: "all" }));
  assert.ok(!JSON.stringify(all).includes("Work only"), JSON.stringify(all));
  // Until it does.
  const work = db.list_profiles(hub_s.db()).find((p) => p.name === "work")!;
  db.update_profile(hub_s.db(), work.id, [["agent_access", ["personal"]]]);
  assert.equal(ok(await agent_call(host, run, "w11", "get_task", { task_id: "work:WRK-1" })).title, "Work only");

  // Switched off again, it's refused at once.
  await let_in(hub_s, "host", false);
  e = err(await agent_call(host, run, "c10", "get_task", { task_id: "HUB-1" }));
  assert.ok(e.includes("doesn't let this host's agents use its board"), e);
});

test("calls_up_a_link_run_once_and_never_go_back_down_or_up", async () => {
  const b = boards();
  const { hub: hub_s, host } = b;
  await link_by_url(hub_s, host);
  await let_in(hub_s, "host", true);
  const call = (call_id: string, tool: string, args: any): ToolCall => ({ id: 1, call_id, tool, profile: "personal", args, task_fields: true });
  const tasks = () => Number(db.value(hub_s.db(), "SELECT COUNT(*) FROM tasks"));
  // Delivered twice, at once and again after: one task.
  const before = tasks();
  const c = call("dup", "create_task", { project_id: "HUB", title: "Once" });
  const [a, b2] = await Promise.all([handle_up_call(hub_s, "host", c), handle_up_call(hub_s, "host", c)]);
  const again = await handle_up_call(hub_s, "host", c);
  assert.deepEqual([a.id, b2.id], [again.id, again.id]);
  assert.equal(tasks(), before + 1);
  // The same call id from another host is another call.
  const other = await handle_up_call(hub_s, "elsewhere", c);
  assert.notEqual(other.id, again.id);
  assert.equal(tasks(), before + 2);

  // The host's own task isn't looked for back on the host (hub → host → hub would go round).
  let e = err(await result(handle_up_call(hub_s, "host", call("back", "get_task", { task_id: "LAP-1" }))));
  assert.ok(e.startsWith("not found"), e);
  // Nor are its lists asked of it again.
  const listed = await handle_up_call(hub_s, "host", call("list", "list_projects", {}));
  assert.ok(!JSON.stringify(listed).includes("LAP"), JSON.stringify(listed));
  // Nor does the hub pass it up a link of its own.
  assert.equal(hub_s.uplinks.size, 0);
  // Tools for the agent's own thread stay on its own host.
  for (const tool of ["wait", "request_user_input", "permission_prompt", "submit_review"]) {
    e = err(await result(handle_up_call(hub_s, "host", call(`t-${tool}`, tool, {}))));
    assert.equal(e, `${tool} only works on the host the agent runs on`);
  }
  // A profile the hub doesn't have, which nothing there lets in.
  const stranger = { ...call("x", "list_projects", {}), profile: "stranger" };
  assert.ok(err(await result(handle_up_call(hub_s, "host", stranger))).startsWith("not found"));
});

test("a_host_that_dials_in_takes_the_hub_as_an_up_link_too", async () => {
  const b = boards();
  const { hub: hub_s, host, run } = b;
  const url = await serve(hub_s);
  await serve(host);
  on_end(hub.dial_out(host, url, "hub-hub"));
  await until("the host to dial in", () => hub.find_link(hub_s, "host"));
  await until("the up-link", () => host.uplinks.get("hub"));
  const e = err(await agent_call(host, run, "c1", "get_task", { task_id: "HUB-1" }));
  assert.ok(e.includes("doesn't let this host's agents use its board"), e);
  await let_in(hub_s, "host", true);
  assert.equal(ok(await agent_call(host, run, "c2", "get_task", { task_id: "HUB-1" })).title, "On the hub");
});

test("a_hub_the_host_links_itself_is_asked_the_usual_way_not_up_the_link", async () => {
  const b = boards();
  const { hub: hub_s, host } = b;
  await link_by_url(hub_s, host);
  assert.equal(hubs(host).length, 1);
  // The host links the hub as well: its board is asked over that link, with the hub's token.
  const url = await serve(hub_s);
  follow(host, db.upsert_link(host.db(), "hub", "desktop", "outbound", url, hub_s.token));
  await until("the host's link to the hub", () => hub.find_link(host, "hub"));
  assert.equal(hubs(host).length, 0);
});

test("an_up_link_goes_with_its_connection", async () => {
  const s = node("host", "homeserver");
  const [first, calls] = register(s, "hub", "desktop");
  const sent: ToolCall[] = [];
  calls.recv((c) => c && sent.push(c));
  // A call waiting for its answer when the connection goes fails, rather than waiting on.
  const pending = first.link.call("c1", "get_task", "personal", {}, true);
  const c = await until("the call", () => sent[0]);
  assert.deepEqual([c.call_id, c.tool, c.profile], ["c1", "get_task", "personal"]);
  // The hub connecting again takes its place; the old one going then leaves the new one.
  const [second] = register(s, "hub", "desktop");
  first.drop();
  // It may have run there all the same.
  const o = await pending;
  assert.ok(o.kind === "Err" && o.error.includes("may or may not have taken effect"), JSON.stringify(o));
  assert.equal(s.uplinks.get("hub"), second.link);
  second.drop();
  assert.equal(s.uplinks.size, 0);
});

// HA-120 review: the host names the caller's profile, and whoever controls it (an agent that reads its token, say) can
// name any. The hub took the name on trust, so a host-side profile called work had the hub's work board.
test("only_the_profiles_whose_assistant_runs_on_a_host_use_the_hub_from_it", async () => {
  const b = boards();
  const { hub: hub_s, host } = b;
  await link_by_url(hub_s, host);
  await let_in(hub_s, "host", true);
  // A work profile made on the host, with a run of its own.
  const work = db.insert_profile(host.db(), "work", [], null);
  const sneaky = create_scratch_task_inner(host, work.id, { ...CreateTask_default(), title: "Sneaky" });
  const run = db.insert_run(host.db(), sneaky.id, "prompt");
  const attempts: Array<[string, any]> = [
    ["get_task", { task_id: "WRK-1" }],
    ["get_task", { task_id: b.work_task.id }],
    ["send_to_task", { task_id: "WRK-1", message: "hi" }],
    ["create_task", { project_id: "WRK", title: "Planted" }],
  ];
  for (const [i, [tool, args]] of attempts.entries()) {
    const e = err(await agent_call(host, run, `w${i}`, tool, args));
    assert.ok(e.startsWith("not found") && e.includes("only in the profiles whose assistant runs on homeserver, and work isn't one"), `${tool}: ${e}`);
  }
  const listed = JSON.stringify(ok(await agent_call(host, run, "w9", "list_projects", {})));
  assert.ok(!listed.includes("WRK") && !listed.includes("HUB"), listed);
  assert.equal(Number(db.value(hub_s.db(), "SELECT COUNT(*) FROM tasks WHERE title='Planted'")), 0);
  // Nor is a profile of the right name whose assistant runs elsewhere (or on the hub) let in.
  const personal = db.list_profiles(hub_s.db()).find((p) => p.name === "personal")!;
  db.update_profile(hub_s.db(), personal.id, [["assistant_host", null]]);
  const e = err(await agent_call(host, b.run, "p1", "get_task", { task_id: "HUB-1" }));
  assert.ok(e.includes("personal isn't one"), e);
  // Placed there, it is, and only it: work stays out.
  db.update_profile(hub_s.db(), personal.id, [["assistant_host", "host"]]);
  assert.equal(ok(await agent_call(host, b.run, "p2", "get_task", { task_id: "HUB-1" })).key, "HUB-1");
  assert.ok("err" in (await agent_call(host, run, "w10", "get_task", { task_id: "WRK-1" })));
});
