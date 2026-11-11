import { Cause, Context, Effect, Exit, FileSystem, Layer, Option, Result } from "effect"
import type { ProjectId, Task } from "@huntaway/contracts"
import { Git } from "../git/Git.ts"
import { expandHome } from "../git/paths.ts"
import { startRef, TaskBase } from "../git/TaskBase.ts"
import { PullRequests } from "../github/PullRequests.ts"
import { Actor } from "../platform/Changes.ts"
import type { Change } from "../platform/Changes.ts"
import { KeyedLock } from "../platform/KeyedLock.ts"
import { ServerConfig } from "../platform/ServerConfig.ts"
import { ProjectRepo } from "../projects/ProjectRepo.ts"
import { APPROVAL } from "../runs/finish.ts"
import { Runs } from "../runs/Runs.ts"
import { MergeFacts, NO_GIT_FACTS } from "../tasks/MergeFacts.ts"
import type { GitFacts } from "../tasks/MergeFacts.ts"
import { TaskRepo } from "../tasks/TaskRepo.ts"
import { Tasks } from "../tasks/Tasks.ts"
import { Threads } from "../threads/Threads.ts"
import { decideLanes } from "./decide.ts"
import { MergeGate } from "./MergeGate.ts"
import { mergeRequestText } from "./request.ts"

// The merge queue (docs/plan/06-server.md, Merge; inventory 04, section 2.14; huntaway's agent/runner/merge.ts): the
// agent merges, the board queues, gates and observes. Tasks moved to Ready for merge merge one at a time per lane (the
// branch they merge into), in column order; the queue is worked out from the task rows each time (`tasks/lanes.ts`,
// `merge/decide.ts`), never kept. `reconcileLane` looks at a project's queue under its `["merges", project]` lock, so two
// looks can't both give a lane's slot away (the old `start_next_merge` relied on being synchronous): what it starts
// registers its run (the task `running`) before the lock is let go.

type TaskChanged = Extract<Change, { readonly _tag: "TaskChanged" }>

/** What a task's merge reads that may change who has a lane's slot or who waits for it. */
const laneColumns = [
  "status",
  "resolution",
  "merging",
  "running",
  "merge_approval",
  "remerge",
  "restack",
  "stack_run",
  "merges_into",
] as const satisfies ReadonlyArray<keyof Task>

const laneMoved = (before: Task | null, after: Task | null): boolean =>
  before === null ||
  after === null ||
  laneColumns.some((k) => before[k] !== after[k]) ||
  (before.start_from?.type === "task" ? before.start_from.task_id : null) !== (after.start_from?.type === "task" ? after.start_from.task_id : null)

/** The first line of why an effect failed. */
const why = (cause: Cause.Cause<unknown>): string => {
  const e = Cause.squash(cause)
  const text = typeof e === "object" && e !== null && "detail" in e && typeof e.detail === "string" ? e.detail : Cause.pretty(cause)
  return text.split("\n")[0] ?? "it failed"
}

export interface MergesShape {
  /**
   * Starts what a project's merge queue is ready for (the old `start_next_merge`): in each lane whose slot is free, the
   * first task queued gets its agent asked to merge; tasks whose merges need approval have their agents summarise them.
   * Safe to call at any time; nothing on a host that runs no agents.
   */
  readonly reconcileLane: (project: ProjectId | null) => Effect.Effect<void>
  /** Every project's queue, as the server starts (the old `start_queued_merges`). */
  readonly reconcileAll: Effect.Effect<void>
  /**
   * The reactor's merge steps for a task's change: a replaced approval settled, the approval card once its summary run
   * has ended, and its project's queue looked at when the change may have freed or taken a slot.
   */
  readonly taskChanged: (change: TaskChanged) => Effect.Effect<void>
}

