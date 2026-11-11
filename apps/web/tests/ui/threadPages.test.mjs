// A long thread opens at a window of its last items and loads the pages before it as it's scrolled up (IA-169), from
// the old threadPages check. Its items are put into the server's database before the page opens it (threads.mjs:
// `seedThread`), and older pages are held, or failed, on the RPC websocket (`routeRpc`) as the old check held them with
// `page.route`.
//
// Dropped from the old check:
// - "a subagent from before the window opens from the Agents list…" and "a failed page while loading back to a subagent
//   can be tried again from its view": the Agents list (layout/AgentsPill) isn't on this server yet, and a subagent whose
//   call is before the window has no row to open it from.
// - "items added and changed while the window loads are in the thread once", "a permission answered while its page
//   loads shows the answer", "a closed thread's catch-up after a reconnect…", "a thread opened again has what came while
//   it was closed, and a resync catches it up…", "an open thread catches up from its seq when the events socket
//   reconnects": the client's hold, gap, catch-up and resync logic is gone (the server subscribes before it reads the
//   window, and a dropped subscription continues from its seq): packages/client/test/thread.test.ts covers what is left
//   ("a dropped subscription continues from the last event it had", "an event for an item of a page loaded since
//   changes it there"). Events while a page loads need an agent's run (2.5).
import assert from "node:assert/strict"
import { afterAll, beforeAll, test } from "vite-plus/test"
import { eventually, failure, gate, routeRpc, seedBoard, seedThread, startServer, threadScroller, withBrowser } from "./harness.mjs"

let server, board
beforeAll(async () => {
  server = startServer()
  board = await seedBoard(server)
})
afterAll(() => server?.stop())

const newTask = (title) => server.rpc("tasks.create", { task: { project_id: board.project.id, title, status: "in_review" } })
const T = (n) => `2026-10-27T07:${String(Math.floor(n / 60) % 60).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}.000Z`

/**
 * A long thread: the agent starts a background subagent early on, which hasn't finished, then writes 350 steps, each a
 * message and a tool call: 703 items, so its window (the last 300 items) starts at Step 201, and a page (200 items) is
 * 100 steps.
 */
function longThread() {
  const items = [
    { id: "legacy:1", type: "user_message", text: "Do a long job.", created_at: T(0) },
    {
      id: "A1",
      type: "tool_call",
      name: "Agent",
      kind: "subagent",
      input: { description: "Watch the logs", prompt: "Watch the logs as it goes.", run_in_background: true },
      title: "Watch the logs",
      status: "completed",
      result: { content: "Async agent launched successfully." },
      subagent: { status: "running", background: true, activity: "Tailing server.log" },
      created_at: T(1),
    },
    { id: "legacy:3:0", type: "assistant_message", text: "Watcher reading the logs.", parent_id: "A1", created_at: T(2) },
  ]
  for (let i = 1; i <= 350; i++) {
    items.push({ id: `legacy:${3 + i}:0`, type: "assistant_message", text: `Step ${i} of the job.`, created_at: T(2 + i) })
    items.push({
      id: `b${i}`,
      type: "tool_call",
      name: "Bash",
      kind: "shell",
      input: { command: `echo ${i}` },
      command: `echo ${i}`,
      status: "completed",
      result: { content: String(i) },
      created_at: T(2 + i),
    })
  }
  return items
}

/** Chromium keeps what's on screen in place by itself (CSS scroll anchoring); Safari doesn't, so the thread does it too. */
const noAnchoring = (page) =>
  page.addInitScript(() =>
    addEventListener("DOMContentLoaded", () =>
      document.head.append(Object.assign(document.createElement("style"), { textContent: "* { overflow-anchor: none !important; }" })),
    ),
  )

/** The thread's top item on screen, and how far it is from the top of the scrolled area. */
const topItem = (page) =>
  threadScroller(page).evaluate((el) => {
    const top = el.getBoundingClientRect().top
    const item = [...el.querySelector(":scope > div.mx-auto:not(.hidden)").children].find((c) => c.getBoundingClientRect().bottom > top)
    return { text: item.textContent, y: Math.round(item.getBoundingClientRect().top - top) }
  })

/** Where the item with this text is now, as topItem has it. */
const itemAt = (page, text) =>
  threadScroller(page).evaluate((el, wanted) => {
    const item = [...el.querySelector(":scope > div.mx-auto:not(.hidden)").children].find((c) => c.textContent === wanted)
    return { text: wanted, y: Math.round(item.getBoundingClientRect().top - el.getBoundingClientRect().top) }
  }, text)

const pages = (calls) => calls.filter((c) => c.tag === "threads.page").map((c) => `before=${c.payload.before}&limit=${c.payload.limit}`)

