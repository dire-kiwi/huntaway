import type { ATask, AProject } from "./analytics/analytics"

/**
 * Statistics on the tokens agents use and what reviews find (see server agent/tokens.rs and
 * review/stats.rs): where tokens go (tasks' own work, reviews, summaries, compactions), on which
 * models, and how often each model's work passes review.
 *
 * A review or summary thread's tokens count towards the task it's for, and a subproject's tasks'
 * towards the subproject, which lists them. The board's own model calls that aren't runs (task
 * titles and 5-hour window restarts, see server agent/tokens/calls.rs) count in the totals, but
 * not towards tasks.
 */

/** What a run's (or a call's) tokens were spent on. */
export type Purpose = "task" | "review" | "summary" | "compaction" | "scratch" | "group" | "title" | "window"

export const PURPOSES: Purpose[] = ["task", "review", "summary", "compaction", "scratch", "group", "title", "window"]

export const PURPOSE_LABEL: Record<Purpose, string> = {
  task: "Tasks",
  review: "Reviews",
  summary: "Summaries",
  compaction: "Compactions",
  scratch: "Scratch",
  group: "Group tasks",
  title: "Titles",
  window: "Window restarts",
}

export const PURPOSE_HINT: Record<Purpose, string> = {
  task: "Agents working on tasks",
  review: "Reviewers reviewing tasks' changes",
  summary: "Summaries of tasks' changes, written once their review passed",
  compaction: "Compacting threads' conversations (the board's after a thread sat idle, and /compact)",
  scratch: "Scratch tasks, in no project",
  group: "Group tasks, planning the work across a group's projects",
  title: "Writing tasks' titles, as they're created and on each message the user sends them",
  window: "The short prompts that start a login's next 5-hour window as the last one ends",
}

/** A value for each purpose, in the order of `PURPOSES`. */
export function perPurpose<T>(f: (p: Purpose) => T): Record<Purpose, T> {
  return {
    task: f("task"),
    review: f("review"),
    summary: f("summary"),
    compaction: f("compaction"),
    scratch: f("scratch"),
    group: f("group"),
    title: f("title"),
    window: f("window"),
  }
}

/** What one run used of one model, or one of the board's model calls that isn't a run (`runId` null). */
export interface URow {
  at: number
  runId: string | null
  /** A call's that isn't a run: the rows of one call (one for each model it used) share it. */
  callId: string | null
  /** The thread it ran in: a task, or a review or summary thread. A title's task; null for a window restart. */
  threadId: string | null
  runKind: string
  model: string
  /** "claude" or "codex", as the host reports it. */
  runtime: string
  /** Input that wasn't read from or written to the cache. */
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  /** The part of `cacheWrite` written to the 1-hour cache, and to the 5-minute one; null where it isn't known (Codex's, and older runs). */
  cacheWrite1h: number | null
  cacheWrite5m: number | null
  reasoning: number
  cost: number | null
  estimated: boolean
}

export interface UReview {
  at: number
  /** The task reviewed. */
  taskId: string
  threadId: string
  /** "pass" or "issues", as the host reports it. */
  verdict: string
  serious: number
  minor: number | null
  minorNoted: boolean
  /** Who reviewed, e.g. "Codex · gpt-6.1-sol". */
  reviewer: string
  model: string | null
  /** Which of its task's rounds of review it was in, from 1. */
  round: number
  /** The effort the reviewed task's agent was set to work at; null is the agent's own default (or a host that doesn't say). */
  effort: string | null
  /** The model the reviewed task's agent used most in the run before the review, if known. */
  taskModel: string | null
}

/** One round of review of a task: its reviewers' submissions together. */
export interface URound {
  taskId: string
  /** From 1, in the order the task's rounds started. */
  round: number
  at: number
  /** `issues` if a reviewer found serious issues, else `pass` (as the host reports it). */
  verdict: string
  serious: number
  reviewers: number
}

export interface UThread {
  /** A review thread's task, or a subproject task's subproject. */
  parentId: string | null
  taskType: string | null
  subproject: boolean
  groupName: string | null
  /** The model its own runs used most. */
  model: string | null
  kind: string
}

