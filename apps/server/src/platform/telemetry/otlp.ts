import { DateTime, Option, Predicate, Schema } from "effect"

// The agents' own OpenTelemetry (the old telemetry/otlp.ts; inventory 07, section 9 "OTLP receiver"). Claude Code and
// Codex both export log events over OTLP/HTTP with JSON; a run of a profile that sends is pointed at this server, at
// `/api/otlp/<run id>/v1/logs` on its internal URL, with the run's own secret as its bearer token (`http/otlp.ts`). The
// run, task, project and profile come from the URL's run, so a run can only send as itself. Each record is mapped onto
// `agent_events`' columns here, with a fixed list of the attributes kept (`KEEP`): the agents' identity attributes
// (email, account and organization ids) and Codex's tool arguments and output, which it sends by default, never leave
// the machine.

/** Where the receiver is, under the server's internal URL. */
export const OTLP_PREFIX = "/api/otlp/"

/** The most a request may be, gzipped or not. */
export const OTLP_MAX_BODY = 4 * 1024 * 1024

/** Where run `run` sends its log events. */
export const logsUrl = (internalUrl: string, run: string) => `${internalUrl}${OTLP_PREFIX}${encodeURIComponent(run)}/v1/logs`

/**
 * The environment a Claude Code run gets to send its events here. Its metrics repeat the events, and content
 * (prompts, tools' input) stays off, as it is by default.
 */
export const claudeEnv = (url: string, secret: string): ReadonlyArray<readonly [string, string]> => [
  ["CLAUDE_CODE_ENABLE_TELEMETRY", "1"],
  ["OTEL_LOGS_EXPORTER", "otlp"],
  ["OTEL_METRICS_EXPORTER", "none"],
  ["OTEL_TRACES_EXPORTER", "none"],
  ["OTEL_EXPORTER_OTLP_LOGS_PROTOCOL", "http/json"],
  ["OTEL_EXPORTER_OTLP_LOGS_ENDPOINT", url],
  ["OTEL_EXPORTER_OTLP_LOGS_HEADERS", `Authorization=Bearer%20${secret}`],
  // Its default is 2 s, which the docs say to raise if events are lost when it exits.
  ["CLAUDE_CODE_OTEL_SHUTDOWN_TIMEOUT_MS", "5000"],
]

