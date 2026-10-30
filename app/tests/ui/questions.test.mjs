// HA-9: agents' questions (request_user_input, AskUserQuestion, Codex's) and plans (ExitPlanMode) are answered from
// cards in the thread, not as permission prompts with raw JSON.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { demoProject, routeThread, startServer, withBrowser } from "./harness.mjs";

let server, project;
before(async () => {
  server = startServer();
  project = await demoProject(server);
});
after(() => server?.stop());

/** A thread of `items` ([kind, data] pairs), as a host stores it. */
function thread(taskId, items) {
  return items.map(([kind, data], i) => ({ id: i + 1, task_id: taskId, kind, data, created_at: `2026-10-31T07:00:${String(i).padStart(2, "0")}.000Z` }));
}

/** Answers what the cards send (a prompt's decision, or a question's answer) as a host would, and returns what they sent. */
async function capture(page) {
  const sent = [];
  await page.route(/\/api\/h\/[^/]+\/(permissions\/[^/?]+|tasks\/[^/]+\/questions\/\d+)$/, (route) => {
    if (route.request().method() !== "POST") return route.continue();
    sent.push({ path: new URL(route.request().url()).pathname.replace(/^\/api\/h\/[^/]+/, ""), body: route.request().postDataJSON() });
    return route.fulfill({ json: { ok: true, status: "allowed" } });
  });
  return sent;
}

/** Waits for the `n`th thing sent. */
async function nth(sent, n) {
  for (const end = Date.now() + 3000; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) if (sent.length >= n) return sent[n - 1];
  assert.fail(`only ${sent.length} sent, waiting for ${n}`);
}

const user = (text) => ["user", { text }];
const colour = {
  call_id: "c1",
  question: "Which colour should the button be?",
  options: [
    { label: "Red", description: "Bold" },
    { label: "Green", description: "Calm" },
    { label: "Blue", description: "Neutral" },
  ],
  multi_select: false,
  allow_other: true,
  status: "pending",
};

test("a request_user_input question is answered with a click or keys 1-9, not while typing", async () => {
  const task = await server.api("POST", `/projects/${project.id}/tasks`, { title: "Board question" });
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    await routeThread(page, task.id, thread(task.id, [user("Start"), ["question", colour]]));
    const sent = await capture(page);
    await ui.run([`goto /p/${project.id}?task=${task.id}`, "click Thread", "wait Which colour should the button be?", "wait The agent asks", "wait Bold"]);

    // Typed in the composer, a number is just a number.
    const composer = page.locator("textarea").last();
    await composer.click();
    await ui.run(["type 2"]);
    assert.equal(await composer.inputValue(), "2");
    assert.equal(sent.length, 0);

    // Elsewhere, it picks that option and sends it.
    await ui.run(["click Which colour should the button be?", "press 2"]);
    assert.deepEqual(await nth(sent, 1), { path: `/tasks/${task.id}/questions/2`, body: { choices: ["Green"], text: null } });
    // Or a click.
    await ui.run(["click Blue"]);
    assert.deepEqual((await nth(sent, 2)).body, { choices: ["Blue"], text: null });
    // Or an answer of one's own, with Enter.
    await ui.run(["click Or write your own answer", "type  Purple ", "press Enter"]);
    assert.deepEqual((await nth(sent, 3)).body, { choices: [], text: "Purple" });
  });
});

test("questions with several answers, and answered ones", async () => {
  const task = await server.api("POST", `/projects/${project.id}/tasks`, { title: "Board questions" });
  const pets = { ...colour, call_id: "c2", question: "Which pets?", options: [{ label: "Cats" }, { label: "Dogs" }, { label: "Birds" }], multi_select: true };
  const answered = { ...colour, status: "answered", answer: { choices: ["Red"], text: null } };
  const replied = { ...colour, question: "Which font?", options: [], status: "replied" };
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    await routeThread(page, task.id, thread(task.id, [["question", answered], ["question", replied], user("Serif"), ["question", pets]]));
    const sent = await capture(page);
    await ui.run([`goto /p/${project.id}?task=${task.id}`, "click Thread", "wait Which pets?", "wait answered in the thread", "wait css=[aria-label='Question from the agent'] >> text=answered"]);
    // The answered one shows its answer, and can't be answered again.
    assert.equal(await page.getByRole("radio", { name: "Red" }).getAttribute("aria-checked"), "true");
    assert.equal(await page.getByRole("radio", { name: "Red" }).isDisabled(), true);

    // Keys go to the latest question: here they tick, and Send sends them with what's typed.
    await ui.run(["click Which pets?", "press 1", "press 3", "press 3", "press 3", "click Something else (optional)", "type A lizard", "click Send answer"]);
    assert.deepEqual(await nth(sent, 1), { path: `/tasks/${task.id}/questions/4`, body: { choices: ["Cats", "Birds"], text: "A lizard" } });
  });
});

