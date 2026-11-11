// The old src/subagents.ts. Subagents Claude or Codex starts during a run, as the thread view shows them (itemModel.ts makes them from the
// thread's subagent calls), and which of them a thread reveals or shows in full.

import { createStore } from "../../../smallStore"

export type SubagentStatus = "running" | "completed" | "failed" | "stopped"

export interface Subagent {
  /** tool_use_id of the launching call (Agent/Task, or a forked Skill). */
  id: string
  description: string
  prompt: string
  agentType?: string
  model?: string
  background: boolean
  status: SubagentStatus
  /** Latest progress line while running (e.g. "Reading b.txt"). */
  activity?: string
  /** Final report of a background subagent (a foreground one returns it as its tool result). */
  summary?: string
  toolUses?: number
  /** One of its tool calls is waiting on a permission prompt. */
  awaitingApproval?: boolean
  startedAt: string
  endedAt?: string
  /** The subagent that started this one, for nested subagents. */
  parent: string | null
}

export function subagentTitle(s: Pick<Subagent, "description" | "prompt" | "agentType">) {
  return s.description || (s.prompt.split("\n")[0] ?? "").slice(0, 80) || s.agentType || "Subagent"
}

export function duration(s: Subagent): string | null {
  if (!s.endedAt) return null
  const ms = Date.parse(s.endedAt) - Date.parse(s.startedAt)
  if (!(ms >= 0)) return null
  const sec = Math.round(ms / 1000)
  return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m ${sec % 60}s`
}

/**
 * Ask a task's thread to reveal a subagent's row in the main conversation, expanding the rows around
 * it. The request is pending until that row has shown itself (`handled`): rows that mount on the way,
 * as their parents expand, still act on it, and ones that mount after it don't.
 */
export const useSubagentFocus = createStore<{
  focus: { taskId: string; id: string; n: number } | null
  /** The latest request that's been dealt with. */
  handled: number
  reveal: (taskId: string, id: string) => void
  handle: (n: number) => void
}>((set) => ({
  focus: null,
  handled: 0,
  reveal: (taskId, id) => set((s) => ({ focus: { taskId, id, n: (s.focus?.n ?? 0) + 1 } })),
  handle: (n) => set((s) => ({ handled: Math.max(s.handled, n) })),
}))

/** The subagent each task's thread shows in full in place of the main conversation, by task id. */
export const useSubagentView = createStore<{ open: Record<string, string | undefined>; show: (taskId: string, id: string | null) => void }>((set) => ({
  open: {},
  show: (taskId, id) => set((s) => ({ open: { ...s.open, [taskId]: id ?? undefined } })),
}))
