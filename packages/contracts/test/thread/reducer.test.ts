import { describe, expect, it } from "vite-plus/test"
import { TaskId } from "../../src/ids.ts"
import type { ThreadEvent, UnknownEvent } from "../../src/thread/Event.ts"
import type { AssistantMessage, Item, ToolCall } from "../../src/thread/Item.ts"
import { type AnyThreadEvent, applyEvent, applyEvents, initialState, isGap, openRequests, patched } from "../../src/thread/reducer.ts"
import type { ThreadRequest } from "../../src/thread/Request.ts"
import type { Snapshot } from "../../src/thread/Snapshot.ts"
import type { Thread } from "../../src/thread/Thread.ts"
import { snapshotWindow } from "../../src/thread/window.ts"
import { Timestamp } from "../../src/time.ts"

// The old threads/protocol.test.ts's `apply_event` cases (agent-threads' reducer tests), and the web's
// tests/threads.test.ts. Dropped with what the port leaves out (docs/plan/03-domain.md, The thread protocol):
// `items.removed` (removing items, and a window's start and context moving down with them) and `thread.updated`
// (replacing the thread) are no longer declared, so they are counted as unknown events, which "counts event types it
// does not know" covers.

const th = TaskId.make("th")
const thread: Thread = { id: th, harness: "claude", status: "idle", created_at: Timestamp.make("2026-11-01T00:00:00Z") }
const user: Item = { id: "u1", type: "user_message", text: "hi" }
const call: ToolCall = { id: "tc1", type: "tool_call", name: "Bash", kind: "shell", input: { command: "ls" }, status: "pending" }
const reply: AssistantMessage = { id: "a1", type: "assistant_message", text: "" }

const added = (seq: number, item: Item, thread_id = th): ThreadEvent => ({ type: "item.added", thread_id, seq, item })
const unknown = (type: string, seq: number, thread_id = th): UnknownEvent => ({ type, thread_id, seq })

/** A state with user, call and reply in it, at seq 3. */
const started = (): Snapshot =>
  applyEvents(
    initialState(thread),
    [user, call, reply].map((item, i) => added(i + 1, item)),
  )

/** A text delta to a1 at seq 3. */
const delta = (text: string, offset: number, item_id = "a1", seq = 3): ThreadEvent => ({
  type: "delta",
  thread_id: th,
  seq,
  item_id,
  kind: "text",
  offset,
  text,
})

const ids = (list: ReadonlyArray<{ readonly id: string }>) => list.map((x) => x.id)

