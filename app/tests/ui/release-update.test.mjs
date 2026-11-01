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
const PACKAGE = "https://github.com/dire-kiwi/huntaway/releases/download/v0.2.0/huntaway-0.2.0-linux-x64.pacman";

/** A server started by the pacman package with `--release-updates`, running 0.1.0 from `app/`, with 0.2.0 staged. */
function release(over = {}) {
  return {
    repo: "dire-kiwi/huntaway",
    running: "0.1.0",
    exe: "/home/me/.local/share/huntaway/app/0.1.0/huntaway",
    latest: {
      version: "0.2.0",
      prerelease: false,
      published_at: ago(86400 * 2),
      notes: "## What's new\n\n- **Faster** boards\n- Release updates",
      url: "https://github.com/dire-kiwi/huntaway/releases/tag/v0.2.0",
      asset: { name: "huntaway-server-0.2.0-linux-x64.tar.gz", url: "https://example.invalid/s.tar.gz", size: 40e6, sha256: "ab" },
      newer: true,
    },
    prereleases: false,
    checked_at: ago(300),
    error: null,
    rate_limit_reset: null,
    shell: { version: "0.1.0", install: "pacman", path: null, outdated: false, package: null },
    bundled_server: "/opt/Huntaway/resources/huntaway",
    staged: "0.2.0",
    download: null,
    previous: null,
    bad: [],
    rollback_to: "bundled",
    ...over,
  };
}

/**
 * Serves `state()` as `GET /admin/server`'s release block (and boot id and running agents), and answers the release
 * endpoints and `PATCH /settings`, recording what they were sent.
 */
async function fakeReleases(page, state) {
  const calls = { check: 0, update: [], rollback: 0, settings: [] };
  await page.route("**/api/h/**", async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const status = async () => {
      const s = state();
      return { ...(await (await route.fetch({ url: req.url().replace(/\/admin\/release\/check$/, "/admin/server"), method: "GET" })).json()), ...s };
    };
    if (path.endsWith("/admin/server")) return json(route, await status());
    if (path.endsWith("/admin/release/check")) {
      calls.check++;
      return json(route, await status());
    }
    if (path.endsWith("/admin/release/update")) {
      calls.update.push(req.postDataJSON());
      return json(route, { ok: true });
    }
    if (path.endsWith("/admin/release/rollback")) {
      calls.rollback++;
      return json(route, { ok: true });
    }
    if (path.endsWith("/settings") && req.method() === "PATCH") {
      calls.settings.push(req.postDataJSON());
      return json(route, req.postDataJSON());
    }
    return route.fallback();
  });
  return calls;
}

// HA-67: a staged release is offered in the sidebar as "v0.2.0 · Update", and its modal shows the notes and restarts
// onto it through POST /admin/release/update, following the restart's phases and reloading on the new server.
test("a staged release is offered in the sidebar, and Update restarts onto it", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    let restarted = false;
    const calls = await fakeReleases(page, () =>
      restarted
        ? { boot_id: "after-update", running_agents: 2, release: release({ running: "0.2.0", staged: null, latest: { ...release().latest, newer: false } }) }
        : { running_agents: 2, release: release({ shell: { ...release().shell, outdated: true, package: { name: "p", url: PACKAGE, size: 1, sha256: null } } }) },
    );
    let socket;
    await page.routeWebSocket(/\/api\/ws/, (ws) => {
      socket = ws;
      ws.connectToServer();
    });
    await ui.run(["goto /", "click v0.2.0 · Update", "wait Update Huntaway", "wait Release notes", "wait 2 agents are running", "wait The desktop app itself has an update too"]);
    const dialog = page.getByRole("dialog");
    // The notes are markdown, and link to the release.
    assert.equal(await dialog.locator(".prose-chat strong").textContent(), "Faster");
    assert.equal(await dialog.getByRole("link", { name: "On GitHub" }).getAttribute("href"), "https://github.com/dire-kiwi/huntaway/releases/tag/v0.2.0");
    assert.match(await dialog.textContent(), /v0\.1\.0→v0\.2\.0/);
    await page.evaluate(() => (window.__beforeUpdate = true));
    await dialog.getByRole("button", { name: "Update & restart" }).click();
    await ui.run(["wait Starting…"]);
    assert.deepEqual(calls.update, [{ version: "0.2.0" }]);
    socket.send(JSON.stringify({ type: "restart", phase: "installing", error: null }));
    await ui.run(["wait Installing the release…"]);
    restarted = true;
    socket.send(JSON.stringify({ type: "restart", phase: "restarting", error: null }));
    // A new boot id reloads the page, which runs 0.2.0 and has nothing to update to.
    await page.waitForFunction(() => !window.__beforeUpdate, null, { timeout: 10_000 });
    await ui.run(["wait Settings", "sleep 500", "gone v0.2.0 · Update"]);
  });
});

