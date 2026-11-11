import { Context, Effect, FileSystem, Layer, Option, Schedule, Schema, Semaphore } from "effect"
import type { Duration } from "effect"
import { Conflict } from "@huntaway/contracts"
import type { FanoutFacts, PickFanout, PickOutcome, Task, TaskId } from "@huntaway/contracts"
import { Git } from "../git/Git.ts"
import { TaskBase } from "../git/TaskBase.ts"
import { Worktrees } from "../git/Worktrees.ts"
import { stray, uncommitted } from "../git/worktree/remove.ts"
import { Gh } from "../github/Gh.ts"
import { Permissions } from "../permissions/Permissions.ts"
import { Actor } from "../platform/Changes.ts"
import { nowTimestamp } from "../platform/columns.ts"
import { ProjectRepo } from "../projects/ProjectRepo.ts"
import { Runs } from "../runs/Runs.ts"
import { TaskRepo } from "../tasks/TaskRepo.ts"
import { TaskNotFound, Tasks } from "../tasks/Tasks.ts"
import { Threads } from "../threads/Threads.ts"
import { expandTilde } from "../settings/Folders.ts"
import { ServerConfig } from "../platform/ServerConfig.ts"
import { FanoutRepo } from "./FanoutRepo.ts"

// 6.11: tasks made together from one prompt, each run by another agent (a fan-out; docs/plan/inventory/04-git-review.md
// §2.18, the old `review/fanout.ts`). The compare view reads what it can't see on the tasks (`facts`: how long each
// one's agent ran, what's uncommitted in its worktree, its branch and where it's pushed), and picking one (`pick`) keeps
// it and completes the others as not done, stopping their agents and removing their worktrees, and their branches and
// pull requests if asked. Nothing uncommitted is lost unless `discard_uncommitted` says so: such a worktree is kept.

/** The most of a worktree's uncommitted changes listed. */
const LISTED = 20

/** How long the agents of a task that wasn't picked have to stop before it's left as it is, and how often it's looked at. Tests shorten it. */
export const FanoutStopWait = Context.Reference<{ readonly for: Duration.Input; readonly every: Duration.Input }>(
  "huntaway-server/review/Fanout/FanoutStopWait",
  {
    defaultValue: () => ({ for: "20 seconds", every: "200 millis" }),
  },
)

/** How long deleting a pushed branch, or closing a pull request, may take. */
const REMOTE_TIMEOUT = "60 seconds"

/** What a task had, before picking did anything with it. */
const had = (v: boolean): "kept" | "none" => (v ? "kept" : "none")

/** Not a task made from one prompt with others, or one with no others. */
export class FanoutRefused extends Schema.TaggedError<FanoutRefused, { readonly brand: unique symbol }>()("FanoutRefused", { reason: Schema.String }) {}

/** Where a branch is pushed: its upstream's remote, its branch there, and its short name (`origin/ia/x-1`). */
interface Pushed {
  readonly remote: string
  readonly remoteRef: string
  readonly short: string
}

export interface FanoutShape {
  /** The tasks made from the same prompt as `id`, it among them, in the order they were made, with what the compare view shows. */
  readonly facts: (id: TaskId) => Effect.Effect<ReadonlyArray<FanoutFacts>, TaskNotFound | FanoutRefused>
  /** Keeps `id` and completes the others from its prompt as not done, cleaning up after them as `pick` asks. One pick at a time. */
  readonly pick: (
    id: TaskId,
    pick: PickFanout,
  ) => Effect.Effect<{ readonly task: Task; readonly results: ReadonlyArray<PickOutcome> }, TaskNotFound | FanoutRefused | Conflict>
}

