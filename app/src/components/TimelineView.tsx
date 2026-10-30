import clsx from "clsx";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api, hostSupports, type Project, type Task } from "../api";
import { usePanel, openTask } from "../router";
import { keyPrefix, useStore } from "../store";
import { ticks } from "../timeline";
import { duration, StatusIcon, STATUS_COLOR, useClock } from "./ui";
import type { OnMenu } from "./Board";

/**
 * The board's tasks on a time axis: a lane for each task, with its agent's runs as bars and the
 * user's prompts as ticks, from the hosts' analytics reports (API 16). What ran when, side by side
 * and for how long, and how long each task has been waiting on the user.
 */

const SPANS = [
  { id: "1h", label: "1h", ms: 3600_000 },
  { id: "6h", label: "6h", ms: 6 * 3600_000 },
  { id: "24h", label: "24h", ms: 24 * 3600_000 },
  { id: "3d", label: "3d", ms: 3 * 86400_000 },
  { id: "7d", label: "7d", ms: 7 * 86400_000 },
  { id: "30d", label: "30d", ms: 30 * 86400_000 },
] as const;
type SpanId = (typeof SPANS)[number]["id"];
const SPAN_KEY = "ia.timeline.span";

interface Bar {
  start: number;
  end: number;
  kind: string;
  running: boolean;
}
interface Mark {
  at: number;
  kind: "prompt" | "start" | "merge";
  text: string;
}
interface Lane {
  task: Task;
  bars: (Bar & { runs?: number })[];
  marks: Mark[];
  /** The latest thing in the window, which orders the lanes. */
  last: number;
}

/** The bars as one, where they overlap or touch: a review round runs two reviewers at once, and a run may start as another ends. */
function merged(bars: Bar[]): (Bar & { runs: number })[] {
  const out: (Bar & { runs: number })[] = [];
  for (const b of [...bars].sort((a, b) => a.start - b.start)) {
    const last = out.at(-1);
    if (last && b.start <= last.end) {
      last.end = Math.max(last.end, b.end);
      last.running ||= b.running;
      last.runs++;
    } else out.push({ ...b, runs: 1 });
  }
  return out;
}

/** Runs and prompts of the board's tasks in `[from, to)`, from each host and profile they're on. */
function useReports(tasks: Task[], from: number, to: number) {
  // Asked again as hosts connect or update, not on every change to them.
  const hostsKey = useStore((s) => s.hosts.map((h) => `${h.id}:${h.connected}:${h.api_version}`).join(","));
  // Which profiles to ask, on which hosts: those of the board's tasks.
  const pairs = useMemo(() => [...new Set(tasks.map((t) => `${t.host_id}\n${t.profile_id}`))].sort().join("\t"), [tasks]);
  // Asked again as runs start and end.
  const running = useMemo(() => tasks.filter((t) => t.running).map((t) => t.id).sort().join(","), [tasks]);
  const [data, setData] = useState<{ runs: (Bar & { task_id: string })[]; events: (Mark & { task_id: string })[] } | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    const errs: string[] = [];
    const asks = pairs
      .split("\t")
      .filter(Boolean)
      .map(async (pair) => {
        const [hostId, profileId] = pair.split("\n");
        const host = useStore.getState().hosts.find((h) => h.id === hostId);
        if (!host?.connected) return null;
        if (!hostSupports(host, 16)) {
          errs.push(`${host.name} needs an update to show runs`);
          return null;
        }
        try {
          return await api.analytics(hostId, profileId, new Date(from).toISOString(), new Date(to).toISOString());
        } catch (e) {
          errs.push(`${host.name}: ${(e as Error).message}`);
          return null;
        }
      });
    Promise.all(asks).then((reports) => {
      if (cancelled) return;
      const now = Date.now();
      setData({
        runs: reports.flatMap((r) =>
          (r?.runs ?? [])
            .filter((run) => run.kind !== "compact")
            .map((run) => ({ task_id: run.task_id, kind: run.kind, start: Date.parse(run.started_at), end: run.ended_at ? Date.parse(run.ended_at) : now, running: !run.ended_at })),
        ),
        events: reports.flatMap((r) => (r?.events ?? []).map((e) => ({ task_id: e.task_id, kind: e.kind, at: Date.parse(e.at), text: e.text }))),
      });
      setErrors(errs);
    });
    return () => {
      cancelled = true;
    };
    // `to` moves on every minute; asking again each time is what keeps the bars of the runs going up to date.
  }, [pairs, from, to, running, hostsKey]);
  return { data, errors };
}

