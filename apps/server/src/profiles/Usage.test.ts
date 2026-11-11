import { assert, describe, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Option, Ref, Schema } from "effect"
import type { Scope } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import type { HttpClientRequest } from "effect/http"
import { TestClock } from "effect/testing"
import { AgentConfigId, Timestamp } from "@huntaway/contracts"
import type { UsageAccount, UsageLimit } from "@huntaway/contracts"
import { tempDir, TestPlatform } from "@huntaway/testing"
import { Db } from "../platform/Db.ts"
import { Events } from "../platform/Events.ts"
import { AgentConfigRepo } from "./AgentConfigRepo.ts"
import { Usage } from "./Usage.ts"
import { field, isResetDue, mergeLimits, parseLimits, poolLimits, rfc3339, timestamp } from "./usage/limits.ts"

// The old agent/usage.test.ts's cases. Anthropic's endpoint and a CLIProxyAPI's management API are an `HttpClient`
// layer that answers as they do; the clock is the test clock.

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage"
/** 2026-11-12T00:00:00Z. */
const NOW = 1_794_441_600_000
const NOW_SECS = NOW / 1000

const Json = Schema.fromJsonString(Schema.Unknown)
const json = (value: unknown) => Schema.encodeEffect(Json)(value).pipe(Effect.orDie)
const parse = (text: string) => Effect.asSome(Schema.decodeEffect(Json)(text)).pipe(Effect.orElseSucceed(() => Option.none<unknown>()))

interface Seen {
  readonly method: string
  readonly url: string
  readonly authorization: string | undefined
  readonly body: unknown
}

/** An `HttpClient` that answers with `answer(request)` and keeps what it was asked. */
const fakeHttp = (answer: (req: Seen) => Effect.Effect<readonly [number, unknown]>, seen: Ref.Ref<ReadonlyArray<Seen>>) =>
  HttpClient.make((request: HttpClientRequest.HttpClientRequest, url) =>
    Effect.gen(function* () {
      const text = request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : ""
      const body = text === "" ? null : Option.getOrNull(yield* parse(text))
      const req: Seen = { method: request.method, url: url.toString(), authorization: request.headers["authorization"], body }
      yield* Ref.update(seen, (s) => [...s, req])
      const [status, out] = yield* answer(req)
      return HttpClientResponse.fromWeb(request, new Response(yield* json(out), { status, headers: { "content-type": "application/json" } }))
    }),
  )

/** No network: every request fails as an unreachable host would. */
const noNetwork = (seen: Ref.Ref<ReadonlyArray<Seen>>) => fakeHttp(() => Effect.succeed([599, { error: "no network in tests" }] as const), seen)

/**
 * A CLIProxyAPI's management API with two Claude accounts (one whose usage fails), a Codex one and a disabled one,
 * answering only `key` (the old `fake_proxy`), at `http://proxy.test`.
 */
const proxyAnswers =
  (key: string) =>
  (r: Seen): Effect.Effect<readonly [number, unknown]> =>
    Effect.gen(function* () {
      if (r.authorization !== `Bearer ${key}`) return [401, { error: "invalid management key" }] as const
      if (r.method === "GET" && r.url === "http://proxy.test/v8/management/credentials") {
        return [
          200,
          {
            files: [
              { auth_index: "a1", provider: "claude", email: "one@example.com", name: "claude-one.json", disabled: false },
              { auth_index: 2, provider: "claude", name: "claude-two.json", unavailable: true, status_message: "cooling down" },
              { auth_index: "c1", provider: "codex", email: "codex@example.com" },
              { auth_index: "d1", provider: "claude", email: "off@example.com", disabled: true },
            ],
          },
        ] as const
      }
      if (r.method === "POST" && r.url === "http://proxy.test/v8/management/requests/api-call") {
        const usage = { five_hour: { utilization: 40.0, resets_at: "2026-11-04T10:00:00Z" }, seven_day: { utilization: 10.0, resets_at: null } }
        if (field(r.body, "auth_index") === "a1") return [200, { status_code: 200, header: {}, body: yield* json(usage) }] as const
        return [200, { status_code: 401, header: {}, body: yield* json({ error: { message: "token expired" } }) }] as const
      }
      return [404, {}] as const
    })

const layerWith = (http: (seen: Ref.Ref<ReadonlyArray<Seen>>) => HttpClient.HttpClient, seen: Ref.Ref<ReadonlyArray<Seen>>) =>
  Usage.layer.pipe(
    Layer.provideMerge(AgentConfigRepo.layer),
    Layer.provideMerge(Layer.succeed(HttpClient.HttpClient, http(seen))),
    Layer.provideMerge(TestPlatform()),
  )

