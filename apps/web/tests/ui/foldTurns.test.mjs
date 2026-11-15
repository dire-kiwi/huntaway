// HE-22: Settings → Experiments, and its first experiment, "Fold finished turns". A finished turn with three tool
// calls (one failed, one that waited for approval) is drawn as today with the switch off, and as one row
// ("Worked for 2m 10s · 3 steps · $0.123", an amber and a red dot) with it on, which opens to the steps.
import assert from "node:assert/strict"
import { afterAll, beforeAll, test } from "vite-plus/test"
import { eventually, seedBoard, seedThread, startServer, withBrowser } from "./harness.mjs"

let server, board
beforeAll(async () => {
  server = startServer()
  board = await seedBoard(server)
})
afterAll(() => server?.stop())

const at = (s) => `2026-11-01T09:${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}.000Z`
const bash = (id, command, status, content, s) => ({
  id,
  type: "tool_call",
  name: "Bash",
  kind: "shell",
  input: { command },
  command,
  status,
  result: { content },
  created_at: at(s),
})

/** A finished turn: the user's message, the agent's text around three commands, and its result. */
function finishedTurn() {
  const items = [
    { id: "legacy:1", type: "user_message", text: "Tidy the config.", created_at: at(0) },
    { id: "legacy:2:0", type: "assistant_message", text: "Looking around first.", created_at: at(1) },
    bash("toolu_ls", "ls src", "completed", "Main.ts", 2),
    bash("toolu_cat", "cat nowhere", "failed", "cat: nowhere: No such file or directory", 3),
    bash("toolu_rm", "rm -rf build", "completed", "", 6),
    { id: "legacy:3:0", type: "assistant_message", text: "All tidy now.", created_at: at(120) },
    { id: "legacy:3:result", type: "turn_result", ok: true, duration_ms: 130_000, metadata: { num_turns: 7, total_cost_usd: 0.123 }, created_at: at(130) },
  ]
  // The last command waited for the user's approval.
  const requests = [
    {
      id: "prompt-1",
      type: "permission",
      tool_call_id: "toolu_rm",
      name: "Bash",
      kind: "shell",
      input: { command: "rm -rf build" },
      resolution: { outcome: "allow" },
      created_at: at(4),
    },
  ]
  return { items, requests }
}

test("Settings → Experiments switches folding finished turns on and off", async () => {
  const task = await server.rpc("tasks.create", { task: { project_id: board.project.id, title: "Tidy the config", status: "in_review" } })
  const { items, requests } = finishedTurn()
  seedThread(server, task, items, requests)
  const experiments = async () => (await server.rpc("host.settings")).experiments
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    const thread = `goto /p/${board.project.id}?task=${task.id}`
    const row = page.locator("[data-folded-turn]")
    // Off, as it is by default: the thread is drawn as before.
    assert.deepEqual(await experiments(), [])
    await ui.run([thread, "wait Turn complete", "wait cat nowhere", "wait Looking around first."])
    assert.equal(await row.count(), 0)

    await ui.run(["goto /settings/experiments", "wait Features that are still being tried", "click Fold finished turns"])
    await eventually(async () => assert.deepEqual(await experiments(), ["fold_turns"]))
    const toggle = page.getByRole("switch", { name: "Fold finished turns" })
    await eventually(async () => assert.equal(await toggle.getAttribute("aria-checked"), "true"))

    // On: the steps and the result line fold into one row; the text stays.
    await ui.run([
      thread,
      "wait Worked for 2m 10s · 3 steps · $0.123",
      "wait Looking around first.",
      "wait All tidy now.",
      "gone cat nowhere",
      "gone Turn complete",
      "gone Permission for",
    ])
    assert.equal(await row.locator("[data-dot=waited]").count(), 1)
    assert.equal(await row.locator("[data-dot=failed]").count(), 1)
    // It sits where the steps were, between the text before and after them.
    const order = await page.locator("[data-thread=items]").innerText()
    assert.ok(order.indexOf("Looking around first.") < order.indexOf("Worked for") && order.indexOf("Worked for") < order.indexOf("All tidy now."), order)
    // Clicked, the steps show as they do without it, and fold again.
    await row.click()
    await ui.run(["wait cat nowhere", "wait ls src", "wait Permission for", "wait Turn complete"])
    assert.equal(await row.getAttribute("aria-expanded"), "true")
    await row.click()
    await ui.run(["gone cat nowhere", "gone Turn complete"])

    // Off again: as before.
    await ui.run(["goto /settings/experiments", "click Fold finished turns"])
    await eventually(async () => assert.deepEqual(await experiments(), []))
    await ui.run([thread, "wait Turn complete", "wait cat nowhere"])
    assert.equal(await row.count(), 0)
  })
})
