import assert from "node:assert/strict"
import { afterAll, beforeAll, test } from "vite-plus/test"
import { routeRpc, startServer, success, withBrowser } from "./harness.mjs"

// The nearby hosts on Settings → Hosts (the old nearbyHosts check): what the hub finds (`hub.hosts.discover`) is the
// test's, as a test server runs no discovery.

let server
beforeAll(() => {
  server = startServer()
})
afterAll(() => server?.stop())

const found = (o) => ({ host_id: null, version: null, protocol: 1, capabilities: null, via: "lan", linked: false, ...o })

// HA-289: Settings → Hosts lists hosts found on the LAN and Tailscale, and Link fills in Add host's URL.
test("a nearby host's Link opens Add host by URL with its URL filled in; linked ones aren't listed", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    let answer = {
      tailscale: true,
      hosts: [
        found({ host_id: "a", name: "buildbox", url: "http://192.168.1.20:7879", version: "0.9.0" }),
        found({ host_id: "b", name: "already-linked", url: "http://192.168.1.21:7879", linked: true }),
        found({ name: "old-laptop", url: "http://100.64.0.7:7879", via: "tailscale", protocol: null }),
        found({ host_id: "c", name: "office-nas", url: "http://100.64.0.9:7879", via: "mesh", through: "buildbox" }),
      ],
    }
    await routeRpc(page, (r) => (r.tag === "hub.hosts.discover" ? success(answer) : undefined))
    await ui.run([
      "goto /settings/hosts",
      "wait Nearby hosts",
      "wait buildbox",
      "wait old-laptop",
      "wait Tailscale · http://100.64.0.7:7879",
      "wait Linked from buildbox · http://100.64.0.9:7879",
    ])
    assert.equal(await page.getByText("already-linked").count(), 0)

    await ui.run(["click text=old-laptop >> xpath=../.. >> role=button[name='Link']", "wait By URL and token"])
    assert.equal(await page.inputValue("input[placeholder='http://buildbox:7879']"), "http://100.64.0.7:7879")
    // The token is what's left to give.
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("type")), "password")
    await ui.run(["click Cancel", "gone By URL and token"])

    // Add host on its own still starts empty, over SSH.
    await ui.run(["click role=button[name='Add host']", "wait SSH target", "click By URL and token"])
    assert.equal(await page.inputValue("input[placeholder='http://buildbox:7879']"), "http://")
    await ui.run(["click Cancel", "gone By URL and token"])

    answer = { tailscale: false, hosts: [] }
    await ui.run(["click Search again", "wait No other hosts found on this network, or linked", "gone buildbox"])
  })
})
