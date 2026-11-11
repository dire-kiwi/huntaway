import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber, FileSystem, Result } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { SqlClient } from "effect/sql"
import { TaskId } from "@huntaway/contracts"
import { fakeGitHub, git, tempDir } from "@huntaway/testing"
import type { FakeGitHub } from "@huntaway/testing"
import type { ServerConfigShape } from "../platform/ServerConfig.ts"
import { Threads } from "../threads/Threads.ts"
import { OpenPrTarget } from "./engine/core.ts"
import { readGraph } from "./read.ts"
import { agentFinishes, AT, engine, make, onBoard, PROJECT, runsOf, setTask, task, TASK, workable } from "./tests/board.ts"
import { Workflows } from "./Workflows.ts"

// Pull request steps (huntaway's integrations/workflows/pull_requests.test.ts): pushing the branch and opening it, and
// the preset that does so when the agent is done. gh is the fake GitHub's; the push goes over SSH to a bare repository
// through the user's own SSH command (which the gh tools leave as it is: they don't push to a path on this machine).
// Where it pushes and opens is `OpenPrTarget` (the old `engine_testing.GITHUB`).

const TARGET = { remote: "origin", repo: "o/r" }

/** Git without the user's configuration, its SSH command serving pushes from `bare`. */
const sshTo = (dir: string, bare: string) =>
  Effect.gen(function* () {
    const ssh = `${dir}/fake-ssh`
    const fs = yield* FileSystem.FileSystem
    yield* fs.writeFileString(ssh, `#!/bin/sh\nexec git receive-pack '${bare}'\n`)
    yield* fs.chmod(ssh, 0o755)
    return { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_SSH_COMMAND: ssh, GIT_SSH_VARIANT: "ssh" }
  }).pipe(Effect.orDie)

/** A bare repository to push to, and the board's config to push there with the fake GitHub's gh (`gh` if given). */
const remote = (fake: FakeGitHub, gh?: string) =>
  Effect.gen(function* () {
    const dir = yield* tempDir
    const bare = `${dir}/remote.git`
    yield* git(dir, ["init", "-q", "--bare", bare])
    const config: Partial<ServerConfigShape> = { ghBin: gh ?? fake.bin, agentEnv: yield* sshTo(dir, bare) }
    return { bare, config }
  })

/** The task's worktree pushes to `origin` over SSH. */
const withOrigin = (dir: string) => git(dir, ["remote", "add", "origin", "ssh://git@example.invalid/o/r.git"])

/** The agent's last message in the task's thread. */
const says = (text: string) =>
  Effect.flatMap(Threads, (threads) => threads.appendFromAgent(TASK, [{ type: "item.added", item: { id: "said-1", type: "assistant_message", text } }])).pipe(
    Effect.orDie,
  )

const graphOf = (g: unknown) => {
  const read = readGraph(g)
  return Result.isSuccess(read) ? Effect.succeed(read.success) : Effect.die(read.failure)
}

