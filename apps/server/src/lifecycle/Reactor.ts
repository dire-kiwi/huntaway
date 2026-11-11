import { Context, Effect, Layer } from "effect"
import { Titles } from "../agents/Titles.ts"
import { StackTitles } from "../agents/StackTitles.ts"
import { StatusScripts } from "../git/StatusScripts.ts"
import { TaskBase } from "../git/TaskBase.ts"
import { PullRequests } from "../github/PullRequests.ts"
import { Merges } from "../merge/Merges.ts"
import { MergeTargets } from "../merge/MergeTargets.ts"
import { Restack } from "../git/Restack.ts"
import { GhStacks } from "../github/GhStacks.ts"
import { isMerged } from "../tasks/checks.ts"
import { Threads } from "../threads/Threads.ts"
import { Permissions } from "../permissions/Permissions.ts"
import { Changes } from "../platform/Changes.ts"
import type { Change } from "../platform/Changes.ts"
import { Reviews } from "../review/Reviews.ts"
import { RunEnds } from "../runs/RunEnds.ts"
import { Routines } from "../automations/Routines.ts"
import { Runs } from "../runs/Runs.ts"
import { TaskTmp } from "../tasks/TaskTmp.ts"
// 6.1
import { Terminals } from "../terminal/Terminals.ts"

export interface ReactorShape {
  /** Waits until every change offered so far has been handled. Tests wait on this instead of sleeping. */
  readonly idle: Effect.Effect<void>
}

/**
 * The one consumer of `Changes` (docs/plan/06-server.md, How an area reaches upward). For each change it calls, in a
 * fixed order, the reconcilers the change could affect. M1 handles changes one at a time in commit order, which keeps
 * one task's in order too; handling different tasks in parallel, each under its lock, comes with the slow reconcilers
 * (M2 on). M1 has the dependencies; the merge lane, reviews, workflows, status scripts and the rest join with their areas.
 */
