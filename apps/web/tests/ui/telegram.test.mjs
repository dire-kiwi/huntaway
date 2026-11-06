import assert from "node:assert/strict";
import { createServer } from "node:http";
import { afterAll, beforeAll, test } from "vite-plus/test";
import { startServer, withBrowser } from "./harness.mjs";

const TOKEN = "123456:ABCdefGHIjklMNOpqrSTUvwxYZ_0123456789";

/** A fake Bot API (the server's IA_TELEGRAM_API) for bot 123456 (@test_bot): updates to hand out, and the messages sent. */
const fake = { updates: [], sent: [], closing: false };
const bot = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    let body = {};
    try {
      body = JSON.parse(Buffer.concat(chunks).toString());
    } catch {}
    const [, token, method] = req.url.match(/^\/bot([^/]+)\/(\w+)/) ?? [];
    const reply = (v) => (res.destroyed ? undefined : res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(v)));
    if (token !== TOKEN) return reply({ ok: false, error_code: 401, description: "Unauthorized" });
    if (method === "getMe") return reply({ ok: true, result: { id: 123456, is_bot: true, username: "test_bot" } });
    if (method === "getUpdates") {
      const deadline = Date.now() + (body.timeout ?? 0) * 1000;
      for (;;) {
        const ups = fake.updates.filter((u) => u.update_id >= (body.offset ?? 0));
        if (ups.length || Date.now() >= deadline || fake.closing) return reply({ ok: true, result: ups });
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    if (method === "sendMessage") {
      fake.sent.push(body);
      return reply({ ok: true, result: { message_id: fake.sent.length, chat: { id: body.chat_id } } });
    }
    reply({ ok: true, result: true });
  });
});

let server;
beforeAll(async () => {
  await new Promise((r) => bot.listen(0, "127.0.0.1", r));
  // The test server talks to the fake, never to Telegram.
  process.env.IA_TELEGRAM_API = `http://127.0.0.1:${bot.address().port}`;
  server = startServer();
});
afterAll(() => {
  fake.closing = true;
  server?.stop();
  bot.closeAllConnections();
  bot.close();
});

// HA-207 (HA-127 ported): the assistant's Details panel sets the bot's token, links a chat with a one-time code, picks what it
// sends there, and unlinks it. The token is never shown again, and the panel follows what happens on Telegram.
test("the assistant's Telegram bot is set up, linked and unlinked from its details", async () => {
  const [profile] = await server.api("GET", "/profiles");
  const base = `/profiles/${profile.id}/telegram`;
  // The token that isn't one is answered with a 400.
  await withBrowser(server, { allowErrors: [/status of 400 \(Bad Request\).*\/telegram\b/] }, async (ui) => {
    const { page } = ui;
    await ui.run(["goto /assistant/Default", "wait Message your assistant", "wait Talk to the assistant from Telegram"]);
    // A token that isn't one is refused, and nothing is saved.
    await page.getByLabel("Bot token").fill("not-a-token");
    await ui.run(["click Save token", "wait that isn't a bot token"]);
    assert.equal((await server.api("GET", base)).configured, false);
    await page.getByLabel("Bot token").fill(TOKEN);
    await ui.run(["click Save token", "wait isn't linked to a chat yet"]);
    const set = await server.api("GET", base);
    assert.deepEqual([set.configured, set.bot.username, set.owner], [true, "test_bot", null]);
    // Its page never has the token.
    assert.ok(!(await page.content()).includes("ABCdef"), "the token is on the page");

    // A code to send the bot. Sent in a group, it's spent (everyone there saw it): the panel stops showing it.
    await ui.run(["click Link a chat…", "wait Send this to @test_bot"]);
    const seen = await page.locator("[aria-label='Linking code'] code").textContent();
    fake.updates.push({ update_id: 1, message: { message_id: 1, from: { id: 7, first_name: "Pat" }, chat: { id: -100, type: "group" }, text: seen } });
    await ui.run(["gone Send this to @test_bot", "wait Link a chat…"]);
    assert.ok(fake.sent.some((m) => m.chat_id === -100 && m.text.includes("no longer works")));
    await ui.run(["click Link a chat…", "wait Send this to @test_bot"]);
    const command = await page.locator("[aria-label='Linking code'] code").textContent();
    assert.match(command, /^\/start [A-Za-z0-9]{16}$/);
    assert.notEqual(command, seen);
    // Sent from a private chat: the panel says who it's linked to, without a reload.
    fake.updates.push({
      update_id: 2,
      message: { message_id: 2, from: { id: 7, first_name: "Pat", username: "pat" }, chat: { id: 7, type: "private" }, text: command },
    });
    await ui.run(["wait is linked to", "wait Pat", "gone Send this to @test_bot"]);
    assert.equal((await server.api("GET", base)).owner.name, "Pat");
    assert.ok(fake.sent.some((m) => m.chat_id === 7 && m.text.includes("Linked to the Default profile's assistant")));

    // Its routines' reports go to push alone from here on.
    await page.getByLabel("Where its routines' reports go").selectOption("push");
    await ui.run(["sleep 300"]);
    assert.deepEqual((await server.api("GET", base)).events, { replies: false, reports: false, prompts: true, attention: true });
    // Kept over a reload.
    await ui.run(["goto /assistant/Default", "wait is linked to"]);
    assert.equal(await page.getByLabel("Where its routines' reports go").inputValue(), "push");

    // Someone else's message is turned away, and counted.
    fake.updates.push({ update_id: 3, message: { message_id: 3, from: { id: 5, first_name: "Sam" }, chat: { id: 5, type: "private" }, text: "hi" } });
    await ui.run(["wait Turned away 1 message"]);
    assert.ok(!fake.sent.some((m) => m.chat_id === 5));

    // Unlinked (confirmed), it listens to nobody.
    await ui.run(["click Unlink", "click role=dialog >> role=button[name='Unlink']", "wait isn't linked to a chat yet"]);
    assert.equal((await server.api("GET", base)).owner, null);
    // And removed, its token goes.
    await ui.run(["click Remove bot", "click role=dialog >> role=button[name='Remove']", "wait Talk to the assistant from Telegram"]);
    assert.equal((await server.api("GET", base)).configured, false);
  });
});
