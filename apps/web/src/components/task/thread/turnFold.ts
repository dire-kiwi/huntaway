// The "Fold finished turns" experiment (Settings → Experiments, docs/plan/09-frontend.md): which rows of a thread fold
// into a finished turn's one row. Pure, so it's tested without a page.

import { QUESTION_TOOLS } from "@huntaway/client"
import type { Item, ResultData } from "./threadModel"

/** A finished turn whose steps fold. */
export interface FoldedTurn {
  /** The key of its first tool group, where its row goes. */
  readonly at: string
  /** The keys of the rows that fold into it: its tool groups, its answered tool prompts and its result line. */
  readonly folded: ReadonlySet<string>
  /** Its tool calls' ids, for revealing a subagent among them. */
  readonly calls: ReadonlyArray<string>
  readonly result: ResultData
  /** A step waited for approval: a permission prompt for a tool came up in the turn. */
  readonly waited: boolean
  /** A step failed, or was refused. */
  readonly failed: boolean
}

/** A permission prompt for a tool call (not a question, a plan or one of the board's own approvals). */
const isToolPrompt = (it: Extract<Item, { type: "permission" }>) =>
  it.data.kind === undefined && it.data.tool_name !== "ExitPlanMode" && !QUESTION_TOOLS.includes(it.data.tool_name)

/**
 * The thread's finished turns that have tool calls. A turn runs from a message to the agent (the user's or the board's)
 * to its result; a message sent while it worked (`steered`) is part of it. A turn without a result yet (still running)
 * or without tool calls doesn't fold.
 */
export function finishedTurns(items: ReadonlyArray<Item>): Array<FoldedTurn> {
  const out: Array<FoldedTurn> = []
  let folded = new Set<string>()
  let calls: Array<string> = []
  let at: string | null = null
  let waited = false
  let failed = false
  const reset = () => {
    folded = new Set()
    calls = []
    at = null
    waited = false
    failed = false
  }
  for (const it of items) {
    if (it.type === "user") {
      if (!it.steered) reset()
    } else if (it.type === "tools") {
      at ??= it.key
      folded.add(it.key)
      for (const c of it.calls) {
        calls.push(c.id)
        if (c.result?.isError) failed = true
      }
    } else if (it.type === "permission" && isToolPrompt(it)) {
      waited = true
      if (it.data.status === "denied") failed = true
      // Answered, it's part of its step; one still waiting stays in sight.
      if (it.data.status !== "pending") folded.add(it.key)
    } else if (it.type === "result") {
      if (at !== null) {
        folded.add(it.key)
        out.push({ at, folded, calls, result: it.data, waited, failed })
      }
      reset()
    } else if (it.type === "compact" && it.result) reset()
  }
  return out
}

/** The longest a turn's "Worked for" is believed: longer is a clock or a resumed run, and is left out (as is under 1 s). */
const MAX_WORK_MS = 12 * 60 * 60 * 1000

/** How long a turn worked, for its row: null when it doesn't say or it's out of range. */
export function workedMs(result: ResultData): number | null {
  const ms = result.duration_ms
  return ms != null && ms >= 1000 && ms < MAX_WORK_MS ? ms : null
}
