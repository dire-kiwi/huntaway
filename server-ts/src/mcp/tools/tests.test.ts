// Port of server/src/mcp/tools/tests.rs.
//
// Rust's tests cut a call short with a timeout, which drops its future. A promise can't be dropped, so here
// `cut_short` does what a restart does to a call waiting for the user: it forgets the call (calls_inflight) and its
// waiter (perm_waiters), leaving it to wait for good, and the retry finds it recorded as executing.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import * as db from "../../db.ts";
import type { Task } from "../../db.ts";
import type { Shared } from "../../state.ts";
import * as api from "../../api.ts";
import * as au from "../../integrations/automations.ts";
import * as wf from "../../integrations/workflows.ts";
import * as runner from "../../agent/runner.ts";
import * as assistant from "../../agent/assistant.ts";
import * as approval_rules from "../../agent/approval_rules.ts";
import type { Decision } from "../../agent/approval_rules.ts";
import * as runs from "../../agent/runs.ts";
import * as prompts from "../../agent/prompts.ts";
import * as worktree from "../../git/worktree.ts";
import * as pr_watch from "../pr_watch.ts";
import * as permissions from "../permissions.ts";
import * as testing from "../../testing.ts";
import * as hub from "../../hosts/hub.ts";
import { readBody } from "../../http.ts";
import { now, path_str, sleep } from "../../util.ts";
import { ToolError, msg, type Ctx } from "../tools.ts";
import { MARKS_API, TASK_FIELDS_API, TASK_FIELD_DEFAULT_LIMIT, TASK_FIELD_MAX_LIMIT, dispatch, handle_mcp, handle_remote, needs_project_settings_api, too_old, type McpCall } from "./dispatch.ts";
import { local } from "./local.ts";
import { reminder_time, task_field, task_overview } from "./tasks.ts";

const state = testing.state;

function project(s: Shared, profile: db.Profile, id: string, key: string) {
  db.insert_project(s.db(), {
    id,
    profile_id: profile.id,
    name: id,
    key,
    repo_path: "/x",
    scratch_path: "/s",
    worktrees_root: "/w",
    base_branch: null,
    use_worktrees: false,
  });
}

/** `CreateTask::default()`. */
function create_task(fields: Record<string, any>): any {
  return {
    title: "",
    description: "",
    status: null,
    resolution: null,
    use_worktree: null,
    model: null,
    effort: null,
    kind: null,
    start: null,
    parent_id: null,
    subproject: null,
    claude_config_id: null,
    depends_on: null,
    task_type: null,
    labels: null,
    external_links: null,
    fanout_id: null,
    start_from: null,
    ...fields,
  };
}

function task(s: Shared, project: string, title: string): Task {
  return api.create_task_inner(s, project, create_task({ title, use_worktree: false }));
}

function new_task(p: db.Profile, title: string, fields: Record<string, any> = {}): any {
  return {
    profile_id: p.id,
    project_id: null,
    kind: "task",
    title,
    description: "",
    status: "todo",
    use_worktree: false,
    model: null,
    effort: null,
    claude_config_id: null,
    ...fields,
  };
}

function grant(s: Shared, p: db.Profile, names: string[]) {
  db.update_profile(s.db(), p.id, [["agent_access", names]]);
}

/** A run of `task_id` that holds its thread, as a started one does (see runner::start_run). */
function started_run(s: Shared, task_id: string): db.Run {
  const run = db.insert_run(s.db(), task_id, "prompt");
  s.runs.set(task_id, { run_id: run.id, cancel: null });
  return run;
}

function ctx(p: db.Profile, more: Partial<Ctx> = {}): Ctx {
  return { profile_id: p.id, profile_name: p.name, task: null, call_id: null, task_fields: true, ...more };
}

async function call(s: Shared, ctx: Ctx, tool: string, args: any): Promise<any> {
  try {
    return await local(s, ctx, tool, args);
  } catch (e) {
    throw new Error(msg(e));
  }
}

/** The message of the error `p` fails with (Rust's `unwrap_err`). */
async function err(p: Promise<any>): Promise<string> {
  try {
    const v = await p;
    assert.fail(`it didn't fail: ${JSON.stringify(v)}`);
  } catch (e: any) {
    if (e?.code === "ERR_ASSERTION") throw e;
    return e instanceof Error ? e.message : String(e);
  }
}

/** Whether `p` fails. */
async function fails(p: Promise<any>): Promise<boolean> {
  try {
    await p;
    return false;
  } catch {
    return true;
  }
}

/** `p`'s outcome, without throwing (for a `tokio::join!`). */
async function settle<T>(p: Promise<T>): Promise<{ ok: T } | { err: string }> {
  try {
    return { ok: await p };
  } catch (e) {
    return { err: e instanceof Error ? e.message : String(e) };
  }
}
const unwrap = (r: { ok: any } | { err: string }): any => {
  if ("err" in r) assert.fail(`failed: ${r.err}`);
  return r.ok;
};
const unwrap_err = (r: { ok: any } | { err: string }): string => {
  if ("ok" in r) assert.fail(`didn't fail: ${JSON.stringify(r.ok)}`);
  return r.err;
};

function keys(v: any, field: string): string[] {
  return v.map((p: any) => `${p.profile}:${p[field]}`);
}

async function post_tool(s: Shared, path: string, body: any): Promise<any> {
  if (!s.local_router) api.router(s);
  const [status, result] = await api.local_request(s, "POST", path, Buffer.from(JSON.stringify(body)));
  assert.equal(status, 200);
  assert.equal(result.error, undefined, JSON.stringify(result));
  return result.result;
}

const count = (s: Shared, sql: string, ...ps: any[]) => db.value<number>(s.db(), sql, ...ps) ?? 0;
const char_count = (s: string) => Array.from(s).length;

