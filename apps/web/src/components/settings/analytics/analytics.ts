import { DateTime } from "effect"
import type { AnalyticsReport, ContextReport, TokenReport } from "@huntaway/contracts"
import type { CCompaction, CompactSource, CTurn } from "../../task/contextStatsData"
import type { TokenData } from "../tokenStatsData"
import { millisOf } from "../../ui/dates"
import type { Answered } from "./gather"

/**
 * Prompt analytics for time tracking. Each host reports the profile's prompts and agent runs
 * (see server analytics.rs); this merges them and works out active time:
 *
 * Each prompt is credited with the time since the previous prompt (on any task), up to the
 * idle gap. A prompt after a longer break is credited a fixed lead-in. So the time spent
 * reading an agent's output and writing the next prompt counts toward the task prompted.
 */

/** Categorical slots for projects, validated for CVD separation on the dark panel surface. */
export const PALETTE = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"]
/** Tasks in no project and projects past the eighth: they're told apart by their labels. */
export const NEUTRAL = "#6b6b7b"
/** Pseudo-project for threads outside any project: scratch and group tasks (and scratch chats on older hosts). */
export const SCRATCH = "scratch"

export const MIN = 60_000
export const HOUR = 60 * MIN

export interface Rules {
  /** A gap between prompts longer than this is a break. */
  idleMin: number
  /** What a prompt after a break is credited. */
  leadMin: number
}

export interface AProject {
  id: string
  /** The name of the profile it's in; none for SCRATCH, which is every profile's. */
  profile?: string
  name: string
  key: string
  color: string
}

export interface ATask {
  id: string
  hostId: string
  /** The name of the profile it's in. */
  profile: string
  /** A real project id, or SCRATCH. */
  projectId: string
  kind: string
  number: number
  title: string
  /** As the host reports it. */
  status: string
  /** e.g. "IA-35", or the thread's title for one in no project. */
  key: string
}

export interface AEvent {
  at: number
  taskId: string
  kind: "prompt" | "start" | "merge"
  text: string
}

export interface Span {
  taskId: string
  start: number
  end: number
}

export type RunSpan = Span & { running: boolean }

export interface Activity {
  from: number
  to: number
  /** Includes prompts from the idle gap before `from`, so the first ones in range are credited right. */
  events: AEvent[]
  /** Agent runs (not compactions), clipped to the range. */
  runs: RunSpan[]
  tasks: Record<string, ATask>
  projects: Record<string, AProject>
  /** Hosts that couldn't be asked, and why. */
  errors: string[]
}

type Named = Pick<Activity, "tasks" | "projects">

const EVENT_KINDS: ReadonlyArray<AEvent["kind"]> = ["prompt", "start", "merge"]
/** An event's kind; one this board doesn't know counts as a prompt. */
const eventKind = (kind: string): AEvent["kind"] => EVENT_KINDS.find((k) => k === kind) ?? "prompt"

const COMPACT_SOURCES: ReadonlyArray<CompactSource> = ["idle", "user", "auto"]
/** Who compacted; none (or one this board doesn't know) is someone's /compact. */
const compactSource = (source: string | null): CompactSource => COMPACT_SOURCES.find((s) => s === source) ?? "user"

function named(): Named {
  return { tasks: {}, projects: { [SCRATCH]: { id: SCRATCH, name: "No project", key: "No project", color: NEUTRAL } } }
}

/** Adds the projects and tasks of a host's report on `profile` to `out`. */
function addNames(out: Named, { target, report }: Answered<Pick<AnalyticsReport, "tasks" | "projects">>) {
  const { host, profile } = target
  let slot = Object.keys(out.projects).length - 1
  for (const p of report.projects) {
    // Colour follows the project, in the order projects were created, whatever is shown.
    out.projects[p.id] = { ...p, profile, color: PALETTE[slot++] ?? NEUTRAL }
  }
  for (const t of report.tasks) {
    const projectId = t.project_id ?? SCRATCH
    const project = out.projects[projectId]
    const key = t.kind === "scratch" || !project || projectId === SCRATCH ? t.title || "Untitled" : `${project.key}-${t.number}`
    out.tasks[t.id] = { id: t.id, hostId: host, profile, projectId, kind: t.kind, number: t.number, title: t.title, status: t.status, key }
  }
}

