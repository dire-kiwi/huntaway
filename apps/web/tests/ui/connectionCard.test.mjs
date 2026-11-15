import assert from "node:assert/strict"
import { afterAll, beforeAll, test } from "vite-plus/test"
import { seedBoard, startServer, withBrowser } from "./harness.mjs"

// The assistant's connection card (HE-28): its agent, the fake `claude`, asks with "fake-board-call request_connection
// <JSON>"; the card says what's missing (this test server has no Google server) and why, opens the profile's Google card
// from Settings in a dialog, and Skip tells the agent to carry on without it. Connecting (Check again, the board's own
// look) is the server's tests' (assistant/Connections.test.ts): it needs a Google sign-in.

let server, profile
beforeAll(async () => {
  server = startServer("--fake-claude")
  ;({ profile } = await seedBoard(server))
})
afterAll(() => server?.stop())

test("the assistant asks for Google with a card: what's missing, a dialog to set it up, and Skip", async () => {
  const ask = { connection: "google", reason: "To find the flight confirmation in your mail" }
  await server.rpc("assistant.send", { profile_id: profile.id, text: `fake-board-call request_connection ${JSON.stringify(ask)}` })
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    await ui.run(["goto /assistant/Default", "wait The assistant asks to connect Google", "wait To find the flight confirmation in your mail"])
    await ui.run(["wait css=[aria-label='Connect Google'] >> text=There's no Google server on this host yet"])
    // Set up opens Settings → Assistant → Google over the page.
    await ui.run(["click Set up Google", "wait Settings → Assistant → Google", "wait Add the Google server", "click Done"])
    assert.equal(await page.getByText("Settings → Assistant → Google").count(), 0)
    // Check again: still not connected.
    await ui.run(["click Check again", "wait Still not connected."])
    // Skip: the card settles, and the agent is told to carry on without it.
    await ui.run(["click css=[aria-label='Connect Google'] >> text=Skip", "wait css=[aria-label='Connect Google'] >> text=skipped"])
    await ui.run(["wait text=Fake reply to: The user skipped connecting Google. Carry on without it."])
    assert.equal(await page.getByRole("button", { name: "Check again" }).count(), 0)
  })
})
