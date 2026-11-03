import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { at, fakeThread } from "./fakeThread.mjs";
import { demoProject, routeThread, startServer, withBrowser } from "./harness.mjs";

// HA-150: an agent-threads task's thread is drawn with agent-threads' React package (in Huntaway's
// colours, with its composer), from the thread API and the thread events on /api/ws (HA-145).

let server, project;
before(async () => {
  server = startServer();
  project = await demoProject(server);
});
after(() => server?.stop());

const user = (id, n, text, extra = {}) => ({ id, type: "user_message", text, created_at: at(n), ...extra });
const said = (id, n, text, extra = {}) => ({ id, type: "assistant_message", text, created_at: at(n), ...extra });
const call = (id, n, name, kind, input, extra = {}) => ({ id, type: "tool_call", name, kind, input, status: "completed", result: { content: "ok" }, created_at: at(n), ...extra });

/** A finished turn with a subagent, and a second turn waiting on a plan and a permission. */
function thread() {
  return {
    items: [
      user("u1", 0, "Fix the login bug."),
      said("a1", 1, "Looking at the login code."),
      call("t1", 2, "Bash", "shell", { command: "ls server/src" }),
      call("t2", 3, "Read", "read", { file_path: "/repo/server/src/login.rs" }, { path: "/repo/server/src/login.rs" }),
      call("s1", 4, "Agent", "subagent", { description: "Explore auth", prompt: "Find where sessions are checked." }, { result: { content: "Sessions are checked in auth.rs." } }),
      said("s1a", 5, "Subagent searching.", { parent_id: "s1" }),
      call("s1t", 6, "Grep", "search", { pattern: "session" }, { parent_id: "s1" }),
      said("s1b", 7, "Subagent report: sessions are in auth.rs.", { parent_id: "s1" }),
      said("a2", 8, "The bug is in the session check."),
      { id: "r1", type: "turn_result", ok: true, duration_ms: 4200, usage: { input_tokens: 1200, output_tokens: 300, cache_read_tokens: 40000 }, created_at: at(9) },
      user("u2", 10, "Plan the fix, then run the tests."),
      call("t3", 12, "Bash", "shell", { command: "cargo test login" }, { status: "pending", result: undefined }),
    ],
    requests: [
      { id: "plan1", type: "plan", plan: "# Fix the session check\n\n1. Compare expiry in UTC.", created_at: at(11) },
      { id: "perm1", type: "permission", kind: "shell", name: "Bash", input: { command: "cargo test login" }, tool_call_id: "t3", title: "cargo test login", created_at: at(12) },
    ],
  };
}

/** Opens `task` with its thread served by a fake (see fakeThread.mjs) and the page's /api/ws routed, then switches the task onto agent-threads. */
async function openThread(ui, task, opts, shown = "No agent has worked on this yet") {
  const { page } = ui;
  let socket;
  await page.routeWebSocket(/\/api\/ws/, (ws) => {
    socket = ws;
    ws.connectToServer();
  });
  const t = await fakeThread(page, task, opts);
  // Shown as a legacy task first, until it's switched on.
  await ui.run([`goto /p/${project.id}?task=${task.id}`, `wait ${shown}`]);
  t.connect(socket);
  t.switchOn();
  return t;
}

