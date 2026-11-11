import assert from "node:assert/strict"
import crypto from "node:crypto"
import http from "node:http"
import { afterAll, beforeAll, test } from "vite-plus/test"
import { eventually, makeTask, seedBoard, startServer, withBrowser } from "./harness.mjs"

// Web Push (the old tests/ui/push.test.mjs): a device turns push on in Settings and gets the board's notifications,
// encrypted for it, from a push service on this machine. The server's agent is the fake `claude`, whose permission
// prompts move a task to Needs attention as an agent's would: a move the user makes (`tasks.update`) doesn't push.
//
// Not ported: "a prompt's notification answers it with its token" (answering from a notification waits for the phone
// app, docs/plan/14-dropped-and-open.md) and "a hub pushes its linked hosts' notifications" (hosts are M7).

let server, board, service
beforeAll(async () => {
  server = startServer("--fake-claude")
  board = await seedBoard(server, [{ title: "Moved by hand", status: "todo" }])
  service = await pushService()
})
afterAll(() => {
  server?.stop()
  service?.close()
})

/** A push service on this machine: it keeps what the board posts to it. */
async function pushService() {
  const got = []
  const waiting = []
  const srv = http.createServer((req, res) => {
    const chunks = []
    req.on("data", (c) => chunks.push(c))
    req.on("end", () => {
      const msg = { path: req.url, headers: req.headers, body: Buffer.concat(chunks) }
      const w = waiting.shift()
      if (w) w(msg)
      else got.push(msg)
      res.writeHead(201).end()
    })
  })
  await new Promise((r) => srv.listen(0, "127.0.0.1", r))
  return {
    url: `http://127.0.0.1:${srv.address().port}`,
    /** The next push, or null after `ms`. */
    next: (ms = 10_000) =>
      got.length
        ? Promise.resolve(got.shift())
        : new Promise((resolve) => {
            const t = setTimeout(() => {
              waiting.splice(waiting.indexOf(done), 1)
              resolve(null)
            }, ms)
            const done = (m) => (clearTimeout(t), resolve(m))
            waiting.push(done)
          }),
    close: () => srv.close(),
  }
}

const b64 = (b) => Buffer.from(b).toString("base64url")

/** A device's keys, as its browser would make them. */
function deviceKeys() {
  const ecdh = crypto.createECDH("prime256v1")
  ecdh.generateKeys()
  return { ecdh, auth: crypto.randomBytes(16) }
}

/** What the device's browser does with a push (RFC 8291). */
function decrypt({ ecdh, auth }, body) {
  const salt = body.subarray(0, 16)
  assert.equal(body.readUInt32BE(16), 4096)
  const idlen = body[20]
  const asPublic = body.subarray(21, 21 + idlen)
  const sealed = body.subarray(21 + idlen)
  const secret = ecdh.computeSecret(asPublic)
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), ecdh.getPublicKey(), asPublic])
  const ikm = Buffer.from(crypto.hkdfSync("sha256", secret, auth, keyInfo, 32))
  const cek = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16))
  const nonce = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12))
  const d = crypto.createDecipheriv("aes-128-gcm", cek, nonce)
  d.setAuthTag(sealed.subarray(-16))
  const plain = Buffer.concat([d.update(sealed.subarray(0, -16)), d.final()])
  assert.equal(plain.at(-1), 2)
  return JSON.parse(plain.subarray(0, -1).toString())
}

/**
 * Headless Chromium has no push service, so the page gets a stand-in subscription: `endpoint` at the push service
 * here, with the device's keys. It lasts over reloads, as a real one does.
 */
async function fakePush(page, endpoint, keys) {
  await page.context().grantPermissions(["notifications"])
  await page.addInitScript(
    ([url, p256dh, auth]) => {
      const KEY = "test.pushSubscription"
      const make = (key) => ({
        endpoint: url,
        options: { userVisibleOnly: true, applicationServerKey: new Uint8Array(key).buffer },
        toJSON: () => ({ endpoint: url, keys: { p256dh, auth } }),
        unsubscribe: async () => (localStorage.removeItem(KEY), true),
      })
      PushManager.prototype.getSubscription = async () => {
        const key = JSON.parse(localStorage.getItem(KEY) ?? "null")
        return key && make(key)
      }
      PushManager.prototype.subscribe = async ({ applicationServerKey }) => {
        const key = [...new Uint8Array(applicationServerKey)]
        localStorage.setItem(KEY, JSON.stringify(key))
        return make(key)
      }
    },
    [endpoint, b64(keys.ecdh.getPublicKey()), b64(keys.auth)],
  )
}

