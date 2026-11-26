import { describe, expect, it } from "@effect/vitest"
import { DateTime } from "effect"
import { HostId, RequestId, TaskId, Timestamp, type Item, type PendingPermission, type ThreadRequest } from "@huntaway/contracts"
import { inboxItems, needsAnswer } from "../src/logic/inbox"
import { agentNote, DONE_SHOWN, groupTasks, searchTasks } from "../src/logic/tasks"
import { foldTools, shortToolName, threadRows, toolsSummary } from "../src/logic/thread"
import { ago } from "../src/logic/time"

const at = (n: number) => Timestamp.make(`2026-11-15T10:00:${String(n).padStart(2, "0")}.000Z`)

const t = (id: string, status: "todo" | "done" | "needs_attention" | "in_progress", position: number, extra: object = {}) => ({
  id,
  kind: "task" as const,
  task_type: null,
  status,
  position,
  done_at: status === "done" ? at(position) : null,
  ...extra,
})
const user = (id: string, text: string, n: number): Item => ({ id, type: "user_message", text, created_at: at(n) })
const said = (id: string, text: string, n: number): Item => ({ id, type: "assistant_message", text, created_at: at(n) })
const call = (id: string, n: number, status: "completed" | "failed" | "running" = "running"): Item => ({
  id,
  type: "tool_call",
  name: "Bash",
  kind: "shell",
  input: {},
  status,
  command: "ls -la\nmore",
  created_at: at(n),
})
const prompt = (id: string, tool_call_id: string | undefined, n: number): ThreadRequest => ({
  id,
  type: "permission",
  name: "Bash",
  kind: "shell",
  input: {},
  created_at: at(n),
  ...(tool_call_id === undefined ? {} : { tool_call_id }),
})
const A = HostId.make("a")
const task = (id: string, status: "needs_attention" | "in_progress" | "in_review", n: number, review_unread = false) => ({
  host_id: A,
  id: TaskId.make(id),
  status,
  updated_at: at(n),
  review_unread,
})
const pending = (id: string, task_id: string, n: number): PendingPermission => ({
  id: RequestId.make(id),
  task_id: TaskId.make(task_id),
  tool_name: "Bash",
  input: {},
  created_at: at(n),
  expires_at: null,
  rule: null,
})

describe("groupTasks", () => {
  it("puts what needs the user first, each status by position, and leaves out reviews and assistants", () => {
    const groups = groupTasks([
      t("a", "todo", 2),
      t("b", "todo", 1),
      t("c", "needs_attention", 5),
      t("d", "in_progress", 3),
      { ...t("r", "todo", 0), kind: "review" as const },
      { ...t("s", "todo", 0), task_type: "assistant" as const },
    ])
    expect(groups.map((g) => [g.status, g.tasks.map((x) => x.id)])).toEqual([
      ["needs_attention", ["c"]],
      ["in_progress", ["d"]],
      ["todo", ["b", "a"]],
    ])
    expect(groups[0]?.label).toBe("Needs attention")
  })

  it("shows the latest done tasks only", () => {
    const done = Array.from({ length: DONE_SHOWN + 5 }, (_, i) => t(`d${i}`, "done", i))
    const [group] = groupTasks(done)
    expect(group?.tasks).toHaveLength(DONE_SHOWN)
    expect(group?.tasks[0]?.id).toBe(`d${DONE_SHOWN + 4}`)
  })
})

describe("threadRows", () => {
  it("puts a prompt after its call, others where they were asked, and leaves out what isn't shown", () => {
    const rows = threadRows({
      items: [
        user("ctx", "old", 0),
        user("u1", "hello", 1),
        said("a1", "Looking", 3),
        call("c1", 4),
        { id: "sub", type: "assistant_message", text: "a subagent's", parent_id: "c1" },
        user("u2", "  ", 6),
        { id: "r", type: "turn_result", ok: false, error: "boom", created_at: at(7) },
        { id: "i", type: "turn_result", ok: false, interrupted: true },
      ],
      requests: [prompt("p-loose", undefined, 2), prompt("p-call", "c1", 5), prompt("p-late", undefined, 9)],
      context: [0],
    })
    expect(rows.map((r) => r.key)).toEqual(["u1", "p-loose", "a1", "c1", "p-call", "r", "p-late"])
    expect(rows.find((r) => r.key === "c1")).toEqual({ type: "tool", key: "c1", name: "Bash", summary: "ls -la", status: "running" })
  })

  it("names an MCP tool by its own name", () => {
    expect(shortToolName("mcp__huntaway__list_tasks")).toBe("list_tasks")
    expect(shortToolName("Bash")).toBe("Bash")
  })
})

