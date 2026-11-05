// Threads written as items live (threads/write.ts): the setting and the flag, every write point (db/messages.ts's
// insert_message, update_message_data and update_pending_message, reached from AppState.add_message, start_run, and the
// permission, question and merge-gate updates), what's sent once committed, rollbacks and crashes, rebuilds, and deltas.
// The fixture and Codex tests (fixtures.test.ts, codex.test.ts) write whole recorded sessions this way too.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import * as db from "../db.ts";
import type { Task } from "../db.ts";
import type { AppState } from "../state.ts";
import * as testing from "../testing.ts";
import * as runs from "../agent/runs.ts";
import * as runner from "../agent/runner.ts";
import * as questions from "../mcp/questions.ts";
import * as permissions from "../mcp/permissions.ts";
import * as merge_gate from "../review/merge_gate.ts";
import * as store from "./store.ts";
import * as write from "./write.ts";
import * as rebuild_cli from "./rebuild.ts";
import * as live from "./live.ts";
import { convert } from "./translate.ts";

// A run's launch fails rather than starting a real agent (with TEST_CAN_RUN, its messages are still written).
process.env.IA_SHIM_BIN = "/nonexistent/ia-shim";
process.env.IA_CLAUDE_BIN = "/nonexistent/claude";
process.env.IA_CODEX_BIN = "/nonexistent/codex";

function setup(on = true): { s: AppState; events: any[]; task: (title?: string) => Task } {
  const s = testing.state();
  if (on) db.set_setting(s.db(), write.SETTING, "true");
  const events: any[] = [];
  s.events.subscribe((e) => events.push(e));
  const profile = db.insert_profile(s.db(), "p", [], null);
  const task = (title = "t") =>
    db.insert_task(s.db(), { profile_id: profile.id, project_id: null, kind: "task", title, description: "", status: "in_progress", use_worktree: false });
  return { s, events, task };
}

const flagged = (s: AppState, id: string) => db.value<number>(s.db(), "SELECT thread_items FROM tasks WHERE id=?1", id) === 1;
const count = (s: AppState, table: string, id: string) => db.value<number>(s.db(), `SELECT COUNT(*) FROM ${table} WHERE task_id=?1`, id)!;
const THREAD_TABLES = ["threads", "thread_items", "thread_requests", "thread_events", "thread_item_origins"];

/** The task's items and requests are what a rebuild from its messages makes, and its origins and metas too. */
function matches_rebuild(s: AppState, id: string) {
  const c = s.db();
  assert.deepEqual(write.compare(c, id), []);
  const rebuilt = convert(db.list_messages(c, id), { finished: false });
  assert.deepEqual({ items: store.items(c, id), requests: store.requests(c, id) }, { items: rebuilt.items, requests: rebuilt.requests });
  assert.deepEqual(store.metas(c, id), rebuilt.meta);
}

const thread_events = (events: any[], id: string) => events.filter((e) => e.type === "thread_event" && e.task_id === id).map((e) => e.event);

