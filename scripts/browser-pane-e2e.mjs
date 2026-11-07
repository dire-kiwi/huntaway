#!/usr/bin/env node
// Drives the desktop app's browser pane (HA-275) in this checkout's Electron, headless:
//
//   scripts/test-server.sh --demo --no-agents > $TMPDIR/env && pnpm build
//   node scripts/browser-pane-e2e.mjs --env $TMPDIR/env
//
// The app (apps/web, as `pnpm electron` runs it) attaches to the test server (IA_PORT, IA_DATA_DIR for its token), with
// a config dir of its own, so it never touches the live board. A small site on 127.0.0.1 is what the pane browses. It
// opens the Demo project's first task, then checks the pane: what the page can reach, links, history, popups,
// schemes it refuses, the session every <webview> gets, its place in a narrow and a wide window, resizing, and what's kept across closing it and other tasks.
// Electron's binary: `node apps/web/node_modules/electron/install.js` if pnpm didn't fetch it. Exits 1 on a failed check.
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const web = path.join(root, "apps/web");
const args = process.argv.slice(2);
const envFile = args.includes("--env") ? args[args.indexOf("--env") + 1] : process.env.IA_TEST_ENV;
if (!envFile) {
  console.error("usage: node scripts/browser-pane-e2e.mjs --env <test-server.sh's output>");
  process.exit(2);
}
const env = Object.fromEntries(
  fs
    .readFileSync(envFile, "utf8")
    .split("\n")
    .filter((l) => l.startsWith("export "))
    .map((l) => l.slice(7).split("=")),
);
const electronBin = path.join(web, "node_modules/electron/dist/electron");
if (!fs.existsSync(electronBin)) {
  console.error(`no Electron at ${electronBin}: run node apps/web/node_modules/electron/install.js`);
  process.exit(2);
}
const { _electron } = await import(path.join(web, "node_modules/playwright-core/index.mjs"));

const api = async (p) => {
  const r = await fetch(`${env.IA_TEST_URL}/api${p}`, { headers: { authorization: `Bearer ${env.IA_TEST_TOKEN}` } });
  if (!r.ok) throw new Error(`${p}: ${r.status}`);
  return r.json();
};
const [profile] = await api("/profiles");
const project = (await api(`/profiles/${profile.id}/projects`)).find((p) => p.name === "Demo");
if (!project) throw new Error("no Demo project: start the test server with --demo");
const [task, other] = await api(`/projects/${project.id}/tasks`);

const pages = {
  "/": `<!doctype html><title>Page one</title><h1>Page one</h1>
<a id="next" href="/two.html">two</a> <a id="blank" href="/three.html" target="_blank">three in a new window</a>
<a id="file" href="file:///etc/hostname">a file</a> <button id="pop" onclick="window.open('/two.html#pop')">popup</button>
<script>
  window.probe = { node: typeof require, proc: typeof process, desktop: typeof window.huntawayDesktop };
  navigator.permissions.query({ name: "geolocation" }).then((p) => (window.probe.geo = p.state));
</script>`,
  "/two.html": "<!doctype html><title>Page two</title><h1>Page two</h1>",
  "/three.html": "<!doctype html><title>Page three</title><h1>Page three</h1>",
};
const site = http.createServer((req, res) => {
  const body = pages[new URL(req.url, "http://x").pathname];
  res.writeHead(body ? 200 : 404, { "content-type": "text/html" }).end(body ?? "not found");
});
await new Promise((r) => site.listen(0, "127.0.0.1", r));
const sitePort = site.address().port;

