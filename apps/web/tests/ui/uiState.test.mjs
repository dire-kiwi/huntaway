// The composer's draft, the description's edit and the Stop buttons (IA-161), from the old uiState check. A send is
// answered on the RPC websocket by the check (`routeRpc`), as the old check answered `POST /tasks/<id>/messages` with
// `page.route`: this server has no runs until plan task 2.5 (it answers `tasks.send` with Unavailable), and a send
// answered here starts no agent either way.
//
// Dropped from the old check:
// - "a refresh keeps the task events that came while it loaded", "a refresh that ends after a newer one doesn't undo
//   it", "overlapping refreshes that end … leave the newer one's tasks and projects", "the board loads once on start":
//   the board is a stream now (board.watch), with no refreshes to race (packages/client/test/sessions.test.ts).
// - "cards open from the keyboard, and dialogs hold the focus": the board's and the dialogs' (HE-3's), not the task view's.
import assert from "node:assert/strict"
import { afterAll, beforeAll, test } from "vite-plus/test"
import { eventually, failure, gate, routeRpc, seedBoard, startServer, success, withBrowser } from "./harness.mjs"

let server, board
beforeAll(async () => {
  server = startServer()
  board = await seedBoard(server)
})
afterAll(() => server?.stop())

// In To do, so their cards aren't under the task's panel.
const newTask = (title, fields = {}) => server.rpc("tasks.create", { task: { project_id: board.project.id, title, status: "todo", ...fields } })
const composerOf = (page) => page.locator("textarea[placeholder='Add extra instructions, or press Enter to start']")
const draftsOf = (page, id) => page.evaluate((taskId) => Object.keys(localStorage).filter((k) => k.includes(taskId)).length, id)

/** Opens task `other`'s card, then `task`'s again, each on its thread. */
async function toAndBack(ui, task, other) {
  const { page } = ui
  await page.locator(`[data-task="${other.id}"]`).click()
  await page.locator("header").getByText(other.title).first().waitFor()
  await ui.run(["click thread"])
  assert.equal(await composerOf(page).inputValue(), "", "another task has its own")
  await page.locator(`[data-task="${task.id}"]`).click()
  await page.locator("header").getByText(task.title).first().waitFor()
  await ui.run(["click thread"])
}

test("the composer keeps its draft across tabs, cards and a reload, and what's typed while sending", async () => {
  const task = await newTask("Draft: one")
  const other = await newTask("Draft: two")
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    const sends = gate()
    const calls = await routeRpc(page, (r) => (r.tag === "tasks.send" ? sends.hold() : undefined))
    const composer = composerOf(page)
    await ui.run([`goto /p/${board.project.id}?task=${task.id}`, "click thread", "wait No agent has worked on this yet"])
    await composer.fill("A draft for the agent")
    await ui.run(["click changes", "gone No agent has worked on this yet", "click thread"])
    assert.equal(await composer.inputValue(), "A draft for the agent", "after another tab")
    await toAndBack(ui, task, other)
    assert.equal(await composer.inputValue(), "A draft for the agent", "after another card")
    await page.reload()
    await ui.run(["click thread"])
    assert.equal(await composer.inputValue(), "A draft for the agent", "after a reload")

    // Sending, slowly: what's typed meanwhile stays, and what was sent goes.
    await composer.focus()
    await page.keyboard.press("Control+End")
    await page.keyboard.press("Enter")
    await eventually(() => assert.equal(sends.held(), 1))
    await page.keyboard.type(" and more")
    sends.release(success(await server.rpc("tasks.get", { id: task.id })))
    await eventually(async () => assert.equal(await composer.inputValue(), "and more"))
    assert.deepEqual(
      calls.filter((c) => c.tag === "tasks.send").map((c) => c.payload),
      [{ id: task.id, text: "A draft for the agent" }],
    )
  })
})

// IA-161 review: a send still going when the composer went (another card or tab) left what was sent in the saved draft,
// so it came back, ready to be sent again; and a composer opened meanwhile could send it a second time.
test("a message sent while its composer is gone doesn't come back as a draft", async () => {
  const task = await newTask("Send: one")
  const other = await newTask("Send: two")
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    const sends = gate()
    const calls = await routeRpc(page, (r) => (r.tag === "tasks.send" ? sends.hold() : undefined))
    const composer = composerOf(page)
    const sendButton = page.getByTitle("Send (Enter)")
    const answer = async () => {
      await eventually(() => assert.ok(sends.held() > 0, "the send"))
      sends.release(success(await server.rpc("tasks.get", { id: task.id })))
    }

    // Sent, then another card opened before the host answers.
    await ui.run([`goto /p/${board.project.id}?task=${task.id}`, "click thread"])
    await composer.fill("Send this once")
    await composer.press("Enter")
    await page.locator(`[data-task="${other.id}"]`).click()
    await page.locator("header").getByText("Send: two").first().waitFor()
    await answer()
    await page.locator(`[data-task="${task.id}"]`).click()
    await page.locator("header").getByText("Send: one").first().waitFor()
    await ui.run(["click thread"])
    assert.equal(await composer.inputValue(), "", "after another card")

    // Sent, then another tab and back before the host answers: the send is shown under way, and can't go again.
    await composer.fill("Send this once too")
    await composer.press("Enter")
    await ui.run(["click changes", "click thread"])
    assert.equal(await composer.inputValue(), "Send this once too")
    assert.ok(await sendButton.isDisabled(), "the send button waits for the send under way")
    await composer.press("Enter")
    await answer()
    await eventually(async () => assert.equal(await composer.inputValue(), ""))
    assert.equal(calls.filter((c) => c.tag === "tasks.send").length, 2)
    assert.equal(await draftsOf(page, task.id), 0, "no saved draft")
  })
})

