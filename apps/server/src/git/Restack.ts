import { Context, Deferred, Effect, FiberSet, FileSystem, Layer, Option, Ref } from "effect"
import type { Project, Task, TaskId } from "@huntaway/contracts"
import { Actor, Changes } from "../platform/Changes.ts"
import { KeyedLock } from "../platform/KeyedLock.ts"
import { ServerConfig } from "../platform/ServerConfig.ts"
import { ProjectRepo } from "../projects/ProjectRepo.ts"
import { restack as restackPrompt } from "../prompts/restack.ts"
import { isMerged } from "../tasks/checks.ts"
import { stackedBelow, stackedLevels } from "../tasks/lanes.ts"
import { TaskRepo } from "../tasks/TaskRepo.ts"
import { Tasks } from "../tasks/Tasks.ts"
import type { TaskColumns } from "../tasks/decide.ts"
import { Threads } from "../threads/Threads.ts"
import { Git } from "./Git.ts"
import { GitHubAccess } from "./GitHubAccess.ts"
import { expandHome } from "./paths.ts"
import { mergeBase, moveBranch, push, rebase } from "./restack/git.ts"
import type { Conflicted } from "./restack/git.ts"
import { startRef, TaskBase } from "./TaskBase.ts"
import { uncommitted } from "./worktree/remove.ts"
import { setMergeBase } from "./worktree/start.ts"
import { Worktrees } from "./Worktrees.ts"

// Stacked pull requests (docs/plan/06-server.md, Git; inventory 04, section 2.16; huntaway's git/worktree/restack.ts,
// HA-297): once the task a stack level lands after is merged, the board restacks the level onto where that went (its
// `restack` is `due` meanwhile, which holds its merge), so its pull request shows only its own work and it merges there.
// Restacks run one at a time per repository, in the order asked (`KeyedLock` `["restack", repo]`), each under the
// level's worktree lock. Never while an agent or reviewer is in its worktree (checked at the start, after GitHub's wait
// and after the rebase); never over commits on its remote that aren't here (unless GitHub rebased it); with a lease on
// the remote head it read; with the repository's hooks off; never pushing its own rebase over GitHub's. What needs the
// agent is asked of it once (`RestackAsk`, which the reactor sends), then left to the user.

/** What a restack did: `done` (onto that branch, or nothing to do), `later` (an agent is in its worktree), or why it couldn't. */
type Restacked =
  | { readonly _tag: "Done"; readonly base: string; readonly moved: boolean }
  | { readonly _tag: "Later" }
  | ({ readonly _tag: "Conflict" } & Conflicted)

const done = (base: string, moved = false): Restacked => ({ _tag: "Done", base, moved })
const conflict = (c: Conflicted): Restacked => ({ _tag: "Conflict", ...c })
const later: Restacked = { _tag: "Later" }

/** For a test: what runs once a level's commits are rebased, before it's checked that no agent started meanwhile. */
export const AfterRebase = Context.Reference<(task: TaskId) => Effect.Effect<void>>("huntaway-server/git/Restack/AfterRebase", {
  defaultValue: () => () => Effect.void,
})

export interface RestackShape {
  /**
   * Task `merged` was merged: the open stack levels on it with a branch are marked `due` and restacked onto where it went
   * (the old `restack_stacked_on`). Those without a branch yet have nothing to restack: their worktrees start from there.
   */
  readonly reconcileDependants: (merged: Task) => Effect.Effect<void>
  /** Restack task `id` in the background, after the restacks asked for before it in its repository. */
  readonly schedule: (id: TaskId) => Effect.Effect<void>
  /** A run of `id` (or of one of its review threads) ended: a restack it held off is done now, if no agent is left in its worktree. */
  readonly afterRun: (id: TaskId) => Effect.Effect<void>
  /** Waits for any restack of `id` asked for so far, so its agent doesn't start in the middle of one. */
  readonly settled: (id: TaskId) => Effect.Effect<void>
  /** Restack the levels that were due when the server stopped (Recovery). */
  readonly resume: Effect.Effect<void>
}

