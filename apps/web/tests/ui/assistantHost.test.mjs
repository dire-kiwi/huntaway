// A profile's assistant on a host of its own (the old assistantHost check, HA-120, HA-255; plan task 7.4): the board's
// host's profile names a linked host for its assistant (`assistant_host`), and the board opens it there, whatever that
// host's own profile says; the routines left on the board's host are listed under the assistant host's, with a Delete.
//
// Changed: the old check linked the two servers and set the profiles with the REST API; this does with `hub.hosts.add`,
// `hub.hosts.update` and `profiles.update`. A profile "Default" is made on each (the old servers had one from the start).
import assert from "node:assert/strict"
import { afterAll, beforeAll, test } from "vite-plus/test"
import { eventually, makeProfile, startServer, withBrowser } from "./harness.mjs"

let hub, home, mine, theirs
beforeAll(async () => {
  hub = startServer()
  home = startServer()
  mine = await makeProfile(hub)
  theirs = await makeProfile(home)
})
afterAll(() => {
  hub?.stop()
  home?.stop()
})

/** Link `to` on `from`'s board by URL, under `name`, once it's connected. Returns its host id. */
async function link(from, to, name) {
  const { id } = await from.rpc("hub.hosts.add", { url: to.url, token: to.token })
  await from.rpc("hub.hosts.update", { id, name })
  await eventually(
    async () =>
      assert.ok(
        (await from.rpc("hub.hosts.list")).some((h) => h.id === id && h.connected),
        `${name} didn't connect`,
      ),
    15_000,
  )
  return id
}

const assistants = async (server, profile) =>
  (await server.rpc("tasks.list", { filter: { _tag: "ByProfile", profile_id: profile.id, include_assistant: true } })).filter(
    (t) => t.task_type === "assistant",
  )

const routine = (name, expr) => ({ name, trigger: { kind: "cron", expr }, action: { kind: "message_assistant", message: "Anything new?" } })

const openAssistant = ["goto /profile/Default", "click css=nav[aria-label=Assistant] >> text=Assistant", "wait Message your assistant"]

// HA-120 review: the sidebar asked the assistant host for its profile's assistant as any client would, so a host whose
// own profile named another assistant host (here, back to the board's) sent it on, and the assistant was made on the
// board's host.
test("the sidebar opens the assistant on the profile's assistant host, whatever that host's profile says", async () => {
  const homeId = await link(hub, home, "homeserver")
  const hubId = await link(home, hub, "desktop")
  await hub.rpc("profiles.update", { id: mine.id, patch: { assistant_host: homeId } })
  await home.rpc("profiles.update", { id: theirs.id, patch: { assistant_host: hubId } })
  await withBrowser(hub, {}, async (ui) => {
    await ui.run([...openAssistant, "wait Working on"])
    // Made on homeserver rather than on the board's own host.
    assert.equal((await assistants(home, theirs)).length, 1)
    assert.equal((await assistants(hub, mine)).length, 0)
    // Settings says where it runs.
    await ui.run(["goto /settings/assistant", "wait Default's assistant"])
    assert.match(await ui.page.getByRole("group", { name: "Default's assistant" }).innerText(), /Default · on homeserver/)
  })
})

// HA-255: routines the board's own host keeps for a profile whose assistant moved to another host don't run there, and
// the assistant's Routines tab (on the assistant host) lists them under its own, each with a Delete for the board's host.
test("the routines left on the board's host are listed under the assistant host's, and can be deleted there", async () => {
  // The test before may have linked it, and sent home's assistant back to the hub.
  const homeId = (await hub.rpc("hub.hosts.list")).find((h) => h.name === "homeserver")?.id ?? (await link(hub, home, "homeserver"))
  await home.rpc("profiles.update", { id: theirs.id, patch: { assistant_host: null } })
  // Made on the board's host while the assistant ran there.
  await hub.rpc("profiles.update", { id: mine.id, patch: { assistant_host: null } })
  await hub.rpc("automations.create", { profile_id: mine.id, automation: routine("Old inbox", "0 8 * * mon-fri") })
  await hub.rpc("profiles.update", { id: mine.id, patch: { assistant_host: homeId } })
  await home.rpc("automations.create", { profile_id: theirs.id, automation: routine("New inbox", "0 9 * * *") })
  const hubName = (await hub.rpc("host.info")).host_name
  await withBrowser(hub, {}, async (ui) => {
    const { page } = ui
    await ui.run([
      ...openAssistant,
      "click routines",
      "wait css=[data-testid=routine] >> text=New inbox",
      "wait css=[data-testid=routine-left-behind] >> text=Old inbox",
    ])
    const box = page.getByTestId("routines-left-behind")
    assert.match(
      await box.innerText(),
      new RegExp(`This routine stays on ${hubName}, where your assistant ran before, and doesn't run while it's on homeserver`),
    )
    // The assistant host's own routine isn't listed as left behind, nor the other way round.
    assert.equal(await box.getByText("New inbox").count(), 0)
    assert.equal(await page.getByTestId("routine").filter({ hasText: "Old inbox" }).count(), 0)
    await box.getByTitle(`Delete it on ${hubName}`).click()
    await ui.run(["wait Its run history goes with it", "click role=button[name='Delete routine']", "gone css=[data-testid=routines-left-behind]"])
    await ui.run(["wait css=[data-testid=routine] >> text=New inbox"])
  })
  // Deleted on the board's host; the assistant host's own is still there.
  assert.deepEqual((await hub.rpc("automations.list", { profile_id: mine.id })).automations, [])
  assert.deepEqual(
    (await home.rpc("automations.list", { profile_id: theirs.id })).automations.map((a) => a.name),
    ["New inbox"],
  )
})
