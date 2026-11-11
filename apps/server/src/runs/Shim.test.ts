import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Queue, Stream } from "effect"
import type { Scope } from "effect"
import type { SecureRandom } from "effect/crypto"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import type { SqlClient } from "effect/sql"
import { ensureShim, fakeAgent, fakeTask, TestRuns, whileTicking } from "@huntaway/testing"
import { RunId, Timestamp } from "@huntaway/contracts"
import type { LaunchSpec } from "../agents/AgentDriver.ts"
import { Changes } from "../platform/Changes.ts"
import type { Change } from "../platform/Changes.ts"
import { SERVE_ENV } from "../platform/ServerConfig.ts"
import type { ServerConfigShape } from "../platform/ServerConfig.ts"
import { RunDir } from "./RunDir.ts"
import { RunFollower, SHIM_VANISHED } from "./RunFollower.ts"
import { RunOutput } from "./RunOutput.ts"
import { RunRepo } from "./RunRepo.ts"
import { Shim } from "./Shim.ts"
import type { ShimFailed } from "./Shim.ts"

// ia-shim for real (built with cargo; skipped without it), with trivial programs as agents, and the signals the server
// sends a run's process group. The old runs.test.ts's launch and stop cases.

const SHIM = ensureShim()

type Env =
  | Shim
  | RunDir
  | RunRepo
  | RunFollower
  | Changes
  | FileSystem.FileSystem
  | ChildProcessSpawner.ChildProcessSpawner
  | SqlClient.SqlClient
  | SecureRandom.SecureRandom
  | Scope.Scope

/** Runs `body` on the runs area, with the built shim, a follower whose handler puts each line in `lines`. */
const withShim = <A, E>(body: (lines: Queue.Queue<string>) => Effect.Effect<A, E, Env>, config: Partial<ServerConfigShape> = {}) =>
  Effect.gen(function* () {
    const lines = yield* Queue.unbounded<string>()
    const output = Layer.succeed(RunOutput, RunOutput.of({ handle: (_, line) => Queue.offer(lines, line).pipe(Effect.asVoid) }))
    return yield* body(lines).pipe(Effect.provide(TestRuns(output, { shimBin: SHIM, ...config })))
  }).pipe(Effect.scoped)

/** A run's row and folder written for `spec`, not yet started. */
const prepared = (spec: Partial<LaunchSpec> & Pick<LaunchSpec, "program">) =>
  Effect.gen(function* () {
    const repo = yield* RunRepo
    const dir = yield* RunDir
    const fs = yield* FileSystem.FileSystem
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "huntaway-run-" })
    const task = yield* fakeTask
    const run = yield* repo.insert({ id: RunId.make(`run-${task}`), task_id: task, kind: "prompt", created_at: Timestamp.make("2026-11-12T00:00:00.000Z") })
    const full: LaunchSpec = {
      args: [],
      env: [],
      cwd,
      configDir: null,
      prompt: "",
      input: false,
      promptId: null,
      systemPrompt: null,
      mcpServers: null,
      mcpRun: null,
      ...spec,
    }
    yield* dir.prepare(run.id, full)
    return { run, spec: full }
  })

const exited = Effect.gen(function* () {
  const changes = yield* Changes
  return yield* changes.take
})
const runExited = (change: Change) => (change._tag === "RunExited" ? change : assert.fail(`expected RunExited, got ${change._tag}`))

/** Why a launch failed. */
const failure = <A, R>(effect: Effect.Effect<A, ShimFailed, R>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((e) => e.reason),
  )

/** A process in a process group of its own, as ia-shim starts an agent, that has run `script` up to printing "ready". */
const agentProcess = (script: string) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const handle = yield* spawner.spawn(ChildProcess.make("sh", ["-c", script], { detached: true, stdin: "ignore", stderr: "ignore" }))
    yield* handle.stdout.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.filter((line) => line === "ready"),
      Stream.take(1),
      Stream.runDrain,
    )
    return handle
  }).pipe(Effect.orDie)