export class Fanout extends Context.Service<Fanout, FanoutShape>()("huntaway-server/review/Fanout") {
  static readonly layer = Layer.effect(
    Fanout,
    Effect.gen(function* () {
      const repo = yield* FanoutRepo
      const taskRepo = yield* TaskRepo
      const projects = yield* ProjectRepo
      const tasks = yield* Tasks
      const runs = yield* Runs
      const permissions = yield* Permissions
      const worktrees = yield* Worktrees
      const taskBase = yield* TaskBase
      const git = yield* Git
      const gh = yield* Gh
      const threads = yield* Threads
      const fs = yield* FileSystem.FileSystem
      const config = yield* ServerConfig
      // One pick at a time, so two at once (of two of them) can't complete them all as not done.
      const picking = yield* Semaphore.make(1)

      const getTask = (id: TaskId) =>
        taskRepo.get(id).pipe(
          Effect.filterOrFail(
            (t): t is Task => t !== null,
            () => new TaskNotFound({ id }),
          ),
        )
      const note = (id: TaskId, level: "info" | "warning", text: string) => threads.notice(id, level, text).pipe(Effect.ignore)
      const exists = (p: string) => fs.exists(p).pipe(Effect.orElseSucceed(() => false))
      const run = (dir: string, args: ReadonlyArray<string>, timeout?: Duration.Input) =>
        git.run(dir, args, timeout === undefined ? {} : { timeout }).pipe(Effect.orElseSucceed(() => null))

      /** Its profile's tasks made from the same prompt, it among them. Only its own profile's: a fanout id is only a label. */
      const siblings = Effect.fnUntraced(function* (t: Task) {
        const f = t.kind === "task" ? t.fanout_id : null
        if (f === null) return yield* new FanoutRefused({ reason: "the task wasn't made from one prompt with others" })
        const ids = yield* repo.siblings(t.profile_id, f)
        const byId = new Map((yield* taskRepo.getMany(ids)).map((x) => [x.id, x]))
        return ids.flatMap((id) => {
          const x = byId.get(id)
          return x === undefined ? [] : [x]
        })
      })

      const repoOf = (t: Task) =>
        t.project_id === null
          ? Effect.succeed(null)
          : Effect.map(projects.get(t.project_id), Option.match({ onNone: () => null, onSome: (p) => expandTilde(p.repo_path, config.home) }))

      /** The task's branch, if the repository has it. */
      const branchOf = Effect.fnUntraced(function* (repoPath: string | null, t: Task) {
        const branch = t.branch === null || t.branch === "" ? null : t.branch
        if (repoPath === null || branch === null) return null
        const o = yield* run(repoPath, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])
        return o?.ok === true ? branch : null
      })

      /** Where `branch` is pushed, if the repository has a copy of it under its own name (deleting another would delete that branch). */
      const pushed = Effect.fnUntraced(function* (repoPath: string, branch: string) {
        const format = "--format=%(upstream:remotename)%00%(upstream:remoteref)%00%(upstream)%00%(upstream:short)"
        const o = yield* run(repoPath, ["for-each-ref", format, `refs/heads/${branch}`])
        const line = o?.stdout.split("\n")[0]
        if (o === null || line === undefined || o.stdout === "") return null
        const fields = line.replace(/\r$/, "").split("\0")
        const [remote, remoteRef, tracking, short] = fields
        if (fields.length !== 4 || remote === undefined || remoteRef === undefined || tracking === undefined || short === undefined) return null
        if (remote === "" || remoteRef !== `refs/heads/${branch}` || tracking === "") return null
        const there = yield* run(repoPath, ["rev-parse", "--verify", "--quiet", tracking])
        return there?.ok === true ? ({ remote, remoteRef, short } satisfies Pushed) : null
      })

      const factsOf = Effect.fnUntraced(function* (t: Task) {
        const time = yield* repo.runTime(t.id, yield* nowTimestamp)
        const repoPath = yield* repoOf(t)
        const branch = yield* branchOf(repoPath, t)
        const up = repoPath !== null && branch !== null ? ((yield* pushed(repoPath, branch))?.short ?? null) : null
        let changes: ReadonlyArray<string> = []
        let uncommittedError: string | null = null
        let strays = 0
        const wt = t.worktree_path
        if (wt !== null && t.worktree_state === "ready" && (yield* exists(wt))) {
          const status = yield* Effect.result(uncommitted(git, fs, wt))
          if (status._tag === "Success") changes = status.success.split("\n").filter((l) => l.trim() !== "")
          else uncommittedError = status.failure.reason
          strays = yield* stray(git, wt).pipe(Effect.orElseSucceed(() => 0))
        }
        return {
          id: t.id,
          run_secs: time.secs,
          runs: time.runs,
          working: yield* worktrees.agentInWorktree(t.id),
          uncommitted: changes.slice(0, LISTED),
          uncommitted_count: changes.length,
          uncommitted_error: uncommittedError,
          stray_commits: strays,
          branch,
          pushed: up,
        } satisfies FanoutFacts
      })

      const facts = Effect.fn("Fanout.facts")(function* (id: TaskId) {
        return yield* Effect.forEach(yield* siblings(yield* getTask(id)), factsOf, { concurrency: 4 })
      })

      // The run's end is written to the task (its column, `running`) after the run ends: until then its end could put it
      // back in a column after it's been completed.
      const active = (t: TaskId) =>
        Effect.gen(function* () {
          if (yield* runs.isRunning(t)) return true
          return (yield* taskRepo.get(t))?.running ?? false
        })

      /** Whether the task's agents (its own and its reviewers') have stopped, waiting `FanoutStopWait` at most. */
      const stopped = Effect.fnUntraced(function* (id: TaskId) {
        const wait = yield* FanoutStopWait
        const busy = Effect.gen(function* () {
          if (yield* active(id)) return true
          for (const r of yield* taskRepo.reviewThreads(id)) if (yield* active(r.id)) return true
          return false
        })
        return yield* busy.pipe(
          Effect.repeat({ schedule: Schedule.spaced(wait.every), while: (b) => b }),
          Effect.map((b) => !b),
          Effect.timeoutOrElse({ duration: wait.for, orElse: () => Effect.succeed(false) }),
        )
      })

      /** Closes the pull request as the task's GitHub account: null, or what went wrong. */
      const closePr = Effect.fnUntraced(function* (t: Task, repoPath: string | null, url: string) {
        const account = yield* taskBase.account(t)
        const out = yield* Effect.result(gh.gh(["pr", "close", url], { cwd: repoPath ?? undefined, account, timeout: REMOTE_TIMEOUT }))
        if (out._tag === "Failure") return out.failure.message
        if (out.success.code === 0) return null
        let s = out.success.stderr.trim()
        while (s.startsWith("gh: ")) s = s.slice(4)
        return s
      })

      /** Completes task `o`, which wasn't picked (`picked` was), as not done and cleans up after it as `b` asks. */
      const retire = Effect.fnUntraced(function* (o0: Task, picked: string, b: PickFanout) {
        const out: {
          -readonly [K in keyof PickOutcome]: K extends "notes" ? Array<string> : PickOutcome[K]
        } = { id: o0.id, key: o0.key, stopped: false, completed: false, worktree: "none", branch: "none", pushed_branch: "none", pr: "none", notes: [] }
        const why = `${picked}, made from the same prompt, was picked`
        // Its agents first: one at work would carry on in a worktree that's going.
        for (const id of [o0.id, ...(yield* taskRepo.reviewThreads(o0.id)).map((r) => r.id)]) {
          if (yield* runs.isRunning(id)) out.stopped = true
          yield* runs.abort(id)
          yield* permissions.expireFor({ _tag: "Task", task: id })
        }
        if (out.stopped) yield* note(o0.id, "warning", `Stopped: ${why}`)
        const repoPath = yield* repoOf(o0)
        out.worktree = had(o0.worktree_path !== null)
        out.branch = had(o0.branch !== null)
        out.pr = had(o0.pr_url !== null)
        const fresh = (yield* stopped(o0.id)) ? yield* taskRepo.get(o0.id) : null
        if (fresh === null) {
          out.notes.push("Its agent didn't stop in time, so it was left as it is")
          return out
        }
        const o = fresh
        if (o.status !== "done") {
          const done = yield* Effect.result(tasks.update(o.id, { status: "done", resolution: "not_done" }, Actor.board))
          if (done._tag === "Success") {
            out.completed = true
            yield* note(o.id, "info", `Completed as not done: ${why}`)
          } else out.notes.push(`Couldn't complete it as not done: ${done.failure.message}`)
        }

        out.pr = had(o.pr_url !== null)
        const url = b.close_prs === true ? o.pr_url : null
        if (url !== null) {
          const failed = yield* closePr(o, repoPath, url)
          if (failed === null) {
            out.pr = "closed"
            yield* note(o.id, "info", `Closed pull request ${url}`)
          } else out.notes.push(`Couldn't close its pull request ${url}: ${failed}`)
        }

        const branch = yield* branchOf(repoPath, o)
        const up = repoPath !== null && branch !== null ? yield* pushed(repoPath, branch) : null
        out.branch = had(branch !== null)
        out.pushed_branch = had(up !== null)
        out.worktree = had(o.worktree_path !== null)
        // The worktree first, keeping the branch: the branch goes once its pushed copy has (or there's none), so that what
        // can't be done now (a pull request kept open, a push that fails) can be done by picking again.
        const wt = o.worktree_path
        if (wt !== null) {
          const strays = yield* Effect.result((yield* exists(wt)) ? stray(git, wt) : Effect.succeed(0))
          if (strays._tag === "Success" && strays.success === 0) {
            const removed = yield* Effect.result(worktrees.teardown(o.id, { force: b.discard_uncommitted === true, deleteBranch: false }))
            if (removed._tag === "Success") out.worktree = "removed"
            else out.notes.push(`Kept its worktree: ${removed.failure.message}`)
          } else if (strays._tag === "Success") {
            const n = strays.success
            out.notes.push(`Kept its worktree: it has ${n} commit${n === 1 ? "" : "s"} on no branch (a detached HEAD), which would be lost`)
          } else out.notes.push(`Kept its worktree: couldn't check it for commits on no branch: ${strays.failure.reason}`)
        }
        if (repoPath === null || b.delete_branches !== true || branch === null) return out
        if (out.worktree === "kept") {
          out.notes.push("Kept its branch, as its worktree is kept")
          return out
        }
        if (up !== null) {
          if (out.pr === "kept") {
            // Deleting a pull request's branch closes it.
            out.notes.push(`Kept its branch and the pushed copy ${up.short}: its pull request is still open`)
            return out
          }
          const g = yield* run(repoPath, ["push", up.remote, "--delete", up.remoteRef], REMOTE_TIMEOUT)
          if (g === null || !g.ok) {
            out.notes.push(
              `Kept its branch, as its pushed copy ${up.short} couldn't be deleted: ${g === null ? "git push failed or timed out" : g.stderr.trim()}`,
            )
            return out
          }
          out.pushed_branch = "deleted"
          yield* note(o.id, "info", `Deleted the pushed branch ${up.short}`)
        }
        const g = yield* run(repoPath, ["branch", "-D", branch])
        if (g?.ok === true) {
          out.branch = "deleted"
          yield* note(o.id, "info", `Deleted branch ${branch}`)
          yield* tasks.change(o.id, () => ({ branch: null }), Actor.board).pipe(Effect.ignore)
        } else out.notes.push(`Couldn't delete its branch ${branch}: ${g === null ? "git couldn't run" : g.stderr.trim()}`)
        return out
      })

      const pick = Effect.fn("Fanout.pick")(function* (id: TaskId, b: PickFanout) {
        return yield* picking.withPermits(1)(
          Effect.gen(function* () {
            const t = yield* getTask(id)
            if (t.status === "done" && t.resolution === "not_done") {
              return yield* new Conflict({ reason: "changed_meanwhile", detail: `${t.key} was completed as not done: move it out of Done to pick it` })
            }
            const others = (yield* siblings(t)).filter((o) => o.id !== t.id)
            if (others.length === 0) return yield* new FanoutRefused({ reason: "there are no other tasks from the same prompt" })
            const results: Array<PickOutcome> = []
            for (const o of others) results.push(yield* retire(o, t.key, b))
            yield* note(t.id, "info", `Picked over ${results.map((r) => r.key).join(", ")}, made from the same prompt`)
            return { task: yield* getTask(id), results }
          }),
        )
      })

      return Fanout.of({ facts, pick })
    }),
  )
}
