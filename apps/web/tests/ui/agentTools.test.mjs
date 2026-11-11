import assert from "node:assert/strict"
import { afterAll, beforeAll, test } from "vite-plus/test"
import { eventually, routeRpc, seedBoard, startServer, withBrowser } from "./harness.mjs"

// A project's skills and MCP servers (the old agentTools check, 6.4): its Skills and MCP tab, which 6.12's project
// settings mount (`ProjectAgentTools`). Saves are slowed by holding `agentTools.updateProject` (`routeRpc`), as the old
// check slowed `PATCH /projects/{id}/agent-tools`.

let server, project
beforeAll(async () => {
  server = startServer()
  ;({ project } = await seedBoard(server))
})
afterAll(() => server?.stop())

const disabled = async () => (await server.rpc("agentTools.project", { project_id: project.id })).disabled_skills

// IA-63: switches clicked before the previous save came back used to send a stale list, so a click was lost.
test("fast clicks on skill switches all reach the server", async () => {
  const names = ["alpha", "beta", "gamma"]
  await server.rpc("agentTools.updateProject", { project_id: project.id, patch: { disabled_skills: names } })
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    // Slow saves, so every click lands while an earlier one is still saving.
    await routeRpc(page, (request) =>
      request.tag === "agentTools.updateProject" ? new Promise((resolve) => setTimeout(() => resolve(undefined), 400)) : undefined,
    )
    await ui.run([`goto /p/${project.id}/settings/tools`, "click Skills from Claude configs"])
    for (const name of names) await page.getByRole("switch", { name, exact: true }).click()
    await eventually(async () => assert.deepEqual(await disabled(), []), 5000)
    // Switched back on and never seen in a run, they're no longer listed, before or after a reload.
    await ui.run(["wait none seen yet", `goto /p/${project.id}/settings/tools`, "wait none seen yet"])
  })
})
