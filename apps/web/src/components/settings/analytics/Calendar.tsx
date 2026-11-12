import { clsx } from "clsx"
import { useEffect, useMemo, useRef, useState } from "react"
import { addDays, dayKey, hm, HOUR, localDay, mergeSpans, NEUTRAL, partsOf, splitByDay, startOfDay, totalsByTask, type RunSpan, type Span } from "./analytics"
import { Swatch, useTip } from "../chart"
import { localeDateString } from "../../ui/dates"
import { type View } from "./useView"
import { projectOf, colorOf, hourLabel, SpanTip, Legend, numbered, todayKey } from "./shared"
import { TaskTable, PromptLog } from "./Report"
import { lanes, DayTimeline } from "./DayTimeline"

// 1 January 2024 was a Monday.
const WEEKDAYS = Array.from({ length: 7 }, (_, i) => localeDateString(localDay(2024, 1, 1 + i), { weekday: "short" }))

/** Active time per day and project, and prompts per day. */
function useDays(view: View) {
  return useMemo(() => {
    const a = view.data
    const byDay = new Map<string, { total: number; prompts: number; projects: Map<string, number> }>()
    const get = (k: string) => {
      let d = byDay.get(k)
      if (!d) byDay.set(k, (d = { total: 0, prompts: 0, projects: new Map() }))
      return d
    }
    for (const s of view.spans.flatMap(splitByDay)) {
      const d = get(dayKey(s.start))
      const pid = projectOf(a, s.taskId).id
      d.total += s.end - s.start
      d.projects.set(pid, (d.projects.get(pid) ?? 0) + s.end - s.start)
    }
    for (const e of view.events) get(dayKey(e.at)).prompts++
    return byDay
  }, [view])
}

export function MonthGrid({ view, anchor, selected, onSelect }: { view: View; anchor: number; selected: number | null; onSelect: (d: number) => void }) {
  const a = view.data
  const byDay = useDays(view)
  const month = partsOf(anchor).month
  const days: number[] = []
  for (let d = a.from; d < a.to; d = addDays(d, 1)) days.push(d)
  const max = Math.max(HOUR, ...[...byDay.values()].map((d) => d.total))
  const today = todayKey()
  const monthTotal = days.filter((d) => partsOf(d).month === month).reduce((n, d) => n + (byDay.get(dayKey(d))?.total ?? 0), 0)

  return (
    <section>
      <div className="mb-2 flex items-baseline gap-2">
        <h2 className="text-[13px] font-medium">{localeDateString(anchor, { month: "long" })}</h2>
        <span className="text-[12px] text-faint tabular-nums">{hm(monthTotal)} active</span>
      </div>
      <div className="overflow-hidden rounded-lg border border-line">
        <div className="grid grid-cols-7 border-b border-line bg-panel text-[11px] text-faint">
          {WEEKDAYS.map((w) => (
            <div key={w} className="px-2 py-1.5">
              {w}
            </div>
          ))}
        </div>
        <div className="grid grid-cols-7 gap-px bg-line">
          {days.map((d) => {
            const k = dayKey(d)
            const info = byDay.get(k)
            const inMonth = partsOf(d).month === month
            const top = info ? [...info.projects.entries()].toSorted((x, y) => y[1] - x[1]) : []
            return (
              <button
                key={d}
                onClick={() => onSelect(d)}
                className={clsx(
                  "flex min-h-24 flex-col gap-1 p-2 text-left transition-colors",
                  inMonth ? "bg-panel hover:bg-raised" : "bg-bg hover:bg-panel",
                  selected === d && "ring-1 ring-accent ring-inset",
                )}
              >
                <span className="flex items-center gap-1.5 text-[11.5px]">
                  <span
                    className={clsx(
                      "flex h-5 min-w-5 items-center justify-center rounded-full tabular-nums",
                      k === today ? "bg-accent-strong px-1 text-white" : inMonth ? "text-muted" : "text-faint/60",
                    )}
                  >
                    {partsOf(d).day}
                  </span>
                  {info && info.total > 0 && <span className={clsx("ml-auto font-medium tabular-nums", !inMonth && "text-muted")}>{hm(info.total)}</span>}
                </span>
                {info && info.total > 0 && (
                  <>
                    {/* How full the day was, against the busiest day shown. */}
                    <span className="flex h-1 w-full gap-[2px] overflow-hidden rounded-full bg-white/[0.05]" style={{ width: `${(info.total * 100) / max}%` }}>
                      {top.map(([pid, ms]) => (
                        <span key={pid} className="h-full" style={{ flex: ms, background: a.projects[pid]?.color ?? NEUTRAL }} />
                      ))}
                    </span>
                    {top.slice(0, 3).map(([pid, ms]) => (
                      <span key={pid} className="flex items-center gap-1.5 text-[11px] text-muted">
                        <Swatch color={a.projects[pid]?.color ?? NEUTRAL} className="h-2 w-2" />
                        <span className="min-w-0 flex-1 truncate">{a.projects[pid]?.name}</span>
                        <span className="tabular-nums text-faint">{hm(ms)}</span>
                      </span>
                    ))}
                    {top.length > 3 && <span className="text-[10.5px] text-faint">+{top.length - 3} more</span>}
                  </>
                )}
                {info && info.prompts > 0 && (
                  <span className="mt-auto text-[10.5px] text-faint">
                    {info.prompts} prompt{info.prompts === 1 ? "" : "s"}
                  </span>
                )}
              </button>
            )
          })}
        </div>
      </div>
    </section>
  )
}

