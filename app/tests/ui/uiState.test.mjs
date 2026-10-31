import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { demoProject, startServer, withBrowser } from "./harness.mjs";

let server, project;
before(async () => {
  server = startServer();
  project = await demoProject(server);
});
after(() => server?.stop());

/** Lets the test send events to the page, as the host would (the page's own still come through). */
async function events(page) {
  let socket;
  await page.routeWebSocket(/\/api\/ws/, (ws) => {
    socket = ws;
    ws.connectToServer();
  });
  return (ev) => socket.send(JSON.stringify(ev));
}

/** Holds back the requests matching `re` (and `method`) until `release()`. */
async function hold(page, re, method = "GET") {
  let release;
  const held = new Promise((r) => (release = r));
  let seen = 0;
  await page.route(re, async (route) => {
    if (route.request().method() !== method) return route.fallback();
    seen++;
    await held;
    await route.fallback();
  });
  return { release, seen: () => seen };
}

const until = async (page, fn, what, show = async () => "") => {
  for (const end = Date.now() + 5000; Date.now() < end; await page.waitForTimeout(50)) if (await fn()) return;
  assert.fail(`timed out waiting for ${what} ${await show()}`);
};

// IA-161: a refresh (on a resync, a reconnect or hosts_changed) replaced every task with what it loaded, so a task event
// that came while it loaded was undone (a card kept its old state) and a task deleted meanwhile came back.
test("a refresh keeps the task events that came while it loaded", async () => {
  const renamed = await server.api("POST", `/projects/${project.id}/tasks`, { title: "Refresh: before", status: "in_review" });
  const deleted = await server.api("POST", `/projects/${project.id}/tasks`, { title: "Refresh: deleted", status: "in_review" });
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    const send = await events(page);
    await ui.run([`goto /p/${project.id}`, "wait Refresh: before", "wait Refresh: deleted"]);
    const lists = await hold(page, new RegExp(`/projects/${project.id}/tasks\\?kind=task$`));
    send({ type: "resync" });
    await until(page, () => lists.seen() > 0, "the refresh to ask for the tasks");
    // While it loads: the task changes, and the other is deleted.
    send({ type: "task", task: { ...renamed, title: "Refresh: after" } });
    send({ type: "task_deleted", id: deleted.id });
    await ui.run(["wait Refresh: after", "gone Refresh: deleted"]);
    lists.release();
    await page.waitForLoadState("networkidle");
    await ui.run(["sleep 300", "wait Refresh: after", "gone Refresh: before", "gone Refresh: deleted"]);
  });
});

// IA-161 review: two refreshes whose answers came out of order: the older one put back the title the newer one had.
test("a refresh that ends after a newer one doesn't undo it", async () => {
  const task = await server.api("POST", `/projects/${project.id}/tasks`, { title: "Order: old", status: "in_review" });
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    const send = await events(page);
    await ui.run([`goto /p/${project.id}`, "wait Order: old"]);
    await page.waitForLoadState("networkidle");
    // The first refresh's list is read now and held back; the second's says the task was renamed later on.
    const answers = [];
    await page.route(new RegExp(`/projects/${project.id}/tasks\\?kind=task$`), async (route) => {
      const res = await route.fetch();
      const list = await res.json();
      const n = answers.length;
      if (n === 1) for (const t of list) if (t.id === task.id) Object.assign(t, { title: "Order: new", updated_at: new Date(Date.now() + 60_000).toISOString() });
      await new Promise((r) => answers.push(r));
      await route.fulfill({ response: res, json: list });
    });
    send({ type: "resync" });
    await until(page, () => answers.length === 1, "the first refresh");
    send({ type: "resync" });
    await until(page, () => answers.length === 2, "the second refresh");
    answers[1]();
    await ui.run(["wait Order: new"]);
    answers[0]();
    await page.waitForLoadState("networkidle");
    await ui.run(["sleep 300", "wait Order: new", "gone Order: old"]);
  });
});

