import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { loadProjectOrder, moveProject, moveProjects, saveProjectOrder, sortProjects } from "../src/projectOrder.ts";

const project = (id, name = id, host_id = "desktop") => ({ id, name, host_id });
const ids = (projects) => projects.map((p) => p.id);
const alpha = project("a", "Alpha");
const beta = project("b", "Beta");
const gamma = project("c", "Gamma");
const projects = [alpha, beta, gamma];
afterEach(() => { delete globalThis.localStorage; });

test("defaults to alphabetical order without mutating the input", () => {
  const input = [gamma, alpha, beta];
  assert.deepEqual(ids(sortProjects(input, [])), ["a", "b", "c"]);
  assert.deepEqual(ids(input), ["c", "a", "b"]);
});

test("moves to either edge and back using before/after insertion", () => {
  let order = moveProject(projects, [], "c", "a", "before");
  assert.deepEqual(ids(sortProjects(projects, order)), ["c", "a", "b"]);
  order = moveProject(projects, order, "c", "b", "after");
  assert.deepEqual(ids(sortProjects(projects, order)), ["a", "b", "c"]);
  order = moveProject(projects, order, "a", "b", "after");
  assert.deepEqual(ids(sortProjects(projects, order)), ["b", "a", "c"]);
});

test("keeps renamed projects in place and appends new projects alphabetically", () => {
  const order = moveProject(projects, [], "c", "a", "before");
  const refreshed = [{ ...beta, name: "Aardvark" }, project("e", "Echo"), gamma, project("d", "Delta"), alpha];
  assert.deepEqual(ids(sortProjects(refreshed, order)), ["c", "a", "b", "d", "e"]);
  assert.deepEqual(ids(sortProjects([beta, gamma], order)), ["c", "b"]);
});

test("preserves an offline host's ordering when reordering another host", () => {
  const laptop = [project("x", "X", "laptop"), project("y", "Y", "laptop")];
  let order = moveProject([...projects, ...laptop], [], "y", "x", "before");
  order = moveProject(projects, order, "c", "a", "before");
  assert.deepEqual(ids(sortProjects(laptop, order)), ["y", "x"]);
  assert.deepEqual(ids(sortProjects(projects, order)), ["c", "a", "b"]);
});

test("ignores cross-host moves, self-drops, and missing projects", () => {
  const input = [...projects, project("x", "X", "laptop")];
  const order = [];
  for (const [source, target] of [["a", "x"], ["a", "a"], ["missing", "a"], ["a", "missing"]]) {
    assert.equal(moveProject(input, order, source, target, "before"), order);
  }
});

test("persists and restores after a reload", () => {
  const data = new Map();
  globalThis.localStorage = { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
  assert.deepEqual(loadProjectOrder(), []);
  saveProjectOrder(moveProject(projects, [], "c", "a", "before"));
  assert.deepEqual(ids(sortProjects([...projects].reverse(), loadProjectOrder())), ["c", "a", "b"]);
});

test("starts from the order of the All profiles view, or else of the profile picked last", () => {
  const data = new Map();
  globalThis.localStorage = { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
  data.set("ia.profileName", "work");
  data.set('ia.projectOrder:"work"', JSON.stringify(["desktop:b", "desktop:a", "desktop:c"]));
  assert.deepEqual(ids(sortProjects(projects, loadProjectOrder())), ["b", "a", "c"]);
  data.set('ia.projectOrder:"\\u0000all"', JSON.stringify(["desktop:c", "desktop:b", "desktop:a"]));
  assert.deepEqual(ids(sortProjects(projects, loadProjectOrder())), ["c", "b", "a"]);
  // Once it's been reordered, that's the order.
  saveProjectOrder(["desktop:a", "desktop:c", "desktop:b"]);
  assert.deepEqual(ids(sortProjects(projects, loadProjectOrder())), ["a", "c", "b"]);
});

test("recovers from malformed or unavailable browser storage", () => {
  for (const value of ["bad json", "null", "{}", '["desktop:a", 1]']) {
    globalThis.localStorage = { getItem: () => value };
    assert.deepEqual(loadProjectOrder(), []);
  }
  globalThis.localStorage = { getItem: () => '["desktop:a", "desktop:a"]' };
  assert.deepEqual(loadProjectOrder(), ["desktop:a"]);
  globalThis.localStorage = {
    getItem() { throw new Error("Storage blocked"); },
    setItem() { throw new Error("Storage blocked"); },
  };
  assert.deepEqual(loadProjectOrder(), []);
  assert.doesNotThrow(() => saveProjectOrder(["desktop:a"]));
});

test("moves a group of projects as one, before its first or after its last", () => {
  const delta = project("d", "Delta");
  const all = [alpha, beta, gamma, delta];
  // The group is b and d; a and c are on their own.
  let order = moveProjects(all, [], ["b", "d"], ["a"], "before");
  assert.deepEqual(ids(sortProjects(all, order)), ["b", "d", "a", "c"]);
  order = moveProjects(all, order, ["c"], ["b", "d"], "before");
  assert.deepEqual(ids(sortProjects(all, order)), ["c", "b", "d", "a"]);
  order = moveProjects(all, order, ["c"], ["b", "d"], "after");
  assert.deepEqual(ids(sortProjects(all, order)), ["b", "d", "c", "a"]);
  assert.equal(moveProjects(all, order, ["b", "d"], ["d"], "after"), order);
  assert.equal(moveProjects(all, order, ["b", "missing"], ["a"], "after"), order);
});

test("reordering inside a group whose projects aren't next to each other leaves the group in place", () => {
  const grouped = [{ ...alpha, group_name: "G" }, beta, { ...gamma, group_name: "G" }];
  // Shown as G(a, c), b.
  let order = moveProjects(grouped, [], ["a"], ["c"], "after");
  assert.deepEqual(ids(sortProjects(grouped, order)), ["c", "a", "b"]);
  order = moveProjects(grouped, [], ["c"], ["a"], "before");
  assert.deepEqual(ids(sortProjects(grouped, order)), ["c", "a", "b"]);
  // A project moved past the group goes after all of it.
  order = moveProjects(grouped, [], ["b"], ["a", "c"], "before");
  assert.deepEqual(ids(sortProjects(grouped, order)), ["b", "a", "c"]);
  order = moveProjects(grouped, order, ["b"], ["a", "c"], "after");
  assert.deepEqual(ids(sortProjects(grouped, order)), ["a", "c", "b"]);
});
