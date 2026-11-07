import assert from "node:assert/strict";
import { afterAll, beforeAll, test } from "vite-plus/test";
import { startServer, withBrowser } from "./harness.mjs";

let server;
beforeAll(() => {
  server = startServer();
});
afterAll(() => server?.stop());

const host = (o) => ({ host_id: null, version: null, api_version: 128, via: "lan", linked: false, ...o });

// HA-289: Settings → Hosts lists hosts found on the LAN and Tailscale (faked here), and Link fills in Add host's URL.
test("a nearby host's Link opens Add host by URL with its URL filled in; linked ones aren't listed", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    let found = {
      tailscale: true,
      hosts: [
        host({ host_id: "a", name: "buildbox", url: "http://192.168.1.20:7878", version: "0.9.0" }),
        host({ host_id: "b", name: "already-linked", url: "http://192.168.1.21:7878", linked: true }),
        host({ name: "old-laptop", url: "http://100.64.0.7:7878", via: "tailscale", api_version: 120 }),
      ],
    };
    await page.route("**/api/hosts/discover", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(found) }));
    await ui.run(["goto /settings/hosts", "wait Nearby hosts", "wait buildbox", "wait old-laptop", "wait Tailscale · http://100.64.0.7:7878"]);
    assert.equal(await page.getByText("already-linked").count(), 0);

    await ui.run(["click text=old-laptop >> xpath=../.. >> role=button[name='Link']", "wait By URL and token"]);
    assert.equal(await page.inputValue("input[placeholder='http://buildbox:7878']"), "http://100.64.0.7:7878");
    // The token is what's left to give.
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("type")), "password");
    await ui.run(["click Cancel", "gone By URL and token"]);

    // Add host on its own still starts empty, over SSH.
    await ui.run(["click role=button[name='Add host']", "wait SSH target", "click By URL and token"]);
    assert.equal(await page.inputValue("input[placeholder='http://buildbox:7878']"), "http://");
    await ui.run(["click Cancel", "gone By URL and token"]);

    found = { tailscale: false, hosts: [] };
    await ui.run(["click Search again", "wait No other hosts found on this network.", "gone buildbox"]);
  });
});
