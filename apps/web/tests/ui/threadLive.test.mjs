// The task view and its thread are live: what changes anywhere (another tab, an agent, a script) shows in an open task
// without a reload. The board half of the old liveUpdates check is HE-3's liveUpdates.test.mjs; this is its task-view
// and thread half (IA-167).
//
// Dropped from the old check: times on cards moving on by themselves (the board's, HE-3's), a subproject's Board button
// counting its tasks (subprojects are gone), and the open card being marked (the board's).
import assert from "node:assert/strict"
import { afterAll, beforeAll, test } from "vite-plus/test"
import { eventually, seedAgentBoard, seedBoard, startServer, threadScroller, withBrowser } from "./harness.mjs"

let server, board
beforeAll(async () => {
  server = startServer()
  board = await seedBoard(server)
})
afterAll(() => server?.stop())

/** Where a page's thread is scrolled to, and how far from its end. */
const scrolledAt = (p) =>
  threadScroller(p).evaluate((el) => ({ top: Math.round(el.scrollTop), gap: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight) }))

const statusShown = (page) =>
  page
    .locator("section:has(h3:text-is('Status')) button.bg-raised")
    .innerText()
    .then((t) => t.split("\n").pop().trim())

// Two tabs on the same task: what one does, or a script does, the other's open task view shows (each tab has its own
// connection and board).
test("a task changed in one tab, or elsewhere, shows in another tab's open task view", async () => {
  const task = await server.rpc("tasks.create", { task: { project_id: board.project.id, title: "Live: one", status: "in_review" } })
  await withBrowser(server, {}, async (ui) => {
    const { page, context } = ui
    const panel = `/p/${board.project.id}?task=${task.id}`
    const other = await context.newPage()
    await other.goto(`${server.url}${panel}`)
    await other.locator("header h1", { hasText: "Live: one" }).waitFor()
    await ui.run([`goto ${panel}`, "wait css=header h1:has-text('Live: one')"])

    // Renamed in the first tab: the second's header follows.
    await ui.run(["dblclick css=h1[title='Double-click to rename']", "press Control+a", "type Live: renamed here", "press Enter"])
    await other.locator("header h1", { hasText: "Live: renamed here" }).waitFor()

    // Renamed by a script: both follow.
    await server.rpc("tasks.update", { id: task.id, patch: { title: "Live: renamed by a script" } })
    await ui.run(["wait css=header h1:has-text('Live: renamed by a script')"])
    await other.locator("header h1", { hasText: "Live: renamed by a script" }).waitFor()

    // Its status, in the second tab's details: moved by a script, then from the first tab's details.
    await other.getByRole("button", { name: /^details$/i }).click()
    await eventually(async () => assert.equal(await statusShown(other), "In review"))
    await server.rpc("tasks.update", { id: task.id, patch: { status: "needs_attention" } })
    await eventually(async () => assert.equal(await statusShown(other), "Needs attention"))
    await ui.run(["click details"])
    await page.locator("section:has(h3:text-is('Status')) button", { hasText: "In review" }).click()
    await eventually(async () => assert.equal(await statusShown(other), "In review"))
    await other.close()
  })
})

// The fake agent's reply streams in as the preview (HUNTAWAY_FAKE_CLAUDE_TEXT, sent a delta at a time every
// HUNTAWAY_FAKE_CLAUDE_STREAM_SLEEP seconds, for a prompt with the "fake-subagent" marker, which also runs a subagent).
// It checks that a thread at its end follows the streamed text, that one scrolled up stays where it is, and that the
// saved reply takes the streamed text's place, in both tabs (the old liveUpdates check, IA-167, with the deltas its
// socket sent).
test("the reply being written streams into the thread, which follows it at its end", async () => {
  const paragraphs = Array.from({ length: 60 }, (_, i) => `streamed ${i}`)
  Object.assign(process.env, { HUNTAWAY_FAKE_CLAUDE_TEXT: `Streaming **now**\n\n${paragraphs.join("\n\n")}`, HUNTAWAY_FAKE_CLAUDE_STREAM_SLEEP: "0.05" })
  const running = startServer("--fake-claude")
  try {
    const { project } = await seedAgentBoard(running)
    const task = await running.rpc("tasks.create", { task: { project_id: project.id, title: "Live: streaming", status: "in_review" } })
    await withBrowser(running, {}, async (ui) => {
      const { page, context } = ui
      const panel = `/p/${project.id}?task=${task.id}`
      const other = await context.newPage()
      await other.goto(`${running.url}${panel}`)
      await ui.run([`goto ${panel}`, "wait No agent has worked on this yet"])

      await ui.run(["click css=textarea", "type Write a long reply fake-subagent", "press Enter"])
      // Drawn as it comes, as plain text: the saved message is Markdown.
      await ui.run(["wait Streaming **now**"])
      await other.getByText("Streaming **now**").waitFor()
      // Once it's long enough to scroll (the old check had forty replies above the streamed one; here the streamed
      // reply is most of the thread), a thread at its end follows it.
      await eventually(async () => assert.ok(await threadScroller(page).evaluate((el) => el.scrollHeight - el.clientHeight > 200)))
      assert.ok((await scrolledAt(page)).gap < 80, "a thread at its end follows streamed text")
      // Scrolled up, it stays where it is.
      const scrolled = await threadScroller(page).evaluate((el) => {
        el.scrollTop = 100
        el.dispatchEvent(new Event("scroll"))
        return el.scrollTop
      })
      assert.equal(scrolled, 100)
      await ui.run(["wait streamed 40"])
      assert.equal((await scrolledAt(page)).top, 100, "a thread scrolled up isn't moved by streamed text")
      // The saved reply takes the streamed text's place.
      await ui.run(["gone Streaming **now**", "wait streamed 59"])
      await other.getByText("Streaming **now**").waitFor({ state: "detached" })
      await other.getByText("streamed 59", { exact: true }).waitFor()
      await other.close()
    })
  } finally {
    delete process.env.HUNTAWAY_FAKE_CLAUDE_TEXT
    delete process.env.HUNTAWAY_FAKE_CLAUDE_STREAM_SLEEP
    running.stop()
  }
})
