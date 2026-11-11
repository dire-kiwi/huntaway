import assert from "node:assert/strict"
import { afterAll, beforeAll, test } from "vite-plus/test"
import { eventually, failure, routeRpc, seedBoard, startServer, withBrowser } from "./harness.mjs"

// The settings panels of 6.12 that no other check covers: a refused profile delete, a shortcut's key, and the first
// profile on a fresh board.
let server, board
beforeAll(async () => {
  server = startServer()
  board = await seedBoard(server)
})
afterAll(() => server?.stop())

// HA-40 (the old confirmErrors check): deleting a profile was fire-and-forget: a refusal (agents running, a host
// offline) left the page as it was with no message, and a double-click sent it twice.
test("a refused profile delete shows its error in the dialog, and a double-click deletes once", async () => {
  await server.rpc("profiles.create", { profile: { name: "Spare" } })
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    let refuse = true
    const calls = await routeRpc(page, (request) => {
      if (request.tag !== "profiles.delete") return undefined
      if (refuse) return failure({ _tag: "Conflict", reason: "agent_running", detail: "Spare has agents running" })
      // Slow, so a second click lands while the first is on its way.
      return new Promise((r) => setTimeout(() => r(undefined), 400))
    })
    const deletes = () => calls.filter((c) => c.tag === "profiles.delete").length
    const row = page.locator("section:has(> div > h2:text-is('Profiles')) .rounded-xl:has(> div:text-is('Spare'))")
    await ui.run(["goto /settings/profiles", "wait css=h2:text-is('Profiles')"])
    await row.locator("button[title='Delete']").click()
    await ui.run(["wait css=[role=dialog] >> text=Delete profile Spare", "click css=[role=dialog] button:has-text('Delete profile')"])
    await ui.run(["wait Spare has agents running"])
    assert.equal(await page.locator("[role=dialog]").count(), 1, "the dialog stays open with the error")

    refuse = false
    const before = deletes()
    await page.locator("[role=dialog] button:has-text('Delete profile')").dblclick()
    await ui.run(["gone css=[role=dialog]"])
    await eventually(async () => assert.ok(!(await server.rpc("profiles.list")).some((p) => p.name === "Spare"), "the profile is deleted"))
    assert.equal(deletes() - before, 1, "a double-click sends one request")
  })
})

// HA-396: a key picked in Settings → Keyboard shortcuts is the one the page takes, after a reload too. (The old check
// moved the Triage view's; Triage isn't on this server yet, so this one moves the search field's.)
test("a shortcut takes the key picked for it in the settings", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    await ui.run([
      "goto /settings/shortcuts",
      "wait Keyboard shortcuts",
      "click [aria-label^='Go to the search field (Board)']",
      "wait Press a key…",
      "press n",
    ])
    await ui.run(["gone Press a key…", "wait [aria-label='Go to the search field (Board): n. Change']"])
    await page.reload()
    await ui.run(["wait [aria-label='Go to the search field (Board): n. Change']", `goto /p/${board.project.id}`, "wait Search tasks"])
    const search = page.getByPlaceholder(/Search tasks/)
    await ui.run(["press /"])
    assert.equal(await search.evaluate((el) => el === document.activeElement), false, "the old key does nothing")
    await ui.run(["press n"])
    await eventually(async () => assert.equal(await search.evaluate((el) => el === document.activeElement), true))
  })
})

// A board with no profile opens on the welcome form; the first profile made there opens its board.
test("a fresh board asks for its first profile", async () => {
  const fresh = startServer("--fake-claude")
  try {
    await withBrowser(fresh, {}, async (ui) => {
      await ui.run(["goto /", "wait Welcome to Huntaway", "click css=input[placeholder='work / personal']", "type Work", "click Create profile"])
      await ui.run(["gone Welcome to Huntaway", "wait role=button[name=/Work/]"])
    })
    const [profile] = await fresh.rpc("profiles.list")
    assert.equal(profile.name, "Work")
    // Its config is the folder the form had, named after it, as the host had none.
    const configs = await fresh.rpc("configs.list")
    assert.ok(profile.claude_config_ids.length === 1 && configs.some((c) => c.id === profile.claude_config_ids[0]))
  } finally {
    fresh.stop()
  }
})
