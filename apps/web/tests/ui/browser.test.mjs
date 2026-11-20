// The task's browser (HE-62). In a plain browser the globe opens the streamed pane. As the desktop app, played here by
// a stand-in for its preload's `paneDebugger`, a task's pane is its <webview>, which exists only once the user opened the
// browser on that task: opening the desktop view (with the fake Cua Driver) mounts none, even for a task with an address
// saved, as a hidden one would take the task's page from its agent.
import assert from "node:assert/strict"
import { afterAll, beforeAll, test } from "vite-plus/test"
import { seedBoard, startServer, withBrowser } from "./harness.mjs"

let server, board
beforeAll(async () => {
  server = startServer("--fake-desktop")
  board = await seedBoard(server)
  await server.rpc("desktop.setEnabled", { enabled: true })
})
afterAll(() => server?.stop())

/** The desktop app's bridge, as much of it as the pane asks for: nothing is given to the server. */
const desktopApp = () => {
  window.huntawayDesktop = {
    browserPane: true,
    paneDebugger: {
      attach: () => Promise.resolve({ error: "not in this check" }),
      send: () => Promise.resolve({ error: "not in this check" }),
      detach: () => undefined,
      onEvent: () => () => undefined,
      onDetached: () => () => undefined,
    },
  }
}

test("the globe opens the task's browser beside the thread, with its address bar", async () => {
  const task = await server.rpc("tasks.create", { task: { project_id: board.project.id, title: "Browse it" } })
  await withBrowser(server, { allowErrors: [/browser/i] }, async (ui) => {
    await ui.run([
      `goto /p/${board.project.id}?task=${task.id}`,
      "wait Browse it",
      `click [title="The task's browser, beside the thread"]`,
      "wait [aria-label=Address]",
    ])
    assert.equal(await ui.page.locator("canvas").count(), 1)
    assert.equal(await ui.page.locator("webview").count(), 0)
    await ui.run([`click [title="Close the browser"] >> nth=1`, "gone [aria-label=Address]"])
  })
})

test("in the desktop app, opening the desktop view mounts no browser pane, even for a task with an address saved", async () => {
  const task = await server.rpc("tasks.create", { task: { project_id: board.project.id, title: "Desktop only" } })
  await withBrowser(server, {}, async (ui) => {
    await ui.context.addInitScript(desktopApp)
    await ui.run([`goto /p/${board.project.id}?task=${task.id}`, "wait Desktop only"])
    const { host_id } = await (await fetch(`${server.url}/api/health`)).json()
    await ui.page.evaluate(([key]) => localStorage.setItem(key, "http://127.0.0.1:9/"), [`ia.browser:${host_id}:${task.id}`])
    await ui.run([
      "goto /",
      `goto /p/${board.project.id}?task=${task.id}`,
      `wait [title="What the agent sees on the host's desktop"]`,
      `click [title="What the agent sees on the host's desktop"]`,
      "wait What it did",
    ])
    assert.equal(await ui.page.locator("webview").count(), 0)
    // Opened and closed, the task's pane stays (closed); another task's view has none.
    await ui.run([`click [title="The task's browser, beside the thread"]`, "wait [aria-label=Address]"])
    // It starts at the saved address, which comes from storage a moment after the pane is drawn.
    await ui.page.locator("webview").waitFor({ state: "attached" })
    assert.equal(await ui.page.locator("webview").getAttribute("src"), "http://127.0.0.1:9/")
    await ui.run([`click [title="Close the browser"] >> nth=1`])
    // Kept for the agent, off-screen and hidden from the page's readers.
    assert.equal(await ui.page.locator("webview").count(), 1)
    assert.equal(await ui.page.locator("[aria-hidden=true] webview").count(), 1)
  })
})

/**
 * Something other than the board page gives the task's browser a page: a stand-in for a desktop pane on the server's
 * socket (no Chrome needed), which answers its commands with nothing and says it's on `url`, until `close` is called.
 */
const pageElsewhere = async (task, url) => {
  const { ticket } = await server.rpc("browser.pane", { task_id: task.id })
  const ws = new WebSocket(`${server.url.replace(/^http/, "ws")}/api/browser/${ticket}`)
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(String(e.data))
    if (typeof m.id !== "number") return
    ws.send(JSON.stringify({ id: m.id, result: {} }))
    if (m.method === "Page.getFrameTree") ws.send(JSON.stringify({ method: "Page.frameNavigated", params: { frame: { id: "F", url } } }))
  })
  await new Promise((resolve) => ws.addEventListener("open", resolve))
  return () => ws.close()
}

test("in the desktop app, an empty pane takes the page the task's browser opens later", async () => {
  const task = await server.rpc("tasks.create", { task: { project_id: board.project.id, title: "Empty pane" } })
  await withBrowser(server, {}, async (ui) => {
    await ui.context.addInitScript(desktopApp)
    await ui.run([
      `goto /p/${board.project.id}?task=${task.id}`,
      "wait Empty pane",
      `click [title="The task's browser, beside the thread"]`,
      "wait Type an address above",
    ])
    assert.equal(await ui.page.locator("webview").count(), 0)
    const close = await pageElsewhere(task, "http://127.0.0.1:9/elsewhere")
    try {
      await ui.page.locator("webview").waitFor({ state: "attached", timeout: 10_000 })
      assert.equal(await ui.page.locator("webview").getAttribute("src"), "http://127.0.0.1:9/elsewhere")
    } finally {
      close()
    }
  })
})
