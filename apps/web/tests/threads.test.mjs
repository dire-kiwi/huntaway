import assert from "node:assert/strict";
import { test } from "node:test";
import { apply_events, initial_state, snapshot_window } from "../src/threads.ts";

// HA-212: the app gets the thread model from the server's file (apps/server/src/threads/protocol.ts), by relative path.
test("folds a thread's events with the server's reducer", () => {
  const thread = { id: "th", harness: "claude", status: "idle", created_at: "2026-11-01T00:00:00Z" };
  const s = apply_events(initial_state(thread), [
    { type: "item.added", thread_id: "th", seq: 1, item: { id: "a1", type: "assistant_message", text: "" } },
    { type: "delta", thread_id: "th", seq: 1, item_id: "a1", kind: "text", offset: 0, text: "Hello" },
    { type: "item.added", thread_id: "th", seq: 2, item: { id: "a2", type: "assistant_message", text: "Bye" } },
  ]);
  assert.deepEqual(s.items.map((i) => i.text), ["Hello", "Bye"]);
  assert.equal(s.seq, 2);
  assert.deepEqual(snapshot_window(s, 1).items.map((i) => i.id), ["a2"]);
});
