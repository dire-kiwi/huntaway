import { assert, describe, it } from "@effect/vitest"
import { Cause, Effect, Exit, FileSystem } from "effect"
import { SqlClient } from "effect/sql"
import type { Project, Task, TaskId } from "@huntaway/contracts"
import { git, tempDir, TestBoard } from "@huntaway/testing"
import { Prompts } from "../agents/Prompts.ts"
import { Checkpoints } from "../git/Checkpoints.ts"
import { Restack } from "../git/Restack.ts"
import { startRef } from "../git/TaskBase.ts"
import { Worktrees } from "../git/Worktrees.ts"
import { Reactor } from "../lifecycle/Reactor.ts"
import { change, reload } from "../mcp/tools/tests/wait.ts"
import { Actor } from "../platform/Changes.ts"
import type { ServerConfigShape } from "../platform/ServerConfig.ts"
import { Profiles } from "../profiles/Profiles.ts"
import { Projects } from "../projects/Projects.ts"
import { Runs } from "../runs/Runs.ts"
import { activeMerge, mergeHeld, stackState, stackWaits } from "../tasks/lanes.ts"
import { TaskRepo } from "../tasks/TaskRepo.ts"
import { Tasks } from "../tasks/Tasks.ts"
import { TaskDeletion } from "../runs/TaskDeletion.ts"
import { ThreadReaders } from "../threads/ThreadReaders.ts"
import { Threads } from "../threads/Threads.ts"
import { MergeTargets } from "./MergeTargets.ts"

// Stacks on the whole board's services (HA-297, HA-295, HA-386): the cases of huntaway's api/stacks.test.ts,
// api/incoming.test.ts and api/stack_merge.test.ts that need git or a board (the lane rules are decide.test.ts's, what
// a merge request says request.test.ts's, GitHub's stacks GhStacks.test.ts's). Levels are tasks with worktrees on a
// repository whose `origin` is a bare one in a temp folder; a level below is merged as GitHub squash-merges one. A test
// board has no ia-shim: a run the board starts registers and then fails to launch.

process.env["GIT_CONFIG_GLOBAL"] = "/dev/null"
process.env["GIT_CONFIG_NOSYSTEM"] = "1"

const board = <A, E, R>(effect: Effect.Effect<A, E, R>, config: Partial<ServerConfigShape> = {}) =>
  effect.pipe(Effect.scoped, Effect.provide(TestBoard(config)))

/** A project "X" on a repository on master with a bare `origin` (`remote`) it's pushed to; with `remote` false, none. */
const project = (withRemote = true) =>
  Effect.gen(function* () {
    const top = yield* tempDir
    const repo = `${top}/repo`
    const remote = `${top}/remote.git`
    yield* (yield* FileSystem.FileSystem).makeDirectory(repo, { recursive: true }).pipe(Effect.orDie)
    yield* git(repo, ["init", "-q", "-b", "master"])
    yield* git(repo, ["commit", "-q", "--allow-empty", "-m", "init"])
    if (withRemote) {
      yield* git(top, ["init", "-q", "--bare", "-b", "master", remote])
      yield* git(repo, ["remote", "add", "origin", remote])
      yield* git(repo, ["push", "-q", "-u", "origin", "master"])
    }
    const profile = (yield* (yield* Profiles).create({ name: "p" }).pipe(Effect.orDie)).id
    const p = yield* (yield* Projects).create({ profile_id: profile, name: "x", key: "X", repo_path: repo, base_branch: "master" }).pipe(Effect.orDie)
    return { p, repo, remote }
  })

const write = (dir: string, file: string, text: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.writeFileString(`${dir}/${file}`, text)),
    Effect.orDie,
  )

/** A task (stacked on `on`, if given) with a commit writing `file`, its branch pushed to origin if `push`. */
const level = (p: Project, title: string, file: string, on: Task | null, push = true) =>
  Effect.gen(function* () {
    const made = yield* (yield* Tasks).create({ project_id: p.id, title, ...(on === null ? {} : { start_from: on.key }) }, Actor.user).pipe(Effect.orDie)
    const t = yield* (yield* Worktrees).setup(made.id).pipe(Effect.orDie)
    const wt = t.worktree_path ?? ""
    yield* write(wt, file, `${title}\n`)
    yield* git(wt, ["add", "."])
    yield* git(wt, ["commit", "-q", "-m", title])
    if (push) yield* git(wt, ["push", "-q", "-u", "origin", t.branch ?? ""])
    return yield* reload(t.id)
  })

