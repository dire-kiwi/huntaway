import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber, FileSystem, Option, Stream } from "effect"
import type { Scope } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { SqlClient } from "effect/sql"
import { git, tempDir, TestBoard } from "@huntaway/testing"
import type { NewTask, Project, Task, TaskId } from "@huntaway/contracts"
import { Actor } from "../platform/Changes.ts"
import type { DataDir } from "../platform/DataDir.ts"
import { Events } from "../platform/Events.ts"
import { Profiles } from "../profiles/Profiles.ts"
import { Projects } from "../projects/Projects.ts"
import { RunDir } from "../runs/RunDir.ts"
import { RunRepo } from "../runs/RunRepo.ts"
import { Runs } from "../runs/Runs.ts"
import { TaskDeletion } from "../runs/TaskDeletion.ts"
import { Tasks } from "../tasks/Tasks.ts"
import { Threads } from "../threads/Threads.ts"
import { Git } from "./Git.ts"
import type { TaskBase } from "./TaskBase.ts"
import { folderName, Worktrees } from "./Worktrees.ts"
import type { Removal } from "./Worktrees.ts"
import { removableByHand, uncommitted } from "./worktree/remove.ts"

// huntaway's git/worktree/tests.test.ts: the setup, teardown and removal cases (where a branch starts, stacks and diffs
// are TaskBase.test.ts's). Real repositories in temp folders, git with none of the machine's configuration.

process.env["GIT_CONFIG_GLOBAL"] = "/dev/null"
process.env["GIT_CONFIG_NOSYSTEM"] = "1"

type Env = Runs | RunRepo | RunDir | Worktrees | TaskBase | Tasks | Projects | Profiles | Threads | Events | Git | DataDir | TaskDeletion | SqlClient.SqlClient
const run = <A, E>(effect: Effect.Effect<A, E, Env | FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner | Scope.Scope>) =>
  effect.pipe(Effect.scoped, Effect.provide(TestBoard()))

const rev = (dir: string, r: string) => git(dir, ["rev-parse", r])
const write = (path: string, text: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    yield* fs.makeDirectory(path.slice(0, path.lastIndexOf("/")), { recursive: true })
    yield* fs.writeFileString(path, text)
  }).pipe(Effect.orDie)
const read = (path: string) => Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString(path)).pipe(Effect.orDie)
const exists = (path: string) => Effect.flatMap(FileSystem.FileSystem, (fs) => fs.exists(path)).pipe(Effect.orDie)
const sh = (command: string, args: ReadonlyArray<string>) =>
  Effect.flatMap(ChildProcessSpawner.ChildProcessSpawner, (spawner) => spawner.string(ChildProcess.make(command, args))).pipe(Effect.orDie)

/** A repository on master with one commit (and `.gitignore` given), in a folder of its own. */
const repoOnMaster = (gitignore: string | null = null) =>
  Effect.gen(function* () {
    const repo = `${yield* tempDir}/repo`
    yield* sh("mkdir", ["-p", repo])
    yield* git(repo, ["init", "-q", "-b", "master"])
    if (gitignore !== null) {
      yield* write(`${repo}/.gitignore`, gitignore)
      yield* git(repo, ["add", "."])
    }
    yield* git(repo, ["commit", "-q", "--allow-empty", "-m", "init"])
    return repo
  })

/** A project with key `key` on `repo` (master its base), in a profile of its own. */
const projectOn = (repo: string, key = "X") =>
  Effect.gen(function* () {
    const profile = yield* (yield* Profiles).create({ name: `p-${key.toLowerCase()}` })
    return yield* (yield* Projects).create({ profile_id: profile.id, name: key.toLowerCase(), key, repo_path: repo, base_branch: "master" })
  }).pipe(Effect.orDie)

const newTask = (project: Project, title: string, more: Partial<NewTask> = {}) =>
  Effect.flatMap(Tasks, (tasks) => tasks.create({ project_id: project.id, title, ...more }, Actor.user)).pipe(Effect.orDie)
