import assert from "node:assert/strict"
import { afterAll, beforeAll, test } from "vite-plus/test"
import { eventually, makeProfile, startServer, withBrowser } from "./harness.mjs"
import { fakeAdmin, release } from "./servers.mjs"

// A linked host's Server on its page (the old hostRelease check; docs/plan/09-frontend.md, Step 1 as done for
// settings/): two test servers, the second linked from the first, and the linked host's `admin.*` answered by the test
// on the hub's relay to it (servers.mjs), so nothing restarts or reaches GitHub.

let hub, host, hostId
beforeAll(async () => {
  hub = startServer()
  host = startServer()
  await makeProfile(hub)
  hostId = (await host.rpc("host.info")).host_id
  await hub.rpc("hub.hosts.add", { url: host.url, token: host.token })
  await eventually(async () => assert.ok((await hub.rpc("hub.hosts.list")).find((h) => h.id === hostId)?.connected), 20000)
})
afterAll(() => {
  hub?.stop()
  host?.stop()
})

/** The linked host as the hub lists it, with `over` (its commit, version…), on the page's sockets. */
const linkedAs = (over) => (tag, value, via) =>
  via === "rpc" && tag === "hub.hosts.watch" ? value.map((h) => (h.id === hostId ? { ...h, ...over() } : h)) : value

// HA-74: a linked host with release updates shows its version, the latest release and Update on its page, and Update
// restarts it onto the staged release through the hub, the page following the restart's phases until it's back.
test("a linked host's page offers its staged release, and follows the Update", async () => {
  await withBrowser(hub, {}, async (ui) => {
    const { page } = ui
    let s = { release: release() }
    const { calls } = await fakeAdmin(page, "relay", () => s)
    await ui.run([
      `goto /hosts/${hostId}`,
      "wait Running v0.1.0",
      "wait /srv/huntaway/app/0.1.0/huntaway",
      "wait Latest release on dire-kiwi/huntaway",
      "wait v0.2.0 is downloaded and checked",
      "gone Not running from a source checkout",
    ])
    await ui.run([
      "click Update to v0.2.0",
      "wait Update Huntaway",
      "wait Release notes",
      "wait this page follows it until it's back",
      "wait 1 agent is running",
    ])
    const dialog = page.getByRole("dialog")
    assert.match(await dialog.textContent(), /v0\.1\.0→v0\.2\.0/)
    await dialog.getByRole("button", { name: "Update & restart" }).click()
    await ui.run(["gone Update Huntaway"])
    assert.deepEqual(calls.update, [{ version: "0.2.0" }])
    // The host's phases while it restarts (polled every 1.5 s), then its new boot on 0.2.0.
    s = { release: release(), restart: { phase: "installing", log: "Unpacking it", error: null } }
    await ui.run(["wait Installing the release…"])
    s = {
      boot_id: "b2",
      release: release({ running: "0.2.0", staged: null, latest: { ...release().latest, newer: false }, previous: "0.1.0", rollback_to: "0.1.0" }),
    }
    await ui.run(["gone Installing the release…", "wait Running v0.2.0", "wait which this server runs", "gone Update to v0.2.0"])
  })
})

// HA-74: Check now, the prereleases toggle and Roll back go to the linked host, a download shows its progress, and a
// new desktop app on that host says how to install it, without this app's own Install.
test("a linked host's release checks, download and Roll back go through the hub", async () => {
  await withBrowser(hub, {}, async (ui) => {
    const { page } = ui
    await page.addInitScript(() => {
      window.huntawayDesktop = {
        setBadgeCount() {},
        focus() {},
        shellUpdateKind: () => "pacman",
        updateShell: () => Promise.reject(new Error("not this app")),
      }
    })
    const pkg = { name: "p", url: "https://example.invalid/huntaway-0.3.0-linux-x64.pacman", size: 1, sha256: "ab" }
    const shell = { version: "0.2.0", install: "pacman", path: null, outdated: true, package: pkg }
    const latest = { ...release().latest, version: "0.3.0", url: "https://github.com/dire-kiwi/huntaway/releases/tag/v0.3.0" }
    let r = release({
      running: "0.2.0",
      staged: null,
      latest,
      previous: "0.1.0",
      rollback_to: "0.1.0",
      shell,
      download: { version: "0.3.0", phase: "downloading", bytes: 10e6, total: 40e6, error: null },
    })
    // A host newer than this board, installed from a release: the board's code isn't offered to it.
    const { calls } = await fakeAdmin(page, "relay", () => ({ release: r }), {
      rewrite: linkedAs(() => ({ version: "0.2.0", commit: null, updates_from: "releases" })),
    })
    await ui.run([
      `goto /hosts/${hostId}`,
      "wait Downloading v0.3.0 in the background: 10.0 MB of 40.0 MB",
      "wait The desktop app on this host has an update",
      "wait that host's app installs from its own Settings → Server",
      `wait sudo pacman -U ${pkg.url}`,
    ])
    assert.equal(await page.getByRole("button", { name: /^(Install|Update app)$/ }).count(), 0)
    assert.equal(await page.getByText(/^Update to [0-9a-f]{7}$/).count(), 0)
    r = { ...r, download: null, staged: "0.3.0" }
    await ui.run(["click Check now", "wait Update to v0.3.0", "gone Downloading v0.3.0"])
    assert.equal(calls.check, 1)
    r = { ...r, prereleases: true }
    await page.getByRole("switch", { name: "Include prereleases" }).click()
    await page.waitForFunction(() => document.querySelector("[role=switch][aria-checked=true]"))
    assert.deepEqual(calls.settings, [{ release_prereleases: true }])
    await ui.run([
      "click Roll back to v0.1.0",
      "wait Roll back Huntaway",
      "wait v0.2.0 may have migrated the database",
      "wait This page follows it until it's back",
    ])
    await page.getByRole("dialog").getByRole("button", { name: "Roll back to v0.1.0" }).click()
    await ui.run(["gone Roll back Huntaway"])
    assert.equal(calls.rollback, 1)
  })
})

// HA-74: hosts without release updates (no release block) show what they did: a checkout's rebuild and the board's
// code, or a plain restart.
test("linked hosts without release updates show a rebuild or a restart", async () => {
  const remote = "a".repeat(40)
  await withBrowser(hub, {}, async (ui) => {
    let s = { source_dir: "/src", source_branch: "master", running_commit: remote }
    await fakeAdmin(ui.page, "relay", () => s, { rewrite: linkedAs(() => ({ commit: remote })) })
    await ui.run([
      `goto /hosts/${hostId}`,
      "wait Running v0.1.0 at aaaaaaa",
      "wait Builds from /src",
      "wait Rebuild & restart",
      "gone Check now",
      "gone Latest release",
    ])
    // The board's code, which differs from the host's.
    assert.equal(await ui.page.getByText(/^Update to [0-9a-f]{7}$/).count(), 1)
    s = {}
    await ui.run([`goto /hosts/${hostId}`, "wait Not running from a source checkout, so it can restart but not rebuild.", "gone Check now", "gone Update to v"])
  })
})
