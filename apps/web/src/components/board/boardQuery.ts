import { documentsOnly, taskLabels, type HostTask as Task } from "@huntaway/client"
import type { Status } from "@huntaway/contracts"

/**
 * What a board shows: its filters and sort, which apply to the kanban board and the list alike. Filters of one kind match
 * any of their values; kinds together all have to match. The search doesn't filter the board: it lists what it finds
 * (HA-306, see `searchTasks`).
 */
export interface BoardQuery {
  statuses: Status[]
  kinds: TaskKind[]
  /** `<host>:<project id>`, or "" for tasks in no project (group and scratch tasks). */
  projects: string[]
  flags: TaskFlag[]
}

export const EMPTY_QUERY: BoardQuery = { statuses: [], kinds: [], projects: [], flags: [] }

/** What a task is, or a label it has, for the Type filter. */
export type TaskKind = "code" | "group" | "plan" | "artifact" | "diagram" | "scratch"

export const TASK_KINDS: { id: TaskKind; label: string }[] = [
  { id: "code", label: "Code task" },
  { id: "group", label: "Group task" },
  { id: "plan", label: "Plan" },
  { id: "artifact", label: "Artifact" },
  { id: "diagram", label: "Diagram" },
  { id: "scratch", label: "Scratch" },
]

export type TaskFlag = "running" | "starred" | "pr" | "reminder"

export const TASK_FLAGS: { id: TaskFlag; label: string; test: (t: Task) => boolean }[] = [
  { id: "running", label: "Agent running", test: (t) => t.running },
  { id: "starred", label: "Starred", test: (t) => t.starred },
  { id: "pr", label: "Has a pull request", test: (t) => !!t.pr_url },
  { id: "reminder", label: "Has a reminder", test: (t) => !!t.remind_at },
]

/** What a task is: one that makes only documents (a plan, artifact or diagram task from before they were labels) is its
 *  first label. */
export const taskKind = (t: Task): TaskKind =>
  !t.project_id && t.group_name ? "group" : t.task_type === "scratch" ? "scratch" : documentsOnly(t) ? (taskLabels(t)[0] ?? "code") : "code"

/** What the Type filter finds a task as: what it is, and its labels. */
export const taskKinds = (t: Task): TaskKind[] => [...new Set<TaskKind>([taskKind(t), ...taskLabels(t)])]

export type SortKey = "manual" | "activity" | "newest" | "oldest" | "title" | "cost"

export const SORTS: { id: SortKey; label: string }[] = [
  { id: "manual", label: "Manual (drag to order)" },
  { id: "activity", label: "Latest activity" },
  { id: "newest", label: "Newest first" },
  { id: "oldest", label: "Oldest first" },
  { id: "title", label: "Title" },
  { id: "cost", label: "Cost" },
]

export const isSortKey = (s: unknown): s is SortKey => SORTS.some((x) => x.id === s)

/** Whether the query leaves any task out. */
export const isFiltering = (q: BoardQuery) => q.statuses.length > 0 || q.kinds.length > 0 || q.projects.length > 0 || q.flags.length > 0

/** How many filters are set. */
export const filterCount = (q: BoardQuery) => q.statuses.length + q.kinds.length + q.projects.length + q.flags.length

/** Adds `value` to the list, or takes it out if it's there. */
export const toggled = <T>(list: T[], value: T) => (list.includes(value) ? list.filter((v) => v !== value) : [...list, value])

/** A test for the tasks the query keeps, except by status (the board leaves out a status's column or section instead). */
export function taskMatcher(q: BoardQuery): (t: Task) => boolean {
  const flags = TASK_FLAGS.filter((f) => q.flags.includes(f.id))
  return (t) => {
    if (q.kinds.length && !taskKinds(t).some((k) => q.kinds.includes(k))) return false
    if (q.projects.length && !q.projects.includes(t.project_id ? `${t.host_id}:${t.project_id}` : "")) return false
    return flags.every((f) => f.test(t))
  }
}

/** The words of a search, in lower case. */
export const searchWords = (text: string) => text.toLowerCase().split(/\s+/).filter(Boolean)

export interface SearchHit {
  task: Task
  /** Its key, e.g. "IA-12". */
  key: string
  project?: string | undefined
  archived: boolean
}

