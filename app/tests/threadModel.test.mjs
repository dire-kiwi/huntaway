import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
import { forkedSkillMessages } from "./fixtures/forkedSkill.mjs";

// The app's modules import each other without extensions, as Vite allows.
const hook = `export async function resolve(spec, ctx, next) {
  if (spec.startsWith(".") && !/\\.[cm]?[jt]sx?$/.test(spec)) {
    try { return await next(spec + ".ts", ctx); } catch {}
  }
  return next(spec, ctx);
}`;
register("data:text/javascript," + encodeURIComponent(hook));
const { buildModel } = await import("../src/threadModel.ts");

/** A thread with a bit of everything a model is made of, in the order an agent stores it. */
function thread() {
  const out = [];
  const add = (kind, data) => out.push({ id: out.length + 1, task_id: "t", kind, data, created_at: `2026-10-26T07:${String(out.length).padStart(2, "0")}:00.000Z` });
  const assistant = (content, parent = null) => add("claude", { type: "assistant", parent_tool_use_id: parent, message: { content } });
  const call = (id, name, input = {}, parent = null) => assistant([{ type: "tool_use", id, name, input }], parent);
  const result = (id, text, parent = null) =>
    add("claude", { type: "user", parent_tool_use_id: parent, message: { content: [{ type: "tool_result", tool_use_id: id, content: text }] } });
  add("user", { text: "Look into the config." });
  assistant([{ type: "thinking", thinking: "Hmm." }, { type: "text", text: "Starting." }]);
  call("r1", "Read", { file_path: "/a" });
  call("r2", "Read", { file_path: "/b" });
  result("r1", "a");
  result("r2", "b");
  call("A1", "Agent", { description: "Explore", prompt: "Explore the config." });
  add("claude", { type: "system", subtype: "task_started", tool_use_id: "A1", task_id: "k1", description: "Explore" });
  assistant([{ type: "text", text: "Subagent here." }], "A1");
  // A prompt stored before the subagent's call it's for.
  add("permission", { status: "allowed", tool_use_id: "b1", tool_name: "Bash", input: { command: "ls" }, request_id: "p1" });
  call("b1", "Bash", { command: "ls" }, "A1");
  add("claude", { type: "system", subtype: "task_progress", task_id: "k1", description: "Running ls" });
  result("b1", "config.rs", "A1");
  // And one stored after it, as they usually are.
  call("b2", "Bash", { command: "pwd" }, "A1");
  add("permission", { status: "pending", tool_use_id: "b2", tool_name: "Bash", input: { command: "pwd" }, request_id: "p2" });
  result("b2", "/repo", "A1");
  result("A1", "Done");
  add("event", { level: "info", text: "Context is filling up" });
  add("claude", { type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "manual", pre_tokens: 1000 } });
  add("claude", { type: "user", isSynthetic: true, message: { content: "The summary." } });
  add("claude", { type: "result", subtype: "success", num_turns: 0, is_error: false });
  call("w1", "Write", { file_path: "/c" });
  result("w1", "ok");
  add("claude", { type: "result", subtype: "success", num_turns: 3, duration_ms: 1000 });
  return out;
}

/** The model without its hidden build state. */
const plain = (m) => ({ ...m });

test("a Skill's lifecycle discovers a subagent as messages arrive, keeping its launch and children", () => {
  const all = forkedSkillMessages();
  let model;
  for (let n = 1; n <= all.length; n++) {
    model = buildModel(all.slice(0, n), true, model);
    assert.deepStrictEqual(plain(model), plain(buildModel(all.slice(0, n), true)));
    if (n >= 2) assert.equal(model.subagents.size, 1);
  }
  assert.equal(model.subagents.get("skill-review").messageId, all[0].id);
  assert.ok(model.children.get("skill-review").some((m) => m.kind === "permission"));
  assert.equal(model.items[0].calls[0].name, "Skill");
  assert.match(model.results.get("skill-review").content, /No runtime bugs found/);
});

