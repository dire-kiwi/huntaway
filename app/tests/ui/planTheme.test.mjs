// How a plan's <ia-html> works as a page of its own (src/planTheme.ts), in a browser but without a server.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import { after, before, test } from "node:test";
import { frameDoc } from "../../src/htmlFrame.ts";
import { themedPlan } from "../../src/planTheme.ts";

const { chromium } = createRequire(import.meta.url)("playwright-core");
const css = fs.readFileSync(new URL("../../src/planTheme.css", import.meta.url), "utf8");

let browser;
before(async () => (browser = await chromium.launch({ executablePath: "/usr/bin/chromium" })));
after(() => browser?.close());

test("<ia-html> is a page of its own: its scripts work as in a page, its styles stay in it, and its frame fits it", async () => {
  const plan = `<h1>Scripts</h1>
<p id="outside">outside</p>
<ia-html><template>
  <style>p { color: rgb(255, 0, 0); }</style>
  <p id="json"></p><p id="shared"></p><p id="ready"></p><p id="loaded"></p><p id="ext"></p><p id="module"></p><p id="ext-module"></p><p id="after-throw"></p>
  <button id="pick" onclick="setMode('dark')">Dark</button><p id="mode"></p>
  <script id="data" type="application/json">{"count": 2}</script>
  <script>document.getElementById("json").textContent = JSON.parse(document.getElementById("data").textContent).count;</script>
  <script>var count = 2; let label = "n"; function twice(x) { return x * 2; } function setMode(m) { document.getElementById("mode").textContent = m; }</script>
  <script>document.getElementById("shared").textContent = label + twice(count);</script>
  <script>
    document.addEventListener("DOMContentLoaded", () => (document.getElementById("ready").textContent = "ready"));
    window.addEventListener("load", () => (document.getElementById("loaded").textContent = "loaded " + window.fromSrc));
  </script>
  <script src="data:text/javascript,window.fromSrc='src';document.getElementById('ext').textContent='ext ' + typeof count"></script>
  <script type="module">
    import { n } from "data:text/javascript,export const n = 'module import';";
    document.getElementById("module").textContent = n;
  </script>
  <script type="module" src="data:text/javascript,document.getElementById('ext-module').textContent='ext module'"></script>
  <script>throw new Error("optional widget failed");</script>
  <script>document.getElementById("after-throw").textContent = "after throw";</script>
</template></ia-html>`;
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.setContent(themedPlan(plan, css, ""));
  const frame = page.frames().find((f) => f.parentFrame() === page.mainFrame());
  assert.ok(frame, "the component's frame");
  await frame.waitForFunction(() => document.getElementById("loaded")?.textContent && document.getElementById("ext-module")?.textContent, null, { timeout: 5000 });
  const text = (id) => frame.evaluate((id) => document.getElementById(id).textContent, id);
  assert.equal(await text("json"), "2");
  // A var, a let and a function from one script, in the next; page events; scripts with a src; modules.
  assert.equal(await text("shared"), "n4");
  assert.equal(await text("ready"), "ready");
  assert.equal(await text("loaded"), "loaded src");
  assert.equal(await text("ext"), "ext number");
  assert.equal(await text("module"), "module import");
  assert.equal(await text("ext-module"), "ext module");
  // A script that throws doesn't stop the next.
  assert.equal(await text("after-throw"), "after throw");
  assert.deepEqual(errors.filter((e) => !/optional widget failed/.test(e)), []);
  // An inline handler reaches a script's function.
  await page.frameLocator("ia-html iframe").locator("#pick").click();
  assert.equal(await text("mode"), "dark");
  // Its styles stay in it, the theme's are there, and the frame is as tall as what's in it.
  assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById("outside")).color), "rgb(230, 230, 236)");
  assert.equal(await frame.evaluate(() => getComputedStyle(document.getElementById("json")).color), "rgb(255, 0, 0)");
  assert.equal(await frame.evaluate(() => getComputedStyle(document.body).color), "rgb(230, 230, 236)");
  const inner = await frame.evaluate(() => Math.ceil(document.documentElement.getBoundingClientRect().height));
  await page.waitForFunction((h) => document.querySelector("ia-html iframe").getBoundingClientRect().height === h, inner, { timeout: 5000 });
  assert.ok(inner > 200, `content height ${inner}`);
  await page.close();
});