/** A TOML basic string (what `JSON.stringify` gives a plain string, which TOML reads the same). */
const tomlString = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`

/** The `-c` overrides a Codex run's app-server gets to send its events here. */
export const codexOverrides = (url: string, secret: string): ReadonlyArray<string> => [
  `otel.exporter={otlp-http={endpoint=${tomlString(url)},protocol="json",headers={Authorization=${tomlString(`Bearer ${secret}`)}}}}`,
  'otel.environment="huntaway"',
  "otel.log_user_prompt=false",
]

/** Whether a variable is one that makes Claude Code export its own telemetry. */
export const ownTelemetryVar = (name: string) => name === "CLAUDE_CODE_ENABLE_TELEMETRY" || name.startsWith("OTEL_")

/** Whether a Codex `config.toml` sets up OpenTelemetry of its own (`[otel]`, `[otel.…]` or `otel.… =` keys). */
export const codexTomlSendsOwn = (toml: string) => /^\s*(\[otel[\].]|otel\s*[.=])/m.test(toml)

/** Whether a Claude Code `settings.json` (or managed settings) gives its agents telemetry variables of their own. */
export const claudeSettingsSendOwn = (text: string): boolean =>
  Option.match(Schema.decodeOption(SettingsEnv)(text), {
    onNone: () => false,
    onSome: (v) => v.env !== undefined && Object.keys(v.env).some(ownTelemetryVar),
  })

const SettingsEnv = Schema.fromJsonString(Schema.Struct({ env: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)) }))

// ---------- mapping ----------

/** An OTLP AnyValue as a plain value. */
const anyValue = (v: unknown): unknown => {
  if (!Predicate.isObject(v)) return null
  if (Predicate.hasProperty(v, "stringValue")) return v.stringValue
  if (Predicate.hasProperty(v, "intValue")) return Number(v.intValue)
  if (Predicate.hasProperty(v, "doubleValue")) return Number(v.doubleValue)
  if (Predicate.hasProperty(v, "boolValue")) return v.boolValue === true
  if (Predicate.hasProperty(v, "arrayValue")) {
    const values = Predicate.hasProperty(v.arrayValue, "values") ? v.arrayValue.values : []
    return Array.isArray(values) ? values.map(anyValue) : []
  }
  if (Predicate.hasProperty(v, "kvlistValue")) return attrsOf(Predicate.hasProperty(v.kvlistValue, "values") ? v.kvlistValue.values : [])
  return null
}

const attrsOf = (list: unknown): Record<string, unknown> => {
  const out: Record<string, unknown> = {}
  if (!Array.isArray(list)) return out
  for (const kv of list)
    if (Predicate.hasProperty(kv, "key") && typeof kv.key === "string") out[kv.key] = anyValue(Predicate.hasProperty(kv, "value") ? kv.value : null)
  return out
}

/** The field `key` of `v`, if it is an object that has it. */
const field = (v: unknown, key: string): unknown => (Predicate.hasProperty(v, key) ? v[key] : undefined)
const list = (v: unknown, key: string): ReadonlyArray<unknown> => {
  const x = field(v, key)
  return Array.isArray(x) ? x : []
}

/** Attributes kept in `attrs` besides those mapped onto columns. Everything else is dropped. */
const KEEP: ReadonlySet<string> = new Set([
  "request_id",
  "attempt",
  "event.sequence",
  "event.kind",
  "prompt_length",
  "decision_type",
  "error_type",
  "tool_result_size_bytes",
  "tool_input_size_bytes",
  "mcp_server_scope",
  "ttft_ms",
  "tool_token_count",
  "speed",
  "query_source",
  "subagent_type",
  "pre_tokens",
  "post_tokens",
  "trigger",
  "slug",
  "auth_mode",
  "terminal.type",
  "otel.environment",
])

/** Events whose `error` (or `error.message`) is the API's, and so is kept. A tool's error can say anything it ran. */
const ERROR_EVENTS: ReadonlySet<string> = new Set(["api_error", "api_request", "sse_event"])

const num = (v: unknown): number | null =>
  typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null
const str = (v: unknown): string =>
  v === null || v === undefined ? "" : typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : ""
const uint = (v: unknown) => {
  const n = num(v)
  return n !== null && n > 0 ? Math.round(n) : 0
}

/** An `agent_events` row (without the task's columns and `run_id`, which the receiver adds). */
export type AgentEventRow = Record<string, unknown>

/** The `agent_events` rows of an ExportLogsServiceRequest. `now` is the time for a record that has none. */
export const mapRequest = (v: unknown, now: string): ReadonlyArray<AgentEventRow> => {
  const rows: Array<AgentEventRow> = []
  for (const rl of list(v, "resourceLogs")) {
    const res = attrsOf(field(field(rl, "resource"), "attributes"))
    const service = str(res["service.name"])
    const runtime = service.startsWith("codex") ? "codex" : service.startsWith("claude") ? "claude" : service
    const version = str(res["service.version"])
    for (const sl of list(rl, "scopeLogs")) {
      for (const rec of list(sl, "logRecords")) {
        const row = mapRecord(rec, runtime, version, now)
        if (row !== null) rows.push(row)
      }
    }
  }
  return rows
}

/** One log record's row, or null for one that isn't an event. */
export const mapRecord = (rec: unknown, runtime: string, version: string, now: string): AgentEventRow | null => {
  const a = attrsOf(field(rec, "attributes"))
  const bodyText = field(field(rec, "body"), "stringValue")
  const body = typeof bodyText === "string" ? bodyText : ""
  // Claude Code's are `api_request` (body `claude_code.api_request`), Codex's `codex.api_request`.
  const event = str(a["event.name"] ?? field(rec, "eventName") ?? body).replace(/^(claude_code|codex)\./, "")
  if (event === "" || !/^[\w.]+$/.test(event) || event.length > 64) return null
  const nanos = num(field(rec, "timeUnixNano")) ?? num(field(rec, "observedTimeUnixNano"))
  const ts = a["event.timestamp"] !== undefined ? str(a["event.timestamp"]) : nanos !== null && nanos > 0 ? isoOfMillis(nanos / 1e6) : now
  const success = a["success"] === undefined ? -1 : a["success"] === true || a["success"] === "true" ? 1 : 0
  const attrs: Record<string, unknown> = {}
  for (const [k, x] of Object.entries(a)) if (KEEP.has(k)) attrs[k] = x
  return {
    ts,
    runtime,
    agent_version: version === "" ? str(a["app.version"]) : version,
    event,
    session_id: str(a["session.id"] ?? a["conversation.id"]),
    prompt_id: str(a["prompt.id"]),
    model: str(a["model"]),
    tool: str(a["tool_name"]),
    decision: str(a["decision"]),
    decision_source: str(a["source"] ?? a["decision_source"]),
    success,
    duration_ms: uint(a["duration_ms"]),
    status_code: uint(a["status_code"] ?? a["http.response.status_code"]),
    input_tokens: uint(a["input_tokens"] ?? a["input_token_count"]),
    output_tokens: uint(a["output_tokens"] ?? a["output_token_count"]),
    cache_read_tokens: uint(a["cache_read_tokens"] ?? a["cached_token_count"]),
    cache_write_tokens: uint(a["cache_creation_tokens"]),
    reasoning_tokens: uint(a["reasoning_token_count"] ?? a["reasoning_tokens"]),
    cost_usd: num(a["cost_usd"]) ?? 0,
    error: ERROR_EVENTS.has(event) ? str(a["error"] ?? a["error.message"]) : "",
    attrs,
  }
}

/** Milliseconds since the epoch as an ISO time (a record's own time, not the clock). */
const isoOfMillis = (ms: number): string =>
  Option.match(DateTime.make(Math.floor(ms)), { onNone: () => "1970-01-01T00:00:00.000Z", onSome: DateTime.formatIso })
