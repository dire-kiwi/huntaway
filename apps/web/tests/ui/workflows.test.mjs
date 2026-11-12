// The project's workflow editor and a task's workflow tabs (plan task 6.6), as the old checks had them (HA-173, HA-310).
// The old ones read and made workflows over the REST API; these call `workflows.*` over RPC.
import assert from "node:assert/strict"
import { afterAll, beforeAll, test } from "vite-plus/test"
import { eventually, makeTask, seedBoard, startServer, withBrowser } from "./harness.mjs"

let server, project
beforeAll(async () => {
  server = startServer()
  ;({ project } = await seedBoard(server))
})
afterAll(() => server?.stop())

const workflows = () => server.rpc("workflows.list", { project_id: project.id })

/** Drags from one element's centre to another's, as a person does with the mouse. */
async function drag(page, from, to, { dx = 0, dy = 0 } = {}) {
  const a = await page.locator(from).boundingBox()
  const b = to ? await page.locator(to).boundingBox() : null
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2)
  await page.mouse.down()
  const x = b ? b.x + b.width / 2 : a.x + a.width / 2 + dx
  const y = b ? b.y + b.height / 2 : a.y + a.height / 2 + dy
  await page.mouse.move(x, y, { steps: 8 })
  await page.mouse.up()
}

// HA-173: the node editor: a preset, a step added and connected by dragging, a connection removed, and a step moved, saved as shown.
test("a workflow made in its editor saves the graph it shows", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    await ui.run([
      `goto /p/${project.id}/settings/workflows`,
      "wait No workflows yet",
      "click role=button[name=/Review and summarise/]",
      "wait [data-testid=workflow-canvas]",
    ])
    // A loop is refused: the summary can't lead back into the check.
    await drag(page, "[data-port='summary.done']", "[data-node=changed]")
    await ui.run(["wait That would make a loop"])
    await ui.run(["click role=button[name=/^Agent$/]", "wait [data-node=agent1]"])
    await drag(page, "[data-port='reviewer.failed']", "[data-node=agent1]")
    await ui.run(['click [data-testid=workflow-inspector] >> role=textbox[name="Name"s]', "press Control+a", "type Notes"])
    // Removes the check's connection to the reviewer by clicking its line.
    await page.locator("[data-edge='changed.yes->reviewer']").dispatchEvent("pointerdown", { button: 0 })
    await ui.run(["wait text=Connection", "click [data-testid=workflow-inspector] >> role=button[name=/Remove/]"])
    const before = await page.locator("[data-node=summary]").boundingBox()
    await drag(page, "[data-node=summary] >> text=Writes text", null, { dx: 0, dy: 60 })
    const moved = await page.locator("[data-node=summary]").boundingBox()
    assert.ok(Math.abs(moved.y - before.y - 60) <= 10, `moved by ${moved.y - before.y}`)
    await ui.run(["click Create workflow", "gone [role=dialog]", "wait Review and summarise"])

    const list = await workflows()
    assert.equal(list.length, 1)
    const g = list[0].graph
    const edges = g.edges.map((e) => `${e.from}.${e.port}->${e.to}`).toSorted()
    assert.deepEqual(edges, ["reviewer.failed->agent1", "reviewer.issues->fix", "reviewer.pass->summary", "start.done->changed"])
    const notes = g.nodes.find((n) => n.id === "agent1")
    assert.equal(notes.kind, "agent")
    assert.equal(notes.name, "Notes")
    const summary = g.nodes.find((n) => n.id === "summary")
    assert.ok(Math.abs(summary.y - 250) <= 10, `summary at ${summary.y}`)

    // Opened again, it shows what it was saved with, and saves it unchanged.
    await ui.run(["click role=button[name=/^Edit$/]", "wait Edit Review and summarise", "wait [data-node=agent1]", "click Save", "gone [role=dialog]"])
    const again = await server.rpc("workflows.get", { id: list[0].id })
    assert.deepEqual(again.graph, g)
  })
})

// HA-173: a workflow's agent steps show in the task panel's tabs, and it can be run from the task's details.
test("a task's workflow runs show in the tabs its steps name", async () => {
  const w = await server.rpc("workflows.create", {
    workflow: {
      project_id: project.id,
      name: "Notes by hand",
      graph: {
        nodes: [
          { id: "start", kind: "trigger", on: "manual", x: 0, y: 0 },
          { id: "notes", kind: "agent", name: "Release notes", prompt: "Write release notes.", output: "text", tab: "Notes", x: 200, y: 0 },
        ],
        edges: [{ from: "start", port: "out", to: "notes" }],
      },
    },
  })
  const task = await makeTask(server, project, { title: "Release it", status: "todo" })
  await withBrowser(server, {}, async (ui) => {
    await ui.run([
      `goto /p/${project.id}?task=${task.id}`,
      "wait Notes by hand",
      'click role=button[name="Run Notes by hand"s]',
      'wait role=button[name="Notes"s]',
      'click role=button[name="Notes"s]',
    ])
    // Agents can't run on this server, so the step fails; it still shows where its output goes.
    await ui.run(["wait Release notes", "wait Notes by hand"])
  })
  const { runs } = await eventually(() => server.rpc("workflows.runsOfTask", { task_id: task.id }))
  assert.equal(runs.length, 1)
  assert.equal(runs[0].workflow_id, w.id)
})

// HA-310: an A/B test's paths: added, wired, weighted and taken out (the paths after it moving up a letter, with their
// lines), and a reviewer that keeps its conversation, saved as shown.
test("an A/B test's paths and weights save as the editor shows them", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    await ui.run([
      `goto /p/${project.id}/settings/workflows`,
      "click role=button[name=/Review and summarise/]",
      "wait [data-testid=workflow-canvas]",
      "click role=button[name=/^A\\/B test$/]",
      "wait [data-node=ab1]",
      "wait [data-testid=split-paths]",
      "click Add a path",
      "wait [data-port='ab1.c']",
    ])
    await drag(page, "[data-port='changed.yes']", "[data-node=ab1]")
    await drag(page, "[data-port='ab1.b']", "[data-node=reviewer]")
    await drag(page, "[data-port='ab1.c']", "[data-node=summary]")
    // Path A goes, and B and C, with their lines, become A and B.
    await ui.run(["click [data-node=ab1] >> text=A/B test", "click role=button[name=/Remove path A/]", "gone [data-port='ab1.c']"])
    await ui.run(["click role=spinbutton[name=/Weight of path B/]", "press Control+a", "type 150"])
    await ui.run(["wait [data-node=ab1] >> text=B · 75%", "wait [data-node=ab1] >> text=A · 25%"])
    await ui.run(["click [data-node=reviewer] >> text=Pass or issues", "click Keep its conversation from one run to the next"])
    await ui.run(["wait [data-node=reviewer] >> text=keeps its conversation", "wait role=switch[name=/Keep its conversation/][checked=true]"])
    await ui.run(["click Create workflow", "gone [role=dialog]"])

    const g = (await workflows()).find((w) => w.graph.nodes.some((n) => n.kind === "split")).graph
    const ab = g.nodes.find((n) => n.id === "ab1")
    assert.deepEqual([ab.kind, ab.weights], ["split", [50, 150]])
    const edges = g.edges.filter((e) => e.from === "ab1" || e.to === "ab1").map((e) => `${e.from}.${e.port}->${e.to}`)
    assert.deepEqual(edges.toSorted(), ["ab1.a->reviewer", "ab1.b->summary", "changed.yes->ab1"])
    assert.equal(g.nodes.find((n) => n.id === "reviewer").keep_conversation, true)
  })
})
