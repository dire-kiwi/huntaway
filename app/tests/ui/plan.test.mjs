// A plan in the board's theme, running to the bottom of the task under the composer.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { demoProject, startServer, withBrowser } from "./harness.mjs";

let server, project;
before(async () => {
  server = startServer();
  project = await demoProject(server);
});
after(() => server?.stop());

/** Wait until `locator`'s box stops moving (unchanged over a few animation frames). */
async function settled(locator) {
  let last = null;
  for (let same = 0, tries = 0; same < 3 && tries < 100; tries++) {
    await locator.page().evaluate(() => new Promise((done) => requestAnimationFrame(done)));
    const box = JSON.stringify(await locator.boundingBox());
    same = box === last ? same + 1 : 0;
    last = box;
  }
}

test("a plan is themed, its components work, and it runs to the bottom with room to scroll clear of the composer", async () => {
  const tasks = await server.api("GET", `/projects/${project.id}/tasks`);
  const plan = tasks.find((t) => t.title === "Plan a dark mode for the demo site");
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    await ui.run([`goto /p/${project.id}?task=${plan.id}`, "wait css=iframe"]);
    await page.frameLocator("iframe").first().getByRole("heading", { name: "Dark mode", exact: true }).waitFor();
    const frame = page.frames().find((f) => f !== page.mainFrame());

    // The board's background, and the demo's <ia-html> toggle, a page of its own in a frame in the plan's.
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    assert.equal(await frame.evaluate(() => getComputedStyle(document.body).backgroundColor), bg);
    // The panel slides in, and Playwright's stability check runs inside the frame, so it doesn't see the frame
    // itself move: wait for the frames to stop moving, and for the button's scroll into view to settle, first.
    await settled(page.locator("iframe"));
    // Scrolled into view from the plan's frame: Chromium doesn't run animation frames in an offscreen frame of
    // another origin, which Playwright's checks inside it wait for.
    await frame.locator("ia-html").scrollIntoViewIfNeeded();
    await frame.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
    const toggle = page.frameLocator("iframe").first().frameLocator("ia-html iframe");
    const dark = toggle.locator("button", { hasText: "Dark" });
    await settled(frame.locator("ia-html iframe"));
    await dark.click();
    await toggle.locator("button.on", { hasText: "Dark" }).waitFor();

    // The frame reaches the composer's bottom, and pads its own bottom by what covers it, as that grows.
    const frameBox = await page.locator("iframe").boundingBox();
    const composer = await page.getByPlaceholder("Ask for changes to the plan…").boundingBox();
    assert.ok(frameBox.y + frameBox.height > composer.y + composer.height, `${JSON.stringify(frameBox)} ${JSON.stringify(composer)}`);
    const pad = () => frame.evaluate(() => parseFloat(document.documentElement.style.paddingBottom) || 0);
    const before = await pad();
    assert.ok(before > composer.height, `padding ${before}`);
    await ui.run(["click Ask for changes to the plan", "type one", "press Shift+Enter", "type two", "press Shift+Enter", "type three"]);
    await page.waitForTimeout(200);
    assert.ok((await pad()) > before, `padding ${await pad()} after ${before}`);
  });
});

