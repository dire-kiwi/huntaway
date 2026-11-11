import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect, FileSystem, Result } from "effect"
import { SqlClient } from "effect/sql"

import type { Project, Task, TaskId } from "@huntaway/contracts"
import { fakeGitHub, fakePull, git, tempDir, TestBoard } from "@huntaway/testing"
import type { FakeGhCall, FakeGitHub, FakeGitHubState } from "@huntaway/testing"
import { Worktrees } from "../git/Worktrees.ts"
import { Actor } from "../platform/Changes.ts"
import { ServerConfig } from "../platform/ServerConfig.ts"
import { Profiles } from "../profiles/Profiles.ts"
import { Projects } from "../projects/Projects.ts"
import { Tasks } from "../tasks/Tasks.ts"
import { Reactor } from "../lifecycle/Reactor.ts"
import { readGraph } from "../workflows/read.ts"
import { WorkflowEngine } from "../workflows/WorkflowEngine.ts"
import { Workflows } from "../workflows/Workflows.ts"
import { WorkflowStore } from "../workflows/WorkflowStore.ts"
import { Threads } from "../threads/Threads.ts"
import { change, reload } from "../mcp/tools/tests/wait.ts"
import { MergedWatcher } from "./MergedWatcher.ts"

// The merged watcher (the old review/merged.test.ts) over the fake GitHub, its checks run by hand. Dropped, with why:
// - in `leaves_tasks_that_are_busy_merging_opted_out_or_in_a_subproject`, the subproject cases: subprojects are gone.
// `builds_one_query_and_reads_its_answer` is in github/prWatch/pr.test.ts.

process.env["GIT_CONFIG_GLOBAL"] = "/dev/null"
process.env["GIT_CONFIG_NOSYSTEM"] = "1"

/** `body` on a board whose gh is the fake GitHub of `state`. */
const onBoard = <A, E, R>(state: FakeGitHubState, body: (fake: FakeGitHub) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fake = yield* fakeGitHub(state)
    return yield* body(fake).pipe(Effect.scoped, Effect.provide(TestBoard({ ghBin: fake.bin })))
  }).pipe(Effect.provide(NodeServices.layer))

/** o/r's pull requests 7 and 8 (and more) in these states, as gh's accounts `me` (github.com) and others. */
const github = (states: Readonly<Record<number, string>>, more: Partial<FakeGitHubState> = {}): FakeGitHubState => ({
  accounts: [{ host: "github.com", login: "me", token: "tok-me", active: true }],
  repos: { "o/r": { pulls: Object.entries(states).map(([n, state]) => fakePull({ number: Number(n), head: `b${n}`, state })) } },
  ...more,
})

/** Pull request `n` of o/r set to `state`. */
const setState = (fake: FakeGitHub, n: number, state: string) =>
  fake.update((s) => {
    const pulls = s.repos?.["o/r"]?.pulls ?? []
    const others = pulls.filter((p) => p.number !== n)
    return { ...s, repos: { ...s.repos, "o/r": { pulls: [...others, fakePull({ number: n, head: `b${n}`, state })] } } }
  })

/** A repository on master with one commit, and a project on it in profile `profile` (made unless given). */
const projectOnRepo = (name: string, profileId?: Project["profile_id"]) =>
  Effect.gen(function* () {
    const repo = `${yield* tempDir}/repo`
    yield* (yield* FileSystem.FileSystem).makeDirectory(repo, { recursive: true }).pipe(Effect.orDie)
    yield* git(repo, ["init", "-q", "-b", "master"])
    yield* git(repo, ["commit", "-q", "--allow-empty", "-m", "init"])
    const profile = profileId ?? (yield* (yield* Profiles).create({ name: `p-${name}` }).pipe(Effect.orDie)).id
    const project = yield* (yield* Projects).create({ profile_id: profile, name, repo_path: repo, base_branch: "master" }).pipe(Effect.orDie)
    return { repo, project }
  })

