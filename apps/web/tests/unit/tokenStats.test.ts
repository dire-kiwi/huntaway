import assert from "node:assert/strict"
import { test } from "vite-plus/test"
import {
  byDay,
  byImplementer,
  byReviewer,
  byTask,
  codexWrites,
  groupBy,
  hitRate,
  issuesByModelAndEffort,
  poorHit,
  purposeOf,
  reviewsByTask,
  summarise,
  ticks,
  tokens,
  total,
} from "../../src/components/settings/tokenStatsData"
import type { TokenData, UReview, URound, URow, UThread } from "../../src/components/settings/tokenStatsData"

/** `v`, which the test expects to be there. */
const must = <T>(v: T | undefined): T => {
  assert.ok(v !== undefined)
  return v
}

type Verdict = UReview["verdict"]

const row = (threadId: string | null, at: number, model: string, output: number, extra: Partial<URow> = {}): URow => ({
  at,
  runId: `${threadId}-${at}`,
  callId: null,
  threadId,
  runKind: "prompt",
  model,
  runtime: "claude",
  input: 1,
  output,
  cacheRead: 10,
  cacheWrite: 0,
  cacheWrite1h: null,
  cacheWrite5m: null,
  reasoning: 0,
  cost: output / 100,
  estimated: false,
  ...extra,
})
const thread = (kind: string, extra: Partial<UThread> = {}): UThread => ({
  parentId: null,
  taskType: null,
  groupName: null,
  model: null,
  kind,
  ...extra,
})
// Without the round it was in, which a test gives where it counts.
const review = (taskId: string, threadId: string, at: number, verdict: Verdict, extra: Partial<UReview> = {}): UReview => ({
  at,
  taskId,
  threadId,
  verdict,
  serious: verdict === "issues" ? 1 : 0,
  minor: null,
  minorNoted: false,
  reviewer: "Claude · opus",
  model: "opus",
  effort: null,
  taskModel: null,
  round: 0,
  ...extra,
})

// Task C, which has a review thread and a summary thread; and task T on its own. (Subprojects, which listed their
// tasks' tokens, are gone: docs/plan/14-dropped-and-open.md.)
const data = (extra: Partial<TokenData> = {}): TokenData => ({
  from: 0,
  to: 100,
  rows: [],
  reviews: [],
  rounds: [],
  followUps: [],
  tasks: {},
  projects: {},
  threads: {
    C: thread("task", { model: "opus" }),
    R: thread("review", { parentId: "C" }),
    M: thread("review", { parentId: "C", taskType: "summary" }),
    T: thread("task", { model: "gpt" }),
    G: thread("task", { groupName: "g" }),
    X: thread("task", { taskType: "scratch" }),
  },
  pending: 0,
  errors: [],
  ...extra,
})

test("formats token counts up to billions", () => {
  assert.deepEqual([950, 12_400, 1_200_000, 3_400_000_000, 12_000_000_000].map(tokens), ["950", "12k", "1.2M", "3.4B", "12B"])
})

test("tells what tokens were spent on", () => {
  const d = data()
  assert.equal(purposeOf(d, row("C", 1, "opus", 1)), "task")
  assert.equal(purposeOf(d, row("C", 1, "opus", 1, { runKind: "compact" })), "compaction")
  assert.equal(purposeOf(d, row("R", 1, "opus", 1, { runKind: "review" })), "review")
  assert.equal(purposeOf(d, row("M", 1, "haiku", 1, { runKind: "review" })), "summary")
  assert.equal(purposeOf(d, row("G", 1, "opus", 1)), "group")
  assert.equal(purposeOf(d, row("X", 1, "opus", 1)), "scratch")
})

test("totals count each run once and group by model", () => {
  const rows = [row("C", 1, "opus", 100), row("C", 1, "haiku", 5), row("T", 2, "gpt", 50, { cost: null })]
  const t = total(rows)
  assert.equal(t.runs, 2)
  assert.equal(t.output, 155)
  assert.equal(t.cost, 1.05)
  assert.deepEqual(
    groupBy(rows, (r) => r.model, "output").map((g) => g.key),
    ["opus", "gpt", "haiku"],
  )
})

test("a task's tokens include its threads'", () => {
  const d = data()
  const rows = [row("C", 2, "opus", 100), row("R", 3, "gpt", 40, { runKind: "review" }), row("M", 4, "haiku", 5), row("T", 5, "gpt", 50)]
  const tasks = byTask(d, rows, "output")
  assert.deepEqual(
    tasks.map((t) => [t.taskId, t.totals.output]),
    [
      ["C", 145],
      ["T", 50],
    ],
  )
  const c = must(tasks[0])
  assert.deepEqual([c.parts.task?.output, c.parts.review?.output, c.parts.summary?.output], [100, 40, 5])
  assert.deepEqual(
    c.models.map((m) => m.model),
    ["opus", "gpt", "haiku"],
  )
})