test("a plan's questions are answered in it, the answers last until they're sent, and Send answers sends them to the agent", async () => {
  const tasks = await server.api("GET", `/projects/${project.id}/tasks`);
  const plan = tasks.find((t) => t.title === "Plan a dark mode for the demo site");
  await withBrowser(server, { allowErrors: [/open-token/] }, async (ui) => {
    const { page } = ui;
    await ui.run([`goto /p/${project.id}?task=${plan.id}`, "wait css=iframe", "wait 2 of 3 questions answered"]);
    const answer = async () => {
      const frame = page.frames().find((f) => f !== page.mainFrame() && f.parentFrame() === page.mainFrame());
      await frame.locator("ia-question[name=notes]").scrollIntoViewIfNeeded();
      return frame;
    };
    let frame = await answer();
    await frame.getByLabel("Only light and dark").check();
    await frame.locator("textarea[name=notes]").fill("Keep the print styles");
    await ui.run(["wait 3 of 3 questions answered"]);
    const state = async () => {
      frame = page.frames().find((f) => f !== page.mainFrame() && f.parentFrame() === page.mainFrame());
      await frame.waitForFunction(() => document.querySelector("textarea[name=notes]"));
      return frame.evaluate(() => [document.querySelector("input[value=two]").checked, document.querySelector("textarea[name=notes]").value]);
    };
    // The frame is made again (from the source view), and the board is reloaded: the answers are put back.
    await ui.run(["click Source", "gone css=iframe", "click Preview", "wait css=iframe"]);
    assert.deepEqual(await state(), [true, "Keep the print styles"]);
    await page.reload();
    await ui.run(["wait css=iframe", "wait 3 of 3 questions answered"]);
    assert.deepEqual(await state(), [true, "Keep the print styles"]);

    await ui.run(["click Send answers", "wait Answers sent"]);
    const messages = await server.api("GET", `/tasks/${plan.id}/messages`);
    const sent = messages.map((m) => m.data?.text ?? m.text ?? JSON.stringify(m.data)).find((t) => /My answers to the questions/.test(t));
    assert.ok(sent, "the answers were sent");
    assert.match(sent, /Which choices should the toggle offer\? \(`toggle-choices`\): Only light and dark/);
    assert.match(sent, /`notes`\): Keep the print styles/);
    // Sent answers aren't put back in: the plan starts from its own again. (With agents off, the run fails, so the
    // task needs attention and opens on its thread.)
    await page.reload();
    await page.getByRole("button", { name: "plan", exact: true }).click();
    await ui.run(["wait css=iframe", "wait 2 of 3 questions answered"]);
    assert.deepEqual(await state(), [false, ""]);
  });
});

/** Open the demo plan on its plan tab (once a send has run its agent, which can't run here, the task opens on its thread). */
async function openPlan(ui, plan) {
  await ui.run([`goto /p/${project.id}?task=${plan.id}`]);
  await ui.page.getByRole("button", { name: "plan", exact: true }).click();
  await ui.run(["wait css=iframe", "wait answered"]);
  const frame = ui.page.frames().find((f) => f !== ui.page.mainFrame() && f.parentFrame() === ui.page.mainFrame());
  await frame.waitForFunction(() => document.querySelector("ia-question .ia-answer, input[name], select[name], textarea[name]"));
  return frame;
}

const demoPlan = async () => (await server.api("GET", `/projects/${project.id}/tasks`)).find((t) => t.title === "Plan a dark mode for the demo site");
const saved = (page) => page.evaluate(() => JSON.parse(Object.entries(localStorage).find(([k]) => k.startsWith("ia.planAnswers"))?.[1] ?? "{}"));

test("answers changed while the answers are being sent are kept, to send next", async () => {
  const plan = await demoPlan();
  await withBrowser(server, { allowErrors: [/open-token/] }, async (ui) => {
    const { page } = ui;
    let release;
    const held = new Promise((done) => (release = done));
    const posted = [];
    await page.route(new RegExp(`/tasks/${plan.id}/messages$`), async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      posted.push(route.request().postDataJSON().text);
      await held;
      await route.continue();
    });
    let frame = await openPlan(ui, plan);
    await frame.locator("textarea[name=notes]").fill("First answer");
    await page.waitForFunction(() => Object.values(localStorage).some((v) => v.includes("First answer")));
    await ui.run(["click Send answers"]);
    while (!posted.length) await page.waitForTimeout(50);
    await frame.locator("textarea[name=notes]").fill("Second answer");
    await page.waitForFunction(() => Object.values(localStorage).some((v) => v.includes("Second answer")));
    const sent = page.waitForResponse((r) => r.url().endsWith(`/tasks/${plan.id}/messages`) && r.request().method() === "POST");
    release();
    await sent;
    await page.waitForTimeout(300);
    assert.match(posted[0], /`notes`\): First answer/);
    assert.deepEqual(await saved(page), { notes: { v: ["Second answer"] } });
    assert.equal(await page.getByText("Answers sent").count(), 0);
    assert.ok(await page.getByRole("button", { name: "Send answers" }).isEnabled());
    await page.reload();
    frame = await openPlan(ui, plan);
    assert.equal(await frame.locator("textarea[name=notes]").inputValue(), "Second answer");
  });
});