/** A task in In review on pull request `url`, whose worktree has a commit. */
const taskInReview = (project: Project, url: string) =>
  Effect.gen(function* () {
    const created = yield* (yield* Tasks).create({ project_id: project.id, title: "Do it" }, Actor.user).pipe(Effect.orDie)
    const t = yield* (yield* Worktrees).setup(created.id).pipe(Effect.orDie)
    const wt = t.worktree_path ?? ""
    yield* (yield* FileSystem.FileSystem).writeFileString(`${wt}/a`, "a").pipe(Effect.orDie)
    yield* git(wt, ["add", "a"])
    yield* git(wt, ["commit", "-qm", "a"])
    yield* change(t.id, { status: "in_review", pr_url: url })
    return yield* reload(t.id)
  })

const check = Effect.flatMap(MergedWatcher, (w) => w.check)

/** The states queries gh was given: as whom, on which host, for which pull requests' numbers. */
const queries = (fake: FakeGitHub) =>
  Effect.map(fake.calls, (calls) =>
    calls
      .filter((c: FakeGhCall) => c.args[0] === "api" && c.args[1] === "graphql")
      .map((c) => {
        const host = c.args.includes("--hostname") ? (c.args[c.args.indexOf("--hostname") + 1] ?? "") : "github.com"
        const numbers = c.args.filter((a) => /^p\d+=/.test(a)).map((a) => Number(a.slice(a.indexOf("=") + 1)))
        return [c.as, host, numbers] as const
      }),
  )

/** The texts of the task's thread notices. */
const notices = (id: TaskId) =>
  Effect.map(Effect.flatMap(Threads, (t) => t.stored(id)).pipe(Effect.orDie), (s) => s.entries.flatMap((e) => (e.item.type === "notice" ? [e.item.text] : [])))

/** How many notices say a pull request was closed. */
const closedNotices = (said: ReadonlyArray<string>) => said.filter((e) => e.includes("closed on GitHub")).length

const URL7 = "https://github.com/o/r/pull/7"
const URL8 = "https://github.com/o/r/pull/8"

