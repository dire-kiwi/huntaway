import { Cause, Context, Effect, Exit, Layer, Option, Result, Schema } from "effect"
import { SecureRandom } from "effect/crypto"
import { Conflict, Invalid } from "@huntaway/contracts"
import type { Task, TaskId } from "@huntaway/contracts"
import { Git } from "../git/Git.ts"
import { expandHome } from "../git/paths.ts"
import { Restack } from "../git/Restack.ts"
import { startRef, TaskBase } from "../git/TaskBase.ts"
import { PullRequests } from "../github/PullRequests.ts"
import { Actor } from "../platform/Changes.ts"
import type { Change } from "../platform/Changes.ts"
import { KeyedLock } from "../platform/KeyedLock.ts"
import { ServerConfig } from "../platform/ServerConfig.ts"
import { ProjectRepo } from "../projects/ProjectRepo.ts"
import { Runs } from "../runs/Runs.ts"
import { isMerged } from "../tasks/checks.ts"
import { heldReason, reaching, stackedLevels } from "../tasks/lanes.ts"
import { TaskRepo } from "../tasks/TaskRepo.ts"
import { TaskNotFound, Tasks } from "../tasks/Tasks.ts"
import { Threads } from "../threads/Threads.ts"
import { choiceOf, heldBy, named, restacks, retargets, stackToMerge } from "./targets.ts"
import type { Moved } from "./targets.ts"

// What follows from a task merging into (or landing after) another (docs/plan/06-server.md, Merge; inventory 04, section
// 2.16; huntaway's api/incoming.ts, api/stack_merge.ts and the restack's `conflicted`): the tasks whose target, or the
// level they land after, was closed without being merged are held for the user to say where they go now
// (`setTarget`, `tasks.mergeTarget`); a whole stack merges as one run (`mergeStack`, `tasks.mergeStack`); a level the
// board couldn't restack has its agent asked to (`askToRestack`, the reactor's `RestackAsk`).

type TaskChanged = Extract<Change, { readonly _tag: "TaskChanged" }>
type RestackAsk = Extract<Change, { readonly _tag: "RestackAsk" }>

/** What a refused change said. */
const why = (cause: Cause.Cause<unknown>): string => {
  const e = Cause.squash(cause)
  if (typeof e === "object" && e !== null && "detail" in e && typeof e.detail === "string") return e.detail
  if (typeof e === "object" && e !== null && "reason" in e && typeof e.reason === "string") return e.reason
  return Cause.pretty(cause).split("\n")[0] ?? "it failed"
}

/** A whole stack's merge refused: for a task in no stack (`Invalid`), or why it can't merge yet (`Conflict`). */
const refuse = (r: { readonly invalid: boolean; readonly reason: string }) =>
  r.invalid ? new Invalid({ field: "id", reason: r.reason }) : new Conflict({ reason: "stack_not_ready", detail: r.reason })

const closedNotMerged = (t: Task | null) => t !== null && t.status === "done" && !isMerged(t)

export interface MergeTargetsShape {
  /**
   * Where the open tasks merging into (or stacked on) the same closed or deleted task as `id` go now, all at once:
   * `onward`, `close`, or one of them by id, which takes its place. The tasks changed.
   */
  readonly setTarget: (id: TaskId, to: string) => Effect.Effect<ReadonlyArray<Task>, TaskNotFound | Conflict | Invalid>
  /** Moves every open level of the stack `id` is in to Ready for merge, as one run, bottom first. The levels. */
  readonly mergeStack: (id: TaskId) => Effect.Effect<ReadonlyArray<Task>, TaskNotFound | Conflict | Invalid>
  /** The board couldn't restack a level: its agent is asked to, out of the merge queue meanwhile; else it needs attention. */
  readonly askToRestack: (ask: RestackAsk) => Effect.Effect<void>
  /**
   * The reactor's step for a task's change: closed without being merged, the tasks merging into it and the levels on it
   * are held for the user; held, it's said in the thread; a new target or base has its branch's `gh-merge-base` follow.
   */
  readonly taskChanged: (change: TaskChanged) => Effect.Effect<void>
}