/** Where an activity report starts: the idle gap before `from`, so the first prompts in range are credited right. */
export const paddedFrom = (from: number, rules: Pick<Rules, "idleMin">) => from - rules.idleMin * MIN

/**
 * Every profile's activity in range, from each host's reports on each of its profiles (asked from `paddedFrom`; a run
 * still going ends `now`). A profile's is picked out after active time is worked out (see `useView`), as a prompt is
 * credited with the time since the previous one on any task, whichever profile that was in.
 */
export function activityOf(from: number, to: number, reports: ReadonlyArray<Answered<AnalyticsReport>>, errors: Array<string>, now: number): Activity {
  const out: Activity = { from, to, events: [], runs: [], ...named(), errors }
  for (const r of reports) {
    addNames(out, r)
    for (const e of r.report.events) out.events.push({ at: millisOf(e.at), taskId: e.task_id, kind: eventKind(e.kind), text: e.text })
    for (const run of r.report.runs) {
      if (run.kind === "compact") continue
      const start = Math.max(from, millisOf(run.started_at))
      const end = Math.min(to, run.ended_at ? millisOf(run.ended_at) : now)
      if (end > start) out.runs.push({ taskId: run.task_id, start, end, running: !run.ended_at })
    }
  }
  out.events.sort((a, b) => a.at - b.at)
  return out
}

/** Context sizes at the end of each turn and compactions, in range (see contextStats.ts). */
export interface ContextData extends Named {
  from: number
  to: number
  turns: CTurn[]
  compactions: CCompaction[]
  errors: string[]
}

/** The context sizes and compactions in each host's reports on its profiles. */
export function contextOf(from: number, to: number, reports: ReadonlyArray<Answered<ContextReport>>, errors: Array<string>): ContextData {
  const out: ContextData = { from, to, turns: [], compactions: [], ...named(), errors }
  for (const r of reports) {
    addNames(out, r)
    for (const x of r.report.stats) {
      const at = millisOf(x.at)
      if (x.kind === "turn" && x.tokens !== null) {
        out.turns.push({ at, taskId: x.task_id, tokens: x.tokens, startTokens: x.start_tokens, maxTokens: x.max_tokens, cost: x.cost_usd })
      } else if (x.kind === "compact") {
        out.compactions.push({
          at,
          taskId: x.task_id,
          source: compactSource(x.source),
          tokens: x.tokens,
          postTokens: x.post_tokens,
          durationMs: x.duration_ms,
        })
      }
    }
  }
  out.turns.sort((a, b) => a.at - b.at)
  out.compactions.sort((a, b) => a.at - b.at)
  return out
}

