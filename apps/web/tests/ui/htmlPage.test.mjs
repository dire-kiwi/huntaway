// HE-78: an agent's HTML page in the thread (its html_render call). It shows in the thread as the page, kept as an
// attachment, in a sandboxed frame as tall as the page; full screen zooms it and Escape closes just that, also from
// inside the page. With the task in the side panel, a click in the full-screen view isn't one outside the panel (it
// closed the task, found in review).
import assert from "node:assert/strict"
import { afterAll, beforeAll, test } from "vite-plus/test"
import { eventually, seedBoard, seedThread, startServer, withBrowser } from "./harness.mjs"

let server, board
beforeAll(async () => {
  server = startServer()
  board = await seedBoard(server)
})
afterAll(() => server?.stop())

const PAGE = '<h3 style="margin:0">Runtimes</h3><div style="height:200px;background:var(--panel)"></div><button id="b">Press</button>'

/** A task whose thread has an html_render call that kept PAGE. */
async function taskWithPage() {
  const kept = await server.rpc("attachments.upload", { name: "Runtimes.html", data: Buffer.from(PAGE).toString("base64") })
  const task = await server.rpc("tasks.create", { task: { project_id: board.project.id, title: "Show runtimes", status: "in_review" } })
  seedThread(server, task, [
    { id: "legacy:1", type: "user_message", text: "Show me the runtimes.", created_at: "2026-11-01T09:00:00.000Z" },
    {
      id: "toolu_page",
      type: "tool_call",
      name: "html_render",
      kind: "mcp",
      server: "huntaway",
      input: { title: "Runtimes", html: PAGE, height: 240 },
      status: "completed",
      result: { content: `The user sees the page in your thread.\n(Kept as ${kept.path}.)` },
      created_at: "2026-11-01T09:00:01.000Z",
    },
    { id: "legacy:2:0", type: "assistant_message", text: "Server is slowest.", created_at: "2026-11-01T09:00:02.000Z" },
  ])
  return task
}

test("a kept page shows in the thread; full screen zooms, and Escape in the page closes just it, in the side panel too", async () => {
  const task = await taskWithPage()
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    const frame = page.locator('iframe[title="Runtimes"]').first()
    const dialog = page.getByRole("dialog", { name: "Runtimes" })
    await ui.run([`goto /p/${board.project.id}?task=${task.id}&side`, "wait Server is slowest."])
    await frame.waitFor()
    // As tall as the page says it is: its heading, the 200px box and the button.
    await eventually(async () => assert.ok((await frame.boundingBox()).height > 240))
    assert.equal(await page.frameLocator('iframe[title="Runtimes"]').first().locator("h3").textContent(), "Runtimes")

    await page.getByRole("button", { name: "Full screen" }).click()
    await dialog.waitFor()
    // Zoom is a click in the full-screen view, not outside the task's panel: the task stays open.
    await dialog.getByRole("button", { name: "Zoom in" }).click()
    await dialog.getByText("125%").waitFor()
    assert.ok(new URL(page.url()).searchParams.has("task"))

    // Back to actual size (Playwright's clicks don't find their place in a frame under CSS zoom).
    await dialog.getByRole("button", { name: "125%" }).click()
    await dialog.getByText("100%").waitFor()

    // Escape with the focus in the page (another origin) closes the full-screen view, and only that.
    await dialog.frameLocator('iframe[title="Runtimes"]').locator("#b").click()
    await page.keyboard.press("Escape")
    await dialog.waitFor({ state: "detached" })
    assert.ok(new URL(page.url()).searchParams.has("task"))
    await ui.run(["wait Server is slowest."])
  })
})
