// The thread view on items (itemModel.ts) draws what the view on messages (threadModel.ts) does: the same messages,
// translated into items by the server's translator (server-ts/src/threads/translate.ts, which is pure), give the same
// rows, subagents and results.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
import { forkedSkillMessages } from "./fixtures/forkedSkill.mjs";

// The app's modules import each other without extensions (and folders by their index.ts), as Vite allows.
const hook = `export async function resolve(spec, ctx, next) {
  if (spec.startsWith(".") && !/\\.[cm]?[jt]sx?$/.test(spec)) {
    try { return await next(spec + ".ts", ctx); } catch {}
    try { return await next(spec + "/index.ts", ctx); } catch {}
  }
  return next(spec, ctx);
}`;
register("data:text/javascript," + encodeURIComponent(hook));
const { buildModel, buildItems } = await import("../src/threadModel.ts");
const { buildItemModel, keyOf, toolName } = await import("../src/itemModel.ts");
const { convert } = await import("../../server-ts/src/threads/translate.ts");
const { apply_events, initial_state, snapshot_window, item_page, with_page } = await import("../src/threads.ts");

/** A thread's messages, as an agent and the board store them. */
function history() {
  const out = [];
  const add = (kind, data) => out.push({ id: out.length + 1, task_id: "t", kind, data, created_at: `2026-10-26T07:${String(out.length).padStart(2, "0")}:00.000Z` });
  const assistant = (content, parent = null) => add("claude", { type: "assistant", parent_tool_use_id: parent, session_id: "s", message: { content } });
  const call = (id, name, input = {}, parent = null) => assistant([{ type: "tool_use", id, name, input }], parent);
  const result = (id, content, parent = null, extra = {}) =>
    add("claude", { type: "user", parent_tool_use_id: parent, session_id: "s", message: { content: [{ type: "tool_result", tool_use_id: id, content, ...extra }] } });
  add("user", { text: "Start working on this task.", auto: true, start: true });
  add("event", { level: "info", text: "Setting up worktree…", detail: null });
  add("event", { level: "warn", text: "Slow", detail: "It took a while" });
  assistant([{ type: "thinking", thinking: "Hmm." }, { type: "text", text: "Starting." }]);
  call("r1", "Read", { file_path: "/a" });
  call("r2", "Grep", { pattern: "x", path: "/src" });
  result("r1", [{ type: "text", text: "a" }]);
  result("r2", "no match", null, { is_error: true });
  call("m1", "mcp__gh__pr_view", { number: 3 });
  result("m1", "PR 3");
  call("h1", "mcp__huntaway__create_task", { title: "Next" });
  result("h1", "made");
  // A permission prompt, allowed, and one denied.
  call("b1", "Bash", { command: "ls" });
  add("permission", { status: "allowed", tool_use_id: "b1", tool_name: "Bash", input: { command: "ls" }, request_id: "p1" });
  result("b1", "a b");
  call("b2", "Bash", { command: "rm -rf /" });
  add("permission", { status: "denied", tool_use_id: "b2", tool_name: "Bash", input: { command: "rm -rf /" }, request_id: "p2", note: "No" });
  result("b2", "No", null, { is_error: true });
  // A subagent, with a prompt of its own, and its report.
  call("A1", "Agent", { description: "Explore", prompt: "Explore the config.", subagent_type: "Explore" });
  add("claude", { type: "system", subtype: "task_started", task_type: "local_agent", tool_use_id: "A1", task_id: "k1", description: "Explore" });
  assistant([{ type: "text", text: "Subagent here." }], "A1");
  call("c1", "Bash", { command: "pwd" }, "A1");
  add("permission", { status: "allowed", tool_use_id: "c1", tool_name: "Bash", input: { command: "pwd" }, request_id: "p3" });
  add("claude", { type: "system", subtype: "task_progress", task_id: "k1", description: "Running pwd", usage: { tool_uses: 1 } });
  result("c1", "/repo", "A1");
  add("claude", { type: "system", subtype: "task_notification", task_id: "k1", status: "completed" });
  add("claude", { type: "user", session_id: "s", message: { content: [{ type: "tool_result", tool_use_id: "A1", content: "Found it" }] },
    tool_use_result: { agentType: "Explore", totalToolUseCount: 1, status: "completed", resolvedModel: "haiku" } });
  // A background subagent.
  call("B1", "Agent", { description: "Away", prompt: "Go", run_in_background: true });
  add("claude", { type: "system", subtype: "task_started", task_type: "local_agent", tool_use_id: "B1", task_id: "k2", is_backgrounded: true });
  result("B1", "Async agent launched successfully");
  add("claude", { type: "system", subtype: "task_notification", task_id: "k2", status: "completed", summary: "Done away" });
  // A question, a plan approved into a mode, and the board's own question.
  const questions = [{ question: "Which?", header: "Pick", options: [{ label: "A" }, { label: "B", description: "b" }], multiSelect: false }];
  call("q1", "AskUserQuestion", { questions });
  add("permission", { status: "allowed", tool_use_id: "q1", tool_name: "AskUserQuestion", input: { questions }, request_id: "p4", answers: [["B"]] });
  result("q1", "B");
  call("x1", "ExitPlanMode", { plan: "# Plan\n\nDo it." });
  add("permission", { status: "allowed", tool_use_id: "x1", tool_name: "ExitPlanMode", input: { plan: "# Plan\n\nDo it." }, request_id: "p5", mode: "acceptEdits" });
  result("x1", "ok");
  add("question", { question: "Merge it?", options: [{ label: "Yes" }, { label: "No" }], multi_select: false, allow_other: true, call_id: "cq", status: "answered", answer: { choices: ["Yes"], text: null } });
  // A turn's end, the user's reply sent while it ran, an API error and an interruption.
  add("claude", { type: "result", subtype: "success", is_error: false, num_turns: 4, duration_ms: 1200, total_cost_usd: 0.25, result: "Starting." });
  add("user", { text: "And the docs", steered: true });
  add("claude", { type: "assistant", session_id: "s", is_api_error_message: true, error: "rate_limit", message: { content: [{ type: "text", text: "API Error: rate limited" }] } });
  add("claude", { type: "user", session_id: "s", message: { content: [{ type: "text", text: "[Request interrupted by user]" }] } });
  add("claude", { type: "result", subtype: "error_during_execution", is_error: true, interrupted: true, duration_ms: 50 });
  // A compaction, its summary and the /compact run's turn, then a failed turn.
  add("claude", { type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "manual", pre_tokens: 9000, post_tokens: 1200 } });
  add("claude", { type: "user", isSynthetic: true, message: { content: "The summary." } });
  add("claude", { type: "result", subtype: "success", num_turns: 0, is_error: false, duration_ms: 3000, total_cost_usd: 0.01 });
  add("claude", { type: "result", subtype: "error_max_turns", is_error: true, num_turns: 9 });
  // A routine's report, and a prompt still waiting.
  add("report", { automation: "Brief", task_id: "t2", key: "HA-2", outcome: "reported", text: "All **fine**" });
  call("w1", "Write", { file_path: "/c", content: "x" });
  add("permission", { status: "pending", tool_use_id: "w1", tool_name: "Write", input: { file_path: "/c", content: "x" }, request_id: "p6" });
  return out;
}

