import assert from "node:assert/strict";
import { test } from "node:test";
import { byDay, byImplementer, byReviewer, byTask, groupBy, purposeOf, reviewsByTask, summarise, ticks, tokens, total } from "../src/tokenStats.ts";

const row = (threadId, at, model, output, extra = {}) => ({
  at,
  runId: `${threadId}-${at}`,
  threadId,
  runKind: "prompt",
  model,
  runtime: "claude",
  input: 1,
  output,
  cacheRead: 10,
  cacheWrite: 0,
  reasoning: 0,
  cost: output / 100,
  estimated: false,
  ...extra,
});
const thread = (kind, extra = {}) => ({ parentId: null, taskType: null, subproject: false, groupName: null, model: null, kind, ...extra });
const review = (taskId, threadId, at, verdict, extra = {}) => ({ at, taskId, threadId, verdict, serious: verdict === "issues" ? 1 : 0, minor: null, minorNoted: false, reviewer: "Claude · opus", model: "opus", ...extra });

// A subproject S with task C, which has a review thread and a summary thread; and task T on its own.
const data = (extra = {}) => ({
  from: 0,
  to: 100,
  rows: [],
  reviews: [],
  followUps: [],
  tasks: {},
  projects: {},
  threads: {
    S: thread("task", { subproject: true }),
    C: thread("task", { parentId: "S", model: "opus" }),
    R: thread("review", { parentId: "C" }),
    M: thread("review", { parentId: "C", taskType: "summary" }),
    T: thread("task", { model: "gpt" }),
    G: thread("task", { groupName: "g" }),
    X: thread("task", { taskType: "scratch" }),
  },
  pending: 0,
  errors: [],
  ...extra,
});

test("formats token counts up to billions", () => {
  assert.deepEqual([950, 12_400, 1_200_000, 3_400_000_000, 12_000_000_000].map(tokens), ["950", "12k", "1.2M", "3.4B", "12B"]);
});

test("tells what tokens were spent on", () => {
  const d = data();
  assert.equal(purposeOf(d, row("C", 1, "opus", 1)), "task");
  assert.equal(purposeOf(d, row("C", 1, "opus", 1, { runKind: "compact" })), "compaction");
  assert.equal(purposeOf(d, row("R", 1, "opus", 1, { runKind: "review" })), "review");
  assert.equal(purposeOf(d, row("M", 1, "haiku", 1, { runKind: "review" })), "summary");
  assert.equal(purposeOf(d, row("G", 1, "opus", 1)), "group");
  assert.equal(purposeOf(d, row("X", 1, "opus", 1)), "scratch");
});

test("totals count each run once and group by model", () => {
  const rows = [row("C", 1, "opus", 100), row("C", 1, "haiku", 5), row("T", 2, "gpt", 50, { cost: null })];
  const t = total(rows);
  assert.equal(t.runs, 2);
  assert.equal(t.output, 155);
  assert.equal(t.cost, 1.05);
  assert.deepEqual(
    groupBy(rows, (r) => r.model, "output").map((g) => g.key),
    ["opus", "gpt", "haiku"],
  );
});

test("a task's tokens include its threads', and a subproject lists its tasks", () => {
  const d = data();
  const rows = [row("S", 1, "opus", 10), row("C", 2, "opus", 100), row("R", 3, "gpt", 40, { runKind: "review" }), row("M", 4, "haiku", 5), row("T", 5, "gpt", 50)];
  const tasks = byTask(d, rows, "output");
  assert.deepEqual(
    tasks.map((t) => [t.taskId, t.totals.output]),
    [
      ["S", 155],
      ["T", 50],
    ],
  );
  const [s] = tasks;
  // With its tasks'.
  assert.deepEqual([s.parts.task.output, s.parts.review.output, s.parts.summary.output], [110, 40, 5]);
  assert.deepEqual(
    s.children.map((c) => [c.taskId, c.totals.output, c.parts.task?.output, c.parts.review?.output, c.parts.summary?.output]),
    [["C", 145, 100, 40, 5]],
  );
  assert.deepEqual(
    s.models.map((m) => m.model),
    ["opus", "gpt", "haiku"],
  );
});

test("a subproject's task shows under it even when the subproject used nothing itself", () => {
  const tasks = byTask(data(), [row("C", 2, "opus", 100)], "tokens");
  assert.deepEqual(
    tasks.map((t) => [t.taskId, t.totals.output, t.children.map((c) => c.taskId)]),
    [["S", 100, ["C"]]],
  );
});

test("days add up each purpose", () => {
  const d = data();
  const days = byDay(d, [row("C", 5, "opus", 1), row("R", 15, "opus", 2), row("C", 25, "opus", 4)], [0, 10, 20]);
  assert.deepEqual(
    days.map((x) => [x.parts.task.output, x.parts.review.output]),
    [
      [1, 0],
      [0, 2],
      [4, 0],
    ],
  );
});

test("reviews come in rounds, one per reviewer's thread each", () => {
  const d = data({
    reviews: [
      review("C", "R", 1, "issues", { serious: 2 }),
      review("C", "R2", 2, "pass", { reviewer: "Codex · gpt", model: "gpt" }),
      review("C", "R", 10, "pass", { minor: 2, minorNoted: true }),
      review("C", "R2", 11, "pass", { reviewer: "Codex · gpt", model: "gpt" }),
      review("T", "R3", 5, "pass"),
    ],
    followUps: [
      { taskId: "F1", createdBy: "C", at: 12 },
      // Before the review that noted minor issues: not one of its follow-ups.
      { taskId: "F0", createdBy: "C", at: 3 },
      { taskId: "F2", createdBy: "T", at: 6 },
    ],
  });
  const tasks = reviewsByTask(d);
  const c = tasks.find((t) => t.taskId === "C");
  assert.equal(c.rounds.length, 2);
  assert.deepEqual(
    c.rounds.map((r) => r.map((x) => x.verdict)),
    [
      ["issues", "pass"],
      ["pass", "pass"],
    ],
  );
  assert.equal(c.followUps, 1);
  const s = summarise(d.reviews, tasks);
  assert.deepEqual(
    [s.reviews, s.withIssues, s.serious, s.minor, s.minorListed, s.tasks, s.firstPassed, s.roundsWithIssues, s.minorTasks, s.minorTasksFollowedUp, s.followUps],
    [5, 1, 2, 2, 1, 2, 1, 1, 1, 1, 1],
  );
  assert.deepEqual(
    byImplementer(d, tasks).map((m) => [m.model, m.summary.tasks, m.summary.firstPassed]),
    [
      ["opus", 1, 0],
      ["gpt", 1, 1],
    ],
  );
  assert.deepEqual(
    byReviewer(d.reviews).map((r) => [r.reviewer, r.summary.reviews, r.summary.withIssues]),
    [
      ["Claude · opus", 3, 1],
      ["Codex · gpt", 2, 0],
    ],
  );
});

test("axis ticks are round numbers", () => {
  assert.deepEqual(ticks(190), { top: 200, ticks: [0, 50, 100, 150, 200] });
  assert.deepEqual(ticks(2_100_000_000), { top: 3_000_000_000, ticks: [0, 1_000_000_000, 2_000_000_000, 3_000_000_000] });
  assert.deepEqual(ticks(0), { top: 1, ticks: [0] });
  assert.deepEqual(ticks(3).ticks, [0, 1, 2, 3]);
});
