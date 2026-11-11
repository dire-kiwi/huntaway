import { assert, describe, it } from "@effect/vitest"
import { Effect, Option } from "effect"
import type { Scope } from "effect"
import { SecureRandom } from "effect/crypto"
import type { SqlClient } from "effect/sql"
import { fakeTask, TestRuns } from "@huntaway/testing"
import { RunId, Timestamp } from "@huntaway/contracts"
import type { TaskId } from "@huntaway/contracts"
import type { RunKind } from "./Run.ts"
import { RunRepo } from "./RunRepo.ts"

// The runs table. The cost cases are the old output.test.ts's "a run that resumes a session is charged only what it
// adds" (HA-108) and schema.test.ts's last `add_cost`, at the repository, which is where the rule lives now.

const AT = Timestamp.make("2026-11-12T00:00:00.000Z")

const run = <A, E>(effect: Effect.Effect<A, E, RunRepo | SqlClient.SqlClient | SecureRandom.SecureRandom | Scope.Scope>) =>
  effect.pipe(Effect.scoped, Effect.provide(TestRuns()))

const newRun = (task: TaskId, kind: RunKind = "prompt") =>
  Effect.gen(function* () {
    const repo = yield* RunRepo
    const random = yield* SecureRandom.SecureRandom
    return yield* repo.insert({ id: RunId.make(yield* random.uuidV4()), task_id: task, kind, created_at: AT })
  })

const close = (a: number, b: number) => Math.abs(a - b) < 1e-9

