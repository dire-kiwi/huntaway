import assert from "node:assert/strict";
import { register } from "node:module";
import { mock, test } from "node:test";

// The app's modules import each other without extensions, as Vite allows.
const hook = `export async function resolve(spec, ctx, next) {
  if (spec.startsWith(".") && !/\\.[cm]?[jt]sx?$/.test(spec)) {
    try { return await next(spec + ".ts", ctx); } catch {}
  }
  return next(spec, ctx);
}`;
register("data:text/javascript," + encodeURIComponent(hook));
const { attentionCount, notificationText, notifyGate, notifySettings, saveNotifySettings, stillApplies, taskEvent, DEFAULT_NOTIFY } = await import(
  "../src/notifications.ts"
);
const { handleEvent, liveTaskChanges, useStore } = await import("../src/store.ts");

const task = (o = {}) => ({ host_id: "h", id: "t1", kind: "task", profile_id: "p", status: "in_progress", running: true, attention_reason: null, title: "Fix it", ...o });

test("a task notifies as it goes to Needs attention, ready to review, Ready for merge or Done", () => {
  const working = task();
  assert.equal(taskEvent(working, task({ status: "needs_attention", running: false, attention_reason: "Run failed: boom" })), "attention");
  // A permission prompt or a question while the agent runs.
  assert.equal(taskEvent(working, task({ status: "needs_attention", attention_reason: "Approve Bash?" })), "attention");
  assert.equal(taskEvent(working, task({ status: "in_review", running: false })), "review");
  assert.equal(taskEvent(task({ status: "in_review" }), task({ status: "ready_for_merge", running: true })), "merge");
  assert.equal(taskEvent(task({ status: "ready_for_merge" }), task({ status: "done", resolution: "done" })), "done");
  // Staying put, or other moves, don't.
  assert.equal(taskEvent(task({ status: "needs_attention" }), task({ status: "needs_attention", attention_reason: "Another?" })), null);
  assert.equal(taskEvent(task({ status: "needs_attention" }), working), null);
  assert.equal(taskEvent(task({ status: "todo", running: false }), working), null);
});

test("ready to review is once its review passes, not while it runs or after it found issues", () => {
  const reviewing = task({ status: "in_review", running: false, review: { state: "running" } });
  assert.equal(taskEvent(task(), reviewing), null);
  assert.equal(taskEvent(reviewing, { ...reviewing, review: { state: "issues" } }), null);
  assert.equal(taskEvent(reviewing, { ...reviewing, review: { state: "passed" } }), "review");
  // In review with its agent still running (moved there mid-run) isn't ready yet.
  assert.equal(taskEvent(task(), task({ status: "in_review", running: true })), null);
  assert.equal(taskEvent(task({ status: "in_review", running: true }), task({ status: "in_review", running: false })), "review");
});

test("a run the user stopped, review threads and scratch chats from older hosts don't notify", () => {
  assert.equal(taskEvent(task(), task({ status: "needs_attention", attention_reason: "Stopped by user" })), null);
  assert.equal(taskEvent(task({ kind: "review" }), task({ kind: "review", status: "needs_attention" })), null);
  assert.equal(taskEvent(task({ kind: "scratch" }), task({ kind: "scratch", status: "needs_attention" })), null);
});

test("a notification shows the task's key and title, and the reason", () => {
  assert.deepEqual(notificationText("attention", task({ attention_reason: "Approve Bash?" }), "HA-8"), { title: "HA-8 Fix it", body: "Needs attention: Approve Bash?" });
  assert.equal(notificationText("attention", task(), "HA-8").body, "Needs attention");
  assert.equal(notificationText("review", task({ review: { state: "passed" } }), "HA-8").body, "Ready to review: its review passed");
  assert.equal(notificationText("done", task({ resolution: "wont_fix" }), "HA-8").body, "Closed: won't fix");
  assert.ok(notificationText("attention", task({ attention_reason: "x".repeat(500) }), "HA-8").body.length <= 200);
});

