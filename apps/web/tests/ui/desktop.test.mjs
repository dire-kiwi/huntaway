// The task view's desktop view (6.10, HA-273): on a host whose agents may use its desktop, the task's button opens what
// its agent sees there and what it did. The server runs the fake Cua Driver (`--fake-desktop`) and the fake agent; the
// agent's desktop calls are made here, as the run makes them, over the run's own `desktop` server.
import assert from "node:assert/strict"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { afterAll, beforeAll, test } from "vite-plus/test"
import { eventually, seedBoard, startServer, withBrowser } from "./harness.mjs"

let server, board
beforeAll(async () => {
  server = startServer("--fake-claude", "--fake-desktop")
  board = await seedBoard(server)
  await server.rpc("desktop.setEnabled", { enabled: true })
})
afterAll(() => server?.stop())

/** The newest run's id and the bearer its `desktop` server takes (from its mcp.json). */
const newestRun = () => {
  const runs = join(server.dataDir, "runs")
  const id = readdirSync(runs)
    .map((name) => ({ name, at: statSync(join(runs, name)).mtimeMs }))
    .toSorted((a, b) => b.at - a.at)[0]?.name
  assert.ok(id, "no run")
  const mcp = JSON.parse(readFileSync(join(runs, id, "mcp.json"), "utf8"))
  assert.ok(mcp.mcpServers.desktop, "the run has no desktop server")
  return { id, auth: mcp.mcpServers.desktop.headers.Authorization }
}

/** A desktop tool's call as run `run` makes it; its text. */
const call = async (run, name, args) => {
  const res = await fetch(`${server.url}/api/mcp/${run.id}/desktop`, {
    method: "POST",
    headers: { authorization: run.auth, "content-type": "application/json", accept: "application/json", connection: "close" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  })
  const out = await res.json()
  return out.result.content.map((c) => c.text ?? "").join("\n")
}

test("the desktop view shows the window the agent used and what it did there", async () => {
  const task = await server.rpc("tasks.create", { task: { project_id: board.project.id, title: "Use the desktop" } })
  // A run that keeps going until it's stopped, launched with computer use on.
  await server.rpc("tasks.send", { id: task.id, text: "fake-until-interrupted" })
  const run = await eventually(async () => {
    const r = newestRun()
    assert.match(await call(r, "windows", {}), /Fake Notes/)
    return r
  }, 15_000)
  assert.match(await call(run, "act", { pid: 4242, window_id: 7, steps: [{ tool: "type_text", args: { text: "hello" } }], op_id: "a1" }), /ran 1 steps/)
  await call(run, "clipboard", { text: "copied" })

  await withBrowser(server, {}, async (ui) => {
    await ui.run([
      `goto /p/${board.project.id}?task=${task.id}`,
      // Its title may have been rewritten by the agent's first turn by now: the button is what's waited for.
      `wait [title="What the agent sees on the host's desktop"]`,
      `click [title="What the agent sees on the host's desktop"]`,
      "wait What it did",
      'wait copy "copied"',
      'wait type "hello"',
      "wait window 7 of pid 4242",
      "wait css=img[alt='What the agent sees']",
    ])
    // Closed, the thread has the room again.
    await ui.run(["click [title='Close the desktop view'] >> nth=0", "gone What it did"])
  })
  await server.rpc("tasks.stop", { id: task.id })
})

test("the button shows only on a host whose agents may use its desktop", async () => {
  const task = await server.rpc("tasks.create", { task: { project_id: board.project.id, title: "No desktop here" } })
  await server.rpc("desktop.setEnabled", { enabled: false })
  try {
    await withBrowser(server, {}, async (ui) => {
      await ui.run([`goto /p/${board.project.id}?task=${task.id}`, "wait No desktop here"])
      assert.equal(await ui.page.locator(`[title="What the agent sees on the host's desktop"]`).count(), 0)
    })
  } finally {
    await server.rpc("desktop.setEnabled", { enabled: true })
  }
})
