// A subagent's own thread view (IA-127, IA-131), from the old subagentThread check. The thread is put into the server's
// database before the page opens it (threads.mjs: `seedThread`). A subagent opens from the Agents list
// (layout/AgentsPill, "Subagents in this thread") or from its row ("Open subagent thread").
//
// Dropped from the old check:
// - "Codex children show their metadata, nested transcript and permission source": Codex's translator comes with M5.
import assert from "node:assert/strict"
import { afterAll, beforeAll, test } from "vite-plus/test"
import { DatabaseSync } from "node:sqlite"
import { join } from "node:path"
import { eventually, makeProject, seedBoard, seedThread, startServer, withBrowser } from "./harness.mjs"

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

/** Opens the subagent `name`'s own thread from the Agents list. */
const fromList = (name) => ["click Subagents in this thread", `click css=.shadow-xl button:has-text('${name}')`]

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

// IA-127: picking a subagent from the Agents list only scrolled to its row in the main thread.
test("a subagent opens in its own thread view, and goes back to the main thread", async () => {
  const task = await threadTask("Subagents")
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    // From another tab: the list switches to the thread.
    await ui.run([`goto /p/${board.project.id}?task=${task.id}`, "click Thread", "wait Main agent's summary.", "click Details", ...fromList("Explore config")])
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
    await ui.run([`goto /p/${board.project.id}?task=${task.id}`, "click Thread", "wait Main agent's summary.", ...fromList("Explore config")])
    await ui.run(["wait Subagent searching now.", "gone Main agent's summary."])

    // The Agents list.
    await ui.run(["click Subagents in this thread", "wait css=.shadow-xl button:has-text('Look for tests')", "press Escape"])
    await ui.run(["gone css=.shadow-xl button:has-text('Look for tests')", "wait Subagent searching now.", "wait Show in thread", "gone Main agent's summary."])

    // The composer's permission mode menu too.
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
    // In the side panel, where another card can be opened beside it.
    await ui.run([`goto /p/${board.project.id}?task=${task.id}&side`, "click Thread", "wait Main agent's summary.", ...open])
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

    // Opening another task in the side panel (a card opens in a dialog, over the others) and coming back does too.
    await ui.run([
      "click Collapse into the side panel",
      ...open,
      `click css=[data-task='${other.id}']`,
      "gone Show in thread",
      `click css=[data-task='${task.id}']`,
      "click Thread",
    ])
    await ui.run(["wait Main agent's summary.", "gone Show in thread"])
  })
})

// IA-127 review: "Show in thread" left a row collapsed and out of view when it only mounted as the reveal expanded what
// was around it: a nested subagent inside a collapsed one, or one hidden by a group's limit on tool calls.
test("show in thread reaches a nested subagent and one in a group's hidden calls", async () => {
  const task = await threadTask("Hidden subagents")
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    await ui.run(["size 1900x500", `goto /p/${board.project.id}?task=${task.id}`, "click Thread", "wait Main agent's summary."])
    await ui.run(["gone Subagent searching now.", "gone Hidden subagent's answer.", "wait Show 1 earlier tool call"])

    await ui.run([...fromList("Check env"), "wait Nested subagent's answer.", "click Show in thread"])
    await ui.run(["gone Show in thread", "wait Subagent searching now."])
    await inView(page, "Nested subagent's answer.")

    await ui.run([...fromList("Look for tests"), "wait Show in thread", "click Show in thread"])
    await ui.run(["gone Show in thread", "gone Show 1 earlier tool call"])
    await inView(page, "Hidden subagent's answer.")
  })
})

// HE-40: in the narrow layout the Agents list is a sheet along the window's bottom; the header's row of controls fades
// its end out with a mask, which hid the sheet when it was drawn inside that row.
test("the Agents list shows in the narrow layout, and opens a subagent", async () => {
  const task = await threadTask("Subagents narrow")
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    await ui.run([
      "size 600x900",
      `goto /p/${board.project.id}?task=${task.id}`,
      "click Thread",
      "wait Main agent's summary.",
      "click Subagents in this thread",
    ])
    const item = page.locator(".shadow-xl button:has-text('Explore config')")
    await item.waitFor()
    // It's the element on top where it's drawn, not under the thread's composer.
    const onTop = await item.evaluate((el) => {
      const r = el.getBoundingClientRect()
      return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))
    })
    assert.ok(onTop, "the list is hidden under something")
    await item.click()
    await ui.run(["wait Show in thread", "wait Subagent searching now.", "gone css=.shadow-xl button:has-text('Explore config')"])
  })
})

// HE-40 review: the list hung from the pill's right edge went off the task dialog's left, titles and all, wherever the
// pill was far enough left: with the controls in a row of their own (a view under 880 wide), or in the title row of a
// view just wide enough with more controls after it (terminal tools' tabs). And the pill pushed the title row's last
// buttons out of the dialog where the controls only just fitted beside the title.
/** A terminal tool, which adds a tab to the task view's controls. */
const tool = (n) => ({ id: `t${n}`, name: `tool ${n}`, command: "true" })

