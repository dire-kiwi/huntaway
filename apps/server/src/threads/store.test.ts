import { describe, test } from "vite-plus/test";
import assert from "node:assert/strict";
import * as db from "../db.ts";
import type { Conn } from "../db.ts";
import { read_json, read_jsonl } from "./examples.ts";
import {
  apply_events,
  initial_state,
  item_page,
  snapshot_window,
  type Item,
  type NewEvent,
  type SavedEvent,
  type Snapshot,
  type Thread,
  type ThreadEvent,
  type ThreadRequest,
  type ToolCall,
} from "./protocol.ts";
import * as store from "./store.ts";

/** A database with a task in it, on a connection of its own (the store needs nothing else). */
function setup(): { c: Conn; task: string; thread: Thread } {
  const c = db.open(":memory:");
  const task = add_task(c);
  return { c, task, thread: { id: task, harness: "claude", status: "idle", created_at: "2026-11-01T00:00:00Z" } };
}

function add_task(c: Conn): string {
  const p = db.list_profiles(c)[0] ?? db.insert_profile(c, "p", [], null);
  const t = db.insert_task(c, {
    profile_id: p.id,
    project_id: null,
    kind: "task",
    title: "t",
    description: "",
    status: "in_progress",
    use_worktree: false,
  });
  return t.id;
}

/** An event as the store is given it: without its thread and seq. */
function unnumbered(e: ThreadEvent): NewEvent {
  const { thread_id: _t, seq: _s, ...rest } = e as SavedEvent;
  return rest as NewEvent;
}

const added = (item: Item): NewEvent => ({ type: "item.added", item });
const rows = (c: Conn, table: string, task: string) => db.value<number>(c, `SELECT COUNT(*) FROM ${table} WHERE task_id=?1`, task)!;
const ids = (list: { id: string }[]) => list.map((x) => x.id);

describe("spec/examples", () => {
  const events = read_jsonl("thread.events.jsonl") as ThreadEvent[];
  const whole = read_json("thread.snapshot.json") as Snapshot;

  /** An example event as the task's thread's: its thread_id, and a thread.updated's thread's id, are the task's. */
  const for_task = (e: ThreadEvent, task: string): ThreadEvent =>
    e.type === "thread.updated" ? { ...e, thread_id: task, thread: { ...e.thread, id: task } } : { ...e, thread_id: task };

  /** The example thread's events saved for a task, and its thread as the task would give it. */
  function saved() {
    const s = setup();
    store.append(
      s.c,
      s.task,
      events.filter((e) => e.type !== "delta").map((e) => unnumbered(for_task(e, s.task))),
    );
    return { ...s, thread: { ...whole.thread, id: s.task } };
  }

  test("the thread's events saved make thread.snapshot.json", () => {
    const { c, thread } = saved();
    assert.deepEqual(store.snapshot(c, thread), { ...whole, thread });
  });

  test("they're numbered, kept, and read back", () => {
    const { c, task } = saved();
    const want = events.filter((e) => e.type !== "delta").map((e) => for_task(e, task));
    assert.equal(store.last_seq(c, task), want.length);
    assert.deepEqual(store.events_after(c, task, 0), want);
    assert.deepEqual(store.events_after(c, task, 20), want.slice(20));
    assert.deepEqual(store.events_after(c, task, 20, 2), want.slice(20, 22));
    assert.deepEqual(store.events_after(c, task, want.length), []);
    assert.deepEqual(store.events_after(c, task, want.length + 5), []);
    // Folded on the client, they make the snapshot too.
    const thread = { ...whole.thread, id: task };
    assert.deepEqual(apply_events(initial_state(thread), store.events_after(c, task, 0)!), { ...whole, thread });
  });

  test("windows and pages read from the tables are the snapshot's", () => {
    const { c, task, thread } = saved();
    assert.deepEqual(store.window(c, thread, 8), { ...read_json("thread.window.json"), thread });
    assert.deepEqual(store.page(c, task, 5, 3), { ...read_json("thread.page.json"), thread_id: task });
  });
});

