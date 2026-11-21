// The page's own select (ui/Select.tsx, HE-70), where the native one's behaviour is the page's to keep.
import assert from "node:assert/strict"
import { afterAll, beforeAll, test } from "vite-plus/test"
import { eventually, makeTask, seedBoard, startServer, withBrowser } from "./harness.mjs"

let server, project, first, waiting
beforeAll(async () => {
  server = startServer()
  ;({
    project,
    tasks: [first, , waiting],
  } = await seedBoard(server, [{ title: "Older task" }, { title: "Newer task" }, { title: "Waiting task" }]))
})
afterAll(() => server?.stop())

// A board update that adds an option above the highlighted one leaves the highlight on that option, so Enter picks
// what the user arrowed to, not what's now in its place.
test("the highlight stays on its option when the options change under it", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    await ui.run([`goto /p/${project.id}?task=${waiting.id}`, "click Add a task it depends on…"])
    const options = page.getByRole("listbox").getByRole("option")
    // Newest first: the placeholder, "Newer task", "Older task".
    assert.equal(await options.count(), 3)
    await page.keyboard.press("ArrowDown")
    await page.keyboard.press("ArrowDown")
    const combobox = page.getByRole("combobox").filter({ hasText: "Add a task it depends on…" })
    const highlighted = () => combobox.getAttribute("aria-activedescendant").then((id) => page.locator(`[id="${id}"]`).innerText())
    assert.match(await highlighted(), /Older task$/)
    await makeTask(server, project, { title: "Brand new task" })
    await eventually(async () => assert.equal(await options.count(), 4))
    assert.match(await highlighted(), /Older task$/)
    await page.keyboard.press("Enter")
    await eventually(async () => assert.deepEqual((await server.rpc("tasks.get", { id: waiting.id })).depends_on, [first.id]))
  })
})
