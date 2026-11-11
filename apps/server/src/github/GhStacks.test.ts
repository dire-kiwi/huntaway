import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect, FileSystem } from "effect"
import { SqlClient } from "effect/sql"
import type { Project, Task, TaskId } from "@huntaway/contracts"
import { fakeGitHub, fakePull, git, tempDir, TestBoard } from "@huntaway/testing"
import type { FakeGitHub, FakeGitHubState, FakePull } from "@huntaway/testing"
import { Checkpoints } from "../git/Checkpoints.ts"
import { Restack } from "../git/Restack.ts"
import { startRef } from "../git/TaskBase.ts"
import { Worktrees } from "../git/Worktrees.ts"
import { Reactor } from "../lifecycle/Reactor.ts"
import { change, reload } from "../mcp/tools/tests/wait.ts"
import { MergeTargets } from "../merge/MergeTargets.ts"
import { Actor } from "../platform/Changes.ts"
import { Profiles } from "../profiles/Profiles.ts"
import { Projects } from "../projects/Projects.ts"
import { Runs } from "../runs/Runs.ts"
import { Tasks } from "../tasks/Tasks.ts"
import { Threads } from "../threads/Threads.ts"
import { GhStacks } from "./GhStacks.ts"

// GitHub's stacked pull requests (HA-336) over the fake GitHub: the GitHub cases of huntaway's api/stacks.test.ts. The
// old tests answered gh from a table of exact calls; here the fake GitHub keeps the pull requests and stacks, and
// `stacks` (POST `repos/o/r/stacks`, `…/add`, `…/unstack`) changes them as GitHub does.

process.env["GIT_CONFIG_GLOBAL"] = "/dev/null"
process.env["GIT_CONFIG_NOSYSTEM"] = "1"

const ME = { host: "github.com", login: "me", token: "tok-me", active: true }

/** `body` on a board whose gh is the fake GitHub of `state`. */
const onBoard = <A, E, R>(state: FakeGitHubState, body: (fake: FakeGitHub) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fake = yield* fakeGitHub(state)
    return yield* body(fake).pipe(Effect.scoped, Effect.provide(TestBoard({ ghBin: fake.bin })))
  }).pipe(Effect.provide(NodeServices.layer))

/** A project "X" on a repository on master with a bare `origin` it's pushed to. */
const project = Effect.gen(function* () {
  const top = yield* tempDir
  const repo = `${top}/repo`
  const remote = `${top}/remote.git`
  yield* (yield* FileSystem.FileSystem).makeDirectory(repo, { recursive: true }).pipe(Effect.orDie)
  yield* git(repo, ["init", "-q", "-b", "master"])
  yield* git(repo, ["commit", "-q", "--allow-empty", "-m", "init"])
  yield* git(top, ["init", "-q", "--bare", "-b", "master", remote])
  yield* git(repo, ["remote", "add", "origin", remote])
  yield* git(repo, ["push", "-q", "-u", "origin", "master"])
  const profile = (yield* (yield* Profiles).create({ name: "p" }).pipe(Effect.orDie)).id
  const p = yield* (yield* Projects).create({ profile_id: profile, name: "x", key: "X", repo_path: repo, base_branch: "master" }).pipe(Effect.orDie)
  return { p, repo, remote }
})

const write = (dir: string, file: string, text: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.writeFileString(`${dir}/${file}`, text)),
    Effect.orDie,
  )

/** A task (stacked on `on`) with a commit writing `file`, its branch pushed. */
const level = (p: Project, title: string, file: string, on: Task | null) =>
  Effect.gen(function* () {
    const made = yield* (yield* Tasks).create({ project_id: p.id, title, ...(on === null ? {} : { start_from: on.key }) }, Actor.user).pipe(Effect.orDie)
    const t = yield* (yield* Worktrees).setup(made.id).pipe(Effect.orDie)
    const wt = t.worktree_path ?? ""
    yield* write(wt, file, `${title}\n`)
    yield* git(wt, ["add", "."])
    yield* git(wt, ["commit", "-q", "-m", title])
    yield* git(wt, ["push", "-q", "-u", "origin", t.branch ?? ""])
    return yield* reload(t.id)
  })

