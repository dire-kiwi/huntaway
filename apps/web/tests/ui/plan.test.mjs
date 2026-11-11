// A plan in the board's theme, running to the bottom of the task under the composer, and its questions answered in it
// (6.2; the old plan.test.mjs). Changed: the demo board's server runs no agents, so a send of the answers is answered by
// the check (`routeDocuments`), which records what was sent, in place of reading the thread back or holding the old
// `/messages` request; a document's other contents are `tasks.document` answers in place of routed `/document` ones
// and the board hears that a version was written over from a `task` event the check gives it.
import assert from "node:assert/strict"
import { afterAll, beforeAll, test } from "vite-plus/test"
import { seedThread, startServer, withBrowser } from "./harness.mjs"
import { demoBoard, docFrame, PLAN, planDocument, routeDocuments, saved } from "./documents.mjs"

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
    const composer = await page.getByPlaceholder("Ask for changes to the plan…").boundingBox()
    assert.ok(frameBox.y + frameBox.height > composer.y + composer.height, `${JSON.stringify(frameBox)} ${JSON.stringify(composer)}`)
    const pad = () => frame.evaluate(() => parseFloat(document.documentElement.style.paddingBottom) || 0)
    const before = await pad()
    assert.ok(before > composer.height, `padding ${before}`)
    await ui.run(["click Ask for changes to the plan", "type one", "press Shift+Enter", "type two", "press Shift+Enter", "type three"])
    await page.waitForTimeout(200)
    assert.ok((await pad()) > before, `padding ${await pad()} after ${before}`)
  })
})

test("a plan's questions are answered in it, the answers last until they're sent, and Send answers sends them to the agent", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    const { sent: posted } = await routeDocuments(page, server, plan)
    await ui.run([`goto /p/${project.id}?task=${plan.id}`, "wait css=iframe", "wait 2 of 3 questions answered"])
    const answer = async () => {
      // The task's panel slides in as it opens: a click before it's still could miss.
      await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running"))
      const frame = docFrame(page)
      await frame.locator("ia-question[name=notes]").scrollIntoViewIfNeeded()
      return frame
    }
    let frame = await answer()
    await frame.getByLabel("Only light and dark").check()
    await frame.locator("textarea[name=notes]").fill("Keep the print styles")
    await ui.run(["wait 3 of 3 questions answered"])
    const state = async () => {
      frame = docFrame(page)
      await frame.waitForFunction(() => document.querySelector("textarea[name=notes]"))
      return frame.evaluate(() => [document.querySelector("input[value=two]").checked, document.querySelector("textarea[name=notes]").value])
    }
    // The frame is made again (from the source view), and the board is reloaded: the answers are put back.
    await ui.run(["click Source", "gone css=iframe", "click Preview", "wait css=iframe"])
    assert.deepEqual(await state(), [true, "Keep the print styles"])
    await page.reload()
    await ui.run(["wait css=iframe", "wait 3 of 3 questions answered"])
    assert.deepEqual(await state(), [true, "Keep the print styles"])

    await ui.run(["click Send answers", "wait Answers sent"])
    const sent = posted.find((text) => /My answers to the questions/.test(text))
    assert.ok(sent, "the answers were sent")
    assert.match(sent, /Which choices should the toggle offer\? \(`toggle-choices`\): Only light and dark/)
    assert.match(sent, /`notes`\): Keep the print styles/)
    // Sent answers aren't put back in: the plan starts from its own again.
    await page.reload()
    await page.getByRole("button", { name: "plan", exact: true }).click()
    await ui.run(["wait css=iframe", "wait 2 of 3 questions answered"])
    assert.deepEqual(await state(), [false, ""])
  })
})

/** Open the demo plan on its plan tab (once a send has run its agent, which can't run here, the task opens on its thread). */
async function openPlan(ui) {
  await ui.run([`goto /p/${project.id}?task=${plan.id}`])
  await ui.page.getByRole("button", { name: "plan", exact: true }).click()
  await ui.run(["wait css=iframe", "wait answered"])
  const frame = docFrame(ui.page)
  await frame.waitForFunction(() => document.querySelector("ia-question .ia-answer, input[name], select[name], textarea[name]"))
  return frame
}

test("answers changed while the answers are being sent are kept, to send next", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    let release
    const held = new Promise((done) => (release = done))
    const { sent: posted } = await routeDocuments(page, server, plan, { hold: () => held })
    let frame = await openPlan(ui)
    await frame.locator("textarea[name=notes]").fill("First answer")
    await page.waitForFunction(() => Object.values(localStorage).some((v) => v.includes("First answer")))
    await ui.run(["click Send answers"])
    while (!posted.length) await page.waitForTimeout(50)
    await frame.locator("textarea[name=notes]").fill("Second answer")
    await page.waitForFunction(() => Object.values(localStorage).some((v) => v.includes("Second answer")))
    release()
    // The send's end takes off the saved answers it sent as they were.
    await page.waitForFunction(() => !Object.values(localStorage).some((v) => v.includes("First answer")))
    assert.match(posted[0], /`notes`\): First answer/)
    assert.deepEqual(await saved(page), { notes: { v: ["Second answer"] } })
    assert.equal(await page.getByText("Answers sent").count(), 0)
    assert.ok(await page.getByRole("button", { name: "Send answers" }).isEnabled())
    await page.reload()
    frame = await openPlan(ui)
    assert.equal(await frame.locator("textarea[name=notes]").inputValue(), "Second answer")
  })
})