test("an agent-threads task's thread streams, answers its requests and opens a subagent full screen", async () => {
  const task = await server.api("POST", `/projects/${project.id}/tasks`, { title: "Agent threads: requests", status: "in_review" });
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    const t = await openThread(ui, task, {
      ...thread(),
      // A host answers a request by resolving it.
      onCommand: (c, t) => {
        if (c.type === "respond") t.emit({ type: "request.resolved", request_id: c.request_id, resolution: c.resolution });
      },
    });
    // The window, drawn by the package: the user's messages as Huntaway draws them, the agent's, tool rows and the subagent.
    await ui.run(["gone No agent has worked on this yet", "wait Fix the login bug.", "wait The bug is in the session check.", "wait Explore auth"]);
    assert.deepEqual(t.asked.windows, [100]);
    await page.locator(".at-root.ha-thread").waitFor();

    // Streaming: deltas into a new reply, then its final text.
    t.sendTask({ run_engine: "agent_threads", running: true });
    t.emit({ type: "turn.started", turn_id: "turn2" });
    t.emit({ type: "item.added", item: { id: "a3", type: "assistant_message", text: "", turn_id: "turn2", created_at: at(13) } });
    t.emit({ type: "delta", item_id: "a3", kind: "text", offset: 0, text: "Running the " });
    await ui.run(["wait Running the"]);
    t.emit({ type: "delta", item_id: "a3", kind: "text", offset: 12, text: "tests now." });
    await ui.run(["wait Running the tests now.", "wait Working…"]);
    t.emit({ type: "item.updated", item_id: "a3", patch: { text: "Running the **tests** now." } });
    await page.locator(".prose-chat strong", { hasText: "tests" }).waitFor();

    // The permission card, answered through the thread's commands.
    const perm = page.getByRole("group", { name: "Permission for Bash" });
    await perm.getByRole("button", { name: "Allow", exact: true }).click();
    await perm.getByText("Allowed", { exact: true }).waitFor();
    assert.deepEqual(t.commands.at(-1), { thread_id: task.id, type: "respond", request_id: "perm1", resolution: { outcome: "allow" } });

    // "Always" too, for another call.
    t.emit({ type: "item.added", item: call("t4", 14, "Bash", "shell", { command: "cargo fmt" }, { status: "pending", result: undefined }) });
    t.emit({ type: "request.opened", request: { id: "perm2", type: "permission", kind: "shell", name: "Bash", input: { command: "cargo fmt" }, tool_call_id: "t4", created_at: at(14) } });
    await page.getByRole("button", { name: "Always allow Bash in this thread" }).click();
    await page.getByText("Always allowed", { exact: true }).waitFor();
    assert.deepEqual(t.commands.at(-1).resolution, { outcome: "allow", always: true });

    // The plan, approved into a mode.
    const plan = page.getByRole("group", { name: "Plan from Claude" });
    await plan.getByText("Compare expiry in UTC.").waitFor();
    await plan.getByLabel("The mode to carry on in").selectOption("accept_edits");
    await plan.getByRole("button", { name: "Approve" }).click();
    await plan.getByText("Approved", { exact: true }).waitFor();
    assert.deepEqual(t.commands.find((c) => c.request_id === "plan1")?.resolution, { outcome: "allow", permission_mode: "accept_edits" });

    // A subagent opens full screen, with the way back, and Escape goes back to the main thread.
    await page.getByRole("button", { name: "Open subagent thread" }).click();
    await ui.run(["wait Main thread", "wait Find where sessions are checked.", "wait Subagent report: sessions are in auth.rs."]);
    assert.equal(await page.getByText("The bug is in the session check.").isVisible(), false, "the main thread is hidden meanwhile");
    await ui.run(["press Escape", "gone Main thread", "wait The bug is in the session check."]);
    // From the Agents pill too.
    await ui.run(["click Subagents in this thread", "click css=.shadow-xl button:has-text('Explore auth')", "wait Show in thread", "click Show in thread", "gone Main thread"]);
  });
});