/** What a result line shows (items.tsx's ResultLine), and a compaction's (CompactLine). */
const resultShown = (d) => d && {
  duration_ms: d.duration_ms,
  num_turns: d.num_turns,
  total_cost_usd: d.total_cost_usd,
  interrupted: !!d.interrupted,
  error: !d.interrupted && !!(d.is_error || (d.subtype && d.subtype !== "success")),
  subtype: d.interrupted ? undefined : d.is_error || d.subtype !== "success" ? d.subtype : undefined,
};
const compactShown = (m) => ({ trigger: m.trigger, pre_tokens: m.pre_tokens, post_tokens: m.post_tokens });

/** A row as it's drawn: a group of calls by its calls (its key is only React's), and results by what they show. */
function row(it) {
  switch (it.type) {
    case "tools":
      return { type: "tools", calls: it.calls.map((c) => ({ id: c.id, name: c.name, input: c.input, result: c.result })) };
    case "user":
      return { type: "user", key: it.key, text: it.text, auto: !!it.auto, steered: !!it.steered };
    case "result":
      return { type: "result", key: it.key, shown: resultShown(it.data) };
    case "compact":
      return { type: "compact", key: it.key, meta: compactShown(it.meta), summary: it.summary, result: resultShown(it.result) };
    default:
      return it;
  }
}

/** What the view draws of a model: its rows, each subagent's rows (prompts included), its subagents and results. */
function drawn(model, children) {
  // A foreground subagent's report is its call's result: what its notification said (which items keep only for a
  // background one) shows only until then.
  const subs = [...model.subagents.values()]
    .map(({ messageId: _, ...s }) => JSON.parse(JSON.stringify(s.background || !model.results.has(s.id) ? s : { ...s, summary: undefined })))
    .sort((a, b) => a.id.localeCompare(b.id));
  return {
    items: model.items.map(row),
    children: Object.fromEntries(subs.map((s) => [s.id, children(s.id).map(row)])),
    subagents: subs,
    results: Object.fromEntries([...model.results].sort()),
    callParent: Object.fromEntries([...model.callParent].sort()),
    lastSent: model.lastSent,
  };
}