/** Wait for `f` to hold, for a few seconds at most. */
async function until(f: () => boolean, what = "a condition") {
  const deadline = Date.now() + 10_000;
  while (!f()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

test("agents_say_what_a_task_starts_from", async () => {
  const s = state();
  const p = db.insert_profile(s.db(), "personal", [], null);
  project(s, p, "web", "WEB");
  const me = ctx(p);
  const first = await call(s, me, "create_task", { title: "First", project_id: "WEB", use_worktree: true });
  assert.equal(first.start_from, undefined);
  let t = await call(s, me, "create_task", { title: "On top", project_id: "WEB", use_worktree: true, start_from: "web-1" });
  assert.equal(t.start_from, "task WEB-1");
  const made = db.get_task(s.db(), t.id)!;
  assert.deepEqual(made.start_from, { type: "task", task_id: first.id });
  t = await call(s, me, "update_task", { task_id: "WEB-2", start_from: "https://github.com/o/web/pull/7" });
  assert.equal(t.start_from, "pull request o/web#7");
  t = await call(s, me, "update_task", { task_id: "WEB-2", start_from: "" });
  assert.equal(t.start_from, undefined);
  // Not for a task without a worktree.
  const e = await err(call(s, me, "create_task", { title: "Here", project_id: "WEB", start_from: "dev" }));
  assert.ok(e.includes("start_from is for a task with a worktree"), e);
});

test("legacy_helper_keeps_full_details_after_server_upgrade", async () => {
  const s = state();
  const p = db.insert_profile(s.db(), "personal", [], null);
  project(s, p, "ia", "IA");
  const t = task(s, "ia", "Existing thread");
  const description = "Description ā🙂\n".repeat(160);
  const review = { ...db.Review_default(), state: "issues", summary: "Review\n".repeat(400) };
  db.update_task(s.db(), t.id, [["description", description], ["review", review]]);
  const run = db.insert_run(s.db(), t.id, "prompt");
  // An already-running helper keeps its API 58 schema and sends the same request shape after reconnecting to the
  // upgraded daemon. No get_task_field capability.
  const request: any = { run_id: run.id, call_id: "old-helper", tool: "get_task", args: { task_id: "IA-1" } };
  const full = await post_tool(s, "/api/internal/mcp", request);
  assert.ok(full.description === description, "legacy helper lost its description");
  assert.equal(full.review.summary, review.summary);
  assert.equal(full.omitted_fields, undefined);
  // Its retried call remains idempotent across the upgrade too.
  assert.deepEqual(await post_tool(s, "/api/internal/mcp", request), full);

  const current = { ...request, call_id: "new-helper", task_fields: true };
  const overview = await post_tool(s, "/api/internal/mcp", current);
  assert.equal(overview.description, undefined);
  assert.equal(overview.field_lengths.description, char_count(description));
  current.call_id = "new-helper-field";
  current.tool = "get_task_field";
  current.args = { task_id: "IA-1", field: "description", limit: TASK_FIELD_MAX_LIMIT };
  assert.equal((await post_tool(s, "/api/internal/mcp", current)).content, description);
});

test("legacy_host_keeps_full_details_from_upgraded_host", async () => {
  const s = state();
  const p = db.insert_profile(s.db(), "personal", [], null);
  project(s, p, "ia", "IA");
  const t = task(s, "ia", "Remote task");
  const description = "Remote description\n".repeat(160);
  db.update_task(s.db(), t.id, [["description", description]]);
  // API 58 call_tool sends only profile and args. It cannot offer or forward get_task_field, so it must receive full
  // details from an API 59 linked host.
  const request: any = { profile: "personal", args: { task_id: "IA-1" } };
  const full = await post_tool(s, "/api/tools/get_task", request);
  assert.ok(full.description === description, "API 58 caller lost its description");
  assert.equal(full.omitted_fields, undefined);

  const overview = await post_tool(s, "/api/tools/get_task", { ...request, task_fields: true });
  assert.equal(overview.description, undefined);
  assert.equal(overview.field_lengths.description, char_count(description));
  assert.deepEqual(await post_tool(s, "/api/tools/get_task", { ...request, task_fields: false }), full);
});

test("large_task_fields_are_summarized_and_can_be_reassembled", async () => {
  const s = state();
  const p = db.insert_profile(s.db(), "personal", [], null);
  project(s, p, "ia", "IA");
  const t = task(s, "ia", "A large task");
  const me = ctx(p);
  const description = "A lengthy description\n".repeat(5000);
  const message = 'Latest reply: ā🙂\n"quoted"\\\t'.repeat(4000);
  const review = { ...db.Review_default(), state: "issues", summary: "Review\n".repeat(2000), issues: ["Fix it".repeat(1000)] };
  db.update_task(s.db(), t.id, [["description", description], ["review", review]]);
  db.insert_message(s.db(), t.id, "claude", { type: "result", result: message });
  // Arrays can grow too; no unbounded review is smuggled in through created_tasks.
  const child = task(s, "ia", "Child");
  db.update_task(s.db(), child.id, [["created_by", t.id], ["review", review]]);
  const overview = await call(s, me, "get_task", { task_id: "IA-1" });
  const serialized = JSON.stringify(overview, null, 2);
  assert.ok(Buffer.byteLength(serialized) < 10000, `overview was ${serialized.length} bytes`);
  assert.deepEqual([overview.key, overview.title], ["IA-1", "A large task"]);
  for (const field of ["description", "last_message", "review", "created_tasks"]) {
    assert.equal(overview[field], undefined, `${field} was inlined`);
    assert.ok(overview.omitted_fields.includes(field));
  }
  assert.equal(overview.field_lengths.description, char_count(description));
  assert.equal(overview.field_lengths.last_message, char_count(message));
  for (const [field, expected] of [["description", description], ["last_message", message]]) {
    let offset = 0;
    let assembled = "";
    for (;;) {
      const page = await call(s, me, "get_task_field", { task_id: t.id, field, offset });
      const content: string = page.content;
      assert.equal(page.format, "text");
      assert.equal(page.total_length, overview.field_lengths[field]);
      assert.ok(char_count(content) <= TASK_FIELD_DEFAULT_LIMIT);
      assembled += content;
      if (typeof page.next_offset === "number") {
        assert.ok(page.next_offset > offset);
        offset = page.next_offset;
      } else break;
    }
    assert.equal(assembled, expected);
  }
  const page = await call(s, me, "get_task_field", { task_id: "IA-1", field: "review" });
  assert.equal(page.format, "json");
  assert.equal(page.total_length, overview.field_lengths.review);
  assert.equal(typeof page.next_offset, "number");
});

test("task_field_pages_count_characters_and_validate_ranges", async () => {
  const s = state();
  const p = db.insert_profile(s.db(), "personal", [], null);
  project(s, p, "ia", "IA");
  const t = task(s, "ia", "Small task");
  const me = ctx(p);
  db.update_task(s.db(), t.id, [["description", 'aā🙂\n"\\\u0000z']]);
  const page = (extra: any) => call(s, me, "get_task_field", { task_id: "IA-1", field: "description", ...extra });
  let v = await page({ offset: 1, limit: 3 });
  assert.deepEqual([v.content, v.length, v.total_length, v.next_offset], ["ā🙂\n", 3, 8, 4]);
  v = await page({ offset: 7, limit: TASK_FIELD_MAX_LIMIT });
  assert.equal(v.content, "z");
  assert.equal(v.next_offset, null);
  for (const offset of [8, 9, Number.MAX_SAFE_INTEGER]) {
    v = await page({ offset });
    assert.equal(v.content, "");
    assert.equal(v.length, 0);
    assert.equal(v.next_offset, null);
  }
  for (const extra of [
    { offset: -1 }, { offset: 1.5 }, { offset: "1" }, { offset: null },
    { limit: -1 }, { limit: 0 }, { limit: TASK_FIELD_MAX_LIMIT + 1 },
    { limit: 1.5 }, { limit: "1" }, { limit: null }, { field: "session_id" },
  ]) {
    assert.ok(await fails(page(extra)), `accepted ${JSON.stringify(extra)}`);
  }
  // Null, scalar and empty fields have exact lengths matching their paginated representation.
  const overview = await call(s, me, "get_task", { task_id: "IA-1" });
  assert.equal(overview.description, 'aā🙂\n"\\\u0000z');
  for (const [field, content, format] of [["last_message", "null", "json"], ["running", "false", "json"], ["title", "Small task", "text"]]) {
    v = await page({ field });
    assert.equal(v.content, content);
    assert.equal(v.format, format);
    assert.equal(overview.field_lengths[field], char_count(content));
  }
  db.update_task(s.db(), t.id, [["description", ""]]);
  v = await page({});
  assert.equal(v.total_length, 0);
  assert.equal(v.content, "");
  assert.equal(v.next_offset, null);
});

test("overview_bounds_escaped_values_and_the_total_inline_size", () => {
  const details: Record<string, string> = {};
  for (let i = 0; i < 30; i++) details[`field_${i}`] = "x".repeat(900);
  let v = task_overview(details);
  assert.ok(JSON.stringify(v, null, 2).length < 10000);
  assert.equal(Object.keys(v.field_lengths).length, 30);
  assert.ok(v.omitted_fields.length >= 24);
  // Control characters expand sixfold in JSON; characters alone aren't an output bound.
  v = task_overview({ description: "\u0000".repeat(900) });
  assert.equal(v.description, undefined);
  assert.equal(v.field_lengths.description, 900);
});

test("task_fields_use_the_same_profile_access_and_key_resolution", async () => {
  const s = state();
  const [personal, work, lab] = ["personal", "work", "lab"].map((n) => db.insert_profile(s.db(), n, [], null));
  for (const [p, id, key] of [[personal, "own", "IA"], [work, "work", "IA"], [lab, "lab", "LAB"]] as const) {
    project(s, p, id, key);
    const t = task(s, id, id);
    db.update_task(s.db(), t.id, [["description", id]]);
  }
  const me = ctx(personal);
  const get = (extra: any) => call(s, me, "get_task_field", { task_id: "IA-1", field: "description", ...extra });
  const work_id = db.list_tasks_for_project(s.db(), "work", "task")[0].id;
  assert.ok(await fails(get({ task_id: work_id })));
  assert.ok(await fails(get({ profile: "work" })));
  assert.ok(await fails(get({ task_id: "work:IA-1" })));
  grant(s, work, ["personal"]);
  assert.equal((await get({})).content, "own");
  assert.equal((await get({ profile: "work" })).content, "work");
  assert.equal((await get({ task_id: "work:ia-1" })).content, "work");
  assert.equal((await get({ task_id: work_id })).content, "work");
  // The remote entry point enforces access too, and resolves the same qualified keys.
  assert.equal((await handle_remote(s, "get_task_field", "personal", { task_id: "work:IA-1", field: "description" }, true)).content, "work");
  grant(s, work, []);
  assert.ok(await fails(handle_remote(s, "get_task_field", "personal", { task_id: work_id, field: "description" }, true)));
  assert.ok(await fails(get({ task_id: "LAB-1" })));
});

/** Fake linked hosts' servers, closed when the file's tests end. */
const servers: Array<() => void> = [];
after(() => {
  for (const f of servers.splice(0)) f();
});

/**
 * Link `s` to a fake host `name` on API `api`, which answers `POST /api/tools/{tool}` with `answer(tool, body)` (Rust's
 * `hub::link_http` with an axum router).
 */
async function link_fake_host(s: Shared, name: string, api_version: number, answer: (tool: string, body: any) => any) {
  const srv = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const m = (req.url ?? "").match(/^\/api\/tools\/([^/?]+)$/);
    if (req.method !== "POST" || !m) return void res.writeHead(404).end();
    const body = JSON.parse((await readBody(req, 1 << 20)).toString() || "null");
    let out: any;
    try {
      out = { result: answer(decodeURIComponent(m[1]), body) };
    } catch (e) {
      return void res.writeHead(500).end(String(e));
    }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(out));
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  servers.push(() => {
    srv.closeAllConnections();
    srv.close();
  });
  const conn = hub.link_http(s, name, `http://127.0.0.1:${(srv.address() as any).port}`, api_version);
  servers.push(() => conn.kind.type === "http" && conn.kind.agent.destroy());
}

test("reads_task_fields_on_new_and_legacy_linked_hosts", async () => {
  const s = state();
  const p = db.insert_profile(s.db(), "personal", [], null);
  const me = ctx(p);
  const calls: Array<[string, string, any]> = [];
  for (const [name, api_version] of [["old", TASK_FIELDS_API - 1], ["new", TASK_FIELDS_API]] as const) {
    await link_fake_host(s, name, api_version, (tool, body) => {
      calls.push([name, tool, body]);
      const details = { id: "remote", description: "ā🙂x".repeat(10000), title: "Remote task" };
      if (api_version === TASK_FIELDS_API && tool === "get_task" && body.task_fields === true) return task_overview(details);
      if (api_version === TASK_FIELDS_API && tool === "get_task_field") return task_field(details, body.args);
      if (tool === "get_task") return details;
      throw new Error(`sent ${tool} to a legacy host`);
    });
  }
  // An explicit host and fallback lookup both pass through compatibility handling.
  for (const host of ["old", "new", null]) {
    const args: any = { task_id: "work:REMOTE-1", profile: "work" };
    if (host) args.host = host;
    const overview = await dispatch(s, me, "get_task", { ...args });
    assert.equal(overview.field_lengths.description, 30000);
    assert.equal(overview.description, undefined);
    Object.assign(args, { field: "description", offset: 1, limit: 2 });
    const page = await dispatch(s, me, "get_task_field", args);
    assert.equal(page.content, "🙂x");
    assert.equal(page.next_offset, 3);
  }
  // An old helper on an upgraded calling host still needs full details from both old and upgraded destinations; the
  // forwarding host's version is not a capability.
  const legacy = ctx(p, { task_fields: false });
  for (const host of ["old", "new", null]) {
    const args: any = { task_id: "work:REMOTE-1", profile: "work" };
    if (host) args.host = host;
    const full = await dispatch(s, legacy, "get_task", args);
    assert.ok(full.description === "ā🙂x".repeat(10000), "forwarding hid legacy details");
    assert.equal(full.omitted_fields, undefined);
  }
  assert.ok(calls.some(([host, tool]) => host === "new" && tool === "get_task_field"));
  for (const [host, tool, body] of calls) {
    assert.equal(body.profile, "personal");
    assert.equal(body.args.task_id, "work:REMOTE-1");
    assert.equal(body.args.profile, "work");
    if (host === "old") {
      assert.equal(tool, "get_task");
      assert.equal(body.args.offset, undefined);
      assert.equal(body.task_fields, false);
    }
  }
});

test("leaves_archived_projects_out_of_lists", async () => {
  const s = state();
  const p = db.insert_profile(s.db(), "personal", [], null);
  project(s, p, "ia", "IA");
  project(s, p, "old", "OLD");
  task(s, "ia", "live");
  task(s, "old", "shelved");
  db.update_project(s.db(), "old", [["archived_at", "2026-01-01T00:00:00Z"]]);
  const me = ctx(p);
  assert.deepEqual(keys(await call(s, me, "list_projects", {}), "key"), ["personal:IA"]);
  assert.deepEqual(keys(await call(s, me, "list_tasks", { project_id: "all" }), "key"), ["personal:IA-1"]);
  // Still found when named, and says it's archived.
  assert.equal((await call(s, me, "get_project", { project_id: "OLD" })).archived, true);
  assert.equal((await call(s, me, "get_project", { project_id: "IA" })).archived, false);
  const e = await err(call(s, me, "create_task", { project_id: "OLD", title: "more" }));
  assert.ok(e.includes("is archived"), e);
});

test("lists_other_profiles_boards_that_let_it_in", async () => {
  const s = state();
  const [personal, work] = ["personal", "work"].map((n) => db.insert_profile(s.db(), n, [], null));
  project(s, personal, "ia", "IA");
  project(s, work, "sd", "SD");
  task(s, "sd", "deploy");
  const me = ctx(personal);
  // Opt-in: other boards are closed until they let the profile in.
  assert.deepEqual(keys(await call(s, me, "list_projects", {}), "key"), ["personal:IA"]);
  let e = await err(call(s, me, "get_task", { task_id: "SD-1" }));
  assert.ok(e.includes("task SD-1"), e);
  e = await err(call(s, me, "list_tasks", { profile: "work", project_id: "all" }));
  assert.ok(e.includes("Settings → Profiles"), e);

  grant(s, work, ["personal"]);
  assert.deepEqual(keys(await call(s, me, "list_projects", {}), "key"), ["personal:IA", "work:SD"]);
  assert.deepEqual(keys(await call(s, me, "list_projects", { profile: "work" }), "key"), ["work:SD"]);
  // 'all' is the caller's own board unless it names another (or every one).
  assert.equal((await call(s, me, "list_tasks", { project_id: "all" })).length, 0);
  assert.deepEqual(keys(await call(s, me, "list_tasks", { project_id: "all", profile: "all" }), "key"), ["work:SD-1"]);
  assert.deepEqual(keys(await call(s, me, "list_tasks", { project_id: "SD" }), "key"), ["work:SD-1"]);
  assert.equal((await call(s, me, "get_task", { task_id: "SD-1" })).title, "deploy");
  // Access is one way.
  assert.deepEqual(keys(await call(s, ctx(work), "list_projects", {}), "key"), ["work:SD"]);
  // `*` lets every profile in.
  const lab = db.insert_profile(s.db(), "lab", [], null);
  grant(s, personal, ["*"]);
  assert.deepEqual(keys(await call(s, ctx(lab), "list_projects", {}), "key"), ["personal:IA"]);
});

test("keys_used_on_several_boards_need_a_profile", async () => {
  const s = state();
  const [personal, work, lab] = ["personal", "work", "lab"].map((n) => db.insert_profile(s.db(), n, [], null));
  grant(s, work, ["personal"]);
  grant(s, lab, ["personal"]);
  project(s, personal, "ia-personal", "IA");
  project(s, work, "ia-work", "IA");
  project(s, work, "sd-work", "SD");
  project(s, lab, "sd-lab", "SD");
  for (const p of ["ia-personal", "ia-work", "sd-work", "sd-lab"]) task(s, p, p);
  const me = ctx(personal);
  const title = async (args: any) => (await call(s, me, "get_task", args)).title as string;
  // The caller's own board wins.
  assert.equal(await title({ task_id: "IA-1" }), "ia-personal");
  assert.equal(await title({ task_id: "work:IA-1" }), "ia-work");
  // On two other boards, the key must say which.
  let e = await err(title({ task_id: "SD-1" }));
  assert.ok(e.includes("work:SD-1") && e.includes("lab:SD-1"), e);
  assert.equal(await title({ task_id: "lab:SD-1" }), "sd-lab");
  assert.equal(await title({ task_id: "SD-1", profile: "work" }), "sd-work");
  // Ids need no profile.
  const id = db.list_tasks_for_project(s.db(), "sd-lab", "task")[0].id;
  assert.equal(await title({ task_id: id }), "sd-lab");
  // Projects too, by key or name.
  e = await err(call(s, me, "list_tasks", { project_id: "SD" }));
  assert.ok(e.includes("work:SD"), e);
  assert.deepEqual(keys(await call(s, me, "list_tasks", { project_id: "sd-work" }), "title"), ["work:sd-work"]);
});

test("creates_tasks_on_other_boards_under_their_profile", async () => {
  const s = state();
  const mine = db.insert_claude_config(s.db(), "personal", "~/.claude-personal", "claude");
  const theirs = db.insert_claude_config(s.db(), "work", "~/.claude-work", "claude");
  const personal = db.insert_profile(s.db(), "personal", [mine.id], null);
  const work = db.insert_profile(s.db(), "work", [theirs.id, mine.id], null);
  project(s, personal, "kiwicd", "KIW");
  project(s, work, "site-deploy", "SD");
  const caller = task(s, "kiwicd", "orchestrate");
  const me = ctx(personal, { task: caller });
  const e = await err(call(s, me, "create_task", { title: "x", project_id: "work:SD" }));
  assert.ok(e.includes("doesn't let agents in profile personal"), e);
  grant(s, work, ["personal"]);
  let t = await call(s, me, "create_task", { title: "Follow-up", project_id: "SD" });
  assert.deepEqual([t.key, t.profile], ["SD-1", "work"]);
  const made = db.get_task(s.db(), t.id)!;
  assert.equal(made.profile_id, work.id);
  assert.equal(made.claude_config_id, theirs.id);
  // Without a project the caller's own is used, and a profile alone isn't enough.
  t = await call(s, me, "create_task", { title: "Here" });
  assert.equal(t.key, "KIW-2");
  assert.ok(await fails(call(s, me, "create_task", { title: "?", profile: "work" })));
  // And it can be updated and messaged from there.
  t = await call(s, me, "update_task", { task_id: "work:SD-1", title: "Renamed" });
  assert.equal(t.title, "Renamed");
});

test("sets_dependencies_by_key", async () => {
  const s = state();
  const p = db.insert_profile(s.db(), "personal", [], null);
  project(s, p, "kiwicd", "KIW");
  project(s, p, "other", "OT");
  const me = ctx(p);
  await call(s, me, "create_task", { title: "Base", project_id: "KIW" });
  await call(s, me, "create_task", { title: "Elsewhere", project_id: "OT" });
  let t = await call(s, me, "create_task", { title: "After", project_id: "KIW", depends_on: ["KIW-1"] });
  assert.equal(t.depends_on[0].key, "KIW-1");
  assert.equal(t.depends_on[0].merged, false);
  let e = await err(call(s, me, "update_task", { task_id: "KIW-1", depends_on: ["KIW-2"] }));
  assert.ok(e.includes("already depends"), e);
  e = await err(call(s, me, "update_task", { task_id: "KIW-2", depends_on: ["OT-1"] }));
  assert.ok(e.includes("same project"), e);
  t = await call(s, me, "update_task", { task_id: "KIW-2", depends_on: [] });
  assert.equal(t.depends_on, undefined);
});

test("sets_a_pull_request", async () => {
  const s = state();
  const p = db.insert_profile(s.db(), "personal", [], null);
  project(s, p, "kiwicd", "KIW");
  const me = ctx(p);
  await call(s, me, "create_task", { title: "Base", project_id: "KIW" });
  const url = "https://github.com/dire-kiwi/kiwicd/pull/7";
  let t = await call(s, me, "update_task", { task_id: "KIW-1", pr_url: ` ${url} ` });
  assert.equal(t.pr_url, url);
  const e = await err(call(s, me, "update_task", { task_id: "KIW-1", pr_url: "#7" }));
  assert.ok(e.includes("pr_url must be"), e);
  t = await call(s, me, "update_task", { task_id: "KIW-1", pr_url: "" });
  assert.equal(t.pr_url, null);
});

test("puts_tasks_in_now_and_later", async () => {
  const s = state();
  const p = db.insert_profile(s.db(), "personal", [], null);
  project(s, p, "kiwicd", "KIW");
  const me = ctx(p);
  let t = await call(s, me, "create_task", { title: "Soon", project_id: "KIW", now: false });
  assert.equal(t.now, undefined);
  t = await call(s, me, "update_task", { task_id: "KIW-1", now: true });
  assert.equal(t.now, true);
  assert.ok(db.get_task(s.db(), t.id)!.now_at != null);
  t = await call(s, me, "update_task", { task_id: "KIW-1", now: false });
  assert.equal(t.now, undefined);
  assert.equal(db.get_task(s.db(), t.id)!.now_at, null);
  const e = await err(call(s, me, "update_task", { task_id: "KIW-1", now: "yes" }));
  assert.ok(e.includes("now must be"), e);
});

test("a_task_an_agent_creates_and_starts_is_in_now", async () => {
  runs.TEST_CAN_RUN.set(true);
  try {
    const s = state();
    const p = db.insert_profile(s.db(), "personal", [], null);
    project(s, p, "kiwicd", "KIW");
    const me = ctx(p);
    const first = await call(s, me, "create_task", { title: "First", project_id: "KIW" });
    // Started, but waiting for what it depends on, so nothing runs here: it's only that it was sent to.
    const t = await call(s, me, "create_task", { title: "Second", project_id: "KIW", depends_on: [first.id], start: true });
    const made = db.get_task(s.db(), t.id)!;
    assert.ok(made.waiting, "started");
    assert.ok(made.now_at != null);
  } finally {
    runs.TEST_CAN_RUN.set(false);
  }
});

test("created_tasks_start_in_now", async () => {
  const s = state();
  const p = db.insert_profile(s.db(), "personal", [], null);
  project(s, p, "kiwicd", "KIW");
  const me = ctx(p);
  const now_at = (t: any) => db.get_task(s.db(), t.id)!.now_at;
  let t = await call(s, me, "create_task", { title: "Default", project_id: "KIW" });
  assert.ok(now_at(t) != null);
  t = await call(s, me, "create_task", { title: "Explicit", project_id: "KIW", now: true });
  assert.ok(now_at(t) != null);
  t = await call(s, me, "create_task", { title: "Later", project_id: "KIW", now: false });
  assert.equal(now_at(t), null);
  t = await call(s, me, "create_task", { title: "Scratch", type: "scratch" });
  assert.ok(now_at(t) != null);
});

test("updating_a_task_puts_it_in_now", async () => {
  runs.TEST_CAN_RUN.set(true);
  try {
    const s = state();
    const p = db.insert_profile(s.db(), "personal", [], null);
    project(s, p, "kiwicd", "KIW");
    const me = ctx(p);
    const now_at = (id: string) => db.get_task(s.db(), id)!.now_at;
    const later = async (title: string, extra: any) => {
      const t = await call(s, me, "create_task", { title, project_id: "KIW", now: false, ...extra });
      assert.equal(now_at(t.id), null);
      return t;
    };
    const edited = await later("Edited", {});
    const kept = await later("Kept in later", {});
    const first = await later("First", {});
    // Any update puts it in Now, whoever makes it...
    await call(s, me, "update_task", { task_id: edited.id, description: "More" });
    assert.ok(now_at(edited.id) != null);
    // ...unless the same call says where it goes.
    await call(s, me, "update_task", { task_id: kept.id, description: "More", now: false });
    assert.equal(now_at(kept.id), null);
    // A message from another agent (a parent starting its subproject's tasks) too. Held for what it depends on, so nothing runs.
    const messaged = await later("Messaged", { depends_on: [first.id] });
    await call(s, me, "send_to_task", { task_id: messaged.id, message: "Go" });
    assert.ok(now_at(messaged.id) != null);
  } finally {
    runs.TEST_CAN_RUN.set(false);
  }
});

test("stars_and_sets_reminders", async () => {
  const s = state();
  const p = db.insert_profile(s.db(), "personal", [], null);
  project(s, p, "kiwicd", "KIW");
  const me = ctx(p);
  // Set as it's created, the reminder a delay from now. Times are kept to the millisecond, so less a millisecond.
  const before = Date.now() - 1;
  let t = await call(s, me, "create_task", { title: "Later", project_id: "KIW", starred: true, remind_at: "2h", reminder: " Check CI " });
  assert.deepEqual([t.starred, t.reminder], [true, "Check CI"]);
  const at = Date.parse(t.remind_at);
  const hours2 = 2 * 3600_000;
  assert.ok(at >= before + hours2 && at <= Date.now() + hours2, t.remind_at);
  // An absolute time is kept in UTC, and the note stays when only the time changes.
  t = await call(s, me, "update_task", { task_id: "KIW-1", remind_at: "2030-01-02T09:00:00+13:00", starred: false });
  assert.deepEqual([t.remind_at, t.reminder], ["2030-01-01T20:00:00.000Z", "Check CI"]);
  assert.equal(t.starred, undefined);
  let e = await err(call(s, me, "update_task", { task_id: "KIW-1", starred: "yes" }));
  assert.ok(e.includes("starred must be"), e);
  e = await err(call(s, me, "update_task", { task_id: "KIW-1", remind_at: 5 }));
  assert.ok(e.includes("remind_at must be"), e);
  e = await err(call(s, me, "update_task", { task_id: "KIW-1", remind_at: "soon" }));
  assert.ok(e.includes("remind_at must be"), e);
  // Clearing the time clears the note, and a note needs a time.
  t = await call(s, me, "update_task", { task_id: "KIW-1", remind_at: "" });
  assert.equal(t.remind_at, undefined);
  const stored = db.get_task(s.db(), t.id)!;
  assert.deepEqual([stored.remind_at, stored.reminder], [null, null]);
  e = await err(call(s, me, "update_task", { task_id: "KIW-1", reminder: "Why" }));
  assert.ok(e.includes("needs remind_at"), e);
  // A bad time doesn't leave a task behind.
  assert.ok(await fails(call(s, me, "create_task", { title: "Bad", remind_at: "whenever", project_id: "KIW" })));
  assert.equal(db.list_tasks_for_project(s.db(), "kiwicd", "task").length, 1);
});

test("a_create_task_with_bad_marks_leaves_no_task", async () => {
  const s = state();
  const p = db.insert_profile(s.db(), "personal", [], null);
  project(s, p, "kiwicd", "KIW");
  const me = ctx(p);
  const long = "x".repeat(501);
  for (const [args, why] of [
    [{ reminder: "Check CI" }, "needs remind_at"],
    [{ starred: "yes" }, "starred must be"],
    [{ remind_at: "2h", reminder: long }, "at most 500"],
    [{ remind_at: 5 }, "remind_at must be"],
    [{ remind_at: "whenever" }, "remind_at must be"],
  ] as Array<[any, string]>) {
    const full = { ...args, title: "Bad", project_id: "KIW" };
    const e = await err(call(s, me, "create_task", full));
    assert.ok(e.includes(why), `${JSON.stringify(full)}: ${e}`);
    assert.equal(db.list_tasks_for_project(s.db(), "kiwicd", "task").length, 0, `${JSON.stringify(full)} left a task`);
  }
  const t = await call(s, me, "create_task", { title: "Good", project_id: "KIW", remind_at: "1d", reminder: "Look again" });
  assert.equal(t.reminder, "Look again");
});

test("scratch_tasks_get_their_marks_too", async () => {
  const s = state();
  const p = db.insert_profile(s.db(), "personal", [], null);
  const me = ctx(p);
  const scratch = (extra: any) => ({ type: "scratch", title: "Scratch with reminder", ...extra });
  const made = await call(s, me, "create_task", scratch({ starred: true, remind_at: "2h", reminder: "Come back to this" }));
  const t = db.get_task(s.db(), made.id)!;
  assert.ok(t.starred && t.remind_at != null, JSON.stringify(t));
  assert.equal(t.reminder, "Come back to this");
  // Bad ones fail before it's made.
  const n = () => db.list_tasks_for_profile(s.db(), p.id, false).length;
  const before = n();
  for (const bad of [{ remind_at: "whenever" }, { reminder: "No time" }, { starred: "yes" }]) {
    assert.ok(await fails(call(s, me, "create_task", scratch(bad))), JSON.stringify(bad));
    assert.equal(n(), before, `${JSON.stringify(bad)} left a task`);
  }
});

test("marks_only_go_to_hosts_that_can_set_them", async () => {
  const s = state();
  const p = db.insert_profile(s.db(), "personal", [], null);
  const me = ctx(p);
  // Linked hosts that answer every tool call, and note which they were sent.
  const calls: Array<[string, string]> = [];
  for (const [name, api_version] of [["old", MARKS_API - 1], ["new", MARKS_API]] as const) {
    await link_fake_host(s, name, api_version, (tool) => {
      calls.push([name, tool]);
      return { ok: true };
    });
  }
  const sent = () => calls.splice(0);
  // Named, an older host is refused, clearing a mark too; anything else still goes.
  for (const marks of [{ remind_at: "2h" }, { starred: false }, { reminder: "" }]) {
    const e = await err(dispatch(s, me, "update_task", { ...marks, task_id: "OLD-1", host: "old" }));
    assert.ok(e.includes("old runs an older build"), `${JSON.stringify(marks)}: ${e}`);
  }
  const e = await err(dispatch(s, me, "create_task", { title: "T", host: "old", starred: true }));
  assert.ok(e.includes("older build"), e);
  assert.deepEqual(sent(), []);
  await dispatch(s, me, "update_task", { task_id: "OLD-1", host: "old", title: "T" });
  await dispatch(s, me, "update_task", { task_id: "NEW-1", host: "new", remind_at: "2h" });
  assert.deepEqual(sent(), [["old", "update_task"], ["new", "update_task"]]);
  // Not found here, it's only tried on the hosts that can do it.
  await dispatch(s, me, "update_task", { task_id: "ELSE-1", starred: true });
  assert.deepEqual(sent(), [["new", "update_task"]]);
});

test("reads_reminder_times", () => {
  const nowt = new Date("2026-10-26T10:00:00Z");
  const at = (v: string) => reminder_time(v, nowt);
  assert.equal(at("30m"), "2026-10-26T10:30:00.000Z");
  assert.equal(at("in 2 hours"), "2026-10-26T12:00:00.000Z");
  assert.equal(at("1d 12h"), "2026-10-27T22:00:00.000Z");
  assert.equal(at("1w"), "2026-11-02T10:00:00.000Z");
  assert.equal(at("2026-12-01T09:00:00Z"), "2026-12-01T09:00:00Z");
  assert.equal(at(" "), "");
  // In the host's time zone, whatever that is.
  for (const v of ["2026-12-01 09:00", "2026-12-01T09:00", "2026-12-01"]) {
    const r = at(v);
    assert.ok(r !== null && !isNaN(Date.parse(r)), v);
  }
  for (const v of ["soon", "2", "h", "3 fortnights", "99999d", "tomorrow"]) assert.equal(at(v), null, v);
});

test("a_repository_path_it_cant_have_is_refused_before_asking", async () => {
  const s = state();
  const p = db.insert_profile(s.db(), "personal", [], null);
  project(s, p, "os", "OS");
  const me = ctx(p);
  // Without a thread to ask in, a change it could make would say it needs approval.
  for (const [args, want] of [
    [{ project_id: "OS", repo_path: "/nowhere" }, "/nowhere isn't a folder"],
    [{ project_id: "OS", repo_path: "/nowhere", move_repo: true }, "/x doesn't exist, so there's nothing to move"],
    [{ project_id: "OS", move_repo: true }, "move_repo needs a new repo_path"],
    [{ project_id: "OS", repo_path: "/x", move_repo: true }, "move_repo needs a new repo_path"],
  ] as Array<[any, string]>) {
    const e = await err(call(s, me, "update_project", args));
    assert.ok(e.includes(want), e);
  }
  assert.equal(db.get_project(s.db(), "os")!.repo_path, "/x");
});

test("a_renamed_projects_old_key_still_names_its_tasks", async () => {
  const s = state();
  const p = db.insert_profile(s.db(), "personal", [], null);
  project(s, p, "os", "OS");
  project(s, p, "web", "WEB");
  task(s, "os", "Sandbox");
  const me = ctx(p);
  let v = await call(s, me, "update_project", { project_id: "OS", name: " omarchy-sandbox ", key: "oms" });
  assert.deepEqual([v.name, v.key, v.former_keys], ["omarchy-sandbox", "OMS", ["OS"]]);
  assert.equal((await call(s, me, "get_task", { task_id: "OMS-1" })).key, "OMS-1");
  assert.equal((await call(s, me, "get_task", { task_id: "os-1" })).key, "OMS-1");
  assert.equal((await call(s, me, "get_project", { project_id: "OS" })).key, "OMS");
  // Keys are checked, and are the project's alone.
  for (const [args, want] of [
    [{ project_id: "OMS", key: "WEB" }, "already has the key WEB"],
    [{ project_id: "OMS", key: "O-S" }, "letters or digits"],
    [{ project_id: "OMS", name: "  " }, "name can't be blank"],
  ] as Array<[any, string]>) {
    const e = await err(call(s, me, "update_project", args));
    assert.ok(e.includes(want), e);
  }
  // Changing back drops it from the old keys.
  v = await call(s, me, "update_project", { project_id: "OMS", key: "OSX" });
  assert.deepEqual(v.former_keys, ["OS", "OMS"]);
  v = await call(s, me, "update_project", { project_id: "OSX", key: "OS" });
  assert.deepEqual(v.former_keys, ["OMS", "OSX"]);
  // Its old keys stay its own, so they keep naming its tasks.
  let e = await err(call(s, me, "update_project", { project_id: "WEB", key: "OMS" }));
  assert.ok(e.includes("old task keys still use it"), e);
  e = await err(api.create_project_inner(s, p.id, { name: "x", repo_path: "/", key: "OSX", base_branch: null, use_worktrees: null }));
  assert.ok(e.includes("old task keys still use it"), e);
  assert.equal((await call(s, me, "get_task", { task_id: "OMS-1" })).title, "Sandbox");
  assert.equal((await call(s, me, "get_task", { task_id: "OSX-1" })).title, "Sandbox");
  // A derived key steers clear of them too.
  const site = await api.create_project_inner(s, p.id, { name: "Oms", repo_path: "/", key: null, base_branch: null, use_worktrees: null });
  assert.equal(site.key, "OMS2");
  // Projects that shared a key before it was checked: their tasks are named by id instead.
  db.update_project(s.db(), "web", [["former_keys", JSON.stringify(["OS"])]]);
  task(s, "web", "Site");
  e = await err(call(s, me, "get_task", { task_id: "OS-1" }));
  assert.ok(e.includes("more than one task"), e);
});

test("agents_read_and_change_a_projects_prompts", async () => {
  const s = state();
  const p = db.insert_profile(s.db(), "personal", [], null);
  project(s, p, "kiwicd", "KIW");
  const me = ctx(p, { task: task(s, "kiwicd", "Caller") });
  // The caller's own project by default, with every prompt the default.
  let v = await call(s, me, "get_project", {});
  assert.equal(v.key, "KIW");
  assert.deepEqual(v.merge_prompt, { instructions: prompts.DEFAULT_MERGE, default: true });
  v = await call(s, me, "update_project", { merge_prompt: "  Squash-merge it.  ", review_rounds: 3 });
  assert.deepEqual(v.merge_prompt, { instructions: "Squash-merge it.", default: false });
  assert.equal(v.start_prompt.default, true);
  assert.equal(v.review_rounds, 3);
  assert.equal(db.get_project(s.db(), "kiwicd")!.merge_prompt, "Squash-merge it.");
  // An empty string goes back to the default.
  v = await call(s, me, "update_project", { project_id: "KIW", merge_prompt: "", name: "Kiwi CD", model: "opus" });
  assert.deepEqual([v.merge_prompt.default, v.name, v.model], [true, "Kiwi CD", "opus"]);
  assert.equal((await call(s, me, "update_project", { model: "" })).model, null);
  assert.equal(db.get_project(s.db(), "kiwicd")!.merge_prompt, null);
  // Changes that need the user's approval can't be asked for without a call to ask in (from another host), and none
  // of the call's changes are made.
  let e = await err(call(s, me, "update_project", { permission_mode: "bypassPermissions", name: "Other" }));
  assert.ok(e.includes("needs the user's approval"), e);
  let stored = db.get_project(s.db(), "kiwicd")!;
  assert.deepEqual([stored.name, stored.permission_mode], ["Kiwi CD", null]);
  // Setting one to what it already is doesn't need it.
  await call(s, me, "update_project", { setup_script: "", use_worktrees: false });
  // The agent configs are the user's to change.
  e = await err(call(s, me, "update_project", { claude_config_ids: [] }));
  assert.ok(e.includes("only be changed by the user"), e);
  assert.ok(await fails(call(s, me, "update_project", { name: " " })));
  // Reviewers: blanks dropped, configs checked, an empty list back to the task's own.
  const codex = db.insert_claude_config(s.db(), "Codex", "", "codex");
  const two = [{ claude_config_id: codex.id, model: "gpt-5" }, { model: " opus ", effort: "" }];
  v = await call(s, me, "update_project", { reviewers: two });
  assert.deepEqual(v.reviewers, [
    { claude_config_id: codex.id, model: "gpt-5", effort: null },
    { claude_config_id: null, model: "opus", effort: null },
  ]);
  assert.equal(db.get_project(s.db(), "kiwicd")!.reviewers.length, 2);
  assert.ok(await fails(call(s, me, "update_project", { reviewers: [{ claude_config_id: "nope" }] })));
  await call(s, me, "update_project", { reviewers: [] });
  // A summarizer of its own, over the profile's, and back to the profile's with null.
  v = await call(s, me, "update_project", { summarizer: { model: "sonnet" } });
  assert.equal(v.summarizer.model, "sonnet");
  v = await call(s, me, "update_project", { summarizer: null });
  assert.equal(v.summarizer, null);
  assert.equal(db.get_project(s.db(), "kiwicd")!.summarizer, null);
  // Several, with skills.
  v = await call(s, me, "update_project", { summarizers: [{ name: "A" }, { name: "B", skills: ["tldr"] }] });
  assert.deepEqual([v.summarizers[1].skills, v.summarizer.name], [["tldr"], "A"]);
  v = await call(s, me, "update_project", { summarizers: null });
  assert.deepEqual(v.summarizers, []);
  await call(s, me, "update_project", { reviewers: [{ model: "opus" }] });
  await call(s, me, "update_project", { reviewers: null });
  stored = db.get_project(s.db(), "kiwicd")!;
  assert.equal(stored.reviewers.length, 0);
  assert.equal((await call(s, me, "update_project", { group_name: "Kiwi" })).group_name, "Kiwi");
  assert.equal((await call(s, me, "update_project", { group_name: "" })).group_name, null);
});

/** The next project change or deletion waiting for approval, once there is one. */
async function approval_asked(s: Shared): Promise<any> {
  let a: any;
  await until(() => (a = permissions.pending_approvals(s, true, true, true)[0]) !== undefined, "an approval to be asked");
  return a;
}

/** Answers the next project change or deletion waiting for approval, once there is one, and returns it. */
async function answer_approval(s: Shared, allow: boolean): Promise<any> {
  const a = await approval_asked(s);
  // "Always" doesn't apply to project changes or deletions.
  permissions.decide(s, a.request_id, allow, true, null);
  return a;
}

/**
 * Start `call` (MCP call `call_id`) and cut it short once it asks the user, as a server restart would: it's forgotten
 * (its waiter and its place in calls_inflight), and never carries on.
 */
async function cut_short(s: Shared, call_id: string, call: () => Promise<any>) {
  call().catch(() => {});
  let id: string | undefined;
  await until(() => (id = db.value<string>(s.db(), "SELECT id FROM permission_requests WHERE call_id=?1", call_id)) !== undefined, `${call_id} to ask`);
  s.perm_waiters.delete(id!);
  s.calls_inflight.delete(call_id);
}

test("only_new_hosts_get_calls_older_ones_would_half_do", () => {
  // There's no tool to delete a project.
  assert.ok(!needs_project_settings_api("delete_project", { project_id: "KIW" }));
  assert.ok(needs_project_settings_api("update_project", { name: "Kiwi", auto_review: true }));
  assert.ok(needs_project_settings_api("update_project", { setup_script: "" }));
  assert.ok(!needs_project_settings_api("update_project", { auto_review: true, merge_prompt: "", group_name: "Kiwi" }));
  assert.ok(!needs_project_settings_api("get_project", { name: "Kiwi" }));
  // A host on API 42 or 43 (task types, JSON 404s, but not these settings) would make the old ones and drop the rest,
  // so it isn't sent a mix; one on 44 is.
  const mixed = { project_id: "KIW", setup_script: "npm ci", auto_review: false };
  for (const old of [42, 43]) assert.ok(too_old("laptop", old, "update_project", mixed)?.includes("laptop runs an older build"));
  assert.equal(too_old("laptop", 44, "update_project", mixed), null);
  assert.equal(too_old("laptop", 43, "update_project", { auto_review: false }), null);
  // One from before delete_task would only say it doesn't know it.
  assert.ok(too_old("laptop", 57, "delete_task", { task_id: "KIW-2" })?.includes("can't delete tasks"));
  assert.equal(too_old("laptop", 58, "delete_task", { task_id: "KIW-2" }), null);
});

test("agents_delete_tasks_only_once_the_user_confirms", async () => {
  const s = state();
  const p = db.insert_profile(s.db(), "personal", [], null);
  project(s, p, "kiwicd", "KIW");
  // Even a thread that may do anything without asking asks first.
  const c0 = task(s, "kiwicd", "Caller");
  s.update_task(c0.id, [["permission_mode", "bypassPermissions"]]);
  const caller = db.get_task(s.db(), c0.id)!;
  const me = (call_id: string) => ctx(p, { task: caller, call_id });
  const [doomed, kept] = [task(s, "kiwicd", "Doomed"), task(s, "kiwicd", "Kept")];
  const exists = (t: Task) => db.get_task(s.db(), t.id) !== null;

  let e = await err(call(s, me("c0"), "delete_task", { task_id: "KIW-1" }));
  assert.ok(e.includes("can't delete your own task"), e);
  assert.equal(permissions.pending_approvals(s, true, true).length, 0);

  // Denied: nothing is deleted.
  const args = { task_id: "KIW-3", reason: "A duplicate of KIW-2" };
  let [res, asked] = await Promise.all([settle(call(s, me("c1"), "delete_task", args)), answer_approval(s, false)]);
  e = unwrap_err(res);
  assert.ok(e.includes("didn't approve deleting KIW-3, so nothing was deleted"), e);
  assert.ok(exists(kept));
  const input = asked.input;
  assert.deepEqual([asked.kind, asked.tool_name], ["delete_task", "delete_task"]);
  assert.deepEqual([input.delete.key, input.delete.title, input.task.key], ["KIW-3", "Kept", "KIW-1"]);
  assert.deepEqual([input.project.key, input.reason, input.delete_branch], ["KIW", "A duplicate of KIW-2", false]);
  // It flagged the asking task, and only the UIs that know deletions are shown it.
  assert.equal(db.get_task(s.db(), caller.id)!.attention_reason, "Delete a task?");

  // Confirmed: it's deleted.
  const confirm = async () => {
    const a = await approval_asked(s);
    assert.equal(permissions.pending_approvals(s, false, false).length, 0);
    assert.equal(permissions.pending(s, caller.id).length, 1);
    await answer_approval(s, true);
    return a;
  };
  [res] = await Promise.all([settle(call(s, me("c2"), "delete_task", { task_id: "KIW-2" })), confirm()]);
  const done = unwrap(res);
  assert.deepEqual([done.deleted, done.key], [true, "KIW-2"]);
  assert.ok(!exists(doomed) && exists(kept));

  // Deleted by someone else while the user is asked: the question goes, and the call says so.
  const del = async () => {
    await approval_asked(s);
    await api.delete_task_inner(s, kept, false);
  };
  [res] = await Promise.all([settle(call(s, me("c3"), "delete_task", { task_id: "KIW-3" })), del()]);
  assert.equal(unwrap(res).deleted, false);
  assert.equal(permissions.pending_approvals(s, true, true).length, 0);

  // An agent on another host has no thread here to ask in.
  const other = task(s, "kiwicd", "Other");
  e = await err(call(s, ctx(p), "delete_task", { task_id: "KIW-4" }));
  assert.ok(e.includes("deleting KIW-4 needs the user's approval"), e);
  assert.ok(exists(other));
});

test("a_retried_delete_deletes_what_it_asked_about", async () => {
  const s = state();
  const p = db.insert_profile(s.db(), "personal", [], null);
  project(s, p, "kiwicd", "KIW");
  const caller = task(s, "kiwicd", "Caller");
  const me = ctx(p, { task: caller, call_id: "c1" });
  const [doomed, kept] = [task(s, "kiwicd", "Doomed"), task(s, "kiwicd", "Kept")];
  // The server stops while the user is asked.
  await cut_short(s, "c1", () => call(s, me, "delete_task", { task_id: "KIW-2" }));
  // Redelivered, the call waits for the same question, and deletes the task it named.
  const [res] = await Promise.all([settle(call(s, me, "delete_task", { task_id: "KIW-3" })), answer_approval(s, true)]);
  assert.equal(unwrap(res).key, "KIW-2");
  assert.equal(db.get_task(s.db(), doomed.id), null);
  assert.notEqual(db.get_task(s.db(), kept.id), null);
});

test("tasks_added_while_the_user_is_asked_are_not_deleted_unasked", async () => {
  const s = state();
  const p = db.insert_profile(s.db(), "personal", [], null);
  project(s, p, "kiwicd", "KIW");
  const add = (title: string, parent: Task | null, subproject: boolean) =>
    api.create_task_inner(s, "kiwicd", create_task({ parent_id: parent?.id ?? null, subproject, title, use_worktree: false }));
  const caller = add("Caller", null, false);
  const me = (call_id: string) => ctx(p, { task: caller, call_id });
  const exists = (t: Task) => db.get_task(s.db(), t.id) !== null;
  // A subproject gets a task while the user looks at what it has.
  const sp = add("Subproject", null, true);
  const shown = add("Shown", sp, false);
  let late!: Task;
  const answer1 = async () => {
    await approval_asked(s);
    late = add("Late", sp, false);
    await answer_approval(s, true);
  };
  let [res] = await Promise.all([settle(call(s, me("c1"), "delete_task", { task_id: "KIW-2" })), answer1()]);
  let e = unwrap_err(res);
  assert.ok(e.includes("KIW-4 became tasks of KIW-2 while the user was asked, so nothing was deleted"), e);
  assert.ok(exists(sp) && exists(shown) && exists(late));
  // An ordinary task is made a subproject with a task meanwhile.
  const plain = add("Plain", null, false);
  let child!: Task;
  const answer2 = async () => {
    await approval_asked(s);
    s.update_task(plain.id, [["subproject", true]]);
    child = add("Child", plain, false);
    await answer_approval(s, true);
  };
  [res] = await Promise.all([settle(call(s, me("c2"), "delete_task", { task_id: "KIW-5" })), answer2()]);
  assert.ok(unwrap_err(res).includes("nothing was deleted"));
  assert.ok(exists(plain) && exists(child));
  // Asked again, the user sees them all, and they all go.
  let asked: any;
  [res, asked] = await Promise.all([settle(call(s, me("c3"), "delete_task", { task_id: "KIW-2" })), answer_approval(s, true)]);
  assert.equal(unwrap(res).tasks_deleted_with_it, 2);
  assert.equal(asked.input.tasks_with_it.length, 2);
  assert.ok(!exists(sp) && !exists(shown) && !exists(late));
});

test("no_task_joins_a_subproject_while_its_deleted", async () => {
  const s = state();
  const p = db.insert_profile(s.db(), "personal", [], null);
  const dir = testing.temp_dir();
  const repo = join(dir, "repo");
  mkdirSync(repo, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { stdio: "pipe" });
  git("init", "-q", "-b", "master");
  git("commit", "-q", "--allow-empty", "-m", "init");
  const proj = await api.create_project_inner(s, p.id, { name: "Kiwi", repo_path: path_str(repo), key: "KIW", base_branch: "master", use_worktrees: null });
  // The subproject's teardown holds it until the test lets it go.
  const [started, go] = [join(dir, "started"), join(dir, "go")];
  const script = `touch '${started}'; while [ ! -e '${go}' ]; do sleep 0.05; done`;
  db.run(s.db(), "UPDATE projects SET teardown_script=?1 WHERE id=?2", script, proj.id);
  const add = (title: string, parent: Task | null, subproject: boolean) =>
    api.create_task_inner(s, proj.id, create_task({ parent_id: parent?.id ?? null, subproject, title, use_worktree: false }));
  const caller = add("Caller", null, false);
  const sp = add("Subproject", null, true);
  await worktree.setup(s, sp.id);
  const shown = add("Shown", sp, false);
  const me = ctx(p, { task: caller, call_id: "c1" });
  const during = async () => {
    await answer_approval(s, true);
    await until(() => existsSync(started), "the teardown to start");
    // Mid-teardown: the subproject is still there, but takes no new tasks.
    assert.notEqual(db.get_task(s.db(), sp.id), null);
    let late: string;
    try {
      add("Late", sp, false);
      late = "added";
    } catch (e: any) {
      late = e.message;
    }
    writeFileSync(go, "");
    return late;
  };
  const [res, late] = await Promise.all([settle(call(s, me, "delete_task", { task_id: "KIW-2" })), during()]);
  assert.equal(unwrap(res).tasks_deleted_with_it, 1);
  assert.ok(late.includes("being deleted"), late);
  assert.ok(db.get_task(s.db(), sp.id) === null && db.get_task(s.db(), shown.id) === null);
  // Once it's gone, nothing stays held.
  assert.equal(s.deleting.size, 0);
  rmSync(dir, { recursive: true, force: true });
});

test("deleting_a_subproject_lists_its_tasks_and_spares_the_callers", async () => {
  const s = state();
  const p = db.insert_profile(s.db(), "personal", [], null);
  project(s, p, "kiwicd", "KIW");
  const add = (title: string, parent: Task | null, subproject: boolean) =>
    api.create_task_inner(s, "kiwicd", create_task({ parent_id: parent?.id ?? null, subproject, title, use_worktree: false }));
  const sp = add("Subproject", null, true);
  const [inside, child] = [add("Inside", sp, false), add("Child", sp, false)];
  const outside = add("Outside", null, false);
  const ctx_of = (t: Task) => ctx(p, { task: t, call_id: `${t.title}-call` });
  const e = await err(call(s, ctx_of(inside), "delete_task", { task_id: "KIW-1" }));
  assert.ok(e.includes("can't delete the subproject you're in"), e);
  const [res, asked] = await Promise.all([
    settle(call(s, ctx_of(outside), "delete_task", { task_id: "KIW-1", delete_branch: true })),
    answer_approval(s, true),
  ]);
  assert.equal(unwrap(res).tasks_deleted_with_it, 2);
  const with_it = asked.input.tasks_with_it.map((t: any) => t.key);
  assert.deepEqual([with_it, asked.input.delete.subproject, asked.input.delete_branch], [["KIW-2", "KIW-3"], true, true]);
  for (const t of [sp, inside, child]) assert.equal(db.get_task(s.db(), t.id), null);
});

test("deleting_a_thread_or_project_settles_its_approvals", async () => {
  const s = state();
  const p = db.insert_profile(s.db(), "personal", [], null);
  project(s, p, "kiwicd", "KIW");
  project(s, p, "other", "OTH");
  const [asker, other_asker] = [task(s, "kiwicd", "Asker"), task(s, "kiwicd", "Other asker")];
  const c1 = ctx(p, { task: asker, call_id: "c1" });
  const c2 = ctx(p, { task: other_asker, call_id: "c2" });
  // The thread that asked is deleted.
  const del1 = async () => {
    await approval_asked(s);
    await api.delete_one(s, asker, false);
  };
  let [res] = await Promise.all([settle(call(s, c1, "update_project", { setup_script: "make" })), del1()]);
  assert.ok(unwrap_err(res).includes("Request expired"));
  assert.equal(permissions.pending_approvals(s, true, true).length, 0);
  // The project the change is for is deleted, from another project's thread.
  const del2 = async () => {
    await approval_asked(s);
    await api.delete_project_inner(s, "other");
  };
  [res] = await Promise.all([settle(call(s, c2, "update_project", { project_id: "OTH", setup_script: "make" })), del2()]);
  assert.ok(unwrap_err(res).includes("Request expired"));
  assert.equal(permissions.pending_approvals(s, true, true).length, 0);
});

test("a_retried_call_carries_on_with_its_approval", async () => {
  const s = state();
  const p = db.insert_profile(s.db(), "personal", [], null);
  project(s, p, "kiwicd", "KIW");
  project(s, p, "old", "OLD");
  const caller = task(s, "kiwicd", "Caller");
  const me = (call_id: string) => ctx(p, { task: caller, call_id });
  // The server stops while the user is asked about the script (the name is as it was).
  const change = { name: "kiwicd", setup_script: "npm ci" };
  await cut_short(s, "c1", () => call(s, me("c1"), "update_project", change));
  // Meanwhile the user renames the project and sets the script themselves.
  await api.update_project_inner(s, "kiwicd", { name: "Kiwi", setup_script: "npm ci" });
  // Redelivered, the call waits for the same approval and makes only what it showed.
  const [res, asked] = await Promise.all([settle(call(s, me("c1"), "update_project", change)), answer_approval(s, true)]);
  assert.equal(unwrap(res).name, "Kiwi");
  assert.equal(asked.input.changes.length, 1);
  assert.equal(permissions.pending_approvals(s, true, true).length, 0);
  // Answered already: a denial stands, without asking again.
  await cut_short(s, "c2", () => call(s, me("c2"), "update_project", { setup_script: "make" }));
  await answer_approval(s, false);
  await api.update_project_inner(s, "kiwicd", { setup_script: "" });
  let e = await err(call(s, me("c2"), "update_project", { setup_script: "make" }));
  assert.ok(e.includes("didn't approve changing setup_script"), e);
  assert.equal(db.get_project(s.db(), "kiwicd")!.setup_script, "");
  // There's no tool to delete a project.
  e = await err(call(s, me("c3"), "delete_project", { project_id: "OLD" }));
  assert.ok(e.includes("unknown tool"), e);
  assert.notEqual(db.get_project(s.db(), "old"), null);
});

test("the_user_approves_risky_project_changes", async () => {
  const s = state();
  const p = db.insert_profile(s.db(), "personal", [], null);
  project(s, p, "kiwicd", "KIW");
  // Even a thread that may do anything without asking asks for these.
  const c0 = task(s, "kiwicd", "Caller");
  s.update_task(c0.id, [["permission_mode", "bypassPermissions"]]);
  const caller = db.get_task(s.db(), c0.id)!;
  const me = (call_id: string) => ctx(p, { task: caller, call_id });
  const change = { permission_mode: "bypassPermissions", setup_script: "npm ci", base_branch: "main", reason: "Faster setup" };

  // Denied: nothing changes, and the agent hears why.
  let [res, asked] = await Promise.all([settle(call(s, me("c1"), "update_project", change)), answer_approval(s, false)]);
  const e = unwrap_err(res);
  assert.ok(e.includes("didn't approve changing setup_script, permission_mode"), e);
  const stored = db.get_project(s.db(), "kiwicd")!;
  assert.deepEqual([stored.permission_mode, stored.setup_script, stored.base_branch], [null, "", null]);
  assert.equal(asked.tool_name, "update_project");
  assert.equal(asked.task_id, caller.id);
  const input = asked.input;
  assert.deepEqual([input.project.key, input.task.key, input.reason], ["KIW", "KIW-1", "Faster setup"]);
  const field = (f: string) => input.changes.find((c: any) => c.field === f);
  assert.deepEqual(field("permission_mode"), { field: "permission_mode", from: null, to: "bypassPermissions", needs_approval: true });
  assert.equal(field("base_branch").needs_approval, false);

  // A changed thread mode doesn't settle it either; approved, the whole call is made.
  const dont_ask = { ...caller, permission_mode: "dontAsk" };
  const approve = async () => {
    await approval_asked(s);
    permissions.apply_mode_to_pending(s, dont_ask);
    return answer_approval(s, true);
  };
  [res] = await Promise.all([settle(call(s, me("c2"), "update_project", change)), approve()]);
  let v = unwrap(res);
  assert.deepEqual([v.permission_mode, v.setup_script, v.base_branch], ["bypassPermissions", "npm ci", "main"]);
  assert.equal(db.get_task(s.db(), caller.id)!.auto_allow.length, 0);

  // Only what differs is shown and made: a setting the call leaves as it was isn't written back over a change made
  // while the user decides.
  const again = { permission_mode: "bypassPermissions", setup_script: "npm install" };
  const approve2 = async () => {
    await approval_asked(s);
    await api.update_project_inner(s, "kiwicd", { permission_mode: "default" });
    return answer_approval(s, true);
  };
  [res, asked] = await Promise.all([settle(call(s, me("c5"), "update_project", again)), approve2()]);
  assert.deepEqual(asked.input.changes.map((c: any) => c.field), ["setup_script"]);
  assert.deepEqual([unwrap(res).permission_mode, db.get_project(s.db(), "kiwicd")!.setup_script], ["default", "npm install"]);

  // Settings given in another form than they're kept in, but that come to what they are (a blank column script is
  // none, no reviewers is the profile's), aren't changes, so nothing is asked.
  const same = { status_scripts: { done: "  " }, reviewers: [], use_worktrees: false, repo_path: "/x" };
  v = await call(s, me("c6"), "update_project", same);
  assert.deepEqual([v.status_scripts, v.reviewers], [{}, []]);
  assert.equal(permissions.pending_approvals(s, true, true).length, 0);
});

test("files_brought_into_worktrees_need_the_users_approval", async () => {
  const s = state();
  const p = db.insert_profile(s.db(), "personal", [], null);
  project(s, p, "kiwicd", "KIW");
  const caller = task(s, "kiwicd", "Caller");
  const me = (call_id: string) => ctx(p, { task: caller, call_id });
  const change = { copy_files: ".env", link_folders: "models" };
  let [res, asked] = await Promise.all([settle(call(s, me("c1"), "update_project", change)), answer_approval(s, false)]);
  assert.ok(unwrap_err(res).includes("didn't approve changing copy_files, link_folders"));
  assert.deepEqual(asked.input.changes.map((c: any) => c.field), ["copy_files", "link_folders"]);
  const stored = db.get_project(s.db(), "kiwicd")!;
  assert.deepEqual([stored.copy_files, stored.link_folders], ["", ""]);
  [res] = await Promise.all([settle(call(s, me("c2"), "update_project", change)), answer_approval(s, true)]);
  const v = unwrap(res);
  assert.deepEqual([v.copy_files, v.link_folders], [".env", "models"]);
  // Checked like the API checks them, before asking.
  const e = await err(call(s, me("c3"), "update_project", { link_folders: "../elsewhere" }));
  assert.ok(e.includes("link_folders: ../elsewhere"), e);
});

test("agents_add_projects_only_once_the_user_approves_the_folder", async () => {
  const s = state();
  const p = db.insert_profile(s.db(), "personal", [], null);
  project(s, p, "kiwicd", "KIW");
  // Even a thread that may do anything without asking asks first.
  const c0 = task(s, "kiwicd", "Caller");
  s.update_task(c0.id, [["permission_mode", "bypassPermissions"]]);
  const caller = db.get_task(s.db(), c0.id)!;
  const me = (call_id: string) => ctx(p, { task: caller, call_id });
  const root0 = testing.temp_dir();
  mkdirSync(join(root0, "home"), { recursive: true });
  const root = realpathSync(root0);
  const home = join(root, "home");
  const projects = () => db.list_projects(s.db(), p.id).length;

  // Denied: no project, and no folder made.
  const fresh = join(root, "new", "site");
  const args = { repo_path: fresh, name: "Site", reason: "The user asked for one" };
  let [res, asked] = await Promise.all([settle(call(s, me("c1"), "create_project", args)), answer_approval(s, false)]);
  let e = unwrap_err(res);
  assert.ok(e.includes(`didn't approve adding ${fresh} as a project, so nothing was added`), e);
  assert.deepEqual([projects(), existsSync(join(root, "new"))], [1, false]);
  assert.deepEqual([asked.kind, asked.tool_name], ["project", "create_project"]);
  const input = asked.input;
  assert.deepEqual([input.op, input.repo_path, input.exists, input.git], ["create", fresh, false, false]);
  assert.deepEqual([input.project.name, input.project.key, input.board], ["Site", "SIT", "personal"]);
  assert.deepEqual([input.task.key, input.reason, input.permission_mode], ["KIW-1", "The user asked for one", "default"]);
  assert.equal(db.get_task(s.db(), caller.id)!.attention_reason, "Add a project?");

  // Approved: it's added where the user saw, with symlinks and `..` resolved first.
  symlinkSync(home, join(root, "link"));
  [res, asked] = await Promise.all([settle(call(s, me("c2"), "create_project", { repo_path: `${root}/link/../link` })), answer_approval(s, true)]);
  const v = unwrap(res);
  assert.deepEqual([asked.input.repo_path, asked.input.exists, asked.input.project.name], [home, true, "home"]);
  assert.deepEqual([v.repo_path, v.name, v.profile], [home, "home", "personal"]);
  assert.equal(projects(), 2);

  // Paths that aren't plainly somewhere aren't asked about.
  for (const bad of ["relative/path", "", "/nonexistent-ia/../x"]) {
    e = await err(call(s, me("c3"), "create_project", { repo_path: bad }));
    assert.ok(e.includes("absolute path") || e.includes("can be created"), `${bad}: ${e}`);
  }
  writeFileSync(join(root, "file"), "");
  assert.ok((await err(call(s, me("c3"), "create_project", { repo_path: join(root, "file") }))).includes("is not a directory"));
  assert.equal(permissions.pending_approvals(s, true, true).length, 0);

  // An agent on another host has no thread here to ask in.
  e = await err(call(s, ctx(p), "create_project", { repo_path: join(root, "remote") }));
  assert.ok(e.includes("needs the user's approval, which only an agent on the board's own host can ask for"), e);
  assert.deepEqual([projects(), existsSync(join(root, "remote"))], [2, false]);

  // Cut short by a restart while the user is asked, the retried call waits for the same answer.
  const run = started_run(s, caller.id);
  const later = join(root, "later");
  const mcp = (): McpCall => ({ task_fields: true, run_id: run.id, call_id: "m1", tool: "create_project", args: { repo_path: later } });
  await cut_short(s, "m1", () => handle_mcp(s, mcp()));
  [res] = await Promise.all([settle(handle_mcp(s, mcp())), answer_approval(s, true)]);
  assert.equal(unwrap(res).repo_path, later);
  assert.deepEqual([projects(), statSync(later).isDirectory()], [3, true]);
  rmSync(root, { recursive: true, force: true });
});

test("scratch_tasks_are_made_in_no_project_unless_given_one", async () => {
  const s = state();
  const p = db.insert_profile(s.db(), "personal", [], null);
  project(s, p, "web", "WEB");
  const me = ctx(p);
  let t = await call(s, me, "create_task", { title: "Try it", type: "scratch" });
  assert.deepEqual([t.key, t.type, t.project_id], ["S-1", "scratch", null]);
  const e = await err(call(s, me, "create_task", { title: "x", type: "scratch", is_subproject: true }));
  assert.ok(e.includes("can't be a subproject"), e);
  assert.equal((await call(s, me, "get_task", { task_id: "s-1" })).title, "Try it");
  assert.ok(await fails(call(s, me, "get_task", { task_id: "S-2" })));
  // On its profile's board with the rest.
  const all = await call(s, me, "list_tasks", { project_id: "all" });
  assert.deepEqual(keys(all, "key"), ["personal:S-1"]);

  // Given a project (API 51), it's in that project.
  t = await call(s, me, "create_task", { title: "Ask", type: "scratch", project_id: "WEB" });
  assert.deepEqual([t.key, t.type, t.project_id], ["WEB-1", "scratch", "web"]);
  // A subproject is a type too, and a scratch task can be in one.
  const sp = await call(s, me, "create_task", { title: "Search", type: "subproject", project_id: "WEB" });
  assert.deepEqual([sp.key, sp.is_subproject], ["WEB-2", true]);
  t = await call(s, me, "create_task", { title: "Ask", type: "scratch", subproject: "WEB-2" });
  assert.deepEqual([t.key, t.type, t.subproject], ["WEB-3", "scratch", "WEB-2"]);
  // An agent in a project still makes one in no project unless it says otherwise.
  const worker = db.get_task(s.db(), t.id)!;
  t = await call(s, ctx(p, { task: worker }), "create_task", { title: "Elsewhere", type: "scratch" });
  assert.deepEqual([t.key, t.project_id], ["S-2", null]);
});

test("only_its_own_profiles_agents_reach_the_assistant", async () => {
  const s = state();
  const p = db.insert_profile(s.db(), "personal", [], null);
  const work = db.insert_profile(s.db(), "work", [], null);
  project(s, p, "web", "WEB");
  project(s, work, "sd", "SD");
  task(s, "web", "build");
  task(s, "sd", "deploy");
  const mine = assistant.get_or_create(s, p.id);
  const theirs = assistant.get_or_create(s, work.id);
  // Each lets the other's agents in.
  grant(s, p, ["work"]);
  grant(s, work, ["personal"]);
  const me = ctx(p);
  // Off list_tasks unless it's asked for, and then only the caller's own.
  assert.deepEqual(keys(await call(s, me, "list_tasks", { project_id: "all" }), "key"), ["personal:WEB-1"]);
  const all = await call(s, me, "list_tasks", { project_id: "all", include_assistant: true });
  assert.deepEqual(keys(all, "key"), ["personal:A-1", "personal:WEB-1"]);
  assert.equal(all[0].type, "assistant");
  const every = await call(s, me, "list_tasks", { project_id: "all", profile: "all", include_assistant: true });
  assert.deepEqual(keys(every, "key"), ["personal:A-1", "personal:WEB-1", "work:SD-1"]);
  // By key or id, its own and not the other profile's.
  assert.equal((await call(s, me, "get_task", { task_id: "A-1" })).id, mine.id);
  assert.equal((await call(s, me, "get_task", { task_id: mine.id })).key, "A-1");
  for (const r of ["work:A-1", theirs.id]) {
    assert.ok(await fails(call(s, me, "get_task", { task_id: r })), r);
    assert.ok(await fails(call(s, me, "send_to_task", { task_id: r, message: "hi" })), r);
    assert.ok(await fails(call(s, me, "update_task", { task_id: r, title: "Mine now" })), r);
    assert.ok(await fails(call(s, me, "delete_task", { task_id: r })), r);
  }
  assert.ok(await fails(call(s, me, "get_task", { task_id: "A-1", profile: "work" })));
  assert.ok(await fails(handle_remote(s, "get_task", "personal", { task_id: theirs.id }, true)));
  assert.equal(db.get_task(s.db(), theirs.id)!.title, "Assistant");
  // The other profile's own agents reach theirs.
  assert.equal((await call(s, ctx(work), "get_task", { task_id: "A-1" })).id, theirs.id);
});

test("a_group_task_creates_tasks_in_its_groups_projects", async () => {
  const s = state();
  const p = db.insert_profile(s.db(), "personal", [], null);
  project(s, p, "web", "WEB");
  project(s, p, "api", "API");
  for (const id of ["web", "api"]) db.update_project(s.db(), id, [["group_name", "Shop"]]);
  const planner = db.insert_group_task(s.db(), new_task(p, "Plan checkout"), "Shop");
  assert.deepEqual([planner.number, planner.group_name], [1, "Shop"]);
  // Numbered across the profile's groups, so each key names one task.
  const blog = db.insert_group_task(s.db(), new_task(p, "Plan posts"), "Blog");
  assert.equal(blog.number, 2);
  assert.equal(db.insert_group_task(s.db(), new_task(p, "Plan search"), "Shop").number, 3);

  let me = ctx(p, { task: planner });
  // It's in no project, so each task needs one.
  const e = await err(call(s, me, "create_task", { title: "x" }));
  assert.ok(e.includes("project_id is required"), e);
  const t = await call(s, me, "create_task", { title: "Cart API", project_id: "API" });
  assert.equal(t.key, "API-1");
  assert.equal(db.get_task(s.db(), t.id)!.created_by, planner.id);
  const got = await call(s, me, "get_task", { task_id: planner.id });
  assert.deepEqual([got.key, got.group_task], ["G-1", "Shop"]);
  assert.equal(got.created_tasks[0].key, "API-1");

  // Their keys name them to the board tools.
  me = ctx(p);
  assert.equal((await call(s, me, "get_task", { task_id: "G-2" })).title, "Plan posts");
  let v = await call(s, me, "update_task", { task_id: "g-2", title: "Plan the blog" });
  assert.deepEqual([v.id, v.key], [blog.id, "G-2"]);
  assert.ok(await fails(call(s, me, "get_task", { task_id: "G-9" })));

  // No project can take the key now, and one that had it from before moves to a free one (as the migration does), so
  // both keep keys that name them.
  const e2 = await err(api.update_project_inner(s, "web", { key: "g" }));
  assert.ok(e2.includes("used by group tasks"), e2);
  project(s, p, "old", "G");
  project(s, p, "gp", "GP");
  task(s, "old", "Old work");
  db.free_group_task_key(s.db());
  assert.equal(db.get_project(s.db(), "old")!.key, "GP2");
  assert.equal((await call(s, me, "get_task", { task_id: "G-1" })).title, "Plan checkout");
  assert.equal((await call(s, me, "get_task", { task_id: "GP2-1" })).title, "Old work");
  v = await call(s, me, "update_task", { task_id: "G-1", title: "Plan the checkout" });
  assert.equal(v.id, planner.id);
  v = await call(s, me, "update_task", { task_id: "GP2-1", status: "backlog" });
  assert.deepEqual([v.key, v.status], ["GP2-1", "backlog"]);
});

test("lists_only_the_created_tasks_the_caller_can_reach", async () => {
  const s = state();
  const [personal, work, lab] = ["personal", "work", "lab"].map((n) => db.insert_profile(s.db(), n, [], null));
  project(s, personal, "web", "WEB");
  project(s, work, "sd", "SD");
  db.update_project(s.db(), "web", [["group_name", "Shop"]]);
  const planner = db.insert_group_task(s.db(), new_task(personal, "Plan"), "Shop");
  grant(s, work, ["personal"]);
  grant(s, personal, ["lab"]);
  const me = ctx(personal, { task: planner });
  await call(s, me, "create_task", { title: "Mine", project_id: "WEB" });
  await call(s, me, "create_task", { title: "Theirs", project_id: "work:SD" });
  const titles = (v: any) => JSON.parse(v.content).map((t: any) => t.title);
  const get = { task_id: planner.id, field: "created_tasks", limit: TASK_FIELD_MAX_LIMIT };
  assert.deepEqual(titles(await call(s, ctx(personal), "get_task_field", get)), ["Mine", "Theirs"]);
  // Lab reaches personal's board but not work's.
  assert.deepEqual(titles(await call(s, ctx(lab), "get_task_field", get)), ["Mine"]);
  // Nor does personal once work stops letting it in.
  grant(s, work, []);
  assert.deepEqual(titles(await call(s, ctx(personal), "get_task_field", get)), ["Mine"]);
});

test("group_tasks_have_no_dependencies", async () => {
  const s = state();
  const [personal, work, lab] = ["personal", "work", "lab"].map((n) => db.insert_profile(s.db(), n, [], null));
  for (const [p, id] of [[personal, "web"], [work, "sd"]] as const) {
    project(s, p, id, id.toUpperCase());
    db.update_project(s.db(), id, [["group_name", "Shop"]]);
  }
  const planner = (p: db.Profile, title: string) => db.insert_group_task(s.db(), new_task(p, title), "Shop");
  const mine = planner(personal, "Mine");
  const theirs = planner(work, "Theirs");
  grant(s, work, ["personal"]);
  grant(s, personal, ["lab"]);
  let e = await err(call(s, ctx(personal), "update_task", { task_id: mine.id, depends_on: ["work:G-1"] }));
  assert.ok(e.includes("only tasks in a project"), e);
  e = await err(api.update_task_inner(s, mine.id, { depends_on: [theirs.id] }));
  assert.ok(e.includes("only tasks in a project"), e);
  // Clearing them is fine.
  await call(s, ctx(personal), "update_task", { task_id: mine.id, depends_on: [] });

  // A link made before this was checked shows to no one, and the migration drops it.
  db.update_task(s.db(), mine.id, [["depends_on", [theirs.id]], ["waiting", true]]);
  const get = { task_id: mine.id };
  assert.equal((await call(s, ctx(lab), "get_task", get)).depends_on, undefined);
  grant(s, work, []);
  assert.equal((await call(s, ctx(personal), "get_task", get)).depends_on, undefined);
  db.clear_projectless_dependencies(s.db());
  const t = db.get_task(s.db(), mine.id)!;
  assert.ok(t.depends_on.length === 0 && !t.waiting);
});

test("group_tasks_follow_their_group_when_its_renamed", () => {
  const c = db.open(":memory:");
  const p = db.insert_profile(c, "me", [], null);
  for (const id of ["a", "b"]) {
    db.insert_project(c, { id, profile_id: p.id, name: id, key: id, repo_path: "/x", scratch_path: "/s", worktrees_root: "/w", base_branch: null, use_worktrees: false });
    db.update_project(c, id, [["group_name", "Old"]]);
  }
  const t = db.insert_group_task(c, new_task(p, "Plan"), "Old");
  db.update_project(c, "a", [["group_name", "New"]]);
  // "b" is still in the old group.
  assert.equal(db.rename_group_tasks(c, p.id, "Old", "New").length, 0);
  db.update_project(c, "b", [["group_name", "New"]]);
  assert.deepEqual(db.rename_group_tasks(c, p.id, "Old", "New"), [t.id]);
  assert.equal(db.get_task(c, t.id)!.group_name, "New");
  // Ungrouped, they keep the name.
  db.update_project(c, "a", [["group_name", null]]);
  db.update_project(c, "b", [["group_name", null]]);
  assert.equal(db.rename_group_tasks(c, p.id, "New", null).length, 0);
  assert.equal(db.list_group_tasks(c, p.id, false)[0].group_name, "New");
});

test("an_agent_waits_for_the_tasks_it_watches", async () => {
  const s = state();
  const p = db.insert_profile(s.db(), "personal", [], null);
  project(s, p, "kiwicd", "KIW");
  const [planner, worker] = [task(s, "kiwicd", "Plan"), task(s, "kiwicd", "Build")];
  const run = db.insert_run(s.db(), planner.id, "prompt");
  const mcp = (call_id: string, args: any): McpCall => ({ task_fields: true, run_id: run.id, call_id, tool: "wait", args });

  const e = await err(handle_mcp(s, mcp("c0", { reason: "r", tasks: ["KIW-9"] })));
  assert.ok(e.includes("KIW-9 not found on this host"), e);

  const mover = (async () => {
    while (db.get_task(s.db(), worker.id)!.status === "todo" && db.get_task(s.db(), planner.id)!.agent_wait === null) await sleep(10);
    s.update_task(worker.id, [["status", "in_review"]]);
  })();
  const v = await handle_mcp(s, mcp("c1", { reason: "waiting on KIW-2", tasks: ["KIW-2"], seconds: 60 }));
  await mover;
  assert.equal(v.ended, "tasks_changed");
  assert.equal(v.note, "KIW-2 changed status (see tasks).");
  assert.deepEqual([v.tasks[0].key, v.tasks[0].status], ["KIW-2", "in_review"]);
});

test("another_call_from_the_run_ends_its_wait", async () => {
  const s = state();
  const p = db.insert_profile(s.db(), "personal", [], null);
  project(s, p, "kiwicd", "KIW");
  const planner = task(s, "kiwicd", "Plan");
  const run = db.insert_run(s.db(), planner.id, "prompt");
  const mcp = (call_id: string, tool: string, args: any): McpCall => ({ task_fields: true, run_id: run.id, call_id, tool, args });
  const busy = (async () => {
    while (db.get_task(s.db(), planner.id)!.agent_wait === null) await sleep(10);
    // The helper runs calls concurrently: the agent works on while the wait is pending.
    await handle_mcp(s, mcp("c2", "get_task", { task_id: "KIW-1" }));
  })();
  // Without tasks or a command, a long wait is turned down.
  const e = await err(handle_mcp(s, mcp("c0", "wait", { reason: "r", seconds: 600 })));
  assert.ok(e.includes("30 seconds at most"), e);
  const v = await handle_mcp(s, mcp("c1", "wait", { reason: "r", seconds: 30 }));
  await busy;
  assert.equal(v.ended, "resumed");
  assert.equal(db.get_task(s.db(), planner.id)!.agent_wait, null);
});

test("a_subagents_completion_wakes_its_agents_wait", async () => {
  const codex = (method: string, params: any) => ({ method, params });
  const endings: Array<[boolean, any]> = [];
  for (const status of ["completed", "failed", "interrupted"]) {
    endings.push([true, codex("turn/completed", { threadId: "child", turn: { status } })]);
  }
  for (const kind of ["completed", "interrupted"]) {
    endings.push([true, codex("item/completed", { threadId: "main", item: { type: "subAgentActivity", id: "activity", kind, agentThreadId: "child" } })]);
  }
  endings.push([
    true,
    codex("item/completed", {
      threadId: "main",
      item: {
        type: "collabAgentToolCall",
        id: "native-wait",
        tool: "wait",
        status: "completed",
        agentsStates: { child: { status: "completed", message: "Child report" } },
      },
    }),
  ]);
  endings.push([false, { type: "system", subtype: "task_notification", tool_use_id: "child", task_id: "background", status: "completed", summary: "Child report" }]);
  endings.push([false, { type: "system", subtype: "task_updated", tool_use_id: "child", patch: { status: "failed" } }]);

  for (const [n, [is_codex, ending]] of endings.entries()) {
    const s = state();
    const p = db.insert_profile(s.db(), "personal", [], null);
    project(s, p, "kiwicd", "KIW");
    const planner = task(s, "kiwicd", "Plan");
    s.update_task(planner.id, [["session_id", "main"]]);
    const run = db.insert_run(s.db(), planner.id, "prompt");
    const start = is_codex
      ? codex("thread/started", { thread: { id: "child", parentThreadId: "main", preview: "Inspect config" } })
      : {
          type: "assistant",
          message: { content: [{ type: "tool_use", id: "child", name: "Agent", input: { description: "Inspect config", run_in_background: true } }] },
        };
    runner.on_output(s, run.id, 0, `${JSON.stringify(start)}\n`);
    const finish = (async () => {
      while (db.get_task(s.db(), planner.id)!.agent_wait === null) await sleep(10);
      if (ending.params?.item?.type === "subAgentActivity") {
        const started = { ...ending, method: "item/started" };
        const offset = db.get_run(s.db(), run.id)!.out_offset;
        runner.on_output(s, run.id, offset, `${JSON.stringify(started)}\n`);
        assert.notEqual(db.get_task(s.db(), planner.id)!.agent_wait, null);
      }
      const offset = db.get_run(s.db(), run.id)!.out_offset;
      runner.on_output(s, run.id, offset, `${JSON.stringify(ending)}\n`);
    })();
    const result = await handle_mcp(s, { task_fields: true, run_id: run.id, call_id: "wait", tool: "wait", args: { reason: "waiting for child", seconds: 1 } });
    await finish;
    assert.equal(result.ended, "subagent_finished", `case ${n}: ${JSON.stringify(result)}`);
    assert.equal(result.subagent.tool_use_id, is_codex ? "codex-agent-child" : "child");
    assert.equal(db.get_task(s.db(), planner.id)!.agent_wait, null);
    assert.ok(!db.get_run(s.db(), run.id)!.saw_result, "the parent's turn must stay running");
  }
});

test("a_waits_command_is_approved_like_a_bash_call", async () => {
  const s = state();
  const p = db.insert_profile(s.db(), "personal", [], null);
  project(s, p, "kiwicd", "KIW");
  const repo = testing.temp_dir();
  db.update_project(s.db(), "kiwicd", [["repo_path", repo]]);
  const planner = task(s, "kiwicd", "Plan");
  const run = started_run(s, planner.id);
  const mcp = (call_id: string, args: any): McpCall => ({ task_fields: true, run_id: run.id, call_id, tool: "wait", args });
  // Answers the call's prompt once it's raised.
  const answer = async (call_id: string, allow: boolean) => {
    let r: { id: string; input: string } | undefined;
    await until(() => (r = db.one(s.db(), "SELECT id, input FROM permission_requests WHERE call_id=?1", call_id)) !== undefined, "the prompt");
    permissions.decide(s, r!.id, allow, false, null);
    return JSON.parse(r!.input);
  };

  let asked = answer("c1", true);
  const v = await handle_mcp(s, mcp("c1", { reason: "waiting for the build", command: "pwd; exit 1", seconds: 60 }));
  assert.deepEqual(await asked, { command: "pwd; exit 1", cwd: repo, description: "Run while waiting: waiting for the build" });
  assert.deepEqual([v.ended, v.note], ["command_exited", "Your command exited with code 1 (see command.output)."]);
  assert.deepEqual(v.command, { exit_code: 1, output: `${repo}\n` });

  asked = answer("c2", false);
  const e = await err(handle_mcp(s, mcp("c2", { reason: "r", command: "true" })));
  await asked;
  assert.ok(e.startsWith("The command wasn't approved, so the wait didn't start"), e);
  assert.equal(db.get_task(s.db(), planner.id)!.agent_wait, null);
});

test("a_waits_command_runs_unasked_when_the_agents_reviewer_approved_the_call", async () => {
  const s = state();
  const p = db.insert_profile(s.db(), "personal", [], null);
  project(s, p, "kiwicd", "KIW");
  const repo = testing.temp_dir();
  db.update_project(s.db(), "kiwicd", [["repo_path", repo]]);
  const planner = task(s, "kiwicd", "Plan");
  const launched = (mode: string, allowed: string) => {
    const run = started_run(s, planner.id);
    const dir = runs.run_dir(s, run.id);
    mkdirSync(dir, { recursive: true });
    const args = ["-p", "--permission-mode", mode, "--allowedTools", allowed, "mcp__gh__pr_view", "--add-dir", "/a"];
    writeFileSync(join(dir, "spec.json"), JSON.stringify({ cwd: repo, args }));
    return run;
  };
  // A Codex run in auto mode, from this build (whose reviewer reviews waits) or an older one.
  const codex_launched = (review_waits: boolean | null) => {
    const run = started_run(s, planner.id);
    const dir = runs.run_dir(s, run.id);
    mkdirSync(dir, { recursive: true });
    const spec_path = join(dir, "codex.json");
    const spec: any = { cwd: repo, approval_policy: "on-request", approvals_reviewer: "auto_review", sandbox: "workspace-write" };
    if (review_waits !== null) spec.review_waits = review_waits;
    writeFileSync(spec_path, JSON.stringify(spec));
    writeFileSync(join(dir, "spec.json"), JSON.stringify({ cwd: repo, args: ["codex-run", spec_path] }));
    return run;
  };
  const mcp = (run_id: string, call_id: string): McpCall => ({
    task_fields: true,
    run_id,
    call_id,
    tool: "wait",
    args: { reason: "waiting for CI", command: "exit 3" },
  });
  const request = (call_id: string) => db.value<string>(s.db(), "SELECT id FROM permission_requests WHERE call_id=?1", call_id);

  // Claude's auto mode classifier approved the call before the agent made it.
  let run = launched("auto", "mcp__huntaway__get_task");
  let v = await handle_mcp(s, mcp(run.id, "c1"));
  assert.deepEqual([v.ended, v.command.exit_code], ["command_exited", 3]);
  assert.equal(request("c1"), undefined);
  // As did Codex's reviewer.
  run = codex_launched(true);
  v = await handle_mcp(s, mcp(run.id, "c2"));
  assert.deepEqual([v.ended, v.command.exit_code], ["command_exited", 3]);
  assert.equal(request("c2"), undefined);

  // A run that pre-approves every board tool (one from an older build, before or after the rename, Claude or Codex) is
  // still asked, in auto mode as in Ask.
  const asked_runs = [launched("auto", "mcp__huntaway"), launched("auto", "mcp__issue_agent"), launched("default", "mcp__issue_agent"), codex_launched(null), codex_launched(false)];
  for (const [n, r] of asked_runs.entries()) {
    const call_id = `asked${n}`;
    s.runs.set(planner.id, { run_id: r.id, cancel: null });
    const pending_call = settle(handle_mcp(s, mcp(r.id, call_id)));
    let id: string | undefined;
    await until(() => (id = request(call_id)) !== undefined, call_id);
    permissions.decide(s, id!, false, false, null);
    const e = unwrap_err(await pending_call);
    assert.ok(e.startsWith("The command wasn't approved"), `${n}: ${e}`);
  }

  // And in Don't ask its command is refused without asking.
  db.update_task(s.db(), planner.id, [["permission_mode", "dontAsk"]]);
  run = launched("dontAsk", "mcp__issue_agent");
  const e = await err(handle_mcp(s, mcp(run.id, "c3")));
  assert.ok(e.includes(permissions.DONT_ASK_DENIAL), e);
  assert.equal(request("c3"), undefined);
});

test("an_agent_waits_on_its_pull_request", async () => {
  const s = state();
  const p = db.insert_profile(s.db(), "personal", [], null);
  project(s, p, "kiwicd", "KIW");
  // The project's repository, on GitHub as o/r.
  const repo = testing.temp_dir();
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["remote", "add", "origin", "git@github.com:o/r.git"], { cwd: repo });
  db.update_project(s.db(), "kiwicd", [["repo_path", repo]]);
  const t = task(s, "kiwicd", "Build");
  const failed = pr_watch.response("me", "a1", [["Tests / server", "COMPLETED", "FAILURE", true]], []);
  pr_watch.fake((_account, target) => {
    assert.equal(target.label(), "o/r#7");
    return structuredClone(failed);
  });
  try {
    // A Claude run and a Codex run (in auto mode, whose reviewer reviews waits) call it alike.
    const claude = db.insert_run(s.db(), t.id, "prompt");
    const codex = db.insert_run(s.db(), t.id, "prompt");
    const dir = runs.run_dir(s, codex.id);
    mkdirSync(dir, { recursive: true });
    const spec = { cwd: repo, approval_policy: "on-request", approvals_reviewer: "auto_review", sandbox: "workspace-write", review_waits: true };
    writeFileSync(join(dir, "codex.json"), JSON.stringify(spec));
    writeFileSync(join(dir, "spec.json"), JSON.stringify({ cwd: repo, args: ["codex-run", join(dir, "codex.json")] }));
    const mcp = (run: db.Run, call_id: string, args: any): McpCall => ({ task_fields: true, run_id: run.id, call_id, tool: "wait", args });

    let v = await handle_mcp(s, mcp(claude, "c1", { reason: "waiting for CI", pull_request: "7" }));
    assert.equal(v.ended, "pull_request");
    assert.equal(v.note, "Pull request #7: checks failed (Tests / server) (see pull_request).");
    assert.equal(v.pull_request.checks.failed[0].name, "Tests / server");
    assert.deepEqual(v.pull_request.events, ["checks_failed"]);
    // Told, a later wait (by URL) times out, saying how it was when last read.
    v = await handle_mcp(s, mcp(codex, "c2", { reason: "waiting for review", pull_request: "https://github.com/o/r/pull/7", seconds: 1 }));
    assert.equal(v.ended, "timeout");
    assert.deepEqual([v.pull_request.checks.outcome, v.pull_request.number], ["failed", 7]);
    assert.equal(typeof v.pull_request.read_at, "string", JSON.stringify(v));
    assert.equal(count(s, "SELECT COUNT(*) FROM permission_requests"), 0);

    let e = await err(handle_mcp(s, mcp(claude, "c3", { reason: "r", pull_request: 7, pull_request_events: ["reviews"] })));
    assert.ok(e.startsWith("pull_request_events takes checks_failed, checks_passed, comments, conflicts"), e);
    e = await err(handle_mcp(s, mcp(claude, "c4", { reason: "r", pull_request: "the PR" })));
    assert.ok(e.includes("the PR isn't a pull request"), e);
    // A whole number sent as a float (or written as one) is a number. (JSON.parse reads 7.0 as 7.)
    for (const [c, pr] of [["c5", 7.0], ["c5b", "7.0"]] as Array<[string, any]>) {
      v = await handle_mcp(s, mcp(claude, c, { reason: "r", pull_request: pr, seconds: 1 }));
      assert.deepEqual([v.ended, v.pull_request.number], ["timeout", 7], String(pr));
    }
    e = await err(handle_mcp(s, mcp(claude, "c6", { reason: "r", pull_request: 7.5 })));
    assert.ok(e.includes("7.5 isn't a pull request"), e);
    // A remote's host that isn't its account's (an SSH alias ssh doesn't know) asks for the URL.
    execFileSync("git", ["remote", "set-url", "origin", "git@github-work:o/r.git"], { cwd: repo });
    db.update_profile(s.db(), p.id, [["github_account", "me"]]);
    e = await err(handle_mcp(s, mcp(claude, "c7", { reason: "r", pull_request: 7 })));
    assert.ok(e.includes("this task's repository is pushed to github-work, but its GitHub account me is on github.com: give the pull request's URL"), e);
    // The pull request's state is kept with the task, and goes with it.
    assert.equal(count(s, "SELECT COUNT(*) FROM pr_watches WHERE task_id=?1", t.id), 1);
    db.run(s.db(), "DELETE FROM tasks WHERE id=?1", t.id);
    assert.equal(count(s, "SELECT COUNT(*) FROM pr_watches"), 0);
  } finally {
    pr_watch.fake(null);
  }
});

