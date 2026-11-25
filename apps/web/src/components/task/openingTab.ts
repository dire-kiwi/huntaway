import { documentsOnly, taskLabels, type HostTask as Task } from "@huntaway/client"

type Opened = Pick<Task, "kind" | "task_type" | "labels" | "work_dir" | "status" | "running" | "document_at">

/**
 * A task's documents are ready for the user once there is one and its agent isn't working on them (running or queued)
 * or waiting on them (needs attention, answered in the thread).
 */
export const documentReady = (task: Opened): boolean =>
  !!task.document_at && !task.running && task.status !== "in_progress" && task.status !== "needs_attention"

/**
 * The tab a task opens on. A task with labels opens on its first label's document when it's ready. Otherwise one that
 * makes only documents opens on the thread, and any other task not started yet (to do or backlog) on its details, the
 * rest on the thread: one whose review passed too, with the summary of its changes folded at its bottom (HE-55). The
 * profile's assistant, which is back in To do after each reply, is a conversation: it always opens on the thread, and so
 * do the profile's pens thread, its pens' own threads and a stack's own thread (HE-105).
 */
export function openingTab(task: Opened | undefined): string {
  if (!task) return "thread"
  const [label] = taskLabels(task)
  if (label !== undefined && documentReady(task)) return label
  if (documentsOnly(task)) return "thread"
  if (task.kind === "task" && (task.task_type === "assistant" || task.task_type === "pens" || task.task_type === "pen" || task.task_type === "stack"))
    return "thread"
  return task.status === "todo" || task.status === "backlog" ? "details" : "thread"
}
