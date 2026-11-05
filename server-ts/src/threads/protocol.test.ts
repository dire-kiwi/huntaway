// The reducer's and windows' cases, from agent-threads' ts/packages/protocol/src/reducer.test.ts and window.test.ts (main
// 5ad670a), and its spec/examples (see examples.ts).
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { read_json, read_jsonl } from "./examples.ts";
import {
  apply_event, apply_events, initial_state, is_gap, item_page, open_requests, request_anchor, snapshot_window, with_page,
  type AssistantMessage, type Command, type Item, type ItemPage, type Snapshot, type Thread, type ThreadEvent, type ThreadRequest, type ToolCall,
} from "./protocol.ts";

const ids = (list: { id: string }[]) => list.map((x) => x.id);

describe("apply_event", () => {
  const thread: Thread = { id: "th", harness: "claude", status: "idle", created_at: "2026-11-01T00:00:00Z" };
  const user: Item = { id: "u1", type: "user_message", text: "hi" };
  const call: ToolCall = { id: "tc1", type: "tool_call", name: "Bash", kind: "shell", input: { command: "ls" }, status: "pending" };
  const reply: AssistantMessage = { id: "a1", type: "assistant_message", text: "" };

  /** A state with user, call and reply in it, at seq 3. */
  function started(): Snapshot {
    let seq = 0;
    return apply_events(
      initial_state(thread),
      [user, call, reply].map((item): ThreadEvent => ({ type: "item.added", thread_id: "th", seq: ++seq, item })),
    );
  }

  test("adds items to the end, keeping the others", () => {
    const s = started();
    assert.deepEqual(s.items, [user, call, reply]);
    assert.equal(s.seq, 3);
    const next = apply_event(s, { type: "item.added", thread_id: "th", seq: 4, item: { id: "n1", type: "notice", level: "info", text: "x" } });
    assert.equal(next.items.length, 4);
    assert.ok(next.items.slice(0, 3).every((item, i) => item === s.items[i]));
    assert.equal(next.thread, s.thread);
    assert.equal(next.requests, s.requests);
    assert.equal(s.items.length, 3);
  });

  test("replaces an added item that has the id of one it has, in place", () => {
    const s = started();
    const again = { ...call, status: "running" as const };
    const next = apply_event(s, { type: "item.added", thread_id: "th", seq: 4, item: again });
    assert.deepEqual(next.items, [user, again, reply]);
    assert.equal(next.items[0], s.items[0]);
  });

  test("patches an item: sets fields, removes nulls, leaves id and type", () => {
    const s = apply_event(started(), {
      type: "item.updated",
      thread_id: "th",
      seq: 4,
      item_id: "tc1",
      patch: { status: "completed", result: { content: "a\nb" }, command: "ls", id: "other", type: "notice" },
    });
    assert.deepEqual(s.items[1], { ...call, status: "completed", result: { content: "a\nb" }, command: "ls" });
    const next = apply_event(s, { type: "item.updated", thread_id: "th", seq: 5, item_id: "tc1", patch: { command: null } });
    assert.ok(!("command" in next.items[1]!));
    assert.equal(next.items[0], s.items[0]);
    assert.equal(next.items[2], s.items[2]);
    assert.equal((s.items[1] as ToolCall).command, "ls");
  });

  test("keeps an item a patch doesn't change", () => {
    const s = started();
    const next = apply_event(s, { type: "item.updated", thread_id: "th", seq: 4, item_id: "tc1", patch: { status: "pending", title: null } });
    assert.equal(next.items, s.items);
    assert.equal(next.seq, 4);
  });

  test("removes items, keeping the others and skipping ids it doesn't have", () => {
    const s = started();
    const next = apply_event(s, { type: "items.removed", thread_id: "th", seq: 4, item_ids: ["tc1", "nope"], indices: [1, 3] });
    assert.deepEqual(next.items, [user, reply]);
    assert.equal(next.items[0], s.items[0]);
    assert.equal(next.seq, 4);
    const none = apply_event(next, { type: "items.removed", thread_id: "th", seq: 5, item_ids: ["nope"], indices: [3] });
    assert.equal(none.items, next.items);
    assert.equal(none.seq, 5);
  });

  test("moves a window's start and context down by the removed items before them", () => {
    const item = (id: string, parent_id?: string): Item => ({ id, type: "assistant_message", text: id, ...(parent_id ? { parent_id } : {}) });
    // The thread is a0..a9, with a2 a subagent call a8 belongs to; the window is from 7, with a2 as context.
    const call: Item = { id: "a2", type: "tool_call", name: "Agent", kind: "subagent", input: {}, status: "running" };
    const w: Snapshot = { thread, items: [call, item("a7"), item("a8", "a2"), item("a9")], requests: [], seq: 5, start: 7, context: [2] };
    const next = apply_event(w, { type: "items.removed", thread_id: "th", seq: 6, item_ids: ["a1", "a5", "a6", "a9"], indices: [1, 5, 6, 9] });
    assert.deepEqual([next.start, next.context, next.seq], [4, [1], 6]);
    assert.deepEqual(ids(next.items), ["a2", "a7", "a8"]);
    // Its context item removed too, and everything before it: it starts at 0, with no context.
    const all = apply_event(w, {
      type: "items.removed",
      thread_id: "th",
      seq: 6,
      item_ids: ["a0", "a1", "a2", "a3", "a4", "a5", "a6"],
      indices: [0, 1, 2, 3, 4, 5, 6],
    });
    assert.equal(all.start, 0);
    assert.ok(!("context" in all));
    assert.deepEqual(ids(all.items), ["a7", "a8", "a9"]);
  });

  test("counts an update to an item it doesn't have", () => {
    const s = started();
    const next = apply_event(s, { type: "item.updated", thread_id: "th", seq: 4, item_id: "nope", patch: { text: "x" } });
    assert.equal(next.items, s.items);
    assert.equal(next.seq, 4);
  });

  /** A text delta to a1 at seq 3. */
  const delta = (text: string, offset: number, item_id = "a1", seq = 3): ThreadEvent => ({ type: "delta", thread_id: "th", seq, item_id, kind: "text", offset, text });

  test("appends deltas to text without counting them", () => {
    const s = started();
    const next = apply_events(s, [delta("Hel", 0), delta("lo", 3)]);
    assert.deepEqual(next.items[2], { ...reply, text: "Hello" });
    assert.equal(next.items[0], s.items[0]);
    assert.equal(next.items[1], s.items[1]);
    assert.equal(next.seq, 3);
    // Not for items it doesn't have, items without text, or from before the state's last saved event.
    assert.equal(apply_event(s, delta("x", 0, "nope")), s);
    assert.equal(apply_event(s, delta("x", 0, "tc1")), s);
    assert.equal(apply_event(s, delta("x", 0, "a1", 2)), s);
    // One from after it (the state missed saved events) still applies.
    assert.deepEqual(apply_event(s, delta("x", 0, "a1", 9)).items[2], { ...reply, text: "x" });
  });

  test("appends reasoning deltas", () => {
    const s = apply_event(initial_state(thread), { type: "item.added", thread_id: "th", seq: 1, item: { id: "r1", type: "reasoning", text: "a" } });
    const next = apply_event(s, { type: "delta", thread_id: "th", seq: 1, item_id: "r1", kind: "reasoning", offset: 1, text: "b" });
    assert.equal((next.items[0] as { text: string }).text, "ab");
  });

  test("skips what of a delta the state already has", () => {
    // A snapshot taken after "Hel" and "lo" were sent has them in, and they come again after it.
    const s = apply_events(started(), [delta("Hel", 0), delta("lo", 3)]);
    assert.equal(apply_event(s, delta("Hel", 0)), s);
    assert.equal(apply_event(s, delta("lo", 3)), s);
    assert.equal(apply_event(s, delta("el", 1)), s);
    // Part of it in already: the rest is appended.
    assert.deepEqual(apply_event(s, delta("lo, world", 3)).items[2], { ...reply, text: "Hello, world" });
    assert.deepEqual(apply_events(s, [delta("Hel", 0), delta("lo", 3), delta(", world", 5)]).items[2], { ...reply, text: "Hello, world" });
  });

  test("skips a delta past the end of the text", () => {
    // Deltas were missed: the item's final text puts it right.
    const s = apply_event(started(), delta("Hel", 0));
    assert.equal(apply_event(s, delta("p", 5)), s);
  });

  test("ignores a delta whose kind isn't its item's", () => {
    const s = apply_event(started(), { type: "item.added", thread_id: "th", seq: 4, item: { id: "r1", type: "reasoning", text: "" } });
    assert.equal(apply_event(s, { type: "delta", thread_id: "th", seq: 4, item_id: "a1", kind: "reasoning", offset: 0, text: "x" }), s);
    assert.equal(apply_event(s, { type: "delta", thread_id: "th", seq: 4, item_id: "r1", kind: "text", offset: 0, text: "x" }), s);
  });

  test("returns the state itself for an empty delta", () => {
    const s = started();
    assert.equal(apply_event(s, delta("", 0)), s);
  });

  test("opens and resolves requests", () => {
    const s = started();
    const open = apply_events(s, [
      { type: "request.opened", thread_id: "th", seq: 4, request: { id: "p1", type: "permission", name: "Bash", kind: "shell", input: {} } },
      { type: "request.opened", thread_id: "th", seq: 5, request: { id: "q1", type: "question", questions: [{ id: "a", question: "?" }] } },
    ]);
    assert.deepEqual(ids(open.requests), ["p1", "q1"]);
    assert.equal(open.items, s.items);
    assert.deepEqual(open_requests(open), open.requests);
    const resolved = apply_event(open, { type: "request.resolved", thread_id: "th", seq: 6, request_id: "p1", resolution: { outcome: "allow" } });
    // It stays where it was, with its resolution.
    assert.deepEqual(resolved.requests, [{ ...open.requests[0]!, resolution: { outcome: "allow" } }, open.requests[1]]);
    assert.equal(resolved.requests[1], open.requests[1]);
    assert.ok(!("resolution" in open.requests[0]!));
    assert.deepEqual(open_requests(resolved), [open.requests[1]]);
    const again = apply_event(resolved, { type: "request.resolved", thread_id: "th", seq: 7, request_id: "p1", resolution: { outcome: "deny" } });
    assert.deepEqual(again.requests[0]!.resolution, { outcome: "deny" });
    const unknown = apply_event(again, { type: "request.resolved", thread_id: "th", seq: 8, request_id: "nope", resolution: { outcome: "allow" } });
    assert.equal(unknown.requests, again.requests);
    assert.equal(unknown.seq, 8);
    // Opened again with its id, it's replaced in place, and open again.
    const reopened = apply_event(unknown, { type: "request.opened", thread_id: "th", seq: 9, request: open.requests[0]! });
    assert.deepEqual(ids(reopened.requests), ["p1", "q1"]);
    assert.equal(open_requests(reopened).length, 2);
  });

  test("replaces the thread", () => {
    const s = started();
    const running: Thread = { ...thread, status: "running", session_id: "s1" };
    const next = apply_event(s, { type: "thread.updated", thread_id: "th", seq: 4, thread: running });
    assert.equal(next.thread, running);
    assert.equal(next.items, s.items);
  });

  test("counts turn events", () => {
    const s = started();
    const next = apply_event(s, { type: "turn.started", thread_id: "th", seq: 4, turn_id: "t1" });
    assert.deepEqual(next, { ...s, seq: 4 });
    assert.equal(next.items, s.items);
  });

  test("ignores events it already has, and other threads' events", () => {
    const s = started();
    assert.equal(apply_event(s, { type: "item.added", thread_id: "th", seq: 3, item: { ...reply, text: "again" } }), s);
    assert.equal(apply_event(s, { type: "item.added", thread_id: "th", seq: 1, item: user }), s);
    assert.equal(apply_event(s, { type: "item.added", thread_id: "other", seq: 4, item: user }), s);
    assert.equal(apply_event(s, { type: "delta", thread_id: "other", seq: 3, item_id: "a1", kind: "text", offset: 0, text: "x" }), s);
  });

  test("counts event types it doesn't know", () => {
    const s = started();
    const next = apply_event(s, { type: "turn.paused", thread_id: "th", seq: 4 } as unknown as ThreadEvent);
    assert.deepEqual(next, { ...s, seq: 4 });
  });

  test("is_gap is true for a saved event more than one past the state", () => {
    const s = started();
    assert.equal(is_gap(s, { type: "turn.started", thread_id: "th", seq: 4, turn_id: "t" }), false);
    assert.equal(is_gap(s, { type: "turn.started", thread_id: "th", seq: 3, turn_id: "t" }), false);
    assert.equal(is_gap(s, { type: "turn.started", thread_id: "th", seq: 5, turn_id: "t" }), true);
    assert.equal(is_gap(s, { type: "delta", thread_id: "th", seq: 5, item_id: "a1", kind: "text", offset: 0, text: "" }), false);
    assert.equal(is_gap(s, { type: "turn.started", thread_id: "other", seq: 9, turn_id: "t" }), false);
  });
});

