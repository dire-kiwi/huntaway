import { Effect } from "effect"
import { RunId } from "@huntaway/contracts"
import type { Project, Task } from "@huntaway/contracts"
import { projectStart } from "../../agents/prompts/project.ts"
import type { FinishDue, WorkflowFactsReader, WorkflowTask } from "../../agents/WorkflowFacts.ts"
import { workflowMergeFinish } from "../../prompts/workflowDone.ts"
import { asksFinish, columnText, doneNote, flowEdges, inputValue, mergeFinishThen, opensPr, takesStartPrompt, waitingColumn } from "../graph.ts"
import { columnsOf, withFinish, workColumn } from "./columns.ts"
import { projectOf, valueSource } from "./core.ts"
import type { Deps } from "./core.ts"
import { mergesToDone } from "./start.ts"

// What the prompts, a run's end and the merge queue read of a task's workflows (`WorkflowFacts`, registered by
// `WorkflowEngine`; huntaway's engine/values.ts `start_instructions`, `merge_instructions`, `board_opens_pr`, and
// engine/columns.ts `on_finish_due`, `merge_finish`).

/** The workflows area's reader of `WorkflowFacts`. */
export const factsReader = (d: Deps): WorkflowFactsReader => ({
  startInstructions: (task: WorkflowTask, project: Pick<Project, "start_prompt"> | null) =>
    Effect.gen(function* () {
      if (project === null || !takesStartPrompt(task)) return null
      const found = yield* workColumn(d, task, "in_progress")
      if (found === null) return null
      const [w, n] = found
      const full = yield* d.taskRepo.get(task.id)
      if (full === null) return null
      return columnText(yield* valueSource(d, w, full, yield* projectOf(d, full.project_id), null), n, projectStart(project))
    }),
  boardOpensPr: (task: WorkflowTask) =>
    Effect.gen(function* () {
      // Not while it merges (or steps out of the merge queue to make changes): the agent's merge is its own to push.
      if (task.merging === true || task.remerge === true) return false
      const found = yield* workColumn(d, task, "in_progress")
      return found !== null && opensPr(found[0].graph, found[1].id)
    }),
  mergeInstructions: (task: Task) =>
    Effect.gen(function* () {
      const found = yield* workColumn(d, task, "ready_for_merge")
      if (found === null) return null
      const [w, n] = found
      const text = inputValue(yield* valueSource(d, w, task, yield* projectOf(d, task.project_id), null), n, "prompt", n.prompt).trim()
      return text === "" ? null : text
    }),
  mergeFinish: (task: Task) =>
    Effect.gen(function* () {
      const found = yield* mergesToDone(d, task)
      if (found === null) return null
      const then = mergeFinishThen(found[0].graph, found[1])
      return then === null ? null : workflowMergeFinish(then)
    }),
  finishDue: (task: Task) =>
    Effect.gen(function* () {
      if (task.kind !== "task" || task.project_id === null) return null
      const p = yield* projectOf(d, task.project_id)
      if (p === null || p.archived_at !== null) return null
      const takes = takesStartPrompt(task)
      // The column whose prompt its agent was sent, by a run waiting there since before it worked.
      for (const r of yield* d.store.running(task.id)) {
        const n = waitingColumn(r)
        if (n === null) continue
        if (!(yield* d.reviewRepo.laterRun(task.id, r.task_run === null ? null : RunId.make(r.task_run)))) continue
        const due: FinishDue = {
          workflow_id: r.workflow_id,
          node: n.id,
          status: n.status,
          run_id: r.id,
          asksFinish: asksFinish(n, takes),
          note: doneNote(r.graph, n),
        }
        return due
      }
      // In progress's, with something after it (or waiting for finish_work): else there's nothing to hold the task for.
      const found = (yield* columnsOf(d, task.project_id, "in_progress")).find(
        ([w, n]) => n.done_when === "finish" || flowEdges(w.graph).some((e) => e.from === n.id),
      )
      if (found === undefined) return null
      const [w, n] = found
      const due: FinishDue = { workflow_id: w.id, node: n.id, status: n.status, run_id: null, asksFinish: asksFinish(n, takes), note: doneNote(w.graph, n) }
      return due
    }),
  withFinish: (task: Task, text: string) => withFinish(d, task, text),
})