/** Squash `t`'s branch (as on origin) into origin's master, as GitHub's squash merge does: the new master. */
const squashMerge = (repo: string, t: Task) =>
  Effect.gen(function* () {
    yield* git(repo, ["fetch", "-q", "origin"])
    const tree = yield* git(repo, ["rev-parse", `origin/${t.branch}^{tree}`])
    const sha = yield* git(repo, ["commit-tree", tree, "-p", "origin/master", "-m", `${t.title} (#1)`])
    yield* git(repo, ["push", "-q", "origin", `${sha}:refs/heads/master`])
    return sha
  })

/** The subjects of the commits on `rev` that `base` doesn't have, oldest first. */
const own = (repo: string, base: string, rev: string) =>
  Effect.map(git(repo, ["log", "--reverse", "--format=%s", `${base}..${rev}`]), (out) => out.split("\n").filter((l) => l !== ""))

const rev = (repo: string, r: string) => git(repo, ["rev-parse", r])

/** Until the board's restacks of `ids` (and what they led to) and what followed them are over. */
const restacked = (...ids: ReadonlyArray<TaskId>) =>
  Effect.gen(function* () {
    const reactor = yield* Reactor
    const restack = yield* Restack
    const runs = yield* Runs
    const checkpoints = yield* Checkpoints
    const sql = yield* SqlClient.SqlClient
    for (let i = 0; i < 6; i++) {
      yield* reactor.idle
      for (const id of ids) yield* restack.settled(id)
      for (const { id } of yield* sql<{ readonly id: TaskId }>`SELECT id FROM tasks`.pipe(Effect.orDie)) {
        yield* runs.launched(id)
        yield* checkpoints.settled(id)
      }
    }
    yield* reactor.idle
  })

const update = (id: TaskId, patch: Parameters<Tasks["Service"]["update"]>[1]) =>
  Effect.flatMap(Tasks, (t) => t.update(id, patch, Actor.user)).pipe(Effect.orDie)
const rows = (p: Project) => (yield_: TaskRepo["Service"]) => yield_.projectTasks(p.id)
const projectRows = (p: Project) => Effect.flatMap(TaskRepo, rows(p))

const notices = (id: TaskId) =>
  Effect.map(Effect.flatMap(Threads, (t) => t.stored(id)).pipe(Effect.orDie), (s) => s.entries.flatMap((e) => (e.item.type === "notice" ? [e.item.text] : [])))
const lastPrompt = (id: TaskId) =>
  Effect.map(
    Effect.flatMap(ThreadReaders, (r) => r.lastUserMessage(id)),
    (m) => m?.text ?? "",
  )

/** What a failure said, or "" for a success. */
const failure = (exit: Exit.Exit<unknown, unknown>): string => {
  if (Exit.isSuccess(exit)) return ""
  const e = Cause.squash(exit.cause)
  if (typeof e === "object" && e !== null && "detail" in e && typeof e.detail === "string") return e.detail
  if (typeof e === "object" && e !== null && "reason" in e && typeof e.reason === "string") return e.reason
  return String(e)
}

