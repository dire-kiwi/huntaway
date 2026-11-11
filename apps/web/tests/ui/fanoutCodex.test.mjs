import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync } from "node:fs"
import { afterAll, beforeAll, test } from "vite-plus/test"
import { failure, gate, gitRepo, routeRpc, startServer, success, withBrowser } from "./harness.mjs"

// The old tests/ui/fanoutCodex.test.mjs, every case. The old checks answered `GET /claude-configs/<id>/models` and failed
// a `POST /projects/<id>/tasks` with `page.route`; these answer `configs.models` and fail `tasks.create` on the RPC
// websocket (`routeRpc`), and see that nothing was created while the models were held from the calls the page made (the
// old checks slept 300ms and read the tasks).
//
// IA-227 with a Claude Code config and a Codex one, whose models the board fetches from the host (faked here, as the
// test server can't run Codex).
let server
let profile
let claude
let project
let codex
let cart
beforeAll(async () => {
  server = startServer()
  const repo = `${server.dataDir}/shop`
  gitRepo(repo)
  claude = await config("Claude")
  codex = await config("Codex", "codex")
  profile = await server.rpc("profiles.create", { profile: { name: "Default", claude_config_ids: [claude.id, codex.id] } })
  project = await server.rpc("projects.create", { project: { profile_id: profile.id, name: "Shop", repo_path: repo, key: "SHOP" } })
  // A git repository whose tasks don't get worktrees unless they ask.
  mkdirSync(`${server.dataDir}/cart`)
  execFileSync("git", ["init", "-q", `${server.dataDir}/cart`])
  cart = await server.rpc("projects.create", {
    project: { profile_id: profile.id, name: "Cart", repo_path: `${server.dataDir}/cart`, key: "CART", use_worktrees: false },
  })
})
afterAll(() => server?.stop())

function config(name, agent) {
  mkdirSync(`${server.dataDir}/${name}`, { recursive: true })
  return server.rpc("configs.create", { config: { name, config_dir: `${server.dataDir}/${name}`, ...(agent ? { agent } : {}) } })
}

const MODELS = [{ id: "gpt-5.5", name: "GPT-5.5", is_default: true, efforts: ["low", "medium", "high", "xhigh"], default_effort: null }]
const tasksIn = async (description, p = project) =>
  (await server.rpc("tasks.list", { filter: { _tag: "ByProject", project_id: p.id } })).filter((t) => t.description === description)
const isModels = (r, c = codex) => r.tag === "configs.models" && r.payload.id === c.id
const disabled = "document.querySelector('button[type=submit]').disabled"
const boom = failure({ _tag: "Invalid", field: "title", reason: "boom" })
const creates = (calls) => calls.filter((c) => c.tag === "tasks.create").length

// Review of IA-227: a Codex model named before Codex's models are in waits for them, rather than going as text.
test("a model named before its config's models are in waits for them", async () => {
  await withBrowser(server, {}, async (ui) => {
    const held = gate()
    const calls = await routeRpc(ui.page, (r) => (isModels(r) ? held.hold() : undefined))
    await ui.run([
      `goto /p/${project.id}`,
      "click New task",
      // No list is open for it (there's nothing to offer yet), so Escape would close the dialog.
      "type Slow discovery !opus !gpt-5.5",
      "wait Loading Codex's models",
      // Asked for meanwhile, it's created once they're in.
      "press Control+Enter",
      "wait It's created once they're in",
    ])
    assert.equal(creates(calls), 0)
    held.release(success(MODELS))
    await ui.run(["gone Reads as"])
  })
  const tasks = await tasksIn("Slow discovery")
  assert.deepEqual(tasks.map((t) => [t.model, t.claude_config_id === codex.id]).toSorted(), [
    ["gpt-5.5", true],
    ["opus", false],
  ])
  assert.ok(tasks[0].fanout_id && tasks[1].fanout_id === tasks[0].fanout_id)
})