test("with the setting off, nothing new is written", () => {
  const { s, events, task } = setup(false);
  const t = task();
  s.add_message(t.id, "user", { text: "hi" });
  s.add_event(t.id, "info", "set up");
  const p = s.add_message(t.id, "permission", { tool_name: "Bash", input: { command: "ls" }, request_id: "r1", status: "pending" });
  db.update_message_data(s.db(), p.id, { ...p.data, status: "allowed" });
  const q = s.add_message(t.id, "question", { question: "Which?", options: [], status: "pending" });
  db.update_pending_message(s.db(), q.id, { ...q.data, status: "replied" });
  s.emit_delta(t.id, "streamed");
  assert.equal(flagged(s, t.id), false);
  for (const table of THREAD_TABLES) assert.equal(count(s, table, t.id), 0, table);
  assert.deepEqual(thread_events(events, t.id), []);
  // The thread API has none for it: its thread is its messages.
  assert.throws(() => live.open(s, t.id), /has no thread kept as items/);
  // Nor does turning it on later flag a task that has messages: its items would have a gap.
  db.set_setting(s.db(), write.SETTING, "true");
  s.add_message(t.id, "user", { text: "more" });
  assert.equal(flagged(s, t.id), false);
  assert.equal(count(s, "thread_items", t.id), 0);
  // A new one is.
  const u = task();
  s.add_message(u.id, "user", { text: "hi" });
  assert.equal(flagged(s, u.id), true);
  assert.equal(store.has_thread(s.db(), u.id), true);
  // The thread API serves it.
  const w = live.window(s, live.open(s, u.id));
  assert.deepEqual([w.items.map((i: any) => i.text), w.seq], [["hi"], store.last_seq(s.db(), u.id)]);
  // Turned off, flagged tasks carry on, and new ones aren't flagged.
  db.set_setting(s.db(), write.SETTING, null);
  s.add_message(u.id, "user", { text: "again" });
  assert.equal(store.items(s.db(), u.id).length, 2);
  const v = task();
  s.add_message(v.id, "user", { text: "hi" });
  assert.equal(flagged(s, v.id), false);
});

