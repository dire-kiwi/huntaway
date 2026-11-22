import assert from "node:assert/strict"
import { afterAll, beforeAll, test } from "vite-plus/test"
import { eventually, makeProfile, startServer, success, withBrowser } from "./harness.mjs"
import { routeSockets, serverStatus } from "./servers.mjs"

// A linked host's Update on Settings → Hosts (the old hostUpdate check): two test servers, the second linked from the
// first. What the hub says of the hosts (their commits and versions) is rewritten on the page's socket, the hub's
// `hub.hosts.pushUpdate` and both hosts' `admin.status` are answered by the test (servers.mjs), so nothing is sent or
// restarts.

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

/**
 * The board's own host runs `local` (`host.info`'s commit and version) and has the checkout `checkout` (its
 * `admin.status`); the linked host is `linked()` as the hub lists it and answers `admin.status` with `remote()`.
 * `hub.hosts.pushUpdate` calls are counted.
 */
async function hosts(page, { local, checkout, linked, remote }) {
  const calls = { updates: 0 }
  await routeSockets(page, {
    rewrite: (tag, value, via) => {
      if (via !== "rpc") return value
      if (tag === "host.info") return { ...value, ...local }
      if (tag === "hub.hosts.watch") return value.map((h) => (h.id === hostId ? { ...h, ...linked() } : h))
      return value
    },
    handle: (r, via) => {
      if (r.tag === "hub.hosts.pushUpdate") {
        calls.updates++
        return success({ ok: true })
      }
      if (r.tag !== "admin.status") return undefined
      return success(via === "relay" ? remote(calls) : serverStatus({ source_dir: "/src", running_commit: local.commit ?? null, ...checkout }))
    },
  })
  return calls
}

// HA-38: an Update sends a host the hub's checkout, and the phase ended only when the host came back on the commit the
// hub runs. With the checkout ahead of it (or a host that came back on its old commit), the row said "building server…"
// for good, as the restart's state is gone with the old server, and the Update button stayed hidden.
test("a host's Update ends when it restarts, and offers the hub's checkout", async () => {
  const [running, checkout, remote] = ["c", "b", "a"].map((c) => c.repeat(40))
  await withBrowser(hub, {}, async (ui) => {
    let polls = 0
    const calls = await hosts(ui.page, {
      local: { commit: running },
      checkout: { source_commit: checkout },
      linked: () => ({ commit: remote, updates_from: "checkout" }),
      remote: ({ updates }) => {
        // Two polls while it builds, then a new boot, still on its old commit, with no restart under way.
        if (updates) polls++
        const restart = updates && polls <= 2 ? { phase: "building_server", log: "", error: null } : null
        return serverStatus({ boot_id: polls > 2 ? "b2" : "b1", source_dir: "/src", running_commit: remote, running_agents: 0, restart })
      },
    })
    await ui.run(["goto /settings/hosts", "click Update to bbbbbbb", "wait building server", "wait Update to bbbbbbb", "gone building server"])
    assert.equal(calls.updates, 1)
  })
})