test("a_retried_wait_wakes_for_a_watched_task_deleted_meanwhile", async () => {
  const s = state();
  const p = db.insert_profile(s.db(), "personal", [], null);
  project(s, p, "kiwicd", "KIW");
  const [planner, worker] = [task(s, "kiwicd", "Plan"), task(s, "kiwicd", "Build")];
  const run = db.insert_run(s.db(), planner.id, "prompt");
  // The call was waiting on KIW-2 when the server went down, and KIW-2 was deleted since.
  const w = {
    reason: "waiting on KIW-2",
    since: now(),
    until: new Date(Date.now() + 60_000).toISOString(),
    tasks: [{ id: worker.id, key: "KIW-2", status: worker.status }],
    command: null,
    call_id: "c1",
    run_id: run.id,
    moved_to: null,
    subagent_finished: null,
    pull_request: null,
  };
  s.update_task(planner.id, [["agent_wait", w]]);
  db.run(s.db(), "DELETE FROM tasks WHERE id=?1", worker.id);
  const retry: McpCall = { task_fields: true, run_id: run.id, call_id: "c1", tool: "wait", args: { reason: "waiting on KIW-2", tasks: ["KIW-2"], seconds: 60 } };
  const v = await handle_mcp(s, retry);
  assert.equal(v.ended, "tasks_changed");
  assert.deepEqual(v.tasks, [{ id: worker.id, key: "KIW-2", deleted: true }]);
  assert.equal(db.get_task(s.db(), planner.id)!.agent_wait, null);
});