// IA-161 review: a draft the browser's storage couldn't take (full) threw in the composer, and the whole app went blank.
test("a draft the browser can't store stays usable, and its send still goes", async () => {
  const task = await newTask("Full: one")
  const other = await newTask("Full: two")
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    const calls = await routeRpc(page, async (r) => (r.tag === "tasks.send" ? success(await server.rpc("tasks.get", { id: task.id })) : undefined))
    const composer = composerOf(page)
    const notice = page.getByText("This browser couldn't save the draft")
    await ui.run([`goto /p/${board.project.id}?task=${task.id}`, "click thread"])
    await composer.fill("Short")
    const stored = () => page.evaluate((id) => Object.entries(localStorage).find(([k]) => k.includes(id))?.[1] ?? null, task.id)
    await eventually(async () => assert.ok((await stored())?.includes("Short"), "the draft is stored"))
    // The storage is full from here on.
    await page.evaluate(() => {
      const setItem = Reflect.get(Storage.prototype, "setItem")
      Storage.prototype.setItem = function (k, v) {
        if (k.startsWith("ia.composer.draft.")) throw new DOMException("The quota has been exceeded.", "QuotaExceededError")
        return Reflect.apply(setItem, this, [k, v])
      }
    })
    await composer.focus()
    await page.keyboard.press("Control+End")
    await page.keyboard.type(", and then a much longer draft")
    await notice.waitFor()
    assert.ok(await composer.isVisible(), "the app is still there")
    assert.equal(await composer.inputValue(), "Short, and then a much longer draft")
    // It's kept on the page, across cards.
    await toAndBack(ui, task, other)
    assert.equal(await composer.inputValue(), "Short, and then a much longer draft", "after another card")
    // And it's sent, as a send, not an error; the draft is cleared from the storage too.
    await composer.press("Enter")
    await eventually(async () => assert.equal(await composer.inputValue(), ""))
    assert.deepEqual(
      calls.filter((c) => c.tag === "tasks.send").map((c) => c.payload.text),
      ["Short, and then a much longer draft"],
    )
    await notice.waitFor({ state: "detached" })
    assert.equal(await stored(), null)
    assert.equal(await page.locator(".text-red-400").count(), 0, "no error")
  })
})

// IA-161: a change to the description while it was being edited replaced the edit, and a failed save said nothing.
test("an edit of the description survives a change to it, and a failed save says so", async () => {
  const task = await newTask("Describe me", { description: "Old text", status: "in_review" })
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    let failing = false
    await routeRpc(page, (r) => (r.tag === "tasks.update" && failing ? failure({ _tag: "Invalid", field: "description", reason: "disk full" }) : undefined))
    await ui.run([`goto /p/${board.project.id}?task=${task.id}`, "click details", "wait Old text", "click Edit description"])
    const field = page.locator("section:has(h3:text-is('Description')) textarea")
    await field.fill("My new text")
    await server.rpc("tasks.update", { id: task.id, patch: { description: "Changed elsewhere" } })
    await ui.run(["wait It was changed while you were editing it"])
    assert.equal(await field.inputValue(), "My new text")

    failing = true
    await page.getByRole("button", { name: /^Save/ }).click()
    await ui.run(["wait Couldn't save the description: description: disk full"])
    assert.equal(await field.inputValue(), "My new text")
  })
})

// Stop shows only while the task's agent runs, which needs the fake agent kept running (HUNTAWAY_FAKE_CLAUDE_SLEEP). It
// checks that a Stop the host refuses says so, in the header and in the composer. The message re-titles the task (the
// fake agent's "Fake title"), so the header is waited on for its Stop, not the title. IA-161: the Stop buttons ignored a
// failed request.
test("a Stop that fails says so", async () => {
  process.env.HUNTAWAY_FAKE_CLAUDE_SLEEP = "30"
  const running = startServer("--fake-claude")
  try {
    const { project } = await seedBoard(running)
    const task = await running.rpc("tasks.create", { task: { project_id: project.id, title: "Stop me", status: "in_review" } })
    await running.rpc("tasks.send", { id: task.id, text: "Take your time." })
    await withBrowser(running, {}, async (ui) => {
      const { page } = ui
      await routeRpc(page, (r) => (r.tag === "tasks.stop" ? failure({ _tag: "NotFound", what: "run", id: task.id }) : undefined))
      await ui.run([`goto /p/${project.id}?task=${task.id}`, "wait css=header button:has-text('Stop')"])
      // In the header, and in the composer.
      await page.locator("header button", { hasText: "Stop" }).click()
      await ui.run(["wait Couldn't stop the agent: No run"])
      await page.locator("header [title='Dismiss']").click()
      await ui.run(["gone Couldn't stop the agent"])
      await page.locator("button:has(svg.lucide-square)").last().click()
      await ui.run(["wait Couldn't stop the agent: No run"])
    })
  } finally {
    delete process.env.HUNTAWAY_FAKE_CLAUDE_SLEEP
    running.stop()
  }
})
