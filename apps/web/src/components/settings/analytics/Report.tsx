import { clsx } from "clsx"
import { ChevronDown } from "lucide-react"
import { useState, type ReactNode } from "react"
import { addDays, dayKey, hm, HOUR, splitByDay, type Activity, type AEvent, type AProject, type TaskTotals } from "./analytics"
import { Swatch, useTip } from "../chart"
import { type View } from "./useView"
import { projectOf, colorOf, clock, openTask, Legend, EVENT_LABEL, todayKey } from "./shared"
import { DayTimeline } from "./DayTimeline"

export function Report({ view }: { view: View }) {
  const days = Math.round((view.data.to - view.data.from) / (24 * HOUR))
  return (
    <>
      <Tiles view={view} />
      <section>
        <h2 className="mb-2 text-[13px] font-medium">{days <= 1 ? "Timeline" : "Active time per day"}</h2>
        {days <= 1 ? <DayTimeline view={view} day={view.data.from} /> : <DailyChart view={view} />}
      </section>
      <TaskTable view={view} />
      <PromptLog events={view.events} a={view.data} />
    </>
  )
}

const tile = (label: string, value: string, hint: string, hero = false) => (
  <div className="rounded-lg border border-line bg-panel/60 px-4 py-3">
    <div className="text-[11.5px] text-faint">{label}</div>
    <div className={clsx("mt-1 font-semibold", hero ? "text-[26px] leading-8" : "text-[20px] leading-8")}>{value}</div>
    <div className="mt-0.5 text-[11.5px] text-faint">{hint}</div>
  </div>
)

function Tiles({ view }: { view: View }) {
  const active = view.spans.reduce((n, s) => n + s.end - s.start, 0)
  const agent = view.runs.reduce((n, s) => n + s.end - s.start, 0)
  const tasks = [...view.totals.values()].filter((t) => t.prompts > 0 || t.active > 0).length
  const days = new Set(view.spans.flatMap(splitByDay).map((s) => dayKey(s.start))).size
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      {tile("Active time", hm(active), days ? `over ${days} day${days === 1 ? "" : "s"}` : "no activity", true)}
      {tile("Prompts", String(view.events.length), `${view.events.filter((e) => e.kind === "prompt").length} typed`)}
      {tile("Tasks", String(tasks), "prompted or worked on")}
      {tile("Agent time", hm(agent), `${view.runs.length} run${view.runs.length === 1 ? "" : "s"}`)}
    </div>
  )
}

/** Ticks for a 0..max hours axis: at most four, on a readable step. */
function hourTicks(maxMs: number) {
  const maxH = Math.max(maxMs / HOUR, 1)
  const step = [0.5, 1, 2, 3, 4, 6, 8, 12].find((s) => maxH / s <= 4) ?? 12
  const top = Math.ceil(maxH / step) * step
  const ticks = []
  for (let h = 0; h <= top + 1e-9; h += step) ticks.push(h)
  return { top: top * HOUR, ticks }
}

