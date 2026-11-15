import { documentsOnly, isAssistant, isPenThread, isPensThread, isScratch, type HostTask as Task } from "@huntaway/client"
import { isGroupTask } from "../../../boardHelpers"

/** What kind of task it is, for which parts of its details it has: the sidebar's key items and the Details tab share it. */
export function taskFacts(task: Task) {
  // A group task has no repository, so nothing to review, merge or depend on. A plan, artifact or
  // diagram has no branch to merge either.
  const groupTask = isGroupTask(task)
  const docsOnly = documentsOnly(task)
  // A scratch task has no repository either.
  const scratch = isScratch(task)
  // Nor does the profile's assistant, which lasts: it isn't moved between columns, reviewed or merged.
  // The pens thread (API 127) lasts too, as does each pen's own (API 128).
  const pensThread = isPensThread(task)
  const penThread = isPenThread(task)
  const assistant = isAssistant(task)
  const lasting = assistant || pensThread || penThread
  /** It works on code in its project's repository: it has a branch, a pull request and a worktree. */
  const code = !groupTask && !docsOnly && !scratch && !lasting
  // What its work merges into (API 128): a code task in a project, which merge as they did.
  const mergeable = task.kind === "task" && !!task.project_id && code && !task.parent_id
  // It needs a worktree; once it's done, only to show where it went.
  const showMergesInto = mergeable && (task.use_worktree || !!task.branch || !!task.merges_into) && (task.status !== "done" || !!task.merges_into)
  return { groupTask, docsOnly, scratch, pensThread, penThread, assistant, lasting, code, showMergesInto }
}
