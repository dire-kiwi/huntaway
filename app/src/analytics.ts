import { api, hostSupports, type AnalyticsReport, type Status } from "./api";
import type { CCompaction, CTurn } from "./contextStats";
import { boardHosts, useStore } from "./store";

/**
 * Prompt analytics for time tracking. Each host reports the profile's prompts and agent runs
 * (see server analytics.rs); this merges them and works out active time:
 *
 * Each prompt is credited with the time since the previous prompt (on any task), up to the
 * idle gap. A prompt after a longer break is credited a fixed lead-in. So the time spent
 * reading an agent's output and writing the next prompt counts toward the task prompted.
 */

/** Categorical slots for projects, validated for CVD separation on the dark panel surface. */
export const PALETTE = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"];
/** Tasks in no project and projects past the eighth: they're told apart by their labels. */
export const NEUTRAL = "#6b6b7b";
/** Pseudo-project for threads outside any project: scratch and group tasks (and scratch chats on older hosts). */
export const SCRATCH = "scratch";

export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

export interface Rules {
  /** A gap between prompts longer than this is a break. */
  idleMin: number;
  /** What a prompt after a break is credited. */
  leadMin: number;
}

export interface AProject {
  id: string;
  name: string;
  key: string;
  color: string;
}

export interface ATask {
  id: string;
  hostId: string;
  /** A real project id, or SCRATCH. */
  projectId: string;
  kind: string;
  number: number;
  title: string;
  status: Status;
  /** e.g. "IA-35", or the thread's title for one in no project. */
  key: string;
}

export interface AEvent {
  at: number;
  taskId: string;
  kind: "prompt" | "start" | "merge";
  text: string;
}

export interface Span {
  taskId: string;
  start: number;
  end: number;
}

export type RunSpan = Span & { running: boolean };

export interface Activity {
  from: number;
  to: number;
  /** Includes prompts from the idle gap before `from`, so the first ones in range are credited right. */
  events: AEvent[];
  /** Agent runs (not compactions), clipped to the range. */
  runs: RunSpan[];
  tasks: Record<string, ATask>;
  projects: Record<string, AProject>;
  /** Hosts that couldn't be asked, and why. */
  errors: string[];
}

/** Asks each host on the board for a report on each of its profiles. Hosts that can't answer go in `errors`. */
async function fromHosts<T>(minApi: number, errors: string[], ask: (host: string, profile: string) => Promise<T>) {
  const s = useStore.getState();
  const reports = await Promise.all(
    boardHosts(s.hosts).flatMap((h) => {
      const profiles = s.profiles.filter((p) => p.host_id === h.id);
      if (!profiles.length) return [];
      if (!hostSupports(h, minApi)) {
        errors.push(`${h.name} needs an update to report ${minApi > 16 ? "context sizes" : "analytics"}`);
        return [];
      }
      return profiles.map(async (profile) => {
        try {
          return { host: h.id, report: await ask(h.id, profile.id) };
        } catch (e) {
          errors.push(`${h.name}: ${e instanceof Error ? e.message : String(e)}`);
          return null;
        }
      });
    }),
  );
  return reports.filter((r) => r !== null);
}

type Named = Pick<Activity, "tasks" | "projects">;

function named(): Named {
  return { tasks: {}, projects: { [SCRATCH]: { id: SCRATCH, name: "No project", key: "No project", color: NEUTRAL } } };
}

/** Adds a host's report's projects and tasks to `out`. */
function addNames(out: Named, host: string, report: Pick<AnalyticsReport, "tasks" | "projects">) {
  let slot = Object.keys(out.projects).length - 1;
  for (const p of report.projects) {
    // Colour follows the project, in the order projects were created, whatever is shown.
    out.projects[p.id] = { ...p, color: PALETTE[slot++] ?? NEUTRAL };
  }
  for (const t of report.tasks) {
    const projectId = t.project_id ?? SCRATCH;
    const project = out.projects[projectId];
    const key = t.kind === "scratch" || !project || projectId === SCRATCH ? t.title || "Untitled" : `${project.key}-${t.number}`;
    out.tasks[t.id] = { id: t.id, hostId: host, projectId, kind: t.kind, number: t.number, title: t.title, status: t.status, key };
  }
}

