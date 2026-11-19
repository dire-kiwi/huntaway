// HE-60: a document's link, `/docs/<profile id>/d/<slug>/`, opened on a hub whose own host hasn't that profile (the
// profile is a linked host's) opens the docs plugin's page on the host that has it. It went to the hub's own docs
// plugin, which said "no profile <id>".
import assert from "node:assert/strict"
import { afterAll, beforeAll, test } from "vite-plus/test"
import { eventually, makeProfile, startServer, withBrowser } from "./harness.mjs"

let hub, laptop, theirs
beforeAll(async () => {
  hub = startServer()
  laptop = startServer()
  await makeProfile(hub, "Default")
  theirs = await makeProfile(laptop, "Laptop")
})
afterAll(() => {
  hub?.stop()
  laptop?.stop()
})

test("a linked host's document opens on that host from the hub", async () => {
  const { id } = await hub.rpc("hub.hosts.add", { url: laptop.url, token: laptop.token })
  await eventually(
    async () =>
      assert.ok(
        (await hub.rpc("hub.hosts.list")).some((h) => h.id === id && h.connected),
        "laptop didn't connect",
      ),
    15_000,
  )
  await withBrowser(hub, {}, async (ui) => {
    const { page } = ui
    // The laptop's docs plugin answers: it knows the profile and says it has no such document (none is published).
    await ui.run([`goto /docs/${theirs.id}/d/rollout-plan/`])
    await page.getByText(`no document "rollout-plan"`).waitFor()
    assert.equal(await page.getByText(`no profile ${theirs.id}`).count(), 0)
    // And the profile's documents page is the laptop's, under its name.
    await ui.run([`goto /docs/${theirs.id}`, "wait Docs · Laptop"])
  })
})
