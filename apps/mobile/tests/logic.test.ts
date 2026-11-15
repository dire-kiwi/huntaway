import { describe, expect, it } from "@effect/vitest"
import { HostId, RequestId, TaskId, Timestamp, type Item, type PendingPermission, type ThreadRequest } from "@huntaway/contracts"
import { inboxItems } from "../src/logic/inbox"
import { DONE_SHOWN, groupTasks } from "../src/logic/tasks"
import { shortToolName, threadRows } from "../src/logic/thread"

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
const call = (id: string, n: number): Item => ({
  id,
  type: "tool_call",
  name: "Bash",
  kind: "shell",
  input: {},
  status: "running",
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
const task = (id: string, status: "needs_attention" | "in_progress", n: number) => ({ host_id: A, id: TaskId.make(id), status, updated_at: at(n) })
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
})