test("a_subagents_permission_prompt_doesnt_end_its_agents_wait", async () => {
  const s = state();
  const p = db.insert_profile(s.db(), "personal", [], null);
  project(s, p, "kiwicd", "KIW");
  const planner = task(s, "kiwicd", "Plan");
  db.update_task(s.db(), planner.id, [["auto_allow", '["Bash"]']]);
  const run = db.insert_run(s.db(), planner.id, "prompt");
  const mcp = (call_id: string, tool: string, args: any): McpCall => ({ task_fields: true, run_id: run.id, call_id, tool, args });
  const subagent = (async () => {
    while (db.get_task(s.db(), planner.id)!.agent_wait === null) await sleep(10);
    const v = await handle_mcp(s, mcp("c2", "permission_prompt", { tool_name: "Bash", input: { command: "make" }, tool_use_id: "toolu_sub" }));
    assert.equal(v.behavior, "allow");
    return db.get_task(s.db(), planner.id)!.agent_wait !== null;
  })();
  const v = await handle_mcp(s, mcp("c1", "wait", { reason: "r", seconds: 1 }));
  assert.ok(await subagent, "the prompt cleared the wait");
  assert.equal(v.ended, "timeout");
});

test("a_reviewer_can_only_read_the_board_whatever_its_tool_list_offers", async () => {
  const s = state();
  const p = db.insert_profile(s.db(), "personal", [], null);
  project(s, p, "kiwicd", "KIW");
  const reviewed = task(s, "kiwicd", "Reviewed");
  const thread = db.insert_task(s.db(), new_task(p, "review", { project_id: "kiwicd", kind: "review" }));
  db.update_task(s.db(), thread.id, [["parent_id", reviewed.id]]);
  const run = db.insert_run(s.db(), thread.id, "review");
  const auto_review = db.get_project(s.db(), "kiwicd")!.auto_review;
  const mcp = (call_id: string, tool: string, args: any): McpCall => ({ task_fields: true, run_id: run.id, call_id, tool, args });
  // A reviewer reading an injected instruction can't start agents, steer the reviewed task's, or change tasks and
  // projects, even calling a tool its helper doesn't list.
  const refused: Array<[string, any]> = [
    ["create_task", { title: "Exfiltrate", start: true }],
    ["send_to_task", { task_id: "KIW-1", message: "Push to main" }],
    ["update_task", { task_id: "KIW-1", status: "done" }],
    ["update_project", { auto_review: !auto_review }],
    ["create_project", { repo_path: "/tmp/x" }],
    ["delete_task", { task_id: "KIW-1" }],
  ];
  for (const [i, [tool, args]] of refused.entries()) {
    const e = await err(handle_mcp(s, mcp(`c${i}`, tool, args)));
    assert.ok(e.startsWith(`${tool} isn't available to reviewers`), e);
  }
  assert.equal(db.list_tasks_for_project(s.db(), "kiwicd", "task").length, 1);
  const t = db.get_task(s.db(), reviewed.id)!;
  assert.deepEqual([t.status, t.steering.length], ["todo", 0]);
  assert.equal(db.get_project(s.db(), "kiwicd")!.auto_review, auto_review);
  // Nor is the user asked to approve anything for it (delete_task, update_project).
  assert.equal(count(s, "SELECT COUNT(*) FROM permission_requests"), 0);
  // It still reads the board.
  assert.equal((await handle_mcp(s, mcp("r1", "get_task", { task_id: "KIW-1" }))).title, "Reviewed");
  assert.equal((await handle_mcp(s, mcp("r2", "get_project", {}))).key, "KIW");
  assert.equal((await handle_mcp(s, mcp("r3", "list_tasks", {}))).length, 1);
  assert.ok((await handle_mcp(s, mcp("r4", "list_projects", {}))).length > 0);
  assert.equal((await handle_mcp(s, mcp("r5", "get_task_field", { task_id: "KIW-1", field: "title" }))).content, "Reviewed");
  // A task's own agent keeps them all.
  const own = db.insert_run(s.db(), reviewed.id, "prompt");
  await handle_mcp(s, { task_fields: true, run_id: own.id, call_id: "t1", tool: "create_task", args: { title: "Follow-up" } });
  assert.equal(db.list_tasks_for_project(s.db(), "kiwicd", "task").length, 2);
});