describe("restacking", () => {
  it.effect("a squash-merged level below restacks the level above onto where it went", () =>
    board(
      Effect.gen(function* () {
        const { p, repo, remote } = yield* project()
        const low = yield* level(p, "Low", "low.txt", null)
        const up = yield* level(p, "Up", "up.txt", low)
        assert.strictEqual(yield* rev(repo, startRef(up.id)), yield* rev(repo, low.branch ?? ""))
        const squash = yield* squashMerge(repo, low)
        yield* update(low.id, { status: "done" })
        // Marked at once, so its merge waits.
        yield* (yield* Reactor).idle
        yield* restacked(up.id)
        const t = yield* reload(up.id)
        assert.deepStrictEqual([t.restack, t.base_branch, stackState(yield* projectRows(p), t)], [null, "master", "merged"])
        // Only its own commit, on the squash; pushed (the lease held), and its worktree moved with it.
        const branch = t.branch ?? ""
        assert.deepStrictEqual(yield* own(repo, "origin/master", branch), ["Up"])
        assert.strictEqual(yield* rev(repo, `${branch}^`), squash)
        assert.strictEqual(yield* git(remote, ["rev-parse", branch]), yield* rev(repo, branch))
        assert.strictEqual(yield* rev(t.worktree_path ?? "", "HEAD"), yield* rev(repo, branch))
        assert.strictEqual(yield* git(t.worktree_path ?? "", ["status", "--porcelain"]), "")
        assert.strictEqual(yield* rev(repo, startRef(up.id)), squash)
        assert.isTrue((yield* notices(up.id)).some((n) => n.startsWith("Restacked onto master: 1 commit of its own rebased and pushed to origin")))
        // gh pr create goes to the project's base branch now.
        assert.strictEqual(yield* git(repo, ["config", "--default", "", `branch.${branch}.gh-merge-base`]), "")
      }),
    ),
  )

  it.effect("a restack doesn't push to another branch its branch tracks", () =>
    board(
      Effect.gen(function* () {
        const { p, repo, remote } = yield* project()
        const low = yield* level(p, "Low", "low.txt", null)
        const up = yield* level(p, "Up", "up.txt", low, false)
        yield* git(up.worktree_path ?? "", ["push", "-q", "-u", "origin", "HEAD:refs/heads/shared"])
        const shared = yield* git(remote, ["rev-parse", "shared"])
        yield* squashMerge(repo, low)
        yield* update(low.id, { status: "done" })
        yield* restacked(up.id)
        const t = yield* reload(up.id)
        assert.deepStrictEqual(yield* own(repo, "origin/master", t.branch ?? ""), ["Up"], "restacked here")
        assert.strictEqual(yield* git(remote, ["rev-parse", "shared"]), shared, "the branch it tracked wasn't pushed to")
      }),
    ),
  )

  it.effect("a three-level stack restacks each level on the one below it", () =>
    board(
      Effect.gen(function* () {
        const { p, repo, remote } = yield* project()
        const one = yield* level(p, "One", "one.txt", null)
        const two = yield* level(p, "Two", "two.txt", one)
        const three = yield* level(p, "Three", "three.txt", two)
        yield* squashMerge(repo, one)
        yield* update(one.id, { status: "done" })
        yield* restacked(two.id, three.id)
        const t2 = yield* reload(two.id)
        let t3 = yield* reload(three.id)
        assert.deepStrictEqual([t2.restack, t2.base_branch], [null, "master"])
        // Three follows Two's new branch, still stacked on it, with neither One's commit nor Two's old one.
        assert.deepStrictEqual([t3.restack, t3.base_branch, stackState(yield* projectRows(p), t3)], [null, two.branch, "open"])
        assert.deepStrictEqual(yield* own(repo, "origin/master", t3.branch ?? ""), ["Two", "Three"])
        assert.strictEqual(yield* rev(repo, `${t3.branch}^`), yield* rev(repo, two.branch ?? ""))
        assert.strictEqual(yield* git(remote, ["rev-parse", t3.branch ?? ""]), yield* rev(repo, t3.branch ?? ""))
        assert.strictEqual(yield* rev(repo, startRef(three.id)), yield* rev(repo, two.branch ?? ""))
        // Two merges in turn (a plain merge this time): Three goes to master.
        yield* git(repo, ["push", "-q", "origin", `${two.branch}:refs/heads/master`])
        yield* update(two.id, { status: "done" })
        yield* restacked(three.id)
        t3 = yield* reload(three.id)
        assert.deepStrictEqual([t3.restack, t3.base_branch, stackState(yield* projectRows(p), t3)], [null, "master", "merged"])
        assert.deepStrictEqual(yield* own(repo, "origin/master", t3.branch ?? ""), ["Three"])
      }),
    ),
  )

  it.effect("a restack that conflicts is left to the agent, then to the user; once it's done, the next run's end finishes it", () =>
    board(
      Effect.gen(function* () {
        const { p, repo } = yield* project()
        const low = yield* level(p, "Low", "low.txt", null)
        const up = yield* level(p, "Up", "low.txt", low)
        yield* change(up.id, { status: "in_review" })
        const head = yield* rev(repo, up.branch ?? "")
        // Low was squashed in with a change to the same file.
        yield* git(repo, ["fetch", "-q", "origin"])
        const wt = `${yield* tempDir}/wt`
        yield* git(repo, ["worktree", "add", "-q", "--detach", wt, "origin/master"])
        yield* write(wt, "low.txt", "Low, as merged\n")
        yield* git(wt, ["add", "."])
        yield* git(wt, ["commit", "-q", "-m", "Low (#1)"])
        yield* git(wt, ["push", "-q", "origin", "HEAD:refs/heads/master"])
        yield* update(low.id, { status: "done" })
        yield* restacked(up.id)
        let t = yield* reload(up.id)
        // Nothing moved, and its agent is asked to do it (its launch fails here: no agent).
        assert.strictEqual(t.restack, "conflict")
        assert.strictEqual(yield* rev(repo, up.branch ?? ""), head)
        assert.strictEqual(yield* git(up.worktree_path ?? "", ["status", "--porcelain"]), "")
        const asked = yield* lastPrompt(up.id)
        assert.match(asked, /couldn't restack its branch .* onto `master` itself: its commits conflict with it/)
        assert.include(asked, startRef(up.id))
        // Its run ends (here: its launch failed) with the restack still to do: the user's turn.
        yield* (yield* Restack).afterRun(up.id)
        yield* restacked(up.id)
        t = yield* reload(up.id)
        assert.strictEqual(t.status, "needs_attention")
        assert.match(t.attention_reason ?? "", /Couldn't restack it onto master: its commits conflict with it/)
        assert.isTrue(stackWaits(yield* projectRows(p), t))
        // Once its agent has rebased and pushed it, the next run's end finishes the restack.
        const uwt = up.worktree_path ?? ""
        yield* git(uwt, ["fetch", "-q", "origin"])
        yield* git(uwt, ["reset", "-q", "--hard", "origin/master"])
        yield* write(uwt, "low.txt", "Up\n")
        yield* git(uwt, ["commit", "-q", "-am", "Up"])
        yield* git(uwt, ["push", "-q", "-f", "origin", up.branch ?? ""])
        yield* (yield* Restack).afterRun(up.id)
        yield* restacked(up.id)
        t = yield* reload(up.id)
        assert.deepStrictEqual([t.restack, t.base_branch], [null, "master"])
      }),
    ),
  )

  it.effect.each(["remote ahead", "uncommitted"] as const)("a restack with its branch's remote %s is left to the agent", (how) =>
    board(
      Effect.gen(function* () {
        const { p, repo, remote } = yield* project()
        const low = yield* level(p, "Low", "low.txt", null)
        const up = yield* level(p, "Up", "up.txt", low)
        const head = yield* rev(repo, up.branch ?? "")
        if (how === "remote ahead") {
          // Someone pushed to its branch from elsewhere.
          const other = `${yield* tempDir}/other`
          yield* git(yield* tempDir, ["clone", "-q", "-b", up.branch ?? "", remote, other])
          yield* write(other, "more.txt", "more\n")
          yield* git(other, ["add", "."])
          yield* git(other, ["commit", "-q", "-m", "More"])
          yield* git(other, ["push", "-q", "origin", up.branch ?? ""])
        } else yield* write(up.worktree_path ?? "", "up.txt", "changed\n")
        const remoteHead = yield* git(remote, ["rev-parse", up.branch ?? ""])
        yield* squashMerge(repo, low)
        yield* update(low.id, { status: "done" })
        yield* restacked(up.id)
        const t = yield* reload(up.id)
        assert.strictEqual(t.restack, "conflict")
        assert.include(yield* lastPrompt(up.id), how === "remote ahead" ? "has commits that aren't in" : "uncommitted changes")
        assert.strictEqual(yield* rev(repo, up.branch ?? ""), head)
        assert.strictEqual(yield* git(remote, ["rev-parse", up.branch ?? ""]), remoteHead)
      }),
    ),
  )

  it.effect("a level with no remote is restacked here", () =>
    board(
      Effect.gen(function* () {
        const { p, repo } = yield* project(false)
        const low = yield* level(p, "Low", "low.txt", null, false)
        const up = yield* level(p, "Up", "up.txt", low, false)
        yield* git(repo, ["merge", "-q", "--squash", low.branch ?? ""])
        yield* git(repo, ["commit", "-q", "-m", "Low (squashed)"])
        yield* update(low.id, { status: "done" })
        yield* restacked(up.id)
        const t = yield* reload(up.id)
        assert.deepStrictEqual([t.restack, t.base_branch], [null, "master"])
        assert.deepStrictEqual(yield* own(repo, "master", t.branch ?? ""), ["Up"])
      }),
    ),
  )

  it.effect("a level whose agent is running is restacked when its run ends", () =>
    board(
      Effect.gen(function* () {
        const { p, repo } = yield* project()
        const low = yield* level(p, "Low", "low.txt", null)
        const up = yield* level(p, "Up", "up.txt", low)
        yield* squashMerge(repo, low)
        // Its agent is working.
        yield* change(up.id, { running: true })
        yield* update(low.id, { status: "done" })
        yield* restacked(up.id)
        assert.strictEqual((yield* reload(up.id)).restack, "due")
        yield* change(up.id, { running: false })
        yield* (yield* Restack).afterRun(up.id)
        yield* restacked(up.id)
        const t = yield* reload(up.id)
        assert.deepStrictEqual([t.restack, t.base_branch], [null, "master"])
      }),
    ),
  )

  it.effect("a waiting level merges once restacked, into where the level below went", () =>
    board(
      Effect.gen(function* () {
        const { p, repo } = yield* project()
        const low = yield* level(p, "Low", "low.txt", null)
        const up = yield* level(p, "Up", "up.txt", low)
        yield* change(up.id, { status: "in_review" })
        yield* update(up.id, { status: "ready_for_merge" })
        yield* restacked(up.id)
        assert.strictEqual(yield* lastPrompt(up.id), "")
        assert.include(yield* notices(up.id), "Waits for X-1, which it lands after, to be merged")
        yield* squashMerge(repo, low)
        yield* update(low.id, { status: "done" })
        yield* restacked(up.id)
        assert.match(yield* lastPrompt(up.id), /Merge branch `[^`]+` into `master`\. This task landed after X-1, which is merged: its branch was restacked/)
      }),
    ),
  )

  it.effect("a restacked level's agent is told it goes where the level below went", () =>
    board(
      Effect.gen(function* () {
        const { p, repo } = yield* project()
        const low = yield* level(p, "Low", "low.txt", null)
        const up = yield* level(p, "Up", "up.txt", low)
        const told = Effect.flatMap(Prompts, (prompts) => prompts.system(up.id, { codex: false, permission_mode: "default" }))
        // While Low is open: stacked on its branch.
        let text = yield* told
        assert.include(text, `\`${low.branch}\` is that task's branch`)
        assert.include(text, "It lands after that task, on its own")
        yield* squashMerge(repo, low)
        yield* update(low.id, { status: "done" })
        yield* restacked(up.id)
        const t = yield* reload(up.id)
        assert.deepStrictEqual([t.restack, t.base_branch], [null, "master"])
        text = yield* told
        assert.notInclude(text, "is that task's branch")
        assert.notInclude(text, "don't merge this task into that task's branch")
        assert.include(text, "branched from `master`")
      }),
    ),
  )

  it.effect("a restack due when the server stopped is done after a restart", () =>
    board(
      Effect.gen(function* () {
        const { p, repo } = yield* project()
        const low = yield* level(p, "Low", "low.txt", null)
        const up = yield* level(p, "Up", "up.txt", low)
        yield* squashMerge(repo, low)
        // Merged and marked, as a restart finds it: nothing restacking it.
        yield* change(low.id, { status: "done", resolution: "done" })
        yield* change(up.id, { restack: "due" })
        yield* (yield* Restack).resume
        yield* restacked(up.id)
        const t = yield* reload(up.id)
        assert.deepStrictEqual([t.restack, t.base_branch], [null, "master"])
        assert.deepStrictEqual(yield* own(repo, "origin/master", t.branch ?? ""), ["Up"])
      }),
    ),
  )

  it.effect("a waiting level can be talked to without holding a merge slot", () =>
    board(
      Effect.gen(function* () {
        const { p } = yield* project()
        const low = yield* level(p, "Low", "low.txt", null)
        const up = yield* level(p, "Up", "up.txt", low)
        yield* change(up.id, { status: "in_review" })
        yield* update(up.id, { status: "ready_for_merge" })
        yield* (yield* Runs).send(up.id, { text: "a question", source: "user" }).pipe(Effect.orDie)
        const t = yield* reload(up.id)
        assert.deepStrictEqual([t.status, t.merging, t.remerge], ["in_progress", false, true])
        assert.isNull(activeMerge(yield* projectRows(p), null, new Set()))
        assert.include(
          yield* notices(up.id),
          "Out of Ready for merge while its agent works: it goes back to waiting for the task it lands after when it's done",
        )
        yield* restacked(up.id)
      }),
    ),
  )
})

describe("where held tasks go now", () => {
  it.effect.each(["closed", "deleted"] as const)("levels on a %s level go where it was going, without its commits", (how) =>
    board(
      Effect.gen(function* () {
        const { p, repo, remote } = yield* project()
        const low = yield* level(p, "Low", "low.txt", null)
        const up = yield* level(p, "Up", "up.txt", low)
        const top = yield* level(p, "Top", "top.txt", up)
        yield* change(up.id, { status: "in_review" })
        if (how === "closed") yield* update(low.id, { status: "done", resolution: "wont_fix" })
        else yield* (yield* TaskDeletion).delete(low.id, { deleteBranch: false }, Actor.user).pipe(Effect.orDie)
        yield* restacked(up.id)
        let t = yield* reload(up.id)
        assert.deepStrictEqual([t.status, stackState(yield* projectRows(p), t), mergeHeld(yield* projectRows(p), t)], ["needs_attention", how, true])
        assert.match(
          t.attention_reason ?? "",
          how === "closed" ? /X-1, which this task lands after, was closed without being merged/ : /X-1, which this task lands after, was deleted/,
        )
        // Top, stacked on Up, isn't held.
        assert.strictEqual((yield* reload(top.id)).status, "todo")
        yield* (yield* MergeTargets).setTarget(up.id, "onward").pipe(Effect.orDie)
        yield* restacked(up.id, top.id)
        t = yield* reload(up.id)
        assert.deepStrictEqual(
          [t.status, t.restack, t.base_branch, t.start_from?.type, mergeHeld(yield* projectRows(p), t)],
          ["in_review", null, "master", "commit", false],
        )
        // Without Low's commit, on its remote too; and Top follows it.
        assert.deepStrictEqual(yield* own(repo, "master", t.branch ?? ""), ["Up"])
        assert.strictEqual(yield* git(remote, ["rev-parse", t.branch ?? ""]), yield* rev(repo, t.branch ?? ""))
        assert.deepStrictEqual(yield* own(repo, "master", top.branch ?? ""), ["Up", "Top"])
      }),
    ),
  )

  it.effect("a level on a closed level can take its place; or they all close too", () =>
    board(
      Effect.gen(function* () {
        const { p, repo } = yield* project()
        const low = yield* level(p, "Low", "low.txt", null)
        const a = yield* level(p, "A", "a.txt", low)
        const b = yield* level(p, "B", "b.txt", low)
        yield* update(low.id, { status: "done", resolution: "not_done" })
        yield* restacked(a.id, b.id)
        // Not one of them: refused.
        const wrong = yield* Effect.exit((yield* MergeTargets).setTarget(b.id, low.id))
        assert.include(failure(wrong), "must be one of the open tasks that are stacked on X-1")
        yield* (yield* MergeTargets).setTarget(b.id, a.id).pipe(Effect.orDie)
        yield* restacked(a.id, b.id)
        const ta = yield* reload(a.id)
        const tb = yield* reload(b.id)
        assert.deepStrictEqual([ta.restack, ta.base_branch, tb.restack, tb.base_branch], [null, "master", null, a.branch])
        assert.deepStrictEqual(tb.start_from, { type: "task", task_id: a.id })
        assert.deepStrictEqual(yield* own(repo, "master", a.branch ?? ""), ["A"])
        assert.deepStrictEqual(yield* own(repo, "master", b.branch ?? ""), ["A", "B"])
        assert.strictEqual(stackState(yield* projectRows(p), tb), "open")
        assert.include(yield* notices(a.id), "Takes X-1's place: goes to master now")
        // Nothing held any more: nothing to choose.
        const nothing = yield* Effect.exit((yield* MergeTargets).setTarget(b.id, "onward"))
        assert.include(failure(nothing), "there's nothing to choose")
      }),
    ),
  )

  it.effect("a closed level below can close the levels on it too", () =>
    board(
      Effect.gen(function* () {
        const { p } = yield* project(false)
        const low = yield* level(p, "Low", "low.txt", null, false)
        const up = yield* level(p, "Up", "up.txt", low, false)
        yield* update(low.id, { status: "done", resolution: "wont_fix" })
        yield* restacked(up.id)
        yield* (yield* MergeTargets).setTarget(up.id, "close").pipe(Effect.orDie)
        const t = yield* reload(up.id)
        assert.deepStrictEqual([t.status, t.resolution], ["done", "wont_fix"])
        assert.include(yield* notices(up.id), "Closed as X-1 was")
      }),
    ),
  )

  it.effect("closing the target holds the tasks merging into it until the user says where they go", () =>
    board(
      Effect.gen(function* () {
        const { p, repo } = yield* project(false)
        const target = yield* level(p, "Target", "t.txt", null, false)
        const made = yield* (yield* Tasks).create({ project_id: p.id, title: "A", merges_into: target.key }, Actor.user).pipe(Effect.orDie)
        const a = yield* (yield* Worktrees).setup(made.id).pipe(Effect.orDie)
        assert.strictEqual(a.base_branch, target.branch)
        assert.strictEqual(yield* git(repo, ["config", `branch.${a.branch}.gh-merge-base`]), target.branch)
        yield* change(a.id, { status: "in_review" })
        yield* update(target.id, { status: "done", resolution: "wont_fix" })
        yield* restacked(a.id)
        let t = yield* reload(a.id)
        assert.deepStrictEqual(
          [t.status, t.attention_reason],
          ["needs_attention", "X-1, which this task merges into, was closed without being merged: choose where it merges now"],
        )
        assert.include(yield* notices(a.id), "X-1, which this task merges into, was closed without being merged: choose where it merges now")
        // Onward: where X-1 was going, the base branch; it remembers it may carry X-1's commits.
        yield* (yield* MergeTargets).setTarget(a.id, "onward").pipe(Effect.orDie)
        t = yield* reload(a.id)
        assert.deepStrictEqual([t.status, t.merges_into, t.base_branch], ["in_review", null, null])
        assert.deepStrictEqual(t.carries, { key: "X-1", commit: yield* rev(repo, startRef(a.id)) })
        assert.include(yield* notices(a.id), "Merges into master now, instead of X-1")
        // Its branch goes to the base branch's pull requests now.
        assert.strictEqual(yield* git(repo, ["config", "--default", "", `branch.${a.branch}.gh-merge-base`]), "")
      }),
    ),
  )
})

describe("a whole stack's merge", () => {
  it.effect("moves every open level of the main line to Ready for merge bottom first, as one run, once each is through review", () =>
    board(
      Effect.gen(function* () {
        const { p } = yield* project(false)
        const a = yield* level(p, "A", "a.txt", null, false)
        const b = yield* level(p, "B", "b.txt", a, false)
        const c = yield* level(p, "C", "c.txt", b, false)
        const targets = yield* MergeTargets
        // Not through review yet.
        const early = yield* Effect.exit(targets.mergeStack(b.id))
        assert.include(failure(early), `The stack can't merge yet: "A" isn't started`)
        for (const t of [a, b, c]) yield* change(t.id, { status: "in_review" })
        yield* change(c.id, {
          review: {
            thread_id: c.id,
            state: "issues",
            head: "x",
            summary: null,
            issues: [],
            fixes: 0,
            extra_rounds: 0,
            updated_at: c.created_at,
            reviewers: [],
          },
        })
        assert.include(failure(yield* Effect.exit(targets.mergeStack(a.id))), `"C"'s review found issues`)
        yield* change(c.id, { review: null })
        const moved = yield* targets.mergeStack(c.id).pipe(Effect.orDie)
        assert.deepStrictEqual(
          moved.map((t) => t.id),
          [a.id, b.id, c.id],
        )
        const run = moved[0]?.stack_run ?? null
        assert.isNotNull(run)
        assert.isTrue(moved.every((t) => t.status === "ready_for_merge" && t.merging && t.stack_run === run))
        assert.isTrue((moved[1]?.position ?? 0) > (moved[0]?.position ?? 0) && (moved[2]?.position ?? 0) > (moved[1]?.position ?? 0))
        assert.include(yield* notices(a.id), "Merging with its stack: 3 levels, bottom first, with nothing else merging between them")
        yield* restacked(a.id)
        // The bottom was asked to merge, told the levels above follow it.
        assert.include(yield* lastPrompt(a.id), "the 2 levels above it merge right after this one")
        // Its levels are in Ready for merge already.
        assert.include(failure(yield* Effect.exit(targets.mergeStack(a.id))), "The stack can't merge yet")
        // A task in no stack.
        const lone = yield* level(p, "Lone", "lone.txt", null, false)
        assert.include(failure(yield* Effect.exit(targets.mergeStack(lone.id))), "the task isn't in a stack")
      }),
    ),
  )
})
