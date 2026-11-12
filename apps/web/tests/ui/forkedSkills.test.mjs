// A forked skill in a thread (the old forkedSkills check, IA-173): a Skill with `context: fork` (`/code-review`), which
// Claude Code runs as a `local_agent` subagent with no Agent/Task call, shows as a subagent of the thread: its row opens
// its own thread view with its transcript, its permission and its report, live while it runs and from before the
// thread's window once it has finished.
//
// The old check fed the thread from the page: raw Claude messages (tests/fixtures/forkedSkill.mjs) served as the
// thread's history (`routeThread`) or put through the old translator and sent as live events. Here the agent is the
// fake claude (`--fake-claude`), whose "fake-skill-fork" prompt marker prints that same shape (packages/testing/bin/
// fake-claude.ts), so the server's own translator makes the thread; the translator's handling of it is also the
// recorded `skill-fork` session (packages/testing/fixtures/threads/claude). Changed or dropped:
// - The subagent is opened from its row ("Open subagent thread"), where the old checks picked it from the Agents list
//   ("Subagents in this thread", with its "1 running"/"1 done" counts): that list isn't on this server
//   (subagentThread.test.mjs and threadPages.test.mjs dropped it too). So the older review's subagent is reached by
//   loading the earlier part of the thread.
// - The old first case was a review thread of another task (written into the database); the kind of thread doesn't
//   change how a forked skill is drawn, so it is a task of its own here.
// - The main agent's last words are the fake's reply, and the thread's turn end is waited for in place of "Main reviewer
//   summary.".
import assert from "node:assert/strict"
import { afterAll, beforeAll, test } from "vite-plus/test"
import { eventually, makeTask, seedBoard, seedThread, startServer, withBrowser } from "./harness.mjs"

let server, board
beforeAll(async () => {
  server = startServer("--fake-claude")
  board = await seedBoard(server)
})
afterAll(() => server?.stop())

const PROMPT = "Please run the review fake-skill-fork"
const row = "css=[data-tool-row]:has-text('/code-review')"
const openRow = `click ${row} [aria-label='Open subagent thread'] >> visible=true`

test("a streamed forked Skill becomes a running subagent, then completes with its report", async () => {
  const task = await makeTask(server, board.project, { title: "Live forked Skill" })
  await server.rpc("tasks.send", { id: task.id, text: PROMPT })
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    await ui.run([`goto /p/${board.project.id}?task=${task.id}`, `wait ${row}`, "wait Claude wants to use", "wait from /code-review"])
    // Its child's Bash call waits for an answer: the subagent runs, and its own view shows what it waits on.
    assert.match(await page.locator(row).first().innerText(), /needs approval|running/)
    await ui.run([openRow, "wait Show in thread", "wait git diff main...HEAD"])
    await ui.run(["press Escape", "gone Show in thread", "click Allow"])
    await ui.run(["wait Turn complete", openRow, "wait No runtime bugs found.", "click git diff main...HEAD", "wait The reviewed diff."])
    await ui.run(["press Escape", "gone Show in thread", "wait Turn complete"])
  })
})

test("an older forked Skill, before the thread's window, opens with its transcript and report", async () => {
  const task = await makeTask(server, board.project, { title: "Review of work" })
  await server.rpc("tasks.send", { id: task.id, text: PROMPT })
  // Its child's Bash call allowed, and its turn over.
  const request = await eventually(async () => {
    const [r] = await server.rpc("permissions.pending", { task_id: task.id })
    assert.ok(r, "its permission")
    return r
  }, 15_000)
  await server.rpc("permissions.answer", { id: request.id, answer: { decision: "allow" } })
  await eventually(async () => assert.equal((await server.rpc("tasks.get", { id: task.id })).running, false), 15_000)
  // More than a window's 300 items after it.
  seedThread(
    server,
    task,
    Array.from({ length: 320 }, (_, i) => ({ id: `follow-up-${i + 1}`, type: "assistant_message", text: `Review follow-up ${i + 1}.` })),
  )
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    await ui.run([`goto /p/${board.project.id}?task=${task.id}`, "wait Review follow-up 320.", "wait Load earlier messages"])
    assert.equal(await page.getByText("No runtime bugs found.").count(), 0, "the Skill's launch is before the window")
    await ui.run(["click Load earlier messages", `wait ${row}`, openRow, "wait Show in thread"])
    await ui.run(["wait git diff main...HEAD", "wait Permission for Bash", "wait No runtime bugs found."])
    await ui.run(["click git diff main...HEAD", "wait The reviewed diff.", "gone Review follow-up 320."])
    await ui.run(["click Show in thread", "gone Show in thread", `wait ${row}`])
    await page.getByRole("button", { name: "Open subagent thread", exact: true }).first().waitFor()
  })
})
