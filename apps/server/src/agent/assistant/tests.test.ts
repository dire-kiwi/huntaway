// Port of server/src/agent/assistant/tests.rs (HA-119 and HA-120, on the HA-117 branch).
import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { existsSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import * as db from "../../db.ts";
import type { AppState } from "../../state.ts";
import * as testing from "../../testing.ts";
import { path_str } from "../../util.ts";
import { dispatch, makeReq, router } from "../../api.ts";
import { CreateTask_default, create_scratch_task_inner } from "../../api/new_task.ts";
import { delete_task_inner, update_task_inner } from "../../api/tasks.ts";
import * as runner from "../runner.ts";
import * as runs from "../runs.ts";
import * as documents from "../documents.ts";
import { ASSISTANT_HOST_API, get_or_create, work_dir } from "../assistant.ts";
import { createServer } from "node:http";
import { readBody } from "../../http.ts";
import { API_VERSION } from "../../hosts/proto.ts";
import { link_http } from "../../hosts/hub.ts";
import * as up from "../../hosts/uplink/testing.ts";

const state = testing.state;

// A run's launch fails rather than starting a real `claude`.
process.env.IA_SHIM_BIN = "/nonexistent/ia-shim";
process.env.IA_CLAUDE_BIN = "/nonexistent/claude";
process.env.IA_CODEX_BIN = "/nonexistent/codex";

function count(s: AppState, profile_id: string): number {
  return Number(db.value(s.db(), "SELECT COUNT(*) FROM tasks WHERE profile_id=?1 AND task_type='assistant'", profile_id));
}

/** Status and body of a request to the API. */
async function call(s: AppState, method: string, path: string, body?: any): Promise<[number, any]> {
  if (!s.local_router) router(s);
  const headers: Record<string, string> = { authorization: "Bearer " };
  if (body !== undefined) headers["content-type"] = "application/json";
  const a = await dispatch(s, makeReq(method, path, headers, body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body))));
  const text = a.body.toString("utf8");
  try {
    return [a.status, JSON.parse(text)];
  } catch {
    return [a.status, text];
  }
}

const is_dir = (p: string) => existsSync(p) && statSync(p).isDirectory();

test("a_profiles_assistant_is_made_once_on_first_open", () => {
  const s = state();
  const p = db.insert_profile(s.db(), "personal", [], null);
  const a = get_or_create(s, p.id);
  assert.deepEqual([db.is_assistant(a), db.is_scratch(a), a.project_id, a.number, a.status], [true, false, null, 1, "todo"]);
  assert.deepEqual([a.title, a.title_pinned, a.use_worktree], ["Assistant", true, false]);
  assert.equal(runner.task_key_prefix(s, a), "A");
  // Its workspace is in the data dir, by its id, and made with it.
  assert.equal(a.work_dir, `assistants/${a.id}`);
  const dir = documents.work_dir(s, a)!;
  assert.equal(dir, join(s.data_dir, "assistants", a.id));
  assert.ok(is_dir(dir));
  assert.equal(runner.work_dir(s, a), dir);
  assert.ok(!documents.documents_only(a));
  // Opening it again gives the same one, and makes its folder again if it went.
  rmSync(dir, { recursive: true });
  assert.equal(get_or_create(s, p.id).id, a.id);
  assert.ok(is_dir(dir));
  assert.equal(count(s, p.id), 1);
  // Another profile has one of its own, also A-1.
  const work = db.insert_profile(s.db(), "work", [], null);
  const b = get_or_create(s, work.id);
  assert.notEqual(b.id, a.id);
  assert.deepEqual([b.number, b.profile_id], [1, work.id]);
  assert.throws(() => get_or_create(s, "nope"));
});

test("a_profile_has_one_assistant_at_most", async () => {
  const s = state();
  const p = db.insert_profile(s.db(), "personal", [], null);
  const a = get_or_create(s, p.id);
  const fresh: db.NewTask = { profile_id: p.id, project_id: null, kind: "task", title: "x", description: "", status: "todo", use_worktree: false };
  // The database refuses a second, and the failed insert leaves nothing behind.
  const tasks = () => Number(db.value(s.db(), "SELECT COUNT(*) FROM tasks"));
  const before = tasks();
  assert.throws(() => db.insert_assistant_task(s.db(), fresh, work_dir));
  assert.equal(tasks(), before);
  // Nor can a task become one, as its type isn't one a task can be given.
  assert.throws(() => create_scratch_task_inner(s, p.id, { ...CreateTask_default(), task_type: "assistant" }));
  // Once it's deleted, the next open makes another, numbered after it.
  await delete_task_inner(s, a, false);
  const b = get_or_create(s, p.id);
  assert.notEqual(b.id, a.id);
  assert.equal(count(s, p.id), 1);
});

