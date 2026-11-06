import type { Task } from "./api";

/** Hosts from this API version on keep which tasks are in Now (`now_at`), and set it with `now`. */
export const NOW_API = 97;

/** Which tasks a board shows: those in Now, those in Later (where tasks start), or all of them. */
export type Focus = "now" | "later" | "all";

export const FOCUSES: { id: Focus; label: string; title: string }[] = [
  { id: "now", label: "Now", title: "Only the tasks in Now: those you've prompted or updated lately, or moved there" },
  { id: "later", label: "Later", title: "Only the tasks in Later, where tasks start" },
  { id: "all", label: "All", title: "Every task" },
];

export const isFocus = (v: unknown): v is Focus => FOCUSES.some((f) => f.id === v);

/** Whether the task is in Now (every other task is in Later). */
export const isNow = (t: Pick<Task, "now_at">) => !!t.now_at;

/** Whether a board showing `focus` shows the task. */
export const inFocus = (t: Pick<Task, "now_at">, focus: Focus) => focus === "all" || (focus === "now") === isNow(t);
