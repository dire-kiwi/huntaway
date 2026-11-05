// Port of server/src/agent/assistant/tests.rs (HA-119, on the HA-117 branch).
import { test } from "node:test";
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
import { get_or_create, work_dir } from "../assistant.ts";

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

test("a_database_at_version_88_frees_the_key_a", () => {
  const path = join(testing.temp_dir(), "huntaway.db");
  {
    const c = db.open(path);
    const p = db.insert_profile(c, "p", [], null);
    db.insert_project(c, { id: "apps", profile_id: p.id, name: "Apps", key: "A", repo_path: "/x", scratch_path: "/s", worktrees_root: "/w", base_branch: null, use_worktrees: false });
    c.exec("DROP INDEX tasks_one_assistant; PRAGMA user_version=88;");
    c.close();
  }
  const c = db.open(path);
  assert.equal(db.get_project(c, "apps")!.key, "AP");
  assert.equal(Number(db.value(c, "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='tasks_one_assistant'")), 1);
  c.close();
});
