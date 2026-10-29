import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { demoProject, startServer, withBrowser } from "./harness.mjs";

const TOKEN = "good-token";
const asanaTask = (gid, name, completed = false, notes = `Steps for ${name}.`) => ({
  gid,
  name,
  completed,
  notes,
  permalink_url: `https://app.asana.com/0/1/${gid}`,
  assignee: { name: "Ivy" },
  projects: [{ name: "Web" }],
  workspace: { name: "Acme" },
});
const TASKS = [asanaTask("1001", "Fix login redirect", false, "Users land on /404 after login."), asanaTask("1002", "Write onboarding docs"), asanaTask("1003", "Old bug", true)];

// A fake Asana API for the test server (IA_ASANA_URL), taking only TOKEN.
const asana = createServer((req, res) => {
  const send = (status, body) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { errors: [{ message: "Not Authorized" }] });
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/users/me") return send(200, { data: { gid: "9", name: "Ivy", email: "ivy@example.com", workspaces: [{ gid: "100" }] } });
  if (url.pathname === "/workspaces/100/typeahead") {
    const q = (url.searchParams.get("query") ?? "").toLowerCase();
    return send(200, { data: TASKS.filter((t) => t.name.toLowerCase().includes(q)) });
  }
  if (url.pathname === "/tasks/5000") return send(500, { errors: [{ message: "Server Error" }] });
  const task = TASKS.find((t) => url.pathname === `/tasks/${t.gid}`);
  // Task 1002 takes a while to look up, so there's time to press Enter before it's found.
  const delay = task?.gid === "1002" ? 1500 : 0;
  setTimeout(() => (task ? send(200, { data: task }) : send(404, { errors: [{ message: "Unknown object" }] })), delay);
});

let server, project;
before(async () => {
  await new Promise((resolve) => asana.listen(0, "127.0.0.1", resolve));
  process.env.IA_ASANA_URL = `http://127.0.0.1:${asana.address().port}`;
  server = startServer();
  project = await demoProject(server);
});
after(() => {
  server?.stop();
  asana.close();
});

const tasks = () => server.api("GET", `/projects/${project.id}/tasks`);