/** A task whose agent (the fake one) asks to run Bash: the board moves it to Needs attention. */
async function asking(title) {
  const task = await makeTask(server, board.project, { title })
  await server.rpc("tasks.send", { id: task.id, text: "Please fake-ask-permission" })
  return task
}

const pushes = () => server.rpc("hub.push.info").then((i) => i.subscriptions)

// HA-13: a device turns push on in Settings, and gets the board's notifications encrypted for it, each opening its task;
// not for a move the user made themselves, and not once it's turned off.
test("a device turns push on in Settings and gets the board's notifications", async () => {
  const keys = deviceKeys()
  const endpoint = `${service.url}/push/phone`
  const { host_id } = await server.rpc("host.info")
  await withBrowser(server, { fullBrowser: true, size: "390x844", touch: true }, async (ui) => {
    const { page } = ui
    await fakePush(page, endpoint, keys)
    await ui.run([
      "goto /settings/notifications",
      "wait Push to this device",
      "click Turn on push for this device",
      "wait On for this device",
      "wait Send a test",
    ])
    const subscriptions = await pushes()
    assert.equal(subscriptions.length, 1)
    assert.equal(subscriptions[0].endpoint, endpoint)
    assert.match(subscriptions[0].name, /^Chrome on \w+$/)
    // The events this browser notifies of, to start with.
    assert.deepEqual(subscriptions[0].events, { attention: true, review: true, merge: false, done: false, prompts: "assistant", replies: false, reports: true })

    // A test.
    await ui.run(["click Send a test", "wait It should show on this device"])
    let push = await service.next()
    assert.equal(push.path, "/push/phone")
    assert.deepEqual(decrypt(keys, push.body), {
      title: "Huntaway",
      body: "Push notifications work on this device.",
      url: "/settings/notifications",
      tag: "test",
    })

    // A task that needs attention, as its agent asks for a permission (a project task's prompt itself isn't pushed by default).
    const first = await asking("Push: asks")
    push = await service.next()
    assert.equal(push.headers["content-encoding"], "aes128gcm")
    assert.equal(push.headers.urgency, "high")
    assert.match(push.headers.authorization, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/)
    const msg = decrypt(keys, push.body)
    // Its title is the task's key and title (the fake agent's runs give it one of their own).
    const { title } = await server.rpc("tasks.get", { id: first.id })
    assert.deepEqual(
      { ...msg, body: undefined },
      {
        title: `DEM-${first.number} ${title}`,
        body: undefined,
        url: `/t/${first.id}`,
        tag: `${host_id}:${first.id}`,
        task_id: first.id,
        event: "attention",
      },
    )
    assert.match(msg.body, /^Needs attention/)

    // One the user moves there themselves: none.
    await server.rpc("tasks.update", { id: board.tasks[0].id, patch: { status: "needs_attention" } })
    assert.equal(await service.next(1500), null)

    // The device's own events: Done too, and not attention.
    await ui.run(["click role=group[name^='Events pushed to'] >> text=Done", "click role=group[name^='Events pushed to'] >> text=Needs attention"])
    const events = { attention: false, review: true, merge: false, done: true, prompts: "assistant", replies: false, reports: true }
    await eventually(async () => assert.deepEqual((await pushes())[0].events, events))
    // The assistant's replies and its routines' reports, kept over a reload.
    await ui.run([
      "click role=group[name^='Events pushed to'] >> text=Routine reports",
      "click role=group[name^='Events pushed to'] >> text=Assistant's replies",
    ])
    await eventually(async () => assert.deepEqual((await pushes())[0].events, { ...events, replies: true, reports: false }))
    await ui.run(["goto /settings/notifications", "wait On for this device"])
    assert.equal(await page.getByRole("checkbox", { name: /Routine reports/ }).isChecked(), false)
    assert.equal(await page.getByRole("checkbox", { name: /Assistant's replies/ }).isChecked(), true)
    // And whose permission prompts: every task's, which a prompt then is, without its needs-attention.
    await page.getByLabel(/^Permission prompts pushed to/).selectOption("all")
    await eventually(async () => assert.equal((await pushes())[0].events.prompts, "all"))
    await ui.run(["goto /settings/notifications", "wait On for this device"])
    assert.equal(await page.getByLabel(/^Permission prompts pushed to/).inputValue(), "all")
    const second = await asking("Push: asks again")
    push = await service.next()
    const prompt = decrypt(keys, push.body)
    assert.deepEqual([prompt.event, prompt.body, prompt.task_id, prompt.answer], ["prompt", "Approve Bash?", second.id, undefined])
    assert.equal(push.headers.urgency, "high")

    // Over a reload it's still on for this device; turned off, the board forgets it.
    await ui.run(["goto /settings/notifications", "wait On for this device", "click Turn off", "wait Turn on push for this device"])
    assert.deepEqual(await pushes(), [])
    await asking("Push: asks once off")
    assert.equal(await service.next(1500), null)
  })
})

// HA-13: what's installable: the manifest, its icons and the service worker, which caches nothing.
test("the board is installable, and its service worker caches nothing", async () => {
  const manifest = await (await fetch(`${server.url}/manifest.webmanifest`)).json()
  assert.equal(manifest.display, "standalone")
  assert.equal(manifest.start_url, "/")
  for (const icon of manifest.icons) {
    const res = await fetch(`${server.url}${icon.src}`)
    assert.equal(res.status, 200, icon.src)
    assert.equal(res.headers.get("content-type")?.split(";")[0], icon.type, icon.src)
  }
  assert.ok(manifest.icons.some((i) => i.purpose === "maskable" && i.sizes === "512x512"))
  const sw = await fetch(`${server.url}/sw.js`)
  assert.equal(sw.headers.get("cache-control"), "no-cache")
  const source = await sw.text()
  assert.doesNotMatch(source, /addEventListener\("fetch"|caches\./)

  await withBrowser(server, { fullBrowser: true }, async (ui) => {
    const { page } = ui
    await ui.run([`goto /p/${board.project.id}`, "wait Moved by hand"])
    assert.equal(await page.evaluate(() => navigator.serviceWorker.ready.then((r) => new URL(r.active.scriptURL).pathname)), "/sw.js")
    assert.equal(await page.evaluate(() => document.querySelector("link[rel=manifest]").getAttribute("href")), "/manifest.webmanifest")
  })
})

// HA-13: the service worker shows a push as a notification, and tapping one opens its task in the board's window.
test("a push shows a notification, and a tap opens its task", async () => {
  const t = board.tasks[0]
  await withBrowser(server, { fullBrowser: true }, async (ui) => {
    const { page } = ui
    await page.context().grantPermissions(["notifications"])
    await ui.run([`goto /p/${board.project.id}`, "wait Moved by hand"])
    await page.evaluate(() => navigator.serviceWorker.ready)
    // From the service worker, as its push and click events would run it.
    const sw = page.context().serviceWorkers()[0] ?? (await page.context().waitForEvent("serviceworker"))
    const shown = await sw.evaluate(async () => {
      await self.registration.showNotification("Huntaway", { body: "test", tag: "x", data: { url: "/settings" } })
      return (await self.registration.getNotifications()).map((n) => n.title)
    })
    assert.deepEqual(shown, ["Huntaway"])
    // A tap on a task's notification, with the board open: the page opens the task without loading again. Dispatched
    // to the worker's own notificationclick handler, as a tap on the notification's body is.
    await page.evaluate(() => (window.loadedOnce = true))
    const errors = []
    sw.on("console", (m) => m.type() === "error" && errors.push(m.text()))
    await sw.evaluate(
      async ([id]) => {
        self.__errors = []
        self.addEventListener("error", (e) => self.__errors.push(e.message))
        self.addEventListener("unhandledrejection", (e) => self.__errors.push(`${e.reason}`))
        await self.registration.showNotification("DEM-1 A task", { body: "Needs attention", tag: "tap", data: { url: `/t/${id}`, task_id: id } })
        const [n] = await self.registration.getNotifications({ tag: "tap" })
        const waits = []
        const e = new Event("notificationclick")
        Object.assign(e, { notification: n, action: "", waitUntil: (p) => waits.push(p) })
        self.dispatchEvent(e)
        await Promise.all(waits)
      },
      [t.id],
    )
    await page.waitForURL((url) => url.searchParams.get("task") === t.id)
    assert.equal(await page.evaluate(() => window.loadedOnce), true)
    assert.deepEqual([errors, await sw.evaluate(() => self.__errors)], [[], []])
  })
})

// HA-13: Settings says why push can't work on a page that isn't secure.
test("Settings says push needs HTTPS on a plain HTTP address", async () => {
  await withBrowser(server, { fullBrowser: true }, async (ui) => {
    // As on a plain-HTTP LAN address.
    await ui.page.addInitScript(() => Object.defineProperty(window, "isSecureContext", { value: false }))
    await ui.run(["goto /settings/notifications", "wait Push to this device", "wait Push needs the board on HTTPS"])
    assert.equal(await ui.page.getByRole("button", { name: "Turn on push for this device" }).count(), 0)
  })
})
