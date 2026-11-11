import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { afterAll, beforeAll, test } from "vite-plus/test"
import { eventually, makeProfile, makeProject, makeTask, routeRpc, startServer, success, withBrowser } from "./harness.mjs"

// The task's Terminal tab and its terminal tools (the old terminal.test.mjs, 6.1). The old checks routed the terminal's
// status (`GET /terminal`) and its socket (`/terminal/ws?…&tool=`); here the status and the ticket are RPCs
// (`terminal.status`, `terminal.open`, held with `routeRpc`), the socket is `/api/terminal/<ticket>`, and which tool it
// is for is in `terminal.open`'s payload. The host's terminal tools are its settings (`host.updateSettings`), which the
// old check routed. The last check runs a real tmux on the test server's own tmux server.

let server, project
beforeAll(async () => {
  server = startServer()
  const profile = await makeProfile(server)
  project = await makeProject(server, profile, "Demo", "DEM")
})
afterAll(() => server?.stop())

for (const tool of [false, true])
  test(`${tool ? "lazygit" : "terminal"} opens without a canvas context and survives hiding and reconnecting`, async () => {
    const task = await makeTask(server, project, { title: "Terminal rendering", status: "in_review" })
    if (tool) await server.rpc("host.updateSettings", { patch: { terminal_tools: [{ id: "lg", name: "lazygit", command: "lazygit" }] } })
    await withBrowser(server, {}, async (ui) => {
      const { page } = ui
      // Browsers may refuse canvas allocation under resource pressure. The canvas addon's
      // uncaught error used to abort initialization before even opening the websocket.
      await page.addInitScript(() => {
        const getContext = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, "getContext").value
        HTMLCanvasElement.prototype.getContext = function (...args) {
          if (this.classList.contains("xterm-text-layer")) return null
          return Reflect.apply(getContext, this, args)
        }
      })
      let tickets = 0
      const calls = await routeRpc(page, (request) => {
        if (request.tag === "terminal.status") return success({ available: true, running: true, cwd: "/test", reason: null, tool: null })
        if (request.tag === "terminal.open") return success({ ticket: `t${++tickets}` })
        // The real one would end the tool's session, which this check never made.
        if (request.tag === "terminal.kill") return success(null)
        return undefined
      })
      let socket,
        connections = 0
      const input = []
      await page.routeWebSocket(/\/api\/terminal\//, (ws) => {
        socket = ws
        connections++
        assert.match(new URL(ws.url()).pathname, new RegExp(`/api/terminal/t${tickets}$`))
        ws.onMessage((data) => {
          if (typeof data !== "string") input.push(data.toString())
        })
        ws.send(JSON.stringify({ type: "ready" }))
        ws.send(Buffer.from("Terminal output ready\r\n$ "))
      })
      await ui.run([`goto /t/${task.id}`, tool ? "click Open lazygit in a terminal" : "click terminal"])
      // xterm (a lazy chunk), the terminal's status and its font load first, which took seconds on a busy CI runner. The
      // socket opens as xterm is set up, so give it its 5s from then.
      await page.locator(".xterm").waitFor({ timeout: 20000 })
      await eventually(() => assert.ok(connections, "terminal connects even when a canvas context is unavailable"))
      assert.deepEqual(calls.find((c) => c.tag === "terminal.open")?.payload, { task_id: task.id, tool: tool ? "lg" : null })
      await page.getByText("Terminal output ready", { exact: false }).waitFor()
      await page.locator(".xterm-helper-textarea").press("a")
      await eventually(() => assert.ok(input.includes("a"), "keyboard input reaches the session"))
      await ui.run(["click thread"])
      await page.waitForTimeout(100)
      await ui.run([tool ? '[title="lazygit (open)"]' : "terminal"].map((t) => `click ${t}`))
      await page.getByText("Terminal output ready", { exact: false }).waitFor({ state: "visible" })
      assert.equal(connections, 1, "switching tabs preserves the session")
      socket.close({ code: 1000, reason: "Session ended" })
      await ui.run([tool ? "click Start lazygit again" : "click Start a new session"])
      await page.getByText("Terminal output ready", { exact: false }).waitFor()
      assert.equal(connections, 2)
    })
    if (tool) await server.rpc("host.updateSettings", { patch: { terminal_tools: [] } })
  })

test("a real tmux shell displays command output", { skip: spawnSync("tmux", ["-V"]).status !== 0 }, async () => {
  const task = await makeTask(server, project, { title: "Real terminal", status: "in_review" })
  try {
    await withBrowser(server, {}, async (ui) => {
      const { page } = ui
      await ui.run([`goto /t/${task.id}`, "click terminal"])
      await page.getByText("tmux", { exact: true }).waitFor()
      const input = page.locator(".xterm-helper-textarea")
      await input.fill("printf '\\110\\101\\055\\061\\063\\061\\055\\117\\113\\n'")
      await input.press("Enter")
      await page.locator(".xterm-rows").getByText("HA-131-OK", { exact: false }).waitFor()
    })
  } finally {
    // Its session outlives the browser: ended here (and the data folder's tmux server is ended with the test server).
    await server.rpc("terminal.kill", { task_id: task.id, tool: null })
  }
})