const setUp = (id: TaskId) => Effect.flatMap(Worktrees, (w) => w.setup(id))
const getTask = (id: TaskId) => Effect.flatMap(Tasks, (tasks) => tasks.get(id)).pipe(Effect.orDie)
const setColumns = (id: TaskId, columns: Partial<Task>) => Effect.flatMap(Tasks, (tasks) => tasks.change(id, () => columns, Actor.board)).pipe(Effect.orDie)
const done = (id: TaskId) => setColumns(id, { status: "done" })
const failure = <A, E extends { readonly _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.map(Effect.flip(effect), (e) => ("reason" in e && typeof e.reason === "string" ? e.reason : e._tag))
/** The texts of the task's thread notices. */
const notices = (id: TaskId) =>
  Effect.map(Effect.flatMap(Threads, (t) => t.stored(id)).pipe(Effect.orDie), (s) => s.entries.flatMap((e) => (e.item.type === "notice" ? [e.item.text] : [])))

/** A repository (on master, ignoring target/) with a task whose worktree has a commit. */
const taskWithWork = Effect.gen(function* () {
  const repo = yield* repoOnMaster("target/\n")
  const project = yield* projectOn(repo)
  const task = yield* setUp((yield* newTask(project, "Do it")).id)
  const wt = task.worktree_path ?? ""
  yield* write(`${wt}/a`, "a")
  yield* git(wt, ["add", "a"])
  yield* git(wt, ["commit", "-qm", "a"])
  return { repo, project, task, wt, branch: task.branch ?? "" }
})

/** Waits for task `id`'s worktree to be in `state`, as the board's events say: subscribe before starting what changes it. */
const nextState = Effect.fnUntraced(function* (id: TaskId, state: Task["worktree_state"]) {
  const watch = yield* (yield* Events).watch(undefined)
  return yield* watch.live.pipe(
    Stream.filter((e) => e.type === "task" && e.task.id === id && e.task.worktree_state === state),
    Stream.take(1),
    Stream.runDrain,
    Effect.forkScoped,
  )
})

/** A named pipe, and what opens it for writing: a script reading from it waits until then. */
const fifo = Effect.gen(function* () {
  const path = `${yield* tempDir}/fifo`
  yield* sh("mkfifo", [path])
  return { path, release: Effect.flatMap(FileSystem.FileSystem, (fs) => fs.writeFileString(path, "go\n")).pipe(Effect.orDie) }
})

const kept = (why: string): Removal => ({ _tag: "Kept", why })
const removed = (into: string): Removal => ({ _tag: "Removed", into })

describe("Worktrees", () => {
  it("names a worktree's folder after the task, or after the branch it had", () => {
    const project = { key: "WEB", former_keys: ["OLD"] }
    assert.strictEqual(folderName(project, { branch: null, title: "Fix the login!", number: 7 }), "7-fix-the-login")
    assert.strictEqual(folderName(project, { branch: null, title: "!!!", number: 7 }), "7")
    // A re-made worktree gets its folder back, whatever the task is called now or the project's key was.
    assert.strictEqual(folderName(project, { branch: "ia/old-3-first-name", title: "Renamed", number: 3 }), "3-first-name")
    assert.strictEqual(folderName(project, { branch: "ia/web-feature/x", title: "Y", number: 4 }), "4-y")
  })

  it.live("sets a worktree up on a branch of its own that tracks nothing, and says so", () =>
    run(
      Effect.gen(function* () {
        const repo = yield* repoOnMaster()
        const project = yield* projectOn(repo)
        const task = yield* setUp((yield* newTask(project, "Fix it")).id)
        assert.deepStrictEqual([task.worktree_state, task.branch, task.base_branch], ["ready", "ia/x-1-fix-it", "master"])
        assert.strictEqual(task.worktree_path, `${project.worktrees_root}/1-fix-it`)
        assert.strictEqual(yield* rev(task.worktree_path ?? "", "HEAD"), yield* rev(repo, "master"))
        assert.isFalse((yield* (yield* Git).run(task.worktree_path ?? "", ["rev-parse", "--abbrev-ref", "@{upstream}"])).ok)
        assert.include(yield* notices(task.id), `Worktree ready at ${task.worktree_path} on branch ia/x-1-fix-it (from master)`)
        // Set up already: nothing more.
        assert.deepStrictEqual(yield* setUp(task.id), task)
      }),
    ),
  )

  // HA-262: a worktree whose HEAD had commits on no branch was removed with them.
  it.live("keeps a worktree with commits on no branch unless forced", () =>
    run(
      Effect.gen(function* () {
        const w = yield* Worktrees
        const { repo, task, wt } = yield* taskWithWork
        yield* git(wt, ["checkout", "-q", "--detach"])
        yield* git(wt, ["commit", "-q", "--allow-empty", "-m", "on no branch"])
        const head = yield* rev(wt, "HEAD")
        assert.include(yield* failure(w.teardown(task.id, { force: false, deleteBranch: false })), "1 commit on no branch")
        assert.isTrue(yield* exists(wt))
        assert.strictEqual((yield* getTask(task.id)).worktree_state, "ready")
        assert.strictEqual(yield* rev(wt, "HEAD"), head)
        // Forced, it goes.
        yield* w.teardown(task.id, { force: true, deleteBranch: false })
        assert.isFalse(yield* exists(wt))
        assert.strictEqual((yield* getTask(task.id)).worktree_state, "none")
        assert.isTrue(yield* exists(repo))
      }),
    ),
  )

  it.live("refuses to tear down uncommitted work unless forced, and deletes the branch when asked", () =>
    run(
      Effect.gen(function* () {
        const w = yield* Worktrees
        const { repo, task, wt, branch } = yield* taskWithWork
        yield* write(`${wt}/draft`, "uncommitted")
        assert.include(yield* failure(w.teardown(task.id, { force: false, deleteBranch: false })), "worktree has uncommitted changes:\n?? draft")
        const gone = yield* w.teardown(task.id, { force: true, deleteBranch: true })
        assert.deepStrictEqual([gone.worktree_state, gone.worktree_path, gone.branch], ["none", null, null])
        assert.isFalse((yield* (yield* Git).run(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])).ok)
        const said = yield* notices(task.id)
        assert.include(said, `Deleted branch ${branch}`)
        assert.include(said, "Worktree removed")
      }),
    ),
  )

  // HA-262: teardown didn't take the task's lock, so a run's setup that started meanwhile took over the folder being
  // removed, and its agent was left working in a folder that was then removed.
  it.live("a setup during a teardown waits for it and sets the worktree up again", () =>
    run(
      Effect.gen(function* () {
        const w = yield* Worktrees
        const { project, task, wt, branch } = yield* taskWithWork
        const pipe = yield* fifo
        yield* (yield* Projects).update(project.id, { teardown_script: `cat ${pipe.path} > /dev/null` })
        const tearingDown = yield* nextState(task.id, "tearing_down")
        const removing = yield* Effect.forkScoped(w.teardown(task.id, { force: false, deleteBranch: false }))
        yield* Fiber.join(tearingDown)
        const settingUp = yield* Effect.forkScoped(w.setup(task.id))
        yield* pipe.release
        yield* Fiber.join(removing)
        const setUpAgain = yield* Fiber.join(settingUp)
        const now = yield* getTask(task.id)
        assert.deepStrictEqual([now.worktree_state, now.worktree_path, now.branch], ["ready", wt, branch])
        assert.strictEqual(setUpAgain.worktree_path, wt)
        assert.isTrue(yield* exists(`${wt}/a`), "set up again from its branch")
      }),
    ),
  )

  // HA-262: a task deleted while its worktree was being set up (before the worktree was saved) left the worktree and its
  // branch behind.
  it.live("a task deleted while its worktree is set up leaves neither behind", () =>
    run(
      Effect.gen(function* () {
        const repo = yield* repoOnMaster()
        const project = yield* projectOn(repo)
        const task = yield* newTask(project, "Do it")
        // `git worktree add` takes a while.
        const pipe = yield* fifo
        yield* write(`${repo}/.git/hooks/post-checkout`, `#!/bin/sh\ncat ${pipe.path} > /dev/null\n`)
        yield* sh("chmod", ["+x", `${repo}/.git/hooks/post-checkout`])
        const settingUp = yield* nextState(task.id, "setting_up")
        const setup = yield* Effect.forkScoped(Effect.result(setUp(task.id)))
        yield* Fiber.join(settingUp)
        const deleting = yield* Effect.forkScoped((yield* TaskDeletion).delete(task.id, { deleteBranch: true }, Actor.user))
        yield* pipe.release
        yield* Fiber.join(setup)
        yield* Fiber.join(deleting)
        assert.isTrue(Option.isNone(yield* Effect.option((yield* Tasks).get(task.id))))
        const worktrees = (yield* git(repo, ["worktree", "list", "--porcelain"])).split("\n").filter((l) => l.startsWith("worktree "))
        assert.deepStrictEqual(worktrees, [`worktree ${yield* git(repo, ["rev-parse", "--show-toplevel"])}`])
        assert.strictEqual(yield* git(repo, ["branch", "--list", "ia/*"]), "")
      }),
    ),
  )

  it.live("removes a done task's worktree once merged and clean, and sets it up again in the same folder", () =>
    run(
      Effect.gen(function* () {
        const w = yield* Worktrees
        const { repo, project, task, wt, branch } = yield* taskWithWork
        const remove = w.removeIfMerged(task.id, true)
        assert.deepStrictEqual(yield* remove, kept("it isn't done"))
        yield* done(task.id)
        assert.deepStrictEqual(yield* remove, kept("its work isn't merged into master"))
        yield* git(repo, ["merge", "-q", "--no-ff", "-m", "merge", branch])
        // Untracked files would be lost, even when git status is set not to show them; ignored ones wouldn't matter.
        yield* git(repo, ["config", "status.showUntrackedFiles", "no"])
        yield* write(`${wt}/notes`, "n")
        assert.deepStrictEqual(yield* remove, kept("it has 1 uncommitted or untracked file"))
        yield* sh("rm", [`${wt}/notes`])
        yield* write(`${wt}/target/out`, "o")
        assert.deepStrictEqual(yield* remove, removed("master"))
        assert.isFalse(yield* exists(wt))
        let t = yield* getTask(task.id)
        assert.deepStrictEqual([t.status, t.worktree_state, t.branch], ["done", "none", branch])
        assert.deepStrictEqual(yield* remove, kept("it has no worktree"))

        // Run again (after a rename), it gets its folder back, on its branch.
        yield* setColumns(task.id, { title: "Renamed", status: "in_progress" })
        t = yield* setUp(task.id)
        assert.strictEqual(t.worktree_path, wt)
        assert.strictEqual(yield* (yield* Git).currentBranch(wt), branch)

        // The project's sweep removes it once it's done again, and leaves other tasks alone.
        const other = yield* setUp((yield* newTask(project, "Other")).id)
        assert.deepStrictEqual(yield* w.removeMerged(project.id), [])
        yield* done(task.id)
        const results = yield* w.removeMerged(project.id)
        assert.deepStrictEqual(
          results.map((r) => [r.task_id, r.removed, r.detail]),
          [[task.id, true, "merged into master"]],
        )
        assert.isFalse(yield* exists(wt))
        assert.isTrue(yield* exists(other.worktree_path ?? ""))
      }),
    ),
  )

  it.live("a branch merged upstream counts as merged", () =>
    run(
      Effect.gen(function* () {
        const w = yield* Worktrees
        const root = yield* tempDir
        yield* git(root, ["init", "-q", "--bare", "-b", "master", `${root}/origin`])
        yield* git(root, ["clone", "-q", `${root}/origin`, `${root}/repo`])
        const repo = `${root}/repo`
        yield* git(repo, ["commit", "-q", "--allow-empty", "-m", "init"])
        yield* git(repo, ["push", "-q", "-u", "origin", "master"])
        const project = yield* projectOn(repo)
        const task = yield* setUp((yield* newTask(project, "Do it")).id)
        const wt = task.worktree_path ?? ""
        const branch = task.branch ?? ""
        yield* git(wt, ["commit", "-q", "--allow-empty", "-m", "work"])
        yield* git(wt, ["push", "-q", "origin", branch])
        yield* done(task.id)
        assert.deepStrictEqual(yield* w.removeIfMerged(task.id, true), kept("its work isn't merged into master"))
        // Merged elsewhere (as a pull request is), so the local master is behind.
        yield* git(root, ["clone", "-q", `${root}/origin`, `${root}/other`])
        yield* git(`${root}/other`, ["merge", "-q", "--no-ff", "-m", "merge", `origin/${branch}`])
        yield* git(`${root}/other`, ["push", "-q", "origin", "master"])
        // The sweep fetches it.
        const [result] = yield* w.removeMerged(project.id)
        assert.deepStrictEqual([result?.removed, result?.detail], [true, "merged into origin/master"])
        assert.isFalse(yield* exists(wt))
      }),
    ),
  )

  // HA-32: setup took over any folder at the worktree's path, and a forced teardown removed whatever was there when git
  // wouldn't, so a shared or misconfigured worktrees folder could cost work kept elsewhere.
  it.live("a folder in the worktree's way is neither adopted nor removed", () =>
    run(
      Effect.gen(function* () {
        const g = yield* Git
        const repo = yield* repoOnMaster()
        const project = yield* projectOn(repo)
        const task = yield* newTask(project, "fix it")
        // Someone's folder where the task's worktree would go.
        const wt = `${project.worktrees_root}/${folderName(project, task)}`
        yield* write(`${wt}/precious`, "mine")
        assert.include(yield* failure(setUp(task.id)), "in the way")
        assert.strictEqual(yield* read(`${wt}/precious`), "mine")
        const t = yield* getTask(task.id)
        assert.deepStrictEqual([t.worktree_state, t.worktree_path], ["error", null], "the failure is the task's to show, the folder nobody's")
        assert.include(yield* notices(task.id), "Worktree setup failed")

        // Only a folder inside the worktrees folder, other than a main checkout, is removed by hand.
        assert.isTrue(yield* removableByHand(g, project, repo, wt), "a stray folder in the worktrees folder")
        assert.isFalse(yield* removableByHand(g, project, repo, repo), "the repository")
        assert.isFalse(yield* removableByHand(g, project, repo, repo.slice(0, repo.lastIndexOf("/"))), "outside the worktrees folder")
        assert.isFalse(yield* removableByHand(g, project, repo, project.worktrees_root), "the worktrees folder itself")
        const checkout = `${project.worktrees_root}/checkout`
        yield* git(repo, ["clone", "-q", repo, checkout])
        assert.isFalse(yield* removableByHand(g, project, repo, checkout), "another main checkout")
      }),
    ),
  )

  // HA-341: two projects on one repository whose worktrees share a folder made the same folder for tasks with the same
  // number and title, and the second task's setup took over the first's worktree.
  it.live("a worktree of another project's task isn't taken over", () =>
    run(
      Effect.gen(function* () {
        const repo = yield* repoOnMaster()
        const a = yield* projectOn(repo, "X")
        const b = yield* (yield* Projects).create({ profile_id: a.profile_id, name: "y", key: "Y", repo_path: repo, base_branch: "master" })
        yield* (yield* Projects).update(b.id, { worktrees_root: a.worktrees_root })
        const ta = yield* setUp((yield* newTask(a, "Fix it")).id)
        yield* write(`${ta.worktree_path}/work`, "uncommitted")
        const tb = yield* newTask(b, "Fix it")
        assert.include(yield* failure(setUp(tb.id)), "in the way")
        assert.strictEqual((yield* getTask(tb.id)).worktree_path, null)
        assert.strictEqual(yield* read(`${ta.worktree_path}/work`), "uncommitted")
        // Its own worktree from a setup cut short is still taken up again.
        yield* setColumns(ta.id, { worktree_state: "setting_up" })
        assert.strictEqual((yield* setUp(ta.id)).worktree_path, ta.worktree_path)
      }),
    ),
  )

  // HA-341: a new task whose branch name was taken by another task's branch checked out that branch, with its commits.
  it.live("a branch left by another task isn't taken over", () =>
    run(
      Effect.gen(function* () {
        const repo = yield* repoOnMaster()
        yield* git(repo, ["branch", "ia/x-1-fix-it"])
        yield* git(repo, ["commit", "-q", "--allow-empty", "-m", "theirs"])
        yield* git(repo, ["branch", "-f", "ia/x-1-fix-it", "HEAD"])
        yield* git(repo, ["reset", "-q", "--hard", "HEAD~1"])
        const theirs = yield* rev(repo, "ia/x-1-fix-it")
        const project = yield* projectOn(repo)
        const t = yield* setUp((yield* newTask(project, "Fix it")).id)
        assert.strictEqual(t.branch, "ia/x-1-fix-it-2")
        assert.isTrue((t.worktree_path ?? "").endsWith("1-fix-it-2"))
        assert.strictEqual(yield* rev(repo, "ia/x-1-fix-it"), theirs)
        // Set up again, it keeps its own.
        yield* setColumns(t.id, { worktree_state: "setting_up" })
        assert.strictEqual((yield* setUp(t.id)).branch, "ia/x-1-fix-it-2")
      }),
    ),
  )

  // HA-341: deleting a project read its tasks' worktrees before a setup under way had made one, which was then left
  // behind with no project to show it.
  it.live("deleting a project waits for a worktree being set up", () =>
    run(
      Effect.gen(function* () {
        const w = yield* Worktrees
        const repo = yield* repoOnMaster()
        const project = yield* projectOn(repo)
        const task = yield* newTask(project, "Fix it")
        const pipe = yield* fifo
        yield* write(`${repo}/.git/hooks/post-checkout`, `#!/bin/sh\ncat ${pipe.path} > /dev/null\n`)
        yield* sh("chmod", ["+x", `${repo}/.git/hooks/post-checkout`])
        const settingUp = yield* nextState(task.id, "setting_up")
        const setup = yield* Effect.forkScoped(Effect.result(setUp(task.id)))
        yield* Fiber.join(settingUp)
        const deleting = yield* Effect.forkScoped(w.deleteProject(project.id))
        yield* pipe.release
        yield* Fiber.join(setup)
        yield* Fiber.join(deleting)
        assert.isFalse(yield* exists(`${project.worktrees_root}/1-fix-it`), "its worktree was left behind")
        // Its branch is kept: no committed work is lost.
        assert.strictEqual(yield* git(repo, ["branch", "--list", "--format=%(refname:short)", "ia/*"]), "ia/x-1-fix-it")
      }),
    ),
  )

  it.live("deleting a profile removes its projects' worktrees first, keeping their branches", () =>
    run(
      Effect.gen(function* () {
        const w = yield* Worktrees
        const { repo, project, task, wt, branch } = yield* taskWithWork
        yield* write(`${wt}/draft`, "uncommitted")
        yield* w.deleteProfile(project.profile_id)
        assert.isFalse(yield* exists(wt))
        assert.isTrue(Option.isNone(yield* Effect.option((yield* Tasks).get(task.id))))
        assert.strictEqual(yield* git(repo, ["branch", "--list", "--format=%(refname:short)", "ia/*"]), branch)
        assert.deepStrictEqual((yield* git(repo, ["worktree", "list", "--porcelain"])).split("\n").filter((l) => l.startsWith("worktree ")).length, 1)
      }),
    ),
  )

  it.live("keeps what the teardown script leaves", () =>
    run(
      Effect.gen(function* () {
        const w = yield* Worktrees
        const { repo, project, task, wt, branch } = yield* taskWithWork
        yield* git(repo, ["merge", "-q", "--no-ff", "-m", "merge", branch])
        yield* done(task.id)
        yield* (yield* Projects).update(project.id, { teardown_script: "printf backup > notes" })
        assert.include(yield* failure(w.removeIfMerged(task.id, true)), "notes")
        assert.strictEqual(yield* read(`${wt}/notes`), "backup")
        assert.strictEqual((yield* getTask(task.id)).worktree_state, "ready")
        // The sweep says why.
        yield* sh("rm", [`${wt}/notes`])
        const [result] = yield* w.removeMerged(project.id)
        assert.isFalse(result?.removed)
        assert.include(result?.detail, "teardown script left uncommitted changes")
      }),
    ),
  )

  it.live("keeps it while a reviewer works in it", () =>
    run(
      Effect.gen(function* () {
        const w = yield* Worktrees
        const sql = yield* SqlClient.SqlClient
        const { repo, project, task, wt, branch } = yield* taskWithWork
        yield* git(repo, ["merge", "-q", "--no-ff", "-m", "merge", branch])
        const reviewer = yield* newTask(project, "Review", { use_worktree: false })
        yield* sql`UPDATE tasks SET kind = 'review', parent_id = ${task.id}, running = 1 WHERE id = ${reviewer.id}`.pipe(Effect.orDie)
        yield* done(task.id)
        assert.isTrue(yield* w.agentInWorktree(task.id))
        assert.deepStrictEqual(yield* w.removeIfMerged(task.id, true), kept("an agent is working in it"))
        assert.isTrue(yield* exists(wt))
        // Nor is it set up or torn down by hand meanwhile.
        assert.strictEqual(
          yield* Effect.map(Effect.flip(w.teardown(task.id, { idle: true, force: true, deleteBranch: false })), (e) => e._tag),
          "AgentInWorktree",
        )
        yield* sql`UPDATE tasks SET running = 0 WHERE id = ${reviewer.id}`.pipe(Effect.orDie)
        assert.deepStrictEqual(yield* w.removeIfMerged(task.id, true), removed("master"))
      }),
    ),
  )

  it.live("keeps changes git status is told to skip", () =>
    run(
      Effect.gen(function* () {
        const w = yield* Worktrees
        const g = yield* Git
        const fs = yield* FileSystem.FileSystem
        const { repo, project, task, wt, branch } = yield* taskWithWork
        yield* git(repo, ["merge", "-q", "--no-ff", "-m", "merge", branch])
        yield* done(task.id)
        const remove = w.removeIfMerged(task.id, true)
        // Marked but unchanged, it's clean.
        yield* git(wt, ["update-index", "--assume-unchanged", "a"])
        yield* git(wt, ["update-index", "--skip-worktree", ".gitignore"])
        assert.strictEqual(yield* uncommitted(g, fs, wt), "")
        for (const [file, mark] of [
          ["a", "assume-unchanged"],
          [".gitignore", "skip-worktree"],
        ] as const) {
          yield* write(`${wt}/${file}`, "local edit")
          assert.include(yield* uncommitted(g, fs, wt), `${file} (marked ${mark})`)
          assert.deepStrictEqual(yield* remove, kept("it has 1 uncommitted or untracked file"))
          assert.strictEqual(yield* read(`${wt}/${file}`), "local edit")
          yield* git(wt, ["update-index", `--no-${mark}`, file])
          yield* git(wt, ["checkout", "--", file])
        }
        // The sweep keeps it too.
        yield* git(wt, ["update-index", "--assume-unchanged", "a"])
        yield* write(`${wt}/a`, "local edit")
        const [result] = yield* w.removeMerged(project.id)
        assert.deepStrictEqual([result?.removed, result?.detail], [false, "it has 1 uncommitted or untracked file"])
        // A skip-worktree file that isn't there (as in a sparse checkout) has nothing to lose.
        yield* git(wt, ["update-index", "--no-assume-unchanged", "a"])
        yield* git(wt, ["checkout", "--", "a"])
        yield* git(wt, ["update-index", "--skip-worktree", "a"])
        yield* sh("rm", [`${wt}/a`])
        assert.deepStrictEqual(yield* remove, removed("master"))
      }),
    ),
  )

  it.live("keeps a marked file whose executable bit changed, by hand or by the teardown script", () =>
    run(
      Effect.gen(function* () {
        const w = yield* Worktrees
        const g = yield* Git
        const fs = yield* FileSystem.FileSystem
        const { repo, project, task, wt, branch } = yield* taskWithWork
        yield* git(repo, ["merge", "-q", "--no-ff", "-m", "merge", branch])
        yield* done(task.id)
        const sweep = Effect.map(w.removeMerged(project.id), ([r]) => [r?.removed, r?.detail])
        yield* git(wt, ["update-index", "--assume-unchanged", "a"])
        yield* sh("chmod", ["755", `${wt}/a`])
        assert.deepStrictEqual(yield* sweep, [false, "it has 1 uncommitted or untracked file"])
        yield* sh("chmod", ["644", `${wt}/a`])
        assert.strictEqual(yield* uncommitted(g, fs, wt), "")
        // ...by the teardown script.
        yield* (yield* Projects).update(project.id, { teardown_script: "chmod +x a" })
        assert.include(yield* failure(w.removeIfMerged(task.id, true)), "a (marked assume-unchanged)")
        assert.strictEqual((yield* getTask(task.id)).worktree_state, "ready")
      }),
    ),
  )

  it.live("repairs a worktree left half set up or half removed by a server that stopped", () =>
    run(
      Effect.gen(function* () {
        const w = yield* Worktrees
        const { project, task, wt } = yield* taskWithWork
        const other = yield* newTask(project, "Other")
        const gone = yield* newTask(project, "Gone")
        yield* setColumns(task.id, { worktree_state: "tearing_down" })
        yield* setColumns(other.id, { worktree_state: "setting_up" })
        yield* setColumns(gone.id, { worktree_state: "tearing_down", worktree_path: `${wt}-gone` })
        yield* w.recover
        assert.strictEqual((yield* getTask(task.id)).worktree_state, "ready")
        assert.deepStrictEqual(
          [(yield* getTask(other.id)).worktree_state, (yield* getTask(other.id)).worktree_error],
          ["error", "the server stopped while the worktree was being set up"],
        )
        assert.deepStrictEqual([(yield* getTask(gone.id)).worktree_state, (yield* getTask(gone.id)).worktree_path], ["none", null])
      }),
    ),
  )
})