test("a_run_the_board_has_ended_gets_nothing_done", async () => {
  const s = state();
  const p = db.insert_profile(s.db(), "personal", [], null);
  project(s, p, "kiwicd", "KIW");
  const t = task(s, "kiwicd", "Work");
  // Its supervisor vanished and the board ended it, but its agent's helper still calls.
  const run = db.insert_run(s.db(), t.id, "prompt");
  db.run(s.db(), "UPDATE runs SET status='exited' WHERE id=?1", run.id);
  s.update_task(t.id, [["status", "in_review"]]);
  const mcp = (call_id: string, tool: string, args: any): McpCall => ({ task_fields: true, run_id: run.id, call_id, tool, args });
  const calls: Array<[string, any]> = [
    ["create_task", { title: "Follow-up", start: true }],
    ["update_task", { task_id: "KIW-1", status: "done" }],
    ["send_to_task", { task_id: "KIW-1", message: "Carry on" }],
    ["permission_prompt", { tool_name: "Bash", input: { command: "make" } }],
    ["get_task", { task_id: "KIW-1" }],
  ];
  for (const [i, [tool, args]] of calls.entries()) {
    const e = await err(handle_mcp(s, mcp(`c${i}`, tool, args)));
    assert.ok(e.startsWith("This run has ended on the board"), `${tool}: ${e}`);
  }
  const after = db.get_task(s.db(), t.id)!;
  assert.deepEqual([after.status, after.steering.length, after.queued_message], ["in_review", 0, null]);
  assert.equal(db.list_tasks_for_project(s.db(), "kiwicd", "task").length, 1);
  assert.equal(count(s, "SELECT COUNT(*) FROM permission_requests"), 0);
});

