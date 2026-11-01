import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { startServer, withBrowser } from "./harness.mjs";

let server;
before(() => {
  server = startServer();
});
after(() => server?.stop());

const json = (route, body) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
const ago = (s) => new Date(Date.now() - s * 1000).toISOString();

/** A tarball host with `--release-updates`, running 0.1.0 from `app/`, with 0.2.0 staged. */
function release(over = {}) {
  return {
    repo: "dire-kiwi/huntaway",
    running: "0.1.0",
    exe: "/srv/huntaway/app/0.1.0/huntaway",
    latest: {
      version: "0.2.0",
      prerelease: false,
      published_at: ago(86400),
      notes: "## What's new\n\n- **Faster** boards",
      url: "https://github.com/dire-kiwi/huntaway/releases/tag/v0.2.0",
      asset: { name: "huntaway-server-0.2.0-linux-x64.tar.gz", url: "https://example.invalid/s.tar.gz", size: 40e6, sha256: "ab" },
      newer: true,
    },
    prereleases: false,
    checked_at: ago(300),
    error: null,
    rate_limit_reset: null,
    shell: null,
    bundled_server: "/opt/huntaway-server/huntaway",
    staged: "0.2.0",
    download: null,
    previous: null,
    bad: [],
    rollback_to: "bundled",
    ...over,
  };
}

/**
 * Adds linked host `rem` to the board (by default on API 85, without a commit, as a release install has none),
 * answering its `GET /admin/server` with `server()` and its release endpoints, and its other requests with nothing.
 * Returns the calls the release endpoints and `PATCH /settings` got.
 */
async function linkedHost(page, host, server) {
  const calls = { check: 0, update: [], rollback: 0, settings: [] };
  await page.route("**/api/hosts", async (route) => {
    const hosts = await (await route.fetch()).json();
    const linked = { id: "rem", name: "remote", local: false, connected: true, mode: "outbound", agents: true, version: "0.1.0", commit: null };
    json(route, [...hosts, { ...linked, api_version: 85, api_compat: 1, ...host }]);
  });
  const status = () => ({ boot_id: "b1", started_at: ago(3600), source_dir: null, running_commit: null, running_agents: 1, restart: null, ...server() });
  await page.route("**/api/h/rem/**", (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname.replace("/api/h/rem", "");
    if (path === "/admin/server") return json(route, status());
    if (path === "/admin/release/check") {
      calls.check++;
      return json(route, status());
    }
    if (path === "/admin/release/update") {
      calls.update.push(req.postDataJSON());
      return json(route, { ok: true });
    }
    if (path === "/admin/release/rollback") {
      calls.rollback++;
      return json(route, { ok: true });
    }
    if (path === "/settings" && req.method() === "PATCH") {
      calls.settings.push(req.postDataJSON());
      return json(route, req.postDataJSON());
    }
    return json(route, path.endsWith("/settings") ? {} : []);
  });
  return calls;
}

// HA-74: a linked host with release updates shows its version, the latest release and Update on its page, and Update
// restarts it onto the staged release through the hub, the page following the restart's phases until it's back.
test("a linked host's page offers its staged release, and follows the Update", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    let s = { release: release() };
    const calls = await linkedHost(page, {}, () => s);
    await ui.run([
      "goto /hosts/rem",
      "wait Running v0.1.0",
      "wait /srv/huntaway/app/0.1.0/huntaway",
      "wait Latest release on dire-kiwi/huntaway",
      "wait v0.2.0 is downloaded and checked",
      "gone Not running from a source checkout",
    ]);
    await ui.run(["click Update to v0.2.0", "wait Update Huntaway", "wait Release notes", "wait this page follows it until it's back", "wait 1 agent is running"]);
    const dialog = page.getByRole("dialog");
    assert.match(await dialog.textContent(), /v0\.1\.0→v0\.2\.0/);
    await dialog.getByRole("button", { name: "Update & restart" }).click();
    await ui.run(["gone Update Huntaway"]);
    assert.deepEqual(calls.update, [{ version: "0.2.0" }]);
    // The host's phases while it restarts, then its new boot on 0.2.0.
    s = { release: release(), restart: { phase: "installing", log: "Unpacking it", error: null } };
    await ui.run(["wait Installing the release…"]);
    s = { boot_id: "b2", release: release({ running: "0.2.0", staged: null, latest: { ...release().latest, newer: false }, previous: "0.1.0", rollback_to: "0.1.0" }) };
    await ui.run(["gone Installing the release…", "wait Running v0.2.0", "wait which this server runs", "gone Update to v0.2.0"]);
  });
});

