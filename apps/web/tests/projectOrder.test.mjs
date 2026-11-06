import assert from "node:assert/strict";
import { test } from "node:test";
import { sortProjects } from "../src/projectOrder.ts";

const project = (id, name = id, host_id = "desktop") => ({ id, name, host_id });
const ids = (projects) => projects.map((p) => p.id);

// HA-84: the sidebar always lists projects alphabetically.
test("sorts alphabetically without changing the input", () => {
  const input = [project("c", "Gamma"), project("a", "Alpha"), project("b", "Beta")];
  assert.deepEqual(ids(sortProjects(input)), ["a", "b", "c"]);
  assert.deepEqual(ids(input), ["c", "a", "b"]);
});

test("ignores case and puts numbers in numeric order", () => {
  const input = [project("z", "zeta"), project("A", "Alpha"), project("v10", "v10"), project("v2", "v2"), project("b", "beta")];
  assert.deepEqual(ids(sortProjects(input)), ["A", "b", "v2", "v10", "z"]);
});

test("orders projects of the same name by host, then id", () => {
  const input = [project("2", "Site", "laptop"), project("9", "Site"), project("1", "Site")];
  assert.deepEqual(sortProjects(input).map((p) => `${p.host_id}:${p.id}`), ["desktop:1", "desktop:9", "laptop:2"]);
});
