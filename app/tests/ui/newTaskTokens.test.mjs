import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { after, before, test } from "node:test";
import { startServer, withBrowser } from "./harness.mjs";

let server;
let project;
let dep;
let shopfront;
before(async () => {
  server = startServer();
  const repo = `${server.dataDir}/shop`;
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
  const [profile] = await server.api("GET", "/profiles");
  project = await server.api("POST", `/profiles/${profile.id}/projects`, { name: "Shop", repo_path: repo, key: "SHOP" });
  dep = await server.api("POST", `/projects/${project.id}/tasks`, { title: "Checkout rework" });
  // SHOP-1 is the start of SHOP-10 and SHOP-11, and SHOP of SHOPF.
  for (let i = 2; i <= 11; i++) await server.api("POST", `/projects/${project.id}/tasks`, { title: `Chore ${i}` });
  shopfront = await server.api("POST", `/profiles/${profile.id}/projects`, { name: "Shopfront", repo_path: `${server.dataDir}/shopfront`, key: "SHOPF" });
  // A project keyed like `@none`.
  await server.api("POST", `/profiles/${profile.id}/projects`, { name: "Nonesuch", repo_path: `${server.dataDir}/nonesuch`, key: "NONE" });
});
after(() => server?.stop());

const value = "document.querySelector('textarea').value";
const created = async (description) => (await server.api("GET", `/projects/${project.id}/tasks`)).find((t) => t.description === description);

// IA-220: the new task dialog's options are tokens typed in its description, picked from a list as they're typed,
// and taken out of what its agent is given.
test("tokens set a new task's options, and are taken out of its description", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    await ui.run([
      `goto /p/${project.id}`,
      "click New task",
      "wait Reads as",
      "type /pl",
      "wait role=option[name=/plan/]",
      "press Tab",
      `assert ${value} === '/plan '`,
      "wait New plan in Shop",
      "type Price rules !son",
      "press Enter",
      "type ^hi",
      "press Tab",
      "type @XYZ #SHOP-1",
      "wait role=option[name=/Checkout rework/]",
      // Escape closes the list, not the dialog.
      "press Escape",
      "gone role=listbox",
      "assert document.querySelectorAll('[data-modal]').length === 1",
      "press Space",
      "wait after SHOP-1",
    ]);
    assert.equal(await page.evaluate(value), "/plan Price rules !sonnet ^high @XYZ #SHOP-1 ");
    // Known tokens are marked; one that isn't (@XYZ: there's nowhere else to go from a project's board) is left as text.
    const marked = await page.$$eval("[data-modal] [aria-hidden] span[class*=bg-]", (els) => els.map((e) => [e.textContent, e.className.includes("amber")]));
    assert.deepEqual(marked, [
      ["/plan", false],
      ["!sonnet", false],
      ["^high", false],
      ["@XYZ", true],
      ["#SHOP-1", false],
    ]);
    assert.match(await page.locator("[aria-label='Reads as']").innerText(), /Plan\s+Shop\s+Sonnet\s+high effort\s+after SHOP-1/);
    // A chip's × takes its token out.
    await ui.run(["click [title='Remove the model']", "gone Sonnet", `assert ${value} === '/plan Price rules ^high @XYZ #SHOP-1'`, "press Control+Enter", "gone Reads as"]);
  });
  const task = await created("Price rules @XYZ");
  assert.ok(task);
  assert.deepEqual([task.task_type, task.model, task.effort, task.depends_on], ["plan", null, "high", [dep.id]]);
});

// IA-220: on a profile's board, `@` and a project's key put the task in that project. The draft keeps the tokens.
test("@ puts a task in another project, and its draft keeps the tokens", async () => {
  await withBrowser(server, {}, async (ui) => {
    await ui.run([
      "goto /profile/Default",
      "click New task",
      "wait Reads as",
      "type @SHOP",
      "press Enter",
      "wait New task in Shop",
      "type Fix totals `@none` /nothing",
      "press Escape",
      "gone Reads as",
      "click New task",
      "wait New task in Shop",
      `assert ${value} === '@SHOP Fix totals \`@none\` /nothing'`,
      "press Control+Enter",
      "gone Reads as",
    ]);
  });
  assert.ok(await created("Fix totals `@none` /nothing"));
});

// IA-220 review: Ctrl+Enter with the caret still in a token that's the start of another (#SHOP-1 of #SHOP-10, @SHOP
// of @SHOPF) takes it as typed, rather than sending it to the agent as text.
test("Ctrl+Enter takes the token being typed, even when it's the start of another", async () => {
  await withBrowser(server, {}, async (ui) => {
    await ui.run([`goto /p/${project.id}`, "click New task", "wait Reads as", "type Fix checkout #SHOP-1", "wait role=option[name=/SHOP-10/]", "press Control+Enter", "gone Reads as"]);
    await ui.run(["goto /profile/Default", "click New task", "wait Reads as", "type Fix totals @SHOP", "wait role=option[name=/Shopfront/]", "press Control+Enter", "gone Reads as"]);
  });
  const task = await created("Fix checkout");
  assert.deepEqual(task?.depends_on, [dep.id]);
  assert.ok(await created("Fix totals"));
});