test("Reset in the source view drops the answers from what Send answers sends", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    const { sent: posted } = await routeDocuments(page, server, plan)
    let frame = await openPlan(ui)
    await frame.locator("textarea[name=notes]").fill("Discard me")
    await page.waitForFunction(() => Object.values(localStorage).some((v) => v.includes("Discard me")))
    await ui.run(["click Source", "gone css=iframe", "click Reset", "click Send answers", "wait Answers sent"])
    assert.equal(posted.length, 1)
    assert.doesNotMatch(posted[0], /Discard me/)
    assert.match(posted[0], /`notes`\): \(no answer\)/)
    assert.match(posted[0], /`toggle-choices`\): Light, system and dark/)
    await ui.run(["click Preview", "wait css=iframe"])
    frame = docFrame(page)
    await frame.waitForFunction(() => document.querySelector("textarea[name=notes]"))
    assert.equal(await frame.locator("textarea[name=notes]").inputValue(), "")
  })
})

test("a checkbox question with every choice unticked can be sent, as none of them", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    const content = `<h1>Extras</h1><ia-question name="extras" type="checkbox" title="Which extras?"><option value="a" selected>A</option><option value="b">B</option></ia-question>`
    const { sent: posted } = await routeDocuments(page, server, plan, { document: () => planDocument(content) })
    const frame = await openPlan(ui)
    await ui.run(["wait 1 of 1 question answered"])
    await frame.getByLabel("A", { exact: true }).uncheck()
    await ui.run(["wait 1 of 1 question answered"])
    assert.ok(await page.getByRole("button", { name: "Send answers" }).isEnabled())
    await ui.run(["click Send answers", "wait Answers sent"])
    assert.match(posted[0], /Which extras\? \(`extras`\): \(none of the choices\)/)
  })
})

test("a send that ends after the plan's view was opened again keeps the answers changed in the new one", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    let release
    const held = new Promise((done) => (release = done))
    const { sent: posted } = await routeDocuments(page, server, plan, { hold: () => held })
    let frame = await openPlan(ui)
    await frame.locator("textarea[name=notes]").fill("First answer")
    await page.waitForFunction(() => Object.values(localStorage).some((v) => v.includes("First answer")))
    await ui.run(["click Send answers"])
    while (!posted.length) await page.waitForTimeout(50)
    // Another tab and back: a new view of the plan, while the send goes on.
    await page.getByRole("button", { name: "thread", exact: true }).click()
    await page.getByRole("button", { name: "plan", exact: true }).click()
    await ui.run(["wait css=iframe", "wait answered"])
    frame = docFrame(page)
    await frame.waitForFunction(() => document.querySelector("textarea[name=notes]")?.value === "First answer")
    await frame.locator("textarea[name=notes]").fill("Second answer")
    await page.waitForFunction(() => Object.values(localStorage).some((v) => v.includes("Second answer")))
    release()
    // The send's end takes off the saved answers it sent as they were.
    await page.waitForFunction(() => !Object.values(localStorage).some((v) => v.includes("First answer")))
    assert.equal(posted.length, 1)
    assert.match(posted[0], /`notes`\): First answer/)
    assert.deepEqual(await saved(page), { notes: { v: ["Second answer"] } })
    await page.reload()
    frame = await openPlan(ui)
    assert.equal(await frame.locator("textarea[name=notes]").inputValue(), "Second answer")
  })
})

/** Version `v` of a plan with a question of its own. */
const versionContent = (v) => `<h1>Version ${v}</h1><ia-question name="v${v}" type="text" title="Question in v${v}?"></ia-question>`

test("going back to the latest version in the source view doesn't offer to send an earlier version's fields", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    const at = new Date().toISOString()
    const versions = [1, 2].map((version) => ({ version, open: false, created_at: at, updated_at: at, size: 10 }))
    const { sent: posted } = await routeDocuments(page, server, plan, {
      document: (payload) => planDocument(versionContent(payload.version ?? 2), { versions, version: payload.version ?? 2 }),
    })
    let frame = await openPlan(ui)
    await frame.locator("input[name=v2]").fill("for v2")
    await ui.run(["wait 1 of 1 question answered"])
    await page.locator('select[title^="Versions"]').selectOption("1")
    await ui.run(["wait Back to the latest"])
    frame = docFrame(page)
    await frame.waitForFunction(() => document.querySelector("input[name=v1]"))
    // An earlier version's fields can't be answered or sent.
    assert.equal(await page.getByRole("button", { name: "Send answers" }).count(), 0)
    await ui.run(["click Source", "gone css=iframe", "click Back to the latest", "gone Back to the latest", "wait Question in v2"])
    assert.equal(await page.getByRole("button", { name: "Send answers" }).count(), 0)
    assert.deepEqual(await saved(page), { v2: { v: ["for v2"] } })
    await ui.run(["click Preview", "wait css=iframe", "wait 1 of 1 question answered", "click Send answers", "wait Answers sent"])
    assert.equal(posted.length, 1)
    assert.match(posted[0], /\(v2\)/)
    assert.match(posted[0], /Question in v2\? \(`v2`\): for v2/)
  })
})

