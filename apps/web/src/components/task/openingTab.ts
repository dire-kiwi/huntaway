import type { Task } from "../../api";
// By the package's own path, for the unit tests (which run it in node, with no resolver for paths without extensions).
import { documentsOnly, taskLabels } from "@huntaway/client/labels";

/**
 * A task's documents are ready for the user once there is one and its agent isn't working on them (running or queued)
 * or waiting on them (needs attention, answered in the thread).
 */
export const documentReady = (task: Task) => !!task.document_at && !task.running && task.status !== "in_progress" && task.status !== "needs_attention";

/**
 * Whether a task waits in In review with its review passed and a summary of the changes it passed (written or being
 * written), which is then what it opens on.
 */
export const summaryReady = (task: Task) =>
  task.kind === "task" &&
  task.status === "in_review" &&
  !task.running &&
  task.review?.state === "passed" &&
  (task.summaries ?? (task.summary ? [task.summary] : [])).some((s) => (s.state === "done" || s.state === "running") && s.head === task.review?.head);

/**
 * The tab a task opens on. A task with labels opens on its first label's document when it's ready, and one whose
 * review passed on the summary of its changes (see summaryReady). Otherwise one that makes only documents opens on the
 * thread, and any other task not started yet (to do or backlog) on its details, the rest on the thread. The profile's
 * assistant (API 109), which is back in To do after each reply, is a conversation: it always opens on the thread.
 */
export function openingTab(task: Task | undefined): string {
  const labels = task ? taskLabels(task) : [];
  if (labels.length && documentReady(task!)) return labels[0];
  if (task && summaryReady(task)) return "summary";
  if (task && documentsOnly(task)) return "thread";
  // As `isAssistant`, which the unit tests can't import (its module's imports have no extensions).
  // So is the profile's pens thread (API 126).
  if (task && task.kind === "task" && (task.task_type === "assistant" || task.task_type === "pens")) return "thread";
  return task?.status === "todo" || task?.status === "backlog" ? "details" : "thread";
}