const fromMessages = (messages, running) => {
  const m = buildModel(messages, running);
  return drawn(m, (id) => buildItems(m.children.get(id) ?? [], m.results));
};
const fromItems = (messages, running) => {
  const c = convert(messages, { finished: false });
  const m = buildItemModel({ items: c.items, requests: c.requests }, running);
  return drawn(m, (id) => m.childItems.get(id) ?? []);
};

test("a thread's items draw what its messages do", () => {
  for (const running of [true, false]) assert.deepStrictEqual(fromItems(history(), running), fromMessages(history(), running), `running: ${running}`);
});

test("and so do a forked Skill's, its prompt from its task_started", () => {
  const messages = forkedSkillMessages();
  assert.deepStrictEqual(fromItems(messages, true), fromMessages(messages, true));
  const sub = buildItemModel(convert(messages, { finished: false }), true).subagents.get("skill-review");
  assert.deepEqual([sub.prompt, sub.description, sub.endedAt], ["Review PR 139 for correctness bugs.", "/code-review", messages[6].created_at]);
});

test("at every point along the way, as live events bring it", () => {
  const all = history();
  for (let n = 1; n <= all.length; n++) {
    const part = all.slice(0, n);
    assert.deepStrictEqual(fromItems(part, true), fromMessages(part, true), `after ${n} messages`);
  }
});

/** The snapshot `messages` translate to, as the thread API gives it. */
function snapshot(messages) {
  const c = convert(messages, { finished: false });
  const thread = { id: "t", harness: "claude", status: "idle", created_at: "2026-10-26T07:00:00.000Z" };
  return apply_events(initial_state(thread), c.events.map((e, i) => ({ ...e, thread_id: "t", seq: i + 1 })));
}

test("a window shows its last items, and with every earlier page put in, the whole thread", () => {
  const whole = snapshot(history());
  const full = buildItemModel(whole, true);
  let w = snapshot_window(whole, 12);
  assert.ok(w.start > 0);
  const shown = buildItemModel(w, true);
  // The window's own rows are the thread's last ones (a group of calls may have fewer of its calls).
  assert.ok(shown.items.length < full.items.length);
  assert.deepStrictEqual(shown.items.slice(1).map(row), full.items.slice(-(shown.items.length - 1)).map(row));
  // A subagent its items belong to is known, though its call is before the window.
  while (w.start) w = with_page(w, item_page(whole, w.start, 5));
  const paged = buildItemModel(w, true);
  assert.deepStrictEqual(drawn(paged, (id) => paged.childItems.get(id) ?? []), drawn(full, (id) => full.childItems.get(id) ?? []));
});

test("what an event leaves as it was stays the same objects", () => {
  const all = history();
  const before = snapshot(all.slice(0, 30));
  const prev = buildItemModel(before, true);
  const after = snapshot(all.slice(0, 31));
  // The events' reducer keeps the items they don't change; rebuilding from the same objects keeps the rows.
  const same = { items: after.items.map((it, i) => (JSON.stringify(it) === JSON.stringify(before.items[i]) ? before.items[i] : it)), requests: before.requests };
  const next = buildItemModel(same, true, prev);
  const unchanged = prev.items.filter((it, i) => next.items[i] === it).length;
  assert.ok(unchanged >= prev.items.length - 1, `${unchanged} of ${prev.items.length} rows kept`);
  assert.equal(buildItemModel(same, true, next).items, next.items, "nothing new: the same rows");
});

test("keys and tool names come back as the message path has them", () => {
  assert.deepEqual([keyOf("legacy:12"), keyOf("legacy:12:3"), keyOf("legacy:12:result"), keyOf("toolu_1")], ["12", "12.3", "12.result", "toolu_1"]);
  assert.equal(toolName({ name: "pr_view", kind: "mcp", server: "gh" }), "mcp__gh__pr_view");
  assert.equal(toolName({ name: "board", kind: "app" }), "mcp__app__board");
  assert.equal(toolName({ name: "Bash", kind: "shell" }), "Bash");
});

test("requests from before the board's metadata (converter 2) still draw as prompts", () => {
  const m = buildItemModel(
    {
      items: [{ id: "c", type: "tool_call", name: "Bash", kind: "shell", input: { command: "ls" }, status: "running", created_at: "2026-10-26T07:00:00.000Z" }],
      requests: [{ id: "r", type: "permission", name: "Bash", kind: "shell", input: { command: "ls" }, tool_call_id: "c", created_at: "2026-10-26T07:00:01.000Z" }],
    },
    true,
  );
  assert.deepEqual(m.items.map((i) => i.type), ["tools", "permission"]);
  assert.deepEqual(m.items[1].data, { request_id: "r", status: "pending", tool_use_id: "c", tool_name: "Bash", input: { command: "ls" } });
});