test("a long thread opens at its latest window and loads older pages as it's scrolled up, where it was", async () => {
  const task = await newTask("Long job")
  seedThread(server, task, longThread())
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    await noAnchoring(page)
    const pageGate = gate()
    let holding = true
    const calls = await routeRpc(page, (r) => (r.tag === "threads.page" && holding ? pageGate.hold() : undefined))
    await ui.run([`goto /p/${board.project.id}?task=${task.id}`, "wait Step 350 of the job.", "wait Load earlier messages"])
    assert.deepEqual(
      calls.filter((c) => c.tag === "threads.watch").map((c) => c.payload),
      [{ task_id: task.id, limit: 300 }],
    )
    assert.equal(await page.getByText("Step 200 of the job.", { exact: true }).count(), 0)
    assert.equal(await page.getByText("Step 201 of the job.", { exact: true }).count(), 1)

    // At the top: the page before comes in above, and what was on screen stays put.
    await threadScroller(page).evaluate((el) => (el.scrollTop = 0))
    await ui.run(["wait Loading earlier messages"])
    const shown = await topItem(page)
    holding = false
    pageGate.release()
    await ui.run(["wait Step 200 of the job."])
    await eventually(async () => {
      const after = await itemAt(page, shown.text)
      assert.ok(Math.abs(after.y - shown.y) <= 2, `${JSON.stringify(shown)} → ${JSON.stringify(after)}`)
    })
    assert.deepEqual(pages(calls).slice(0, 1), ["before=403&limit=200"])

    // All the way up to the start.
    await eventually(async () => {
      await threadScroller(page).evaluate((el) => (el.scrollTop = 0))
      assert.equal(await page.getByText("Do a long job.", { exact: true }).count(), 1)
    }, 15_000)
    await ui.run(["gone Load earlier messages", "wait Watch the logs"])
    assert.deepEqual(pages(calls), ["before=403&limit=200", "before=203&limit=200", "before=3&limit=200"])
  })
})

test("a failed page can be tried again", async () => {
  const task = await newTask("Long job, offline")
  seedThread(server, task, longThread())
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    let failing = true
    await routeRpc(page, (r) => (r.tag === "threads.page" && failing ? failure({ _tag: "NotFound", what: "task", id: task.id }) : undefined))
    await ui.run([`goto /p/${board.project.id}?task=${task.id}`, "wait Step 350 of the job."])
    await threadScroller(page).evaluate((el) => (el.scrollTop = 0))
    await ui.run(["wait Couldn't load earlier messages. Try again"])
    failing = false
    await ui.run(["click Couldn't load earlier messages. Try again", "wait Step 200 of the job."])
  })
})

// IA-169 review: a page that added calls to a group of tool calls drew the group again, collapsed, and lost the place.
test("a page joining an expanded group of tool calls keeps it expanded, and the place", async () => {
  const task = await newTask("Long job, one group")
  // 402 items: the window (300) starts at command-102.
  const items = [{ id: "legacy:1", type: "user_message", text: "Run them all.", created_at: T(0) }]
  for (let i = 1; i <= 400; i++)
    items.push({
      id: `c${i}`,
      type: "tool_call",
      name: "Bash",
      kind: "shell",
      input: { command: `command-${i}` },
      command: `command-${i}`,
      status: "completed",
      result: { content: `output-${i}` },
      created_at: T(i),
    })
  items.push({ id: "legacy:2:0", type: "assistant_message", text: "All done.", created_at: T(401) })
  seedThread(server, task, items)
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    await noAnchoring(page)
    const pageGate = gate()
    await routeRpc(page, (r) => (r.tag === "threads.page" ? pageGate.hold() : undefined))
    await ui.run([
      `goto /p/${board.project.id}?task=${task.id}`,
      "wait All done.",
      "click css=button:has-text('earlier tool calls')",
      "gone css=button:has-text('earlier tool calls')",
    ])
    // A call opened, and the calls near it on screen.
    await ui.run(["click command-110", "wait output-110"])
    const row = (text) =>
      threadScroller(page).evaluate((el, wanted) => {
        const r = [...el.querySelectorAll("[data-tool-row]")].find((x) => x.textContent.includes(wanted))
        return r && Math.round(r.getBoundingClientRect().top - el.getBoundingClientRect().top)
      }, text)
    await threadScroller(page).evaluate((el) => {
      const r = [...el.querySelectorAll("[data-tool-row]")].find((x) => x.textContent.includes("command-110"))
      el.scrollTop += r.getBoundingClientRect().top - el.getBoundingClientRect().top - 20
    })
    const before = await row("command-110")
    await threadScroller(page).evaluate((el) => el.dispatchEvent(new Event("scroll")))
    await ui.run(["wait Loading earlier messages"])
    pageGate.release()
    await ui.run(["wait command-90"])
    await eventually(async () => assert.equal(await row("command-110"), before))
    await ui.run(["wait output-110", "gone css=button:has-text('earlier tool calls')"])
  })
})
