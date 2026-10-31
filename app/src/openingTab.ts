import type { Task } from "./api";
// With its extension, for the unit tests (which run it in node).
import { documentsOnly, taskLabels } from "./labels.ts";

/**
 * A task's documents are ready for the user once there is one and its agent isn't working on them (running or queued)
 * or waiting on them (needs attention, answered in the thread).
 */
export const documentReady = (task: Task) => !!task.document_at && !task.running && task.status !== "in_progress" && task.status !== "needs_attention";

/**
 * The tab a task opens on. A task with labels opens on its first label's document when it's ready. Otherwise one that
 * makes only documents opens on the thread, and any other task not started yet (to do or backlog) on its details, the
 * rest on the thread.
 */
export function openingTab(task: Task | undefined): string {
  const labels = task ? taskLabels(task) : [];
  if (labels.length && documentReady(task!)) return labels[0];
  if (task && documentsOnly(task)) return "thread";
  return task?.status === "todo" || task?.status === "backlog" ? "details" : "thread";
}
