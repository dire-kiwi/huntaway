// itemThreads.ts: a thread follows its thread_events, catching up after a gap, taking a fresh
// window on a resync, paging back, and streaming its preview text.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "vite-plus/test";

// The app's modules import each other without extensions (and folders by their index.ts), as Vite allows.
const hook = `export async function resolve(spec, ctx, next) {
  if (spec.startsWith(".") && !/\\.[cm]?[jt]sx?$/.test(spec)) {
    try { return await next(spec + ".ts", ctx); } catch {}
    try { return await next(spec + "/index.ts", ctx); } catch {}
  }
  return next(spec, ctx);
}`;
register("data:text/javascript," + encodeURIComponent(hook));
const { handleEvent, useStore } = await import("../src/store.ts");
const { flushDeltas, useDeltas, watchDelta } = await import("../src/deltas.ts");
const { api, ApiError } = await import("../src/api/index.ts");
const it = await import("../src/itemThreads.ts");

const thread = (id) => ({ id, harness: "claude", status: "idle", created_at: "" });
const text = (id, t, extra = {}) => ({ id, type: "assistant_message", text: t, ...extra });
const added = (task, seq, item) => ({ type: "item.added", thread_id: task, seq, item });
const ev = (task, event) => handleEvent({ type: "thread_event", task_id: task, event });
const texts = (task) => it.useItemThreads.getState().threads[task]?.snap?.items.map((i) => i.text);
const tick = () => new Promise((r) => setTimeout(r, 0));
/** A promise and the function that settles it, for an API call answered when the test says. */
function later() {
  let settle;
  const p = new Promise((resolve, reject) => (settle = { resolve, reject }));
  return [p, settle];
}

function setup(task) {
  it.resetItemThreads();
  useStore.setState({ localHostId: "local", hosts: [{ id: "local", local: true, connected: true }], tasks: { [task]: { id: task, host_id: "local" } } });
}

test("events that come while the window loads are applied after it, and those it has are left out", async () => {
  setup("a");
  const [window, answer] = later();
  api.thread = () => window;
  const release = it.retainItemThread("local", "a");
  ev("a", added("a", 2, text("x", "two")));
  ev("a", added("a", 3, text("y", "three")));
  answer.resolve({ thread: thread("a"), items: [text("w", "one"), text("x", "two")], requests: [], seq: 2 });
  await tick();
  assert.deepEqual(texts("a"), ["one", "two", "three"]);
  assert.equal(it.useItemThreads.getState().threads.a.snap.seq, 3);
  release();
});

test("a gap is caught up from the thread's seq, then the events held meanwhile are applied", async () => {
  setup("b");
  api.thread = async () => ({ thread: thread("b"), items: [text("w", "one")], requests: [], seq: 1 });
  const asked = [];
  const [page, answer] = later();
  api.threadEvents = (_h, _id, after) => (asked.push(after), page);
  const release = it.retainItemThread("local", "b");
  await tick();
  // Seq 2 was missed.
  ev("b", added("b", 3, text("y", "three")));
  ev("b", added("b", 4, text("z", "four")));
  assert.deepEqual(asked, [1]);
  assert.deepEqual(texts("b"), ["one"], "nothing applied out of order");
  answer.resolve({ events: [added("b", 2, text("x", "two")), added("b", 3, text("y", "three"))], more: false, seq: 3 });
  await tick();
  assert.deepEqual(texts("b"), ["one", "two", "three", "four"]);
  release();
});

test("a log that doesn't go back that far, or a thread_resync, takes a fresh window", async () => {
  setup("c");
  let windows = 0;
  api.thread = async () => (
    ++windows,
    { thread: thread("c"), items: [text("w", windows === 1 ? "old" : `fresh ${windows}`)], requests: [], seq: 10 * windows }
  );
  api.threadEvents = async () => ({ events: [], more: false, seq: 10, resync: true });
  const release = it.retainItemThread("local", "c");
  await tick();
  ev("c", added("c", 12, text("y", "far")));
  await tick();
  await tick();
  assert.deepEqual(texts("c"), ["fresh 2"]);
  handleEvent({ type: "thread_resync", task_id: "c" });
  await tick();
  assert.deepEqual(texts("c"), ["fresh 3"]);
  release();
});