test("a model whose config's models couldn't be fetched isn't sent as text", async () => {
  await withBrowser(server, {}, async (ui) => {
    await routeRpc(ui.page, (r) => (isModels(r) ? failure({ _tag: "Unavailable", what: "codex", reason: "codex isn't installed" }) : undefined))
    await ui.run([
      `goto /p/${project.id}`,
      "click New task",
      // No list is open for it (there's nothing to offer yet), so Escape would close the dialog.
      "type No discovery !opus !gpt-5.5",
      "wait Couldn't load Codex's models",
      `assert ${disabled}`,
    ])
  })
  assert.equal((await tasksIn("No discovery")).length, 0)
})

/** Answers Codex's models with `models`, and fails the second `tasks.create`. */
const modelsAndFailure = (page, models = MODELS) => {
  let n = 0
  return routeRpc(page, (r) => (isModels(r) ? success(models) : r.tag === "tasks.create" && ++n === 2 ? boom : undefined))
}

// Review of IA-227: an effort only a task already made takes is still an effort when the rest are made.
test("after a failure, the rest are made from the same prompt and options", async () => {
  await withBrowser(server, {}, async (ui) => {
    await modelsAndFailure(ui.page)
    await ui.run([
      `goto /p/${project.id}`,
      "click New task",
      "type Effort retry !opus !gpt-5.5 ^max",
      "press Escape",
      "wait Create 2 tasks",
      "press Control+Enter",
      "wait boom",
      "assert document.querySelector('textarea').value === 'Effort retry !gpt-5.5 ^max'",
      "wait max effort",
      "press Control+Enter",
      "gone Reads as",
    ])
  })
  const tasks = (await tasksIn("Effort retry")).toSorted((a, b) => a.number - b.number)
  // Codex's gpt-5.5 doesn't take max, so it gets its default.
  assert.deepEqual(
    tasks.map((t) => [t.model, t.effort]),
    [
      ["opus", "max"],
      ["gpt-5.5", null],
    ],
  )
  assert.ok(tasks[0].fanout_id && tasks[1].fanout_id === tasks[0].fanout_id)
})

// Review of IA-227: a Codex config's default model, named as `!codex`, is known before its models are, but which efforts
// it takes isn't, so an effort waits for them.
test("an effort for a Codex harness waits for its models", async () => {
  await withBrowser(server, {}, async (ui) => {
    const held = gate()
    const calls = await routeRpc(ui.page, (r) => (isModels(r) ? held.hold() : undefined))
    await ui.run([
      `goto /p/${project.id}`,
      "click New task",
      "type Default discovery !opus !codex ^max",
      "wait Loading Codex's models, to see whether it takes max effort",
      "click Create 2 tasks",
      "wait It's created once they're in",
    ])
    assert.equal(creates(calls), 0)
    held.release(success(MODELS))
    await ui.run(["gone Reads as"])
  })
  const tasks = await tasksIn("Default discovery")
  assert.deepEqual(tasks.map((t) => [t.model, t.effort]).toSorted(), [
    [null, null],
    ["opus", "max"],
  ])
})

// Review of IA-227: what's left of a set after a failure is kept with the draft, so it's still made as part of the set
// after the dialog is closed and opened again.
test("the rest of a set are made as part of it after the dialog is closed and opened again", async () => {
  await withBrowser(server, {}, async (ui) => {
    await modelsAndFailure(ui.page)
    await ui.run([
      `goto /p/${cart.id}`,
      "click New task",
      "type Reopen retry !opus !gpt-5.5 ^max",
      "press Escape",
      "wait Create 2 tasks",
      "press Control+Enter",
      "wait boom",
      "click Cancel",
      "gone Reads as",
      // Reloaded, too.
      `goto /p/${cart.id}`,
      "click New task",
      "assert document.querySelector('textarea').value === 'Reopen retry !gpt-5.5 ^max'",
      "wait Makes the task left from this prompt, with CART-1, in its own worktree",
      "wait max effort",
      "press Control+Enter",
      "gone Reads as",
    ])
  })
  const tasks = (await tasksIn("Reopen retry", cart)).toSorted((a, b) => a.number - b.number)
  assert.deepEqual(
    tasks.map((t) => [t.model, t.effort, t.use_worktree]),
    [
      ["opus", "max", true],
      ["gpt-5.5", null, true],
    ],
  )
  assert.ok(tasks[0].fanout_id && tasks[1].fanout_id === tasks[0].fanout_id)
})

