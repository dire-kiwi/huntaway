// A card's status bar at any column width (IA-150) and its agent's todo list (HA-316): the old taskCards check, on the
// demo board (`--demo`, whose task at work has its todo list). Where the old check routed the project's task list to
// give cards states no agent can reach here, this rewrites the tasks the board's stream (`board.watch`) brings.
//
// Dropped: the subproject's progress (its "2/8" and the bar along its card's bottom edge), as subprojects are gone
// (docs/plan/14-dropped-and-open.md); its card, "Card: subproject at work", is "Card: at work" here, a task at work
// with the rest of what it had.
import assert from "node:assert/strict"
import { afterAll, beforeAll, test } from "vite-plus/test"
import { startServer, withBrowser } from "./harness.mjs"
import { routeSockets } from "./servers.mjs"

let server, project
beforeAll(async () => {
  server = startServer("--demo")
  const [profile] = await server.rpc("profiles.list")
  project = (await server.rpc("projects.list", { profile_id: profile.id })).find((p) => p.name === "Demo")
})
afterAll(() => server?.stop())

const ago = (s) => new Date(Date.now() - s * 1000).toISOString()
const later = (s) => new Date(Date.now() + s * 1000).toISOString()
const review = (state, issues = []) => ({
  thread_id: "none",
  state,
  head: null,
  summary: "summary",
  issues,
  fixes: 0,
  extra_rounds: 0,
  updated_at: ago(60),
  reviewers: [],
})

// What the cards get on top of what the server says: agents can't run here, so their states are made up.
const STATES = {
  "Card: at work": {
    running: true,
    run_started_at: ago(4140),
    starred: true,
    remind_at: later(7200),
    branch: "ia/a",
    cost_usd: 4.12,
  },
  "Card: waiting agent": {
    running: true,
    run_started_at: ago(1380),
    agent_wait: { reason: "Waiting for CI on the release branch to finish", since: ago(600), until: later(1800), tasks: [], call_id: "call", run_id: "run" },
  },
  "Card: needs you": {
    status: "needs_attention",
    attention_reason: "Which of the two layouts should the sidebar use? I need your call before I go on.",
    starred: true,
    remind_at: later(86400),
  },
  "Card: reviewed": {
    status: "in_review",
    review: review("issues", Array(12).fill("an issue")),
    preview_url: "http://127.0.0.1:1/",
    pr_url: "https://github.com/o/r/pull/7",
    branch: "ia/b",
  },
  "Card: everything": {
    status: "in_review",
    labels: ["plan"],
    starred: true,
    remind_at: later(3 * 3600),
    review: review("running"),
    depends: true,
    branch: "ia/c",
    cost_usd: 12.75,
  },
  // Agents stopped on a permission prompt: still running, and needing you.
  "Card: approval while working": { status: "needs_attention", running: true, run_started_at: ago(600), attention_reason: "Allow Bash: cargo test?" },
  "Card: approval while merging": {
    status: "needs_attention",
    running: true,
    merging: true,
    run_started_at: ago(900),
    attention_reason: "Allow Bash: git push?",
  },
  "Card: won't fix": { status: "done", resolution: "wont_fix", done_at: ago(3600), last_activity_at: ago(3600) },
}

