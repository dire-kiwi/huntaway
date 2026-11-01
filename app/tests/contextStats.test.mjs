import assert from "node:assert/strict";
import { test } from "node:test";
import { byTask, histogram, limitRows, percentile, tokens } from "../src/contextStats.ts";

const turn = (taskId, at, n, cost = null, start = null) => ({ at, taskId, tokens: n, startTokens: start, maxTokens: 1_000_000, cost });
const compaction = (taskId, at, source, before, after) => ({ at, taskId, source, tokens: before, postTokens: after, durationMs: null });

test("formats token counts", () => {
  assert.deepEqual([950, 12_400, 999_000, 1_200_000, 1_000_000].map(tokens), ["950", "12k", "999k", "1.2M", "1M"]);
});

test("takes percentiles by nearest rank", () => {
  assert.equal(percentile([], 0.5), null);
  assert.equal(percentile([30, 10, 20], 0.5), 20);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9), 9);
  assert.equal(percentile([5], 0.99), 5);
});

test("buckets turns by the context they left, with what they cost", () => {
  const b = histogram([turn("a", 1, 10_000, 0.5), turn("a", 2, 25_000, 1), turn("b", 3, 2_000_000, 2)]);
  assert.deepEqual(b[0], { from: 0, to: 25_000, turns: 1, cost: 0.5 });
  assert.deepEqual(b[1], { from: 25_000, to: 50_000, turns: 1, cost: 1 });
  assert.deepEqual(b.at(-1), { from: 750_000, to: null, turns: 1, cost: 2 });
  assert.equal(b.reduce((n, x) => n + x.turns, 0), 3);
});

test("says how often a limit would have been passed, and what turns started past it cost", () => {
  const turns = [
    turn("a", 1, 60_000, 1, 10_000),
    turn("a", 2, 120_000, 2, 61_000),
    turn("a", 4, 130_000, 4, 121_000),
    // After the idle compaction.
    turn("a", 6, 40_000, 8, 21_000),
    // A review's new session on the same thread starts small, whatever the last round left.
    turn("b", 3, 110_000, 16, 9_000),
    // Started past the limit on a turn from before the range, which isn't in it.
    turn("c", 8, 150_000, 32, 140_000),
  ];
  const compactions = [compaction("a", 5, "idle", 130_000, 20_000), compaction("b", 7, "auto", 900_000, 10_000)];
  const [r] = limitRows(turns, compactions, [100_000]);
  assert.equal(r.turns, 4);
  assert.equal(r.share, 4 / 6);
  assert.equal(r.tasks, 3);
  assert.equal(r.cost, 4 + 32);
  assert.equal(r.costShare, 36 / 63);
  // The agent's own compaction isn't counted: it comes at its own threshold.
  assert.equal(r.compactions, 1);
  // Each turn counts the same whatever else the range has.
  assert.equal(limitRows([turns[5]], [], [100_000])[0].cost, 32);
});

test("lists tasks by the biggest context they reached", () => {
  const rows = byTask([turn("a", 1, 50_000, 1), turn("a", 2, 30_000, 1), turn("b", 1, 80_000)], [compaction("c", 3, "user", 200_000, 9_000)]);
  assert.deepEqual(
    rows.map((r) => [r.taskId, r.peak, r.last, r.turns, r.compactions, r.cost]),
    [
      ["c", 200_000, null, 0, 1, 0],
      ["b", 80_000, 80_000, 1, 0, 0],
      ["a", 50_000, 30_000, 2, 0, 2],
    ],
  );
});