const config = fs.mkdtempSync(path.join(os.tmpdir(), "ia-browser-e2e-"));
const app = await _electron.launch({
  executablePath: electronBin,
  args: [web, "--ozone-platform=headless", "--no-sandbox"],
  env: { ...process.env, IA_PORT: new URL(env.IA_TEST_URL).port, IA_DATA_DIR: env.IA_TEST_DATA_DIR, XDG_CONFIG_HOME: config, IA_RELEASE_UPDATES: "" },
  timeout: 30_000,
});
let failed = 0;
const ok = (cond, what) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${what}`);
  if (!cond) failed++;
};
try {
  // Links the page opens outside go here rather than to the system's browser.
  await app.evaluate(({ shell }) => {
    shell.openExternal = async (u) => void (globalThis.opened = [...(globalThis.opened ?? []), u]);
  });
  const opened = () => app.evaluate(() => globalThis.opened ?? []);
  const page = await app.firstWindow();
  page.on("pageerror", (e) => ok(false, `page error: ${e.message}`));
  await page.waitForLoadState();
  const toggle = 'button[title="A browser beside the thread"]';
  const address = 'input[placeholder^="Address"]';
  const openTask = async (t) => {
    await page.goto(`${env.IA_TEST_URL}/p/${project.id}?task=${t.id}`);
    await page.waitForSelector(toggle, { timeout: 15_000 });
  };
  const inPage = (js) =>
    page.evaluate(async (js) => {
      for (let i = 0; i < 50; i++) {
        try {
          // As if the user did it: Chromium leaves navigations without a gesture out of the back list.
          return await document.querySelector("webview").executeJavaScript(js, true);
        } catch {
          await new Promise((r) => setTimeout(r, 100));
        }
      }
      throw new Error("the webview never answered");
    }, js);
  const addressIs = async (re) => {
    for (let i = 0; i < 50 && !re.test(await page.inputValue(address)); i++) await page.waitForTimeout(100);
    return re.test(await page.inputValue(address));
  };
  const back = async () => {
    await page.click('button[title="Back"]');
    await addressIs(/\d\/$/);
    await page.waitForTimeout(300);
  };

  await openTask(task);
  ok(await page.evaluate(() => window.huntawayDesktop?.browserPane === true), "the app offers the pane");
  await page.click(toggle);
  await page.waitForSelector(address);
  ok(await page.evaluate(() => document.activeElement?.placeholder?.startsWith("Address")), "an empty pane focuses its address bar");
  await page.keyboard.type("file:///etc/passwd");
  await page.keyboard.press("Enter");
  ok((await page.getAttribute(address, "aria-invalid")) === "true", "a file: address is refused");
  await page.fill(address, String(sitePort));
  await page.keyboard.press("Enter");
  ok(await addressIs(/^http:\/\/localhost:\d+\/$/), "a port opens localhost");
  await page.waitForTimeout(500);
  const probe = JSON.parse(await inPage("JSON.stringify(window.probe)"));
  ok(probe.node === "undefined" && probe.proc === "undefined" && probe.desktop === "undefined", `the page has no Node or app bridge: ${JSON.stringify(probe)}`);
  ok(probe.geo !== "granted", `the page has no location: ${probe.geo}`);
  ok((await inPage("document.title")) === "Page one", "the page loaded");
  // The window starts at 900 wide: too narrow for both, the pane takes the thread's place.
  ok(
    (await page.locator('[role="separator"]').count()) === 0 && (await page.locator("webview").isVisible()) && (await page.locator("main").first().isHidden()),
    "in a narrow window the pane takes the main area's place",
  );
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900));
  await page.waitForSelector('[role="separator"]');
  ok(await page.locator("main").first().isVisible(), "in a wide one it's beside the thread");

  // Every webview's guest is in the pane's own session, whatever its element asked for.
  const sessions = () =>
    app.evaluate(({ webContents, session }) =>
      webContents
        .getAllWebContents()
        .filter((w) => w.getType() === "webview")
        .map((w) => ({ url: w.getURL(), own: w.session === session.fromPartition("persist:huntaway-browser"), def: w.session === session.defaultSession })),
    );
  const ss = await sessions();
  ok(ss.length === 1 && ss[0].own && !ss[0].def, `the pane's page is in persist:huntaway-browser: ${JSON.stringify(ss)}`);
  for (const partition of [null, "", "persist:other"]) {
    await page.evaluate(
      ({ sitePort, partition }) => {
        const w = document.createElement("webview");
        w.className = "probe";
        if (partition !== null) w.setAttribute("partition", partition);
        w.src = `http://localhost:${sitePort}/two.html`;
        document.body.append(w);
      },
      { sitePort, partition },
    );
    await page.waitForTimeout(800);
    const s = (await sessions()).filter((x) => x.url.endsWith("/two.html"));
    ok(s.length === 1 && s[0].own && !s[0].def, `a webview with partition ${JSON.stringify(partition)} gets it too: ${JSON.stringify(s)}`);
    await page.evaluate(() => document.querySelectorAll("webview.probe").forEach((w) => w.remove()));
    await page.waitForTimeout(500);
  }

  await inPage("document.getElementById('next').click()");
  ok(await addressIs(/two\.html$/), "a link navigates, and the address follows");
  await page.waitForTimeout(300);
  ok(await page.isEnabled('button[title="Back"]'), "back is enabled");
  await back();
  ok(await page.isEnabled('button[title="Forward"]'), "back went back, and forward is enabled");
  await inPage("document.getElementById('blank').click()");
  ok(await addressIs(/three\.html$/), "a target=_blank link opens in the pane");
  await back();
  await inPage("document.getElementById('pop').click()");
  ok(await addressIs(/two\.html#pop$/), "window.open opens in the pane");
  await back();
  await inPage("document.getElementById('file').click()");
  await page.waitForTimeout(800);
  ok(/\d\/$/.test(await page.inputValue(address)), "a file: link goes nowhere");
  ok(!(await opened()).some((u) => u.startsWith("file:")), "nor to the system");
  await page.click('button[title="Open in your browser"]');
  await page.waitForTimeout(500);
  ok(
    (await opened()).some((u) => u.includes(`:${sitePort}`)),
    "Open in your browser opens it in the system's browser",
  );

  const paneWidth = () => page.evaluate(() => document.querySelector("webview").parentElement.parentElement.getBoundingClientRect().width);
  const before = await paneWidth();
  const bar = await page.locator('[role="separator"]').boundingBox();
  await page.mouse.move(bar.x + 2, bar.y + 200);
  await page.mouse.down();
  await page.mouse.move(bar.x - 200, bar.y + 200, { steps: 8 });
  await page.mouse.up();
  const after = await paneWidth();
  ok(after > before + 150, `dragging the bar resizes the pane: ${before} → ${after}`);

  await page.click('button[title="Close the browser"]');
  ok(await page.locator("webview").isHidden(), "closing hides the pane");
  await page.click(toggle);
  ok((await inPage("document.title")) === "Page one", "opening it again finds the page still loaded");
  await openTask(other);
  ok((await page.locator("webview").count()) === 0, "another task has no pane open");
  await openTask(task);
  await page.click(toggle);
  ok(await addressIs(/\d\/$/), "the task remembers its page");

  await page.fill(address, "1");
  await page.keyboard.press("Enter");
  await page.waitForSelector("text=Couldn't load", { timeout: 10_000 });
  ok(true, `a page that won't load says so: ${await page.locator("text=Couldn't load").textContent()}`);
  await page.fill(address, String(sitePort));
  await page.keyboard.press("Enter");
  await page.waitForSelector("text=Couldn't load", { state: "detached", timeout: 10_000 });
  ok((await inPage("document.title")) === "Page one", "and goes on to the next one");
} catch (e) {
  ok(false, e.stack ?? String(e));
} finally {
  await app.close().catch(() => {});
  site.close();
  fs.rmSync(config, { recursive: true, force: true });
}
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