/** The tokens runs that started in range used, and the reviews then (see tokenStatsData.ts), in each host's reports on its profiles. */
export function tokensOf(from: number, to: number, reports: ReadonlyArray<Answered<TokenReport>>, errors: Array<string>): TokenData {
  const out: TokenData = { from, to, rows: [], reviews: [], rounds: [], followUps: [], ...named(), threads: {}, pending: 0, errors }
  for (const r of reports) {
    addNames(out, r)
    for (const t of r.report.tasks) {
      out.threads[t.id] = { parentId: t.parent_id, taskType: t.task_type, groupName: t.group_name, model: t.model, kind: t.kind }
    }
    for (const u of r.report.usage) {
      out.rows.push({
        at: millisOf(u.at),
        runId: u.run_id,
        // Hosts before API 100 don't say which call a row is from: a call's rows have its time.
        callId: u.run_id === null ? (u.call_id ?? `${u.kind}\u0000${u.task_id}\u0000${u.at}`) : null,
        threadId: u.task_id,
        runKind: u.kind,
        model: u.model,
        runtime: u.runtime,
        input: u.input_tokens,
        output: u.output_tokens,
        cacheRead: u.cache_read_tokens,
        cacheWrite: u.cache_write_tokens,
        // Hosts before API 136 don't say which cache the writes went to.
        cacheWrite1h: u.cache_write_1h_tokens ?? null,
        cacheWrite5m: u.cache_write_5m_tokens ?? null,
        reasoning: u.reasoning_tokens,
        cost: u.cost_usd,
        estimated: u.estimated,
      })
    }
    for (const v of r.report.reviews) {
      out.reviews.push({
        at: millisOf(v.at),
        taskId: v.task_id,
        threadId: v.thread_id,
        verdict: v.verdict,
        serious: v.serious,
        minor: v.minor,
        minorNoted: v.minor_noted,
        // A reviewer's label names its config, and its model only when it isn't the config's default.
        reviewer: v.label ? (v.model && !v.label.includes(v.model) ? `${v.label} · ${v.model}` : v.label) : (v.model ?? "Unknown"),
        model: v.model,
        round: v.round,
        effort: v.effort ?? null,
        taskModel: v.task_model ?? null,
      })
    }
    for (const x of r.report.rounds) {
      out.rounds.push({
        taskId: x.task_id,
        round: x.round,
        at: millisOf(x.at),
        verdict: x.verdict,
        serious: x.serious,
        reviewers: x.reviewers,
      })
    }
    for (const f of r.report.follow_ups) out.followUps.push({ taskId: f.task_id, createdBy: f.created_by, at: millisOf(f.at) })
    out.pending += r.report.pending
  }
  out.rows.sort((a, b) => a.at - b.at)
  out.reviews.sort((a, b) => a.at - b.at)
  return out
}

/** Active time credited to each prompt, clipped to the range (see the top of this file). */
export function activeSpans(a: Activity, rules: Rules): Span[] {
  const idle = rules.idleMin * MIN
  const lead = rules.leadMin * MIN
  const spans: Span[] = []
  let prev: number | null = null
  for (const e of a.events) {
    const gap = prev === null ? Infinity : e.at - prev
    const credit = gap <= idle ? gap : Math.min(lead, gap)
    prev = e.at
    const start = Math.max(a.from, e.at - credit)
    const end = Math.min(a.to, e.at)
    if (end > start) spans.push({ taskId: e.taskId, start, end })
  }
  return spans
}

/** Joins back-to-back spans on the same task, for calendar blocks. */
export function mergeSpans(spans: Span[]): Span[] {
  const out: Span[] = []
  for (const s of spans.toSorted((x, y) => x.start - y.start)) {
    const last = out[out.length - 1]
    if (last && last.taskId === s.taskId && s.start <= last.end) last.end = Math.max(last.end, s.end)
    else out.push({ ...s })
  }
  return out
}

// Calendar arithmetic in the browser's time zone, as `Date`'s local setters did it: a wall-clock time that doesn't
// exist moves on, one that comes twice is the first (DateTime's "compatible").
const zone = DateTime.zoneMakeLocal()
const zoned = (t: number) => DateTime.makeZonedUnsafe(t, { timeZone: zone })
const millis = DateTime.toEpochMillis

/** `t`'s local wall-clock parts: `month` 1 to 12, `weekDay` 0 for Sunday. */
export const partsOf = (t: number): DateTime.DateTime.PartsWithWeekday => DateTime.toParts(zoned(t))

/** Local midnight of the day `t` is in. */
export const startOfDay = (t: number) => millis(DateTime.startOf(zoned(t), "day"))

/** Calendar days move by date, not 24h, so daylight saving changes don't shift them. */
export const addDays = (t: number, n: number) => millis(DateTime.add(zoned(t), { days: n }))

/** The first of the month `n` months from `t`'s, at `t`'s time of day. */
export const addMonths = (t: number, n: number) => millis(DateTime.add(DateTime.setParts(zoned(t), { day: 1 }), { months: n }))

/** Weeks start on Monday. */
export function startOfWeek(t: number) {
  const d = startOfDay(t)
  return addDays(d, -((partsOf(d).weekDay + 6) % 7))
}

export const startOfMonth = (t: number) => millis(DateTime.setParts(zoned(startOfDay(t)), { day: 1 }))

