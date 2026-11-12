import { useAtomValue } from "@effect/atom-react"
import { TaskId, type GitStatus } from "@huntaway/contracts"
import { query, type HostTask as Task, type QueryOptions } from "@huntaway/client"
import { useState } from "react"
import { useVisible } from "../../../state/visibility"
import { resultError, resultValue } from "../../ui"
import { toJson } from "../../ui/json"

/** How often the view checks for changes (an agent may be making them). */
const POLL = "4 seconds"

/** Whether two answers are the same, so the one already shown is kept (and what depends on it isn't fetched again). */
export const sameJson = (a: unknown, b: unknown) => toJson(a) === toJson(b)

/**
 * `value`, or the one it was before while what's read again is the same (`sameJson`): what depends on it (a diff's lines
 * picked, a file's diffs) stays as it was. State adjusted during render; the answer is compared once.
 */
export function useKept<T>(value: T): T {
  const [kept, setKept] = useState<{ readonly raw: T; readonly value: T }>({ raw: value, value })
  if (kept.raw === value) return kept.value
  const next = kept.value !== undefined && value !== undefined && sameJson(kept.value, value) ? kept.value : value
  setKept({ raw: value, value: next })
  return next
}

/**
 * How the tab's reads are kept: every few seconds while the page is shown (but not while a change is being made,
 * `busy`), and again when the window comes back. The agent starting or stopping and the worktree coming or going read
 * them again too (invalidate.ts's triggers), and so does every change made here (a `git.*` mutation).
 */
export function useGitReads(busy: boolean): QueryOptions {
  const visible = useVisible()
  return { refresh: visible && !busy ? POLL : undefined, focus: true }
}

/** The repository's status query (with no options: the read every reader shares, which a change waits for). */
export const statusQuery = (h: string, id: string, options?: QueryOptions) => query("git.status", h, { id: TaskId.make(id) }, options)

/** The repository's status, kept as it was while it's the same; `loadErr` once a read failed (the status before stays). */
export function useGitStatus(task: Task, reads: QueryOptions): { status: GitStatus | null; loadErr: string | null } {
  const result = useAtomValue(statusQuery(task.host_id, task.id, reads))
  const status = useKept(resultValue(result) ?? null)
  return { status, loadErr: resultError(result) }
}