// Chromium doesn't update the rendering of an offscreen frame of another origin, so size observers don't fire there.
test("an <ia-html> frame fits its content offscreen, absolutely positioned content included, as it grows and shrinks", async () => {
  const plan = `<h1>Below the fold</h1><div style="height: 2000px"></div>
<ia-html><template><div style="height: 600px">tall</div></template></ia-html>
<ia-html><template><div id="w" style="position: absolute; top: 0; left: 0; width: 300px; height: 180px">widget</div></template></ia-html>`;
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  await page.setContent(themedPlan(plan, css, ""));
  const heights = () => page.evaluate(() => [...document.querySelectorAll("ia-html iframe")].map((f) => f.getBoundingClientRect().height).join());
  const expect = (want) => page.waitForFunction((want) => [...document.querySelectorAll("ia-html iframe")].map((f) => f.getBoundingClientRect().height).join() === want, want, { timeout: 3000 }).catch(async () => assert.equal(await heights(), want));
  await expect("600,180");
  assert.equal(await page.evaluate(() => scrollY), 0);
  const w = page.frames().filter((f) => f.parentFrame() === page.mainFrame())[1];
  await w.evaluate(() => (document.getElementById("w").style.height = "260px"));
  await expect("600,260");
  await w.evaluate(() => (document.getElementById("w").style.height = "100px"));
  await expect("600,100");
  await page.close();
});

test("a reloaded plan goes back to where it was read, with a tall <ia-html> above that place", async () => {
  const paragraphs = Array.from({ length: 80 }, (_, i) => `<p id="b${i}">Paragraph ${i}</p>`).join("\n");
  const plan = (v) => themedPlan(`<h1>Version ${v}</h1><ia-html><template><div style="height: 600px">tall</div></template></ia-html>\n${paragraphs}`, css, "");
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  await page.setContent(`<iframe sandbox="allow-scripts" style="width: 800px; height: 600px; border: 0"></iframe>
<script>addEventListener("message", (e) => typeof e.data?.iaScroll === "number" && (window.lastScroll = e.data.iaScroll));</script>`);
  const load = async (doc) => {
    await page.evaluate((doc) => new Promise((done) => {
      const f = document.querySelector("iframe");
      f.onload = done;
      f.srcdoc = doc;
    }), doc);
    return page.frames().find((f) => f.parentFrame() === page.mainFrame());
  };
  let frame = await load(frameDoc(plan(1), 0, 0));
  await frame.waitForFunction(() => document.querySelector("ia-html iframe").getBoundingClientRect().height === 600, null, { timeout: 3000 });
  await frame.evaluate(() => document.getElementById("b40").scrollIntoView());
  const top = await frame.evaluate(() => document.getElementById("b40").getBoundingClientRect().top);
  await page.waitForFunction(() => window.lastScroll > 600, null, { timeout: 3000 });
  const y = await page.evaluate(() => window.lastScroll);
  // As HtmlFrame does on a new version: the new document, with the place it was scrolled to.
  frame = await load(frameDoc(plan(2), y, 0));
  await page.waitForTimeout(1500);
  assert.equal(await frame.evaluate(() => document.querySelector("ia-html iframe").getBoundingClientRect().height), 600);
  const after = await frame.evaluate(() => document.getElementById("b40").getBoundingClientRect().top);
  assert.ok(Math.abs(after - top) <= 2, `b40 at ${after}, was at ${top}`);
  await page.close();
});