const clock = (t: number) => new Date(t).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });

export function TimelineView({ tasks, projectOf, onMenu }: { tasks: Task[]; projectOf: (t: Task) => Project | undefined; onMenu?: OnMenu }) {
  const [span, setSpan] = useState<SpanId>(() => (SPANS.find((s) => s.id === localStorage.getItem(SPAN_KEY))?.id ?? "24h") as SpanId);
  // How many windows back from now it shows.
  const [back, setBack] = useState(0);
  const now = useClock(60_000);
  const ms = SPANS.find((s) => s.id === span)!.ms;
  const to = now - back * ms;
  const from = to - ms;
  const { data, errors } = useReports(tasks, from, to);
  const openId = usePanel()?.taskId;

  const { lanes, idle, concurrency, peak, total } = useMemo(() => {
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const lanes = new Map<string, Lane>();
    const lane = (t: Task) => {
      let l = lanes.get(t.id);
      if (!l) lanes.set(t.id, (l = { task: t, bars: [], marks: [], last: 0 }));
      return l;
    };
    for (const r of data?.runs ?? []) {
      const t = byId.get(r.task_id);
      // A report from a minute ago may not know the run that started since.
      if (!t || r.end <= from || r.start >= to) continue;
      const l = lane(t);
      l.bars.push({ ...r, start: Math.max(r.start, from), end: Math.min(r.running && !t.running ? Date.parse(t.last_activity_at) : r.end, to) });
      l.last = Math.max(l.last, Math.min(r.end, to));
    }
    for (const e of data?.events ?? []) {
      const t = byId.get(e.task_id);
      if (!t || e.at < from || e.at >= to) continue;
      const l = lane(t);
      l.marks.push(e);
      l.last = Math.max(l.last, e.at);
    }
    // Running now with no run in the report yet: from when it started.
    if (!back)
      for (const t of tasks) {
        if (!t.running || !t.run_started_at || lanes.get(t.id)?.bars.some((b) => b.running)) continue;
        const l = lane(t);
        l.bars.push({ start: Math.max(Date.parse(t.run_started_at), from), end: to, kind: "prompt", running: true });
        l.last = to;
      }
    for (const l of lanes.values()) l.bars = [...merged(l.bars.filter((b) => b.kind !== "review")), ...merged(l.bars.filter((b) => b.kind === "review"))];
    const sorted = [...lanes.values()].sort((a, b) => b.last - a.last);
    // How many tasks had an agent (or a reviewer) running at once, as steps: +1 as one starts, -1 as it stops.
    const steps = sorted
      .flatMap((l) => merged(l.bars).flatMap((b) => [{ at: b.start, d: 1 }, { at: b.end, d: -1 }]))
      .sort((a, b) => a.at - b.at || a.d - b.d);
    const concurrency: { at: number; n: number }[] = [{ at: from, n: 0 }];
    let n = 0;
    let peak = 0;
    for (const s of steps) {
      n += s.d;
      peak = Math.max(peak, n);
      concurrency.push({ at: s.at, n });
    }
    concurrency.push({ at: to, n });
    const total = sorted.reduce((sum, l) => sum + merged(l.bars).reduce((s, b) => s + (b.end - b.start), 0), 0);
    return { lanes: sorted, idle: tasks.length - sorted.length, concurrency, peak, total };
  }, [data, tasks, from, to, back]);

  const x = (t: number) => `${(100 * (t - from)) / (to - from)}%`;
  const w = (a: number, b: number) => `max(2px, ${(100 * (b - a)) / (to - from)}%)`;
  const axis = ticks(from, to);
  const runningNow = tasks.filter((t) => t.running).length;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-line px-5 py-2 text-[12px] text-muted">
        <div className="flex items-center rounded-md border border-line p-0.5">
          {SPANS.map((s) => (
            <button
              key={s.id}
              onClick={() => {
                setSpan(s.id);
                setBack(0);
                localStorage.setItem(SPAN_KEY, s.id);
              }}
              className={clsx("h-6 rounded px-2 text-xs font-medium", span === s.id ? "bg-raised text-fg" : "text-muted hover:text-fg")}
            >
              {s.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1">
          <button className="flex h-6 w-6 items-center justify-center rounded hover:bg-raised hover:text-fg" title="Earlier" onClick={() => setBack(back + 1)}>
            <ChevronLeft size={14} />
          </button>
          <button className="flex h-6 w-6 items-center justify-center rounded hover:bg-raised hover:text-fg disabled:opacity-30" title="Later" disabled={!back} onClick={() => setBack(back - 1)}>
            <ChevronRight size={14} />
          </button>
          {back > 0 && (
            <button className="ml-1 hover:text-fg hover:underline" onClick={() => setBack(0)}>
              Now
            </button>
          )}
        </div>
        <span>
          {!back && (
            <>
              <span className="text-st-progress">{runningNow} running now</span> ·{" "}
            </>
          )}
          {lanes.length} task{lanes.length === 1 ? "" : "s"} active · {duration(total)} of agent time · up to {peak} at once
        </span>
        <span className="ml-auto flex items-center gap-3 text-[11px] text-faint">
          <span className="flex items-center gap-1">
            <span className="inline-block h-2 w-4 rounded-sm bg-st-progress/70" /> agent run
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-2 w-4 rounded-sm bg-st-review/70" /> review
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-3 w-0.5 bg-fg" /> your prompt
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-2 w-4 rounded-sm bg-st-attention/25 [background-image:repeating-linear-gradient(-45deg,transparent_0_3px,rgb(245_158_11/0.35)_3px_5px)]" /> waiting on you
          </span>
        </span>
      </div>
      {errors.length > 0 && <div className="border-b border-line bg-amber-500/10 px-5 py-1.5 text-[12px] text-amber-300">{errors.join(" · ")}</div>}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* The axis and how many ran at once stay at the top while the lanes scroll. */}
        <div className="sticky top-0 z-10 border-b border-line bg-bg">
          <div className="flex h-7 items-end">
            <div className="w-[300px] shrink-0" />
            <div className="relative h-full flex-1 mr-5">
              {axis.map((t) => (
                <span key={t.at} data-tick className={clsx("absolute bottom-1 -translate-x-1/2 text-[11px] whitespace-nowrap tabular-nums", t.day ? "text-muted" : "text-faint")} style={{ left: x(t.at) }}>
                  {t.label}
                </span>
              ))}
            </div>
          </div>
          <div className="flex h-10 items-stretch">
            <div className="flex w-[300px] shrink-0 items-center px-5 text-[11.5px] text-faint">Agents running</div>
            <div className="relative mr-5 flex-1">
              <svg className="absolute inset-0 h-full w-full" viewBox="0 0 1000 100" preserveAspectRatio="none">
                <path
                  d={
                    `M0 100 ` +
                    concurrency
                      .map((c, i) => {
                        const px = (1000 * (c.at - from)) / (to - from);
                        const py = 100 - (90 * c.n) / Math.max(peak, 1);
                        const prev = concurrency[i - 1];
                        return prev ? `L${px} ${100 - (90 * prev.n) / Math.max(peak, 1)} L${px} ${py}` : `L${px} ${py}`;
                      })
                      .join(" ") +
                    ` L1000 100 Z`
                  }
                  fill="color-mix(in srgb, var(--color-st-progress) 22%, transparent)"
                  stroke="var(--color-st-progress)"
                  strokeWidth={1}
                  vectorEffect="non-scaling-stroke"
                />
              </svg>
            </div>
          </div>
        </div>
        <div className="relative">
          {/* Lines across every lane: the axis's ticks, and now. */}
          <div className="pointer-events-none absolute inset-y-0 right-5 left-[300px]">
            {axis.map((t) => (
              <div key={t.at} className={clsx("absolute inset-y-0 w-px", t.day ? "bg-line-strong/70" : "bg-line/60")} style={{ left: x(t.at) }} />
            ))}
            {!back && <div className="absolute inset-y-0 right-0 w-px bg-st-progress/50" title="Now" />}
          </div>
          {data === null && <div className="px-5 py-6 text-[12.5px] text-faint">Loading runs…</div>}
          {data && lanes.length === 0 && <div className="px-5 py-6 text-[12.5px] text-faint">Nothing ran in this window.</div>}
          {lanes.map((l) => {
            const t = l.task;
            const key = `${keyPrefix(t, projectOf(t))}-${t.number}`;
            // Since the agent last stopped, a task that needs the user, or that's in review, has been waiting on them.
            const lastEnd = l.bars.reduce((m, b) => Math.max(m, b.running ? 0 : b.end), 0);
            const waiting = !back && !t.running && (t.status === "needs_attention" || t.status === "in_review") && lastEnd > 0 ? lastEnd : null;
            return (
              <div
                key={t.id}
                role="button"
                tabIndex={0}
                aria-current={openId === t.id || undefined}
                onClick={() => openTask(t.id)}
                onKeyDown={(e) => {
                  if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
                    e.preventDefault();
                    openTask(t.id);
                  }
                }}
                onContextMenu={onMenu && ((e) => onMenu(e, t))}
                className={clsx("group flex h-8 cursor-pointer items-stretch outline-none hover:bg-white/[0.03] focus-visible:bg-white/[0.04]", openId === t.id && "bg-accent/[0.07]")}
              >
                <div className="flex w-[300px] shrink-0 items-center gap-2 px-5 text-[12.5px]">
                  <StatusIcon status={t.status} size={13} />
                  <span className="shrink-0 font-mono text-[11px] text-faint">{key}</span>
                  <span className="truncate text-fg" title={t.title}>
                    {t.title}
                  </span>
                </div>
                <div className="relative mr-5 flex-1">
                  {waiting && (
                    <div
                      className="absolute top-2 bottom-2 rounded-sm [background-image:repeating-linear-gradient(-45deg,transparent_0_3px,var(--stripe)_3px_5px)]"
                      style={{ left: x(waiting), width: w(waiting, to), ["--stripe" as string]: `color-mix(in srgb, ${STATUS_COLOR[t.status]} 35%, transparent)` }}
                      title={`${t.status === "needs_attention" ? "Waiting for your answer" : "Waiting for your review"} for ${duration(to - waiting)}`}
                    />
                  )}
                  {l.bars.map((b, i) => (
                    <div
                      key={i}
                      className={clsx("absolute top-2 bottom-2 rounded-sm", b.kind === "review" ? "bg-st-review/70" : "bg-st-progress/70", b.running && "animate-pulse")}
                      style={{ left: x(b.start), width: w(b.start, b.end) }}
                      title={`${b.kind === "review" ? "Review" : "Agent"}${(b.runs ?? 1) > 1 ? ` (${b.runs} runs)` : ""} · ${clock(b.start)} – ${b.running ? "now" : clock(b.end)} (${duration(b.end - b.start)})`}
                    />
                  ))}
                  {l.marks.map((m, i) => (
                    <div
                      key={`m${i}`}
                      className={clsx("absolute top-1 bottom-1 w-0.5 -translate-x-1/2 rounded-full", m.kind === "prompt" ? "bg-fg" : m.kind === "start" ? "bg-st-done" : "bg-st-merge")}
                      style={{ left: x(m.at) }}
                      title={`${m.kind === "prompt" ? "You" : m.kind === "start" ? "Started" : "Moved to Ready for merge"} · ${clock(m.at)}${m.text ? `\n${m.text}` : ""}`}
                    />
                  ))}
                </div>
              </div>
            );
          })}
          {data && idle > 0 && (
            <div className="px-5 py-3 text-[12px] text-faint">
              {idle} other task{idle === 1 ? "" : "s"} on the board had no activity in this window.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
