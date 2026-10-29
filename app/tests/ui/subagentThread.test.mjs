import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { demoProject, routeThread, startServer, withBrowser } from "./harness.mjs";

let server, project;
before(async () => {
  server = startServer();
  project = await demoProject(server);
});
after(() => server?.stop());

/**
 * A finished thread whose agent started a subagent ("Explore config"), which started one of its own ("Check env"),
 * then another ("Look for tests") at the start of a group of tool calls long enough to hide it.
 */
function messages(taskId) {
  const out = [];
  const add = (kind, data) => out.push({ id: out.length + 1, task_id: taskId, kind, data, created_at: `2026-10-26T07:00:${String(out.length).padStart(2, "0")}.000Z` });
  const assistant = (content, parent = null) => add("claude", { type: "assistant", parent_tool_use_id: parent, message: { content } });
  const result = (id, text, parent = null) =>
    add("claude", { type: "user", parent_tool_use_id: parent, message: { content: [{ type: "tool_result", tool_use_id: id, content: text }] } });
  add("user", { text: "Find out how the config is loaded." });
  assistant([{ type: "text", text: "Main agent here, starting a subagent." }]);
  assistant([{ type: "tool_use", id: "A1", name: "Agent", input: { description: "Explore config", prompt: "Find where the configuration is loaded." } }]);
  assistant([{ type: "text", text: "Subagent searching now." }], "A1");
  assistant([{ type: "tool_use", id: "b1", name: "Bash", input: { command: "ls server/src" } }], "A1");
  add("permission", { status: "allowed", tool_use_id: "b1", tool_name: "Bash", input: { command: "ls server/src" }, request_id: "p1" });
  result("b1", "config.rs", "A1");
  assistant([{ type: "tool_use", id: "A2", name: "Agent", input: { description: "Check env", prompt: "Which env vars override it?" } }], "A1");
  assistant([{ type: "text", text: "Nested subagent's answer." }], "A2");
  result("A2", "Done", "A1");
  assistant([{ type: "text", text: "Subagent report." }], "A1");
  result("A1", "Done");
  assistant([{ type: "text", text: "Now the tests." }]);
  assistant([{ type: "tool_use", id: "A3", name: "Agent", input: { description: "Look for tests", prompt: "List the config tests." } }]);
  assistant([{ type: "text", text: "Hidden subagent's answer." }], "A3");
  result("A3", "Done");
  for (let i = 0; i < 6; i++) {
    assistant([{ type: "tool_use", id: `r${i}`, name: "Read", input: { file_path: `/repo/file${i}.rs` } }]);
    result(`r${i}`, `contents ${i}`);
  }
  assistant([{ type: "text", text: "Main agent's summary." }]);
  add("claude", { type: "result", subtype: "success", duration_ms: 1000, num_turns: 3 });
  return out;
}

/** Waits for the text to be shown within the thread's scrolled area. */
async function inView(page, text) {
  const el = page.getByText(text, { exact: true });
  for (const end = Date.now() + 3000; Date.now() < end; await page.waitForTimeout(100)) {
    const shown = await el.evaluate((e) => {
      const r = e.getBoundingClientRect();
      const s = e.closest(".overflow-y-auto").getBoundingClientRect();
      return r.height > 0 && r.top >= s.top && r.bottom <= s.bottom;
    });
    if (shown) return;
  }
  assert.fail(`"${text}" isn't scrolled into view`);
}

const routeMessages = (page, task) => routeThread(page, task.id, messages(task.id));

