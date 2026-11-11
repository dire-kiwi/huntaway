import type { PenId, ProjectId, TaskId } from "./ids.ts"
import type { DocumentLabel, Status, Task } from "./task.ts"

// What kind of thread a task row is (docs/plan/03-domain.md, What kind of thread a task row is). The old code asked
// with predicates spread over five columns (huntaway's db/tasks/row.ts `is_*`, agent/documents.ts `documents_only`,
// agent/runner/prompt.ts `key_prefix` and `system_prompt`); here it is one function, and the questions asked of a kind
// are tables over `_tag`.

export type ThreadKind =
  /** An ordinary task in a project. */
  | { readonly _tag: "Code"; readonly project_id: ProjectId; readonly worktree: boolean }
  /** A task that makes only documents, in its own folder (the old plan, artifact and diagram tasks). */
  | { readonly _tag: "Document"; readonly project_id: ProjectId | null; readonly labels: ReadonlyArray<DocumentLabel> }
  /** Works in its own folder; in a project, it reads the project's repository. */
  | { readonly _tag: "Scratch"; readonly project_id: ProjectId | null }
  /** In no project: plans the work of a group's projects. */
  | { readonly _tag: "Group"; readonly group: string }
  /** The profile's one assistant. */
  | { readonly _tag: "Assistant" }
  /** A routine's run of the assistant. */
  | { readonly _tag: "Routine"; readonly assistant: TaskId }
  /** The profile's one thread that arranges its pens. */
  | { readonly _tag: "PensRoot" }
  /** A pen's own thread. `pen` is the thread's `pen_id`: null on a row the old board wrote, which linked them the other way. */
  | { readonly _tag: "Pen"; readonly pen: PenId | null }
  /** Threads under a task (kind `review`): a reviewer, a summarizer, a workflow's agent step. */
  | { readonly _tag: "Review"; readonly of: TaskId }
  | { readonly _tag: "Summary"; readonly of: TaskId }
  | { readonly _tag: "WorkflowStep"; readonly of: TaskId }

/** The fields `threadKindOf` reads, so the server can ask of a row before it is a whole `Task`. */
export type ThreadKindFields = Pick<
  Task,
  "id" | "kind" | "task_type" | "project_id" | "parent_id" | "group_name" | "pen_id" | "labels" | "work_dir" | "use_worktree"
>

/**
 * What kind of thread `task` is, in the old code's order of precedence: a thread under a task by its `task_type`; then a
 * task's own `task_type`; then one with a `work_dir` of its own (documents only); then a group task (in no project);
 * then a code task. A task in no project with none of these (none is made so) is taken as a scratch task, as it has no
 * repository to work in.
 */
export const threadKindOf = (task: ThreadKindFields): ThreadKind => {
  // A thread under a task always has one (the column cascades from it); the task's own id is only a fallback.
  const parent = task.parent_id ?? task.id
  if (task.kind === "review") {
    if (task.task_type === "summary") return { _tag: "Summary", of: parent }
    if (task.task_type === "workflow") return { _tag: "WorkflowStep", of: parent }
    return { _tag: "Review", of: parent }
  }
  switch (task.task_type) {
    case "assistant":
      return { _tag: "Assistant" }
    case "routine":
      return { _tag: "Routine", assistant: parent }
    case "pens":
      return { _tag: "PensRoot" }
    case "pen":
      return { _tag: "Pen", pen: task.pen_id }
    case "scratch":
      return { _tag: "Scratch", project_id: task.project_id }
    case "summary":
    case "workflow":
    case null:
      break
  }
  if (task.work_dir !== null) return { _tag: "Document", project_id: task.project_id, labels: task.labels }
  if (task.project_id === null) return task.group_name === null ? { _tag: "Scratch", project_id: null } : { _tag: "Group", group: task.group_name }
  return { _tag: "Code", project_id: task.project_id, worktree: task.use_worktree }
}

/** The questions asked of a kind, one row per `_tag`. */
interface KindFacts {
  /** Shown on a board, in its project's columns or the profile's projectless ones. The rest are reached from their owner. */
  readonly onBoard: boolean
  /** The statuses it may be moved to. A thread under a task has a status column, but the board never sets it. */
  readonly statuses: ReadonlySet<Status>
  /** The letter before its number in a task in no project. */
  readonly letter: string
}

const anyStatus: ReadonlySet<Status> = new Set(["backlog", "todo", "in_progress", "needs_attention", "in_review", "ready_for_merge", "done"])
/** Lasting threads (the assistant, the pens thread, a pen's thread) are never reviewed, merged, done or parked. */
const lastingStatuses: ReadonlySet<Status> = new Set(["todo", "in_progress", "needs_attention"])
const noStatus: ReadonlySet<Status> = new Set()

const facts: { readonly [Tag in ThreadKind["_tag"]]: KindFacts } = {
  Code: { onBoard: true, statuses: anyStatus, letter: "T" },
  Document: { onBoard: true, statuses: anyStatus, letter: "T" },
  Scratch: { onBoard: true, statuses: anyStatus, letter: "S" },
  Group: { onBoard: true, statuses: anyStatus, letter: "G" },
  Assistant: { onBoard: false, statuses: lastingStatuses, letter: "A" },
  Routine: { onBoard: false, statuses: anyStatus, letter: "A" },
  PensRoot: { onBoard: false, statuses: lastingStatuses, letter: "S" },
  Pen: { onBoard: false, statuses: lastingStatuses, letter: "S" },
  Review: { onBoard: false, statuses: noStatus, letter: "T" },
  Summary: { onBoard: false, statuses: noStatus, letter: "T" },
  WorkflowStep: { onBoard: false, statuses: noStatus, letter: "T" },
}

/** Shown on a board, in its project's columns or the profile's projectless ones. The rest are reached from their owner. */
export const isOnBoard = (kind: ThreadKind): boolean => facts[kind._tag].onBoard

/** Moves between columns at all. */
export const takesStatus = (kind: ThreadKind): boolean => facts[kind._tag].statuses.size > 0

/** Whether a thread of this kind may be moved to `status`. */
export const canMoveTo = (kind: ThreadKind, status: Status): boolean => facts[kind._tag].statuses.has(status)

/**
 * What goes before a task's number in its key: its project's key (`projectKey`, null for a task in no project), else
 * `G` for a group task, `S` for a scratch task and the pens threads, `A` for the assistant and its routines, `T` for
 * anything else. `G`, `S` and `A` are reserved, so no project has them.
 */
export const keyLetter = (kind: ThreadKind, projectKey: string | null): string => projectKey ?? facts[kind._tag].letter