// IA-211: the task sidebar's Asana section connects the profile to Asana, then finds an Asana task and links it.
test("links a task to an Asana task from its sidebar", async () => {
  const [task] = await tasks();
  await withBrowser(server, { allowErrors: [/status of 400 .*\/profiles\//] }, async (ui) => {
    await ui.run([
      `goto /p/${project.id}?task=${task.id}`,
      "wait Not linked to an Asana task",
      "click Link Asana task…",
      "wait Asana personal access token",
      "type nope",
      "press Enter",
      "wait didn't accept the token",
      "click Asana personal access token",
      "press Control+a",
      `type ${TOKEN}`,
      "press Enter",
      // Open tasks first.
      "wait Fix login redirect",
      "wait Old bug",
      // Escape closes the dialog, not the task's panel too.
      "press Escape",
      "gone Search Asana tasks",
      "click Link Asana task…",
      // What it found for nothing typed stays until what's typed is found.
      "wait Fix login redirect",
      "type docs",
      "gone Fix login redirect",
      "press Enter",
      "gone [data-modal]",
      "wait text=Write onboarding docs",
    ]);
  });
  const linked = (await server.api("GET", `/tasks/${task.id}`)).task.external_links;
  assert.deepEqual(linked, [{ provider: "asana", id: "1002", url: "https://app.asana.com/0/1/1002", title: "Write onboarding docs" }]);
});

// IA-211: the new task form links an Asana task (here by its pasted link), whose name and notes describe the task
// when nothing's written yet. Escape in the Asana dialog leaves the form open with what's in it.
test("a new task is linked to the Asana task picked for it", async () => {
  const before = new Set((await tasks()).map((t) => t.id));
  await withBrowser(server, {}, async (ui) => {
    await ui.run([
      `goto /p/${project.id}`,
      "click New task",
      "click Link Asana task",
      "wait Fix login redirect",
      "press Escape",
      "gone Search Asana tasks",
      "wait Create task",
      "click Link Asana task",
      // The board's card linked above has it in a tooltip, so it's looked for in the list.
      "wait role=option[name=/Write onboarding docs/]",
      "type https://app.asana.com/0/1/1001/f",
      "gone role=option[name=/Write onboarding docs/]",
      "press Enter",
      "gone Search Asana tasks",
      "assert document.querySelector('textarea').value === 'Fix login redirect\\n\\nUsers land on /404 after login.'",
      "press Control+Enter",
      "gone Create task",
    ]);
  });
  const created = (await tasks()).filter((t) => !before.has(t.id));
  assert.equal(created.length, 1);
  assert.deepEqual(created[0].external_links, [{ provider: "asana", id: "1001", url: "https://app.asana.com/0/1/1001", title: "Fix login redirect" }]);
});

// IA-211 review: Enter while what's typed is still being looked up doesn't pick from what was found for what was
// typed before (here the first of the tasks found for nothing typed), but waits to pick what's found for it. And the
// Asana task picked is kept with the form's draft, like what's written, so the task made from it later is linked too.
test("Enter picks only what's found for what's typed, and a draft keeps the Asana task picked", async () => {
  const before = new Set((await tasks()).map((t) => t.id));
  await withBrowser(server, {}, async (ui) => {
    await ui.run([
      `goto /p/${project.id}`,
      "click New task",
      "click Link Asana task",
      "wait role=option[name=/Fix login redirect/]",
      "type https://app.asana.com/0/1/1002",
      "press Enter",
      "sleep 300",
      "assert document.querySelectorAll('[data-modal]').length === 2",
      "assert document.querySelector('textarea').value === ''",
      "gone role=option[name=/Fix login redirect/]",
      "press Enter",
      "gone Search Asana tasks",
      "assert document.querySelector('textarea').value === 'Write onboarding docs\\n\\nSteps for Write onboarding docs.'",
      "wait [aria-label='Unlink Write onboarding docs']",
      // Closed without creating it, then opened again.
      "press Escape",
      "gone Create task",
      "click New task",
      "wait [aria-label='Unlink Write onboarding docs']",
      "assert document.querySelector('textarea').value.startsWith('Write onboarding docs')",
      "press Control+Enter",
      "gone Create task",
    ]);
  });
  const created = (await tasks()).filter((t) => !before.has(t.id));
  assert.equal(created.length, 1);
  assert.deepEqual(created[0].external_links, [{ provider: "asana", id: "1002", url: "https://app.asana.com/0/1/1002", title: "Write onboarding docs" }]);
});

// IA-211 review: Ctrl+Enter in the Asana dialog doesn't create the task from the form underneath, while what's typed
// is still being looked up (when there's nothing to pick yet), after the lookup failed, or when it picks a task.
test("Ctrl+Enter in the Asana dialog doesn't create the new task", async () => {
  const before = (await tasks()).length;
  await withBrowser(server, { allowErrors: [/status of 502 .*\/asana\/tasks/] }, async (ui) => {
    await ui.run([
      `goto /p/${project.id}`,
      "click New task",
      "type Keep this open",
      "click Link Asana task",
      "wait role=option[name=/Fix login redirect/]",
      "type https://app.asana.com/0/1/1002",
      "press Control+Enter",
      "sleep 300",
      "assert document.querySelectorAll('[data-modal]').length === 2",
      "click Search Asana tasks",
      "press Control+a",
      "type https://app.asana.com/0/1/5000",
      "wait Server Error",
      "press Control+Enter",
      "sleep 300",
      "assert document.querySelectorAll('[data-modal]').length === 2",
      "press Escape",
      "gone Search Asana tasks",
      "wait Create task",
      "assert document.querySelector('textarea').value === 'Keep this open'",
      // Nor when it picks a task: only the dialog closes, and the form has the link until it's created.
      "click Link Asana task",
      "wait role=option[name=/Fix login redirect/]",
      "press Control+Enter",
      "gone Search Asana tasks",
      "sleep 300",
      "assert document.querySelectorAll('[data-modal]').length === 1",
      "wait [aria-label='Unlink Fix login redirect']",
      "wait Create task",
      "assert document.querySelector('textarea').value === 'Keep this open'",
    ]);
  });
  assert.equal((await tasks()).length, before);
});

// IA-216: a profile with Asana turned off leaves it out of the new task form, and its tasks' sidebars only list the
// links they had, to unlink them.
test("a profile with Asana turned off leaves it out", async () => {
  const [profile] = await server.api("GET", "/profiles");
  const linked = (await tasks()).find((t) => t.external_links?.length);
  const other = (await tasks()).find((t) => t.kind === "task" && !t.external_links?.length);
  await server.api("PATCH", `/profiles/${profile.id}`, { asana_enabled: false });
  try {
    await withBrowser(server, {}, async (ui) => {
      await ui.run([
        `goto /p/${project.id}?task=${linked.id}`,
        `wait [aria-label='Unlink ${linked.external_links[0].title}']`,
        "assert !document.body.innerText.includes('Link Asana task')",
        `goto /p/${project.id}?task=${other.id}`,
        "wait Description",
        "assert !document.body.innerText.includes('Not linked to an Asana task')",
        `goto /p/${project.id}`,
        "click New task",
        "wait Start agent now",
        "assert !document.body.innerText.includes('Link Asana task')",
      ]);
    });
  } finally {
    await server.api("PATCH", `/profiles/${profile.id}`, { asana_enabled: true });
  }
});

// IA-216 review: the new task form moving to a host from before Asana links (API 57) and back, as `@` does on a
// profile's board, leaves the link button out there and doesn't crash the page.
test("the new task form moves between hosts before and after Asana links", async () => {
  const old = startServer();
  try {
    const host = await server.api("POST", "/hosts", { url: old.url, token: old.token });
    await withBrowser(server, {}, async (ui) => {
      const { page } = ui;
      await page.route("**/api/hosts", async (route) => {
        const res = await route.fetch();
        // Named apart, so the two Demo projects' `@` words are @DEMO.test and @DEMO.old.
        const hosts = (await res.json()).map((h) => (h.id === host.id ? { ...h, api_version: 56, name: "old" } : h));
        await route.fulfill({ response: res, json: hosts });
      });
      // Both hosts have a Default profile with a Demo project, and the form opens in whichever loaded first.
      await ui.run(["goto /profile/Default", "click New task", "wait Start agent now", "type @DEMO.test", "press Space", "wait Link Asana task"]);
      for (const [to, shown] of [["@DEMO.old", 0], ["@DEMO.test", 1], ["@DEMO.old", 0], ["@none", 1]]) {
        await page.locator("textarea").fill(`${to} `);
        await ui.run(["wait Start agent now", "sleep 200"]);
        assert.equal(await page.getByText("Link Asana task").count(), shown, to);
      }
    });
  } finally {
    old.stop();
  }
});