// IA-150: a card's status bar is one line at any column width, with the key and the state whole, and the badges'
// words come back once the card is 280px wide.
test("task cards keep their status bar on one line, and show words once there's room", async () => {
  for (const title of Object.keys(STATES)) await server.rpc("tasks.create", { task: { project_id: project.id, title, status: "in_progress" } })
  const dep = await server.rpc("tasks.create", { task: { project_id: project.id, title: "Card: dependency", status: "todo" } })
  const dress = (t) => {
    const s = STATES[t.title]
    if (!s) return t
    const { depends, ...fields } = s
    return { ...t, ...fields, ...(depends ? { depends_on: [dep.id] } : {}) }
  }
  await withBrowser(server, { allowErrors: [/127\.0\.0\.1:1\//] }, async (ui) => {
    const { page } = ui
    await routeSockets(page, {
      rewrite: (tag, value) =>
        tag !== "board.watch"
          ? value
          : value.type === "snapshot"
            ? { ...value, tasks: value.tasks.map(dress) }
            : value.type === "task"
              ? { ...value, task: dress(value.task) }
              : value,
    })
    const rows = () =>
      page.evaluate(() =>
        Object.fromEntries(
          [...document.querySelectorAll("[data-task]")].map((card) => {
            const row = card.firstElementChild
            const [key, state] = [row.firstElementChild, row.lastElementChild]
            const whole = (el) => el.scrollWidth <= el.clientWidth && el.getBoundingClientRect().right <= card.getBoundingClientRect().right
            const title = card.children[1].textContent
            return [
              title,
              {
                height: row.getBoundingClientRect().height,
                width: card.getBoundingClientRect().width,
                key: whole(key),
                state: whole(state),
                text: row.innerText.replace(/\s+/g, " "),
                stateTitle: state.title,
                stateClass: state.className,
              },
            ]
          }),
        ),
      )

    // The narrowest columns (240px), with every column on screen or not.
    await page.setViewportSize({ width: 1250, height: 900 })
    await ui.run([`goto /p/${project.id}`, "wait Card: everything", "wait Card: won't fix"])
    let cards = await rows()
    for (const title of [...Object.keys(STATES), "Card: dependency"]) {
      const c = cards[title]
      assert.ok(c, `no card for ${title}`)
      assert.ok(c.width < 280, `${title}: ${c.width}px wide`)
      assert.ok(c.height <= 18, `${title}: its status bar is ${c.height}px high: ${c.text}`)
      assert.ok(c.key && c.state, `${title}: its key or state is cut off: ${c.text}`)
    }
    assert.match(cards["Card: reviewed"].text, /12(?! issues)/)
    assert.doesNotMatch(cards["Card: won't fix"].text, /Won't fix/)
    // The state: needing you before the agent's run, which still shows how long it's been going.
    const state = (title) => [cards[title].stateTitle, cards[title].stateClass, cards[title].text]
    assert.match(state("Card: needs you")[0], /^Needs your input · /)
    for (const [title, run] of [
      ["Card: approval while working", /working since/],
      ["Card: approval while merging", /merging since/],
    ]) {
      const [tip, cls, text] = state(title)
      assert.match(tip, /^Needs your input · /, title)
      assert.match(tip, run, title)
      assert.match(cls, /text-st-attention/, title)
      assert.match(text, /\d+m \d\ds$/, title)
    }
    assert.match(state("Card: at work")[0], /^Working since/)
    assert.match(state("Card: at work")[1], /text-st-progress/)
    assert.match(state("Card: waiting agent")[0], /^Waiting for CI/)

    // Wide columns: the words are back.
    await page.setViewportSize({ width: 2700, height: 900 })
    await page.waitForFunction(() => document.querySelector("[data-task]").getBoundingClientRect().width >= 280)
    cards = await rows()
    assert.match(cards["Card: reviewed"].text, /12 issues/)
    assert.match(cards["Card: won't fix"].text, /Won't fix · 1h ago/)
    assert.match(cards["Card: everything"].text, /plan.*-\d+.*reviewing/)
    for (const [title, c] of Object.entries(cards)) assert.ok(c.height <= 18, `${title}: its status bar is ${c.height}px high: ${c.text}`)
  })
})

// HA-316: a card lists its agent's todo list, the first five items and how many more; the demo's task at work has seven.
test("a card lists its agent's todos, five of them and how many more", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    await ui.run([`goto /p/${project.id}`, "wait Something being worked on"])
    const list = page.locator("[data-task]", { hasText: "Something being worked on" }).locator("[aria-label='Todo list'] li")
    await list.last().waitFor()
    const items = await list.evaluateAll((els) => els.map((el) => [el.innerText.replace(/\s+/g, " ").trim(), el.className]))
    assert.equal(items.length, 6, JSON.stringify(items))
    assert.match(items[0][0], /^✓ Read how the board stores tasks$/)
    assert.match(items[0][1], /line-through/)
    assert.match(items[2][0], /^◐ Show it on the task's card$/)
    assert.match(items[4][0], /^○ Add it to the demo board$/)
    assert.equal(items[5][0], "(2 more items)")
    // Cards without a list have none.
    assert.equal(await page.locator("[data-task]", { hasText: "Try dragging this card" }).locator("[aria-label='Todo list']").count(), 0)
  })
})
