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

// HA-76: a host installed from a release has no commit, so it was never offered an Update. It goes by version: Update
// to the release the hub runs, only when that's newer, and it ends when the host comes back on it.
test("a release host is offered the hub's version, and a checkout host without a commit isn't", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    let updates = 0;
    let [version, boot] = ["0.0.9", "b1"];
    let hub;
    await page.route("**/api/hosts", async (route) => {
      const hosts = await (await route.fetch()).json();
      hub = hosts[0].version;
      const linked = { local: false, connected: true, mode: "ssh", agents: true, api_version: hosts[0].api_version, api_compat: 1, commit: null };
      json(route, [
        ...hosts,
        { ...linked, id: "rel", name: "releasebox", version, updates_from: "releases" },
        { ...linked, id: "new", name: "newerbox", version: "99.0.0", updates_from: "releases" },
        { ...linked, id: "chk", name: "checkoutbox", version: "0.0.9", updates_from: "checkout" },
      ]);
    });
    await page.route("**/api/hosts/rel/update", (route) => {
      updates++;
      json(route, { ok: true });
    });
    await page.route("**/api/h/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/api/h/rel/admin/server") {
        return json(route, { boot_id: boot, started_at: "", running_agents: 0, restart: updates ? { phase: "downloading", log: "", error: null } : null });
      }
      if (/^\/api\/h\/(rel|new|chk)\//.test(path)) return json(route, path.endsWith("/settings") ? {} : []);
      return route.fallback();
    });
    await ui.run(["goto /settings", "wait checkoutbox"]);
    await ui.run([`wait Update to v${hub}`]);
    assert.equal(await page.locator("button", { hasText: "Update to" }).count(), 1, "only the older release host");
    const button = page.locator("button", { hasText: `Update to v${hub}` });
    assert.match(await button.getAttribute("title"), /downloads this release from GitHub/);
    await ui.run([`click Update to v${hub}`, "wait downloading"]);
    assert.equal(updates, 1);
    [version, boot] = [hub, "b2"];
    await ui.run(["gone downloading"]);
    await page.reload();
    await ui.run(["wait checkoutbox"]);
    assert.equal(await page.locator("button", { hasText: "Update to" }).count(), 0);
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
