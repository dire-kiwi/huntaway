import { documentsOnly, taskLabels, type HostTask as Task } from "@huntaway/client"

type Opened = Pick<Task, "kind" | "task_type" | "labels" | "work_dir" | "status" | "running" | "document_at" | "review" | "summaries">

/**
 * A task's documents are ready for the user once there is one and its agent isn't working on them (running or queued)
 * or waiting on them (needs attention, answered in the thread).
 */
export const documentReady = (task: Opened): boolean =>
  !!task.document_at && !task.running && task.status !== "in_progress" && task.status !== "needs_attention"

/**
 * Whether a task waits in In review with its review passed and a summary of the changes it passed (written or being
 * written), which is then what it opens on.
 */
export const summaryReady = (task: Opened): boolean =>
  task.kind === "task" &&
  task.status === "in_review" &&
  !task.running &&
  task.review?.state === "passed" &&
  task.summaries.some((s) => (s.state === "done" || s.state === "running") && s.head === task.review?.head)

/**
 * The tab a task opens on. A task with labels opens on its first label's document when it's ready, and one whose
 * review passed on the summary of its changes (see summaryReady). Otherwise one that makes only documents opens on the
 * thread, and any other task not started yet (to do or backlog) on its details, the rest on the thread. The profile's
 * assistant, which is back in To do after each reply, is a conversation: it always opens on the thread, and so do the
 * profile's pens thread and its pens' own threads.
 */
export function openingTab(task: Opened | undefined): string {
  if (!task) return "thread"
  const [label] = taskLabels(task)
  if (label !== undefined && documentReady(task)) return label
  if (summaryReady(task)) return "summary"
  if (documentsOnly(task)) return "thread"
  if (task.kind === "task" && (task.task_type === "assistant" || task.task_type === "pens" || task.task_type === "pen")) return "thread"
  return task.status === "todo" || task.status === "backlog" ? "details" : "thread"
}
