import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { startServer, withBrowser } from "./harness.mjs";

let server;
before(() => {
  server = startServer();
});
after(() => server?.stop());

// HA-119: each profile has an assistant, which the sidebar opens full width and which is off the board.
test("the sidebar opens the profile's assistant, which stays off the board", async () => {
  const [profile] = await server.api("GET", "/profiles");
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    await ui.run(["goto /profile/Default", "wait Try a scratch task", "click css=nav[aria-label=Assistant] >> text=Assistant", "wait Message your assistant"]);
    assert.equal(new URL(page.url()).pathname, "/assistant/Default");
    // Opening it made it, as A-1 in no project, with a folder of its own.
    const assistant = await server.api("GET", `/profiles/${profile.id}/assistant`);
    assert.deepEqual([assistant.task_type, assistant.number, assistant.project_id, assistant.work_dir], ["assistant", 1, null, `assistants/${assistant.id}`]);
    await ui.run(["wait A-1"]);
    // A chat, not a task: no Start, no changes or review, no status to move it to.
    for (const name of [/^start$/i, /^(changes|review)$/i]) assert.equal(await page.getByRole("button", { name }).count(), 0, String(name));
    assert.equal(await page.getByText("Pull request", { exact: true }).count(), 0);

    // Not on the profile's board, or in its counts.
    await ui.run(["goto /profile/Default", "wait Try a scratch task"]);
    assert.equal(await page.getByText("A-1", { exact: true }).count(), 0);

    // Its own page, loaded afresh (the board's listings leave it out), moves to the assistant's page.
    await ui.run([`goto /t/${assistant.id}`, "wait Message your assistant"]);
    await page.waitForURL(/\/assistant\/Default$/);
  });
});

// HA-121: the assistant's Memory tab edits its files, keeps an unsaved edit while another file or tab is open, saves with
// Ctrl+S wherever the focus is, won't overwrite what the assistant wrote meanwhile, and shows each file's history.
test("the Memory tab edits the assistant's files and shows their history", async () => {
  const [profile] = await server.api("GET", "/profiles");
  const base = `/profiles/${profile.id}/assistant/memory`;
  await server.api("POST", `${base}/file`, { path: "MEMORY.md", content: "# Memory\n- The cat is called Mog\n", force: true });
  // The save over the assistant's edit is refused.
  await withBrowser(server, { allowErrors: [/status of 409 .*\/assistant\/memory\/file/] }, async (ui) => {
    const { page } = ui;
    const editor = page.getByRole("textbox", { name: "Edit MEMORY.md" });
    await ui.run(["goto /assistant/Default", "wait Message your assistant", "click memory", "wait About you", "click MEMORY.md", "wait The cat is called Mog"]);
    // Every memory file shows how much of it a run is told.
    await ui.run(["wait 33 / 8,000 characters"]);
    await editor.click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type("- Likes walks");
    // An edit outlasts opening another file, and the thread.
    await ui.run(["click USER.md", "wait About the user", "click thread", "wait Message your assistant", "click memory", "click MEMORY.md"]);
    await page.waitForFunction(() => document.querySelector("textarea[aria-label='Edit MEMORY.md']")?.value.includes("Likes walks"));
    // Saved with Ctrl+S, though the focus isn't in the editor.
    await page.getByRole("button", { name: "History" }).focus();
    await page.keyboard.press("Control+s");
    // (The history has a commit of yours already, from the API above: wait for the save itself.)
    await page.waitForFunction(() => !document.querySelector("[title='Not saved']"));
    await ui.run(["click History", "wait You"]);
    assert.equal((await server.api("GET", `${base}/file?path=MEMORY.md`)).content, "# Memory\n- The cat is called Mog\n- Likes walks");

    // The assistant writes it meanwhile: a save is refused until you pick whose to keep.
    await editor.click();
    await page.keyboard.type(" a lot");
    await server.api("POST", `${base}/file`, { path: "MEMORY.md", content: "the assistant's\n", force: true });
    await ui.run(["click Save", "wait since you opened it", "click Load its version", "gone since you opened it"]);
    await page.waitForFunction(() => document.querySelector("textarea[aria-label='Edit MEMORY.md']")?.value === "the assistant's\n");

    // An older version, restored.
    // (The history is still open.)
    await ui.run(["click Start the assistant's memory", "wait Restore this version", "click Restore this version", "wait Lasting facts"]);
    // (Its diff says "Lasting facts" too: wait for the restore itself, which commits the assistant's edit first.)
    const restored = async () => (await server.api("GET", `${base}/file?path=MEMORY.md`)).content;
    for (let i = 0; i < 50 && !/^# Memory\n\n<!-- Lasting facts/.test(await restored()); i++) await page.waitForTimeout(100);
    assert.match(await restored(), /^# Memory\n\n<!-- Lasting facts/);
  });
});

// HA-240: Ctrl+S saves a draft as soon as its file is opened again, before the editor's effects have run.
test("a draft saves as soon as its file is opened again", async () => {
  const [profile] = await server.api("GET", "/profiles");
  const base = `/profiles/${profile.id}/assistant/memory`;
  await server.api("POST", `${base}/file`, { path: "MEMORY.md", content: "# Memory\n", force: true });
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    await ui.run(["goto /assistant/Default", "wait Message your assistant", "click memory", "click MEMORY.md"]);
    await page.waitForFunction(() => document.querySelector("textarea[aria-label='Edit MEMORY.md']")?.value === "# Memory\n");
    await page.getByRole("textbox", { name: "Edit MEMORY.md" }).click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type("- kept");
    await ui.run(["click USER.md", "wait About the user"]);
    // Ctrl+S the moment the new editor is in the page, in the same task as its first render.
    await page.evaluate(() => {
      const list = [...document.querySelectorAll("aside button")].find((b) => b.textContent.includes("MEMORY.md"));
      new MutationObserver((_, observer) => {
        if (!document.querySelector("textarea[aria-label='Edit MEMORY.md']")) return;
        observer.disconnect();
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true, cancelable: true }));
      }).observe(document.body, { childList: true, subtree: true });
      list.click();
    });
    await page.waitForFunction(() => !document.querySelector("[title='Not saved']"));
    assert.equal((await server.api("GET", `${base}/file?path=MEMORY.md`)).content, "# Memory\n- kept");
  });
});