test("a version written over while the source view shows doesn't offer to send or reset the fields it had before", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    // Version 1 is open (the agent's turn is writing it), so its content changes without a new version.
    let content = `<h1>Plan</h1><ia-question name="first" type="text" title="First question?"></ia-question>`
    const { sent: posted, push } = await routeDocuments(page, server, plan, { document: () => planDocument(content, { open: true }) })
    let frame = await openPlan(ui)
    await frame.locator("input[name=first]").fill("an answer")
    await ui.run(["wait 1 of 1 question answered"])
    await ui.run(["click Source", "gone css=iframe"])
    // The agent replaces the question: the board hears the document changed, and fetches it again.
    content = `<h1>Plan</h1><ia-question name="second" type="text" title="Second question?"></ia-question>`
    const task = await server.rpc("tasks.get", { id: plan.id })
    push({ type: "task", task: { ...task, document_at: new Date(Date.now() + 1000).toISOString() }, seq: 1_000_000 })
    await ui.run(["wait Second question"])
    assert.equal(await page.getByRole("button", { name: "Send answers" }).count(), 0)
    assert.equal(await page.getByRole("button", { name: "Reset" }).count(), 0)
    assert.deepEqual(await saved(page), { first: { v: ["an answer"] } })
    // Its own form, once it's shown, has its own question.
    await ui.run(["click Preview", "wait css=iframe", "wait 0 of 1 question answered"])
    frame = docFrame(page)
    await frame.locator("input[name=second]").fill("the other answer")
    // Its change event, as the field loses the focus, before the send: this send is answered at once, and an answer
    // changed after it's sent is one to send again.
    await frame.locator("input[name=second]").evaluate((el) => el.blur())
    await ui.run(["wait 1 of 1 question answered", "click Send answers", "wait Answers sent"])
    assert.equal(posted.length, 1)
    assert.match(posted[0], /Second question\? \(`second`\): the other answer/)
    assert.doesNotMatch(posted[0], /First question/)
  })
})

test("a plan form's own reset button puts its fields back for Send answers and for the next load", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    const content = `<h1>Owner</h1><form><label>Owner <input name="owner" value="Alice"></label><button type="reset">Reset form</button></form>`
    const { sent: posted } = await routeDocuments(page, server, plan, { document: () => planDocument(content) })
    let frame = await openPlan(ui)
    await frame.locator("input[name=owner]").fill("Bob")
    await page.waitForFunction(() => Object.values(localStorage).some((v) => v.includes("Bob")))
    await frame.getByRole("button", { name: "Reset form" }).click()
    assert.equal(await frame.locator("input[name=owner]").inputValue(), "Alice")
    await page.waitForFunction(() => !Object.values(localStorage).some((v) => v.includes("Bob")))
    assert.deepEqual(await saved(page), {})
    await page.reload()
    frame = await openPlan(ui)
    assert.equal(await frame.locator("input[name=owner]").inputValue(), "Alice")
    // And without a reload in between: what's sent is what's shown.
    await frame.locator("input[name=owner]").fill("Bob")
    await page.waitForFunction(() => Object.values(localStorage).some((v) => v.includes("Bob")))
    await frame.getByRole("button", { name: "Reset form" }).click()
    await page.waitForFunction(() => !Object.values(localStorage).some((v) => v.includes("Bob")))
    await ui.run(["click Send answers", "wait Answers sent"])
    assert.equal(posted.length, 1)
    assert.match(posted[0], /Owner \(`owner`\): Alice/)
  })
})

test("a plan form's reset that its own handler calls off keeps the answers", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    const content = `<h1>Owner</h1><form onreset="event.preventDefault()"><label>Owner <input name="owner" value="Alice"></label><button type="reset">Reset form</button></form>`
    await routeDocuments(page, server, plan, { document: () => planDocument(content) })
    let frame = await openPlan(ui)
    await frame.locator("input[name=owner]").fill("Bob")
    await page.waitForFunction(() => Object.values(localStorage).some((v) => v.includes("Bob")))
    await frame.getByRole("button", { name: "Reset form" }).click()
    await page.waitForTimeout(300)
    assert.equal(await frame.locator("input[name=owner]").inputValue(), "Bob")
    assert.deepEqual(await saved(page), { owner: { v: ["Bob"] } })
    await page.reload()
    frame = await openPlan(ui)
    assert.equal(await frame.locator("input[name=owner]").inputValue(), "Bob")
  })
})

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
