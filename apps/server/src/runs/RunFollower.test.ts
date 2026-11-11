import { assert, describe, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Option, Queue } from "effect"
import type { Scope } from "effect"
import type { SecureRandom } from "effect/crypto"
import type { SqlClient } from "effect/sql"
import { fakeAgent, TestRuns, whileTicking } from "@huntaway/testing"
import { Changes } from "../platform/Changes.ts"
import type { Change } from "../platform/Changes.ts"
import { RunDir } from "./RunDir.ts"
import { FOLDER_REMOVED, RunFollower, SHIM_VANISHED } from "./RunFollower.ts"
import { RunOutput } from "./RunOutput.ts"
import { RunRepo } from "./RunRepo.ts"
import { Shim } from "./Shim.ts"

// A run's follower with the fake agent on the test clock: the lines it hands on, the offset it saves, and when it
// tells the reactor the run has exited. The old runs.test.ts's following cases, over the files.

type Env = RunFollower | RunRepo | RunDir | Shim | Changes | FileSystem.FileSystem | SqlClient.SqlClient | SecureRandom.SecureRandom | Scope.Scope

/** Runs `body` with a follower whose line handler puts each line in `lines`. */
const withLines = <A, E>(body: (lines: Queue.Queue<string>) => Effect.Effect<A, E, Env>) =>
  Effect.gen(function* () {
    const lines = yield* Queue.unbounded<string>()
    const output = Layer.succeed(RunOutput, RunOutput.of({ handle: (_, line) => Queue.offer(lines, line).pipe(Effect.asVoid) }))
    return yield* body(lines).pipe(Effect.provide(TestRuns(output)))
  }).pipe(Effect.scoped)

/** An assistant message saying `text` (plain words), as a line of output. */
const text = (line: string) => `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"${line}"}]}}`
const said = text

const takeLines = (lines: Queue.Queue<string>, n: number) =>
  whileTicking(Effect.forEach(Array.from({ length: n }), () => Queue.take(lines), { concurrency: 1 }))

const exited = Effect.gen(function* () {
  const changes = yield* Changes
  return yield* whileTicking(changes.take)
})

const runExited = (change: Change) => (change._tag === "RunExited" ? change : assert.fail(`expected RunExited, got ${change._tag}`))

