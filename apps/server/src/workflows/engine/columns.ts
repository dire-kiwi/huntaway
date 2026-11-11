import { Effect } from "effect"
import type { ProjectId, Status, Task, Workflow } from "@huntaway/contracts"
import type { WorkflowTask } from "../../agents/WorkflowFacts.ts"
import { agentWorks, columnNode, doneNote, takesStartPrompt, withNote } from "../graph.ts"
import type { ColumnNode } from "../graph.ts"
import { projectOf } from "./core.ts"
import type { Deps } from "./core.ts"

// A task's columns as its project's workflows have them (huntaway's integrations/workflows/engine/columns.ts): the
// workflows that start in a column, the one where the agent works in it, and the note a message to the agent ends with.

/**
 * The project's workflows that are on, with their nodes for column `status`: none unless the project uses workflows
 * instead of the board's own handling (`use_workflows`).
 */
export const columnsOf = Effect.fnUntraced(function* (d: Deps, project: ProjectId, status: Status) {
  const p = yield* projectOf(d, project)
  if (p === null || !p.use_workflows) return []
  const out: Array<readonly [Workflow, ColumnNode]> = []
  for (const w of yield* d.store.list(project)) {
    const n = w.enabled ? columnNode(w.graph, status) : undefined
    if (n !== undefined) out.push([w, n])
  }
  return out
})

/** The project's workflow node for column `status` with the task's agent's work there, if any. */
export const workColumn = Effect.fnUntraced(function* (d: Deps, task: Pick<WorkflowTask, "kind" | "project_id">, status: Status) {
  if (task.kind !== "task" || task.project_id === null) return null
  return (yield* columnsOf(d, task.project_id, status)).find(([w, n]) => agentWorks(n, w.graph)) ?? null
})

/**
 * What a message the workflow sends the task's agent to work again (fixes, say) ends with, when the project's In
 * progress node waits for `finish_work`: how to say it's done, and what the board does then, as its start prompt said.
 */
export const finishNote = Effect.fnUntraced(function* (d: Deps, task: Task) {
  const found = yield* workColumn(d, task, "in_progress")
  if (found === null || found[1].done_when !== "finish" || !takesStartPrompt(task)) return ""
  return doneNote(found[0].graph, found[1])
})

/** `text`, with `finishNote` after it unless it says so already (the old `with_finish`). */
export const withFinish = Effect.fnUntraced(function* (d: Deps, task: Task, text: string) {
  return withNote(text, yield* finishNote(d, task))
})