test("every kind of message, and every update in place, writes what a rebuild makes", () => {
  const { s, events, task } = setup();
  const t = task();
  const id = t.id;
  // As the board's routes do: written, then sent.
  const update = (message_id: number, data: any) => s.emit_message_updated(db.update_message_data(s.db(), message_id, data)!);
  s.add_message(id, "user", { text: "Fix it", auto: true, start: true });
  s.add_event(id, "info", "Worktree ready", "on branch x");
  const sys = (v: any) => s.add_message(id, "claude", { session_id: "S", ...v });
  sys({ type: "assistant", message: { content: [{ type: "thinking", thinking: "Hmm" }, { type: "text", text: "Looking" }] } });
  sys({ type: "assistant", message: { content: [{ type: "tool_use", id: "bash1", name: "Bash", input: { command: "ls" } }] } });
  // A prompt for it, allowed.
  const p = s.add_message(id, "permission", { tool_name: "Bash", input: { command: "ls" }, tool_use_id: "bash1", request_id: "perm1", status: "pending" });
  matches_rebuild(s, id);
  assert.equal(store.open_requests(s.db(), id).length, 1);
  update(p.id, { ...p.data, status: "allowed" });
  assert.equal(store.open_requests(s.db(), id).length, 0);
  sys({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "bash1", content: "a\nb" }] } });
  // A subagent, and what it does under its call.
  sys({ type: "assistant", message: { content: [{ type: "tool_use", id: "agent1", name: "Task", input: { description: "Look", prompt: "Look around", subagent_type: "x" } }] } });
  sys({ type: "system", subtype: "task_started", task_id: "job1", tool_use_id: "agent1", description: "Look" });
  sys({ type: "assistant", parent_tool_use_id: "agent1", message: { content: [{ type: "tool_use", id: "read1", name: "Read", input: { file_path: "/a" } }] } });
  sys({ type: "user", parent_tool_use_id: "agent1", message: { content: [{ type: "tool_result", tool_use_id: "read1", content: "text" }] } });
  sys({ type: "system", subtype: "task_notification", task_id: "job1", tool_use_id: "agent1", status: "completed" });
  sys({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "agent1", content: [{ type: "text", text: "Found it" }] }] } });
  const items = store.items(s.db(), id);
  assert.equal(items.find((i) => i.id === "read1")?.parent_id, "agent1");
  // A plan, sent back with feedback, then a denied prompt, and one that expired, answered late.
  const plan = s.add_message(id, "permission", { tool_name: "ExitPlanMode", input: { plan: "Do it" }, request_id: "plan1", status: "pending" });
  update(plan.id, { ...plan.data, status: "denied", note: "Not yet" });
  const denied = s.add_message(id, "permission", { tool_name: "Write", input: { file_path: "/x" }, request_id: "perm2", status: "pending" });
  update(denied.id, { ...denied.data, status: "denied" });
  const ask = s.add_message(id, "permission", { tool_name: "AskUserQuestion", input: { questions: [{ question: "Which?", options: [{ label: "A" }] }] }, request_id: "q1", status: "pending" });
  update(ask.id, { ...ask.data, status: "expired" });
  update(ask.id, { ...ask.data, status: "allowed", answers: { "Which?": "A" }, late: true });
  // The board's own approvals.
  const approval = s.add_message(id, "permission", { tool_name: "mcp__huntaway__delete_task", kind: "delete_task", input: { task: "X-1" }, request_id: "del1", status: "pending" });
  update(approval.id, { ...approval.data, status: "allowed" });
  // The turn ends, the conversation is compacted, and a routine's report comes (kept only in messages).
  sys({ type: "assistant", message: { content: [{ type: "text", text: "Done" }] } });
  sys({ type: "result", subtype: "success", is_error: false, result: "Done", duration_ms: 1200 });
  s.add_event(id, "info", "Compacting");
  sys({ type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "manual", pre_tokens: 1000 } });
  s.add_message(id, "report", { automation: "Daily", text: "All quiet" });
  // A question asked with request_user_input, replied to, and a merge-gate card replaced by a new one.
  const q = s.add_message(id, "question", { question: "Merge?", options: [{ label: "Yes" }], status: "pending" });
  questions.replied(s, id);
  assert.equal(db.list_messages(s.db(), id).find((m) => m.id === q.id)!.data.status, "replied");
  merge_gate.ask(s, id);
  merge_gate.settle(s, id, "replaced");
  merge_gate.ask(s, id);
  s.add_message(id, "user", { text: "and then", steered: true });
  matches_rebuild(s, id);
  // The replaced card is a cancel with a message, the new one open, and only the report warns (it's kept in messages).
  const reqs = store.requests(s.db(), id);
  const replaced = reqs.filter((r) => r.resolution?.message?.startsWith("No longer asked"));
  assert.equal(replaced.length, 1);
  assert.equal(store.open_requests(s.db(), id).length, 1);
  const warnings = convert(db.list_messages(s.db(), id), { finished: false }).warnings;
  assert.deepEqual(warnings.map((w) => w.code), ["unknown_kind"]);
  // Each message's events went out after it, numbered with no gaps.
  const sent = thread_events(events, id);
  assert.deepEqual(sent.map((e) => e.seq), sent.map((_, i) => i + 1));
  assert.equal(sent.at(-1).seq, store.last_seq(s.db(), id));
  // And they're what a client folding them from nothing has.
  assert.deepEqual(new Set(sent.filter((e) => e.type === "item.added").map((e) => e.item.id)), new Set(store.items(s.db(), id).map((i) => i.id)));
});

