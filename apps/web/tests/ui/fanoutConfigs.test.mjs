import assert from "node:assert/strict"
import { mkdirSync } from "node:fs"
import { afterAll, beforeAll, test } from "vite-plus/test"
import { failure, gate, gitRepo, routeRpc, startServer, success, withBrowser } from "./harness.mjs"

// The old tests/ui/fanoutConfigs.test.mjs, both cases. The old checks answered `GET /claude-configs/<id>/models` with
// `page.route`; these answer `configs.models` on the RPC websocket (`routeRpc`), and see that nothing was created while
// the models were held from the calls the page made (the old check slept 300ms and read the tasks).
//
// Review of IA-227: with two Codex configs that both have a model, `!model` is the picked config's whatever order their
// models come in, so a prompt doesn't run with another login because its models answered first.
let server
let project
let work
let personal
beforeAll(async () => {
  server = startServer()
  const repo = `${server.dataDir}/shop`
  gitRepo(repo)
  const config = (name, agent) => {
    mkdirSync(`${server.dataDir}/${name}`, { recursive: true })
    return server.rpc("configs.create", { config: { name, config_dir: `${server.dataDir}/${name}`, ...(agent ? { agent } : {}) } })
  }
  const claude = await config("Claude")
  work = await config("Work", "codex")
  personal = await config("Personal", "codex")
  // Work first, so it's the one picked.
  const profile = await server.rpc("profiles.create", { profile: { name: "Default", claude_config_ids: [work.id, personal.id, claude.id] } })
  project = await server.rpc("projects.create", { project: { profile_id: profile.id, name: "Shop", repo_path: repo, key: "SHOP" } })
})
afterAll(() => server?.stop())

const MODELS = [{ id: "gpt-5.5", name: "GPT-5.5", is_default: true, efforts: ["low", "medium", "high"], default_effort: "medium" }]
const tasksIn = async (description) =>
  (await server.rpc("tasks.list", { filter: { _tag: "ByProject", project_id: project.id } })).filter((t) => t.description === description)
const modelsOf = (r, c) => r.tag === "configs.models" && r.payload.id === c.id

test("a model two configs have is the picked one's even when another's models come in first", async () => {
  await withBrowser(server, {}, async (ui) => {
    const held = gate()
    const calls = await routeRpc(ui.page, (r) => (modelsOf(r, work) ? held.hold() : modelsOf(r, personal) ? success(MODELS) : undefined))
    await ui.run([
      `goto /p/${project.id}`,
      "click New task",
      "type Before loading !gpt-5.5 !opus",
      "wait Loading Work's models, to see whether it has !gpt-5.5 too",
      "press Control+Enter",
      "wait It's created once they're in",
    ])
    assert.equal(calls.filter((c) => c.tag === "tasks.create").length, 0)
    held.release(success(MODELS))
    await ui.run(["gone Reads as"])
  })
  const gpt = (await tasksIn("Before loading")).find((t) => t.model === "gpt-5.5")
  assert.equal(gpt.claude_config_id, work.id)
})

test("if the picked config's models can't be fetched, a model another config has waits to be named with its config", async () => {
  await withBrowser(server, {}, async (ui) => {
    await routeRpc(ui.page, (r) =>
      modelsOf(r, work) ? failure({ _tag: "Unavailable", what: "codex", reason: "signed out" }) : modelsOf(r, personal) ? success(MODELS) : undefined,
    )
    await ui.run([
      `goto /p/${project.id}`,
      "click New task",
      "type Work down !gpt-5.5 !opus",
      "wait Couldn't load Work's models",
      "wait !gpt-5.5.personal",
      "assert document.querySelector('button[type=submit]').disabled",
      // Named with its config, it's Personal's.
      "press Control+a",
      "type Work down !gpt-5.5.personal !opus",
      "press Escape",
      "gone Couldn't load Work's models",
      "press Control+Enter",
      "gone Reads as",
    ])
  })
  const gpt = (await tasksIn("Work down")).find((t) => t.model === "gpt-5.5")
  assert.equal(gpt.claude_config_id, personal.id)
})