export class Merges extends Context.Service<Merges, MergesShape>()("huntaway-server/merge/Merges") {
  static readonly layer = Layer.effect(
    Merges,
    Effect.gen(function* () {
      const repo = yield* TaskRepo
      const projects = yield* ProjectRepo
      const tasks = yield* Tasks
      const runs = yield* Runs
      const threads = yield* Threads
      const gate = yield* MergeGate
      const base = yield* TaskBase
      const locks = yield* KeyedLock
      const config = yield* ServerConfig

      const board = Actor.board
      const say = (task: Task, level: "info" | "warning" | "error", text: string) => threads.notice(task.id, level, text).pipe(Effect.ignore)

      /** `task` needs attention for `reason`, still merging (it holds its lane until the user sorts it out). */
      const attention = (task: Task, reason: string) =>
        tasks.change(task.id, () => ({ status: "needs_attention", attention_reason: reason }), board).pipe(Effect.ignore)

      /** Have the agent of `task`, whose merge needs the user's approval, summarise it; out of the queue until the user decides. */
      const askApproval = Effect.fnUntraced(function* (task: Task) {
        const pending = yield* tasks
          .change(task.id, (t) => (t.merge_approval === null && t.merging && !t.running ? { merge_approval: "pending" } : null), board)
          .pipe(Effect.option)
        if (Option.isNone(pending) || pending.value.merge_approval !== "pending" || task.merge_approval === "pending") return
        yield* say(task, "info", "The merge waits for your approval: its agent summarizes what will be merged first")
        const asked = yield* Effect.exit(gate.requestSummary(pending.value))
        if (Exit.isSuccess(asked)) return
        const reason = `Couldn't ask for a summary of the merge: ${why(asked.cause)}`
        yield* say(task, "error", reason)
        yield* attention(task, reason)
      })

      /** Ask the agent of `task`, whose turn has come, to merge it (the old `request_merge`). */
      const requestMerge = Effect.fnUntraced(function* (rows: ReadonlyArray<Task>, task: Task) {
        const project = task.project_id === null ? null : Option.getOrNull(yield* projects.get(task.project_id))
        const text = mergeRequestText(rows, { task, project, base: yield* base.taskBase(task, project) })
        let failed: string
        if (Result.isFailure(text)) failed = text.failure
        else {
          const sent = yield* Effect.exit(runs.send(task.id, { text: text.success, source: "board", auto: true }))
          if (Exit.isSuccess(sent)) return
          failed = why(sent.cause)
        }
        // Stays merging, so the lane waits for the user to sort it out.
        const reason = `Couldn't start the merge: ${failed}`
        yield* say(task, "error", reason)
        yield* attention(task, reason)
      })

      const reconcileLane = Effect.fn("Merges.reconcileLane")(function* (project: ProjectId | null) {
        if (project === null || config.noAgents) return
        yield* locks.withLock(["merges", project])(
          Effect.gen(function* () {
            const ref = yield* repo.project(project)
            const rows = yield* repo.projectTasks(project)
            const first = rows[0]
            if (ref === null || first === undefined) return
            const plan = decideLanes({
              tasks: rows,
              finished: yield* repo.finishedLast(project),
              archived: ref.archived,
              approvalRequired: yield* gate.required(first),
            })
            for (const { id, said } of plan.leaveRun) {
              const left = yield* tasks.change(id, (t) => (t.stack_run === null ? null : { stack_run: null }), board).pipe(Effect.option)
              if (said && Option.isSome(left)) {
                yield* say(
                  left.value,
                  "info",
                  "No longer merging with its stack as one: the level below it left the merge. It merges after that one, in its turn",
                )
              }
            }
            for (const t of plan.summarise) yield* askApproval(t)
            for (const t of plan.start) {
              // As it is now: moved out of the queue meanwhile, it isn't asked.
              const now = yield* repo.get(t.id)
              if (now === null || !now.merging || now.running || now.status !== "ready_for_merge" || now.merge_approval === "pending") continue
              yield* requestMerge(rows, now)
            }
          }),
        )
      })

      const reconcileAll = Effect.gen(function* () {
        for (const p of yield* repo.projects) yield* reconcileLane(p.id)
      }).pipe(Effect.withSpan("Merges.reconcileAll"))

      const taskChanged = Effect.fn("Merges.taskChanged")(function* (change: TaskChanged) {
        const { before, after } = change
        if (after !== null) {
          // The approval it waited for is asked again, or not at all.
          if (before?.merge_approval === "pending" && after.merge_approval !== "pending") yield* gate.settle(after.id, "replaced")
          // Its agent summarised the merge, which waits for the user's approval: the card.
          const summarised = before?.running === true && !after.running && after.merging && after.merge_approval === "pending"
          if (summarised && after.status === "needs_attention" && after.attention_reason === APPROVAL) yield* gate.ask(after.id)
        }
        if (laneMoved(before, after)) yield* reconcileLane((after ?? before)?.project_id ?? null)
      })

      return Merges.of({ reconcileLane, reconcileAll, taskChanged })
    }),
  )

  /**
   * The facts `Tasks.update` decides a move to Ready for merge (and a new target) with, read from git and GitHub before
   * the task's lock (`tasks/MergeFacts.ts`): work to merge, the pull request's approval, where its branch started,
   * whether a failed worktree's folder is there.
   */
  static readonly registered = Layer.effectDiscard(
    Effect.gen(function* () {
      const facts = yield* MergeFacts
      const base = yield* TaskBase
      const pullRequests = yield* PullRequests
      const projects = yield* ProjectRepo
      const git = yield* Git
      const fs = yield* FileSystem.FileSystem
      const config = yield* ServerConfig
      yield* facts.register(
        Effect.fnUntraced(function* (task, patch) {
          const project = task.project_id === null ? null : Option.getOrNull(yield* projects.get(task.project_id))
          const toMerge = patch.status === "ready_for_merge" && task.status !== "ready_for_merge" && task.kind === "task"
          const out: GitFacts = {
            gitWork: toMerge ? yield* base.hasWorkToMerge(task) : NO_GIT_FACTS.gitWork,
            prApproval:
              toMerge && patch.remerge !== true
                ? yield* pullRequests.approval(task, patch.pr_url !== undefined ? patch.pr_url : task.pr_url)
                : NO_GIT_FACTS.prApproval,
            startCommit:
              patch.merges_into !== undefined && task.branch !== null && project !== null
                ? yield* git.commit(expandHome(project.repo_path, config.home), startRef(task.id))
                : null,
            worktreeFolderExists:
              task.worktree_path !== null && task.worktree_state === "error"
                ? yield* fs.exists(task.worktree_path).pipe(Effect.orElseSucceed(() => false))
                : false,
          }
          return out
        }),
      )
    }),
  )
}
