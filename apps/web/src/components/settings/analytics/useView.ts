import { useMemo } from "react"
import { activeSpans, SCRATCH, totalsByTask, type Activity, type AEvent, type Rules, type RunSpan, type Span, type TaskTotals } from "./analytics"

/** What a range shows once the profile and project filters are applied. */
export interface View {
  data: Activity
  spans: Span[]
  events: AEvent[]
  runs: RunSpan[]
  totals: Map<string, TaskTotals>
}

export function useView(data: Activity | null, rules: Rules, profile: string | null, project: string): View | null {
  return useMemo(() => {
    if (!data) return null
    // Spans are worked out from every profile's prompts first: a prompt's time is from the previous one, on any task.
    const keep = (id: string) =>
      (profile === null || data.tasks[id]?.profile === profile) && (project === "all" || (data.tasks[id]?.projectId ?? SCRATCH) === project)
    const spans = activeSpans(data, rules).filter((s) => keep(s.taskId))
    const events = data.events.filter((e) => e.at >= data.from && e.at < data.to && keep(e.taskId))
    const runs = data.runs.filter((r) => keep(r.taskId))
    return { data, spans, events, runs, totals: totalsByTask(events, spans, runs) }
  }, [data, rules, profile, project])
}
