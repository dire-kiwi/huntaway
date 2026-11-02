import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { after, before, test } from "node:test";
import { demoProject, startServer, withBrowser } from "./harness.mjs";

let server, project;
before(async () => {
  // Agents run with scripts/fake-claude, so a started task's agent runs without a model.
  server = startServer("--fake-claude");
  project = await demoProject(server);
});
after(() => server?.stop());

// The task once the dialog's request has made it (the dialog closing doesn't wait for the board to show it).
const byDescription = async (description) => {
  for (let i = 0; i < 100; i++) {
    const t = (await server.api("GET", `/projects/${project.id}/tasks`)).find((t) => t.description === description);
    if (t) return t;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.fail(`no task "${description}"`);
};

// HA-109: the new task dialog sends the prompt as the description with `start: true`, which is the user's prompt, so
// "Create & start" puts the task in Now. Creating without starting leaves it in Later.
test("a task made with Create & start is in Now, one only created is in Later", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    await ui.run([`goto /p/${project.id}`, "click New task", "type Say hello from the dialog"]);
    const toggle = page.getByRole("switch", { name: "Start agent now" });
    if ((await toggle.getAttribute("aria-checked")) !== "true") await toggle.click();
    await ui.run(["press Control+Enter", "gone Create & start"]);
    const started = await byDescription("Say hello from the dialog");
    assert.ok(started.now_at, "the prompt put it in Now");

    await ui.run(["click New task", "type Only make this one"]);
    const again = page.getByRole("switch", { name: "Start agent now" });
    if ((await again.getAttribute("aria-checked")) === "true") await again.click();
    await ui.run(["press Control+Enter", "gone Only make this one"]);
    const made = await byDescription("Only make this one");
    assert.equal(made.now_at, null, "no prompt, so it's in Later");

    // The Now view shows the started one, not the other.
    await ui.run(["click Only the tasks in Now"]);
    await page.waitForFunction((id) => !!document.querySelector(`[data-task="${id}"]`), started.id);
    assert.equal(await page.locator(`[data-task="${made.id}"]`).count(), 0);
  });
});

// HA-109 review: an answer typed into a question card is a prompt to the agent too (the card posts to its own
// endpoint, not the thread's).
test("answering an agent's question from its card puts the task in Now", async () => {
  const task = await server.api("POST", `/projects/${project.id}/tasks`, { title: "Asks a question", description: "Needs an answer" });
  const card = { call_id: "c1", question: "Which colour should the button be?", options: [{ label: "Red" }, { label: "Green" }], multi_select: false, allow_other: true, status: "pending" };
  execFileSync(
    "python3",
    [
      "-c",
      `
import json, sqlite3, sys
c = sqlite3.connect(sys.argv[1])
c.execute("insert into messages (task_id,kind,data,created_at) values (?,?,?,?)", (sys.argv[2], 'question', sys.argv[3], '2026-10-31T07:00:00.000Z'))
c.commit()
`,
      `${server.dataDir}/huntaway.db`,
      task.id,
      JSON.stringify(card),
    ],
  );
  assert.equal((await server.api("GET", `/tasks/${task.id}`)).task.now_at, null);
  await withBrowser(server, {}, async (ui) => {
    await ui.run([`goto /p/${project.id}?task=${task.id}`, "click Thread", "wait Which colour should the button be?", "click Or write your own answer", "type Please do the second change instead", "press Enter"]);
    await ui.run(["wait Fake reply to:"]);
  });
  assert.ok((await server.api("GET", `/tasks/${task.id}`)).task.now_at, "the answer put it in Now");
});

// HA-109 review: so is an answer to Claude's own AskUserQuestion card (it posts to the permission's endpoint).
test("answering Claude's own question card puts the task in Now", async () => {
  const task = await server.api("POST", `/projects/${project.id}/tasks`, { title: "Claude asks", description: "Needs an answer too" });
  const ask = {
    tool_name: "AskUserQuestion",
    request_id: "ask-now",
    tool_use_id: "toolu_1",
    status: "expired",
    input: { questions: [{ question: "Which pets?", header: "Pets", multiSelect: true, options: [{ label: "Cats" }, { label: "Dogs" }] }] },
  };
  execFileSync(
    "python3",
    [
      "-c",
      `
import json, sqlite3, sys
c = sqlite3.connect(sys.argv[1])
cur = c.execute("insert into messages (task_id,kind,data,created_at) values (?,?,?,?)", (sys.argv[2], 'permission', sys.argv[3], '2026-10-31T07:00:00.000Z'))
c.execute("insert into permission_requests (id,task_id,message_id,tool_name,input,status,created_at,kind) values (?,?,?,?,?,?,?,?)", ('ask-now', sys.argv[2], cur.lastrowid, 'AskUserQuestion', json.dumps(json.loads(sys.argv[3])['input']), 'expired', '2026-10-31T07:00:00.000Z', 'tool'))
c.commit()
`,
      `${server.dataDir}/huntaway.db`,
      task.id,
      JSON.stringify(ask),
    ],
  );
  assert.equal((await server.api("GET", `/tasks/${task.id}`)).task.now_at, null);
  await withBrowser(server, {}, async (ui) => {
    await ui.run([`goto /p/${project.id}?task=${task.id}`, "click Thread", "wait Which pets?", "click css=[aria-label='Your own answer to: Which pets?']", "type Fish", "click Send answers"]);
    await ui.run(["wait Fake reply to:"]);
  });
  assert.ok((await server.api("GET", `/tasks/${task.id}`)).task.now_at, "the answers put it in Now");
});
