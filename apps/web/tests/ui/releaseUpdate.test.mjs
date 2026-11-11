import assert from "node:assert/strict"
import { afterAll, beforeAll, test } from "vite-plus/test"
import { makeProfile, startServer, withBrowser } from "./harness.mjs"
import { fakeAdmin, release as releaseOf } from "./servers.mjs"

// Release updates on Settings → Server and the sidebar (the old release-update check; docs/plan/09-frontend.md, Step 1
// as done for settings/): this server's `admin.status` and its release calls are answered by the test (servers.mjs), its
// restart events pushed on the board stream, so nothing reaches GitHub or restarts. The whole update, from a fake
// GitHub's release to the server running it, is apps/server/tests/e2e/releases.test.ts.

let server
beforeAll(async () => {
  server = startServer()
  // A profile, for the board and its sidebar.
  await makeProfile(server)
})
afterAll(() => server?.stop())

const PACKAGE = "https://github.com/dire-kiwi/huntaway/releases/download/v0.2.0/huntaway-0.2.0-linux-x64.pacman"

/** A server started by the pacman package with `--release-updates`, running 0.1.0 from `app/`, with 0.2.0 staged. */
const release = (over = {}) =>
  releaseOf({
    exe: "/home/me/.local/share/huntaway/app/0.1.0/huntaway",
    shell: { version: "0.1.0", install: "pacman", path: null, outdated: false, package: null },
    bundled_server: "/opt/Huntaway/resources/huntaway",
    ...over,
  })

/** The restart events the server would send, after any of its own (see `push` in servers.mjs). */
const restartEvents = (push) => {
  let seq = 1_000_000
  return (phase, error = null) => push({ type: "restart", phase, error, seq: ++seq })
}

// HA-67: a staged release is offered in the sidebar as "v0.2.0 · Update", and its modal shows the notes and restarts
// onto it through admin.updateRelease, following the restart's phases and reloading on the new server.
test("a staged release is offered in the sidebar, and Update restarts onto it", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    let restarted = false
    const { calls, push } = await fakeAdmin(page, "rpc", () =>
      restarted
        ? { boot_id: "after-update", running_agents: 2, release: release({ running: "0.2.0", staged: null, latest: { ...release().latest, newer: false } }) }
        : {
            running_agents: 2,
            release: release({ shell: { ...release().shell, outdated: true, package: { name: "p", url: PACKAGE, size: 1, sha256: null } } }),
          },
    )
    const restart = restartEvents(push)
    await ui.run([
      "goto /",
      "click v0.2.0 · Update",
      "wait Update Huntaway",
      "wait Release notes",
      "wait 2 agents are running",
      "wait The desktop app itself has an update too",
    ])
    const dialog = page.getByRole("dialog")
    // The notes are markdown, and link to the release.
    assert.equal(await dialog.locator(".prose-chat strong").textContent(), "Faster")
    assert.equal(await dialog.getByRole("link", { name: "On GitHub" }).getAttribute("href"), "https://github.com/dire-kiwi/huntaway/releases/tag/v0.2.0")
    assert.match(await dialog.textContent(), /v0\.1\.0→v0\.2\.0/)
    await page.evaluate(() => (window.__beforeUpdate = true))
    await dialog.getByRole("button", { name: "Update & restart" }).click()
    await ui.run(["wait Starting…"])
    assert.deepEqual(calls.update, [{ version: "0.2.0" }])
    restart("installing")
    await ui.run(["wait Installing the release…"])
    restarted = true
    restart("restarting")
    // A new boot id reloads the page, which runs 0.2.0 and has nothing to update to.
    await page.waitForFunction(() => !window.__beforeUpdate, null, { timeout: 10_000 })
    await ui.run(["wait Settings", "gone v0.2.0 · Update"])
  })
})

