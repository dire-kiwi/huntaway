// Tasks that merge into another's branch (HA-295): their cards, the sidebar's picker, and the choice of where they go
// once the task they merge into is closed. The old mergesInto check, on a project of its own on a git repository.
import assert from "node:assert/strict"
import { afterAll, beforeAll, test } from "vite-plus/test"
import { eventually, makeProfile, makeProject, startServer, withBrowser } from "./harness.mjs"

let server, project, target, open, merged, plain
const make = (title, more = {}) => server.rpc("tasks.create", { task: { project_id: project.id, title, use_worktree: true, ...more } })
beforeAll(async () => {
  server = startServer()
  // A task merges into another's branch, so they need worktrees: a project on a git repository.
  project = await makeProject(server, await makeProfile(server), "Shop", "SHOP")
  target = await make("Checkout rework")
  open = await make("Cart totals", { merges_into: target.id })
  merged = await make("Payment form", { merges_into: "SHOP-1" })
  plain = await make("Shipping options")
  await server.rpc("tasks.update", { id: merged.id, patch: { status: "done", resolution: "done" } })
})
afterAll(() => server?.stop())

const task = (id) => server.rpc("tasks.get", { id })
/** Waits for `check` of the task to hold, and returns the task. */
const until = (id, check) =>
  eventually(async () => {
    const t = await task(id)
    assert.ok(check(t), JSON.stringify({ merges_into: t.merges_into, status: t.status, attention_reason: t.attention_reason }))
    return t
  }, 10_000)
const card = (page, t) => page.locator(`[data-task="${t.id}"]`)

// HA-295: a task merging into another says so on its card ("merged into" once it's merged), and opens that task from
// there; the task they merge into counts how many of them are merged.
test("cards show what a task merges into, and how many merging into a task are merged", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    await ui.run([`goto /p/${project.id}`, "wait Checkout rework", "wait Payment form"])
    assert.match(await card(page, target).innerText(), /1\/2/)
    assert.match(
      await card(page, target).locator("[title^='Merging into this task']").getAttribute("title"),
      /SHOP-2 Cart totals \(To do\)\nSHOP-3 Payment form \(merged\)/,
    )
    assert.match(await card(page, open).innerText(), /→\s*1/)
    const done = card(page, merged).locator("button[title^='Merged into SHOP-1']")
    assert.match(await done.getAttribute("class"), /text-st-done/)
    // The badge opens the task it merges into, not its own card.
    await card(page, open).locator("button[title^='Merges into SHOP-1']").click()
    await page.waitForURL((u) => u.searchParams.get("task") === target.id)
  })
})

// HA-295: what a task merges into is picked in its sidebar, from the tasks it could merge into.
test("the sidebar picks what a task merges into", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    await ui.run([`goto /p/${project.id}?task=${plain.id}`, "click Details", "wait Merges into"])
    const picker = page.locator('select[aria-label="Merges into"]')
    // Not itself or a done task; newest first.
    const options = await picker.locator("option").allInnerTexts()
    assert.deepEqual(options.slice(1), ["SHOP-2 Cart totals", "SHOP-1 Checkout rework"])
    await picker.selectOption({ label: "SHOP-1 Checkout rework" })
    const t = await until(plain.id, (x) => x.merges_into === target.id)
    assert.deepEqual(t.start_from, { type: "task", task_id: target.id })
    await ui.run(["wait 1/3"])
    // The task it merges into lists it.
    await ui.run([`goto /p/${project.id}?task=${target.id}`, "click Details", "wait Merging into this", "wait Shipping options"])
  })
})

// HA-295: once the task they merge into is closed without being merged, the open ones wait for the user to say where
// they go; "where it was going" sends them all to the base branch.
test("closing the task they merge into asks where they go, for all of them at once", async () => {
  await server.rpc("tasks.update", { id: target.id, patch: { status: "done", resolution: "wont_fix" } })
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    await until(open.id, (t) => t.status === "needs_attention")
    await ui.run([`goto /p/${project.id}`, "wait Cart totals"])
    assert.match(await card(page, open).locator("button[title*='closed without being merged']").innerText(), /closed/)
    // The thread shows the choice, as the card's reason says.
    await ui.run([`goto /p/${project.id}?task=${open.id}`, "wait Choose where they all go now", "wait Close them (SHOP-2 and SHOP-4) too"])
    await ui.run(["click Go where SHOP-1 was going", "gone Choose where they all go now"])
    for (const id of [open.id, plain.id]) {
      const t = await until(id, (x) => x.merges_into === null)
      assert.notEqual(t.status, "needs_attention")
    }
    // The task it was merging into keeps the ones that merged.
    assert.equal((await task(merged.id)).merges_into, target.id)
  })
})

// Review of HA-295: in a chain (A into B into C, with B merged into C), closing C holds A too, and its card and thread
// say so and offer the choice.
test("closing the last task of a chain asks where the tasks reaching it go", async () => {
  const c = await make("Search revamp")
  const b = await make("Search index", { merges_into: c.id })
  const a = await make("Search box", { merges_into: b.id })
  await server.rpc("tasks.update", { id: b.id, patch: { status: "done", resolution: "done" } })
  await server.rpc("tasks.update", { id: c.id, patch: { status: "done", resolution: "wont_fix" } })
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    await until(a.id, (t) => t.status === "needs_attention")
    await ui.run([`goto /p/${project.id}`, "wait Search box"])
    const badge = card(page, a).locator("button[title*='closed without being merged']")
    assert.match(await badge.getAttribute("title"), new RegExp(`SHOP-${c.number} .*by way of SHOP-${b.number}`))
    await ui.run([`goto /p/${project.id}?task=${a.id}`, `wait SHOP-${c.number} was closed without being merged`])
    await ui.run([`click Go where SHOP-${c.number} was going`, "gone Choose where it goes now"])
    const t = await until(a.id, (x) => x.merges_into === null)
    assert.notEqual(t.status, "needs_attention")
  })
})