describe("RunRepo", () => {
  it.effect("a run is inserted preparing, and the latest and later runs go by the order they started", () =>
    run(
      Effect.gen(function* () {
        const repo = yield* RunRepo
        const task = yield* fakeTask
        const first = yield* newRun(task)
        assert.deepStrictEqual([first.phase, first.out_offset, first.stop, first.between_turns, first.cost_usd], ["preparing", 0, "none", false, 0])
        assert.isTrue(first.isLive && first.acceptsInput)
        const compact = yield* newRun(task, "compact")
        assert.isFalse(compact.acceptsInput)
        assert.isTrue(yield* repo.laterThan(first))
        assert.isFalse(yield* repo.laterThan(compact))
        assert.strictEqual(Option.getOrThrow(yield* repo.latest(task)).id, compact.id)
        assert.strictEqual(Option.getOrThrow(yield* repo.latest(task, "prompt")).id, first.id)
        assert.deepStrictEqual(
          (yield* repo.active).map((r) => r.id),
          [first.id, compact.id],
        )
        yield* repo.setPhase(first.id, "running")
        assert.isTrue(yield* repo.end(first.id, AT))
        // Ending it again changes nothing.
        assert.isFalse(yield* repo.end(first.id, AT))
        const ended = Option.getOrThrow(yield* repo.get(first.id))
        assert.deepStrictEqual([ended.phase, ended.ended_at, ended.isLive], ["exited", AT, false])
        assert.deepStrictEqual(
          (yield* repo.active).map((r) => r.id),
          [compact.id],
        )
        assert.isTrue(yield* repo.hasActive(task))
        yield* repo.end(compact.id, AT)
        assert.isFalse(yield* repo.hasActive(task))
      }),
    ),
  )

  it.effect("saves the offset and the progress columns", () =>
    run(
      Effect.gen(function* () {
        const repo = yield* RunRepo
        const r = yield* newRun(yield* fakeTask)
        assert.strictEqual(yield* repo.saveOffset(r.id, 1234), 1234)
        yield* repo.update(r.id, { between_turns: true, saw_result: true, result_error: "boom", stop: "requested", stop_id: "stop-1", turn_tokens: 99 })
        const row = Option.getOrThrow(yield* repo.get(r.id))
        assert.deepStrictEqual(
          [row.out_offset, row.between_turns, row.saw_result, row.result_error, row.stop, row.stop_id, row.turn_tokens, row.finished],
          [1234, true, true, "boom", "requested", "stop-1", 99, false],
        )
      }),
    ),
  )

  // HA-238: a thread goes on in the folder its conversation started in.
  it.effect("a session's folder is its first run's", () =>
    run(
      Effect.gen(function* () {
        const repo = yield* RunRepo
        const task = yield* fakeTask
        const first = yield* newRun(task)
        yield* repo.update(first.id, { config_dir: "/a", session_id: "s1", board_tools: true })
        // A later run that resumed it somewhere else doesn't move it.
        const later = yield* newRun(task)
        yield* repo.update(later.id, { config_dir: "/b", session_id: "s1" })
        const fresh = yield* newRun(task)
        yield* repo.update(fresh.id, { config_dir: "", session_id: "s2" })
        assert.deepStrictEqual(yield* repo.sessionConfigDir(task, "s1"), Option.some("/a"))
        assert.deepStrictEqual(yield* repo.sessionConfigDir(task, "s2"), Option.some(""))
        // A session from before runs kept their folder.
        assert.deepStrictEqual(yield* repo.sessionConfigDir(task, "s3"), Option.none())
        assert.deepStrictEqual([yield* repo.sessionBoardTools(task, "s1"), yield* repo.sessionBoardTools(task, "s2")], [true, false])
      }),
    ),
  )

  // HA-108: Claude Code's total for a session it resumes goes on from what the session's earlier runs cost.
  it.effect("a run that resumes a session is charged only what it adds", () =>
    run(
      Effect.gen(function* () {
        const repo = yield* RunRepo
        const task = yield* fakeTask
        const cost = (r: RunId) => repo.get(r).pipe(Effect.map((row) => Option.getOrThrow(row).cost_usd))
        const charged = (r: RunId, session: string | null, total: number, counted = true) => repo.addCost(r, session, total, counted)

        // Two turns of a session.
        const first = yield* newRun(task)
        assert.isTrue(close(yield* charged(first.id, "s1", 1.0), 1.0))
        assert.isTrue(close(yield* charged(first.id, "s1", 1.5), 0.5))
        assert.isTrue(close(yield* cost(first.id), 1.5))
        // A run that resumes it: its first total goes on from 1.5.
        const resumed = yield* newRun(task, "compact")
        assert.isTrue(close(yield* charged(resumed.id, "s1", 1.75), 0.25))
        const again = yield* newRun(task)
        yield* charged(again.id, "s1", 2.0)
        yield* charged(again.id, "s1", 2.5)
        assert.isTrue(close(yield* cost(again.id), 0.75))
        // A turn that failed before the model counted anything says a total of 0: it charges nothing, and the next run
        // goes on from the last total.
        const failed = yield* newRun(task)
        assert.strictEqual(yield* charged(failed.id, "s1", 0, false), 0)
        assert.strictEqual(yield* cost(failed.id), 0)
        const next = yield* newRun(task)
        assert.isTrue(close(yield* charged(next.id, "s1", 2.75), 0.25))

        // A new session starts from nothing, even after a run that started it and ended before its first result.
        const killed = yield* newRun(task)
        yield* repo.update(killed.id, { session_id: "s2" })
        const fresh = yield* newRun(task)
        assert.isTrue(close(yield* charged(fresh.id, "s2", 3.0), 3.0))
        // So does a session whose total went down: Claude Code started counting again.
        const lower = yield* newRun(task)
        assert.isTrue(close(yield* charged(lower.id, "s2", 0.5), 0.5))
        assert.isTrue(close(yield* charged(lower.id, "s2", 0.75), 0.25))
        assert.isTrue(close(yield* cost(lower.id), 0.75))
        // The next run of the session goes on from its last total (schema.test.ts's last case).
        const after = yield* newRun(task)
        assert.isTrue(close(yield* charged(after.id, "s2", 1.2), 0.45))
        // A result with no session (a run that never said its init) goes on from the run's own last total.
        const unnamed = yield* newRun(task)
        assert.isTrue(close(yield* charged(unnamed.id, null, 0.3), 0.3))
        assert.isTrue(close(yield* charged(unnamed.id, null, 0.4), 0.1))
        assert.strictEqual(Option.getOrThrow(yield* repo.get(unnamed.id)).session_cost, 0.4)
      }),
    ),
  )
})