/** Send `text` to the task and wait for its launch to end (this test board has no ia-shim: it writes the run's folder, then gives up). */
const launch = (id: TaskId, text: string) =>
  Effect.gen(function* () {
    const runs = yield* Runs
    yield* runs.send(id, { text, source: "user" }).pipe(Effect.orDie)
    yield* runs.launched(id)
    const latest = yield* (yield* RunRepo).latest(id)
    return Option.isSome(latest) ? yield* (yield* RunDir).spec(latest.value.id) : null
  })

describe("a run's launch", () => {
  it.live("sets the task's worktree up first, and its agent works there", () =>
    run(
      Effect.gen(function* () {
        const repo = yield* repoOnMaster()
        const project = yield* projectOn(repo)
        const task = yield* newTask(project, "Fix it")
        assert.isTrue(task.use_worktree)
        const spec = yield* launch(task.id, "hello")
        const t = yield* getTask(task.id)
        assert.deepStrictEqual([t.worktree_state, t.branch], ["ready", "ia/x-1-fix-it"])
        assert.strictEqual(spec?.cwd, t.worktree_path)
        assert.include(yield* notices(task.id), "Setting up worktree…")
      }),
    ),
  )

  // HE-8: a task's own work_dir is where it works (the old documents.work_dir): an imported task's, in the old data
  // folder, so its session is found where it ran.
  it.live("a task with a work folder of its own works there, not in a worktree", () =>
    run(
      Effect.gen(function* () {
        const repo = yield* repoOnMaster()
        const project = yield* projectOn(repo)
        const task = yield* newTask(project, "Notes")
        const own = `${repo}-old-board/documents/${task.id}`
        const sql = yield* SqlClient.SqlClient
        yield* sql`UPDATE tasks SET work_dir = ${own}, use_worktree = 0 WHERE id = ${task.id}`
        const spec = yield* launch(task.id, "hello")
        assert.strictEqual(spec?.cwd, own)
        assert.strictEqual((yield* getTask(task.id)).worktree_state, "none")
      }),
    ),
  )

  it.live("a setup that fails fails the launch", () =>
    run(
      Effect.gen(function* () {
        const repo = yield* repoOnMaster()
        const project = yield* projectOn(repo)
        const task = yield* newTask(project, "Fix it")
        yield* write(`${project.worktrees_root}/1-fix-it/precious`, "mine")
        assert.strictEqual(yield* launch(task.id, "hello"), null, "the agent wasn't started")
        assert.strictEqual((yield* getTask(task.id)).worktree_state, "error")
        assert.include(yield* notices(task.id), "Worktree setup failed")
      }),
    ),
  )

  it.live("a review thread works in its task's worktree, and doesn't start before that's set up", () =>
    run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const repo = yield* repoOnMaster()
        const project = yield* projectOn(repo)
        const task = yield* newTask(project, "Fix it")
        const reviewer = yield* newTask(project, "Review", { use_worktree: false })
        yield* sql`UPDATE tasks SET kind = 'review', parent_id = ${task.id} WHERE id = ${reviewer.id}`.pipe(Effect.orDie)
        assert.strictEqual(yield* launch(reviewer.id, "review it"), null, "the task's worktree isn't set up")
        const set = yield* setUp(task.id)
        assert.strictEqual((yield* launch(reviewer.id, "review it"))?.cwd, set.worktree_path)
      }),
    ),
  )
})
