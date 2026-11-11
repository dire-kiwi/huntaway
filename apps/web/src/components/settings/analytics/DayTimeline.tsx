import { addDays, HOUR, mergeSpans, type RunSpan, type Span } from "./analytics"
import { useTip } from "../chart"
import { type View } from "./useView"
import { projectOf, colorOf, hourLabel, clock, SpanTip, Legend, EVENT_LABEL, numbered } from "./shared"

/** Puts overlapping spans in separate lanes. */
export function lanes<T extends Span>(spans: T[]): T[][] {
  const out: T[][] = []
  for (const s of spans.toSorted((x, y) => x.start - y.start)) {
    const lane = out.find((l) => (l.at(-1)?.end ?? 0) <= s.start)
    if (lane) lane.push(s)
    else out.push([s])
  }
  return out
}

/** One day: when you were prompting (and on what), and when agents ran. */
export function DayTimeline({ view, day }: { view: View; day: number }) {
  const { bind, node } = useTip()
  const a = view.data
  const end = addDays(day, 1)
  const clipTo = <T extends Span>(s: T): T | null => {
    const start = Math.max(s.start, day)
    const e = Math.min(s.end, end)
    return e > start ? { ...s, start, end: e } : null
  }
  const mine = mergeSpans(view.spans)
    .map(clipTo)
    .filter((s): s is Span => !!s)
  const runs = view.runs.map(clipTo).filter((s): s is RunSpan => !!s)
  const events = view.events.filter((e) => e.at >= day && e.at < end)
  const runLanes = lanes(runs).slice(0, 6)

  // Show the working hours, padded, rather than the whole day.
  const times = [...mine.flatMap((s) => [s.start, s.end]), ...runs.flatMap((s) => [s.start, s.end])]
  const firstH = times.length ? Math.max(0, Math.floor((Math.min(...times) - day) / HOUR) - 1) : 8
  const lastH = times.length ? Math.min(24, Math.ceil((Math.max(...times) - day) / HOUR) + 1) : 18
  const span = Math.max(lastH - firstH, 6)
  const startH = Math.max(0, Math.min(firstH, 24 - span))
  const x = (t: number) => `${(((t - day) / HOUR - startH) * 100) / span}%`
  // Less a pixel, so back-to-back blocks keep a gap between them.
  const w = (s: Span) => `max(2px, calc(${((s.end - s.start) / HOUR / span) * 100}% - 1px))`
  const hourStep = span > 12 ? 2 : 1
  const hoursShown: number[] = []
  for (let h = startH; h <= startH + span; h += hourStep) hoursShown.push(h)
  const shownProjects = Object.values(a.projects).filter((p) => [...mine, ...runs].some((s) => projectOf(a, s.taskId).id === p.id))

  if (mine.length === 0 && runs.length === 0) {
    return <div className="rounded-lg border border-dashed border-line px-4 py-6 text-center text-[12.5px] text-faint">No activity on this day</div>
  }

  return (
    <div className="rounded-lg border border-line bg-panel/60 p-4">
      <div className="grid grid-cols-[64px_1fr] gap-y-2">
        <div />
        <div className="relative h-4">
          {hoursShown.map((h) => (
            <span
              key={h}
              className="absolute -translate-x-1/2 text-[10.5px] whitespace-nowrap text-faint tabular-nums"
              style={{ left: `${((h - startH) * 100) / span}%` }}
            >
              {hourLabel(day, h)}
            </span>
          ))}
        </div>
        <div className="pt-1 text-[11.5px] text-muted">You</div>
        <div className="relative h-7">
          <HourLines hours={hoursShown} startH={startH} span={span} />
          {mine.map((s) => (
            <div
              key={s.start}
              className="absolute top-0 h-5 rounded-[4px]"
              style={{ left: x(s.start), width: w(s), background: colorOf(a, s.taskId) }}
              {...bind(() => <SpanTip a={a} s={s} label="Prompting" />)}
            />
          ))}
          {events.map((e) => (
            <div
              key={`${e.taskId}-${e.at}-${e.kind}`}
              className="absolute top-5 h-2 w-[2px] -translate-x-1/2 rounded-full bg-fg/70"
              style={{ left: x(e.at) }}
              {...bind(() => (
                <>
                  <div className="text-muted tabular-nums">
                    {clock(e.at)} · <span className="font-mono">{a.tasks[e.taskId]?.key}</span>
                  </div>
                  <div className="mt-0.5 line-clamp-4">{e.kind === "prompt" ? e.text : EVENT_LABEL[e.kind]}</div>
                </>
              ))}
            />
          ))}
        </div>
        <div className="pt-0.5 text-[11.5px] text-muted">Agents</div>
        <div className="relative space-y-[2px]">
          <HourLines hours={hoursShown} startH={startH} span={span} />
          {runLanes.length === 0 && <div className="h-3" />}
          {numbered(runLanes).map(({ n, value: lane }) => (
            <div key={n} className="relative h-3">
              {lane.map((s) => (
                <div
                  key={s.start}
                  className="absolute top-0 h-3 rounded-[3px] opacity-60"
                  style={{ left: x(s.start), width: w(s), background: colorOf(a, s.taskId) }}
                  {...bind(() => <SpanTip a={a} s={s} label={s.running ? "Agent running" : "Agent ran"} />)}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
      <Legend projects={shownProjects}>
        <span className="text-faint">Ticks mark prompts</span>
      </Legend>
      {node}
    </div>
  )
}

function HourLines({ hours, startH, span }: { hours: number[]; startH: number; span: number }) {
  return (
    <>
      {hours.map((h) => (
        <div
          key={h}
          className="pointer-events-none absolute -top-1 -bottom-1 border-l border-white/[0.05]"
          style={{ left: `${((h - startH) * 100) / span}%` }}
        />
      ))}
    </>
  )
}