test("a question that becomes answerable again reopens its request", () => {
  const { s, events, task } = setup();
  const t = task();
  s.add_message(t.id, "user", { text: "go" });
  // The answer can't be sent (this host can't run agents): the question is answerable again.
  const q = s.add_message(t.id, "question", { question: "Which?", options: [{ label: "A" }, { label: "B" }], status: "pending" });
  assert.throws(() => questions.answer(s, t.id, q.id, { choices: ["A"] }), /can't run agents/);
  assert.equal(db.list_messages(s.db(), t.id).find((m) => m.id === q.id)!.data.status, "pending");
  const [request] = store.open_requests(s.db(), t.id);
  assert.equal(request?.id, `legacy:${q.id}`);
  assert.equal(request?.resolution, undefined);
  matches_rebuild(s, t.id);
  // The thread's events say so: resolved, then opened again, sent with no gap.
  const sent = thread_events(events, t.id);
  assert.deepEqual(sent.slice(-2).map((e) => e.type), ["request.resolved", "request.opened"]);
  assert.deepEqual(sent.map((e) => e.seq), sent.map((_, i) => i + 1));
});

test("answering a question sends its thread's events in order: the answer's, then the reply's or the merge decision's", async () => {
  runs.TEST_CAN_RUN.set(true);
  try {
    const { s, events, task } = setup();
    const in_order = (id: string) => {
      const sent = thread_events(events, id).filter((e) => e.type !== "delta");
      assert.deepEqual(sent.map((e) => e.seq), sent.map((_, i) => i + 1), sent.map((e) => `${e.seq}:${e.type}`).join(" "));
      assert.equal(sent.at(-1).seq, store.last_seq(s.db(), id));
    };
    // A request_user_input question, whose answer is the agent's next prompt (a run of its own starts with it).
    const t = task();
    s.add_message(t.id, "user", { text: "go" });
    const q = s.add_message(t.id, "question", { question: "Which?", options: [{ label: "A" }, { label: "B" }], status: "pending" });
    questions.answer(s, t.id, q.id, { choices: ["A"] });
    const reply = db.list_messages(s.db(), t.id).find((m) => m.kind === "user" && m.id > q.id);
    assert.match(reply?.data.text ?? "", /Which\?/);
    const sent = thread_events(events, t.id);
    const resolved = sent.findIndex((e) => e.type === "request.resolved" && e.request_id === `legacy:${q.id}`);
    const replied = sent.findIndex((e) => e.type === "item.added" && e.item.id === `legacy:${reply!.id}`);
    assert.ok(resolved >= 0 && replied > resolved, `resolved at ${resolved}, the reply at ${replied}`);
    in_order(t.id);
    for (let i = 0; i < 100 && s.is_running(t.id); i++) await new Promise((r) => setTimeout(r, 10));
    in_order(t.id);
    matches_rebuild(s, t.id);
    // A merge-approval card, whose answer the board acts on (an event, and the merge's start).
    const m = task("merge");
    s.add_message(m.id, "user", { text: "go" });
    db.run(s.db(), "UPDATE tasks SET status='needs_attention', merging=1, merge_approval='pending' WHERE id=?1", m.id);
    merge_gate.ask(s, m.id);
    const card = db.list_messages(s.db(), m.id).find((x) => x.kind === "question")!;
    questions.answer(s, m.id, card.id, { choices: [merge_gate.APPROVE] });
    assert.ok(db.list_messages(s.db(), m.id).some((x) => x.kind === "event" && x.data.text.startsWith("Merge approved")));
    in_order(m.id);
    for (let i = 0; i < 100 && s.is_running(m.id); i++) await new Promise((r) => setTimeout(r, 10));
    in_order(m.id);
    matches_rebuild(s, m.id);
  } finally {
    runs.TEST_CAN_RUN.set(false);
  }
});

test("start_run's writes are the thread's first: the start message flags the task, and goes out after the commit", async () => {
  runs.TEST_CAN_RUN.set(true);
  try {
    const { s, events, task } = setup();
    const t = task();
    const seen: string[] = [];
    // Nothing is sent while start_run's transaction is open.
    const off = s.events.subscribe((e) => {
      if (e.type === "message" || e.type === "thread_event") seen.push(`${e.type}:${s.db().isTransaction}`);
    });
    runner.send(s, t.id, "");
    off();
    assert.equal(flagged(s, t.id), true);
    const [first] = db.list_messages(s.db(), t.id);
    assert.deepEqual([first?.kind, first?.data.start], ["user", true]);
    const item = store.items(s.db(), t.id)[0];
    assert.deepEqual([item?.type, item?.id], ["user_message", `legacy:${first!.id}`]);
    assert.deepEqual(store.item_meta(s.db(), t.id, item!.id), { auto: true, start: true });
    assert.ok(seen.includes("message:false") && seen.includes("thread_event:false") && !seen.some((x) => x.endsWith(":true")), seen.join(" "));
    // runs.turn_message_id is the start message, as before.
    assert.equal(db.value(s.db(), "SELECT turn_message_id FROM runs WHERE task_id=?1", t.id), first!.id);
    // The launch fails (there's no agent): its events are written too.
    for (let i = 0; i < 100 && s.is_running(t.id); i++) await new Promise((r) => setTimeout(r, 10));
    assert.ok(db.list_messages(s.db(), t.id).length > 1);
    matches_rebuild(s, t.id);
    const sent = thread_events(events, t.id);
    assert.deepEqual(sent.map((e) => e.seq), sent.map((_, i) => i + 1));
  } finally {
    runs.TEST_CAN_RUN.set(false);
  }
});

test("a write rolled back leaves neither the message nor its items, and the next one goes on from the store", () => {
  const { s, events, task } = setup();
  const t = task();
  const c = s.db();
  s.add_message(t.id, "user", { text: "go" });
  s.add_message(t.id, "claude", { type: "assistant", message: { content: [{ type: "tool_use", id: "c1", name: "Bash", input: { command: "ls" } }] } });
  const before = { items: store.items(c, t.id), seq: store.last_seq(c, t.id) };
  const status = () => (store.get_item(c, t.id, "c1") as any).status;
  assert.throws(
    () =>
      db.tx(c, () => {
        // Its result, then something else in the transaction fails.
        db.insert_message(c, t.id, "claude", { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "c1", content: "x" }] } });
        assert.equal(status(), "completed");
        throw new Error("boom");
      }),
    /boom/,
  );
  assert.deepEqual({ items: store.items(c, t.id), seq: store.last_seq(c, t.id) }, before);
  assert.equal(db.list_messages(c, t.id).length, 2);
  // The translator in memory had taken the result in (it would make the next one a second result): it isn't used again.
  s.add_message(t.id, "claude", { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "c1", content: "y" }] } });
  assert.equal(status(), "completed");
  matches_rebuild(s, t.id);
  // Nothing was sent for the write that was rolled back.
  const sent = thread_events(events, t.id);
  assert.deepEqual(sent.map((e) => e.seq), sent.map((_, i) => i + 1));
});