export class Restack extends Context.Service<Restack, RestackShape>()("huntaway-server/git/Restack") {
  static readonly layer = Layer.effect(
    Restack,
    Effect.gen(function* () {
      const g = yield* Git
      const fs = yield* FileSystem.FileSystem
      const repo = yield* TaskRepo
      const tasks = yield* Tasks
      const projects = yield* ProjectRepo
      const threads = yield* Threads
      const base = yield* TaskBase
      const worktrees = yield* Worktrees
      const github = yield* GitHubAccess
      const locks = yield* KeyedLock
      const changes = yield* Changes
      const config = yield* ServerConfig
      const fibers = yield* FiberSet.make()
      // The restacks asked for and not over, by task: how many, and what completes when the last is.
      const pending = yield* Ref.make<ReadonlyMap<string, { readonly count: number; readonly over: Deferred.Deferred<void> }>>(new Map())

      const board = Actor.board
      const say = (id: TaskId, level: "info" | "warning" | "error", text: string, detail?: string) =>
        threads.notice(id, level, text, detail === "" ? undefined : detail).pipe(Effect.ignore)
      const write = (id: TaskId, columns: TaskColumns) => tasks.change(id, () => columns, board).pipe(Effect.option, Effect.map(Option.getOrNull))
      const projectOf = (t: Task) => (t.project_id === null ? Effect.succeed(null) : Effect.map(projects.get(t.project_id), Option.getOrNull))
      const repoOf = (p: Project) => expandHome(p.repo_path, config.home)

      /** The restack itself (the old `restack`), with the level's worktree lock held. */
      const restackOne = Effect.fnUntraced(function* (id: TaskId) {
        const t = yield* repo.get(id)
        if (t === null || t.restack === null || t.status === "done") return done("nothing to do")
        if (t.running || (yield* worktrees.agentInWorktree(id))) return later
        const project = yield* projectOf(t)
        if (project === null) return done("no project")
        const dir = repoOf(project)
        const branch = t.branch
        const onto = yield* base.taskBase(t, project)
        if (branch === null || onto === null) {
          yield* write(id, { restack: null })
          return done("nothing to restack")
        }
        const account = yield* base.account(t)
        const local = `refs/heads/${branch}`
        const head = yield* g.commit(dir, local)
        // Not here (deleted, say): nothing to restack here, and its merge says where it goes.
        if (head === null) {
          yield* write(id, { restack: null })
          return done("its branch isn't in the repository")
        }
        // Its branch on the remote, under its own name only: an upstream the agent set to another branch isn't force-pushed.
        const tracked = yield* base.upstream(dir, branch)
        const elsewhere = tracked !== null && tracked.remote !== "." && tracked.merge !== local
        const up = elsewhere || tracked?.remote === "." ? null : tracked
        const pushed = up === null ? null : yield* g.commit(dir, up.tracking)
        // In a stack on GitHub with the level below: GitHub rebases it itself, a few seconds after, and the board takes that in.
        const rows = yield* repo.projectTasks(project.id)
        const below = stackedBelow(rows, t)?.task ?? null
        let byGithub: string | null = null
        if (t.github_stack !== null && pushed !== null && below !== null && (isMerged(below) || below.github_stack === t.github_stack)) {
          byGithub = yield* github.restacked(t, dir, pushed, onto)
          if (yield* worktrees.agentInWorktree(id)) return later
        }
        // Where its new base is: fetched, the newer of the branch and its upstream.
        const baseUp = yield* base.upstream(dir, onto)
        if (baseUp !== null) {
          yield* base
            .fetch(dir, baseUp, account)
            .pipe(Effect.catchTag("WorktreeFailed", (e) => say(id, "warning", `Couldn't fetch ${onto}; restacking onto the copy fetched before`, e.reason)))
        }
        const tip = yield* g.commit(dir, yield* base.compareRef(dir, onto))
        if (tip === null) return conflict({ conflict: `${onto} isn't in the repository` })
        if (elsewhere) yield* say(id, "warning", `Not pushing ${branch} to ${tracked.merge} on ${tracked.remote}, which it tracks: that's another branch`)
        if (up !== null) {
          yield* base.fetch(dir, up, account).pipe(Effect.catchTag("WorktreeFailed", (e) => say(id, "warning", `Couldn't fetch ${branch}`, e.reason)))
        }
        const remoteHead = up === null ? null : yield* g.commit(dir, up.tracking)
        // GitHub rebased it there (and it was still linked) if it moved from where it was pushed, and nothing here but new
        // commits isn't in that: onto its new base, or onto the base as it was when GitHub did it.
        const byGitHub =
          t.github_stack !== null &&
          byGithub !== "unstacked" &&
          pushed !== null &&
          remoteHead !== null &&
          remoteHead !== pushed &&
          (yield* g.isAncestor(dir, pushed, head)) &&
          (byGithub === "rebased" || (yield* g.isAncestor(dir, tip, remoteHead)))
        if (remoteHead !== null && up !== null && !byGitHub && !(yield* g.isAncestor(dir, remoteHead, head))) {
          return conflict({ conflict: `its branch on ${up.remote} has commits that aren't in ${branch} here` })
        }
        const wt = yield* g.checkedOutIn(dir, local)
        if (wt !== null) {
          const dirty = yield* uncommitted(g, fs, wt).pipe(Effect.result)
          if (dirty._tag === "Failure") return conflict({ conflict: "its worktree couldn't be read", detail: dirty.failure.reason })
          if (dirty.success.length > 0) return conflict({ conflict: "its worktree has uncommitted changes" })
        }
        let newHead = head
        let count = 0
        // Where its own work starts, if its branch still has it (its agent may have restacked it already).
        const kept = yield* g.commit(dir, startRef(id))
        const start = kept !== null && (yield* g.isAncestor(dir, kept, head)) ? kept : null
        // On its new base already, with nothing between that and its own work that the base doesn't have.
        const onTip = (yield* g.isAncestor(dir, tip, head)) && (start === null || (yield* g.isAncestor(dir, start, tip)))
        if (byGitHub && remoteHead !== null && pushed !== null) {
          // GitHub's rebase, and on top of it what wasn't pushed before.
          newHead = remoteHead
          if (pushed !== head) {
            const rebased = yield* rebase(g, fs, dir, pushed, head, remoteHead)
            if ("conflict" in rebased) return conflict(rebased)
            newHead = rebased.head
          }
        } else if (!onTip) {
          if (kept === null) return conflict({ conflict: "where its own work starts isn't known (it has no start ref)" })
          if (start === null) return conflict({ conflict: "its branch no longer has the commit where its own work started" })
          count = Number((yield* g.run(dir, ["rev-list", "--count", `${start}..${head}`])).stdout.trim()) || 0
          const rebased = yield* rebase(g, fs, dir, start, head, tip)
          if ("conflict" in rebased) return conflict(rebased)
          newHead = rebased.head
        }
        yield* (yield* AfterRebase)(id)
        // Its agent may have started meanwhile (fetching takes a while), or the branch moved.
        if (yield* worktrees.agentInWorktree(id)) return later
        if ((yield* g.commit(dir, local)) !== head) return conflict({ conflict: `its branch ${branch} moved while it was being restacked` })
        if (newHead !== head) {
          const moved = yield* moveBranch(g, dir, wt, local, newHead, head)
          if (moved !== null) return conflict({ conflict: `its branch ${branch} couldn't be moved`, detail: moved })
        }
        if (up !== null && remoteHead !== null && remoteHead !== newHead) {
          const failed = yield* push(g, github, dir, up.remote, up.merge, newHead, remoteHead, account)
          if (failed !== null) {
            // Put back as it was, unless it moved since.
            if (newHead !== head) yield* moveBranch(g, dir, wt, local, head, newHead)
            return conflict({ conflict: `pushing it to ${up.remote} failed`, detail: failed })
          }
        }
        // It starts on its new base from now on.
        yield* g.run(dir, ["update-ref", startRef(id), (yield* mergeBase(g, dir, tip, newHead)) ?? tip]).pipe(Effect.ignore)
        const u = yield* write(id, { restack: null, base_branch: onto })
        if (u !== null) yield* setMergeBase(g, dir, branch, yield* base.taskBase(u, project), project.base_branch === "" ? null : project.base_branch)
        // Its pull request goes there too, whatever its base branch was before.
        let prNote = ""
        if (u?.pr_url !== null && u?.pr_url !== undefined) {
          const to = (yield* base.remoteBase(u, project)) ?? onto
          const r = yield* github.retarget(u, dir, u.pr_url, to)
          if ("error" in r) yield* say(id, "warning", `Couldn't change its pull request's base to ${to}`, r.error)
          else if (r.moved) prNote = `, and its pull request targets ${to} now`
        }
        const what = byGitHub
          ? `GitHub restacked it onto ${onto}, and the board took that in${newHead !== remoteHead ? " (with the commits that weren't pushed yet on top)" : ""}`
          : newHead === head
            ? `It's on ${onto} already`
            : `Restacked onto ${onto}: ${count} commit${count === 1 ? "" : "s"} of its own rebased${remoteHead !== null && up !== null ? ` and pushed to ${up.remote}` : ""}`
        yield* say(id, "info", `${what}${prNote}`)
        // Linked on GitHub where it goes now, if it can be.
        if (u !== null) yield* github.linkStacks(u.id)
        return done(onto, newHead !== head)
      })

      /**
       * Restacking `t` needs its agent: the first time, it's asked to (by the reactor, `RestackAsk`); after it's had a go
       * (its run ended with the restack still to do), the task needs the user's attention.
       */
      const conflicted = Effect.fnUntraced(function* (t: Task, c: Conflicted) {
        const project = yield* projectOf(t)
        const onto = (yield* base.taskBase(t, project)) ?? "the base branch"
        const again = t.restack === "conflict"
        yield* write(t.id, { restack: "conflict" })
        const reason = `Couldn't restack it onto ${onto}: ${c.conflict}`
        yield* say(t.id, "warning", reason, c.detail)
        if (again || t.status === "done") {
          if (t.status !== "done") yield* write(t.id, { status: "needs_attention", attention_reason: reason, merging: false, remerge: t.merging || t.remerge })
          return
        }
        const below = project === null ? null : (stackedBelow(yield* repo.projectTasks(project.id), t)?.task ?? null)
        const them = below?.key ?? "The task this one lands after"
        const text = restackPrompt({
          them,
          onto,
          branch: t.branch ?? "",
          conflict: c.conflict,
          startRef: startRef(t.id),
          githubStack: t.github_stack !== null,
        })
        yield* changes.offer({ _tag: "RestackAsk", task: t.id, text, reason })
      })

      /** What follows a restack of `id` that ended in `r`. */
      const after = Effect.fnUntraced(function* (id: TaskId, r: Restacked) {
        const t = yield* repo.get(id)
        if (t === null || r._tag === "Later") return
        if (r._tag === "Conflict") {
          yield* conflicted(t, r)
          return
        }
        // The levels stacked on it follow its branch, which has moved, and so do those waiting for it to be restacked first.
        if (t.project_id === null) return
        for (const up of stackedLevels(yield* repo.projectTasks(t.project_id), id)) {
          if (up.branch === null || (!r.moved && up.restack !== "due")) continue
          if (up.restack !== "due") yield* write(up.id, { restack: "due" })
          yield* schedule(up.id)
        }
      })

      const finished = (id: string) =>
        Effect.flatMap(
          Ref.modify(pending, (m) => {
            const p = m.get(id)
            if (p === undefined) return [null, m] as const
            const next = new Map(m)
            if (p.count <= 1) next.delete(id)
            else next.set(id, { count: p.count - 1, over: p.over })
            return [p.count <= 1 ? p.over : null, next] as const
          }),
          (over) => (over === null ? Effect.void : Deferred.succeed(over, undefined)),
        )

      const schedule = (id: TaskId): Effect.Effect<void> =>
        Effect.gen(function* () {
          const t = yield* repo.get(id)
          const project = t === null ? null : yield* projectOf(t)
          if (t === null || project === null) return
          const over = yield* Deferred.make<void>()
          yield* Ref.update(pending, (m) => {
            const p = m.get(id)
            return new Map([...m, [id, { count: (p?.count ?? 0) + 1, over: p?.over ?? over }]])
          })
          const job = locks
            .withLock(["restack", repoOf(project)])(worktrees.withLock(id)(restackOne(id)))
            .pipe(
              Effect.catchCause((cause) => Effect.succeed(conflict({ conflict: "the restack failed", detail: String(cause) }))),
              Effect.flatMap((r) => after(id, r)),
              Effect.catchCause((cause) => Effect.logError(`task ${id}: after its restack`, cause)),
              Effect.ensuring(finished(id)),
            )
          yield* FiberSet.run(fibers, job)
        })

      const reconcileDependants = Effect.fn("Restack.reconcileDependants")(function* (merged: Task) {
        if (merged.project_id === null) return
        const project = yield* projectOf(merged)
        const levels = stackedLevels(yield* repo.projectTasks(merged.project_id), merged.id).filter((t) => t.branch !== null)
        // Their start refs first take in what they took of its branch since they last did, as their own work starts there.
        if (levels.length > 0) yield* base.keepStarts(merged.id)
        for (const t of levels) {
          if (t.branch === null) continue
          const u = yield* write(t.id, { restack: "due" })
          if (u === null) continue
          const to = (yield* base.taskBase(u, project)) ?? "the base branch"
          yield* say(
            t.id,
            "info",
            `${merged.key}, which this task lands after, was merged: ${t.github_stack !== null ? "GitHub restacks it" : "restacking it"} onto ${to}`,
          )
          yield* schedule(t.id)
        }
      })

      const afterRun = Effect.fn("Restack.afterRun")(function* (id: TaskId) {
        const t = yield* repo.get(id)
        const level = t !== null && t.kind === "review" && t.parent_id !== null ? yield* repo.get(t.parent_id) : t
        if (level === null || level.restack === null || (yield* worktrees.agentInWorktree(level.id))) return
        yield* schedule(level.id)
      })

      const settled = (id: TaskId) =>
        Effect.flatMap(Ref.get(pending), (m) => {
          const p = m.get(id)
          return p === undefined ? Effect.void : Deferred.await(p.over)
        })

      const resume = Effect.gen(function* () {
        for (const t of (yield* repo.all).filter((x) => x.kind === "task" && x.restack === "due" && x.status !== "done")) yield* schedule(t.id)
      }).pipe(Effect.withSpan("Restack.resume"))

      return Restack.of({ reconcileDependants, schedule, afterRun, settled, resume })
    }),
  )
}
