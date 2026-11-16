// HE-49: an agent's `space_request_sign_ins` prompt is drawn as its own card: the Space, the host browser profile and
// the sites with their cookie counts, identity providers unticked. The user unticks a site, ticks one back, and allows
// it: only those go (the fake `claude`, asked with "fake-ask-sign-ins", says in its reply which sites it was allowed with).
// There is no Always allow; Deny sends nothing.
import assert from "node:assert/strict"
import { afterAll, beforeAll, test } from "vite-plus/test"
import { makeTask, seedBoard, startServer, withBrowser } from "./harness.mjs"

let server, board
beforeAll(async () => {
  server = startServer("--fake-claude")
  board = await seedBoard(server)
})
afterAll(() => server?.stop())

const asking = async (title) => {
  const task = await makeTask(server, board.project, { title })
  await server.rpc("tasks.send", { id: task.id, text: "Sign in for me. fake-ask-sign-ins" })
  return task
}
const reply = (page) => page.getByText(/\(permission /).first()

test("the sign-ins card lists the sites, and sends only the ones left ticked", async () => {
  const task = await asking("Bring sign-ins")
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    await ui.run([
      `goto /p/${board.project.id}?task=${task.id}`,
      "wait Claude asks to bring your sign-ins into",
      "wait Research",
      "wait From Chromium (Work) on this host",
      "wait github.com",
      "wait google.com",
      "wait identity",
      "wait Not in this profile: nothere.com",
      "wait Bring 2 sites",
      "gone Always allow",
    ])
    const card = page.locator('[data-card="sign-ins"]')
    const box = (site) => card.locator("label", { hasText: site }).locator('input[type="checkbox"]')
    assert.equal(await box("google.com").isChecked(), false)
    await box("figma.com").uncheck()
    await box("google.com").check()
    await ui.run(["click Bring 2 sites", "wait brought"])
    assert.match(await reply(page).textContent(), /permission mcp__spaces__space_request_sign_ins: allow sites=\["github.com","google.com"\]/)
  })
})

test("denied, nothing is sent", async () => {
  const task = await asking("No sign-ins")
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    await ui.run([`goto /p/${board.project.id}?task=${task.id}`, "wait Bring 2 sites", "click Deny", "wait not brought"])
    assert.match(await reply(page).textContent(), /permission mcp__spaces__space_request_sign_ins: deny/)
  })
})
