import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

// The app's modules import each other without extensions, as Vite allows.
const hook = `export async function resolve(spec, ctx, next) {
  if (spec.startsWith(".") && !/\\.[cm]?[jt]sx?$/.test(spec)) {
    try { return await next(spec + ".ts", ctx); } catch {}
  }
  return next(spec, ctx);
}`;
register("data:text/javascript," + encodeURIComponent(hook));
const { handleEvent, useStore } = await import("../src/store.ts");
const { flushDeltas, useDeltas, watchDelta } = await import("../src/deltas.ts");

const host = { id: "local", name: "local", local: true, connected: true, agents: true, api_version: 44, api_compat: 1 };
const task = (id) => ({ id, profile_id: "p", project_id: "proj", kind: "task", title: id, host_id: "local" });
const delta = (task_id, text) => handleEvent({ type: "delta", task_id, text });
const deltas = () => useDeltas.getState().deltas;

function reset() {
  useStore.setState({ hosts: [host], localHostId: "local", tasks: { a: task("a"), b: task("b") }, messages: {} });
  flushDeltas();
  useDeltas.setState({ deltas: {} });
}

// HA-39: each token was a change to the whole store, so every selector on the board ran again for each one.
test("streamed tokens go in their own store, once a frame", async () => {
  reset();
  const unwatch = watchDelta("a");
  let changes = 0;
  const stop = useDeltas.subscribe(() => changes++);
  const board = useStore.getState();
  for (const w of ["one ", "two ", "three"]) delta("a", w);
  assert.equal(useStore.getState(), board, "the board's store is left be");
  assert.equal(changes, 0, "nothing until the frame");
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(changes, 1);
  assert.equal(deltas().a, "one two three");
  delta("a", " four");
  flushDeltas();
  assert.equal(deltas().a, "one two three four");
  stop();
  unwatch();
});

test("tokens for threads nothing shows are left out", () => {
  reset();
  const unwatch = watchDelta("a");
  delta("b", "unseen");
  delta("a", "seen");
  flushDeltas();
  assert.deepEqual(deltas(), { a: "seen" });
  // Two things show it: it's kept until neither does.
  const again = watchDelta("a");
  unwatch();
  delta("a", " still");
  flushDeltas();
  assert.equal(deltas().a, "seen still");
  again();
  assert.deepEqual(deltas(), {});
  delta("a", "after");
  flushDeltas();
  assert.deepEqual(deltas(), {});
});

test("a reset or a saved reply drops the streamed text, and the tokens of that frame before it", () => {
  reset();
  const unwatch = watchDelta("a");
  delta("a", "first block");
  handleEvent({ type: "delta_reset", task_id: "a" });
  delta("a", "second");
  flushDeltas();
  assert.equal(deltas().a, "second");
  delta("a", " block");
  handleEvent({
    type: "message",
    task_id: "a",
    message: { id: 1, task_id: "a", kind: "claude", data: { type: "assistant", message: { content: [{ type: "text", text: "second block" }] } } },
  });
  flushDeltas();
  assert.deepEqual(deltas(), {});
  // A subagent's reply isn't the thread's.
  delta("a", "third");
  handleEvent({ type: "message", task_id: "a", message: { id: 2, task_id: "a", kind: "claude", data: { type: "assistant", parent_tool_use_id: "x" } } });
  flushDeltas();
  assert.equal(deltas().a, "third");
  unwatch();
});
