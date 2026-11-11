import assert from "node:assert/strict"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, beforeAll, test } from "vite-plus/test"
import { eventually, makeProfile, startServer, withBrowser } from "./harness.mjs"

// A host's page with another host linked (docs/plan/09-frontend.md, Step 1 as done for settings/): copying an agent
// config's login to the linked host (`hub.hosts.copyConfig` over the config archives), switching settings sync on there,
// and taking it off the board. Two test servers on the fake agent, so their configs show; nothing is faked.

let hub, host, hubId, hostId
beforeAll(async () => {
  hub = startServer("--fake-claude")
  host = startServer("--fake-claude")
  await makeProfile(hub)
  hubId = (await hub.rpc("host.info")).host_id
  hostId = (await host.rpc("host.info")).host_id
  await hub.rpc("hub.hosts.add", { url: host.url, token: host.token })
  await eventually(async () => assert.ok((await hub.rpc("hub.hosts.list")).find((h) => h.id === hostId)?.connected), 20000)
})
afterAll(() => {
  hub?.stop()
  host?.stop()
})

test("a config's login is copied to the linked host, into a config made there", async () => {
  const from = join(hub.dataDir, "claude-work")
  const to = join(host.dataDir, "claude-work")
  mkdirSync(from, { recursive: true })
  writeFileSync(join(from, ".credentials.json"), '{"token":"t"}')
  writeFileSync(join(from, "settings.json"), "{}")
  await hub.rpc("configs.create", { config: { name: "work", config_dir: from } })
  await withBrowser(hub, {}, async (ui) => {
    const { page } = ui
    await ui.run([`goto /hosts/${hubId}`, "wait Agent configs on this host", "click Copy login", 'wait Copy "work" login from', `wait ${from}`])
    const dir = page.locator("[data-modal] input").last()
    assert.equal(await dir.inputValue(), from)
    await dir.fill(to)
    await page.locator("[data-modal]").getByRole("button", { name: "Copy login" }).click()
    await ui.run(["wait Copied .credentials.json, settings.json."])
  })
  const made = (await host.rpc("configs.list")).find((c) => c.name === "work")
  assert.equal(made?.config_dir, to)
  assert.equal(readFileSync(join(to, ".credentials.json"), "utf8"), '{"token":"t"}')
})

test("the linked host's page switches its settings sync on, and Remove takes it off the board", async () => {
  await withBrowser(hub, {}, async (ui) => {
    await ui.run([`goto /hosts/${hostId}`, "wait Settings sync", "wait Off: this host keeps its own settings", "click Sync this host's settings"])
    await ui.run(["wait A setting changed here goes to the other hosts"])
    assert.equal((await host.rpc("host.settings")).settings_sync, true)
    await ui.run([
      "click role=button[name='Remove from board']",
      "wait Its projects, threads and agents stay on that host",
      "click role=button[name='Remove from board'] >> nth=-1",
    ])
    await ui.run([`gone [data-host="${hostId}"]`, `wait [data-host="${hubId}"]`])
    assert.equal(new URL(ui.page.url()).pathname, "/settings/hosts")
  })
  assert.equal(
    (await hub.rpc("hub.hosts.list")).find((h) => h.id === hostId),
    undefined,
  )
})