// HA-74: Check now, the prereleases toggle and Roll back go to the linked host, a download shows its progress, and a
// new desktop app on that host says how to install it, without this app's own Install.
test("a linked host's release checks, download and Roll back go through the hub", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    await page.addInitScript(() => {
      window.huntawayDesktop = { setBadgeCount() {}, focus() {}, shellUpdateKind: () => "pacman", updateShell: () => Promise.reject(new Error("not this app")) };
    });
    const pkg = { name: "p", url: "https://example.invalid/huntaway-0.3.0-linux-x64.pacman", size: 1, sha256: "ab" };
    const shell = { version: "0.2.0", install: "pacman", path: null, outdated: true, package: pkg };
    const latest = { ...release().latest, version: "0.3.0", url: "https://github.com/dire-kiwi/huntaway/releases/tag/v0.3.0" };
    let r = release({ running: "0.2.0", staged: null, latest, previous: "0.1.0", rollback_to: "0.1.0", shell, download: { version: "0.3.0", phase: "downloading", bytes: 10e6, total: 40e6, error: null } });
    // A host newer than this board, which offered the board's code to bring it in line: without a checkout it can't
    // take it, so it isn't offered.
    const calls = await linkedHost(page, { api_compat: 999 }, () => ({ release: r }));
    await ui.run([
      "goto /hosts/rem",
      "wait Downloading v0.3.0 in the background: 10.0 MB of 40.0 MB",
      "wait The desktop app on this host has an update",
      "wait that host's app installs from its own Settings → Server",
      `wait sudo pacman -U ${pkg.url}`,
    ]);
    assert.equal(await page.getByRole("button", { name: /^(Install|Update app)$/ }).count(), 0);
    assert.equal(await page.getByText(/^Update to [0-9a-f]{7}$/).count(), 0);
    r = { ...r, download: null, staged: "0.3.0" };
    await ui.run(["click Check now", "wait Update to v0.3.0", "gone Downloading v0.3.0"]);
    assert.equal(calls.check, 1);
    r = { ...r, prereleases: true };
    await page.getByRole("switch", { name: "Include prereleases" }).click();
    await page.waitForFunction(() => document.querySelector("[role=switch][aria-checked=true]"));
    assert.deepEqual(calls.settings, [{ release_prereleases: true }]);
    await ui.run(["click Roll back to v0.1.0", "wait Roll back Huntaway", "wait v0.2.0 may have migrated the database", "wait This page follows it until it's back"]);
    await page.getByRole("dialog").getByRole("button", { name: "Roll back to v0.1.0" }).click();
    await ui.run(["gone Roll back Huntaway"]);
    assert.equal(calls.rollback, 1);
  });
});

// HA-74: hosts from before release updates (no release block) show what they did: a checkout's rebuild and the board's
// code, or a plain restart.
test("older linked hosts show no release updates", async () => {
  await withBrowser(server, {}, async (ui) => {
    const remote = "a".repeat(40);
    let s = { source_dir: "/src", source_branch: "master", running_commit: remote };
    await linkedHost(ui.page, { api_version: 82, commit: remote }, () => s);
    await ui.run(["goto /hosts/rem", "wait Running aaaaaaa", "wait Builds from /src", "wait Rebuild & restart", "gone Check now", "gone Latest release"]);
    assert.equal(await ui.page.getByText(/^Update to [0-9a-f]{7}$/).count(), 1);
    s = {};
    await ui.run(["goto /hosts/rem", "wait Not running from a source checkout, so it can restart but not rebuild.", "gone Check now", "gone Update to v"]);
  });
});
