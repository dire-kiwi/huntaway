// The Tokens and Report tabs of Analytics (the old tests/ui/tokenStats.test.mjs). The reports are given by the check on
// the RPC websocket (`routeRpc`), as the old one answered `/token-stats` and `/analytics` with `page.route`. Changed:
// subprojects are gone (docs/plan/14-dropped-and-open.md), so the first case's "subproject" is a task with its review
// thread, and the expanding of a subproject's tasks is not checked.
import assert from "node:assert/strict"
import { afterAll, beforeAll, test } from "vite-plus/test"
import { makeProfile, routeRpc, startServer, success, withBrowser } from "./harness.mjs"

let server
let mine
beforeAll(async () => {
  server = startServer()
  mine = await makeProfile(server, "Default")
})
afterAll(() => server?.stop())

/** Answers `analytics.tokenStats` (and `analytics.report`) with `tokens(request)` (and `activity(request)`). */
const fake = (page, tokens, activity = () => undefined) =>
  routeRpc(page, (request) => {
    if (request.tag === "analytics.tokenStats") return success(tokens(request))
    if (request.tag === "analytics.report") {
      const a = activity(request)
      return a === undefined ? undefined : success(a)
    }
    return undefined
  })

const at = new Date().toISOString()
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
})
const usage = (run, taskId, model, output, extra = {}) => ({
  run_id: run,
  call_id: null,
  cache_write_1h_tokens: null,
  cache_write_5m_tokens: null,
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
})

// A task, whose review thread ran on Codex; and a task on its own.
const report = {
  usage: [
    usage("r1", "child", "claude-opus-5-5", 1000),
    usage("r2", "child", "claude-opus-5-5", 4000),
    usage("r3", "thread", "gpt-6.1-sol", 2000, { kind: "review", runtime: "codex", cost_usd: null }),
    usage("r4", "solo", "claude-sonnet-5-5", 500),
  ],
  reviews: [
    {
      task_id: "child",
      thread_id: "thread",
      at,
      verdict: "issues",
      serious: 2,
      minor: 1,
      minor_noted: true,
      label: "codex · xhigh",
      model: "gpt-6.1-sol",
      round: 2,
      effort: "high",
      task_model: "claude-opus-5-5",
    },
    {
      task_id: "solo",
      thread_id: "thread2",
      at,
      verdict: "pass",
      serious: 0,
      minor: null,
      minor_noted: false,
      label: null,
      model: "claude-opus-5-5",
      round: 1,
      effort: null,
      task_model: "claude-sonnet-5-5",
    },
  ],
  // Its task's first round was before the range.
  rounds: [
    { task_id: "child", round: 1, at, verdict: "issues", serious: 1, reviewers: 1 },
    { task_id: "child", round: 2, at, verdict: "issues", serious: 2, reviewers: 1 },
    { task_id: "solo", round: 1, at, verdict: "pass", serious: 0, reviewers: 1 },
  ],
  follow_ups: [{ task_id: "follow", created_by: "child", at: new Date(Date.now() + 1000).toISOString() }],
  tasks: [
    task("child", 2, "Its task"),
    task("thread", 0, "Review", { kind: "review", parent_id: "child" }),
    task("solo", 3, "On its own", { model: "claude-sonnet-5-5" }),
    task("follow", 4, "A follow-up"),
  ],
  projects: [],
  pending: 2,
}