test("first_opens_at_once_make_one_assistant", async () => {
  const s = state();
  const p = db.insert_profile(s.db(), "personal", [], null);
  const opens = await Promise.all(Array.from({ length: 8 }, () => call(s, "GET", `/api/profiles/${p.id}/assistant`)));
  assert.deepEqual(new Set(opens.map(([status, t]) => `${status} ${t.id}`)).size, 1);
  assert.equal(opens[0][0], 200);
  assert.equal(count(s, p.id), 1);
});

test("the_assistant_is_off_the_board_unless_asked_for", async () => {
  const s = state();
  const p = db.insert_profile(s.db(), "personal", [], null);
  const scratch = create_scratch_task_inner(s, p.id, CreateTask_default());
  const a = get_or_create(s, p.id);
  const ids = (l: db.Task[]) => l.map((t) => t.id);
  // The board's tasks in no project (group and scratch tasks).
  assert.deepEqual(ids(db.list_group_tasks(s.db(), p.id, false)), [scratch.id]);
  assert.deepEqual(ids(db.list_group_tasks(s.db(), p.id, true)), [scratch.id, a.id]);
  assert.deepEqual(ids(db.list_tasks_for_profile(s.db(), p.id, false)), [scratch.id]);
  assert.equal(db.list_tasks_for_profile(s.db(), p.id, true).length, 2);
  // Over the API.
  let [status, list] = await call(s, "GET", `/api/profiles/${p.id}/tasks`);
  assert.deepEqual([status, list.length], [200, 1]);
  [, list] = await call(s, "GET", `/api/profiles/${p.id}/tasks?include_assistant=true`);
  assert.equal(list.length, 2);
  [, list] = await call(s, "GET", `/api/profiles/${p.id}/group-tasks`);
  assert.deepEqual(list.map((t: any) => t.id), [scratch.id]);
  [, list] = await call(s, "GET", `/api/profiles/${p.id}/group-tasks?include_assistant=true`);
  assert.equal(list.length, 2);
  const [got_status, got] = await call(s, "GET", `/api/profiles/${p.id}/assistant`);
  assert.deepEqual([got_status, got.id, got.task_type], [200, a.id, "assistant"]);
  assert.equal((await call(s, "GET", "/api/profiles/nope/assistant"))[0], 404);
});

test("a_message_to_the_profiles_assistant_goes_to_its_thread", async () => {
  runs.TEST_CAN_RUN.set(true);
  try {
    const s = state();
    const p = db.insert_profile(s.db(), "personal", [], null);
    // Made by the first message, if it has none yet, which starts its agent.
    const [status, t] = await call(s, "POST", `/api/profiles/${p.id}/assistant`, { text: "What's on today?" });
    assert.equal(status, 200, JSON.stringify(t));
    assert.deepEqual([t.task_type, t.status], ["assistant", "in_progress"]);
    assert.equal(count(s, p.id), 1);
    assert.equal((await call(s, "GET", `/api/profiles/${p.id}/assistant`))[1].id, t.id);
    assert.equal((await call(s, "POST", "/api/profiles/nope/assistant", { text: "Hi" }))[0], 404);
  } finally {
    runs.TEST_CAN_RUN.set(false);
  }
});

test("the_assistant_never_goes_to_review_or_merge", async () => {
  const s = state();
  const p = db.insert_profile(s.db(), "personal", [], null);
  const a = get_or_create(s, p.id);
  for (const status of ["in_review", "ready_for_merge", "done", "backlog"]) {
    await assert.rejects(update_task_inner(s, a.id, { status }), (e: any) => e?.status === 400, status);
  }
  for (const field of ["use_worktree", "subproject"]) {
    await assert.rejects(update_task_inner(s, a.id, { [field]: true }), field);
  }
  const t = await update_task_inner(s, a.id, { status: "needs_attention", starred: true });
  assert.deepEqual([t.status, t.starred], ["needs_attention", true]);
});

test("the_assistant_writes_its_workspace_without_asking", () => {
  const s = state();
  const p = db.insert_profile(s.db(), "personal", [], null);
  const a = get_or_create(s, p.id);
  const dir = documents.work_dir(s, a)!;
  const write = (f: string) => documents.writes_own_folder(s, a, "Write", { file_path: f });
  assert.ok(write(join(dir, "MEMORY.md")));
  assert.ok(write(join(dir, "memory", "2026-11-03.md")));
  assert.ok(!write(join(s.data_dir, "huntaway.db")));
  assert.ok(!write(`${dir}/../x`));
  // A scratch task still writes only its own folder.
  const t = create_scratch_task_inner(s, p.id, CreateTask_default());
  assert.ok(!documents.writes_own_folder(s, t, "Write", { file_path: join(dir, "MEMORY.md") }));
});

