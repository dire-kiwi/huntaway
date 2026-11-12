import { Context, Effect, Layer, Ref } from "effect"
import type { Project, Task, ThreadKindFields } from "@huntaway/contracts"

// What a task's prompts, its run's end and its merge request need from its project's workflows (docs/plan/06-server.md,
// Workflows; huntaway's integrations/workflows/engine/values.ts `start_instructions`, `merge_instructions`,
// `board_opens_pr`, engine/columns.ts `on_finish_due`, `asks_finish`, `merges_to_done`, `merge_finish`, `with_finish`,
// `with_due_finish`). The prompts (`agents/`), a run's end (`runs/`) and the merge queue (`merge/`) sit above the
// workflows area, which needs them, so they can't call it: `WorkflowEngine` registers its reader here when its layer is
// built (plan task 6.6), as the merge area registers with `MergeFacts`. Until then (and in tests that build no
// workflows) a project has no workflow: the old defaults.

/** The column node whose work a task's agent's run did, which takes the task on once that run ends (the old `Due`). */
export interface FinishDue {
  readonly workflow_id: string
  readonly node: string
  /** The column's status. */
  readonly status: Task["status"]
  /** The run waiting at the node, which the agent was sent its prompt by; null for In progress's node with no run yet. */
  readonly run_id: string | null
  /** The agent was asked to say its work there is done with `finish_work` (`asks_finish`). */
  readonly asksFinish: boolean
  /** What the column's prompt ends with: how to say it's done, and what the board does then. */
  readonly note: string
}

/** What a prompt knows of its task (a preview's has no merge state: it isn't merging). */
export type WorkflowTask = ThreadKindFields & { readonly merging?: boolean; readonly remerge?: boolean }

export interface WorkflowFactsReader {
  /** What a task's agent is told to do when it starts, if its project's workflow has an In progress node (code tasks only). */
  readonly startInstructions: (task: WorkflowTask, project: Pick<Project, "start_prompt"> | null) => Effect.Effect<string | null>
  /** Whether the project's workflow opens the task's pull request once its agent's work in In progress is done. */
  readonly boardOpensPr: (task: WorkflowTask) => Effect.Effect<boolean>
  /** How the task's agent merges it, if the workflow's Ready for merge node has a prompt. */
  readonly mergeInstructions: (task: Task) => Effect.Effect<string | null>
  /** How the merging agent says it's merged, when the workflow moves the task to Done (`merges_to_done`); null otherwise. */
  readonly mergeFinish: (task: Task) => Effect.Effect<string | null>
  /** The column that takes the task on once its agent's run ends with its work done; null for none. */
  readonly finishDue: (task: Task) => Effect.Effect<FinishDue | null>
  /** `text` ending with how to say the work in In progress is done, when that waits for `finish_work` (`with_finish`). */
  readonly withFinish: (task: Task, text: string) => Effect.Effect<string>
}

/** No workflow: what a project without one does. */
export const NO_WORKFLOWS: WorkflowFactsReader = {
  startInstructions: () => Effect.succeed(null),
  boardOpensPr: () => Effect.succeed(false),
  mergeInstructions: () => Effect.succeed(null),
  mergeFinish: () => Effect.succeed(null),
  finishDue: () => Effect.succeed(null),
  withFinish: (_task, text) => Effect.succeed(text),
}

export interface WorkflowFactsShape extends WorkflowFactsReader {
  /** The workflows area's reader, from now on. */
  readonly register: (reader: WorkflowFactsReader) => Effect.Effect<void>
  /**
   * `text` ending with how to say the work is done where `due` waits for `finish_work`: that column's note; without
   * one, `withFinish` (the message asking the agent to finish its todo list: `finish_work` is the run's that called it).
   */
  readonly withDueFinish: (task: Task, due: FinishDue | null, text: string) => Effect.Effect<string>
}

export class WorkflowFacts extends Context.Service<WorkflowFacts, WorkflowFactsShape>()("huntaway-server/agents/WorkflowFacts") {
  static readonly layer = Layer.effect(
    WorkflowFacts,
    Effect.gen(function* () {
      const reader = yield* Ref.make<WorkflowFactsReader>(NO_WORKFLOWS)
      const withFinish = (task: Task, text: string) => Effect.flatMap(Ref.get(reader), (r) => r.withFinish(task, text))
      return WorkflowFacts.of({
        register: (r) => Ref.set(reader, r),
        startInstructions: (task, project) => Effect.flatMap(Ref.get(reader), (r) => r.startInstructions(task, project)),
        boardOpensPr: (task) => Effect.flatMap(Ref.get(reader), (r) => r.boardOpensPr(task)),
        mergeInstructions: (task) => Effect.flatMap(Ref.get(reader), (r) => r.mergeInstructions(task)),
        mergeFinish: (task) => Effect.flatMap(Ref.get(reader), (r) => r.mergeFinish(task)),
        finishDue: (task) => Effect.flatMap(Ref.get(reader), (r) => r.finishDue(task)),
        withFinish,
        withDueFinish: (task, due, text) =>
          due !== null && due.asksFinish
            ? Effect.succeed(due.note !== "" && !text.includes(due.note) ? `${text}\n\n${due.note}` : text)
            : withFinish(task, text),
      })
    }),
  )
}