test("the Tokens tab shows where tokens went and what reviews found", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    await fake(page, () => report)
    await ui.run(["goto /analytics", "click tokens", "wait What they were spent on", "wait 2 finished runs are still being counted"])
    const text = await page.locator("main, body").first().innerText()
    // Output: 1000 + 4000 + 2000 + 500.
    assert.match(text, /Output tokens\s+8k/)
    assert.match(text, /Claude's; Codex used 3k tokens/)
    // The task's row adds up its own runs and its review thread's.
    const row = page.locator("tr", { hasText: "Its task" }).first()
    await row.waitFor()
    assert.match(await row.innerText(), /\b10k\b/)
    // A reviewer is named with the model it ran, when its label doesn't say.
    await ui.run(["wait codex · xhigh · gpt-6.1-sol", "wait 1 of 1 task got 1 follow-up"])
    // Its first round counts, though it was before the range: one of the two tasks passed its first, and it took two rounds of fixes.
    const byModel = page.locator("div", { has: page.getByText("By the model that did the work", { exact: true }) }).last()
    assert.match(await byModel.locator("tr", { hasText: "claude-opus-5-5" }).innerText(), /^claude-opus-5-5\t1\t0% · 0\t2\.0\t/)
    // Serious issues, by the model that did the work and the effort: the first review's 2 are opus's at high effort, and the task that
    // passed is sonnet's at the default effort.
    const issues = page.locator("div", { has: page.getByText("Serious issues by model and effort", { exact: true }) }).last()
    assert.match(await issues.locator("thead").innerText(), /Model\s+All efforts\s+high\s+Default/)
    assert.match(await issues.locator("tr", { hasText: "claude-opus-5-5" }).innerText(), /^claude-opus-5-5\t2 · 2\.0\/task\t2 · 2\.0\/task\t–$/)
    assert.match(await issues.locator("tr", { hasText: "claude-sonnet-5-5" }).innerText(), /^claude-sonnet-5-5\t0 · 0\.0\/task\t–\t0 · 0\.0\/task$/)
    assert.match(await issues.locator("tr", { hasText: "All models" }).innerText(), /^All models\t2 · 1\.0\/task\t2 · 2\.0\/task\t0 · 0\.0\/task$/)
    // Cost: Codex has none.
    await ui.run(["click Cost", "wait Cost by day"])
    assert.match(await page.locator("tr", { hasText: "gpt-6.1-sol · Codex" }).innerText(), /0%/)
  })
})

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
  }
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    await fake(page, () => calls)
    await ui.run(["goto /analytics", "click tokens", "wait What they were spent on", "wait Window restarts"])
    const text = await page.locator("main, body").first().innerText()
    assert.match(text, /on 2 models, and 3 title or window calls/)
    assert.match(await page.locator("tr", { hasText: "Titles" }).innerText(), /Titles\s+· 2 calls/)
    assert.match(await page.locator("tr", { hasText: "Window restarts" }).innerText(), /Window restarts\s+· 1 call/)
    // A model only titles and window restarts used was used in calls, not in no runs.
    assert.equal(await page.locator("tr", { hasText: "claude-haiku-5-5 · Claude" }).locator("td").first().getAttribute("title"), "claude-haiku-5-5, in 3 calls")
    assert.equal(await page.locator("tr", { hasText: "claude-sonnet-5-5 · Claude" }).locator("td").first().getAttribute("title"), "claude-sonnet-5-5, in 1 run")
    // The task's own row has its run alone (with its titles it would be 4k).
    assert.match(await page.locator("tr", { hasText: "On its own" }).innerText(), /On its own\s+2k\s+2k\s+99%\s+claude-sonnet-5-5$/)
  })
})

test("the Tokens tab shows the prompt cache's hit rates, which cache writes went to, and flags poor hit rates", async () => {
  const cache = {
    ...report,
    usage: [
      // 1h and 5m writes said: a 90% hit rate on 1M tokens of input.
      usage("r1", "solo", "claude-opus-5-5", 100, {
        input_tokens: 0,
        cache_read_tokens: 900_000,
        cache_write_tokens: 100_000,
        cache_write_1h_tokens: 90_000,
        cache_write_5m_tokens: 10_000,
      }),
      // An older run (no split), whose task's cache was busted: 50% on 2M.
      usage("r2", "child", "claude-opus-5-5", 100, { input_tokens: 0, cache_read_tokens: 1_000_000, cache_write_tokens: 1_000_000 }),
      // Codex's: n/a.
      usage("r3", "thread", "gpt-6.1-sol", 100, { kind: "review", runtime: "codex", cost_usd: null, input_tokens: 100_000, cache_read_tokens: 900_000 }),
    ],
    reviews: [],
    rounds: [],
    follow_ups: [],
    pending: 0,
  }
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    await fake(page, () => cache)
    await ui.run(["goto /analytics", "click tokens", "wait Prompt cache"])
    const tiles = await page.locator("section", { has: page.getByText("Prompt cache", { exact: true }) }).innerText()
    // (900k + 1M + 900k) of 4M.
    assert.match(tiles, /Cache hit rate\s+70%/)
    assert.match(tiles, /Cache writes\s+1\.1M\s+1h 90k, 5m 10k, 1M unknown/)
    assert.match(tiles, /Low hit rate\s+1\s+task under 85%/)
    // By model: opus is under 85% over its 2M; Codex's writes are n/a.
    const opus = page.locator("tr", { hasText: "claude-opus-5-5 · Claude" })
    assert.match(await opus.innerText(), /\b63%/)
    assert.match(await opus.locator("td").nth(4).getAttribute("title"), /^Low cache hit rate/)
    assert.match(await page.locator("tr", { hasText: "gpt-6.1-sol · Codex" }).innerText(), /\b90%/)
    // By task: the busted one (with its Codex review) is flagged, the other isn't.
    const busted = page.locator("tr", { hasText: "Its task" }).first()
    assert.match(await busted.innerText(), /\b63%/)
    assert.equal(await busted.locator("svg.lucide-triangle-alert, svg.lucide-alert-triangle").count(), 1)
    const fine = page.locator("tr", { hasText: "On its own" })
    assert.match(await fine.innerText(), /\b90%/)
    assert.equal(await fine.locator("svg").count(), 0)
  })
})

