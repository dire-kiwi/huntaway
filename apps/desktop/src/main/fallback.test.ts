import { assert, describe, it } from "@effect/vitest"
import { Effect, Ref } from "effect"
import { NoServer, StartFailed, startWithFallback } from "./fallback.ts"

// The old shell's startWithFallback tests (desktop-versions.test.ts): a failed start is blamed on its version only after
// another server came up.

type Outcome = "ok" | "exit" | "slow" | "backup"

interface Run {
  readonly order: ReadonlyArray<string>
  readonly servers: Readonly<Record<string, Outcome>>
  readonly failed?: ReadonlyArray<string>
  readonly portTaken?: (started: ReadonlyArray<string | null>) => boolean
  readonly stopping?: Ref.Ref<boolean>
}

/**
 * startWithFallback over `servers`: version → what starting it does ("ok", "exit" before it's ready, "slow" for a
 * timeout, "backup" for a server that couldn't back up the database), with the bundled server as "bundled". A slow
 * start's `lateReady` is kept, to be run as its late ready line.
 */
const fallback = (run: Run) =>
  Effect.gen(function* () {
    const started = yield* Ref.make<ReadonlyArray<string | null>>([])
    const saved = yield* Ref.make<ReadonlyArray<string>>([])
    const failed = yield* Ref.make(run.failed ?? [])
    const late = yield* Ref.make<ReadonlyArray<Effect.Effect<void>>>([])
    const result = yield* startWithFallback({
      choose: (skip) => Effect.succeed({ version: run.order.find((v) => !skip.includes(v)) ?? null }),
      start: ({ version }, lateReady) =>
        Effect.gen(function* () {
          yield* Ref.update(started, (s) => [...s, version])
          const what = run.servers[version ?? "bundled"]
          if (what === "ok") return `token-${version}`
          if (what === "slow") yield* Ref.update(late, (l) => [...l, lateReady])
          return yield* new StartFailed({
            message: what ?? "missing",
            early: what === "exit" || what === "backup",
            backup: what === "backup" ? { reason: "space", why: "No space left", dir: "/backups" } : null,
          })
        }),
      portTaken: Effect.map(Ref.get(started), (s) => run.portTaken?.(s) ?? false),
      failed,
      saveBad: (v) => Ref.update(saved, (s) => [...s, v]),
      stopping: run.stopping === undefined ? Effect.succeed(false) : Ref.get(run.stopping),
    }).pipe(Effect.result)
    return { result, started: yield* Ref.get(started), saved, failed, late: yield* Ref.get(late) }
  })

