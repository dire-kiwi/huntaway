import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect, FileSystem } from "effect"
import { SqlClient } from "effect/sql"
import type { Project, Task } from "@huntaway/contracts"
import { fakeGitHub, fakePull, git, tempDir, TestBoard } from "@huntaway/testing"
import type { FakeGitHub, FakeGitHubState } from "@huntaway/testing"
import { Worktrees } from "../git/Worktrees.ts"
import { Reactor } from "../lifecycle/Reactor.ts"
import { change, reload } from "../mcp/tools/tests/wait.ts"
import { Actor } from "../platform/Changes.ts"
import { Profiles } from "../profiles/Profiles.ts"
import { Projects } from "../projects/Projects.ts"
import { Tasks } from "../tasks/Tasks.ts"
import { PullRequests } from "./PullRequests.ts"

// A task's pull request (the pull request cases of the old git/worktree/tests.test.ts: `pr_view_args` in
// `finds_the_github_remote_pull_requests_go_to`, `a_task_with_commits_its_base_lacks_is_unmerged`; and state.ts's
// previews following the pull request), over the fake GitHub. The approval's verdicts are in prWatch/pr.test.ts.

process.env["GIT_CONFIG_GLOBAL"] = "/dev/null"
process.env["GIT_CONFIG_NOSYSTEM"] = "1"

/** `body` on a board whose gh is the fake GitHub of `state` (`me` its account). */
const onBoard = <A, E, R>(state: FakeGitHubState, body: (fake: FakeGitHub) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fake = yield* fakeGitHub({ accounts: [{ host: "github.com", login: "me", token: "tok-me", active: true }], ...state })
    return yield* body(fake).pipe(Effect.scoped, Effect.provide(TestBoard({ ghBin: fake.bin })))
  }).pipe(Effect.provide(NodeServices.layer))

/** A repository on master with one commit, and a project on it (with `fields`). */
const projectOnRepo = (fields: { readonly pr_preview_url?: string } = {}) =>
  Effect.gen(function* () {
    const repo = `${yield* tempDir}/repo`
    yield* (yield* FileSystem.FileSystem).makeDirectory(repo, { recursive: true }).pipe(Effect.orDie)
    yield* git(repo, ["init", "-q", "-b", "master"])
    yield* git(repo, ["commit", "-q", "--allow-empty", "-m", "init"])
    const profile = yield* (yield* Profiles).create({ name: "p" }).pipe(Effect.orDie)
    const project = yield* (yield* Projects).create({ profile_id: profile.id, name: "x", repo_path: repo, base_branch: "master" }).pipe(Effect.orDie)
    const updated = fields.pr_preview_url === undefined ? project : yield* (yield* Projects).update(project.id, fields).pipe(Effect.orDie)
    return { repo, project: updated }
  })

const newTask = (project: Project, title = "Do it") =>
  Effect.flatMap(Tasks, (tasks) => tasks.create({ project_id: project.id, title }, Actor.user)).pipe(Effect.orDie)
const setUp = (t: Task) => Effect.flatMap(Worktrees, (w) => w.setup(t.id)).pipe(Effect.orDie)
const write = (path: string, text: string) => Effect.flatMap(FileSystem.FileSystem, (fs) => fs.writeFileString(path, text)).pipe(Effect.orDie)

