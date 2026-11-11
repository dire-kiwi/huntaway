import assert from "node:assert/strict"
import { afterAll, beforeAll, test } from "vite-plus/test"
import { eventually, seedAgentBoard, startServer, withBrowser } from "./harness.mjs"

// The assistant's routines (6.7; the old routines.test.mjs), with 6.5's `automations.*` RPCs for a profile. The old
// check's run failed to start its agent (agents couldn't run on that server); here a run's thread is made only on a host
// that runs agents, so it runs on the fake agent (`--fake-claude`) and reports what it said.

let server, profile
beforeAll(async () => {
  server = startServer("--fake-claude")
  ;({ profile } = await seedAgentBoard(server))
})
afterAll(() => server?.stop())

const createRoutine = (automation) => server.rpc("automations.create", { profile_id: profile.id, automation })

// HA-122: a routine's run works in a thread of its own under the assistant, off every list the board loads, and posts
// its report in the assistant's thread, which links to it.
test("a routine's report links to its thread, which opens though no list has it", async () => {
  const assistant = await server.rpc("assistant.get", { profile_id: profile.id })
  const routine = await createRoutine({
    name: "Inbox",
    trigger: { kind: "cron", expr: "0 8 * * mon-fri" },
    action: { kind: "message_assistant", message: "Anything new?" },
  })
  const run = await server.rpc("automations.run", { id: routine.id })
  assert.equal(run.status, "ok", JSON.stringify(run))
  const threadId = run.task_id
  // Its agent runs and stops; the run says how it went once it's ended.
  const ended = await eventually(async () => {
    const { runs } = await server.rpc("automations.runs", { id: routine.id })
    assert.ok(runs[0].outcome, JSON.stringify(runs[0]))
    return runs[0]
  }, 30_000)
  assert.notEqual(ended.outcome, "quiet", JSON.stringify(ended))
  const thread = await server.rpc("tasks.get", { id: threadId })
  assert.deepEqual([thread.task_type, thread.parent_id], ["routine", assistant.id])

  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    await ui.run(["goto /assistant/Default", "wait css=[data-testid=routine-report] >> text=Inbox"])
    await page.locator("[data-testid=routine-report]").getByRole("button", { name: thread.key }).click()
    // In a dialog over the assistant (HA-326).
    await page.waitForURL((u) => u.pathname === "/assistant/Default" && u.searchParams.get("modal") === threadId)
    await ui.run(["wait css=[data-task-modal] >> text=Anything new?"])
    // Loaded afresh, by its link: fetched, as no list has it, and it stays on its own page.
    await ui.run([`goto /t/${threadId}`, "wait Anything new?"])
    assert.equal(await page.getByText("Task not found.").count(), 0)
    assert.match(new URL(page.url()).pathname, new RegExp(`/t/${threadId}$`))
    // The assistant's Routines tab shows the run and how it went.
    await ui.run([
      "goto /assistant/Default",
      "click routines",
      "wait css=[data-testid=routine] >> text=Inbox",
      `wait css=[data-testid=routine] >> text=${thread.key}`,
    ])
    // Not on the profile's board.
    await ui.run(["goto /profile/Default", "wait Drop a task here to start its agent"])
    assert.equal(await page.getByText(thread.title, { exact: true }).count(), 0)
  })
})

// HA-234: an `at` routine whose time has passed (it ran, and turned itself off) can still be renamed and saved; only
// turning it on, or giving it a new time, needs one to come.
test("an at routine whose time has passed can be edited while it's off", async () => {
  await server.rpc("assistant.get", { profile_id: profile.id })
  // To the second, as one made by an agent can be (the editor shows minutes).
  const at = new Date(Math.floor(Date.now() / 60_000) * 60_000 - 3600_000 + 17_000).toISOString()
  const routine = await createRoutine({
    name: "Reminder",
    enabled: false,
    trigger: { kind: "at", at },
    action: { kind: "message_assistant", message: "Renew the domain" },
  })

  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    const dialog = page.getByRole("dialog")
    await ui.run(["goto /assistant/Default", "click routines", "click css=[data-testid=routine] >> text=Reminder", "wait Edit Reminder"])
    await dialog.getByPlaceholder("Morning inbox check").fill("Domain reminder")
    await dialog.getByRole("button", { name: "Save routine" }).click()
    await ui.run(["gone Edit Reminder", "wait css=[data-testid=routine] >> text=Domain reminder"])
    const renamed = await server.rpc("automations.get", { id: routine.id })
    assert.equal(renamed.name, "Domain reminder")
    assert.equal(renamed.enabled, false)
    assert.deepEqual(renamed.trigger, { kind: "at", at }, "its time is kept to the second")

    // Turned on, it needs a time to come.
    await ui.run(["click css=[data-testid=routine] >> text=Domain reminder", "wait Edit Domain reminder"])
    await dialog.getByRole("switch", { name: "On", exact: true }).click()
    await dialog.getByRole("button", { name: "Save routine" }).click()
    await ui.run(["wait Pick a time to come."])
    assert.equal((await server.rpc("automations.get", { id: routine.id })).enabled, false)
  })
})
