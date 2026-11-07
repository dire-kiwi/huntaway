// Pens (HA-285): the pen tools, `pen` on the task tools and the API, and each profile's pens thread.
import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { join } from "node:path";
import * as db from "../../db.ts";
import type { Shared } from "../../state.ts";
import * as api from "../../api.ts";
import * as pens from "../../agent/pens.ts";
import * as prompt from "../../agent/runner/prompt.ts";
import * as testing from "../../testing.ts";
import { msg, type Ctx } from "../tools.ts";
import { PENS_API, too_old } from "./dispatch.ts";
import { local } from "./local.ts";

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

function ctx(p: db.Profile): Ctx {
  return { profile_id: p.id, profile_name: p.name, task: null, call_id: null, task_fields: true };
}

async function call(s: Shared, c: Ctx, tool: string, args: any): Promise<any> {
  try {
    return await local(s, c, tool, args);
  } catch (e) {
    throw new Error(msg(e));
  }
}

async function request(s: Shared, method: string, path: string, body?: any): Promise<[number, any]> {
  if (!s.local_router) api.router(s);
  return api.local_request(s, method, path, Buffer.from(body === undefined ? "" : JSON.stringify(body)));
}

/** A board with two projects and a task in each, and a scratch task. */
async function board() {
  const s = testing.state();
  const p = db.insert_profile(s.db(), "personal", [], null);
  project(s, p, "web", "WEB");
  project(s, p, "api", "API");
  const me = ctx(p);
  const web = await call(s, me, "create_task", { title: "Web thing", project_id: "WEB" });
  const apit = await call(s, me, "create_task", { title: "API thing", project_id: "API" });
  const scratch = await call(s, me, "create_task", { title: "Notes", type: "scratch" });
  return { s, p, me, web, apit, scratch };
}

test("agents_arrange_pens_across_projects", async () => {
  const { s, p, me, web, apit, scratch } = await board();
  const made = await call(s, me, "create_pen", { name: "Today" });
  assert.equal(made.name, "Today");
  assert.equal(made.index, 0);
  assert.deepEqual(made.tasks, []);
  // A pen by its name, in any case; one that isn't there yet is made.
  let t = await call(s, me, "update_task", { task_id: web.key, pen: "today" });
  assert.equal(t.pen, "Today");
  t = await call(s, me, "update_task", { task_id: apit.key, pen: "Today" });
  t = await call(s, me, "update_task", { task_id: scratch.key, pen: "Parked" });
  assert.equal(t.pen, "Parked");
  let list = await call(s, me, "list_pens", {});
  assert.deepEqual(
    list.map((x: any) => [x.name, x.index, x.tasks.map((y: any) => y.key).sort()]),
    [
      ["Today", 0, ["API-1", "WEB-1"]],
      ["Parked", 1, ["S-1"]],
    ],
  );
  assert.equal(list[0].tasks.find((x: any) => x.key === "WEB-1").project, "web");
  // A pen's tasks are listed from every project; "none" lists the rest.
  const today = await call(s, me, "list_tasks", { pen: "Today" });
  assert.deepEqual(today.map((x: any) => x.key).sort(), ["API-1", "WEB-1"]);
  const none = await call(s, me, "list_tasks", { pen: "none" });
  assert.deepEqual(
    none.map((x: any) => x.key),
    [],
  );
  assert.match(await call(s, me, "list_tasks", { pen: "Nope" }).catch((e) => e.message), /^pen Nope$/);
  // Hidden, renamed and moved to the front.
  const parked = await call(s, me, "update_pen", { pen: "parked", hidden: true, name: "Later on", index: 0 });
  assert.equal(parked.hidden, true);
  assert.equal(parked.name, "Later on");
  list = await call(s, me, "list_pens", {});
  assert.deepEqual(
    list.map((x: any) => [x.name, x.index, x.hidden]),
    [
      ["Later on", 0, true],
      ["Today", 1, false],
    ],
  );
  assert.match(await call(s, me, "update_pen", { pen: "Today", name: "later ON" }).catch((e) => e.message), /already/);
  assert.match(await call(s, me, "create_pen", { name: "  " }).catch((e) => e.message), /non-empty/);
  // Out of a pen, and a pen deleted: its tasks stay, in no pen.
  t = await call(s, me, "update_task", { task_id: apit.key, pen: "" });
  assert.equal(t.pen, undefined);
  const gone = await call(s, me, "delete_pen", { pen: "Today" });
  assert.deepEqual(gone, { deleted: "Today", tasks_left_in_no_pen: 1 });
  assert.equal(db.get_task(s.db(), web.id)!.pen_id, null);
  assert.deepEqual(
    db.list_pens(s.db(), p.id).map((x) => x.name),
    ["Later on"],
  );
  // A new task can start in a pen.
  t = await call(s, me, "create_task", { title: "Another", project_id: "WEB", pen: "Fresh" });
  assert.equal(t.pen, "Fresh");
});

test("another_profiles_pens_are_out_of_reach", async () => {
  const { s, me } = await board();
  const other = db.insert_profile(s.db(), "work", [], null);
  const theirs = db.insert_pen(s.db(), other.id, "Secret");
  assert.match(await call(s, me, "update_pen", { pen: theirs.id, hidden: true }).catch((e) => e.message), /^pen /);
  assert.match(await call(s, me, "delete_pen", { pen: "Secret" }).catch((e) => e.message), /^pen Secret$/);
  assert.deepEqual(await call(s, me, "list_pens", {}), []);
  // Nor can a task go into it by its id.
  const t = db.list_tasks_for_profile(s.db(), me.profile_id!, false)[0];
  const [status] = await request(s, "PATCH", `/tasks/${t.id}`, { pen_id: theirs.id });
  assert.equal(status, 404);
});

