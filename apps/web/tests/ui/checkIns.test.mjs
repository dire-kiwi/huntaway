import assert from "node:assert/strict"
import { afterAll, beforeAll, test } from "vite-plus/test"
import { eventually, seedBoard, startServer, withBrowser } from "./harness.mjs"

// HE-24: the "Assistant check-ins" experiment. Off, the assistant's Routines tab offers nothing of it; on, it offers Add
// check-ins, which makes the Check-in routine at the times and on the days picked, and the routine's editor shows and
// changes its times as any routine's.

let server, profile
beforeAll(async () => {
  server = startServer()
  ;({ profile } = await seedBoard(server))
})
afterAll(() => server?.stop())

const routines = async () => (await server.rpc("automations.list", { profile_id: profile.id })).automations
const openRoutines = ["goto /assistant/Default", "wait Message your assistant", "click Routines", "wait New routine"]

test("the check-ins experiment adds the Check-in routine from the Routines tab", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    // Off, as it is by default: nothing of it shows.
    await ui.run([...openRoutines, "gone Add check-ins"])

    await ui.run(["goto /settings/experiments", "wait Features that are still being tried", "click Assistant check-ins"])
    await eventually(async () => assert.deepEqual((await server.rpc("host.settings")).experiments, ["check_ins"]))

    // On: 9:15 and 16:30, and one more after the last, on weekdays and Saturday.
    await ui.run([...openRoutines, "click Add check-ins", "wait It skips a check-in"])
    const setup = page.getByTestId("check-in-setup")
    await setup.getByLabel("Time 1").fill("09:15")
    await ui.run(["click Add a time", "click Sat"])
    // Google is offered only once it's connected.
    assert.equal(await setup.getByRole("checkbox").count(), 0)
    await setup.getByRole("button", { name: "Add check-ins" }).click()
    await ui.run(["gone It skips a check-in", "wait css=[data-testid=routine] >> text=Check-in", "gone Add check-ins"])
    const [made] = await routines()
    assert.deepEqual([made.name, made.enabled], ["Check-in", true])
    assert.deepEqual(made.trigger, { kind: "daily", time: "09:15, 16:30, 17:30", weekdays: ["mon", "tue", "wed", "thu", "fri", "sat"] })
    assert.deepEqual([made.action.kind, made.action.mode], ["message_assistant", "fresh"])
    assert.match(made.action.message, /\{\{last_run\}\}/)
    assert.doesNotMatch(made.action.message, /\{\{google\}\}/)
    assert.match(made.precheck, /HUNTAWAY_MINUTES_SINCE_USER_MESSAGE/)

    // The editor shows each time, and takes one out.
    await ui.run([
      "click css=[data-testid=routine] >> text=Check-in",
      "wait Time 3",
      "click Remove 09:15",
      "gone Time 3",
      "click Save routine",
      "gone Edit Check-in",
    ])
    await eventually(async () => assert.equal((await routines())[0].trigger.time, "16:30, 17:30"))
    // The precheck went through the editor as it was.
    assert.equal((await routines())[0].precheck, made.precheck)
  })
})
