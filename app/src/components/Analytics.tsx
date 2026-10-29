import clsx from "clsx";
import { ChevronDown, ChevronLeft, ChevronRight, Download, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  activeSpans,
  addDays,
  addMonths,
  dayKey,
  hm,
  HOUR,
  loadActivity,
  mergeSpans,
  NEUTRAL,
  SCRATCH,
  splitByDay,
  startOfDay,
  startOfMonth,
  startOfWeek,
  toCsv,
  totalsByTask,
  type Activity,
  type AEvent,
  type AProject,
  type ATask,
  type Rules,
  type RunSpan,
  type Span,
  type TaskTotals,
} from "../analytics";
import { navigate } from "../router";
import { useStore } from "../store";
import { Swatch, useTip } from "./chart";
import { DiskUsage } from "./DiskUsage";
import { Button, IconButton } from "./ui";

const selectClass = "h-7 rounded-md border border-line bg-panel px-1.5 text-[12.5px] text-fg outline-none";

type Preset = "today" | "yesterday" | "this_week" | "last_week" | "this_month" | "last_month" | "last_7" | "last_30" | "custom";
const PRESETS: { id: Preset; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "yesterday", label: "Yesterday" },
  { id: "this_week", label: "This week" },
  { id: "last_week", label: "Last week" },
  { id: "this_month", label: "This month" },
  { id: "last_month", label: "Last month" },
  { id: "last_7", label: "Last 7 days" },
  { id: "last_30", label: "Last 30 days" },
  { id: "custom", label: "Custom…" },
];

type Range = { from: number; to: number };

const parseDay = (s: string) => {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1).getTime();
};

function presetRange(p: Preset, custom: { from: string; to: string }): Range {
  const today = startOfDay(Date.now());
  const week = startOfWeek(today);
  const month = startOfMonth(today);
  switch (p) {
    case "today":
      return { from: today, to: addDays(today, 1) };
    case "yesterday":
      return { from: addDays(today, -1), to: today };
    case "this_week":
      return { from: week, to: addDays(week, 7) };
    case "last_week":
      return { from: addDays(week, -7), to: week };
    case "this_month":
      return { from: month, to: addMonths(month, 1) };
    case "last_month":
      return { from: addMonths(month, -1), to: month };
    case "last_7":
      return { from: addDays(today, -6), to: addDays(today, 1) };
    case "last_30":
      return { from: addDays(today, -29), to: addDays(today, 1) };
    case "custom": {
      const a = parseDay(custom.from);
      const b = parseDay(custom.to);
      return { from: Math.min(a, b), to: addDays(Math.max(a, b), 1) };
    }
  }
}

function usePersisted<T>(key: string, initial: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      const s = localStorage.getItem(key);
      return s ? (JSON.parse(s).value ?? initial) : initial;
    } catch {
      return initial;
    }
  });
  const set = (next: T) => {
    setV(next);
    try {
      localStorage.setItem(key, JSON.stringify({ value: next }));
    } catch {
      // Private mode: the choice just isn't remembered.
    }
  };
  return [v, set];
}

function useActivity(range: Range, rules: Rules, enabled: boolean) {
  const profilesKey = useStore((s) => s.profiles.map((p) => `${p.host_id}:${p.id}`).join(","));
  const hostsKey = useStore((s) => s.hosts.map((h) => `${h.id}:${h.connected}:${h.api_version}`).join(","));
  const [data, setData] = useState<Activity | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setLoading(true);
    loadActivity(range.from, range.to, rules)
      .then((d) => {
        if (cancelled) return;
        setData(d);
        setError(null);
      })
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
    // Only the idle gap changes what's fetched; the lead-in is applied afterwards.
  }, [range.from, range.to, rules.idleMin, profilesKey, hostsKey, nonce, enabled]);
  return { data, loading, error, reload: () => setNonce((n) => n + 1) };
}

/** What a range shows once the project filter is applied. */
interface View {
  data: Activity;
  spans: Span[];
  events: AEvent[];
  runs: RunSpan[];
  totals: Map<string, TaskTotals>;
}

