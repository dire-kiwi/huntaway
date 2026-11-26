// A plan in the board's theme, running to the bottom of the task under the composer (6.2; the old plan.test.mjs).
// HE-122: plans are published with the docs server now, so an older task's plan is read only: its questions can't be
// answered or sent.
import assert from "node:assert/strict"
import { afterAll, beforeAll, test } from "vite-plus/test"
import { eventually, seedThread, startServer, withBrowser } from "./harness.mjs"
import { demoBoard, docFrame, PLAN } from "./documents.mjs"

let server, project, plan
beforeAll(async () => {
  server = startServer("--demo")
  const board = await demoBoard(server)
  project = board.project
  plan = board.tasks[PLAN]
})
afterAll(() => server?.stop())

/** Wait until `locator`'s box stops moving (unchanged over a few animation frames). */
async function settled(locator) {
  let last = null
  for (let same = 0, tries = 0; same < 3 && tries < 100; tries++) {
    await locator.page().evaluate(() => new Promise((done) => requestAnimationFrame(done)))
    const box = JSON.stringify(await locator.boundingBox())
    same = box === last ? same + 1 : 0
    last = box
  }
}

test("a plan is themed, its components work, and it runs to the bottom with room to scroll clear of the composer", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    await ui.run([`goto /p/${project.id}?task=${plan.id}`, "wait css=iframe"])
    await page.frameLocator("iframe").first().getByRole("heading", { name: "Dark mode", exact: true }).waitFor()
    const frame = page.frames().find((f) => f !== page.mainFrame())

    // The plan theme's background (planTheme.css, not the board's), its components, and the demo's <ia-html> toggle, a
    // page of its own in a frame in the plan's.
    assert.equal(await frame.evaluate(() => getComputedStyle(document.body).backgroundColor), "rgb(17, 20, 27)")
    assert.equal(await frame.evaluate(() => getComputedStyle(document.querySelector(".callout")).borderLeftWidth), "4px")
    assert.equal(await frame.evaluate(() => getComputedStyle(document.querySelector(".pill.ok")).color), "rgb(111, 212, 154)")
    assert.equal(await frame.evaluate(() => getComputedStyle(document.querySelector(".grid2")).display), "grid")
    // The panel slides in, and Playwright's stability check runs inside the frame, so it doesn't see the frame
    // itself move: wait for the frames to stop moving, and for the button's scroll into view to settle, first.
    await settled(page.locator("iframe"))
    // Scrolled into view from the plan's frame: Chromium doesn't run animation frames in an offscreen frame of
    // another origin, which Playwright's checks inside it wait for.
    await frame.locator("ia-html").scrollIntoViewIfNeeded()
    await frame.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))))
    const toggle = page.frameLocator("iframe").first().frameLocator("ia-html iframe")
    const dark = toggle.locator("button", { hasText: "Dark" })
    await settled(frame.locator("ia-html iframe"))
    await dark.click()
    await toggle.locator("button.on", { hasText: "Dark" }).waitFor()

    // The frame reaches the composer's bottom, and pads its own bottom by what covers it, as that grows.
    const frameBox = await page.locator("iframe").boundingBox()
    const composer = await page.locator("textarea[placeholder]").boundingBox()
    assert.ok(frameBox.y + frameBox.height > composer.y + composer.height, `${JSON.stringify(frameBox)} ${JSON.stringify(composer)}`)
    const pad = () => frame.evaluate(() => parseFloat(document.documentElement.style.paddingBottom) || 0)
    const before = await pad()
    assert.ok(before > composer.height, `padding ${before}`)
    await page.locator("textarea[placeholder]").click()
    await ui.run(["type one", "press Shift+Enter", "type two", "press Shift+Enter", "type three"])
    // The frame is told of the composer's new height after it has grown: wait for that, rather than a fixed while.
    await eventually(async () => {
      const after = await pad()
      assert.ok(after > before, `padding ${after} after ${before}`)
    })
  })
})

test("HE-122: an older plan is read only: its questions can't be answered, and nothing offers to send them", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    const frame = await openPlan(ui)
    await frame.locator("ia-question[name=notes]").scrollIntoViewIfNeeded()
    assert.ok(await frame.locator("textarea[name=notes]").isDisabled())
    assert.ok(await frame.getByLabel("Only light and dark").isDisabled())
    assert.equal(await page.getByRole("button", { name: "Send answers" }).count(), 0)
    assert.equal(await page.getByText(/questions? answered/).count(), 0)
    assert.equal(await page.getByPlaceholder("Ask for changes to the plan…").count(), 0)
  })
})

/** Open the demo plan on its plan tab. */
async function openPlan(ui) {
  await ui.run([`goto /p/${project.id}?task=${plan.id}`])
  await ui.page.getByRole("button", { name: "plan", exact: true }).click()
  await ui.run(["wait css=iframe"])
  const frame = docFrame(ui.page)
  await frame.waitForFunction(() => document.querySelector("ia-question .ia-answer, input[name], select[name], textarea[name]"))
  return frame
}

test("the agent's last reply is closed under the plan until Summary opens it", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    const reply = "I rewrote the approach section around CSS custom properties."
    // The demo plan has no reply from its agent: give it a thread with one (the last check: it stays).
    seedThread(server, plan, [
      { id: "legacy:1", type: "user_message", text: "Tighten the approach section" },
      { id: "legacy:2", type: "assistant_message", text: reply },
    ])
    await openPlan(ui)
    await ui.run(["wait css=button[aria-expanded=false]:has-text('Summary')"])
    assert.equal(await page.getByText(reply).count(), 0)
    await ui.run(["click Summary", "wait " + reply, "wait css=button[aria-expanded=true]:has-text('Summary')", "click Summary", "gone " + reply])
  })
})