describe("inboxItems", () => {
  it("lists prompts and the tasks needing attention that have none, newest first", () => {
    const items = inboxItems(
      [task("t1", "needs_attention", 1), task("t2", "needs_attention", 3), task("t3", "in_progress", 9)],
      [{ host_id: A, prompts: [pending("p1", "t1", 2)] }],
    )
    expect(items.map((i) => i.key)).toEqual(["a/t/t2", "a/p/p1"])
    expect(items[1]?.type === "prompt" && items[1].task?.id).toBe("t1")
  })

  it("lists the tasks new in In review, as what waits on a look rather than an answer (HE-99)", () => {
    const items = inboxItems([task("t1", "needs_attention", 1), task("t2", "in_review", 3, true), task("t3", "in_review", 4)], [])
    expect(items.map((i) => [i.key, i.type, needsAnswer(i)])).toEqual([
      ["a/r/t2", "review", false],
      ["a/t/t1", "attention", true],
    ])
  })
})

describe("the thread's runs of tool calls (HE-99)", () => {
  it("folds calls next to each other into one row, keyed by the first, and leaves the rest where it was", () => {
    const rows = foldTools(
      threadRows({
        items: [user("u1", "go", 1), call("c1", 2, "completed"), call("c2", 3, "failed"), said("a1", "Half way", 4), call("c3", 5)],
        requests: [],
      }),
    )
    expect(rows.map((r) => [r.type, r.key])).toEqual([
      ["user", "u1"],
      ["tools", "tools:c1"],
      ["text", "a1"],
      ["tools", "tools:c3"],
    ])
    const [, first, , last] = rows
    expect(first?.type === "tools" && toolsSummary(first.calls)).toEqual({ label: "2 steps, 1 failed", running: false, failed: 1 })
    expect(last?.type === "tools" && toolsSummary(last.calls)).toEqual({ label: "1 step", running: true, failed: 0 })
  })

  it("shows a published document as a row that opens it, not as a tool call", () => {
    const published: Item = {
      id: "c1",
      type: "tool_call",
      name: "publish_document",
      kind: "mcp",
      server: "docs",
      input: {},
      status: "completed",
      result: { content: '{"slug":"plan","version":2,"url":"http://127.0.0.1:7879/docs/p1/d/plan/"}' },
      created_at: at(1),
    }
    const rows = foldTools(threadRows({ items: [published, { ...published, id: "c2", status: "failed", result: { content: "no" } }], requests: [] }))
    expect(rows).toEqual([
      { type: "doc", key: "c1", doc: { page: { plugin: "docs", path: "p1/d/plan/", search: "" }, slug: "plan", version: 2 } },
      { type: "tools", key: "tools:c2", calls: [{ type: "tool", key: "c2", name: "mcp__docs__publish_document", summary: "", status: "failed" }] },
    ])
  })
})

describe("a task in a list (HE-99)", () => {
  const idle = { running: false, waiting: false, background_work: null, agent_wait: null, status: "in_progress" as const }

  it("says what its agent is doing, and nothing of an agent that waits on the user", () => {
    expect(agentNote(idle)).toBeNull()
    expect(agentNote({ ...idle, waiting: true })).toEqual({ state: "queued", label: "Waiting to start" })
    expect(agentNote({ ...idle, running: true })).toEqual({ state: "working", label: "Working" })
    expect(agentNote({ ...idle, running: true, status: "needs_attention" })).toBeNull()
  })

  it("is found by the words of its key and title, in any case", () => {
    const tasks = [
      { key: "HE-12", title: "Redesign the phone app" },
      { key: "HE-13", title: "Phone push" },
    ]
    expect(searchTasks(tasks, "").map((x) => x.key)).toEqual(["HE-12", "HE-13"])
    expect(searchTasks(tasks, "PHONE app").map((x) => x.key)).toEqual(["HE-12"])
    expect(searchTasks(tasks, "he-13").map((x) => x.key)).toEqual(["HE-13"])
    expect(searchTasks(tasks, "nothing")).toEqual([])
  })

  it("says how long ago it moved, in a couple of characters", () => {
    const now = 1_795_000_000_000
    const before = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(now - ms))
    expect(ago(before(20_000), now)).toBe("now")
    expect(ago(before(5 * 60_000), now)).toBe("5m")
    expect(ago(before(3 * 3_600_000), now)).toBe("3h")
    expect(ago(before(2 * 86_400_000), now)).toBe("2d")
    expect(ago(before(30 * 86_400_000), now)).toBe("4w")
    expect(ago("not a time", now)).toBe("")
    expect(ago(null, now)).toBe("")
  })
})
