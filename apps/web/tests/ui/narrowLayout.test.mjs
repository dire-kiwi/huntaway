// Ports the old narrowLayout check (HA-13, HA-30, HA-92): a phone's drawer, one column at a time, cards' move menus and a
// task full screen; a tablet's and a desktop's layouts.
//
// Changed from the old check: it ran on the demo board, where this one makes it (the demo's tasks, DEMO_TASKS, and a
// task done three days ago, archived), on a board whose agents run with the fake claude (the old one's ran /bin/false):
// the Start button is only there on a host that runs agents. The project's key is DEM, so the moved card's key is read
// from the task rather than written as DEMO-2. Tasks are read back with `tasks.list` rather than the REST routes. The old
// check slept 600 ms for a phone's column to scroll before clicking a card in it, and 500 ms to see that a slow scroll
// didn't take the column back; these wait for the card to be on screen, and for the slow scroll to have run. The Start
// button's case opens the demo's other To do task: the one the old check opened had been moved to In review by the case
// before it (its click found the card in the column it had left the page on).
import assert from "node:assert/strict"
import { afterAll, beforeAll, test } from "vite-plus/test"
import { DEMO_TASKS, makeTask, seedAgentBoard, startServer, tasksByTitle, updateTask, withBrowser } from "./harness.mjs"

const PHONE = { size: "390x844", touch: true }
const TODO = "Edit this task's title and description"
// Still in To do once TODO has been moved on.
const OTHER_TODO = "Try dragging this card to another column"
const ATTENTION = "A task waiting on an answer"
const REVIEW = "Finished work to look over"
const ARCHIVED = "Shipped last week"

let server, board
beforeAll(async () => {
  server = startServer("--fake-claude")
  board = await seedAgentBoard(server)
  board.tasks = []
  for (const t of DEMO_TASKS) board.tasks.push(await makeTask(server, board.project, t))
  // Done three days ago: past the two days that archive a task.
  const old = await makeTask(server, board.project, { title: ARCHIVED, status: "done" })
  await updateTask(server, old, { done_at: new Date(Date.now() - 3 * 24 * 3600_000).toISOString() })
})
afterAll(() => server?.stop())

/** Whether the card with `text` is on screen (not in a column scrolled off to the side, say), and on a phone its column
 * has finished scrolling into place. Runs in the page. */
function cardOnScreen(text) {
  const el = [...document.querySelectorAll("[data-task]")].find((e) => e.textContent.includes(text))
  if (!el) return false
  const r = el.getBoundingClientRect()
  if (!(r.width > 0 && r.left >= 0 && r.right <= innerWidth && r.top < innerHeight)) return false
  const column = el.closest("[role=tabpanel]")
  return !column || Math.abs(column.getBoundingClientRect().left - column.parentElement.getBoundingClientRect().left) < 1
}
const onScreen = (page, text) => page.evaluate(cardOnScreen, text)
/** Waits for the card with `text` to be on screen, as a column scrolls to it. */
const untilOnScreen = (page, text) => page.waitForFunction(cardOnScreen, text, { timeout: 5000 })

// HA-13: on a phone the sidebar is a drawer, opened from the page's header and closed once it's taken you somewhere.
test("on a phone the sidebar is a drawer", async () => {
  await withBrowser(server, PHONE, async (ui) => {
    const { page } = ui
    await ui.run([`goto /p/${board.project.id}`, "wait role=tablist[name='Columns']"])
    assert.equal(await page.getByRole("button", { name: "Settings", exact: true }).isVisible(), false, "the sidebar starts closed")
    await ui.run(["click Menu", "wait role=button[name='Settings's]"])
    // A press beside it closes it, and so does Escape.
    await page.mouse.click(370, 400)
    await ui.run([
      "gone role=button[name='Settings's]",
      "click Menu",
      "wait role=button[name='Settings's]",
      "press Escape",
      "gone role=button[name='Settings's]",
    ])
    // Going somewhere from it closes it.
    await ui.run(["click Menu", "click role=button[name='Settings's]", "wait role=heading[name='Settings']", "gone role=button[name='Analytics']"])
    assert.equal(new URL(page.url()).pathname, "/settings")
    await ui.run(["click Menu", "click role=button[name='Analytics']", "wait role=heading[name='Analytics']"])
  })
})

