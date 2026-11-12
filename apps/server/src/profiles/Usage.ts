import { Clock, Context, Effect, FileSystem, Layer, Option, Path, Redacted, Ref, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import type { HttpClientResponse } from "effect/http"
import type { AgentConfigId, Timestamp, Usage as UsageData, UsageAccount, UsageLimit } from "@huntaway/contracts"
import { Events } from "../platform/Events.ts"
import { ServerConfig } from "../platform/ServerConfig.ts"
import { nowTimestamp } from "../platform/columns.ts"
import { expandTilde } from "../settings/Folders.ts"
import { AgentConfigRepo } from "./AgentConfigRepo.ts"
import type { AgentConfigRow } from "./AgentConfigRepo.ts"
import { settingsBaseUrl } from "./AgentConfigs.ts"
import { codexOutUntil, field, mergeLimits, parseLimits, parseTime, poolLimits, readRateLimit } from "./usage/limits.ts"

// Subscription usage (session and weekly limits) of each agent config (huntaway's agent/usage.ts).
//
// Two sources feed it: Anthropic's OAuth usage endpoint (what `/usage` in Claude Code shows), called with the config's
// own login, and the `rate_limit_event`s agents print as they run. The login is only read, never refreshed:
// refreshing rotates the token underneath any `claude` running with the config. An expired login refreshes on the
// config's next run.
//
// Only configs with `show_usage` on are fetched and listed. The endpoint's rate limit is per account, and every host
// with a copy of the login (PR previews, test servers) would otherwise poll it too.
//
// A config with a proxy (CLIProxyAPI: its own `api_url`, or one its settings.json sets) pools several logins, none of
// them in its folder. Its usage is each of the proxy's Claude accounts' (asked for through the proxy's management API,
// with each account's own token), and its limits are the pool's (`poolLimits`, from the accounts that aren't used up).
// Its runs' `rate_limit_event`s are about whichever account served them, so they don't change its limits, only whether
// it's out (the proxy only passes a refusal on once every account it could try has refused).
//
// A config is *out* when a run on it was refused for its usage limit (`rate_limit_event` with status `rejected`),
// until that limit resets. Usage at 100% alone doesn't make it out: a plan with extra usage carries on past it.
//
// Kept in memory and lost on a restart, by design: a task waiting for a reset keeps it on its row (`limit_reset_at`).
// Codex configs' plan and limits are read from `codex app-server` (`account/rateLimits/read`), by the reader the agents
// area registers (`provideCodex`, 5.3), and from its runs' `account/rateLimits/updated` (`setLimits`).

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage"
const BETA = "oauth-2025-04-20"
/** How long a fetched snapshot is good for before a plain `list` fetches again (a little under the UI's 5-minute poll). */
export const MAX_AGE_MS = 4 * 60_000
/** Minimum gap between fetches for one config, even when a refresh is asked for. */
export const MIN_GAP_MS = 30_000
/** Each request to the usage endpoint or a proxy. */
const REQUEST_TIMEOUT = "10 seconds"

/** Why a config's usage could not be fetched: the text the board shows in its place. */
class FetchFailed extends Schema.TaggedError<FetchFailed, { readonly brand: unique symbol }>()("FetchFailed", { reason: Schema.String }) {}

/**
 * What is known of a config's session (5-hour) limit: its usage has none (`None`), it has one and its reset isn't
 * known, as when no window is running (`Unknown`), or it resets at `at` (ms since the epoch).
 */
export type SessionReset = { readonly _tag: "None" } | { readonly _tag: "Unknown" } | { readonly _tag: "At"; readonly at: number }

interface Entry {
  readonly usage: UsageData
  /** When it was last fetched (`Clock` ms), or null if it never was. */
  readonly fetched: number | null
}

const timed = <A, R>(effect: Effect.Effect<A, { readonly message: string }, R>, failed: (reason: string) => string) =>
  effect.pipe(
    Effect.mapError((e) => new FetchFailed({ reason: failed(e.message) })),
    Effect.timeoutOrElse({ duration: REQUEST_TIMEOUT, orElse: () => Effect.fail(new FetchFailed({ reason: failed("timed out") })) }),
  )
const bodyText = (res: HttpClientResponse.HttpClientResponse) => res.text.pipe(Effect.orElseSucceed(() => ""))

/** What a fetch read: the plan, its limits, and a proxy's accounts. */
interface Fetched {
  readonly plan: string | null
  readonly limits: ReadonlyArray<UsageLimit>
  readonly accounts: ReadonlyArray<UsageAccount> | null
}

const empty = (config: AgentConfigId): UsageData => ({
  config_id: config,
  limits: [],
  plan: null,
  updated_at: null,
  error: null,
  out_until: null,
  accounts: null,
})

export interface UsageShape {
  /**
   * Every config on this host that shows its usage, fetching the ones last fetched `MAX_AGE_MS` ago (`MIN_GAP_MS` when
   * `refresh` is asked for), all at once. `host.usage` is this.
   */
  readonly list: (refresh: boolean) => Effect.Effect<ReadonlyArray<UsageData>>
  /** What is known now, without fetching: the configs that show their usage, and any other a run said is out. For the board's snapshot. */
  readonly snapshot: Effect.Effect<ReadonlyArray<UsageData>>
  /** Fetch a config's usage now: whether that worked (the last numbers stay, with the error, if it didn't). Fetches don't emit. */
  readonly refresh: (config: AgentConfigId) => Effect.Effect<boolean>
  /**
   * A `rate_limit_event` line from a run on `config`: its session and weekly limits merged in, and whether it is out of
   * usage (`usage` emitted when either changed). A config with a proxy only takes the out-ness, as its limits are the
   * pool's.
   */
  readonly onRateLimit: (config: AgentConfigId, line: unknown) => Effect.Effect<void>
  /** Limits a run reported for `config` (and its plan, if it said): merged in, `usage` emitted if they changed. */
  readonly setLimits: (config: AgentConfigId, limits: ReadonlyArray<UsageLimit>, plan: string | null) => Effect.Effect<void>
  /** A Codex turn on `config` failed with `usageLimitExceeded`: out until the latest reset of the limits it last reported used up. */
  readonly codexRefused: (config: AgentConfigId) => Effect.Effect<void>
  /** Until when `config` is out of usage, if it is now (a reset in the future, by `Clock`). The gate before a run. */
  readonly outUntil: (config: AgentConfigId) => Effect.Effect<Timestamp | null>
  /** The config's session limit as last seen (`UsageWindow`'s view of its 5-hour window). */
  readonly sessionReset: (config: AgentConfigId) => Effect.Effect<SessionReset>
  /** The proxy `config`'s agents go through (its own `api_url`, else its settings.json's), or null: whose limits are a pool's. */
  readonly proxy: (config: AgentConfigId) => Effect.Effect<string | null>
  /** The usage kept for `config`, if any. */
  readonly get: (config: AgentConfigId) => Effect.Effect<UsageData | null>
  /**
   * How a Codex config's plan and limits are read (`account/rateLimits/read`, 5.3): the agents area, below this one,
   * registers it as its layer is built. Until then a Codex config's fetch fails.
   */
  readonly provideCodex: (read: CodexLimitsReader) => Effect.Effect<void>
}

/** Reads a Codex config's plan and limits, or why it can't. */
export type CodexLimitsReader = (
  config: AgentConfigRow,
) => Effect.Effect<{ readonly plan: string | null; readonly limits: ReadonlyArray<UsageLimit> }, { readonly reason: string }>

export class Usage extends Context.Service<Usage, UsageShape>()("huntaway-server/profiles/Usage") {
  static readonly layer = Layer.effect(
    Usage,
    Effect.gen(function* () {
      const repo = yield* AgentConfigRepo
      const events = yield* Events
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const server = yield* ServerConfig
      const client = yield* HttpClient.HttpClient
      const state = yield* Ref.make<ReadonlyMap<string, Entry>>(new Map())
      const codexReader = yield* Ref.make<CodexLimitsReader | null>(null)

      const entryOf = (config: AgentConfigId) => Effect.map(Ref.get(state), (m) => m.get(config) ?? null)
      /** Change `config`'s entry (made if there's none); emits `usage` when `change` says it changed something the board shows. */
      const change = (config: AgentConfigId, f: (entry: Entry) => Entry | null) =>
        Effect.gen(function* () {
          const changed = yield* Ref.modify(state, (m): readonly [UsageData | null, ReadonlyMap<string, Entry>] => {
            const next = f(m.get(config) ?? { usage: empty(config), fetched: null })
            if (next === null) return [null, m]
            return [next.usage, new Map([...m, [config, next]])]
          })
          return changed
        })

      const folder = (row: AgentConfigRow) => expandTilde(row.config_dir.trim() === "" ? "~/.claude" : row.config_dir, server.home)

      /** The proxy its agents go through, if it has one: its own (`api_url`), else the one its settings.json sets. */
      const proxyOf = (row: AgentConfigRow): Effect.Effect<string | null> => {
        if (row.agent === "codex") return Effect.succeed(null)
        if (row.api_url !== null && row.api_url.trim() !== "") return Effect.succeed(row.api_url)
        return fs.readFileString(path.join(folder(row), "settings.json")).pipe(
          Effect.flatMap(settingsBaseUrl),
          Effect.orElseSucceed(() => null),
        )
      }

      const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))
      const errorMessage = (text: string) =>
        decodeJson(text).pipe(
          Effect.map((v) => {
            const m = field(field(v, "error"), "message")
            return typeof m === "string" ? m : null
          }),
          Effect.orElseSucceed(() => null),
        )

      /** A Claude login's usage, from Anthropic's endpoint: its plan and limits. */
      const fetchClaude = Effect.fnUntraced(function* (row: AgentConfigRow) {
        const dir = folder(row)
        const file = path.join(dir, ".credentials.json")
        const raw = yield* fs
          .readFileString(file)
          .pipe(
            Effect.mapError(
              (e) => new FetchFailed({ reason: e.reason._tag === "NotFound" ? `No Claude login in ${dir}` : `Can't read ${file}: ${e.message}` }),
            ),
          )
        const creds = yield* decodeJson(raw).pipe(Effect.mapError((e) => new FetchFailed({ reason: `Can't parse ${file}: ${e.message}` })))
        const oauth = field(creds, "claudeAiOauth")
        if (oauth === undefined || oauth === null) return yield* new FetchFailed({ reason: "Not signed in with a Claude subscription" })
        const token = field(oauth, "accessToken")
        if (typeof token !== "string") return yield* new FetchFailed({ reason: `Can't parse ${file}: missing field \`accessToken\`` })
        const expires = field(oauth, "expiresAt")
        if (typeof expires === "number" && Number.isInteger(expires) && expires <= (yield* Clock.currentTimeMillis)) {
          return yield* new FetchFailed({ reason: "Login expired; it refreshes on this config's next agent run" })
        }
        const res = yield* timed(
          client.execute(HttpClientRequest.get(USAGE_URL, { headers: { authorization: `Bearer ${token}`, "anthropic-beta": BETA } })),
          (why) => `Usage request failed: ${why}`,
        )
        if (res.status < 200 || res.status >= 300) {
          const msg = yield* errorMessage(yield* bodyText(res))
          return yield* new FetchFailed({ reason: `Usage request failed (${res.status})${msg !== null ? `: ${msg}` : ""}` })
        }
        const v = yield* res.json.pipe(Effect.mapError((e) => new FetchFailed({ reason: `Bad usage response: ${e.message}` })))
        const plan = field(oauth, "subscriptionType")
        return { plan: typeof plan === "string" ? plan : null, limits: parseLimits(v), accounts: null }
      })

      /** A management API request's JSON (a GET, or a POST of `json`), or why there's none. */
      const proxyJson = Effect.fnUntraced(function* (url: string, key: string, json?: unknown) {
        const base = json === undefined ? HttpClientRequest.get(url) : HttpClientRequest.bodyJsonUnsafe(HttpClientRequest.post(url), json)
        const res = yield* timed(
          client.execute(HttpClientRequest.setHeaders(base, { authorization: `Bearer ${key}` })),
          (why) => `Proxy request failed: ${why}`,
        )
        const body = yield* bodyText(res)
        const v = yield* decodeJson(body).pipe(Effect.orElseSucceed(() => null))
        if (res.status < 200 || res.status >= 300) {
          const error = field(v, "error")
          const msg = typeof error === "string" ? error : Array.from(body).slice(0, 200).join("")
          const hint = msg.includes("remote management disabled") ? " (set management.allow-remote: true in its config.yaml)" : ""
          return yield* new FetchFailed({ reason: `Proxy request failed (${res.status}): ${msg}${hint}` })
        }
        if (v === null) return yield* new FetchFailed({ reason: "Bad response from the proxy" })
        return v
      })

      /** One of a proxy's Claude accounts: its usage, asked for with its own token (`$TOKEN$`, which the proxy puts in). */
      const accountUsage = Effect.fnUntraced(function* (base: string, key: string, cred: unknown) {
        const text = (k: string) => {
          const v = field(cred, k)
          const t = typeof v === "string" ? v.trim() : ""
          return t !== "" ? t : null
        }
        const name = text("email") ?? text("label") ?? text("name") ?? "Claude account"
        // A number in some versions.
        const ai = field(cred, "auth_index")
        const index = typeof ai === "string" ? ai : typeof ai === "number" || typeof ai === "boolean" ? String(ai) : "null"
        const body = { auth_index: index, method: "GET", url: USAGE_URL, header: { Authorization: "Bearer $TOKEN$", "anthropic-beta": BETA } }
        const answer = yield* proxyJson(`${base}/requests/api-call`, key, body).pipe(
          Effect.flatMap(
            Effect.fnUntraced(function* (r: unknown) {
              const status = field(r, "status_code")
              const b = field(r, "body")
              const t = typeof b === "string" ? b : ""
              if (status === 200) {
                return yield* decodeJson(t).pipe(
                  Effect.map(parseLimits),
                  Effect.mapError((e) => new FetchFailed({ reason: `Bad usage response: ${e.message}` })),
                )
              }
              const msg = yield* errorMessage(t)
              const shown = typeof status === "number" ? String(status) : "null"
              return yield* new FetchFailed({ reason: `Usage request failed (${shown})${msg !== null ? `: ${msg}` : ""}` })
            }),
          ),
          Effect.result,
        )
        let error = answer._tag === "Failure" ? answer.failure.reason : null
        // What the proxy says about it, when it isn't using it (a cooldown, a login that needs renewing).
        if (field(cred, "unavailable") === true && error === null) {
          const m = text("status_message")
          error = m !== null ? `Unavailable: ${m}` : "Unavailable"
        }
        const account: UsageAccount = { name, limits: answer._tag === "Success" ? answer.success : [], error }
        return account
      })

      /** The usage of each Claude account of the proxy at `url`, read through its management API with `key`, all at once. */
      const fetchProxy = Effect.fnUntraced(function* (row: AgentConfigRow, url: string) {
        const keys = yield* repo.keys(row.id)
        const key = keys.management_key === null ? "" : Redacted.value(keys.management_key)
        if (key.trim() === "") return yield* new FetchFailed({ reason: "Add the proxy's management key to this config to see its accounts' usage" })
        const base = `${url.replace(/\/+$/, "")}/v8/management`
        const v = yield* proxyJson(`${base}/credentials`, key)
        const files = field(v, "files")
        const claude = (Array.isArray(files) ? files : []).filter((c) => field(c, "provider") === "claude" && field(c, "disabled") !== true)
        const accounts = yield* Effect.forEach(claude, (c) => accountUsage(base, key, c), { concurrency: "unbounded" })
        const now = yield* Clock.currentTimeMillis
        return { plan: `${accounts.length} account${accounts.length === 1 ? "" : "s"}`, limits: poolLimits(accounts, now), accounts }
      })

      /** A Codex config's plan and limits, from a short-lived `codex app-server` (the agents area's reader). */
      const fetchCodex = (row: AgentConfigRow): Effect.Effect<Fetched, FetchFailed> =>
        Effect.flatMap(Ref.get(codexReader), (read) =>
          read === null
            ? Effect.fail(new FetchFailed({ reason: "Codex's usage can't be read here" }))
            : read(row).pipe(
                Effect.map((got): Fetched => ({ plan: got.plan, limits: got.limits, accounts: null })),
                Effect.mapError((e) => new FetchFailed({ reason: e.reason })),
              ),
        )

      const refreshRow = Effect.fnUntraced(function* (row: AgentConfigRow) {
        const url = yield* proxyOf(row)
        const fetch: Effect.Effect<Fetched, FetchFailed> = url !== null ? fetchProxy(row, url) : row.agent === "codex" ? fetchCodex(row) : fetchClaude(row)
        const result = yield* Effect.result(fetch)
        const now = yield* Clock.currentTimeMillis
        const at = yield* nowTimestamp
        yield* change(row.id, ({ usage }) =>
          result._tag === "Success"
            ? {
                // A fresh fetch is the whole picture: limits it no longer reports go.
                usage: {
                  ...usage,
                  limits: mergeLimits([], result.success.limits),
                  plan: result.success.plan,
                  accounts: result.success.accounts,
                  updated_at: at,
                  error: null,
                },
                fetched: now,
              }
            : { usage: { ...usage, error: result.failure.reason }, fetched: now },
        )
        if (result._tag === "Failure") yield* Effect.logDebug(`usage: config=${row.id} fetch failed: ${result.failure.reason}`)
        return result._tag === "Success"
      })

      const refresh = Effect.fn("Usage.refresh")(function* (config: AgentConfigId) {
        const row = yield* repo.get(config)
        if (Option.isNone(row)) return false
        return yield* refreshRow(row.value)
      })

      const list = Effect.fn("Usage.list")(function* (refreshAsked: boolean) {
        const configs = (yield* repo.list).filter((c) => c.show_usage)
        const now = yield* Clock.currentTimeMillis
        const known = yield* Ref.get(state)
        const due = configs.filter((c) => {
          const fetched = known.get(c.id)?.fetched ?? null
          return fetched === null || now - fetched >= (refreshAsked ? MIN_GAP_MS : MAX_AGE_MS)
        })
        yield* Effect.forEach(due, refreshRow, { concurrency: "unbounded", discard: true })
        const after = yield* Ref.get(state)
        return configs.map((c) => after.get(c.id)?.usage ?? empty(c.id))
      })

      const snapshot = Effect.gen(function* () {
        const configs = yield* repo.list
        const known = yield* Ref.get(state)
        return configs.flatMap((c) => {
          const usage = known.get(c.id)?.usage
          return usage !== undefined ? [usage] : c.show_usage ? [empty(c.id)] : []
        })
      }).pipe(Effect.withSpan("Usage.snapshot"))

      /** Mark `config` out of usage until `until` (null: not out), telling the board if that changes. */
      const setOut = (config: AgentConfigId, until: Timestamp | null) =>
        Effect.gen(function* () {
          const have = yield* entryOf(config)
          if (until === null && (have === null || have.usage.out_until === null)) return
          const changed = yield* change(config, (e) => (e.usage.out_until === until ? null : { ...e, usage: { ...e.usage, out_until: until } }))
          if (changed !== null) yield* events.emit({ type: "usage", usage: changed })
        })

      const setLimits = Effect.fn("Usage.setLimits")(function* (config: AgentConfigId, limits: ReadonlyArray<UsageLimit>, plan: string | null) {
        if (limits.length === 0) return
        const at = yield* nowTimestamp
        const changed = yield* change(config, (e) => {
          const merged = mergeLimits(e.usage.limits, limits)
          const nextPlan = plan ?? e.usage.plan
          const same = nextPlan === e.usage.plan && merged.length === e.usage.limits.length && merged.every((l, i) => sameLimit(l, e.usage.limits[i]))
          return same ? null : { ...e, usage: { ...e.usage, limits: merged, plan: nextPlan, updated_at: at } }
        })
        if (changed !== null) yield* events.emit({ type: "usage", usage: changed })
      })

      const onRateLimit = Effect.fn("Usage.onRateLimit")(function* (config: AgentConfigId, line: unknown) {
        const said = readRateLimit(line)
        if (said.out._tag === "Out") yield* setOut(config, said.out.until)
        else if (said.out._tag === "Allowed") yield* setOut(config, null)
        const row = yield* repo.get(config)
        // One account's numbers aren't the pool's.
        const proxied = Option.isSome(row) && (yield* proxyOf(row.value)) !== null
        if (!proxied) yield* setLimits(config, said.limits, null)
      })

      const codexRefused = Effect.fn("Usage.codexRefused")(function* (config: AgentConfigId) {
        const until = codexOutUntil((yield* entryOf(config))?.usage.limits ?? [])
        if (until !== null) yield* setOut(config, until)
      })

      const outUntil = Effect.fn("Usage.outUntil")(function* (config: AgentConfigId) {
        const until = (yield* entryOf(config))?.usage.out_until ?? null
        if (until === null) return null
        const t = parseTime(until)
        return t !== null && t > (yield* Clock.currentTimeMillis) ? until : null
      })

      const sessionReset = Effect.fn("Usage.sessionReset")(function* (config: AgentConfigId) {
        const limit = (yield* entryOf(config))?.usage.limits.find((l) => l.id === "session")
        if (limit === undefined) return { _tag: "None" } as const
        const at = limit.resets_at !== null ? parseTime(limit.resets_at) : null
        const reset: SessionReset = at === null ? { _tag: "Unknown" } : { _tag: "At", at }
        return reset
      })

      const proxy = (config: AgentConfigId) => Effect.flatMap(repo.get(config), Option.match({ onNone: () => Effect.succeed(null), onSome: proxyOf }))

      const get = (config: AgentConfigId) => Effect.map(entryOf(config), (e) => e?.usage ?? null)

      return Usage.of({
        list,
        snapshot,
        refresh,
        onRateLimit,
        setLimits,
        codexRefused,
        outUntil,
        sessionReset,
        proxy,
        get,
        provideCodex: (read) => Ref.set(codexReader, read),
      })
    }),
  )
}

const sameLimit = (a: UsageLimit, b: UsageLimit | undefined) =>
  b !== undefined && a.id === b.id && a.label === b.label && a.percent === b.percent && a.resets_at === b.resets_at
