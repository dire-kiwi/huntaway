// HE-55: a task has no Summary tab: the summary of its changes shows folded at the bottom of its thread, over the
// composer, and opens in place. Agents don't run here, so the board's stream (`board.watch`) gives the task a passed
// review and a summary.
import assert from "node:assert/strict"
import { afterAll, beforeAll, test } from "vite-plus/test"
import { seedBoard, startServer, withBrowser } from "./harness.mjs"
import { routeSockets } from "./servers.mjs"

let server, board
beforeAll(async () => {
  server = startServer()
  board = await seedBoard(server, [{ title: "Summarised task", status: "in_review" }])
})
afterAll(() => server?.stop())

const AT = new Date().toISOString()
const dress = (t) =>
  t.title !== "Summarised task"
    ? t
    : {
        ...t,
        review: { thread_id: "none", state: "passed", head: "abc1234", summary: null, issues: [], fixes: 0, extra_rounds: 0, updated_at: AT, reviewers: [] },
        summaries: [
          {
            thread_id: "none",
            label: "",
            state: "done",
            head: "abc1234",
            text: "## The login form\n\nIt now **checks** the email address before sending it.",
            updated_at: AT,
          },
        ],
      }

test("a task's summary is folded at the bottom of its thread, not in a tab", async () => {
  const [task] = board.tasks
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    await routeSockets(page, {
      rewrite: (tag, value) =>
        tag !== "board.watch"
          ? value
          : value.type === "snapshot"
            ? { ...value, tasks: value.tasks.map(dress) }
            : value.type === "task"
              ? { ...value, task: dress(value.task) }
              : value,
    })
    // It opens on the thread (not on a summary), with the summary folded to one line.
    await ui.run([`goto /p/${board.project.id}?task=${task.id}`, "wait [data-summary-bar=folded]", "wait [data-thread]"])
    const bar = page.locator("[data-summary-bar]")
    assert.match(await bar.innerText(), /Summary of the changes\s+· The login form/)
    assert.equal(await page.getByRole("button", { name: "Summary", exact: true }).count(), 0)
    // Opened, it shows in full with a way to write it again, and folds back.
    await ui.run(["click Show the summary of the changes", "wait [data-summary-bar=open]", "wait Summarise again"])
    assert.match(await bar.innerText(), /It now checks the email address before sending it\./)
    await ui.run(["click Fold the summary", "wait [data-summary-bar=folded]", "gone Summarise again"])
  })
})