test("titles and window restarts are calls of their own, counted in totals but not towards tasks", () => {
  const d = data()
  const title = (callId: string, threadId: string, at: number, model: string, output: number) =>
    row(threadId, at, model, output, { runId: null, callId, runKind: "title" })
  const window = (callId: string, at: number, model: string, output: number) => row(null, at, model, output, { runId: null, callId, runKind: "window" })
  const rows = [
    row("T", 1, "gpt", 50),
    title("a", "T", 2, "haiku", 3),
    title("b", "T", 3, "haiku", 4),
    title("c", "C", 3, "haiku", 2),
    window("d", 4, "haiku", 1),
    window("d", 4, "gpt-mini", 1),
  ]
  assert.equal(purposeOf(d, must(rows[1])), "title")
  assert.equal(purposeOf(d, must(rows[4])), "window")
  const t = total(rows)
  // The window restart that used two models is one call.
  assert.deepEqual([t.runs, t.calls, t.output], [1, 4, 61])
  assert.deepEqual(
    byTask(d, rows, "output").map((u) => [u.taskId, u.totals.output, u.totals.calls]),
    [["T", 50, 0]],
  )
  assert.deepEqual(
    groupBy(rows, (r) => purposeOf(d, r), "output").map((g) => [g.key, g.totals.output, g.totals.runs, g.totals.calls]),
    [
      ["task", 50, 1, 0],
      ["title", 9, 0, 3],
      ["window", 2, 0, 1],
    ],
  )
  assert.deepEqual(
    byDay(d, rows, [0]).map((x) => [x.parts.title.output, x.parts.window.output]),
    [[9, 2]],
  )
  // Two calls in the same millisecond, for the same task or for no task, are two calls.
  assert.deepEqual(total([title("e", "T", 5, "haiku", 1), title("f", "T", 5, "haiku", 1), window("g", 5, "haiku", 1), window("h", 5, "haiku", 1)]).calls, 4)
})

test("days add up each purpose", () => {
  const d = data()
  const days = byDay(d, [row("C", 5, "opus", 1), row("R", 15, "opus", 2), row("C", 25, "opus", 4)], [0, 10, 20])
  assert.deepEqual(
    days.map((x) => [x.parts.task.output, x.parts.review.output]),
    [
      [1, 0],
      [0, 2],
      [4, 0],
    ],
  )
})

const round = (taskId: string, n: number, verdict: Verdict, extra: Partial<URound> = {}): URound => ({
  taskId,
  round: n,
  at: n,
  verdict,
  serious: verdict === "issues" ? 1 : 0,
  reviewers: 1,
  ...extra,
})

test("a task's rounds are the report's, whichever of its reviews are in range", () => {
  const d = data({
    reviews: [
      review("C", "R", 1, "issues", { serious: 2, round: 1 }),
      review("C", "R2", 2, "pass", { reviewer: "Codex · gpt", model: "gpt", round: 1 }),
      review("C", "R", 10, "pass", { minor: 2, minorNoted: true, round: 2 }),
      review("C", "R2", 11, "pass", { reviewer: "Codex · gpt", model: "gpt", round: 2 }),
      review("T", "R3", 5, "pass", { round: 1 }),
    ],
    rounds: [round("C", 2, "pass", { reviewers: 2 }), round("C", 1, "issues", { serious: 2, reviewers: 2 }), round("T", 1, "pass")],
    followUps: [
      { taskId: "F1", createdBy: "C", at: 12 },
      // Before the review that noted minor issues: not one of its follow-ups.
      { taskId: "F0", createdBy: "C", at: 3 },
      { taskId: "F2", createdBy: "T", at: 6 },
    ],
  })
  const tasks = reviewsByTask(d)
  const c = must(tasks.find((t) => t.taskId === "C"))
  assert.deepEqual(
    c.rounds.map((r) => [r.round, r.verdict]),
    [
      [1, "issues"],
      [2, "pass"],
    ],
  )
  assert.equal(c.followUps, 1)
  const s = summarise(d.reviews, tasks)
  assert.deepEqual(
    [s.reviews, s.withIssues, s.serious, s.minor, s.minorListed, s.tasks, s.firstPassed, s.roundsWithIssues, s.minorTasks, s.minorTasksFollowedUp, s.followUps],
    [5, 1, 2, 2, 1, 2, 1, 1, 1, 1, 1],
  )
  assert.deepEqual(
    byImplementer(d, tasks).map((m) => [m.model, m.summary.tasks, m.summary.firstPassed]),
    [
      ["opus", 1, 0],
      ["gpt", 1, 1],
    ],
  )
  assert.deepEqual(
    byReviewer(d.reviews).map((r) => [r.reviewer, r.summary.reviews, r.summary.withIssues]),
    [
      ["Claude · opus", 3, 1],
      ["Codex · gpt", 2, 0],
    ],
  )
})

