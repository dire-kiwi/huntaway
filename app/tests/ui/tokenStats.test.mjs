import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { startServer, withBrowser } from "./harness.mjs";

let server;
before(() => {
  server = startServer();
});
after(() => server?.stop());

const at = new Date().toISOString();
const task = (id, number, title, extra = {}) => ({
  id,
  project_id: null,
  kind: "task",
  number,
  title,
  status: "in_review",
  parent_id: null,
  task_type: null,
  subproject: false,
  group_name: null,
  model: "claude-opus-5-5",
  ...extra,
});
const usage = (run, taskId, model, output, extra = {}) => ({
  run_id: run,
  task_id: taskId,
  kind: "prompt",
  at,
  model,
  runtime: "claude",
  input_tokens: 10,
  output_tokens: output,
  cache_read_tokens: 1000,
  cache_write_tokens: 0,
  reasoning_tokens: 0,
  cost_usd: output / 1000,
  estimated: false,
  ...extra,
});

// A subproject with a task, whose review thread ran on Codex; and a task on its own.
const report = {
  usage: [
    usage("r1", "sub", "claude-opus-5-5", 1000),
    usage("r2", "child", "claude-opus-5-5", 4000),
    usage("r3", "thread", "gpt-6.1-sol", 2000, { kind: "review", runtime: "codex", cost_usd: null }),
    usage("r4", "solo", "claude-sonnet-5-5", 500),
  ],
  reviews: [
    { task_id: "child", thread_id: "thread", at, verdict: "issues", serious: 2, minor: 1, minor_noted: true, label: "codex · xhigh", model: "gpt-6.1-sol", round: 2 },
    { task_id: "solo", thread_id: "thread2", at, verdict: "pass", serious: 0, minor: null, minor_noted: false, label: null, model: "claude-opus-5-5", round: 1 },
  ],
  // Its task's first round was before the range.
  rounds: [
    { task_id: "child", round: 1, at, verdict: "issues", serious: 1, reviewers: 1 },
    { task_id: "child", round: 2, at, verdict: "issues", serious: 2, reviewers: 1 },
    { task_id: "solo", round: 1, at, verdict: "pass", serious: 0, reviewers: 1 },
  ],
  follow_ups: [{ task_id: "follow", created_by: "child", at: new Date(Date.now() + 1000).toISOString() }],
  tasks: [
    task("sub", 1, "The subproject", { subproject: true }),
    task("child", 2, "Its task", { parent_id: "sub" }),
    task("thread", 0, "Review", { kind: "review", parent_id: "child" }),
    task("solo", 3, "On its own", { model: "claude-sonnet-5-5" }),
    task("follow", 4, "A follow-up"),
  ],
  projects: [],
  pending: 2,
};

test("the Tokens tab shows where tokens went, a subproject's tasks and what reviews found", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    await page.route(/\/token-stats\?/, (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(report) }));
    await ui.run(["goto /analytics", "click tokens", "wait What they were spent on", "wait 2 finished runs are still being counted"]);
    const text = await page.locator("main, body").first().innerText();
    // Output: 1000 + 4000 + 2000 + 500.
    assert.match(text, /Output tokens\s+8k/);
    assert.match(text, /Claude's; Codex used 3k tokens/);
    // The subproject's row adds up its task's, its review thread's included; its task shows once it's expanded.
    const row = page.locator("tr", { hasText: "The subproject" });
    await row.waitFor();
    assert.match(await row.innerText(), /\b10k\b/);
    assert.equal(await page.locator("tr", { hasText: "Its task" }).count(), 0);
    await row.getByTitle("Show its 1 task").click();
    await page.locator("tr", { hasText: "Its task" }).waitFor();
    // A reviewer is named with the model it ran, when its label doesn't say.
    await ui.run(["wait codex · xhigh · gpt-6.1-sol", "wait 1 of 1 task got 1 follow-up"]);
    // Its first round counts, though it was before the range: one of the two tasks passed its first, and it took two rounds of fixes.
    const byModel = page.locator("div", { has: page.getByText("By the model that did the work", { exact: true }) }).last();
    assert.match(await byModel.locator("tr", { hasText: "claude-opus-5-5" }).innerText(), /^claude-opus-5-5\t1\t0% · 0\t2\.0\t/);
    // Cost: Codex has none.
    await ui.run(["click Cost", "wait Cost by day"]);
    assert.match(await page.locator("tr", { hasText: "gpt-6.1-sol · Codex" }).innerText(), /0%/);
  });
});

test("titles and window restarts show as calls of their own, outside tasks' totals", async () => {
  const calls = {
    ...report,
    usage: [
      usage("r4", "solo", "claude-sonnet-5-5", 500),
      // Two titles in the same millisecond are two calls.
      usage(null, "solo", "claude-haiku-5-5", 30, { kind: "title", call_id: "c1" }),
      usage(null, "solo", "claude-haiku-5-5", 20, { kind: "title", call_id: "c2" }),
      usage(null, null, "claude-haiku-5-5", 7, { kind: "window", call_id: "c3" }),
    ],
    reviews: [],
    rounds: [],
    follow_ups: [],
    pending: 0,
  };
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    await page.route(/\/token-stats\?/, (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(calls) }));
    await ui.run(["goto /analytics", "click tokens", "wait What they were spent on", "wait Window restarts"]);
    const text = await page.locator("main, body").first().innerText();
    assert.match(text, /on 2 models, and 3 title or window calls/);
    assert.match(await page.locator("tr", { hasText: "Titles" }).innerText(), /Titles\s+· 2 calls/);
    assert.match(await page.locator("tr", { hasText: "Window restarts" }).innerText(), /Window restarts\s+· 1 call/);
    // A model only titles and window restarts used was used in calls, not in no runs.
    assert.equal(await page.locator("tr", { hasText: "claude-haiku-5-5 · Claude" }).locator("td").first().getAttribute("title"), "claude-haiku-5-5, in 3 calls");
    assert.equal(await page.locator("tr", { hasText: "claude-sonnet-5-5 · Claude" }).locator("td").first().getAttribute("title"), "claude-sonnet-5-5, in 1 run");
    // The task's own row has its run alone (with its titles it would be 4k).
    assert.match(await page.locator("tr", { hasText: "On its own" }).innerText(), /On its own\s+2k\s+2k\s+claude-sonnet-5-5$/);
  });
});