// HA-328: Analytics has a tab for each profile and one for All, which adds them up. It's last here, as it adds a profile
// (which the fakes above would answer for too), and removes it when it's done.
const ago = (min) => new Date(Date.now() - min * 60_000).toISOString()
const prompt = (taskId, when) => ({ at: when, task_id: taskId, kind: "prompt", text: "go" })

test("Analytics shows each profile's on its tab and every profile's under All, and a reload keeps the tab", async () => {
  const work = await makeProfile(server, "work")
  try {
    const ofProfile = (request) => (request.payload.profile_id === work.id ? "work" : request.payload.profile_id === mine.id ? "Default" : null)
    const tokens = {
      Default: {
        ...report,
        usage: [usage("d1", "solo", "claude-opus-5-5", 1000)],
        reviews: [],
        rounds: [],
        follow_ups: [],
        tasks: [task("solo", 3, "On its own")],
        pending: 0,
      },
      work: {
        ...report,
        usage: [usage("w1", "theirs", "claude-opus-5-5", 3000)],
        reviews: [],
        rounds: [],
        follow_ups: [],
        tasks: [task("theirs", 1, "Their task")],
        pending: 0,
      },
    }
    // Prompts on Default's task 30 and 10 minutes ago, and on work's 20 minutes ago: each is credited the time since the
    // one before on any task, so All's 25m (5m for the first, then 10m and 10m) is Default's 15m and work's 10m.
    const activity = {
      Default: { events: [prompt("solo", ago(30)), prompt("solo", ago(10))], runs: [], tasks: [task("solo", 3, "On its own")], projects: [] },
      work: { events: [prompt("theirs", ago(20))], runs: [], tasks: [task("theirs", 1, "Their task")], projects: [] },
    }
    const asked = []
    await withBrowser(server, {}, async (ui) => {
      const { page } = ui
      await ui.context.addInitScript(() => {
        localStorage.setItem("ia.analytics.preset", JSON.stringify({ value: "last_7" }))
        localStorage.setItem("ia.analytics.rules", JSON.stringify({ value: { idleMin: 30, leadMin: 5 } }))
      })
      const answer = (kind, data) => (request) => {
        const p = ofProfile(request)
        asked.push(`${kind}:${p}`)
        return data[p]
      }
      await fake(page, answer("tokens", tokens), answer("activity", activity))
      const tabs = page.getByRole("tablist", { name: "Profile" })
      const selected = () => tabs.locator("[aria-selected=true]").innerText()

      await ui.run(["goto /analytics", "click tokens", "wait What they were spent on"])
      assert.equal(await selected(), "All")
      assert.deepEqual(await tabs.getByRole("tab").allInnerTexts(), ["All", "Default", "work"])
      const text = () => page.locator("main, body").first().innerText()
      assert.match(await text(), /Output tokens\s+4k/)
      await ui.run(["wait Their task", "wait On its own"])

      await tabs.getByRole("tab", { name: "work" }).click()
      await page.waitForURL(/\/analytics\/work$/)
      await ui.run(["wait Their task", "gone On its own"])
      assert.match(await text(), /Output tokens\s+3k/)
      // Only work's report was asked for.
      assert.equal(asked.at(-1), "tokens:work")

      // A reload keeps the tab.
      await page.reload()
      await ui.run(["wait Their task"])
      assert.equal(await selected(), "work")
      assert.match(await text(), /Output tokens\s+3k/)

      // Active time is worked out from every profile's prompts, then split.
      await ui.run(["click report", "wait Active time"])
      await page.getByText("Their task").first().waitFor()
      assert.match(await text(), /Active time\s+10m/)
      assert.match(await text(), /Prompts\s+1\b/)
      await tabs.getByRole("tab", { name: "Default" }).click()
      await page.waitForURL(/\/analytics\/Default$/)
      await ui.run(["wait On its own", "gone Their task"])
      assert.match(await text(), /Active time\s+15m/)
      await tabs.getByRole("tab", { name: "All" }).click()
      await page.waitForURL(/\/analytics$/)
      await ui.run(["wait On its own", "wait Their task"])
      assert.match(await text(), /Active time\s+25m/)
      assert.match(await text(), /Prompts\s+3\b/)
    })
  } finally {
    await server.rpc("profiles.delete", { id: work.id })
  }
})