test("a reloaded plan goes back to its place even when its load takes longer than the hold after it", async () => {
  // An image that takes 4s, so load comes well after the page is parsed.
  const server = http.createServer((req, res) => setTimeout(() => res.writeHead(200, { "content-type": "image/svg+xml" }).end('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>'), 4000));
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  try {
    const paragraphs = Array.from({ length: 120 }, (_, i) => `<p id="b${i}">Paragraph ${i}</p>`).join("\n");
    const doc = frameDoc(themedPlan(`<h1>Slow</h1>${paragraphs}<img src="http://127.0.0.1:${server.address().port}/slow.svg">`, css, ""), 2000, 0);
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    await page.setContent(`<iframe sandbox="allow-scripts" style="width: 800px; height: 600px; border: 0"></iframe>`);
    const started = Date.now();
    await page.evaluate((doc) => new Promise((done) => {
      const f = document.querySelector("iframe");
      f.onload = done;
      f.srcdoc = doc;
    }), doc);
    assert.ok(Date.now() - started > 3500, `loaded after ${Date.now() - started}ms`);
    const frame = page.frames().find((f) => f.parentFrame() === page.mainFrame());
    await page.waitForTimeout(200);
    assert.equal(await frame.evaluate(() => scrollY), 2000);
    await page.close();
  } finally {
    server.close();
  }
});

