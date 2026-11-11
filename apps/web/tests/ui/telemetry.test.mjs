import assert from "node:assert/strict"
import { createServer } from "node:http"
import { afterAll, beforeAll, test } from "vite-plus/test"
import { startServer, withBrowser } from "./harness.mjs"

// The host's Telemetry section (the old tests/ui/telemetry.test.mjs), against a fake ClickHouse: a node:http server that
// records what it was sent. Until the host page is brought over (6.12), its placeholder shows the section.

let server
let clickhouse
/** What the fake ClickHouse was sent: each request's query and login. */
const seen = []
beforeAll(async () => {
  server = startServer()
  clickhouse = createServer((req, res) => {
    req.resume()
    req.on("end", () => {
      const q = new URL(req.url ?? "/", "http://x").searchParams.get("query") ?? ""
      seen.push({ query: q, user: req.headers["x-clickhouse-user"], key: req.headers["x-clickhouse-key"] })
      res.writeHead(200).end("")
    })
  })
  await new Promise((r) => clickhouse.listen(0, "127.0.0.1", r))
})
afterAll(() => {
  server?.stop()
  clickhouse?.close()
})

// HA-284: the host's Telemetry section saves where telemetry goes, keeps the password write-only, tests the login, and
// asks before turning it off (which deletes what's waiting).
test("Settings → the host's Telemetry section saves, tests and turns off", async () => {
  const url = `http://127.0.0.1:${clickhouse.address().port}`
  const host = { id: (await server.rpc("host.info")).host_id }
  await withBrowser(server, {}, async (ui) => {
    await ui.run([
      `goto /hosts/${host.id}`,
      "wait Telemetry",
      "wait Off",
      'click [placeholder="http://192.168.1.10:8123"]',
      `type ${url}`,
      'click [placeholder="huntaway_host"]',
      "type huntaway_test",
      'click css=section:has(h2:text-is("Telemetry")) >> input[type=password]',
      "type s3cret",
      'click css=section:has(h2:text-is("Telemetry")) >> role=button[name="Save"]',
      "wait Sending",
    ])
    const t = await server.rpc("admin.telemetry")
    assert.equal(t.url, url)
    assert.equal(t.user, "huntaway_test")
    assert.equal(t.has_password, true)
    assert.equal(t.password, undefined, "the password is never sent back")

    await ui.run(['click css=section:has(h2:text-is("Telemetry")) >> role=button[name="Test"]', "wait ClickHouse took a test insert"])
    const test_insert = seen.find((s) => s.query === "INSERT INTO events FORMAT JSONEachRow")
    assert.ok(test_insert, "the Test button inserted")
    assert.equal(test_insert.user, "huntaway_test")
    assert.equal(test_insert.key, "s3cret")

    // Saved values come back on a new page, the password only as a placeholder.
    await ui.run([`goto /hosts/${host.id}`, "wait Sending"])
    assert.equal(await ui.page.locator('[placeholder="http://192.168.1.10:8123"]').inputValue(), url)
    assert.equal(await ui.page.locator('section:has(h2:text-is("Telemetry")) input[type=password]').inputValue(), "")
    assert.equal(await ui.page.locator('section:has(h2:text-is("Telemetry")) input[type=password]').getAttribute("placeholder"), "Saved (type to change)")

    // Clearing the address asks first.
    await ui.run([
      'click [placeholder="http://192.168.1.10:8123"]',
      "press Control+a",
      "press Backspace",
      'click css=section:has(h2:text-is("Telemetry")) >> role=button[name="Save"]',
      "wait Stop sending this host's telemetry?",
      'click role=dialog >> role=button[name="Turn off"]',
      "gone Stop sending this host's telemetry?",
      "wait Off",
    ])
    assert.equal((await server.rpc("admin.telemetry")).url, null)
  })
})