// IA-220 review: `@none` is always no project, also beside a project keyed NONE (which has a word of its own).
test("@none is no project even with a project keyed NONE", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    await ui.run(["goto /profile/Default", "click New task", "wait Reads as", "type @non", "wait role=option[name=/Nonesuch/]"]);
    assert.match(await page.locator("role=option[name=/Nonesuch/]").innerText(), /^@NONE\.\S+/);
    await ui.run(["click role=option[name=/No project/]", "wait New scratch task in Default", "type Just a question", "press Control+Enter", "gone Reads as"]);
  });
  const [profile] = await server.api("GET", "/profiles");
  const task = (await server.api("GET", `/profiles/${profile.id}/tasks`)).find((t) => t.description === "Just a question");
  assert.deepEqual([task?.project_id, task?.task_type], [null, "scratch"]);
});

// IA-220 review: a draft of nothing but tokens is kept, with the options they pick.
test("a draft of only tokens is kept", async () => {
  await withBrowser(server, {}, async (ui) => {
    await ui.run([
      `goto /p/${project.id}`,
      "click New task",
      "wait Reads as",
      "type /plan !sonnet",
      "press Space",
      "press Escape",
      "gone Reads as",
      "click New task",
      "wait New plan in Shop",
      `assert ${value} === '/plan !sonnet '`,
    ]);
  });
});

// IA-220 review: after Add another creates a task somewhere else, that's where the dialog opens next, so the next
// task's draft is kept there too and comes back with its tokens.
test("with Add another, the next task's draft follows the task created somewhere else", async () => {
  await withBrowser(server, {}, async (ui) => {
    await ui.run([
      "goto /profile/Default",
      "click New task",
      "wait Reads as",
      "type @SHOPF",
      "press Space",
      "type /plan First task",
      "click Add another",
      "press Control+Enter",
      "wait Created",
      `assert ${value} === '@SHOPF /plan '`,
      "type Second task not yet submitted",
      "press Escape",
      "gone Reads as",
      "click New task",
      "wait New plan in Shopfront",
      `assert ${value} === '@SHOPF /plan Second task not yet submitted'`,
    ]);
  });
});

// IA-220 review: a draft already saved where Add another created a task comes back into the dialog (nothing new is
// written in it yet), rather than being written over by the next one's.
test("a draft saved where Add another creates a task comes back rather than being written over", async () => {
  const notes = "Long Shopfront notes I was writing";
  await withBrowser(server, {}, async (ui) => {
    await ui.run([
      `goto /p/${shopfront.id}`,
      "click New task",
      "wait Reads as",
      `type ${notes}`,
      "press Escape",
      "gone Reads as",
      "goto /profile/Default",
      "click New task",
      "wait Reads as",
      "type @SHOPF",
      "press Space",
      "type First task",
      "click Add another",
      "press Control+Enter",
      "wait Created",
      `assert ${value} === '${notes}'`,
      "press Escape",
      "gone Reads as",
      `goto /p/${shopfront.id}`,
      "click New task",
      "wait Reads as",
      `assert ${value} === '${notes}'`,
    ]);
  });
});

// IA-220 review: the project the dialog starts in is the board's as it is now, so a repository that became git's after
// the board loaded (which the dialog's refresh finds) gets worktrees and offers subprojects.
test("a repository that becomes git's after the board loads gets worktrees and subprojects", async () => {
  const [profile] = await server.api("GET", "/profiles");
  const dir = `${server.dataDir}/later`;
  mkdirSync(dir);
  const later = await server.api("POST", `/profiles/${profile.id}/projects`, { name: "Later", repo_path: dir, key: "LATER", use_worktrees: true });
  assert.equal(later.is_git, false);
  await withBrowser(server, {}, async (ui) => {
    await ui.run([`goto /p/${later.id}`, "wait New task"]);
    execFileSync("git", ["init", "-q", dir]);
    // A subproject is offered once the dialog's refresh is in.
    await ui.run(["click New task", "type /subproject", "press Space", "wait New subproject in Later", "type Fresh task", "press Control+Enter", "gone Reads as"]);
    await ui.run(["click New task", "wait Own git worktree", "type Plain task", "press Control+Enter", "gone Reads as"]);
  });
  const tasks = await server.api("GET", `/projects/${later.id}/tasks`);
  const plain = tasks.find((t) => t.description === "Plain task");
  const sub = tasks.find((t) => t.description === "Fresh task");
  assert.equal(plain?.use_worktree, true);
  assert.deepEqual([sub?.subproject, sub?.use_worktree], [true, true]);
});