test("Reset in the source view drops the answers from what Send answers sends", async () => {
  const plan = await demoPlan();
  await withBrowser(server, { allowErrors: [/open-token/] }, async (ui) => {
    const { page } = ui;
    const posted = [];
    await page.route(new RegExp(`/tasks/${plan.id}/messages$`), (route) => {
      if (route.request().method() === "POST") posted.push(route.request().postDataJSON().text);
      return route.continue();
    });
    let frame = await openPlan(ui, plan);
    await frame.locator("textarea[name=notes]").fill("Discard me");
    await page.waitForFunction(() => Object.values(localStorage).some((v) => v.includes("Discard me")));
    await ui.run(["click Source", "gone css=iframe", "click Reset", "click Send answers", "wait Answers sent"]);
    assert.equal(posted.length, 1);
    assert.doesNotMatch(posted[0], /Discard me/);
    assert.match(posted[0], /`notes`\): \(no answer\)/);
    assert.match(posted[0], /`toggle-choices`\): Light, system and dark/);
    await ui.run(["click Preview", "wait css=iframe"]);
    frame = page.frames().find((f) => f !== page.mainFrame() && f.parentFrame() === page.mainFrame());
    await frame.waitForFunction(() => document.querySelector("textarea[name=notes]"));
    assert.equal(await frame.locator("textarea[name=notes]").inputValue(), "");
  });
});

test("a checkbox question with every choice unticked can be sent, as none of them", async () => {
  const plan = await demoPlan();
  await withBrowser(server, { allowErrors: [/open-token/] }, async (ui) => {
    const { page } = ui;
    const at = new Date().toISOString();
    const content = `<h1>Extras</h1><ia-question name="extras" type="checkbox" title="Which extras?"><option value="a" selected>A</option><option value="b">B</option></ia-question>`;
    await page.route(new RegExp(`/tasks/${plan.id}/document(\\?.*)?$`), (route) =>
      route.fulfill({ json: { task_type: "plan", file: "plan.html", versions: [{ version: 1, open: false, created_at: at, updated_at: at, size: content.length }], version: 1, content } }),
    );
    const posted = [];
    await page.route(new RegExp(`/tasks/${plan.id}/messages$`), (route) => {
      if (route.request().method() === "POST") posted.push(route.request().postDataJSON().text);
      return route.continue();
    });
    const frame = await openPlan(ui, plan);
    await ui.run(["wait 1 of 1 question answered"]);
    await frame.getByLabel("A", { exact: true }).uncheck();
    await ui.run(["wait 1 of 1 question answered"]);
    assert.ok(await page.getByRole("button", { name: "Send answers" }).isEnabled());
    await ui.run(["click Send answers", "wait Answers sent"]);
    assert.match(posted[0], /Which extras\? \(`extras`\): \(none of the choices\)/);
  });
});

test("a send that ends after the plan's view was opened again keeps the answers changed in the new one", async () => {
  const plan = await demoPlan();
  await withBrowser(server, { allowErrors: [/open-token/] }, async (ui) => {
    const { page } = ui;
    let release;
    const held = new Promise((done) => (release = done));
    const posted = [];
    await page.route(new RegExp(`/tasks/${plan.id}/messages$`), async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      posted.push(route.request().postDataJSON().text);
      await held;
      await route.continue();
    });
    let frame = await openPlan(ui, plan);
    await frame.locator("textarea[name=notes]").fill("First answer");
    await page.waitForFunction(() => Object.values(localStorage).some((v) => v.includes("First answer")));
    await ui.run(["click Send answers"]);
    while (!posted.length) await page.waitForTimeout(50);
    // Another tab and back: a new view of the plan, while the send goes on.
    await page.getByRole("button", { name: "thread", exact: true }).click();
    await page.getByRole("button", { name: "plan", exact: true }).click();
    await ui.run(["wait css=iframe", "wait answered"]);
    frame = page.frames().find((f) => f !== page.mainFrame() && f.parentFrame() === page.mainFrame());
    await frame.waitForFunction(() => document.querySelector("textarea[name=notes]")?.value === "First answer");
    await frame.locator("textarea[name=notes]").fill("Second answer");
    await page.waitForFunction(() => Object.values(localStorage).some((v) => v.includes("Second answer")));
    const sent = page.waitForResponse((r) => r.url().endsWith(`/tasks/${plan.id}/messages`) && r.request().method() === "POST");
    release();
    await sent;
    await page.waitForTimeout(300);
    assert.equal(posted.length, 1);
    assert.match(posted[0], /`notes`\): First answer/);
    assert.deepEqual(await saved(page), { notes: { v: ["Second answer"] } });
    await page.reload();
    frame = await openPlan(ui, plan);
    assert.equal(await frame.locator("textarea[name=notes]").inputValue(), "Second answer");
  });
});

