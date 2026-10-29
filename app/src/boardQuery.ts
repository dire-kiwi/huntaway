import type { Status, Task } from "./api";

/**
 * What a board shows: its search, filters and sort, which apply to the kanban board and the list
 * alike. Filters of one kind match any of their values; kinds together all have to match.
 */
export interface BoardQuery {
  search: string;
  statuses: Status[];
  kinds: TaskKind[];
  /** `<host>:<project id>`, or "" for tasks in no project (group and scratch tasks). */
  projects: string[];
  flags: TaskFlag[];
}

export const EMPTY_QUERY: BoardQuery = { search: "", statuses: [], kinds: [], projects: [], flags: [] };

/** What a task is, for the Type filter. */
export type TaskKind = "code" | "subproject" | "group" | "plan" | "artifact" | "diagram" | "scratch";

export const TASK_KINDS: { id: TaskKind; label: string }[] = [
  { id: "code", label: "Code task" },
  { id: "subproject", label: "Subproject" },
  { id: "group", label: "Group task" },
  { id: "plan", label: "Plan" },
  { id: "artifact", label: "Artifact" },
  { id: "diagram", label: "Diagram" },
  { id: "scratch", label: "Scratch" },
];

export type TaskFlag = "running" | "starred" | "pr" | "reminder";

export const TASK_FLAGS: { id: TaskFlag; label: string; test: (t: Task) => boolean }[] = [
  { id: "running", label: "Agent running", test: (t) => t.running },
  { id: "starred", label: "Starred", test: (t) => !!t.starred },
  { id: "pr", label: "Has a pull request", test: (t) => !!t.pr_url },
  { id: "reminder", label: "Has a reminder", test: (t) => !!t.remind_at },
];

export const taskKind = (t: Task): TaskKind =>
  t.subproject ? "subproject" : !t.project_id && t.group_name ? "group" : t.task_type ? t.task_type : "code";

export type SortKey = "manual" | "activity" | "newest" | "oldest" | "title" | "cost";

export const SORTS: { id: SortKey; label: string }[] = [
  { id: "manual", label: "Manual (drag to order)" },
  { id: "activity", label: "Latest activity" },
  { id: "newest", label: "Newest first" },
  { id: "oldest", label: "Oldest first" },
  { id: "title", label: "Title" },
  { id: "cost", label: "Cost" },
];

export const isSortKey = (s: unknown): s is SortKey => SORTS.some((x) => x.id === s);

/** Whether the query leaves any task out. */
export const isFiltering = (q: BoardQuery) => !!q.search.trim() || q.statuses.length > 0 || q.kinds.length > 0 || q.projects.length > 0 || q.flags.length > 0;

/** How many filters are set, not counting the search. */
export const filterCount = (q: BoardQuery) => q.statuses.length + q.kinds.length + q.projects.length + q.flags.length;

/** Adds `value` to the list, or takes it out if it's there. */
export const toggled = <T>(list: T[], value: T) => (list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);

/**
 * A test for the tasks the query keeps, except by status (the board leaves out a status's column
 * or section instead). The search matches each of its words, in any case, in the task's key
 * (`key`, e.g. "IA-12"), title, description, branch or project name.
 */
export function taskMatcher(q: BoardQuery, key: (t: Task) => string, projectName: (t: Task) => string | undefined): (t: Task) => boolean {
  const words = q.search.toLowerCase().split(/\s+/).filter(Boolean);
  const flags = TASK_FLAGS.filter((f) => q.flags.includes(f.id));
  return (t) => {
    if (q.kinds.length && !q.kinds.includes(taskKind(t))) return false;
    if (q.projects.length && !q.projects.includes(t.project_id ? `${t.host_id}:${t.project_id}` : "")) return false;
    if (!flags.every((f) => f.test(t))) return false;
    if (!words.length) return true;
    const text = [key(t), t.title, t.description, t.branch ?? "", projectName(t) ?? ""].join("\n").toLowerCase();
    return words.every((w) => text.includes(w));
  };
}

/** Whether the board shows the column or section for `status`. */
export const showsStatus = (q: BoardQuery, status: Status) => !q.statuses.length || q.statuses.includes(status);

const by = <T>(f: (t: Task) => T, cmp: (a: T, b: T) => number) => (a: Task, b: Task) => cmp(f(a), f(b));
const later = (a: string, b: string) => b.localeCompare(a);
const COMPARE: Record<Exclude<SortKey, "manual">, (a: Task, b: Task) => number> = {
  activity: by((t) => t.last_activity_at, later),
  newest: by((t) => t.created_at, later),
  oldest: by((t) => t.created_at, (a, b) => a.localeCompare(b)),
  title: by((t) => t.title, (a, b) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true })),
  cost: by((t) => t.cost_usd, (a, b) => b - a),
};

/** `tasks` in the order of `sort`; ties, and "manual", keep the order they're in. */
export const sortTasks = (tasks: Task[], sort: SortKey) => (sort === "manual" ? tasks : [...tasks].sort(COMPARE[sort]));
