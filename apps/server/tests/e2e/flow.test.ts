import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber, FileSystem, Option, Schema, Stream } from "effect"
import { RpcClient } from "effect/rpc"
import { TaskChanged } from "@huntaway/contracts"
import type { Task } from "@huntaway/contracts"
import type { FakeGitHubState } from "@huntaway/testing"
import { ensureShim, FAKE_CLAUDE, FAKE_CODEX, fakeGitHub, fakePull, git, tempDir } from "@huntaway/testing"
import { CliRpcs, httpRpcClientLayer } from "../../src/cli/rpc.ts"
import { socketRpcClientLayer, startServer } from "./launch.ts"

// M4's "Shows" line (docs/plan/13-milestones.md) on a whole server: a task goes from To do to Done on its own. Its
// agent (the fake `claude`, or the fake `codex app-server` under `codex-run`) runs in a worktree the board sets up and
// commits; the board finds the task's pull request on (a fake) GitHub as the run ends; a reviewer (the fake claude)
// finds an issue, the agent is sent a round of fixes and commits again, the next review passes and a summary is
// written; moved to Ready for merge, the task's own agent is asked to merge, merges the pull request (the fake gh) and
// marks the task done. The repository's `origin` is fetched from a bare repository in a temp folder and pushes to
// github.com's o/r, so the board takes it for a GitHub repository; nothing here pushes, and every gh call goes to the
// fake GitHub.

const isTask = Schema.is(TaskChanged)
const shim = ensureShim()

/** A repository with one commit on `main`, whose `origin` is a bare repository it was pushed to (fetched from), pushing to o/r on GitHub. */
const repository = Effect.gen(function* () {
  const dir = yield* tempDir
  const bare = `${dir}/origin.git`
  const repo = `${dir}/repo`
  yield* git(dir, ["init", "-q", "--bare", "-b", "main", bare])
  yield* git(dir, ["init", "-q", "-b", "main", repo])
  yield* git(repo, ["commit", "-q", "--allow-empty", "-m", "init"])
  yield* git(repo, ["remote", "add", "origin", bare])
  yield* git(repo, ["push", "-q", "origin", "main"])
  yield* git(repo, ["fetch", "-q", "origin"])
  yield* git(repo, ["remote", "set-url", "--push", "origin", "git@github.com:o/r.git"])
  return repo
})

/** A task's whole way to Done with `agent` as its agent; the reviewer is always the fake claude. */
const toDone = (agent: "claude" | "codex") =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const repo = yield* repository
    const github = yield* fakeGitHub({ accounts: [{ host: "github.com", login: "me", token: "tok-me", active: true }], repos: { "o/r": { pulls: [] } } })
    const { port, token, dataDir } = yield* startServer(["--claude-bin", FAKE_CLAUDE, "--codex-bin", FAKE_CODEX, "--gh-bin", github.bin], {
      HUNTAWAY_FAKE_CLAUDE_MERGE: "pr",
      HUNTAWAY_FAKE_CLAUDE_GH: github.bin,
      FAKE_CODEX_MERGE: "pr",
      FAKE_CODEX_GH: github.bin,
    })
    const http = yield* RpcClient.make(CliRpcs).pipe(Effect.provide(httpRpcClientLayer(`http://127.0.0.1:${port}`, token)))

    // A Claude config for the reviewer; a Codex one for the task when it runs on Codex.
    const claudeHome = `${dataDir}/claude-home`
    yield* fs.makeDirectory(claudeHome, { recursive: true })
    const claude = yield* http["configs.create"]({ config: { name: "Claude", agent: "claude", config_dir: claudeHome } })
    const codexHome = `${dataDir}/codex-home`
    yield* fs.makeDirectory(codexHome, { recursive: true })
    const codex = yield* http["configs.create"]({ config: { name: "Codex", agent: "codex", config_dir: codexHome } })
    const profile = yield* http["profiles.create"]({
      profile: { name: "me", claude_config_ids: [claude.id, codex.id], reviewers: [{ claude_config_id: claude.id, model: null, effort: null }] },
    })
    const project = yield* http["projects.create"]({ project: { profile_id: profile.id, name: "Flow", repo_path: repo } })
    const created = yield* http["tasks.create"]({
      task: {
        profile_id: profile.id,
        project_id: project.id,
        title: "Add a thing",
        // The fake agents' markers: commit on the first run; the reviewer finds an issue in the first round only.
        description: "fake-commit fake-review-fixes-once",
        claude_config_id: agent === "codex" ? codex.id : claude.id,
      },
    })
    // The pull request the agent would open for its branch (the board names it as the worktree's setup will).
    const branch = `ia/${created.key.toLowerCase()}-add-a-thing`
    yield* github.update((s: FakeGitHubState): FakeGitHubState => ({
      ...s,
      repos: { "o/r": { pulls: [fakePull({ number: 7, head: branch, title: "Add a thing" })] } },
    }))

    const after = yield* Effect.gen(function* () {
      const socket = yield* RpcClient.make(CliRpcs)
      /** The task as the board's events give it, until `done` holds of it. */
      const until = (done: (t: Task) => boolean) =>
        socket["board.watch"]({}).pipe(
          Stream.filter((m) => isTask(m) && m.task.id === created.id),
          Stream.map((m) => (isTask(m) ? m.task : created)),
          Stream.filter(done),
          Stream.take(1),
          Stream.runHead,
          Effect.map(Option.getOrThrow),
          Effect.forkChild({ startImmediately: true }),
        )
      // Dropped into In progress, its agent starts.
      const reviewed = yield* until(
        (t) => t.status === "in_review" && !t.running && t.review?.state === "passed" && t.summaries.some((s) => s.state === "done"),
      )
      yield* http["tasks.send"]({ id: created.id, text: "" })
      const inReview = yield* Fiber.join(reviewed)
      // Moved to Ready for merge by the user, its agent merges it.
      const merged = yield* until((t) => t.status === "done")
      yield* http["tasks.update"]({ id: created.id, patch: { status: "ready_for_merge" } })
      const done = yield* Fiber.join(merged)
      return { inReview, done }
    }).pipe(Effect.scoped, Effect.provide(socketRpcClientLayer(port, token)), Effect.timeout("90 seconds"))

    // In review: its worktree and branch, its pull request found, one round of fixes, the review passed.
    assert.strictEqual(after.inReview.worktree_state, "ready")
    assert.strictEqual(after.inReview.branch, branch)
    assert.strictEqual(after.inReview.pr_url, "https://github.com/o/r/pull/7")
    assert.strictEqual(after.inReview.review?.state, "passed")
    const log = yield* git(repo, ["log", "--format=%s", `main..${branch}`])
    assert.isAtLeast(log.split("\n").filter((s) => s !== "").length, 2, `the first run's commit and the fixes' (${log})`)
    // Done: merged by its agent, the pull request merged on GitHub.
    assert.include([null, "done"], after.done.resolution, "merged: done, as done")
    assert.isFalse(after.done.merging)
    assert.strictEqual((yield* github.pull("o/r", 7))?.state, "MERGED")
    const calls = yield* github.calls
    assert.isTrue(
      calls.some((c) => c.args.slice(0, 2).join(" ") === "pr merge"),
      "the agent merged with gh",
    )
  })

describe.skipIf(shim === null)("M4: a task from To do to Done on its own", () => {
  it.live("with Claude as its agent: worktree, agent, pull request, reviewers, a round of fixes, merge", () =>
    toDone("claude").pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )
  it.live("with Codex as its agent", () => toDone("codex").pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
})