function DailyChart({ view }: { view: View }) {
  const { bind, node } = useTip()
  const a = view.data
  const days: number[] = []
  for (let d = a.from; d < a.to; d = addDays(d, 1)) days.push(d)
  const order = Object.values(a.projects)
  const perDay = new Map<string, Map<string, number>>()
  for (const s of view.spans.flatMap(splitByDay)) {
    const k = dayKey(s.start)
    const pid = projectOf(a, s.taskId).id
    const m = perDay.get(k) ?? new Map<string, number>()
    m.set(pid, (m.get(pid) ?? 0) + s.end - s.start)
    perDay.set(k, m)
  }
  const totals = days.map((d) => [...(perDay.get(dayKey(d))?.values() ?? [])].reduce((x, y) => x + y, 0))
  const { top, ticks } = hourTicks(Math.max(0, ...totals))
  const shown = order.filter((p) => days.some((d) => perDay.get(dayKey(d))?.has(p.id)))
  const every = Math.ceil(days.length / 16)
  const today = todayKey()

  return (
    <div className="rounded-lg border border-line bg-panel/60 p-4">
      <div className="relative h-52 pl-9">
        {ticks.map((h) => (
          <div key={h} className="absolute right-0 left-9 border-t border-white/[0.06]" style={{ bottom: `${(h * HOUR * 100) / top}%` }}>
            <span className="absolute -top-2 -left-9 w-7 text-right text-[10.5px] text-faint tabular-nums">{h}h</span>
          </div>
        ))}
        <div className="relative flex h-full items-end gap-[2px]">
          {days.map((d, i) => {
            const m = perDay.get(dayKey(d))
            const segs = order.filter((p) => m?.has(p.id)).map((p) => ({ p, ms: m?.get(p.id) ?? 0 }))
            return (
              <div
                key={d}
                className="group flex h-full min-w-0 flex-1 cursor-default flex-col-reverse gap-[2px] rounded-sm hover:bg-white/[0.03]"
                {...bind(() => (
                  <>
                    <div className="mb-1 font-medium">{new Date(d).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}</div>
                    {segs.length === 0 && <div className="text-faint">No activity</div>}
                    {segs.map(({ p, ms }) => (
                      <div key={p.id} className="flex items-center gap-1.5">
                        <Swatch color={p.color} />
                        <span className="min-w-0 flex-1 truncate text-muted">{p.name}</span>
                        <span className="pl-3 tabular-nums">{hm(ms)}</span>
                      </div>
                    ))}
                    {segs.length > 1 && <div className="mt-1 border-t border-line pt-1 text-right tabular-nums">{hm(totals[i] ?? 0)}</div>}
                  </>
                ))}
              >
                {segs.map(({ p, ms }, j) => (
                  <div
                    key={p.id}
                    className={clsx("w-full shrink-0", j === segs.length - 1 && "rounded-t-[4px]")}
                    style={{ height: `calc(${(ms * 100) / top}% - 2px)`, minHeight: 2, background: p.color }}
                  />
                ))}
              </div>
            )
          })}
        </div>
      </div>
      <div className="mt-1 flex gap-[2px] pl-9">
        {days.map((d, i) => {
          const date = new Date(d)
          return (
            <div key={d} className={clsx("min-w-0 flex-1 text-center text-[10.5px] tabular-nums", dayKey(d) === today ? "text-fg" : "text-faint")}>
              {i % every === 0 ? (days.length <= 7 ? date.toLocaleDateString(undefined, { weekday: "short", day: "numeric" }) : date.getDate()) : ""}
            </div>
          )
        })}
      </div>
      {shown.length > 0 && <Legend projects={shown} />}
      {node}
    </div>
  )
}

const when = (t: number | null) =>
  t === null ? "" : new Date(t).toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })

