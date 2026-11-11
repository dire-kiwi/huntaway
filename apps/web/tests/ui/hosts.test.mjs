import assert from "node:assert/strict"
import { afterAll, beforeAll, test } from "vite-plus/test"
import { eventually, makeProject, makeTask, seedBoard, startServer, withBrowser } from "./harness.mjs"

// Settings → Hosts and one board across two hosts (docs/plan/08-hosts.md; inventory 05 §2.2a, 10 §2.7): the hub links
// another test server by its URL and token, its projects and tasks show beside the hub's (through the hub's relay), a
// task of it opens and moves, it keeps its board marked offline while it is away, and forgetting it takes it off.

let hub, host, hubBoard, remote, remoteTask
beforeAll(async () => {
  hub = startServer()
  host = startServer()
  hubBoard = await seedBoard(hub, [{ title: "A task on the hub", status: "todo" }])
  // The same profile name on both: a profile is every host's profile of that name.
  const profile = await host.rpc("profiles.create", { profile: { name: "Default" } })
  remote = await makeProject(host, profile, "Remote", "REM")
  remoteTask = await makeTask(host, remote, { title: "A task on the linked host", status: "todo" })
})
afterAll(() => {
  hub?.stop()
  host?.stop()
})

const hostRow = (id) => `[data-host="${id}"]`
const remoteRow = "css=aside >> role=button[name=/^REM Remote/]"

test("the Hosts page lists this host and offers to link one, by URL and token or from elsewhere", async () => {
  await withBrowser(hub, {}, async (ui) => {
    const { page } = ui
    const own = await hub.rpc("host.info")
    await ui.run(["goto /settings", `wait ${hostRow(own.host_id)}`, "wait this host", `wait v${own.version}`, "wait No other hosts found"])
    assert.equal(await page.locator("[data-host]").count(), 1)
    // A wrong token is turned down, with why, and the dialog stays.
    await ui.run([
      "click Add host",
      "click By URL and token",
      "click css=input[placeholder='http://buildbox:7879']",
      "press Control+a",
      `type ${host.url}`,
      "click css=input[type=password]",
      "type not-the-token",
      "click role=button[name='Add host'] >> nth=-1",
      "wait css=[data-modal] .text-red-400",
    ])
    assert.match(await page.locator("[data-modal] .text-red-400").innerText(), /^token: .* refused the token$/)
    await ui.run(["press Escape", "gone By URL and token"])
    assert.equal((await hub.rpc("hub.hosts.list")).length, 1)
    // Connect from elsewhere: the command a host dials in with, built from where this browser reaches the hub.
    await ui.run(["click Connect from elsewhere", "wait A host that can't be reached directly"])
    await eventually(async () =>
      assert.match(await page.locator("[data-modal] input").first().inputValue(), new RegExp(new URL(hub.url).host.replace(".", "\\."))),
    )
  })
})

test("a host linked in Settings shows its projects and tasks on the board; its task opens and moves; it stays while away; forgetting it takes it off", async () => {
  const linked = await host.rpc("host.info")
  await withBrowser(hub, {}, async (ui) => {
    await ui.run([
      "goto /settings/hosts",
      "click Add host",
      "click By URL and token",
      "click css=input[placeholder='http://buildbox:7879']",
      "press Control+a",
      `type ${host.url}`,
      "click css=input[type=password]",
      `type ${host.token}`,
      "click role=button[name='Add host'] >> nth=-1",
      "gone By URL and token",
      `wait ${hostRow(linked.host_id)} >> text=linked by URL`,
      `wait ${hostRow(linked.host_id)} >> [title=Connected]`,
      `wait ${remoteRow}`,
    ])
    // Renamed: the sidebar names it so.
    await ui.run([
      `click ${hostRow(linked.host_id)} >> role=button[name=Rename]`,
      "press Control+a",
      "type Build box",
      "press Enter",
      "wait css=aside >> text=Build box",
    ])
    await eventually(async () => assert.equal((await hub.rpc("hub.hosts.list")).find((h) => h.id === linked.host_id)?.name, "Build box"))

    // The profile's board has both hosts' tasks; the linked host's opens, and moves on that host.
    await ui.run(["goto /profile/Default", "wait A task on the hub", "wait A task on the linked host", "click A task on the linked host", "wait REM-1"])
    await ui.run([
      "click Details",
      "click role=button[name='Needs attention']",
      "wait css=section:has(span:text-is('Needs attention')) >> text=A task on the linked host",
    ])
    await eventually(async () => assert.equal((await host.rpc("tasks.get", { id: remoteTask.id })).status, "needs_attention"))
    // A change made on that host shows here.
    await host.rpc("tasks.update", { id: remoteTask.id, patch: { title: "Renamed on the host" } })
    await ui.run(["wait css=[data-task] >> text=Renamed on the host"])

    // Away, it keeps its board, marked offline; back, it goes on.
    host.kill()
    await ui.run(["wait css=aside >> text=/Build box · offline/", "wait css=[data-task] >> text=Renamed on the host"])
    host.restart()
    await ui.run(["gone css=aside >> text=/Build box · offline/"])
    await host.rpc("tasks.update", { id: remoteTask.id, patch: { title: "Back again" } })
    await ui.run(["wait css=[data-task] >> text=Back again"])

    // Forgotten: its projects and tasks leave the board (they stay on that host).
    await ui.run([
      "goto /settings/hosts",
      "click role=button[name='Remove Build box']",
      "click Remove from board",
      `gone ${hostRow(linked.host_id)}`,
      `gone ${remoteRow}`,
    ])
    await ui.run(["goto /profile/Default", "wait A task on the hub", "gone Back again"])
    assert.equal((await host.rpc("tasks.get", { id: remoteTask.id })).title, "Back again")
    assert.equal((await hub.rpc("tasks.get", { id: hubBoard.tasks[0].id })).title, "A task on the hub")
  })
})