test("no_project_can_have_the_assistants_key", async () => {
  const s = state();
  const p = db.insert_profile(s.db(), "personal", [], null);
  const [status, v] = await call(s, "POST", `/api/profiles/${p.id}/projects`, { name: "Apps", key: "A", repo_path: path_str(testing.temp_dir()) });
  assert.equal(status, 400, JSON.stringify(v));
  assert.ok(v.error.includes("the assistant"), JSON.stringify(v));
});

test("a_database_at_version_89_frees_the_key_a", () => {
  const path = join(testing.temp_dir(), "huntaway.db");
  {
    const c = db.open(path);
    const p = db.insert_profile(c, "p", [], null);
    db.insert_project(c, { id: "apps", profile_id: p.id, name: "Apps", key: "A", repo_path: "/x", scratch_path: "/s", worktrees_root: "/w", base_branch: null, use_worktrees: false });
    c.exec("DROP INDEX tasks_one_assistant; PRAGMA user_version=89;");
    c.close();
  }
  const c = db.open(path);
  assert.equal(db.get_project(c, "apps")!.key, "AP");
  assert.equal(Number(db.value(c, "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='tasks_one_assistant'")), 1);
  c.close();
});

// HA-204: a database from before assistant hosts keeps its profiles and links, which get no assistant host and don't
// let their hosts' agents in.
test("a_database_at_version_91_gets_assistant_hosts_and_up_links_off", () => {
  const path = join(testing.temp_dir(), "huntaway.db");
  let id: string;
  {
    const c = db.open(path);
    id = db.insert_profile(c, "personal", [], null).id;
    db.upsert_link(c, "home", "homeserver", "ssh", null, null);
    c.exec("ALTER TABLE profiles DROP COLUMN assistant_host; ALTER TABLE links DROP COLUMN uplink; PRAGMA user_version=91;");
    c.close();
  }
  const c = db.open(path);
  assert.equal(Number(db.value(c, "PRAGMA user_version")), db.VERSION);
  assert.equal(db.get_profile(c, id)?.assistant_host, null);
  assert.deepEqual([db.get_link(c, "home")?.name, db.get_link(c, "home")?.uplink], ["homeserver", false]);
  c.close();
  // Opened again (as by a build that had added them as another version), nothing changes.
  const again = db.open(path);
  again.exec("PRAGMA user_version=91;");
  again.close();
  assert.equal(db.get_link(db.open(path), "home")?.uplink, false);
});

test("an_assistant_host_must_be_a_linked_host_with_assistants", async () => {
  const [hub_s, host] = [up.node("hub", "desktop"), up.node("host", "homeserver")];
  const p = db.insert_profile(hub_s.db(), "personal", [], null);
  await up.link_by_url(hub_s, host);
  // A host with assistants but from before assistant hosts, which is connected, so it can tell.
  link_http(hub_s, "old", "http://127.0.0.1:9", ASSISTANT_HOST_API - 1);
  db.upsert_link(hub_s.db(), "old", "old", "outbound", "http://x", null);
  const path = `/api/profiles/${p.id}`;
  const set = (v: any) => up.call_api(hub_s, "PATCH", path, { assistant_host: v });
  for (const [bad, why] of [["nope", "must be a linked host"], [5, "must be a linked host's id or null"], ["old", "older build that can't be an assistant host"]] as const) {
    const [status, v] = await set(bad);
    assert.equal(status, 400, String(bad));
    assert.ok(v.error.includes(why), `${bad}: ${JSON.stringify(v)}`);
  }
  assert.equal((await set("host"))[1].assistant_host, "host");
  // Unchanged by a save that doesn't send it, as from an older UI.
  assert.equal((await up.call_api(hub_s, "PATCH", path, { default_model: "haiku" }))[1].assistant_host, "host");
  // This host is the same as none.
  for (const none of ["hub", "", null]) {
    assert.equal((await set("host"))[0], 200);
    assert.equal((await set(none))[1].assistant_host, null, String(none));
  }
  // An offline host can't say, so it's taken.
  hub_s.links.delete("old");
  assert.equal((await set("old"))[1].assistant_host, "old");
  // Or given when the profile's made.
  const [status, made] = await up.call_api(hub_s, "POST", "/api/profiles", { name: "other", assistant_host: "host" });
  assert.deepEqual([status, made.assistant_host], [200, "host"]);
  assert.equal((await up.call_api(hub_s, "POST", "/api/profiles", { name: "third", assistant_host: "nope" }))[0], 400);
  assert.ok(db.list_profiles(hub_s.db()).every((x) => x.name !== "third"));
  // Removing the host takes it off the profiles that named it.
  assert.equal((await up.call_api(hub_s, "DELETE", "/api/hosts/host"))[0], 200);
  assert.ok(db.list_profiles(hub_s.db()).every((x) => x.assistant_host !== "host"));
  assert.equal(db.get_profile(hub_s.db(), p.id)?.assistant_host, "old");
});