export class Reactor extends Context.Service<Reactor, ReactorShape>()("huntaway-server/lifecycle/Reactor") {
  static readonly layer = Layer.effect(
    Reactor,
    Effect.gen(function* () {
      const changes = yield* Changes
      const runs = yield* Runs
      const runEnds = yield* RunEnds
      const taskTmp = yield* TaskTmp
      const titles = yield* Titles
      const stackTitles = yield* StackTitles
      const permissions = yield* Permissions
      const statusScripts = yield* StatusScripts
      const taskBase = yield* TaskBase
      const reviews = yield* Reviews
      const pullRequests = yield* PullRequests
      const merges = yield* Merges
      const threads = yield* Threads
      const mergeTargets = yield* MergeTargets
      const restack = yield* Restack
      const ghStacks = yield* GhStacks
      // 6.1
      const terminals = yield* Terminals
      const routines = yield* Routines

      const handle = Effect.fn("Reactor.handle")(function* (change: Change) {
        // A run's end (docs/plan/07-agents.md, When a run ends): its task's column, under its lock, then what follows
        // as for any change of the task (the `TaskChanged` it offers).
        if (change._tag === "RunExited") {
          yield* runEnds.ended(change)
          // 6.5: what the automation runs whose messages it took in cost, and a routine thread's report.
          yield* routines.runEnded(change)
          // What its agent took in of the branch it's stacked on, and the tasks stacked on it of its own (4.1).
          yield* taskBase.keepStarts(change.task)
          // 4.8: a restack its agent (or a reviewer) held off is done now that none is in its worktree.
          yield* restack.afterRun(change.task)
          return
        }
        // 4.8: the board couldn't restack a level: its agent is asked to.
        if (change._tag === "RestackAsk") {
          yield* mergeTargets.askToRestack(change)
          return
        }
        // 4.6: a reviewer's (or summarizer's) run ended: its part of the review, and once every part has, the review's
        // outcome (a round of fixes, the task left for the user, or summaries).
        if (change._tag === "ReviewFinished") {
          yield* reviews.finished(change.thread, change.run, change.outcome, change.attention)
          return
        }
        // 4.6: the agent is changing the work under review: its review and summaries in progress stop.
        if (change._tag === "PromptStarted") {
          yield* reviews.supersede(change.task)
          return
        }
        // 4.5: a project's preview template changed: its tasks' previews follow it.
        if (change._tag === "ProjectChanged") {
          yield* pullRequests.followPreviews(change.before, change.after)
          return
        }
        const task = change.after ?? change.before
        if (task === null) return
        // What the change tells its thread ("Nothing to merge…", "Stepped out of the merge queue…"), first.
        if (change.after !== null) for (const n of change.notes ?? []) yield* threads.notice(change.after.id, n.level, n.text).pipe(Effect.ignore)
        const moved = change.before?.status !== change.after?.status
        const depsChanged = change.before?.depends_on !== change.after?.depends_on
        // A task that moved, was deleted or changed what it waits for may unblock tasks waiting on its project.
        if (moved || depsChanged || change.after === null) yield* runs.startUnblocked(task.project_id)
        // 4.8: merged, the stack levels on it are marked to restack onto where it went (before the merge queue is looked
        // at, so a level waiting in Ready for merge waits for its restack) and restacked in the background.
        if (change.after !== null && isMerged(change.after) && (change.before === null || !isMerged(change.before))) {
          yield* restack.reconcileDependants(change.after)
        }
        // 4.8: closed without being merged, what merges into it is held; a new target's branch follows it.
        yield* mergeTargets.taskChanged(change)
        // 4.7: a replaced approval settled, the approval card once its summary run ended, and the merge queue moved on.
        yield* merges.taskChanged(change)
        // 4.8: the stacks it's in (or was in, or deleted from) keep their title on their bottom, written again after a pause.
        yield* stackTitles.changed(change)
        // A deleted task's temp folder goes (in the background), with what it left running; whoever waits on its
        // prompts is told they expired, and requests to delete it expire (it is deleted anyway).
        if (change.after === null) {
          yield* taskTmp.deleted(task.id)
          // 6.1: its terminals end with it.
          yield* terminals.killAll(task.id)
          yield* permissions.expireFor({ _tag: "Task", task: task.id })
          yield* permissions.expireFor({ _tag: "DeletionsOf", task: task.id })
        } else {
          // The thread's mode changed: what it waits on that the new mode decides is settled (3.3).
          if (change.before !== null && change.before.permission_mode !== change.after.permission_mode) yield* permissions.applyMode(change.after.id)
          // Done: the tasks stacked on it keep where they took its branch up to, which may well be deleted now (4.1).
          if (moved && change.after.status === "done") yield* taskBase.keepStarts(change.after.id)
          // 6.1: Done, its terminals end.
          if (moved && change.after.status === "done") yield* terminals.killAll(change.after.id)
          // 4.8: a pull request set (or changed): linked into a stack on GitHub with the one below, in the background.
          if (change.after.pr_url !== null && change.before?.pr_url !== change.after.pr_url) yield* ghStacks.link(change.after.id)
          // The project's status scripts for the move, in the background, one task's in order (4.1).
          if (moved && change.before !== null) yield* statusScripts.changed(change.after, change.before.status)
          // Done with no agent left in it, its temp folder goes (in the background); it may be a review thread's run ending.
          if (moved || change.before?.running !== change.after.running) yield* taskTmp.changed(change.after)
          // 4.6: a task that entered In review (or whose run ended there) is reviewed, if a review is due.
          const ended = change.before?.running === true && !change.after.running
          if (change.after.kind === "task" && change.after.status === "in_review" && (moved || ended)) yield* reviews.reconcile(change.after.id)
          // An unpinned title catches up with what was said since.
          if (change.before?.title_pinned === true && !change.after.title_pinned) yield* titles.refreshLater(change.after.id)
        }
      })

      // Handled one at a time, in the order they were committed. A failure is logged and does not stop the loop.
      const loop = changes.take.pipe(
        Effect.flatMap((change) =>
          handle(change).pipe(
            Effect.catchCause((cause) => Effect.logError("reactor: handling a change failed", cause)),
            Effect.ensuring(changes.done),
          ),
        ),
        Effect.forever,
        Effect.annotateLogs({ module: "reactor" }),
      )
      yield* Effect.forkScoped(loop)
      return Reactor.of({ idle: changes.idle })
    }),
  )
}