// HA-76: a host installed from a release has no commit, so it was never offered an Update. It goes by version: Update
// to the release the hub runs, only when that's newer, and it ends when the host comes back on it.
test("a release host is offered the hub's version; a newer one, and a checkout host without a commit, aren't", async () => {
  const own = (await hub.rpc("host.info")).version
  await withBrowser(hub, {}, async (ui) => {
    const { page } = ui
    let linked = { version: "0.0.9", commit: null, updates_from: "releases" }
    let boot = "b1"
    const calls = await hosts(page, {
      local: {},
      checkout: {},
      linked: () => linked,
      remote: ({ updates }) => serverStatus({ boot_id: boot, running_agents: 0, restart: updates ? { phase: "downloading", log: "", error: null } : null }),
    })
    await ui.run(["goto /settings/hosts", `wait Update to v${own}`])
    const button = page.locator("button", { hasText: `Update to v${own}` })
    assert.match(await button.getAttribute("title"), /downloads this release/)
    await ui.run([`click Update to v${own}`, "wait downloading"])
    assert.equal(calls.updates, 1)
    // Back, on the hub's version.
    ;[linked, boot] = [{ ...linked, version: own }, "b2"]
    await ui.run(["gone downloading"])
    await page.reload()
    await ui.run([`wait [data-host="${hostId}"] >> text=/^v${own}/`])
    assert.equal(await page.locator("button", { hasText: "Update to" }).count(), 0)
    // Newer than the hub: nothing to update to.
    linked = { version: "99.0.0", commit: null, updates_from: "releases" }
    await page.reload()
    await ui.run([`wait [data-host="${hostId}"] >> text=/^v99\\.0\\.0/`])
    assert.equal(await page.locator("button", { hasText: "Update to" }).count(), 0)
    // A checkout that doesn't say which commit it runs: nothing to compare with.
    linked = { version: "0.0.9", commit: null, updates_from: "checkout" }
    await page.reload()
    await ui.run([`wait [data-host="${hostId}"] >> text=/^v0\\.0\\.9/`])
    assert.equal(await page.locator("button", { hasText: "Update to" }).count(), 0)
  })
})

// HE-76: Update on one host updates the whole cluster: every other linked host that differs from the hub is sent the
// update too, and each row follows its own; one that is already on the hub's commit isn't.
test("Update on one host updates every host that differs", async () => {
  const [running, remote] = ["c", "a"].map((c) => c.repeat(40))
  const third = startServer()
  const fourth = startServer()
  try {
    const ids = await Promise.all([third, fourth].map(async (s) => (await s.rpc("host.info")).host_id))
    for (const s of [third, fourth]) await hub.rpc("hub.hosts.add", { url: s.url, token: s.token })
    await eventually(async () => {
      const listed = await hub.rpc("hub.hosts.list")
      assert.ok(ids.every((id) => listed.find((h) => h.id === id)?.connected))
    }, 20000)
    const [differs, same] = ids
    await withBrowser(hub, {}, async (ui) => {
      const pushed = []
      await routeSockets(ui.page, {
        rewrite: (tag, value, via) => {
          if (via !== "rpc") return value
          if (tag === "host.info") return { ...value, commit: running }
          if (tag === "hub.hosts.watch")
            return value.map((h) =>
              h.id === hostId || h.id === differs
                ? { ...h, commit: remote, updates_from: "checkout" }
                : h.id === same
                  ? { ...h, commit: running, updates_from: "checkout" }
                  : h,
            )
          return value
        },
        handle: (r, via) => {
          if (r.tag === "hub.hosts.pushUpdate") {
            pushed.push(r.payload.id)
            return success({ ok: true })
          }
          if (r.tag !== "admin.status") return undefined
          if (via === "rpc") return success(serverStatus({ running_commit: running }))
          // Each linked host builds, for as long as the test looks.
          return success(
            serverStatus({
              boot_id: "b1",
              source_dir: "/src",
              running_commit: remote,
              running_agents: 0,
              restart: pushed.length ? { phase: "building_server", log: "", error: null } : null,
            }),
          )
        },
      })
      await ui.run(["goto /settings/hosts", `wait [data-host="${hostId}"] >> text=Update to ccccccc · all 2 hosts`])
      assert.equal(await ui.page.locator(`[data-host="${same}"] button`, { hasText: "Update to" }).count(), 0)
      await ui.run([
        `click [data-host="${hostId}"] >> text=Update to ccccccc`,
        `wait [data-host="${hostId}"] >> text=building server`,
        `wait [data-host="${differs}"] >> text=building server`,
      ])
      assert.deepEqual(new Set(pushed), new Set([hostId, differs]))
      assert.equal(pushed.length, 2)
      assert.equal(await ui.page.locator(`[data-host="${same}"]`, { hasText: "building server" }).count(), 0)
    })
  } finally {
    third.stop()
    fourth.stop()
  }
})