/** Runs `body` on a fresh board whose HTTP is `http`, at `NOW`, with what was asked of it. */
const test = <A, E>(
  body: (seen: Ref.Ref<ReadonlyArray<Seen>>) => Effect.Effect<A, E, Usage | AgentConfigRepo | Db | Events | FileSystem.FileSystem | Scope.Scope>,
  http: (seen: Ref.Ref<ReadonlyArray<Seen>>) => HttpClient.HttpClient = noNetwork,
) =>
  Effect.gen(function* () {
    const seen = yield* Ref.make<ReadonlyArray<Seen>>([])
    yield* TestClock.setTime(NOW)
    return yield* body(seen).pipe(Effect.provide(layerWith(http, seen)))
  }).pipe(Effect.scoped)

let made = 0
/** A config row. */
const config = (columns: {
  readonly name?: string
  readonly config_dir?: string
  readonly show_usage?: boolean
  readonly api_url?: string | null
  readonly api_key?: string | null
  readonly management_key?: string | null
}) =>
  Effect.gen(function* () {
    const { sql } = yield* Db
    const id = AgentConfigId.make(`cfg-${++made}`)
    yield* sql`INSERT INTO agent_configs ${sql.insert({
      id,
      name: columns.name ?? id,
      config_dir: columns.config_dir ?? "",
      created_at: "2026-01-01T00:00:00.000Z",
      agent: "claude",
      show_usage: columns.show_usage === true ? 1 : 0,
      api_url: columns.api_url ?? null,
      api_key: columns.api_key ?? null,
      management_key: columns.management_key ?? null,
    })}`
    return id
  }).pipe(Effect.orDie)

const setKey = (id: AgentConfigId, key: string) =>
  Effect.flatMap(Db, ({ sql }) => sql`UPDATE agent_configs SET management_key = ${key} WHERE id = ${id}`).pipe(Effect.orDie)

const acct = (limits: Array<UsageLimit>): UsageAccount => ({ name: "a", limits, error: null })
const at = (secs: number) => rfc3339(secs)
const lim = (id: string, percent: number, resets: string | null): UsageLimit => ({
  id,
  label: id,
  percent,
  resets_at: resets === null ? null : Timestamp.make(resets),
})

const got = (id: AgentConfigId) =>
  Effect.flatMap(Usage, (u) => u.get(id)).pipe(
    Effect.filterOrElse(
      (u) => u !== null,
      () => Effect.die("no usage kept"),
    ),
  )

describe("usage limits", () => {
  it("parses the limits list", () => {
    const v = {
      five_hour: { utilization: 14.0, resets_at: "2026-10-23T12:39:59Z" },
      limits: [
        { kind: "session", group: "session", percent: 14, resets_at: "2026-10-23T12:39:59Z", scope: null },
        { kind: "weekly_all", group: "weekly", percent: 67, resets_at: "2026-10-24T02:59:59Z", scope: null },
        { kind: "weekly_scoped", group: "weekly", percent: 0, resets_at: null, scope: { model: { display_name: "Fable" } } },
      ],
    }
    const l = parseLimits(v)
    assert.deepStrictEqual(
      l.map((x) => x.id),
      ["session", "weekly", "weekly:fable"],
    )
    assert.strictEqual(l[1]?.percent, 67.0)
    assert.strictEqual(l[2]?.label, "Weekly · Fable")
  })

  it("parses the window fields", () => {
    const l = parseLimits({ five_hour: { utilization: 14.0, resets_at: "x" }, seven_day: { utilization: 67.0 }, seven_day_opus: null })
    assert.strictEqual(l.length, 2)
    assert.strictEqual(l[0]?.id, "session")
    assert.strictEqual(l[1]?.resets_at, null)
  })

  it("a pool's limits are those of the account that resets first, unless it has used none", () => {
    const accounts = [
      acct([lim("session", 100.0, "2026-11-04T10:00:00Z"), lim("weekly", 40.0, "2026-11-09T00:00:00Z"), lim("weekly:sonnet", 0, null)]),
      acct([lim("session", 30.0, "2026-11-04T08:30:00+00:00"), lim("weekly", 20.0, null), lim("weekly:opus", 5.0, null)]),
      // Its session resets first, but it has used none of it; its weekly limit resets first and is used.
      acct([lim("session", 0, "2026-11-04T07:00:00Z"), lim("weekly", 60.0, "2026-11-06T00:00:00Z"), lim("weekly:sonnet", 0, "2026-11-08T00:00:00Z")]),
      // Its usage couldn't be read: it counts for nothing.
      { name: "b", limits: [], error: "no" },
    ]
    assert.deepStrictEqual(poolLimits(accounts), [
      lim("session", 30.0, "2026-11-04T08:30:00+00:00"),
      lim("weekly", 60.0, "2026-11-06T00:00:00Z"),
      // Every account is at 0%: the first to reset.
      lim("weekly:sonnet", 0, "2026-11-08T00:00:00Z"),
      lim("weekly:opus", 5.0, null),
    ])
    assert.deepStrictEqual(poolLimits([]), [])
  })

  it("a reset is due a minute after", () => {
    assert.isFalse(isResetDue(rfc3339(NOW_SECS + 60), NOW))
    assert.isFalse(isResetDue(rfc3339(NOW_SECS - 30), NOW))
    assert.isTrue(isResetDue(rfc3339(NOW_SECS - 61), NOW))
  })

  it("merge keeps unmentioned limits", () => {
    const merged = mergeLimits([lim("weekly:fable", 3.0, null), lim("session", 10.0, null)], [lim("weekly", 50.0, null), lim("session", 12.0, null)])
    assert.deepStrictEqual(merged, [lim("session", 12.0, null), lim("weekly", 50.0, null), lim("weekly:fable", 3.0, null)])
  })
})