test("a throw between the message and its items rolls both back", () => {
  const { s, task } = setup();
  const t = task();
  s.add_message(t.id, "user", { text: "go" });
  testing.when("threads:write", () => {
    throw new Error("crash");
  });
  assert.throws(() => s.add_message(t.id, "user", { text: "lost" }), /crash/);
  assert.equal(db.list_messages(s.db(), t.id).length, 1);
  assert.equal(store.items(s.db(), t.id).length, 1);
  matches_rebuild(s, t.id);
});

test("a server that dies between the message and its items leaves neither", () => {
  const dir = testing.temp_dir();
  const file = join(dir, "huntaway.db");
  // The first message, written; the second, cut off between its row and its items.
  const script = `
    import * as db from ${JSON.stringify(new URL("../db.ts", import.meta.url).href)};
    import * as testing from ${JSON.stringify(new URL("../testing.ts", import.meta.url).href)};
    import * as write from ${JSON.stringify(new URL("./write.ts", import.meta.url).href)};
    const c = db.open(${JSON.stringify(file)});
    db.set_setting(c, write.SETTING, "true");
    const p = db.insert_profile(c, "p", [], null);
    const t = db.insert_task(c, { profile_id: p.id, project_id: null, kind: "task", title: "t", description: "", status: "in_progress", use_worktree: false });
    console.log(t.id);
    db.insert_message(c, t.id, "user", { text: "kept" });
    testing.when("threads:write", () => process.exit(3));
    db.insert_message(c, t.id, "user", { text: "lost" });
  `;
  const r = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e", script], { encoding: "utf8" });
  assert.equal(r.status, 3, r.stderr);
  const task_id = r.stdout.trim();
  const c = db.open(file);
  try {
    assert.deepEqual(db.list_messages(c, task_id).map((m) => m.data.text), ["kept"]);
    assert.deepEqual(store.items(c, task_id).map((i: any) => i.text), ["kept"]);
    assert.deepEqual(write.compare(c, task_id), []);
  } finally {
    c.close();
  }
});

