// HE-23: the "Show outgoing mail and events as drafts" experiment. The fake `claude` asks for the Google server's
// send_gmail_message ("fake-ask-mail") and manage_event ("fake-ask-event") and says in its reply what input each was
// allowed with. Off, the prompt is today's card; on, it's the mail (edited, and sent as edited) or the event (discarded).
// A thread's settled HTML mail is drawn in its sandboxed frame, and a Codex run's mail has no Edit.
import assert from "node:assert/strict"
import { afterAll, beforeAll, test } from "vite-plus/test"
import { eventually, makeTask, seedBoard, seedThread, startServer, withBrowser } from "./harness.mjs"

let server, board
beforeAll(async () => {
  server = startServer("--fake-claude")
  board = await seedBoard(server)
})
afterAll(() => server?.stop())

/** A task whose agent was asked `text`. */
async function asking(title, text) {
  const task = await makeTask(server, board.project, { title })
  await server.rpc("tasks.send", { id: task.id, text })
  return task
}

const experiments = async () => (await server.rpc("host.settings")).experiments
const reply = (page) => page.getByText(/\(permission /).first()

test("a mail to send is today's card with the experiment off, and a draft to edit and send with it on", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    assert.deepEqual(await experiments(), [])
    const before = await asking("Mail Kim, off", "Tell Kim. fake-ask-mail")
    await ui.run([
      `goto /p/${board.project.id}?task=${before.id}`,
      "wait Claude wants to use",
      "wait Always allow mcp__google__send_gmail_message for this thread",
    ])
    assert.equal(await page.locator("[data-draft]").count(), 0)
    await ui.run(["click Deny", "wait permission mcp__google__send_gmail_message: deny"])

    await ui.run(["goto /settings/experiments", "click Show outgoing mail and events as drafts"])
    await eventually(async () => assert.deepEqual(await experiments(), ["draft_cards"]))

    const task = await asking("Mail Kim", "Tell Kim. fake-ask-mail")
    await ui.run([
      `goto /p/${board.project.id}?task=${task.id}`,
      "wait Claude wants to send a mail",
      "wait Invoice 4411",
      "wait the money went out this morning",
    ])
    // Always allow stays; Allow and Deny read Send and Discard.
    await ui.run(["wait Always allow mcp__google__send_gmail_message for this thread", "wait Discard", "gone text=Deny"])
    await ui.run(["click Edit"])
    await page.getByLabel("To", { exact: true }).fill("kim@example.org")
    await page.getByLabel("Body").fill("Hi Kim,\n\nPaid on Monday.")
    await ui.run(["wait Edited: it goes as you see it here.", "click Send as edited", "wait Sent as you edited it.", "wait text=sent"])
    const said = await reply(page).textContent()
    assert.match(
      said,
      /permission mcp__google__send_gmail_message: allow \{"to":"kim@example.org","subject":"Invoice 4411","body":"Hi Kim,\\n\\nPaid on Monday\.","body_format":"plain"\}/,
    )
    // The card, settled, opens to the mail as sent.
    await ui.run(["click To kim@example.org · Invoice 4411", "wait Paid on Monday."])
  })
})

test("an event to add is shown as the event, and discarded", async () => {
  await server.rpc("host.updateSettings", { patch: { experiments: ["draft_cards"] } })
  const task = await asking("Book Sam", "Book it. fake-ask-event")
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    await ui.run([
      `goto /p/${board.project.id}?task=${task.id}`,
      "wait Claude wants to add an event",
      "wait 1:1 with Sam",
      "wait Mon 16 Nov 2026, 14:00 – 14:30 (Pacific/Auckland)",
      "wait sam@example.com",
      "wait Queen St",
      "click Discard",
      "wait discarded",
    ])
    assert.match(await reply(page).textContent(), /permission mcp__google__manage_event: deny: The user denied this action\./)
  })
})

test("an HTML mail is drawn in a frame that runs nothing and loads nothing; a Codex run's mail has no Edit", async () => {
  await server.rpc("host.updateSettings", { patch: { experiments: ["draft_cards"] } })
  const task = await makeTask(server, board.project, { title: "Mail threads", status: "in_review" })
  const at = "2026-11-01T09:00:00.000Z"
  const html = {
    to: "kim@example.com",
    subject: "Report",
    body_format: "html",
    body: '<h1>Q3</h1><p id="p">Up <b>4%</b></p><img src="https://tracker.example/p.gif"><script>document.body.dataset.ran = "yes"</script>',
  }
  seedThread(
    server,
    task,
    [{ id: "legacy:1", type: "user_message", text: "Send the report.", created_at: at }],
    [
      {
        id: "prompt-html",
        type: "permission",
        name: "send_gmail_message",
        kind: "mcp",
        server: "google",
        input: html,
        resolution: { outcome: "allow" },
        metadata: { tool_name: "mcp__google__send_gmail_message", request_id: "prompt-html", status: "allowed", edited: true },
        created_at: at,
      },
      {
        id: "prompt-codex",
        type: "permission",
        name: "send_gmail_message",
        kind: "mcp",
        server: "google",
        input: { message: "Allow send_gmail_message?", arguments: { to: "sam@example.com", subject: "Hi", body: "Hello" } },
        metadata: {
          tool_name: "mcp__google__send_gmail_message",
          request_id: "prompt-codex",
          status: "pending",
          codex: { id: 3, method: "mcpServer/elicitation/request" },
        },
        created_at: at,
      },
    ],
  )
  // The frame's policy and sandbox say so in the console as they refuse.
  const refused = [/'https:\/\/tracker\.example\/p\.gif' violates the following Content Security Policy/, /Blocked script execution in 'about:srcdoc'/]
  await withBrowser(server, { allowErrors: refused }, async (ui) => {
    const { page } = ui
    const remote = []
    page.on("requestfinished", (r) => r.url().includes("tracker.example") && remote.push(r.url()))
    await ui.run([`goto /p/${board.project.id}?task=${task.id}`, "wait Sent as you edited it.", "click To kim@example.com · Report"])
    const frame = page.frameLocator('iframe[title="The mail\'s body"]')
    await eventually(async () => assert.equal(await frame.locator("#p").textContent(), "Up 4%"))
    assert.equal(await frame.locator("body").getAttribute("data-ran"), null, "its script didn't run")
    assert.deepEqual(remote, [], "its remote image wasn't loaded")
    // Codex's approval can't carry an edited mail.
    await ui.run(["wait Codex wants to send a mail", "wait sam@example.com"])
    const codex = page.getByRole("group", { name: "Mail to send" })
    assert.equal(await codex.getByRole("button", { name: "Send", exact: true }).count(), 1)
    assert.equal(await codex.getByRole("button", { name: "Edit", exact: true }).count(), 0)
  })
})
