// Stacks on the board (HA-297, HA-336, HA-386, HA-388): a stack gathered into one card, a level that waits for the one
// below it, a level whose task below was closed, and a whole stack merged by dropping its card on Ready for merge. The
// old stacks check, on a project of its own on a git repository; its tasks' worktrees are set up over RPC
// (`git.setupWorktree`) where the old check called `POST /tasks/{id}/worktree/setup`.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, beforeAll, test } from "vite-plus/test"
import { eventually, makeProfile, makeProject, routeRpc, startServer, withBrowser } from "./harness.mjs"

let server, project, low, up, make
beforeAll(async () => {
  server = startServer()
  // Stack levels are branches stacked on each other: a project on a git repository, with work on each.
  project = await makeProject(server, await makeProfile(server), "Shop", "SHOP")
  make = async (title, more = {}) => {
    const t = await server.rpc("tasks.create", { task: { project_id: project.id, title, use_worktree: true, ...more } })
    const { worktree_path: wt } = await server.rpc("git.setupWorktree", { id: t.id })
    writeFileSync(join(wt, `${t.number}.txt`), title)
    execFileSync("git", ["-C", wt, "add", "."])
    execFileSync("git", ["-C", wt, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", title])
    await server.rpc("tasks.update", { id: t.id, patch: { status: "in_review" } })
    return t
  }
  low = await make("Checkout rework")
  up = await make("Cart totals", { start_from: "SHOP-1" })
})
afterAll(() => server?.stop())

const task = (id) => server.rpc("tasks.get", { id })
/** Waits for `check` of the task to hold, and returns the task. */
const until = (id, check) =>
  eventually(async () => {
    const t = await task(id)
    assert.ok(check(t), JSON.stringify({ status: t.status, restack: t.restack, base_branch: t.base_branch, attention_reason: t.attention_reason }))
    return t
  }, 10_000)
const card = (page, t) => page.locator(`[data-task="${t.id}"]`)
/** Spreads every stack on the board (HA-388), for the checks of the levels' own cards. */
const spread = (ui) =>
  ui.context.addInitScript(() => {
    if (window === window.top) localStorage.setItem("ia.board.stacks", "spread")
  })

// HA-388: a stack's levels are gathered into one card on the board (tests/browser/stackCard.test.tsx checks the card
// itself), which its button spreads into their own cards, each with a tab that gathers it again; the top bar's switch
// does it for every stack. Which it is lasts over a reload.
test("a stack is one card on the board, and spread or gathered lasts over a reload", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    const stack = page.locator("[data-stack]")
    const column = page.locator("section[data-status=in_review]")
    await ui.run([`goto /p/${project.id}`, "wait Spread the stack"])
    // In In review, where both levels are, in place of their cards, and inside the column; the column counts it as one.
    assert.equal(await column.locator("[data-stack]").count(), 1)
    assert.equal((await card(page, low).count()) + (await card(page, up).count()), 0)
    const [col, box] = [await column.boundingBox(), await stack.boundingBox()]
    assert.ok(box.x > col.x && box.x + box.width < col.x + col.width && box.height > 60, JSON.stringify({ col, box }))
    assert.match(await column.locator("span").nth(1).innerText(), /^1$/)
    assert.equal(await stack.locator("[data-part]").count(), 2)
    assert.doesNotMatch(await stack.innerText(), /SHOP-/)

    await ui.run(["click Spread the stack", "wait 1 of 2", "wait 2 of 2"])
    assert.equal(await stack.count(), 0)
    // The first card's tab isn't cut off by the top of the column's list.
    const list = await column.locator(".overflow-y-auto").boundingBox()
    const tab = await page.getByRole("button", { name: "Gather the stack" }).first().boundingBox()
    assert.ok(tab.y >= list.y, JSON.stringify({ list, tab }))
    await page.reload()
    await ui.run(["wait 2 of 2"])
    assert.equal(await stack.count(), 0)
    await ui.run(["click Gather the stack", "wait Spread the stack"])
    await page.reload()
    await ui.run(["wait Spread the stack"])
    assert.equal(await card(page, low).count(), 0)

    // The switch spreads them all, and gathers them again.
    const sw = page.getByRole("switch", { name: "Stacks gathered" })
    await sw.click()
    await ui.run(["wait 1 of 2"])
    await page.reload()
    await ui.run(["wait 1 of 2"])
    assert.equal(await sw.getAttribute("aria-checked"), "false")
    await sw.click()
    await ui.run(["wait Spread the stack", "gone 1 of 2"])
  })
  // On a phone the card's menu stands in for dragging it.
  await withBrowser(server, { size: "390x844", touch: true }, async (ui) => {
    await ui.run([
      `goto /p/${project.id}`,
      "click role=tab[name=/In review/]",
      "click [data-stack] >> role=button[name='Stack menu']",
      "wait Merge the stack",
      "wait Spread its cards",
    ])
  })
})

