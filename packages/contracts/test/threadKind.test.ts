import { describe, expect, it } from "vite-plus/test"
import { PenId, ProjectId, TaskId } from "../src/ids.ts"
import type { Status } from "../src/task.ts"
import { canMoveTo, isOnBoard, keyLetter, takesStatus, threadKindOf, type ThreadKind, type ThreadKindFields } from "../src/threadKind.ts"

const task = TaskId.make("t-1")
const parent = TaskId.make("t-parent")
const project = ProjectId.make("p-1")
const pen = PenId.make("pen-1")

/** An ordinary code task in a project with a worktree; each case changes what makes it something else. */
const row = (fields: Partial<ThreadKindFields>): ThreadKindFields => ({
  id: task,
  kind: "task",
  task_type: null,
  project_id: project,
  parent_id: null,
  group_name: null,
  pen_id: null,
  labels: [],
  work_dir: null,
  use_worktree: true,
  ...fields,
})

interface Case {
  readonly name: string
  readonly fields: Partial<ThreadKindFields>
  readonly kind: ThreadKind
  readonly onBoard: boolean
  readonly status: boolean
  /** Its key's letter, given its project's key ("HE") when it has a project. */
  readonly key: string
}

const cases: ReadonlyArray<Case> = [
  { name: "a code task", fields: {}, kind: { _tag: "Code", project_id: project, worktree: true }, onBoard: true, status: true, key: "HE" },
  {
    name: "a code task without a worktree, with labels (it writes a plan besides its code)",
    fields: { use_worktree: false, labels: ["plan"] },
    kind: { _tag: "Code", project_id: project, worktree: false },
    onBoard: true,
    status: true,
    key: "HE",
  },
  {
    name: "a task that makes only documents (the old plan, artifact and diagram tasks)",
    fields: { labels: ["artifact"], work_dir: "documents/t-1", use_worktree: false },
    kind: { _tag: "Document", project_id: project, labels: ["artifact"] },
    onBoard: true,
    status: true,
    key: "HE",
  },
  {
    name: "a documents task in no project",
    fields: { project_id: null, labels: ["diagram"], work_dir: "documents/t-1" },
    kind: { _tag: "Document", project_id: null, labels: ["diagram"] },
    onBoard: true,
    status: true,
    key: "T",
  },
  {
    name: "a scratch task",
    fields: { project_id: null, task_type: "scratch", use_worktree: false },
    kind: { _tag: "Scratch", project_id: null },
    onBoard: true,
    status: true,
    key: "S",
  },
  {
    name: "a scratch task in a project, made from a scratch chat (its work_dir is the chat's folder)",
    fields: { task_type: "scratch", work_dir: "/home/me/chat", use_worktree: false },
    kind: { _tag: "Scratch", project_id: project },
    onBoard: true,
    status: true,
    key: "HE",
  },
  {
    name: "a group task",
    fields: { project_id: null, group_name: "Web", use_worktree: false },
    kind: { _tag: "Group", group: "Web" },
    onBoard: true,
    status: true,
    key: "G",
  },
  {
    name: "a task in a project keeps its project over a group name",
    fields: { group_name: "Web" },
    kind: { _tag: "Code", project_id: project, worktree: true },
    onBoard: true,
    status: true,
    key: "HE",
  },
  {
    name: "a task in no project with nothing else (none is made so) is a scratch task",
    fields: { project_id: null, use_worktree: false },
    kind: { _tag: "Scratch", project_id: null },
    onBoard: true,
    status: true,
    key: "S",
  },
  {
    name: "the assistant",
    fields: { project_id: null, task_type: "assistant", work_dir: "assistant/t-1" },
    kind: { _tag: "Assistant" },
    onBoard: false,
    status: true,
    key: "A",
  },
  {
    name: "a routine's run of the assistant",
    fields: { project_id: null, task_type: "routine", parent_id: parent, work_dir: "assistant/t-parent" },
    kind: { _tag: "Routine", assistant: parent },
    onBoard: false,
    status: true,
    key: "A",
  },
  { name: "the pens thread", fields: { project_id: null, task_type: "pens" }, kind: { _tag: "PensRoot" }, onBoard: false, status: true, key: "S" },
  {
    name: "a pen's thread",
    fields: { project_id: null, task_type: "pen", pen_id: pen, work_dir: "pens/pen-1" },
    kind: { _tag: "Pen", pen },
    onBoard: false,
    status: true,
    key: "S",
  },
  {
    name: "a pen's thread the old board wrote, which does not name its pen",
    fields: { project_id: null, task_type: "pen" },
    kind: { _tag: "Pen", pen: null },
    onBoard: false,
    status: true,
    key: "S",
  },
  {
    name: "a task in a pen is still a code task",
    fields: { pen_id: pen },
    kind: { _tag: "Code", project_id: project, worktree: true },
    onBoard: true,
    status: true,
    key: "HE",
  },
  {
    name: "a review thread",
    fields: { kind: "review", parent_id: parent, use_worktree: false },
    kind: { _tag: "Review", of: parent },
    onBoard: false,
    status: false,
    key: "HE",
  },
  {
    name: "a summary thread",
    fields: { kind: "review", task_type: "summary", parent_id: parent },
    kind: { _tag: "Summary", of: parent },
    onBoard: false,
    status: false,
    key: "HE",
  },
  {
    name: "a workflow's agent step",
    fields: { kind: "review", task_type: "workflow", parent_id: parent },
    kind: { _tag: "WorkflowStep", of: parent },
    onBoard: false,
    status: false,
    key: "HE",
  },
  {
    name: "a review thread's task_type of a task's sort is ignored",
    fields: { kind: "review", task_type: "scratch", parent_id: parent },
    kind: { _tag: "Review", of: parent },
    onBoard: false,
    status: false,
    key: "HE",
  },
  {
    name: "a task's task_type of a review thread's sort is ignored",
    fields: { task_type: "summary" },
    kind: { _tag: "Code", project_id: project, worktree: true },
    onBoard: true,
    status: true,
    key: "HE",
  },
]

describe("threadKindOf", () => {
  for (const c of cases) {
    it(c.name, () => {
      const r = row(c.fields)
      const kind = threadKindOf(r)
      expect(kind).toEqual(c.kind)
      expect(isOnBoard(kind)).toBe(c.onBoard)
      expect(takesStatus(kind)).toBe(c.status)
      expect(keyLetter(kind, r.project_id === null ? null : "HE")).toBe(c.key)
    })
  }

  it("lasting threads are never reviewed, merged, done or parked", () => {
    const blocked: ReadonlyArray<Status> = ["in_review", "ready_for_merge", "done", "backlog"]
    for (const fields of [{ task_type: "assistant" }, { task_type: "pens" }, { task_type: "pen" }] as const) {
      const kind = threadKindOf(row({ project_id: null, ...fields }))
      for (const status of blocked) expect(canMoveTo(kind, status)).toBe(false)
      expect(canMoveTo(kind, "needs_attention")).toBe(true)
    }
    expect(canMoveTo(threadKindOf(row({})), "ready_for_merge")).toBe(true)
    expect(canMoveTo(threadKindOf(row({ kind: "review", parent_id: parent })), "todo")).toBe(false)
  })
})