// IA-220 review: a draft brought back by Add another keeps its files (and Asana tasks) when its `@` sends it to another
// host than the task just created: they're on that host, so moving there mustn't drop them.
test("a draft brought back by Add another keeps its files on the host its @ sends it to", async () => {
  const remote = startServer();
  try {
    const host = await server.api("POST", "/hosts", { url: remote.url, token: remote.token });
    const drafted = `JSON.parse(localStorage.getItem('ia.newTask.draft.${shopfront.id}') ?? 'null')`;
    await withBrowser(server, {}, async (ui) => {
      const { page } = ui;
      // Named apart from this one, so its Demo project is @DEMO.remote.
      await page.route("**/api/hosts", async (route) => {
        const res = await route.fetch();
        await route.fulfill({ response: res, json: (await res.json()).map((h) => (h.id === host.id ? { ...h, name: "remote" } : h)) });
      });
      // A draft in Shopfront's dialog that goes to the other host's project, with a file uploaded there.
      await ui.run([
        "goto /profile/Default",
        `eval localStorage.setItem('ia.newTask.project', '${shopfront.id}')`,
        "goto /profile/Default",
        "click New task",
        "wait New task in Shopfront",
        "type @DEMO.re",
        "press Enter",
        "wait New task in Demo (remote)",
        "type Saved remote notes",
      ]);
      await page.locator("[data-modal] input[type=file]").setInputFiles({ name: "saved.txt", mimeType: "text/plain", buffer: Buffer.from("notes") });
      await page.waitForFunction(`${drafted}?.files?.length === 1`);
      // Then Add another from Shop's dialog creates a task in Shopfront, which brings that draft back.
      await ui.run([
        "press Escape",
        "gone Reads as",
        `eval localStorage.setItem('ia.newTask.project', '${project.id}')`,
        "goto /profile/Default",
        "click New task",
        "wait New task in Shop",
        "type @SHOPF",
        "press Space",
        "type First local task",
        "click Add another",
        "press Control+Enter",
        "wait Created",
        `assert ${value} === '@DEMO.remote Saved remote notes'`,
        "wait New task in Demo (remote)",
        "wait saved.txt",
        "sleep 500",
        "wait saved.txt",
        // The note of the task just made stays, with its own key.
        "wait Created SHOPF-",
        `assert ${drafted}.files.length === 1`,
      ]);
    });
  } finally {
    remote.stop();
  }
});

// IA-220 review: moving the caret into an `@` already taken (REM, the start of REMOTE) doesn't move the task back to
// where the dialog started while it's there, which would drop the files uploaded where the `@` sends it.
test("moving the caret into and out of an @ keeps where the task goes and its files", async () => {
  const remote = startServer();
  try {
    await server.api("POST", "/hosts", { url: remote.url, token: remote.token });
    const [theirs] = await remote.api("GET", "/profiles");
    await remote.api("POST", `/profiles/${theirs.id}/projects`, { name: "Remnant", repo_path: `${remote.dataDir}/remnant`, key: "REM" });
    await remote.api("POST", `/profiles/${theirs.id}/projects`, { name: "Faraway", repo_path: `${remote.dataDir}/faraway`, key: "REMOTE" });
    const drafted = `JSON.parse(localStorage.getItem('ia.newTask.draft.${shopfront.id}') ?? 'null')`;
    await withBrowser(server, {}, async (ui) => {
      const { page } = ui;
      await ui.run([
        "goto /profile/Default",
        `eval localStorage.setItem('ia.newTask.project', '${shopfront.id}')`,
        "goto /profile/Default",
        "click New task",
        "wait New task in Shopfront",
        "type @REM",
        "wait role=option[name=/Faraway/]",
        "press Space",
        "wait New task in Remnant",
        "type Saved remote notes",
      ]);
      await page.locator("[data-modal] input[type=file]").setInputFiles({ name: "saved.txt", mimeType: "text/plain", buffer: Buffer.from("notes") });
      await page.waitForFunction(`${drafted}?.files?.length === 1`);
      // Into the token (its list opens, offering REMOTE too), and out again.
      for (const [keys, list] of [
        [["Control+Home", "ArrowRight", "ArrowRight", "ArrowRight", "ArrowRight"], "wait role=option[name=/Faraway/]"],
        [["Control+End"], "gone role=listbox"],
      ]) {
        await ui.run([
          "eval document.querySelector('textarea').focus()",
          ...keys.map((k) => `press ${k}`),
          list,
          "sleep 300",
          "wait New task in Remnant",
          "wait saved.txt",
          `assert ${drafted}.files.length === 1`,
        ]);
      }
      await ui.run([`assert ${value} === '@REM Saved remote notes'`]);
    });
  } finally {
    remote.stop();
  }
});