// Review of IA-227: a Codex harness on its default model runs with the model it inherits (here the profile's), so the
// effort is checked against that one, not Codex's default.
test("an effort is checked against the model a default-model harness inherits", async () => {
  await server.rpc("profiles.update", { id: profile.id, patch: { default_model: "gpt-5.4-mini" } })
  try {
    const models = [
      { id: "gpt-5.5", name: "GPT-5.5", is_default: true, efforts: ["low", "medium", "high", "xhigh"], default_effort: "medium" },
      { id: "gpt-5.4-mini", name: "GPT-5.4 mini", is_default: false, efforts: ["low", "medium", "high"], default_effort: "medium" },
    ]
    await withBrowser(server, {}, async (ui) => {
      await routeRpc(ui.page, (r) => (isModels(r) ? success(models) : undefined))
      await ui.run([
        `goto /p/${project.id}`,
        "click New task",
        "type Inherited model /scratch !opus !codex ^xhigh",
        "press Escape",
        "wait Create 2 scratch tasks",
        "press Control+Enter",
        "gone Reads as",
      ])
    })
    const tasks = await tasksIn("Inherited model")
    assert.deepEqual(tasks.map((t) => [t.model, t.effort, t.claude_config_id === codex.id]).toSorted(), [
      [null, null, true],
      ["opus", "xhigh", false],
    ])
  } finally {
    await server.rpc("profiles.update", { id: profile.id, patch: { default_model: null } })
  }
})

test("family aliases autocomplete and create tasks with the latest model and its effort", async () => {
  const ids = ["gpt-6-sol", "gpt-6.1-sol", "gpt-6-astra", "gpt-6.1-terra", "gpt-6-luna"]
  const models = ids.map((id) => ({ ...MODELS[0], id, name: id, is_default: id === ids[0], efforts: ["low", "max"] }))
  for (const [alias, model] of [
    ["sol", ids[1]],
    ["astra", ids[2]],
    ["terra", ids[3]],
    ["luna", ids[4]],
  ]) {
    await withBrowser(server, {}, async (ui) => {
      await routeRpc(ui.page, (r) => (isModels(r) ? success(models) : undefined))
      await ui.run([
        `goto /p/${project.id}`,
        "click New task",
        `type Alias ${alias} /scratch !${alias}`,
        `wait latest · ${model}`,
        // Pick the alias from autocomplete.
        "press Tab",
        `assert document.querySelector('textarea').value.includes('!${alias} ')`,
        "type ^max",
        "press Escape",
        "press Control+Enter",
        "gone Reads as",
      ])
    })
    const tasks = await tasksIn(`Alias ${alias}`)
    assert.equal(tasks.length, 1)
    assert.equal(tasks[0].model, model)
    assert.equal(tasks[0].effort, "max")
    assert.equal(tasks[0].claude_config_id, codex.id)
  }
})

test("an alias waits for an earlier Codex config that may offer a different latest version", async () => {
  const earlier = await config("Earlier", "codex")
  await server.rpc("profiles.update", { id: profile.id, patch: { claude_config_ids: [claude.id, earlier.id, codex.id] } })
  try {
    await withBrowser(server, {}, async (ui) => {
      const held = gate()
      const calls = await routeRpc(ui.page, (r) =>
        isModels(r) ? success([{ ...MODELS[0], id: "gpt-6.1-sol" }]) : isModels(r, earlier) ? held.hold() : undefined,
      )
      await ui.run([
        `goto /p/${project.id}`,
        "click New task",
        "type Alias ordering /scratch !sol",
        "wait Loading Earlier's models",
        "press Control+Enter",
        "wait It's created once they're in",
      ])
      assert.equal(creates(calls), 0)
      held.release(success([{ ...MODELS[0], id: "gpt-6-sol" }]))
      await ui.run(["gone Reads as"])
    })
    const [task] = await tasksIn("Alias ordering")
    assert.equal(task.model, "gpt-6-sol")
    assert.equal(task.claude_config_id, earlier.id)
  } finally {
    await server.rpc("profiles.update", { id: profile.id, patch: { claude_config_ids: [claude.id, codex.id] } })
  }
})
