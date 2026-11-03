import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

// The app's modules import each other without extensions (and folders by their index.ts), as Vite allows.
const hook = `export async function resolve(spec, ctx, next) {
  if (spec.startsWith(".") && !/\\.[cm]?[jt]sx?$/.test(spec)) {
    try { return await next(spec + ".ts", ctx); } catch {}
    try { return await next(spec + "/index.ts", ctx); } catch {}
  }
  return next(spec, ctx);
}`;
register("data:text/javascript," + encodeURIComponent(hook));
const stored = new Map();
globalThis.localStorage = { getItem: (k) => stored.get(k) ?? null, setItem: (k, v) => stored.set(k, String(v)), removeItem: (k) => stored.delete(k) };
const { handleEvent, useStore } = await import("../src/store.ts");
const { api, ApiError } = await import("../src/api/index.ts");
const { noThread, taskThreadSource, threadEngine } = await import("../src/agentThreads.ts");
const { boardMessages, lastSentAt, mergeRows, movedOn, parseTime, userMessageIds } = await import("../src/threadRows.ts");

const at = (n) => new Date(Date.UTC(2026, 10, 1, 10, 0, 0) + n * 60_000).toISOString();
const sqlite = (n) => at(n).replace("T", " ").replace(/\.\d+Z$/, "");

test("a task is drawn with agent-threads' components when it runs on it, on a host that serves its thread", () => {
  const local = { id: "h", local: true };
  const linked = (api_version) => ({ id: "l", local: false, api_version });
  assert.equal(threadEngine({ run_engine: "agent_threads" }, local), "agent_threads");
  assert.equal(threadEngine({ run_engine: "agent_threads" }, linked(105)), "agent_threads");
  assert.equal(threadEngine({ run_engine: "agent_threads" }, linked(104)), "legacy", "an older host has only the board's messages");
  assert.equal(threadEngine({ run_engine: "agent_threads" }, undefined), "legacy");
  assert.equal(threadEngine({ run_engine: "legacy" }, local), "legacy");
  assert.equal(threadEngine({}, local), "legacy");
  // To look at staged imports: any task is tried.
  localStorage.setItem("ia.stagedThreads", "1");
  try {
    assert.equal(threadEngine({ run_engine: "legacy" }, local), "probe");
    assert.equal(threadEngine({}, linked(90)), "legacy");
  } finally {
    localStorage.removeItem("ia.stagedThreads");
  }
  assert.equal(noThread(new ApiError(404, "task t has no agent-threads thread")), true);
  assert.equal(noThread(new ApiError(503, "no backend")), false);
});

const ev = (seq, type = "item.updated", extra = {}) => ({ type, thread_id: "t", seq, item_id: "a", patch: { text: `v${seq}` }, ...extra });
const snapshot = (seq) => ({ thread: { id: "t", harness: "claude", status: "idle", created_at: at(0) }, items: [], requests: [], seq });

test("a thread's source has the events that came while its window loaded, from /api/ws on its own host", async () => {
  useStore.setState({ localHostId: "h", tasks: {} });
  let loaded;
  const opening = taskThreadSource("h", "task1", () => new Promise((r) => (loaded = r)), 100);
  // While the window loads: one it'll have, one after it, a delta, and others' (another task's, another host's).
  handleEvent({ type: "thread_event", task_id: "task1", event: ev(3) });
  handleEvent({ type: "thread_event", task_id: "task1", event: ev(4) });
  handleEvent({ type: "thread_event", task_id: "task1", event: { type: "delta", thread_id: "t", seq: 4, item_id: "a", kind: "text", offset: 2, text: "x" } });
  handleEvent({ type: "thread_event", task_id: "task2", event: ev(5) });
  handleEvent({ type: "thread_event", host_id: "other", task_id: "task1", event: ev(6) });
  loaded(snapshot(3));
  const source = await opening;
  assert.equal(source.snapshot.seq, 3);
  const got = [];
  const off = source.subscribe((e) => got.push(e));
  assert.deepEqual(got.map((e) => `${e.type}@${e.seq}`), ["item.updated@4", "delta@4"]);
  // Then live.
  handleEvent({ type: "thread_event", task_id: "task1", event: ev(5) });
  assert.equal(got.at(-1).seq, 5);
  off();
  source.close();
  handleEvent({ type: "thread_event", task_id: "task1", event: ev(6) });
  assert.equal(got.length, 3, "a closed source hears nothing");
});

test("a thread catches up from its latest seq when events may have been missed", async () => {
  useStore.setState({ localHostId: "h", tasks: {} });
  const asked = [];
  const saved = [ev(8), ev(9), ev(10)];
  api.threadEvents = async (h, id, after) => {
    asked.push(`${h}/${id}>${after}`);
    // Two pages.
    const rest = saved.filter((e) => e.seq > after);
    return { events: rest.slice(0, 2), more: rest.length > 2, seq: rest.slice(0, 2).at(-1)?.seq ?? after };
  };
  const source = await taskThreadSource("h", "task1", async () => snapshot(5), 100);
  const got = [];
  source.subscribe((e) => got.push(e));
  handleEvent({ type: "thread_event", task_id: "task1", event: ev(7) });
  // The host dropped some.
  handleEvent({ type: "thread_resync" });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(asked, ["h/task1>7", "h/task1>9"]);
  assert.deepEqual(got.map((e) => e.seq), [7, 8, 9, 10]);
  // Another host's resync leaves it be.
  handleEvent({ type: "resync", host_id: "other" });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(asked.length, 2);
  // The store's own resync asks from where it is.
  assert.deepEqual((await source.resync(8)).map((e) => e.seq), [9, 10]);
  source.close();
});

