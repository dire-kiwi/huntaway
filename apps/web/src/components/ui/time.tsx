import { useSyncExternalStore } from "react"
import type { HostTask as Task } from "@huntaway/client"

export function timeAgo(iso: string) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return "just now"
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

/** How long, e.g. "45s", "3m 12s", "1h 04m". */
export function duration(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`
  if (s < 86400) return `${Math.floor(s / 3600)}h ${String(Math.floor(s / 60) % 60).padStart(2, "0")}m`
  return `${Math.floor(s / 86400)}d ${Math.floor(s / 3600) % 24}h`
}

// One clock for every running timer on screen, ticking only while something shows one.
const clockSubs = new Set<() => void>()
let clockTimer: ReturnType<typeof setInterval> | undefined
function subscribeClock(cb: () => void) {
  clockSubs.add(cb)
  clockTimer ??= setInterval(() => clockSubs.forEach((f) => f()), 1000)
  return () => {
    clockSubs.delete(cb)
    if (!clockSubs.size) {
      clearInterval(clockTimer)
      clockTimer = undefined
    }
  }
}
const nowSecond = () => Math.floor(Date.now() / 1000) * 1000

/** The time now, to the `step` (in ms): re-renders once it's moved on a step. */
export function useClock(step: number) {
  return useSyncExternalStore(subscribeClock, () => Math.floor(Date.now() / step) * step)
}

function Elapsed({ since, title }: { since: string; title?: string | undefined }) {
  const now = useSyncExternalStore(subscribeClock, nowSecond)
  return (
    <span className="tabular-nums" title={title ?? `Working since ${new Date(since).toLocaleString()}`}>
      {duration(now - new Date(since).getTime())}
    </span>
  )
}

/** How long the agent has been working while it runs, otherwise when the task last saw activity. `title` replaces its tooltip. */
export function ActivityTime({ task, title }: { task: Task; title?: string | undefined }) {
  if (task.running && task.run_started_at) return <Elapsed since={task.run_started_at} title={title} />
  return <Ago at={task.last_activity_at} title={title} />
}

/** "5m ago", kept up to date (memoized cards don't redraw as the minutes pass). */
export function Ago({ at, title }: { at: string; title?: string | undefined }) {
  useClock(60_000)
  return <span title={title ?? new Date(at).toLocaleString()}>{timeAgo(at)}</span>
}