/** A plan in a sandboxed frame, as HtmlFrame shows it, with the iaForm messages it sends collected in `window.forms`. */
async function planPage(plan, form) {
  const page = await browser.newPage({ viewport: { width: 900, height: 1400 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setContent(`<iframe sandbox="allow-scripts allow-forms" style="width: 880px; height: 1380px; border: 0"></iframe>
<script>window.forms = []; addEventListener("message", (e) => e.data?.iaForm && window.forms.push(e.data));</script>`);
  await page.evaluate((doc) => new Promise((done) => {
    const f = document.querySelector("iframe");
    f.onload = done;
    f.srcdoc = doc;
  }), frameDoc(themedPlan(plan, css, "", form), 0, 0));
  const frame = page.frames().find((f) => f.parentFrame() === page.mainFrame());
  const last = () => page.evaluate(() => window.forms.at(-1));
  return { page, frame, last, errors, post: (data) => page.evaluate((data) => document.querySelector("iframe").contentWindow.postMessage(data, "*"), data) };
}

const QUESTIONS = `<h1>Questions</h1>
<ia-question name="db" type="radio" title="Which database?">
  <p>We have to pick one.</p>
  <option value="sqlite" selected>SQLite</option>
  <option value="pg">Postgres <code>16</code></option>
</ia-question>
<ia-question name="pages" type="checkbox" title="Which pages?" other="Something else">
  <option value="home">Home</option>
  <option value="docs" selected>Docs</option>
</ia-question>
<ia-question name="size" type="select" title="How big?"><option value="s">Small</option><option value="l">Large</option></ia-question>
<ia-question name="notes" type="textarea" title="Anything else?" placeholder="Optional"></ia-question>
<ia-question title="A question with no name or type"></ia-question>
<form action="https://example.com/"><table><tr data-question="Keep the cache?"><td><input type="checkbox" name="cache" value="yes"> keep</td></tr></table>
<label>Owner <input name="owner" value="ivan"></label><input type="submit" name="go" value="Go"></form>
<ia-html><template><input name="inside" value="not a question"></template></ia-html>`;

test("a plan's questions become form fields, and the frame reports each named field with its question and answer", async () => {
  const { page, frame, last, errors, post } = await planPage(QUESTIONS);
  await page.waitForFunction(() => window.forms.length > 0);
  const first = await last();
  assert.equal(first.iaFormUser, false);
  const summary = (fields) => fields.map((f) => [f.name, f.label, f.answer.join("|"), f.touched]);
  assert.deepEqual(summary(first.iaForm), [
    ["db", "Which database?", "SQLite", false],
    ["pages", "Which pages?", "Docs", false],
    ["size", "How big?", "", false],
    ["notes", "Anything else?", "", false],
    ["question-1", "A question with no name or type", "", false],
    ["cache", "Keep the cache?", "", false],
    ["owner", "Owner", "ivan", false],
  ]);
  // The question is a heading, not a tooltip; its explanation and a choice's markup stay.
  assert.equal(await frame.evaluate(() => document.querySelector("ia-question[name=db]").hasAttribute("title")), false);
  assert.equal(await frame.locator("ia-question[name=db] .ia-ask").textContent(), "Which database?");
  assert.equal(await frame.locator("ia-question[name=db] > p").textContent(), "We have to pick one.");
  assert.equal(await frame.locator("ia-question[name=db] label code").textContent(), "16");

  await frame.getByLabel("Postgres").check();
  await frame.locator("input.ia-other").fill("Blog");
  await frame.locator("select[name=size]").selectOption("l");
  await frame.locator("textarea[name=notes]").fill("one\ntwo");
  await frame.locator("input[name=cache]").check();
  // Enter in a field of the plan's own form doesn't submit it (which would load its action in the frame).
  await frame.locator("input[name=owner]").press("Enter");
  const now = await last();
  assert.equal(now.iaFormUser, true);
  assert.deepEqual(summary(now.iaForm), [
    ["db", "Which database?", "Postgres 16", true],
    ["pages", "Which pages?", "Docs|Something else: Blog", true],
    ["size", "How big?", "Large", true],
    ["notes", "Anything else?", "one\ntwo", true],
    ["question-1", "A question with no name or type", "", false],
    ["cache", "Keep the cache?", "yes", true],
    ["owner", "Owner", "ivan", false],
  ]);
  assert.deepEqual(now.iaForm[1].value, { v: ["docs", "\u0000other"], o: "Blog" });
  assert.ok(await frame.evaluate(() => !!document.querySelector("ia-question[name=db]")), "still the plan, not the form's action");

  // Each field says what the plan had, for Reset without the frame.
  assert.deepEqual(now.iaForm[0].initial, { value: { v: ["sqlite"] }, answer: ["SQLite"] });
  assert.deepEqual(now.iaForm[1].initial, { value: { v: ["docs"] }, answer: ["Docs"] });

  // Sent as they are: those aren't touched any more, until the next change; the others still are. Reset: back to the plan's own.
  await post({ iaFormSent: ["db", "pages", "size", "cache"] });
  await frame.locator("input[name=owner]").fill("someone");
  assert.deepEqual((await last()).iaForm.filter((f) => f.touched).map((f) => f.name), ["notes", "owner"]);
  await post({ iaFormReset: true });
  await page.waitForFunction(() => window.forms.at(-1).iaFormUser === false);
  assert.deepEqual(summary((await last()).iaForm), summary(first.iaForm));
  assert.deepEqual(errors, []);
  await page.close();
});

test("a plan's unsent answers are put back in when it loads, and an earlier version's fields can't be changed", async () => {
  const answers = { db: { v: ["pg"] }, pages: { v: ["home", "\u0000other"], o: "</script><b>x</b>" }, notes: { v: ["</script>"] }, gone: { v: ["x"] } };
  const { page, frame, last, errors } = await planPage(QUESTIONS, { answers, key: "3" });
  await page.waitForFunction(() => window.forms.length > 0);
  assert.equal((await last()).iaFormKey, "3");
  const fields = (await last()).iaForm;
  const by = Object.fromEntries(fields.map((f) => [f.name, f]));
  assert.deepEqual(by.db.answer, ["Postgres 16"]);
  assert.deepEqual(by.pages.answer, ["Home", "Something else: </script><b>x</b>"]);
  assert.deepEqual(by.notes.answer, ["</script>"]);
  assert.deepEqual([by.db.touched, by.pages.touched, by.size.touched], [true, true, false]);
  assert.equal(await frame.locator("input.ia-other").inputValue(), "</script><b>x</b>");
  assert.deepEqual(errors, []);
  await page.close();

  const old = await planPage(QUESTIONS, { readOnly: true });
  await old.page.waitForFunction(() => window.forms.length > 0);
  assert.equal((await old.last()).iaFormKey, null);
  assert.ok(await old.frame.evaluate(() => [...document.querySelectorAll("input, select, textarea")].every((c) => c.disabled)));
  await old.page.close();
});