function useView(data: Activity | null, rules: Rules, project: string): View | null {
  return useMemo(() => {
    if (!data) return null;
    const keep = (id: string) => project === "all" || (data.tasks[id]?.projectId ?? SCRATCH) === project;
    const spans = activeSpans(data, rules).filter((s) => keep(s.taskId));
    const events = data.events.filter((e) => e.at >= data.from && e.at < data.to && keep(e.taskId));
    const runs = data.runs.filter((r) => keep(r.taskId));
    return { data, spans, events, runs, totals: totalsByTask(events, spans, runs) };
  }, [data, rules, project]);
}

const projectOf = (a: Activity, taskId: string): AProject => a.projects[a.tasks[taskId]?.projectId ?? SCRATCH] ?? a.projects[SCRATCH];
const colorOf = (a: Activity, taskId: string) => projectOf(a, taskId)?.color ?? NEUTRAL;
const hourLabel = (day: number, h: number) => new Date(new Date(day).setHours(h, 0, 0, 0)).toLocaleTimeString([], { hour: "numeric" });
const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

function openTask(t: ATask | undefined) {
  if (!t) return;
  navigate({ name: "task", taskId: t.id });
}

function SpanTip({ a, s, label }: { a: Activity; s: Span; label: string }) {
  const t = a.tasks[s.taskId];
  const p = projectOf(a, s.taskId);
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
  );
}

// ---------- page ----------