/** Hour `h` of the day `t` is in, on the hour (local). */
export const atHour = (t: number, h: number) => millis(DateTime.setParts(zoned(t), { hour: h, minute: 0, second: 0, millisecond: 0 }))

/** Local midnight of a date (`month` 1 to 12), as `new Date(year, month - 1, day)` was; days and months past the end roll over. */
export const localDay = (year: number, month: number, day: number) =>
  millis(DateTime.makeZonedUnsafe({ year, month, day }, { timeZone: zone, adjustForTimeZone: true }))

const pad2 = (n: number) => String(n).padStart(2, "0")

/** Local "YYYY-MM-DD". */
export function dayKey(t: number) {
  const d = partsOf(t)
  return `${d.year}-${pad2(d.month)}-${pad2(d.day)}`
}

/** Cuts a span at each local midnight. */
export function splitByDay<T extends Span>(s: T): T[] {
  const out: T[] = []
  let start = s.start
  while (start < s.end) {
    const next = addDays(startOfDay(start), 1)
    const end = Math.min(next, s.end)
    out.push({ ...s, start, end })
    start = end
  }
  return out
}

export interface TaskTotals {
  taskId: string
  active: number
  agent: number
  prompts: number
  first: number | null
  last: number | null
}

/** Totals per task. `events` and `spans` should already be in range and filtered. */
export function totalsByTask(events: AEvent[], spans: Span[], runs: Span[]): Map<string, TaskTotals> {
  const m = new Map<string, TaskTotals>()
  const get = (id: string) => {
    let t = m.get(id)
    if (!t) m.set(id, (t = { taskId: id, active: 0, agent: 0, prompts: 0, first: null, last: null }))
    return t
  }
  for (const s of spans) get(s.taskId).active += s.end - s.start
  for (const r of runs) get(r.taskId).agent += r.end - r.start
  for (const e of events) {
    const t = get(e.taskId)
    t.prompts++
    t.first = t.first === null ? e.at : Math.min(t.first, e.at)
    t.last = t.last === null ? e.at : Math.max(t.last, e.at)
  }
  return m
}

/** Hours and minutes, e.g. "3h 05m", "42m", "0m". */
export function hm(ms: number) {
  const min = Math.round(ms / MIN)
  if (min < 60) return `${min}m`
  return `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, "0")}m`
}

/** Decimal hours for timesheets, e.g. "1.25". */
export const hours = (ms: number) => (ms / HOUR).toFixed(2)

function csvCell(v: string | number) {
  const s = String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** One row per day and task: what a timesheet wants. */
export function toCsv(a: Activity, events: AEvent[], spans: Span[], runs: Span[]) {
  const rows = new Map<string, { day: string; taskId: string; active: number; agent: number; prompts: number }>()
  const row = (t: number, taskId: string) => {
    const k = `${dayKey(t)} ${taskId}`
    let r = rows.get(k)
    if (!r) rows.set(k, (r = { day: dayKey(t), taskId, active: 0, agent: 0, prompts: 0 }))
    return r
  }
  for (const s of spans.flatMap(splitByDay)) row(s.start, s.taskId).active += s.end - s.start
  for (const s of runs.flatMap(splitByDay)) row(s.start, s.taskId).agent += s.end - s.start
  for (const e of events) row(e.at, e.taskId).prompts++
  const lines = [["Date", "Project", "Task", "Title", "Prompts", "Active hours", "Agent hours"].join(",")]
  const sorted = [...rows.values()].toSorted((x, y) => x.day.localeCompare(y.day) || (a.tasks[x.taskId]?.key ?? "").localeCompare(a.tasks[y.taskId]?.key ?? ""))
  for (const r of sorted) {
    const t = a.tasks[r.taskId]
    const p = a.projects[t?.projectId ?? SCRATCH]
    lines.push([r.day, p?.name ?? "", t?.key ?? "", t?.title ?? "", r.prompts, hours(r.active), hours(r.agent)].map(csvCell).join(","))
  }
  return lines.join("\n") + "\n"
}
