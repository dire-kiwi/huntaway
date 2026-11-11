import type { SubagentState, SubagentStatus, Timestamp } from "@huntaway/contracts"
import { Predicate } from "effect"
import type { TaskLine } from "./lines.ts"
import { str, uint } from "./tools.ts"

// A subagent call's state as its task_* lines and its result say it: the old threads/translate/subagents.ts.

/** How Claude says a subagent ended, as a SubagentStatus; undefined if what it says isn't an end. */
export const subagentEnd = (status: unknown): SubagentStatus | undefined => {
  switch (status) {
    case "completed":
    case "success":
      return "completed"
    case "failed":
    case "error":
      return "failed"
    case "killed":
    case "stopped":
    case "cancelled":
    case "interrupted":
      return "stopped"
    default:
      return undefined
  }
}

/** Ended with `status` at `at`, or at its first end if it ran again since. */
const ended = (s: SubagentState, status: SubagentStatus, at: Timestamp): SubagentState => ({ ...s, status, ended_at: s.ended_at ?? at })

/** A subagent call's subagent, as a task_started (of a `local_agent`) says it has started. `model`: what its input asked for. */
export const subagentStarted = (s: SubagentState | undefined, line: TaskLine, model: string | undefined): SubagentState => {
  const type = str(line, "subagent_type")
  const named = str(line, "model") ?? model
  return {
    ...s,
    status: "running",
    ...(line.is_backgrounded === true ? { background: true } : {}),
    ...(type === undefined ? {} : { agent_type: type }),
    ...(named === undefined ? {} : { model: named }),
  }
}

/** A subagent after a task_progress, task_updated or task_notification about it, read `at`. */
export const subagentTask = (s: SubagentState, line: TaskLine, at: Timestamp): SubagentState => {
  const running = s.status === "running"
  const toolUses = uint(line.usage?.tool_uses)
  switch (line.subtype) {
    case "task_progress": {
      const activity = str(line, "description")
      return { ...s, ...(activity === undefined ? {} : { activity }), ...(toolUses === undefined ? {} : { tool_uses: toolUses }) }
    }
    case "task_updated": {
      // Continued (with SendMessage) after it ended, it runs again.
      if (line.patch?.status === "running") {
        const { summary: _summary, ended_at: _ended, ...rest } = s
        return { ...rest, status: "running" }
      }
      const end = subagentEnd(line.patch?.status)
      return end !== undefined && running ? ended(s, end, at) : { ...s }
    }
    case "task_notification": {
      const end = subagentEnd(line.status)
      let next = end !== undefined && running ? ended(s, end, at) : { ...s }
      if (toolUses !== undefined) next = { ...next, tool_uses: toolUses }
      // A foreground subagent's report is its call's result.
      const summary = str(line, "summary")
      if (s.background === true && summary !== undefined) next = { ...next, summary }
      return next
    }
    case "task_started":
      return s
  }
  return s
}

/** What the old `slim` kept of an Agent call's `tool_use_result` (one with an `agentId`); none for any other. */
export const agentResultMeta = (toolUseResult: unknown): Readonly<Record<string, unknown>> =>
  Predicate.isObject(toolUseResult) && toolUseResult["agentId"] !== undefined ? toolUseResult : {}

/**
 * A subagent call's subagent, as its result says (`meta`: what `agentResultMeta` keeps of it); undefined for a call whose
 * subagent never started.
 */
export const subagentResult = (
  s: SubagentState | undefined,
  isError: boolean,
  interrupted: boolean,
  meta: Readonly<Record<string, unknown>>,
  text: string,
  at: Timestamp,
): SubagentState | undefined => {
  if (s === undefined && isError) return undefined
  const model = str(meta, "resolvedModel")
  const type = str(meta, "agentType")
  const n = uint(meta["totalToolUseCount"])
  const next: SubagentState = {
    ...(s ?? { status: "running" }),
    ...(model === undefined ? {} : { model }),
    ...(type === undefined ? {} : { agent_type: type }),
    ...(n === undefined ? {} : { tool_uses: n }),
  }
  // A background subagent's call returns as soon as it has started it.
  if (meta["isAsync"] === true || meta["status"] === "async_launched" || text.trimStart().startsWith("Async agent launched"))
    return { ...next, background: true }
  if (next.status !== "running") return next
  return ended(next, isError ? (interrupted ? "stopped" : "failed") : (subagentEnd(meta["status"]) ?? "completed"), at)
}
