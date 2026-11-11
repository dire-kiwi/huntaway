import assert from "node:assert/strict"
import { afterAll, beforeAll, test } from "vite-plus/test"
import { column, DEMO_TASKS, eventually, makeTask, seedBoard, startServer, tasksByTitle, titles, updateTask, withBrowser } from "./harness.mjs"

let server, board
beforeAll(async () => {
  server = startServer()
  board = await seedBoard(server, [
    ...DEMO_TASKS,
    { title: "How a task moves across the board", status: "in_review", labels: ["diagram"] },
    { title: "A release notes card", status: "in_review", labels: ["artifact"] },
  ])
})
afterAll(() => server?.stop())

const tasks = () => tasksByTitle(server, board.project)

// HA-306: the search lists the board's tasks it finds in a popover, to open one, rather than filtering the board. Its keys
// and clicks are checked on the field alone in tests/browser/searchBox.test.tsx (old); this is the board's wiring.
test("the search lists the board's tasks it finds, and opens one in the board's panel", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    await ui.run([`goto /p/${board.project.id}`, "wait Something being worked on", "press /", "type dark mode", "wait Tasks found"])
    const hits = await page.getByRole("listbox", { name: "Tasks found" }).getByRole("option").allTextContents()
    assert.equal(hits.length, 1)
    assert.match(hits[0], /DEM-\d+Plan a dark mode for the demo siteIn review/)
    // The board isn't filtered, and says nothing of the search.
    await ui.run(["wait Something being worked on", "gone of 10 tasks", "press Enter", "gone Tasks found"])
    const plan = (await tasks())["Plan a dark mode for the demo site"]
    await page.waitForURL((u) => u.pathname === `/p/${board.project.id}` && u.searchParams.get("task") === plan.id)
  })
})

// IA-217: statuses pick the columns, types and flags the cards; each filter shows in the bar below the header, to take off.
test("filters leave out columns and cards, and come off one by one", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    await ui.run([`goto /p/${board.project.id}`, "wait Something being worked on", "click Filter", "click css=[role=menuitemcheckbox] >> text=In review"])
    await ui.run(["click css=[role=menuitemcheckbox] >> text=Plan", "click css=[role=menuitemcheckbox] >> text=Diagram", "press Escape", "gone Has a reminder"])
    await ui.run(["wait 2 of 10 tasks", "gone Something being worked on", "gone Show the backlog", "gone A release notes card", "wait Plan a dark mode"])
    assert.deepEqual(await titles(page, "In review"), ["Plan a dark mode for the demo site", "How a task moves across the board"])
    assert.equal(await page.locator("section").count(), 1)
    // Taking the status off brings the columns back, with only the plans and diagrams in them.
    await page.locator("span:has(> button[title='Remove this filter'])", { hasText: "In review" }).getByTitle("Remove this filter").click()
    await ui.run(["wait 2 of 10 tasks", "wait Show the backlog (0)", "gone Something being worked on"])
    await ui.run(["click Clear all", "wait Something being worked on", "gone of 10 tasks"])
  })
})

// IA-217: with a filter on, a task dropped below a column's last card goes after that card, not after the tasks filtered out.
test("a task dropped under a filtered column goes after its last card shown", async () => {
  // The card to drag gets a plan label, so a filter by plans and diagrams keeps it and leaves out the artifact at the
  // bottom of In review.
  const drag = (await tasks())["Try dragging this card to another column"]
  await updateTask(server, drag, { labels: ["plan"] })
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    await ui.run([`goto /p/${board.project.id}`, "wait Something being worked on", "click Filter", "click css=[role=menuitemcheckbox] >> text=Diagram"])
    await ui.run(["click css=[role=menuitemcheckbox] >> text=Plan", "press Escape", "gone Has a reminder", "gone A release notes card"])
    const review = column(page, "In review")
    await page.locator("[data-task]", { hasText: "Try dragging this card" }).dragTo(review, { targetPosition: { x: 100, y: 600 } })
    await review.locator("[data-task]", { hasText: "Try dragging this card" }).waitFor()
    await ui.run(["click Clear all", "wait A release notes card"])
    assert.deepEqual(await titles(page, "In review"), [
      "Finished work to look over",
      "Plan a dark mode for the demo site",
      "How a task moves across the board",
      "Try dragging this card to another column",
      "A release notes card",
    ])
    await eventually(async () => assert.equal((await tasks())["Try dragging this card to another column"].status, "in_review"))
  })
  await updateTask(server, drag, { labels: [], status: "todo" })
})

// IA-217: sorted other than by hand, the columns are in that order, and a drop only moves a task to another column (at its end).
test("a sort orders the columns, and a drop then only changes the column", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    await ui.run([`goto /p/${board.project.id}`, "wait Something being worked on", "click Sort", "click Title", "wait css=button[title^='Sorted by title']"])
    const sorted = ["A release notes card", "Finished work to look over", "How a task moves across the board", "Plan a dark mode for the demo site"]
    assert.deepEqual(await titles(page, "In review"), sorted)
    // Within its column, a drop changes nothing.
    const before = await tasks()
    await page.locator("[data-task]", { hasText: "Plan a dark mode" }).dragTo(page.locator("[data-task]", { hasText: "A release notes card" }))
    await page.waitForTimeout(300)
    assert.deepEqual(await titles(page, "In review"), sorted)
    const after = await tasks()
    for (const title of sorted) assert.equal(after[title].position, before[title].position, title)
    // In another column it goes last, under the board's own order.
    await page.locator("[data-task]", { hasText: "A release notes card" }).dragTo(page.locator("[data-task]", { hasText: "Edit this task's title" }))
    await column(page, "To do").locator("[data-task]", { hasText: "A release notes card" }).waitFor()
    assert.deepEqual(await titles(page, "To do"), [
      "A release notes card",
      "Edit this task's title and description",
      "Try dragging this card to another column",
    ])
    const moved = await eventually(async () => {
      const t = await tasks()
      assert.equal(t["A release notes card"].status, "todo")
      return t
    })
    assert.ok(moved["A release notes card"].position > moved["Edit this task's title and description"].position)
    // The sort is kept, and back on Manual the column is in the board's order again.
    await ui.run([
      `goto /p/${board.project.id}`,
      "wait css=button[title^='Sorted by title']",
      "click Sort",
      "click Manual",
      "wait css=button[title^='Sort the board']",
    ])
    // (The check before this one put "Try dragging…" back in To do, at its end.)
    assert.deepEqual(await titles(page, "To do"), [
      "Edit this task's title and description",
      "Try dragging this card to another column",
      "A release notes card",
    ])
  })
})

// HA-306: a long list stops at 20 tasks and says how many more it found; on a phone a tap on one opens it.
test("the search lists 20 tasks at most, and a tap opens one on a phone", async () => {
  const made = []
  for (let i = 0; i < 23; i++) made.push(await makeTask(server, board.project, { title: `Bulk search task ${i}`, status: "backlog" }))
  await withBrowser(server, { size: "390x844", touch: true }, async (ui) => {
    const { page } = ui
    await ui.run([`goto /p/${board.project.id}`, "click Search tasks", "type bulk search", "wait 3 more"])
    assert.equal(await page.getByRole("option").count(), 20)
    await page.getByRole("option", { name: /Bulk search task 7\b/ }).tap()
    const t = made.find((m) => m.title === "Bulk search task 7")
    await page.waitForURL((u) => u.searchParams.get("task") === t.id)
  })
  for (const t of made) await server.rpc("tasks.delete", { id: t.id })
})
