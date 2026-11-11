import { describe, expect, it } from "@effect/vitest"
import {
  applyEvent,
  initialState,
  type Item,
  itemPage,
  type Snapshot,
  snapshotWindow,
  TaskId,
  Timestamp,
  type ThreadRequest,
  withPage,
} from "@huntaway/contracts"
import { buildItemModel, keyOf, toolName } from "../../src/components/task/thread/itemModel"

// The old tests/itemModel.test.ts, on items made here rather than by the old server's translator from messages.
// Dropped: "a thread's items draw what its messages did" (and its forked Skill and "at every point" cases), which
// compared the view with what the view on messages drew (fixtures/threadHistoryDrawn.json) through the old
// translator; the new translator's own tests (apps/server, 2.4) hold what items a session makes.

const T = TaskId.make("t")
const at = (s: number) => Timestamp.make(`2026-10-26T07:${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}.000Z`)

const text = (n: number, body: string, parent_id?: string): Item => ({
  id: `legacy:${n}:0`,
  type: "assistant_message",
  text: body,
  ...(parent_id === undefined ? {} : { parent_id }),
})

const subagent = (id: string, description: string, prompt: string, background: boolean): Item => ({
  id,
  type: "tool_call",
  name: "Agent",
  kind: "subagent",
  input: { description, prompt, ...(background ? { run_in_background: true } : {}) },
  status: "completed",
  result: { content: background ? "Async agent launched successfully" : "Found it" },
  subagent: { status: "completed", ...(background ? { background: true, summary: "Back" } : { tool_uses: 2 }) },
})

const whole = (items: ReadonlyArray<Item>, requests: ReadonlyArray<ThreadRequest> = []): Snapshot => ({
  ...initialState({ id: T, harness: "claude", status: "idle", created_at: at(0) }),
  items,
  requests,
})

describe("buildItemModel", () => {
  it("keys and tool names come back as the messages had them", () => {
    expect([keyOf("legacy:12"), keyOf("legacy:12:3"), keyOf("legacy:12:result"), keyOf("toolu_1")]).toEqual(["12", "12.3", "12.result", "toolu_1"])
    expect(toolName({ name: "pr_view", kind: "mcp", server: "gh" })).toBe("mcp__gh__pr_view")
    expect(toolName({ name: "board", kind: "app" })).toBe("mcp__app__board")
    expect(toolName({ name: "Bash", kind: "shell" })).toBe("Bash")
  })

  it("requests from before the board's metadata (converter 2) still draw as prompts", () => {
    const m = buildItemModel(
      {
        items: [{ id: "c", type: "tool_call", name: "Bash", kind: "shell", input: { command: "ls" }, status: "running", created_at: at(0) }],
        requests: [{ id: "r", type: "permission", name: "Bash", kind: "shell", input: { command: "ls" }, tool_call_id: "c", created_at: at(1) }],
      },
      true,
    )
    expect(m.items.map((i) => i.type)).toEqual(["tools", "permission"])
    const prompt = m.items[1]
    expect(prompt?.type === "permission" ? prompt.data : null).toEqual({
      request_id: "r",
      status: "pending",
      tool_use_id: "c",
      tool_name: "Bash",
      input: { command: "ls" },
    })
  })

  it("what an event leaves as it was stays the same objects", () => {
    const before = whole([{ id: "legacy:1", type: "user_message", text: "Go" }, text(2, "One"), text(3, "Two")])
    const prev = buildItemModel(before, true)
    const after = applyEvent({ ...before, seq: 3 }, { type: "item.added", thread_id: T, seq: 4, item: text(4, "Three") })
    const next = buildItemModel(after, true, prev)
    expect(next.items.slice(0, 3)).toEqual(prev.items)
    prev.items.forEach((row, i) => expect(next.items[i]).toBe(row))
    expect(buildItemModel(after, true, next).items, "nothing new: the same rows").toBe(next.items)
  })

  it("a window shows its last items, and with every earlier page put in, the whole thread", () => {
    const items: Array<Item> = [{ id: "legacy:1", type: "user_message", text: "Go" }, subagent("toolu_sub", "Look", "Look around", false)]
    for (let i = 0; i < 20; i++) items.push(text(10 + i, `Finding ${i}`, i % 2 === 0 ? "toolu_sub" : undefined))
    const all = whole(items)
    const full = buildItemModel(all, true)
    let w = snapshotWindow(all, 6)
    expect(w.start ?? 0).toBeGreaterThan(0)
    const shown = buildItemModel(w, true)
    // The window's rows are the thread's last ones; the subagent its items belong to is known, though its call is before it.
    expect(shown.items).toEqual(full.items.slice(-shown.items.length))
    expect([...shown.subagents.keys()]).toEqual(["toolu_sub"])
    while (w.start) w = withPage(w, itemPage(all, w.start, 5))
    const paged = buildItemModel(w, true)
    expect(paged.items).toEqual(full.items)
    expect(paged.childItems).toEqual(full.childItems)
    expect(paged.subagents).toEqual(full.subagents)
  })

  // HA-218 review: a window's context had only the subagents still running, so a long thread's earlier subagents that
  // had ended were missing from its Agents list.
  it("a long thread's window lists every subagent before it", () => {
    const items: Array<Item> = [
      { id: "legacy:1", type: "user_message", text: "Go" },
      subagent("toolu_sub", "Look", "Look around", false),
      text(3, "Looking.", "toolu_sub"),
      subagent("toolu_bg", "Away", "Go away", true),
    ]
    for (let i = 0; i < 400; i++) items.push(text(10 + i, `Reply ${i}`))
    const w = snapshotWindow(whole(items), 300)
    expect(w.start ?? 0).toBeGreaterThan(3)
    const m = buildItemModel(w, false)
    const subs = [...m.subagents.values()].toSorted((a, b) => a.id.localeCompare(b.id))
    expect(
      subs.map(({ id, description, prompt, background, status, summary, toolUses }) => ({ id, description, prompt, background, status, summary, toolUses })),
    ).toEqual([
      { id: "toolu_bg", description: "Away", prompt: "Go away", background: true, status: "completed", summary: "Back", toolUses: undefined },
      { id: "toolu_sub", description: "Look", prompt: "Look around", background: false, status: "completed", summary: undefined, toolUses: 2 },
    ])
    // Its rows are the window's: the subagents' calls aren't drawn until their page loads.
    expect(m.items.every((r) => r.type === "text")).toBe(true)
  })
})
