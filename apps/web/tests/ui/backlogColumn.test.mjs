import assert from "node:assert/strict"
import { afterAll, beforeAll, test } from "vite-plus/test"
import { DEMO_TASKS, eventually, makeProfile, makeProject, makeTask, seedBoard, startServer, tasksByTitle, withBrowser } from "./harness.mjs"

let server, board
beforeAll(async () => {
  server = startServer()
  board = await seedBoard(server, DEMO_TASKS)
})
afterAll(() => server?.stop())

const PARKED = "An idea for later"
const TITLE = "Edit this task's title and description"

// IA-125: backlog tasks were left off the kanban board, so a task an agent moved there seemed to vanish.
// The board ends in a Backlog column that starts collapsed, takes drops while collapsed and remembers being open.
test("the kanban board's Backlog column collapses, opens and takes drops", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    await ui.run([`goto /p/${board.project.id}`, "wait Show the backlog (1)", `gone ${PARKED}`])

    // A card dropped on the collapsed strip goes to the backlog.
    await page.locator("[data-task]", { hasText: TITLE }).dragTo(page.getByTitle(/Show the backlog/))
    await ui.run(["wait Show the backlog (2)", `gone ${TITLE}`])
    await eventually(async () => assert.equal((await tasksByTitle(server, board.project))[TITLE].status, "backlog"))

    // Opened, it shows its tasks, and stays open over a reload until collapsed again.
    await ui.run(["click Show the backlog", `wait ${PARKED}`, `wait ${TITLE}`, `goto /p/${board.project.id}`, `wait ${PARKED}`])
    await ui.run(["click Collapse the backlog", `gone ${PARKED}`, `goto /p/${board.project.id}`, "wait Show the backlog", `gone ${PARKED}`])
  })
})

// IA-125 review: a profile's board with no projects (IA-120) has the Backlog column too, and its tasks can be dropped on it.
test("a profile's board with no projects has a Backlog column that takes drops", async () => {
  const lab = await makeProfile(server, "lab")
  await server.rpc("tasks.create", { task: { profile_id: lab.id, title: "Old question", status: "in_review" } })
  const status = async () =>
    (await server.rpc("tasks.list", { filter: { _tag: "Projectless", profile_id: lab.id } })).find((t) => t.title === "Old question")?.status
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    // Empty, it's a strip that still takes drops (HE-53).
    await ui.run(["goto /profile/lab", "wait Old question", "wait css=section[data-status=backlog] >> text=0"])
    await page.locator("[data-task]", { hasText: "Old question" }).dragTo(page.locator("section[data-status=backlog]"))
    await ui.run(["wait Show the backlog (1)", "gone Old question"])
    await eventually(async () => assert.equal(await status(), "backlog"))
    await ui.run(["click Show the backlog", "wait Old question", "click Collapse the backlog", "gone Old question"])
  })
})

// IA-125: the backlog comes first in both views, collapsed until opened (in one view, which opens it in the other).
test("the backlog is first and starts collapsed in the board and list views", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    // The first column's (or list section's) label.
    const first = () => page.evaluate(() => document.querySelector("section")?.textContent)
    await ui.run([`goto /p/${board.project.id}`, "wait Show the backlog"])
    assert.match(await first(), /^\d*Backlog$/)

    await ui.run(["click List view", "wait css=section h2", `gone ${PARKED}`])
    assert.match(await first(), /^Backlog\d+/)
    await ui.run(["click css=section >> text=Backlog", `wait ${PARKED}`, "click Board view", "wait Collapse the backlog", `wait ${PARKED}`])
    await ui.run(["click Collapse the backlog", `gone ${PARKED}`])
  })
})

// Each column's width, by status.
const widths = (page) =>
  page.evaluate(() =>
    Object.fromEntries([...document.querySelectorAll("section[data-status]")].map((e) => [e.dataset.status, e.getBoundingClientRect().width])),
  )

// HE-53: To do, Backlog and Needs attention are a strip while nothing is in them. A drop on one moves the task there
// and opens the column; clicking an empty To do (or Backlog) starts a new task in it.
test("empty To do, Backlog and Needs attention columns collapse to strips", async () => {
  const profile = await makeProfile(server, "quiet")
  const project = await makeProject(server, profile, "Quiet", "QUI")
  await makeTask(server, project, { title: "Being looked at", status: "in_review" })
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    await ui.run([`goto /p/${project.id}`, "wait Being looked at", "wait To do is empty. New task in To do"])
    const before = await widths(page)
    for (const s of ["todo", "backlog", "needs_attention"]) assert.ok(before[s] < 60, `${s} is a strip`)
    for (const s of ["in_progress", "in_review", "done"]) assert.ok(before[s] > 200, `${s} is a column`)

    // Clicking the To do strip opens New task in To do.
    await ui.run(["click To do is empty. New task in To do", "wait Create task", "press Escape", "gone Create task"])

    // A card dropped on the Needs attention strip goes there, and the column opens.
    await page.locator("[data-task]", { hasText: "Being looked at" }).dragTo(page.locator("section[data-status=needs_attention]"))
    await eventually(async () => assert.equal((await tasksByTitle(server, project))["Being looked at"].status, "needs_attention"))
    await eventually(async () => assert.ok((await widths(page)).needs_attention > 200))
    assert.ok((await widths(page)).in_review > 200, "In review stays a column while empty")
  })
})
