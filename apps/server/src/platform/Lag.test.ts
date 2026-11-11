import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { Lag, percentile, record, emptyHistogram } from "./Lag.ts"
import { ServerConfig } from "./ServerConfig.ts"

// The old lag.test.ts's first case, without its routes (requests here are fibers that interleave, so a route's time on
// the thread can't be told apart: docs/plan/06-server.md, As built in 6.9). The ticker's lateness is given here; the
// ticker itself runs only in the server (`PlatformLoops`). Dropped: the worker and statement-cache cases (no worker, and
// the statement cache is the SQL client's).

const config = (lagLogMs: number) => ServerConfig.layerTest({ dataDir: "/nonexistent", lagLogMs })

describe("Lag", () => {
  it("percentiles of the histogram", () => {
    let h = emptyHistogram
    for (const ms of [1, 1, 2, 3, 100]) h = record(h, ms)
    assert.strictEqual(percentile(h, 50), 2)
    assert.strictEqual(percentile(h, 99), 100)
    assert.strictEqual(h.max, 100)
    assert.strictEqual(percentile(emptyHistogram, 50), 0)
  })

  it.effect("a tick that came late past the threshold is a stall, kept and logged; reset starts again", () =>
    Effect.gen(function* () {
      const lag = yield* Lag
      yield* lag.tick(0.4)
      yield* lag.tick(150)
      yield* lag.tick(2)
      const report = yield* lag.report
      assert.strictEqual(report.stall_log_ms, 60)
      assert.deepStrictEqual(
        report.stalls.map((s) => s.ms),
        [150],
      )
      assert.strictEqual(report.delay_ms?.count, 3)
      assert.strictEqual(report.delay_ms?.max, 150)
      assert.strictEqual(report.delay_ms?.p50, 2)
      // The minute's, for telemetry's metrics, start again once taken.
      assert.strictEqual((yield* lag.takeMinute)?.max, 150)
      assert.isNull(yield* lag.takeMinute)
      yield* lag.reset
      const after = yield* lag.report
      assert.deepStrictEqual([after.delay_ms, after.stalls], [null, []])
    }).pipe(Effect.provide(Lag.layer.pipe(Layer.provide(config(60))))),
  )

  it.effect("no stall is logged with the threshold at 0", () =>
    Effect.gen(function* () {
      const lag = yield* Lag
      yield* lag.tick(10_000)
      assert.deepStrictEqual((yield* lag.report).stalls, [])
    }).pipe(Effect.provide(Lag.layer.pipe(Layer.provide(config(0))))),
  )
})
