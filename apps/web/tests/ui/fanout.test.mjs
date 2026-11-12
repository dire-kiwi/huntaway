import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync } from "node:fs"
import { afterAll, beforeAll, test } from "vite-plus/test"
import { failure, gitRepo, routeRpc, startServer, withBrowser } from "./harness.mjs"

// The old tests/ui/fanout.test.mjs, every case. The old checks failed the second `POST /projects/<id>/tasks` with
// `page.route`; these fail the second `tasks.create` on the RPC websocket (`routeRpc`).

let server
let project
let plain
let cart
let profile
beforeAll(async () => {
  server = startServer()
  const repo = `${server.dataDir}/shop`
  gitRepo(repo)
  mkdirSync(`${server.dataDir}/claude`)
  const config = await server.rpc("configs.create", { config: { name: "Claude", config_dir: `${server.dataDir}/claude` } })
  profile = await server.rpc("profiles.create", { profile: { name: "Default", claude_config_ids: [config.id] } })
  const create = (p) => server.rpc("projects.create", { project: { profile_id: profile.id, ...p } })
  project = await create({ name: "Shop", repo_path: repo, key: "SHOP" })
  plain = await create({ name: "Plain", repo_path: `${server.dataDir}/plain`, key: "PL", use_worktrees: false })
  // A git repository whose tasks don't get worktrees unless they ask.
  mkdirSync(`${server.dataDir}/cart`)
  execFileSync("git", ["init", "-q", `${server.dataDir}/cart`])
  cart = await create({ name: "Cart", repo_path: `${server.dataDir}/cart`, key: "CART", use_worktrees: false })
})
afterAll(() => server?.stop())

const tasksIn = async (p, description) =>
  (await server.rpc("tasks.list", { filter: { _tag: "ByProject", project_id: p.id } })).filter((t) => t.description === description)

/** Fails the `n`th `tasks.create` the page sends. */
const failCreate = (page, n) => {
  let creates = 0
  return routeRpc(page, (r) => (r.tag === "tasks.create" && ++creates === n ? failure({ _tag: "Invalid", field: "title", reason: "boom" }) : undefined))
}

// IA-227: as t3code sends one prompt to several models, each `!model` makes a task from the same prompt, in its own
// worktree, and they're shown side by side.
test("several models make a task each from one prompt, and their cards and details say which is which", async () => {
  await withBrowser(server, {}, async (ui) => {
    await ui.run([
      `goto /p/${project.id}`,
      "click New task",
      "type Add a health check !opus !sonnet",
      "press Escape",
      "wait Makes 2 tasks from this prompt",
      // Each is in its own worktree, so the toggle goes.
      "gone Own git worktree",
      "press Control+Enter",
      "gone Reads as",
    ])
    const tasks = await tasksIn(project, "Add a health check")
    assert.deepEqual(tasks.map((t) => [t.model, t.use_worktree]).toSorted(), [
      ["opus", true],
      ["sonnet", true],
    ])
    assert.ok(tasks[0].fanout_id && tasks[0].fanout_id === tasks[1].fanout_id)
    const [opus, sonnet] = tasks.toSorted((a, b) => a.model.localeCompare(b.model))
    await ui.run([
      `wait [data-task="${opus.id}"] >> text=opus`,
      `wait [data-task="${sonnet.id}"] >> text=sonnet`,
      `goto /p/${project.id}?task=${opus.id}`,
      "click Details",
      "wait Same prompt",
      `click css=aside button:has-text("SHOP-${sonnet.number}")`,
      `assert location.search.includes('${sonnet.id}')`,
    ])
  })
})

test("a model that couldn't be made stays in the text, and trying again makes it with the others", async () => {
  await withBrowser(server, {}, async (ui) => {
    await failCreate(ui.page, 2)
    await ui.run([
      `goto /p/${project.id}`,
      "click New task",
      "type Partial run !haiku !sonnet !fable",
      "press Escape",
      "wait Create 3 tasks",
      "press Control+Enter",
      "wait boom",
      "assert document.querySelector('textarea').value === 'Partial run !sonnet !fable'",
      "wait Create 2 tasks",
      "press Control+Enter",
      "gone Reads as",
    ])
  })
  const tasks = await tasksIn(project, "Partial run")
  assert.deepEqual(tasks.map((t) => t.model).toSorted(), ["fable", "haiku", "sonnet"])
  assert.equal(new Set(tasks.map((t) => t.fanout_id)).size, 1)
})

test("a project that isn't a git repository takes one model", async () => {
  await withBrowser(server, {}, async (ui) => {
    await ui.run([
      `goto /p/${plain.id}`,
      "click New task",
      "type Try it !opus !sonnet",
      "press Escape",
      "wait isn't a git repository",
      "assert document.querySelector('button[type=submit]').disabled",
      // A scratch task works in its own folder, so it can.
      "press Space",
      "type /scratch",
      "press Space",
      "wait Create 2 scratch tasks",
      "assert !document.querySelector('button[type=submit]').disabled",
    ])
  })
})

test("one model, or none, makes one task as before", async () => {
  await withBrowser(server, {}, async (ui) => {
    await ui.run([`goto /p/${project.id}`, "click New task", "type Only one !opus", "press Escape", "wait Create task", "press Control+Enter", "gone Reads as"])
  })
  const [task] = await tasksIn(project, "Only one")
  assert.deepEqual([task.model, task.fanout_id ?? null], ["opus", null])
})

// Review of IA-227: with two models and the second failing, one is left to try again, which is still one of the set.
test("the last model left after a failure is still made with the others, in its own worktree", async () => {
  await withBrowser(server, {}, async (ui) => {
    await failCreate(ui.page, 2)
    await ui.run([
      `goto /p/${cart.id}`,
      "click New task",
      "type Retry check !opus !sonnet",
      "press Escape",
      "wait Create 2 tasks",
      "press Control+Enter",
      "wait boom",
      "assert document.querySelector('textarea').value === 'Retry check !sonnet'",
      "wait Makes the task left from this prompt, with CART-1, in its own worktree",
      "gone Own git worktree",
      "press Control+Enter",
      "gone Reads as",
    ])
  })
  const tasks = (await tasksIn(cart, "Retry check")).toSorted((a, b) => a.number - b.number)
  assert.deepEqual(
    tasks.map((t) => [t.model, t.use_worktree]),
    [
      ["opus", true],
      ["sonnet", true],
    ],
  )
  assert.ok(tasks[0].fanout_id && tasks[1].fanout_id === tasks[0].fanout_id)
})

// Review of IA-227: a group's plans made from one prompt are linked too.
test("a group's documents made from one prompt are linked", async () => {
  await server.rpc("projects.update", { id: plain.id, patch: { group_name: "Team" } })
  const { host_id } = await server.rpc("host.info")
  await withBrowser(server, {}, async (ui) => {
    await ui.run([
      `goto /g/${host_id}/Team`,
      "click New task",
      "type Group docs in:group /plan !opus !sonnet",
      "press Escape",
      "wait Create 2 group tasks",
      "press Control+Enter",
      "gone Reads as",
    ])
  })
  const plans = (await server.rpc("tasks.list", { filter: { _tag: "Projectless", profile_id: profile.id } })).filter((t) => t.description === "Group docs")
  assert.deepEqual(plans.map((t) => [t.labels.join(), t.model]).toSorted(), [
    ["plan", "opus"],
    ["plan", "sonnet"],
  ])
  assert.ok(plans[0].fanout_id && plans[1].fanout_id === plans[0].fanout_id)
})
