// Checking tasks' previews (the old previewChecks check, HA-188): the board asks whether each card's preview answers,
// two checks at most waiting at once, and every card still gets its check.
//
// Changed: the old check gave the cards preview URLs by rewriting the REST task list and answered
// `/api/preview-status` after 300 ms. Here the tasks have their preview URLs on the server (`tasks.update`), and
// `board.previewStatus` (the RPC that replaced the route) is held until the check lets each one go, so how many wait
// at once is counted without a timer.
import assert from "node:assert/strict"
import { afterAll, beforeAll, test } from "vite-plus/test"
import { eventually, gate, makeTask, routeRpc, seedBoard, startServer, success, updateTask, withBrowser } from "./harness.mjs"

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
  }
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    const held = gate()
    let most = 0
    const checked = new Set()
    await routeRpc(page, (r) => {
      if (r.tag !== "board.previewStatus") return undefined
      checked.add(r.payload.url)
      // A preview that doesn't answer, until the check lets it go.
      const answer = held.hold()
      most = Math.max(most, held.held())
      return answer
    })
    await ui.run([`goto /p/${board.project.id}`, ...titles.map((t) => `wait ${t}`)])
    // Let them go one at a time, as each comes, until every card's has been asked.
    while (checked.size < titles.length) {
      await eventually(() => assert.ok(held.held() > 0, `checked only ${[...checked].join(", ")}`), 15_000)
      held.release(success({ up: false, status: null }))
    }
    assert.equal(checked.size, titles.length)
    assert.ok(most <= 2, `${most} preview checks at once`)
  })
})