const askData = (extra = {}) => ({
  tool_name: "AskUserQuestion",
  request_id: "ask-1",
  tool_use_id: "toolu_1",
  status: "pending",
  input: {
    questions: [
      { question: "Which season?", header: "Season", multiSelect: false, options: [{ label: "Spring", description: "Spring" }, { label: "Summer", description: "Warm days" }] },
      { question: "Which pets?", header: "Pets", multiSelect: true, options: [{ label: "Cats" }, { label: "Dogs" }, { label: "Birds" }] },
    ],
  },
  ...extra,
});

test("Claude's AskUserQuestion is answered from its card, question by question", async () => {
  const task = await server.api("POST", `/projects/${project.id}/tasks`, { title: "Ask user" });
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    await routeThread(page, task.id, thread(task.id, [user("Start"), ["permission", askData()]]));
    const sent = await capture(page);
    await ui.run([`goto /p/${project.id}?task=${task.id}`, "click Thread", "wait Claude asks 2 questions", "wait Warm days", "gone Claude wants to use", "gone Always allow"]);
    // A description that only repeats its label isn't shown.
    assert.equal(await page.getByRole("radio", { name: "Spring" }).getByText("Spring").count(), 1);
    // Not until every question has an answer.
    assert.equal(await page.getByRole("button", { name: "Submit answers" }).isDisabled(), true);

    // Picking the season moves on to the pets, where keys tick.
    await ui.run(["click Which season?", "press 2", "press 1", "press 3"]);
    await ui.run(["click Submit answers"]);
    assert.deepEqual(await nth(sent, 1), { path: "/permissions/ask-1", body: { decision: "allow", answers: [["Summer"], ["Cats", "Birds"]] } });

    // Dismissed, it's declined with a note to the agent.
    await ui.run(["click Dismiss"]);
    assert.deepEqual((await nth(sent, 2)).body, { decision: "deny", message: "The user dismissed these questions without answering them." });
  });
});

test("a question whose run ended is answered by message, and answered ones show their answers", async () => {
  const task = await server.api("POST", `/projects/${project.id}/tasks`, { title: "Late answers" });
  const answered = askData({ request_id: "ask-0", status: "allowed", answers: [["Spring"], ["Dogs", "A lizard"]] });
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    await routeThread(page, task.id, thread(task.id, [["permission", answered], user("Again"), ["permission", askData({ status: "expired" })]]));
    const sent = await capture(page);
    await ui.run([`goto /p/${project.id}?task=${task.id}`, "click Thread", "wait Claude asked 2 questions", "wait A lizard", "wait run ended before these were answered"]);
    assert.equal(await page.getByRole("checkbox", { name: "Dogs" }).first().getAttribute("aria-checked"), "true");
    await ui.run(["click css=[aria-label='Questions from Claude'] >> nth=1 >> text=Which season?", "press 1"]);
    await ui.run(["click css=[aria-label='Your own answer to: Which pets?']", "type Fish", "click Send answers"]);
    assert.deepEqual(await nth(sent, 1), { path: "/permissions/ask-1", body: { decision: "allow", answers: [["Spring"], ["Fish"]] } });
  });
});

// HA-9 review: every expired question and plan stayed open, and keys 1-9 answered long-superseded ones.
test("a question or plan the conversation has moved past isn't answered any more", async () => {
  const task = await server.api("POST", `/projects/${project.id}/tasks`, { title: "Moved on" });
  const plan = { tool_name: "ExitPlanMode", request_id: "plan-1", status: "expired", input: { plan: "# Plan: Old plan\n\nDo it" } };
  const items = [["question", colour], ["permission", askData({ status: "expired" })], ["permission", plan], user("Do something else"), ["permission", askData({ request_id: "ask-2", status: "expired", input: { questions: [{ question: "Still open?", options: [{ label: "Yes" }] }] } })]];
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    await routeThread(page, task.id, thread(task.id, items));
    const sent = await capture(page);
    await ui.run([`goto /p/${project.id}?task=${task.id}`, "click Thread", "wait Which colour should the button be?", "wait Old plan", "wait not answered", "wait Still open?"]);
    // The ones before the user's message are closed; the expired one after it can still be answered.
    assert.equal(await page.getByRole("button", { name: "Approve" }).count(), 0);
    assert.equal(await page.getByRole("radio", { name: "Green" }).isDisabled(), true);
    assert.equal(await page.getByRole("button", { name: "Send answers" }).count(), 1);
    await ui.run(["click Which colour should the button be?", "press 1"]);
    assert.deepEqual(await nth(sent, 1), { path: "/permissions/ask-2", body: { decision: "allow", answers: [["Yes"]] } });
  });
});

