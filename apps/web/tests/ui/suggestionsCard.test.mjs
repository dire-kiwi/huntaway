import assert from "node:assert/strict"
import { afterAll, beforeAll, test } from "vite-plus/test"
import { seedBoard, startServer, withBrowser } from "./harness.mjs"

// The assistant's suggestions card (HE-61): its agent, the fake `claude`, calls "fake-board-call suggest_task_actions
// <JSON>"; the card lists the tasks with the assistant's reasons and a button for each action it suggests, and a click
// does it on the board and settles the row. What each action does is the server's tests' (assistant/Suggestions.test.ts).

let server, profile, tasks
beforeAll(async () => {
  server = startServer("--fake-claude")
  ;({ profile, tasks } = await seedBoard(server, [
    { title: "Merged on GitHub", status: "in_review" },
    { title: "Waits on the release", status: "todo" },
    { title: "Keep this one", status: "todo" },
  ]))
})
afterAll(() => server?.stop())

/** The card's row `n` (from 1). */
const row = (n) => `css=[data-testid=suggestion]:nth-child(${n})`

test("the assistant suggests what to do with tasks; each row's buttons do it, and say so", async () => {
  const card = {
    title: "Tidy the Demo board",
    suggestions: [
      { task: "DEM-1", reason: "Its pull request was merged 3 days ago", actions: ["done", "merge"] },
      { task: "DEM-2", reason: "Nothing to do until the release", actions: ["remind", "backlog"], remind_at: "3d" },
      { task: "DEM-3", reason: "No activity for a month", actions: ["wont_fix"] },
    ],
  }
  await server.rpc("assistant.send", { profile_id: profile.id, text: `fake-board-call suggest_task_actions ${JSON.stringify(card)}` })
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    await ui.run(["goto /assistant/Default", "wait Tidy the Demo board", "wait The assistant suggests what to do with 3 tasks", "wait 3 to go"])
    await ui.run(["wait Its pull request was merged 3 days ago", "wait Remind me in 3d", "wait Close as won't fix"])

    // Move to Done: the task is done, and the row says so.
    await ui.run([`click ${row(1)} >> text=Move to Done`, `wait ${row(1)} >> text=Moved to Done`, "wait 2 to go"])
    assert.equal((await server.rpc("tasks.get", { id: tasks[0].id })).status, "done")
    // Remind me in 3d: a reminder, with the reason as its note.
    await ui.run([`click ${row(2)} >> text=Remind me in 3d`, `wait ${row(2)} >> text=Reminder set for`])
    const reminded = await server.rpc("tasks.get", { id: tasks[1].id })
    assert.equal(reminded.reminder, "Nothing to do until the release")
    assert.ok(reminded.remind_at)
    // Leave it: nothing changes.
    await ui.run([`click ${row(3)} >> text=Leave it`, `wait ${row(3)} >> text=Left as it is`, "wait all done"])
    assert.equal((await server.rpc("tasks.get", { id: tasks[2].id })).status, "todo")
    assert.equal(await page.getByRole("button", { name: "Leave it" }).count(), 0)
  })
})
