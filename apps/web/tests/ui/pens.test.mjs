// Pens as the profile board's tabs (HA-285, HA-291), the pens thread and a pen's own thread (HA-293), and a pen that
// can't be saved for a task made on its tab (HA-341): the old pens check, on a board seeded as the old demo board was.
import assert from "node:assert/strict"
import { afterAll, beforeAll, test } from "vite-plus/test"
import { DEMO_TASKS, eventually, failure, routeRpc, seedBoard, startServer, tasksByTitle, withBrowser } from "./harness.mjs"

let server, board
beforeAll(async () => {
  server = startServer()
  board = await seedBoard(server, DEMO_TASKS)
})
afterAll(() => server?.stop())

const DRAG = "Try dragging this card to another column"
const WAITING = "A task waiting on an answer"
const tab = (name) => `role=tab[name=/^${name}/]`
const selectedTab = (page) => page.evaluate(() => document.querySelector("[role=tab][aria-selected=true]")?.textContent ?? "")

const tasks = () => tasksByTitle(server, board.project)
const pens = () => server.rpc("pens.list", { profile_id: board.profile.id })

// HA-285: pens are the profile board's tabs. A task goes in one from its card's menu, by being dropped on its tab, or by
// being made on its tab; a pen can be marked inactive and active again (HA-291), and the board stays on the tab picked last.
test("tasks move into pens, which show as the profile board's tabs", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    await ui.run(["goto /profile/Default", "wait Pens thread", "click New pen", "type Today", "press Enter", "gone Create pen", `wait ${tab("Today")}`])
    assert.match(await selectedTab(page), /^Today/)
    // A task made on the pen's tab goes in the pen.
    await ui.run(["click New task", "type Made on the Today tab", "press Control+Enter", "gone Create task"])
    const today = (await pens()).find((p) => p.name === "Today")
    await eventually(async () =>
      assert.ok(
        Object.values(await tasks()).some((t) => t.description?.includes("Made on the Today tab") && t.pen_id === today.id),
        "the new task in the pen",
      ),
    )

    // From a card's menu, on the All tab.
    await ui.run([`click ${tab("All")}`, `rclick ${DRAG}`, "click [role=menu] >> text=Pen: Today", "gone [role=menu]"])
    await eventually(async () => assert.equal((await tasks())[DRAG].pen_id, today.id))
    // Dropped on the tab.
    await page.evaluate(
      ([title, name]) => {
        const card = [...document.querySelectorAll("[data-task]")].find((e) => e.textContent.includes(title))
        const target = [...document.querySelectorAll("[role=tab]")].find((e) => e.textContent.startsWith(name))
        const dataTransfer = new DataTransfer()
        dataTransfer.setData("text/task-id", card.dataset.task)
        for (const type of ["dragover", "drop"]) target.dispatchEvent(new DragEvent(type, { dataTransfer, bubbles: true, cancelable: true }))
      },
      [WAITING, "Today"],
    )
    await eventually(async () => assert.equal((await tasks())[WAITING].pen_id, today.id))
    await ui.run([`click ${tab("Today")}`, `wait ${DRAG}`, `wait ${WAITING}`, "gone Edit this task's title and description"])
    assert.match(await selectedTab(page), /^Today\s*3$/)

    // The board stays on it after a reload.
    await ui.run(["goto /profile/Default", `wait ${DRAG}`, "gone Edit this task's title and description"])
    assert.match(await selectedTab(page), /^Today/)

    // Inactive, it's off the tabs (the board goes back to All) until it's marked active again.
    await ui.run([
      `rclick ${tab("Today")}`,
      "click [role=menu] >> text=Mark inactive",
      "wait 1 inactive",
      `gone ${tab("Today")}`,
      "wait Edit this task's title and description",
    ])
    assert.match(await selectedTab(page), /^All/)
    const penNow = async () => (await pens()).find((p) => p.id === today.id)
    await eventually(async () => assert.equal((await penNow()).active, false))
    await ui.run(["click 1 inactive", "click [role=menu] >> text=Today", `wait ${tab("Today")}`, "gone 1 inactive"])
    assert.match(await selectedTab(page), /^Today/)
    // Its tab's menu says it's active.
    await ui.run([`rclick ${tab("Today")}`, "wait [role=menu] >> text=Mark inactive", "press Escape", "gone [role=menu]"])
    await eventually(async () => assert.equal((await penNow()).active, true))

    // Out of the pen from its menu.
    await ui.run([`rclick ${DRAG}`, "click [role=menu] >> text=Out of Today", "gone [role=menu]", `gone ${DRAG}`])
    await eventually(async () => assert.equal((await tasks())[DRAG].pen_id, null))
  })
})