test("Codex's questions get the same card, and its other prompts say it's Codex asking", async () => {
  const task = await server.api("POST", `/projects/${project.id}/tasks`, { title: "Codex asks" });
  const codexQuestion = {
    tool_name: "request_user_input",
    agent: "codex",
    request_id: "cq",
    status: "pending",
    input: { questions: [{ id: "name", header: "Name", question: "Which file name?", options: [{ label: "a.txt", description: "" }], isOther: false, isSecret: false, multiSelect: false }] },
  };
  const bash = { tool_name: "Bash", agent: "codex", request_id: "cb", status: "pending", input: { command: "ls" } };
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    await routeThread(page, task.id, thread(task.id, [user("Start"), ["permission", codexQuestion], ["permission", bash]]));
    const sent = await capture(page);
    await ui.run([`goto /p/${project.id}?task=${task.id}`, "click Thread", "wait Codex asks", "wait Which file name?", "wait Codex wants to use", "gone Claude wants to use"]);
    // It takes no answer of the user's own, so it has no field for one.
    assert.equal(await page.getByLabel("Your own answer to: Which file name?").count(), 0);
    // A lone question is answered by picking.
    await ui.run(["click text=a.txt"]);
    assert.deepEqual(await nth(sent, 1), { path: "/permissions/cq", body: { decision: "allow", answers: [["a.txt"]] } });
  });
});

// HA-9 review: the mode picked for a plan started as the project's or host's, so approving reset the thread's own.
test("a plan's mode starts as the thread's own", async () => {
  const task = await server.api("POST", `/projects/${project.id}/tasks`, { title: "Own mode" });
  await server.api("PATCH", `/tasks/${task.id}`, { permission_mode: "acceptEdits" });
  const plan = { tool_name: "ExitPlanMode", request_id: "plan-1", status: "pending", input: { plan: "Do it" } };
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    await routeThread(page, task.id, thread(task.id, [user("Go"), ["permission", plan]]));
    const sent = await capture(page);
    await ui.run([`goto /p/${project.id}?task=${task.id}`, "click Thread", "wait Plan ready for approval"]);
    assert.equal(await page.getByLabel("Mode to continue in").inputValue(), "acceptEdits");
    await ui.run(["click Approve"]);
    assert.deepEqual((await nth(sent, 1)).body, { decision: "allow", mode: "acceptEdits" });
  });
});

test("a plan is approved into the mode picked, or sent back with feedback", async () => {
  const task = await server.api("POST", `/projects/${project.id}/tasks`, { title: "Plan" });
  const plan = { tool_name: "ExitPlanMode", request_id: "plan-1", status: "pending", input: { plan: "# Plan: Add a cache\n\n## Steps\n\n1. Add **the cache**\n2. Test it" } };
  const approved = { ...plan, request_id: "plan-0", status: "allowed", mode: "acceptEdits" };
  const kept = { ...plan, request_id: "plan-00", status: "denied", feedback: "Test the eviction too." };
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    await routeThread(page, task.id, thread(task.id, [["permission", kept], ["permission", approved], user("Go"), ["permission", plan]]));
    const sent = await capture(page);
    await ui.run([`goto /p/${project.id}?task=${task.id}`, "click Thread", "wait Plan ready for approval", "wait css=strong >> text=the cache", "wait Continued in Accept edits.", "wait Test the eviction too."]);
    // The plan as Markdown, its title above it, not as JSON.
    assert.equal(await page.getByRole("heading", { name: "Steps" }).count(), 1);
    assert.equal(await page.getByRole("heading", { name: "Plan: Add a cache" }).count(), 0);
    await ui.run(["gone Claude wants to use", "gone css=pre >> text=planFilePath"]);

    await page.getByLabel("Mode to continue in").selectOption("acceptEdits");
    await ui.run(["click Approve"]);
    assert.deepEqual(await nth(sent, 1), { path: "/permissions/plan-1", body: { decision: "allow", mode: "acceptEdits" } });

    await ui.run(["click css=[aria-label='Plan from the agent'] >> nth=2 >> text=Keep planning", "type Cache misses too.", "click css=[aria-label='Plan from the agent'] >> nth=2 >> button:has-text('Keep planning')"]);
    assert.deepEqual((await nth(sent, 2)).body, { decision: "deny", feedback: "Cache misses too." });
  });
});
