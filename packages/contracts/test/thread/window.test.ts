import { describe, expect, it } from "vite-plus/test"
import { TaskId } from "../../src/ids.ts"
import type { Item, ToolStatus } from "../../src/thread/Item.ts"
import { applyEvent } from "../../src/thread/reducer.ts"
import type { RequestResolution, ThreadRequest } from "../../src/thread/Request.ts"
import type { Snapshot } from "../../src/thread/Snapshot.ts"
import type { Thread } from "../../src/thread/Thread.ts"
import { isRunningSubagent, isSubagent, itemPage, requestAnchor, snapshotWindow, withPage } from "../../src/thread/window.ts"
import { Timestamp } from "../../src/time.ts"

// The old threads/protocol.test.ts's `windows` cases (agent-threads' window tests). Requests are no longer anchored by
// `turn_id` (never produced): a resolved request with no tool call is anchored nowhere, so it is in every window and in
// no page, as one with neither was. Only "a request's anchor" changes for it (p-turn: 9 before, -1 now).

const th = TaskId.make("th")
const thread: Thread = { id: th, harness: "claude", status: "waiting", created_at: Timestamp.make("2026-11-01T00:00:00Z") }

const msg = (id: string, parent_id?: string): Item => ({ id, type: "assistant_message", text: id, ...(parent_id === undefined ? {} : { parent_id }) })
const agent = (id: string, parent_id?: string): Item => ({
  id,
  type: "tool_call",
  name: "Agent",
  kind: "subagent",
  input: {},
  status: "completed",
  ...(parent_id === undefined ? {} : { parent_id }),
})
const permission = (id: string, extra: { tool_call_id?: string; parent_id?: string; resolution?: RequestResolution } = {}): ThreadRequest => ({
  id,
  type: "permission",
  name: "Bash",
  kind: "shell",
  input: {},
  ...extra,
})

const ids = (list: ReadonlyArray<{ readonly id: string }>) => list.map((x) => x.id)

/**
 * 0 m0, 1 sa (a subagent), 2 m2, 3 sb (sa's subagent), 4 m4, 5 b1 (sb's), 6 m6, 7 tc (sa's call), 8 m8, 9 m9; requests:
 * p-old answered at m2, p-sa open from sa for tc, p-new answered at m8, p-turn and p-none answered with no call.
 */
const state = (): Snapshot => ({
  thread,
  items: [
    msg("m0"),
    agent("sa"),
    msg("m2"),
    agent("sb", "sa"),
    msg("m4"),
    msg("b1", "sb"),
    msg("m6"),
    { id: "tc", type: "tool_call", name: "Bash", kind: "shell", input: {}, status: "pending", parent_id: "sa" },
    msg("m8"),
    msg("m9"),
  ],
  requests: [
    permission("p-old", { tool_call_id: "m2", resolution: { outcome: "allow" } }),
    permission("p-sa", { tool_call_id: "tc", parent_id: "sa" }),
    permission("p-new", { tool_call_id: "m8", resolution: { outcome: "deny" } }),
    permission("p-turn", { resolution: { outcome: "cancel" } }),
    permission("p-none", { resolution: { outcome: "cancel" } }),
  ],
  seq: 20,
})

/** `s` with item `id` changed. */
const withChanged = (
  s: Snapshot,
  id: string,
  change: { status?: ToolStatus; subagent?: { status: "running" | "completed"; background: boolean } },
): Snapshot => ({
  ...s,
  items: s.items.map((i) => (i.id === id && i.type === "tool_call" ? { ...i, ...change } : i)),
})

