import assert from "node:assert/strict"
import { afterAll, beforeAll, test } from "vite-plus/test"
import { makeTask, seedBoard, startServer, updateTask, withBrowser } from "./harness.mjs"

// The board's own notifications (the old tests/ui/notifications.test.mjs): a task that needs the user notifies from one
// tab of the browser. The old check fed task events into an intercepted websocket; these change the tasks on the server
// (`tasks.update`, which is someone else's move as far as the page knows) and, for a run the user stopped, through the
// fake agent.

let server, board
beforeAll(async () => {
  server = startServer("--fake-claude")
  board = await seedBoard(server)
})
afterAll(() => server?.stop())

/** Keeps the notifications a page shows in `window.notes`, with the object for clicking one. */
function recordNotifications() {
  const Real = window.Notification
  window.notes = []
  window.Notification = class extends Real {
    constructor(title, opts) {
      super(title, opts)
      window.notes.push({ title, body: opts?.body, silent: opts?.silent, n: this })
    }
  }
}

const notes = (page) => page.evaluate(() => window.notes.map((n) => `${n.title} | ${n.body}`))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const create = (title, status) => makeTask(server, board.project, { title, status })
const waiting = async () =>
  (await server.rpc("tasks.list", { filter: { _tag: "ByProject", project_id: board.project.id } })).filter((t) => t.status === "needs_attention").length
const key = (t) => `DEM-${t.number}`

// HA-8: a task that goes to Needs attention (or is ready to review) notifies from one tab, and clicking it opens the
// task; tasks waiting already when the page loads, the task open in a focused window, the user's own moves and a run
// they stopped don't. The tab title and icon count the tasks that need attention.
test("tasks that need you notify once, with their key, title and reason, and the count is in the title", async () => {
  await create("Notify: waiting already", "needs_attention")
  const live = await create("Notify: live", "in_progress")
  const stopped = await create("Notify: stopped", "todo")
  const shared = await create("Notify: two tabs", "in_progress")
  const moved = await create("Notify: moved here", "in_review")

  await withBrowser(server, { fullBrowser: true }, async (ui) => {
    const { page } = ui
    const context = page.context()
    await context.grantPermissions(["notifications"], { origin: server.url })
    await context.addInitScript(recordNotifications)
    // The page's timers (the review's grace among them) are run through what each wait is for, rather than waited out.
    await context.clock.install()
    const settle = async (ms) => {
      await context.clock.runFor(ms)
      await sleep(200)
    }

    // Picking notifications, with the permission granted already.
    await ui.run(["goto /settings/notifications", "click role=radio[name='Notifications']", "wait This browser shows the board's notifications"])
    assert.equal(JSON.parse(await page.evaluate(() => localStorage.getItem("ia.notifications"))).mode, "notify")

    // Tasks waiting already don't notify when the board loads, but they're counted.
    await ui.run([`goto /p/${board.project.id}`, "wait Notify: waiting already"])
    const n = await waiting()
    await page.waitForFunction((count) => document.title === `(${count}) Huntaway`, n)
    assert.match(await page.evaluate(() => document.querySelector('link[rel="icon"]').href), /^data:image\/png/)
    await settle(500)
    assert.deepEqual(await notes(page), [])

    // Someone else moves a task to Needs attention.
    await updateTask(server, live, { status: "needs_attention" })
    await page.waitForFunction(() => window.notes.length === 1)
    assert.deepEqual(await notes(page), [`${key(live)} Notify: live | Needs attention`])
    assert.equal(await page.evaluate(() => window.notes[0].silent), true, "the sound is a setting of its own")
    await page.waitForFunction((count) => document.title === `(${count}) Huntaway`, n + 1)

    // Clicking it opens the task.
    await page.evaluate(() => window.notes[0].n.dispatchEvent(new Event("click")))
    await page.waitForURL(new RegExp(`\\?task=${live.id}`))

    // Open in this (focused) window, it doesn't notify again.
    assert.equal(await page.evaluate(() => document.hasFocus()), true)
    await updateTask(server, live, { status: "in_progress" })
    await updateTask(server, live, { status: "needs_attention" })
    // Nor does a run the user stopped.
    await server.rpc("tasks.send", { id: stopped.id, text: "Take your time fake-until-interrupted" })
    for (let i = 0; i < 100 && !(await server.rpc("tasks.get", { id: stopped.id })).running; i++) await sleep(100)
    await server.rpc("tasks.stop", { id: stopped.id })
    for (let i = 0; i < 100 && (await server.rpc("tasks.get", { id: stopped.id })).attention_reason !== "Stopped by user"; i++) await sleep(100)
    await settle(500)
    assert.equal((await notes(page)).length, 1)

    // Ready to review, once it has stayed so for a moment.
    await updateTask(server, stopped, { status: "in_review" })
    await settle(1000)
    assert.equal((await notes(page)).length, 1)
    await context.clock.runFor(4000)
    await page.waitForFunction(() => window.notes.length === 2, null, { timeout: 8000 })
    assert.equal((await notes(page))[1], `${key(stopped)} ${(await server.rpc("tasks.get", { id: stopped.id })).title} | Ready to review`)

    // Reloaded with tasks waiting: no burst.
    await page.reload()
    await ui.run(["wait Notify: waiting already"])
    await settle(1000)
    assert.deepEqual(await notes(page), [])

    // With two tabs, one of them notifies.
    const other = await context.newPage()
    await other.goto(`${server.url}/p/${board.project.id}`)
    await other.getByText("Notify: two tabs").first().waitFor()
    await updateTask(server, shared, { status: "needs_attention" })
    await page.waitForFunction(() => window.notes.length === 1)
    await settle(500)
    assert.deepEqual([...(await notes(page)), ...(await notes(other))], [`${key(shared)} Notify: two tabs | Needs attention`])
    await other.waitForFunction((count) => document.title === `(${count}) Huntaway`, await waiting())

    // A move made in the other tab doesn't tell this one, which notifies (with Done turned on).
    await other.evaluate(() => {
      const s = JSON.parse(localStorage.getItem("ia.notifications"))
      localStorage.setItem("ia.notifications", JSON.stringify({ ...s, events: { ...s.events, done: true } }))
    })
    await other.locator(`[data-task="${moved.id}"]`).click({ button: "right" })
    await other.getByRole("menu").waitFor()
    await other
      .getByRole("menuitemradio", { name: "Done" })
      .or(other.getByRole("menuitem", { name: "Done" }))
      .first()
      .click()
    for (let i = 0; i < 50 && (await server.rpc("tasks.get", { id: moved.id })).status !== "done"; i++) await sleep(100)
    await settle(1000)
    assert.equal((await server.rpc("tasks.get", { id: moved.id })).status, "done")
    assert.equal((await notes(page)).length + (await notes(other)).length, 1)
    // Someone else's move does.
    await updateTask(server, shared, { status: "done" })
    await page.waitForFunction(() => window.notes.length === 2)
    assert.equal((await notes(page))[1], `${key(shared)} Notify: two tabs | Done`)
    await other.close()
  })
})