describe("Usage", () => {
  it.effect("lists only configs that show their usage", () =>
    test((seen) =>
      Effect.gen(function* () {
        const usage = yield* Usage
        // Neither has a login, so the one that's fetched fails without going to the network.
        const dir = `${yield* tempDir}/claude`
        const off = yield* config({ config_dir: dir })
        const on = yield* config({ config_dir: dir, show_usage: true })
        const listed = yield* usage.list(false)
        assert.strictEqual(listed.length, 1)
        assert.strictEqual(listed[0]?.config_id, on)
        assert.isTrue(listed[0]?.error?.startsWith("No Claude login"), listed[0]?.error ?? "")
        assert.isNull(yield* usage.get(off))
        assert.deepStrictEqual(yield* Ref.get(seen), [])
        // The snapshot has it, without fetching.
        assert.deepStrictEqual(
          (yield* usage.snapshot).map((u) => u.config_id),
          [on],
        )
      }),
    ),
  )

  it.effect("reads a login's usage from Anthropic's endpoint, a few minutes apart, and never refreshes the login", () =>
    test(
      (seen) =>
        Effect.gen(function* () {
          const usage = yield* Usage
          const fs = yield* FileSystem.FileSystem
          const dir = yield* tempDir
          const login = (expiresAt: number) =>
            Effect.flatMap(json({ claudeAiOauth: { accessToken: "tok", refreshToken: "r", expiresAt, subscriptionType: "max" } }), (text) =>
              fs.writeFileString(`${dir}/.credentials.json`, text),
            ).pipe(Effect.orDie)
          yield* login(NOW + 3_600_000)
          const id = yield* config({ config_dir: dir, show_usage: true })
          const seq = yield* (yield* Events).seq
          const [first] = yield* usage.list(false)
          assert.deepStrictEqual(
            [first?.plan, first?.error, first?.limits.map((l) => [l.id, l.percent])],
            [
              "max",
              null,
              [
                ["session", 14],
                ["weekly", 67],
              ],
            ],
          )
          const asked = yield* Ref.get(seen)
          assert.deepStrictEqual(
            asked.map((r) => [r.method, r.url, r.authorization]),
            [["GET", USAGE_URL, "Bearer tok"]],
          )
          // Fetches don't emit: the client asks for them.
          assert.strictEqual(yield* (yield* Events).seq, seq)
          // Fresh for four minutes, or 30 seconds when a refresh is asked for.
          yield* usage.list(true)
          assert.strictEqual((yield* Ref.get(seen)).length, 1)
          yield* TestClock.adjust("30 seconds")
          yield* usage.list(false)
          assert.strictEqual((yield* Ref.get(seen)).length, 1)
          yield* usage.list(true)
          assert.strictEqual((yield* Ref.get(seen)).length, 2)
          yield* TestClock.adjust("4 minutes")
          yield* usage.list(false)
          assert.strictEqual((yield* Ref.get(seen)).length, 3)
          // An expired login isn't used (nor refreshed): its next run refreshes it. The numbers stay, with the error.
          yield* login(NOW)
          assert.isFalse(yield* usage.refresh(id))
          const u = yield* got(id)
          assert.deepStrictEqual([u.error, u.limits.length], ["Login expired; it refreshes on this config's next agent run", 2])
          assert.strictEqual((yield* Ref.get(seen)).length, 3)
        }),
      (seen) =>
        fakeHttp(
          (r) =>
            Effect.succeed(
              r.url === USAGE_URL && r.authorization === "Bearer tok"
                ? ([
                    200,
                    {
                      limits: [
                        { kind: "session", group: "session", percent: 14, resets_at: "2026-11-12T03:00:00Z", scope: null },
                        { kind: "weekly_all", group: "weekly", percent: 67, resets_at: null, scope: null },
                      ],
                    },
                  ] as const)
                : ([401, { error: { message: "bad token" } }] as const),
            ),
          seen,
        ),
    ),
  )

  it.effect("a refused run marks its config out until the reset", () =>
    test(() =>
      Effect.gen(function* () {
        const usage = yield* Usage
        const events = yield* Events
        const c = yield* config({})
        const d = yield* config({})
        const soon = NOW_SECS + 600
        const event = (status: string) => ({
          type: "rate_limit_event",
          rate_limit_info: { status, resetsAt: soon, unifiedWindows: { five_hour: { utilization: 1, resetsAt: soon } } },
        })
        yield* usage.onRateLimit(c, event("allowed_warning"))
        assert.isNull(yield* usage.outUntil(c), "at 100% on extra usage, it isn't out")
        const seq = yield* events.seq
        yield* usage.onRateLimit(c, event("rejected"))
        assert.strictEqual(yield* usage.outUntil(c), timestamp(soon))
        assert.strictEqual((yield* got(c)).limits[0]?.percent, 100.0)
        // A run's news is told to the board.
        assert.isAbove(yield* events.seq, seq)
        // Allowed again (extra usage bought, say).
        yield* usage.onRateLimit(c, event("allowed"))
        assert.isNull(yield* usage.outUntil(c))
        // Rejected, but carrying on with extra usage (as a plan with it enabled reports every turn).
        yield* usage.onRateLimit(c, event("rejected"))
        const overage = { rate_limit_info: { status: "rejected", resetsAt: soon, overageStatus: "allowed", isUsingOverage: true } }
        yield* usage.onRateLimit(c, overage)
        assert.isNull(yield* usage.outUntil(c), "extra usage clears it")
        yield* usage.onRateLimit(d, overage)
        assert.isNull(yield* usage.outUntil(d))
        yield* usage.onRateLimit(d, { rate_limit_info: { status: "rejected", resetsAt: soon, overageStatus: "allowed_warning" } })
        assert.isNull(yield* usage.outUntil(d))
        // A reset that's past isn't out.
        yield* usage.onRateLimit(c, { rate_limit_info: { status: "rejected", resetsAt: soon - 1200 } })
        assert.isNull(yield* usage.outUntil(c))
        // Nor is one that has come since.
        yield* usage.onRateLimit(c, event("rejected"))
        yield* TestClock.adjust("10 minutes")
        assert.isNull(yield* usage.outUntil(c))

        // Codex doesn't say which limit: the latest reset of those used up.
        const x = AgentConfigId.make("x")
        const y = AgentConfigId.make("y")
        const later = NOW_SECS + 1200
        yield* usage.setLimits(x, [lim("session", 100.0, at(later)), lim("weekly", 100.0, at(later + 60)), lim("weekly:x", 50.0, at(later + 999))], null)
        yield* usage.codexRefused(x)
        assert.strictEqual(yield* usage.outUntil(x), timestamp(later + 60))
        yield* usage.setLimits(y, [lim("session", 50.0, at(later))], null)
        yield* usage.codexRefused(y)
        assert.isNull(yield* usage.outUntil(y), "no reset known")
      }),
    ),
  )

  it.effect("a proxied run's rate limits only mark it out", () =>
    test(() =>
      Effect.gen(function* () {
        const usage = yield* Usage
        const p = yield* config({ api_url: "http://proxy.test", api_key: "k" })
        const soon = NOW_SECS + 600
        yield* usage.setLimits(p, [{ id: "session", label: "Session", percent: 20.0, resets_at: null }], null)
        const event = (status: string) => ({ rate_limit_info: { status, resetsAt: soon, unifiedWindows: { five_hour: { utilization: 0.9, resetsAt: soon } } } })
        // One account's numbers aren't the pool's.
        yield* usage.onRateLimit(p, event("allowed"))
        assert.strictEqual((yield* got(p)).limits[0]?.percent, 20.0)
        // A refusal the proxy passed on: every account it could try refused.
        yield* usage.onRateLimit(p, event("rejected"))
        assert.strictEqual(yield* usage.outUntil(p), timestamp(soon))
        assert.strictEqual((yield* got(p)).limits[0]?.percent, 20.0)
        yield* usage.onRateLimit(p, event("allowed"))
        assert.isNull(yield* usage.outUntil(p))
      }),
    ),
  )

  it.effect("a proxy config's usage is its Claude accounts'", () =>
    test(
      (seen) =>
        Effect.gen(function* () {
          const usage = yield* Usage
          const id = yield* config({ name: "pool", show_usage: true, api_url: "http://proxy.test/", api_key: "k" })
          // Without the management key, it says what's missing (and doesn't read ~/.claude's login).
          assert.isFalse(yield* usage.refresh(id))
          assert.include((yield* got(id)).error ?? "", "management key")
          yield* setKey(id, "nope")
          assert.isFalse(yield* usage.refresh(id))
          assert.include((yield* got(id)).error ?? "", "401")

          yield* setKey(id, "mk")
          yield* Ref.set(seen, [])
          assert.isTrue(yield* usage.refresh(id))
          const u = yield* got(id)
          assert.deepStrictEqual([u.error, u.plan], [null, "2 accounts"])
          const accounts = u.accounts ?? []
          assert.deepStrictEqual(
            accounts.map((a) => a.name),
            ["one@example.com", "claude-two.json"],
          )
          assert.deepStrictEqual(
            accounts[0]?.limits.map((l) => [l.id, l.percent]),
            [
              ["session", 40.0],
              ["weekly", 10.0],
            ],
          )
          assert.deepStrictEqual(accounts[1]?.limits, [])
          assert.strictEqual(accounts[1]?.error, "Usage request failed (401): token expired")
          // The pool is the accounts that have numbers.
          assert.deepStrictEqual(
            u.limits.map((l) => [l.id, l.percent]),
            [
              ["session", 40.0],
              ["weekly", 10.0],
            ],
          )
          // Each account's usage was asked for with its own token, by the proxy.
          const calls = (yield* Ref.get(seen)).filter((r) => r.method === "POST")
          assert.strictEqual(calls.length, 2)
          assert.strictEqual(field(calls[0]?.body, "url"), USAGE_URL)
          assert.strictEqual(field(field(calls[0]?.body, "header"), "Authorization"), "Bearer $TOKEN$")
          // (Sent at once: they can arrive in either order.)
          assert.deepStrictEqual(
            calls.map((b) => String(field(b.body, "auth_index"))).toSorted((a, b) => a.localeCompare(b)),
            ["2", "a1"],
          )
        }),
      (seen) => fakeHttp(proxyAnswers("mk"), seen),
    ),
  )

  it.effect("a config whose settings.json uses a proxy gets its usage from it", () =>
    test(
      (seen) =>
        Effect.gen(function* () {
          const usage = yield* Usage
          const fs = yield* FileSystem.FileSystem
          // A folder with no login of its own, whose settings.json sends Claude Code to the proxy.
          const dir = yield* tempDir
          yield* fs
            .writeFileString(`${dir}/settings.json`, yield* json({ env: { ANTHROPIC_BASE_URL: "http://proxy.test", ANTHROPIC_AUTH_TOKEN: "k" } }))
            .pipe(Effect.orDie)
          const id = yield* config({ name: "personal", config_dir: dir, show_usage: true })
          // Without the management key, that's what it asks for, rather than a login in the folder.
          assert.isFalse(yield* usage.refresh(id))
          assert.include((yield* got(id)).error ?? "", "management key")
          // A management key without an api_url of its own.
          yield* setKey(id, "mk")
          assert.isTrue(yield* usage.refresh(id))
          const u = yield* got(id)
          assert.strictEqual(u.plan, "2 accounts")
          assert.deepStrictEqual(
            u.limits.map((l) => [l.id, l.percent]),
            [
              ["session", 40.0],
              ["weekly", 10.0],
            ],
          )
          assert.strictEqual((yield* Ref.get(seen)).filter((r) => r.method === "POST").length, 2)
        }),
      (seen) => fakeHttp(proxyAnswers("mk"), seen),
    ),
  )
})
