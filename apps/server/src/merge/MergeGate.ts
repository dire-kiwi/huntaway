import { Context, Effect, Layer, Option } from "effect"
import type { Task, TaskId } from "@huntaway/contracts"
import { TaskBase } from "../git/TaskBase.ts"
import { ApprovalRefused, APPROVE, DENY, QUESTION_ID, Questions, SETTLED } from "../permissions/Questions.ts"
import type { Settled } from "../permissions/Questions.ts"
import { Actor } from "../platform/Changes.ts"
import { ProfileRepo } from "../profiles/ProfileRepo.ts"
import { ProjectRepo } from "../projects/ProjectRepo.ts"
import { mergeAwaitsApproval, mergeNeedsApproval, mergeSummaryRequest, mergeWhat } from "../prompts/mergeApproval.ts"
import { Runs } from "../runs/Runs.ts"
import type { SendRefused } from "../runs/Runs.ts"
import { TaskRepo } from "../tasks/TaskRepo.ts"
import { TaskNotFound, Tasks } from "../tasks/Tasks.ts"
import { ThreadReaders } from "../threads/ThreadReaders.ts"
import { Threads } from "../threads/Threads.ts"

// The merge gate (docs/plan/06-server.md, Merge; inventory 04, section 2.15; huntaway's review/merge_gate.ts): merges
// that wait for the user's approval, for profiles and projects that ask for it (`merge_approval`). A task moved to Ready
// for merge first has its agent summarise what it would merge, without merging, outside the merge queue (`Merges`).
// When that run ends, the board asks the user to approve or deny the merge with a card in the thread: a question request
// with `merge_approval` in its metadata, answered through `threads.answerQuestion` (`Questions` hands its answer here).
// Approved, the task rejoins the merge queue and its agent is asked to merge when its turn comes; denied, it goes back
// to In review. Until then the gh tools' merges are refused (`blocked`). A task's `merge_approval` is `pending`
// meanwhile, and `approved` after.

/** The card's question. */
export const APPROVAL_QUESTION = "Merge this task? Its agent summarized what will be merged above."

/** The card's `call_id`: one card per run end that asks, settled `replaced` by the next. */
const CARD_CALL = "merge-approval"

export interface MergeGateShape {
  /** Why task `task`'s agent may not merge now, or null when it may (a review thread goes by its task). */
  readonly blocked: (task: TaskId) => Effect.Effect<string | null>
  /** Whether `task`'s merges wait for the user's approval: its project's setting, or else its profile's. */
  readonly required: (task: Task) => Effect.Effect<boolean>
  /** Ask `task`'s agent to summarise what its merge would bring in, without merging. */
  readonly requestSummary: (task: Task) => Effect.Effect<Task, TaskNotFound | SendRefused>
  /** The summary run ended: ask the user to approve the merge, with a card in the thread (replacing any still open). */
  readonly ask: (task: TaskId) => Effect.Effect<void>
  /** Settle `task`'s approval cards still open, as `how`: the merge they asked about was left, or a new card replaces them. */
  readonly settle: (task: TaskId, how: Settled) => Effect.Effect<void>
  /**
   * The user's answer: approved, the task rejoins the merge queue (`merge_approval` approved, Ready for merge); denied,
   * it goes back to In review out of the merge. Refused unless it's still pending and merging, and its agent isn't running.
   */
  readonly decide: (task: TaskId, approve: boolean) => Effect.Effect<Task, TaskNotFound | ApprovalRefused>
}