test("the_api_moves_tasks_between_pens", async () => {
  const { s, p, web } = await board();
  const events: any[] = [];
  s.events.subscribe((e) => events.push(e));
  let [status, pen] = await request(s, "POST", `/profiles/${p.id}/pens`, { name: "Today" });
  assert.equal(status, 200);
  assert.equal(pen.task_count, 0);
  assert.ok(events.some((e) => e.type === "pens" && e.profile_id === p.id));
  [status] = await request(s, "POST", `/profiles/${p.id}/pens`, { name: "TODAY" });
  assert.equal(status, 409);
  let [, t] = await request(s, "PATCH", `/tasks/${web.id}`, { pen_id: pen.id });
  assert.equal(t.pen_id, pen.id);
  [, t] = await request(s, "PATCH", `/tasks/${web.id}`, { pen: "Parked" });
  const parked = db.pen_by_name(s.db(), p.id, "parked")!;
  assert.equal(t.pen_id, parked.id);
  let [, list] = await request(s, "GET", `/profiles/${p.id}/pens`);
  assert.deepEqual(
    list.map((x: any) => [x.name, x.task_count]),
    [
      ["Today", 0],
      ["Parked", 1],
    ],
  );
  [status, pen] = await request(s, "PATCH", `/pens/${parked.id}`, { index: 0, hidden: true });
  assert.equal(status, 200);
  assert.equal(pen.hidden, true);
  [, list] = await request(s, "GET", `/profiles/${p.id}/pens`);
  assert.deepEqual(
    list.map((x: any) => x.name),
    ["Parked", "Today"],
  );
  [status] = await request(s, "PATCH", `/pens/${parked.id}`, { hidden: "yes" });
  assert.equal(status, 400);
  events.length = 0;
  [status] = await request(s, "DELETE", `/pens/${parked.id}`);
  assert.equal(status, 200);
  assert.equal(db.get_task(s.db(), web.id)!.pen_id, null);
  // Its task's board hears it's in no pen.
  assert.ok(events.some((e) => e.type === "task" && e.task.id === web.id && e.task.pen_id === null));
  [, t] = await request(s, "PATCH", `/tasks/${web.id}`, { pen: null });
  assert.equal(t.pen_id, null);
});

test("each_profile_has_one_pens_thread_off_the_board", async () => {
  const { s, p, me } = await board();
  const [status, thread] = await request(s, "GET", `/profiles/${p.id}/pens-thread`);
  assert.equal(status, 200);
  assert.equal(thread.task_type, db.PENS);
  assert.equal(thread.host_id, s.host_id);
  // Numbered among the scratch tasks.
  assert.equal(thread.number, 2);
  assert.equal(pens.get_or_create(s, p.id).id, thread.id);
  // A scratch task made after it is numbered after it.
  const next = await call(s, me, "create_task", { title: "More notes", type: "scratch" });
  assert.equal(next.key, "S-3");
  const found = await call(s, me, "get_task", { task_id: "S-2" });
  assert.equal(found.id, thread.id);
  assert.equal(found.type, "pens");
  // Off the board's lists unless asked for.
  assert.ok(!db.list_group_tasks(s.db(), p.id, false).some((t) => t.id === thread.id));
  assert.ok(db.list_group_tasks(s.db(), p.id, false, true).some((t) => t.id === thread.id));
  assert.ok(!(await call(s, me, "list_tasks", { project_id: "all" })).some((t: any) => t.id === thread.id));
  // It lasts: it doesn't go to review or Done, nor into a pen.
  let [code] = await request(s, "PATCH", `/tasks/${thread.id}`, { status: "done" });
  assert.equal(code, 400);
  [code] = await request(s, "PATCH", `/tasks/${thread.id}`, { pen: "Today" });
  assert.equal(code, 400);
  // Its agent is told about the pens, and its first prompt is the user's message as it is.
  const t = db.get_task(s.db(), thread.id)!;
  assert.match(prompt.system_prompt(t, null, null, [], [], null, false), /You keep the pens of this Huntaway profile, in thread S-2/);
  assert.equal(prompt.start_prompt(t, null, "Today I'm on the web thing"), "Today I'm on the web thing");
});

test("older_hosts_arent_asked_about_pens", () => {
  assert.match(too_old("box", PENS_API - 1, "list_pens", {})!, /without pens/);
  assert.match(too_old("box", PENS_API - 1, "update_task", { task_id: "X-1", pen: "Today" })!, /without pens/);
  assert.equal(too_old("box", PENS_API - 1, "update_task", { task_id: "X-1", title: "x" }), null);
  assert.equal(too_old("box", PENS_API, "create_pen", { name: "x" }), null);
});

// A database at version 105 (hosted docs' fixes, HA-286, which took that number first) gets pens' table and column.
test("a_database_from_before_pens_gets_them", () => {
  const path = join(testing.temp_dir(), "db.sqlite");
  let c = db.open(path);
  c.exec("DROP INDEX tasks_pen; DROP INDEX tasks_one_pens_thread; ALTER TABLE tasks DROP COLUMN pen_id; DROP TABLE pens; PRAGMA user_version=105;");
  c.close();
  c = db.open(path);
  assert.equal(Number(db.value(c, "PRAGMA user_version")), db.VERSION);
  assert.ok(db.VERSION >= 106);
  const p = db.insert_profile(c, "p", [], null);
  const pen = db.insert_pen(c, p.id, "Today");
  assert.deepEqual(
    db.list_pens(c, p.id).map((x) => x.id),
    [pen.id],
  );
  assert.equal(db.value(c, "SELECT COUNT(*) FROM tasks WHERE pen_id IS NOT NULL"), 0);
  c.close();
});