describe("windows", () => {
  const thread: Thread = { id: "th", harness: "claude", status: "waiting", created_at: "2026-11-01T00:00:00Z" };
  const msg = (id: string, parent_id?: string, turn_id = "t1"): Item => ({ id, type: "assistant_message", text: id, turn_id, ...(parent_id ? { parent_id } : {}) });
  const agent = (id: string, parent_id?: string): Item => ({
    id,
    type: "tool_call",
    name: "Agent",
    kind: "subagent",
    input: {},
    status: "completed",
    turn_id: "t1",
    ...(parent_id ? { parent_id } : {}),
  });
  const permission = (id: string, extra: Partial<ThreadRequest> = {}): ThreadRequest =>
    ({ id, type: "permission", name: "Bash", kind: "shell", input: {}, turn_id: "t1", ...extra }) as ThreadRequest;

  /**
   * 0 m0, 1 sa (a subagent), 2 m2, 3 sb (sa's subagent), 4 m4, 5 b1 (sb's), 6 m6, 7 tc (sa's call), 8 m8, 9 m9 (turn
   * t2); requests: p-old answered at m2, p-sa open from sa for tc, p-new answered at m8, p-turn answered with no call
   * (turn t2: anchored at m9), p-none answered with neither.
   */
  function state(): Snapshot {
    const items: Item[] = [
      msg("m0"),
      agent("sa"),
      msg("m2"),
      agent("sb", "sa"),
      msg("m4"),
      msg("b1", "sb"),
      msg("m6"),
      { id: "tc", type: "tool_call", name: "Bash", kind: "shell", input: {}, status: "pending", parent_id: "sa", turn_id: "t1" },
      msg("m8"),
      msg("m9", undefined, "t2"),
    ];
    const requests = [
      permission("p-old", { tool_call_id: "m2", resolution: { outcome: "allow" } }),
      permission("p-sa", { tool_call_id: "tc", parent_id: "sa" }),
      permission("p-new", { tool_call_id: "m8", resolution: { outcome: "deny" } }),
      permission("p-turn", { turn_id: "t2", resolution: { outcome: "cancel" } }),
      permission("p-none", { turn_id: "t9", resolution: { outcome: "cancel" } }),
    ];
    return { thread, items, requests, seq: 20 };
  }

  test("a window is the state itself without a limit, or with one it's within", () => {
    const s = state();
    assert.equal(snapshot_window(s), s);
    assert.equal(snapshot_window(s, 10), s);
    assert.equal(snapshot_window(s, 50), s);
  });

  test("a window has the last items, the parents they and open requests need, and the requests anchored in it", () => {
    const w = snapshot_window(state(), 2);
    assert.equal(w.start, 8);
    // p-sa is open: its call (tc) and its subagent (sa) come too.
    assert.deepEqual(w.context, [1, 7]);
    assert.deepEqual(ids(w.items), ["sa", "tc", "m8", "m9"]);
    assert.deepEqual(ids(w.requests), ["p-sa", "p-new", "p-turn", "p-none"]);
    assert.equal(w.seq, 20);
    assert.deepEqual(w.thread, state().thread);
  });

  test("a window brings the subagents its items belong to, however nested", () => {
    const w = snapshot_window({ ...state(), requests: [] }, 5);
    assert.equal(w.start, 5);
    assert.deepEqual(w.context, [1, 3]);
    assert.deepEqual(ids(w.items), ["sa", "sb", "b1", "m6", "tc", "m8", "m9"]);
  });

  test("a window brings the subagents still running, with theirs, for the items they'll go on to add", () => {
    // sb (sa's) is running but quiet: none of its items, nor a request of its, is in the window.
    const s = state();
    const quiet = { ...s, items: s.items.map((i) => (i.id === "sb" ? { ...i, status: "running" as const } : i)) as Item[], requests: [] };
    const w = snapshot_window(quiet, 2);
    assert.deepEqual(w.context, [1, 3]);
    assert.deepEqual(ids(w.items), ["sa", "sb", "m8", "m9"]);
    // It goes on: its new item has its call to belong to.
    const next = apply_event(w, { type: "item.added", thread_id: "th", seq: 21, item: msg("b10", "sb") });
    assert.equal((next.items.find((i) => i.id === "sb") as ToolCall).status, "running");
    // Pending counts as running; one that's ended doesn't.
    const with_sb = (change: object) => ({ ...quiet, items: quiet.items.map((i) => (i.id === "sb" ? { ...i, ...change } : i)) as Item[] });
    assert.deepEqual(snapshot_window(with_sb({ status: "pending" }), 2).context, [1, 3]);
    assert.ok(!("context" in snapshot_window(with_sb({ status: "cancelled" }), 2)));
    // Where the call has its subagent's own status, that says: a background subagent runs on after its call has
    // completed, and one that ended with its call still running doesn't.
    const sub = (status: "running" | "completed") => with_sb({ status: "completed", subagent: { status, background: true } });
    assert.deepEqual(snapshot_window(sub("running"), 2).context, [1, 3]);
    assert.ok(!("context" in snapshot_window(sub("completed"), 2)));
  });

  test("a window leaves context out when it needs nothing from before it", () => {
    const w = snapshot_window({ ...state(), requests: [] }, 1);
    assert.deepEqual(w, { thread, items: [msg("m9", undefined, "t2")], requests: [], seq: 20, start: 9 });
  });

  test("a page has the items before an index, the parents they need, and the requests anchored in them", () => {
    const p = item_page(state(), 6, 2);
    assert.deepEqual([p.thread_id, p.start, p.context, p.seq], ["th", 4, [1, 3], 20]);
    assert.deepEqual(ids(p.items), ["sa", "sb", "m4", "b1"]);
    assert.deepEqual(p.requests, []);
    const q = item_page(state(), 4, 4);
    assert.equal(q.start, 0);
    assert.deepEqual(q.context, []);
    assert.deepEqual(ids(q.items), ["m0", "sa", "m2", "sb"]);
    assert.deepEqual(ids(q.requests), ["p-old"]);
  });

  test("a page keeps within the list", () => {
    assert.equal(item_page(state(), 50, 1).start, 9);
    const p = item_page(state(), -3, 5);
    assert.deepEqual([p.start, p.items, p.context], [0, [], []]);
  });

  test("with_page puts pages in front of a window until it's whole", () => {
    const whole = state();
    let w = snapshot_window(whole, 2);
    for (const limit of [3, 2]) {
      const page = item_page(whole, w.start!, limit);
      w = with_page(w, page);
      // The same as a window that had that many to begin with.
      assert.deepEqual(w, snapshot_window(whole, whole.items.length - page.start));
    }
    assert.equal(w.start, 3);
    w = with_page(w, item_page(whole, 3, 10));
    assert.deepEqual(w, whole);
    assert.ok(!("start" in w));
    assert.ok(!("context" in w));
  });

  test("with_page orders the context of both by index", () => {
    // A window whose context is sa (1); a page from 4 whose context is sa and sb (1, 3).
    const whole = state();
    const w = snapshot_window({ ...whole, requests: [] }, 4);
    assert.deepEqual(w.context, [1]);
    const next = with_page(w, item_page(whole, 6, 2));
    assert.equal(next.start, 4);
    assert.deepEqual(next.context, [1, 3]);
    assert.deepEqual(ids(next.items), ["sa", "sb", "m4", "b1", "m6", "tc", "m8", "m9"]);
  });

  test("with_page takes the page's version of an item or request it has", () => {
    const whole = state();
    const w = snapshot_window(whole, 2);
    const later = apply_event(whole, { type: "item.updated", thread_id: "th", seq: 21, item_id: "sa", patch: { status: "failed" } });
    const next = with_page(w, item_page(later, 8, 1));
    assert.deepEqual([next.items[0]!.id, (next.items[0] as ToolCall).status], ["sa", "failed"]);
    assert.equal(next.seq, 20);
  });

  test("with_page ignores a page for another thread, or that doesn't end at its start", () => {
    const whole = state();
    const w = snapshot_window(whole, 2);
    assert.equal(with_page(w, item_page(whole, 7, 2)), w);
    assert.equal(with_page(w, { ...item_page(whole, 8, 2), thread_id: "other" }), w);
    assert.equal(with_page(whole, item_page(whole, 0, 2)), whole);
  });

  test("a window takes events as any state does", () => {
    const w = snapshot_window(state(), 2);
    const next = apply_event(w, { type: "item.added", thread_id: "th", seq: 21, item: msg("m10") });
    assert.equal(next.start, 8);
    assert.deepEqual(next.context, [1, 7]);
    assert.equal(ids(next.items).at(-1), "m10");
    // An update to an item it doesn't have only advances seq.
    const gone = apply_event(next, { type: "item.updated", thread_id: "th", seq: 22, item_id: "m0", patch: { text: "x" } });
    assert.equal(gone.items, next.items);
    assert.equal(gone.seq, 22);
  });

  test("a request's anchor is its tool call, else the last item of its turn, else -1", () => {
    const s = state();
    assert.deepEqual(
      s.requests.map((r) => request_anchor(s.items, r)),
      [2, 7, 8, 9, -1],
    );
  });
});

