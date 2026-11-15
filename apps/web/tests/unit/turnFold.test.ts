import { describe, expect, it } from "@effect/vitest"
import type { Call, Item, PromptData } from "../../src/components/task/thread/threadModel"
import { finishedTurns, workedMs } from "../../src/components/task/thread/turnFold"

// The "Fold finished turns" experiment: which rows of a thread fold into a turn's one row.

const call = (id: string, isError = false): Call => ({ id, name: "Bash", input: {}, result: { content: "", isError } })
const tools = (key: string, ...calls: Call[]): Item => ({ type: "tools", key, calls })
const user = (key: string, steered?: boolean): Item => ({ type: "user", key, text: "Go", ...(steered ? { steered } : {}) })
const text = (key: string): Item => ({ type: "text", key, text: "Looking" })
const result = (key: string, duration_ms = 130_000): Item => ({ type: "result", key, data: { subtype: "success", is_error: false, duration_ms } })
const prompt = (key: string, data: Partial<PromptData> = {}): Item => ({
  type: "permission",
  key,
  data: { request_id: key, status: "allowed", tool_name: "Bash", input: {}, ...data },
})

describe("finishedTurns", () => {
  it("folds a finished turn's tool groups and result line, leaving its text, at its first tool group", () => {
    const items = [user("1"), text("2.0"), tools("t1", call("a"), call("b")), text("2.1"), tools("t2", call("c")), text("2.2"), result("r")]
    const [turn, ...rest] = finishedTurns(items)
    expect(rest).toEqual([])
    expect(turn?.at).toBe("t1")
    expect([...(turn?.folded ?? [])]).toEqual(["t1", "t2", "r"])
    expect(turn?.calls).toEqual(["a", "b", "c"])
    expect([turn?.waited, turn?.failed]).toEqual([false, false])
  })

  it("leaves a running turn, and one without tool calls, open", () => {
    expect(finishedTurns([user("1"), tools("t1", call("a")), text("2")])).toEqual([])
    expect(finishedTurns([user("1"), text("2"), result("r")])).toEqual([])
    // The second turn is running: only the first folds.
    const turns = finishedTurns([user("1"), tools("t1", call("a")), result("r1"), user("3"), tools("t2", call("b"))])
    expect(turns.map((t) => t.at)).toEqual(["t1"])
  })

  it("keeps a message sent while the agent worked in its turn, and starts a new one at the next", () => {
    const turns = finishedTurns([user("1"), tools("t1", call("a")), user("2", true), tools("t2", call("b")), result("r1"), user("3"), tools("t3", call("c")), result("r2")])
    expect(turns.map((t) => [t.at, t.calls])).toEqual([
      ["t1", ["a", "b"]],
      ["t3", ["c"]],
    ])
  })

  it("marks a turn whose step waited for approval, failed or was refused", () => {
    const [waited] = finishedTurns([user("1"), tools("t1", call("a")), prompt("p"), result("r")])
    expect([waited?.waited, waited?.failed]).toEqual([true, false])
    const [failed] = finishedTurns([user("1"), tools("t1", call("a"), call("b", true)), result("r")])
    expect([failed?.waited, failed?.failed]).toEqual([false, true])
    const [refused] = finishedTurns([user("1"), tools("t1", call("a")), prompt("p", { status: "denied" }), result("r")])
    expect([refused?.waited, refused?.failed]).toEqual([true, true])
    // A plan, a question and the board's own approvals aren't a step's approval.
    const [asked] = finishedTurns([user("1"), tools("t1", call("a")), prompt("p", { tool_name: "ExitPlanMode" }), prompt("q", { kind: "project" }), result("r")])
    expect(asked?.waited).toBe(false)
  })

  it("says how long a turn worked only between 1 s and 12 h", () => {
    const of = (duration_ms?: number) => workedMs({ subtype: "success", is_error: false, ...(duration_ms === undefined ? {} : { duration_ms }) })
    expect([of(130_000), of(999), of(12 * 3600_000), of(undefined)]).toEqual([130_000, null, null, null])
  })
})