describe("the merged watcher", () => {
  it.effect("a task whose pull request is merged is done, and its worktree removed", () =>
    onBoard(github({ 7: "OPEN" }), (fake) =>
      Effect.gen(function* () {
        const { repo, project } = yield* projectOnRepo("x")
        const t = yield* taskInReview(project, URL7)
        yield* check
        assert.strictEqual((yield* reload(t.id)).status, "in_review")
        assert.deepStrictEqual(yield* queries(fake), [["me", "github.com", [7]]])

        // Merged on GitHub (squashed, say): its branch isn't in master, so the worktree stays.
        yield* setState(fake, 7, "MERGED")
        yield* check
        const done = yield* reload(t.id)
        assert.deepStrictEqual([done.status, done.resolution, done.worktree_state], ["done", "done", "ready"])
        const said = yield* notices(t.id)
        assert.include(said, "PR #7 was merged on GitHub, so the task is done.")
        assert.isTrue(
          said.some((e) => e.startsWith("The worktree was kept: its work isn't merged into master")),
          said.join("\n"),
        )

        // Done, it isn't read again; moved back by the user, it stays where they put it.
        yield* check
        assert.strictEqual((yield* queries(fake)).length, 2)
        yield* change(t.id, { status: "in_review" })
        yield* check
        assert.strictEqual((yield* queries(fake)).length, 3)
        assert.strictEqual((yield* reload(t.id)).status, "in_review")

        // Another task, whose branch was merged as it is: its worktree goes.
        const t2 = yield* taskInReview(project, URL8)
        yield* git(repo, ["merge", "-q", "--no-ff", "-m", "merge", t2.branch ?? ""])
        yield* setState(fake, 8, "MERGED")
        yield* check
        const done2 = yield* reload(t2.id)
        assert.deepStrictEqual([done2.status, done2.worktree_state], ["done", "none"])
        assert.isFalse(yield* (yield* FileSystem.FileSystem).exists(t2.worktree_path ?? "").pipe(Effect.orDie))
      }),
    ),
  )

  it.effect("a closed pull request flags the task once", () =>
    onBoard(github({ 7: "CLOSED" }), (fake) =>
      Effect.gen(function* () {
        const { project } = yield* projectOnRepo("x")
        const t = yield* taskInReview(project, URL7)
        yield* check
        const flagged = yield* reload(t.id)
        assert.deepStrictEqual([flagged.status, flagged.attention_reason], ["needs_attention", "PR #7 was closed on GitHub without being merged"])
        // Moved back to In review, it isn't flagged again until it's reopened and closed.
        yield* change(t.id, { status: "in_review", attention_reason: null })
        yield* check
        assert.strictEqual((yield* reload(t.id)).status, "in_review")
        yield* setState(fake, 7, "OPEN")
        yield* check
        yield* setState(fake, 7, "CLOSED")
        yield* check
        assert.strictEqual((yield* reload(t.id)).status, "needs_attention")
        assert.strictEqual(closedNotices(yield* notices(t.id)), 2)

        // Already waiting on the user, its reason stays the agent's.
        yield* change(t.id, { attention_reason: "Which colour?" })
        yield* setState(fake, 7, "OPEN")
        yield* check
        yield* setState(fake, 7, "CLOSED")
        yield* check
        const now = yield* reload(t.id)
        assert.deepStrictEqual([now.status, now.attention_reason], ["needs_attention", "Which colour?"])
        assert.strictEqual(closedNotices(yield* notices(t.id)), 3)
      }),
    ),
  )

  it.effect("leaves tasks that are busy, merging or opted out", () =>
    onBoard(github({ 7: "MERGED" }), (fake) =>
      Effect.gen(function* () {
        const { project } = yield* projectOnRepo("x")
        const t = yield* taskInReview(project, URL7)
        // Running, merging, or in a project that turned it off: not read.
        for (const columns of [{ running: true }, { merging: true }]) {
          yield* change(t.id, columns)
          yield* check
          yield* change(t.id, { running: false, merging: false })
        }
        yield* (yield* Projects).update(project.id, { done_when_merged: false }).pipe(Effect.orDie)
        yield* check
        assert.deepStrictEqual(yield* queries(fake), [])
        yield* (yield* Projects).update(project.id, { done_when_merged: true }).pipe(Effect.orDie)
        yield* check
        assert.strictEqual((yield* reload(t.id)).status, "done")
      }),
    ),
  )

  it.effect("reads each account's pull requests together, as that account", () =>
    onBoard(
      github(
        { 1: "OPEN", 2: "MERGED", 3: "OPEN" },
        {
          accounts: [
            { host: "github.com", login: "me", token: "tok-me", active: true },
            { host: "github.com", login: "alice", token: "tok-alice" },
            { host: "acme.ghe.com", login: "bob", token: "tok-bob", active: true },
          ],
        },
      ),
      (fake) =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const work = yield* projectOnRepo("work")
          const home = yield* projectOnRepo("home")
          yield* sql`UPDATE profiles SET github_account = 'alice' WHERE id = ${work.project.profile_id}`.pipe(Effect.orDie)
          const a = yield* taskInReview(work.project, "https://github.com/o/r/pull/1")
          const b = yield* taskInReview(work.project, "https://github.com/o/r/pull/2")
          // The same pull request twice is read once.
          const b2 = yield* taskInReview(work.project, "https://github.com/o/r/pull/2")
          const c = yield* taskInReview(home.project, "https://github.com/o/r/pull/3")
          // An account on another host doesn't read github.com's.
          yield* (yield* Projects).update(home.project.id, { github_account: "acme.ghe.com/bob" }).pipe(Effect.orDie)
          const d = yield* taskInReview(home.project, "https://acme.ghe.com/o/r/pull/4")
          yield* check
          const q = (yield* queries(fake)).toSorted((x, y) => String(x).localeCompare(String(y)))
          assert.deepStrictEqual(q, [
            ["alice", "github.com", [1, 2]],
            ["bob", "acme.ghe.com", [4]],
          ])
          const statuses: Array<Task["status"]> = []
          for (const t of [a, b, b2, c, d]) statuses.push((yield* reload(t.id)).status)
          assert.deepStrictEqual(statuses, ["in_review", "done", "done", "in_review", "in_review"])
        }),
    ),
  )

  // HA-262: each read left gh's config for the account, which holds its token, on disk (a folder every poll).
  it.effect("reading as an account leaves no copy of its token", () =>
    onBoard(github({ 7: "OPEN" }, { accounts: [{ host: "github.com", login: "alice", token: "tok-alice" }] }), (fake) =>
      Effect.gen(function* () {
        const { project } = yield* projectOnRepo("x")
        yield* (yield* Projects).update(project.id, { github_account: "alice" }).pipe(Effect.orDie)
        const t = yield* taskInReview(project, URL7)
        yield* check
        assert.strictEqual((yield* reload(t.id)).status, "in_review")
        assert.deepStrictEqual(yield* queries(fake), [["alice", "github.com", [7]]])
        const root = `${(yield* ServerConfig).cacheDir}/huntaway/gh-account`
        assert.deepStrictEqual(yield* (yield* FileSystem.FileSystem).readDirectory(root).pipe(Effect.orDie), [])
      }),
    ),
  )

  // HA-262 (6.6): a task its pull request moved to Done (or Needs attention) starts the workflows that start when a task
  // enters that column, as moving it there does: the watcher moves it with `Tasks.change`, and the reactor sees it.
  it.effect("a task its pull request moves starts the workflows of its new column", () =>
    onBoard(github({ 7: "OPEN", 8: "OPEN" }), (fake) =>
      Effect.gen(function* () {
        const { project } = yield* projectOnRepo("x")
        const a = yield* taskInReview(project, URL7)
        const b = yield* taskInReview(project, URL8)
        const sql = yield* SqlClient.SqlClient
        yield* sql`UPDATE projects SET use_workflows = 1 WHERE id = ${project.id}`.pipe(Effect.orDie)
        // A step after the column: a column with nothing after it runs nothing.
        const on = (status: string) =>
          Effect.gen(function* () {
            const graph = readGraph({
              nodes: [
                { id: "t", kind: "column", status },
                { id: "c", kind: "condition", check: "has_pr" },
              ],
              edges: [{ from: "t", port: "done", to: "c" }],
            })
            if (Result.isFailure(graph)) return yield* Effect.die(graph.failure)
            return yield* (yield* Workflows).create({ project_id: project.id, name: status, graph: graph.success }).pipe(Effect.orDie)
          })
        const done = yield* on("done")
        const flagged = yield* on("needs_attention")
        yield* setState(fake, 7, "MERGED")
        yield* setState(fake, 8, "CLOSED")
        yield* check
        for (let i = 0; i < 4; i++) {
          yield* (yield* Reactor).idle
          yield* (yield* WorkflowEngine).idle
        }
        assert.deepStrictEqual([(yield* reload(a.id)).status, (yield* reload(b.id)).status], ["done", "needs_attention"])
        const store = yield* WorkflowStore
        const ran = (w: { readonly id: string }, t: TaskId) => Effect.map(store.runsOfTask(t), (rs) => rs.find((r) => r.workflow_id === w.id)?.state ?? null)
        assert.deepStrictEqual(
          [yield* ran(done, a.id), yield* ran(flagged, b.id), yield* ran(done, b.id), yield* ran(flagged, a.id)],
          ["done", "done", null, null],
        )
      }),
    ),
  )
})