// HA-67: a background download needs no attention, so the sidebar shows nothing for it, nor for a failed one: Settings
// shows its progress or error, the check's errors (a rate limit), Check now and the prereleases toggle.
test("downloads and checks show in Settings → Server, not in the sidebar", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    let r = release({ staged: null, download: { version: "0.2.0", phase: "downloading", bytes: 12e6, total: 40e6, error: null } });
    const calls = await fakeReleases(page, () => ({ release: r }));
    await ui.run([
      "goto /settings",
      "wait Downloading v0.2.0 in the background: 12.0 MB of 40.0 MB",
      "wait /home/me/.local/share/huntaway/app/0.1.0/huntaway",
      "wait Started by the desktop app v0.1.0 (pacman package)",
      "gone No source checkout found",
      "gone v0.2.0 · Update",
    ]);
    // Check now: the download failed, and so did the check, on GitHub's rate limit.
    r = release({
      staged: null,
      error: "GitHub's rate limit for this address ran out",
      rate_limit_reset: new Date(Date.now() + 1800_000).toISOString(),
      download: { version: "0.2.0", phase: "failed", bytes: 0, total: null, error: "sha256 mismatch" },
    });
    await ui.run(["click Check now", "wait Downloading v0.2.0 failed: sha256 mismatch. It's tried again on the next check.", "wait rate limit resets at"]);
    assert.equal(calls.check, 1);
    assert.equal(await page.getByText("v0.2.0 · Update").count(), 0);
    // Include prereleases sets release_prereleases, and the switch follows the server's setting.
    const toggle = page.getByRole("switch", { name: "Include prereleases" });
    assert.equal(await toggle.getAttribute("aria-checked"), "false");
    r = { ...r, prereleases: true };
    await toggle.click();
    await page.waitForFunction(() => document.querySelector("[role=switch][aria-checked=true]"));
    assert.deepEqual(calls.settings, [{ release_prereleases: true }]);
  });
});

// HA-67: Roll back asks first, warning that the newer version may have migrated the database; and a release that needs
// a new desktop app says how to install it.
test("Roll back asks first, and the app's own update shows its command", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    const shell = { version: "0.1.0", install: "pacman", path: null, outdated: true, package: { name: "p", url: PACKAGE, size: 1, sha256: null } };
    const r = release({ running: "0.2.0", staged: null, latest: { ...release().latest, newer: false }, previous: "0.1.1", rollback_to: "0.1.1", shell });
    const calls = await fakeReleases(page, () => ({ release: r }));
    await ui.run(["goto /settings", "wait The desktop app has an update", `wait sudo pacman -U ${PACKAGE}`, "click Copy the command", "wait Copied"]);
    // HA-68 adds the app's own Install button, only where the desktop app's preload has updateShell.
    assert.equal(await page.getByRole("button", { name: "Install" }).count(), 0);
    await ui.run(["click Roll back to v0.1.1", "wait Roll back Huntaway", "wait v0.2.0 may have migrated the database"]);
    const dialog = page.getByRole("dialog");
    // Nothing happens until it's confirmed.
    await dialog.getByRole("button", { name: "Close", exact: true }).last().click();
    await ui.run(["gone Roll back Huntaway"]);
    assert.equal(calls.rollback, 0);
    await ui.run(["click Roll back to v0.1.1", "wait Roll back Huntaway"]);
    await dialog.getByRole("button", { name: "Roll back to v0.1.1" }).click();
    await ui.run(["wait Starting…"]);
    assert.equal(calls.rollback, 1);
  });
});

// HA-67 review: the dialog showed the restart job the server had kept, failed or not, in place of its confirm. After a
// failed Update, Roll back showed that failure and "Try again", which then rolled back without the migration warning.
test("an earlier failed restart doesn't stand in for Update's or Roll back's confirm", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    const latest = { ...release().latest, version: "0.3.0", url: "https://github.com/dire-kiwi/huntaway/releases/tag/v0.3.0" };
    const r = release({ running: "0.2.0", staged: "0.3.0", latest, previous: "0.1.0", rollback_to: "0.1.0" });
    // A failed update from before the page loaded, as the server keeps it.
    const calls = await fakeReleases(page, () => ({ release: r, restart: { phase: "failed", log: "Downloading 0.3.0", error: "the old failure" } }));
    let socket;
    await page.routeWebSocket(/\/api\/ws/, (ws) => {
      socket = ws;
      ws.connectToServer();
    });
    const dialog = page.getByRole("dialog");
    await ui.run(["goto /settings", "click Update to v0.3.0", "wait Release notes", "gone the old failure", "gone Restart failed"]);
    // This dialog's own failure shows in it.
    await dialog.getByRole("button", { name: "Update & restart" }).click();
    await ui.run(["wait Starting…"]);
    socket.send(JSON.stringify({ type: "restart", phase: "failed", error: "sha256 mismatch" }));
    await ui.run(["wait Restart failed", "wait sha256 mismatch", "wait The server is still running v0.2.0."]);
    await dialog.getByRole("button", { name: "Close", exact: true }).last().click();
    await ui.run(["gone Update Huntaway"]);
    // Roll back still asks, with its warning, and isn't a retry of the update.
    await ui.run(["click Roll back to v0.1.0", "wait Roll back Huntaway", "wait v0.2.0 may have migrated the database", "gone sha256 mismatch", "gone Try again"]);
    await dialog.getByRole("button", { name: "Roll back to v0.1.0" }).click();
    await ui.run(["wait Starting…"]);
    assert.deepEqual([calls.update, calls.rollback], [[{ version: "0.3.0" }], 1]);
  });
});