// HA-114 review: a task whose first round (with issues) was before the range, and whose second
// passed in it, counted as passing its first round.
test("a first round before the range still counts as the task's first", () => {
  const d = data({
    reviews: [review("C", "R", 10, "pass", { round: 2 })],
    rounds: [round("C", 1, "issues"), round("C", 2, "pass")],
  })
  const s = summarise(d.reviews, reviewsByTask(d))
  assert.deepEqual([s.reviews, s.tasks, s.firstPassed, s.roundsWithIssues], [1, 1, 0, 1])
})

const reviewAt = (taskId: string, effort: string | null, serious: number, extra: Partial<UReview> = {}) =>
  review(taskId, "R", 1, serious ? "issues" : "pass", { serious, effort, ...extra })

test("serious issues are counted by the model that did the work and its effort, and across either", () => {
  const d = data()
  const r = issuesByModelAndEffort(d, [
    reviewAt("C", "high", 2, { taskModel: "sonnet" }),
    reviewAt("C", "high", 1, { taskModel: "sonnet" }),
    reviewAt("C", "low", 0, { taskModel: "sonnet" }),
    // The same task after its model changed.
    reviewAt("C", "high", 4, { taskModel: "opus" }),
    reviewAt("T", "xhigh", 3, { taskModel: "opus" }),
    // No model of its own: its task's most used. No effort: the agent's default.
    reviewAt("T", null, 1),
    reviewAt("C", "max", 0, { taskModel: "opus" }),
  ])
  assert.deepEqual(r.efforts, ["low", "high", "xhigh", "max", "default"])
  assert.deepEqual(
    r.models.map((m) => [m.model, m.all.serious, m.all.reviews, m.all.tasks]),
    [
      ["opus", 7, 3, 2],
      ["sonnet", 3, 3, 1],
      ["gpt", 1, 1, 1],
    ],
  )
  const sonnet = must(r.models.find((m) => m.model === "sonnet"))
  assert.deepEqual(sonnet.byEffort, {
    low: { tasks: 1, reviews: 1, withIssues: 0, serious: 0 },
    high: { tasks: 1, reviews: 2, withIssues: 2, serious: 3 },
  })
  // Any effort, across the models.
  assert.deepEqual(r.total.byEffort.high, { tasks: 1, reviews: 3, withIssues: 3, serious: 7 })
  assert.equal(must(r.total.byEffort.default).serious, 1)
  assert.deepEqual(r.total.all, { tasks: 2, reviews: 7, withIssues: 5, serious: 11 })
  assert.deepEqual(issuesByModelAndEffort(d, []), {
    efforts: [],
    models: [],
    total: { model: "All models", all: { tasks: 0, reviews: 0, withIssues: 0, serious: 0 }, byEffort: {} },
  })
})

test("axis ticks are round numbers", () => {
  assert.deepEqual(ticks(190), { top: 200, ticks: [0, 50, 100, 150, 200] })
  assert.deepEqual(ticks(2_100_000_000), { top: 3_000_000_000, ticks: [0, 1_000_000_000, 2_000_000_000, 3_000_000_000] })
  assert.deepEqual(ticks(0), { top: 1, ticks: [0] })
  assert.deepEqual(ticks(3).ticks, [0, 1, 2, 3])
})

test("cache hit rates, flags for poor ones, and which cache writes went to where it's known", () => {
  const rows = [
    row("C", 1, "opus", 1, { input: 10, cacheRead: 880, cacheWrite: 110, cacheWrite1h: 100, cacheWrite5m: 10 }),
    // An older run: its writes' cache isn't known.
    row("C", 2, "opus", 1, { input: 0, cacheRead: 900, cacheWrite: 100 }),
    // Codex doesn't say.
    row("T", 3, "gpt", 1, { runtime: "codex", input: 50, cacheRead: 950, cacheWrite: 0 }),
  ]
  const t = total(rows)
  assert.equal(hitRate(t), 2730 / 3000)
  assert.deepEqual([t.cacheWrite1h, t.cacheWrite5m, t.cacheWriteUnsplit, codexWrites(t)], [100, 10, 100, 0])
  assert.equal(hitRate(total([])), null)
  // A task's totals keep them, its threads' added in.
  const c = must(byTask(data(), rows, "tokens").find((u) => u.taskId === "C"))
  assert.deepEqual([c.totals.cacheWrite1h, c.totals.cacheWriteUnsplit], [100, 100])
  // Poor: under 85% on a million tokens or more of input; a short thread's first writes aren't.
  assert.ok(poorHit({ input: 100_000, cacheRead: 600_000, cacheWrite: 400_000 }))
  assert.ok(!poorHit({ input: 10, cacheRead: 60_000, cacheWrite: 40_000 }))
  assert.ok(!poorHit({ input: 10_000, cacheRead: 9_500_000, cacheWrite: 400_000 }))
})
