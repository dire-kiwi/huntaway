// A subagent's own thread view (IA-127, IA-131), from the old subagentThread check. The thread is put into the server's
// database before the page opens it (threads.mjs: `seedThread`). The Agents list (layout/AgentsPill) isn't on this
// server yet, so a subagent is opened from its row ("Open subagent thread"), where the old checks picked it from the list.
//
// Dropped from the old check:
// - Opening a subagent from the Agents list while another tab shows (the list switching to the thread), and Escape with
//   the Agents list open: the list isn't here yet.
// - "Show in thread" reaching a subagent hidden by a group's limit on tool calls: with no Agents list, a hidden subagent
//   has no way in but its group, which shows it.
// - "Codex children show their metadata, nested transcript and permission source": Codex's translator comes with M5.
import assert from "node:assert/strict"
import { afterAll, beforeAll, test } from "vite-plus/test"
import { eventually, seedBoard, seedThread, startServer, withBrowser } from "./harness.mjs"

let server, board
beforeAll(async () => {
  server = startServer()
  board = await seedBoard(server)
})
afterAll(() => server?.stop())

const T = (n) => `2026-10-26T07:00:${String(n).padStart(2, "0")}.000Z`

/**
 * A finished thread whose agent started a subagent ("Explore config"), which started one of its own ("Check env"),
 * then another ("Look for tests") at the start of a group of tool calls long enough to hide it. The first subagent's
 * Bash call asked for permission, which was given.
 */
function subagentThread() {
  let n = 0
  const at = () => T(++n)
  const text = (id, body, parent) => ({ id, type: "assistant_message", text: body, created_at: at(), ...(parent ? { parent_id: parent } : {}) })
  const agent = (id, description, prompt, parent) => ({
    id,
    type: "tool_call",
    name: "Agent",
    kind: "subagent",
    input: { description, prompt },
    title: description,
    status: "completed",
    result: { content: "Done" },
    subagent: { status: "completed" },
    created_at: at(),
    ...(parent ? { parent_id: parent } : {}),
  })
  const items = [
    { id: "legacy:1", type: "user_message", text: "Find out how the config is loaded.", created_at: at() },
    text("legacy:2:0", "Main agent here, starting a subagent."),
    agent("A1", "Explore config", "Find where the configuration is loaded."),
    text("legacy:4:0", "Subagent searching now.", "A1"),
    {
      id: "b1",
      type: "tool_call",
      name: "Bash",
      kind: "shell",
      input: { command: "ls server/src" },
      command: "ls server/src",
      status: "completed",
      result: { content: "config.rs" },
      parent_id: "A1",
      created_at: at(),
    },
  ]
  // The permission it asked for, after its call.
  const permission = {
    id: "p1",
    type: "permission",
    tool_call_id: "b1",
    parent_id: "A1",
    name: "Bash",
    kind: "shell",
    input: { command: "ls server/src" },
    resolution: { outcome: "allow" },
    created_at: at(),
  }
  items.push(
    agent("A2", "Check env", "Which env vars override it?", "A1"),
    text("legacy:8:0", "Nested subagent's answer.", "A2"),
    text("legacy:9:0", "Subagent report.", "A1"),
    text("legacy:10:0", "Now the tests."),
    agent("A3", "Look for tests", "List the config tests."),
    text("legacy:12:0", "Hidden subagent's answer.", "A3"),
  )
  for (let i = 0; i < 6; i++)
    items.push({
      id: `r${i}`,
      type: "tool_call",
      name: "Read",
      kind: "read",
      input: { file_path: `/repo/file${i}.rs` },
      path: `/repo/file${i}.rs`,
      status: "completed",
      result: { content: `contents ${i}` },
      created_at: at(),
    })
  items.push(text("legacy:20:0", "Main agent's summary."), {
    id: "legacy:20:result",
    type: "turn_result",
    ok: true,
    duration_ms: 1000,
    metadata: { num_turns: 3 },
    created_at: at(),
  })
  return { items, requests: [permission] }
}

/** A task whose thread is the one above, on the board in To do (so its card is not under the panel). */
async function threadTask(title) {
  const task = await server.rpc("tasks.create", { task: { project_id: board.project.id, title, status: "todo" } })
  const { items, requests } = subagentThread()
  seedThread(server, task, items, requests)
  return task
}

/** Opens the subagent `name`'s own thread from its row. */
const openRow = (name) => `click css=[data-tool-row]:has-text('${name}') [aria-label='Open subagent thread'] >> visible=true`

/** Waits for the text to be shown within the thread's scrolled area. */
async function inView(page, text) {
  const el = page.getByText(text, { exact: true })
  await eventually(async () => {
    const shown = await el.evaluate((e) => {
      const r = e.getBoundingClientRect()
      const s = e.closest(".overflow-y-auto").getBoundingClientRect()
      return r.height > 0 && r.top >= s.top && r.bottom <= s.bottom
    })
    assert.ok(shown, `"${text}" isn't scrolled into view`)
  }, 3000)
}