export class MergeTargets extends Context.Service<MergeTargets, MergeTargetsShape>()("huntaway-server/merge/MergeTargets") {
  static readonly layer = Layer.effect(
    MergeTargets,
    Effect.gen(function* () {
      const repo = yield* TaskRepo
      const projects = yield* ProjectRepo
      const tasks = yield* Tasks
      const runs = yield* Runs
      const threads = yield* Threads
      const base = yield* TaskBase
      const restack = yield* Restack
      const pullRequests = yield* PullRequests
      const git = yield* Git
      const locks = yield* KeyedLock
      const config = yield* ServerConfig
      const random = yield* SecureRandom.SecureRandom

      const board = Actor.board
      const say = (id: TaskId, level: "info" | "warning" | "error", text: string, detail?: string) =>
        threads.notice(id, level, text, detail).pipe(Effect.ignore)
      const load = Effect.fnUntraced(function* (id: TaskId) {
        const t = yield* repo.get(id)
        return t === null ? yield* new TaskNotFound({ id }) : t
      })
      const projectOf = (t: Task) => (t.project_id === null ? Effect.succeed(null) : Effect.map(projects.get(t.project_id), Option.getOrNull))

      /**
       * Hold the open tasks in `incoming` (what merges into `key`, closed without being merged or deleted; `stacked`: the
       * levels on it): told so, and out of the merge queue in Needs attention unless their agent runs (then at its end).
       */
      const flag = Effect.fnUntraced(function* (incoming: ReadonlyArray<Task>, key: string, stacked: boolean) {
        const reason = heldReason(key, false, stacked)
        for (const t of incoming) {
          if (t.status === "done" || t.kind !== "task") continue
          if (t.running) {
            yield* say(t.id, "warning", reason)
            continue
          }
          yield* tasks
            .change(
              t.id,
              (now) => (now.running ? null : { status: "needs_attention", attention_reason: reason, merging: false, remerge: false, merge_approval: null }),
              board,
            )
            .pipe(Effect.ignore)
        }
      })

      const taskChanged = Effect.fn("MergeTargets.taskChanged")(function* (change: TaskChanged) {
        const { before, after } = change
        if (after === null) return
        // Closed without being merged: those merging into it (and into its merged ones) and the levels on it are held.
        if (closedNotMerged(after) && !closedNotMerged(before) && after.project_id !== null) {
          const rows = yield* repo.projectTasks(after.project_id)
          yield* flag(reaching(rows, after.id), after.key, false)
          yield* flag(stackedLevels(rows, after.id), after.key, true)
        }
        // Held (as above, or as the task it merges into was deleted): said in its thread.
        const held = after.status === "needs_attention" && after.attention_reason !== null && after.attention_reason.endsWith(": choose where it merges now")
        if (held && before?.attention_reason !== after.attention_reason) yield* say(after.id, "warning", after.attention_reason ?? "")
        // Its pull request goes where it merges now (`gh pr create`'s base).
        if (before !== null && after.branch !== null && (before.merges_into !== after.merges_into || before.base_branch !== after.base_branch)) {
          yield* base.followBase(after)
        }
      })

      /** Writes `m` with what follows: its thread told, its branch's base followed. The task after, if it's still there. */
      const apply = Effect.fnUntraced(function* (m: Moved) {
        const u = yield* tasks.change(m.task.id, () => m.columns, Actor.user).pipe(Effect.option, Effect.map(Option.getOrNull))
        if (u === null) return null
        yield* base.followBase(u)
        yield* say(u.id, "info", m.said)
        return u
      })

      const setTarget = Effect.fn("MergeTargets.setTarget")(function* (id: TaskId, to: string) {
        const t = yield* load(id)
        const choice = choiceOf(to)
        if (choice === null) return yield* new Invalid({ field: "to", reason: 'to must be "onward", "close" or a task id' })
        const project = yield* projectOf(t)
        if (project === null) return yield* new Conflict({ reason: "nothing_to_choose", detail: "the task isn't in a project" })
        const rows = yield* repo.projectTasks(project.id)
        const held = heldBy(rows, t)
        if (held === null) {
          return yield* new Conflict({ reason: "nothing_to_choose", detail: "the task it merges into isn't closed or deleted, so there's nothing to choose" })
        }
        const goneKey = held.gone?.key ?? (held.stacked ? "the deleted task it was stacked on" : "the deleted task it merged into")
        if (choice._tag === "Close") {
          const busy = held.siblings.find((x) => x.running)
          if (busy !== undefined)
            return yield* new Conflict({ reason: "agent_running", detail: `${busy.key}'s agent is running: stop it first, or wait for it to finish` })
          const resolution =
            held.gone?.resolution !== undefined && held.gone.resolution !== null && held.gone.resolution !== "done" ? held.gone.resolution : "not_done"
          const out: Array<Task> = []
          for (const x of held.siblings) {
            // As moving it to Done does (its status scripts, and the tasks merging into it in turn).
            const u = yield* tasks
              .update(x.id, { status: "done", resolution }, Actor.user)
              .pipe(Effect.catchTags({ Invalid: (e) => Effect.fail(e), Conflict: (e) => Effect.fail(e), NotFound: () => Effect.succeed(null) }))
            if (u === null) continue
            yield* say(u.id, "info", `Closed as ${goneKey} was`)
            out.push(u)
          }
          return out
        }
        const heir = choice._tag === "Heir" ? (held.siblings.find((x) => x.id === choice.id || x.key === choice.id) ?? null) : null
        if (choice._tag === "Heir" && heir === null) {
          return yield* new Invalid({
            field: "to",
            reason: `task_id must be one of the open tasks that ${held.stacked ? "are stacked on" : "merge into"} ${goneKey}`,
          })
        }
        // Where each one's own work starts (its start ref), for those with a branch.
        const dir = expandHome(project.repo_path, config.home)
        const starts = new Map<string, string | null>()
        for (const x of held.siblings) if (x.branch !== null) starts.set(x.id, yield* git.commit(dir, startRef(x.id)))
        const main = project.base_branch === "" ? null : project.base_branch
        const moves = held.stacked
          ? restacks(rows, held, heir, starts, held.gone === null ? main : ((yield* base.taskBase(held.gone, project)) ?? main))
          : retargets(rows, held, heir, starts, main)
        const out: Array<Task> = []
        for (const m of moves) {
          const u = yield* apply(m)
          if (u !== null) out.push(u)
        }
        // Restacked where they go; the others follow the one taking its place once it's restacked (`Restack`'s after).
        if (held.stacked) {
          for (const u of out) if (u.restack !== null && (heir === null || u.id === heir.id || heir.branch === null)) yield* restack.schedule(u.id)
        }
        return out
      })

      const mergeStack = Effect.fn("MergeTargets.mergeStack")(function* (id: TaskId) {
        const t = yield* load(id)
        if (t.project_id === null) return yield* new Invalid({ field: "id", reason: "the task isn't in a stack" })
        const projectId = t.project_id
        const first = stackToMerge(yield* repo.projectTasks(projectId), t)
        if (Result.isFailure(first)) return yield* refuse(first.failure)
        const open = first.success
        // What each move would refuse, before any is made: no changes to merge, a pull request not approved on GitHub.
        for (const x of open) {
          if (x.status !== "in_review") continue
          if (!(yield* base.hasWorkToMerge(x))) {
            return yield* new Conflict({
              reason: "stack_not_ready",
              detail: `The stack can't merge yet: ${named(x)} has no changes to merge (move it to Done first)`,
            })
          }
          const approval = yield* pullRequests.approval(x, x.pr_url)
          if (approval._tag === "Required" && approval.error !== null) {
            return yield* new Conflict({
              reason: "pr_not_approved",
              detail: `The stack can't merge yet: ${named(x)}'s pull request isn't approved on GitHub (${approval.error})`,
            })
          }
          if (approval._tag === "Required" && !approval.approved) {
            return yield* new Conflict({
              reason: "pr_not_approved",
              detail: `The stack can't merge yet: ${named(x)}'s pull request has no approving review on GitHub`,
            })
          }
        }
        const run = yield* random.uuidV4()
        // Under the project's merges lock: the queue isn't looked at until every level has moved and joined the run.
        yield* locks.withLock(["merges", projectId])(
          Effect.gen(function* () {
            // As it stands now, after the reads of GitHub.
            const again = stackToMerge(yield* repo.projectTasks(projectId), t)
            const same =
              Result.isSuccess(again) &&
              again.success.length === open.length &&
              again.success.every((x, i) => x.id === open[i]?.id && x.status === open[i]?.status)
            if (!same) return yield* new Conflict({ reason: "changed_meanwhile", detail: "the stack changed meanwhile; try again" })
            const end = yield* repo.endPosition(projectId, "ready_for_merge")
            const moved: Array<Task> = []
            for (const [i, x] of open.entries()) {
              if (x.status === "ready_for_merge") {
                yield* tasks.change(x.id, (now) => (now.status === "ready_for_merge" ? { stack_run: run } : null), Actor.user).pipe(Effect.ignore)
                continue
              }
              const went = yield* Effect.exit(tasks.update(x.id, { status: "ready_for_merge", position: end + i }, Actor.user))
              if (Exit.isFailure(went)) {
                // Those below it merge without it, as levels do; it and those above stay where they are.
                if (moved.length === 0)
                  return yield* new Conflict({ reason: "stack_not_ready", detail: `The stack can't merge yet: ${named(x)} couldn't move (${why(went.cause)})` })
                return yield* new Conflict({
                  reason: "stack_not_ready",
                  detail: `Only ${moved.map(named).join(", ")} moved to Ready for merge: ${named(x)} couldn't (${why(went.cause)})`,
                })
              }
              // Bottom first, so the run is whole at each step.
              yield* tasks.change(x.id, (now) => (now.status === "ready_for_merge" && now.merging ? { stack_run: run } : null), Actor.user).pipe(Effect.ignore)
              moved.push(x)
            }
            return moved
          }),
        )
        for (const x of open) yield* say(x.id, "info", `Merging with its stack: ${open.length} levels, bottom first, with nothing else merging between them`)
        return yield* Effect.forEach(open, (x) => load(x.id), { concurrency: 1 })
      })

      const askToRestack = Effect.fn("MergeTargets.askToRestack")(function* (ask: RestackAsk) {
        const t = yield* repo.get(ask.task)
        if (t === null) return
        // Out of the merge queue meanwhile, back in it once its agent is done (`remerge`).
        if (t.merging) yield* tasks.change(t.id, () => ({ status: "in_progress", merging: false, remerge: true }), Actor.board).pipe(Effect.ignore)
        const sent = yield* Effect.exit(runs.send(t.id, { text: ask.text, source: "board", auto: true }))
        if (Exit.isSuccess(sent)) return
        yield* say(t.id, "error", "Couldn't ask the agent to restack it", why(sent.cause))
        const now = (yield* repo.get(t.id)) ?? t
        yield* tasks
          .change(t.id, () => ({ status: "needs_attention", attention_reason: ask.reason, merging: false, remerge: now.merging || now.remerge }), Actor.board)
          .pipe(Effect.ignore)
      })

      return MergeTargets.of({ setTarget, mergeStack, askToRestack, taskChanged })
    }),
  )
}

/** For the wire: what `setTarget`'s and `mergeStack`'s errors are. */
export const MergeTargetError = Schema.Union([Conflict, Invalid])