const HOUR_PX = 36

/** The hour before the earliest of `blocks`, or 7am without any. */
function firstHourOf(blocks: Span[]) {
  const hs = blocks.map((b) => (b.start - startOfDay(b.start)) / HOUR)
  return Math.max(0, Math.floor(hs.length ? Math.min(...hs) : 8) - 1)
}

export function WeekGrid({ view, from, selected, onSelect }: { view: View; from: number; selected: number | null; onSelect: (d: number) => void }) {
  const { bind, node } = useTip()
  const a = view.data
  const byDay = useDays(view)
  const scroller = useRef<HTMLDivElement>(null)
  const days = Array.from({ length: 7 }, (_, i) => addDays(from, i))
  const blocks = mergeSpans(view.spans).flatMap(splitByDay)
  const runs = view.runs.flatMap(splitByDay)
  const today = todayKey()

  // Open at the start of the earliest work this week (or 8am), worked out again for another week or what was loaded.
  const [opened, setOpened] = useState(() => ({ from, data: view.data, firstHour: firstHourOf(blocks) }))
  if (opened.from !== from || opened.data !== view.data) setOpened({ from, data: view.data, firstHour: firstHourOf(blocks) })
  const firstHour = opened.firstHour
  useEffect(() => {
    scroller.current?.scrollTo({ top: Math.max(0, firstHour * HOUR_PX - 8) })
  }, [firstHour])

  const pos = (s: Span) => {
    const d0 = startOfDay(s.start)
    // Less a pixel, so back-to-back blocks keep a gap between them.
    return { top: ((s.start - d0) / HOUR) * HOUR_PX, height: Math.max(3, ((s.end - s.start) / HOUR) * HOUR_PX - 1) }
  }

  return (
    <section className="rounded-lg border border-line bg-panel/60">
      <div className="grid grid-cols-[48px_repeat(7,minmax(0,1fr))] border-b border-line">
        <div />
        {days.map((d) => {
          const info = byDay.get(dayKey(d))
          return (
            <button
              key={d}
              onClick={() => onSelect(d)}
              className={clsx("border-l border-line px-2 py-1.5 text-left hover:bg-raised", selected === d && "bg-raised")}
            >
              <div className={clsx("text-[11.5px]", dayKey(d) === today ? "font-medium text-accent" : "text-muted")}>
                {localeDateString(d, { weekday: "short", day: "numeric" })}
              </div>
              <div className="text-[12px] font-medium tabular-nums">{info?.total ? hm(info.total) : <span className="text-faint">—</span>}</div>
            </button>
          )
        })}
      </div>
      <div ref={scroller} className="relative max-h-[560px] overflow-y-auto">
        <div className="relative grid grid-cols-[48px_repeat(7,minmax(0,1fr))]" style={{ height: 24 * HOUR_PX }}>
          <div className="relative">
            {Array.from({ length: 24 }, (_, h) => (
              <span key={h} className="absolute right-2 -translate-y-1/2 text-[10.5px] text-faint tabular-nums" style={{ top: h * HOUR_PX }}>
                {h === 0 ? "" : hourLabel(from, h)}
              </span>
            ))}
          </div>
          {days.map((d) => {
            const k = dayKey(d)
            return (
              <div key={d} className={clsx("relative border-l border-line", selected === d && "bg-white/[0.015]")} onClick={() => onSelect(d)}>
                {Array.from({ length: 24 }, (_, h) => (
                  <div key={h} className="absolute right-0 left-0 border-t border-white/[0.04]" style={{ top: h * HOUR_PX }} />
                ))}
                {blocks
                  .filter((b) => dayKey(b.start) === k)
                  .map((b) => {
                    const p = pos(b)
                    const t = a.tasks[b.taskId]
                    return (
                      <div
                        key={b.start}
                        className="absolute right-3 left-1 overflow-hidden rounded-[4px] px-1 text-[10.5px] leading-tight text-white"
                        style={{ top: p.top, height: p.height, background: colorOf(a, b.taskId) }}
                        {...bind(() => <SpanTip a={a} s={b} label="Prompting" />)}
                      >
                        {p.height >= 14 && <span className="font-mono">{t?.kind === "scratch" ? "chat" : t?.key}</span>}
                        {p.height >= 28 && <span className="block truncate opacity-90">{t?.title}</span>}
                      </div>
                    )
                  })}
                {numbered(lanes(runs.filter((r) => dayKey(r.start) === k)).slice(0, 3)).map(({ n: li, value: lane }) =>
                  lane.map((r) => {
                    const p = pos(r)
                    return (
                      <div
                        key={`${li}-${r.start}`}
                        className="absolute w-[3px] rounded-full opacity-70"
                        style={{ top: p.top, height: p.height, right: 2 + li * 4, background: colorOf(a, r.taskId) }}
                        {...bind(() => <SpanTip a={a} s={r} label={r.running ? "Agent running" : "Agent ran"} />)}
                      />
                    )
                  }),
                )}
              </div>
            )
          })}
        </div>
      </div>
      <div className="border-t border-line px-3 py-2">
        <Legend projects={Object.values(a.projects).filter((p) => blocks.some((b) => projectOf(a, b.taskId).id === p.id))}>
          <span className="text-faint">Blocks: you prompting · thin bars: agents running</span>
        </Legend>
      </div>
      {node}
    </section>
  )
}

export function DayDetail({ view, day }: { view: View; day: number }) {
  const a = view.data
  const end = addDays(day, 1)
  const dayView = useMemo<View>(() => {
    const clip = <T extends Span>(s: T): T | null => {
      const start = Math.max(s.start, day)
      const e = Math.min(s.end, end)
      return e > start ? { ...s, start, end: e } : null
    }
    const spans = view.spans.map(clip).filter((s): s is Span => !!s)
    const runs = view.runs.map(clip).filter((s): s is RunSpan => !!s)
    const events = view.events.filter((e) => e.at >= day && e.at < end)
    return { data: { ...a, from: day, to: end }, spans, runs, events, totals: totalsByTask(events, spans, runs) }
  }, [view, a, day, end])

  return (
    <section className="space-y-4">
      <h2 className="text-[13px] font-medium">{localeDateString(day, { weekday: "long", day: "numeric", month: "long", year: "numeric" })}</h2>
      <DayTimeline view={dayView} day={day} />
      {(dayView.events.length > 0 || dayView.runs.length > 0) && (
        <>
          <TaskTable view={dayView} />
          <PromptLog key={day} events={dayView.events} a={a} open title="Prompts" />
        </>
      )}
    </section>
  )
}
