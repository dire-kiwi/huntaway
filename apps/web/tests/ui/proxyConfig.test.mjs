import assert from "node:assert/strict"
import { mkdirSync, writeFileSync } from "node:fs"
import { afterAll, beforeAll, test } from "vite-plus/test"
import { makeProfile, startServer, withBrowser } from "./harness.mjs"

// HA-167: a Claude config's proxy (CLIProxyAPI). Its keys never come back to the board, so the edit dialog's key fields
// start blank, and saving it without typing them must keep them; taking the URL away clears them too. (A server whose
// agents run, the fake's: Settings has Agent configs only for a host that runs agents.)
let server
let config
beforeAll(async () => {
  server = startServer("--fake-claude")
  await makeProfile(server, "Default")
  config = await server.rpc("configs.create", {
    config: { name: "Pool", config_dir: `${server.dataDir}/pool`, api_url: "http://10.9.8.7:8317", api_key: "sk-secret", management_key: "mk-secret" },
  })
})
afterAll(() => server?.stop())

const URL_FIELD = "[placeholder='http://192.168.1.10:8317']"
const saved = async (id = config.id) => (await server.rpc("configs.list")).find((c) => c.id === id)
/** Opens a config's edit dialog in Settings. */
const edit = (name) => [
  "goto /settings/configs",
  `wait ${name}`,
  `click css=div.rounded-xl:has(> div:text-is('${name}')) >> role=button[name='Edit']`,
  "wait Edit config",
]

test("the proxy's keys aren't shown, and saving without them keeps them", async () => {
  await withBrowser(server, {}, async (ui) => {
    await ui.run([...edit("Pool"), "wait Proxy API key"])
    assert.equal(await ui.page.inputValue("[placeholder='Saved; type a new one to replace it'] >> nth=0"), "")
    assert.equal(await ui.page.locator("[placeholder='Saved; type a new one to replace it']").count(), 2)
    await ui.run(["click Save", "gone Proxy API key"])
  })
  const c = await saved()
  assert.deepEqual([c.api_url, c.has_api_key, c.has_management_key, c.api_key], ["http://10.9.8.7:8317", true, true, undefined])
})

test("taking the proxy's URL away clears its keys", async () => {
  await withBrowser(server, {}, async (ui) => {
    await ui.run([
      ...edit("Pool"),
      "wait Proxy API key",
      `click ${URL_FIELD}`,
      "press Control+a",
      "press Backspace",
      "gone Proxy API key",
      "click Save",
      "gone Edit config",
    ])
  })
  const c = await saved()
  assert.deepEqual([c.api_url, c.has_api_key, c.has_management_key], [null, false, false])
})

// HA-343: a config whose settings.json sends Claude Code to a proxy has its usage read from it, which needs the
// management key, without a proxy of the board's own.
test("a proxy set in settings.json takes the management key alone", async () => {
  const dir = `${server.dataDir}/personal`
  mkdirSync(dir, { recursive: true })
  writeFileSync(`${dir}/settings.json`, JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://10.9.8.6:8317", ANTHROPIC_AUTH_TOKEN: "sk" } }))
  const personal = await server.rpc("configs.create", { config: { name: "Personal", config_dir: dir } })
  assert.equal(personal.settings_api_url, "http://10.9.8.6:8317")
  await withBrowser(server, {}, async (ui) => {
    await ui.run([
      ...edit("Personal"),
      "wait http://10.9.8.6:8317",
      "gone Proxy API key",
      "click css=input[type=password]",
      "type mk-personal",
      "click Save",
      "gone Edit config",
    ])
  })
  const c = await saved(personal.id)
  assert.deepEqual([c.api_url, c.has_api_key, c.has_management_key], [null, false, true])
})
