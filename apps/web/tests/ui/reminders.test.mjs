// Stars and reminders from a card's menu, listed in the sidebar (IA-124), and the board's saves of them that fail while
// other changes come in: the old reminders check, on a board seeded as the old demo board was. Where the old check
// held and failed the page's `PATCH /tasks/…` with `page.route`, this holds and fails its `tasks.update` calls on the
// RPC socket (`routeRpc`).
//
// Changed: the old check waited 300 ms after a failed save to see that nothing came back; with no sleeps here, it waits
// for the error to show and then for what the sidebar must (not) show.
import assert from "node:assert/strict"
import { afterAll, beforeAll, test } from "vite-plus/test"
import { DEMO_TASKS, eventually, failure, gate, routeRpc, seedBoard, startServer, tasksByTitle, withBrowser } from "./harness.mjs"

let server, board
beforeAll(async () => {
  server = startServer()
  board = await seedBoard(server, DEMO_TASKS)
})
afterAll(() => server?.stop())

const sidebar = (page) => page.locator("aside").innerText()
const taskNamed = async (title) => (await tasksByTitle(server, board.project))[title]
const update = (task, patch) => server.rpc("tasks.update", { id: task.id, patch })
const failed = (detail) => failure({ _tag: "Conflict", reason: "changed_meanwhile", detail })
/** Holds every `tasks.update` the page makes until the test lets it go (with a failure, or undefined to send it on). */
const holdSaves = (page) => {
  const saves = gate()
  return routeRpc(page, (r) => (r.tag === "tasks.update" ? saves.hold() : undefined)).then(() => saves)
}

// IA-124: starring a task and setting reminders from its card's menu lists it in the sidebar; a
// reminder that has come round shows as due, and clearing it from the sidebar takes it out.
test("stars tasks and sets reminders, and lists them in the sidebar", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    const card = "Try dragging this card to another column"
    const other = "A task waiting on an answer"
    await ui.run([`goto /p/${board.project.id}`, `wait ${card}`])
    assert.doesNotMatch(await sidebar(page), /Starred|Reminders/, "no sections while nothing is starred or reminded")

    await ui.run([`rclick ${card}`, "click [role=menu] >> text=Star", "wait css=aside >> text=Starred", "wait css=aside >> text=Try dragging"])
    await eventually(async () => assert.equal((await taskNamed(card)).starred, true))

    await ui.run([`rclick ${other}`, "click [role=menu] >> text=Remind me in 3 hours", "wait css=aside >> text=Reminders", "wait css=aside >> text=in 3h"])
    const at = await eventually(async () => Date.parse((await taskNamed(other)).remind_at))
    assert.ok(Math.abs(at - (Date.now() + 3 * 3600_000)) < 60_000, `reminder at ${new Date(at).toISOString()}`)

    // Come round (set by an agent, say, straight after): due, and counted on the section's heading.
    // The board's own save mustn't put the older time back when its response comes in late.
    await update(await taskNamed(other), { remind_at: new Date(Date.now() - 60_000).toISOString(), reminder: "Answer it" })
    await ui.run(["wait css=aside >> text=due"])
    assert.match(await sidebar(page), /Reminders\s+1\s/i)

    // Still there after a reload, and the panel shows the note.
    await ui.run([`goto /p/${board.project.id}`, "wait css=aside >> text=due", "click css=aside >> text=A task waiting", "click Details", "wait Answer it"])

    await ui.run(["rclick css=aside >> text=A task waiting", "click [role=menu] >> text=Clear reminder", "gone css=aside >> text=Reminders"])
    await eventually(async () => {
      const cleared = await taskNamed(other)
      assert.deepEqual([cleared.remind_at, cleared.reminder], [null, null])
    })

    await ui.run(["rclick css=aside >> text=Try dragging", "click [role=menu] >> text=Unstar", "gone css=aside >> text=Starred"])
    await eventually(async () => assert.equal((await taskNamed(card)).starred, false))
  })
})

