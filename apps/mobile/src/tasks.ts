// A project's tasks as the app lists them.
import { STATUSES, type Status, type Task } from "@huntaway/client";

/** The columns shown, in the board's order, with Done last and only its latest tasks. */
const ORDER: Status[] = ["needs_attention", "in_progress", "in_review", "ready_for_merge", "todo", "backlog", "done"];
const DONE_SHOWN = 20;

export function groupTasks(tasks: Task[]) {
  return ORDER.map((status) => {
    let list = tasks.filter((t) => t.status === status && t.kind === "task");
    list =
      status === "done"
        ? list.sort((a, b) => (b.done_at ?? b.updated_at).localeCompare(a.done_at ?? a.updated_at)).slice(0, DONE_SHOWN)
        : list.sort((a, b) => a.position - b.position);
    return { status, title: STATUSES.find((x) => x.id === status)?.label ?? status, data: list };
  }).filter((g) => g.data.length);
}

/** `list` with `t` in it, in place of the task with its id. */
export const upsert = (list: Task[], t: Task) => (list.some((x) => x.id === t.id) ? list.map((x) => (x.id === t.id ? t : x)) : [...list, t]);