test("a_prompt_from_a_run_that_has_let_go_of_its_thread_isnt_raised", async () => {
  const s = state();
  const p = db.insert_profile(s.db(), "personal", [], null);
  project(s, p, "kiwicd", "KIW");
  const t = task(s, "kiwicd", "Work");
  const run = db.insert_run(s.db(), t.id, "prompt");
  db.run(s.db(), "UPDATE runs SET status='running' WHERE id=?1", run.id);
  s.update_task(t.id, [["status", "in_review"]]);
  // The run is ending (runner::finish has let go of the thread and expired its prompts, but not yet marked it exited)
  // as its prompt comes in.
  const prompt = (call_id: string): McpCall => ({
    task_fields: true,
    run_id: run.id,
    call_id,
    tool: "permission_prompt",
    args: { tool_name: "Bash", input: { command: "make" } },
  });
  const e = await err(handle_mcp(s, prompt("p1")));
  assert.ok(e.includes("run has ended"), e);
  assert.equal(db.get_task(s.db(), t.id)!.status, "in_review");
  assert.equal(count(s, "SELECT COUNT(*) FROM permission_requests"), 0);
  // While it holds the thread, it's asked.
  s.runs.set(t.id, { run_id: run.id, cancel: null });
  const asking = handle_mcp(s, prompt("p2"));
  await until(() => db.get_task(s.db(), t.id)!.status === "needs_attention", "the prompt");
  permissions.expire_for_task(s, t.id);
  assert.equal((await asking).behavior, "deny");
});

test("a_thread_in_plan_mode_only_reads_the_board", async () => {
  const s = state();
  const p = db.insert_profile(s.db(), "personal", [], null);
  project(s, p, "kiwicd", "KIW");
  const planner = task(s, "kiwicd", "Plan");
  s.update_task(planner.id, [["permission_mode", "plan"]]);
  const run = db.insert_run(s.db(), planner.id, "prompt");
  const mcp = (call_id: string, tool: string, args: any): McpCall => ({ task_fields: true, run_id: run.id, call_id, tool, args });
  const refused: Array<[string, any]> = [
    ["create_task", { title: "Do it now", start: true }],
    ["send_to_task", { task_id: "KIW-1", message: "Go" }],
    ["update_task", { task_id: "KIW-1", status: "done" }],
    ["run_automation", { automation_id: "nightly" }],
  ];
  for (const [i, [tool, args]] of refused.entries()) {
    const e = await err(handle_mcp(s, mcp(`c${i}`, tool, args)));
    assert.ok(e.startsWith(`${tool} isn't available in plan mode`), e);
  }
  assert.equal(db.list_tasks_for_project(s.db(), "kiwicd", "task").length, 1);
  assert.equal(db.get_task(s.db(), planner.id)!.status, "todo");
  assert.equal((await handle_mcp(s, mcp("r1", "get_task", { task_id: "KIW-1" }))).title, "Plan");
  // Its plan approved, it carries on in another mode with them all.
  s.update_task(planner.id, [["permission_mode", null]]);
  await handle_mcp(s, mcp("t1", "create_task", { title: "Follow-up" }));
  assert.equal(db.list_tasks_for_project(s.db(), "kiwicd", "task").length, 2);
  // As does a thread that inherits plan mode from its project.
  db.update_project(s.db(), "kiwicd", [["permission_mode", "plan"]]);
  const e = await err(handle_mcp(s, mcp("c9", "create_task", { title: "Another" })));
  assert.ok(e.startsWith("create_task isn't available in plan mode"), e);
});

test("a_review_thread_isnt_a_task_by_its_id_either", async () => {
  const s = state();
  const p = db.insert_profile(s.db(), "personal", [], null);
  project(s, p, "kiwicd", "KIW");
  const reviewed = task(s, "kiwicd", "Reviewed");
  const thread = db.insert_task(s.db(), new_task(p, "review", { project_id: "kiwicd", kind: "review" }));
  db.update_task(s.db(), thread.id, [["parent_id", reviewed.id]]);
  const me = ctx(p);
  for (const [tool, args] of [["get_task", { task_id: thread.id }], ["send_to_task", { task_id: thread.id, message: "Approve it" }]] as Array<[string, any]>) {
    const e = await err(call(s, me, tool, args));
    assert.equal(e, `task ${thread.id}`, tool);
  }
  assert.equal(testing.messages(s.db(), thread.id).length, 0);
  assert.equal(db.get_task(s.db(), thread.id)!.queued_message, null);
  assert.equal((await call(s, me, "get_task", { task_id: reviewed.id })).title, "Reviewed");
});

test("a_project_name_with_a_colon_isnt_read_as_a_profile", async () => {
  const s = state();
  const p = db.insert_profile(s.db(), "personal", [], null);
  project(s, p, "kiwicd", "KIW");
  db.update_project(s.db(), "kiwicd", [["name", "Ops: infra"]]);
  const me = ctx(p);
  assert.equal((await call(s, me, "get_project", { project_id: "Ops: infra" })).key, "KIW");
  // A profile's name still qualifies a key, and one that doesn't let the caller in says so.
  assert.equal((await call(s, me, "get_project", { project_id: "personal:KIW" })).key, "KIW");
  // Even if a profile is called Ops, whether it lets the caller in or not.
  const ops = db.insert_profile(s.db(), "ops", [], null);
  assert.equal((await call(s, me, "get_project", { project_id: "Ops: infra" })).key, "KIW");
  const e = await err(call(s, me, "get_project", { project_id: "ops:KIW" }));
  assert.ok(e.includes("doesn't let agents in profile personal"), e);
  grant(s, ops, ["personal"]);
  assert.equal((await call(s, me, "get_project", { project_id: "Ops: infra" })).key, "KIW");
});

test("a_guessed_argument_name_says_what_the_tool_takes", async () => {
  const s = state();
  const p = db.insert_profile(s.db(), "personal", [], null);
  project(s, p, "kiwicd", "KIW");
  const own = task(s, "kiwicd", "Plan");
  const run = db.insert_run(s.db(), own.id, "prompt");
  const mcp = (call_id: string, tool: string, args: any): McpCall => ({ task_fields: true, run_id: run.id, call_id, tool, args });
  // An agent that never loaded the schema guessed `task` and got "not found: task ".
  let e = await err(handle_mcp(s, mcp("c1", "get_task", { task: "KIW-1" })));
  assert.ok(e.startsWith('get_task has no argument "task"; its arguments are ') && e.includes("task_id"), e);
  e = await err(handle_mcp(s, mcp("c2", "update_task", { status: "done" })));
  assert.ok(e.startsWith("update_task needs task_id"), e);
  // `project` was ignored, so the task went to the caller's project whatever was named.
  e = await err(handle_mcp(s, mcp("c3", "create_task", { title: "t", project: "OTHER" })));
  assert.ok(e.includes('no argument "project"'), e);
  assert.equal((await handle_mcp(s, mcp("c4", "get_task", { task_id: "KIW-1" }))).title, "Plan");
  assert.equal(db.list_tasks_for_project(s.db(), "kiwicd", "task").length, 1);
});

test("a_call_cut_short_by_a_restart_doesnt_run_again", async () => {
  const s = state();
  const p = db.insert_profile(s.db(), "personal", [], null);
  project(s, p, "kiwicd", "KIW");
  const planner = task(s, "kiwicd", "Plan");
  const run = db.insert_run(s.db(), planner.id, "prompt");
  const mk = (id: string): McpCall => ({ task_fields: true, run_id: run.id, call_id: id, tool: "create_task", args: { title: "Child" } });
  const children = () => count(s, "SELECT COUNT(*) FROM tasks WHERE title='Child'");
  // The server goes down after creating the task, before recording that it did.
  testing.when("mcp:executed", () => {
    throw new Error("the server stopped");
  });
  await assert.rejects(handle_mcp(s, mk("c1")), /the server stopped/);
  assert.equal(children(), 1);
  // The helper retries the call with its id once the server is back.
  const e = await err(handle_mcp(s, mk("c1")));
  assert.ok(e.includes("interrupted"), e);
  assert.equal(children(), 1);
  // A call that can safely run again does.
  const get = (): McpCall => ({ task_fields: true, run_id: run.id, call_id: "c2", tool: "get_task", args: { task_id: "KIW-1" } });
  testing.when("mcp:executed", () => {
    throw new Error("the server stopped");
  });
  await assert.rejects(handle_mcp(s, get()));
  assert.equal((await handle_mcp(s, get())).title, "Plan");
});

test("a_call_the_board_cant_record_isnt_run", async () => {
  const s = state();
  const p = db.insert_profile(s.db(), "personal", [], null);
  project(s, p, "kiwicd", "KIW");
  const planner = task(s, "kiwicd", "Plan");
  const run = db.insert_run(s.db(), planner.id, "prompt");
  const mk = (): McpCall => ({ task_fields: true, run_id: run.id, call_id: "c1", tool: "create_task", args: { title: "Child" } });
  const children = () => count(s, "SELECT COUNT(*) FROM tasks WHERE title='Child'");
  // Recording it fails (a full disk, say), twice.
  s.db().exec("CREATE TRIGGER no_calls BEFORE INSERT ON mcp_calls BEGIN SELECT RAISE(ABORT, 'disk full'); END");
  for (let i = 0; i < 2; i++) {
    const e = await err(handle_mcp(s, mk()));
    assert.ok(e.includes("couldn't record") && e.includes("disk full"), e);
  }
  assert.equal(children(), 0);
  // So does finding out whether it ran.
  s.db().exec("DROP TRIGGER no_calls; ALTER TABLE mcp_calls RENAME TO calls");
  assert.ok((await err(handle_mcp(s, mk()))).includes("couldn't record"));
  assert.equal(children(), 0);
  s.db().exec("ALTER TABLE calls RENAME TO mcp_calls");
  await handle_mcp(s, mk());
  assert.equal(children(), 1);
});