test("going back to the latest version in the source view doesn't offer to send an earlier version's fields", async () => {
  const plan = await demoPlan();
  await withBrowser(server, { allowErrors: [/open-token/] }, async (ui) => {
    const { page } = ui;
    const at = new Date().toISOString();
    const versions = [1, 2].map((version) => ({ version, open: false, created_at: at, updated_at: at, size: 10 }));
    const content = (v) => `<h1>Version ${v}</h1><ia-question name="v${v}" type="text" title="Question in v${v}?"></ia-question>`;
    await page.route(new RegExp(`/tasks/${plan.id}/document(\\?.*)?$`), (route) => {
      const version = Number(new URL(route.request().url()).searchParams.get("version")) || 2;
      return route.fulfill({ json: { task_type: "plan", file: "plan.html", versions, version, content: content(version) } });
    });
    const posted = [];
    await page.route(new RegExp(`/tasks/${plan.id}/messages$`), (route) => {
      if (route.request().method() === "POST") posted.push(route.request().postDataJSON().text);
      return route.continue();
    });
    let frame = await openPlan(ui, plan);
    await frame.locator("input[name=v2]").fill("for v2");
    await ui.run(["wait 1 of 1 question answered"]);
    await page.locator('select[title^="Versions"]').selectOption("1");
    await ui.run(["wait Back to the latest"]);
    frame = page.frames().find((f) => f !== page.mainFrame() && f.parentFrame() === page.mainFrame());
    await frame.waitForFunction(() => document.querySelector("input[name=v1]"));
    // An earlier version's fields can't be answered or sent.
    assert.equal(await page.getByRole("button", { name: "Send answers" }).count(), 0);
    await ui.run(["click Source", "gone css=iframe", "click Back to the latest", "gone Back to the latest", "wait Question in v2"]);
    assert.equal(await page.getByRole("button", { name: "Send answers" }).count(), 0);
    assert.deepEqual(await saved(page), { v2: { v: ["for v2"] } });
    await ui.run(["click Preview", "wait css=iframe", "wait 1 of 1 question answered", "click Send answers", "wait Answers sent"]);
    assert.equal(posted.length, 1);
    assert.match(posted[0], /\(v2\)/);
    assert.match(posted[0], /Question in v2\? \(`v2`\): for v2/);
  });
});

test("a version written over while the source view shows doesn't offer to send or reset the fields it had before", async () => {
  const plan = await demoPlan();
  await withBrowser(server, { allowErrors: [/open-token/] }, async (ui) => {
    const { page } = ui;
    let socket;
    await page.routeWebSocket(/\/api\/ws/, (ws) => {
      socket = ws;
      ws.connectToServer();
    });
    const at = new Date().toISOString();
    // Version 1 is open (the agent's turn is writing it), so its content changes without a new version.
    let content = `<h1>Plan</h1><ia-question name="first" type="text" title="First question?"></ia-question>`;
    await page.route(new RegExp(`/tasks/${plan.id}/document(\\?.*)?$`), (route) =>
      route.fulfill({ json: { task_type: "plan", file: "plan.html", versions: [{ version: 1, open: true, created_at: at, updated_at: at, size: content.length }], version: 1, content } }),
    );
    const posted = [];
    await page.route(new RegExp(`/tasks/${plan.id}/messages$`), (route) => {
      if (route.request().method() === "POST") posted.push(route.request().postDataJSON().text);
      return route.continue();
    });
    let frame = await openPlan(ui, plan);
    await frame.locator("input[name=first]").fill("an answer");
    await ui.run(["wait 1 of 1 question answered"]);
    await ui.run(["click Source", "gone css=iframe"]);
    // The agent replaces the question: the board hears the document changed, and fetches it again.
    content = `<h1>Plan</h1><ia-question name="second" type="text" title="Second question?"></ia-question>`;
    const { task } = await server.api("GET", `/tasks/${plan.id}`);
    socket.send(JSON.stringify({ type: "task", task: { ...task, document_at: new Date(Date.now() + 1000).toISOString() } }));
    await ui.run(["wait Second question"]);
    assert.equal(await page.getByRole("button", { name: "Send answers" }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "Reset" }).count(), 0);
    assert.deepEqual(await saved(page), { first: { v: ["an answer"] } });
    // Its own form, once it's shown, has its own question.
    await ui.run(["click Preview", "wait css=iframe", "wait 0 of 1 question answered"]);
    frame = page.frames().find((f) => f !== page.mainFrame() && f.parentFrame() === page.mainFrame());
    await frame.locator("input[name=second]").fill("the other answer");
    await ui.run(["wait 1 of 1 question answered", "click Send answers", "wait Answers sent"]);
    assert.equal(posted.length, 1);
    assert.match(posted[0], /Second question\? \(`second`\): the other answer/);
    assert.doesNotMatch(posted[0], /First question/);
  });
});