test("a model built as messages come is the same as one built from them all", () => {
  const all = thread();
  for (const step of [1, 2, 5]) {
    let model, list = [];
    for (let i = 0; i < all.length; i += step) {
      list = [...list, ...all.slice(i, i + step)];
      model = buildModel(list, true, model);
      assert.deepStrictEqual(plain(model), plain(buildModel(list, true)), `${list.length} messages, ${step} at a time`);
    }
    // The run ends: its subagents that hadn't finished were stopped with it.
    model = buildModel(list, false, model);
    assert.deepStrictEqual(plain(model), plain(buildModel(list, false)));
  }
});

test("a prompt stored before its subagent's call is in the subagent's messages, in order", () => {
  const all = thread();
  const i = all.findIndex((m) => m.kind === "claude" && m.data.message?.content?.[0]?.id === "b1");
  let model = buildModel(all.slice(0, i), true);
  model = buildModel(all.slice(0, i + 1), true, model);
  assert.deepStrictEqual(model.children.get("A1").map((m) => m.kind), ["claude", "permission", "claude"]);
  // That one's answered; the next one, stored after its call, isn't.
  assert.equal(model.subagents.get("A1").awaitingApproval, undefined);
  const p2 = all.findIndex((m) => m.data?.request_id === "p2");
  for (let n = i + 2; n <= p2 + 1; n++) model = buildModel(all.slice(0, n), true, model);
  assert.equal(model.subagents.get("A1").awaitingApproval, true);
});

test("an updated message (a prompt's answer) rebuilds what shows it", () => {
  const all = thread();
  const model = buildModel(all, true);
  const next = all.map((m) => (m.kind === "permission" ? { ...m, data: { ...m.data, status: "allowed" } } : m));
  assert.equal(model.subagents.get("A1").awaitingApproval, true);
  const updated = buildModel(next, true, model);
  assert.deepStrictEqual(plain(updated), plain(buildModel(next, true)));
  assert.equal(updated.subagents.get("A1").awaitingApproval, undefined);
  assert.notEqual(updated.subagents.get("A1"), model.subagents.get("A1"));
});

test("what a new message leaves as it was stays the same objects", () => {
  const all = thread();
  // Up to the subagent's start, with a group of two Reads.
  const upTo = all.findIndex((m) => m.data?.subtype === "task_started") + 1;
  const model = buildModel(all.slice(0, upTo), true);
  const tools = model.items.findIndex((it) => it.type === "tools" && it.calls.some((c) => c.name === "Agent"));
  const add = (msgs, m) => [...msgs, { id: msgs.length + 1, task_id: "t", created_at: "2026-10-26T08:00:00.000Z", ...m }];

  // A subagent's message: the main conversation's items are all as they were.
  let list = add(all.slice(0, upTo), { kind: "claude", data: { type: "assistant", parent_tool_use_id: "A1", message: { content: [{ type: "text", text: "Hi" }] } } });
  let next = buildModel(list, true, model);
  assert.equal(next.items, model.items);
  assert.equal(next.results, model.results);
  assert.equal(next.subagents.get("A1"), model.subagents.get("A1"));

  // Text in the main conversation: one more item, and the others are the same.
  list = add(list, { kind: "claude", data: { type: "assistant", message: { content: [{ type: "text", text: "Meanwhile" }] } } });
  const after = buildModel(list, true, next);
  assert.equal(after.items.length, next.items.length + 1);
  next.items.forEach((it, i) => assert.equal(after.items[i], it));
  assert.equal(after.children.get("A1"), next.children.get("A1"));
  next = after;

  // The subagent's result: its group changes, and the group's other calls and the other items don't.
  list = add(list, { kind: "claude", data: { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "A1", content: "Done" }] } } });
  const done = buildModel(list, true, next);
  next.items.forEach((it, i) => (i === tools ? assert.notEqual(done.items[i], it) : assert.equal(done.items[i], it)));
  assert.equal(done.items[tools].calls.find((c) => c.id === "A1").result.content, "Done");
  for (const c of next.items[tools].calls) if (c.id !== "A1") assert.equal(done.items[tools].calls.find((x) => x.id === c.id), c);
  assert.equal(done.subagents.get("A1").status, "completed");

  // A full build (here after a reload) keeps them too.
  const reloaded = buildModel(list.map((m) => m), true, done);
  assert.equal(reloaded.items, done.items);
  assert.equal(reloaded.subagents.get("A1"), done.subagents.get("A1"));
});