// IA-161: the composer kept its draft in its own state, so going to another tab or card lost it, and sending cleared what
// was typed while it sent.
// IA-161 review: what an older refresh loaded counted as a change made meanwhile in a newer one that was still loading,
// which then kept a task it found deleted and the old names of projects, when the two ended in order.
for (const order of ["in order", "out of order"]) {
  test(`overlapping refreshes that end ${order} leave the newer one's tasks and projects`, async () => {
    const name = `Overlap ${order}`;
    const task = await server.api("POST", `/projects/${project.id}/tasks`, { title: name, status: "todo" });
    await withBrowser(server, {}, async (ui) => {
      const { page } = ui;
      const send = await events(page);
      await ui.run([`goto /p/${project.id}`, `wait ${name}`]);
      await page.waitForLoadState("networkidle");
      // The second refresh reads the project renamed and the task deleted.
      let second = false;
      await page.route(/\/profiles\/[^/]+\/projects$/, async (route) => {
        const res = await route.fetch();
        const list = await res.json();
        if (second) for (const p of list) if (p.id === project.id) p.name = `Renamed ${order}`;
        await route.fulfill({ response: res, json: list });
      });
      const answers = [];
      await page.route(new RegExp(`/projects/${project.id}/tasks\\?kind=task$`), async (route) => {
        const res = await route.fetch();
        let list = await res.json();
        if (answers.length === 1) list = list.filter((t) => t.id !== task.id);
        await new Promise((r) => answers.push(r));
        await route.fulfill({ response: res, json: list });
      });
      send({ type: "resync" });
      await until(page, () => answers.length === 1, "the first refresh");
      second = true;
      send({ type: "resync" });
      await until(page, () => answers.length === 2, "the second refresh");
      const first = order === "in order" ? [0, 1] : [1, 0];
      answers[first[0]]();
      await page.waitForTimeout(300);
      answers[first[1]]();
      await page.waitForLoadState("networkidle");
      await ui.run(["sleep 300", `wait Renamed ${order}`, `gone ${name}`]);
    });
    await server.api("DELETE", `/tasks/${task.id}`);
  });
}

test("the composer keeps its draft across tabs, cards and a reload, and what's typed while sending", async () => {
  // In To do, so their cards aren't under the task's panel.
  const task = await server.api("POST", `/projects/${project.id}/tasks`, { title: "Draft: one", status: "todo" });
  const other = await server.api("POST", `/projects/${project.id}/tasks`, { title: "Draft: two", status: "todo" });
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    const composer = page.locator("textarea[placeholder='Add extra instructions, or press Enter to start']");
    await ui.run([`goto /p/${project.id}?task=${task.id}`, "click thread", "wait No agent has worked on this yet"]);
    await composer.fill("A draft for the agent");
    await ui.run(["click changes", "gone No agent has worked on this yet", "click thread"]);
    assert.equal(await composer.inputValue(), "A draft for the agent", "after another tab");
    await page.locator(`[data-task="${other.id}"]`).click();
    await page.locator("header").getByText("Draft: two").first().waitFor();
    await ui.run(["click thread"]);
    assert.equal(await composer.inputValue(), "", "another task has its own");
    await page.locator(`[data-task="${task.id}"]`).click();
    await page.locator("header").getByText("Draft: one").first().waitFor();
    await ui.run(["click thread"]);
    assert.equal(await composer.inputValue(), "A draft for the agent", "after another card");
    await page.reload();
    await ui.run(["click thread"]);
    assert.equal(await composer.inputValue(), "A draft for the agent", "after a reload");

    // Sending, slowly (and without starting an agent): what's typed meanwhile stays, and what was sent goes.
    let sent;
    await page.route(`**/tasks/${task.id}/messages`, async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      sent = route.request().postDataJSON().text;
      await new Promise((r) => setTimeout(r, 800));
      await route.fulfill({ json: task });
    });
    await composer.focus();
    await page.keyboard.press("Control+End");
    await page.keyboard.press("Enter");
    await page.keyboard.type(" and more");
    await until(page, async () => (await composer.inputValue()) === "and more", "the sent text to go", async () => JSON.stringify({ value: await composer.inputValue(), sent }));
    assert.equal(sent, "A draft for the agent");
  });
});