describe("append", () => {
  test("adds items after the last, and updates them in place", () => {
    const { c, task, thread } = setup();
    const call: ToolCall = { id: "tc1", type: "tool_call", name: "Bash", kind: "shell", input: { command: "ls" }, status: "pending", turn_id: "t1" };
    const saved = store.append(c, task, [{ type: "turn.started", turn_id: "t1" }, added({ id: "u1", type: "user_message", text: "hi" }), added(call)], {
      message_id: 7,
    });
    assert.deepEqual(
      saved.map((e) => [e.thread_id, e.seq, e.type]),
      [
        [task, 1, "turn.started"],
        [task, 2, "item.added"],
        [task, 3, "item.added"],
      ],
    );
    const pos = () => db.all(c, "SELECT id, pos FROM thread_items WHERE task_id=?1 ORDER BY pos", task).map((r) => [r.id, r.pos]);
    assert.deepEqual(pos(), [
      ["u1", 0],
      ["tc1", 1],
    ]);
    store.append(c, task, [{ type: "item.updated", item_id: "tc1", patch: { status: "completed", result: { content: "a" } } }], { message_id: 8 });
    assert.deepEqual(store.get_item(c, task, "tc1"), { ...call, status: "completed", result: { content: "a" } });
    // Added again with its id: replaced where it was.
    store.append(c, task, [added({ ...call, status: "failed" }), added({ id: "a1", type: "assistant_message", text: "done" })], { message_id: 9 });
    assert.deepEqual(pos(), [
      ["u1", 0],
      ["tc1", 1],
      ["a1", 2],
    ]);
    assert.deepEqual(ids(store.items(c, task)), ["u1", "tc1", "a1"]);
    assert.equal((store.get_item(c, task, "tc1") as ToolCall).status, "failed");
    assert.equal(rows(c, "thread_items", task), 3);
    // An update to an item it doesn't have only goes in the log.
    store.append(c, task, [{ type: "item.updated", item_id: "nope", patch: { text: "x" } }]);
    assert.equal(rows(c, "thread_items", task), 3);
    assert.equal(store.last_seq(c, task), 7);
    assert.equal(store.snapshot(c, thread).seq, 7);
    // The messages each item came from.
    assert.deepEqual(store.item_origins(c, task, "tc1"), [7, 8, 9]);
    assert.deepEqual(store.item_origins(c, task, "u1"), [7]);
    assert.deepEqual(store.items_from(c, task, 9), ["tc1", "a1"]);
    assert.deepEqual(store.items_from(c, task, 1), []);
  });

  test("keeps a subagent call's state live while its subagent runs", () => {
    const { c, task } = setup();
    const live = () => db.all(c, "SELECT id FROM thread_items WHERE task_id=?1 AND live=1", task).map((r) => r.id);
    const agent: ToolCall = { id: "sa", type: "tool_call", name: "Agent", kind: "subagent", input: {}, status: "running" };
    store.append(c, task, [added(agent)]);
    assert.deepEqual(live(), ["sa"]);
    store.append(c, task, [{ type: "item.updated", item_id: "sa", patch: { status: "completed", subagent: { status: "running", background: true } } }]);
    assert.deepEqual(live(), ["sa"]);
    store.append(c, task, [{ type: "item.updated", item_id: "sa", patch: { subagent: { status: "completed", background: true } } }]);
    assert.deepEqual(live(), []);
  });

  test("opens and resolves requests in place", () => {
    const { c, task } = setup();
    const p: ThreadRequest = { id: "p1", type: "permission", name: "Bash", kind: "shell", input: {}, tool_call_id: "tc1" };
    const q: ThreadRequest = { id: "q1", type: "question", questions: [{ id: "a", question: "?" }] };
    store.append(c, task, [
      { type: "request.opened", request: p },
      { type: "request.opened", request: q },
    ]);
    assert.deepEqual(ids(store.open_requests(c, task)), ["p1", "q1"]);
    store.append(c, task, [
      { type: "request.resolved", request_id: "p1", resolution: { outcome: "allow", always: true } },
      { type: "request.resolved", request_id: "nope", resolution: { outcome: "cancel" } },
    ]);
    assert.deepEqual(store.requests(c, task), [{ ...p, resolution: { outcome: "allow", always: true } }, q]);
    assert.deepEqual(ids(store.open_requests(c, task)), ["q1"]);
    // Opened again: open again, where it was.
    store.append(c, task, [{ type: "request.opened", request: p }]);
    assert.deepEqual(store.requests(c, task), [p, q]);
    assert.equal(rows(c, "thread_requests", task), 2);
  });

  test("removes items with their origins", () => {
    const { c, task } = setup();
    store.append(
      c,
      task,
      ["a", "b", "c"].map((id) => added({ id, type: "assistant_message", text: id })),
      { message_id: 1 },
    );
    store.append(c, task, [{ type: "items.removed", item_ids: ["b", "nope"], indices: [1, 3] }]);
    assert.deepEqual(ids(store.items(c, task)), ["a", "c"]);
    assert.deepEqual(store.item_origins(c, task, "b"), []);
    assert.deepEqual(store.items_from(c, task, 1), ["a", "c"]);
    // A new item goes after the last.
    store.append(c, task, [added({ id: "d", type: "assistant_message", text: "d" })]);
    assert.deepEqual(ids(store.items(c, task)), ["a", "c", "d"]);
  });

  test("writes all of a batch or none of it", () => {
    const { c, task } = setup();
    store.append(c, task, [added({ id: "a", type: "assistant_message", text: "a" })]);
    const delta = { type: "delta", item_id: "a", kind: "text", offset: 1, text: "b" } as unknown as NewEvent;
    assert.throws(() => store.append(c, task, [added({ id: "b", type: "assistant_message", text: "b" }), delta]), /deltas aren't saved/);
    assert.equal(store.last_seq(c, task), 1);
    assert.deepEqual(ids(store.items(c, task)), ["a"]);
    // Within the caller's transaction, it's rolled back with it.
    assert.throws(() =>
      db.tx(c, () => {
        store.append(c, task, [added({ id: "c", type: "assistant_message", text: "c" })], { message_id: 3 });
        throw new Error("the message wasn't written");
      }),
    );
    assert.equal(store.last_seq(c, task), 1);
    assert.deepEqual(ids(store.items(c, task)), ["a"]);
    assert.deepEqual(store.items_from(c, task, 3), []);
  });

  test("needs its task", () => {
    const { c } = setup();
    assert.throws(() => store.append(c, "gone", [{ type: "turn.started", turn_id: "t1" }]), /FOREIGN KEY/);
    assert.equal(db.value(c, "SELECT COUNT(*) FROM thread_events"), 0);
    assert.equal(store.has_thread(c, "gone"), false);
  });

  test("numbers each thread's events on its own", () => {
    const { c, task } = setup();
    const other = add_task(c);
    store.append(c, task, [{ type: "turn.started", turn_id: "t1" }]);
    store.append(c, other, [
      { type: "turn.started", turn_id: "t1" },
      { type: "turn.completed", turn_id: "t1" },
    ]);
    store.append(c, task, [{ type: "turn.completed", turn_id: "t1" }]);
    assert.deepEqual([store.last_seq(c, task), store.last_seq(c, other)], [2, 2]);
    // The seq it was given is replaced, as is its thread.
    const [e] = store.append(c, task, [{ type: "turn.started", turn_id: "t2", thread_id: "x", seq: 99 } as unknown as NewEvent]);
    assert.deepEqual(e, { type: "turn.started", thread_id: task, seq: 3, turn_id: "t2" });
  });
});

describe("pruning", () => {
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
  const turns = (n: number): NewEvent[] => Array.from({ length: n }, (_, i) => ({ type: "turn.started", turn_id: `t${i}` }));

  test("keeps a thread's last day of events, and its seq when they've gone", () => {
    const { c, task, thread } = setup();
    store.append(c, task, [added({ id: "a", type: "assistant_message", text: "a" }), ...turns(9)], { at: ago(2 * store.KEEP_MS) });
    // Old, but nothing has been written since: all kept.
    assert.equal(rows(c, "thread_events", task), 10);
    store.append(c, task, turns(5), { at: ago(store.KEEP_MS / 2) });
    store.append(c, task, turns(1));
    const last = store.last_seq(c, task);
    assert.equal(last, 16);
    assert.equal(rows(c, "thread_events", task), 6);
    // The items stay, and so does the seq.
    assert.deepEqual(ids(store.snapshot(c, thread).items), ["a"]);
    assert.equal(store.snapshot(c, thread).seq, last);
    // A client further behind than the log takes a snapshot.
    assert.equal(store.events_after(c, task, 0), null);
    assert.equal(store.events_after(c, task, 9), null);
    assert.equal(store.events_after(c, task, 10)!.length, 6);
    assert.deepEqual(
      store.events_after(c, task, last - 2)!.map((e) => e.seq),
      [last - 1, last],
    );
    // With every event gone, the seq is kept: one up to date has nothing to catch up on, and one behind takes a snapshot.
    assert.equal(store.prune(c, new Date(Date.now() + 2 * store.KEEP_MS).toISOString()), 6);
    assert.equal(rows(c, "thread_events", task), 0);
    assert.equal(store.last_seq(c, task), last);
    assert.deepEqual(store.events_after(c, task, last), []);
    assert.equal(store.events_after(c, task, last - 1), null);
    const [next] = store.append(c, task, turns(1));
    assert.equal(next.seq, last + 1);
    assert.deepEqual(
      store.events_after(c, task, last)!.map((e) => e.seq),
      [last + 1],
    );
  });

  test("prune sweeps every thread", () => {
    const { c, task } = setup();
    const other = add_task(c);
    store.append(c, task, turns(10), { at: ago(2 * store.KEEP_MS) });
    store.append(c, other, turns(3), { at: ago(2 * store.KEEP_MS) });
    store.append(c, other, turns(2));
    assert.deepEqual(
      db.all(c, "SELECT seq FROM thread_events WHERE task_id=?1 ORDER BY seq", other).map((r) => r.seq),
      [4, 5],
    );
    assert.equal(store.prune(c), 10);
    assert.equal(rows(c, "thread_events", task), 0);
    assert.deepEqual(
      db.all(c, "SELECT seq FROM thread_events WHERE task_id=?1 ORDER BY seq", other).map((r) => r.seq),
      [4, 5],
    );
    assert.equal(store.prune(c), 0);
    assert.deepEqual([store.last_seq(c, task), store.last_seq(c, other)], [10, 5]);
  });
});

test("clear empties a thread for a rebuild, and its seq goes up past what clients had", () => {
  const { c, task, thread } = setup();
  store.append(c, task, [added({ id: "a", type: "assistant_message", text: "a" }), { type: "request.opened", request: { id: "r", type: "plan", plan: "p" } }], {
    message_id: 1,
  });
  store.set_item_meta(c, task, "a", { auto: true });
  store.clear(c, task);
  assert.deepEqual(store.snapshot(c, thread), { thread, items: [], requests: [], seq: 3 });
  for (const t of ["thread_items", "thread_requests", "thread_events", "thread_item_origins"]) assert.equal(rows(c, t, task), 0, t);
  // Even a client that had every event: it takes a snapshot.
  assert.equal(store.events_after(c, task, 2), null);
  assert.deepEqual(store.events_after(c, task, 3), []);
  // Events applied without logging them: the seq stays, and nothing is logged.
  assert.deepEqual(store.append(c, task, [added({ id: "b", type: "assistant_message", text: "b" })], { message_id: 2, log: false }), []);
  assert.deepEqual(ids(store.items(c, task)), ["b"]);
  assert.deepEqual(store.item_origins(c, task, "b"), [2]);
  assert.equal(store.last_seq(c, task), 3);
  assert.equal(rows(c, "thread_events", task), 0);
  assert.equal(store.has_thread(c, task), true);
});

test("a task's thread goes with it", () => {
  const { c, task } = setup();
  const other = add_task(c);
  for (const t of [task, other]) {
    store.append(
      c,
      t,
      [
        added({ id: "a", type: "assistant_message", text: "a" }),
        { type: "request.opened", request: { id: "p", type: "permission", name: "Bash", kind: "shell", input: {} } },
      ],
      { message_id: 1 },
    );
    store.set_item_meta(c, t, "a", { auto: true });
  }
  const tables = ["thread_items", "thread_requests", "thread_events", "thread_item_origins"];
  assert.deepEqual(
    tables.map((table) => rows(c, table, task)),
    [1, 1, 2, 1],
  );
  db.run(c, "DELETE FROM tasks WHERE id=?1", task);
  assert.deepEqual(
    tables.map((table) => rows(c, table, task)),
    [0, 0, 0, 0],
  );
  assert.deepEqual(
    tables.map((table) => rows(c, table, other)),
    [1, 1, 2, 1],
  );
  assert.deepEqual(store.item_meta(c, other, "a"), { auto: true });
});

test("items keep what the board knows about them", () => {
  const { c, task } = setup();
  store.append(c, task, [added({ id: "u1", type: "user_message", text: "hi" })]);
  assert.equal(store.item_meta(c, task, "u1"), null);
  store.set_item_meta(c, task, "u1", { from_agent: true });
  // An update to the item leaves it.
  store.append(c, task, [{ type: "item.updated", item_id: "u1", patch: { queued: null } }, added({ id: "u1", type: "user_message", text: "hi!" })]);
  assert.deepEqual(store.item_meta(c, task, "u1"), { from_agent: true });
  store.set_item_meta(c, task, "u1", null);
  assert.equal(store.item_meta(c, task, "u1"), null);
});

describe("windows", () => {
  const msg = (id: string, parent_id?: string, turn_id = "t1"): Item => ({
    id,
    type: "assistant_message",
    text: id,
    turn_id,
    ...(parent_id ? { parent_id } : {}),
  });
  const agent = (id: string, status: ToolCall["status"], parent_id?: string): Item => ({
    id,
    type: "tool_call",
    name: "Agent",
    kind: "subagent",
    input: {},
    status,
    turn_id: "t1",
    ...(parent_id ? { parent_id } : {}),
  });
  const permission = (id: string, extra: Partial<ThreadRequest> = {}): ThreadRequest =>
    ({ id, type: "permission", name: "Bash", kind: "shell", input: {}, turn_id: "t1", ...extra }) as ThreadRequest;

  /**
   * protocol.test.ts's windows thread, with sb's subagent still running, and items removed before and among them, so
   * positions have gaps: x0 m0 sa x1 m2 sb m4 b1 m6 tc m8 m9, with x0 and x1 removed.
   */
  function events(): NewEvent[] {
    return [
      added(msg("x0")),
      added(msg("m0")),
      added(agent("sa", "completed")),
      added(msg("x1")),
      added(msg("m2")),
      added(agent("sb", "running", "sa")),
      added(msg("m4")),
      added(msg("b1", "sb")),
      added(msg("m6")),
      added({ id: "tc", type: "tool_call", name: "Bash", kind: "shell", input: {}, status: "pending", parent_id: "sa", turn_id: "t1" }),
      added(msg("m8")),
      added(msg("m9", undefined, "t2")),
      { type: "items.removed", item_ids: ["x0", "x1"], indices: [0, 3] },
      ...[
        permission("p-old", { tool_call_id: "m2" }),
        permission("p-sa", { tool_call_id: "tc", parent_id: "sa" }),
        permission("p-new", { tool_call_id: "m8" }),
        permission("p-turn", { turn_id: "t2" }),
        permission("p-none", { turn_id: "t9" }),
        permission("p-gone", { tool_call_id: "x1" }),
      ].map((request): NewEvent => ({ type: "request.opened", request })),
      ...["p-old", "p-new", "p-turn", "p-none", "p-gone"].map((request_id): NewEvent => ({
        type: "request.resolved",
        request_id,
        resolution: { outcome: "cancel" },
      })),
    ];
  }

  test("are the snapshot's, for every limit", () => {
    const { c, task, thread } = setup();
    store.append(c, task, events());
    const whole = store.snapshot(c, thread);
    assert.deepEqual(ids(whole.items), ["m0", "sa", "m2", "sb", "m4", "b1", "m6", "tc", "m8", "m9"]);
    assert.deepEqual(whole, apply_events(initial_state(thread), store.events_after(c, task, 0)!));
    for (let limit = 0; limit <= whole.items.length + 1; limit++)
      assert.deepEqual(store.window(c, thread, limit), snapshot_window(whole, limit), `limit ${limit}`);
    assert.deepEqual(store.window(c, thread), whole);
    assert.deepEqual(store.window(c, thread, 2.5), snapshot_window(whole, 2.5));
    // sb is running: a window after it brings it, and sa (and tc, for the open p-sa).
    assert.deepEqual(store.window(c, thread, 1).context, [1, 3, 7]);
    // Ended, and p-sa answered: both subagents' calls still come (HA-218: the app's Agents list shows every one).
    store.append(c, task, [
      { type: "item.updated", item_id: "sb", patch: { status: "completed" } },
      { type: "request.resolved", request_id: "p-sa", resolution: { outcome: "allow" } },
    ]);
    const done = store.snapshot(c, thread);
    assert.deepEqual(store.window(c, thread, 1), snapshot_window(done, 1));
    assert.deepEqual(store.window(c, thread, 1).context, [1, 3]);
  });

  test("pages are the snapshot's, for every place and size", () => {
    const { c, task, thread } = setup();
    store.append(c, task, events());
    const whole = store.snapshot(c, thread);
    for (let before = -1; before <= whole.items.length + 1; before++) {
      for (let limit = 0; limit <= whole.items.length + 1; limit++) {
        assert.deepEqual(store.page(c, task, before, limit), item_page(whole, before, limit), `before ${before}, limit ${limit}`);
      }
    }
  });

  test("of a thread with no items are empty", () => {
    const { c, task, thread } = setup();
    assert.deepEqual(store.window(c, thread, 5), { thread, items: [], requests: [], seq: 0 });
    assert.deepEqual(store.page(c, task, 5, 5), { thread_id: task, items: [], requests: [], start: 0, context: [], seq: 0 });
  });
});