// IA-127: picking a subagent from the Agents list only scrolled to its row in the main thread.
test("a subagent opens in its own thread view, and goes back to the main thread", async () => {
  const task = await server.api("POST", `/projects/${project.id}/tasks`, { title: "Subagents" });
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    await routeMessages(page, task);
    // From another tab: the list switches to the thread.
    await ui.run([`goto /p/${project.id}?task=${task.id}`, "click Thread", "click Details", "click Subagents in this thread", "click css=.shadow-xl button:has-text('Explore config')"]);
    await ui.run(["wait Show in thread", "wait Find where the configuration is loaded.", "wait Subagent searching now.", "wait Subagent report."]);
    // Its permission prompt is in its thread, without the link to itself; the main thread isn't shown.
    await ui.run(["wait Permission for Bash", "gone from Explore config", "gone Main agent's summary."]);

    // A nested subagent opens from its row, with the way back through the one that started it.
    await ui.run(["click Open subagent thread", "wait Nested subagent's answer.", "gone Subagent searching now."]);
    await ui.run(["press Escape", "wait Subagent searching now.", "gone Nested subagent's answer."]);
    // Escape again is back to the main thread, with the task still open.
    await ui.run(["press Escape", "wait Main agent's summary.", "gone Show in thread", "wait Subagents"]);

    // The permission prompt's link opens the subagent's thread; "Show in thread" goes to its row, expanded.
    await ui.run(["click from Explore config", "wait Subagent searching now.", "gone Main agent's summary.", "click Show in thread"]);
    await ui.run(["wait Main agent's summary.", "wait Subagent searching now.", "gone Show in thread"]);
    assert.equal(await page.getByText("Subagent searching now.").count(), 1);
  });
});

// IA-131: Escape with a menu open in a subagent's thread closed the menu and also went back to the main thread.
test("escape with a menu open in a subagent's thread only closes the menu", async () => {
  const task = await server.api("POST", `/projects/${project.id}/tasks`, { title: "Subagent menus" });
  await withBrowser(server, {}, async (ui) => {
    await routeMessages(ui.page, task);
    await ui.run([`goto /p/${project.id}?task=${task.id}`, "click Thread", "click Subagents in this thread", "click css=.shadow-xl button:has-text('Explore config')"]);
    await ui.run(["wait Subagent searching now.", "gone Main agent's summary."]);

    await ui.run(["click Subagents in this thread", "wait css=.shadow-xl button:has-text('Look for tests')", "press Escape"]);
    await ui.run(["gone css=.shadow-xl button:has-text('Look for tests')", "wait Subagent searching now.", "wait Show in thread", "gone Main agent's summary."]);

    // The composer's permission mode menu too.
    await ui.run(["click css=[title^='Permission mode']", "wait css=.bottom-full.shadow-xl", "press Escape"]);
    await ui.run(["gone css=.bottom-full.shadow-xl", "wait Subagent searching now.", "wait Show in thread"]);

    // With no menu open, Escape still goes back, and the task stays open.
    await ui.run(["press Escape", "wait Main agent's summary.", "gone Show in thread", "wait Subagent menus"]);
  });
});

// IA-131 review: the subagent view was kept for the session, so reopening the task showed the last subagent viewed.
test("a reopened task shows its main thread, not the subagent last viewed", async () => {
  const task = await server.api("POST", `/projects/${project.id}/tasks`, { title: "Subagents reopened" });
  const other = await server.api("POST", `/projects/${project.id}/tasks`, { title: "Another task" });
  await withBrowser(server, {}, async (ui) => {
    await routeMessages(ui.page, task);
    const open = ["click Subagents in this thread", "click css=.shadow-xl button:has-text('Explore config')", "wait Subagent searching now.", "gone Main agent's summary."];
    await ui.run([`goto /p/${project.id}?task=${task.id}`, "click Thread", ...open]);
    // Expanding the panel and back keeps it.
    await ui.run(["click Expand", "wait Subagent searching now.", "click Collapse into the side panel", "wait Subagent searching now."]);

    await ui.run(["click Close (Esc)", "gone Show in thread", `click css=[data-task='${task.id}']`, "click Thread", "wait Main agent's summary.", "gone Show in thread"]);

    // Opening another task in the panel and coming back does too.
    await ui.run([...open, `click css=[data-task='${other.id}']`, "gone Show in thread", `click css=[data-task='${task.id}']`, "click Thread"]);
    await ui.run(["wait Main agent's summary.", "gone Show in thread"]);
  });
});