// HA-121 review: what's typed while a save is on its way isn't lost when it's saved, even in the editor of the file opened
// again meanwhile, and Ctrl+S on a file you haven't changed (a daily log not written yet, say) saves nothing.
test("an edit made while the Memory tab saves stays", async () => {
  const [profile] = await server.api("GET", "/profiles");
  const base = `/profiles/${profile.id}/assistant/memory`;
  await server.api("POST", `${base}/file`, { path: "MEMORY.md", content: "# Memory\n", force: true });
  const { today } = await server.api("GET", base);
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    const value = () => page.getByRole("textbox", { name: "Edit MEMORY.md" }).inputValue();
    await ui.run(["goto /assistant/Default", "wait Message your assistant", "click memory", "click MEMORY.md"]);
    await page.waitForFunction(() => document.querySelector("textarea[aria-label='Edit MEMORY.md']")?.value === "# Memory\n");
    // The save is held until more has been typed.
    let release;
    const held = new Promise((r) => (release = r));
    let posted;
    const sent = new Promise((r) => (posted = r));
    await page.route("**/assistant/memory/file", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      posted();
      await held;
      await route.continue();
    });
    await page.getByRole("textbox", { name: "Edit MEMORY.md" }).click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type("- first");
    await page.keyboard.press("Control+s");
    await sent;
    // Another file is opened and this one again while it saves (a new editor), and more typed there.
    await ui.run(["click USER.md", "wait About the user", "click MEMORY.md"]);
    await page.waitForFunction(() => document.querySelector("textarea[aria-label='Edit MEMORY.md']")?.value === "# Memory\n- first");
    await page.getByRole("textbox", { name: "Edit MEMORY.md" }).click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type(" and second");
    // (Wait for the save's answer and the list's refresh after it, not for "You" in the history, which the API's write
    // above put there already.)
    const listed = new Promise((resolve) => {
      let answered = false;
      const done = (result) => {
        page.off("response", seen);
        resolve(result);
      };
      const seen = (r) => {
        const method = r.request().method();
        const { pathname } = new URL(r.url());
        if (method === "POST" && pathname.endsWith("/assistant/memory/file")) {
          if (r.ok()) answered = true;
          else done(`the save was answered ${r.status()}`);
        } else if (answered && method === "GET" && pathname.endsWith("/assistant/memory")) done("listed");
      };
      page.on("response", seen);
    });
    release();
    assert.equal(await listed, "listed");
    await ui.run(["click History", "wait You"]);
    assert.equal((await server.api("GET", `${base}/file?path=MEMORY.md`)).content, "# Memory\n- first");
    // The list was refreshed after the save, and the editor still has what came after it, unsaved.
    await page.waitForTimeout(300);
    assert.equal(await value(), "# Memory\n- first and second");
    assert.equal(await page.getByRole("button", { name: "Save", exact: true }).isEnabled(), true);
    await page.unroute("**/assistant/memory/file");
    await page.keyboard.press("Control+s");
    await page.waitForFunction(() => !document.querySelector("[title='Not saved']"));
    assert.equal((await server.api("GET", `${base}/file?path=MEMORY.md`)).content, "# Memory\n- first and second");

    // Today's log isn't written by a Ctrl+S on its empty editor.
    await ui.run([`click ${today.slice("memory/".length)}`, "wait isn't there yet"]);
    await page.keyboard.press("Control+s");
    await page.waitForTimeout(300);
    assert.ok(!(await server.api("GET", base)).files.some((f) => f.path === today));
  });
});

