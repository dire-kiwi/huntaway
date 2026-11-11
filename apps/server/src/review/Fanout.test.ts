import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect, FileSystem, Layer } from "effect"
import { SqlClient } from "effect/sql"
import type { Task, TaskId } from "@huntaway/contracts"
import { fakeGitHub, git, tempDir, TestBoard } from "@huntaway/testing"
import type { FakeGitHub } from "@huntaway/testing"
import { Worktrees } from "../git/Worktrees.ts"
import { Actor } from "../platform/Changes.ts"
import { ServerConfig } from "../platform/ServerConfig.ts"
import { Profiles } from "../profiles/Profiles.ts"
import { Projects } from "../projects/Projects.ts"
import { TaskRepo } from "../tasks/TaskRepo.ts"
import { Tasks } from "../tasks/Tasks.ts"
import { Threads } from "../threads/Threads.ts"
import { Fanout, FanoutStopWait } from "./Fanout.ts"

// The old review/fanout.test.ts: comparing tasks made from one prompt and picking one, on the whole board's services
// with real worktrees, a bare `origin`, and the fake GitHub for closing pull requests.

process.env["GIT_CONFIG_GLOBAL"] = "/dev/null"
process.env["GIT_CONFIG_NOSYSTEM"] = "1"

const ME = { host: "github.com", login: "me", token: "tok-me", active: true }

const fsDo = <A, E>(f: (fs: FileSystem.FileSystem) => Effect.Effect<A, E>) => Effect.flatMap(FileSystem.FileSystem, (fs) => f(fs).pipe(Effect.orDie))
const exists = (p: string) => fsDo((fs) => fs.exists(p))
const write = (p: string, text: string) => fsDo((fs) => fs.writeFileString(p, text))
/** Whether `dir`'s repository has `ref` (the helper's git dies on a failure, which is taken as no). */
const hasRef = (dir: string, ref: string) =>
  Effect.map(Effect.exit(git(dir, ["rev-parse", "--verify", "--quiet", ref])), (e) => e._tag === "Success" && e.value !== "")
const reload = (id: TaskId) => Effect.flatMap(TaskRepo, (r) => r.get(id)).pipe(Effect.map((t) => t ?? null))
const notices = (id: TaskId) =>
  Effect.map(Effect.flatMap(Threads, (t) => t.stored(id)).pipe(Effect.orDie), (s) => s.entries.flatMap((e) => (e.item.type === "notice" ? [e.item.text] : [])))

/** `body` on a board whose gh is the fake GitHub (`me` its account), agents given 300 ms to stop. */
const onBoard = <A, E, R>(body: (fake: FakeGitHub) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fake = yield* fakeGitHub({ accounts: [ME] })
    return yield* body(fake).pipe(
      Effect.provide(Layer.merge(TestBoard({ ghBin: fake.bin }), Layer.succeed(FanoutStopWait, { for: "300 millis", every: "20 millis" }))),
    )
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))

/**
 * A repository (on master, pushed to a bare `origin`) with three tasks made from one prompt, each with a worktree and a
 * commit of its own: the folder everything is in, and the tasks.
 */
