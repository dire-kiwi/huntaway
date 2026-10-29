import type { DocumentType, Task } from "./api";

/**
 * A plan, artifact or diagram task's document is ready for the user once there is one and its agent
 * isn't working on it (running or queued) or waiting on them (needs attention, answered in the thread).
 */
export const documentReady = (task: Task) => !!task.document_at && !task.running && task.status !== "in_progress" && task.status !== "needs_attention";

/**
 * The tab a task opens on. A plan, artifact or diagram task opens on its document when it's ready, and
 * otherwise on the thread. Any other task not started yet (to do or backlog) opens on its details, the
 * rest on the thread.
 */
export function openingTab(task: Task | undefined): string {
  // As `documentType`, which this doesn't import so that it runs in the unit tests.
  const doc = task?.task_type && task.task_type !== "scratch" ? (task.task_type as DocumentType) : undefined;
  if (doc) return documentReady(task!) ? doc : "thread";
  return task?.status === "todo" || task?.status === "backlog" ? "details" : "thread";
}