test("the_hub_sends_a_profiles_assistant_to_its_host", async () => {
  const [hub_s, host] = [up.node("hub", "desktop"), up.node("host", "homeserver")];
  const p = db.insert_profile(hub_s.db(), "personal", [], null);
  await up.link_by_url(hub_s, host);
  db.update_profile(hub_s.db(), p.id, [["assistant_host", "host"]]);
  const path = `/api/profiles/${p.id}/assistant`;
  // The host has no personal profile yet.
  let [status, v] = await up.call_api(hub_s, "GET", path);
  assert.equal(status, 409);
  assert.ok(v.error.includes("homeserver has no profile named personal"), JSON.stringify(v));
  const there = db.insert_profile(host.db(), "personal", [], null);
  // Its own profile's, on that host, which says so; none is made on the hub.
  const [st, a] = await up.call_api(hub_s, "GET", path);
  assert.deepEqual([st, a.host_id, a.task_type], [200, "host", "assistant"]);
  assert.equal(db.assistant_task(host.db(), there.id)?.id, a.id);
  assert.equal(count(hub_s, p.id), 0);
  // Through the hub's proxy, as a client that's told the host goes on to the task there.
  const [st2, t] = await up.call_api(hub_s, "GET", `/api/h/host/tasks/${a.id}`);
  assert.deepEqual([st2, t.task.id], [200, a.id]);
  // Without the setting, it's the hub's own.
  db.update_profile(hub_s.db(), p.id, [["assistant_host", null]]);
  const own = (await up.call_api(hub_s, "GET", path))[1];
  assert.deepEqual([own.host_id, count(hub_s, p.id)], ["hub", 1]);
  // A host's profile that names the hub as its assistant's host doesn't send a routed request back.
  db.upsert_link(host.db(), "hub", "desktop", "outbound", "http://x", null);
  db.update_profile(host.db(), there.id, [["assistant_host", "hub"]]);
  db.update_profile(hub_s.db(), p.id, [["assistant_host", "host"]]);
  const [st3, a2] = await up.call_api(hub_s, "GET", path);
  assert.deepEqual([st3, a2.id], [200, a.id]);
  // Offline: says so, rather than making one here.
  hub_s.links.delete("host");
  [status, v] = await up.call_api(hub_s, "GET", path);
  assert.equal(status, 503);
  assert.equal(v.error, "personal's assistant runs on homeserver, which is offline");
  assert.equal((await up.call_api(hub_s, "POST", path, { text: "hello" }))[0], 503);
  assert.equal(count(hub_s, p.id), 1);
});

test("a_message_to_the_assistant_goes_to_its_host", async () => {
  const hub_s = up.node("hub", "desktop");
  const p = db.insert_profile(hub_s.db(), "personal", [], null);
  // A host that records what it's sent rather than starting an agent.
  const sent: Array<[string, any]> = [];
  const srv = createServer(async (req, res) => {
    const body = await readBody(req, 1 << 20);
    const json = (v: any) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(v));
    if (req.method === "GET" && req.url === "/api/profiles") return json([{ id: "pp", name: "personal" }]);
    if (req.method === "POST" && req.url?.startsWith("/api/profiles/pp/assistant")) {
      sent.push([req.url, JSON.parse(body.toString())]);
      return json({ id: "a1", task_type: "assistant" });
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  up.on_end(() => {
    srv.closeAllConnections();
    srv.close();
  });
  link_http(hub_s, "host", `http://127.0.0.1:${(srv.address() as any).port}`, API_VERSION);
  db.upsert_link(hub_s.db(), "host", "homeserver", "outbound", "http://x", null);
  db.update_profile(hub_s.db(), p.id, [["assistant_host", "host"]]);
  const [status, t] = await up.call_api(hub_s, "POST", `/api/profiles/${p.id}/assistant`, { text: "Remind me at 5" });
  assert.deepEqual([status, t.id, t.host_id], [200, "a1", "host"]);
  assert.deepEqual(sent, [["/api/profiles/pp/assistant?local=1", { text: "Remind me at 5" }]]);
});