test("an_approval_cut_short_by_a_restart_is_still_waited_for", async () => {
  const s = state();
  const p = db.insert_profile(s.db(), "personal", [], null);
  project(s, p, "kiwicd", "KIW");
  const caller = task(s, "kiwicd", "Caller");
  const run = started_run(s, caller.id);
  const mk = (id: string, script: string): McpCall => ({ task_fields: true, run_id: run.id, call_id: id, tool: "update_project", args: { setup_script: script } });
  const script = () => db.get_project(s.db(), "kiwicd")!.setup_script;
  // The server restarts while the user is asked; retried, the call waits for their answer and makes the change once.
  await cut_short(s, "c1", () => handle_mcp(s, mk("c1", "npm ci")));
  let [res] = await Promise.all([settle(handle_mcp(s, mk("c1", "npm ci"))), answer_approval(s, true)]);
  unwrap(res);
  assert.equal(script(), "npm ci");
  assert.equal((await handle_mcp(s, mk("c1", "npm ci"))).setup_script, "npm ci");
  // Denied before the retry: still nothing changed.
  await cut_short(s, "c2", () => handle_mcp(s, mk("c2", "make")));
  await answer_approval(s, false);
  assert.ok((await err(handle_mcp(s, mk("c2", "make")))).includes("didn't approve"));
  assert.equal(script(), "npm ci");
  // Approved before the retry: the change may have been made as the server stopped, so it isn't made again.
  await cut_short(s, "c3", () => handle_mcp(s, mk("c3", "make")));
  await answer_approval(s, true);
  assert.ok((await err(handle_mcp(s, mk("c3", "make")))).includes("interrupted"));
  // So does a deletion's.
  const [doomed, kept] = [task(s, "kiwicd", "Doomed"), task(s, "kiwicd", "Kept")];
  const del = (id: string, key: string): McpCall => ({ task_fields: true, run_id: run.id, call_id: id, tool: "delete_task", args: { task_id: key } });
  const exists = (t: Task) => db.get_task(s.db(), t.id) !== null;
  await cut_short(s, "c4", () => handle_mcp(s, del("c4", "KIW-2")));
  [res] = await Promise.all([settle(handle_mcp(s, del("c4", "KIW-2"))), answer_approval(s, true)]);
  assert.equal(unwrap(res).deleted, true);
  assert.ok(!exists(doomed));
  await cut_short(s, "c5", () => handle_mcp(s, del("c5", "KIW-3")));
  await answer_approval(s, true);
  assert.ok((await err(handle_mcp(s, del("c5", "KIW-3")))).includes("interrupted"));
  assert.ok(exists(kept));
});

function automations(s: Shared, project: string): au.Automation[] {
  return au.list(s.db(), project);
}

function webhook_args(name: string): any {
  return {
    name,
    trigger: { kind: "webhook", filters: [{ path: "event", op: "equals", value: "issues" }] },
    action: { kind: "create_task", title: "Triage: {{body.issue.title}}", description: "Look at {{body.issue.html_url}}", start: true },
    generate_secret: true,
    reason: "Triage new issues",
  };
}

test("agents_create_automations_only_once_the_user_approves", async () => {
  const s = state();
  const p = db.insert_profile(s.db(), "personal", [], null);
  project(s, p, "kiwicd", "KIW");
  project(s, p, "other", "OTH");
  // Even a thread that may do anything without asking asks first.
  const c0 = task(s, "kiwicd", "Caller");
  s.update_task(c0.id, [["permission_mode", "bypassPermissions"]]);
  const caller = db.get_task(s.db(), c0.id)!;
  const me = (call_id: string) => ctx(p, { task: caller, call_id });
  const elsewhere = task(s, "other", "Elsewhere");

  // Denied: nothing is made.
  let [res, asked] = await Promise.all([settle(call(s, me("c1"), "create_automation", webhook_args("Triage"))), answer_approval(s, false)]);
  let e = unwrap_err(res);
  assert.ok(e.includes('didn\'t approve creating the automation "Triage", so nothing was created'), e);
  assert.equal(automations(s, "kiwicd").length, 0);
  // The approval shows what would run, and who asked.
  assert.deepEqual([asked.kind, asked.tool_name], ["automation", "create_automation"]);
  const input = asked.input;
  assert.deepEqual([input.op, input.project.key, input.task.key], ["create", "KIW", "KIW-1"]);
  assert.equal(input.reason, "Triage new issues");
  const a = input.automation;
  assert.deepEqual([a.name, a.enabled, a.signed], ["Triage", true, true]);
  assert.deepEqual([a.trigger.kind, a.trigger.filters[0].value], ["webhook", "issues"]);
  assert.deepEqual([a.action.title, a.action.start, a.action.status], ["Triage: {{body.issue.title}}", true, "todo"]);
  assert.equal(db.get_task(s.db(), caller.id)!.attention_reason, "Approve an automation?");
  // Only UIs that know automations are shown it.
  const shown = async () => {
    const x = await approval_asked(s);
    assert.equal(permissions.pending_approvals(s, true, false).length, 0);
    await answer_approval(s, true);
    return x;
  };
  // Approved: it's made as it was shown, with a new secret that's returned once.
  [res] = await Promise.all([settle(call(s, me("c2"), "create_automation", webhook_args("Triage"))), shown()]);
  const made_v = unwrap(res);
  const made = automations(s, "kiwicd");
  assert.equal(made.length, 1);
  assert.deepEqual([made[0].name, made[0].enabled], ["Triage", true]);
  assert.equal(made[0].secret, made_v.secret);
  assert.ok(typeof made_v.secret === "string" && made_v.secret.length > 20);
  assert.equal(made_v.hook_path, au.hook_path(made[0]));
  assert.equal(typeof made_v.webhook_note, "string");
  // With the host's public address, the full URL.
  db.set_setting(s.db(), "public_url", "https://board.example.com");
  const list = await call(s, me("c3"), "list_automations", {});
  assert.equal(list.automations[0].webhook_url, `https://board.example.com${au.hook_path(made[0])}`);
  assert.equal(list.automations[0].secret, undefined);

  // A message goes to a task named by key, and only one of the project's own.
  const message = (t: string) => ({
    name: "Nudge",
    trigger: { kind: "daily", time: "9:00", weekdays: ["fri", "mon"] },
    action: { kind: "send_to_task", task_id: t, message: "Anything new?" },
  });
  e = await err(call(s, me("c4"), "create_automation", message(`OTH-${elsewhere.number}`)));
  assert.ok(e.includes("only send messages to tasks in its own project"), e);
  e = await err(call(s, me("c5"), "create_automation", message("KIW-99")));
  assert.ok(e.includes("not found"), e);
  // Bad settings are refused before the user is asked.
  const fast: any = { ...message("KIW-1"), trigger: { kind: "interval", every_minutes: 1 } };
  assert.ok((await err(call(s, me("c6"), "create_automation", fast))).includes("every_minutes"));
  const signed: any = { ...message("KIW-1"), generate_secret: true };
  assert.ok((await err(call(s, me("c7"), "create_automation", signed))).includes("only a webhook"));
  assert.equal(permissions.pending_approvals(s, true, true).length, 0);
  [res, asked] = await Promise.all([settle(call(s, me("c8"), "create_automation", message("KIW-1"))), answer_approval(s, true)]);
  unwrap(res);
  const view = asked.input.automation;
  assert.deepEqual([view.target.key, view.target.title], ["KIW-1", "Caller"]);
  assert.deepEqual(view.trigger, { kind: "daily", time: "09:00", weekdays: ["mon", "fri"] });
  assert.equal(view.action.task_id, caller.id);
  assert.equal(automations(s, "kiwicd").length, 2);

  // An agent on another host has no thread here to ask in.
  const remote = { ...webhook_args("Remote"), project_id: "KIW" };
  e = await err(call(s, ctx(p), "create_automation", remote));
  assert.ok(e.includes('creating the automation "Remote" needs the user\'s approval'), e);
  assert.equal(automations(s, "kiwicd").length, 2);
});

test("agents_change_run_and_delete_automations", async () => {
  const s = state();
  const p = db.insert_profile(s.db(), "personal", [], null);
  project(s, p, "kiwicd", "KIW");
  const caller = task(s, "kiwicd", "Caller");
  const me = (call_id: string) => ctx(p, { task: caller, call_id });
  const body = { name: "Weekly", trigger: { kind: "interval", every_minutes: 60 }, action: { kind: "create_task", title: "Update deps {{date}}" } };
  const a = au.create(s, "kiwicd", body);
  const get = () => au.get(s.db(), a.id)!;

  // Turning it off or renaming it isn't asked about.
  let res: any = await call(s, me("c1"), "update_automation", { automation_id: "weekly", enabled: false, name: "Weekly deps" });
  assert.deepEqual([res.enabled, res.name], [false, "Weekly deps"]);
  assert.equal(permissions.pending_approvals(s, true, true).length, 0);
  assert.ok((await err(call(s, me("c2"), "update_automation", { automation_id: a.id, enabled: false }))).includes("nothing to change"));
  // Turning it on is.
  let asked: any;
  [res, asked] = await Promise.all([settle(call(s, me("c3"), "update_automation", { automation_id: a.id, enabled: true })), answer_approval(s, false)]);
  assert.ok(unwrap_err(res).includes('didn\'t approve changing the automation "Weekly deps"'));
  assert.ok(!get().enabled);
  assert.deepEqual(asked.input.changes, ["enabled"]);
  // So is a new action; only what it changes is changed, though the user renames it meanwhile.
  const change = { automation_id: a.id, name: "Weekly deps", action: { kind: "create_task", title: "Bump deps", status: "backlog" } };
  const approve = async () => {
    const x = await approval_asked(s);
    au.update(s, a.id, { name: "Deps" });
    await answer_approval(s, true);
    return x;
  };
  [res, asked] = await Promise.all([settle(call(s, me("c4"), "update_automation", change)), approve()]);
  unwrap(res);
  const input = asked.input;
  assert.deepEqual([input.op, input.changes], ["update", ["action"]]);
  assert.deepEqual([input.before.action.title, input.automation.action.title], ["Update deps {{date}}", "Bump deps"]);
  assert.equal(input.automation.action.status, "backlog");
  const now_a: any = get();
  assert.equal(now_a.name, "Deps");
  assert.ok(now_a.action.kind === "create_task" && now_a.action.title === "Bump deps" && now_a.action.status === "backlog");

  // Run now makes its task.
  const run = await call(s, me("c5"), "run_automation", { automation_id: "Deps" });
  assert.equal(run.status, "ok", JSON.stringify(run));
  assert.equal(db.get_task(s.db(), run.task_id)!.title, "Bump deps");

  // Deleted by the user while an agent asks to change it: the question goes, and the call says so.
  const del = async () => {
    await approval_asked(s);
    au.delete(s, a.id);
  };
  [res] = await Promise.all([settle(call(s, me("c6"), "update_automation", { automation_id: a.id, trigger: { kind: "interval", every_minutes: 30 } })), del()]);
  assert.ok(unwrap_err(res).includes("was deleted meanwhile"));
  assert.equal(permissions.pending_approvals(s, true, true).length, 0);

  // Deleting one is asked about too.
  const b = au.create(s, "kiwicd", body);
  [res, asked] = await Promise.all([settle(call(s, me("c7"), "delete_automation", { automation_id: b.id, reason: "Not needed" })), answer_approval(s, false)]);
  assert.ok(unwrap_err(res).includes('didn\'t approve deleting the automation "Weekly"'));
  assert.deepEqual([asked.input.op, asked.input.reason], ["delete", "Not needed"]);
  assert.equal(automations(s, "kiwicd").length, 1);
  assert.equal(db.get_task(s.db(), caller.id)!.attention_reason, "Delete an automation?");
  [res] = await Promise.all([settle(call(s, me("c8"), "delete_automation", { automation_id: "Weekly" })), answer_approval(s, true)]);
  assert.equal(unwrap(res).deleted, true);
  assert.equal(automations(s, "kiwicd").length, 0);
});

test("agents_only_reach_automations_on_boards_they_can_use", async () => {
  const s = state();
  const me_p = db.insert_profile(s.db(), "personal", [], null);
  const work = db.insert_profile(s.db(), "work", [], null);
  project(s, me_p, "kiwicd", "KIW");
  project(s, work, "secret", "SEC");
  const body = { name: "Nightly", trigger: { kind: "daily", time: "02:00" }, action: { kind: "create_task", title: "Nightly" } };
  const theirs = au.create(s, "secret", body);
  const caller = task(s, "kiwicd", "Caller");
  const c = ctx(me_p, { task: caller, call_id: "c1" });
  // Not found here, as if it weren't there (so linked hosts are asked instead).
  const not_found = async (tool: string, args: any) => {
    try {
      const v = await local(s, c, tool, args);
      assert.fail(`${tool}: ${JSON.stringify(v)}`);
    } catch (e: any) {
      assert.ok(e instanceof ToolError && e.kind === "NotFound", `${tool}: ${e?.message}`);
    }
  };
  await not_found("list_automations", { project_id: "SEC" });
  await not_found("list_automations", { project_id: "work:SEC" });
  await not_found("create_automation", { project_id: "SEC", name: "x", trigger: body.trigger, action: body.action });
  for (const tool of ["update_automation", "delete_automation", "run_automation"]) {
    const args: any = { automation_id: theirs.id };
    if (tool === "update_automation") args.enabled = false;
    await not_found(tool, args);
  }
  assert.ok(au.get(s.db(), theirs.id)!.enabled);
  assert.equal(au.runs(s.db(), theirs.id, 10).length, 0);
  assert.equal(permissions.pending_approvals(s, true, true).length, 0);
  // A task of theirs can't be messaged from an automation here, by id either.
  const hidden = task(s, "secret", "Hidden");
  const msg_args = { name: "x", trigger: body.trigger, action: { kind: "send_to_task", task_id: hidden.id, message: "hi" } };
  assert.ok((await err(call(s, c, "create_automation", msg_args))).includes(`task ${hidden.id} not found in KIW`));
  // Once their board lets this profile's agents in, its automations are there to use.
  grant(s, work, ["personal"]);
  const list = await call(s, c, "list_automations", { project_id: "SEC" });
  assert.equal(list.automations[0].id, theirs.id);
  // And a message still only goes to a task in the automation's own project.
  assert.ok((await err(call(s, c, "create_automation", msg_args))).includes("its own project"));
  // Older hosts aren't sent automation calls.
  assert.ok(too_old("laptop", 66, "create_automation", {})?.includes("without the automation tools"));
  assert.equal(too_old("laptop", 67, "list_automations", {}), null);
});

test("an_automation_approval_cut_short_by_a_restart_is_still_waited_for", async () => {
  const s = state();
  const p = db.insert_profile(s.db(), "personal", [], null);
  project(s, p, "kiwicd", "KIW");
  const caller = task(s, "kiwicd", "Caller");
  const run = started_run(s, caller.id);
  const mk = (id: string, args: any): McpCall => ({ task_fields: true, run_id: run.id, call_id: id, tool: "create_automation", args });
  const asks = () => count(s, "SELECT COUNT(*) FROM permission_requests WHERE kind='automation'");
  // The server restarts while the user is asked; retried (even with other arguments), the call waits for the same
  // answer and makes what it asked about, once.
  await cut_short(s, "c1", () => handle_mcp(s, mk("c1", webhook_args("Triage"))));
  const [res] = await Promise.all([settle(handle_mcp(s, mk("c1", webhook_args("Other")))), answer_approval(s, true)]);
  assert.equal(unwrap(res).name, "Triage");
  assert.deepEqual([asks(), automations(s, "kiwicd").length], [1, 1]);
  assert.equal((await handle_mcp(s, mk("c1", webhook_args("Triage")))).name, "Triage");
  assert.equal(automations(s, "kiwicd").length, 1);
  // Denied before the retry: nothing is made.
  await cut_short(s, "c2", () => handle_mcp(s, mk("c2", webhook_args("Second"))));
  await answer_approval(s, false);
  assert.ok((await err(handle_mcp(s, mk("c2", webhook_args("Second"))))).includes("didn't approve"));
  assert.equal(automations(s, "kiwicd").length, 1);
  // Approved before the retry: it may have been made as the server stopped, so it isn't made again.
  await cut_short(s, "c3", () => handle_mcp(s, mk("c3", webhook_args("Third"))));
  await answer_approval(s, true);
  assert.ok((await err(handle_mcp(s, mk("c3", webhook_args("Third"))))).includes("interrupted"));
  assert.equal(automations(s, "kiwicd").length, 1);
  assert.equal(asks(), 3);
});

// ---------- workflows (HA-173, ported by HA-189) ----------

const MOVE_GRAPH = {
  nodes: [
    { id: "t", kind: "trigger", on: "manual" },
    { id: "m", kind: "set_status", status: "backlog" },
  ],
  edges: [{ from: "t", port: "out", to: "m" }],
};