describe("startWithFallback", () => {
  it.effect("a version that exits before it's ready is passed over, and marked bad once another comes up", () =>
    Effect.gen(function* () {
      const f = yield* fallback({ order: ["0.3.0", "0.2.0"], servers: { "0.3.0": "exit", "0.2.0": "ok" } })
      assert.deepStrictEqual(f.result._tag === "Success" ? f.result.success : null, { token: "token-0.2.0", choice: { version: "0.2.0" } })
      assert.deepStrictEqual(f.started, ["0.3.0", "0.2.0"])
      assert.deepStrictEqual(yield* Ref.get(f.saved), ["0.3.0"])
      assert.deepStrictEqual(yield* Ref.get(f.failed), [])
      // Down to the bundled server.
      const g = yield* fallback({ order: ["0.3.0", "0.2.0"], servers: { "0.3.0": "exit", "0.2.0": "exit", bundled: "ok" } })
      assert.strictEqual(g.result._tag === "Success" ? g.result.success.token : null, "token-null")
      assert.deepStrictEqual(yield* Ref.get(g.saved), ["0.3.0", "0.2.0"])
    }),
  )

  it.effect("a trying version (or one that exited after the timeout) is skipped, and marked bad once another comes up", () =>
    Effect.gen(function* () {
      const f = yield* fallback({ order: ["0.4.0", "0.2.0"], servers: { "0.2.0": "ok" }, failed: ["0.4.0"] })
      assert.strictEqual(f.result._tag, "Success")
      assert.deepStrictEqual(f.started, ["0.2.0"])
      assert.deepStrictEqual(yield* Ref.get(f.saved), ["0.4.0"])
    }),
  )

  it.effect("when another launch's server takes the port, no version is marked bad", () =>
    Effect.gen(function* () {
      // Two launches start 0.3.0 at once; this one loses the port.
      const f = yield* fallback({ order: ["0.3.0", "0.2.0"], servers: { "0.3.0": "exit", "0.2.0": "ok" }, failed: ["0.4.0"], portTaken: (s) => s.length > 0 })
      assert.strictEqual(f.result._tag === "Failure" ? f.result.failure.message : null, "exit")
      assert.deepStrictEqual(f.started, ["0.3.0"])
      assert.deepStrictEqual(yield* Ref.get(f.saved), [])
      assert.deepStrictEqual(yield* Ref.get(f.failed), [])
    }),
  )

  it.effect("a failure every server has (none comes up) marks nothing bad", () =>
    Effect.gen(function* () {
      const f = yield* fallback({ order: ["0.3.0", "0.2.0"], servers: { "0.3.0": "exit", "0.2.0": "exit", bundled: "exit" } })
      assert.strictEqual(f.result._tag, "Failure")
      assert.deepStrictEqual(f.started, ["0.3.0", "0.2.0", null])
      assert.deepStrictEqual(yield* Ref.get(f.saved), [])
      assert.deepStrictEqual(yield* Ref.get(f.failed), [])
    }),
  )

  it.effect("a slow start, or one stopped by quitting, isn't a bad version and isn't fallen back from", () =>
    Effect.gen(function* () {
      const slow = yield* fallback({ order: ["0.3.0", "0.2.0"], servers: { "0.3.0": "slow", "0.2.0": "ok" } })
      assert.strictEqual(slow.result._tag === "Failure" ? slow.result.failure.message : null, "slow")
      assert.deepStrictEqual(slow.started, ["0.3.0"])
      const quit = yield* fallback({ order: ["0.3.0", "0.2.0"], servers: { "0.3.0": "exit", "0.2.0": "ok" }, stopping: yield* Ref.make(true) })
      assert.strictEqual(quit.result._tag, "Failure")
      assert.deepStrictEqual(quit.started, ["0.3.0"])
      assert.deepStrictEqual(yield* Ref.get(quit.saved), [])
    }),
  )

  // HA-184: the next server would need the backup too, and none is to blame.
  it.effect("a server that couldn't back up the database isn't fallen back from, and nothing is marked bad", () =>
    Effect.gen(function* () {
      const f = yield* fallback({ order: ["0.4.1", "0.4.0"], servers: { "0.4.1": "backup", "0.4.0": "ok", bundled: "ok" }, failed: ["0.5.0"] })
      assert.strictEqual(f.result._tag === "Failure" && "backup" in f.result.failure ? f.result.failure.backup?.reason : null, "space")
      assert.deepStrictEqual(f.started, ["0.4.1"])
      assert.deepStrictEqual(yield* Ref.get(f.saved), [])
      assert.deepStrictEqual(yield* Ref.get(f.failed), [])
    }),
  )

  it.effect("versions that exit after the wait timed out, one after another, reach the bundled server and are all marked bad", () =>
    Effect.gen(function* () {
      // As the shell's lateExit has it: each start times out, then that version exits, and the shell starts again.
      const servers = { "0.3.0": "slow", "0.2.0": "slow", bundled: "ok" } as const
      const first = yield* fallback({ order: ["0.3.0", "0.2.0"], servers })
      assert.strictEqual(first.result._tag, "Failure")
      const second = yield* fallback({ order: ["0.3.0", "0.2.0"], servers, failed: ["0.3.0"] })
      assert.strictEqual(second.result._tag, "Failure")
      assert.deepStrictEqual(yield* Ref.get(second.failed), ["0.3.0"], "a timeout keeps the failures before it")
      const third = yield* fallback({ order: ["0.3.0", "0.2.0"], servers, failed: ["0.3.0", "0.2.0"] })
      assert.strictEqual(third.result._tag === "Success" ? third.result.success.token : null, "token-null")
      assert.deepStrictEqual([first.started, second.started, third.started], [["0.3.0"], ["0.2.0"], [null]])
      assert.deepStrictEqual(yield* Ref.get(third.saved), ["0.3.0", "0.2.0"])
      assert.deepStrictEqual(yield* Ref.get(third.failed), [])
    }),
  )

  it.effect("with no server left to try, the failures are forgotten", () =>
    Effect.gen(function* () {
      const failed = yield* Ref.make<ReadonlyArray<string>>(["0.3.0"])
      const result = yield* startWithFallback({
        choose: () => Effect.fail(new NoServer({ message: "no server" })),
        start: () => Effect.die("not started"),
        portTaken: Effect.succeed(false),
        failed,
        saveBad: () => Effect.die("nothing is saved"),
        stopping: Effect.succeed(false),
      }).pipe(Effect.flip)
      assert.strictEqual(result.message, "no server")
      assert.deepStrictEqual(yield* Ref.get(failed), [])
    }),
  )

  it.effect("versions that exited, then a server that's ready only after the timeout: they're saved then", () =>
    Effect.gen(function* () {
      const f = yield* fallback({ order: ["0.3.0", "0.2.0"], servers: { "0.3.0": "exit", "0.2.0": "exit", bundled: "slow" } })
      assert.strictEqual(f.result._tag, "Failure")
      assert.deepStrictEqual(f.started, ["0.3.0", "0.2.0", null])
      assert.deepStrictEqual(yield* Ref.get(f.saved), [], "nothing is saved while the bundled server is only slow")
      // Its ready line, late.
      yield* Effect.forEach(f.late, (lateReady) => lateReady, { concurrency: 1, discard: true })
      assert.deepStrictEqual(yield* Ref.get(f.saved), ["0.3.0", "0.2.0"])
      assert.deepStrictEqual(yield* Ref.get(f.failed), [])
    }),
  )

  it.effect("a slow installed version that comes up late isn't blamed, and nothing is saved if the app is quitting", () =>
    Effect.gen(function* () {
      const stopping = yield* Ref.make(false)
      const quitting = yield* fallback({ order: ["0.4.0", "0.3.0"], servers: { "0.3.0": "slow" }, failed: ["0.4.0"], stopping })
      yield* Ref.set(stopping, true)
      yield* Effect.forEach(quitting.late, (lateReady) => lateReady, { concurrency: 1, discard: true })
      assert.deepStrictEqual(yield* Ref.get(quitting.saved), [])
      // Not quitting: the trying version is saved, the slow 0.3.0 isn't.
      const f = yield* fallback({ order: ["0.4.0", "0.3.0"], servers: { "0.3.0": "slow" }, failed: ["0.4.0"] })
      yield* Effect.forEach(f.late, (lateReady) => lateReady, { concurrency: 1, discard: true })
      assert.deepStrictEqual(yield* Ref.get(f.saved), ["0.4.0"])
    }),
  )
})
