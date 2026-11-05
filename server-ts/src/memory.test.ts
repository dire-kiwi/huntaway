import { test } from "node:test";
import assert from "node:assert/strict";
import { tick } from "./memory.ts";

const MB = 1 << 20;

test("a full gc only once rss has grown by the slack since the last one", () => {
  assert.deepEqual(tick(110 * MB, 110 * MB), { collect: false, after: 110 * MB });
  assert.equal(tick(110 * MB, 141 * MB).collect, false);
  assert.equal(tick(110 * MB, 142 * MB).collect, true);
  assert.equal(tick(110 * MB, 180 * MB).collect, true);
});

test("a gc taken in the middle of a burst doesn't keep the next one from coming", () => {
  // A GC in the middle of a burst left RSS at 200 MB; the burst ends and RSS goes down to 110 MB by itself, then back up.
  let after = 200 * MB;
  ({ after } = tick(after, 110 * MB));
  assert.equal(after, 110 * MB);
  assert.equal(tick(after, 150 * MB).collect, true);
});
