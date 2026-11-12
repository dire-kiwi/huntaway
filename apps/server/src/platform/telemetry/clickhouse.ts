import type { Duration } from "effect"
import { DateTime, Effect, Option, Redacted, Result, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"

// ClickHouse's HTTP interface (https://clickhouse.com/docs/interfaces/http), for the telemetry exporter (`Telemetry`)
// and `huntaway telemetry` (cli/telemetry.ts): a statement in a POST, its data (an insert's rows) in the body with the
// statement in the URL. Inserts are the only write, and they need nothing a client library adds. (The old
// telemetry/clickhouse.ts.)

/** Where telemetry goes: ClickHouse's HTTP address (no credentials), its database and its login. */
export interface Target {
  readonly url: string
  readonly database: string
  readonly user: string
  readonly password: Redacted.Redacted
}

/** A URL's parts, as `splitUrl` takes them out of it. */
export interface UrlParts {
  readonly url: string
  readonly user: string
  readonly password: string
  /** Null when the URL has no path. */
  readonly database: string | null
}

/**
 * A URL's credentials and database taken out of it (`http://user:pass@host:8123/huntaway`), as `--telemetry-url`
 * takes them; or why it isn't one ClickHouse could be at.
 */
export const splitUrl = (raw: string): Result.Result<UrlParts, string> => {
  if (!URL.canParse(raw.trim())) return Result.fail(`not a URL: ${raw}`)
  const u = new URL(raw.trim())
  if (u.protocol !== "http:" && u.protocol !== "https:") return Result.fail(`not an http(s) URL: ${raw}`)
  const user = decodeURIComponent(u.username)
  const password = decodeURIComponent(u.password)
  const path = decodeURIComponent(u.pathname).replace(/^\/+|\/+$/g, "")
  u.username = ""
  u.password = ""
  u.pathname = "/"
  u.search = ""
  u.hash = ""
  return Result.succeed({ url: u.toString().replace(/\/+$/, ""), user, password, database: path === "" ? null : path })
}

/**
 * ClickHouse's codes for data it couldn't read into a table's columns (a row's JSON, a date, a number). A 400 with
 * another code is a mistake in the statement or its settings, which every batch would make.
 */
const PARSE_CODES: ReadonlySet<number> = new Set([6, 26, 27, 32, 33, 38, 41, 53, 69, 70, 72, 117, 131])

/** An error ClickHouse answered with (`status` 0 when it couldn't be reached), its message cleaned and cut to 1 KB. */
export class ClickHouseError extends Schema.TaggedError<ClickHouseError, { readonly brand: unique symbol }>()("ClickHouseError", {
  reason: Schema.String,
  status: Schema.Int,
  /** ClickHouse's error code (`X-ClickHouse-Exception-Code`), e.g. 516 for a wrong password. */
  code: Schema.NullOr(Schema.Int),
}) {}

/** ClickHouse refused the rows themselves: they can't be read into the table's columns, or are too big. A row cut short is a 500 (code 32). */
export const badRows = (e: ClickHouseError): boolean =>
  ((e.status === 400 || e.status === 500) && e.code !== null && PARSE_CODES.has(e.code)) || e.status === 413

/**
 * It is how ClickHouse or the login is set up rather than something that passes: a wrong password, a missing grant,
 * database or table, or a statement or setting it doesn't take. Retrying soon won't help.
 */
export const setupError = (e: ClickHouseError): boolean => e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429 && !badRows(e)

export interface QueryOptions {
  /** Data for an INSERT: the statement then goes in the URL. Gzipped when it's large enough to be worth it. */
  readonly body?: string | undefined
  /** Settings for this query, sent in the URL. */
  readonly settings?: Readonly<Record<string, string | number>> | undefined
  /** Run in the target's database (the default), or without one (`false`, to create it). */
  readonly inDatabase?: boolean | undefined
  readonly timeout?: Duration.Input | undefined
}

/** The body is gzipped from this size on. */
const GZIP_FROM = 1024

const gzip = (text: string) =>
  Effect.promise(() => new Response(new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer()).pipe(
    Effect.map((buffer) => new Uint8Array(buffer)),
  )

/** ClickHouse's error message, without its stack trace and version, and cut to 1 KB. */
export const cleanError = (text: string): string =>
  text
    .replace(/\s*\(version [^()]*(?:\([^()]*\))?\)\s*$/, "")
    .replace(/^Code: (\d+)\. DB::Exception: /, "Code $1: ")
    .replace(/Stack trace[\s\S]*$/, "")
    .trim()
    .slice(0, 1024)

/** Runs a statement and gives ClickHouse's answer. */
export const query = Effect.fnUntraced(function* (target: Target, statement: string, options: QueryOptions = {}) {
  const client = yield* HttpClient.HttpClient
  const params: Record<string, string> = {}
  if (options.inDatabase !== false && target.database !== "") params["database"] = target.database
  for (const [k, v] of Object.entries(options.settings ?? {})) params[k] = String(v)
  const headers: Record<string, string> = {}
  if (target.user !== "") headers["X-ClickHouse-User"] = target.user
  const password = Redacted.value(target.password)
  if (password !== "") headers["X-ClickHouse-Key"] = password
  let request = HttpClientRequest.post(`${target.url}/`)
  if (options.body === undefined) request = HttpClientRequest.bodyText(request, statement, "text/plain")
  else {
    params["query"] = statement
    if (options.body.length >= GZIP_FROM) {
      headers["Content-Encoding"] = "gzip"
      request = HttpClientRequest.bodyUint8Array(request, yield* gzip(options.body), "application/x-ndjson")
    } else request = HttpClientRequest.bodyText(request, options.body, "application/x-ndjson")
  }
  request = HttpClientRequest.setHeaders(HttpClientRequest.setUrlParams(request, params), headers)
  const unreachable = (why: string) => new ClickHouseError({ reason: `ClickHouse at ${target.url} couldn't be reached: ${why}`, status: 0, code: null })
  const response = yield* client.execute(request).pipe(
    Effect.mapError((e) => unreachable(e.reason._tag === "TransportError" ? (e.reason.description ?? e.message) : e.message)),
    Effect.timeoutOrElse({ duration: options.timeout ?? "30 seconds", orElse: () => Effect.fail(unreachable("timed out")) }),
  )
  const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""))
  if (response.status < 200 || response.status >= 300) {
    const code = Number(response.headers["x-clickhouse-exception-code"])
    const reason = cleanError(text)
    return yield* new ClickHouseError({
      reason: reason === "" ? `HTTP ${response.status}` : reason,
      status: response.status,
      code: Number.isInteger(code) && code > 0 ? code : null,
    })
  }
  return text
})

/** Splits a .sql text into its statements, leaving out comments. */
export const statements = (sql: string): ReadonlyArray<string> =>
  sql
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n")
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter((s) => s !== "")

/** An ISO time as ClickHouse's DateTime64 parses it in JSONEachRow: `2026-11-08 10:00:00.123` (UTC). */
export const chTime = (iso: string): string =>
  Option.match(DateTime.make(iso), {
    onNone: () => "1970-01-01 00:00:00.000",
    onSome: (t) => DateTime.formatIso(t).replace("T", " ").replace("Z", ""),
  })
