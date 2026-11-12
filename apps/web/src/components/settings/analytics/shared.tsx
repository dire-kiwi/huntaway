import { type ReactNode } from "react"
import { atHour, dayKey, hm, NEUTRAL, SCRATCH, type Activity, type AEvent, type AProject, type ATask, type Span } from "./analytics"
import { nowMillis } from "../../../state/clock"
import { navigate } from "../../../state/route"
import { localeTimeString } from "../../ui/dates"
import { Swatch } from "../chart"

export const projectOf = (a: Activity, taskId: string): AProject =>
  a.projects[a.tasks[taskId]?.projectId ?? SCRATCH] ?? a.projects[SCRATCH] ?? { id: SCRATCH, name: "No project", key: "No project", color: NEUTRAL }
export const colorOf = (a: Activity, taskId: string) => projectOf(a, taskId)?.color ?? NEUTRAL
export const hourLabel = (day: number, h: number) => localeTimeString(atHour(day, h), { hour: "numeric" }, [])
/** Each item with its place in the list, for what has no other identity (a lane of runs). */
export const numbered = <T,>(list: ReadonlyArray<T>): Array<{ n: number; value: T }> => list.map((value, n) => ({ n, value }))
/** Today's day key, for marking today. */
export const todayKey = () => dayKey(nowMillis())
export const clock = (t: number) => localeTimeString(t, { hour: "numeric", minute: "2-digit" }, [])

export function openTask(t: ATask | undefined) {
  if (!t) return
  navigate({ name: "task", taskId: t.id })
}

export function SpanTip({ a, s, label }: { a: Activity; s: Span; label: string }) {
  const t = a.tasks[s.taskId]
  const p = projectOf(a, s.taskId)
  return (
    <>
      <div className="flex items-center gap-1.5">
        <Swatch color={p.color} />
        <span className="font-mono text-[11.5px] text-muted">{t?.key ?? "Deleted"}</span>
      </div>
      {t && t.kind !== "scratch" && <div className="mt-0.5 text-fg">{t.title}</div>}
      <div className="mt-1 text-muted tabular-nums">
        {label} · {clock(s.start)}–{clock(s.end)} · {hm(s.end - s.start)}
      </div>
    </>
  )
}
export function Legend({ projects, children }: { projects: AProject[]; children?: ReactNode }) {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px] text-muted">
      {projects.map((p) => (
        <span key={p.id} className="flex items-center gap-1.5">
          <Swatch color={p.color} /> {p.name}
        </span>
      ))}
      {children}
    </div>
  )
}
export const EVENT_LABEL: Record<AEvent["kind"], string> = { prompt: "", start: "Started the task", merge: "Moved to Ready for merge" }
