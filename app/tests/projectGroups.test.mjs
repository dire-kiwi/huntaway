import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  groupNames,
  groupProjects,
  groupTasks,
  hiddenKey,
  inGroupTaskGroup,
  loadCollapsedGroups,
  loadHiddenProjects,
  loadPinnedProjects,
  orphanGroupNames,
  profileProjects,
  saveCollapsedGroups,
  saveHiddenProjects,
  savePinnedProjects,
  sidebarEntries,
  visibleEntries,
} from "../src/projectGroups.ts";

const project = (id, group_name = null, host_id = "desktop") => ({ id, name: id, host_id, group_name });
afterEach(() => { delete globalThis.localStorage; });

test("puts each group where its first project is, with its projects in order", () => {
  const list = [project("a"), project("b", "G"), project("c"), project("d", "G"), project("e", "H")];
  const entries = sidebarEntries(list);
  assert.deepEqual(entries.map((e) => e.key), ["p:a", "g:desktop:G", "p:c", "g:desktop:H"]);
  assert.deepEqual(entries[1].projects.map((p) => p.id), ["b", "d"]);
  assert.equal(entries[1].name, "G");
});

test("finds groups that only have group tasks left", () => {
  const task = (group_name, host_id = "desktop", project_id = null, kind = "task") => ({ group_name, host_id, project_id, kind });
  const projects = [project("a", "Shop")];
  const tasks = [task("Shop"), task("Old"), task("Old"), task("Gone"), task("Elsewhere", "laptop"), task(null), task(null, "desktop", "a"), task("Chat", "desktop", null, "scratch")];
  assert.deepEqual(orphanGroupNames(tasks, projects, "desktop"), ["Gone", "Old"]);
  assert.deepEqual(orphanGroupNames(tasks, projects, "laptop"), ["Elsewhere"]);
});

test("keeps a profile's group tasks on the group's board once another profile has its only projects", () => {
  // All profiles: personal's last Shop project was ungrouped (or deleted), work's still in Shop.
  const projects = [{ ...project("site", "Shop"), profile_id: "work" }, { ...project("web"), profile_id: "personal" }];
  const planners = ["todo", "backlog", "done"].map((status) => ({ id: status, status, group_name: "Shop", host_id: "desktop", project_id: null, kind: "task", profile_id: "personal" }));
  assert.deepEqual(orphanGroupNames(planners, projects, "desktop"), []);
  assert.deepEqual(groupTasks(planners, "desktop", "Shop").map((t) => t.id), ["todo", "backlog", "done"]);
  assert.deepEqual(groupTasks(planners, "laptop", "Shop"), []);
  assert.deepEqual(groupTasks(planners, "desktop", "Blog"), []);
});

test("keeps a host's groups apart from another host's of the same name", () => {
  const list = [project("a", "G"), project("b", "G", "laptop"), project("c", "G")];
  assert.deepEqual(groupProjects(list, "desktop", "G").map((p) => p.id), ["a", "c"]);
  assert.deepEqual(groupNames([...list, project("d", "H")], "desktop"), ["G", "H"]);
  assert.deepEqual(groupNames(list, "nowhere"), []);
});

test("remembers collapsed groups, and copes without storage", () => {
  const data = new Map();
  globalThis.localStorage = { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, v) };
  saveCollapsedGroups(new Set(["desktop:G"]));
  assert.deepEqual([...loadCollapsedGroups()], ["desktop:G"]);
  globalThis.localStorage = { getItem: () => "bad json" };
  assert.deepEqual([...loadCollapsedGroups()], []);
  globalThis.localStorage = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
  assert.deepEqual([...loadCollapsedGroups()], []);
  assert.doesNotThrow(() => saveCollapsedGroups(new Set(["x"])));
});