/**
 * The tasks with each word of `text`, in any case, in their key (`key`, e.g. "IA-12"), title, description, branch or
 * project name, best first: a key typed in full, then the tasks not done, then those done, then the archived ones; in
 * each, those with every word in their key or title first, then the latest active, then the newest (so ties don't depend on
 * the order `tasks` are in).
 */
export function searchTasks(
  tasks: Task[],
  text: string,
  key: (t: Task) => string,
  projectName: (t: Task) => string | undefined,
  archived: (t: Task) => boolean,
): SearchHit[] {
  const words = searchWords(text)
  if (!words.length) return []
  const whole = words.join(" ")
  const ranked: { hit: SearchHit; rank: number[] }[] = []
  for (const t of tasks) {
    const hit: SearchHit = { task: t, key: key(t), project: projectName(t), archived: archived(t) }
    const named = `${hit.key}\n${t.title}`.toLowerCase()
    const all = [named, t.description, t.branch ?? "", hit.project ?? ""].join("\n").toLowerCase()
    if (!words.every((w) => all.includes(w))) continue
    const exact = hit.key.toLowerCase() === whole
    ranked.push({ hit, rank: [exact ? 0 : 1, hit.archived ? 2 : t.status === "done" ? 1 : 0, words.every((w) => named.includes(w)) ? 0 : 1] })
  }
  return ranked
    .toSorted(
      (a, b) =>
        (a.rank[0] ?? 0) - (b.rank[0] ?? 0) ||
        (a.rank[1] ?? 0) - (b.rank[1] ?? 0) ||
        (a.rank[2] ?? 0) - (b.rank[2] ?? 0) ||
        b.hit.task.last_activity_at.localeCompare(a.hit.task.last_activity_at) ||
        b.hit.task.created_at.localeCompare(a.hit.task.created_at) ||
        b.hit.task.number - a.hit.task.number,
    )
    .map((r) => r.hit)
}

/** `text` in runs, those that are one of `words` (in any case) marked, to highlight. */
export function highlighted(text: string, words: string[]): { text: string; match: boolean; start: number }[] {
  const lower = text.toLowerCase()
  const marked = Array.from<boolean>({ length: text.length }).fill(false)
  for (const w of words) {
    if (!w) continue
    for (let i = lower.indexOf(w); i !== -1; i = lower.indexOf(w, i + 1)) marked.fill(true, i, i + w.length)
  }
  const runs: { text: string; match: boolean; start: number }[] = []
  for (let i = 0; i < text.length; i++) {
    const last = runs.at(-1)
    const ch = text.charAt(i)
    const match = marked[i] === true
    if (last && last.match === match) last.text += ch
    else runs.push({ text: ch, match, start: i })
  }
  return runs
}

/** Where in `text` (a description) the first of `words` is, with some of what's around it on one line; or nothing. */
export function snippet(text: string, words: string[], width = 90): string | undefined {
  const lower = text.toLowerCase()
  const at = Math.min(...words.map((w) => lower.indexOf(w)).filter((i) => i !== -1))
  if (!Number.isFinite(at)) return undefined
  const start = Math.max(0, at - 30)
  const line = text
    .slice(start, start + width)
    .replace(/\s+/g, " ")
    .trim()
  return (start > 0 ? "…" : "") + line + (start + width < text.length ? "…" : "")
}

/** Whether the board shows the column or section for `status`. */
export const showsStatus = (q: BoardQuery, status: Status) => !q.statuses.length || q.statuses.includes(status)

const by =
  <T>(f: (t: Task) => T, cmp: (a: T, b: T) => number) =>
  (a: Task, b: Task) =>
    cmp(f(a), f(b))
const later = (a: string, b: string) => b.localeCompare(a)
const COMPARE: Record<Exclude<SortKey, "manual">, (a: Task, b: Task) => number> = {
  activity: by((t) => t.last_activity_at, later),
  newest: by((t) => t.created_at, later),
  oldest: by(
    (t) => t.created_at,
    (a, b) => a.localeCompare(b),
  ),
  title: by(
    (t) => t.title,
    (a, b) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true }),
  ),
  cost: by(
    (t) => t.cost_usd,
    (a, b) => b - a,
  ),
}

/** `tasks` in the order of `sort`; ties, and "manual", keep the order they're in. */
export const sortTasks = (tasks: Task[], sort: SortKey) => (sort === "manual" ? tasks : tasks.toSorted(COMPARE[sort]))
