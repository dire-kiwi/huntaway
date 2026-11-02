import type { ATask, AProject } from "./analytics";

/**
 * Statistics on the tokens agents use and what reviews find (see server agent/tokens.rs and
 * review/stats.rs): where tokens go (tasks' own work, reviews, summaries, compactions), on which
 * models, and how often each model's work passes review.
 *
 * A review or summary thread's tokens count towards the task it's for, and a subproject's tasks'
 * towards the subproject, which lists them.
 */

/** What a run's tokens were spent on. */
export type Purpose = "task" | "review" | "summary" | "compaction" | "scratch" | "group";

export const PURPOSES: Purpose[] = ["task", "review", "summary", "compaction", "scratch", "group"];

export const PURPOSE_LABEL: Record<Purpose, string> = {
  task: "Tasks",
  review: "Reviews",
  summary: "Summaries",
  compaction: "Compactions",
  scratch: "Scratch",
  group: "Group tasks",
};

export const PURPOSE_HINT: Record<Purpose, string> = {
  task: "Agents working on tasks",
  review: "Reviewers reviewing tasks' changes",
  summary: "Summaries of tasks' changes, written once their review passed",
  compaction: "Compacting threads' conversations (the board's after a thread sat idle, and /compact)",
  scratch: "Scratch tasks, in no project",
  group: "Group tasks, planning the work across a group's projects",
};

/** What one run used of one model. */
export interface URow {
  at: number;
  runId: string;
  /** The thread it ran in: a task, or a review or summary thread. */
  threadId: string;
  runKind: string;
  model: string;
  runtime: "claude" | "codex";
  /** Input that wasn't read from or written to the cache. */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  cost: number | null;
  estimated: boolean;
}

export interface UReview {
  at: number;
  /** The task reviewed. */
  taskId: string;
  threadId: string;
  verdict: "pass" | "issues";
  serious: number;
  minor: number | null;
  minorNoted: boolean;
  /** Who reviewed, e.g. "Codex · gpt-6.1-sol". */
  reviewer: string;
  model: string | null;
}

export interface UThread {
  /** A review thread's task, or a subproject task's subproject. */
  parentId: string | null;
  taskType: string | null;
  subproject: boolean;
  groupName: string | null;
  /** The model its own runs used most. */
  model: string | null;
  kind: string;
}

export interface TokenData {
  from: number;
  to: number;
  rows: URow[];
  reviews: UReview[];
  followUps: { taskId: string; createdBy: string; at: number }[];
  tasks: Record<string, ATask>;
  projects: Record<string, AProject>;
  threads: Record<string, UThread>;
  /** Runs that have ended but aren't counted yet. */
  pending: number;
  errors: string[];
}

export type Metric = "tokens" | "output" | "cost";

export const METRIC_LABEL: Record<Metric, string> = { tokens: "All tokens", output: "Output tokens", cost: "Cost" };

export interface Totals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  /** What Claude Code said it cost; Codex doesn't say. */
  cost: number;
  runs: number;
  /** Some of it is estimated. */
  estimated: boolean;
}

export const zero = (): Totals => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0, runs: 0, estimated: false });

/** Every token: uncached input, cache reads and writes, and output. */
export const allTokens = (t: Pick<Totals, "input" | "output" | "cacheRead" | "cacheWrite">) => t.input + t.output + t.cacheRead + t.cacheWrite;

export function value(t: Totals, m: Metric) {
  return m === "tokens" ? allTokens(t) : m === "output" ? t.output : t.cost;
}

export function add(t: Totals, r: URow | Totals) {
  t.input += r.input;
  t.output += r.output;
  t.cacheRead += r.cacheRead;
  t.cacheWrite += r.cacheWrite;
  t.reasoning += r.reasoning;
  t.cost += r.cost ?? 0;
  t.runs += "runId" in r ? 0 : r.runs;
  t.estimated ||= r.estimated;
}

/** Sums rows, counting each run once. */
export function total(rows: URow[]): Totals {
  const t = zero();
  const runs = new Set<string>();
  for (const r of rows) {
    add(t, r);
    runs.add(r.runId);
  }
  t.runs = runs.size;
  return t;
}