export class MergeGate extends Context.Service<MergeGate, MergeGateShape>()("huntaway-server/merge/MergeGate") {
  static readonly layer = Layer.effect(
    MergeGate,
    Effect.gen(function* () {
      const repo = yield* TaskRepo
      const projects = yield* ProjectRepo
      const profiles = yield* ProfileRepo
      const tasks = yield* Tasks
      const runs = yield* Runs
      const threads = yield* Threads
      const readers = yield* ThreadReaders
      const base = yield* TaskBase

      const required = Effect.fn("MergeGate.required")(function* (task: Task) {
        const project = task.project_id === null ? null : Option.getOrNull(yield* projects.get(task.project_id))
        if (project?.merge_approval !== null && project?.merge_approval !== undefined) return project.merge_approval
        return Option.getOrNull(yield* profiles.get(task.profile_id))?.merge_approval ?? false
      })

      const blocked = Effect.fn("MergeGate.blocked")(function* (id: TaskId) {
        let task = yield* repo.get(id)
        if (task !== null && task.kind === "review" && task.parent_id !== null) task = yield* repo.get(task.parent_id)
        if (task === null) return null
        if (task.merge_approval === "approved") return null
        if (task.merge_approval !== null) return mergeAwaitsApproval
        if (!task.merging && (yield* required(task))) return mergeNeedsApproval
        return null
      })

      const requestSummary = Effect.fn("MergeGate.requestSummary")(function* (task: Task) {
        const project = task.project_id === null ? null : Option.getOrNull(yield* projects.get(task.project_id))
        const into = yield* base.taskBase(task, project)
        return yield* runs.send(task.id, { text: mergeSummaryRequest(mergeWhat(task.branch, into)), source: "board", auto: true })
      })

      const settle = Effect.fn("MergeGate.settle")(function* (task: TaskId, how: Settled) {
        for (const open of yield* readers.openQuestions(task)) {
          if (open.request.metadata?.["merge_approval"] !== true) continue
          // Unless it's been answered since.
          yield* threads.resolveRequest(task, open.request.id, { outcome: "cancel", message: SETTLED[how] }).pipe(Effect.ignore)
        }
      })

      const ask = Effect.fn("MergeGate.ask")(function* (task: TaskId) {
        yield* settle(task, "replaced")
        const options = [
          { label: APPROVE, description: "Its agent merges it, once no other task in the project is merging" },
          { label: DENY, description: "It isn't merged, and goes back to In review" },
        ]
        yield* threads
          .openRequest(task, {
            type: "question",
            questions: [{ id: QUESTION_ID, question: APPROVAL_QUESTION, options, multi_select: false, allow_other: false }],
            metadata: { question: APPROVAL_QUESTION, options, multi_select: false, allow_other: false, merge_approval: true, call_id: CARD_CALL },
          })
          .pipe(Effect.catchTag("TaskNotFound", () => Effect.void))
      })

      const decide = Effect.fn("MergeGate.decide")(function* (id: TaskId, approve: boolean) {
        let refused: ApprovalRefused | null = null
        const after = yield* tasks.change(
          id,
          (t) => {
            if (t.merge_approval !== "pending" || !t.merging) {
              refused = new ApprovalRefused({ reason: "not_pending", detail: "the task isn't waiting for its merge to be approved any more" })
            } else if (t.running) {
              refused = new ApprovalRefused({ reason: "agent_running", detail: "its agent is still running; approve the merge once it's done" })
            } else refused = null
            if (refused !== null) return null
            return approve
              ? { merge_approval: "approved", status: "ready_for_merge", attention_reason: null }
              : { merging: false, status: "in_review", attention_reason: null }
          },
          Actor.user,
        )
        if (refused !== null) return yield* Effect.fail<ApprovalRefused>(refused)
        yield* threads
          .notice(id, "info", approve ? "Merge approved: it merges once no other task in the project is merging" : "Merge denied: back in review")
          .pipe(Effect.ignore)
        return after
      })

      return MergeGate.of({ blocked, required, requestSummary, ask, settle, decide })
    }),
  )

  /** The gate decides merges from their approval cards (`Questions.answer`). */
  static readonly registered = Layer.effectDiscard(
    Effect.gen(function* () {
      const gate = yield* MergeGate
      const questions = yield* Questions
      yield* questions.onMergeApproval(gate.decide)
    }),
  )
}

/** A gate that blocks nothing and asks nothing, for tests that build no merge area (they replace a method of it). */
export const openGate = (): MergeGateShape => ({
  blocked: () => Effect.succeed(null),
  required: () => Effect.succeed(false),
  requestSummary: (task) => Effect.succeed(task),
  ask: () => Effect.void,
  settle: () => Effect.void,
  decide: (id) => Effect.fail(new TaskNotFound({ id })),
})
