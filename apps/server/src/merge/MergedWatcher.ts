import { Context, Effect, Layer, Ref, Result } from "effect"
import type { Task } from "@huntaway/contracts"
import { parseAccount } from "@huntaway/shared"
import { TaskBase } from "../git/TaskBase.ts"
import { Worktrees } from "../git/Worktrees.ts"
import { PrWatch } from "../github/PrWatch.ts"
import { PrWatchRepo } from "../github/PrWatchRepo.ts"
import { CHUNK, statesOf, statesQuery } from "../github/prWatch/merged.ts"
import { targetLabel, targetOfUrl, targetUrl } from "../github/prWatch/target.ts"
import type { Target } from "../github/prWatch/target.ts"
import { Actor } from "../platform/Changes.ts"
import { nowTimestamp } from "../platform/columns.ts"
import { Runs } from "../runs/Runs.ts"
import type { TaskColumns } from "../tasks/decide.ts"
import { TaskRepo } from "../tasks/TaskRepo.ts"
import { Tasks } from "../tasks/Tasks.ts"
import { Threads } from "../threads/Threads.ts"

// Tasks whose pull requests are merged or closed on GitHub (by the user, or by auto-merge) rather than through Ready for
// merge (docs/plan/inventory/04-git-review.md 2.17; huntaway's review/merged.ts). Every `POLL` the board reads the state
// of the pull requests of the tasks in In review or Needs attention whose project has `done_when_merged` on, with one
// GraphQL query per GitHub account and host (and `CHUNK` pull requests), as each task's own account, never as another.
//
// - Merged: the task moves to Done (resolution `done`), as moving it there does, says so in its thread, and its
//   worktree is removed if nothing in it would be lost (`Worktrees.removeIfMerged`, which says why when it's kept).
// - Closed without being merged: a task in In review moves to Needs attention saying so; one already there only gets a
//   notice.
//
// Each is done once per change of state: the state last acted on is kept per task and pull request (`pr_states`), and
// stored only once it's been acted on, so a task the user moves back out of Done stays where they put it, a pull request
// reopened and closed again is reported again, and a move that couldn't be made (its agent started meanwhile) is tried
// again at the next read. Tasks whose agent (or a reviewer) is running or that are merging are left alone.
//
// A wait on the pull request already tells the agent it was merged, and leaves marking the task done to it; if it ends
// its run without doing so, the task goes to In review and the next read here moves it on.

/** How often the pull requests are read, and how long after the server starts they're first read. */
export const POLL = "180 seconds"
export const FIRST = "30 seconds"

export interface MergedWatcherShape {
  /** Read the candidates' pull requests and act on what changed. */
  readonly check: Effect.Effect<void>
}

/** Whether `now` is `t` as it was read for its pull request: open and idle with the same one. */
const unchanged = (now: Task, t: Task): boolean =>
  (now.status === "in_review" || now.status === "needs_attention") && !now.running && !now.merging && now.pr_url === t.pr_url

