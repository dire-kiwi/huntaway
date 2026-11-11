import { assert, describe, it } from "@effect/vitest"
import { Clock, Effect, Layer, Queue, Ref, Schema } from "effect"
import type { FileSystem, Scope } from "effect"
import { HttpClient, HttpClientError } from "effect/http"
import { TestClock } from "effect/testing"
import { AgentConfigId } from "@huntaway/contracts"
import type { UsageLimit } from "@huntaway/contracts"
import { tempDir, TestPlatform } from "@huntaway/testing"
import { Db } from "../platform/Db.ts"
import { AgentConfigRepo } from "../profiles/AgentConfigRepo.ts"
import type { AgentConfigRow } from "../profiles/AgentConfigRepo.ts"
import { Usage } from "../profiles/Usage.ts"
import { rfc3339 } from "../profiles/usage/limits.ts"
import { SideCalls } from "./SideCalls.ts"
import { newWatch, UsageWindow, windowOf } from "./UsageWindow.ts"
import { WindowPrompt, WindowPromptFailed } from "./WindowPrompt.ts"

// The old agent/window.test.ts's cases. The prompt is a fake that prints what each test gives it; nothing reaches the
// network (no config has a login, and the HTTP client fails every request); the clock is the test clock.

const MIN = 60_000
const HOUR = 60 * MIN
/** 2026-11-12T00:00:00Z. */
const NOW = 1_794_441_600_000
const secs = (t: number) => Math.floor(t / 1000)

const json = (value: unknown) => Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(value).pipe(Effect.orDie)

type Output = { readonly ok: string } | { readonly err: string }

/** What the fake prompt prints, one per prompt, and the configs it was sent for. */
interface Script {
  readonly outputs: Ref.Ref<ReadonlyArray<Output>>
  readonly pings: Queue.Queue<AgentConfigId>
}

const fakePrompt = (script: Script) =>
  Layer.succeed(
    WindowPrompt,
    WindowPrompt.of({
      send: (config: AgentConfigRow) =>
        Effect.gen(function* () {
          const [out, ...rest] = yield* Ref.get(script.outputs)
          if (out === undefined) return yield* new WindowPromptFailed({ reason: "no prompt in tests" })
          yield* Ref.set(script.outputs, rest)
          yield* Queue.offer(script.pings, config.id)
          if ("err" in out) return yield* new WindowPromptFailed({ reason: out.err })
          return { stdout: out.ok, error: null }
        }),
    }),
  )

const noNetwork = HttpClient.make((request) =>
  Effect.fail(new HttpClientError.HttpClientError({ reason: new HttpClientError.TransportError({ request, description: "no network in tests" }) })),
)

const layerWith = (script: Script) =>
  UsageWindow.layer.pipe(
    Layer.provideMerge(fakePrompt(script)),
    Layer.provideMerge(Layer.mergeAll(Usage.layer, SideCalls.layer)),
    Layer.provideMerge(AgentConfigRepo.layer),
    Layer.provideMerge(Layer.succeed(HttpClient.HttpClient, noNetwork)),
    Layer.provideMerge(TestPlatform()),
  )

type Env = UsageWindow | Usage | Db | FileSystem.FileSystem | Scope.Scope

const test = <A, E>(body: (script: Script) => Effect.Effect<A, E, Env>) =>
  Effect.gen(function* () {
    const script: Script = { outputs: yield* Ref.make<ReadonlyArray<Output>>([]), pings: yield* Queue.unbounded<AgentConfigId>() }
    yield* TestClock.setTime(NOW)
    return yield* body(script).pipe(Effect.provide(layerWith(script)))
  }).pipe(Effect.scoped)

let made = 0
/** A config with the setting on and no login (so fetching its usage fails without the network). */
const config = Effect.gen(function* () {
  const { sql } = yield* Db
  const id = AgentConfigId.make(`cfg-${++made}`)
  const dir = `${yield* tempDir}/claude`
  yield* sql`INSERT INTO agent_configs ${sql.insert({ id, name: "work", config_dir: dir, created_at: "2026-01-01T00:00:00.000Z", restart_window: 1 })}`
  return id
}).pipe(Effect.orDie)

const session = (id: AgentConfigId, resetsAt: number | null) => {
  const l: UsageLimit = { id: "session", label: "Session", percent: 40.0, resets_at: resetsAt !== null ? rfc3339(secs(resetsAt)) : null }
  return Effect.flatMap(Usage, (u) => u.setLimits(id, [l], null))
}