test("a translator failure keeps the message, and stops the thread's live writes until it's rebuilt", () => {
  const { s, events, task } = setup();
  const t = task();
  const c = s.db();
  s.add_message(t.id, "user", { text: "go" });
  testing.when("threads:translated", () => {
    throw new Error("a bug");
  });
  const orig = console.error;
  const logged: string[] = [];
  console.error = (...a: any[]) => void logged.push(a.join(" "));
  let m: db.Message;
  try {
    m = s.add_message(t.id, "user", { text: "kept" });
  } finally {
    console.error = orig;
  }
  assert.ok(logged.some((l) => l.includes("stops being written as items") && l.includes("a bug")), logged.join("\n"));
  assert.equal(db.list_messages(c, t.id).at(-1)!.id, m.id);
  // None of its items were written.
  assert.equal(store.items(c, t.id).length, 1);
  assert.match(db.value<string>(c, "SELECT error FROM threads WHERE task_id=?1", t.id)!, /a bug/);
  assert.equal(store.has_thread(c, t.id), false);
  // Later messages are written, and skipped by the thread.
  s.add_message(t.id, "user", { text: "later" });
  assert.equal(store.items(c, t.id).length, 1);
  // A rebuild starts it again, with all of them.
  const n = thread_events(events, t.id).length;
  write.rebuild(c, t.id);
  assert.equal(thread_events(events, t.id).length, n);
  assert.equal(store.has_thread(c, t.id), true);
  s.add_message(t.id, "user", { text: "after" });
  assert.deepEqual(store.items(c, t.id).map((i: any) => i.text), ["go", "kept", "later", "after"]);
  matches_rebuild(s, t.id);
});

test("a rebuild from another connection: the server's translator notices, and clients from before it resync", () => {
  const dir = testing.temp_dir();
  const file = join(dir, "huntaway.db");
  const a = db.open(file);
  const b = rebuild_cli.open(file);
  try {
    db.set_setting(a, write.SETTING, "true");
    const p = db.insert_profile(a, "p", [], null);
    const t = db.insert_task(a, { profile_id: p.id, project_id: null, kind: "task", title: "t", description: "", status: "in_progress", use_worktree: false });
    db.insert_message(a, t.id, "user", { text: "go" });
    db.insert_message(a, t.id, "claude", { type: "assistant", message: { content: [{ type: "tool_use", id: "c1", name: "Bash", input: { command: "ls" } }] } });
    // A call written to the database by something without the hook (an older build, say), which the rebuild takes in.
    db.run(b, "INSERT INTO messages (task_id, kind, data, created_at) VALUES (?1, 'claude', ?2, ?3)", t.id, JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "c2", name: "Read", input: { file_path: "/a" } }] } }), new Date().toISOString());
    const seq = store.last_seq(a, t.id);
    const out: string[] = [];
    const results = rebuild_cli.run(rebuild_cli.parse_args(["--all"]), b, (x) => void out.push(x));
    assert.deepEqual(results.map((r) => [r.task_id, r.rebuilt?.messages, r.rebuilt?.items]), [[t.id, 3, 3]]);
    assert.match(out.join(""), /1 tasks rebuilt/);
    assert.equal(store.last_seq(a, t.id), seq + 1);
    assert.equal(store.events_after(a, t.id, seq), null);
    // The first connection's translator is behind the rebuild (it never saw c2): it goes on from the store.
    db.insert_message(a, t.id, "claude", { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "c2", content: "x" }] } });
    assert.equal((store.get_item(a, t.id, "c2") as any).status, "completed");
    assert.deepEqual(write.compare(a, t.id), []);
    // --check changes nothing, and says it's the same.
    const checked = rebuild_cli.run(rebuild_cli.parse_args([t.id, "--check"]), b, () => {});
    assert.deepEqual(checked.map((r) => r.differences), [[]]);
    // A difference shows.
    db.run(a, "UPDATE thread_items SET data=json_set(data, '$.text', 'changed') WHERE task_id=?1 AND type='user_message'", t.id);
    const [diff] = rebuild_cli.run(rebuild_cli.parse_args([t.id, "--check"]), b, () => {});
    assert.equal(diff!.differences!.length, 1);
    assert.match(diff!.differences![0]!, /changed/);
    // Named, a task that isn't flagged is, and gets its whole history.
    db.set_setting(a, write.SETTING, null);
    const u = db.insert_task(a, { profile_id: p.id, project_id: null, kind: "task", title: "u", description: "", status: "in_progress", use_worktree: false });
    db.insert_message(a, u.id, "user", { text: "old" });
    assert.equal(store.has_thread(a, u.id), false);
    rebuild_cli.run(rebuild_cli.parse_args([u.id]), b, () => {});
    assert.equal(store.has_thread(a, u.id), true);
    db.insert_message(a, u.id, "user", { text: "new" });
    assert.deepEqual(store.items(a, u.id).map((i: any) => i.text), ["old", "new"]);
    assert.throws(() => rebuild_cli.parse_args([]), /name the tasks, or --all/);
  } finally {
    a.close();
    b.close();
  }
});

