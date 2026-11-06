import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { startServer, withBrowser } from "./harness.mjs";

// HA-167: a Claude config's proxy (CLIProxyAPI). Its keys never come back to the board, so the edit dialog's key fields
// start blank, and saving it without typing them must keep them; taking the URL away clears them too.
let server;
let config;
before(async () => {
  server = startServer();
  config = await server.api("POST", "/claude-configs", {
    name: "Pool",
    config_dir: `${server.dataDir}/pool`,
    api_url: "http://10.9.8.7:8317",
    api_key: "sk-secret",
    management_key: "mk-secret",
  });
});
after(() => server?.stop());

const URL_FIELD = "[placeholder='http://192.168.1.10:8317']";
const saved = async () => (await server.api("GET", "/claude-configs")).find((c) => c.id === config.id);
/** Opens the Pool config's edit dialog in Settings. */
const edit = ["goto /settings", "wait Pool", "click css=div.rounded-xl:has(> div:text-is('Pool')) >> role=button[name='Edit']", "wait Proxy API key"];

test("the proxy's keys aren't shown, and saving without them keeps them", async () => {
  await withBrowser(server, {}, async (ui) => {
    await ui.run(edit);
    assert.equal(await ui.page.inputValue("[placeholder='Saved; type a new one to replace it'] >> nth=0"), "");
    assert.equal(await ui.page.locator("[placeholder='Saved; type a new one to replace it']").count(), 2);
    await ui.run(["click Save", "gone Proxy API key"]);
  });
  const c = await saved();
  assert.deepEqual([c.api_url, c.has_api_key, c.has_management_key, c.api_key], ["http://10.9.8.7:8317", true, true, undefined]);
});

test("taking the proxy's URL away clears its keys", async () => {
  await withBrowser(server, {}, async (ui) => {
    await ui.run([...edit, `click ${URL_FIELD}`, "press Control+a", "press Backspace", "gone Proxy API key", "click Save", "gone Edit config"]);
  });
  const c = await saved();
  assert.deepEqual([c.api_url, c.has_api_key, c.has_management_key], [null, false, false]);
});
