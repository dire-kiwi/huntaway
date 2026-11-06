import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { startServer, withBrowser } from "./harness.mjs";

let hub;
let home;
before(() => {
  hub = startServer();
  home = startServer();
});
after(() => {
  hub?.stop();
  home?.stop();
});

/** Link `to` on `from`'s board by URL, under `name`, once it's connected. Returns its host id. */
async function link(from, to, name) {
  const { id } = await from.api("POST", "/hosts", { url: to.url, token: to.token });
  await from.api("PATCH", `/hosts/${id}`, { name });
  for (let i = 0; i < 100; i++) {
    if ((await from.api("GET", "/hosts")).some((h) => h.id === id && h.connected)) return id;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`${name} didn't connect`);
}

const assistants = async (server, profile) =>
  (await server.api("GET", `/profiles/${profile.id}/tasks?include_assistant=true`)).filter((t) => t.task_type === "assistant");

// HA-120 review: the sidebar asked the assistant host for its profile's assistant as any client would, so a host whose own
// profile named another assistant host (here, back to the board's) sent it on, and the assistant was made on the board's host.
test("the sidebar opens the assistant on the profile's assistant host, whatever that host's profile says", async () => {
  const [mine] = await hub.api("GET", "/profiles");
  const [theirs] = await home.api("GET", "/profiles");
  const homeId = await link(hub, home, "homeserver");
  const hubId = await link(home, hub, "desktop");
  await hub.api("PATCH", `/profiles/${mine.id}`, { assistant_host: homeId });
  await home.api("PATCH", `/profiles/${theirs.id}`, { assistant_host: hubId });
  await withBrowser(hub, {}, async (ui) => {
    await ui.run(["goto /profile/Default", "click css=nav[aria-label=Assistant] >> text=Assistant", "wait Message your assistant", "wait This board"]);
    // On homeserver, as its Details say, and made there rather than on the board's own host.
    assert.match(await ui.page.locator("aside", { hasText: "This board" }).innerText(), /Host\s+homeserver\n/);
    assert.equal((await assistants(home, theirs)).length, 1);
    assert.equal((await assistants(hub, mine)).length, 0);
  });
});

// HA-255: routines the board's own host keeps for a profile whose assistant moved to another host don't run there, and
// the assistant's Routines tab (on the assistant host) lists them under its own, each with a Delete for the board's host.
test("the routines left on the board's host are listed under the assistant host's, and can be deleted there", async () => {
  const [mine] = await hub.api("GET", "/profiles");
  const [theirs] = await home.api("GET", "/profiles");
  // The test before may have linked it, and sent home's assistant back to the hub.
  const homeId = (await hub.api("GET", "/hosts")).find((h) => h.name === "homeserver")?.id ?? (await link(hub, home, "homeserver"));
  await home.api("PATCH", `/profiles/${theirs.id}`, { assistant_host: null });
  const routine = (name, expr) => ({ name, trigger: { kind: "cron", expr }, action: { kind: "message_assistant", message: "Anything new?" } });
  // Made on the board's host while the assistant ran there.
  await hub.api("PATCH", `/profiles/${mine.id}`, { assistant_host: null });
  await hub.api("POST", `/profiles/${mine.id}/automations`, routine("Old inbox", "0 8 * * mon-fri"));
  await hub.api("PATCH", `/profiles/${mine.id}`, { assistant_host: homeId });
  await home.api("POST", `/profiles/${theirs.id}/automations`, routine("New inbox", "0 9 * * *"));
  const hubName = (await hub.api("GET", "/info")).host_name;
  await withBrowser(hub, {}, async (ui) => {
    const { page } = ui;
    await ui.run([
      "goto /profile/Default",
      "click css=nav[aria-label=Assistant] >> text=Assistant",
      "wait Message your assistant",
      "click routines",
      "wait css=[data-testid=routine] >> text=New inbox",
      "wait css=[data-testid=routine-left-behind] >> text=Old inbox",
    ]);
    const box = page.getByTestId("routines-left-behind");
    assert.match(await box.innerText(), new RegExp(`This routine stays on ${hubName}, where your assistant ran before, and doesn't run while it's on homeserver`));
    // The assistant host's own routine isn't listed as left behind, nor the other way round.
    assert.equal(await box.getByText("New inbox").count(), 0);
    assert.equal(await page.getByTestId("routine").filter({ hasText: "Old inbox" }).count(), 0);
    await box.getByTitle(`Delete it on ${hubName}`).click();
    await ui.run(["wait Its run history goes with it", "click role=button[name='Delete routine']", "gone css=[data-testid=routines-left-behind]"]);
    await ui.run(["wait css=[data-testid=routine] >> text=New inbox"]);
  });
  // Deleted on the board's host; the assistant host's own is still there.
  assert.deepEqual((await hub.api("GET", `/profiles/${mine.id}/automations`)).automations, []);
  assert.deepEqual((await home.api("GET", `/profiles/${theirs.id}/automations`)).automations.map((a) => a.name), ["New inbox"]);
});
