import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { startServer, withBrowser } from "./harness.mjs";

let server;
before(() => {
  server = startServer();
});
after(() => server?.stop());

/** A request to the server as a phone: with its own token, or none. */
async function asPhone(method, path, token, body) {
  const res = await fetch(`${server.url}/api${path}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

// HA-208 (HA-136): Settings → Network access → Phones shows a QR code for the address the phone reaches the board at, the
// list picks up the phone that pairs with it (and the code goes), and renaming and revoking it from there cut it off:
// its token stops working and its websocket closes.
test("pairs a phone from Settings, renames it and revokes it", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    await ui.run(["goto /settings", "wait Phones", "click Pair a phone", "wait The board's address"]);
    // The test server's page is plain HTTP, so there's no address to start from, and plain HTTP is refused.
    await ui.run(["click https://machine.tailnet.ts.net", "type http://192.168.1.5:7878", "wait Phones refuse plain HTTP"]);
    await ui.run(["press Control+a", "type https://board.example.ts.net", "wait Pairing QR code", "gone Phones refuse plain HTTP"]);
    const link = await page.locator('[aria-label="Pairing link"]').inputValue();
    const m = link.match(/^huntaway:\/\/pair\?url=([^&]+)&code=(\w+)$/);
    assert.ok(m, link);
    assert.equal(decodeURIComponent(m[1]), "https://board.example.ts.net");
    assert.ok(!link.includes(server.token), "the QR code never holds the board's token");

    const paired = await asPhone("POST", "/devices/pair", "", { code: m[2], name: "Test phone" });
    assert.equal(paired.status, 200, JSON.stringify(paired.body));
    const phone = paired.body.token;
    assert.equal((await asPhone("POST", "/devices/pair", "", { code: m[2], name: "again" })).status, 403, "a code pairs once");
    // The panel polls for it while the code is shown.
    await ui.run(["wait Paired devices", "wait Test phone", "gone Pairing QR code"]);
    assert.equal((await asPhone("GET", "/profiles", phone)).status, 200);
    assert.equal((await asPhone("GET", "/hosts/join", phone)).status, 403);

    const ws = new WebSocket(`${server.url.replace(/^http/, "ws")}/api/ws?token=${phone}`);
    const closed = new Promise((resolve) => ws.addEventListener("close", (e) => resolve(e.code)));
    await new Promise((resolve, reject) => {
      ws.addEventListener("message", resolve, { once: true });
      ws.addEventListener("error", reject, { once: true });
    });

    await ui.run(["click Rename Test phone", "press Control+a", "type Work phone", "click role=button[name='Save']", "wait Work phone", "gone Test phone"]);
    assert.equal((await server.api("GET", "/devices")).devices[0].name, "Work phone");
    await ui.run(["click Revoke Work phone", "wait Revoke Work phone?", "click [data-modal] >> role=button[name='Revoke']", "gone Revoke Work phone?"]);
    await ui.run(["gone Paired devices"]);
    assert.equal(await Promise.race([closed, new Promise((r) => setTimeout(() => r("still open"), 5000))]), 1008);
    assert.equal((await asPhone("GET", "/profiles", phone)).status, 401);
  });
});
