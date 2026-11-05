import { test } from "node:test";
import assert from "node:assert/strict";
import { should_collect } from "./memory.ts";

const MB = 1 << 20;

test("a full gc only once rss has grown by the slack since the last one", () => {
  assert.equal(should_collect(110 * MB, 110 * MB), false);
  assert.equal(should_collect(141 * MB, 110 * MB), false);
  assert.equal(should_collect(142 * MB, 110 * MB), true);
  assert.equal(should_collect(180 * MB, 110 * MB), true);
  // Less than the last time (the memory reducer got there first): nothing to do.
  assert.equal(should_collect(100 * MB, 110 * MB), false);
});