// HA-123: the assistant's approval rules are edited in its details, and its Actions tab lists what they asked about.
test("the assistant's rules can be changed, and a draft isn't saved until it's saved", async () => {
  const [profile] = await server.api("GET", "/profiles");
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    await ui.run(["goto /assistant/Default", "wait Message your assistant", "wait 7 allow", "wait 15 ask", "wait 7 never", "wait (the defaults, for Google)"]);
    await ui.run(["click Edit rules", "wait Approval rules", "click Ask before the assistant creates a task on the board"]);
    // Trying a tool name says which rule decides it.
    await ui.run(["click css=[aria-label='A tool name to try the rules on']", "type mcp__huntaway__create_task", "wait (mcp__huntaway__create_task)"]);
    // Cancelled, nothing changes.
    await ui.run(["click Cancel", "gone Approval rules"]);
    assert.equal((await server.api("GET", `/profiles/${profile.id}/approval-rules`)).is_default, true);
    await ui.run(["click Edit rules", "wait Approval rules", "click Ask before the assistant creates a task on the board", "click Save rules", "gone Approval rules", "wait 16 ask"]);
    const saved = await server.api("GET", `/profiles/${profile.id}/approval-rules`);
    assert.equal(saved.is_default, false);
    assert.deepEqual(saved.rules.at(-1), { tool: "mcp__huntaway__create_task", decision: "ask" });
    // Back to the defaults, from the dialog.
    page.once("dialog", (d) => d.accept());
    await ui.run(["click Edit rules", "wait Approval rules", "click Defaults", "gone Approval rules", "wait (the defaults, for Google)"]);
    assert.equal((await server.api("GET", `/profiles/${profile.id}/approval-rules`)).is_default, true);
    await ui.run(["click actions", "wait Nothing yet"]);
  });
});

// HA-123 review: two rules for one tool aren't saved with one of them dropped; the dialog says so, and what's saved decides as
// its Try a tool showed.
test("the rules dialog won't save two rules for one tool, and what it saves decides as it showed", async () => {
  const [profile] = await server.api("GET", "/profiles");
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    await ui.run(["goto /assistant/Default", "wait Message your assistant", "click Edit rules", "wait Approval rules"]);
    const rows = await page.locator("[aria-label='Rules'] input").count();
    // Bash: allow, then bash: never beneath it.
    for (const [tool, decision] of [["Bash", "allow"], ["bash", "never"]]) {
      await ui.run(["click Add a rule"]);
      const n = await page.locator("[aria-label='Rules'] input").count();
      await page.getByRole("textbox", { name: `Rule ${n}'s tool` }).fill(tool);
      await page.getByRole("combobox", { name: `Rule ${n}'s decision` }).selectOption(decision);
    }
    assert.equal(await page.locator("[aria-label='Rules'] input").count(), rows + 2);
    await ui.run(["click css=[aria-label='A tool name to try the rules on']", "type Bash", "wait never (bash)", "wait has more than one rule"]);
    assert.equal(await page.getByRole("button", { name: "Save rules" }).isDisabled(), true);
    assert.equal(await page.locator("[aria-label='Rules'] input[aria-invalid='true']").count(), 2);
    // The allow goes: saved, it's never, as shown.
    await ui.run([`click Remove rule ${rows + 1}`, "gone has more than one rule", "wait never (bash)", "click Save rules", "gone Approval rules"]);
    const saved = await server.api("GET", `/profiles/${profile.id}/approval-rules`);
    assert.deepEqual(saved.rules.filter((r) => r.tool.toLowerCase() === "bash"), [{ tool: "bash", decision: "never" }]);
    // Put back for the other tests.
    await server.api("POST", `/profiles/${profile.id}/approval-rules`, { reset: true });
  });
});
