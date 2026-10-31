import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { startServer, withBrowser } from "./harness.mjs";

let server;
before(() => {
  server = startServer();
});
after(() => server?.stop());

const json = (route, body) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

// HA-38: an Update sends a host the hub's checkout, and the phase ended only when the host came back on the commit the
// hub runs. With the checkout ahead of it (or a host that came back on its old commit), the row said "building server…"
// for good, as the restart's state is gone with the old server, and the Update button stayed hidden.
test("a host's Update ends when it restarts, and offers the hub's checkout", async () => {
  const [running, checkout, remote] = ["c", "b", "a"].map((c) => c.repeat(40));
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    let updates = 0;
    let polls = 0;
    await page.route("**/api/hosts", async (route) => {
      const hosts = await (await route.fetch()).json();
      hosts[0].commit = running;
      const linked = { id: "rem", name: "remote", local: false, connected: true, mode: "outbound", agents: true, version: "0.1.0" };
      json(route, [...hosts, { ...linked, api_version: hosts[0].api_version, api_compat: 1, commit: remote }]);
    });
    await page.route("**/api/hosts/rem/update", (route) => {
      updates++;
      json(route, { ok: true });
    });
    await page.route("**/api/h/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/api/h/rem/admin/server") {
        // Two polls while it builds, then a new boot, still on its old commit, with no restart under way.
        if (updates) polls++;
        const restart = updates && polls <= 2 ? { phase: "building_server", log: "", error: null } : null;
        return json(route, { boot_id: polls > 2 ? "b2" : "b1", started_at: "", source_dir: "/src", running_commit: remote, running_agents: 0, restart });
      }
      if (path.endsWith("/admin/server")) return json(route, { ...(await (await route.fetch()).json()), source_dir: "/src", source_commit: checkout, running_commit: running });
      if (path.startsWith("/api/h/rem/")) return json(route, path.endsWith("/settings") ? {} : []);
      return route.fallback();
    });
    await ui.run(["goto /settings", "click Update to bbbbbbb", "wait building server", "wait Update to bbbbbbb", "gone building server"]);
    assert.equal(updates, 1);
  });
});

// HA-38: after the events socket dropped, it waited out its backoff (up to 32 s) even once the network was back.
test("the events socket reconnects at once when the network comes back", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    let socket;
    let down = false;
    const tries = [];
    await page.routeWebSocket(/\/api\/ws/, (ws) => {
      tries.push(Date.now());
      if (down) return ws.close();
      socket = ws;
      ws.connectToServer();
    });
    await ui.run(["goto /settings", "wait Hosts"]);
    down = true;
    socket.close();
    // Retries after 1, 2 and 4 s fail, and the next is 8 s later.
    while (tries.length < 4) await page.waitForTimeout(100);
    down = false;
    const back = Date.now();
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    while (tries.length < 5 && Date.now() - back < 3000) await page.waitForTimeout(50);
    assert.equal(tries.length, 5);
    assert.ok(tries[4] - back < 1000, `reconnected after ${tries[4] - back} ms`);
  });
});