test("streamed text is a delta for a preview item the thread doesn't have, for threads kept as items", () => {
  const { s, events, task } = setup();
  const t = task();
  s.add_message(t.id, "user", { text: "go" });
  const seq = store.last_seq(s.db(), t.id);
  s.emit_delta(t.id, "Hel");
  s.emit_delta(t.id, "lo");
  let d = thread_events(events, t.id).filter((e) => e.type === "delta");
  assert.equal(d.length, 2);
  assert.deepEqual(d.map((e) => [e.seq, e.kind, e.offset, e.text]), [[seq, "text", 0, "Hel"], [seq, "text", 3, "lo"]]);
  assert.equal(d[0].item_id, d[1].item_id);
  assert.match(d[0].item_id, /^stream:/);
  assert.equal(store.get_item(s.db(), t.id, d[0].item_id), null);
  // The board's own delta events are sent as before.
  assert.equal(events.filter((e) => e.type === "delta" && e.task_id === t.id).length, 2);
  // Saved, its text ends the preview: the next streams into another.
  s.add_message(t.id, "claude", { type: "assistant", message: { content: [{ type: "text", text: "Hello" }] } });
  s.emit_delta(t.id, "Next");
  // As does a reset (another message starting, or the run ending).
  s.emit_delta_reset(t.id);
  s.emit_delta(t.id, "Third");
  d = thread_events(events, t.id).filter((e) => e.type === "delta");
  assert.equal(new Set(d.map((e) => e.item_id)).size, 3);
  assert.deepEqual(d.slice(2).map((e) => [e.offset, e.seq]), [[0, store.last_seq(s.db(), t.id)], [0, store.last_seq(s.db(), t.id)]]);
  // Not for a task without items.
  const { s: off, events: off_events, task: off_task } = setup(false);
  const u = off_task();
  off.add_message(u.id, "user", { text: "go" });
  off.emit_delta(u.id, "x");
  assert.deepEqual(thread_events(off_events, u.id), []);
});

test("the permission route's updates go through the hook", () => {
  const { s, task } = setup();
  const t = task();
  s.add_message(t.id, "user", { text: "go" });
  const m = s.add_message(t.id, "permission", { tool_name: "Bash", input: { command: "ls" }, request_id: "r1", status: "pending" });
  permissions.set_message_status(s, m.id, "expired", "Its run ended");
  const [r] = store.requests(s.db(), t.id);
  assert.equal(r?.resolution?.outcome, "cancel");
  matches_rebuild(s, t.id);
});