test("leaves hidden projects out, and a group once all of its projects are hidden", () => {
  const list = [project("a"), project("b", "G"), project("c"), project("d", "G"), project("e", "H"), project("a", null, "laptop")];
  const hide = (...keys) => visibleEntries(sidebarEntries(list), new Set(keys));
  assert.deepEqual(hide().map((e) => e.key), ["p:a", "g:desktop:G", "p:c", "g:desktop:H", "p:a"]);
  // Ids are per host: hiding desktop's "a" leaves laptop's.
  const some = hide(hiddenKey(list[0]), "desktop:b", "desktop:e");
  assert.deepEqual(some.map((e) => e.key), ["g:desktop:G", "p:c", "p:a"]);
  // The group stays where its (hidden) first project is, showing the rest.
  assert.deepEqual(some[0].projects.map((p) => p.id), ["d"]);
  assert.deepEqual(sidebarEntries(list)[1].projects.map((p) => p.id), ["b", "d"], "doesn't change the entries it's given");
});

test("keeps hidden projects in this browser", () => {
  const store = new Map();
  globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  assert.deepEqual([...loadHiddenProjects()], []);
  saveHiddenProjects(new Set(["desktop:a"]));
  assert.deepEqual([...loadHiddenProjects()], ["desktop:a"]);
  assert.deepEqual([...loadCollapsedGroups()], [], "apart from collapsed groups");
  globalThis.localStorage = { getItem: () => '["desktop:a", 3]' };
  assert.deepEqual([...loadHiddenProjects()], ["desktop:a"]);
  globalThis.localStorage = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
  assert.deepEqual([...loadHiddenProjects()], []);
  assert.doesNotThrow(() => saveHiddenProjects(new Set(["x"])));
});

test("tells a group task's tasks in the group's projects from those it created elsewhere", () => {
  const projects = [project("site", "Shop"), project("api", "Shop"), project("tools"), project("blog", "Other"), project("away", "Shop", "laptop")];
  const planner = { id: "g", group_name: "Shop", host_id: "desktop", project_id: null, kind: "task" };
  const created = (project_id) => ({ project_id, host_id: "desktop", created_by: "g", kind: "task" });
  const inGroup = (id) => inGroupTaskGroup(created(id), planner, projects);
  assert.ok(inGroup("site"));
  assert.ok(inGroup("api"));
  assert.ok(!inGroup("tools"));
  assert.ok(!inGroup("blog"));
  assert.ok(!inGroup("away"));
  assert.ok(!inGroup("unknown"));
  assert.ok(!inGroup(null));
});

// IA-128: the sidebar lists the active profile's projects and the pinned ones, in their order.
test("lists a profile's projects and the pinned ones", () => {
  const p = (id, profile_id, host_id = "desktop") => ({ id, name: id, host_id, profile_id, group_name: null });
  // Profiles are merged by name across hosts: "work" is w1 on desktop and w2 on laptop.
  const names = { "desktop:w1": "work", "laptop:w2": "work", "desktop:me": "personal" };
  const profileOf = (x) => names[`${x.host_id}:${x.profile_id}`];
  const list = [p("a", "me"), p("b", "w1"), p("c", "w2", "laptop"), p("d", "me"), p("e", "w1")];
  const ids = (xs) => xs.map((x) => x.id);
  assert.deepEqual(ids(profileProjects(list, "work", profileOf, new Set())), ["b", "c", "e"]);
  assert.deepEqual(ids(profileProjects(list, "personal", profileOf, new Set(["desktop:e", "laptop:b"]))), ["a", "d", "e"]);
  assert.deepEqual(ids(profileProjects(list, "work", profileOf, new Set(["desktop:a"]))), ["a", "b", "c", "e"]);
});

test("keeps pinned projects in this browser", () => {
  const store = new Map();
  globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  assert.deepEqual([...loadPinnedProjects()], []);
  savePinnedProjects(new Set(["desktop:a"]));
  assert.deepEqual([...loadPinnedProjects()], ["desktop:a"]);
  assert.deepEqual([...loadHiddenProjects()], [], "apart from the hidden ones");
  globalThis.localStorage = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
  assert.deepEqual([...loadPinnedProjects()], []);
  assert.doesNotThrow(() => savePinnedProjects(new Set(["x"])));
});