describe("spec/examples", () => {
  const events = read_jsonl("thread.events.jsonl") as ThreadEvent[];
  const first = events[0] as Extract<ThreadEvent, { type: "thread.updated" }>;
  const whole = read_json("thread.snapshot.json") as Snapshot;

  test("the thread's events fold into thread.snapshot.json", () => {
    assert.deepEqual(apply_events(initial_state(first.thread), events), whole);
  });

  test("they fold the same with every event delivered twice", () => {
    const twice = events.flatMap((e): ThreadEvent[] => [e, e]);
    assert.deepEqual(apply_events(initial_state(first.thread), twice), whole);
  });

  test("their seqs go up by one, and a delta's is the last saved event's", () => {
    let seq = 0;
    for (const e of events) {
      if (e.type === "delta") assert.equal(e.seq, seq);
      else assert.equal(e.seq, ++seq);
    }
  });

  test("thread.window.json is the snapshot's window of 8", () => assert.deepEqual(snapshot_window(whole, 8), read_json("thread.window.json")));
  test("thread.page.json is its page of 3 before 5", () => assert.deepEqual(item_page(whole, 5, 3), read_json("thread.page.json") as ItemPage));
  test("the window with the page is the window of 11", () => {
    assert.deepEqual(with_page(read_json("thread.window.json"), read_json("thread.page.json")), snapshot_window(whole, 11));
  });

  test("commands.jsonl has one of each command", () => {
    const commands = read_jsonl("commands.jsonl") as Command[];
    const types: Command["type"][] = ["send", "interrupt", "respond", "set_options", "rewind", "new_session", "compact"];
    assert.deepEqual([...new Set(commands.map((c) => c.type))].sort(), types.sort());
  });
});
