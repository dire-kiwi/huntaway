// HE-54: files attached in the new task dialog, pasted, dropped or picked, are uploaded to the host it goes on and listed
// in its description; its draft keeps them.
import assert from "node:assert/strict"
import { afterAll, beforeAll, test } from "vite-plus/test"
import { eventually, seedBoard, startServer, withBrowser } from "./harness.mjs"

let server, project
beforeAll(async () => {
  server = startServer()
  ;({ project } = await seedBoard(server))
})
afterAll(() => server?.stop())

const tasks = () => server.rpc("tasks.list", { filter: { _tag: "ByProject", project_id: project.id } })

/** Pastes a small PNG into the description, as a screenshot comes: "image.png". */
const pasteImage = (page) =>
  page.evaluate(async () => {
    const canvas = document.createElement("canvas")
    canvas.width = 4
    canvas.height = 3
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"))
    const data = new DataTransfer()
    data.items.add(new File([blob], "image.png", { type: "image/png" }))
    const area = document.querySelector("textarea[aria-label=Description]")
    area.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }))
  })

test("an image pasted into a new task's description is attached to the task", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    await ui.run([`goto /p/${project.id}`, "click New task", "wait New task in Demo", "type Look at this"])
    await pasteImage(page)
    await ui.run(["wait img[alt^=pasted-]"])
    // Kept in the draft: closed and opened again, it's still there.
    await ui.run(["press Escape", "gone New task in Demo", "click New task", "wait img[alt^=pasted-]", "press Control+Enter", "gone New task in Demo"])
    const task = await eventually(async () => {
      const made = (await tasks()).find((t) => t.description.startsWith("Look at this"))
      assert.ok(made)
      return made
    })
    assert.match(task.description, /^Look at this\n\nAttached files:\n- \S+\/pasted-[\d-]+\.png$/)
  })
})