export function TaskTable({ view }: { view: View }) {
  const a = view.data
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const groups = new Map<string, { project: AProject; rows: TaskTotals[]; active: number; agent: number; prompts: number }>()
  for (const t of view.totals.values()) {
    const p = projectOf(a, t.taskId)
    const g = groups.get(p.id) ?? { project: p, rows: [], active: 0, agent: 0, prompts: 0 }
    g.rows.push(t)
    g.active += t.active
    g.agent += t.agent
    g.prompts += t.prompts
    groups.set(p.id, g)
  }
  const sorted = [...groups.values()].toSorted((x, y) => y.active - x.active || y.agent - x.agent)
  const total = sorted.reduce((n, g) => ({ active: n.active + g.active, agent: n.agent + g.agent, prompts: n.prompts + g.prompts }), {
    active: 0,
    agent: 0,
    prompts: 0,
  })
  return (
    <section>
      <h2 className="mb-2 text-[13px] font-medium">By project and task</h2>
      {sorted.length === 0 ? (
        <div className="rounded-lg border border-dashed border-line px-4 py-6 text-center text-[12.5px] text-faint">No prompts or agent runs in this range</div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-line">
          <table className="w-full text-[12.5px]">
            <thead className="bg-panel text-left text-[11.5px] text-faint">
              <tr>
                <th className="px-3 py-2 font-normal">Task</th>
                <th className="w-20 px-3 py-2 text-right font-normal">Prompts</th>
                <th className="w-24 px-3 py-2 text-right font-normal">Active</th>
                <th className="w-24 px-3 py-2 text-right font-normal">Agent</th>
                <th className="hidden w-36 px-3 py-2 font-normal lg:table-cell">First prompt</th>
                <th className="hidden w-36 px-3 py-2 font-normal lg:table-cell">Last prompt</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {sorted.map((g) => (
                <ProjectRows
                  key={g.project.id}
                  collapsed={!!collapsed[g.project.id]}
                  onToggle={() => setCollapsed({ ...collapsed, [g.project.id]: !collapsed[g.project.id] })}
                  g={g}
                >
                  {g.rows
                    .toSorted((x, y) => y.active - x.active || y.agent - x.agent)
                    .map((r) => {
                      const t = a.tasks[r.taskId]
                      return (
                        <tr key={r.taskId} className={clsx("bg-bg/40", t && "cursor-pointer hover:bg-raised")} onClick={() => openTask(t)}>
                          <td className="py-1.5 pr-3 pl-9">
                            <span className="mr-2 font-mono text-[11.5px] text-faint">{t?.kind === "scratch" ? "chat" : (t?.key ?? "")}</span>
                            <span className={clsx(!t && "text-faint italic")}>{t?.title || (t ? "Untitled" : "Deleted task")}</span>
                          </td>
                          <td className="px-3 py-1.5 text-right tabular-nums text-muted">{r.prompts || ""}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums">{r.active ? hm(r.active) : ""}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums text-muted">{r.agent ? hm(r.agent) : ""}</td>
                          <td className="hidden px-3 py-1.5 text-faint tabular-nums lg:table-cell">{when(r.first)}</td>
                          <td className="hidden px-3 py-1.5 text-faint tabular-nums lg:table-cell">{when(r.last)}</td>
                        </tr>
                      )
                    })}
                </ProjectRows>
              ))}
              <tr className="bg-panel font-medium">
                <td className="px-3 py-2">Total</td>
                <td className="px-3 py-2 text-right tabular-nums">{total.prompts}</td>
                <td className="px-3 py-2 text-right tabular-nums">{hm(total.active)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{hm(total.agent)}</td>
                <td className="hidden lg:table-cell" colSpan={2} />
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function ProjectRows({
  g,
  collapsed,
  onToggle,
  children,
}: {
  g: { project: AProject; rows: TaskTotals[]; active: number; agent: number; prompts: number }
  collapsed: boolean
  onToggle: () => void
  children: ReactNode
}) {
  return (
    <>
      <tr className="cursor-pointer bg-panel/60 hover:bg-raised" onClick={onToggle}>
        <td className="px-3 py-2">
          <span className="flex items-center gap-2">
            <ChevronDown size={13} className={clsx("text-faint transition-transform", collapsed && "-rotate-90")} />
            <Swatch color={g.project.color} />
            <span className="font-medium">{g.project.name}</span>
            <span className="text-[11.5px] text-faint">
              {g.rows.length} {g.rows.length === 1 ? "thread" : "threads"}
            </span>
          </span>
        </td>
        <td className="px-3 py-2 text-right tabular-nums">{g.prompts}</td>
        <td className="px-3 py-2 text-right font-medium tabular-nums">{hm(g.active)}</td>
        <td className="px-3 py-2 text-right tabular-nums text-muted">{hm(g.agent)}</td>
        <td className="hidden lg:table-cell" colSpan={2} />
      </tr>
      {!collapsed && children}
    </>
  )
}

export function PromptLog({ events, a, open: initiallyOpen = false, title = "Prompt log" }: { events: AEvent[]; a: Activity; open?: boolean; title?: string }) {
  const [open, setOpen] = useState(initiallyOpen)
  const [all, setAll] = useState(false)
  const list = events.toReversed()
  const shown = all ? list : list.slice(0, 100)
  const multiDay = events.length > 0 && dayKey(events[0]?.at ?? 0) !== dayKey(events.at(-1)?.at ?? 0)
  return (
    <section>
      <button className="mb-2 flex items-center gap-1.5 text-[13px] font-medium" onClick={() => setOpen(!open)}>
        <ChevronDown size={13} className={clsx("text-faint transition-transform", !open && "-rotate-90")} />
        {title}
        <span className="font-normal text-faint">· {events.length}</span>
      </button>
      {open &&
        (events.length === 0 ? (
          <div className="rounded-lg border border-dashed border-line px-4 py-5 text-center text-[12.5px] text-faint">No prompts</div>
        ) : (
          <div className="divide-y divide-line overflow-hidden rounded-lg border border-line">
            {shown.map((e) => {
              const t = a.tasks[e.taskId]
              return (
                <button
                  key={`${e.taskId}-${e.at}-${e.kind}`}
                  onClick={() => openTask(t)}
                  className="flex w-full items-start gap-3 bg-panel/60 px-3 py-2 text-left hover:bg-raised"
                >
                  <span className="w-28 shrink-0 pt-px text-[11.5px] text-faint tabular-nums">
                    {multiDay ? new Date(e.at).toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : clock(e.at)}
                  </span>
                  <Swatch color={colorOf(a, e.taskId)} className="mt-1" />
                  <span className="w-24 shrink-0 truncate pt-px font-mono text-[11.5px] text-faint">{t?.kind === "scratch" ? "chat" : t?.key}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12.5px]">{t?.title ?? "Deleted task"}</span>
                    <span className={clsx("line-clamp-2 text-[12px]", e.kind === "prompt" ? "text-muted" : "text-faint italic")}>
                      {e.kind === "prompt" ? e.text : EVENT_LABEL[e.kind]}
                    </span>
                  </span>
                </button>
              )
            })}
            {!all && list.length > shown.length && (
              <button className="w-full bg-panel/60 px-3 py-2 text-center text-[12px] text-muted hover:bg-raised hover:text-fg" onClick={() => setAll(true)}>
                Show all {list.length}
              </button>
            )}
          </div>
        ))}
    </section>
  )
}
