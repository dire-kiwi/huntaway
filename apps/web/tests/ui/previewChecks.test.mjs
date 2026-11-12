// Checking tasks' previews (the old previewChecks check, HA-188): the board asks whether each card's preview answers,
// two checks at most waiting at once, and every card still gets its check.
//
// Changed: the old check gave the cards preview URLs by rewriting the REST task list and answered
// `/api/preview-status` after 300 ms. Here the tasks have their preview URLs on the server (`tasks.update`), and
// `board.previewStatus` (the RPC that replaced the route) is held until the check lets them go.
//
// Changed on purpose (HE-9, `components/ui/preview.ts`): the old board let two checks wait at once, because each held one
// of the browser's six HTTP connections to the host. The checks are now calls on the page's one RPC socket, which takes
// any number at once, so the limit is gone; what HA-188 was for is checked instead: with every card's check waiting, a
// task's thread still opens.
import assert from "node:assert/strict"
import { afterAll, beforeAll, test } from "vite-plus/test"
import { eventually, gate, makeTask, routeRpc, seedBoard, seedThread, startServer, success, updateTask, withBrowser } from "./harness.mjs"

let server, board
beforeAll(async () => {
  server = startServer()
  board = await seedBoard(server)
})
afterAll(() => server?.stop())

// HA-188: each card with a preview polled its status, which waits up to 5s on a preview that doesn't answer. A browser
// opens 6 connections to a host, so a board with more such previews than that had every one of them busy, and opening a
// thread waited seconds for its messages. Only a couple of checks go at once now, and they all still get theirs.
test("preview checks leave the browser's connections for the rest of the board", async () => {
  const titles = Array.from({ length: 8 }, (_, i) => `Preview ${i}`)
  for (const title of titles) {
    const task = await makeTask(server, board.project, { title, status: "in_review" })
    await updateTask(server, task, { preview_url: `http://127.0.0.1:1/${title.replace(" ", "-")}` })
    if (title === "Preview 0") seedThread(server, task, [{ id: "legacy:1", type: "user_message", text: "Is the preview up?" }])
  }
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    const held = gate()
    const checked = new Set()
    await routeRpc(page, (r) => {
      if (r.tag !== "board.previewStatus") return undefined
      checked.add(r.payload.url)
      // A preview that doesn't answer, until the check lets it go.
      return held.hold()
    })
    await ui.run([`goto /p/${board.project.id}`, ...titles.map((t) => `wait ${t}`)])
    // Every card's check waiting on a preview that doesn't answer, a task's thread still opens.
    await eventually(() => assert.equal(held.held(), titles.length, `checked only ${[...checked].join(", ")}`), 15_000)
    await ui.run(["click Preview 0", "wait Is the preview up?"])
    // Let them go one at a time, as each comes, until every card's has been asked.
    while (checked.size < titles.length) {
      await eventually(() => assert.ok(held.held() > 0, `checked only ${[...checked].join(", ")}`), 15_000)
      held.release(success({ up: false, status: null }))
    }
    assert.equal(checked.size, titles.length)
  })
})