describe("a task's pull request", () => {
  it.effect("is looked up where its branch is pushed, as the task's account, unless it has one", () =>
    onBoard(
      { repos: { "o/mirror": { pulls: [fakePull({ number: 3, head: "ia/x-1" })] }, "o/r": { pulls: [fakePull({ number: 9, head: "ia/x-1" })] } } },
      (fake) =>
        Effect.gen(function* () {
          const { repo, project } = yield* projectOnRepo()
          yield* git(repo, ["remote", "add", "history", "git@github.com:o/history.git"])
          yield* git(repo, ["remote", "add", "origin", "https://github.com/o/r.git"])
          // It's where the branch is pushed that counts, not where it's fetched from.
          yield* git(repo, ["config", "branch.master.remote", "history"])
          yield* git(repo, ["remote", "set-url", "--push", "history", "git@github.com:o/mirror.git"])
          const t = yield* newTask(project)
          const pullRequests = yield* PullRequests
          // No branch, no pull request to look for.
          assert.isNull(yield* pullRequests.find(t.id))
          yield* change(t.id, { branch: "ia/x-1" })
          assert.strictEqual(yield* pullRequests.find(t.id), "https://github.com/o/mirror/pull/3")
          assert.strictEqual((yield* reload(t.id)).pr_url, "https://github.com/o/mirror/pull/3")
          const view = (yield* fake.calls).filter((c) => c.args[0] === "pr" && c.args[1] === "view")
          assert.deepStrictEqual(view.at(-1)?.args, ["pr", "view", "ia/x-1", "--json", "url", "--repo", "o/mirror"])
          assert.strictEqual(view.at(-1)?.as, "me")
          // One it has isn't looked up again.
          assert.isNull(yield* pullRequests.find(t.id))
          // Pushed nowhere on GitHub, wherever gh finds it (origin's fetch URL).
          const u = yield* newTask(project, "Another")
          yield* change(u.id, { branch: "ia/x-1" })
          yield* git(repo, ["config", "--unset", "branch.master.remote"])
          yield* git(repo, ["remote", "set-url", "--push", "origin", "git@gitlab.com:o/r.git"])
          assert.strictEqual(yield* pullRequests.find(u.id), "https://github.com/o/r/pull/9")
          assert.deepStrictEqual((yield* fake.calls).at(-1)?.args, ["pr", "view", "ia/x-1", "--json", "url"])
        }),
    ),
  )

  it.effect("a task with commits its base lacks is unmerged, unless its pull request is merged", () =>
    onBoard({ repos: { "o/r": { pulls: [fakePull({ number: 7, head: "x" })] } } }, (fake) =>
      Effect.gen(function* () {
        const { repo, project } = yield* projectOnRepo()
        const t = yield* setUp(yield* newTask(project))
        const wt = t.worktree_path ?? ""
        const pullRequests = yield* PullRequests
        // Nothing done yet.
        assert.isFalse(yield* pullRequests.unmerged(yield* reload(t.id)))
        yield* write(`${wt}/notes`, "1")
        assert.isTrue(yield* pullRequests.unmerged(yield* reload(t.id)))
        yield* git(wt, ["add", "notes"])
        yield* git(wt, ["commit", "-qm", "work"])
        assert.isTrue(yield* pullRequests.unmerged(yield* reload(t.id)))
        // A task of a type of its own (the old plan documents, a pen's thread…) isn't merged.
        const sql = yield* SqlClient.SqlClient
        yield* sql`UPDATE tasks SET task_type = 'summary' WHERE id = ${t.id}`.pipe(Effect.orDie)
        assert.isFalse(yield* pullRequests.unmerged(yield* reload(t.id)))
        yield* sql`UPDATE tasks SET task_type = NULL WHERE id = ${t.id}`.pipe(Effect.orDie)
        // Its pull request merged on GitHub (squashed, say) leaves nothing unmerged; open, or unreadable, it does.
        yield* change(t.id, { pr_url: "https://github.com/o/r/pull/7" })
        assert.isTrue(yield* pullRequests.unmerged(yield* reload(t.id)))
        yield* fake.update((s) => ({ ...s, repos: { "o/r": { pulls: [fakePull({ number: 7, head: "x", state: "MERGED" })] } } }))
        assert.isFalse(yield* pullRequests.unmerged(yield* reload(t.id)))
        yield* change(t.id, { pr_url: "https://github.com/o/r/pull/8" })
        assert.isTrue(yield* pullRequests.unmerged(yield* reload(t.id)))
        // Merged into master, nothing is.
        yield* change(t.id, { pr_url: null })
        yield* git(repo, ["merge", "-q", "--no-ff", "-m", "merge", t.branch ?? ""])
        assert.isFalse(yield* pullRequests.unmerged(yield* reload(t.id)))
      }),
    ),
  )

  it.effect("needs an approving review on GitHub where the project or profile asks for one", () =>
    onBoard({ repos: { "o/r": { pulls: [fakePull({ number: 7, head: "x" })] } } }, (fake) =>
      Effect.gen(function* () {
        const { repo, project } = yield* projectOnRepo()
        yield* git(repo, ["remote", "add", "origin", "git@github.com:o/r.git"])
        const t = yield* setUp(yield* newTask(project))
        const pullRequests = yield* PullRequests
        const projects = yield* Projects
        // Not asked for.
        assert.deepStrictEqual(yield* pullRequests.approval(t, null), { _tag: "NotRequired" })
        // The profile's setting, unless the project has its own.
        yield* (yield* Profiles).update(project.profile_id, { require_pr_approval: true }).pipe(Effect.orDie)
        assert.deepStrictEqual(yield* pullRequests.approval(t, null), {
          _tag: "Required",
          url: null,
          approved: false,
          error: "the task has no pull request yet; open one and get it approved on GitHub first",
        })
        yield* projects.update(project.id, { require_pr_approval: false }).pipe(Effect.orDie)
        assert.deepStrictEqual(yield* pullRequests.approval(t, null), { _tag: "NotRequired" })
        yield* projects.update(project.id, { require_pr_approval: true }).pipe(Effect.orDie)
        const url = "https://github.com/o/r/pull/7"
        assert.deepStrictEqual(yield* pullRequests.approval(t, url), { _tag: "Required", url, approved: false, error: null })
        yield* fake.update((s) => ({ ...s, repos: { "o/r": { pulls: [fakePull({ number: 7, head: "x", reviewDecision: "APPROVED" })] } } }))
        assert.deepStrictEqual(yield* pullRequests.approval(t, url), { _tag: "Required", url, approved: true, error: null })
        // Where its merge goes through no pull request (the project opens none, or isn't on GitHub), it isn't.
        yield* projects.update(project.id, { pull_requests: false }).pipe(Effect.orDie)
        assert.deepStrictEqual(yield* pullRequests.approval(t, url), { _tag: "NotRequired" })
        yield* projects.update(project.id, { pull_requests: true }).pipe(Effect.orDie)
        yield* git(repo, ["remote", "set-url", "origin", "git@gitlab.com:o/r.git"])
        assert.deepStrictEqual(yield* pullRequests.approval(t, url), { _tag: "NotRequired" })
      }),
    ),
  )

  it.effect("its preview follows it unless set by hand, and a new template is followed", () =>
    onBoard({}, () =>
      Effect.gen(function* () {
        const { project } = yield* projectOnRepo({ pr_preview_url: "https://pr-{pr}.preview.example" })
        const tasks = yield* Tasks
        const t = yield* newTask(project)
        let now = yield* tasks.update(t.id, { pr_url: "https://github.com/o/r/pull/12" }, Actor.user).pipe(Effect.orDie)
        assert.strictEqual(now.preview_url, "https://pr-12.preview.example")
        // A preview set by hand stays.
        const own = yield* newTask(project, "Own")
        yield* tasks.update(own.id, { preview_url: "https://mine.example" }, Actor.user).pipe(Effect.orDie)
        now = yield* tasks.update(own.id, { pr_url: "https://github.com/o/r/pull/13" }, Actor.user).pipe(Effect.orDie)
        assert.strictEqual(now.preview_url, "https://mine.example")
        // A done task with none gets none.
        const done = yield* newTask(project, "Done")
        yield* tasks.update(done.id, { pr_url: "https://github.com/o/r/pull/14" }, Actor.user).pipe(Effect.orDie)
        yield* tasks.update(done.id, { preview_url: null, status: "done" }, Actor.user).pipe(Effect.orDie)
        // Saving the template moves the previews it made.
        yield* (yield* Projects).update(project.id, { pr_preview_url: "https://preview.example/pr/{pr}" }).pipe(Effect.orDie)
        yield* (yield* Reactor).idle
        assert.deepStrictEqual(
          [(yield* reload(t.id)).preview_url, (yield* reload(own.id)).preview_url, (yield* reload(done.id)).preview_url],
          ["https://preview.example/pr/12", "https://mine.example", null],
        )
      }),
    ),
  )

  it.effect("a preview that can't be reached isn't up", () =>
    onBoard({}, () =>
      Effect.gen(function* () {
        const status = yield* (yield* PullRequests).previewStatus("http://127.0.0.1:1/")
        assert.deepStrictEqual([status.up, status.status, typeof status.error], [false, null, "string"])
      }),
    ),
  )
})
