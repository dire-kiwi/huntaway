import assert from "node:assert/strict"
import { mkdirSync } from "node:fs"
import { afterAll, beforeAll, test } from "vite-plus/test"
import { failure, gitRepo, routeRpc, startServer, success, withBrowser } from "./harness.mjs"

// HE-69: an ACP config, for an agent that speaks the Agent Client Protocol (Google's Antigravity, `agy acp`, by default).
// The config form asks for its command, which is kept, blank for the default; its models are the ones its host lists
// (answered here on the RPC websocket, as the test server runs no ACP agent), never Claude's aliases. A server whose
// agents run, the fake's: Settings has Agent configs only for a host that runs agents.
let server
let profile
let project
let claude
beforeAll(async () => {
  server = startServer("--fake-claude")
  const repo = `${server.dataDir}/shop`
  gitRepo(repo)
  mkdirSync(`${server.dataDir}/claude`, { recursive: true })
  claude = await server.rpc("configs.create", { config: { name: "Claude", config_dir: `${server.dataDir}/claude` } })
  profile = await server.rpc("profiles.create", { profile: { name: "Default", claude_config_ids: [claude.id] } })
  project = await server.rpc("projects.create", { project: { profile_id: profile.id, name: "Shop", repo_path: repo, key: "SHOP" } })
})
afterAll(() => server?.stop())

const MODELS = [
  { id: "gemini-3-pro", name: "Gemini 3 Pro", description: null, is_default: true, efforts: [], default_effort: null },
  { id: "gemini-3-flash", name: "Gemini 3 Flash", description: null, is_default: false, efforts: [], default_effort: null },
]
const saved = async (name) => (await server.rpc("configs.list")).find((c) => c.name === name)
/** A config's card in Settings → Agent configs. */
const card = (name) => `css=div.rounded-xl:has(> div:text-is('${name}'))`

test("an ACP config is added with its command, and taking the command away runs the default", async () => {
  let calls = []
  await withBrowser(server, {}, async (ui) => {
    calls = await routeRpc(ui.page)
    await ui.run([
      "goto /settings/configs",
      "wait Agent configs",
      "click role=button[name='Add config']",
      "wait Add config on",
      "click [placeholder='work / personal']",
      "type Gemini",
    ])
    // Only an ACP config has a command.
    assert.equal(await ui.page.locator("[placeholder='agy acp']").count(), 0)
    await ui.run([
      "click ACP agent (Antigravity)",
      "wait role=button[name='Help: Command']",
      "click [placeholder='agy acp']",
      "type gemini --experimental-acp",
      "click css=div.space-y-3 >> role=button[name='Add config']",
      "gone Add config on",
      // The row says what it runs, beside its badge.
      `wait ${card("Gemini")} >> text=gemini --experimental-acp`,
      `wait ${card("Gemini")} >> text=ACP`,
    ])
  })
  const made = calls.find((c) => c.tag === "configs.create")?.payload.config
  assert.deepEqual([made?.agent, made?.command, made?.config_dir], ["acp", "gemini --experimental-acp", ""])
  const c = await saved("Gemini")
  assert.deepEqual([c.agent, c.command, c.config_dir, c.api_url], ["acp", "gemini --experimental-acp", "", null])

  await withBrowser(server, {}, async (ui) => {
    await ui.run([
      "goto /settings/configs",
      `click ${card("Gemini")} >> role=button[name='Edit']`,
      "wait Edit config",
      "click [placeholder='agy acp']",
      "press Control+a",
      "press Backspace",
      "click Save",
      "gone Edit config",
      `wait ${card("Gemini")} >> text=agy acp`,
    ])
  })
  assert.equal((await saved("Gemini")).command, null)
})

test("an ACP config offers the models it lists, and says when they couldn't be listed", async () => {
  const gemini = await server.rpc("configs.create", { config: { name: "Antigravity", config_dir: "", agent: "acp" } })
  await server.rpc("profiles.update", { id: profile.id, patch: { claude_config_ids: [claude.id, gemini.id] } })
  const isModels = (r) => r.tag === "configs.models" && r.payload.id === gemini.id
  await withBrowser(server, {}, async (ui) => {
    await routeRpc(ui.page, (r) => (isModels(r) ? success(MODELS) : undefined))
    await ui.run([`goto /p/${project.id}`, "click New task", "type Listed !gemini-3", "wait Gemini 3 Pro · Antigravity", "wait Gemini 3 Flash · Antigravity"])
    // Claude's aliases are the Claude config's alone.
    await ui.run(["press Control+a", "press Backspace", "type Aliases !op", "wait Opus · Claude"])
    assert.equal(await ui.page.getByText("Opus · Antigravity").count(), 0)
  })
  await withBrowser(server, {}, async (ui) => {
    await routeRpc(ui.page, (r) => (isModels(r) ? failure({ _tag: "Unavailable", what: "acp", reason: "sign in by running agy once" }) : undefined))
    await ui.run([
      `goto /p/${project.id}`,
      "click New task",
      "type Signed out !gemini-3-pro",
      "wait Couldn't load Antigravity's models (sign in by running agy once)",
    ])
  })
})
