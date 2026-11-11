// A thread follows its agent's run as it goes: what the composer sends, the agent's replies, a message steered into a
// running agent, a stop (IA-168, from the old threadUpdates check, and the composer's sends from the old uiState). Agents
// run with the fake claude (packages/testing/bin/fake-claude), which answers without a model, waiting
// HUNTAWAY_FAKE_CLAUDE_SLEEP seconds first so a run can be caught while it runs.
//
// Every check here waits for Runs (plan task 2.5): until then the server answers `tasks.send` with Unavailable.
//
// Dropped from the old check: a group of tool calls whose results come after them, a prompt and then its answer, a
// subagent's items as they come (the fake agent makes no tool calls or subagents; the translator's tests and
// packages/client/test/thread.test.ts cover the items and their events; answering prompts is 3.3), a closed thread not
// catching up on a resync and opening again with a fresh window (no resync on this server: a thread is kept subscribed
// for ten seconds after it's closed, and subscribes again from its seq after that), and a thread at its end following a
// subagent's items (the fake agent has no subagents).
import assert from "node:assert/strict"
import { afterAll, beforeAll, test } from "vite-plus/test"
import { eventually, seedAgentBoard, startServer, withBrowser } from "./harness.mjs"

let server, board
beforeAll(async () => {
  process.env.HUNTAWAY_FAKE_CLAUDE_SLEEP = "3"
  server = startServer("--fake-claude")
  delete process.env.HUNTAWAY_FAKE_CLAUDE_SLEEP
  board = await seedAgentBoard(server)
})
afterAll(() => server?.stop())

const newTask = (title, fields = {}) => server.rpc("tasks.create", { task: { project_id: board.project.id, title, status: "in_review", ...fields } })

// Waits for Runs (2.5). It checks a message sent from the composer shows in the thread, the agent's reply after it, and
// the task's state with them (working, then done), and that the draft is gone once it's sent.
test.skip("a message sent from the composer starts the agent, and its reply shows (waits for Runs, 2.5)", async () => {
  const task = await newTask("Updates: send")
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    await ui.run([`goto /p/${board.project.id}?task=${task.id}`, "wait No agent has worked on this yet", "click css=textarea", "type Say hello", "press Enter"])
    await ui.run(["wait css=[data-thread] >> text=Say hello", "wait Working…", "wait Fake reply to:", "gone Working…"])
    assert.equal(await page.locator("textarea").inputValue(), "")
    await eventually(async () => assert.equal((await server.rpc("tasks.get", { id: task.id })).running, false))
  })
})

// Waits for Runs (2.5). It checks a message sent while the agent works is steered into its run (shown above the composer
// until the agent reads it, then in the thread) and answered in the same run.
test.skip("a message sent while the agent works is steered into its run (waits for Runs, 2.5)", async () => {
  const task = await newTask("Updates: steer")
  await withBrowser(server, {}, async (ui) => {
    await ui.run([`goto /p/${board.project.id}?task=${task.id}`, "click css=textarea", "type First message", "press Enter", "wait Working…"])
    await ui.run(["click css=textarea", "type Also this", "press Enter"])
    await ui.run(["wait the agent reads it once it finishes its current step", "wait css=[data-thread] >> text=Also this", "wait Fake reply to:"])
    await ui.run(["gone the agent reads it once it finishes its current step", "gone Working…"])
  })
})

// Waits for Runs (2.5). It checks Stop in the header ends the run: the thread says the turn was interrupted, and the
// task isn't running any more.
test.skip("Stop ends the agent's run (waits for Runs, 2.5)", async () => {
  const task = await newTask("Updates: stop")
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    await ui.run([`goto /p/${board.project.id}?task=${task.id}`, "click css=textarea", "type Take your time", "press Enter", "wait Working…"])
    await page.locator("header button", { hasText: "Stop" }).click()
    await ui.run(["gone Working…", "wait Interrupted"])
    await eventually(async () => assert.equal((await server.rpc("tasks.get", { id: task.id })).running, false))
  })
})

// Waits for Runs (2.5). IA-161 review: a send still going when its composer went (another card) must not come back as a
// draft. Against the real run: the send is answered after the card changes.
test.skip("a message sent while its composer is gone doesn't come back as a draft (waits for Runs, 2.5)", async () => {
  const task = await newTask("Updates: gone", { status: "todo" })
  const other = await newTask("Updates: other", { status: "todo" })
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    await ui.run([`goto /p/${board.project.id}?task=${task.id}`, "click thread", "click css=textarea", "type Send this once", "press Enter"])
    await page.locator(`[data-task="${other.id}"]`).click()
    await page.locator("header").getByText("Updates: other").first().waitFor()
    await page.locator(`[data-task="${task.id}"]`).click()
    await ui.run(["click thread", "wait css=[data-thread] >> text=Send this once"])
    assert.equal(await page.locator("textarea").inputValue(), "")
    assert.equal(await page.evaluate((id) => Object.keys(localStorage).filter((k) => k.includes(id)).length, task.id), 0, "no saved draft")
  })
})

// Waits for Runs (2.5). It checks the thread of a task closed while its agent replied has the reply when it's opened
// again (kept subscribed for ten seconds after it's closed, then subscribed again).
test.skip("a thread opened again has what came while it was closed (waits for Runs, 2.5)", async () => {
  const task = await newTask("Updates: reopened")
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    await ui.run([`goto /p/${board.project.id}?task=${task.id}`, "click css=textarea", "type Reply while I'm away", "press Enter", "wait Working…"])
    await ui.run(["click Close (Esc)", "gone Working…"])
    await eventually(async () => assert.equal((await server.rpc("tasks.get", { id: task.id })).running, false), 15_000)
    await page.locator(`[data-task="${task.id}"]`).click()
    await ui.run(["wait Fake reply to:"])
  })
})