test("timestamps from the thread and from the board's database are read alike", () => {
  assert.equal(parseTime(at(1)), Date.UTC(2026, 10, 1, 10, 1, 0));
  assert.equal(parseTime(sqlite(1)), Date.UTC(2026, 10, 1, 10, 1, 0));
  assert.equal(parseTime("2026-11-01T10:01:00+00:00"), Date.UTC(2026, 10, 1, 10, 1, 0));
  assert.equal(parseTime(undefined), null);
  assert.equal(parseTime("soon"), null);
});

const board = (id, kind, n, data = {}) => ({ id, task_id: "t", kind, data, created_at: sqlite(n) });
const item = (id, n, type = "assistant_message", extra = {}) => ({ id, type, text: id, created_at: at(n), ...extra });

test("the board's prompts, questions and events are drawn, unless an import has them in the thread already", () => {
  const messages = [
    board(1, "user", 0, { text: "hi" }),
    board(2, "event", 1, { level: "info", text: "old" }),
    board(3, "permission", 2, { status: "allowed", request_id: "r-old" }),
    board(4, "claude", 3),
    board(5, "event", 4, { level: "warn", text: "new" }),
    board(6, "permission", 5, { status: "pending", request_id: "r-in-thread" }),
    board(7, "question", 6, { status: "pending" }),
  ];
  // An import up to message 3 (its user message is legacy:1, its event legacy:2), and a request with a prompt's id.
  const snap = { items: [item("legacy:1", 0, "user_message"), item("legacy:2", 1, "notice"), item("x", 3)], requests: [{ id: "r-in-thread", type: "permission" }, { id: "legacy:3", type: "permission" }] };
  assert.deepEqual(boardMessages(messages, snap).map((m) => m.id), [5, 7]);
  assert.deepEqual(boardMessages(messages, { items: [], requests: [] }).map((m) => m.id), [2, 3, 5, 6, 7]);
  assert.deepEqual(boardMessages(undefined, snap), []);
});

const ids = (merged) => merged.map((r) => (r.kind === "row" ? (r.row.type === "tool_group" ? `g:${r.row.key}` : r.row.id) : `b${r.message.id}`));

test("the board's messages go among the thread's rows by time", () => {
  const rows = [item("a", 1), { type: "tool_group", key: "c1", calls: [item("c1", 3, "tool_call"), item("c2", 4, "tool_call")] }, item("untimed", null), item("d", 6)];
  rows[2].created_at = undefined;
  const msgs = [board(1, "event", 0.5), board(2, "event", 2), board(3, "event", 5), board(4, "event", 7)];
  assert.deepEqual(ids(mergeRows(rows, msgs, false)), ["b1", "a", "b2", "g:c1", "untimed", "b3", "d", "b4"]);
  // With earlier items still to load, one from before the first row loaded waits for them.
  assert.deepEqual(ids(mergeRows(rows, msgs, true)), ["a", "b2", "g:c1", "untimed", "b3", "d", "b4"]);
  assert.deepEqual(ids(mergeRows([], msgs, false)), ["b1", "b2", "b3", "b4"]);
  assert.deepEqual(ids(mergeRows([], msgs, true)), []);
});

test("a request row is placed by when it was asked", () => {
  const req = { type: "request", request: { id: "q", type: "question", created_at: at(2.5) } };
  const merged = mergeRows([item("a", 1), req], [board(1, "event", 2), board(2, "event", 3)], false);
  assert.deepEqual(merged.map((r) => (r.kind === "board" ? `b${r.message.id}` : r.row.type === "request" ? `r:${r.row.request.id}` : r.row.id)), ["a", "b1", "r:q", "b2"]);
});

test("the thread's user messages are matched to the board's, for rewinding to before them", () => {
  const items = [
    item("legacy:4", 0, "user_message"),
    { id: "u1", type: "user_message", text: "Fix it", created_at: at(1) },
    { id: "s1", type: "user_message", text: "Fix it", parent_id: "agent", created_at: at(2) },
    { id: "u2", type: "user_message", text: "Unknown to the board", created_at: at(3) },
    { id: "u3", type: "user_message", text: "Fix it ", created_at: at(4) },
  ];
  const msgs = [board(4, "user", 0, { text: "legacy" }), board(10, "user", 1, { text: "Fix it" }), board(11, "event", 2), board(12, "user", 4, { text: "Fix it" })];
  assert.deepEqual([...userMessageIds(items, msgs)], [
    ["legacy:4", 4],
    ["u1", 10],
    ["u3", 12],
  ]);
});

test("a request asked before the user's last message is one the conversation moved on from", () => {
  const items = [item("u1", 1, "user_message"), item("a", 2), item("sub", 5, "user_message", { parent_id: "x" })];
  const sent = lastSentAt(items);
  assert.equal(sent, parseTime(at(1)));
  assert.equal(movedOn({ id: "q", created_at: at(0.5) }, sent), true);
  assert.equal(movedOn({ id: "q", created_at: at(3) }, sent), false, "a subagent's messages aren't the user's");
  assert.equal(movedOn({ id: "q" }, sent), false);
  assert.equal(lastSentAt([item("a", 2)]), null);
});