export interface TokenData {
  from: number
  to: number
  rows: URow[]
  reviews: UReview[]
  /** Every round of review of the tasks `reviews` are for, those before the range included. */
  rounds: URound[]
  followUps: { taskId: string; createdBy: string; at: number }[]
  tasks: Record<string, ATask>
  projects: Record<string, AProject>
  threads: Record<string, UThread>
  /** Runs that have ended but aren't counted yet. */
  pending: number
  errors: string[]
}

export type Metric = "tokens" | "output" | "cost"

export const METRIC_LABEL: Record<Metric, string> = { tokens: "All tokens", output: "Output tokens", cost: "Cost" }

export interface Totals {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  /** Cache writes to the 1-hour cache and to the 5-minute one, where that's known. */
  cacheWrite1h: number
  cacheWrite5m: number
  /** Claude's cache writes from runs that didn't say which cache (older ones). Codex never says: its writes are in none of the three. */
  cacheWriteUnsplit: number
  reasoning: number
  /** What Claude Code said it cost; Codex doesn't say. */
  cost: number
  runs: number
  /** Model calls that aren't runs (titles and window restarts). */
  calls: number
  /** Some of it is estimated. */
  estimated: boolean
}

export const zero = (): Totals => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cacheWrite1h: 0,
  cacheWrite5m: 0,
  cacheWriteUnsplit: 0,
  reasoning: 0,
  cost: 0,
  runs: 0,
  calls: 0,
  estimated: false,
})

/** Every token: uncached input, cache reads and writes, and output. */
export const allTokens = (t: Pick<Totals, "input" | "output" | "cacheRead" | "cacheWrite">) => t.input + t.output + t.cacheRead + t.cacheWrite

/** The input fed to the model: uncached, read from the cache and written to it. */
export const fedTokens = (t: Pick<Totals, "input" | "cacheRead" | "cacheWrite">) => t.input + t.cacheRead + t.cacheWrite

/** The share of the input fed in that was read from the cache; null with none fed in. */
export function hitRate(t: Pick<Totals, "input" | "cacheRead" | "cacheWrite">): number | null {
  const fed = fedTokens(t)
  return fed ? t.cacheRead / fed : null
}

/** A hit rate below this, on at least `POOR_HIT_MIN` tokens of input, is flagged: the cache is being written and not read (busted). */
export const POOR_HIT = 0.85
export const POOR_HIT_MIN = 1_000_000

export function poorHit(t: Pick<Totals, "input" | "cacheRead" | "cacheWrite">) {
  return fedTokens(t) >= POOR_HIT_MIN && (hitRate(t) ?? 1) < POOR_HIT
}

/** Codex's cache writes, which don't say which cache they went to. */
export const codexWrites = (t: Totals) => t.cacheWrite - t.cacheWrite1h - t.cacheWrite5m - t.cacheWriteUnsplit

export function value(t: Totals, m: Metric) {
  return m === "tokens" ? allTokens(t) : m === "output" ? t.output : t.cost
}

export function add(t: Totals, r: URow | Totals) {
  t.input += r.input
  t.output += r.output
  t.cacheRead += r.cacheRead
  t.cacheWrite += r.cacheWrite
  if (!("runId" in r)) {
    t.cacheWrite1h += r.cacheWrite1h
    t.cacheWrite5m += r.cacheWrite5m
    t.cacheWriteUnsplit += r.cacheWriteUnsplit
  } else if (r.cacheWrite1h !== null && r.cacheWrite5m !== null) {
    t.cacheWrite1h += r.cacheWrite1h
    t.cacheWrite5m += r.cacheWrite5m
  } else if (r.runtime === "claude") t.cacheWriteUnsplit += r.cacheWrite
  t.reasoning += r.reasoning
  t.cost += r.cost ?? 0
  t.runs += "runId" in r ? 0 : r.runs
  t.calls += "runId" in r ? 0 : r.calls
  t.estimated ||= r.estimated
}

/** Sums rows, counting each run once, and each call's rows (one for each model it used) as a call. */
export function total(rows: URow[]): Totals {
  const t = zero()
  const runs = new Set<string>()
  const calls = new Set<string>()
  for (const r of rows) {
    add(t, r)
    if (r.runId !== null) runs.add(r.runId)
    else if (r.callId !== null) calls.add(r.callId)
  }
  t.runs = runs.size
  t.calls = calls.size
  return t
}

