import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { activeProfile, loadActiveProfile, saveActiveProfile } from "../src/activeProfile.ts";

afterEach(() => { delete globalThis.localStorage; });

// IA-128: the profile the sidebar lists the projects of.
test("keeps the profile picked last, else the first one", () => {
  assert.equal(activeProfile(["personal", "work"], null), "personal");
  assert.equal(activeProfile(["personal", "work"], "work"), "work");
  assert.equal(activeProfile(["personal", "work"], "gone"), "personal", "a deleted profile falls back to the first");
  assert.equal(activeProfile([], "work"), undefined);
});

test("moves to the profile the open page needs", () => {
  const seen = [];
  const needs = (current) => (seen.push(current), current === "work" ? undefined : "work");
  assert.equal(activeProfile(["personal", "work"], "personal", needs), "work");
  assert.equal(activeProfile(["personal", "work"], "work", needs), "work");
  assert.deepEqual(seen, ["personal", "work"], "told which profile is current");
  assert.equal(activeProfile(["personal", "work"], "work", () => "gone"), "work", "not to a profile that isn't on the board");
});

test("keeps the active profile in this browser", () => {
  const store = new Map();
  globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  assert.equal(loadActiveProfile(), null);
  saveActiveProfile("work");
  assert.equal(loadActiveProfile(), "work");
  globalThis.localStorage = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
  assert.equal(loadActiveProfile(), null);
  assert.doesNotThrow(() => saveActiveProfile("work"));
});
