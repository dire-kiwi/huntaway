import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Ref } from "effect"
import type { Scope } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { git, tempDir, TestBoard } from "@huntaway/testing"
import type { NewTask, Project, Task, TaskId, TaskPatch } from "@huntaway/contracts"
import { Reactor } from "../lifecycle/Reactor.ts"
import { Restack } from "./Restack.ts"
import { Actor } from "../platform/Changes.ts"
import { Profiles } from "../profiles/Profiles.ts"
import { Projects } from "../projects/Projects.ts"
import { TaskDeletion } from "../runs/TaskDeletion.ts"
import { Tasks } from "../tasks/Tasks.ts"
import { Threads } from "../threads/Threads.ts"
import { Git } from "./Git.ts"
import { GitHubAccess, GitHubUnavailable, noGitHubStacks } from "./GitHubAccess.ts"
import type { GitHubAccessShape, PullRequestView } from "./GitHubAccess.ts"
import { startRef, TaskBase } from "./TaskBase.ts"
import type { TaskBaseOptions } from "./TaskBase.ts"
import { Worktrees } from "./Worktrees.ts"
import { isGithubCom, remoteRepo } from "./worktree/remote.ts"

// huntaway's git/worktree/tests.test.ts: where a branch starts (the latest base, `start_from`'s four kinds, stacked
// tasks), what a task's own work is (diffs, start refs, `hasWorkToMerge`) and the GitHub remote its pull request goes to.
// The setup and removal cases are Worktrees.test.ts's; the restack and GitHub-stack cases are 4.8's.

process.env["GIT_CONFIG_GLOBAL"] = "/dev/null"
process.env["GIT_CONFIG_NOSYSTEM"] = "1"

type Env = Worktrees | TaskBase | Tasks | Projects | Profiles | Threads | Git | Reactor | TaskDeletion | Restack
type Needs = Env | FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner | Scope.Scope

/** The whole board, with the git area's own `TaskBase` and `Worktrees` built over a fake GitHub, and `options`. */
const boardWith = (github: GitHubAccessShape | null, options: TaskBaseOptions = {}) =>
  Layer.fresh(Worktrees.layer).pipe(
    Layer.provideMerge(Layer.fresh(TaskBase.layerWith({ sshConfig: "/dev/null", ...options }))),
    Layer.provideMerge(github === null ? GitHubAccess.layerNone : Layer.succeed(GitHubAccess, GitHubAccess.of(github))),
    Layer.provideMerge(TestBoard()),
  )
const run = <A, E>(effect: Effect.Effect<A, E, Needs>, github: GitHubAccessShape | null = null, options: TaskBaseOptions = {}) =>
  effect.pipe(Effect.scoped, Effect.provide(boardWith(github, options)))

const rev = (dir: string, r: string) => git(dir, ["rev-parse", r])
const write = (path: string, text: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    yield* fs.makeDirectory(path.slice(0, path.lastIndexOf("/")), { recursive: true })
    yield* fs.writeFileString(path, text)
  }).pipe(Effect.orDie)
const sh = (command: string, args: ReadonlyArray<string>) =>
  Effect.flatMap(ChildProcessSpawner.ChildProcessSpawner, (spawner) => spawner.string(ChildProcess.make(command, args))).pipe(Effect.orDie)
let counter = 0
/** Commit a new file `name` in `dir`, returning the commit. */
const commitFile = (dir: string, name: string) =>
  Effect.gen(function* () {
    counter++
    yield* write(`${dir}/${name}`, `${name} ${counter}`)
    yield* git(dir, ["add", name])
    yield* git(dir, ["commit", "-qm", name])
    return yield* rev(dir, "HEAD")
  })

const projectOn = (repo: string) =>
  Effect.gen(function* () {
    const profile = yield* (yield* Profiles).create({ name: "p" })
    return yield* (yield* Projects).create({ profile_id: profile.id, name: "x", key: "X", repo_path: repo, base_branch: "master" })
  }).pipe(Effect.orDie)
const make = (project: Project, title: string, more: Partial<NewTask> = {}) =>
  Effect.flatMap(Tasks, (tasks) => tasks.create({ project_id: project.id, title, ...more }, Actor.user)).pipe(Effect.orDie)
const setUp = (id: TaskId) => Effect.flatMap(Worktrees, (w) => w.setup(id))
const getTask = (id: TaskId) => Effect.flatMap(Tasks, (tasks) => tasks.get(id)).pipe(Effect.orDie)
const patchTask = (id: TaskId, patch: TaskPatch) => Effect.flatMap(Tasks, (tasks) => tasks.update(id, patch, Actor.user))
/** Moves a task to Done and waits for the reactor, which keeps the starts of the tasks stacked on it (`keepStarts`) before
 * anything deletes its branch, as a move to Done is followed by the reactor on the board. */
const done = (id: TaskId) =>
  Effect.flatMap(Tasks, (tasks) => tasks.change(id, () => ({ status: "done" }), Actor.board)).pipe(
    Effect.orDie,
    Effect.andThen(Effect.flatMap(Reactor, (r) => r.idle)),
  )