describe("RunFollower", () => {
  it.effect("hands on each line in order, saves the offset, and tells of the exit once everything is read", () =>
    withLines((lines) =>
      Effect.gen(function* () {
        const follower = yield* RunFollower
        const repo = yield* RunRepo
        const agent = yield* fakeAgent()
        yield* agent.write([said("one"), said("two")])
        yield* follower.follow(agent.run)
        assert.isTrue(yield* follower.isFollowing(agent.run.id))
        assert.deepStrictEqual(yield* takeLines(lines, 2), [text("one"), text("two")])
        // More while it waits, then the exit with a last line after it.
        yield* agent.write([said("three")])
        assert.deepStrictEqual(yield* takeLines(lines, 1), [text("three")])
        yield* agent.write([said("four")])
        yield* agent.end({ code: 0, signal: null })
        const change = runExited(yield* exited)
        assert.deepStrictEqual([change.run, change.task, change.exit, change.errorTail], [agent.run.id, agent.run.task_id, { code: 0, signal: null }, ""])
        assert.deepStrictEqual(yield* Queue.takeAll(lines), [text("four")])
        const fs = yield* FileSystem.FileSystem
        const size = Number((yield* fs.stat(`${agent.dir}/out.jsonl`)).size)
        assert.strictEqual(Option.getOrThrow(yield* repo.get(agent.run.id)).out_offset, size)
        // Told once: the follower has ended.
        assert.isFalse(yield* follower.isFollowing(agent.run.id))
      }),
    ),
  )

  it.effect("a restarted server goes on from the saved offset", () =>
    withLines((lines) =>
      Effect.gen(function* () {
        const follower = yield* RunFollower
        const before = `${text("one")}\n${text("two")}\n`
        const agent = yield* fakeAgent({ output: `${before}${text("three")}\n`, offset: Buffer.byteLength(before) })
        yield* agent.end()
        yield* follower.follow(agent.run)
        runExited(yield* exited)
        assert.deepStrictEqual(yield* Queue.takeAll(lines), [text("three")])
      }),
    ),
  )

  it.effect("takes in the last line of an exited run whole, and quotes the end of err.log", () =>
    withLines((lines) =>
      Effect.gen(function* () {
        const follower = yield* RunFollower
        const fs = yield* FileSystem.FileSystem
        const agent = yield* fakeAgent({ output: `${text("one")}\n${text("cut")}` })
        yield* fs.writeFileString(`${agent.dir}/err.log`, "it broke\n")
        yield* agent.end({ code: 1, signal: null })
        yield* follower.follow(agent.run)
        const change = runExited(yield* exited)
        assert.deepStrictEqual([change.exit, change.errorTail], [{ code: 1, signal: null }, "it broke\n"])
        assert.deepStrictEqual(yield* Queue.takeAll(lines), [text("one"), text("cut")])
      }),
    ),
  )

  it.effect("ends a run whose shim vanished without writing its exit", () =>
    withLines((lines) =>
      Effect.gen(function* () {
        const follower = yield* RunFollower
        const dir = yield* RunDir
        const agent = yield* fakeAgent({ output: `${text("working")}\n` })
        yield* agent.shimGone
        yield* follower.follow(agent.run)
        const change = runExited(yield* exited)
        assert.deepStrictEqual(change.exit, { code: null, signal: null, error: SHIM_VANISHED })
        // Recorded for a restarted server, as the shim would have.
        assert.deepStrictEqual(yield* dir.exit(agent.run.id), { code: null, signal: null, error: SHIM_VANISHED })
        assert.deepStrictEqual(yield* Queue.takeAll(lines), [text("working")])
      }),
    ),
  )

  // The old "following stops when a deleted task's run folder goes before its exit is seen".
  it.effect("ends a run whose folder was removed", () =>
    withLines((lines) =>
      Effect.gen(function* () {
        const follower = yield* RunFollower
        const dir = yield* RunDir
        const agent = yield* fakeAgent({ output: `${text("working")}\n` })
        yield* follower.follow(agent.run)
        assert.deepStrictEqual(yield* takeLines(lines, 1), [text("working")])
        yield* dir.remove(agent.run.id)
        const change = runExited(yield* exited)
        assert.deepStrictEqual([change.exit, change.errorTail], [{ code: null, signal: null, error: FOLDER_REMOVED }, ""])
      }),
    ),
  )

  it.effect("stopping the follower leaves the agent alone", () =>
    withLines((lines) =>
      Effect.gen(function* () {
        const follower = yield* RunFollower
        const dir = yield* RunDir
        const agent = yield* fakeAgent({ output: `${text("working")}\n` })
        yield* follower.follow(agent.run)
        assert.deepStrictEqual(yield* takeLines(lines, 1), [text("working")])
        yield* follower.stop(agent.run.id)
        assert.isFalse(yield* follower.isFollowing(agent.run.id))
        assert.strictEqual(yield* dir.exit(agent.run.id), null)
        assert.isFalse(yield* agent.inputClosed)
      }),
    ),
  )

  it.effect("tells the line handler when it lets a run go: the run exited, or following it was stopped", () =>
    Effect.gen(function* () {
      const lines = yield* Queue.unbounded<string>()
      const released = yield* Queue.unbounded<string>()
      const output = Layer.succeed(
        RunOutput,
        RunOutput.of({
          handle: (_, line) => Queue.offer(lines, line).pipe(Effect.asVoid),
          released: (run) => Queue.offer(released, run.id).pipe(Effect.asVoid),
        }),
      )
      yield* Effect.gen(function* () {
        const follower = yield* RunFollower
        const ending = yield* fakeAgent({ output: `${text("working")}\n` })
        yield* follower.follow(ending.run)
        assert.deepStrictEqual(yield* takeLines(lines, 1), [text("working")])
        yield* ending.end({ code: 0, signal: null })
        runExited(yield* exited)
        assert.strictEqual(yield* whileTicking(Queue.take(released)), ending.run.id)
        const stopped = yield* fakeAgent({ output: `${text("working")}\n` })
        yield* follower.follow(stopped.run)
        assert.deepStrictEqual(yield* takeLines(lines, 1), [text("working")])
        yield* follower.stop(stopped.run.id)
        assert.strictEqual(yield* Queue.take(released), stopped.run.id)
      }).pipe(Effect.provide(TestRuns(output)))
    }).pipe(Effect.scoped),
  )

  it.effect("tells a vanished shim from a live one", () =>
    withLines(() =>
      Effect.gen(function* () {
        const shim = yield* Shim
        const fs = yield* FileSystem.FileSystem
        const agent = yield* fakeAgent()
        // No shim.pid: not started by a shim this server can check on.
        assert.isFalse(yield* shim.vanished(agent.run.id))
        // Its shim is this process, for the test: alive.
        yield* fs.writeFileString(`${agent.dir}/shim.pid`, String(process.pid))
        assert.isFalse(yield* shim.vanished(agent.run.id))
        // From before a reboot, whatever has its pid now is not its shim.
        yield* fs.writeFileString(`${agent.dir}/run.json`, '{"boot":"a boot before this one","format":6}')
        assert.strictEqual(yield* shim.vanished(agent.run.id), (yield* RunDir).boot !== null)
        yield* agent.shimGone
        assert.isTrue(yield* shim.vanished(agent.run.id))
        // Once it has its exit, it is over, not vanished.
        yield* agent.end()
        assert.isFalse(yield* shim.vanished(agent.run.id))
      }),
    ),
  )
})