/** Token counts: 950, 12k, 1.2M, 3.4B. */
export function tokens(n: number) {
  if (n < 1000) return String(Math.round(n))
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0).replace(/\.0$/, "")}M`
  return `${(n / 1_000_000_000).toFixed(n < 10_000_000_000 ? 1 : 0).replace(/\.0$/, "")}B`
}

/** Ticks for a 0..max axis: at most four steps of 1, 2, 2.5 or 5 times a power of ten, and the axis's top. */
export function ticks(max: number): { top: number; ticks: number[] } {
  if (max <= 0) return { top: 1, ticks: [0] }
  const pow = 10 ** Math.floor(Math.log10(max / 4))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((st) => max / st <= 4) ?? 10 * pow
  const top = Math.ceil(max / step) * step
  const out = []
  for (let i = 0; i * step <= top + step / 1e6; i++) out.push(i * step)
  return { top, ticks: out }
}

export const usd = (n: number) => (n >= 100 ? `$${Math.round(n).toLocaleString()}` : `$${n.toFixed(2)}`)

export function format(n: number, m: Metric) {
  return m === "cost" ? usd(n) : tokens(n)
}

export function purposeOf(d: Pick<TokenData, "threads">, r: Pick<URow, "runId" | "threadId" | "runKind">): Purpose {
  if (r.runId === null) return r.runKind === "window" ? "window" : "title"
  const t = r.threadId === null ? undefined : d.threads[r.threadId]
  if (t?.kind === "review") return t.taskType === "summary" ? "summary" : "review"
  if (r.runKind === "compact") return "compaction"
  if (t?.groupName) return "group"
  if (t?.taskType === "scratch") return "scratch"
  return "task"
}

/** The task a thread's tokens count towards: a review or summary thread's task, or the thread itself. */
export function ownerOf(d: Pick<TokenData, "threads">, threadId: string) {
  const t = d.threads[threadId]
  return t?.kind === "review" && t.parentId ? t.parentId : threadId
}

/** The task a task is listed under: its subproject, if it's in one. */
export function topOf(d: Pick<TokenData, "threads">, taskId: string) {
  const t = d.threads[taskId]
  return t?.kind !== "review" && t?.parentId && d.threads[t.parentId]?.subproject ? t.parentId : taskId
}

/** Rows grouped by `key`, biggest first by `metric`. */
export function groupBy<K extends string>(rows: URow[], key: (r: URow) => K, metric: Metric): { key: K; totals: Totals }[] {
  const groups = new Map<K, URow[]>()
  for (const r of rows) {
    const k = key(r)
    const g = groups.get(k)
    if (g) g.push(r)
    else groups.set(k, [r])
  }
  return [...groups].map(([k, g]) => ({ key: k, totals: total(g) })).toSorted((a, b) => value(b.totals, metric) - value(a.totals, metric))
}

/** Each day's totals by purpose; `days` are the days' starts, in order. */
export function byDay(d: TokenData, rows: URow[], days: number[]): { day: number; parts: Record<Purpose, Totals> }[] {
  const out = days.map((day) => ({ day, parts: perPurpose(() => zero()) }))
  for (const r of rows) {
    let i = days.length - 1
    while (i > 0 && (days[i] ?? 0) > r.at) i--
    const slot = out[i]
    if (i < 0 || r.at < (days[0] ?? 0) || slot === undefined) continue
    add(slot.parts[purposeOf(d, r)], r)
  }
  return out
}

/** A task's tokens: its own, its review and summary threads' and its compactions', and for a subproject its tasks' (in `parts` too). */
export interface TaskUsage {
  taskId: string
  totals: Totals
  parts: Partial<Record<Purpose, Totals>>
  /** The models its tokens went to, biggest first. */
  models: { model: string; totals: Totals }[]
  /** A subproject's tasks. */
  children: TaskUsage[]
}

export function byTask(d: TokenData, rows: URow[], metric: Metric): TaskUsage[] {
  const own = new Map<string, URow[]>()
  for (const r of rows) {
    // Calls that aren't runs aren't the task's agents' work.
    if (r.runId === null || r.threadId === null) continue
    const id = ownerOf(d, r.threadId)
    const g = own.get(id)
    if (g) g.push(r)
    else own.set(id, [r])
  }
  // A subproject's tasks' rows, and the tasks each top-level one lists.
  const childRows = new Map<string, URow[]>()
  const tops = new Map<string, string[]>()
  for (const id of own.keys()) {
    const top = topOf(d, id)
    if (top !== id) {
      childRows.set(id, own.get(id) ?? [])
      tops.set(top, [...(tops.get(top) ?? []), id])
    } else if (!tops.has(id)) tops.set(id, [])
  }
  const usage = (taskId: string, rs: URow[], children: TaskUsage[]): TaskUsage => {
    const all = [...rs, ...children.flatMap((c) => childRows.get(c.taskId) ?? [])]
    const parts: Partial<Record<Purpose, Totals>> = {}
    for (const p of PURPOSES) {
      const of = all.filter((r) => purposeOf(d, r) === p)
      if (of.length) parts[p] = total(of)
    }
    return { taskId, totals: total(all), parts, models: groupBy(all, (r) => r.model, metric).map((g) => ({ model: g.key, totals: g.totals })), children }
  }
  const sort = (xs: TaskUsage[]) => xs.toSorted((a, b) => value(b.totals, metric) - value(a.totals, metric))
  return sort(
    [...tops].map(([top, kids]) => {
      const children = sort(kids.map((k) => usage(k, own.get(k) ?? [], [])))
      return usage(top, own.get(top) ?? [], children)
    }),
  )
}

/** A task's reviews: all of its rounds, those outside the range too, so its first round is its first. */
export interface TaskReviews {
  taskId: string
  rounds: URound[]
  /** The model the task's own agent used most. */
  model: string | null
  serious: number
  minorNoted: boolean
  /** Follow-up tasks its agent created after a review that noted minor issues. */
  followUps: number
}

export function reviewsByTask(d: TokenData): TaskReviews[] {
  const grouped = new Map<string, UReview[]>()
  for (const r of d.reviews) grouped.set(r.taskId, [...(grouped.get(r.taskId) ?? []), r])
  return [...grouped].map(([taskId, rs]) => {
    const rounds = d.rounds.filter((r) => r.taskId === taskId).toSorted((a, b) => a.round - b.round)
    const firstMinor = rs.find((r) => r.minorNoted)?.at
    const followUps = firstMinor === undefined ? 0 : d.followUps.filter((f) => f.createdBy === taskId && f.at > firstMinor).length
    return {
      taskId,
      rounds,
      model: d.threads[taskId]?.model ?? null,
      serious: rs.reduce((n, r) => n + r.serious, 0),
      minorNoted: firstMinor !== undefined,
      followUps,
    }
  })
}

export interface ReviewSummary {
  reviews: number
  withIssues: number
  serious: number
  /** Minor issues listed, by the reviews that list them. */
  minor: number
  minorListed: number
  minorNoted: number
  tasks: number
  /** Tasks whose first round passed. */
  firstPassed: number
  /** Rounds that found serious issues, across the tasks. */
  roundsWithIssues: number
  /** Tasks with a review that noted minor issues, and those of them whose agent then created follow-ups. */
  minorTasks: number
  minorTasksFollowedUp: number
  followUps: number
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
    firstPassed: tasks.filter((t) => t.rounds[0]?.verdict === "pass").length,
    roundsWithIssues: tasks.reduce((n, t) => n + t.rounds.filter((r) => r.verdict === "issues").length, 0),
    minorTasks: tasks.filter((t) => t.minorNoted).length,
    minorTasksFollowedUp: tasks.filter((t) => t.followUps > 0).length,
    followUps: tasks.reduce((n, t) => n + t.followUps, 0),
  }
}

/** How each model's work fared in review: the tasks whose own agent used it most. */
export function byImplementer(d: TokenData, tasks: TaskReviews[]) {
  const groups = new Map<string, TaskReviews[]>()
  for (const t of tasks) {
    const m = t.model ?? "Unknown"
    groups.set(m, [...(groups.get(m) ?? []), t])
  }
  return [...groups]
    .map(([model, ts]) => ({
      model,
      summary: summarise(
        ts.flatMap((t) => d.reviews.filter((r) => r.taskId === t.taskId)),
        ts,
      ),
    }))
    .toSorted((a, b) => b.summary.tasks - a.summary.tasks)
}

/** What each reviewer found. */
export function byReviewer(reviews: UReview[]) {
  const groups = new Map<string, UReview[]>()
  for (const r of reviews) groups.set(r.reviewer, [...(groups.get(r.reviewer) ?? []), r])
  return [...groups].map(([reviewer, rs]) => ({ reviewer, summary: summarise(rs, []) })).toSorted((a, b) => b.summary.reviews - a.summary.reviews)
}

/** How many serious issues reviews found in the work of one model, at one effort or all of them. */
export interface IssueCell {
  tasks: number
  reviews: number
  /** Reviews that found serious issues. */
  withIssues: number
  serious: number
}

export interface IssueRow {
  /** The model that did the work. */
  model: string
  /** All of its efforts. */
  all: IssueCell
  byEffort: Record<string, IssueCell>
}

/** The key an effort is kept under: the agent's own default has none of its own. */
export const DEFAULT_EFFORT = "default"

const EFFORT_ORDER = ["minimal", "low", "medium", "high", "xhigh", "max"]

/** Efforts lowest first, unknown ones after them, the agent's default last. */
const effortRank = (e: string) => (e === DEFAULT_EFFORT ? Infinity : EFFORT_ORDER.includes(e) ? EFFORT_ORDER.indexOf(e) : EFFORT_ORDER.length)

type Acc = { tasks: Set<string>; reviews: number; withIssues: number; serious: number }
const acc = (): Acc => ({ tasks: new Set(), reviews: 0, withIssues: 0, serious: 0 })

export const effortLabel = (e: string) => (e === DEFAULT_EFFORT ? "Default" : e)

/** The model that did the work a review is of: the one its task's agent used before the review, else the task's most used. */
export function implementerOf(d: Pick<TokenData, "threads">, r: UReview) {
  return r.taskModel ?? d.threads[r.taskId]?.model ?? "Unknown"
}

/**
 * The serious issues reviews found, by the model that did the work and the effort it worked at, with the totals of each
 * model across its efforts (`all`), of each effort across the models (`total.byEffort`) and of everything (`total.all`).
 * `efforts` are the efforts seen, lowest first, the agent's default last.
 */
export function issuesByModelAndEffort(d: Pick<TokenData, "threads">, reviews: UReview[]): { efforts: string[]; models: IssueRow[]; total: IssueRow } {
  const cell = (a: Acc): IssueCell => ({ tasks: a.tasks.size, reviews: a.reviews, withIssues: a.withIssues, serious: a.serious })
  const rows = new Map<string, { all: Acc; byEffort: Map<string, Acc> }>()
  const overall = { all: acc(), byEffort: new Map<string, Acc>() }
  const put = (a: Acc, r: UReview) => {
    a.tasks.add(r.taskId)
    a.reviews++
    if (r.verdict === "issues") a.withIssues++
    a.serious += r.serious
  }
  for (const r of reviews) {
    const model = implementerOf(d, r)
    const effort = r.effort?.trim() || DEFAULT_EFFORT
    let row = rows.get(model)
    if (!row) rows.set(model, (row = { all: acc(), byEffort: new Map() }))
    for (const g of [row, overall]) {
      put(g.all, r)
      let a = g.byEffort.get(effort)
      if (!a) g.byEffort.set(effort, (a = acc()))
      put(a, r)
    }
  }
  const efforts = [...overall.byEffort.keys()].toSorted((a, b) => effortRank(a) - effortRank(b) || a.localeCompare(b))
  const out = (model: string, g: { all: Acc; byEffort: Map<string, Acc> }): IssueRow => ({
    model,
    all: cell(g.all),
    byEffort: Object.fromEntries([...g.byEffort].map(([e, a]) => [e, cell(a)])),
  })
  const models = [...rows]
    .map(([m, g]) => out(m, g))
    .toSorted((a, b) => b.all.serious - a.all.serious || b.all.reviews - a.all.reviews || a.model.localeCompare(b.model))
  return { efforts, models, total: out("All models", overall) }
}