const fannedOut = Effect.gen(function* () {
  const root = yield* tempDir
  const [repo, origin] = [`${root}/repo`, `${root}/origin.git`]
  yield* fsDo((fs) => fs.makeDirectory(repo, { recursive: true }))
  yield* git(root, ["init", "-q", "--bare", "-b", "master", origin])
  yield* git(repo, ["init", "-q", "-b", "master"])
  yield* write(`${repo}/readme`, "hi\n")
  yield* git(repo, ["add", "."])
  yield* git(repo, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"])
  yield* git(repo, ["remote", "add", "origin", origin])
  yield* git(repo, ["push", "-q", "-u", "origin", "master"])
  const profile = yield* (yield* Profiles).create({ name: "p" }).pipe(Effect.orDie)
  const project = yield* (yield* Projects).create({ profile_id: profile.id, name: "x", repo_path: repo, key: "X", base_branch: "master" }).pipe(Effect.orDie)
  const tasks: Array<Task> = []
  for (const model of ["opus", "sonnet", "haiku"]) {
    const t = yield* (yield* Tasks).create({ project_id: project.id, title: "Do it", model, fanout_id: "f-1" }, Actor.user).pipe(Effect.orDie)
    const ready = yield* (yield* Worktrees).setup(t.id).pipe(Effect.orDie)
    const wt = ready.worktree_path ?? ""
    yield* write(`${wt}/${model}`, `${model}\n`)
    yield* git(wt, ["add", "."])
    yield* git(wt, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", model])
    tasks.push(ready)
  }
  return { root, repo, origin, profile, tasks }
})

const at = <T>(xs: ReadonlyArray<T>, i: number): T => {
  const x = xs[i]
  if (x === undefined) throw new Error(`no element ${i}`)
  return x
}

describe("Fanout", () => {
  // lists_how_long_each_ran_and_what_is_uncommitted
  it.live("lists how long each ran and what is uncommitted", () =>
    onBoard(() =>
      Effect.gen(function* () {
        const { tasks } = yield* fannedOut
        const [a, b, c] = [at(tasks, 0), at(tasks, 1), at(tasks, 2)]
        const wt = b.worktree_path ?? ""
        yield* write(`${wt}/loose`, "x")
        yield* git(wt, ["push", "-q", "-u", "origin", b.branch ?? ""])
        const sql = yield* SqlClient.SqlClient
        yield* sql`INSERT INTO runs (id, task_id, kind, status, created_at, ended_at) VALUES
          ('r1', ${a.id}, 'prompt', 'exited', '2026-01-01T10:00:00.000Z', '2026-01-01T10:01:30.000Z'),
          ('r2', ${a.id}, 'prompt', 'exited', '2026-01-01T11:00:00.000Z', '2026-01-01T11:00:30.000Z')`
        const got = yield* (yield* Fanout).facts(c.id)
        assert.deepStrictEqual(
          got.map((f) => f.id),
          tasks.map((t) => t.id),
        )
        assert.deepStrictEqual([Math.round(at(got, 0).run_secs), at(got, 0).runs], [120, 2])
        assert.deepStrictEqual([at(got, 1).uncommitted, at(got, 1).uncommitted_count], [["?? loose"], 1])
        assert.strictEqual(at(got, 1).pushed, `origin/${b.branch}`)
        assert.deepStrictEqual([at(got, 0).uncommitted, at(got, 0).pushed, at(got, 0).branch], [[], null, a.branch])
      }),
    ),
  )

  // picking_one_completes_the_others_and_keeps_uncommitted_work
  it.live("picking one completes the others and keeps uncommitted work", () =>
    onBoard(() =>
      Effect.gen(function* () {
        const fanout = yield* Fanout
        const { repo, tasks } = yield* fannedOut
        const [a, b, c] = [at(tasks, 0), at(tasks, 1), at(tasks, 2)]
        const cWt = c.worktree_path ?? ""
        yield* write(`${cWt}/draft`, "not committed")
        let r = (yield* fanout.pick(a.id, {})).results
        assert.strictEqual(r.length, 2)
        assert.deepStrictEqual([at(r, 0).key, at(r, 0).completed, at(r, 0).worktree, at(r, 0).branch, at(r, 0).pr], ["X-2", true, "removed", "kept", "none"])
        assert.deepStrictEqual([at(r, 1).completed, at(r, 1).worktree], [true, "kept"])
        assert.include(at(r, 1).notes[0] ?? "", "uncommitted")
        for (const t of [b, c]) {
          const now = yield* reload(t.id)
          assert.deepStrictEqual([now?.status, now?.resolution], ["done", "not_done"])
        }
        // Picked, it stays as it was; the others' commits are still on their branches.
        assert.strictEqual((yield* reload(a.id))?.status, a.status)
        assert.isTrue(yield* exists(a.worktree_path ?? ""))
        assert.isFalse(yield* exists(b.worktree_path ?? ""))
        assert.isTrue(yield* exists(`${cWt}/draft`))
        assert.isTrue(yield* hasRef(repo, `refs/heads/${b.branch}`))
        assert.isTrue((yield* notices(b.id)).some((n) => n.includes("X-1, made from the same prompt, was picked")))

        // A task completed as not done isn't picked over the one that was, until it's moved out of Done.
        assert.strictEqual((yield* Effect.flip(fanout.pick(b.id, {})))._tag, "Conflict")
        assert.strictEqual((yield* reload(a.id))?.status, a.status)

        // Asked again to discard what's uncommitted and delete the branches: the ones done already are cleaned up too.
        r = (yield* fanout.pick(a.id, { delete_branches: true, discard_uncommitted: true })).results
        assert.deepStrictEqual([at(r, 0).completed, at(r, 0).worktree, at(r, 0).branch], [false, "none", "deleted"])
        assert.deepStrictEqual([at(r, 1).worktree, at(r, 1).branch, at(r, 1).notes], ["removed", "deleted", []])
        assert.isFalse(yield* exists(cWt))
        for (const t of [b, c]) {
          assert.isFalse(yield* hasRef(repo, `refs/heads/${t.branch}`))
          assert.strictEqual((yield* reload(t.id))?.branch, null)
        }
        assert.isTrue(yield* hasRef(repo, `refs/heads/${a.branch}`))
      }),
    ),
  )

  // deletes_pushed_branches_and_closes_pull_requests_only_when_asked, and HA-262's closing_a_pull_request_as_an_account_leaves_no_copy_of_its_token
  it.live("deletes pushed branches and closes pull requests only when asked, as the task's account", () =>
    onBoard((fake) =>
      Effect.gen(function* () {
        const fanout = yield* Fanout
        const { repo, origin, profile, tasks } = yield* fannedOut
        const [a, b, c] = [at(tasks, 0), at(tasks, 1), at(tasks, 2)]
        yield* (yield* Profiles).update(profile.id, { github_account: "me" })
        for (const t of [b, c]) yield* git(t.worktree_path ?? "", ["push", "-q", "-u", "origin", t.branch ?? ""])
        const pr = "https://github.com/o/r/pull/7"
        yield* (yield* Tasks).change(b.id, () => ({ pr_url: pr }), Actor.board)
        const closes = Effect.map(fake.calls, (cs) => cs.filter((x) => x.args[0] === "pr" && x.args[1] === "close"))

        // Branches deleted, pull requests kept open: the pull request's branch is kept, here and where it's pushed.
        let r = (yield* fanout.pick(a.id, { delete_branches: true })).results
        assert.deepStrictEqual([at(r, 0).branch, at(r, 0).pushed_branch, at(r, 0).pr], ["kept", "kept", "kept"])
        assert.include(at(r, 0).notes[0] ?? "", "its pull request is still open")
        assert.deepStrictEqual([at(r, 1).branch, at(r, 1).pushed_branch], ["deleted", "deleted"])
        const b1 = `refs/heads/${b.branch}`
        assert.isTrue((yield* hasRef(origin, b1)) && (yield* hasRef(repo, b1)))
        assert.isFalse(yield* hasRef(origin, `refs/heads/${c.branch}`))
        assert.deepStrictEqual(yield* closes, [])
        // So the board still offers to delete it.
        assert.strictEqual(at(yield* fanout.facts(a.id), 1).pushed, `origin/${b.branch}`)

        // HA-51 review: asked to close it on a later pick, it's closed (the fake has no such pull request: a route says
        // it closed), and then its branch goes too, from both.
        yield* fake.update((s) => ({ ...s, routes: { [`pr close ${pr}`]: { stdout: "" } } }))
        r = (yield* fanout.pick(a.id, { close_prs: true, delete_branches: true })).results
        assert.deepStrictEqual([at(r, 0).pr, at(r, 0).branch, at(r, 0).pushed_branch, at(r, 0).notes], ["closed", "deleted", "deleted", []])
        const closed = yield* closes
        assert.deepStrictEqual(
          closed.map((x) => [x.args.join(" "), x.as]),
          [[`pr close ${pr}`, "me"]],
        )
        assert.isFalse((yield* hasRef(origin, b1)) || (yield* hasRef(repo, b1)))
        assert.isTrue(yield* hasRef(repo, `refs/heads/${a.branch}`))
        // HA-262: the account's gh config (its token) isn't left on disk.
        const cache = `${(yield* ServerConfig).cacheDir}/huntaway/gh-account`
        assert.deepStrictEqual(yield* fsDo((fs) => fs.readDirectory(cache)), [])
      }),
    ),
  )

  // HA-51 review: a_pushed_branch_that_cant_be_deleted_is_deleted_by_picking_again
  it.live("deletes a pushed branch that couldn't be deleted by picking again", () =>
    onBoard(() =>
      Effect.gen(function* () {
        const fanout = yield* Fanout
        const { repo, origin, tasks } = yield* fannedOut
        const [a, b] = [at(tasks, 0), at(tasks, 1)]
        yield* git(b.worktree_path ?? "", ["push", "-q", "-u", "origin", b.branch ?? ""])
        const hook = `${origin}/hooks/pre-receive`
        yield* write(hook, "#!/bin/sh\necho no deleting >&2\nexit 1\n")
        yield* fsDo((fs) => fs.chmod(hook, 0o755))
        let r = at((yield* fanout.pick(a.id, { delete_branches: true })).results, 0)
        assert.deepStrictEqual([r.worktree, r.branch, r.pushed_branch], ["removed", "kept", "kept"])
        assert.include(r.notes[0] ?? "", "no deleting")
        const b1 = `refs/heads/${b.branch}`
        assert.isTrue((yield* hasRef(repo, b1)) && (yield* hasRef(origin, b1)))
        yield* fsDo((fs) => fs.remove(hook))
        r = at((yield* fanout.pick(a.id, { delete_branches: true })).results, 0)
        assert.deepStrictEqual([r.branch, r.pushed_branch, r.notes], ["deleted", "deleted", []])
        assert.isFalse((yield* hasRef(repo, b1)) || (yield* hasRef(origin, b1)))
      }),
    ),
  )

  // HA-341: a_branch_tracking_another_branch_doesnt_get_that_branch_deleted
  it.live("doesn't delete the branch a task's branch tracks under another name", () =>
    onBoard(() =>
      Effect.gen(function* () {
        const { repo, origin, tasks } = yield* fannedOut
        const [a, b] = [at(tasks, 0), at(tasks, 1)]
        yield* git(b.worktree_path ?? "", ["push", "-q", "-u", "origin", "HEAD:refs/heads/release"])
        yield* (yield* Fanout).pick(a.id, { delete_branches: true })
        assert.isTrue(yield* hasRef(origin, "refs/heads/release"), "the branch it tracked was deleted")
        assert.isFalse(yield* hasRef(repo, `refs/heads/${b.branch}`), "its own branch is still deleted")
      }),
    ),
  )

  // HA-51 review: a_worktree_with_commits_on_no_branch_is_kept
  it.live("keeps a worktree with commits on no branch", () =>
    onBoard(() =>
      Effect.gen(function* () {
        const fanout = yield* Fanout
        const { tasks } = yield* fannedOut
        const [a, b] = [at(tasks, 0), at(tasks, 1)]
        const wt = b.worktree_path ?? ""
        yield* git(wt, ["checkout", "-q", "--detach"])
        yield* write(`${wt}/loose`, "x")
        yield* git(wt, ["add", "."])
        yield* git(wt, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "detached"])
        const f = yield* fanout.facts(a.id)
        assert.deepStrictEqual([at(f, 1).stray_commits, at(f, 1).uncommitted_count, at(f, 2).stray_commits], [1, 0, 0])
        const r = (yield* fanout.pick(a.id, { delete_branches: true, discard_uncommitted: true, close_prs: true })).results
        assert.deepStrictEqual([at(r, 0).completed, at(r, 0).worktree, at(r, 0).branch], [true, "kept", "kept"])
        assert.include(at(r, 0).notes[0] ?? "", "1 commit on no branch")
        assert.isTrue(yield* exists(`${wt}/loose`))
        assert.deepStrictEqual([at(r, 1).worktree, at(r, 1).branch], ["removed", "deleted"])
      }),
    ),
  )

  // one_whose_agent_does_not_stop_is_left_as_it_is
  it.live("leaves one whose agent doesn't stop as it is", () =>
    onBoard(() =>
      Effect.gen(function* () {
        const { tasks } = yield* fannedOut
        const [a, b] = [at(tasks, 0), at(tasks, 1)]
        // A task marked running whose run never ends (no agent to stop).
        yield* (yield* Tasks).change(b.id, () => ({ running: true }), Actor.board)
        const r = (yield* (yield* Fanout).pick(a.id, { delete_branches: true, discard_uncommitted: true, close_prs: true })).results
        assert.deepStrictEqual([at(r, 0).completed, at(r, 0).worktree, at(r, 0).branch], [false, "kept", "kept"])
        assert.include(at(r, 0).notes[0] ?? "", "didn't stop in time")
        assert.strictEqual((yield* reload(b.id))?.status, b.status)
        assert.isTrue(yield* exists(b.worktree_path ?? ""))
        assert.deepStrictEqual([at(r, 1).completed, at(r, 1).worktree], [true, "removed"])
      }),
    ),
  )

  // only_the_profiles_own_tasks_are_picked_over
  it.live("picks over the profile's own tasks only", () =>
    onBoard(() =>
      Effect.gen(function* () {
        const fanout = yield* Fanout
        const { root, tasks } = yield* fannedOut
        const a = at(tasks, 0)
        // Another profile's task with the same fanout id.
        const other = yield* (yield* Profiles).create({ name: "q" })
        const p = yield* (yield* Projects).create({ profile_id: other.id, name: "y", repo_path: `${root}/other`, key: "Y", use_worktrees: false })
        const theirs = yield* (yield* Tasks).create({ project_id: p.id, title: "Theirs", fanout_id: "f-1" }, Actor.user)
        assert.strictEqual((yield* fanout.facts(a.id)).length, 3)
        assert.strictEqual((yield* fanout.pick(a.id, {})).results.length, 2)
        assert.strictEqual((yield* reload(theirs.id))?.status, theirs.status)
        // And theirs alone has nothing to be picked over.
        assert.strictEqual((yield* Effect.flip(fanout.pick(theirs.id, {})))._tag, "FanoutRefused")
        // A task that wasn't made from one prompt with others isn't compared.
        const alone = yield* (yield* Tasks).create({ project_id: p.id, title: "Alone" }, Actor.user)
        assert.strictEqual((yield* Effect.flip(fanout.facts(alone.id)))._tag, "FanoutRefused")
      }),
    ),
  )
})