// HA-13: a phone's board shows one column at a time, picked from tabs above it or by swiping, and remembered.
test("on a phone the board shows one column at a time", async () => {
  await withBrowser(server, PHONE, async (ui) => {
    const { page } = ui
    await ui.run([`goto /p/${board.project.id}`, "wait role=tablist[name='Columns']"])
    // Nothing picked yet: it opens on what needs attention.
    assert.match(await page.getByRole("tab", { selected: true }).textContent(), /^\W*Needs attention1$/)
    await untilOnScreen(page, ATTENTION)
    assert.equal(await onScreen(page, TODO), false)

    await ui.run(["click role=tab[name=/^To do/]"])
    await untilOnScreen(page, TODO)
    assert.equal(await onScreen(page, ATTENTION), false)

    // Swiping sideways picks the next column.
    await page.evaluate(() => {
      const el = document.querySelector("[role=tabpanel]").parentElement
      el.scrollTo({ left: el.scrollLeft + el.clientWidth, behavior: "instant" })
    })
    await ui.run(["wait role=tab[name=/^In progress/][selected=true]"])

    // The column picked last is the one shown next time.
    await ui.run([`goto /p/${board.project.id}`, "wait role=tab[name=/^In progress/][selected=true]"])
    await untilOnScreen(page, "Something being worked on")

    // HA-30: each board remembers its own: another board opens on what needs attention, and its pick doesn't move this one's.
    await ui.run(["goto /profile/Default", "wait role=tab[name=/^Needs attention/][selected=true]", "click role=tab[name=/^Backlog/]"])
    await ui.run(["wait role=tab[name=/^Backlog/][selected=true]", `goto /p/${board.project.id}`, "wait role=tab[name=/^In progress/][selected=true]"])
  })
})

// HA-13: dragging doesn't work on a touch screen, so a card's menu button moves it to another column.
test("on a phone a card's menu moves it to another column", async () => {
  const todo = board.tasks.find((t) => t.title === TODO)
  await withBrowser(server, PHONE, async (ui) => {
    const { page } = ui
    await ui.run([`goto /p/${board.project.id}`, "click role=tab[name=/^To do/]"])
    await untilOnScreen(page, TODO)
    await ui.run([`click [aria-label="Move ${TODO} to…"]`, "wait role=menu"])
    assert.ok((await page.getByRole("menu").textContent()).startsWith(`Move ${board.project.key}-${todo.number} to`))
    // Within the screen.
    const box = await page.getByRole("menu").boundingBox()
    assert.ok(box.x >= 0 && box.x + box.width <= 390, `menu at ${JSON.stringify(box)}`)
    // In review had two (the demo's), and has three now.
    await ui.run(["click role=menuitemradio[name='In review']", "gone role=menu", "wait role=tab[name=/^In review\\s*3$/]"])
    assert.equal((await tasksByTitle(server, board.project))[TODO].status, "in_review")
    await ui.run(["click role=tab[name=/^In review/]"])
    await untilOnScreen(page, TODO)
    await untilOnScreen(page, REVIEW)
  })
})

// HA-92: on a busy phone a column's smooth scroll can be slow to get going, and the column it was leaving took back over.
test("on a phone a column picked above the board is the one shown, however slowly the board scrolls to it", async () => {
  await withBrowser(server, PHONE, async (ui) => {
    const { page } = ui
    await ui.run([`goto /p/${board.project.id}`, "click role=tab[name=/^Needs attention/]"])
    await untilOnScreen(page, ATTENTION)
    // A smooth scroll that starts a second late; `window.slowScrolled` is set once it has run.
    await page.evaluate(() => {
      const el = document.querySelector("[role=tabpanel]").parentElement
      const scrollTo = el.scrollTo.bind(el)
      el.scrollTo = (o) =>
        o?.behavior === "smooth"
          ? setTimeout(() => {
              scrollTo(o)
              window.slowScrolled = true
            }, 1000)
          : scrollTo(o)
    })
    await ui.run(["click role=tab[name=/^In review/]"])
    await untilOnScreen(page, REVIEW)
    await page.waitForFunction(() => window.slowScrolled === true)
    // The scroll's events after it.
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
    assert.ok(await onScreen(page, REVIEW), "still in review")
    assert.equal(await page.getByRole("tab", { selected: true }).textContent(), await page.getByRole("tab", { name: /^In review/ }).textContent())
  })
})

// HA-13: a task opens over the whole of a phone's screen, with a back button to the board.
test("on a phone a task opens full screen with a back button", async () => {
  await withBrowser(server, PHONE, async (ui) => {
    const { page } = ui
    await ui.run([`goto /p/${board.project.id}`, "click role=tab[name=/^Needs attention/]"])
    await untilOnScreen(page, ATTENTION)
    await ui.run([`click ${ATTENTION}`, "wait role=button[name='Back']"])
    assert.ok(new URL(page.url()).searchParams.get("task"))
    const panel = await page.locator("main").first().boundingBox()
    assert.equal(Math.round(panel.width), 390)
    // No expand or close buttons: the back button closes it.
    assert.equal(await page.getByTitle("Expand").count(), 0)
    // On a touch screen Enter starts a new line, and the send button sends.
    await ui.run(["click Add extra instructions", "type first line", "press Enter", "type second line"])
    assert.equal(await page.locator("textarea").inputValue(), "first line\nsecond line")
    // HA-30: so the send button's title doesn't offer Enter.
    assert.equal(await page.locator("button[title^='Send']").getAttribute("title"), "Send")
    await ui.run(["click role=button[name='Back']", "gone role=button[name='Back']", "wait role=tablist[name='Columns']"])
    assert.equal(new URL(page.url()).searchParams.get("task"), null)
  })
})

