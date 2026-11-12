// Ports the old uiPolish check (HA-44): a dialog's backdrop, toggles as switches, the open token asked for once, a phone's
// Start button, and another task's thread opening at its end.
//
// Changed from the old check: it ran on the older database file (`IA_NEW_DB_FILE=0`) so its threads could be faked on
// the messages routes; the two-file scheme and the messages are gone (docs/plan/14-dropped-and-open.md), so the threads
// are written into the server's database (`seedThread`). The open token is `public.openToken` on the RPC socket rather
// than `GET /api/open-token`, so its calls are counted there (routeRpc). The old check slept 200-300 ms before saying
// nothing had happened; these wait for the page to have drawn a frame after the click, or for the board to have loaded.
import assert from "node:assert/strict"
import { afterAll, beforeAll, test } from "vite-plus/test"
import { DEMO_TASKS, eventually, makeTask, routeRpc, seedAgentBoard, seedThread, startServer, threadScroller, withBrowser } from "./harness.mjs"

// Agents run (with the fake claude, which nothing here sends to), as the old check's did (with /bin/false): a task's
// Start button is only there on a host that runs agents.
let server, board
beforeAll(async () => {
  server = startServer("--fake-claude")
  board = await seedAgentBoard(server)
  board.tasks = []
  for (const t of DEMO_TASKS) board.tasks.push(await makeTask(server, board.project, t))
})
afterAll(() => server?.stop())

const byTitle = (title) => board.tasks.find((t) => t.title.startsWith(title))
const dialogs = (page) => page.locator("[role=dialog]").count()
/** Resolves once the page has drawn two frames: what a click changed is on the page by then. */
const frames = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))

// HA-44: a dialog closed on a mousedown on its backdrop, so a drag out of a field, or a stray click, lost what was typed.
test("a click on a dialog's backdrop closes it only when nothing typed would be lost", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    await ui.run([`goto /p/${board.project.id}`, "wait Try dragging this card", "click New task", "wait [role=dialog]"])
    // Pressed in the field and let go over the backdrop: the press wasn't on the backdrop.
    const field = await page.locator("[role=dialog] textarea").first().boundingBox()
    await page.mouse.move(field.x + 10, field.y + 10)
    await page.mouse.down()
    await page.mouse.move(20, 500, { steps: 5 })
    await page.mouse.up()
    await frames(page)
    assert.equal(await dialogs(page), 1, "a drag out of the field keeps it")
    // Something typed: kept. Taken out again: nothing to lose.
    await page.locator("[role=dialog] textarea").first().click()
    await page.keyboard.type("Half a title")
    await page.mouse.click(20, 500)
    await frames(page)
    assert.equal(await dialogs(page), 1, "a click on the backdrop keeps what was typed")
    await page.locator("[role=dialog] textarea").first().click()
    for (let i = 0; i < "Half a title".length; i++) await page.keyboard.press("Backspace")
    await page.mouse.click(20, 500)
    await ui.run(["gone [role=dialog]"])
  })
})

test("toggles are switches to screen readers", async () => {
  await withBrowser(server, {}, async (ui) => {
    await ui.run([`goto /p/${board.project.id}`, "click New task", "wait [role=dialog]"])
    const sw = ui.page.locator("[role=dialog] [role=switch]").first()
    const was = await sw.getAttribute("aria-checked")
    assert.ok(was === "true" || was === "false")
    await sw.click()
    assert.equal(await sw.getAttribute("aria-checked"), was === "true" ? "false" : "true")
  })
})

// HA-44: every load waited for the open token before showing anything, and a board that doesn't hand it out logged a 404.
// Once a load has found out it doesn't, the next one with a token doesn't ask (state/auth.ts keeps `ia.openBoard`).
test("a board that doesn't hand out its token isn't asked for it again once known", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    const calls = await routeRpc(page)
    const asked = () => calls.filter((c) => c.tag === "public.openToken").length
    await ui.run([`goto /p/${board.project.id}`, "wait Try dragging this card"])
    // Its answer kept: this board doesn't hand one out.
    await page.waitForFunction(() => localStorage.getItem("ia.openBoard") === "0")
    assert.equal(asked(), 1, "asked once, to find out")
    // The next load asks before the board loads, if it asks at all.
    await ui.run([`goto /p/${board.project.id}`, "wait Try dragging this card"])
    assert.equal(asked(), 1, "not asked again")
  })
})

// HA-44: on a phone, the task's Start button was at the end of a row of tabs that scrolls sideways, half off-screen.
test("a phone's task header keeps Start on screen", async () => {
  const todo = byTitle("Try dragging this card")
  await withBrowser(server, { size: "390x844", touch: true }, async (ui) => {
    // The panel slides in at once: the checks have no animations (noMotion in harness.mjs).
    await ui.run([`goto /p/${board.project.id}?task=${todo.id}`, "wait role=button[name='Back']"])
    const start = await ui.page.getByRole("button", { name: "Start", exact: true }).boundingBox()
    assert.ok(start && start.x >= 0 && start.x + start.width <= 390, `Start at ${JSON.stringify(start)}`)
  })
})

/** A thread of `n` short replies, enough to scroll, saying whose they are. */
const longThread = (task, n = 80) => [
  { id: "legacy:1", type: "user_message", text: "Talk for a while." },
  ...Array.from({ length: n }, (_, i) => ({ id: `legacy:${i + 2}:0`, type: "assistant_message", text: `Line ${i + 1} of ${task.id.slice(0, 4)}.` })),
]

// HA-44: the thread wasn't keyed by task, so another task's thread could open where the last one was scrolled to.
test("another task's thread opens at its latest message, not where the last one was scrolled to", async () => {
  // Tasks an agent has worked on, which open on their thread.
  const a = byTitle("A task waiting on an answer")
  const b = byTitle("Finished work to look over")
  seedThread(server, a, longThread(a))
  seedThread(server, b, longThread(b))
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    await ui.run([`goto /p/${board.project.id}?task=${a.id}`, `wait Line 80 of ${a.id.slice(0, 4)}.`])
    await threadScroller(page).evaluate((el) => (el.scrollTop = 0))
    await eventually(async () => assert.equal(await threadScroller(page).evaluate((el) => el.scrollTop), 0))
    // As a click on its card does (which is under the panel here).
    await page.evaluate((id) => {
      history.pushState(null, "", `${location.pathname}?task=${id}`)
      dispatchEvent(new PopStateEvent("popstate"))
    }, b.id)
    await ui.run([`wait Line 80 of ${b.id.slice(0, 4)}.`])
    await eventually(async () => {
      const fromEnd = await threadScroller(page).evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)
      assert.ok(fromEnd < 80, `${fromEnd}px from the end`)
    })
  })
})
