import { Cause, Context, Effect, Exit, Layer, Option } from "effect"
import type { Task, TaskId, Timestamp } from "@huntaway/contracts"
import { Tokens } from "../agents/Tokens.ts"
import { Checkpoints } from "../git/Checkpoints.ts"
import { PullRequests } from "../github/PullRequests.ts"
import { Changes } from "../platform/Changes.ts"
import type { Actor, Change } from "../platform/Changes.ts"
import { nowTimestamp } from "../platform/columns.ts"
import { Db } from "../platform/Db.ts"
import { Events } from "../platform/Events.ts"
import { KeyedLock } from "../platform/KeyedLock.ts"
import { AgentConfigRepo } from "../profiles/AgentConfigRepo.ts"
import { ProfileRepo } from "../profiles/ProfileRepo.ts"
import { todoNudge } from "../prompts/todoNudge.ts"
import { deriveColumns } from "../tasks/decide.ts"
import type { TaskColumns } from "../tasks/decide.ts"
import { heldReasonOf } from "../tasks/lanes.ts"
import { TaskRepo } from "../tasks/TaskRepo.ts"
import { ThreadReaders } from "../threads/ThreadReaders.ts"
import { Threads } from "../threads/Threads.ts"
import { AgentRequests } from "./AgentRequests.ts"
import { BackgroundWork } from "./BackgroundWork.ts"
import { DevServers } from "./DevServers.ts"
import { decideFinish, isAhead, nudged, nudgeNotice, outcomeOf, todoReason } from "./finish.ts"
import type { FinishDecision } from "./finish.ts"
import type { Run } from "./Run.ts"
import { RunRepo } from "./RunRepo.ts"
import { Runs } from "./Runs.ts"
import { RunWaits } from "./RunWaits.ts"

// What the reactor does with `RunExited` (docs/plan/07-agents.md, When a run ends; inventory 01, section 9): under the
// task's lock, the run's outcome, the run recorded as exited, the steers it never took in queued again ahead of what
// was queued since, and the task's column decided (`decideFinish`) — unless a later run has started, whose start and
// end set the task's state; then what is queued is sent before the column is written (so the card stays where it is),
// and the column written, with a `TaskChanged` for the reactor.

type RunExited = Extract<Change, { readonly _tag: "RunExited" }>

/** The first part's findings, under the lock. */
interface Ended {
  readonly run: Run
  readonly decision: FinishDecision
  /** A run of the task has started since: the task's state is that run's. */
  readonly later: boolean
  readonly queued: string | null
}

export interface RunEndsShape {
  /** The end of a run (its exit, or its launch given up on). Idempotent: a run already ended is left alone. */
  readonly ended: (change: RunExited) => Effect.Effect<void>
}