export class MergedWatcher extends Context.Service<MergedWatcher, MergedWatcherShape>()("huntaway-server/merge/MergedWatcher") {
  static readonly layer = Layer.effect(
    MergedWatcher,
    Effect.gen(function* () {
      const repo = yield* PrWatchRepo
      const prWatch = yield* PrWatch
      const taskRepo = yield* TaskRepo
      const tasks = yield* Tasks
      const base = yield* TaskBase
      const worktrees = yield* Worktrees
      const runs = yield* Runs
      const threads = yield* Threads
      // The last error of each account and host, so a read that keeps failing is logged once.
      const failing = yield* Ref.make<ReadonlyMap<string, string>>(new Map())

      /** Whether `t`'s agent or one of its reviewers is running. */
      const busy = Effect.fnUntraced(function* (t: Task) {
        if (yield* runs.isRunning(t.id)) return true
        for (const r of yield* taskRepo.reviewThreads(t.id)) if (r.running || (yield* runs.isRunning(r.id))) return true
        return false
      })

      /** A change of `t` the board makes if it's as it was read: whether it was made. */
      const changeIf = Effect.fnUntraced(function* (t: Task, columns: (now: Task) => TaskColumns | null) {
        let applied = false
        yield* tasks
          .change(
            t.id,
            (now) => {
              const c = unchanged(now, t) ? columns(now) : null
              applied = c !== null
              return c
            },
            Actor.board,
          )
          .pipe(Effect.ignore)
        return applied
      })

      /** `t`'s pull request was merged: move it to Done and remove its worktree. False if it changed meanwhile, or its agent started. */
      const merged = Effect.fnUntraced(function* (t: Task, target: Target) {
        if (yield* busy(t)) return false
        const done = yield* changeIf(t, () => ({ status: "done", resolution: "done", attention_reason: null, waiting: false }))
        if (!done) return false
        yield* threads.notice(t.id, "info", `PR #${target.number} was merged on GitHub, so the task is done.`, targetUrl(target)).pipe(Effect.ignore)
        // As moving it to Done does, the reactor carries the rest: the tasks waiting on it start; restacking the levels on
        // it (4.8), the next merge (4.7), workflows (6.6) and its terminals (6.1) join it there with their areas.
        const removed = yield* Effect.result(worktrees.removeIfMerged(t.id, true))
        if (Result.isFailure(removed)) {
          const why = removed.failure._tag === "WorktreeFailed" ? removed.failure.reason : `task ${removed.failure.id} not found`
          yield* threads.notice(t.id, "warning", "The worktree couldn't be removed", why).pipe(Effect.ignore)
        } else if (removed.success._tag === "Kept" && removed.success.why !== "it has no worktree") {
          yield* threads.notice(t.id, "info", `The worktree was kept: ${removed.success.why}.`).pipe(Effect.ignore)
        }
        return true
      })

      /** `t`'s pull request was closed without being merged: flag it. False if it changed meanwhile. */
      const closed = Effect.fnUntraced(function* (t: Task, target: Target) {
        const text = `PR #${target.number} was closed on GitHub without being merged`
        if (t.status === "in_review") {
          const flagged = yield* changeIf(t, (now) => (now.status === "in_review" ? { status: "needs_attention", attention_reason: text } : null))
          if (!flagged) return false
        }
        yield* threads.notice(t.id, "warning", `${text}.`, targetUrl(target)).pipe(Effect.ignore)
        return true
      })

      /** Act on `t`'s pull request being in `state`, if it wasn't at the last read; keep the state once acted on. */
      const changed = Effect.fnUntraced(function* (t: Task, target: Target, state: string) {
        const url = targetUrl(target)
        if ((yield* repo.prState(t.id, url)) === state) return
        const done = state === "merged" ? yield* merged(t, target) : state === "closed" ? yield* closed(t, target) : true
        if (done) yield* repo.setPrState(t.id, url, state, yield* nowTimestamp)
      })

      const check = Effect.gen(function* () {
        const ids = yield* repo.withOpenPrs
        const found = yield* taskRepo.getMany(ids)
        // By account and host, then by pull request (tasks can share one).
        const groups = new Map<string, { readonly account: string | null; readonly host: string; readonly prs: Array<readonly [Target, Array<Task>]> }>()
        for (const t of found) {
          if (yield* busy(t)) continue
          const target = targetOfUrl(t.pr_url)
          if (target === null) continue
          const account = yield* base.account(t)
          // Not as an account on another host.
          const a = account === null ? null : parseAccount(account)
          if (a !== null && a.host !== target.host) continue
          const key = `${account ?? ""}\u0000${target.host}`
          const g = groups.get(key) ?? { account, host: target.host, prs: [] }
          groups.set(key, g)
          const same = g.prs.find(([p]) => targetUrl(p) === targetUrl(target))
          if (same !== undefined) same[1].push(t)
          else g.prs.push([target, [t]])
        }
        for (const [key, { account, host, prs }] of groups) {
          for (let i = 0; i < prs.length; i += CHUNK) {
            const chunk = prs.slice(i, i + CHUNK)
            const q = statesQuery(chunk.map(([t]) => t))
            const answer = yield* Effect.result(prWatch.graphql(account, host, q.query, q.vars, q.numbers))
            const read = Result.isFailure(answer) ? Result.fail(answer.failure.reason) : statesOf(answer.success, chunk.length)
            if (Result.isFailure(read)) {
              const was = (yield* Ref.get(failing)).get(key)
              if (was !== read.failure) {
                yield* Effect.logWarning(`reading tasks' pull requests as ${account ?? "gh's active account"} on ${host}: ${read.failure}`)
                yield* Ref.update(failing, (m) => new Map([...m, [key, read.failure]]))
              }
              break
            }
            yield* Ref.update(failing, (m) => new Map([...m].filter(([k]) => k !== key)))
            for (const [j, [target, list]] of chunk.entries()) {
              const r = read.success[j] ?? null
              if (r === null) continue
              for (const t of list) {
                // The board shows how its checks stand.
                if (r.state === "open") yield* prWatch.recordChecks(t.id, target, r.head, r.checks)
                yield* changed(t, target, r.state).pipe(
                  Effect.catchCause((cause) => Effect.logError(`task ${t.id}, pr ${targetLabel(target)}: acting on its pull request's state`, cause)),
                )
              }
            }
          }
        }
      }).pipe(Effect.withSpan("MergedWatcher.check"))

      return MergedWatcher.of({ check })
    }),
  )

  /** The loop: a check `FIRST` after the server starts, then `POLL` after each ends. Not in `areasLayer`: tests run `check`. */
  static readonly loop = Layer.effectDiscard(
    Effect.gen(function* () {
      const watcher = yield* MergedWatcher
      yield* Effect.sleep(FIRST).pipe(
        Effect.andThen(
          watcher.check.pipe(
            Effect.catchCause((cause) => Effect.logError("reading tasks' pull requests", cause)),
            Effect.andThen(Effect.sleep(POLL)),
            Effect.forever,
          ),
        ),
        Effect.forkScoped,
      )
    }),
  )
}