const event = (windows: unknown) => json({ type: "rate_limit_event", rate_limit_info: { status: "allowed", unifiedWindows: windows } })

const fiveHour = (resets: number) => {
  const r = secs(resets)
  return event({ five_hour: { utilization: 0.01, resetsAt: r }, seven_day: { utilization: 0.3, resetsAt: r + 86400 } })
}

const push = (script: Script, out: Output) => Ref.update(script.outputs, (o) => [...o, out])
const pings = (script: Script) => Queue.size(script.pings)
/** One look, at `at`. */
const tickAt = (at: number) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(at)
    yield* (yield* UsageWindow).tick
  })
const watchOf = (id: AgentConfigId) => Effect.flatMap(UsageWindow, (w) => w.watch(id)).pipe(Effect.map((w) => w ?? newWatch))

describe("UsageWindow", () => {
  it.effect("a window that ended is started again, once", () =>
    test((script) =>
      Effect.gen(function* () {
        const c = yield* config
        yield* session(c, NOW + HOUR)
        yield* tickAt(NOW)
        assert.strictEqual(yield* pings(script), 0, "still running")
        // Not until GRACE after the reset.
        yield* tickAt(NOW + HOUR + 30_000)
        assert.strictEqual(yield* pings(script), 0)
        const later = NOW + HOUR + 2 * MIN
        const next = later + 5 * HOUR
        const result = {
          type: "result",
          modelUsage: { "claude-haiku-5-5": { inputTokens: 3, outputTokens: 2, cacheCreationInputTokens: 600, costUSD: 0.0002 } },
        }
        yield* push(script, { ok: `${yield* fiveHour(next)}\n${yield* json(result)}\n` })
        yield* tickAt(later)
        assert.strictEqual(yield* pings(script), 1)
        // Its tokens are kept, as the config's.
        const { sql } = yield* Db
        const kept = yield* sql<{
          readonly purpose: string
          readonly config_id: string
          readonly task_id: string | null
          readonly model: string
          readonly output_tokens: number
          readonly cache_write_tokens: number
        }>`SELECT purpose, config_id, task_id, model, output_tokens, cache_write_tokens FROM call_usage`.pipe(Effect.orDie)
        assert.deepStrictEqual(
          kept.map((k) => [k.purpose, k.config_id, k.task_id, k.model, k.output_tokens, k.cache_write_tokens]),
          [["window", c, null, "claude-haiku-5-5", 2, 600]],
        )
        assert.deepStrictEqual(yield* (yield* Usage).sessionReset(c), { _tag: "At", at: secs(next) * 1000 })
        yield* tickAt(later + MIN)
        assert.strictEqual(yield* pings(script), 1, "the next window is running")
      }),
    ),
  )

  it.effect("a plan without the window is sent nothing", () =>
    test((script) =>
      Effect.gen(function* () {
        const c = yield* config
        const weekly: UsageLimit = { id: "weekly", label: "Weekly", percent: 30.0, resets_at: rfc3339(secs(NOW + 3 * 24 * HOUR)) }
        yield* (yield* Usage).setLimits(c, [weekly], null)
        // Nor is a config whose usage isn't known at all.
        yield* config
        yield* tickAt(NOW)
        assert.strictEqual(yield* pings(script), 0)
      }),
    ),
  )

  it("a window seen once counts while its usage leaves it out", () => {
    const now = NOW
    const [ended, seen] = windowOf({ _tag: "At", at: now - HOUR }, newWatch, now)
    assert.deepStrictEqual(ended, { _tag: "Ended" })
    assert.deepStrictEqual(windowOf({ _tag: "None" }, seen, now)[0], { _tag: "Ended" })
    assert.deepStrictEqual(windowOf({ _tag: "None" }, newWatch, now)[0], { _tag: "None" })
    // Nor one with no reset time.
    assert.deepStrictEqual(windowOf({ _tag: "Unknown" }, newWatch, now)[0], { _tag: "Ended" })
  })

  it.effect("a failed prompt is tried again later", () =>
    test((script) =>
      Effect.gen(function* () {
        const c = yield* config
        yield* session(c, NOW - 5 * MIN)
        yield* push(script, { err: "claude exited with 1" })
        yield* tickAt(NOW)
        assert.deepStrictEqual([yield* pings(script), (yield* watchOf(c)).failures], [1, 1])
        yield* tickAt(NOW + 4 * MIN)
        assert.strictEqual(yield* pings(script), 1, "backing off")
        // A prompt that leaves no window running counts as failed too, and the wait doubles.
        yield* push(script, { ok: '{"type":"result"}' })
        yield* tickAt(NOW + 5 * MIN)
        let w = yield* watchOf(c)
        assert.deepStrictEqual([yield* pings(script), w.failures, w.retry_at], [2, 2, NOW + 15 * MIN])
        yield* push(script, { ok: yield* fiveHour(NOW + 5 * HOUR) })
        yield* tickAt(NOW + 15 * MIN)
        w = yield* watchOf(c)
        assert.deepStrictEqual([yield* pings(script), w.failures, w.retry_at], [3, 0, null])
      }),
    ),
  )

  it.effect("a prompt that shows no window stops the restarts", () =>
    test((script) =>
      Effect.gen(function* () {
        const c = yield* config
        yield* session(c, NOW - 5 * MIN)
        yield* push(script, { ok: yield* event({ seven_day: { utilization: 0.3, resetsAt: secs(NOW + 3 * 24 * HOUR) } }) })
        yield* tickAt(NOW)
        assert.isTrue((yield* watchOf(c)).no_window)
        yield* tickAt(NOW + 2 * HOUR)
        assert.strictEqual(yield* pings(script), 1)
      }),
    ),
  )

  it.effect("a prompt that reports the window that just ended carries on", () =>
    test((script) =>
      Effect.gen(function* () {
        const c = yield* config
        const ended = NOW - MIN
        yield* session(c, ended)
        // What Claude Code prints for the first request after a window ends.
        const stale = {
          type: "rate_limit_event",
          rate_limit_info: {
            status: "allowed",
            resetsAt: secs(ended),
            rateLimitType: "five_hour",
            unifiedWindows: { seven_day: { utilization: 0.3, resetsAt: secs(NOW + 3 * 24 * HOUR) }, seven_day_overage_included: { utilization: 0.1 } },
          },
        }
        yield* push(script, { ok: yield* json(stale) })
        yield* tickAt(NOW)
        let w = yield* watchOf(c)
        assert.isFalse(w.no_window)
        assert.deepStrictEqual([yield* pings(script), w.failures], [1, 1], "tried again later")
        const next = NOW + 5 * HOUR
        yield* push(script, { ok: yield* fiveHour(next) })
        yield* tickAt(NOW + 5 * MIN)
        w = yield* watchOf(c)
        assert.deepStrictEqual([yield* pings(script), w.failures, w.no_window], [2, 0, false])
        assert.deepStrictEqual(windowOf(yield* (yield* Usage).sessionReset(c), w, NOW + 5 * MIN)[0], { _tag: "Open", at: secs(next) * 1000 })
      }),
    ),
  )

  it.effect("a config out of usage waits for its reset", () =>
    test((script) =>
      Effect.gen(function* () {
        const c = yield* config
        yield* session(c, NOW - 5 * MIN)
        // Refused for its weekly limit, which resets later.
        yield* (yield* Usage).onRateLimit(c, { rate_limit_info: { status: "rejected", resetsAt: secs(NOW + 24 * HOUR) } })
        yield* tickAt(NOW)
        assert.strictEqual(yield* pings(script), 0)
      }),
    ),
  )

  // The loop over a tick that only says when it ran: a real tick reads files, which the test clock does not wait for.
  it.effect("the loop looks at once, then every 30 seconds", () =>
    Effect.gen(function* () {
      const ticks = yield* Queue.unbounded<number>()
      const counted = Layer.succeed(
        UsageWindow,
        UsageWindow.of({ tick: Effect.flatMap(Clock.currentTimeMillis, (at) => Queue.offer(ticks, at)), watch: () => Effect.succeed(null) }),
      )
      yield* TestClock.setTime(NOW)
      yield* Effect.gen(function* () {
        assert.strictEqual(yield* Queue.take(ticks), NOW)
        yield* TestClock.adjust("29 seconds")
        assert.strictEqual(yield* Queue.size(ticks), 0)
        yield* TestClock.adjust("1 second")
        assert.strictEqual(yield* Queue.take(ticks), NOW + 30_000)
        yield* TestClock.adjust("30 seconds")
        assert.strictEqual(yield* Queue.take(ticks), NOW + 60_000)
      }).pipe(Effect.provide(UsageWindow.loop.pipe(Layer.provideMerge(counted))))
    }).pipe(Effect.scoped),
  )
})

// Dropped: `a_codex_plan_whose_only_window_is_weekly_is_sent_nothing` (Codex's rate limits and its prompt are M5's).