export async function loadActivity(from: number, to: number, rules: Rules): Promise<Activity> {
  const out: Activity = { from, to, events: [], runs: [], ...named(), errors: [] };
  const padded = new Date(from - rules.idleMin * MIN).toISOString();
  const reports = await fromHosts(16, out.errors, (h, profile) => api.analytics(h, profile, padded, new Date(to).toISOString()));
  const now = Date.now();
  for (const r of reports) {
    addNames(out, r.host, r.report);
    for (const e of r.report.events) out.events.push({ at: Date.parse(e.at), taskId: e.task_id, kind: e.kind, text: e.text });
    for (const run of r.report.runs) {
      if (run.kind === "compact") continue;
      const start = Math.max(from, Date.parse(run.started_at));
      const end = Math.min(to, run.ended_at ? Date.parse(run.ended_at) : now);
      if (end > start) out.runs.push({ taskId: run.task_id, start, end, running: !run.ended_at });
    }
  }
  out.events.sort((a, b) => a.at - b.at);
  return out;
}

/** Context sizes at the end of each turn and compactions, in range (see contextStats.ts). */
export interface ContextData extends Named {
  from: number;
  to: number;
  turns: CTurn[];
  compactions: CCompaction[];
  errors: string[];
}

export async function loadContext(from: number, to: number): Promise<ContextData> {
  const out: ContextData = { from, to, turns: [], compactions: [], ...named(), errors: [] };
  const reports = await fromHosts(85, out.errors, (h, profile) => api.contextStats(h, profile, new Date(from).toISOString(), new Date(to).toISOString()));
  for (const r of reports) {
    addNames(out, r.host, r.report);
    for (const x of r.report.stats) {
      const at = Date.parse(x.at);
      if (x.kind === "turn" && x.tokens !== null) {
        out.turns.push({ at, taskId: x.task_id, tokens: x.tokens, maxTokens: x.max_tokens, cost: x.cost_usd });
      } else if (x.kind === "compact") {
        out.compactions.push({ at, taskId: x.task_id, source: x.source ?? "user", tokens: x.tokens, postTokens: x.post_tokens, durationMs: x.duration_ms });
      }
    }
  }
  out.turns.sort((a, b) => a.at - b.at);
  out.compactions.sort((a, b) => a.at - b.at);
  return out;
}

/** Active time credited to each prompt, clipped to the range (see the top of this file). */
export function activeSpans(a: Activity, rules: Rules): Span[] {
  const idle = rules.idleMin * MIN;
  const lead = rules.leadMin * MIN;
  const spans: Span[] = [];
  let prev: number | null = null;
  for (const e of a.events) {
    const gap = prev === null ? Infinity : e.at - prev;
    const credit = gap <= idle ? gap : Math.min(lead, gap);
    prev = e.at;
    const start = Math.max(a.from, e.at - credit);
    const end = Math.min(a.to, e.at);
    if (end > start) spans.push({ taskId: e.taskId, start, end });
  }
  return spans;
}

/** Joins back-to-back spans on the same task, for calendar blocks. */
export function mergeSpans(spans: Span[]): Span[] {
  const out: Span[] = [];
  for (const s of [...spans].sort((x, y) => x.start - y.start)) {
    const last = out[out.length - 1];
    if (last && last.taskId === s.taskId && s.start <= last.end) last.end = Math.max(last.end, s.end);
    else out.push({ ...s });
  }
  return out;
}