// HA-297: a stack level says what it lands after, apart from "merges into", and in Ready for merge that it waits for
// it (not that it's queued behind another merge); the task below counts the levels on it. HA-336: one whose pull
// request isn't in a stack on GitHub isn't called "stacked" (see tests/browser/stackedOn.test.tsx for one that is).
test("a stack level waits for the one below it, and says so", async () => {
  await server.rpc("tasks.update", { id: up.id, patch: { status: "ready_for_merge" } })
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    await spread(ui)
    await ui.run([`goto /p/${project.id}`, "wait Cart totals"])
    assert.match(await card(page, low).locator("[title^='Landing after this task']").innerText(), /1/)
    const badge = card(page, up).locator("button[title^='Lands after SHOP-1']")
    assert.match(await badge.innerText(), /waits for\s*(SHOP-)?1/)
    assert.equal(await card(page, up).locator("[title^='Queued to merge']").count(), 0)
    await ui.run([`goto /p/${project.id}?task=${up.id}`, "click Details", "wait Waits for SHOP-1, which it lands after, to be merged", "wait Lands after"])
    // Nothing merges it meanwhile.
    const t = await task(up.id)
    assert.deepEqual([t.status, t.merging, t.running], ["ready_for_merge", true, false])
  })
})

// HA-297: once the task below is closed without being merged, the level waits for the user to say where it goes;
// "where it was going" restacks it onto the base branch, without that one's commits.
test("closing the task below asks where the level goes, and restacks it there", async () => {
  await server.rpc("tasks.update", { id: low.id, patch: { status: "done", resolution: "wont_fix" } })
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    await spread(ui)
    await until(up.id, (t) => t.status === "needs_attention")
    await ui.run([`goto /p/${project.id}`, "wait Cart totals"])
    assert.match(await card(page, up).locator("button[title*='closed without being merged']").innerText(), /closed/)
    await ui.run([`goto /p/${project.id}?task=${up.id}`, "wait Choose where it goes now", "wait The board restacks its branch there"])
    await ui.run(["click Go where SHOP-1 was going", "gone The board restacks its branch there"])
    const t = await until(up.id, (x) => x.restack === null && x.status !== "needs_attention" && x.start_from?.type === "commit")
    const own = execFileSync("git", ["-C", t.worktree_path, "log", "--format=%s", `${t.base_branch}..HEAD`], { encoding: "utf8" }).trim()
    assert.equal(own, "Cart totals")
  })
})

// HA-386: once every open level of a stack is through review, dragging its card to Ready for merge merges the whole
// stack (the server moves each level there as one run of the merge queue, `tasks.mergeStack`); until then the drop is
// refused and the card says which level holds it up. No other column takes the card.
test("dragging a stack's card to Ready for merge merges the whole stack, once its levels are through review", async () => {
  // Without automatic reviews (which can't run here), a level in In review with its agent idle is through review.
  await server.rpc("projects.update", { id: project.id, patch: { auto_review: false } })
  const a = await make("Search index")
  const b = await make("Search filters", { start_from: `SHOP-${a.number}` })
  await server.rpc("tasks.update", { id: b.id, patch: { status: "in_progress" } })
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    const stack = page.locator("[data-stack]", { hasText: "Search" })
    const column = (status) => page.locator(`section[data-status=${status}]`)
    const statuses = async () => [(await task(a.id)).status, (await task(b.id)).status]
    // The page's calls that would move a level, to see that a drop it refuses makes none (the old check waited 300 ms
    // and read the tasks; this waits for the page to have drawn the drop's outcome).
    const calls = await routeRpc(page)
    const moves = () => calls.filter((c) => c.tag === "tasks.mergeStack" || (c.tag === "tasks.update" && [a.id, b.id].includes(c.payload.id)))
    const drawn = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
    await ui.run([`goto /p/${project.id}`, "wait Spread the stack"])
    // A level is still in progress: the card is in that column, isn't dragged anywhere, and says why.
    assert.equal(await column("in_progress").locator("[data-stack]").count(), 1)
    await stack.dragTo(column("ready_for_merge"))
    await ui.run(["wait The stack can't merge yet. Not through review yet", "wait (in progress)"])
    await stack.dragTo(column("todo"))
    await drawn()
    assert.deepEqual(moves(), [])
    assert.deepEqual(await statuses(), ["in_review", "in_progress"])
    // Through review, it says it can go; another column still doesn't take it.
    await server.rpc("tasks.update", { id: b.id, patch: { status: "in_review" } })
    await ui.run(["wait Ready to merge the whole stack"])
    assert.equal(await column("in_review").locator("[data-stack]").count(), 1)
    await stack.dragTo(column("todo"))
    await drawn()
    assert.deepEqual(moves(), [])
    assert.deepEqual(await statuses(), ["in_review", "in_review"])
    // Dropped on Ready for merge, every level goes there, as one run, and the card with them.
    await stack.dragTo(column("ready_for_merge"))
    const moved = await until(b.id, (t) => t.status === "ready_for_merge")
    const bottom = await until(a.id, (t) => t.status === "ready_for_merge" || t.merging)
    assert.ok(moved.stack_run && moved.stack_run === bottom.stack_run, JSON.stringify([bottom.stack_run, moved.stack_run]))
    // The card says so and leaves In review (for Ready for merge, or Needs attention once the bottom level's merge
    // can't start: no agent runs here).
    await ui.run(["wait Merging the stack"])
    await column("in_review").locator("[data-stack]").waitFor({ state: "detached" })
  })
})
