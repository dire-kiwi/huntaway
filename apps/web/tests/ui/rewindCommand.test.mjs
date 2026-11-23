// HE-101: the composer's `/rewind`, as Claude Code has it, to reword a prompt. It lists the user's messages (newest
// first), picking one asks how far to go back (its Cancel goes back to the list), and once rewound the message is in the
// composer to change and send again, to the agent's conversation as it was before it. Agents run with the fake claude,
// which logs each call (its arguments and prompt) to <data dir>/fake-claude.log.
import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { afterAll, beforeAll, test } from "vite-plus/test"
import { eventually, seedAgentBoard, startServer, withBrowser } from "./harness.mjs"

let server, board
beforeAll(async () => {
  server = startServer("--fake-claude")
  board = await seedAgentBoard(server)
})
afterAll(() => server?.stop())

/** The fake agent's calls, oldest first. */
const calls = () => {
  const log = `${server.dataDir}/fake-claude.log`
  return existsSync(log)
    ? readFileSync(log, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : []
}

/** Sends `text` to the task and waits for its turn to be checkpointed, with the agent stopped. */
async function said(task, text, turns) {
  await server.rpc("tasks.send", { id: task.id, text })
  await eventually(async () => {
    const t = await server.rpc("tasks.get", { id: task.id })
    assert.equal(t.running, false)
    assert.equal((await server.rpc("checkpoints.turns", { task_id: task.id })).turns.length, turns)
  }, 20_000)
}

test("/rewind picks a message to go back to before, and puts it in the composer to reword", async () => {
  const task = await server.rpc("tasks.create", { task: { project_id: board.project.id, title: "Greeting page" } })
  await said(task, "Make it blue", 1)
  await said(task, "Add a footer with the date", 2)
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    const composer = page.getByPlaceholder("Reply to the agent…")
    const dialog = page.getByRole("dialog")
    await ui.run([`goto /t/${task.id}`, "wait Fake reply to: Add a footer with the date"])

    // `/rew` lists it in the `/` menu; Enter runs it rather than putting it in the message.
    await composer.click()
    await ui.run(["type /rew", "wait role=option[name=/rewind/]", "press Enter", "wait role=dialog[name='Rewind's]"])
    assert.equal(await composer.inputValue(), "")
    const messages = dialog.getByRole("group", { name: "Messages to rewind to" }).getByRole("button")
    await messages.nth(1).waitFor()
    const texts = await messages.allTextContents()
    assert.deepEqual(
      texts.map((t) => [t.startsWith("Turn 2") && t.endsWith("Add a footer with the date"), t.startsWith("Turn 1") && t.endsWith("Make it blue")]),
      [
        [true, false],
        [false, true],
      ],
      texts.join(" | "),
    )
    // The newest has the focus: Enter asks how far to go back, and Cancel goes back to the list.
    await ui.run(["press Enter", "wait role=dialog[name='Rewind to before turn 2']"])
    await dialog.getByRole("button", { name: "Cancel" }).click()
    await ui.run(["wait role=dialog[name='Rewind's]"])

    // Typed out in full, `/rewind` opens it too; Escape leaves the composer empty.
    await ui.run(["press Escape", "gone role=dialog"])
    await composer.fill("/rewind")
    await ui.run(["press Enter", "wait role=dialog[name='Rewind's]"])
    await messages.filter({ hasText: "Add a footer" }).click()
    const convo = dialog.getByRole("checkbox")
    assert.equal(await convo.isChecked(), true, "the conversation goes back too")
    await dialog.getByRole("button", { name: "Rewind", exact: true }).click()
    await ui.run(["gone role=dialog", "wait The agent's next run carries on from before turn 2"])
    await eventually(async () => assert.equal(await composer.inputValue(), "Add a footer with the date"))
    assert.notEqual((await server.rpc("tasks.get", { id: task.id })).rewind, null)

    // Reworded and sent, it goes to the conversation as it was before the message.
    await composer.fill("Add a footer with the date, in ISO format")
    await ui.run(["press Enter"])
    const run = await eventually(() => {
      // The run (not the title's call, which quotes it too) carries on with the session.
      const c = calls().find((x) => x.args.includes("--resume") && JSON.stringify(x.prompt).includes("in ISO format"))
      assert.ok(c, "the reworded message went to the agent")
      return c
    }, 20_000)
    assert.ok(run.args.includes("--resume-session-at"), `resumed at the rewind: ${run.args.join(" ")}`)
  })
})