describe("pull request steps", () => {
  it.effect("a pull request step pushes the branch and opens it", () =>
    Effect.gen(function* () {
      const fake = yield* fakeGitHub({ repos: { "o/r": { pulls: [] } } })
      const { bare, config } = yield* remote(fake)
      yield* onBoard(
        Effect.gen(function* () {
          const dir = yield* workable({ status: "in_progress" })
          yield* withOrigin(dir)
          yield* says("Fixed the thing.")
          const w = yield* make({
            nodes: [
              { id: "t", kind: "trigger", on: "manual" },
              { id: "pr", kind: "open_pr", title: "{{task.key}}: {{task.title}}", draft: true },
              { id: "m", kind: "set_status", status: "in_review" },
            ],
            edges: [
              { from: "t", port: "out", to: "pr" },
              { from: "pr", port: "opened", to: "m" },
              { from: "pr", port: "exists", to: "m" },
            ],
          })
          const eng = yield* engine
          const run = eng.run(w.id, TASK).pipe(Effect.provideService(OpenPrTarget, TARGET))
          const url = "https://github.com/o/r/pull/1"
          const first = yield* run
          assert.deepStrictEqual([first.nodes["pr"]?.state, first.nodes["pr"]?.port, first.nodes["pr"]?.text], ["done", "opened", url])
          const t = yield* task()
          assert.deepStrictEqual([t.pr_url, t.status], [url, "in_review"])
          const pull = yield* fake.pull("o/r", 1)
          assert.deepStrictEqual(
            [pull?.title, pull?.body, pull?.base, pull?.head, pull?.isDraft],
            ["X-1: Fix the thing", "Fixed the thing.", "main", "ia/x-1", true],
          )
          assert.match(yield* git(bare, ["rev-parse", "--verify", "refs/heads/ia/x-1"]), /^[0-9a-f]{40}$/)
          // Once it has one, the step finds it.
          assert.strictEqual((yield* run).nodes["pr"]?.port, "exists")
          // A branch without commits of its own has nothing to open one for.
          yield* setTask(TASK, { pr_url: null, branch: "main" })
          yield* git(dir, ["checkout", "-q", "main"])
          const none = (yield* run).nodes["pr"]
          assert.strictEqual(none?.port, "failed")
          assert.include(none?.text ?? "", "no commits of its own")
          // Moved to Needs attention, the task says why.
          const graph = yield* graphOf({
            nodes: [
              { id: "t", kind: "trigger", on: "manual" },
              { id: "pr", kind: "open_pr" },
              { id: "m", kind: "set_status", status: "needs_attention" },
            ],
            edges: [
              { from: "t", port: "out", to: "pr" },
              { from: "pr", port: "failed", to: "m" },
            ],
          })
          yield* (yield* Workflows).update(w.id, { graph })
          yield* run
          const flagged = yield* task()
          assert.strictEqual(flagged.status, "needs_attention")
          assert.isTrue(
            (flagged.attention_reason ?? "").startsWith(`The workflow "Review" failed at Open a pull request: the task's branch has no commits`),
            flagged.attention_reason ?? "",
          )
        }),
        config,
      )
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )

  // HA-341: one lock for the whole host was held while a run went on, so a slow push held up every task's workflows.
  it.effect("a slow pull request step doesn't hold up other tasks' workflows", () =>
    Effect.gen(function* () {
      const fake = yield* fakeGitHub({ repos: { "o/r": { pulls: [] } } })
      // `gh pr create` says it started, then waits to be let go: each through a FIFO, which blocks until the other end opens.
      const dir = yield* tempDir
      const [started, go, gh] = [`${dir}/started`, `${dir}/go`, `${dir}/gh`]
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      yield* spawner.string(ChildProcess.make("mkfifo", [started, go])).pipe(Effect.orDie)
      const fs = yield* FileSystem.FileSystem
      yield* fs.writeFileString(gh, `#!/bin/sh\ncase " $* " in *" create "*) echo started > '${started}'; read x < '${go}';; esac\nexec '${fake.bin}' "$@"\n`)
      yield* fs.chmod(gh, 0o755)
      const { config } = yield* remote(fake, gh)
      yield* onBoard(
        Effect.gen(function* () {
          yield* withOrigin(yield* workable())
          const pr = yield* make({
            nodes: [
              { id: "t", kind: "trigger", on: "manual" },
              { id: "pr", kind: "open_pr" },
            ],
            edges: [{ from: "t", port: "out", to: "pr" }],
          })
          const eng = yield* engine
          const slow = yield* Effect.forkChild(eng.run(pr.id, TASK).pipe(Effect.provideService(OpenPrTarget, TARGET)))
          const sql = yield* SqlClient.SqlClient
          const other = TaskId.make("t2")
          yield* sql`INSERT INTO tasks ${sql.insert({
            id: other,
            profile_id: "p",
            project_id: PROJECT,
            number: 2,
            title: "Other",
            status: "todo",
            last_activity_at: AT,
            created_at: AT,
            updated_at: AT,
          })}`.pipe(Effect.orDie)
          const move = yield* make(
            {
              nodes: [
                { id: "t", kind: "trigger", on: "manual" },
                { id: "m", kind: "set_status", status: "in_review" },
              ],
              edges: [{ from: "t", port: "out", to: "m" }],
            },
            "Move",
          )
          // The pull request is being opened: the other task's workflow runs meanwhile.
          yield* fs.readFileString(started).pipe(Effect.orDie)
          yield* eng.run(move.id, other)
          assert.strictEqual((yield* task(other)).status, "in_review")
          yield* fs.writeFileString(go, "go\n").pipe(Effect.orDie)
          assert.strictEqual((yield* Fiber.join(slow)).nodes["pr"]?.port, "opened")
        }),
        config,
      )
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )

  // Review of HA-276: a task without a worktree stayed in In progress, idle, as the preset's check failed and skipped the rest.
  it.effect("a task without a worktree goes to review with the pull request preset", () =>
    onBoard(
      Effect.gen(function* () {
        yield* workable({ status: "in_progress", task: { worktree_path: null, worktree_state: "none", branch: null } })
        // The "Open a PR when done" preset (the web app's settings/workflows/presets.ts).
        const w = yield* make({
          nodes: [
            { id: "start", kind: "trigger", on: "finished" },
            { id: "commits", kind: "condition", check: "has_commits" },
            { id: "pr", kind: "open_pr" },
            { id: "review", kind: "set_status", status: "in_review" },
            { id: "attention", kind: "set_status", status: "needs_attention" },
          ],
          edges: [
            { from: "start", port: "out", to: "commits" },
            { from: "commits", port: "yes", to: "pr" },
            { from: "commits", port: "no", to: "review" },
            { from: "pr", port: "opened", to: "review" },
            { from: "pr", port: "exists", to: "review" },
            { from: "pr", port: "failed", to: "attention" },
          ],
        })
        yield* agentFinishes()
        const t = yield* task()
        // The run its agent finishing started.
        const run = (yield* runsOf(w)).find((r) => r.source === "finished")
        assert.deepStrictEqual([run?.nodes["commits"]?.port, run?.nodes["pr"]?.state], ["no", "skipped"])
        assert.deepStrictEqual([t.status, t.running], ["in_review", false])
      }),
    ),
  )
})