// IA-127 review: "Show in thread" left a row collapsed and out of view when it only mounted as the reveal expanded
// what was around it: a nested subagent inside a collapsed one, or one hidden by a group's limit on tool calls.
test("show in thread reaches a nested subagent and one in a group's hidden calls", async () => {
  const task = await server.api("POST", `/projects/${project.id}/tasks`, { title: "Hidden subagents" });
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    await routeMessages(page, task);
    await ui.run(["size 1900x500", `goto /p/${project.id}?task=${task.id}`, "click Thread", "wait Main agent's summary."]);
    await ui.run(["gone Subagent searching now.", "gone Hidden subagent's answer.", "wait Show 1 earlier tool call"]);

    await ui.run(["click Subagents in this thread", "click css=.shadow-xl button:has-text('Check env')", "wait Show in thread", "click Show in thread"]);
    await ui.run(["gone Show in thread", "wait Subagent searching now."]);
    await inView(page, "Nested subagent's answer.");

    await ui.run(["click Subagents in this thread", "click css=.shadow-xl button:has-text('Look for tests')", "wait Show in thread", "click Show in thread"]);
    await ui.run(["gone Show in thread", "gone Show 1 earlier tool call"]);
    await inView(page, "Hidden subagent's answer.");
  });
});

// IA-152: Codex's adapter normalizes child threads to stable Agent rows. Metadata and later
// follow-ups update that row; collab wait/send tools mustn't appear as additional subagents.
test("Codex children show their metadata, nested transcript and permission source", async () => {
  const task = await server.api("POST", `/projects/${project.id}/tasks`, { title: "Codex subagents" });
  const out = [];
  const add = (data, kind = "claude") => out.push({ id: out.length + 1, task_id: task.id, kind, data, created_at: new Date(out.length * 1000).toISOString() });
  const assistant = (content, parent = null) => add({ type: "assistant", parent_tool_use_id: parent, message: { content } });
  assistant([{ type: "tool_use", id: "codex-agent-child", name: "Agent", input: { run_in_background: true } }]);
  add({ type: "system", subtype: "task_started", tool_use_id: "codex-agent-child", prompt: "Inspect config", description: "Inspect config", model: "gpt-6.1-sol", subagent_type: "explorer" });
  assistant([{ type: "text", text: "Codex child looking at config." }], "codex-agent-child");
  assistant([{ type: "tool_use", id: "codex-bash", name: "Bash", input: { command: "ls server/src" } }], "codex-agent-child");
  add({ status: "allowed", tool_use_id: "codex-bash", tool_name: "Bash", input: { command: "ls server/src" }, request_id: "codex-p1" }, "permission");
  add({ type: "user", parent_tool_use_id: "codex-agent-child", message: { content: [{ type: "tool_result", tool_use_id: "codex-bash", content: "config.rs" }] } });
  assistant([{ type: "tool_use", id: "codex-agent-nested", name: "Agent", input: { description: "Check env", prompt: "Check env", run_in_background: true } }], "codex-agent-child");
  assistant([{ type: "text", text: "Nested Codex findings." }], "codex-agent-nested");
  add({ type: "system", subtype: "task_notification", tool_use_id: "codex-agent-nested", status: "completed" });
  add({ type: "system", subtype: "task_notification", tool_use_id: "codex-agent-child", status: "completed", summary: "Initial config report" });
  assistant([{ type: "tool_use", id: "followup", name: "followupTask", input: { prompt: "Double-check config", receiver_thread_ids: ["child"] } }]);
  add({ type: "system", subtype: "task_updated", tool_use_id: "codex-agent-child", patch: { status: "running" } });
  assistant([{ type: "text", text: "Codex follow-up findings." }], "codex-agent-child");
  add({ type: "system", subtype: "task_notification", tool_use_id: "codex-agent-child", status: "completed", summary: "Final config report" });
  assistant([{ type: "text", text: "Main Codex summary." }]);

  await withBrowser(server, {}, async (ui) => {
    await routeThread(ui.page, task.id, out);
    await ui.run([`goto /p/${project.id}?task=${task.id}`, "click Thread", "wait Main Codex summary.", "gone Codex child looking at config."]);
    await ui.run(["text Subagents in this thread"]);
    assert.match(await ui.page.getByTitle("Subagents in this thread").innerText(), /2 done/);
    await ui.run(["click from Inspect config", "wait Codex child looking at config.", "wait Codex follow-up findings.", "wait gpt-6.1-sol", "wait Permission for Bash", "gone Main Codex summary."]);
    await ui.run(["click Open subagent thread", "wait Nested Codex findings.", "press Escape", "wait Codex follow-up findings.", "press Escape", "wait Main Codex summary."]);
    await ui.run(["click Subagents in this thread", "click css=.shadow-xl button:has-text('Inspect config')", "wait Codex child looking at config."]);
    await ui.run(["shot /tmp/ia152-codex-subagent.png"]);
  });
});