// HA-67: a background download needs no attention, so the sidebar shows nothing for it, nor for a failed one: Settings
// shows its progress or error, the check's errors (a rate limit), Check now and the prereleases toggle.
test("downloads and checks show in Settings → Server, not in the sidebar", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    let r = release({ staged: null, download: { version: "0.2.0", phase: "downloading", bytes: 12e6, total: 40e6, error: null } })
    const { calls } = await fakeAdmin(page, "rpc", () => ({ release: r }))
    await ui.run([
      "goto /settings/server",
      "wait Downloading v0.2.0 in the background: 12.0 MB of 40.0 MB",
      "wait /home/me/.local/share/huntaway/app/0.1.0/huntaway",
      "wait Started by the desktop app v0.1.0 (pacman package)",
      "gone No source checkout found",
      "gone v0.2.0 · Update",
    ])
    // Check now: the download failed, and so did the check, on GitHub's rate limit.
    r = release({
      staged: null,
      error: "GitHub's rate limit for this address ran out",
      rate_limit_reset: new Date(Date.now() + 1800_000).toISOString(),
      download: { version: "0.2.0", phase: "failed", bytes: 0, total: null, error: "sha256 mismatch" },
    })
    await ui.run(["click Check now", "wait Downloading v0.2.0 failed: sha256 mismatch. It's tried again on the next check.", "wait rate limit resets at"])
    assert.equal(calls.check, 1)
    assert.equal(await page.getByText("v0.2.0 · Update").count(), 0)
    // Include prereleases sets release_prereleases, and the switch follows the server's setting.
    const toggle = page.getByRole("switch", { name: "Include prereleases" })
    assert.equal(await toggle.getAttribute("aria-checked"), "false")
    r = { ...r, prereleases: true }
    await toggle.click()
    await page.waitForFunction(() => document.querySelector("[role=switch][aria-checked=true]"))
    assert.deepEqual(calls.settings, [{ release_prereleases: true }])
  })
})

// HA-67: Roll back asks first, warning that the newer version may have migrated the database; and a release that needs
// a new desktop app says how to install it.
test("Roll back asks first, and the app's own update shows its command", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    const shell = { version: "0.1.0", install: "pacman", path: null, outdated: true, package: { name: "p", url: PACKAGE, size: 1, sha256: null } }
    const r = release({ running: "0.2.0", staged: null, latest: { ...release().latest, newer: false }, previous: "0.1.1", rollback_to: "0.1.1", shell })
    const { calls } = await fakeAdmin(page, "rpc", () => ({ release: r }))
    await ui.run(["goto /settings/server", "wait The desktop app has an update", `wait sudo pacman -U ${PACKAGE}`, "click Copy the command", "wait Copied"])
    // HA-68 adds the app's own Install button, only where the desktop app's preload has updateShell.
    assert.equal(await page.getByRole("button", { name: "Install" }).count(), 0)
    await ui.run(["click Roll back to v0.1.1", "wait Roll back Huntaway", "wait v0.2.0 may have migrated the database"])
    const dialog = page.getByRole("dialog")
    // Nothing happens until it's confirmed.
    await dialog.getByRole("button", { name: "Close", exact: true }).last().click()
    await ui.run(["gone Roll back Huntaway"])
    assert.equal(calls.rollback, 0)
    await ui.run(["click Roll back to v0.1.1", "wait Roll back Huntaway"])
    await dialog.getByRole("button", { name: "Roll back to v0.1.1" }).click()
    await ui.run(["wait Starting…"])
    assert.equal(calls.rollback, 1)
  })
})

// HA-68: where the desktop app can install its own package (its preload's shellUpdateKind), the notice has a button that
// shows the update's progress, and its failure in place, keeping the command.
test("the desktop app's own Install shows its progress and its failure", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    await page.addInitScript(() => {
      window.__updates = []
      window.huntawayDesktop = {
        setBadgeCount() {},
        focus() {},
        shellUpdateKind: () => localStorage.getItem("test.shellKind") ?? "pacman",
        updateShell: (onProgress) =>
          new Promise((_resolve, reject) => {
            window.__updates.push(1)
            window.__progress = onProgress
            window.__fail = (m) => reject(new Error(m))
          }),
      }
    })
    const shell = { version: "0.1.0", install: "pacman", path: null, outdated: true, package: { name: "p", url: PACKAGE, size: 1, sha256: "ab" } }
    await fakeAdmin(page, "rpc", () => ({ release: release({ shell }) }))
    await ui.run(["goto /settings/server", "wait The desktop app has an update", "wait which the app can install itself", "wait Or install its package with"])
    const install = page.getByRole("button", { name: "Install", exact: true })
    await install.click()
    await ui.run(["wait Looking up the latest release…"])
    assert.ok(await install.isDisabled())
    await page.evaluate(() => window.__progress({ phase: "downloading", version: "0.2.0", bytes: 50e6, total: 100e6 }))
    await ui.run(["wait Downloading v0.2.0: 50.0 MB of 100.0 MB"])
    await page.evaluate(() => window.__progress({ phase: "installing", version: "0.2.0" }))
    await ui.run(["wait Installing v0.2.0: enter your password"])
    await page.evaluate(() => window.__fail("The password prompt was cancelled, so nothing was installed. Install it with the sudo pacman command instead."))
    await ui.run(["wait The password prompt was cancelled", "gone Installing v0.2.0", `wait sudo pacman -U ${PACKAGE}`])
    assert.ok(await install.isEnabled())
    assert.deepEqual(await page.evaluate(() => window.__updates), [1])
    // An app whose install isn't the one the server reports on (another app's server) gets the command only.
    await page.evaluate(() => localStorage.setItem("test.shellKind", "appimage"))
    await ui.run(["goto /settings/server", "wait The desktop app has an update"])
    assert.equal(await page.getByRole("button", { name: /^(Install|Update app)$/ }).count(), 0)
  })
})

