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
const { useStore, retainThread, withMessage } = await import("../src/store.ts");
const { api } = await import("../src/api.ts");

const msg = (id, text = `m${id}`) => ({ id, task_id: "t", kind: "user", data: { text }, created_at: "" });
const ids = (list) => list.map((m) => m.id);

test("a message goes in id order, and an update replaces the one with its id", () => {
  const list = [msg(1), msg(3), msg(5)];
  assert.deepStrictEqual(ids(withMessage(list, msg(6))), [1, 3, 5, 6]);
  assert.deepStrictEqual(ids(withMessage(list, msg(4))), [1, 3, 4, 5]);
  assert.deepStrictEqual(ids(withMessage(list, msg(0))), [0, 1, 3, 5]);
  assert.deepStrictEqual(ids(withMessage([], msg(2))), [2]);
  const updated = withMessage(list, msg(3, "new"));
  assert.deepStrictEqual(ids(updated), [1, 3, 5]);
  assert.equal(updated[1].data.text, "new");
  assert.equal(updated[0], list[0]);
  assert.deepStrictEqual(ids(list), [1, 3, 5], "the old list is left as it was");
});

test("a thread's messages go once nothing shows it, and a load that finishes after leaves them gone", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let answer;
    api.messages = () => new Promise((resolve) => (answer = resolve));
    useStore.setState({ tasks: { t: { id: "t", host_id: "h" } }, messages: {} });
    const s = () => useStore.getState();

    // Two views show it; one goes.
    const first = retainThread("t");
    const second = retainThread("t");
    let load = s().loadMessages("t");
    answer([msg(1)]);
    await load;
    assert.deepStrictEqual(ids(s().messages.t), [1]);
    first();
    first(); // twice is once
    mock.timers.tick(60_000);
    assert.deepStrictEqual(ids(s().messages.t), [1]);

    // The other goes: they're kept for a while, in case it's shown again soon.
    second();
    mock.timers.tick(1000);
    assert.ok(s().messages.t);
    mock.timers.tick(60_000);
    assert.equal(s().messages.t, undefined);

    // Shown again and gone before its messages came.
    const third = retainThread("t");
    load = s().loadMessages("t");
    third();
    answer([msg(1), msg(2)]);
    await load;
    assert.equal(s().messages.t, undefined);

    // Shown again within the while: kept.
    const fourth = retainThread("t");
    load = s().loadMessages("t");
    answer([msg(1), msg(2)]);
    await load;
    fourth();
    mock.timers.tick(1000);
    const fifth = retainThread("t");
    mock.timers.tick(60_000);
    assert.deepStrictEqual(ids(s().messages.t), [1, 2]);
    fifth();
  } finally {
    mock.timers.reset();
  }
});