describe("windows", () => {
  it("a window is the state itself without a limit, or with one it's within", () => {
    const s = state()
    expect(snapshotWindow(s)).toBe(s)
    expect(snapshotWindow(s, 10)).toBe(s)
    expect(snapshotWindow(s, 50)).toBe(s)
  })

  it("a window has the last items, the parents they and open requests need, and the requests anchored in it", () => {
    const w = snapshotWindow(state(), 2)
    expect(w.start).toBe(8)
    // p-sa is open: its call (tc) and its subagent (sa) come too, and so does every subagent's call (sb).
    expect(w.context).toStrictEqual([1, 3, 7])
    expect(ids(w.items)).toStrictEqual(["sa", "sb", "tc", "m8", "m9"])
    expect(ids(w.requests)).toStrictEqual(["p-sa", "p-new", "p-turn", "p-none"])
    expect(w.seq).toBe(20)
    expect(w.thread).toStrictEqual(state().thread)
  })

  it("a window brings the subagents its items belong to, however nested", () => {
    const w = snapshotWindow({ ...state(), requests: [] }, 5)
    expect(w.start).toBe(5)
    expect(w.context).toStrictEqual([1, 3])
    expect(ids(w.items)).toStrictEqual(["sa", "sb", "b1", "m6", "tc", "m8", "m9"])
  })

  it("a window brings every subagent's call, running or not, with theirs", () => {
    // sb (sa's) is running but quiet: none of its items, nor a request of its, is in the window.
    const quiet = withChanged({ ...state(), requests: [] }, "sb", { status: "running" })
    const w = snapshotWindow(quiet, 2)
    expect(w.context).toStrictEqual([1, 3])
    expect(ids(w.items)).toStrictEqual(["sa", "sb", "m8", "m9"])
    // It goes on: its new item has its call to belong to.
    const next = applyEvent(w, { type: "item.added", thread_id: th, seq: 21, item: msg("b10", "sb") })
    expect(next.items.find((i) => i.id === "sb")).toHaveProperty("status", "running")
    // One that has ended comes too (HA-218): a client lists every subagent of the thread, as the Agents list does.
    expect(snapshotWindow(withChanged(quiet, "sb", { status: "pending" }), 2).context).toStrictEqual([1, 3])
    expect(snapshotWindow(withChanged(quiet, "sb", { status: "cancelled" }), 2).context).toStrictEqual([1, 3])
    const sub = (status: "running" | "completed") => withChanged(quiet, "sb", { status: "completed", subagent: { status, background: true } })
    expect(snapshotWindow(sub("running"), 2).context).toStrictEqual([1, 3])
    expect(snapshotWindow(sub("completed"), 2).context).toStrictEqual([1, 3])
  })

  it("a window leaves context out when it needs nothing from before it", () => {
    // No subagent calls, nor items of theirs.
    const s = state()
    const w = snapshotWindow({ ...s, items: s.items.filter((i) => i.type !== "tool_call" && i.parent_id === undefined), requests: [] }, 1)
    expect(w).toStrictEqual({ thread, items: [msg("m9")], requests: [], seq: 20, start: 5 })
  })

  it("a page has the items before an index, the parents they need, and the requests anchored in them", () => {
    const p = itemPage(state(), 6, 2)
    expect([p.thread_id, p.start, p.context, p.seq]).toStrictEqual(["th", 4, [1, 3], 20])
    expect(ids(p.items)).toStrictEqual(["sa", "sb", "m4", "b1"])
    expect(p.requests).toStrictEqual([])
    const q = itemPage(state(), 4, 4)
    expect(q.start).toBe(0)
    expect(q.context).toStrictEqual([])
    expect(ids(q.items)).toStrictEqual(["m0", "sa", "m2", "sb"])
    expect(ids(q.requests)).toStrictEqual(["p-old"])
  })

  it("a page keeps within the list", () => {
    expect(itemPage(state(), 50, 1).start).toBe(9)
    const p = itemPage(state(), -3, 5)
    expect([p.start, p.items, p.context]).toStrictEqual([0, [], []])
  })

  it("withPage puts pages in front of a window until it's whole", () => {
    const whole = state()
    let w = snapshotWindow(whole, 2)
    for (const limit of [3, 2]) {
      const page = itemPage(whole, w.start ?? 0, limit)
      w = withPage(w, page)
      // The same as a window that had that many to begin with.
      expect(w).toStrictEqual(snapshotWindow(whole, whole.items.length - page.start))
    }
    expect(w.start).toBe(3)
    w = withPage(w, itemPage(whole, 3, 10))
    expect(w).toStrictEqual(whole)
    expect(w).not.toHaveProperty("start")
    expect(w).not.toHaveProperty("context")
  })

  it("withPage orders the context of both by index", () => {
    // A window whose context is the subagents' calls (1, 3); a page from 4 whose context is sa and sb (1, 3).
    const whole = state()
    const w = snapshotWindow({ ...whole, requests: [] }, 4)
    expect(w.context).toStrictEqual([1, 3])
    const next = withPage(w, itemPage(whole, 6, 2))
    expect(next.start).toBe(4)
    expect(next.context).toStrictEqual([1, 3])
    expect(ids(next.items)).toStrictEqual(["sa", "sb", "m4", "b1", "m6", "tc", "m8", "m9"])
  })

  it("withPage takes the page's version of an item or request it has", () => {
    const whole = state()
    const w = snapshotWindow(whole, 2)
    const later = applyEvent(whole, { type: "item.updated", thread_id: th, seq: 21, item_id: "sa", patch: { status: "failed" } })
    const next = withPage(w, itemPage(later, 8, 1))
    expect(next.items[0]).toMatchObject({ id: "sa", status: "failed" })
    expect(next.seq).toBe(20)
  })

  it("withPage ignores a page for another thread, or that doesn't end at its start", () => {
    const whole = state()
    const w = snapshotWindow(whole, 2)
    expect(withPage(w, itemPage(whole, 7, 2))).toBe(w)
    expect(withPage(w, { ...itemPage(whole, 8, 2), thread_id: TaskId.make("other") })).toBe(w)
    expect(withPage(whole, itemPage(whole, 0, 2))).toBe(whole)
  })

  it("a window takes events as any state does", () => {
    const w = snapshotWindow(state(), 2)
    const next = applyEvent(w, { type: "item.added", thread_id: th, seq: 21, item: msg("m10") })
    expect(next.start).toBe(8)
    expect(next.context).toStrictEqual([1, 3, 7])
    expect(ids(next.items).at(-1)).toBe("m10")
    // An update to an item it doesn't have only advances seq.
    const gone = applyEvent(next, { type: "item.updated", thread_id: th, seq: 22, item_id: "m0", patch: { text: "x" } })
    expect(gone.items).toBe(next.items)
    expect(gone.seq).toBe(22)
  })

  it("a request's anchor is its tool call, else -1", () => {
    const s = state()
    expect(s.requests.map((r) => requestAnchor(s.items, r))).toStrictEqual([2, 7, 8, -1, -1])
  })

  it("tells a subagent's call, and whether its subagent is still going", () => {
    const s = state()
    expect(s.items.filter(isSubagent).map((i) => i.id)).toStrictEqual(["sa", "sb"])
    const running = (change: Parameters<typeof withChanged>[2]) =>
      withChanged(s, "sb", change)
        .items.filter(isRunningSubagent)
        .map((i) => i.id)
    expect(running({})).toStrictEqual([])
    expect(running({ status: "running" })).toStrictEqual(["sb"])
    expect(running({ status: "pending" })).toStrictEqual(["sb"])
    // A background subagent's call completes when it starts; its subagent's status says whether it is going.
    expect(running({ status: "completed", subagent: { status: "running", background: true } })).toStrictEqual(["sb"])
    expect(running({ status: "running", subagent: { status: "completed", background: true } })).toStrictEqual([])
  })
})
