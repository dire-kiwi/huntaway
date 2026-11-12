// The old src/subagents.ts. Subagents Claude or Codex starts during a run, as the thread view shows them (itemModel.ts makes them from the
// thread's subagent calls), and which of them a thread reveals or shows in full: atoms kept for the page's life, read
// with a selector as the old stores were (`useSubagentView((s) => s.open[id])`, `useSubagentView.getState()`).

import { useAtomValue } from "@effect/atom-react"
import { Atom } from "effect/reactivity"
import { registry } from "../../../state/registry"
import { millisOf } from "../../ui"

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
  const ms = millisOf(s.endedAt) - millisOf(s.startedAt)
  if (!(ms >= 0)) return null
  const sec = Math.round(ms / 1000)
  return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m ${sec % 60}s`
}

/**
 * Ask a task's thread to reveal a subagent's row in the main conversation, expanding the rows around
 * it. The request is pending until that row has shown itself (`handled`): rows that mount on the way,
 * as their parents expand, still act on it, and ones that mount after it don't.
 */
export const subagentFocusAtom = Atom.make<{
  readonly focus: { readonly taskId: string; readonly id: string; readonly n: number } | null
  /** The latest request that's been dealt with. */
  readonly handled: number
}>({ focus: null, handled: 0 }).pipe(Atom.keepAlive)

const reveal = (taskId: string, id: string): void => registry.update(subagentFocusAtom, (s) => ({ ...s, focus: { taskId, id, n: (s.focus?.n ?? 0) + 1 } }))
const handle = (n: number): void => registry.update(subagentFocusAtom, (s) => (n > s.handled ? { ...s, handled: n } : s))

type FocusState = Atom.Type<typeof subagentFocusAtom> & { readonly reveal: typeof reveal; readonly handle: typeof handle }

/** The reveal request with what acts on it, through `select`. */
export function useSubagentFocus<A>(select: (s: FocusState) => A): A {
  return useAtomValue(subagentFocusAtom, (s) => select({ ...s, reveal, handle }))
}

/** The subagent each task's thread shows in full in place of the main conversation, by task id. */
export const subagentViewAtom = Atom.make<Readonly<Record<string, string | undefined>>>({}).pipe(Atom.keepAlive)

/** Shows subagent `id` in full in task `taskId`'s thread, or (null) its main conversation again. */
export const showSubagent = (taskId: string, id: string | null): void => registry.update(subagentViewAtom, (open) => ({ ...open, [taskId]: id ?? undefined }))

interface ViewState {
  readonly open: Readonly<Record<string, string | undefined>>
  readonly show: typeof showSubagent
}

/** The subagents shown in full and `show`, through `select`; `getState()` reads them outside React. */
export const useSubagentView = Object.assign(
  function useSubagentView<A>(select: (s: ViewState) => A): A {
    return useAtomValue(subagentViewAtom, (open) => select({ open, show: showSubagent }))
  },
  { getState: (): ViewState => ({ open: registry.get(subagentViewAtom), show: showSubagent }) },
)
