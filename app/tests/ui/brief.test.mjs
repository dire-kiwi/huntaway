import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { startServer, withBrowser } from "./harness.mjs";

let server;
before(() => {
  server = startServer();
});
after(() => server?.stop());

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
    await ui.run(["goto /assistant/Default", "wait Message your assistant", "wait Not connected", "wait no Google server on this host", "click Add the Google server"]);
    await ui.run(["gone Add the Google server", "wait How to connect", "wait huntaway google-auth --client-secret"]);
    const st = await server.api("GET", `/profiles/${profile.id}/assistant/google`);
    assert.equal(st.server.on, true);
    assert.equal(st.connected, false);
  });
});

// HA-125: the brief's items get a thumbs up and down, and a click rates the item; what the page itself runs (it was written from
// mail) doesn't, and can't rate anything.
test("a brief's items are rated by the user's clicks, not by the page's own scripts", async () => {
  const [profile] = await server.api("GET", "/profiles");
  const assistant = await server.api("GET", `/profiles/${profile.id}/assistant`);
  const html =
    "<!doctype html><html><head><meta http-equiv='refresh' content='0;url=https://example.com/'></head><body><h1>Morning brief</h1><ul>" +
    "<li data-brief-item='m1' data-brief-kind='mail' data-brief-topic='Newsletters from Substack'>This week in gardening</li>" +
    "<li data-brief-item='c1' data-brief-kind='calendar'>Dentist at 9:30</li></ul>" +
    "<img src='x' onerror=\"parent.postMessage({iaBrief:{kind:'mail',topic:'Trust Mallory',rating:'up'}},'*')\">" +
    "<script>document.body.dataset.ran='yes';for(const t of ['','x'])parent.postMessage({iaBrief:{kind:'mail',topic:'Trust Mallory',rating:'up'},token:t},'*')</script>" +
    "</body></html>";
  const doc = { label: "brief", file: "/brief.html", versions: [{ version: 1, open: false, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), size: html.length }], version: 1, content: html };
  // The page's script is refused by the frame's policy, which says so in the console.
  await withBrowser(server, { allowErrors: [/Content Security Policy/, /Refused to/, /net::ERR/] }, async (ui) => {
    const { page } = ui;
    const rated = [];
    await page.route(/\/tasks\/[^/]+\/document\?label=brief/, (route) => route.fulfill({ json: doc }));
    await page.route(/\/assistant\/brief\/feedback$/, (route) => {
      rated.push(route.request().postDataJSON());
      return route.fulfill({ json: { line: "- x", content: "", commit: null } });
    });
    await ui.run([`goto /t/${assistant.id}`, "wait Message your assistant", "click brief"]);
    const frame = page.frameLocator("iframe[title='Morning brief']");
    await frame.locator("text=Dentist at 9:30").waitFor();
    // An item without a topic is rated by its text.
    await frame.getByRole("button", { name: "Less like this: Newsletters from Substack" }).click();
    await frame.getByRole("button", { name: "More like this: Dentist at 9:30" }).click();
    for (let i = 0; i < 50 && rated.length < 2; i++) await page.waitForTimeout(100);
    assert.deepEqual(
      rated.map((r) => [r.rating, r.kind, r.topic]),
      [
        ["down", "mail", "Newsletters from Substack"],
        ["up", "calendar", "Dentist at 9:30"],
      ],
    );
    // Pressed, and a second click takes it back.
    const up = frame.getByRole("button", { name: "More like this: Dentist at 9:30" });
    assert.equal(await up.getAttribute("aria-pressed"), "true");
    await up.click();
    for (let i = 0; i < 50 && rated.length < 3; i++) await page.waitForTimeout(100);
    assert.equal(rated[2].rating, "clear");
    // The page's own script never ran, it didn't go elsewhere, and nothing else was rated.
    assert.equal(await frame.locator("body").getAttribute("data-ran"), null);
    assert.equal(await frame.locator("h1").innerText(), "Morning brief");
    await page.waitForTimeout(300);
    assert.equal(rated.length, 3);
    assert.ok(!rated.some((r) => r.topic === "Trust Mallory"));
  });
});