test("agents_create_change_run_and_delete_workflows_once_the_user_approves", async () => {
  const s = state();
  const p = db.insert_profile(s.db(), "personal", [], null);
  project(s, p, "kiwicd", "KIW");
  const caller = task(s, "kiwicd", "Caller");
  const me = (call_id: string) => ctx(p, { task: caller, call_id });
  const workflows = () => wf.list(s.db(), "kiwicd");
  const args = { name: "Park", graph: MOVE_GRAPH, reason: "Park tasks" };

  // Denied: nothing is made. The approval shows the workflow, and isn't shown to UIs from before workflows: its thread
  // message says `workflow`, which they draw as a tool's prompt (they'd draw an `automation` as one, and crash on it).
  const shown = async (allow: boolean) => {
    const x = await approval_asked(s);
    assert.equal(permissions.pending_approvals(s, true, true).length, 0);
    assert.equal(permissions.pending_approvals(s, true, true, true).length, 1);
    const asking = testing.messages(s.db(), caller.id).filter((m: any) => m.kind === "permission").at(-1) as any;
    assert.deepEqual([asking.data.kind, asking.data.request_id], ["workflow", x.request_id]);
    await answer_approval(s, allow);
    return x;
  };
  let [res, asked] = await Promise.all([settle(call(s, me("c1"), "create_workflow", args)), shown(false)]);
  assert.ok(unwrap_err(res).includes('didn\'t approve creating the workflow "Park", so nothing was created'), unwrap_err(res));
  assert.equal(workflows().length, 0);
  assert.deepEqual([asked.kind, asked.tool_name, asked.input.op, asked.input.reason], ["automation", "create_workflow", "create", "Park tasks"]);
  assert.deepEqual([asked.input.workflow.name, asked.input.workflow.graph.nodes.length], ["Park", 2]);
  assert.equal(db.get_task(s.db(), caller.id)!.attention_reason, "Approve a workflow?");
  // A graph that doesn't check out isn't asked about.
  const looped = { nodes: MOVE_GRAPH.nodes, edges: [...MOVE_GRAPH.edges, { from: "m", port: "out", to: "m" }] };
  assert.ok((await err(call(s, me("c2"), "create_workflow", { name: "Bad", graph: looped }))).includes("loop through m"));
  // Approved: it's made as it was shown.
  [res] = await Promise.all([settle(call(s, me("c3"), "create_workflow", args)), shown(true)]);
  const made = unwrap(res);
  assert.deepEqual([made.name, made.enabled, workflows().length], ["Park", true, 1]);
  const list = await call(s, me("c4"), "list_workflows", {});
  assert.deepEqual([list.project.key, list.workflows[0].id], ["KIW", made.id]);

  // Turning it off or renaming it isn't asked about; turning it on is.
  const off = await call(s, me("c5"), "update_workflow", { workflow_id: "park", enabled: false, name: "Parking" });
  assert.deepEqual([off.enabled, off.name], [false, "Parking"]);
  assert.equal(permissions.pending_approvals(s, true, true, true).length, 0);
  assert.ok((await err(call(s, me("c6"), "update_workflow", { workflow_id: made.id, enabled: false }))).includes("nothing to change"));
  [res, asked] = await Promise.all([settle(call(s, me("c7"), "update_workflow", { workflow_id: made.id, enabled: true })), answer_approval(s, false)]);
  assert.ok(unwrap_err(res).includes('didn\'t approve changing the workflow "Parking"'));
  assert.deepEqual(asked.input.changes, ["enabled"]);
  assert.ok(!wf.get(s.db(), made.id)!.enabled);

  // Run by hand on a task of its project, on or off.
  const target = task(s, "kiwicd", "Target");
  const run = await call(s, me("c8"), "run_workflow", { workflow_id: "Parking", task_id: `KIW-${target.number}` });
  assert.deepEqual([run.state, run.workflow_name, run.source], ["done", "Parking", "manual"]);
  assert.equal(db.get_task(s.db(), target.id)!.status, "backlog");
  // get_task shows the task's latest runs.
  const details = await call(s, me("c9"), "get_task", { task_id: `KIW-${target.number}` });
  assert.deepEqual(details.workflows, [{ workflow: "Parking", state: "done", started_at: run.created_at, steps: [] }]);

  // Deleted by the user while an agent asks to change it: the question goes, and the call says so.
  const del = async () => {
    await approval_asked(s);
    wf.delete(s, made.id);
  };
  [res] = await Promise.all([settle(call(s, me("c10"), "update_workflow", { workflow_id: made.id, graph: { ...MOVE_GRAPH, nodes: [MOVE_GRAPH.nodes[0]], edges: [] } })), del()]);
  assert.ok(unwrap_err(res).includes("was deleted meanwhile"), unwrap_err(res));
  assert.equal(permissions.pending_approvals(s, true, true, true).length, 0);

  // Deleting one is asked about too.
  const again = wf.create(s, "kiwicd", { name: "Park", graph: MOVE_GRAPH });
  [res, asked] = await Promise.all([settle(call(s, me("c11"), "delete_workflow", { workflow_id: again.id, reason: "Not needed" })), answer_approval(s, true)]);
  assert.equal(unwrap(res).deleted, true);
  assert.deepEqual([asked.input.op, asked.input.reason], ["delete", "Not needed"]);
  assert.equal(workflows().length, 0);
});

test("agents_only_reach_workflows_on_boards_they_can_use", async () => {
  const s = state();
  const me_p = db.insert_profile(s.db(), "personal", [], null);
  const work = db.insert_profile(s.db(), "work", [], null);
  project(s, me_p, "kiwicd", "KIW");
  project(s, work, "secret", "SEC");
  const theirs = wf.create(s, "secret", { name: "Park", graph: MOVE_GRAPH });
  const hidden = task(s, "secret", "Hidden");
  const caller = task(s, "kiwicd", "Caller");
  const c = ctx(me_p, { task: caller, call_id: "c1" });
  const not_found = async (tool: string, args: any) => {
    try {
      const v = await local(s, c, tool, args);
      assert.fail(`${tool}: ${JSON.stringify(v)}`);
    } catch (e: any) {
      assert.ok(e instanceof ToolError && e.kind === "NotFound", `${tool}: ${e?.message}`);
    }
  };
  await not_found("list_workflows", { project_id: "SEC" });
  await not_found("create_workflow", { project_id: "SEC", name: "x", graph: MOVE_GRAPH });
  await not_found("update_workflow", { workflow_id: theirs.id, enabled: false });
  await not_found("delete_workflow", { workflow_id: theirs.id });
  await not_found("run_workflow", { workflow_id: theirs.id, task_id: hidden.id });
  assert.ok(wf.get(s.db(), theirs.id)!.enabled);
  assert.equal(db.get_task(s.db(), hidden.id)!.status, "todo");
  // A workflow of this board's doesn't run on another project's task.
  const mine = wf.create(s, "kiwicd", { name: "Mine", graph: MOVE_GRAPH });
  grant(s, work, ["personal"]);
  assert.ok((await err(call(s, c, "run_workflow", { workflow_id: mine.id, task_id: hidden.id }))).includes("isn't in KIW"));
  // Older hosts aren't sent workflow calls.
  assert.ok(too_old("laptop", 106, "list_workflows", {})?.includes("without workflows"));
  assert.equal(too_old("laptop", 107, "list_workflows", {}), null);
});

// ---------- routines (HA-122, ported by HA-205) ----------

test("the_assistant_sets_up_routines_once_the_user_approves", async () => {
  const s = state();
  const p = db.insert_profile(s.db(), "personal", [], null);
  project(s, p, "kiwicd", "KIW");
  const mine = assistant.get_or_create(s, p.id);
  const me = (call_id: string) => ctx(p, { task: mine, call_id });
  const remind = {
    name: "Call Sam",
    trigger: { kind: "at", at: new Date(Date.now() + 86_400_000).toISOString() },
    action: { kind: "message_assistant", mode: "thread", message: "Remind the user to call Sam." },
    reason: "The user asked to be reminded",
  };
  const [res, asked] = await Promise.all([call(s, me("c1"), "create_automation", remind), answer_approval(s, true)]);
  const made = res;
  // The approval names the profile, not a project.
  const input = asked.input;
  assert.deepEqual([input.profile?.id, input.project ?? null], [p.id, null], JSON.stringify(input));
  assert.equal(input.automation.action.kind, "message_assistant");
  assert.deepEqual([made.profile_id, made.project_id], [p.id, null], JSON.stringify(made));
  // The assistant lists its routines without saying so; a project's agent asks for them.
  const listed = await call(s, me("c2"), "list_automations", {});
  assert.equal(listed.routines[0].name, "Call Sam");
  const worker = task(s, "kiwicd", "Worker");
  const theirs = ctx(p, { task: worker, call_id: "c3" });
  assert.deepEqual((await call(s, theirs, "list_automations", {})).automations, []);
  assert.equal((await call(s, theirs, "list_automations", { routines: true })).routines[0].name, "Call Sam");
  // Changing what it does asks; by name among the routines.
  const change = { automation_id: "call sam", precheck: "test -f flag", budget_usd: 0.5 };
  const [res2, asked2] = await Promise.all([call(s, me("c4"), "update_automation", change), answer_approval(s, true)]);
  assert.equal(res2.precheck, "test -f flag");
  assert.deepEqual(asked2.input.changes, ["budget_usd", "precheck"]);
  // A routine can't make tasks.
  const bad = { name: "x", routines: true, trigger: { kind: "interval", every_minutes: 60 }, action: { kind: "create_task", title: "x" } };
  assert.ok((await err(call(s, me("c5"), "create_automation", bad))).includes("only message the assistant"));

  // Another profile's agents can't reach it, even with access to this board.
  const work = db.insert_profile(s.db(), "work", [], null);
  grant(s, p, ["work"]);
  const id = made.id;
  assert.equal(await err(call(s, ctx(work), "run_automation", { automation_id: id })), `automation ${id}`);
  const e = await err(call(s, ctx(work), "list_automations", { routines: true, profile: "personal" }));
  assert.ok(e.includes("its own profile"), e);
});

// ---------- the assistant's approval rules on the board's own tools (HA-123, ported by HA-206) ----------

test("the_assistants_rules_can_make_creating_a_task_ask_first_whatever_its_mode", async () => {
  const s = state();
  const p = db.insert_profile(s.db(), "personal", [], null);
  project(s, p, "kiwicd", "KIW");
  const mine = assistant.get_or_create(s, p.id);
  db.update_task(s.db(), mine.id, [["permission_mode", "bypassPermissions"]]);
  approval_rules.set(s.db(), p.id, {
    rules: [{ tool: "mcp__huntaway__create_task", decision: "ask" }, { tool: "mcp__huntaway__delete_task", decision: "never" }],
    expiry_minutes: 30,
  });
  const run = started_run(s, mine.id);
  const mcp = (call_id: string, tool: string, args: any): McpCall => ({ task_fields: true, run_id: run.id, call_id, tool, args });
  const titles = () => db.list_tasks_for_project(s.db(), "kiwicd", "task").map((t) => t.title);
  const next_prompt = async () => {
    let p: any;
    await until(() => (p = permissions.pending(s, mine.id).pop()) !== undefined, "a prompt");
    return p;
  };

  // Asked, and denied: no task.
  const denied = handle_mcp(s, mcp("c1", "create_task", { project_id: "kiwicd", title: "Book flights" }));
  denied.catch(() => {});
  let request = await next_prompt();
  assert.deepEqual([request.tool_name, request.rule], ["mcp__huntaway__create_task", "mcp__huntaway__create_task"]);
  permissions.decide(s, request.id, false, false, null);
  await err(denied);
  assert.deepEqual(titles(), []);

  // Asked, and allowed: made.
  const allowed = handle_mcp(s, mcp("c2", "create_task", { project_id: "kiwicd", title: "Book flights" }));
  request = await next_prompt();
  permissions.decide(s, request.id, true, false, null);
  await allowed;
  assert.deepEqual(titles(), ["Book flights"]);

  // Never: refused without asking.
  const t = db.list_tasks_for_project(s.db(), "kiwicd", "task")[0];
  const e = await err(handle_mcp(s, mcp("c3", "delete_task", { task_id: t.id })));
  assert.ok(e.startsWith(approval_rules.BLOCKED), e);
  assert.deepEqual(
    approval_rules.list(s.db(), p.id, 10).map((a) => [a.tool_name, a.outcome]),
    [["mcp__huntaway__delete_task", "blocked"], ["mcp__huntaway__create_task", "allowed"], ["mcp__huntaway__create_task", "denied"]],
  );
  // Other tools are as they were.
  await handle_mcp(s, mcp("c4", "list_projects", {}));
});

/** The profile's assistant, in Bypass, with `rules`, and a run of it that's going. */
function ruled_assistant(s: Shared, p: db.Profile, rules: Array<[string, Decision]>): [Task, db.Run] {
  const a = assistant.get_or_create(s, p.id);
  const mine = db.update_task(s.db(), a.id, [["permission_mode", "bypassPermissions"]])!;
  approval_rules.set(s.db(), p.id, { rules: rules.map(([tool, decision]) => ({ tool, decision })), expiry_minutes: 30 });
  return [mine, started_run(s, mine.id)];
}

/** The next prompt an approval rule raised in `task_id`'s thread, once there is one. */
async function rule_asked(s: Shared, task_id: string): Promise<any> {
  let p: any;
  await until(() => (p = permissions.pending(s, task_id).find((x) => x.rule != null)) !== undefined, "a rule to ask");
  return p;
}

test("an_ask_rule_on_the_whole_board_leaves_tools_that_ask_for_themselves_to_ask_once", async () => {
  const s = state();
  const p = db.insert_profile(s.db(), "personal", [], null);
  project(s, p, "kiwicd", "KIW");
  const doomed = task(s, "kiwicd", "Doomed");
  const [mine, run] = ruled_assistant(s, p, [["mcp__huntaway", "ask"]]);
  const mcp = (call_id: string, tool: string, args: any): McpCall => ({ task_fields: true, run_id: run.id, call_id, tool, args });
  const ruled = () => db.value<number>(s.db(), "SELECT COUNT(*) FROM permission_requests WHERE rule IS NOT NULL");

  // delete_task asks with its own card, which shows what's deleted, and does it once that's approved.
  const [, a] = await Promise.all([handle_mcp(s, mcp("d", "delete_task", { task_id: doomed.id })), answer_approval(s, true)]);
  assert.deepEqual([a.kind, a.input.delete.key, a.input.tasks_with_it], ["delete_task", "KIW-1", []]);
  assert.equal(db.get_task(s.db(), doomed.id), null);
  // Its one card is the rule's asking: it's in the action log, answered.
  assert.deepEqual(a.rule, { tool: "mcp__huntaway", decision: "ask" });
  assert.equal(ruled(), 1, "delete_task was asked about twice");
  const log = approval_rules.list(s.db(), p.id, 10);
  assert.deepEqual([log[0].tool_name, log[0].rule, log[0].outcome, log[0].answered_by], ["mcp__huntaway__delete_task", "mcp__huntaway", "allowed", "user"]);

  // update_project asks for some settings only: the rule asks first, then the change is approved as ever.
  const answer_both = async () => {
    const r = await rule_asked(s, mine.id);
    assert.equal(r.tool_name, "mcp__huntaway__update_project");
    permissions.decide(s, r.id, true, false, null);
    return answer_approval(s, true);
  };
  const [res, a2] = await Promise.all([handle_mcp(s, mcp("u", "update_project", { project_id: "kiwicd", setup_script: "make deps" })), answer_both()]);
  assert.equal(res.setup_script, "make deps");
  assert.equal(a2.kind, "project");
  assert.equal(db.get_project(s.db(), "kiwicd")!.setup_script, "make deps");
  // And a setting that needs no approval is asked about by the rule alone.
  const answer_rule = async () => {
    const r = await rule_asked(s, mine.id);
    permissions.decide(s, r.id, true, false, null);
  };
  const [res2] = await Promise.all([handle_mcp(s, mcp("g", "update_project", { project_id: "kiwicd", group_name: "Birds" })), answer_rule()]);
  assert.equal(res2.group_name, "Birds");

  // A never rule still refuses a tool that asks for itself.
  const [, run2] = ruled_assistant(s, p, [["mcp__huntaway__delete_task", "never"]]);
  const other = task(s, "kiwicd", "Kept");
  const e = await err(handle_mcp(s, { task_fields: true, run_id: run2.id, call_id: "d2", tool: "delete_task", args: { task_id: other.id } }));
  assert.ok(e.startsWith(approval_rules.BLOCKED), e);
  assert.ok(db.get_task(s.db(), other.id));
});

test("rules_hold_for_wait_and_its_command", async () => {
  const s = state();
  const p = db.insert_profile(s.db(), "personal", [], null);
  const marker = join(testing.temp_dir(), "ran");
  const wait = (call_id: string, run: db.Run): McpCall => ({
    task_fields: true, run_id: run.id, call_id, tool: "wait", args: { reason: "r", seconds: 5, command: `touch '${marker}'` },
  });
  // Never: refused, and its command doesn't run, in Bypass.
  let [, run] = ruled_assistant(s, p, [["mcp__huntaway__wait", "never"]]);
  assert.ok((await err(handle_mcp(s, wait("w1", run)))).startsWith(approval_rules.BLOCKED));
  assert.ok(!existsSync(marker));
  // An older name of the board's server holds too.
  [, run] = ruled_assistant(s, p, [["mcp__issue_agent__wait", "never"]]);
  await err(handle_mcp(s, wait("w2", run)));
  assert.ok(!existsSync(marker));

  // Ask, denied: nothing runs.
  let mine: Task;
  [mine, run] = ruled_assistant(s, p, [["mcp__huntaway__wait", "ask"]]);
  const deny = async () => {
    const r = await rule_asked(s, mine.id);
    assert.equal(r.tool_name, "mcp__huntaway__wait");
    permissions.decide(s, r.id, false, false, null);
  };
  await Promise.all([err(handle_mcp(s, wait("w3", run))), deny()]);
  assert.ok(!existsSync(marker));
  // Allowed: the wait goes on, and its command runs (Bypass allows it).
  const allow = async () => {
    const r = await rule_asked(s, mine.id);
    permissions.decide(s, r.id, true, false, null);
  };
  const [res] = await Promise.all([handle_mcp(s, wait("w4", run)), allow()]);
  assert.equal(res.ended, "command_exited");
  assert.ok(existsSync(marker));
  const log = approval_rules.list(s.db(), p.id, 10).map((a) => [a.tool_name, a.outcome]);
  assert.deepEqual(log.slice(0, 2), [["mcp__huntaway__wait", "allowed"], ["mcp__huntaway__wait", "denied"]]);
});

test("a_bash_rule_holds_for_a_waits_command_even_when_claudes_classifier_reviewed_the_wait", async () => {
  const s = state();
  const p = db.insert_profile(s.db(), "personal", [], null);
  const dir = testing.temp_dir();
  const marker = join(dir, "ran");
  // A Claude run in Auto mode: wait isn't in its --allowedTools, so Claude's classifier reviewed the call.
  const auto = (rules: Array<[string, Decision]>): [Task, db.Run] => {
    const [mine, run] = ruled_assistant(s, p, rules);
    db.update_task(s.db(), mine.id, [["permission_mode", "auto"]]);
    const run_dir = runs.run_dir(s, run.id);
    mkdirSync(run_dir, { recursive: true });
    const args = ["-p", "--permission-mode", "auto", "--allowedTools", "mcp__huntaway__list_tasks", "--add-dir", "/a"];
    writeFileSync(join(run_dir, "spec.json"), JSON.stringify({ cwd: dir, args }));
    assert.ok(runner.agent_reviews_waits(s, run.id));
    return [mine, run];
  };
  const wait = (call_id: string, run: db.Run): McpCall => ({
    task_fields: true, run_id: run.id, call_id, tool: "wait", args: { reason: "r", seconds: 5, command: `touch '${marker}'` },
  });
  // Never: the command doesn't run.
  let [mine, run] = auto([["Bash", "never"]]);
  const e = await err(handle_mcp(s, wait("w1", run)));
  assert.ok(e.includes(approval_rules.BLOCKED), e);
  assert.ok(!existsSync(marker));
  // Ask: the user answers, not the classifier.
  [mine, run] = auto([["Bash", "ask"]]);
  const deny = async () => {
    const r = await rule_asked(s, mine.id);
    assert.deepEqual([r.tool_name, typeof r.input.command], ["Bash", "string"]);
    permissions.decide(s, r.id, false, false, null);
  };
  await Promise.all([err(handle_mcp(s, wait("w2", run))), deny()]);
  assert.ok(!existsSync(marker));
  // No rule on Bash: the classifier's review stands, as before.
  [, run] = auto([["mcp__google__*send*", "ask"]]);
  assert.equal((await handle_mcp(s, wait("w3", run))).ended, "command_exited");
  assert.ok(existsSync(marker));
});