// IA-127: picking a subagent only scrolled to its row in the main thread.
test("a subagent opens in its own thread view, and goes back to the main thread", async () => {
  const task = await threadTask("Subagents")
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    await ui.run([`goto /p/${board.project.id}?task=${task.id}`, "click Thread", "wait Main agent's summary.", openRow("Explore config")])
    await ui.run(["wait Show in thread", "wait Find where the configuration is loaded.", "wait Subagent searching now.", "wait Subagent report."])
    // Its permission prompt is in its thread, without the link to itself; the main thread isn't shown.
    await ui.run(["wait Permission for Bash", "gone from Explore config", "gone Main agent's summary."])

    // A nested subagent opens from its row, with the way back through the one that started it.
    await ui.run([openRow("Check env"), "wait Nested subagent's answer.", "gone Subagent searching now."])
    await ui.run(["press Escape", "wait Subagent searching now.", "gone Nested subagent's answer."])
    // Escape again is back to the main thread, with the task still open.
    await ui.run(["press Escape", "wait Main agent's summary.", "gone Show in thread", "wait css=header >> text=Subagents"])

    // The permission prompt's link opens the subagent's thread; "Show in thread" goes to its row, expanded.
    await ui.run(["click from Explore config", "wait Subagent searching now.", "gone Main agent's summary.", "click Show in thread"])
    await ui.run(["wait Main agent's summary.", "wait Subagent searching now.", "gone Show in thread"])
    assert.equal(await page.getByText("Subagent searching now.").count(), 1)
  })
})

// IA-131: Escape with a menu open in a subagent's thread closed the menu and also went back to the main thread.
test("escape with a menu open in a subagent's thread only closes the menu", async () => {
  const task = await threadTask("Subagent menus")
  await withBrowser(server, {}, async (ui) => {
    await ui.run([`goto /p/${board.project.id}?task=${task.id}`, "click Thread", "wait Main agent's summary.", openRow("Explore config")])
    await ui.run(["wait Subagent searching now.", "gone Main agent's summary."])

    // The composer's permission mode menu.
    await ui.run(["click css=[title^='Permission mode']", "wait css=.bottom-full.shadow-xl", "press Escape"])
    await ui.run(["gone css=.bottom-full.shadow-xl", "wait Subagent searching now.", "wait Show in thread"])

    // With no menu open, Escape still goes back, and the task stays open.
    await ui.run(["press Escape", "wait Main agent's summary.", "gone Show in thread", "wait css=header >> text=Subagent menus"])
  })
})

// IA-131 review: the subagent view was kept for the session, so reopening the task showed the last subagent viewed.
test("a reopened task shows its main thread, not the subagent last viewed", async () => {
  const task = await threadTask("Subagents reopened")
  const other = await server.rpc("tasks.create", { task: { project_id: board.project.id, title: "Another task", status: "todo" } })
  await withBrowser(server, {}, async (ui) => {
    const open = [openRow("Explore config"), "wait Subagent searching now.", "gone Main agent's summary."]
    await ui.run([`goto /p/${board.project.id}?task=${task.id}`, "click Thread", "wait Main agent's summary.", ...open])
    // Expanding the panel and back keeps it.
    await ui.run(["click Expand", "wait Subagent searching now.", "click Collapse into the side panel", "wait Subagent searching now."])

    await ui.run([
      "click Close (Esc)",
      "gone Show in thread",
      `click css=[data-task='${task.id}']`,
      "click Thread",
      "wait Main agent's summary.",
      "gone Show in thread",
    ])

    // Opening another task in the panel and coming back does too.
    await ui.run([...open, `click css=[data-task='${other.id}']`, "gone Show in thread", `click css=[data-task='${task.id}']`, "click Thread"])
    await ui.run(["wait Main agent's summary.", "gone Show in thread"])
  })
})

// IA-127 review: "Show in thread" left a row collapsed and out of view when it only mounted as the reveal expanded what
// was around it: a nested subagent inside a collapsed one.
test("show in thread reaches a nested subagent", async () => {
  const task = await threadTask("Hidden subagents")
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    await ui.run(["size 1900x500", `goto /p/${board.project.id}?task=${task.id}`, "click Thread", "wait Main agent's summary."])
    await ui.run(["gone Subagent searching now.", "gone Hidden subagent's answer.", "wait Show 1 earlier tool call"])

    await ui.run([openRow("Explore config"), "wait Subagent searching now.", openRow("Check env"), "wait Nested subagent's answer.", "click Show in thread"])
    await ui.run(["gone Show in thread", "wait Subagent searching now."])
    await inView(page, "Nested subagent's answer.")
  })
})