test("the count is of the tasks that need attention", () => {
  const tasks = [task({ status: "needs_attention" }), task({ status: "needs_attention", kind: "review" }), task({ status: "in_review" }), task({ status: "needs_attention" })];
  assert.equal(attentionCount(tasks), 2);
});

test("a notification stops applying once the task moves on", () => {
  assert.equal(stillApplies("attention", task({ status: "needs_attention" })), true);
  assert.equal(stillApplies("attention", task()), false);
  assert.equal(stillApplies("review", task({ status: "in_review", running: false, review: { state: "running" } })), false);
});

test("ready to review waits out the grace period, and a review or run that starts meanwhile cancels it", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const seen = [];
    let now = null;
    const gate = notifyGate((t, e) => seen.push(`${t.id}:${e}`), () => now, 5000);
    const ready = task({ status: "in_review", running: false });

    // It stays ready: one notification once the grace is over.
    now = ready;
    gate.observe(task(), ready);
    gate.observe(ready, { ...ready, cost_usd: 1 }); // another change meanwhile doesn't start it again
    mock.timers.tick(4999);
    assert.deepEqual(seen, []);
    mock.timers.tick(1);
    assert.deepEqual(seen, ["t1:review"]);

    // A review starts a moment after: nothing until it passes.
    seen.length = 0;
    const reviewing = { ...ready, review: { state: "running" } };
    gate.observe(task(), ready);
    now = reviewing;
    gate.observe(ready, reviewing);
    mock.timers.tick(10_000);
    assert.deepEqual(seen, []);

    // Attention notifies at once, and takes over from a pending one.
    gate.observe(task(), ready);
    const asking = task({ status: "needs_attention", attention_reason: "Approve Bash?" });
    now = asking;
    gate.observe(ready, asking);
    assert.deepEqual(seen, ["t1:attention"]);
    mock.timers.tick(10_000);
    assert.deepEqual(seen, ["t1:attention"]);

    // A task that's gone by then doesn't.
    seen.length = 0;
    gate.observe(task(), ready);
    now = undefined;
    mock.timers.tick(10_000);
    assert.deepEqual(seen, []);
  } finally {
    mock.timers.reset();
  }
});

test("settings start from the defaults, and keep what's saved", () => {
  const store = new Map();
  globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  try {
    assert.deepEqual(notifySettings(), DEFAULT_NOTIFY);
    // Settings from an older build, or edited by hand, keep the defaults for what's missing or wrong.
    store.set("ia.notifications", JSON.stringify({ mode: "loud", events: { done: true } }));
    assert.deepEqual(notifySettings(), { ...DEFAULT_NOTIFY, events: { ...DEFAULT_NOTIFY.events, done: true } });
    saveNotifySettings({ ...DEFAULT_NOTIFY, mode: "both" });
    assert.equal(notifySettings().mode, "both");
    assert.equal(notifySettings(), notifySettings());
  } finally {
    delete globalThis.localStorage;
  }
});

test("task events tell what changed, and loads of tasks don't", async () => {
  const changes = [];
  const listener = (prev, next) => changes.push([prev?.status, next.status]);
  liveTaskChanges.add(listener);
  try {
    useStore.setState({ localHostId: "h", profiles: [{ host_id: "h", id: "p", name: "personal" }], archived: [], tasks: {} });
    // First seen: no previous copy.
    handleEvent({ type: "task", host_id: "h", task: task() });
    handleEvent({ type: "task", host_id: "h", task: task({ status: "needs_attention" }) });
    assert.deepEqual(changes, [[undefined, "in_progress"], ["in_progress", "needs_attention"]]);
    // Another host's task with the same id, or one in a profile that isn't on the board, is left out.
    handleEvent({ type: "task", host_id: "other", task: task({ status: "done" }) });
    handleEvent({ type: "task", host_id: "h", task: task({ id: "t2", profile_id: "gone", status: "done" }) });
    // A list that loads changes the store without telling.
    useStore.setState((s) => ({ tasks: { ...s.tasks, t1: task({ status: "in_review" }) } }));
    assert.equal(changes.length, 2);
  } finally {
    liveTaskChanges.delete(listener);
  }
});