export class RunEnds extends Context.Service<RunEnds, RunEndsShape>()("huntaway-server/runs/RunEnds") {
  static readonly layer = Layer.effect(
    RunEnds,
    Effect.gen(function* () {
      const db = yield* Db
      const locks = yield* KeyedLock
      const repo = yield* RunRepo
      const tasks = yield* TaskRepo
      const threads = yield* Threads
      const readers = yield* ThreadReaders
      const events = yield* Events
      const changes = yield* Changes
      const runs = yield* Runs
      const profiles = yield* ProfileRepo
      const configs = yield* AgentConfigRepo
      const tokens = yield* Tokens
      const devServers = yield* DevServers
      const requests = yield* AgentRequests
      const background = yield* BackgroundWork
      const waits = yield* RunWaits
      const checkpoints = yield* Checkpoints
      const pullRequests = yield* PullRequests

      const board: Actor = { _tag: "Board" }

      /** Writes `columns` on `before` with what follows from them, in the caller's transaction; the task after. */
      const write = Effect.fnUntraced(function* (before: Task, columns: TaskColumns, at: Timestamp) {
        yield* tasks.write(before.id, deriveColumns(before, columns, at), at)
        const after = yield* tasks.get(before.id)
        if (after !== null) yield* events.emit({ type: "task", task: after })
        return after
      })

      /** Part one, under the lock: the outcome, the run ended, its steers queued again, the decision and its notices. */
      const recordEnd = (change: RunExited, planOnly: boolean) =>
        db.tx(
          Effect.gen(function* () {
            const found = yield* repo.get(change.run)
            if (Option.isNone(found)) return null
            const run = found.value
            const at = yield* nowTimestamp
            if (!(yield* repo.end(run.id, at))) return null
            const task = yield* tasks.get(run.task_id)
            if (task === null) return null
            // What the agent never took in goes with the next prompt, ahead of anything queued since.
            const steers = yield* tasks.takeSteers(task.id, run.id)
            yield* tasks.queueAhead(
              task.id,
              steers.map((s) => ({ text: s.text, source: s.source, automation_run_id: s.automation_run_id })),
              at,
            )
            const later = yield* repo.laterThan(run)
            const profile = Option.getOrNull(yield* profiles.get(task.profile_id))
            const config = task.claude_config_id === null ? null : Option.getOrNull(yield* configs.get(task.claude_config_id))
            const decision = decideFinish({
              outcome: outcomeOf(run, change.exit, change.errorTail),
              run,
              task,
              limitAhead: isAhead(task.limit_reset_at, at),
              limitWait: profile?.limit_wait ?? false,
              configName: config?.name ?? "Its config",
              // 4.7: what it merges into (or lands after) was closed or deleted while it ran.
              mergeHeld: task.kind === "task" && task.project_id !== null ? heldReasonOf(yield* tasks.projectTasks(task.project_id), task) : null,
              mergesToDone: false,
              planOnly,
              nudged: nudged(yield* readers.lastUserMessage(task.id)),
              endOfMergeQueue: yield* tasks.endPosition(task.project_id, "ready_for_merge"),
            })
            // Said once, by the run's own end: a later run's start doesn't unsay it.
            for (const n of decision.notices) yield* threads.notice(task.id, n.level, n.text, n.detail).pipe(Effect.orDie)
            const queued = (yield* tasks.queued(task.id))
              .map((q) => q.text)
              .filter((t) => t.trim() !== "")
              .join("\n\n")
            const ended: Ended = { run, decision, later, queued: queued === "" ? null : queued }
            return ended
          }),
        )

      /** Part two, under the lock: the column, unless a run has started since. */
      const writeColumn = (run: Run, columns: TaskColumns) =>
        db.tx(
          Effect.gen(function* () {
            if (yield* repo.laterThan(run)) return null
            const before = yield* tasks.get(run.task_id)
            if (before === null) return null
            const after = yield* write(before, columns, yield* nowTimestamp)
            return after === null ? null : { before, after }
          }),
        )

      /** Ask the agent to finish its todo list; one that can't be asked (its project archived, say) needs attention. */
      const nudge = Effect.fnUntraced(function* (task: TaskId, items: NonNullable<FinishDecision["nudge"]>) {
        const notice = nudgeNotice(items)
        yield* threads.notice(task, notice.level, notice.text, notice.detail).pipe(Effect.ignore)
        const sent = yield* Effect.exit(runs.send(task, { text: todoNudge(items), source: "board", auto: true }))
        if (Exit.isSuccess(sent)) return
        yield* Effect.logWarning(`task=${task} asking its agent to finish its todo list failed`)
        const done = yield* locks.withLock(["task", task])(
          db.tx(
            Effect.gen(function* () {
              const before = yield* tasks.get(task)
              if (before === null || before.status !== "in_progress" || before.running) return null
              const after = yield* write(before, { status: "needs_attention", attention_reason: todoReason(items) }, yield* nowTimestamp)
              return after === null ? null : { before, after }
            }),
          ),
        )
        if (done !== null) yield* changes.offer({ _tag: "TaskChanged", before: done.before, after: done.after, cause: board })
      })

      /**
       * 4.3: the checkpoints of the run's turns. A turn the agent never ended (stopped, failed or killed) gets its
       * checkpoint here, while the run still holds the thread: before a rewind or the next run (a queued message) can ask
       * for theirs. Then whether the run only wrote its plan (HA-198), once its turns' checkpoints are taken.
       */
      const turnCheckpoints = Effect.fnUntraced(function* (change: RunExited) {
        const found = yield* repo.get(change.run)
        if (Option.isNone(found) || !found.value.isLive) return false
        const run = found.value
        if (run.phase === "running" && !run.between_turns && run.kind !== "compact") {
          const failed = outcomeOf(run, change.exit, change.errorTail)._tag === "Failed"
          yield* checkpoints.afterTurn(run, failed ? "failed" : "stopped")
        }
        const task = yield* tasks.get(run.task_id)
        return task === null ? false : yield* checkpoints.planOnly(task, run)
      })

      const ended = Effect.fn("RunEnds.ended")(function* (change: RunExited) {
        const planOnly = yield* turnCheckpoints(change)
        const first = yield* locks.withLock(["task", change.task])(recordEnd(change, planOnly))
        if (first === null) return
        const { run, decision, later } = first
        // What the run had going goes with it: its wait is over (the old `wait.ended`), its tokens are counted, its
        // servers looked for a while longer, its prompts expire (`AgentRequests`' handlers), the reply being written ends.
        yield* waits.over(run.task_id, run.id)
        yield* tokens.runEnded(run.task_id)
        yield* background.runEnded(run)
        yield* devServers.notifyRunEnded(run.task_id)
        yield* requests.ended(run, !later)
        yield* threads.endPreview(run.task_id)
        // 4.6: a review or summary thread's run only stops running here; its outcome is the review's (`Reviews.finished`).
        if (run.kind === "review") {
          const outcome = outcomeOf(run, change.exit, change.errorTail)
          yield* changes.offer({ _tag: "ReviewFinished", thread: run.task_id, run: run.id, outcome, attention: run.attention })
        }
        if (later) return
        // 4.5: the pull request its agent may have opened, looked up in the background for a task with a branch and none.
        yield* pullRequests.findLater(run.task_id)
        // The queued message carries on the conversation, so the task stays where it is. Out of usage, it would only be
        // refused too: it stays queued for when the limit resets.
        if (first.queued !== null && decision.sendQueued) {
          const sent = yield* Effect.exit(runs.sendQueued(run.task_id))
          if (Exit.isSuccess(sent) && (sent.value.running || sent.value.waiting)) return
          if (Exit.isFailure(sent) && !(yield* runs.isRunning(run.task_id))) {
            const why = Cause.pretty(sent.cause).split("\n")[0] ?? "it failed"
            yield* threads.notice(run.task_id, "error", `Couldn't send the queued message: ${why}`, first.queued).pipe(Effect.ignore)
          }
        }
        const done = yield* locks.withLock(["task", run.task_id])(writeColumn(run, decision.columns))
        if (done === null) return
        yield* changes.offer({ _tag: "TaskChanged", before: done.before, after: done.after, cause: board })
        if (decision.nudge !== null) yield* nudge(run.task_id, decision.nudge)
      })

      return RunEnds.of({ ended })
    }),
  )
}
