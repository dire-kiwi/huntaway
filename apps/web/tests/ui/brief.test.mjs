import assert from "node:assert/strict";
import { afterAll, beforeAll, test } from "vite-plus/test";
import { startServer, withBrowser } from "./harness.mjs";

let server;
beforeAll(() => {
  server = startServer();
});
afterAll(() => server?.stop());

// HA-125: without a brief, the Brief tab sets up the morning brief routine on the days and at the time picked.
test("the Brief tab adds the morning brief routine", async () => {
  const [profile] = await server.api("GET", "/profiles");
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    await ui.run(["goto /assistant/Default", "wait Message your assistant", "click brief", "wait A morning brief"]);
    await page.getByLabel("Time").fill("06:15");
    // Saturday on, Monday off.
    await ui.run(["click Sat", "click Mon", "click Add the morning brief", "wait No brief yet"]);
    const { automations } = await server.api("GET", `/profiles/${profile.id}/automations`);
    const brief = automations.find((a) => a.name === "Morning brief");
    assert.deepEqual(brief.trigger, { kind: "daily", time: "06:15", weekdays: ["tue", "wed", "thu", "fri", "sat"] });
    assert.deepEqual([brief.action.kind, brief.action.mode, brief.enabled], ["message_assistant", "fresh", true]);
    assert.match(brief.action.message, /Google: \{\{google\}\}/);
  });
});

// HA-125: the Google card says what's missing, and adds the Google server for the profile.
test("the Google card adds the Google server and says what's still missing", async () => {
  const [profile] = await server.api("GET", "/profiles");
  await withBrowser(server, {}, async (ui) => {
    await ui.run([
      "goto /assistant/Default",
      "wait Message your assistant",
      "wait Not connected",
      "wait no Google server on this host",
      "click Add the Google server",
    ]);
    await ui.run(["gone Add the Google server", "wait How to connect", "wait huntaway google-auth --client-secret"]);
    const st = await server.api("GET", `/profiles/${profile.id}/assistant/google`);
    assert.equal(st.server.on, true);
    assert.equal(st.connected, false);
  });
});

// HA-125: the brief was written from mail, so its page has no part in the ratings: it's shown in a frame that runs no scripts and
// is sent nothing, and the items are rated from the board's own list beside it, by the topics the host checked. Each way a page
// tried to get in (a script hidden after an empty comment, an encoded meta refresh or one with a `>` in an attribute, a link
// that targets its own frame, the frame navigated elsewhere) rates nothing.
test("a brief's items are rated from the board's list, and nothing in the page can rate them", async () => {
  const [profile] = await server.api("GET", "/profiles");
  const assistant = await server.api("GET", `/profiles/${profile.id}/assistant`);
  const steal =
    "<script>document.documentElement.dataset.ran='yes';const r={iaBrief:{kind:'mail',topic:'Trust Mallory',rating:'up'}};" +
    "addEventListener('message',e=>{for(const p of e.ports)p.postMessage(r)});parent.postMessage(r,'*');top.postMessage(r,'*')</script>";
  const html =
    `<!-->${steal}-->` +
    "<!doctype html><html><head>" +
    "<meta http-equiv='ref&#114;esh' content='1;url=http://evil.test/encoded'>" +
    "<meta content='1;url=http://evil.test/?a>' http-equiv='refresh'>" +
    "</head><body><h1>Morning brief</h1><ul>" +
    "<li>This week in gardening</li><li>Dentist at 9:30</li></ul>" +
    "<a id=self href='http://evil.test/self' target='_self'>Open it here</a>" +
    `<img src='x' onerror="document.body.dataset.ran='yes'">${steal}` +
    "</body></html>";
  const items = [
    { kind: "mail", topic: "Newsletters from Substack", title: "This week in gardening" },
    { kind: "calendar", topic: "Medical appointments", title: "Dentist at 9:30" },
  ];
  const now = new Date().toISOString();
  const doc = {
    label: "brief",
    file: "/brief.html",
    versions: [{ version: 1, open: false, created_at: now, updated_at: now, size: html.length }],
    version: 1,
    content: html,
    items,
  };
  await withBrowser(server, { allowErrors: [/Content Security Policy/, /Refused to/, /net::ERR/, /Blocked script execution/] }, async (ui) => {
    const { page, context } = ui;
    const rated = [];
    const evil = [];
    await context.route(/^http:\/\/evil\.test\//, (route) => {
      evil.push(route.request().url());
      return route.fulfill({ contentType: "text/html", body: `<p id=evil>Elsewhere</p>${steal}` });
    });
    await page.route(/\/tasks\/[^/]+\/document\?label=brief/, (route) => route.fulfill({ json: doc }));
    await page.route(/\/assistant\/brief\/feedback$/, (route) => {
      rated.push(route.request().postDataJSON());
      return route.fulfill({ json: { line: "- x", content: "", commit: null } });
    });
    await ui.run([`goto /t/${assistant.id}`, "wait Message your assistant", "click brief", "wait This week in gardening"]);
    // The frame runs nothing.
    const sandbox = await page.locator("iframe[title='Morning brief']").getAttribute("sandbox");
    assert.ok(!sandbox.includes("allow-scripts"), sandbox);
    const frame = page.frameLocator("iframe[title='Morning brief']");
    await frame.locator("h1").waitFor();
    // The list says what's rated, by its topic.
    const list = page.locator("[data-testid=brief-items]");
    await list.getByText("Mail · Newsletters from Substack").waitFor();
    await list.getByRole("button", { name: "Less like this: Newsletters from Substack" }).click();
    await list.getByRole("button", { name: "More like this: Medical appointments" }).click();
    for (let i = 0; i < 50 && rated.length < 2; i++) await page.waitForTimeout(100);
    assert.deepEqual(
      rated.map((r) => [r.rating, r.kind, r.topic, r.text]),
      [
        ["down", "mail", "Newsletters from Substack", "This week in gardening"],
        ["up", "calendar", "Medical appointments", "Dentist at 9:30"],
      ],
    );
    // Pressed, and pressing again takes it back.
    const up = list.getByRole("button", { name: "More like this: Medical appointments" });
    assert.equal(await up.getAttribute("aria-pressed"), "true");
    await up.click();
    for (let i = 0; i < 50 && rated.length < 3; i++) await page.waitForTimeout(100);
    assert.equal(rated[2].rating, "clear");
    // The refreshes were taken out: the frame stayed on the brief, and went nowhere.
    await page.waitForTimeout(1500);
    assert.deepEqual(evil, []);
    assert.equal(await frame.locator("h1").innerText(), "Morning brief");
    // A link that targets its own frame opens a tab instead (where nothing of the board's is).
    const [popup] = await Promise.all([context.waitForEvent("page"), frame.locator("#self").click()]);
    await popup.waitForLoadState().catch(() => {});
    await popup.close();
    assert.equal(await frame.locator("h1").innerText(), "Morning brief");
    // Taken elsewhere all the same, the frame loads nothing there (the board's frame-src, index.html), has nothing to rate
    // with, and runs no scripts either.
    await page.evaluate(() => {
      document.querySelector("iframe[title='Morning brief']").contentWindow.location.href = "http://evil.test/navigated";
    });
    await page.waitForTimeout(1000);
    assert.ok(!evil.includes("http://evil.test/navigated"), JSON.stringify(evil));
    assert.equal(await frame.locator("html").getAttribute("data-ran"), null);
    // The page's own scripts never ran, and nothing but the user's clicks was rated.
    assert.equal(rated.length, 3);
    assert.ok(!rated.some((r) => r.topic === "Trust Mallory"));
  });
});