export function startOfDay(t: number) {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Calendar days move by date, not 24h, so daylight saving changes don't shift them. */
export function addDays(t: number, n: number) {
  const d = new Date(t);
  d.setDate(d.getDate() + n);
  return d.getTime();
}

export function addMonths(t: number, n: number) {
  const d = new Date(t);
  d.setDate(1);
  d.setMonth(d.getMonth() + n);
  return d.getTime();
}

/** Weeks start on Monday. */
export function startOfWeek(t: number) {
  const d = new Date(startOfDay(t));
  return addDays(d.getTime(), -((d.getDay() + 6) % 7));
}

export function startOfMonth(t: number) {
  const d = new Date(startOfDay(t));
  d.setDate(1);
  return d.getTime();
}

/** Local "YYYY-MM-DD". */
export function dayKey(t: number) {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Cuts a span at each local midnight. */
export function splitByDay<T extends Span>(s: T): T[] {
  const out: T[] = [];
  let start = s.start;
  while (start < s.end) {
    const next = addDays(startOfDay(start), 1);
    const end = Math.min(next, s.end);
    out.push({ ...s, start, end });
    start = end;
  }
  return out;
}

export interface TaskTotals {
  taskId: string;
  active: number;
  agent: number;
  prompts: number;
  first: number | null;
  last: number | null;
}

/** Totals per task. `events` and `spans` should already be in range and filtered. */
export function totalsByTask(events: AEvent[], spans: Span[], runs: Span[]): Map<string, TaskTotals> {
  const m = new Map<string, TaskTotals>();
  const get = (id: string) => {
    let t = m.get(id);
    if (!t) m.set(id, (t = { taskId: id, active: 0, agent: 0, prompts: 0, first: null, last: null }));
    return t;
  };
  for (const s of spans) get(s.taskId).active += s.end - s.start;
  for (const r of runs) get(r.taskId).agent += r.end - r.start;
  for (const e of events) {
    const t = get(e.taskId);
    t.prompts++;
    t.first = t.first === null ? e.at : Math.min(t.first, e.at);
    t.last = t.last === null ? e.at : Math.max(t.last, e.at);
  }
  return m;
}

/** Hours and minutes, e.g. "3h 05m", "42m", "0m". */
export function hm(ms: number) {
  const min = Math.round(ms / MIN);
  if (min < 60) return `${min}m`;
  return `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, "0")}m`;
}

/** Decimal hours for timesheets, e.g. "1.25". */
export const hours = (ms: number) => (ms / HOUR).toFixed(2);

function csvCell(v: string | number) {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** One row per day and task: what a timesheet wants. */
export function toCsv(a: Activity, events: AEvent[], spans: Span[], runs: Span[]) {
  const rows = new Map<string, { day: string; taskId: string; active: number; agent: number; prompts: number }>();
  const row = (t: number, taskId: string) => {
    const k = `${dayKey(t)} ${taskId}`;
    let r = rows.get(k);
    if (!r) rows.set(k, (r = { day: dayKey(t), taskId, active: 0, agent: 0, prompts: 0 }));
    return r;
  };
  for (const s of spans.flatMap(splitByDay)) row(s.start, s.taskId).active += s.end - s.start;
  for (const s of runs.flatMap(splitByDay)) row(s.start, s.taskId).agent += s.end - s.start;
  for (const e of events) row(e.at, e.taskId).prompts++;
  const lines = [["Date", "Project", "Task", "Title", "Prompts", "Active hours", "Agent hours"].join(",")];
  const sorted = [...rows.values()].sort((x, y) => x.day.localeCompare(y.day) || (a.tasks[x.taskId]?.key ?? "").localeCompare(a.tasks[y.taskId]?.key ?? ""));
  for (const r of sorted) {
    const t = a.tasks[r.taskId];
    const p = a.projects[t?.projectId ?? SCRATCH];
    lines.push([r.day, p?.name ?? "", t?.key ?? "", t?.title ?? "", r.prompts, hours(r.active), hours(r.agent)].map(csvCell).join(","));
  }
  return lines.join("\n") + "\n";
}
