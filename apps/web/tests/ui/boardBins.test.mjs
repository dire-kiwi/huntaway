// HE-52: the kanban board's bins, labels in its header with a popover of what's in them. Ready for merge is one rather
// than a column: a task dropped on the label goes to Ready for merge; the queue shows in a popover while the pointer is
// on the label, and a click keeps it open until Escape; its cards are a column's. Reminders has the tasks with a
// reminder, and keeps those whose reminder is still to come out of their columns.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, beforeAll, test } from "vite-plus/test"
import { eventually, makeProfile, makeProject, startServer, withBrowser } from "./harness.mjs"

let server, project, make
beforeAll(async () => {
  server = startServer()
  // Tasks with work to merge, which stay in Ready for merge (one with nothing to merge goes straight to Done).
  project = await makeProject(server, await makeProfile(server), "Mill", "MILL")
  make = async (title) => {
    const t = await server.rpc("tasks.create", { task: { project_id: project.id, title, use_worktree: true } })
    const { worktree_path: wt } = await server.rpc("git.setupWorktree", { id: t.id })
    writeFileSync(join(wt, `${t.number}.txt`), title)
    execFileSync("git", ["-C", wt, "add", "."])
    execFileSync("git", ["-C", wt, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", title])
    await server.rpc("tasks.update", { id: t.id, patch: { status: "in_review" } })
    return t
  }
})
afterAll(() => server?.stop())

const task = (id) => server.rpc("tasks.get", { id })
/** Waits for the task to be in the merge (in Ready for merge, or past it with no agent to merge it here). */
const merging = (id) =>
  eventually(async () => {
    const t = await task(id)
    assert.ok(t.status === "ready_for_merge" || t.merging, JSON.stringify({ status: t.status, merging: t.merging }))
  }, 10_000)

/** A point in `loc`: 30px in, and `y` from its top or halfway down. */
const at = async (loc, y) => {
  const b = await loc.boundingBox()
  return [b.x + 30, y === undefined ? b.y + b.height / 2 : b.y + y]
}

/**
 * Drags `source` over `label` (which opens its popover) and on to `target()` in the popover (`dy` from its top) with
 * the mouse, as dragTo can't go by way of the label. Nothing is clicked: the popover isn't pinned.
 */
const viaLabel = async (page, source, label, target, dy) => {
  const [x, y] = await at(source)
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + 10, y + 10, { steps: 3 })
  const [lx, ly] = await at(label)
  await page.mouse.move(lx, ly, { steps: 8 })
  await target().waitFor()
  // Straight down from the label into the popover, then across to the target: a slant would leave both on the way.
  const [tx, ty] = await at(target(), dy)
  await page.mouse.move(lx, ty, { steps: 8 })
  await page.mouse.move(tx, ty, { steps: 8 })
  await page.mouse.up()
}

// In the headless shell and in the full Chromium, which cancels a drag whose card is hidden as it starts.
for (const fullBrowser of [false, true]) {
  const n = fullBrowser ? " (full)" : ""
  test(`Ready for merge is a label that takes dropped tasks and shows the queue${n}`, async () => {
    const [a, b, c] = [await make(`Grind the flour${n}`), await make(`Sift the flour${n}`), await make(`Bag the flour${n}`)]
    await withBrowser(server, { fullBrowser }, async (ui) => {
      const { page } = ui
      const label = page.locator("button[data-status=ready_for_merge]")
      const queue = page.locator("section[aria-label='The merge queue']")
      const card = (t) => page.locator(`[data-task="${t.id}"]`)
      await ui.run([`goto /p/${project.id}`, `wait Grind the flour${n}`])
      // No column for it; the label counts what's in it.
      assert.equal(await page.locator("section[data-status=ready_for_merge]").count(), 0)
      assert.match(await label.innerText(), /Ready for merge\s*0/)
      // Dropped on the label, a task goes to Ready for merge.
      await card(a).dragTo(label)
      await merging(a.id)
      await card(b).dragTo(label)
      await eventually(async () => assert.equal((await task(b.id)).status, "ready_for_merge"), 10_000)
      // Its queue shows while the pointer is on the label, and goes when it leaves.
      await page.mouse.move(5, 600)
      await label.hover()
      await queue.waitFor()
      assert.equal(await queue.locator(`[data-task="${b.id}"]`).count(), 1)
      await page.mouse.move(5, 600)
      await queue.waitFor({ state: "hidden" })
      await card(b).waitFor({ state: "hidden" })
      await label.hover()
      await queue.waitFor()
      // A click keeps it open, and a task dropped in it goes to Ready for merge too.
      await label.click()
      await page.mouse.move(5, 600)
      await queue.waitFor()
      await card(c).dragTo(queue)
      await eventually(async () => assert.equal((await task(c.id)).status, "ready_for_merge"), 10_000)
      // Dragged above another in the queue, it goes before it there, and stays in Ready for merge.
      await queue.locator(`[data-task="${c.id}"]`).waitFor()
      await queue.locator(`[data-task="${c.id}"]`).dragTo(queue.locator(`[data-task="${b.id}"]`), { targetPosition: { x: 30, y: 4 } })
      await eventually(async () => {
        const [tb, tc] = [await task(b.id), await task(c.id)]
        assert.equal(tc.status, "ready_for_merge")
        assert.ok(tc.position < tb.position, JSON.stringify([tb.position, tc.position]))
      }, 10_000)
      // A card dragged out of the (still open) queue goes to the column it's dropped in.
      await queue.waitFor()
      await queue.locator(`[data-task="${c.id}"]`).dragTo(page.locator("section[data-status=in_review]"))
      await eventually(async () => assert.equal((await task(c.id)).status, "in_review"), 10_000)
      // Pinned, it's back once the drag is over, without the card; Escape closes it.
      await queue.waitFor()
      assert.equal(await queue.locator(`[data-task="${c.id}"]`).count(), 0)
      await page.keyboard.press("Escape")
      await queue.waitFor({ state: "hidden" })

      // Not pinned (opened by dragging over the label), a drop in the queue lands there: above its first card, first.
      await page.mouse.move(5, 600)
      await label.hover()
      await queue.waitFor()
      const top = await queue.locator("[data-task]").first().getAttribute("data-task")
      await page.mouse.move(5, 600)
      await queue.waitFor({ state: "hidden" })
      await viaLabel(page, card(c), label, () => queue.locator(`[data-task="${top}"]`), 4)
      await eventually(async () => {
        const [tc, tt] = [await task(c.id), await task(top)]
        assert.equal(tc.status, "ready_for_merge")
        assert.ok(tc.position < tt.position, JSON.stringify([tt.position, tc.position]))
      }, 10_000)
      await page.mouse.move(5, 600)
      await queue.waitFor({ state: "hidden" })
      // Opened by hovering, the queue reorders: its last card dragged above its first goes first.
      await label.hover()
      await queue.waitFor()
      const ids = await queue.locator("[data-task]").evaluateAll((els) => els.map((e) => e.dataset.task))
      assert.ok(ids.length >= 2, JSON.stringify(ids))
      const [head, last] = [ids[0], ids.at(-1)]
      await queue.locator(`[data-task="${last}"]`).dragTo(queue.locator(`[data-task="${head}"]`), { targetPosition: { x: 30, y: 4 } })
      await eventually(async () => {
        const [th, tl] = [await task(head), await task(last)]
        assert.equal(tl.status, "ready_for_merge")
        assert.ok(tl.position < th.position, JSON.stringify([th.position, tl.position]))
      }, 10_000)
    })
    // Out of the queue, for the next run's.
    for (const t of [a, b, c]) await server.rpc("tasks.update", { id: t.id, patch: { status: "done", resolution: "wont_fix" } })
  })
}

for (const fullBrowser of [false, true]) {
  const n = fullBrowser ? " (full)" : ""
  test(`Reminders keeps tasks waiting on a reminder out of their columns${n}`, async () => {
    const later = new Date(Date.now() + 3 * 86400_000).toISOString()
    const past = new Date(Date.now() - 60_000).toISOString()
    const plain = async (title, patch = {}) => {
      const t = await server.rpc("tasks.create", { task: { project_id: project.id, title } })
      return Object.keys(patch).length ? server.rpc("tasks.update", { id: t.id, patch }) : t
    }
    const other = await plain(`Mill the corn${n}`)
    const [waiting, due, free] = [
      await plain(`Ring the miller${n}`, { remind_at: later }),
      await plain(`Pay the miller${n}`, { remind_at: past }),
      await plain(`Oil the wheel${n}`),
    ]
    await withBrowser(server, { fullBrowser }, async (ui) => {
      const { page } = ui
      const label = page.locator("button[data-bin=reminders]")
      const bin = page.locator("section[aria-label=Reminders]")
      const todo = page.locator("section[data-status=todo]")
      await ui.run([`goto /p/${project.id}`, `wait Oil the wheel${n}`])
      // One still to come is only in the bin; a due one is back in its column, and in the bin too.
      assert.equal(await todo.locator(`[data-task="${waiting.id}"]`).count(), 0)
      assert.equal(await todo.locator(`[data-task="${due.id}"]`).count(), 1)
      assert.match(await label.innerText(), /Reminders\s*2/)
      await label.hover()
      await bin.waitFor()
      assert.deepEqual(await bin.locator("[data-task]").evaluateAll((els) => els.map((e) => e.dataset.task)), [due.id, waiting.id])
      await page.mouse.move(5, 600)
      await bin.waitFor({ state: "hidden" })
      // Dropped on the label, a task is asked when to be reminded, and leaves its column.
      await todo.locator(`[data-task="${free.id}"]`).dragTo(label)
      await ui.run(["click Remind me tomorrow at 9:00"])
      await eventually(async () => assert.ok((await task(free.id)).remind_at))
      await todo.locator(`[data-task="${free.id}"]`).waitFor({ state: "detached" })
      // Dragged over the label and dropped in the popover it opens (not pinned), a task is asked too.
      await viaLabel(page, todo.locator(`[data-task="${other.id}"]`), label, () => bin, 30)
      await ui.run(["wait Remind me tomorrow at 9:00", "press Escape", "gone Remind me tomorrow at 9:00"])
      await page.mouse.move(5, 600)
      await bin.waitFor({ state: "hidden" })
      // Dragged out of the bin into a column, it goes there without its reminder.
      await label.click()
      await bin.locator(`[data-task="${waiting.id}"]`).dragTo(page.locator("section[data-status=in_progress]"))
      await eventually(async () => {
        const t = await task(waiting.id)
        assert.deepEqual([t.status, t.remind_at], ["in_progress", null])
      })
      await page.locator(`section[data-status=in_progress] [data-task="${waiting.id}"]`).waitFor()
    })
    // No reminders left, for the next run's.
    for (const t of [due, free]) await server.rpc("tasks.update", { id: t.id, patch: { remind_at: null } })
  })
}