describe("applyEvent", () => {
  it("adds items to the end, keeping the others", () => {
    const s = started()
    expect(s.items).toStrictEqual([user, call, reply])
    expect(s.seq).toBe(3)
    const next = applyEvent(s, added(4, { id: "n1", type: "notice", level: "info", text: "x" }))
    expect(next.items.length).toBe(4)
    expect(next.items.slice(0, 3).every((item, i) => item === s.items[i])).toBe(true)
    expect(next.thread).toBe(s.thread)
    expect(next.requests).toBe(s.requests)
    expect(s.items.length).toBe(3)
  })

  it("replaces an added item that has the id of one it has, in place", () => {
    const s = started()
    const again: ToolCall = { ...call, status: "running" }
    const next = applyEvent(s, added(4, again))
    expect(next.items).toStrictEqual([user, again, reply])
    expect(next.items[0]).toBe(s.items[0])
  })

  it("patches an item: sets fields, removes nulls, leaves id and type", () => {
    const s = applyEvent(started(), {
      type: "item.updated",
      thread_id: th,
      seq: 4,
      item_id: "tc1",
      patch: { status: "completed", result: { content: "a\nb" }, command: "ls", id: "other", type: "notice" },
    })
    expect(s.items[1]).toStrictEqual({ ...call, status: "completed", result: { content: "a\nb" }, command: "ls" })
    const next = applyEvent(s, { type: "item.updated", thread_id: th, seq: 5, item_id: "tc1", patch: { command: null } })
    expect(next.items[1] !== undefined && "command" in next.items[1]).toBe(false)
    expect(next.items[0]).toBe(s.items[0])
    expect(next.items[2]).toBe(s.items[2])
    expect(s.items[1]).toHaveProperty("command", "ls")
  })

  it("keeps an item a patch doesn't change", () => {
    const s = started()
    const next = applyEvent(s, { type: "item.updated", thread_id: th, seq: 4, item_id: "tc1", patch: { status: "pending", title: null } })
    expect(next.items).toBe(s.items)
    expect(next.seq).toBe(4)
    expect(patched(call, { status: "pending", title: null, id: "x" })).toBe(call)
  })

  it("counts an update to an item it doesn't have", () => {
    const s = started()
    const next = applyEvent(s, { type: "item.updated", thread_id: th, seq: 4, item_id: "nope", patch: { text: "x" } })
    expect(next.items).toBe(s.items)
    expect(next.seq).toBe(4)
  })

  it("appends deltas to text without counting them", () => {
    const s = started()
    const next = applyEvents(s, [delta("Hel", 0), delta("lo", 3)])
    expect(next.items[2]).toStrictEqual({ ...reply, text: "Hello" })
    expect(next.items[0]).toBe(s.items[0])
    expect(next.items[1]).toBe(s.items[1])
    expect(next.seq).toBe(3)
    // Not for items it doesn't have, items without text, or from before the state's last saved event.
    expect(applyEvent(s, delta("x", 0, "nope"))).toBe(s)
    expect(applyEvent(s, delta("x", 0, "tc1"))).toBe(s)
    expect(applyEvent(s, delta("x", 0, "a1", 2))).toBe(s)
    // One from after it (the state missed saved events) still applies.
    expect(applyEvent(s, delta("x", 0, "a1", 9)).items[2]).toStrictEqual({ ...reply, text: "x" })
  })

  it("appends reasoning deltas", () => {
    const s = applyEvent(initialState(thread), added(1, { id: "r1", type: "reasoning", text: "a" }))
    const next = applyEvent(s, { type: "delta", thread_id: th, seq: 1, item_id: "r1", kind: "reasoning", offset: 1, text: "b" })
    expect(next.items[0]).toHaveProperty("text", "ab")
  })

  it("skips what of a delta the state already has", () => {
    // A snapshot taken after "Hel" and "lo" were sent has them in, and they come again after it.
    const s = applyEvents(started(), [delta("Hel", 0), delta("lo", 3)])
    expect(applyEvent(s, delta("Hel", 0))).toBe(s)
    expect(applyEvent(s, delta("lo", 3))).toBe(s)
    expect(applyEvent(s, delta("el", 1))).toBe(s)
    // Part of it in already: the rest is appended.
    expect(applyEvent(s, delta("lo, world", 3)).items[2]).toStrictEqual({ ...reply, text: "Hello, world" })
    expect(applyEvents(s, [delta("Hel", 0), delta("lo", 3), delta(", world", 5)]).items[2]).toStrictEqual({ ...reply, text: "Hello, world" })
  })

  it("skips a delta past the end of the text", () => {
    // Deltas were missed: the item's final text puts it right.
    const s = applyEvent(started(), delta("Hel", 0))
    expect(applyEvent(s, delta("p", 5))).toBe(s)
  })

  it("ignores a delta whose kind isn't its item's", () => {
    const s = applyEvent(started(), added(4, { id: "r1", type: "reasoning", text: "" }))
    expect(applyEvent(s, { type: "delta", thread_id: th, seq: 4, item_id: "a1", kind: "reasoning", offset: 0, text: "x" })).toBe(s)
    expect(applyEvent(s, { type: "delta", thread_id: th, seq: 4, item_id: "r1", kind: "text", offset: 0, text: "x" })).toBe(s)
  })

  it("returns the state itself for an empty delta", () => {
    const s = started()
    expect(applyEvent(s, delta("", 0))).toBe(s)
  })

  it("opens and resolves requests", () => {
    const s = started()
    const p1: ThreadRequest = { id: "p1", type: "permission", name: "Bash", kind: "shell", input: {} }
    const open = applyEvents(s, [
      { type: "request.opened", thread_id: th, seq: 4, request: p1 },
      { type: "request.opened", thread_id: th, seq: 5, request: { id: "q1", type: "question", questions: [{ id: "a", question: "?" }] } },
    ])
    expect(ids(open.requests)).toStrictEqual(["p1", "q1"])
    expect(open.items).toBe(s.items)
    expect(openRequests(open)).toStrictEqual(open.requests)
    const resolved = applyEvent(open, { type: "request.resolved", thread_id: th, seq: 6, request_id: "p1", resolution: { outcome: "allow" } })
    // It stays where it was, with its resolution.
    expect(resolved.requests).toStrictEqual([{ ...open.requests[0], resolution: { outcome: "allow" } }, open.requests[1]])
    expect(resolved.requests[1]).toBe(open.requests[1])
    expect(open.requests[0]).not.toHaveProperty("resolution")
    expect(openRequests(resolved)).toStrictEqual([open.requests[1]])
    const again = applyEvent(resolved, { type: "request.resolved", thread_id: th, seq: 7, request_id: "p1", resolution: { outcome: "deny" } })
    expect(again.requests[0]?.resolution).toStrictEqual({ outcome: "deny" })
    const missing = applyEvent(again, { type: "request.resolved", thread_id: th, seq: 8, request_id: "nope", resolution: { outcome: "allow" } })
    expect(missing.requests).toBe(again.requests)
    expect(missing.seq).toBe(8)
    // Opened again with its id, it is replaced in place, and open again.
    const reopened = applyEvent(missing, { type: "request.opened", thread_id: th, seq: 9, request: p1 })
    expect(ids(reopened.requests)).toStrictEqual(["p1", "q1"])
    expect(openRequests(reopened).length).toBe(2)
  })

  it("ignores events it already has, and other threads' events", () => {
    const s = started()
    const other = TaskId.make("other")
    expect(applyEvent(s, added(3, { ...reply, text: "again" }))).toBe(s)
    expect(applyEvent(s, added(1, user))).toBe(s)
    expect(applyEvent(s, added(4, user, other))).toBe(s)
    expect(applyEvent(s, { type: "delta", thread_id: other, seq: 3, item_id: "a1", kind: "text", offset: 0, text: "x" })).toBe(s)
    expect(applyEvent(s, unknown("turn.paused", 4, other))).toBe(s)
  })

  it("counts event types it doesn't know", () => {
    // A newer host's, and the old protocol's that are no longer declared.
    for (const type of ["turn.paused", "turn.started", "thread.updated", "items.removed"]) {
      const s = started()
      const next = applyEvent(s, unknown(type, 4))
      expect(next).toStrictEqual({ ...s, seq: 4 })
      expect(next.items).toBe(s.items)
      expect(applyEvent(next, unknown(type, 4))).toBe(next)
    }
  })

  it("counts an event of a known type it can't read, and applies nothing of it", () => {
    // An item of a newer host's type: the stream decodes the event as an unknown one.
    const s = started()
    const newer: AnyThreadEvent = { type: "item.added", thread_id: th, seq: 4 }
    expect(applyEvent(s, newer)).toStrictEqual({ ...s, seq: 4 })
  })

  it("isGap is true for a saved event more than one past the state", () => {
    const s = started()
    expect(isGap(s, unknown("turn.started", 4))).toBe(false)
    expect(isGap(s, added(3, user))).toBe(false)
    expect(isGap(s, added(5, user))).toBe(true)
    expect(isGap(s, unknown("turn.started", 5))).toBe(true)
    expect(isGap(s, delta("", 0, "a1", 5))).toBe(false)
    expect(isGap(s, unknown("turn.started", 9, TaskId.make("other")))).toBe(false)
  })

  // The web's tests/threads.test.ts (HA-212: the app folds with the server's reducer).
  it("folds a thread's events, deltas included, and windows them", () => {
    const s = applyEvents(initialState(thread), [
      added(1, { id: "a1", type: "assistant_message", text: "" }),
      { type: "delta", thread_id: th, seq: 1, item_id: "a1", kind: "text", offset: 0, text: "Hello" },
      added(2, { id: "a2", type: "assistant_message", text: "Bye" }),
    ])
    expect(s.items.map((i) => ("text" in i ? i.text : null))).toStrictEqual(["Hello", "Bye"])
    expect(s.seq).toBe(2)
    expect(ids(snapshotWindow(s, 1).items)).toStrictEqual(["a2"])
  })
})