export function Analytics() {
  const [tab, setTab] = usePersisted<"report" | "calendar" | "disk">("ia.analytics.tab", "report");
  const [preset, setPreset] = usePersisted<Preset>("ia.analytics.preset", "this_week");
  const [custom, setCustom] = usePersisted("ia.analytics.custom", { from: dayKey(addDays(Date.now(), -6)), to: dayKey(Date.now()) });
  const [rules, setRules] = usePersisted<Rules>("ia.analytics.rules", { idleMin: 30, leadMin: 5 });
  const [project, setProject] = useState("all");
  const [calMode, setCalMode] = usePersisted<"month" | "week">("ia.analytics.calMode", "month");
  const [anchor, setAnchor] = useState(() => startOfDay(Date.now()));
  const [selected, setSelected] = useState<number | null>(() => startOfDay(Date.now()));

  const range = useMemo<Range>(() => {
    if (tab === "report") return presetRange(preset, custom);
    if (calMode === "week") {
      const from = startOfWeek(anchor);
      return { from, to: addDays(from, 7) };
    }
    // The whole grid, including the days of the neighbouring months it shows.
    const from = startOfWeek(startOfMonth(anchor));
    return { from, to: addDays(startOfWeek(addDays(addMonths(startOfMonth(anchor), 1), -1)), 7) };
  }, [tab, preset, custom, calMode, anchor]);

  const { data, loading, error, reload } = useActivity(range, rules, tab !== "disk");
  const view = useView(data, rules, project);
  const projects = data ? Object.values(data.projects).filter((p) => p.id !== SCRATCH) : [];

  const exportCsv = () => {
    if (!view) return;
    const blob = new Blob([toCsv(view.data, view.events, view.spans, view.runs)], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `prompt-activity-${dayKey(range.from)}-to-${dayKey(range.to - 1)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const switchCal = (m: "month" | "week") => {
    // Show the picked day in the new view.
    if (selected !== null) setAnchor(selected);
    setCalMode(m);
  };

  const step = (n: number) => {
    const next = calMode === "week" ? addDays(anchor, 7 * n) : addMonths(anchor, n);
    setAnchor(next);
    setSelected(null);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="drag flex h-12 shrink-0 items-center gap-3 border-b border-line px-5">
        <h1 className="text-[14px] font-semibold">Analytics</h1>
        <div className="no-drag flex items-center gap-1 rounded-lg border border-line bg-panel p-0.5">
          {(["report", "calendar", "disk"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={clsx("rounded-md px-2.5 py-1 text-[12px] capitalize", tab === t ? "bg-raised text-fg" : "text-muted hover:text-fg")}
            >
              {t}
            </button>
          ))}
        </div>
        {loading && tab !== "disk" && <span className="text-[11.5px] text-faint">Loading…</span>}
      </header>

      {tab === "disk" ? (
        <DiskUsage />
      ) : (
        <>
          {/* Filters: one row above everything they apply to. */}
          <div className="flex flex-wrap items-center gap-2 border-b border-line px-5 py-2">
            {tab === "report" ? (
              <>
                <select className={selectClass} value={preset} onChange={(e) => setPreset(e.target.value as Preset)} title="Time range">
                  {PRESETS.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
                {preset === "custom" && (
                  <span className="flex items-center gap-1.5 text-[12px] text-faint">
                    <input type="date" className={selectClass} value={custom.from} onChange={(e) => e.target.value && setCustom({ ...custom, from: e.target.value })} />
                    to
                    <input type="date" className={selectClass} value={custom.to} onChange={(e) => e.target.value && setCustom({ ...custom, to: e.target.value })} />
                  </span>
                )}
                {preset !== "custom" && <span className="text-[12px] text-faint tabular-nums">{rangeLabel(range)}</span>}
              </>
            ) : (
              <>
                <div className="flex items-center gap-1 rounded-lg border border-line bg-panel p-0.5">
                  {(["month", "week"] as const).map((m) => (
                    <button
                      key={m}
                      onClick={() => switchCal(m)}
                      className={clsx("rounded-md px-2 py-0.5 text-[12px] capitalize", calMode === m ? "bg-raised text-fg" : "text-muted hover:text-fg")}
                    >
                      {m}
                    </button>
                  ))}
                </div>
                <IconButton title="Previous" onClick={() => step(-1)}>
                  <ChevronLeft size={15} />
                </IconButton>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setAnchor(startOfDay(Date.now()));
                    setSelected(startOfDay(Date.now()));
                  }}
                >
                  Today
                </Button>
                <IconButton title="Next" onClick={() => step(1)}>
                  <ChevronRight size={15} />
                </IconButton>
                <span className="text-[13px] font-medium">
                  {calMode === "month"
                    ? new Date(anchor).toLocaleDateString(undefined, { month: "long", year: "numeric" })
                    : rangeLabel({ from: startOfWeek(anchor), to: addDays(startOfWeek(anchor), 7) })}
                </span>
              </>
            )}
            <select className={selectClass} value={project} onChange={(e) => setProject(e.target.value)} title="Project">
              <option value="all">All projects</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
              <option value={SCRATCH}>In no project</option>
            </select>
            <div className="ml-auto flex items-center gap-2">
              <label className="flex items-center gap-1.5 text-[12px] text-faint" title="A longer gap between prompts counts as a break">
                Break after
                <select className={selectClass} value={rules.idleMin} onChange={(e) => setRules({ ...rules, idleMin: Number(e.target.value) })}>
                  {[10, 15, 30, 45, 60, 90, 120].map((m) => (
                    <option key={m} value={m}>
                      {hm(m * 60_000)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex items-center gap-1.5 text-[12px] text-faint" title="Time credited to the first prompt after a break">
                First prompt
                <select className={selectClass} value={rules.leadMin} onChange={(e) => setRules({ ...rules, leadMin: Number(e.target.value) })}>
                  {[0, 2, 5, 10, 15].map((m) => (
                    <option key={m} value={m}>
                      {hm(m * 60_000)}
                    </option>
                  ))}
                </select>
              </label>
              <IconButton title="Refresh" onClick={reload}>
                <RefreshCw size={14} className={clsx(loading && "animate-spin")} />
              </IconButton>
              {tab === "report" && (
                <Button size="sm" onClick={exportCsv} disabled={!view} title="Prompts, active and agent hours per day and task">
                  <Download size={13} /> CSV
                </Button>
              )}
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto max-w-6xl space-y-6 p-6">
              {error && <div className="rounded-md border border-red-500/25 bg-red-500/10 px-3 py-2 text-[12.5px] text-red-300">{error}</div>}
              {data?.errors.map((e) => (
                <div key={e} className="rounded-md border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-[12.5px] text-amber-200">
                  {e}
                </div>
              ))}
              {view && tab === "report" && <Report view={view} />}
              {view && tab === "calendar" && (
                <>
                  {calMode === "month" ? (
                    <MonthGrid view={view} anchor={anchor} selected={selected} onSelect={setSelected} />
                  ) : (
                    <WeekGrid view={view} from={range.from} selected={selected} onSelect={setSelected} />
                  )}
                  {selected !== null && selected >= range.from && selected < range.to && <DayDetail view={view} day={selected} />}
                </>
              )}
              <p className="text-[11.5px] leading-relaxed text-faint">
                Active time credits each prompt with the time since your previous prompt on any task, so reading an agent's output and writing the next
                prompt counts toward the task you prompted. Gaps over {hm(rules.idleMin * 60_000)} are breaks; the first prompt after one counts{" "}
                {hm(rules.leadMin * 60_000)}. Prompts are the messages you send, plus starting a task and moving it to Ready for merge. Agent time is how
                long agents ran, including reviews.
              </p>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function rangeLabel(r: Range) {
  const last = addDays(r.to, -1);
  const fmt = (t: number) => new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  return r.from === last ? fmt(r.from) : `${fmt(r.from)} – ${fmt(last)}`;
}

// ---------- report ----------

function Report({ view }: { view: View }) {
  const days = Math.round((view.data.to - view.data.from) / (24 * HOUR));
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
  );
}

function Tiles({ view }: { view: View }) {
  const active = view.spans.reduce((n, s) => n + s.end - s.start, 0);
  const agent = view.runs.reduce((n, s) => n + s.end - s.start, 0);
  const tasks = [...view.totals.values()].filter((t) => t.prompts > 0 || t.active > 0).length;
  const days = new Set(view.spans.flatMap(splitByDay).map((s) => dayKey(s.start))).size;
  const tile = (label: string, value: string, hint: string, hero = false) => (
    <div className="rounded-lg border border-line bg-panel/60 px-4 py-3">
      <div className="text-[11.5px] text-faint">{label}</div>
      <div className={clsx("mt-1 font-semibold", hero ? "text-[26px] leading-8" : "text-[20px] leading-8")}>{value}</div>
      <div className="mt-0.5 text-[11.5px] text-faint">{hint}</div>
    </div>
  );
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      {tile("Active time", hm(active), days ? `over ${days} day${days === 1 ? "" : "s"}` : "no activity", true)}
      {tile("Prompts", String(view.events.length), `${view.events.filter((e) => e.kind === "prompt").length} typed`)}
      {tile("Tasks", String(tasks), "prompted or worked on")}
      {tile("Agent time", hm(agent), `${view.runs.length} run${view.runs.length === 1 ? "" : "s"}`)}
    </div>
  );
}

/** Ticks for a 0..max hours axis: at most four, on a readable step. */
function hourTicks(maxMs: number) {
  const maxH = Math.max(maxMs / HOUR, 1);
  const step = [0.5, 1, 2, 3, 4, 6, 8, 12].find((s) => maxH / s <= 4) ?? 12;
  const top = Math.ceil(maxH / step) * step;
  const ticks = [];
  for (let h = 0; h <= top + 1e-9; h += step) ticks.push(h);
  return { top: top * HOUR, ticks };
}

function DailyChart({ view }: { view: View }) {
  const { bind, node } = useTip();
  const a = view.data;
  const days: number[] = [];
  for (let d = a.from; d < a.to; d = addDays(d, 1)) days.push(d);
  const order = Object.values(a.projects);
  const perDay = new Map<string, Map<string, number>>();
  for (const s of view.spans.flatMap(splitByDay)) {
    const k = dayKey(s.start);
    const pid = projectOf(a, s.taskId).id;
    const m = perDay.get(k) ?? new Map<string, number>();
    m.set(pid, (m.get(pid) ?? 0) + s.end - s.start);
    perDay.set(k, m);
  }
  const totals = days.map((d) => [...(perDay.get(dayKey(d))?.values() ?? [])].reduce((x, y) => x + y, 0));
  const { top, ticks } = hourTicks(Math.max(0, ...totals));
  const shown = order.filter((p) => days.some((d) => perDay.get(dayKey(d))?.has(p.id)));
  const every = Math.ceil(days.length / 16);
  const today = dayKey(Date.now());

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
            const m = perDay.get(dayKey(d));
            const segs = order.filter((p) => m?.has(p.id)).map((p) => ({ p, ms: m!.get(p.id)! }));
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
                    {segs.length > 1 && <div className="mt-1 border-t border-line pt-1 text-right tabular-nums">{hm(totals[i])}</div>}
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
            );
          })}
        </div>
      </div>
      <div className="mt-1 flex gap-[2px] pl-9">
        {days.map((d, i) => {
          const date = new Date(d);
          return (
            <div key={d} className={clsx("min-w-0 flex-1 text-center text-[10.5px] tabular-nums", dayKey(d) === today ? "text-fg" : "text-faint")}>
              {i % every === 0 ? (days.length <= 7 ? date.toLocaleDateString(undefined, { weekday: "short", day: "numeric" }) : date.getDate()) : ""}
            </div>
          );
        })}
      </div>
      {shown.length > 0 && <Legend projects={shown} />}
      {node}
    </div>
  );
}

function Legend({ projects, children }: { projects: AProject[]; children?: ReactNode }) {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px] text-muted">
      {projects.map((p) => (
        <span key={p.id} className="flex items-center gap-1.5">
          <Swatch color={p.color} /> {p.name}
        </span>
      ))}
      {children}
    </div>
  );
}

function TaskTable({ view }: { view: View }) {
  const a = view.data;
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const groups = new Map<string, { project: AProject; rows: TaskTotals[]; active: number; agent: number; prompts: number }>();
  for (const t of view.totals.values()) {
    const p = projectOf(a, t.taskId);
    const g = groups.get(p.id) ?? { project: p, rows: [], active: 0, agent: 0, prompts: 0 };
    g.rows.push(t);
    g.active += t.active;
    g.agent += t.agent;
    g.prompts += t.prompts;
    groups.set(p.id, g);
  }
  const sorted = [...groups.values()].sort((x, y) => y.active - x.active || y.agent - x.agent);
  const total = sorted.reduce((n, g) => ({ active: n.active + g.active, agent: n.agent + g.agent, prompts: n.prompts + g.prompts }), { active: 0, agent: 0, prompts: 0 });
  const when = (t: number | null) =>
    t === null ? "" : new Date(t).toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

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
                <ProjectRows key={g.project.id} collapsed={!!collapsed[g.project.id]} onToggle={() => setCollapsed({ ...collapsed, [g.project.id]: !collapsed[g.project.id] })} g={g}>
                  {g.rows
                    .sort((x, y) => y.active - x.active || y.agent - x.agent)
                    .map((r) => {
                      const t = a.tasks[r.taskId];
                      return (
                        <tr key={r.taskId} className={clsx("bg-bg/40", t && "cursor-pointer hover:bg-raised")} onClick={() => openTask(t)}>
                          <td className="py-1.5 pr-3 pl-9">
                            <span className="mr-2 font-mono text-[11.5px] text-faint">{t?.kind === "scratch" ? "chat" : t?.key ?? ""}</span>
                            <span className={clsx(!t && "text-faint italic")}>{t?.title || (t ? "Untitled" : "Deleted task")}</span>
                          </td>
                          <td className="px-3 py-1.5 text-right tabular-nums text-muted">{r.prompts || ""}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums">{r.active ? hm(r.active) : ""}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums text-muted">{r.agent ? hm(r.agent) : ""}</td>
                          <td className="hidden px-3 py-1.5 text-faint tabular-nums lg:table-cell">{when(r.first)}</td>
                          <td className="hidden px-3 py-1.5 text-faint tabular-nums lg:table-cell">{when(r.last)}</td>
                        </tr>
                      );
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
  );
}

function ProjectRows({
  g,
  collapsed,
  onToggle,
  children,
}: {
  g: { project: AProject; rows: TaskTotals[]; active: number; agent: number; prompts: number };
  collapsed: boolean;
  onToggle: () => void;
  children: ReactNode;
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
  );
}

const EVENT_LABEL: Record<AEvent["kind"], string> = { prompt: "", start: "Started the task", merge: "Moved to Ready for merge" };

function PromptLog({ events, a, open: initiallyOpen = false, title = "Prompt log" }: { events: AEvent[]; a: Activity; open?: boolean; title?: string }) {
  const [open, setOpen] = useState(initiallyOpen);
  const [all, setAll] = useState(false);
  const list = [...events].reverse();
  const shown = all ? list : list.slice(0, 100);
  const multiDay = events.length > 0 && dayKey(events[0].at) !== dayKey(events[events.length - 1].at);
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
            {shown.map((e, i) => {
              const t = a.tasks[e.taskId];
              return (
                <button key={`${e.at}-${i}`} onClick={() => openTask(t)} className="flex w-full items-start gap-3 bg-panel/60 px-3 py-2 text-left hover:bg-raised">
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
              );
            })}
            {!all && list.length > shown.length && (
              <button className="w-full bg-panel/60 px-3 py-2 text-center text-[12px] text-muted hover:bg-raised hover:text-fg" onClick={() => setAll(true)}>
                Show all {list.length}
              </button>
            )}
          </div>
        ))}
    </section>
  );
}

// ---------- timelines ----------

/** Puts overlapping spans in separate lanes. */
function lanes<T extends Span>(spans: T[]): T[][] {
  const out: T[][] = [];
  for (const s of [...spans].sort((x, y) => x.start - y.start)) {
    const lane = out.find((l) => l[l.length - 1].end <= s.start);
    if (lane) lane.push(s);
    else out.push([s]);
  }
  return out;
}

/** One day: when you were prompting (and on what), and when agents ran. */
function DayTimeline({ view, day }: { view: View; day: number }) {
  const { bind, node } = useTip();
  const a = view.data;
  const end = addDays(day, 1);
  const clipTo = <T extends Span>(s: T): T | null => {
    const start = Math.max(s.start, day);
    const e = Math.min(s.end, end);
    return e > start ? { ...s, start, end: e } : null;
  };
  const mine = mergeSpans(view.spans).map(clipTo).filter((s): s is Span => !!s);
  const runs = view.runs.map(clipTo).filter((s): s is RunSpan => !!s);
  const events = view.events.filter((e) => e.at >= day && e.at < end);
  const runLanes = lanes(runs).slice(0, 6);

  // Show the working hours, padded, rather than the whole day.
  const times = [...mine.flatMap((s) => [s.start, s.end]), ...runs.flatMap((s) => [s.start, s.end])];
  const firstH = times.length ? Math.max(0, Math.floor((Math.min(...times) - day) / HOUR) - 1) : 8;
  const lastH = times.length ? Math.min(24, Math.ceil((Math.max(...times) - day) / HOUR) + 1) : 18;
  const span = Math.max(lastH - firstH, 6);
  const startH = Math.max(0, Math.min(firstH, 24 - span));
  const x = (t: number) => `${(((t - day) / HOUR - startH) * 100) / span}%`;
  // Less a pixel, so back-to-back blocks keep a gap between them.
  const w = (s: Span) => `max(2px, calc(${((s.end - s.start) / HOUR / span) * 100}% - 1px))`;
  const hourStep = span > 12 ? 2 : 1;
  const hoursShown: number[] = [];
  for (let h = startH; h <= startH + span; h += hourStep) hoursShown.push(h);
  const shownProjects = Object.values(a.projects).filter((p) => [...mine, ...runs].some((s) => projectOf(a, s.taskId).id === p.id));

  if (mine.length === 0 && runs.length === 0) {
    return <div className="rounded-lg border border-dashed border-line px-4 py-6 text-center text-[12.5px] text-faint">No activity on this day</div>;
  }

  return (
    <div className="rounded-lg border border-line bg-panel/60 p-4">
      <div className="grid grid-cols-[64px_1fr] gap-y-2">
        <div />
        <div className="relative h-4">
          {hoursShown.map((h) => (
            <span key={h} className="absolute -translate-x-1/2 text-[10.5px] whitespace-nowrap text-faint tabular-nums" style={{ left: `${((h - startH) * 100) / span}%` }}>
              {hourLabel(day, h)}
            </span>
          ))}
        </div>
        <div className="pt-1 text-[11.5px] text-muted">You</div>
        <div className="relative h-7">
          <HourLines hours={hoursShown} startH={startH} span={span} />
          {mine.map((s, i) => (
            <div
              key={i}
              className="absolute top-0 h-5 rounded-[4px]"
              style={{ left: x(s.start), width: w(s), background: colorOf(a, s.taskId) }}
              {...bind(() => <SpanTip a={a} s={s} label="Prompting" />)}
            />
          ))}
          {events.map((e, i) => (
            <div
              key={i}
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
          {runLanes.map((lane, i) => (
            <div key={i} className="relative h-3">
              {lane.map((s, j) => (
                <div
                  key={j}
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
  );
}

function HourLines({ hours, startH, span }: { hours: number[]; startH: number; span: number }) {
  return (
    <>
      {hours.map((h) => (
        <div key={h} className="pointer-events-none absolute -top-1 -bottom-1 border-l border-white/[0.05]" style={{ left: `${((h - startH) * 100) / span}%` }} />
      ))}
    </>
  );
}

// ---------- calendar ----------

const WEEKDAYS = Array.from({ length: 7 }, (_, i) => new Date(2024, 0, 1 + i).toLocaleDateString(undefined, { weekday: "short" }));

/** Active time per day and project, and prompts per day. */
function useDays(view: View) {
  return useMemo(() => {
    const a = view.data;
    const byDay = new Map<string, { total: number; prompts: number; projects: Map<string, number> }>();
    const get = (k: string) => {
      let d = byDay.get(k);
      if (!d) byDay.set(k, (d = { total: 0, prompts: 0, projects: new Map() }));
      return d;
    };
    for (const s of view.spans.flatMap(splitByDay)) {
      const d = get(dayKey(s.start));
      const pid = projectOf(a, s.taskId).id;
      d.total += s.end - s.start;
      d.projects.set(pid, (d.projects.get(pid) ?? 0) + s.end - s.start);
    }
    for (const e of view.events) get(dayKey(e.at)).prompts++;
    return byDay;
  }, [view]);
}

function MonthGrid({ view, anchor, selected, onSelect }: { view: View; anchor: number; selected: number | null; onSelect: (d: number) => void }) {
  const a = view.data;
  const byDay = useDays(view);
  const month = new Date(anchor).getMonth();
  const days: number[] = [];
  for (let d = a.from; d < a.to; d = addDays(d, 1)) days.push(d);
  const max = Math.max(HOUR, ...[...byDay.values()].map((d) => d.total));
  const today = dayKey(Date.now());
  const monthTotal = days.filter((d) => new Date(d).getMonth() === month).reduce((n, d) => n + (byDay.get(dayKey(d))?.total ?? 0), 0);

  return (
    <section>
      <div className="mb-2 flex items-baseline gap-2">
        <h2 className="text-[13px] font-medium">{new Date(anchor).toLocaleDateString(undefined, { month: "long" })}</h2>
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
            const k = dayKey(d);
            const info = byDay.get(k);
            const inMonth = new Date(d).getMonth() === month;
            const top = info ? [...info.projects.entries()].sort((x, y) => y[1] - x[1]) : [];
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
                    {new Date(d).getDate()}
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
            );
          })}
        </div>
      </div>
    </section>
  );
}

const HOUR_PX = 36;

function WeekGrid({ view, from, selected, onSelect }: { view: View; from: number; selected: number | null; onSelect: (d: number) => void }) {
  const { bind, node } = useTip();
  const a = view.data;
  const byDay = useDays(view);
  const scroller = useRef<HTMLDivElement>(null);
  const days = Array.from({ length: 7 }, (_, i) => addDays(from, i));
  const blocks = mergeSpans(view.spans).flatMap(splitByDay);
  const runs = view.runs.flatMap(splitByDay);
  const today = dayKey(Date.now());

  // Open at the start of the earliest work this week (or 8am).
  const firstHour = useMemo(() => {
    const hs = blocks.map((b) => (b.start - startOfDay(b.start)) / HOUR);
    return Math.max(0, Math.floor(hs.length ? Math.min(...hs) : 8) - 1);
  }, [from, view.data]);
  useEffect(() => {
    scroller.current?.scrollTo({ top: Math.max(0, firstHour * HOUR_PX - 8) });
  }, [firstHour]);

  const pos = (s: Span) => {
    const d0 = startOfDay(s.start);
    // Less a pixel, so back-to-back blocks keep a gap between them.
    return { top: ((s.start - d0) / HOUR) * HOUR_PX, height: Math.max(3, ((s.end - s.start) / HOUR) * HOUR_PX - 1) };
  };

  return (
    <section className="rounded-lg border border-line bg-panel/60">
      <div className="grid grid-cols-[48px_repeat(7,minmax(0,1fr))] border-b border-line">
        <div />
        {days.map((d) => {
          const info = byDay.get(dayKey(d));
          return (
            <button
              key={d}
              onClick={() => onSelect(d)}
              className={clsx("border-l border-line px-2 py-1.5 text-left hover:bg-raised", selected === d && "bg-raised")}
            >
              <div className={clsx("text-[11.5px]", dayKey(d) === today ? "font-medium text-accent" : "text-muted")}>
                {new Date(d).toLocaleDateString(undefined, { weekday: "short", day: "numeric" })}
              </div>
              <div className="text-[12px] font-medium tabular-nums">{info?.total ? hm(info.total) : <span className="text-faint">—</span>}</div>
            </button>
          );
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
            const k = dayKey(d);
            return (
              <div key={d} className={clsx("relative border-l border-line", selected === d && "bg-white/[0.015]")} onClick={() => onSelect(d)}>
                {Array.from({ length: 24 }, (_, h) => (
                  <div key={h} className="absolute right-0 left-0 border-t border-white/[0.04]" style={{ top: h * HOUR_PX }} />
                ))}
                {blocks
                  .filter((b) => dayKey(b.start) === k)
                  .map((b, i) => {
                    const p = pos(b);
                    const t = a.tasks[b.taskId];
                    return (
                      <div
                        key={i}
                        className="absolute right-3 left-1 overflow-hidden rounded-[4px] px-1 text-[10.5px] leading-tight text-white"
                        style={{ top: p.top, height: p.height, background: colorOf(a, b.taskId) }}
                        {...bind(() => <SpanTip a={a} s={b} label="Prompting" />)}
                      >
                        {p.height >= 14 && <span className="font-mono">{t?.kind === "scratch" ? "chat" : t?.key}</span>}
                        {p.height >= 28 && <span className="block truncate opacity-90">{t?.title}</span>}
                      </div>
                    );
                  })}
                {lanes(runs.filter((r) => dayKey(r.start) === k))
                  .slice(0, 3)
                  .map((lane, li) =>
                    lane.map((r, i) => {
                      const p = pos(r);
                      return (
                        <div
                          key={`${li}-${i}`}
                          className="absolute w-[3px] rounded-full opacity-70"
                          style={{ top: p.top, height: p.height, right: 2 + li * 4, background: colorOf(a, r.taskId) }}
                          {...bind(() => <SpanTip a={a} s={r} label={r.running ? "Agent running" : "Agent ran"} />)}
                        />
                      );
                    }),
                  )}
              </div>
            );
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
  );
}

function DayDetail({ view, day }: { view: View; day: number }) {
  const a = view.data;
  const end = addDays(day, 1);
  const dayView = useMemo<View>(() => {
    const clip = <T extends Span>(s: T): T | null => {
      const start = Math.max(s.start, day);
      const e = Math.min(s.end, end);
      return e > start ? { ...s, start, end: e } : null;
    };
    const spans = view.spans.map(clip).filter((s): s is Span => !!s);
    const runs = view.runs.map(clip).filter((s): s is RunSpan => !!s);
    const events = view.events.filter((e) => e.at >= day && e.at < end);
    return { data: { ...a, from: day, to: end }, spans, runs, events, totals: totalsByTask(events, spans, runs) };
  }, [view, a, day, end]);

  return (
    <section className="space-y-4">
      <h2 className="text-[13px] font-medium">{new Date(day).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" })}</h2>
      <DayTimeline view={dayView} day={day} />
      {(dayView.events.length > 0 || dayView.runs.length > 0) && (
        <>
          <TaskTable view={dayView} />
          <PromptLog key={day} events={dayView.events} a={a} open title="Prompts" />
        </>
      )}
    </section>
  );
}
