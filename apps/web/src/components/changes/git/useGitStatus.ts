import { TaskId, type GitStatus } from "@huntaway/contracts"
import type { HostTask as Task } from "@huntaway/client"
import { useCallback, useEffect, useRef, useState, type RefObject } from "react"
import { rpc } from "../../../state/rpc"
import { toJson } from "../../ui/json"
import { errText } from "./model"

/** How often the view checks for changes (an agent may be making them). */
const POLL_MS = 4000

/** Whether two answers are the same, so the one already shown is kept (and what depends on it isn't fetched again). */
export const sameJson = (a: unknown, b: unknown) => toJson(a) === toJson(b)

/**
 * The repository's status, checked when the agent starts or stops, every few seconds while the page is shown (but
 * not while a change is being made, `busy`), and when the window comes back. `tick` is bumped by every check, and
 * `askedTick` by every one but the polls (for what's big to fetch again).
 */
export function useGitStatus(task: Task, busy: RefObject<boolean>) {
  const [h, id] = [task.host_id, task.id]
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const [askedTick, setAskedTick] = useState(0)

  // The status, kept as it was when nothing changed, so what depends on it isn't fetched again.
  const seq = useRef(0)
  const refresh = useCallback(
    async (poll = false): Promise<GitStatus | null> => {
      const n = ++seq.current
      let st: GitStatus | null = null
      try {
        st = await rpc(h, "git.status", { id: TaskId.make(id) })
        if (n !== seq.current) return null
        const got = st
        setStatus((prev) => (sameJson(prev, got) ? prev : got))
        setLoadErr(null)
      } catch (e) {
        if (n === seq.current) setLoadErr(errText(e))
      }
      setTick((t) => t + 1)
      if (!poll) setAskedTick((t) => t + 1)
      return st
    },
    [h, id],
  )
  // Again as the agent starts or stops and the worktree comes or goes (from a timer, so not while the effect runs).
  const moved = `${task.running}:${task.worktree_state}`
  useEffect(() => {
    const t = setTimeout(() => void refresh(), 0, moved)
    return () => clearTimeout(t)
  }, [refresh, moved])
  useEffect(() => {
    const poll = setInterval(() => {
      if (document.visibilityState === "visible" && !busy.current) void refresh(true)
    }, POLL_MS)
    const onFocus = () => void refresh()
    window.addEventListener("focus", onFocus)
    return () => {
      clearInterval(poll)
      window.removeEventListener("focus", onFocus)
    }
  }, [refresh, busy])
  return { status, loadErr, tick, askedTick, refresh }
}
