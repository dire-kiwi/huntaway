import type { HostTask as Task } from "@huntaway/client"
import { nowMillis, useNow } from "../../state/clock"
import { localeString, millisOf } from "./dates"

/** How long ago `iso` was: "just now", "5m ago", "3h ago", "2d ago". */
export function timeAgo(iso: string, now = nowMillis()) {
  const s = Math.max(0, (now - millisOf(iso)) / 1000)
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

/** The time now, to the `step` (in ms): re-renders once it's moved on a step (one clock per step, state/clock.ts). */
export const useClock = useNow

function Elapsed({ since, title }: { since: string; title?: string | undefined }) {
  const now = useNow(1000)
  return (
    <span className="tabular-nums" title={title ?? `Working since ${localeString(since)}`}>
      {duration(now - millisOf(since))}
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
  useNow(60_000)
  return <span title={title ?? localeString(at)}>{timeAgo(at)}</span>
}
