import type { Task } from "./api";

// Without imports of its own (but types), so that the unit tests can run it (and what imports it, with its extension).

/** A label a task can have, which asks its agent for a document besides its other work: an HTML plan or artifact, or a
 *  Mermaid diagram (API 69). From API 42 they were types of task, whose agents made only the document. */
export type DocumentType = "plan" | "artifact" | "diagram";

/** The labels, in the order a task shows them. */
export const LABELS: DocumentType[] = ["plan", "artifact", "diagram"];

const isLabel = (l: unknown): l is DocumentType => LABELS.includes(l as DocumentType);

type Labelled = Pick<Task, "kind" | "task_type" | "labels" | "work_dir">;

/** A task's labels (API 69), or on an older host its type, if it's a plan, artifact or diagram task. */
export const taskLabels = (t: Omit<Labelled, "work_dir">): DocumentType[] =>
  t.kind !== "task" ? [] : t.labels ? LABELS.filter((l) => t.labels!.includes(l)) : isLabel(t.task_type) ? [t.task_type] : [];

/** A task that makes only its documents, in its own folder, rather than changing code: a plan, artifact or diagram task
 *  from before they were labels (API 69), or on an older host. */
export const documentsOnly = (t: Labelled) => t.kind === "task" && t.task_type !== "scratch" && (t.labels ? !!t.work_dir : isLabel(t.task_type));