const failure = <A, E extends { readonly _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.map(Effect.flip(effect), (e) => ("reason" in e && typeof e.reason === "string" ? e.reason : e._tag))
const log = (id: TaskId) =>
  Effect.map(Effect.flatMap(Threads, (t) => t.stored(id)).pipe(Effect.orDie), (s) =>
    s.entries.flatMap((e) => (e.item.type === "notice" ? [e.item.text] : [])).join("\n"),
  )
const diff = (id: TaskId) => Effect.flatMap(TaskBase, (b) => b.diff(id)).pipe(Effect.orDie)
/** The files a task's Changes tab shows. */
const changedFiles = (id: TaskId) =>
  Effect.map(diff(id), (d) =>
    (d.patch ?? "")
      .split("\n")
      .filter((l) => l.startsWith("+++ b/"))
      .map((l) => l.slice("+++ b/".length)),
  )
const hasWork = (task: Task) => Effect.flatMap(TaskBase, (b) => b.hasWorkToMerge(task))

/** A repository (on master, ignoring target/) with a task whose worktree has a commit. */
const taskWithWork = Effect.gen(function* () {
  const repo = `${yield* tempDir}/repo`
  yield* sh("mkdir", ["-p", repo])
  yield* git(repo, ["init", "-q", "-b", "master"])
  yield* write(`${repo}/.gitignore`, "target/\n")
  yield* git(repo, ["add", "."])
  yield* git(repo, ["commit", "-qm", "init"])
  const project = yield* projectOn(repo)
  const task = yield* setUp((yield* make(project, "Do it")).id)
  const wt = task.worktree_path ?? ""
  yield* commitFile(wt, "a")
  return { repo, project, task: yield* getTask(task.id), wt, branch: task.branch ?? "" }
})

/** A repository cloned from a bare `origin`, master pushed, another clone to push from as someone else would, a project on it. */
const stackingRepo = Effect.gen(function* () {
  const root = yield* tempDir
  const repo = `${root}/repo`
  const other = `${root}/other`
  yield* git(root, ["init", "-q", "--bare", "-b", "master", `${root}/origin`])
  yield* git(root, ["clone", "-q", `${root}/origin`, repo])
  yield* commitFile(repo, "notes")
  yield* git(repo, ["push", "-q", "-u", "origin", "master"])
  yield* git(root, ["clone", "-q", `${root}/origin`, other])
  return { root, repo, other, project: yield* projectOn(repo) }
})

/** `OWNER/REPO` from a remote URL on github.com. */
const githubRepo = (url: string) => {
  const r = remoteRepo(url)
  return r !== null && isGithubCom(r[0]) ? r[1] : null
}

describe("remotes", () => {
  it("reads GitHub remotes", () => {
    for (const url of [
      "git@github.com:o/r.git",
      "github.com:o/r",
      "https://github.com/o/r",
      "https://github.com/o/r.git/",
      "https://x:token@github.com/o/r.git",
      "ssh://git@ssh.github.com:443/o/r.git",
      "git://GitHub.com/o/r",
    ]) {
      assert.strictEqual(githubRepo(url), "o/r", url)
    }
    for (const url of [
      "git@gitlab.com:o/r.git",
      "https://example.com/github.com/o/r",
      "/srv/git/o/r.git",
      "./github.com:o/r",
      "https://github.com/o",
      "https://github.com/o/r/pull/1",
    ]) {
      assert.strictEqual(githubRepo(url), null, url)
    }
  })

  it.live("finds the GitHub remote pull requests go to", () =>
    run(
      Effect.gen(function* () {
        const base = yield* TaskBase
        const repo = yield* tempDir
        yield* git(repo, ["init", "-q", "-b", "master"])
        assert.strictEqual(yield* base.github(repo, "master"), null)
        yield* git(repo, ["remote", "add", "history", "git@github.com:o/history.git"])
        assert.deepStrictEqual(yield* base.github(repo, "master"), { remote: "history", repo: "o/history" })
        yield* git(repo, ["remote", "add", "origin", "https://github.com/o/r.git"])
        assert.deepStrictEqual(yield* base.github(repo, "master"), { remote: "origin", repo: "o/r" })
        assert.deepStrictEqual(yield* base.github(repo, null), { remote: "origin", repo: "o/r" })
        // The base branch's upstream comes first.
        yield* git(repo, ["config", "branch.master.remote", "history"])
        assert.strictEqual((yield* base.github(repo, "master"))?.remote, "history")
        yield* git(repo, ["remote", "set-url", "history", "git@gitlab.com:o/history.git"])
        assert.strictEqual(yield* base.github(repo, "master"), null)
        // It's where the branch is pushed that counts, not where it's fetched from.
        yield* git(repo, ["remote", "set-url", "--push", "history", "git@github.com:o/mirror.git"])
        assert.strictEqual((yield* base.github(repo, "master"))?.repo, "o/mirror")
        yield* git(repo, ["remote", "set-url", "--push", "origin", "git@gitlab.com:o/r.git"])
        assert.strictEqual(yield* base.github(repo, null), null)
      }),
    ),
  )

  it.live("an SSH host alias is the host it stands for", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir
      const config = `${dir}/ssh_config`
      yield* write(config, "Host github-work\n  HostName github.com\n  IdentityFile ~/.ssh/work\nHost ghe\n  HostName GHE.acme.com\n")
      return yield* run(
        Effect.gen(function* () {
          const base = yield* TaskBase
          const repo = `${dir}/repo`
          yield* sh("mkdir", ["-p", repo])
          yield* git(repo, ["init", "-q", "-b", "master"])
          yield* git(repo, ["remote", "add", "origin", "git@github-work:o/r.git"])
          assert.deepStrictEqual(yield* base.pushRepo(repo, null), ["github.com", "o/r"])
          assert.strictEqual((yield* base.github(repo, null))?.repo, "o/r")
          yield* git(repo, ["remote", "set-url", "origin", "ssh://git@ghe/o/r.git"])
          assert.deepStrictEqual(yield* base.pushRepo(repo, null), ["ghe.acme.com", "o/r"])
          assert.strictEqual(yield* base.github(repo, null), null)
          // Only SSH remotes' hosts are aliases.
          yield* git(repo, ["remote", "set-url", "origin", "https://github-work/o/r.git"])
          assert.deepStrictEqual(yield* base.pushRepo(repo, null), ["github-work", "o/r"])
          // A host the config doesn't name is as it is.
          yield* git(repo, ["remote", "set-url", "origin", "git@gitlab.com:o/r.git"])
          assert.deepStrictEqual(yield* base.pushRepo(repo, null), ["gitlab.com", "o/r"])
        }),
        null,
        { sshConfig: config },
      )
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )
})

describe("a task's diff", () => {
  // HA-42: untracked files were listed without -z, so a name git quotes or one starting with `-` dropped out.
  it.live("has every untracked file, whatever its name", () =>
    run(
      Effect.gen(function* () {
        const { task, wt } = yield* taskWithWork
        for (const name of ["café.txt", "-n.txt", "plain.txt"]) yield* write(`${wt}/${name}`, `in ${name}\n`)
        const d = yield* diff(task.id)
        assert.deepStrictEqual([...(d.untracked ?? [])].toSorted(), ["-n.txt", "café.txt", "plain.txt"])
        for (const name of ["café.txt", "-n.txt", "plain.txt"]) assert.include(d.patch, `+in ${name}\n`)
      }),
    ),
  )

  // HA-51: a task whose worktree was removed showed the project folder's changes as its own.
  it.live("without its worktree, is its branch's", () =>
    run(
      Effect.gen(function* () {
        const { repo, task, branch } = yield* taskWithWork
        yield* write(`${repo}/main-only`, "not the task's\n")
        yield* (yield* Worktrees).teardown(task.id, { force: false, deleteBranch: false })
        let d = yield* diff(task.id)
        assert.deepStrictEqual([d.available, d.branch], [true, branch])
        assert.include(d.patch, "+++ b/a")
        assert.notInclude(d.patch, "main-only")
        assert.include(d.commits, " a\n")
        assert.deepStrictEqual(d.untracked, [])
        yield* git(repo, ["branch", "-D", branch])
        d = yield* diff(task.id)
        assert.isFalse(d.available)
        assert.include(d.reason, "is gone")
      }),
    ),
  )

  // HA-92: a worktree removed while its diff was being read failed the request with git's "cannot change to" the folder.
  it.live("of a worktree removed meanwhile, is its branch's", () =>
    run(
      Effect.gen(function* () {
        const { repo, task, wt, branch } = yield* taskWithWork
        yield* git(repo, ["worktree", "remove", "--force", wt])
        const d = yield* diff(task.id)
        assert.deepStrictEqual([d.available, d.branch], [true, branch])
        assert.include(d.patch, "+++ b/a")
      }),
    ),
  )

  // HA-90: the same, with the folder going after the diff checked for it, while git runs in it.
  it.live("of a worktree removed while git reads it, is its branch's", () => {
    const moved = { from: "", to: "" }
    const onDiffRead = Effect.suspend(() => (moved.from === "" ? Effect.void : sh("mv", [moved.from, moved.to]))).pipe(Effect.provide(NodeServices.layer))
    return run(
      Effect.gen(function* () {
        const { task, wt, branch } = yield* taskWithWork
        yield* write(`${wt}/draft`, "uncommitted\n")
        moved.from = wt
        moved.to = `${wt}.gone`
        let d = yield* diff(task.id)
        assert.deepStrictEqual([d.available, d.branch], [true, branch])
        assert.include(d.patch, "+++ b/a")
        // Back in place, it's the worktree's again, uncommitted work and all.
        yield* sh("mv", [`${wt}.gone`, wt])
        d = yield* diff(task.id)
        assert.deepStrictEqual([d.branch, d.untracked], [undefined, ["draft"]])
      }),
      null,
      { onDiffRead },
    )
  })

  // HA-262: with status.showUntrackedFiles=no the agent's new files didn't count, and Ready for merge marked the task
  // done with them unmerged.
  it.live("counts new files as work to merge, whatever git status is told to show", () =>
    run(
      Effect.gen(function* () {
        const repo = yield* tempDir
        yield* git(repo, ["init", "-q", "-b", "master"])
        yield* git(repo, ["commit", "-q", "--allow-empty", "-m", "init"])
        yield* git(repo, ["config", "status.showUntrackedFiles", "no"])
        const project = yield* projectOn(repo)
        const t = yield* setUp((yield* make(project, "Do it")).id)
        assert.isFalse(yield* hasWork(t))
        yield* write(`${t.worktree_path}/notes`, "1")
        assert.isTrue(yield* hasWork(t))
        yield* git(t.worktree_path ?? "", ["add", "notes"])
        yield* git(t.worktree_path ?? "", ["commit", "-qm", "notes"])
        assert.isTrue(yield* hasWork(t))
        yield* git(repo, ["merge", "-q", "--no-ff", "-m", "merge", t.branch ?? ""])
        assert.isFalse(yield* hasWork(t))
      }),
    ),
  )
})

describe("where a branch starts", () => {
  it.live(
    "from the latest base",
    () =>
      run(
        Effect.gen(function* () {
          const base = yield* TaskBase
          const { repo, other, project } = yield* stackingRepo
          // Someone else pushes to master.
          const push = (file: string) =>
            Effect.andThen(commitFile(other, file), Effect.andThen(git(other, ["push", "-q", "origin", "HEAD"]), rev(other, "HEAD")))
          // A task's worktree: the task, the commit it starts from, whether its branch tracks anything, and its log. It has
          // nothing of its own to show or merge.
          const task = (title: string, baseBranch: string | null) =>
            Effect.gen(function* () {
              const made = yield* make(project, title)
              if (baseBranch !== null) yield* patchTask(made.id, { base_branch: baseBranch }).pipe(Effect.orDie)
              const t = yield* setUp(made.id)
              const wt = t.worktree_path ?? ""
              const tracks = (yield* (yield* Git).run(wt, ["rev-parse", "--abbrev-ref", "@{upstream}"])).ok
              assert.isFalse(yield* hasWork(t), title)
              const d = yield* diff(t.id)
              assert.deepStrictEqual([d.merge_base, d.commits, d.patch], [yield* rev(wt, "HEAD"), "", ""], title)
              return { t, head: yield* rev(wt, "HEAD"), tracks, log: yield* log(t.id) }
            })
          const compared = (b: string) => base.compareRef(repo, b)

          // The main checkout is on master, with a change in the way of pulling it.
          let latest = yield* push("notes")
          yield* write(`${repo}/notes`, "mine")
          let r = yield* task("Dirty", null)
          assert.strictEqual(r.head, latest, r.log)
          assert.strictEqual(yield* compared("master"), "origin/master")
          assert.isFalse(r.tracks)
          assert.include(r.log, "Branching from origin/master, 1 commit ahead of master, which couldn't be fast-forwarded")
          assert.include(r.log, "(from origin/master)")
          assert.notStrictEqual(yield* rev(repo, "master"), latest)

          // Clean, it's pulled.
          yield* git(repo, ["checkout", "-q", "notes"])
          latest = yield* push("b")
          r = yield* task("Clean", null)
          assert.deepStrictEqual([r.head, yield* rev(repo, "master")], [latest, latest])
          assert.strictEqual(yield* compared("master"), "master")
          assert.include(r.log, "Pulled master from origin/master (2 new commits)")

          // Local commits that aren't pushed are kept.
          yield* git(repo, ["commit", "-q", "--allow-empty", "-m", "local"])
          const local = yield* rev(repo, "master")
          r = yield* task("Ahead", null)
          assert.strictEqual(r.head, local, r.log)
          assert.strictEqual(yield* compared("master"), "master")

          // Diverged: the upstream, where its pull request goes.
          latest = yield* push("c")
          r = yield* task("Diverged", null)
          assert.strictEqual(r.head, latest)
          assert.strictEqual(yield* compared("master"), "origin/master")
          assert.include(r.log, "master has diverged from origin/master; branching from origin/master, without the 1 commit only master has")
          assert.strictEqual(yield* rev(repo, "master"), local)

          // Pushed without -u, the branch of the same name on origin counts.
          yield* git(repo, ["reset", "-q", "--hard", "origin/master"])
          yield* git(repo, ["branch", "-q", "--unset-upstream"])
          latest = yield* push("d")
          r = yield* task("No upstream", null)
          assert.strictEqual(r.head, latest, r.log)
          assert.strictEqual(yield* compared("master"), "master")

          // A base branch only on the remote.
          yield* git(other, ["push", "-q", "origin", "HEAD:dev"])
          r = yield* task("Remote only", "dev")
          assert.strictEqual(r.head, latest, r.log)
          assert.isTrue(!r.tracks && r.log.includes("(from origin/dev)"), r.log)
          assert.strictEqual(yield* compared("dev"), "origin/dev")
          // Its work shows up in its diff.
          yield* commitFile(r.t.worktree_path ?? "", "feature")
          const d = yield* diff(r.t.id)
          assert.strictEqual(d.merge_base, latest)
          assert.strictEqual((d.commits ?? "").split("\n").filter((l) => l !== "").length, 1)
          assert.include(d.patch, "+++ b/feature")

          // Unreachable, it goes by the last fetch.
          yield* git(repo, ["remote", "set-url", "origin", `${repo}/../gone`])
          yield* push("e")
          r = yield* task("Offline", null)
          assert.strictEqual(r.head, latest, r.log)
          assert.include(r.log, "Could not fetch origin/master; branching from the copy fetched before")
        }),
      ),
    // Fetches, a pull and worktrees from four kinds of start: under a second here, past 5 s on CI's runner.
    30_000,
  )

  it.live("a task stacked on another starts from its branch and compares with it", () =>
    run(
      Effect.gen(function* () {
        const { repo, project } = yield* stackingRepo
        const a = yield* setUp((yield* make(project, "First")).id)
        const aWt = a.worktree_path ?? ""
        yield* commitFile(aWt, "a-file")
        // Stacked on it by its key: from its branch, which it's compared with (and its pull request targets).
        let b = yield* make(project, "Second", { start_from: "x-1" })
        assert.deepStrictEqual(b.start_from, { type: "task", task_id: a.id })
        b = yield* setUp(b.id)
        const bWt = b.worktree_path ?? ""
        assert.strictEqual(yield* rev(bWt, "HEAD"), yield* rev(aWt, "HEAD"))
        assert.strictEqual(b.base_branch, a.branch)
        assert.include(yield* log(b.id), "Lands after X-1: starting from its branch")
        assert.isFalse(yield* hasWork(b))
        yield* commitFile(bWt, "b-file")
        assert.deepStrictEqual(yield* changedFiles(b.id), ["b-file"])
        assert.isTrue(yield* hasWork(b))
        // It started where it did: what it starts from can't change now.
        yield* Effect.flip(patchTask(b.id, { start_from: null }))

        // A task to stack on with no branch yet has its worktree set up first.
        const c = yield* make(project, "Third")
        const d = yield* setUp((yield* make(project, "Fourth", { start_from: `task:${c.id}` })).id)
        const cNow = yield* getTask(c.id)
        assert.strictEqual(cNow.worktree_state, "ready")
        assert.strictEqual(d.base_branch, cNow.branch)
        assert.include(yield* log(d.id), "Setting up X-3's worktree first")

        // Merged into master by way of First's branch: Second's worktree goes, though First's branch doesn't have its work.
        yield* git(repo, ["merge", "-q", "--ff-only", b.branch ?? ""])
        yield* done(b.id)
        assert.deepStrictEqual(yield* (yield* Worktrees).removeIfMerged(b.id, false), { _tag: "Removed", into: "master" })

        // Once First is merged, a task stacked on it starts from where it went.
        yield* done(a.id)
        const e = yield* setUp((yield* make(project, "Fifth", { start_from: "X-1" })).id)
        assert.strictEqual(e.base_branch, "master")
        assert.strictEqual(yield* rev(e.worktree_path ?? "", "HEAD"), yield* rev(repo, "master"))
        assert.include(yield* log(e.id), "X-1 is merged already, so starting from master")
      }),
    ),
  )

  it.live("a stacked task keeps its base when its setup script fails", () =>
    run(
      Effect.gen(function* () {
        const { project } = yield* stackingRepo
        const a = yield* setUp((yield* make(project, "First")).id)
        let b = yield* make(project, "Second", { start_from: "X-1" })
        yield* (yield* Projects).update(project.id, { setup_script: "exit 1" })
        assert.include(yield* failure(setUp(b.id)), "script exited with exit status: 1")
        const failed = yield* getTask(b.id)
        assert.deepStrictEqual([failed.worktree_state, failed.base_branch], ["error", a.branch])
        // Its branch is made, so what it starts from can't change now.
        assert.strictEqual(yield* failure(patchTask(b.id, { start_from: "master" })), "worktree_made")
        // Set up again once the script is fixed, it's still stacked on First.
        yield* (yield* Projects).update(project.id, { setup_script: "" })
        b = yield* setUp(b.id)
        assert.strictEqual(b.base_branch, a.branch)
      }),
    ),
  )

  it.live("a stacked task merges where the task it stacks on went", () =>
    run(
      Effect.gen(function* () {
        const base = yield* TaskBase
        const { repo, project } = yield* stackingRepo
        const a = yield* setUp((yield* make(project, "First")).id)
        yield* commitFile(a.worktree_path ?? "", "parent-file")
        const b = yield* setUp((yield* make(project, "Second", { start_from: "X-1" })).id)
        const bWt = b.worktree_path ?? ""
        yield* commitFile(bWt, "child-file")
        // First is squashed into master and done: Second now merges into master, and its changes are still only its
        // own, before and after it's rebased onto master.
        yield* git(repo, ["merge", "-q", "--squash", a.branch ?? ""])
        yield* git(repo, ["commit", "-qm", "First"])
        yield* done(a.id)
        assert.strictEqual(yield* base.taskBase(yield* getTask(b.id), project), "master")
        assert.deepStrictEqual(yield* changedFiles(b.id), ["child-file"])
        assert.strictEqual((yield* diff(b.id)).base, "master")
        yield* git(bWt, ["rebase", "-q", "--onto", "master", a.branch ?? ""])
        assert.deepStrictEqual(yield* changedFiles(b.id), ["child-file"])
        assert.strictEqual((yield* diff(b.id)).merge_base, yield* rev(repo, "master"))
        // And with First's branch gone too.
        yield* git(repo, ["worktree", "remove", "--force", a.worktree_path ?? ""])
        yield* git(repo, ["branch", "-q", "-D", a.branch ?? ""])
        assert.deepStrictEqual(yield* changedFiles(b.id), ["child-file"])
      }),
    ),
  )

  it.live("a task started from a merged task goes where that went", () =>
    Effect.forEach(
      [false, true],
      (afterFirst) =>
        run(
          Effect.gen(function* () {
            const base = yield* TaskBase
            const { repo, project } = yield* stackingRepo
            const a = yield* setUp((yield* make(project, "First")).id)
            const aWt = a.worktree_path ?? ""
            const aBranch = a.branch ?? ""
            yield* commitFile(aWt, "parent-file")
            const b = yield* setUp((yield* make(project, "Second", { start_from: "X-1" })).id)
            yield* commitFile(b.worktree_path ?? "", "child-file")
            // Second is squashed into First and done.
            yield* git(aWt, ["merge", "-q", "--squash", b.branch ?? ""])
            yield* git(aWt, ["commit", "-qm", "Second"])
            yield* done(b.id)
            const firstMerged = Effect.gen(function* () {
              yield* git(repo, ["merge", "-q", "--squash", aBranch])
              yield* git(repo, ["commit", "-qm", "First"])
              yield* done(a.id)
              yield* (yield* Worktrees).teardown(a.id, { force: true, deleteBranch: true })
            })
            if (afterFirst) yield* firstMerged
            const c = yield* setUp((yield* make(project, "Third", { start_from: "X-2" })).id)
            const went = afterFirst ? "master" : aBranch
            assert.strictEqual(c.base_branch, went, String(afterFirst))
            assert.include(yield* log(c.id), `X-2 is merged already, so starting from ${went}`)
            assert.strictEqual(yield* rev(c.worktree_path ?? "", "HEAD"), yield* rev(repo, went))
            yield* commitFile(c.worktree_path ?? "", "third-file")
            // First is merged afterwards: Third goes to master too.
            if (!afterFirst) yield* firstMerged
            assert.strictEqual(yield* base.taskBase(yield* getTask(c.id), project), "master", String(afterFirst))
            assert.deepStrictEqual(yield* changedFiles(c.id), ["third-file"], String(afterFirst))
          }),
        ),
      { concurrency: 1 },
    ),
  )

  // Second takes in some of First's later work, and the board hears of it as First is done or as First's worktree and
  // branch are removed, without anyone reading Second's changes before First's branch is gone. (The old test's third
  // case, Second's run ending, goes the same way through the reactor's `RunExited`: not run here, as it needs a run.)
  it.live(
    "a stacked task keeps its own changes when the branch it stacks on is deleted",
    () =>
      Effect.forEach(
        ["done", "teardown"] as const,
        (how) =>
          run(
            Effect.gen(function* () {
              const base = yield* TaskBase
              const g = yield* Git
              const { repo, project } = yield* stackingRepo
              const a = yield* setUp((yield* make(project, "First")).id)
              const aWt = a.worktree_path ?? ""
              const aBranch = a.branch ?? ""
              yield* commitFile(aWt, "parent-file")
              const b = yield* setUp((yield* make(project, "Second", { start_from: "X-1" })).id)
              const bWt = b.worktree_path ?? ""
              const takenIn = yield* commitFile(aWt, "more-parent-file")
              yield* git(bWt, ["merge", "-q", "--no-edit", aBranch])
              yield* commitFile(bWt, "child-file")
              // First moves on again, past what Second took in.
              yield* commitFile(aWt, "latest-parent-file")
              // First is squashed into master, done, and its branch deleted (pushed and fetched too), before Second is
              // brought up to date: its changes are still only its own.
              yield* git(repo, ["merge", "-q", "--squash", aBranch])
              yield* git(repo, ["commit", "-qm", "First"])
              yield* git(repo, ["push", "-q", "origin", "master", `${aBranch}:${aBranch}`])
              yield* git(repo, ["fetch", "-q", "origin"])
              // Second's agent is at work, so the board doesn't restack it onto master as First is merged (4.8's
              // `Restack`, which this case isn't about): its start ref is what's looked at.
              const tasks = yield* Tasks
              yield* tasks.change(b.id, () => ({ running: true }), Actor.board).pipe(Effect.orDie)
              yield* done(a.id)
              if (how === "done") {
                yield* (yield* Reactor).idle
                assert.strictEqual(yield* g.commit(repo, startRef(b.id)), takenIn, how)
                yield* git(repo, ["worktree", "remove", "--force", aWt])
                yield* git(repo, ["branch", "-q", "-D", aBranch])
              } else yield* (yield* Worktrees).teardown(a.id, { force: true, deleteBranch: true })
              assert.strictEqual(yield* g.commit(repo, `refs/heads/${aBranch}`), null)
              yield* git(repo, ["push", "-q", "origin", "--delete", aBranch])
              yield* git(repo, ["fetch", "-q", "--prune", "origin"])
              assert.deepStrictEqual(yield* changedFiles(b.id), ["child-file"], how)
              // So do a review and a summary, which compare with the same commit, rather than the pull request's diff.
              const bNow = yield* getTask(b.id)
              assert.strictEqual((yield* base.changesBase(bWt, bNow, project)).start, yield* rev(bWt, "HEAD~1"), how)
              assert.deepStrictEqual(yield* base.workScope(bWt, bNow, project), { ref: takenIn, ownStart: true }, how)
              // And its branch's, with its worktree removed.
              yield* tasks.change(b.id, () => ({ running: false }), Actor.board).pipe(Effect.orDie)
              yield* (yield* Reactor).idle
              yield* (yield* Worktrees).teardown(b.id, { force: false, deleteBranch: false })
              assert.deepStrictEqual(yield* changedFiles(b.id), ["child-file"], how)
              yield* setUp(b.id)
              // Rebased onto master (First's commits dropped), it's compared with master.
              yield* git(bWt, ["rebase", "-q", "--onto", "master", "HEAD~1"])
              assert.deepStrictEqual(yield* changedFiles(b.id), ["child-file"], how)
              assert.strictEqual((yield* diff(b.id)).merge_base, yield* rev(repo, "master"))
              assert.deepStrictEqual(yield* base.workScope(bWt, yield* getTask(b.id), project), { ref: yield* rev(repo, "master"), ownStart: false }, how)
              // Deleting the task drops what it kept.
              yield* (yield* TaskDeletion).delete(b.id, { deleteBranch: false }, Actor.user)
              assert.strictEqual(yield* g.commit(repo, startRef(b.id)), null)
            }),
          ),
        { concurrency: 1 },
      ),
    // Two cases of git worktrees and branches made and removed: well under a second each here, slower on CI.
    30_000,
  )

  it.live("a remote's branch is that remote's", () =>
    run(
      Effect.gen(function* () {
        const base = yield* TaskBase
        const { root, repo, other, project } = yield* stackingRepo
        // Another remote with a feature branch of its own, and origin's, neither fetched.
        const fork = `${root}/fork`
        yield* git(root, ["clone", "-q", "--bare", `${root}/origin`, fork])
        yield* git(repo, ["remote", "add", "upstream", fork])
        yield* git(other, ["checkout", "-q", "-b", "feature"])
        const theirs = yield* commitFile(other, "fork-file")
        yield* git(other, ["push", "-q", fork, "feature"])
        yield* git(other, ["reset", "-q", "--hard", "origin/master"])
        const ours = yield* commitFile(other, "origin-file")
        yield* git(other, ["push", "-q", "origin", "feature"])
        // Upstream's isn't a branch this task's pull request (which goes to origin's repository) can target: it starts
        // from its latest commit, and its pull request targets master.
        let t = yield* setUp((yield* make(project, "Fork's", { start_from: "upstream/feature" })).id)
        const wt = t.worktree_path ?? ""
        assert.deepStrictEqual([yield* rev(wt, "HEAD"), t.base_branch], [theirs, "master"])
        assert.include(yield* log(t.id), "upstream/feature is on upstream, which this task's pull request doesn't go to")
        yield* commitFile(wt, "mine")
        assert.deepStrictEqual(yield* changedFiles(t.id), ["mine"])
        t = yield* getTask(t.id)
        assert.isTrue(yield* hasWork(t))
        // A review and a summary read its changes from where it started, not its pull request's diff.
        assert.deepStrictEqual(yield* base.workScope(wt, t, project), { ref: theirs, ownStart: true })
        // Origin's, never fetched: fetched, and its pull request goes to feature there.
        t = yield* setUp((yield* make(project, "Origin's", { start_from: "origin/feature" })).id)
        assert.deepStrictEqual([yield* rev(t.worktree_path ?? "", "HEAD"), t.base_branch], [ours, "feature"])
      }),
    ),
  )

  it.live("a task can start from a commit or a remote branch", () =>
    run(
      Effect.gen(function* () {
        const { repo, other, project } = yield* stackingRepo
        const first = yield* rev(repo, "master")
        yield* commitFile(repo, "later")
        // An older commit of master, by a short SHA: it starts there, and merges into master.
        let t = yield* make(project, "Old", { start_from: first.slice(0, 8) })
        assert.deepStrictEqual(t.start_from, { type: "commit", commit: first.slice(0, 8) })
        t = yield* setUp(t.id)
        assert.deepStrictEqual([yield* rev(t.worktree_path ?? "", "HEAD"), t.base_branch], [first, "master"])
        assert.include(yield* log(t.id), `Starting from commit ${first.slice(0, 12)}`)
        // A commit on a branch master doesn't have: its changes are only what's after it.
        yield* git(repo, ["checkout", "-q", "-b", "side", first])
        const side = yield* commitFile(repo, "side-file")
        yield* git(repo, ["checkout", "-q", "master"])
        t = yield* setUp((yield* make(project, "Side", { start_from: `commit:${side}` })).id)
        yield* commitFile(t.worktree_path ?? "", "mine")
        assert.deepStrictEqual(yield* changedFiles(t.id), ["mine"])
        assert.strictEqual((yield* diff(t.id)).merge_base, side)
        // A commit only on the remote, by its full SHA, is fetched.
        yield* git(other, ["checkout", "-q", "-b", "elsewhere"])
        const elsewhere = yield* commitFile(other, "elsewhere-file")
        yield* git(other, ["push", "-q", "origin", "elsewhere"])
        yield* git(other, ["push", "-q", "origin", "--delete", "elsewhere"])
        yield* git(other, ["push", "-q", "origin", "elsewhere:refs/keep/elsewhere"])
        t = yield* setUp((yield* make(project, "Fetched", { start_from: elsewhere })).id)
        assert.strictEqual(yield* rev(t.worktree_path ?? "", "HEAD"), elsewhere)
        // One that's nowhere fails, saying so.
        t = yield* make(project, "Nowhere", { start_from: "deadbeefdeadbeef" })
        assert.include(yield* failure(setUp(t.id)), "commit deadbeefdeadbeef isn't in the repository (give its full SHA to fetch it)")
        assert.strictEqual((yield* getTask(t.id)).worktree_state, "error")
        // It can be put right, and set up again.
        t = yield* patchTask(t.id, { start_from: first.slice(0, 8) }).pipe(Effect.orDie)
        assert.deepStrictEqual([t.worktree_state, t.worktree_error], ["none", null])
        assert.strictEqual(yield* rev((yield* setUp(t.id)).worktree_path ?? "", "HEAD"), first)
        // A branch only on the remote, named with it, is that branch: fetched, and its base.
        yield* git(other, ["checkout", "-q", "-b", "feature", "origin/master"])
        const feature = yield* commitFile(other, "feature-file")
        yield* git(other, ["push", "-q", "origin", "feature"])
        yield* git(repo, ["fetch", "-q", "origin"])
        t = yield* setUp((yield* make(project, "Feature", { start_from: "origin/feature" })).id)
        assert.deepStrictEqual([yield* rev(t.worktree_path ?? "", "HEAD"), t.base_branch], [feature, "feature"])
      }),
    ),
  )
})

/** A fake GitHub whose pull requests are `prs` by number in `repo`, recording what it was asked. */
const fakeGitHub = (asked: Ref.Ref<ReadonlyArray<string>>, prs: Readonly<Record<string, PullRequestView>>, repo: string): GitHubAccessShape => ({
  ...noGitHubStacks(),
  fetchEnv: (_cwd, account) =>
    Effect.as(
      Ref.update(asked, (all) => [...all, `fetch as ${account}`]),
      {},
    ),
  pullRequest: (_cwd, _account, ref, inRepo) =>
    Effect.gen(function* () {
      yield* Ref.update(asked, (all) => [...all, `pr view ${ref} --repo ${inRepo}`])
      const pr = inRepo === repo ? prs[ref] : undefined
      return pr === undefined ? yield* new GitHubUnavailable({ reason: "no such pull request" }) : pr
    }),
})
const pr = (state: PullRequestView["state"], head: string, oid: string, cross: boolean): PullRequestView => ({
  state,
  headRefName: head,
  baseRefName: "master",
  headRefOid: oid,
  isCrossRepository: cross,
  url: "https://github.com/o/r/pull/0",
})

describe("a task started from a pull request", () => {
  it.live("starts from its branch, its head commit, or where it went", () =>
    Effect.gen(function* () {
      const asked = yield* Ref.make<ReadonlyArray<string>>([])
      const prs = yield* Ref.make<Record<string, PullRequestView>>({})
      const github: GitHubAccessShape = {
        ...noGitHubStacks(),
        fetchEnv: () => Effect.succeed({}),
        pullRequest: (cwd, account, ref, repo) => Effect.flatMap(Ref.get(prs), (all) => fakeGitHub(asked, all, "o/r").pullRequest(cwd, account, ref, repo)),
      }
      yield* run(
        Effect.gen(function* () {
          const { repo, other, project } = yield* stackingRepo
          // On GitHub as far as the board can tell.
          yield* git(repo, ["remote", "set-url", "--push", "origin", "git@github.com:o/r.git"])
          yield* git(other, ["checkout", "-q", "-b", "feature"])
          const feature = yield* commitFile(other, "feature-file")
          yield* git(other, ["push", "-q", "origin", "feature"])
          yield* git(other, ["checkout", "-q", "-b", "fork", "master"])
          const fork = yield* commitFile(other, "fork-file")
          yield* git(other, ["push", "-q", "origin", "fork:refs/pull/8/head"])
          yield* Ref.set(prs, { "7": pr("OPEN", "feature", feature, false), "8": pr("OPEN", "patch-1", fork, true), "9": pr("MERGED", "done", feature, false) })

          // An open one from the repository: its branch, which its pull request targets.
          let t = yield* make(project, "On a PR", { start_from: "#7" })
          assert.deepStrictEqual(t.start_from, { type: "pull_request", number: 7 })
          t = yield* setUp(t.id)
          assert.deepStrictEqual([yield* rev(t.worktree_path ?? "", "HEAD"), t.base_branch], [feature, "feature"])
          assert.include(yield* Ref.get(asked), "pr view 7 --repo o/r")
          yield* commitFile(t.worktree_path ?? "", "mine")
          assert.deepStrictEqual(yield* changedFiles(t.id), ["mine"])
          // From a fork: its head commit, fetched, on top of its base.
          t = yield* setUp((yield* make(project, "On a fork's PR", { start_from: "https://github.com/o/r/pull/8/files" })).id)
          assert.deepStrictEqual([yield* rev(t.worktree_path ?? "", "HEAD"), t.base_branch], [fork, "master"])
          assert.include(yield* log(t.id), "Pull request #8 is from a fork")
          // Merged: where it went.
          t = yield* setUp((yield* make(project, "On a merged PR", { start_from: "pr:9" })).id)
          assert.strictEqual(t.base_branch, "master")
          // One in another repository, or that gh can't find, fails.
          assert.include(
            yield* failure(setUp((yield* make(project, "Elsewhere", { start_from: "https://github.com/o/other/pull/7" })).id)),
            "pull request #7 is in o/other, not in the project's repository o/r",
          )
          assert.include(yield* failure(setUp((yield* make(project, "Missing", { start_from: "#10" })).id)), "couldn't read pull request #10 of o/r with gh")
        }),
        github,
      )
    }).pipe(Effect.scoped),
  )

  it.live("is looked up where the project's tasks open theirs", () =>
    Effect.gen(function* () {
      const asked = yield* Ref.make<ReadonlyArray<string>>([])
      const prs = yield* Ref.make<Record<string, PullRequestView>>({})
      const github: GitHubAccessShape = {
        ...noGitHubStacks(),
        fetchEnv: () => Effect.succeed({}),
        pullRequest: (cwd, account, ref, repo) =>
          Effect.flatMap(Ref.get(prs), (all) => fakeGitHub(asked, all, "o/upstream").pullRequest(cwd, account, ref, repo)),
      }
      yield* run(
        Effect.gen(function* () {
          const base = yield* TaskBase
          const { root, repo, other, project } = yield* stackingRepo
          // Origin and upstream are different repositories on GitHub, and master follows upstream's.
          const up = `${root}/upstream`
          yield* git(root, ["clone", "-q", "--bare", `${root}/origin`, up])
          yield* git(repo, ["remote", "add", "upstream", up])
          yield* git(repo, ["remote", "set-url", "--push", "origin", "git@github.com:o/origin.git"])
          yield* git(repo, ["remote", "set-url", "--push", "upstream", "git@github.com:o/upstream.git"])
          yield* git(repo, ["fetch", "-q", "upstream"])
          yield* git(repo, ["branch", "-q", "-u", "upstream/master", "master"])
          yield* git(other, ["checkout", "-q", "-b", "feature"])
          const feature = yield* commitFile(other, "feature-file")
          yield* git(other, ["push", "-q", up, "feature"])
          yield* Ref.set(prs, { "7": pr("OPEN", "feature", feature, false) })
          // Its branch isn't one `feature` alone follows here (that would be origin's): its head commit, fetched from
          // upstream, on top of its base, where the task's pull request goes.
          for (const from of ["https://github.com/o/upstream/pull/7", "#7"]) {
            const t = yield* setUp((yield* make(project, "On upstream's PR", { start_from: from })).id)
            assert.deepStrictEqual([yield* rev(t.worktree_path ?? "", "HEAD"), t.base_branch], [feature, "master"], from)
            assert.include(yield* log(t.id), "Pull request #7 has its branch on upstream")
            assert.deepStrictEqual(yield* base.github(repo, t.base_branch), { remote: "upstream", repo: "o/upstream" })
          }
          assert.isTrue((yield* Ref.get(asked)).every((l) => l.endsWith("--repo o/upstream")))
          // With a local feature that follows upstream's, it's that branch, and the task's pull request targets it there.
          yield* git(repo, ["fetch", "-q", "upstream"])
          yield* git(repo, ["branch", "-q", "--track", "feature", "upstream/feature"])
          const t = yield* setUp((yield* make(project, "On upstream's branch", { start_from: "#7" })).id)
          assert.strictEqual(t.base_branch, "feature")
          assert.deepStrictEqual(yield* base.github(repo, t.base_branch), { remote: "upstream", repo: "o/upstream" })
        }),
        github,
      )
    }).pipe(Effect.scoped),
  )
})

describe("stacks", () => {
  it.live("a stacked task still goes where its merged parent went once that is deleted", () =>
    run(
      Effect.gen(function* () {
        const base = yield* TaskBase
        const { repo, project } = yield* stackingRepo
        const a = yield* setUp((yield* make(project, "First")).id)
        const aTip = yield* commitFile(a.worktree_path ?? "", "parent-file")
        const b = yield* setUp((yield* make(project, "Second", { start_from: "X-1" })).id)
        yield* commitFile(b.worktree_path ?? "", "child-file")
        // Third isn't set up yet.
        const c = yield* make(project, "Third", { start_from: "X-1" })
        // First is squashed into master, done, torn down with its branch, and deleted.
        yield* git(repo, ["merge", "-q", "--squash", a.branch ?? ""])
        yield* git(repo, ["commit", "-qm", "First"])
        yield* done(a.id)
        // First merged, Second is restacked onto where it went (4.8) before First's branch goes.
        yield* (yield* Restack).settled(b.id)
        yield* (yield* Worktrees).teardown(a.id, { force: true, deleteBranch: true })
        yield* (yield* TaskDeletion).delete(a.id, { deleteBranch: false }, Actor.user)
        // Second goes to master, from the commit it was restacked onto, its changes still only its own.
        const bNow = yield* getTask(b.id)
        assert.deepStrictEqual([bNow.base_branch, bNow.start_from], ["master", { type: "commit", commit: yield* rev(repo, "master") }])
        assert.notStrictEqual(aTip, yield* rev(repo, "master"))
        assert.strictEqual(yield* base.taskBase(bNow, project), "master")
        assert.deepStrictEqual(yield* changedFiles(b.id), ["child-file"])
        assert.include(yield* log(b.id), "X-1, which this task landed after, was deleted: it's merged, so this task goes to master")
        // Third is a task on master.
        const cNow = yield* getTask(c.id)
        assert.deepStrictEqual([cNow.base_branch, cNow.start_from], ["master", null])
        assert.strictEqual(yield* rev((yield* setUp(c.id)).worktree_path ?? "", "HEAD"), yield* rev(repo, "master"))
      }),
    ),
  )

  it.live("deleting a merged middle task stacks its tasks on the one below", () =>
    run(
      Effect.gen(function* () {
        const base = yield* TaskBase
        const { repo, project } = yield* stackingRepo
        const a = yield* setUp((yield* make(project, "First")).id)
        const aWt = a.worktree_path ?? ""
        yield* commitFile(aWt, "first-file")
        const b = yield* setUp((yield* make(project, "Second", { start_from: "X-1" })).id)
        yield* commitFile(b.worktree_path ?? "", "second-file")
        // Third has a branch on Second's, Fourth isn't set up yet.
        const c = yield* setUp((yield* make(project, "Third", { start_from: "X-2" })).id)
        yield* commitFile(c.worktree_path ?? "", "third-file")
        const d = yield* make(project, "Fourth", { start_from: "X-2" })
        // Second is squashed into First, done and deleted with its branch, before First is merged.
        yield* git(aWt, ["merge", "-q", "--squash", b.branch ?? ""])
        yield* git(aWt, ["commit", "-qm", "Second"])
        yield* done(b.id)
        yield* (yield* TaskDeletion).delete(b.id, { deleteBranch: true }, Actor.user)
        const onFirst = { type: "task", task_id: a.id }
        let cNow = yield* getTask(c.id)
        let dNow = yield* getTask(d.id)
        assert.deepStrictEqual([cNow.start_from, cNow.base_branch], [onFirst, a.branch])
        assert.deepStrictEqual([dNow.start_from, dNow.base_branch], [onFirst, null])
        assert.include(yield* log(c.id), "X-2, which this task landed after, was deleted: it's merged into X-1, so this task lands after that now")
        assert.deepStrictEqual(yield* changedFiles(c.id), ["third-file"])
        // First is squashed into master, done and its branch deleted: both go to master.
        yield* git(repo, ["merge", "-q", "--squash", a.branch ?? ""])
        yield* git(repo, ["commit", "-qm", "First"])
        yield* done(a.id)
        yield* (yield* Worktrees).teardown(a.id, { force: true, deleteBranch: true })
        cNow = yield* getTask(c.id)
        dNow = yield* getTask(d.id)
        assert.strictEqual(yield* base.taskBase(cNow, project), "master")
        assert.strictEqual(yield* base.taskBase(dNow, project), "master")
        assert.deepStrictEqual(yield* changedFiles(c.id), ["third-file"])
        assert.strictEqual((yield* diff(c.id)).base, "master")
        dNow = yield* setUp(d.id)
        assert.deepStrictEqual([yield* rev(dNow.worktree_path ?? "", "HEAD"), dNow.base_branch], [yield* rev(repo, "master"), "master"])
      }),
    ),
  )

  it.live("a task stacked on an unpushed branch opens its pull request where that one's goes", () =>
    run(
      Effect.gen(function* () {
        const base = yield* TaskBase
        const { root, repo, project } = yield* stackingRepo
        const up = `${root}/upstream`
        yield* git(root, ["clone", "-q", "--bare", `${root}/origin`, up])
        yield* git(repo, ["remote", "add", "upstream", up])
        yield* git(repo, ["remote", "set-url", "--push", "origin", "git@github.com:o/origin.git"])
        yield* git(repo, ["remote", "set-url", "--push", "upstream", "git@github.com:o/upstream.git"])
        yield* git(repo, ["fetch", "-q", "upstream"])
        yield* git(repo, ["branch", "-q", "-u", "upstream/master", "master"])
        // Second stacks on First, which isn't set up yet: it is, without a remote of its own.
        const a = yield* make(project, "First")
        const b = yield* setUp((yield* make(project, "Second", { start_from: "X-1" })).id)
        const aNow = yield* getTask(a.id)
        assert.strictEqual(b.base_branch, aNow.branch)
        const goesTo = (t: Task) => Effect.flatMap(base.remoteBase(t, project), (b2) => base.github(repo, b2))
        assert.deepStrictEqual(yield* goesTo(aNow), { remote: "upstream", repo: "o/upstream" })
        assert.deepStrictEqual(yield* goesTo(b), { remote: "upstream", repo: "o/upstream" })
        // Once First's branch has a remote of its own, that's where.
        yield* git(repo, ["config", `branch.${aNow.branch}.remote`, "origin"])
        assert.deepStrictEqual(yield* goesTo(b), { remote: "origin", repo: "o/origin" })
      }),
    ),
  )
})

describe("accounts", () => {
  it.live("worktree fetches use the project's account before the profile's", () =>
    Effect.gen(function* () {
      const asked = yield* Ref.make<ReadonlyArray<string>>([])
      // No network: the fetch is pointed at a folder that isn't there.
      const github: GitHubAccessShape = {
        ...noGitHubStacks(),
        fetchEnv: (_cwd, account) =>
          Effect.as(
            Ref.update(asked, (all) => [...all, `${account}`]),
            {
              GIT_CONFIG_COUNT: "1",
              GIT_CONFIG_KEY_0: "url./nonexistent/.insteadOf",
              GIT_CONFIG_VALUE_0: "https://github.com/",
            },
          ),
        pullRequest: () => Effect.succeed(null),
      }
      yield* run(
        Effect.gen(function* () {
          const { repo, project, task } = yield* taskWithWork
          yield* git(repo, ["remote", "add", "origin", "https://github.com/o/r.git"])
          yield* git(repo, ["update-ref", "refs/remotes/origin/master", "master"])
          yield* git(repo, ["branch", "--set-upstream-to=origin/master", "master"])
          yield* (yield* Profiles).update(task.profile_id, { github_account: "profile-login" }).pipe(Effect.orDie)
          yield* (yield* Projects).update(project.id, { github_account: "project-login" })
          const one = yield* setUp((yield* make(project, "Project account")).id)
          yield* (yield* Projects).update(project.id, { github_account: null })
          const two = yield* setUp((yield* make(project, "Profile account")).id)
          assert.deepStrictEqual(yield* Ref.get(asked), ["project-login", "profile-login"])
          for (const t of [one, two]) {
            assert.include(yield* log(t.id), "Could not fetch origin/master; branching from the copy fetched before")
            assert.strictEqual(yield* rev(t.worktree_path ?? "", "HEAD"), yield* rev(repo, "master"))
          }
        }),
        github,
      )
    }).pipe(Effect.scoped),
  )
})