const url = (n: number) => `https://github.com/o/r/pull/${n}`
const pullOf = (n: number, t: Task, base: string, more: Partial<FakePull> = {}) => fakePull({ number: n, head: t.branch ?? "", base, ...more })
const setPulls = (fake: FakeGitHub, pulls: ReadonlyArray<FakePull>, stacks: Readonly<Record<string, ReadonlyArray<number>>> = {}) =>
  fake.update((s) => ({ ...s, repos: { "o/r": { pulls: [...pulls], stacks: { ...stacks } } } }))

/** Sets the task's pull request as `update_task` does, and waits for the links it led to. */
const setPr = (id: TaskId, n: number) =>
  Effect.gen(function* () {
    yield* (yield* Tasks).update(id, { pr_url: url(n) }, Actor.user).pipe(Effect.orDie)
    yield* (yield* Reactor).idle
    yield* (yield* GhStacks).settled
  })

const notices = (id: TaskId) =>
  Effect.map(Effect.flatMap(Threads, (t) => t.stored(id)).pipe(Effect.orDie), (s) => s.entries.flatMap((e) => (e.item.type === "notice" ? [e.item.text] : [])))

/** What gh was asked, as its arguments joined. */
const asked = (fake: FakeGitHub) => Effect.map(fake.calls, (calls) => calls.map((c) => c.args.join(" ")))

const own = (repo: string, base: string, rev: string) =>
  Effect.map(git(repo, ["log", "--reverse", "--format=%s", `${base}..${rev}`]), (out) => out.split("\n").filter((l) => l !== ""))

/** Until the restacks of `ids` and what followed them are over. */
const restacked = (...ids: ReadonlyArray<TaskId>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    for (let i = 0; i < 6; i++) {
      yield* (yield* Reactor).idle
      for (const id of ids) yield* (yield* Restack).settled(id)
      for (const { id } of yield* sql<{ readonly id: TaskId }>`SELECT id FROM tasks`.pipe(Effect.orDie)) {
        yield* (yield* Runs).launched(id)
        yield* (yield* Checkpoints).settled(id)
      }
      yield* (yield* GhStacks).settled
    }
  })