/** Token counts: 950, 12k, 1.2M, 3.4B. */
export function tokens(n: number) {
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0).replace(/\.0$/, "")}M`;
  return `${(n / 1_000_000_000).toFixed(n < 10_000_000_000 ? 1 : 0).replace(/\.0$/, "")}B`;
}

/** Ticks for a 0..max axis: at most four steps of 1, 2, 2.5 or 5 times a power of ten, and the axis's top. */
export function ticks(max: number): { top: number; ticks: number[] } {
  if (max <= 0) return { top: 1, ticks: [0] };
  const pow = 10 ** Math.floor(Math.log10(max / 4));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((st) => max / st <= 4)!;
  const top = Math.ceil(max / step) * step;
  const out = [];
  for (let i = 0; i * step <= top + step / 1e6; i++) out.push(i * step);
  return { top, ticks: out };
}

export const usd = (n: number) => (n >= 100 ? `$${Math.round(n).toLocaleString()}` : `$${n.toFixed(2)}`);

export function format(n: number, m: Metric) {
  return m === "cost" ? usd(n) : tokens(n);
}

export function purposeOf(d: Pick<TokenData, "threads">, r: Pick<URow, "threadId" | "runKind">): Purpose {
  const t = d.threads[r.threadId];
  if (t?.kind === "review") return t.taskType === "summary" ? "summary" : "review";
  if (r.runKind === "compact") return "compaction";
  if (t?.groupName) return "group";
  if (t?.taskType === "scratch") return "scratch";
  return "task";
}

/** The task a thread's tokens count towards: a review or summary thread's task, or the thread itself. */
export function ownerOf(d: Pick<TokenData, "threads">, threadId: string) {
  const t = d.threads[threadId];
  return t?.kind === "review" && t.parentId ? t.parentId : threadId;
}

/** The task a task is listed under: its subproject, if it's in one. */
export function topOf(d: Pick<TokenData, "threads">, taskId: string) {
  const t = d.threads[taskId];
  return t?.kind !== "review" && t?.parentId && d.threads[t.parentId]?.subproject ? t.parentId : taskId;
}

/** Rows grouped by `key`, biggest first by `metric`. */
export function groupBy<K extends string>(rows: URow[], key: (r: URow) => K, metric: Metric): { key: K; totals: Totals }[] {
  const groups = new Map<K, URow[]>();
  for (const r of rows) {
    const k = key(r);
    const g = groups.get(k);
    if (g) g.push(r);
    else groups.set(k, [r]);
  }
  return [...groups].map(([key, g]) => ({ key, totals: total(g) })).sort((a, b) => value(b.totals, metric) - value(a.totals, metric));
}

/** Each day's totals by purpose; `days` are the days' starts, in order. */
export function byDay(d: TokenData, rows: URow[], days: number[]): { day: number; parts: Record<Purpose, Totals> }[] {
  const out = days.map((day) => ({ day, parts: Object.fromEntries(PURPOSES.map((p) => [p, zero()])) as Record<Purpose, Totals> }));
  for (const r of rows) {
    let i = days.length - 1;
    while (i > 0 && days[i] > r.at) i--;
    if (i < 0 || r.at < days[0]) continue;
    add(out[i].parts[purposeOf(d, r)], r);
  }
  return out;
}

/** A task's tokens: its own, its review and summary threads' and its compactions', and for a subproject its tasks' (in `parts` too). */
export interface TaskUsage {
  taskId: string;
  totals: Totals;
  parts: Partial<Record<Purpose, Totals>>;
  /** The models its tokens went to, biggest first. */
  models: { model: string; totals: Totals }[];
  /** A subproject's tasks. */
  children: TaskUsage[];
}

export function byTask(d: TokenData, rows: URow[], metric: Metric): TaskUsage[] {
  const own = new Map<string, URow[]>();
  for (const r of rows) {
    const id = ownerOf(d, r.threadId);
    const g = own.get(id);
    if (g) g.push(r);
    else own.set(id, [r]);
  }
  // A subproject's tasks' rows, and the tasks each top-level one lists.
  const childRows = new Map<string, URow[]>();
  const tops = new Map<string, string[]>();
  for (const id of own.keys()) {
    const top = topOf(d, id);
    if (top !== id) {
      childRows.set(id, own.get(id)!);
      tops.set(top, [...(tops.get(top) ?? []), id]);
    } else if (!tops.has(id)) tops.set(id, []);
  }
  const usage = (taskId: string, rs: URow[], children: TaskUsage[]): TaskUsage => {
    const all = [...rs, ...children.flatMap((c) => childRows.get(c.taskId) ?? [])];
    const parts: Partial<Record<Purpose, Totals>> = {};
    for (const p of PURPOSES) {
      const of = all.filter((r) => purposeOf(d, r) === p);
      if (of.length) parts[p] = total(of);
    }
    return { taskId, totals: total(all), parts, models: groupBy(all, (r) => r.model, metric).map((g) => ({ model: g.key, totals: g.totals })), children };
  };
  const sort = (xs: TaskUsage[]) => xs.sort((a, b) => value(b.totals, metric) - value(a.totals, metric));
  return sort(
    [...tops].map(([top, kids]) => {
      const children = sort(kids.map((k) => usage(k, own.get(k)!, [])));
      return usage(top, own.get(top) ?? [], children);
    }),
  );
}

/** A task's reviews, in rounds: each reviewer's thread is reviewed again each round. */
export interface TaskReviews {
  taskId: string;
  rounds: UReview[][];
  /** The model the task's own agent used most. */
  model: string | null;
  serious: number;
  minorNoted: boolean;
  /** Follow-up tasks its agent created after a review that noted minor issues. */
  followUps: number;
}

export function reviewsByTask(d: TokenData): TaskReviews[] {
  const byTask = new Map<string, UReview[]>();
  for (const r of d.reviews) byTask.set(r.taskId, [...(byTask.get(r.taskId) ?? []), r]);
  return [...byTask].map(([taskId, rs]) => {
    const seen = new Map<string, number>();
    const rounds: UReview[][] = [];
    for (const r of rs) {
      const n = seen.get(r.threadId) ?? 0;
      seen.set(r.threadId, n + 1);
      (rounds[n] ??= []).push(r);
    }
    const firstMinor = rs.find((r) => r.minorNoted)?.at;
    const followUps = firstMinor === undefined ? 0 : d.followUps.filter((f) => f.createdBy === taskId && f.at > firstMinor).length;
    return {
      taskId,
      rounds,
      model: d.threads[taskId]?.model ?? null,
      serious: rs.reduce((n, r) => n + r.serious, 0),
      minorNoted: firstMinor !== undefined,
      followUps,
    };
  });
}

export interface ReviewSummary {
  reviews: number;
  withIssues: number;
  serious: number;
  /** Minor issues listed, by the reviews that list them. */
  minor: number;
  minorListed: number;
  minorNoted: number;
  tasks: number;
  /** Tasks whose first round passed. */
  firstPassed: number;
  /** Rounds that found serious issues, across the tasks. */
  roundsWithIssues: number;
  /** Tasks with a review that noted minor issues, and those of them whose agent then created follow-ups. */
  minorTasks: number;
  minorTasksFollowedUp: number;
  followUps: number;
}

export function summarise(reviews: UReview[], tasks: TaskReviews[]): ReviewSummary {
  return {
    reviews: reviews.length,
    withIssues: reviews.filter((r) => r.verdict === "issues").length,
    serious: reviews.reduce((n, r) => n + r.serious, 0),
    minor: reviews.reduce((n, r) => n + (r.minor ?? 0), 0),
    minorListed: reviews.filter((r) => r.minor !== null).length,
    minorNoted: reviews.filter((r) => r.minorNoted).length,
    tasks: tasks.length,
    firstPassed: tasks.filter((t) => t.rounds[0]?.every((r) => r.verdict === "pass")).length,
    roundsWithIssues: tasks.reduce((n, t) => n + t.rounds.filter((round) => round.some((r) => r.verdict === "issues")).length, 0),
    minorTasks: tasks.filter((t) => t.minorNoted).length,
    minorTasksFollowedUp: tasks.filter((t) => t.followUps > 0).length,
    followUps: tasks.reduce((n, t) => n + t.followUps, 0),
  };
}

/** How each model's work fared in review: the tasks whose own agent used it most. */
export function byImplementer(d: TokenData, tasks: TaskReviews[]) {
  const groups = new Map<string, TaskReviews[]>();
  for (const t of tasks) {
    const m = t.model ?? "Unknown";
    groups.set(m, [...(groups.get(m) ?? []), t]);
  }
  return [...groups]
    .map(([model, ts]) => ({ model, summary: summarise(ts.flatMap((t) => d.reviews.filter((r) => r.taskId === t.taskId)), ts) }))
    .sort((a, b) => b.summary.tasks - a.summary.tasks);
}

/** What each reviewer found. */
export function byReviewer(reviews: UReview[]) {
  const groups = new Map<string, UReview[]>();
  for (const r of reviews) groups.set(r.reviewer, [...(groups.get(r.reviewer) ?? []), r]);
  return [...groups].map(([reviewer, rs]) => ({ reviewer, summary: summarise(rs, []) })).sort((a, b) => b.summary.reviews - a.summary.reviews);
}
