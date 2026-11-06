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
