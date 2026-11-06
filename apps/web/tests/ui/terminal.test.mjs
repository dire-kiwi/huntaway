import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { after, before, test } from "node:test";
import { demoProject, startServer, withBrowser } from "./harness.mjs";

let server, project;
before(async () => {
  server = startServer();
  project = await demoProject(server);
});
after(() => server?.stop());

for (const tool of [false, true]) test(`${tool ? "lazygit" : "terminal"} opens without a canvas context and survives hiding and reconnecting`, async () => {
  const task = await server.api("POST", `/projects/${project.id}/tasks`, { title: "Terminal rendering", status: "in_review" });
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    // Browsers may refuse canvas allocation under resource pressure. The canvas addon's
    // uncaught error used to abort initialization before even opening the websocket.
    await page.addInitScript(() => {
      const getContext = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (...args) {
        if (this.classList.contains("xterm-text-layer")) return null;
        return getContext.apply(this, args);
      };
    });
    if (tool) await page.route(/\/settings$/, async (route) => {
      const res = await route.fetch();
      await route.fulfill({ response: res, json: { ...await res.json(), terminal_tools: [{ id: "lg", name: "lazygit", command: "lazygit" }] } });
    });
    let socket, connections = 0;
    const input = [];
    await page.route(/\/terminal(?:\?.*)?$/, (route) => route.fulfill({ json: { available: true, running: true, cwd: "/test" } }));
    await page.routeWebSocket(/\/terminal\/ws\?/, (ws) => {
      socket = ws;
      connections++;
      assert.equal(new URL(ws.url()).searchParams.get("tool"), tool ? "lg" : null);
      ws.onMessage((data) => { if (typeof data !== "string") input.push(data.toString()); });
      ws.send(JSON.stringify({ type: "ready" }));
      ws.send(Buffer.from("Terminal output ready\r\n$ "));
    });
    await ui.run([`goto /t/${task.id}`, tool ? "click Open lazygit in a terminal" : "click terminal"]);
    // xterm (a lazy chunk), the terminal's status and its font load first, which took seconds on a busy CI runner. The
    // socket opens as xterm is set up, so give it its 5s from then.
    await page.locator(".xterm").waitFor({ timeout: 20000 });
    for (const end = Date.now() + 5000; !connections && Date.now() < end;) await page.waitForTimeout(50);
    assert.ok(connections, "terminal connects even when a canvas context is unavailable");
    await page.getByText("Terminal output ready", { exact: false }).waitFor();
    await page.locator(".xterm-helper-textarea").press("a");
    for (const end = Date.now() + 5000; !input.includes("a") && Date.now() < end;) await page.waitForTimeout(50);
    assert.ok(input.includes("a"), "keyboard input reaches the session");
    await ui.run(["click thread"]);
    await page.waitForTimeout(100);
    await ui.run([tool ? "click [title=\"lazygit (open)\"]" : "click terminal"]);
    await page.getByText("Terminal output ready", { exact: false }).waitFor({ state: "visible" });
    assert.equal(connections, 1, "switching tabs preserves the session");
    socket.close({ code: 1000, reason: "Session ended" });
    await ui.run([tool ? "click Start lazygit again" : "click Start a new session"]);
    await page.getByText("Terminal output ready", { exact: false }).waitFor();
    assert.equal(connections, 2);
  });
});

test("a real tmux shell displays command output", { skip: spawnSync("tmux", ["-V"]).status !== 0 }, async () => {
  const task = await server.api("POST", `/projects/${project.id}/tasks`, { title: "Real terminal", status: "in_review" });
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    await ui.run([`goto /t/${task.id}`, "click terminal"]);
    await page.getByText("tmux", { exact: true }).waitFor();
    const input = page.locator(".xterm-helper-textarea");
    await input.fill("printf '\\110\\101\\055\\061\\063\\061\\055\\117\\113\\n'");
    await input.press("Enter");
    await page.locator(".xterm-rows").getByText("HA-131-OK", { exact: false }).waitFor();
  });
});