test("a plan form's own reset button puts its fields back for Send answers and for the next load", async () => {
  const plan = await demoPlan();
  await withBrowser(server, { allowErrors: [/open-token/] }, async (ui) => {
    const { page } = ui;
    const at = new Date().toISOString();
    const content = `<h1>Owner</h1><form><label>Owner <input name="owner" value="Alice"></label><button type="reset">Reset form</button></form>`;
    await page.route(new RegExp(`/tasks/${plan.id}/document(\\?.*)?$`), (route) =>
      route.fulfill({ json: { task_type: "plan", file: "plan.html", versions: [{ version: 1, open: false, created_at: at, updated_at: at, size: content.length }], version: 1, content } }),
    );
    const posted = [];
    await page.route(new RegExp(`/tasks/${plan.id}/messages$`), (route) => {
      if (route.request().method() === "POST") posted.push(route.request().postDataJSON().text);
      return route.continue();
    });
    let frame = await openPlan(ui, plan);
    await frame.locator("input[name=owner]").fill("Bob");
    await page.waitForFunction(() => Object.values(localStorage).some((v) => v.includes("Bob")));
    await frame.getByRole("button", { name: "Reset form" }).click();
    assert.equal(await frame.locator("input[name=owner]").inputValue(), "Alice");
    await page.waitForFunction(() => !Object.values(localStorage).some((v) => v.includes("Bob")));
    assert.deepEqual(await saved(page), {});
    await page.reload();
    frame = await openPlan(ui, plan);
    assert.equal(await frame.locator("input[name=owner]").inputValue(), "Alice");
    // And without a reload in between: what's sent is what's shown.
    await frame.locator("input[name=owner]").fill("Bob");
    await page.waitForFunction(() => Object.values(localStorage).some((v) => v.includes("Bob")));
    await frame.getByRole("button", { name: "Reset form" }).click();
    await page.waitForFunction(() => !Object.values(localStorage).some((v) => v.includes("Bob")));
    await ui.run(["click Send answers", "wait Answers sent"]);
    assert.equal(posted.length, 1);
    assert.match(posted[0], /Owner \(`owner`\): Alice/);
  });
});

test("a plan form's reset that its own handler calls off keeps the answers", async () => {
  const plan = await demoPlan();
  await withBrowser(server, { allowErrors: [/open-token/] }, async (ui) => {
    const { page } = ui;
    const at = new Date().toISOString();
    const content = `<h1>Owner</h1><form onreset="event.preventDefault()"><label>Owner <input name="owner" value="Alice"></label><button type="reset">Reset form</button></form>`;
    await page.route(new RegExp(`/tasks/${plan.id}/document(\\?.*)?$`), (route) =>
      route.fulfill({ json: { task_type: "plan", file: "plan.html", versions: [{ version: 1, open: false, created_at: at, updated_at: at, size: content.length }], version: 1, content } }),
    );
    let frame = await openPlan(ui, plan);
    await frame.locator("input[name=owner]").fill("Bob");
    await page.waitForFunction(() => Object.values(localStorage).some((v) => v.includes("Bob")));
    await frame.getByRole("button", { name: "Reset form" }).click();
    await page.waitForTimeout(300);
    assert.equal(await frame.locator("input[name=owner]").inputValue(), "Bob");
    assert.deepEqual(await saved(page), { owner: { v: ["Bob"] } });
    await page.reload();
    frame = await openPlan(ui, plan);
    assert.equal(await frame.locator("input[name=owner]").inputValue(), "Bob");
  });
});