/** Set variables in this process's environment; returns what puts them back. */
const setEnv = (set: Readonly<Record<string, string>>) => {
  const before = Object.fromEntries(Object.keys(set).map((k) => [k, process.env[k]]))
  Object.assign(process.env, set)
  return () => {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

describe.skipIf(SHIM === null)("Shim (needs cargo to build ia-shim)", () => {
  it.live("relays the prompt and then the input to the agent, and records how it exited", () =>
    withShim((lines) =>
      Effect.gen(function* () {
        const shim = yield* Shim
        const dir = yield* RunDir
        const follower = yield* RunFollower
        const { run, spec } = yield* prepared({ program: "cat", prompt: "hello\n", input: true })
        yield* shim.spawn(run.id, spec)
        const pids = yield* dir.pids(run.id)
        assert.isTrue(pids.agent !== null && pids.shim !== null)
        yield* follower.follow(run)
        assert.strictEqual(yield* Queue.take(lines), "hello")
        assert.isTrue(yield* dir.appendInput(run.id, '{"type":"user"}'))
        assert.strictEqual(yield* Queue.take(lines), '{"type":"user"}')
        yield* dir.closeInput(run.id)
        const change = runExited(yield* exited)
        assert.deepStrictEqual(change.exit, { code: 0, signal: null })
        // Started once.
        assert.include(yield* failure(shim.spawn(run.id, spec)), "was already started")
      }),
    ),
  )

  it.live("fails a launch the shim could not start, or that has nowhere to run", () =>
    withShim(() =>
      Effect.gen(function* () {
        const shim = yield* Shim
        const missing = yield* prepared({ program: "/nonexistent/claude" })
        assert.include(yield* failure(shim.spawn(missing.run.id, missing.spec)), "failed to start /nonexistent/claude")
        const nowhere = yield* prepared({ program: "true", cwd: "/nonexistent/folder" })
        assert.include(yield* failure(shim.spawn(nowhere.run.id, nowhere.spec)), "working directory /nonexistent/folder does not exist")
      }),
    ),
  )

  it.live("says where to get ia-shim when there is none", () =>
    withShim(
      () =>
        Effect.gen(function* () {
          const shim = yield* Shim
          const { run, spec } = yield* prepared({ program: "true" })
          assert.include(yield* failure(shim.spawn(run.id, spec)), "ia-shim not found")
        }),
      { shimBin: "/nonexistent/ia-shim" },
    ),
  )

  // HA-185: a service's or the desktop app's settings for `huntaway serve` must not reach a server the agent starts.
  it.live("an agent's run doesn't get the server's own settings", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const bin = yield* fs.makeTempDirectoryScoped({ prefix: "huntaway-shim-" })
      // A stand-in ia-shim (`ia-shim <run dir> -- <program> <args>`) that writes down the environment it was started with.
      const stand = `${bin}/shim`
      yield* fs.writeFileString(stand, `#!/bin/sh\nenv > "$1/env.txt"\necho $$ > "$1/pid"\n`, { mode: 0o755 })
      const set: Record<string, string> = {
        HA185_KEPT: "yes",
        HUNTAWAY_CLAUDE_BIN: "/bin/true",
        ...Object.fromEntries(SERVE_ENV.map((k) => [k, `from-the-server-${k}`])),
      }
      yield* Effect.acquireRelease(
        Effect.sync(() => setEnv(set)),
        (restore) => Effect.sync(restore),
      )
      const env = yield* withShim(
        () =>
          Effect.gen(function* () {
            const shim = yield* Shim
            const dir = yield* RunDir
            const { run, spec } = yield* prepared({ program: "true", env: [["HUNTAWAY_FROM_LAUNCH", "1"]] })
            yield* shim.spawn(run.id, spec)
            return yield* fs.readFileString(`${dir.path(run.id)}/env.txt`)
          }),
        { shimBin: stand },
      )
      const vars = new Map(
        env
          .split("\n")
          .filter(Boolean)
          .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
      )
      for (const k of SERVE_ENV) assert.isUndefined(vars.get(k), `${k} reached the agent`)
      assert.strictEqual(vars.get("HA185_KEPT"), "yes")
      assert.strictEqual(vars.get("HUNTAWAY_CLAUDE_BIN"), "/bin/true")
      assert.strictEqual(vars.get("HUNTAWAY_FROM_LAUNCH"), "1")
      assert.isTrue((vars.get("PATH") ?? "") !== "")
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )

  it.live("stops a run's agent with SIGTERM to its process group", () =>
    withShim(() =>
      Effect.gen(function* () {
        const shim = yield* Shim
        const follower = yield* RunFollower
        const { run, spec } = yield* prepared({ program: "sleep", args: ["30"] })
        yield* shim.spawn(run.id, spec)
        yield* follower.follow(run)
        assert.isTrue(yield* shim.kill(run.id))
        assert.deepStrictEqual(runExited(yield* exited).exit, { code: null, signal: 15 })
        // Nothing left to stop.
        assert.isFalse(yield* shim.kill(run.id))
      }),
    ),
  )

  // HA-341: stopping a run from before a reboot signalled whatever process group now had its agent's pid.
  it.live("a run from before a reboot isn't signalled", () =>
    withShim(() =>
      Effect.gen(function* () {
        const shim = yield* Shim
        const fs = yield* FileSystem.FileSystem
        const other = yield* agentProcess("echo ready; exec sleep 30")
        const agent = yield* fakeAgent()
        yield* fs.writeFileString(`${agent.dir}/pid`, String(other.pid))
        yield* fs.writeFileString(`${agent.dir}/run.json`, '{"boot":"a boot before this one","format":6}')
        assert.isFalse(yield* shim.kill(agent.run.id))
        assert.isTrue(yield* shim.isAlive(other.pid))
      }),
    ),
  )

  // The old "an agent that outlives its shim is stopped": the follower ends the run and stops its agent.
  it.effect("an agent that outlives its shim is stopped", () =>
    withShim(() =>
      Effect.gen(function* () {
        const follower = yield* RunFollower
        const fs = yield* FileSystem.FileSystem
        const orphan = yield* agentProcess("echo ready; exec sleep 60")
        const agent = yield* fakeAgent()
        yield* fs.writeFileString(`${agent.dir}/pid`, String(orphan.pid))
        // Its shim was killed (by hand, or by the OOM killer).
        yield* agent.shimGone
        yield* follower.follow(agent.run)
        assert.deepStrictEqual(runExited(yield* whileTicking(exited)).exit, { code: null, signal: null, error: SHIM_VANISHED })
        // Stopped: its process ends.
        yield* whileTicking(orphan.exitCode.pipe(Effect.ignore))
      }),
    ),
  )

  it.effect("an orphan that ignores SIGTERM is killed after its grace", () =>
    withShim(() =>
      Effect.gen(function* () {
        const shim = yield* Shim
        const dir = yield* RunDir
        const fs = yield* FileSystem.FileSystem
        const orphan = yield* agentProcess("trap '' TERM; echo ready; exec sleep 60")
        const agent = yield* fakeAgent()
        yield* fs.writeFileString(`${agent.dir}/pid`, String(orphan.pid))
        yield* whileTicking(shim.stopOrphan(agent.run.id), "1 second")
        assert.isFalse(yield* dir.marker(agent.run.id, "orphan"))
        assert.isFalse(yield* shim.isAlive(-Number(orphan.pid)))
      }),
    ),
  )
})