// HA-30: the header's row of tabs scrolls sideways on a phone, so Start is in the row above it, where it stays on screen.
test("on a phone a task's Start button is on screen", async () => {
  await withBrowser(server, PHONE, async (ui) => {
    const { page } = ui
    await ui.run([`goto /p/${board.project.id}`, "click role=tab[name=/^To do/]"])
    await untilOnScreen(page, OTHER_TODO)
    await ui.run([`click ${OTHER_TODO}`, "wait role=button[name='Back']"])
    const start = await page.getByRole("button", { name: "Start", exact: true }).boundingBox()
    assert.ok(start && start.x >= 0 && start.x + start.width <= 390 && start.y < 48, `Start at ${JSON.stringify(start)}`)
    const tabs = await page.getByRole("button", { name: "details", exact: true }).boundingBox()
    assert.ok(tabs.x + tabs.width <= 390, `Details at ${JSON.stringify(tabs)}`)
  })
})

// HA-30: a card's menu brings an archived task back into Done, as dragging it there does on a desktop.
test("on a phone a card's menu brings an archived task back into Done", async () => {
  await withBrowser(server, PHONE, async (ui) => {
    const { page } = ui
    await ui.run([
      `goto /p/${board.project.id}`,
      "click role=tab[name=/^Done/]",
      "click 1 archived",
      `wait ${ARCHIVED}`,
      `click [aria-label="Move ${ARCHIVED} to…"]`,
    ])
    // It isn't in Done (nothing's ticked), and picking Done brings it back.
    const done = page.getByRole("menuitemradio", { name: /^\W*Done$/ })
    assert.equal(await done.getAttribute("aria-checked"), "false")
    await done.click()
    await ui.run(["gone role=menu", "wait Tasks done for two days move here"])
    const task = (await tasksByTitle(server, board.project))[ARCHIVED]
    assert.equal(task.status, "done")
    assert.ok(Date.now() - Date.parse(task.done_at) < 60_000, `done at ${task.done_at}`)
  })
})

// HA-13: dialogs fit a phone's screen.
test("on a phone the new task dialog fits the screen", async () => {
  await withBrowser(server, PHONE, async (ui) => {
    const { page } = ui
    await ui.run([`goto /p/${board.project.id}`, "click role=button[name='New task']", "wait Create task"])
    const box = await page.getByRole("dialog").boundingBox()
    assert.ok(box.x >= 0 && box.x + box.width <= 390, `dialog at ${JSON.stringify(box)}`)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390)
  })
})

// HA-13: none of it on a desktop: the sidebar, the columns side by side, no menu buttons on cards, and the panel beside the board.
test("the desktop layout is as it was", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    await ui.run([`goto /p/${board.project.id}`, `wait ${TODO}`])
    assert.ok(await page.getByRole("button", { name: "Settings", exact: true }).isVisible())
    assert.equal(await page.getByRole("button", { name: "Menu", exact: true }).count(), 0)
    assert.equal(await page.getByRole("tablist", { name: "Columns" }).count(), 0)
    assert.ok(await onScreen(page, TODO))
    assert.ok(await onScreen(page, ATTENTION))
    assert.equal(await page.locator(`[aria-label="Move ${TODO} to…"]`).isVisible(), false)
    await ui.run([`click ${ATTENTION}`, "wait role=button[name='Expand']"])
    assert.equal(await page.getByRole("button", { name: "Back", exact: true }).count(), 0)
    assert.equal(await page.locator("button[title^='Send']").getAttribute("title"), "Send (Enter)")
  })
})

// HA-13: a tablet keeps the desktop layout, but its cards have the menu button to move them, as dragging may not work.
test("a tablet has menu buttons on its cards, and a side panel wide enough to use", async () => {
  await withBrowser(server, { size: "820x1180", touch: true }, async (ui) => {
    const { page } = ui
    await ui.run([`goto /p/${board.project.id}`, `wait ${TODO}`])
    assert.equal(await page.getByRole("tablist", { name: "Columns" }).count(), 0)
    assert.ok(await page.locator(`[aria-label="Move ${TODO} to…"]`).isVisible())
    await ui.run([`click ${ATTENTION}`, "wait role=button[name='Expand']"])
    const panel = await page.locator("main").first().boundingBox()
    assert.ok(panel.width >= 470, `panel ${panel.width} wide`)
  })
})
