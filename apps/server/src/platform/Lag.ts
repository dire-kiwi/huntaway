import { Clock, Context, DateTime, Duration, Effect, Layer, Ref } from "effect"
import { Timestamp } from "@huntaway/contracts"
import type { EventLoopReport } from "@huntaway/contracts"
import { ServerConfig } from "./ServerConfig.ts"

// How long the server's one thread is kept busy (the old lag.ts, HA-183; docs/plan/04-database.md: `node:sqlite` is
// synchronous, so a slow query or a big body holds up every other request, socket and agent's output until it ends).
// A tick that should come every 20 ms: when it comes late, the thread was busy for the difference. Its lateness goes in
// a histogram (since the start or the last reset, which `admin.eventLoop` shows, and the minute's, which telemetry's
// metrics take), and a stall of `lagLogMs` or more is logged and kept (the last 50).
//
// Not kept from the old one: the time each HTTP route spent on the thread and the label of what was running in a stall
// (`busy_with`). Requests here are fibers that interleave, so a route's time on the thread can't be told apart; a
// stall's log line says how long, and the log lines around it what was going on.

/** The ticker's period. */
export const TICK_MS = 20
/** Stalls kept. */
const STALLS = 50

/** Lateness in tenths of a millisecond, counted. */
export interface Histogram {
  readonly counts: ReadonlyMap<number, number>
  readonly count: number
  readonly sum: number
  readonly min: number
  readonly max: number
}

export const emptyHistogram: Histogram = { counts: new Map(), count: 0, sum: 0, min: 0, max: 0 }

/** The histogram with one more sample (`ms` late). */
export const record = (h: Histogram, ms: number): Histogram => {
  const key = Math.round(ms * 10)
  const counts = new Map(h.counts)
  counts.set(key, (counts.get(key) ?? 0) + 1)
  return {
    counts,
    count: h.count + 1,
    sum: h.sum + ms,
    min: h.count === 0 ? ms : Math.min(h.min, ms),
    max: Math.max(h.max, ms),
  }
}

/** The `p`th percentile (0–100), in ms; 0 for an empty histogram. */
export const percentile = (h: Histogram, p: number): number => {
  if (h.count === 0) return 0
  const rank = Math.max(1, Math.ceil((p / 100) * h.count))
  let seen = 0
  for (const key of [...h.counts.keys()].toSorted((a, b) => a - b)) {
    seen += h.counts.get(key) ?? 0
    if (seen >= rank) return key / 10
  }
  return h.max
}

const round = (n: number) => Math.round(n * 10) / 10

interface State {
  readonly since: string
  readonly all: Histogram
  readonly minute: Histogram
  readonly stalls: ReadonlyArray<{ readonly at: string; readonly ms: number }>
}

export interface LagShape {
  /** One tick that came `ms` late (the ticker's; tests give their own). */
  readonly tick: (ms: number) => Effect.Effect<void>
  /** What's been measured since the start (or the last reset). */
  readonly report: Effect.Effect<EventLoopReport>
  readonly reset: Effect.Effect<void>
  /** The minute's p50, p99 and max (null with no ticks), starting the next minute's. */
  readonly takeMinute: Effect.Effect<{ readonly p50: number; readonly p99: number; readonly max: number } | null>
}

export class Lag extends Context.Service<Lag, LagShape>()("huntaway-server/platform/Lag") {
  static readonly layer = Layer.effect(
    Lag,
    Effect.gen(function* () {
      const config = yield* ServerConfig
      const now = Effect.map(DateTime.now, DateTime.formatIso)
      const state = yield* Ref.make<State>({ since: yield* now, all: emptyHistogram, minute: emptyHistogram, stalls: [] })

      const tick = Effect.fnUntraced(function* (ms: number) {
        const late = Math.max(0, ms)
        const stalled = config.lagLogMs > 0 && late >= config.lagLogMs
        const at = yield* now
        yield* Ref.update(state, (s) => ({
          ...s,
          all: record(s.all, late),
          minute: record(s.minute, late),
          stalls: stalled ? [...s.stalls, { at, ms: Math.round(late) }].slice(-STALLS) : s.stalls,
        }))
        if (stalled) yield* Effect.logWarning(`the event loop was blocked for ${Math.round(late)} ms`)
      })

      const report = Effect.map(Ref.get(state), (s): EventLoopReport => {
        const h = s.all
        return {
          since: Timestamp.make(s.since),
          stall_log_ms: config.lagLogMs,
          delay_ms:
            h.count === 0
              ? null
              : {
                  count: h.count,
                  min: round(h.min),
                  mean: round(h.sum / h.count),
                  p50: round(percentile(h, 50)),
                  p90: round(percentile(h, 90)),
                  p99: round(percentile(h, 99)),
                  max: round(h.max),
                },
          stalls: s.stalls.toReversed().map((x) => ({ at: Timestamp.make(x.at), ms: x.ms })),
        }
      })

      const reset = Effect.flatMap(now, (since) => Ref.update(state, (s) => ({ ...s, since, all: emptyHistogram, stalls: [] })))

      const takeMinute = Ref.modify(state, (s) => {
        const h = s.minute
        const out = h.count === 0 ? null : { p50: percentile(h, 50), p99: percentile(h, 99), max: h.max }
        return [out, { ...s, minute: emptyHistogram }] as const
      })

      return Lag.of({ tick, report, reset, takeMinute })
    }),
  )

  /** The ticker: every 20 ms, how late it came. Not in tests (the test clock would make it spin). */
  static readonly ticker = Layer.effectDiscard(
    Effect.gen(function* () {
      const lag = yield* Lag
      const loop = Effect.gen(function* () {
        const before = yield* Clock.currentTimeNanos
        yield* Effect.sleep(Duration.millis(TICK_MS))
        const after = yield* Clock.currentTimeNanos
        yield* lag.tick(Number(after - before) / 1e6 - TICK_MS)
      })
      yield* loop.pipe(Effect.forever, Effect.forkScoped)
    }),
  )
}