test("without Web Locks, one of the tabs still notifies", async () => {
  const task = await create("Notify: no locks", "in_progress")
  await withBrowser(server, { fullBrowser: true }, async (ui) => {
    const context = ui.page.context()
    await context.grantPermissions(["notifications"], { origin: server.url })
    await context.addInitScript(recordNotifications)
    await context.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, "locks", { get: () => undefined })
      localStorage.setItem("ia.notifications", JSON.stringify({ mode: "notify" }))
    })
    const pages = [ui.page, await context.newPage(), await context.newPage()]
    for (const page of pages) {
      await page.goto(`${server.url}/p/${board.project.id}`)
      await page.getByText("Notify: no locks").first().waitFor()
    }
    await updateTask(server, task, { status: "needs_attention" })
    await pages[0].waitForFunction(() => document.title.startsWith("("))
    await sleep(1000)
    const all = (await Promise.all(pages.map(notes))).flat()
    assert.deepEqual(all, [`${key(task)} Notify: no locks | Needs attention`])
  })
})

test("Settings says why notifications can't work on a page that isn't secure", async () => {
  await withBrowser(server, { fullBrowser: true }, async (ui) => {
    const { page } = ui
    // As on a plain-HTTP LAN address.
    await page.addInitScript(() => Object.defineProperty(window, "isSecureContext", { value: false }))
    await ui.run(["goto /settings/notifications", "click role=radio[name='Both']", "wait Notifications can't work here", "wait The sound plays once"])
    assert.equal(await page.getByRole("button", { name: "Enable" }).count(), 0)
  })
})

// HA-26: a PR preview (a board that hands out its token) shows no system notifications, though they're allowed and
// picked; the count still shows.
test("a PR preview doesn't show system notifications", async () => {
  const preview = startServer("--open-token")
  try {
    const demo = await seedBoard(preview)
    const task = await makeTask(preview, demo.project, { title: "Notify: preview", status: "in_progress" })
    await withBrowser(preview, { fullBrowser: true }, async (ui) => {
      const context = ui.page.context()
      await context.grantPermissions(["notifications"], { origin: preview.url })
      await context.addInitScript(recordNotifications)
      await context.addInitScript(() => localStorage.setItem("ia.notifications", JSON.stringify({ mode: "notify" })))
      await ui.run([`goto /p/${demo.project.id}`, "wait Notify: preview"])
      await updateTask(preview, task, { status: "needs_attention" })
      await ui.page.waitForFunction(() => document.title === "(1) Huntaway")
      await sleep(1000)
      assert.deepEqual(await notes(ui.page), [])
      await ui.run(["goto /settings/notifications", "wait it doesn't show system notifications"])
      assert.equal(await ui.page.getByRole("button", { name: "Enable" }).count(), 0)
    })
  } finally {
    preview.stop()
  }
})