// A star whose save fails goes back, without undoing what changed on the server while it was saving.
test("a failed star puts back only the star", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    const card = "Edit this task's title and description"
    const renamed = "Renamed while the star was saving"
    const t = await taskNamed(card)
    // Holds the board's save until the other changes are in, then fails it.
    const saves = await holdSaves(page)
    await ui.run([`goto /p/${board.project.id}`, `wait ${card}`])
    await ui.run([`rclick ${card}`, "click [role=menu] >> text=Star", "wait css=aside >> text=Starred"])
    await update(t, { title: renamed, remind_at: new Date(Date.now() - 60_000).toISOString() })
    await ui.run([`wait ${renamed}`, "wait css=aside >> text=due"])
    await eventually(() => assert.equal(saves.held(), 1))
    saves.release(failed("star failed"))
    await ui.run(["wait star failed", "gone css=aside >> text=Starred"])
    const side = await sidebar(page)
    assert.match(side, /Reminders/i)
    assert.match(side, /Renamed while/)
    assert.ok(await page.getByText(renamed).first().isVisible())
    assert.equal((await taskNamed(renamed)).starred, false)
    // Left for the next test as it found it.
    await update(t, { title: card, remind_at: null })
  })
})

// Starred on the server while the board's own star was saving (by an agent, say): the failed
// save mustn't take the star off, though it's the same as the one that failed.
test("a failed star doesn't undo the same star saved meanwhile", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    const card = "Something being worked on"
    const renamed = "Starred elsewhere meanwhile"
    const t = await taskNamed(card)
    const saves = await holdSaves(page)
    await ui.run([`goto /p/${board.project.id}`, `wait ${card}`])
    await ui.run([`rclick ${card}`, "click [role=menu] >> text=Star", "wait css=aside >> text=Starred"])
    await update(t, { title: renamed, starred: true })
    await ui.run([`wait ${renamed}`])
    await eventually(() => assert.equal(saves.held(), 1))
    saves.release(failed("star failed"))
    await ui.run(["wait star failed", `wait css=aside >> text=${renamed}`])
    assert.equal((await taskNamed(renamed)).starred, true)
    assert.match(await sidebar(page), /Starred[\s\S]*Starred elsewhere meanwhile/i)
    await update(t, { title: card, starred: false })
  })
})

// Star and then Unstar while the star is still saving, and both fail: unstarred, as the server
// has it, not the star the first one showed.
test("overlapping failed saves end up as the server has the task", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    const card = "Merged and closed"
    const saves = await holdSaves(page)
    await ui.run([`goto /p/${board.project.id}`, `wait ${card}`])
    await ui.run([`rclick ${card}`, "click [role=menu] >> text=Star", "wait css=aside >> text=Starred"])
    await ui.run([`rclick ${card}`, "click [role=menu] >> text=Unstar", "gone css=aside >> text=Starred"])
    await eventually(() => assert.equal(saves.held(), 2))
    saves.release(failed("save failed"))
    saves.release(failed("save failed"))
    await ui.run(["wait save failed", "gone css=aside >> text=Starred"])
    assert.equal((await taskNamed(card)).starred, false)
    assert.doesNotMatch(await sidebar(page), /Starred/i)
  })
})

// Snooze a reminder and then clear it while the snooze is still saving: the snooze fails, the
// clear (nulls for the time and the note) still stands, and then saves.
test("a failed snooze doesn't bring back a reminder cleared meanwhile", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    const card = "An idea for later"
    await update(await taskNamed(card), { remind_at: new Date(Date.now() + 86400_000).toISOString(), reminder: "Think it over" })
    const saves = await holdSaves(page)
    await ui.run([`goto /p/${board.project.id}`, "wait css=aside >> text=An idea for later"])
    const row = "css=aside >> text=An idea for later"
    await ui.run([`rclick ${row}`, "click [role=menu] >> text=Remind me in 1 hour", "wait css=aside >> text=in 1h"])
    await ui.run([`rclick ${row}`, "click [role=menu] >> text=Clear reminder", "gone css=aside >> text=Reminders"])
    await eventually(() => assert.equal(saves.held(), 2))
    saves.release(failed("snooze failed"))
    await ui.run(["wait snooze failed", "gone css=aside >> text=Reminders"])
    // The clear goes on to the server.
    saves.release(undefined)
    await eventually(async () => {
      const saved = await taskNamed(card)
      assert.deepEqual([saved.remind_at, saved.reminder], [null, null])
    })
    await ui.run(["gone css=aside >> text=Reminders"])
  })
})