// The pens thread opens beside the board on its thread, keyed among the scratch tasks, and isn't a card on the board.
test("the pens thread opens beside the board", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    await ui.run(["goto /profile/Default", "click Pens thread", "wait This thread keeps your pens"])
    const url = new URL(page.url())
    assert.equal(url.pathname, "/profile/Default")
    const thread = await server.rpc("pens.thread", { profile_id: board.profile.id })
    assert.equal(url.searchParams.get("task"), thread.id)
    await ui.run([`wait S-${thread.number}`, "gone role=button[name=/^Start$/]"])
    assert.equal(await page.locator(`[data-task="${thread.id}"]`).count(), 0)
  })
})

// HA-293: each pen has its own thread, opened from its tab's menu or the button beside the tabs while it's shown, made
// the first time and the same one after; it isn't a card on the board, it's renamed with its pen, and it goes with it.
test("a pen's own thread opens from its tab", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    await ui.run(["goto /profile/Default", "wait Pens thread", "click New pen", "type Launch", "press Enter", "gone Create pen", `wait ${tab("Launch")}`])
    await ui.run(["click Launch thread", "wait This is the pen's own thread"])
    const pen = (await pens()).find((p) => p.name === "Launch")
    assert.ok(pen.thread_id, "the pen has its thread")
    const thread = await server.rpc("tasks.get", { id: pen.thread_id })
    assert.equal(thread.title, "Pen: Launch")
    assert.equal(new URL(page.url()).searchParams.get("task"), pen.thread_id)
    await ui.run([`wait S-${thread.number}`, "gone role=button[name=/^Start$/]"])
    assert.equal(await page.locator(`[data-task="${pen.thread_id}"]`).count(), 0)

    // From the tab's menu, after a reload: the same thread.
    await ui.run([
      "goto /profile/Default",
      `wait ${tab("Launch")}`,
      `rclick ${tab("Launch")}`,
      "click [role=menu] >> text=Open its thread",
      "wait This is the pen's own thread",
    ])
    assert.equal(new URL(page.url()).searchParams.get("task"), pen.thread_id)

    // Renamed with its pen.
    await server.rpc("pens.update", { id: pen.id, patch: { name: "Liftoff" } })
    await ui.run([`wait ${tab("Liftoff")}`, "wait Pen: Liftoff"])

    // Deleted with it.
    await ui.run([
      "goto /profile/Default",
      `rclick ${tab("Liftoff")}`,
      "click [role=menu] >> text=Delete…",
      "wait Its own thread is deleted with it",
      "click Delete pen",
      `gone ${tab("Liftoff")}`,
    ])
    await eventually(() =>
      server.rpc("tasks.get", { id: pen.thread_id }).then(
        () => assert.fail("the thread outlived its pen"),
        (e) => assert.equal(e.tag, "NotFound"),
      ),
    )
  })
})

// HA-341: a task made on a pen's tab that couldn't be moved into the pen vanished from the tab without a word.
test("a task made on a pen's tab that can't go in the pen says so", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    await routeRpc(page, (r) =>
      r.tag === "tasks.update" && (r.payload.patch.pen !== undefined || r.payload.patch.pen_id !== undefined)
        ? failure({ _tag: "Invalid", field: "pen", reason: "the pen couldn't be saved" })
        : undefined,
    )
    await ui.run(["goto /profile/Default", "wait Pens thread", "click New pen", "type Failing", "press Enter", "gone Create pen", `wait ${tab("Failing")}`])
    await ui.run(["click New task", "type Made on the Failing tab", "press Control+Enter", "gone Create task", "wait the pen couldn't be saved"])
  })
})
