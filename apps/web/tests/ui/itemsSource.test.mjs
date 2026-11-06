// HA-222: tasks whose items are their thread's source (apps/server/src/threads/source.ts) have no messages since they
// moved onto items. Their thread is drawn from items whatever the Keep threads as items setting, and so are what read
// a thread outside it: a needs-attention card's prompts (Triage) and a plan's last reply, which read messages before.
import assert from "node:assert/strict";
import { afterAll, beforeAll, test } from "vite-plus/test";
import { demoProject, startServer, withBrowser } from "./harness.mjs";

let server, project;
beforeAll(async () => {
  // Agents run with scripts/fake-claude, so a started task's agent replies without a model.
  server = startServer("--fake-claude");
  project = await demoProject(server);
});
afterAll(() => server?.stop());

/** Waits until `f` gives something truthy (the board's state, read through its API). */
async function until(what, f, ms = 15_000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v) return v;
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const task = async (id) => (await server.api("GET", `/tasks/${id}`)).task;
const idle = (id) => until(`${id} to be idle`, async () => !(await task(id)).running);

test("a task on items is drawn from its items, with the setting off too, and has no messages", async () => {
  const t = await server.api("POST", `/projects/${project.id}/tasks`, { title: "On items", description: "Say hello" });
  await server.api("POST", `/tasks/${t.id}/messages`, { text: "Say hi, please" });
  await idle(t.id);
  assert.equal((await task(t.id)).thread_source, "items");
  assert.deepEqual(await server.api("GET", `/tasks/${t.id}/messages`), []);
  await withBrowser(server, {}, async (ui) => {
    await ui.run([`goto /p/${project.id}?task=${t.id}`, "click Thread", "wait Say hi, please", "wait Fake reply to:"]);
    await server.api("PATCH", "/settings", { thread_items: false });
    try {
      await ui.page.reload();
      await ui.run(["click Thread", "wait Say hi, please", "wait Fake reply to:"]);
    } finally {
      await server.api("PATCH", "/settings", { thread_items: null });
    }
  });
});

test("a task on items shows its prompt on its Triage card, and it's answered there", async () => {
  const t = await server.api("POST", `/projects/${project.id}/tasks`, { title: "Asks for a permission", description: "Needs a prompt" });
  await server.api("POST", `/tasks/${t.id}/messages`, { text: "fake-ask-permission" });
  await until("its prompt", async () => (await server.api("GET", `/permissions?task_id=${t.id}`)).length > 0);
  assert.equal((await task(t.id)).thread_source, "items");
  await withBrowser(server, {}, async (ui) => {
    await ui.run([`goto /p/${project.id}`, "click Triage view: what needs you, most pressing first"]);
    // A picked card shows the prompts its task waits on.
    await ui.run(["click Approve Bash?", "wait Allow"]);
    await ui.page.getByRole("button", { name: "Allow" }).click();
  });
  await idle(t.id);
  const thread = await server.api("GET", `/tasks/${t.id}/thread`);
  const said = thread.items
    .filter((i) => i.type === "assistant_message")
    .map((i) => i.text)
    .join("\n");
  assert.match(said, /permission Bash: allow/);
});

test("a plan on items shows its agent's last reply under it", async () => {
  const plan = (await server.api("GET", `/projects/${project.id}/tasks`)).find((t) => t.title === "Plan a dark mode for the demo site");
  await server.api("POST", `/tasks/${plan.id}/messages`, { text: "Tighten the approach section" });
  await idle(plan.id);
  assert.equal((await task(plan.id)).thread_source, "items");
  await withBrowser(server, { allowErrors: [/open-token/] }, async (ui) => {
    await ui.run([`goto /p/${project.id}?task=${plan.id}`]);
    await ui.page.getByRole("button", { name: "plan", exact: true }).click();
    await ui.run(["wait css=iframe", "wait css=button[aria-expanded=false]:has-text('Summary')", "click Summary", "wait Fake reply to:"]);
  });
});