// HA-67 review: the dialog showed the restart job the server had kept, failed or not, in place of its confirm. After a
// failed Update, Roll back showed that failure and "Try again", which then rolled back without the migration warning.
test("an earlier failed restart doesn't stand in for Update's or Roll back's confirm", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    const latest = { ...release().latest, version: "0.3.0", url: "https://github.com/dire-kiwi/huntaway/releases/tag/v0.3.0" }
    const r = release({ running: "0.2.0", staged: "0.3.0", latest, previous: "0.1.0", rollback_to: "0.1.0" })
    // A failed update from before the page loaded, as the server keeps it.
    const { calls, push } = await fakeAdmin(page, "rpc", () => ({
      release: r,
      restart: { phase: "failed", log: "Downloading 0.3.0", error: "the old failure" },
    }))
    const restart = restartEvents(push)
    const dialog = page.getByRole("dialog")
    await ui.run(["goto /settings/server", "click Update to v0.3.0", "wait Release notes", "gone the old failure", "gone Restart failed"])
    // This dialog's own failure shows in it.
    await dialog.getByRole("button", { name: "Update & restart" }).click()
    await ui.run(["wait Starting…"])
    restart("failed", "sha256 mismatch")
    await ui.run(["wait Restart failed", "wait sha256 mismatch", "wait The server is still running v0.2.0."])
    await dialog.getByRole("button", { name: "Close", exact: true }).last().click()
    await ui.run(["gone Update Huntaway"])
    // Roll back still asks, with its warning, and isn't a retry of the update.
    await ui.run([
      "click Roll back to v0.1.0",
      "wait Roll back Huntaway",
      "wait v0.2.0 may have migrated the database",
      "gone sha256 mismatch",
      "gone Try again",
    ])
    await dialog.getByRole("button", { name: "Roll back to v0.1.0" }).click()
    await ui.run(["wait Starting…"])
    assert.deepEqual([calls.update, calls.rollback], [[{ version: "0.3.0" }], 1])
  })
})

// HA-67 review: hiding failures from before the dialog opened hid the failure of a restart it was showing too (one
// begun before a reload, or in another tab). Those show, and their button goes back to the dialog's own confirm.
test("a restart the dialog is showing still shows its failure, and doesn't skip Roll back's confirm", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    const latest = { ...release().latest, version: "0.3.0", url: "https://github.com/dire-kiwi/huntaway/releases/tag/v0.3.0" }
    const r = release({ running: "0.2.0", staged: "0.3.0", latest, previous: "0.1.0", rollback_to: "0.1.0" })
    // An update under way when the page loads.
    const { calls, push } = await fakeAdmin(page, "rpc", () => ({ release: r, restart: { phase: "installing", log: "Downloading 0.3.0", error: null } }))
    const restart = restartEvents(push)
    const dialog = page.getByRole("dialog")
    await ui.run(["goto /settings/server", "click Update to v0.3.0", "wait Installing the release…"])
    restart("failed", "sha256 mismatch")
    await ui.run(["wait Restart failed", "wait sha256 mismatch", "wait The server is still running v0.2.0.", "gone Release notes"])
    // Its button shows this dialog's confirm rather than retrying.
    await dialog.getByRole("button", { name: "Update & restart…" }).click()
    await ui.run(["wait Release notes", "gone sha256 mismatch"])
    await dialog.getByRole("button", { name: "Close", exact: true }).last().click()
    // Roll back opens on its confirm; a restart begun elsewhere meanwhile shows, and so does its failure.
    await ui.run(["click Roll back to v0.1.0", "wait v0.2.0 may have migrated the database"])
    restart("starting")
    await ui.run(["wait Starting…", "gone v0.2.0 may have migrated the database"])
    restart("failed", "exec failed: Permission denied")
    await ui.run(["wait exec failed: Permission denied", "gone Try again"])
    await dialog.getByRole("button", { name: "Roll back to v0.1.0…" }).click()
    await ui.run(["wait v0.2.0 may have migrated the database", "gone exec failed"])
    assert.equal(calls.rollback, 0)
    await dialog.getByRole("button", { name: "Roll back to v0.1.0", exact: true }).click()
    await ui.run(["wait Starting…"])
    assert.deepEqual([calls.update, calls.rollback], [[], 1])
  })
})