test("a long agent-threads thread loads its earlier items as it's scrolled up, keeping its place", async () => {
  const task = await server.api("POST", `/projects/${project.id}/tasks`, { title: "Agent threads: paging", status: "in_review" });
  const items = [];
  for (let i = 0; i < 160; i++) {
    items.push(user(`u${i}`, i * 3, `Question ${i}`));
    items.push(said(`a${i}`, i * 3 + 1, `Answer ${i}\n\nwith a second paragraph`));
    // Tool calls in a row, so a group's first call is on the page before (and the group keeps its key).
    items.push(call(`c${i}`, i * 3 + 2, "Read", "read", { file_path: `/repo/f${i}.rs` }, { path: `/repo/f${i}.rs` }));
  }
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    const t = await openThread(ui, task, { items });
    await ui.run(["wait Answer 159"]);
    assert.equal(await page.getByText("Answer 100", { exact: true }).count(), 0, "the window has the latest items");
    // Scrolled up, the page before loads, and what was at the top of the screen stays where it was.
    const before = await page.evaluate(() => {
      const el = document.querySelector("[data-autoscroll]");
      el.scrollTop = 1200;
      el.dispatchEvent(new Event("scroll"));
      const first = [...el.querySelectorAll(".ha-rows > *")].find((r) => r.getBoundingClientRect().bottom > el.getBoundingClientRect().top);
      first.dataset.anchor = "1";
      return first.getBoundingClientRect().top;
    });
    await page.evaluate(() => {
      const el = document.querySelector("[data-autoscroll]");
      el.scrollTop = 300;
      el.dispatchEvent(new Event("scroll"));
    });
    await page.getByText("Answer 120", { exact: true }).waitFor({ state: "attached" });
    assert.ok(t.asked.pages.length >= 1, "a page was asked for");
    const kept = await page.evaluate(() => {
      const el = document.querySelector("[data-autoscroll]");
      return { top: document.querySelector("[data-anchor]")?.getBoundingClientRect().top, scroll: el.scrollTop };
    });
    assert.ok(kept.scroll > 1000, `the thread kept its place (scrollTop ${kept.scroll})`);
    assert.ok(kept.top !== undefined, "the row on screen is the same row");
    assert.ok(Math.abs(kept.top - before) < 5, `what was on screen stayed where it was (${before} → ${kept.top})`);
    // All the way up, it gets to the first.
    for (let i = 0; i < 10 && !(await page.getByText("Question 0", { exact: true }).count()); i++) {
      await page.evaluate(() => {
        const el = document.querySelector("[data-autoscroll]");
        el.scrollTop = 0;
        el.dispatchEvent(new Event("scroll"));
      });
      await page.waitForTimeout(200);
    }
    await page.getByText("Question 0", { exact: true }).waitFor();
  });
});

test("the board's prompts and events go among the thread's rows, and ones it moved on from are greyed", async () => {
  const task = await server.api("POST", `/projects/${project.id}/tasks`, { title: "Agent threads: board", status: "in_review" });
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    // The board's own messages for the task: its user messages, a permission prompt (the board's flow) and an event.
    const messages = [
      { id: 1, task_id: task.id, kind: "user", data: { text: "Fix the login bug." }, created_at: at(0) },
      { id: 2, task_id: task.id, kind: "event", data: { level: "warn", text: "The board's own event." }, created_at: at(1.5) },
      { id: 3, task_id: task.id, kind: "user", data: { text: "Plan the fix, then run the tests." }, created_at: at(10) },
      { id: 4, task_id: task.id, kind: "permission", data: { status: "pending", request_id: "bp1", tool_use_id: "s1t", tool_name: "WebFetch", input: { url: "https://example.com" } }, created_at: at(12.5) },
    ];
    await routeThread(page, task.id, messages);
    await openThread(ui, task, {
      items: thread().items.slice(0, 11),
      requests: [{ id: "q1", type: "question", questions: [{ id: "a", question: "Which database?", options: [{ label: "SQLite" }, { label: "Postgres" }] }], created_at: at(9.5) }],
    }, "The board's own event.");
    await ui.run(["wait Fix the login bug.", "wait The board's own event.", "wait WebFetch"]);
    // In time order: the event after the first reply, the prompt after the last message.
    const order = await page.evaluate(() => [...document.querySelector(".ha-rows").children].map((r) => r.textContent.slice(0, 40)));
    const index = (s) => order.findIndex((t) => t.includes(s));
    assert.ok(index("Looking at the login code.") < index("The board's own event.") && index("The board's own event.") < index("Ranls server/src"), order.join(" | "));
    assert.ok(index("Plan the fix") < index("WebFetch"), order.join(" | "));
    // The board's prompt says which subagent asked (by its call), and its buttons keep the board's colours.
    await ui.run(["wait from Explore auth"]);
    const deny = await page.getByRole("button", { name: "Deny", exact: true }).evaluate((b) => getComputedStyle(b).color);
    const fg = await page.evaluate(() => getComputedStyle(document.querySelector(".ha-thread")).color);
    assert.notEqual(deny, fg, "Deny is the danger colour, not the thread's text colour");
    // The question was asked before the user's last message: greyed, and still answerable.
    await page.locator(".ha-moved-on").getByText("Which database?").waitFor();
  });
});