describe("GitHub stacks", () => {
  it.effect("a level's pull request is linked into a GitHub stack with the one below; a second on the same task isn't", () =>
    onBoard({ accounts: [ME] }, (fake) =>
      Effect.gen(function* () {
        const { p } = yield* project
        const low = yield* level(p, "Low", "low.txt", null)
        const up = yield* level(p, "Up", "up.txt", low)
        const other = yield* level(p, "Other", "other.txt", low)
        yield* setPulls(fake, [pullOf(2, low, "master"), pullOf(3, up, low.branch ?? ""), pullOf(4, other, low.branch ?? "")])
        yield* setPr(low.id, 2)
        // Up has no pull request yet.
        assert.isNull((yield* reload(up.id)).github_stack)
        yield* setPr(up.id, 3)
        assert.strictEqual((yield* reload(up.id)).github_stack, 1)
        assert.include(yield* notices(up.id), "Its pull request is stacked on X-1's on GitHub: https://github.com/o/r/stack/1")
        assert.include(yield* asked(fake), "api -X POST repos/o/r/stacks -F pull_requests[]=2 -F pull_requests[]=3")
        // GitHub's stacks are single chains: Other's isn't linked, and lands after Low all the same.
        yield* setPr(other.id, 4)
        assert.isNull((yield* reload(other.id)).github_stack)
        assert.isTrue((yield* notices(other.id)).some((n) => n.startsWith("X-1's pull request has another stacked on it on GitHub already")))
        assert.isFalse((yield* asked(fake)).some((c) => c.includes("stacks/1/add")))
        // Said once, not on every change.
        yield* (yield* Tasks).update(other.id, { title: "Other 2" }, Actor.user).pipe(Effect.orDie)
        yield* (yield* Tasks).update(other.id, { pr_url: "" }, Actor.user).pipe(Effect.orDie)
        yield* setPr(other.id, 4)
        assert.strictEqual((yield* notices(other.id)).filter((n) => n.includes("another stacked on it")).length, 1)
      }),
    ),
  )

  it.effect("a level below is linked on GitHub before the one on it, so all three are one stack", () =>
    onBoard({ accounts: [ME] }, (fake) =>
      Effect.gen(function* () {
        const { p } = yield* project
        const one = yield* level(p, "One", "one.txt", null)
        const two = yield* level(p, "Two", "two.txt", one)
        const three = yield* level(p, "Three", "three.txt", two)
        yield* setPulls(fake, [pullOf(2, one, "master"), pullOf(3, two, one.branch ?? ""), pullOf(4, three, two.branch ?? "")])
        // One's and Two's pull requests were set before (not linked), and Three's is set now.
        yield* change(one.id, { pr_url: url(2) })
        yield* change(two.id, { pr_url: url(3) })
        yield* setPr(three.id, 4)
        assert.deepStrictEqual([(yield* reload(two.id)).github_stack, (yield* reload(three.id)).github_stack], [1, 1])
        assert.deepStrictEqual(
          (yield* asked(fake)).filter((c) => c.includes("POST")),
          ["api -X POST repos/o/r/stacks -F pull_requests[]=2 -F pull_requests[]=3", "api -X POST repos/o/r/stacks/1/add -F pull_requests[]=4"],
        )
      }),
    ),
  )

  it.effect("a level isn't stacked on GitHub on one whose base will change, nor on one merging into another task", () =>
    onBoard({ accounts: [ME] }, (fake) =>
      Effect.gen(function* () {
        const { p } = yield* project
        const one = yield* level(p, "One", "one.txt", null)
        const two = yield* level(p, "Two", "two.txt", one)
        const three = yield* level(p, "Three", "three.txt", two)
        // Two lands after One, and isn't in a stack on GitHub itself (One has no pull request).
        yield* setPulls(fake, [pullOf(3, two, one.branch ?? ""), pullOf(4, three, two.branch ?? "")])
        yield* change(two.id, { pr_url: url(3) })
        yield* setPr(three.id, 4)
        assert.isNull((yield* reload(three.id)).github_stack)
        assert.isTrue(
          (yield* notices(three.id)).some((n) =>
            n.startsWith("X-2 isn't in a stack on GitHub itself, and its pull request's base changes once the task it lands after lands"),
          ),
        )
        assert.isFalse((yield* asked(fake)).some((c) => c.includes("POST")))
      }),
    ),
  )

  it.effect("a level in a GitHub stack takes in GitHub's restack, with what wasn't pushed on top", () =>
    onBoard({ accounts: [ME] }, (fake) =>
      Effect.gen(function* () {
        const { p, repo, remote } = yield* project
        const low = yield* level(p, "Low", "low.txt", null)
        const up = yield* level(p, "Up", "up.txt", low)
        yield* change(up.id, { pr_url: url(3), github_stack: 9 })
        // A commit of Up's agent that isn't pushed yet.
        const wt = up.worktree_path ?? ""
        yield* write(wt, "up2.txt", "Up 2\n")
        yield* git(wt, ["add", "."])
        yield* git(wt, ["commit", "-q", "-m", "Up 2"])
        // Low squash-merged; GitHub rebases Up's own commit onto it as another committer, and force-pushes it.
        yield* git(repo, ["fetch", "-q", "origin"])
        const tree = yield* git(repo, ["rev-parse", `origin/${low.branch}^{tree}`])
        const squash = yield* git(repo, ["commit-tree", tree, "-p", "origin/master", "-m", "Low (#2)"])
        yield* git(repo, ["push", "-q", "origin", `${squash}:refs/heads/master`])
        const gh = `${yield* tempDir}/gh`
        yield* git(yield* tempDir, ["clone", "-q", remote, gh])
        yield* git(gh, ["checkout", "-q", "-b", "gh", `origin/${up.branch}`])
        yield* git(gh, ["-c", "user.name=GitHub", "-c", "user.email=noreply@github.com", "rebase", "-q", "--onto", "origin/master", `origin/${low.branch}`])
        const byGitHub = yield* git(gh, ["rev-parse", "HEAD"])
        yield* git(gh, ["push", "-q", "-f", "origin", `gh:${up.branch}`])
        yield* setPulls(fake, [pullOf(2, low, "master", { state: "MERGED" }), pullOf(3, up, "master", { headOid: byGitHub, stack: 9 })], { "9": [3] })
        yield* (yield* Tasks).update(low.id, { status: "done" }, Actor.user).pipe(Effect.orDie)
        yield* restacked(up.id)
        const t = yield* reload(up.id)
        assert.deepStrictEqual([t.restack, t.base_branch, t.status === "needs_attention"], [null, "master", false], (yield* notices(up.id)).join("\n"))
        // GitHub's commit, with the one that wasn't pushed on top of it, here, in its worktree and on the remote.
        const branch = t.branch ?? ""
        assert.strictEqual(yield* git(repo, ["rev-parse", `${branch}^`]), byGitHub)
        assert.strictEqual(yield* git(repo, ["rev-parse", `${byGitHub}^`]), squash)
        assert.deepStrictEqual(yield* own(repo, "origin/master", branch), ["Up", "Up 2"])
        assert.strictEqual(yield* git(remote, ["rev-parse", branch]), yield* git(repo, ["rev-parse", branch]))
        assert.strictEqual(yield* git(wt, ["rev-parse", "HEAD"]), yield* git(repo, ["rev-parse", branch]))
        assert.strictEqual(yield* git(repo, ["rev-parse", startRef(up.id)]), squash)
        assert.isTrue(
          (yield* notices(up.id)).some((n) =>
            n.startsWith("GitHub restacked it onto master, and the board took that in (with the commits that weren't pushed yet on top)"),
          ),
        )
        // GitHub retargeted its pull request already.
        assert.isFalse((yield* asked(fake)).some((c) => c.startsWith("pr edit")))
      }),
    ),
  )

  it.effect.each([true, false])("a level in a GitHub stack is unstacked before its pull request is retargeted (recorded: %s)", (recorded) =>
    onBoard({ accounts: [ME] }, (fake) =>
      Effect.gen(function* () {
        const { p } = yield* project
        const low = yield* level(p, "Low", "low.txt", null)
        const up = yield* level(p, "Up", "up.txt", low)
        yield* setPulls(fake, [pullOf(2, low, "master", { stack: 9 }), pullOf(3, up, low.branch ?? "", { stack: 9 })], { "9": [2, 3] })
        // Not through update_task, which would try to link it.
        yield* change(up.id, { pr_url: url(3), github_stack: recorded ? 9 : null })
        yield* (yield* Tasks).update(low.id, { status: "done", resolution: "wont_fix" }, Actor.user).pipe(Effect.orDie)
        yield* restacked(up.id)
        yield* (yield* MergeTargets).setTarget(up.id, "onward").pipe(Effect.orDie)
        yield* restacked(up.id)
        const calls = yield* asked(fake)
        const unstack = calls.indexOf("api -X POST repos/o/r/stacks/9/unstack")
        assert.isTrue(unstack >= 0 && unstack < calls.indexOf(`pr edit ${url(3)} --base master`), calls.join("\n"))
        assert.isNull((yield* reload(up.id)).github_stack)
        assert.strictEqual((yield* fake.pull("o/r", 3))?.base, "master")
        assert.isTrue(
          (yield* notices(up.id)).some((n) => n.includes("its pull request targets master now")),
          (yield* notices(up.id)).join("\n"),
        )
      }),
    ),
  )
})