// IA-161 review: a send still going when the composer went (another card or tab) left what was sent in the saved draft,
// so it came back, ready to be sent again; and a composer opened meanwhile could send it a second time.
test("a message sent while its composer is gone doesn't come back as a draft", async () => {
  const task = await server.api("POST", `/projects/${project.id}/tasks`, { title: "Send: one", status: "todo" });
  const other = await server.api("POST", `/projects/${project.id}/tasks`, { title: "Send: two", status: "todo" });
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    const composer = page.locator("textarea[placeholder='Add extra instructions, or press Enter to start']");
    const sendButton = page.getByTitle("Send (Enter)");
    let posts = 0;
    const answers = [];
    await page.route(`**/tasks/${task.id}/messages`, async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      posts++;
      await new Promise((r) => answers.push(r));
      await route.fulfill({ json: task });
    });
    const answer = async () => {
      await until(page, () => answers.length > 0, "the send");
      answers.shift()();
    };

    // Sent, then another card opened before the host answers.
    await ui.run([`goto /p/${project.id}?task=${task.id}`, "click thread"]);
    await composer.fill("Send this once");
    await composer.press("Enter");
    await page.locator(`[data-task="${other.id}"]`).click();
    await page.locator("header").getByText("Send: two").first().waitFor();
    await answer();
    await page.locator(`[data-task="${task.id}"]`).click();
    await page.locator("header").getByText("Send: one").first().waitFor();
    await ui.run(["click thread"]);
    assert.equal(await composer.inputValue(), "", "after another card");

    // Sent, then another tab and back before the host answers: the send is shown under way, and can't go again.
    await composer.fill("Send this once too");
    await composer.press("Enter");
    await ui.run(["click changes", "click thread"]);
    assert.equal(await composer.inputValue(), "Send this once too");
    assert.ok(await sendButton.isDisabled(), "the send button waits for the send under way");
    await composer.press("Enter");
    await answer();
    await until(page, async () => (await composer.inputValue()) === "", "the sent text to go");
    assert.equal(posts, 2);
    assert.equal(await page.evaluate((id) => Object.keys(localStorage).filter((k) => k.includes(id)).length, task.id), 0, "no saved draft");
  });
});

// IA-161 review: a draft the browser's storage couldn't take (full) threw in the composer, and the whole app went blank.
test("a draft the browser can't store stays usable, and its send still goes", async () => {
  const task = await server.api("POST", `/projects/${project.id}/tasks`, { title: "Full: one", status: "todo" });
  const other = await server.api("POST", `/projects/${project.id}/tasks`, { title: "Full: two", status: "todo" });
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    const composer = page.locator("textarea[placeholder='Add extra instructions, or press Enter to start']");
    const notice = page.getByText("This browser couldn't save the draft");
    await ui.run([`goto /p/${project.id}?task=${task.id}`, "click thread"]);
    await composer.fill("Short");
    const stored = () => page.evaluate((id) => Object.entries(localStorage).find(([k]) => k.includes(id))?.[1] ?? null, task.id);
    await until(page, async () => (await stored())?.includes("Short"), "the draft to be stored");
    // The storage is full from here on.
    await page.evaluate(() => {
      const setItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function (k, v) {
        if (k.startsWith("ia.composer.draft.")) throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
        return setItem.call(this, k, v);
      };
    });
    await composer.focus();
    await page.keyboard.press("Control+End");
    await page.keyboard.type(", and then a much longer draft");
    await page.waitForTimeout(200);
    assert.ok(await composer.isVisible(), `the app is still there: ${(await page.locator("#root").innerHTML()).length} bytes`);
    assert.equal(await composer.inputValue(), "Short, and then a much longer draft");
    await notice.waitFor();
    // It's kept on the page, across cards.
    await page.locator(`[data-task="${other.id}"]`).click();
    await page.locator("header").getByText("Full: two").first().waitFor();
    await page.locator(`[data-task="${task.id}"]`).click();
    await page.locator("header").getByText("Full: one").first().waitFor();
    await ui.run(["click thread"]);
    assert.equal(await composer.inputValue(), "Short, and then a much longer draft", "after another card");
    // And it's sent, as a send, not an error; the draft is cleared from the storage too.
    let sent;
    await page.route(`**/tasks/${task.id}/messages`, async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      sent = route.request().postDataJSON().text;
      await route.fulfill({ json: task });
    });
    await composer.press("Enter");
    await until(page, async () => (await composer.inputValue()) === "", "the sent text to go");
    assert.equal(sent, "Short, and then a much longer draft");
    await notice.waitFor({ state: "detached" });
    assert.equal(await stored(), null);
    assert.equal(await page.locator(".text-danger").count(), 0, "no error");
  });
});

