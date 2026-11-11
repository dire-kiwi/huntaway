import assert from "node:assert/strict"
import { afterAll, beforeAll, test } from "vite-plus/test"
import { eventually, makeTask, seedBoard, startServer, withBrowser } from "./harness.mjs"

// What agents ask, answered from the cards in the thread (the old questions.test.mjs's AskUserQuestion and plan cases,
// and the permission card's buttons): a test server whose agent is the fake `claude`, which asks for permission on its
// output for "fake-ask-permission", "fake-ask-question" and "fake-ask-plan" in its prompt and says in its reply what each
// answer was. The old checks answered from a thread fed by the page (`routeThread`) and caught what the cards sent;
// these answer a live agent and read its reply.
//
// Not ported: the board's own request_user_input card (its answer is the user's message, `Questions.answer`, not built
// yet), keys in a task dialog over the page (the dialog comes with the task modal), late answers and "moved on" (the
// server's tests have them: a run's end, which expires its prompts, is plan task 2.6's).

let server, board
beforeAll(async () => {
  server = startServer("--fake-claude")
  board = await seedBoard(server)
})
afterAll(() => server?.stop())

/** A task whose agent was asked `text`, and what its thread shows of it. */
async function asking(title, text) {
  const task = await makeTask(server, board.project, { title })
  await server.rpc("tasks.send", { id: task.id, text })
  return task
}

/** The agent's reply, once it has said what each answer was. */
const reply = (page) => page.getByText(/\(permission /).first()

test("a permission is allowed, a question answered with a key, a plan approved into a mode", async () => {
  const task = await asking("Ask everything", "Please fake-ask-permission, fake-ask-question and fake-ask-plan")
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    await ui.run([`goto /p/${board.project.id}?task=${task.id}`, "wait Claude wants to use", "wait Always allow Bash for this thread", "click Allow"])
    // The question: keys 1-9 pick (a lone question's pick answers it), not while typing.
    await ui.run(["wait Claude asks", "click css=[aria-label='Questions from Claude'] >> text=Which one?", "press 2"])
    await ui.run(["wait Plan ready for approval", "wait Do a fake thing"])
    assert.equal(await page.getByRole("radio", { name: "b" }).getAttribute("aria-checked"), "true")
    await page.getByLabel("Mode to continue in").selectOption("acceptEdits")
    await ui.run(["click Approve", "wait Continued in Accept edits"])
    const said = await reply(page).textContent()
    assert.match(said, /permission Bash: allow/)
    assert.match(said, /permission AskUserQuestion: allow \{"Which one\?":"b"\}/)
    assert.match(said, /permission ExitPlanMode: allow \[\{"type":"setMode","mode":"acceptEdits","destination":"session"\}\]/)
    await eventually(async () => assert.equal((await server.rpc("tasks.get", { id: task.id })).permission_mode, "acceptEdits"))
  })
})

test("a permission is denied, questions are dismissed, a plan is sent back with feedback", async () => {
  const task = await asking("Turn it down", "Please fake-ask-permission, fake-ask-question and fake-ask-plan")
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    await ui.run([`goto /p/${board.project.id}?task=${task.id}`, "wait Claude wants to use", "click Deny"])
    await ui.run(["wait Claude asks", "click Dismiss", "wait dismissed"])
    await ui.run(["wait Plan ready for approval", "click Keep planning", "click What should change in the plan", "type Add tests too", "press Control+Enter"])
    await ui.run(["wait kept planning", "wait Add tests too"])
    const said = await reply(page).textContent()
    assert.match(said, /permission Bash: deny: The user denied this action\./)
    assert.match(said, /permission AskUserQuestion: deny: The user dismissed these questions without answering them\./)
    assert.match(said, /permission ExitPlanMode: deny: The user wants you to keep planning rather than start on this plan\. Their feedback:$/)
    // The feedback is the reply's next paragraph (Markdown).
    await ui.run(["wait text=Add tests too)"])
  })
})

test("always allowing a tool keeps it on the thread's list", async () => {
  const task = await asking("Always", "Please fake-ask-permission")
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    await ui.run([`goto /p/${board.project.id}?task=${task.id}`, "click Always allow Bash for this thread"])
    assert.match(await reply(page).textContent(), /permission Bash: allow/)
    assert.deepEqual((await server.rpc("tasks.get", { id: task.id })).auto_allow, ["Bash"])
    // Its next calls of the tool are let through by the board without a card (the server's tests have it).
  })
})
