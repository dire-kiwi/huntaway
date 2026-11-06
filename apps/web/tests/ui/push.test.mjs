import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { after, before, test } from "node:test";
import { demoProject, startServer, withBrowser } from "./harness.mjs";

let server, project, service;
before(async () => {
  server = startServer();
  project = await demoProject(server);
  service = await pushService();
});
after(() => {
  server?.stop();
  service?.close();
});

/** A push service on this machine: it keeps what the board posts to it. */
async function pushService() {
  const got = [];
  const waiting = [];
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const msg = { path: req.url, headers: req.headers, body: Buffer.concat(chunks) };
      const w = waiting.shift();
      if (w) w(msg);
      else got.push(msg);
      res.writeHead(201).end();
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${srv.address().port}`,
    /** The next push, or null after `ms`. */
    next: (ms = 10_000) =>
      got.length
        ? Promise.resolve(got.shift())
        : new Promise((resolve) => {
            const t = setTimeout(() => {
              waiting.splice(waiting.indexOf(done), 1);
              resolve(null);
            }, ms);
            const done = (m) => (clearTimeout(t), resolve(m));
            waiting.push(done);
          }),
    close: () => srv.close(),
  };
}

const b64 = (b) => Buffer.from(b).toString("base64url");

/** A device's keys, as its browser would make them. */
function deviceKeys() {
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  return { ecdh, auth: crypto.randomBytes(16) };
}

/** What the device's browser does with a push (RFC 8291). */
function decrypt({ ecdh, auth }, body) {
  const salt = body.subarray(0, 16);
  assert.equal(body.readUInt32BE(16), 4096);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const sealed = body.subarray(21 + idlen);
  const secret = ecdh.computeSecret(asPublic);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), ecdh.getPublicKey(), asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync("sha256", secret, auth, keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const d = crypto.createDecipheriv("aes-128-gcm", cek, nonce);
  d.setAuthTag(sealed.subarray(-16));
  const plain = Buffer.concat([d.update(sealed.subarray(0, -16)), d.final()]);
  assert.equal(plain.at(-1), 2);
  return JSON.parse(plain.subarray(0, -1).toString());
}

/**
 * Headless Chromium has no push service, so the page gets a stand-in subscription: `endpoint` at the push service
 * here, with the device's keys. It lasts over reloads, as a real one does.
 */
async function fakePush(page, endpoint, keys) {
  await page.context().grantPermissions(["notifications"]);
  await page.addInitScript(
    ([endpoint, p256dh, auth]) => {
      const KEY = "test.pushSubscription";
      const make = (key) => ({
        endpoint,
        options: { userVisibleOnly: true, applicationServerKey: new Uint8Array(key).buffer },
        toJSON: () => ({ endpoint, keys: { p256dh, auth } }),
        unsubscribe: async () => (localStorage.removeItem(KEY), true),
      });
      PushManager.prototype.getSubscription = async () => {
        const key = JSON.parse(localStorage.getItem(KEY) ?? "null");
        return key && make(key);
      };
      PushManager.prototype.subscribe = async ({ applicationServerKey }) => {
        const key = [...new Uint8Array(applicationServerKey)];
        localStorage.setItem(KEY, JSON.stringify(key));
        return make(key);
      };
    },
    [endpoint, b64(keys.ecdh.getPublicKey()), b64(keys.auth)],
  );
}

// HA-13: a device turns push on in Settings, and gets the board's notifications encrypted for it, each opening its task;
// not for a move the user made themselves, and not once it's turned off.
test("a device turns push on in Settings and gets the board's notifications", async () => {
  const keys = deviceKeys();
  const endpoint = `${service.url}/push/phone`;
  const tasks = await server.api("GET", `/projects/${project.id}/tasks`);
  const first = tasks.find((t) => t.status === "todo");
  const second = tasks.find((t) => t.status === "todo" && t.id !== first.id);
  const [host] = await server.api("GET", "/hosts");
  await withBrowser(server, { size: "390x844", touch: true }, async (ui) => {
    const { page } = ui;
    await fakePush(page, endpoint, keys);
    await ui.run(["goto /settings", "wait Push to this device", "click Turn on push for this device", "wait On for this device", "wait Send a test"]);
    const { subscriptions } = await server.api("GET", "/push");
    assert.equal(subscriptions.length, 1);
    assert.equal(subscriptions[0].endpoint, endpoint);
    assert.match(subscriptions[0].name, /^Chrome on \w+$/);
    // The events this browser notifies of, to start with.
    assert.deepEqual(subscriptions[0].events, { attention: true, review: true, merge: false, done: false, prompts: "assistant", replies: false, reports: true });

    // A test.
    await ui.run(["click Send a test", "wait It should show on this device"]);
    let push = await service.next();
    assert.equal(push.path, "/push/phone");
    assert.deepEqual(decrypt(keys, push.body), { title: "Huntaway", body: "Push notifications work on this device.", url: "/settings", tag: "test" });

    // A task that needs attention, as its agent moves it.
    await server.api("PATCH", `/tasks/${first.id}`, { status: "needs_attention" });
    push = await service.next();
    assert.equal(push.headers["content-encoding"], "aes128gcm");
    assert.equal(push.headers.urgency, "high");
    assert.match(push.headers.authorization, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
    assert.deepEqual(decrypt(keys, push.body), {
      title: `DEMO-${first.number} ${first.title}`,
      body: "Needs attention",
      url: `/t/${first.id}`,
      tag: `${host.id}:${first.id}`,
      task_id: first.id,
      event: "attention",
    });

    // One the user moves there themselves, from the board (through its proxy, as the UI does): none.
    await server.api("PATCH", `/h/${host.id}/tasks/${second.id}`, { status: "needs_attention" });
    assert.equal(await service.next(1500), null);

    // The device's own events: Done too, and not attention.
    await ui.run(["click role=group[name^='Events pushed to'] >> text=Done", "click role=group[name^='Events pushed to'] >> text=Needs attention", "sleep 300"]);
    const events = { attention: false, review: true, merge: false, done: true, prompts: "assistant", replies: false, reports: true };
    assert.deepEqual((await server.api("GET", "/push")).subscriptions[0].events, events);
    // The assistant's replies (HA-162) and its routines' reports, kept over a reload.
    await ui.run(["click role=group[name^='Events pushed to'] >> text=Routine reports", "click role=group[name^='Events pushed to'] >> text=Assistant's replies", "sleep 300"]);
    assert.deepEqual((await server.api("GET", "/push")).subscriptions[0].events, { ...events, replies: true, reports: false });
    await ui.run(["goto /settings", "wait On for this device"]);
    assert.equal(await ui.page.getByRole("checkbox", { name: /Routine reports/ }).isChecked(), false);
    assert.equal(await ui.page.getByRole("checkbox", { name: /Assistant's replies/ }).isChecked(), true);
    // And whose permission prompts.
    await ui.page.getByLabel(/^Permission prompts pushed to/).selectOption("all");
    await ui.run(["sleep 300"]);
    assert.equal((await server.api("GET", "/push")).subscriptions[0].events.prompts, "all");
    await ui.run(["goto /settings", "wait On for this device"]);
    assert.equal(await ui.page.getByLabel(/^Permission prompts pushed to/).inputValue(), "all");
    await server.api("PATCH", `/tasks/${first.id}`, { status: "in_progress" });
    await server.api("PATCH", `/tasks/${first.id}`, { status: "needs_attention" });
    await server.api("PATCH", `/tasks/${first.id}`, { status: "done" });
    push = await service.next();
    assert.equal(decrypt(keys, push.body).body, "Done");
    assert.equal(push.headers.urgency, "normal");

    // Over a reload it's still on for this device; turned off, the board forgets it.
    await ui.run(["goto /settings", "wait On for this device", "click Turn off", "wait Turn on push for this device"]);
    assert.deepEqual((await server.api("GET", "/push")).subscriptions, []);
    await server.api("PATCH", `/tasks/${second.id}`, { status: "todo" });
    await server.api("PATCH", `/tasks/${second.id}`, { status: "needs_attention" });
    assert.equal(await service.next(1500), null);
  });
});

// HA-13: what's installable: the manifest, its icons and the service worker, which caches nothing.
test("the board is installable, and its service worker caches nothing", async () => {
  const manifest = await (await fetch(`${server.url}/manifest.webmanifest`)).json();
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.start_url, "/");
  for (const icon of manifest.icons) {
    const res = await fetch(`${server.url}${icon.src}`);
    assert.equal(res.status, 200, icon.src);
    assert.equal(res.headers.get("content-type"), icon.type, icon.src);
  }
  assert.ok(manifest.icons.some((i) => i.purpose === "maskable" && i.sizes === "512x512"));
  const sw = await fetch(`${server.url}/sw.js`);
  assert.equal(sw.headers.get("cache-control"), "no-cache");
  const source = await sw.text();
  assert.doesNotMatch(source, /addEventListener\("fetch"|caches\./);

  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    await ui.run([`goto /p/${project.id}`, "wait Demo"]);
    assert.equal(await page.evaluate(() => navigator.serviceWorker.ready.then((r) => new URL(r.active.scriptURL).pathname)), "/sw.js");
    assert.equal(await page.evaluate(() => document.querySelector("link[rel=manifest]").getAttribute("href")), "/manifest.webmanifest");
  });
});

// HA-13: the service worker shows a push as a notification, and tapping one opens its task in the board's window.
test("a push shows a notification, and a tap opens its task", async () => {
  const tasks = await server.api("GET", `/projects/${project.id}/tasks`);
  const t = tasks.find((x) => x.status === "in_review");
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    await page.context().grantPermissions(["notifications"]);
    await ui.run([`goto /p/${project.id}`, "wait Demo"]);
    await page.evaluate(() => navigator.serviceWorker.ready);
    // From the service worker, as its push and click events would run it.
    const sw = page.context().serviceWorkers()[0] ?? (await page.context().waitForEvent("serviceworker"));
    const shown = await sw.evaluate(async () => {
      await self.registration.showNotification("Huntaway", { body: "test", tag: "x", data: { url: "/settings" } });
      return (await self.registration.getNotifications()).map((n) => n.title);
    });
    assert.deepEqual(shown, ["Huntaway"]);
    // A tap on a task's notification, with the board open: the page opens the task without loading again. Dispatched
    // to the worker's own notificationclick handler, as a tap on the notification's body is.
    await page.evaluate(() => (window.loadedOnce = true));
    const errors = [];
    sw.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    await sw.evaluate(async ([id]) => {
      self.__errors = [];
      self.addEventListener("error", (e) => self.__errors.push(String(e.message)));
      self.addEventListener("unhandledrejection", (e) => self.__errors.push(String(e.reason)));
      await self.registration.showNotification("DEMO-1 A task", { body: "Needs attention", tag: "tap", data: { url: `/t/${id}`, task_id: id } });
      const [n] = await self.registration.getNotifications({ tag: "tap" });
      const waits = [];
      const e = new Event("notificationclick");
      Object.assign(e, { notification: n, action: "", waitUntil: (p) => waits.push(p) });
      self.dispatchEvent(e);
      await Promise.all(waits);
    }, [t.id]);
    // Not its title, which its card on the board already shows.
    await page.waitForURL((url) => url.searchParams.get("task") === t.id);
    assert.equal(await page.evaluate(() => window.loadedOnce), true);
    assert.deepEqual([errors, await sw.evaluate(() => self.__errors)], [[], []]);
  });
});

// HA-126: a permission prompt's notification has Allow and Deny, which post its one-time token (never the board's) and
// show how that went in its place; one that couldn't reach the board keeps its buttons to try again.
test("a prompt's notification answers it with its token, and says how that went", async () => {
  const tasks = await server.api("GET", `/projects/${project.id}/tasks`);
  const t = tasks[0];
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    await page.context().grantPermissions(["notifications"]);
    await ui.run([`goto /p/${project.id}`, "wait Demo"]);
    await page.evaluate(() => navigator.serviceWorker.ready);
    const sw = page.context().serviceWorkers()[0] ?? (await page.context().waitForEvent("serviceworker"));
    // What the worker posts, as the board gets it.
    const posted = [];
    await page.context().route(/\/push-answer$/, async (route) => {
      const req = route.request();
      posted.push({ url: new URL(req.url()).pathname, body: req.postDataJSON(), auth: req.headers().authorization });
      await route.continue();
    });
    const msg = {
      title: `DEMO-${t.number} ${t.title}`,
      body: "Approve Bash?",
      url: `/t/${t.id}`,
      tag: `h:${t.id}:req-1`,
      task_id: t.id,
      event: "prompt",
      request_id: "req-1",
      answer: { url: "/api/permissions/req-1/push-answer", token: "one-time" },
    };
    const notes = () =>
      sw.evaluate(async () =>
        (await self.registration.getNotifications()).map((n) => ({ body: n.body, tag: n.tag, actions: n.actions.map((a) => a.action), data: n.data })),
      );
    // Shown with Allow and Deny (the board isn't in front: it's another tab's page that's focused).
    await sw.evaluate((m) => show(m, true), msg);
    let [n] = await notes();
    assert.deepEqual([n.body, n.tag, n.actions], ["Approve Bash?", msg.tag, ["allow", "deny"]]);
    assert.deepEqual(n.data.answer, msg.answer);

    // Deny: the board doesn't know the token (there's no such prompt), and the notification says so in its place.
    await sw.evaluate((data) => answer(data, "deny"), n.data);
    assert.deepEqual(posted, [{ url: "/api/permissions/req-1/push-answer", body: { token: "one-time", decision: "deny" }, auth: undefined }]);
    [n] = await notes();
    assert.deepEqual([n.body, n.tag, n.actions], ["This notification can't answer that prompt.", msg.tag, []]);
    assert.equal(n.data.task_id, t.id);

    // A board that can't be reached: the prompt again, with why, and its buttons to try again.
    await sw.evaluate((data) => answer({ ...data, answer: { ...data.answer, url: "http://127.0.0.1:9/push-answer" } }, "allow"), msg);
    [n] = await notes();
    assert.match(n.body, /can't be reached/);
    assert.deepEqual(n.actions, ["allow", "deny"]);

    // Allowed: what the board answers is shown.
    await page.context().unroute(/\/push-answer$/);
    await page.context().route(/\/push-answer$/, (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ result: "allowed", message: "Allowed." }) }));
    await sw.evaluate((data) => answer(data, "allow"), msg);
    [n] = await notes();
    assert.deepEqual([n.body, n.actions], ["Allowed.", []]);
  });
});

// HA-13: Settings says why push can't work on a page that isn't secure.
test("Settings says push needs HTTPS on a plain HTTP address", async () => {
  await withBrowser(server, {}, async (ui) => {
    // As on a plain-HTTP LAN address.
    await ui.page.addInitScript(() => Object.defineProperty(window, "isSecureContext", { value: false }));
    await ui.run(["goto /settings", "wait Push to this device", "wait Push needs the board on HTTPS"]);
    assert.equal(await ui.page.getByRole("button", { name: "Turn on push for this device" }).count(), 0);
  });
});

// HA-13: a hub pushes the notifications of its linked hosts' tasks too, from the first change after they connect.
test("a hub pushes its linked hosts' notifications", async () => {
  const fs = await import("node:fs");
  const hubToken = fs.readFileSync(`${server.dataDir}/hub_token`, "utf8").trim();
  const host = startServer("--hub", server.url, "--hub-token", hubToken);
  try {
    const [info] = await host.api("GET", "/hosts").then((hs) => hs.filter((h) => h.local));
    // Linked once the hub lists it as connected.
    for (let i = 0; ; i++) {
      const linked = (await server.api("GET", "/hosts")).find((h) => h.id === info.id);
      if (linked?.connected) break;
      assert.ok(i < 100, "the host didn't connect to the hub");
      await new Promise((r) => setTimeout(r, 100));
    }
    const keys = deviceKeys();
    await server.api("POST", "/push/subscriptions", {
      endpoint: `${service.url}/push/hub-phone`,
      keys: { p256dh: b64(keys.ecdh.getPublicKey()), auth: b64(keys.auth) },
      name: "phone",
    });
    // A task on the linked host, changed there (as its agent would).
    const [profile] = await host.api("GET", "/profiles");
    const [remote] = await host.api("GET", `/profiles/${profile.id}/projects`);
    const t = (await host.api("GET", `/projects/${remote.id}/tasks`)).find((x) => x.status === "in_progress");
    await host.api("PATCH", `/tasks/${t.id}`, { status: "needs_attention" });
    let push;
    while ((push = await service.next()) && push.path !== "/push/hub-phone");
    assert.ok(push, "no push from the linked host's task");
    assert.deepEqual(decrypt(keys, push.body), {
      title: `${remote.key}-${t.number} ${t.title}`,
      body: "Needs attention",
      url: `/t/${t.id}`,
      tag: `${info.id}:${t.id}`,
      task_id: t.id,
      event: "attention",
    });
  } finally {
    host.stop();
  }
});