// IA-161: a change to the description while it was being edited replaced the edit, and a failed save said nothing.
test("an edit of the description survives a change to it, and a failed save says so", async () => {
  const task = await server.api("POST", `/projects/${project.id}/tasks`, { title: "Describe me", description: "Old text", status: "in_review" });
  await withBrowser(server, { allowErrors: [/status of 500/] }, async (ui) => {
    const { page } = ui;
    const send = await events(page);
    await ui.run([`goto /p/${project.id}?task=${task.id}`, "click details", "wait Old text", "click Edit"]);
    const field = page.locator("aside textarea");
    await field.fill("My new text");
    send({ type: "task", task: { ...task, description: "Changed elsewhere", updated_at: new Date().toISOString() } });
    await ui.run(["wait It was changed while you were editing it"]);
    assert.equal(await field.inputValue(), "My new text");

    await page.route(`**/tasks/${task.id}`, (route) =>
      route.request().method() === "PATCH" ? route.fulfill({ status: 500, json: { error: "disk full" } }) : route.fallback(),
    );
    await page.getByRole("button", { name: /^Save/ }).click();
    await ui.run(["wait Couldn't save the description: disk full"]);
    assert.equal(await field.inputValue(), "My new text");
  });
});

// IA-161: the Stop buttons ignored a failed request.
test("a Stop that fails says so", async () => {
  const task = await server.api("POST", `/projects/${project.id}/tasks`, { title: "Stop me", status: "in_progress" });
  await withBrowser(server, { allowErrors: [/status of 500/] }, async (ui) => {
    const { page } = ui;
    const send = await events(page);
    await page.route(`**/tasks/${task.id}/stop`, (route) => route.fulfill({ status: 500, json: { error: "host went away" } }));
    await ui.run([`goto /p/${project.id}?task=${task.id}`, "wait Stop me"]);
    send({ type: "task", task: { ...task, running: true } });
    // In the header, and in the composer.
    await page.locator("header button", { hasText: "Stop" }).click();
    await ui.run(["wait Couldn't stop the agent: host went away"]);
    await page.locator("header [title='Dismiss']").click();
    await ui.run(["gone Couldn't stop the agent"]);
    await page.locator("button:has(svg.lucide-square)").last().click();
    await ui.run(["wait Couldn't stop the agent: host went away"]);
  });
});

// IA-161: the board loaded everything twice on start: before the events socket connected, and again once it had.
test("the board loads once on start", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    let hosts = 0;
    page.on("request", (r) => new URL(r.url()).pathname === "/api/hosts" && hosts++);
    await ui.run([`goto /p/${project.id}`, "wait Demo"]);
    await page.waitForLoadState("networkidle");
    assert.equal(hosts, 1);
  });
});

// IA-161: cards were clickable divs the keyboard couldn't reach, and dialogs weren't dialogs to screen readers, nor kept focus.
test("cards open from the keyboard, and dialogs hold the focus", async () => {
  const task = await server.api("POST", `/projects/${project.id}/tasks`, { title: "Keyboard card", status: "in_review" });
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    await ui.run([`goto /p/${project.id}`, "wait Keyboard card"]);
    const card = page.locator(`[data-task="${task.id}"]`);
    assert.equal(await card.getAttribute("role"), "button");
    await card.focus();
    await page.keyboard.press("Enter");
    await page.locator("header").getByText("Keyboard card").first().waitFor();
    await page.keyboard.press("Escape");

    const opener = page.getByRole("button", { name: "New task" }).first();
    await opener.click();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor();
    assert.ok(await dialog.getAttribute("aria-labelledby"));
    assert.ok(await dialog.evaluate((el) => el.contains(document.activeElement)), "the dialog has the focus");
    for (let i = 0; i < 30; i++) {
      await page.keyboard.press(i % 3 ? "Tab" : "Shift+Tab");
      assert.ok(await dialog.evaluate((el) => el.contains(document.activeElement)), `Tab ${i} left the dialog`);
    }
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
    assert.ok(await opener.evaluate((el) => el === document.activeElement), "the focus is back on what opened it");
  });
});
