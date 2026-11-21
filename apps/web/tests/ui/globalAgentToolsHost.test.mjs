// Settings → Skills and MCP on a board with two hosts (HE-41): each host keeps its own skills, and only its own
// profiles' agents get them. The panel always showed the board's own host, so on a board whose host has no profiles (a
// laptop showing another machine's projects) a skill added there reached no agent, with nothing to switch it on with.
// It now starts on a host with profiles, and a picker says whose tools these are. (With settings sync, on by default since
// HE-46, hosts have the same global skills and profiles; these are hosts where it is off.)
import assert from "node:assert/strict"
import { afterAll, beforeAll, test } from "vite-plus/test"
import { eventually, makeProfile, pick, startServer, withBrowser } from "./harness.mjs"

let board, home, profile
beforeAll(async () => {
  // Both can run agents (the fake one), as the panel is only for hosts that can.
  board = startServer("--fake-claude")
  home = startServer("--fake-claude")
  profile = await makeProfile(home, "Personal")
  // Hosts that differ: with settings sync on (the default since HE-46) the board's host would take home's profile and
  // skills, so it is switched off there, as a host that keeps its own.
  await board.rpc("host.updateSettings", { patch: { settings_sync: false } })
})
afterAll(() => {
  board?.stop()
  home?.stop()
})

test("the panel starts on the host with profiles, and says so of one without", async () => {
  const { id } = await board.rpc("hub.hosts.add", { url: home.url, token: home.token })
  await board.rpc("hub.hosts.update", { id, name: "homeserver" })
  await eventually(
    async () =>
      assert.ok(
        (await board.rpc("hub.hosts.list")).some((h) => h.id === id && h.connected),
        "homeserver didn't connect",
      ),
    15_000,
  )
  await home.rpc("agentTools.addSkill", { project_id: null, skill: { content: "---\nname: home-skill\ndescription: On the home server\n---\nHi.\n" } })
  await withBrowser(board, {}, async (ui) => {
    const { page } = ui
    await ui.run(["goto /settings/tools", "wait home-skill", "wait On by default in"])
    // Its profile's switch, which turns the skill on for its projects.
    await page.getByTitle("Off by default in Personal's projects. Click to turn on.").click()
    await eventually(async () =>
      assert.equal((await home.rpc("agentTools.get")).profile_switches[profile.id]?.[(await home.rpc("agentTools.get")).skills[0].id], true),
    )
    // The board's own host has no profiles: picked, it says so.
    await pick(page.locator("#settings-tab-panel [role=combobox]"), { label: /\(this host\)$/ })
    await ui.run(["wait has no profiles", "gone home-skill"])
  })
})

// HE-41 review: the shown host came from the connected hosts on every render, so when it dropped the panel moved to the
// board's own host and remounted, closing an open editor and losing what was typed in it.
test("a host that goes offline stays shown, with its open editor", async () => {
  await withBrowser(board, {}, async (ui) => {
    const { page } = ui
    await ui.run(["goto /settings/tools", "wait home-skill", "click New skill"])
    const editor = page.locator("textarea")
    await editor.fill("---\nname: half-typed\n---\n")
    home.kill()
    await ui.run(["wait homeserver is offline"])
    assert.equal(await editor.inputValue(), "---\nname: half-typed\n---\n")
    assert.equal(await page.locator("#settings-tab-panel [role=combobox]").innerText(), "homeserver (offline)")
    await ui.run(["gone has no profiles"])
  })
})