test("the Agents list and the header stay within the task view, however crowded its controls", async () => {
  const task = await threadTask("Subagents in a small window")
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    // What cuts off what's in `el`: its nearest ancestor that clips, or the window.
    await page.addInitScript(() => {
      window.clipOf = (el) => {
        for (let p = el; p; p = p.parentElement) if (getComputedStyle(p).overflowX !== "visible") return p.getBoundingClientRect()
        return { left: 0, right: window.innerWidth }
      }
    })
    for (const tools of [0, 1, 3]) {
      await server.rpc("host.updateSettings", { patch: { terminal_tools: Array.from({ length: tools }, (_, n) => tool(n)) } })
      // In the task dialog, and in the side panel beside the board.
      for (const [size, side] of [
        ["760x900", ""],
        ["950x900", ""],
        ["962x900", ""],
        ["980x900", ""],
        ["1020x900", ""],
        ["1400x900", "&side"],
      ]) {
        const where = `${size}${side} with ${tools} terminal tools`
        await ui.run([
          `size ${size}`,
          `goto /p/${board.project.id}?task=${task.id}${side}`,
          "click Thread",
          "wait Main agent's summary.",
          "click Subagents in this thread",
        ])
        const title = page.locator(".shadow-xl button:has-text('Explore config') span.truncate").first()
        await title.waitFor()
        // The list is all within the view, and its first item's title is what's on top at its left.
        const fits = await title.evaluate((el) => {
          const clip = window.clipOf(el.closest(".shadow-xl").parentElement)
          const list = el.closest(".shadow-xl").getBoundingClientRect()
          const r = el.getBoundingClientRect()
          return list.left >= clip.left && list.right <= clip.right && el.contains(document.elementFromPoint(r.x + 4, r.y + r.height / 2))
        })
        assert.ok(fits, `the list isn't all shown at ${where}`)
        await ui.run(["press Escape", "gone css=.shadow-xl button:has-text('Explore config')"])
        // The title row's last button is within the view, and the title has room.
        const header = await page.locator("h1[title='Double-click to rename']").evaluate((h1) => {
          const clip = window.clipOf(h1.parentElement)
          const last = h1.parentElement.lastElementChild.getBoundingClientRect()
          return { inside: last.right <= clip.right, title: h1.clientWidth }
        })
        assert.ok(header.inside, `the header's last button is cut off at ${where}`)
        assert.ok(header.title >= 100, `the title is ${header.title}px wide at ${where}`)
      }
    }
    await server.rpc("host.updateSettings", { patch: { terminal_tools: [] } })
  })
})

// HE-40 review: the width the controls needed was taken from the view's width as it was before a resize, so collapsing
// the dialog into the side panel and expanding it again left them in a row of their own in a view with room for them.
test("the controls come back beside the title once the view is wide again", async () => {
  const task = await threadTask("Subagents, with a title long enough to need its room in the header of the task view")
  await server.rpc("host.updateSettings", { patch: { terminal_tools: [tool(0), tool(1)] } })
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    const besideTitle = () =>
      page.locator("h1[title='Double-click to rename']").evaluate((h1) => !!h1.parentElement.querySelector("[title='Subagents in this thread']"))
    await ui.run([
      "size 1900x1000",
      `goto /p/${board.project.id}?task=${task.id}`,
      "click Thread",
      "wait Main agent's summary.",
      "wait Subagents in this thread",
    ])
    assert.ok(await besideTitle(), "the controls aren't beside the title in the dialog")
    await ui.run(["click Collapse into the side panel", "wait Expand"])
    await eventually(async () => assert.ok(!(await besideTitle()), "the controls are still beside the title in the side panel"))
    await ui.run(["click Expand", "wait Collapse into the side panel"])
    await eventually(async () => assert.ok(await besideTitle(), "the controls didn't come back beside the title"))
    // And after the window is made smaller and larger again.
    await ui.run(["size 1000x1000"])
    await eventually(async () => assert.ok(!(await besideTitle())))
    await ui.run(["size 1900x1000"])
    await eventually(async () => assert.ok(await besideTitle(), "the controls didn't come back after the window grew"))
  })
  await server.rpc("host.updateSettings", { patch: { terminal_tools: [] } })
})

// HE-40 review: a review thread's header was one row, and the Agents pill pushed its last buttons (Close, Expand) out of
// the side panel. Here a long project name crowds it, where a running reviewer's Context and Stop would.
test("a crowded review thread's header keeps its buttons within the side panel", async () => {
  const project = await makeProject(server, board.profile, "Longer project name", "LNG")
  const parent = await server.rpc("tasks.create", { task: { project_id: project.id, title: "Reviewed work", status: "in_review" } })
  const thread = await server.rpc("tasks.create", { task: { project_id: project.id, title: "Review", status: "in_review" } })
  const db = new DatabaseSync(join(server.dataDir, "board.db"))
  try {
    db.exec("PRAGMA busy_timeout = 5000")
    db.prepare("UPDATE tasks SET kind = 'review', parent_id = ? WHERE id = ?").run(parent.id, thread.id)
  } finally {
    db.close()
  }
  const { items, requests } = subagentThread()
  seedThread(server, thread, items, requests)
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    for (const size of ["1000x900", "720x900", "1900x900"]) {
      await ui.run([`size ${size}`, `goto /p/${project.id}?task=${thread.id}&side`, "wait Main agent's summary.", "wait Subagents in this thread"])
      const header = await page.locator("header:has([title^='Close']) h1").evaluate((h1) => {
        let clip = { left: 0, right: window.innerWidth }
        // The nearest ancestor that clips: the side panel's view.
        for (let p = h1.closest("header").parentElement; p; p = p.parentElement)
          if (getComputedStyle(p).overflowX !== "visible") {
            clip = p.getBoundingClientRect()
            break
          }
        const close = h1.closest("header").querySelector("[title^='Close']").getBoundingClientRect()
        return { inside: close.right <= Math.min(clip.right, window.innerWidth), title: h1.clientWidth, natural: h1.scrollWidth }
      })
      assert.ok(header.inside, `Close is cut off at ${size}`)
      assert.ok(header.title >= Math.min(100, header.natural), `the title is ${header.title}px wide at ${size}`)
    }
    // The list opens from the pill wherever it is.
    await ui.run(["size 720x900", "click Subagents in this thread", "click css=.shadow-xl button:has-text('Explore config')", "wait Show in thread"])
  })
})