test("an earlier page goes in front, keeping what events changed in the window since", async () => {
  setup("d");
  const sub = { id: "s", type: "tool_call", name: "Agent", kind: "subagent", input: {}, status: "running" };
  api.thread = async () => ({ thread: thread("d"), items: [sub, text("x", "two", { parent_id: "s" })], requests: [], seq: 5, start: 1, context: [0] });
  const [page, answer] = later();
  api.threadItems = (_h, _id, before) => (assert.equal(before, 1), page);
  const release = it.retainItemThread("local", "d");
  await tick();
  const loading = it.loadOlderItems("d");
  assert.equal(it.useItemThreads.getState().threads.d.loading, true);
  // The subagent ends while the page loads; the page has it as it was.
  ev("d", { type: "item.updated", thread_id: "d", seq: 6, item_id: "s", patch: { status: "completed" } });
  answer.resolve({ thread_id: "d", items: [sub], requests: [], start: 0, context: [], seq: 5 });
  await loading;
  const snap = it.useItemThreads.getState().threads.d.snap;
  assert.deepEqual([snap.start, snap.items.map((i) => i.id), snap.items[0].status], [undefined, ["s", "x"], "completed"]);
  assert.equal(it.useItemThreads.getState().threads.d.loading, false);
  release();
});

test("streamed text shows from its delta events, from its offset, until the message is saved", async () => {
  setup("e");
  api.thread = async () => ({ thread: thread("e"), items: [], requests: [], seq: 1 });
  const release = it.retainItemThread("local", "e");
  const unwatch = watchDelta("e");
  await tick();
  const delta = (item_id, offset, t) => ev("e", { type: "delta", thread_id: "e", seq: 1, item_id, kind: "text", offset, text: t });
  delta("stream:1", 0, "Hel");
  delta("stream:1", 3, "lo");
  // Sent again (from before a reconnect, say): what it has already is skipped.
  delta("stream:1", 0, "Hello");
  // The board's own delta events (for older clients) aren't drawn as well.
  handleEvent({ type: "delta", task_id: "e", text: "Hello" });
  flushDeltas();
  assert.equal(useDeltas.getState().deltas.e, "Hello");
  // Another block streams into a new preview.
  delta("stream:2", 0, "Next");
  flushDeltas();
  assert.equal(useDeltas.getState().deltas.e, "Next");
  ev("e", added("e", 2, text("legacy:5:0", "Next")));
  assert.equal(useDeltas.getState().deltas.e, undefined);
  assert.deepEqual(texts("e"), ["Next"]);
  unwatch();
  release();
});

test("a thread the host has no items for is missing, until it's rebuilt", async () => {
  setup("f");
  api.thread = async () => {
    throw new ApiError(404, "task f has no thread kept as items");
  };
  const release = it.retainItemThread("local", "f");
  await tick();
  assert.equal(it.useItemThreads.getState().missing.f, true);
  release();
  // Rebuilt: it has items now.
  api.thread = async () => ({ thread: thread("f"), items: [text("w", "one")], requests: [], seq: 1 });
  handleEvent({ type: "thread_resync", task_id: "f" });
  await tick();
  assert.equal(it.useItemThreads.getState().missing.f, undefined);
  assert.deepEqual(texts("f"), ["one"]);
});

test("another host's events, and other threads', leave a thread be", async () => {
  setup("g");
  api.thread = async () => ({ thread: thread("g"), items: [text("w", "one")], requests: [], seq: 1 });
  const release = it.retainItemThread("local", "g");
  await tick();
  it.onThreadEvent("elsewhere", "g", added("g", 2, text("x", "theirs")));
  ev("g", added("other", 2, text("x", "other thread")));
  assert.deepEqual(texts("g"), ["one"]);
  release();
});
