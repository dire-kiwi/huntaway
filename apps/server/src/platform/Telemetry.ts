import {
  Cause,
  Clock,
  Context,
  DateTime,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Logger,
  Option,
  Queue,
  Random,
  Redacted,
  Ref,
  References,
  Result,
  Schema,
  Semaphore,
} from "effect"
import { HttpClient } from "effect/http"
import { Invalid, ProfileId, TaskId, Timestamp } from "@huntaway/contracts"
import type { RunId, TelemetryLogs, TelemetryPatch, TelemetryState, TelemetryStatus, TelemetryTestResult } from "@huntaway/contracts"
import { Db } from "./Db.ts"
import { Events } from "./Events.ts"
import { Identity } from "./Identity.ts"
import { Lag } from "./Lag.ts"
import { ServerConfig } from "./ServerConfig.ts"
import { badRows, chTime, query, setupError, splitUrl } from "./telemetry/clickhouse.ts"
import type { ClickHouseError, Target } from "./telemetry/clickhouse.ts"
import { claudeEnv, claudeSettingsSendOwn, codexOverrides, codexTomlSendsOwn, logsUrl } from "./telemetry/otlp.ts"
import type { AgentEventRow } from "./telemetry/otlp.ts"
import { isTable, TABLES } from "./telemetry/schema.ts"
import type { Table } from "./telemetry/schema.ts"
import { KEYS, TelemetryRepo } from "./TelemetryRepo.ts"
import type { OutboxRow } from "./TelemetryRepo.ts"

// Telemetry to ClickHouse (the old telemetry.ts, HA-284; inventory 07, sections 2, 3, 6 and 9; docs/plan/06-server.md,
// Platform). Off unless the host is given a ClickHouse (its settings, or `--telemetry-url`), and then only for the
// profiles that opt in (`profiles.telemetry`).
//
// The rest of the server calls `emit` (or `taskEvent`, `runEvent`, `profileEvent`), which adds a row for one of the
// tables in telemetry/schema.ts to an outbox in the database, `telemetry_outbox`. Every FLUSH (or once BATCH_ROWS are
// waiting) the oldest rows of a table are sent as one `INSERT … FORMAT JSONEachRow` over ClickHouse's HTTP interface.
// So a restart, an update's exit or a crash loses nothing (there's no flush on exit), and a laptop away from the LAN
// sends what it kept once it's back.
//
// Retries don't count rows twice. The batch being sent (its table and first and last outbox ids) is kept in the
// `telemetry_inflight` setting before it's sent, and sent again exactly as it was, with the same
// `insert_deduplication_token`, until ClickHouse takes it: rows that came meanwhile would otherwise make a different
// batch, with a different token, which ClickHouse would take again. Only then are its rows deleted.
//
// Failures back off from FLUSH to MAX_BACKOFF. One that's how ClickHouse or its login is set up (a wrong password, a
// missing grant or table) waits SETUP_RETRY, and the host's Telemetry section says what it was. Rows ClickHouse can't
// read are dropped, as are the oldest past the outbox's limits, counted in a `telemetry_dropped` event once sending
// works again. Telemetry never gets in the way of what it describes: nothing here fails its caller.
//
// The logs tee (`Telemetry.logs`): the server's log lines at or above the host's `telemetry_logs` level go to `logs`,
// at most LOG_LINES_PER_SECOND; the exporter's own (module `telemetry`) never do, or a failing send would log itself in
// a loop. A line that names a task goes only if the task's profile sends.

export const FLUSH = Duration.seconds(10)
export const BATCH_ROWS = 1000
export const MAX_BACKOFF = Duration.minutes(5)
export const SETUP_RETRY = Duration.minutes(30)
export const SAMPLE = Duration.minutes(1)
export const LOG_LINES_PER_SECOND = 100
/** The outbox's limits: past either, the oldest rows go, down to 90%. */
export interface Limits {
  readonly rows: number
  readonly bytes: number
}
export const LIMITS: Limits = { rows: 200_000, bytes: 100 * 1024 * 1024 }
const ERROR_CHARS = 1024
const LOG_CHARS = 8192
/** A batch is sent with this, so ClickHouse knows it again. */
const INSERT_SETTINGS = {
  async_insert: 1,
  wait_for_async_insert: 1,
  // Its token deduplicates an async insert only with this, which a server's profile could turn off.
  async_insert_deduplicate: 1,
  input_format_skip_unknown_fields: 1,
  date_time_input_format: "best_effort",
}

export type Row = Record<string, unknown>

/** Where telemetry goes and what goes. */
export interface Config {
  readonly target: Target
  readonly logs: TelemetryLogs
  readonly agents: boolean
  readonly from: "settings" | "flag"
}

const Inflight = Schema.Struct({ target: Schema.String, first: Schema.Int, last: Schema.Int, at: Schema.optional(Schema.String) })
type Inflight = typeof Inflight.Type
const InflightJson = Schema.fromJsonString(Inflight)
const JsonText = Schema.fromJsonString(Schema.Unknown)
const toJson = (value: unknown) => Option.getOrElse(Schema.encodeOption(JsonText)(value), () => "null")

const LOG_LEVELS: ReadonlyArray<TelemetryLogs> = ["off", "warn", "info"]
const logLevelOf = (v: string | null): TelemetryLogs => LOG_LEVELS.find((l) => l === v) ?? "warn"

/** A Map column's value: its values as strings, without empty ones. */
export const stringMap = (v: unknown): Record<string, string> => {
  const out: Record<string, string> = {}
  if (typeof v !== "object" || v === null) return out
  for (const [k, x] of Object.entries(v)) {
    if (x === null || x === undefined || x === "") continue
    out[k] =
      typeof x === "string" ? x : typeof x === "object" ? toJson(x) : typeof x === "number" || typeof x === "boolean" || typeof x === "bigint" ? `${x}` : ""
  }
  return out
}

/** The milliseconds from one ISO time to another; 0 when either can't be read or the second isn't later. */
export const elapsedMs = (from: string, to: string): number => {
  const a = DateTime.make(from)
  const b = DateTime.make(to)
  if (Option.isNone(a) || Option.isNone(b)) return 0
  const ms = DateTime.toEpochMillis(b.value) - DateTime.toEpochMillis(a.value)
  return ms > 0 ? ms : 0
}

const TASK_IN_LINE = /\btask[= ]([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i
const RUN_IN_LINE = /\brun[= ]([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i

/** Telemetry never gets in the way of what it describes. */
const quietly = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.ignoreCause(Effect.asVoid(effect))

/** The exporter's own log lines, which the tee leaves out. */
const say = (level: "info" | "warn", message: string) =>
  (level === "warn" ? Effect.logWarning(message) : Effect.logInfo(message)).pipe(Effect.annotateLogs({ module: "telemetry" }))

/** `--telemetry-url`'s ClickHouse without its login. */
const safeFlagUrl = (u: string) => {
  const parsed = splitUrl(u)
  if (Result.isFailure(parsed)) return null
  const x = parsed.success
  return x.database === null ? x.url : `${x.url}/${x.database}`
}

const ts = (v: string | null) => (v === null ? null : Timestamp.make(v))

interface Exporter {
  readonly state: TelemetryState
  readonly lastOkAt: string | null
  readonly lastError: string | null
  readonly lastErrorAt: string | null
  readonly nextAttemptAt: string | null
  readonly sent: number
  readonly failures: number
  readonly added: number
  /** What the loop waits before it sends next: null while there's nowhere to send. */
  readonly delay: Duration.Duration | null
  readonly logWindow: { readonly second: number; readonly taken: number; readonly left: number }
}

interface LogLine {
  readonly level: "info" | "warn" | "error"
  readonly module: string
  readonly text: string
  readonly at: string
}

export interface TelemetryShape {
  /** Whether rows go anywhere: callers can skip working out a row when they don't. */
  readonly on: Effect.Effect<boolean>
  /** A host's row for `table` (nothing when telemetry is off). A row about a task goes through `taskEvent`. */
  readonly emit: (table: Table, row: Row) => Effect.Effect<void>
  /** A task's row (the `events` table's unless `table` says), with its task's columns, if its profile sends. */
  readonly taskEvent: (task: TaskId, row: Row, table?: Table) => Effect.Effect<void>
  /** A run's row: its task's, with `run_id`. */
  readonly runEvent: (run: RunId, row: Row) => Effect.Effect<void>
  /** A row about a profile that isn't a task's (an automation's run), if the profile sends. */
  readonly profileEvent: (profile: ProfileId, row: Row) => Effect.Effect<void>
  /** A config's row (a window restart): with the first profile that sends and has it. */
  readonly configEvent: (config: string, row: Row) => Effect.Effect<void>
  /**
   * Whether something that began at `at`, and is sent when it ends, is the server's to send: it began once the host
   * had started sending. One that began before is backfill's, so neither sends it twice.
   */
  readonly beganSince: (at: string) => Effect.Effect<boolean>
  /** The variables a Claude run gets to send its agent's own events here (none when it doesn't). */
  readonly claudeEnv: (task: TaskId, run: RunId, configDir: string | null) => Effect.Effect<ReadonlyArray<readonly [string, string]>>
  /** The `-c` overrides a Codex run's app-server gets (none when it doesn't). */
  readonly codexOverrides: (task: TaskId, run: RunId, configDir: string | null) => Effect.Effect<ReadonlyArray<string>>
  /** The rows of a run's agent's OTLP request (the receiver's). */
  readonly agentEvents: (run: RunId, rows: ReadonlyArray<AgentEventRow>) => Effect.Effect<void>
  readonly status: Effect.Effect<TelemetryStatus>
  readonly update: (patch: TelemetryPatch) => Effect.Effect<TelemetryStatus, Invalid>
  /** An empty insert into `events`, with the values given over the saved ones. */
  readonly test: (patch: TelemetryPatch) => Effect.Effect<TelemetryTestResult, Invalid>
  /** Sends what's waiting, a batch at a time, until it's all sent or a send fails. One at a time. */
  readonly flush: Effect.Effect<void>
  /** The minute's metrics. */
  readonly sample: Effect.Effect<void>
  /** A log line for the tee (the logger's, through its queue; tests call it). */
  readonly log: (level: LogLine["level"], module: string, text: string) => Effect.Effect<void>
  /** Puts the lines the logger queued into the outbox. */
  readonly drainLogs: Effect.Effect<void>
  /** The logger of the logs tee. */
  readonly logger: Logger.Logger<unknown, void>
  /** The exporter's loop, until interrupted (`Telemetry.exporter`). */
  readonly run: Effect.Effect<never>
}

/** The level and module of an Effect log entry, and whether it is the tee's to take at `logs`. */
const levelOf = (level: string): LogLine["level"] | null =>
  level === "Fatal" || level === "Error" ? "error" : level === "Warn" ? "warn" : level === "Info" ? "info" : null

export class Telemetry extends Context.Service<Telemetry, TelemetryShape>()("huntaway-server/platform/Telemetry") {
  static readonly layerWith = (limits: Limits) =>
    Layer.effect(
      Telemetry,
      Effect.gen(function* () {
        const repo = yield* TelemetryRepo
        const db = yield* Db
        const identity = yield* Identity
        const config = yield* ServerConfig
        const lag = yield* Lag
        const fs = yield* FileSystem.FileSystem
        const http = yield* HttpClient.HttpClient
        const nowIso = Effect.map(DateTime.now, DateTime.formatIso)
        const run$ = <A, E>(effect: Effect.Effect<A, E, HttpClient.HttpClient>) => Effect.provideService(effect, HttpClient.HttpClient, http)

        // ---- the config ----

        const readConfig = Effect.gen(function* () {
          const logs = logLevelOf(yield* repo.setting(KEYS.logs))
          const agents = (yield* repo.setting(KEYS.agents)) !== "false"
          const url = yield* repo.setting(KEYS.url)
          if (url !== null && url.trim() !== "") {
            const database = yield* repo.setting(KEYS.database)
            const target: Target = {
              url,
              database: database === null || database === "" ? "huntaway" : database,
              user: (yield* repo.setting(KEYS.user)) ?? "",
              password: (yield* repo.password) ?? Redacted.make(""),
            }
            return { target, logs, agents, from: "settings" } satisfies Config
          }
          const flag = config.telemetryUrl?.trim() ?? ""
          if (flag === "") return null
          const parsed = splitUrl(flag)
          if (Result.isFailure(parsed)) return null
          const u = parsed.success
          return {
            target: { url: u.url, database: u.database ?? "huntaway", user: u.user, password: Redacted.make(u.password) },
            logs,
            agents,
            from: "flag",
          } satisfies Config
        })

        const cfgRef = yield* Ref.make<Config | null>(null)
        const exporter = yield* Ref.make<Exporter>({
          state: "off",
          lastOkAt: null,
          lastError: null,
          lastErrorAt: null,
          nextAttemptAt: null,
          sent: 0,
          failures: 0,
          added: 0,
          delay: null,
          logWindow: { second: 0, taken: 0, left: 0 },
        })
        /** Wakes the loop: `now` to send, `again` to read its delay afresh. */
        const wake = yield* Queue.sliding<"now" | "again">(1)
        const logQueue = yield* Queue.unbounded<LogLine>()
        const sending = yield* Semaphore.make(1)
        const told = yield* Ref.make<ReadonlySet<string>>(new Set())

        /** Reads the config again (it was changed), and starts or stops sending. */
        const reload = Effect.gen(function* () {
          const cfg = yield* readConfig
          yield* Ref.set(cfgRef, cfg)
          yield* Ref.update(exporter, (e): Exporter => ({
            ...e,
            failures: 0,
            nextAttemptAt: null,
            state: cfg === null ? "off" : e.state === "off" || e.state === "error" ? "ok" : e.state,
            delay: cfg === null ? null : Duration.seconds(1),
          }))
          if (cfg !== null && (yield* repo.setting(KEYS.since)) === null) yield* repo.setSetting(KEYS.since, yield* nowIso)
          yield* Queue.offer(wake, "again")
        })
        yield* reload

        // ---- rows ----

        const add = Effect.fnUntraced(function* (table: Table, row: Row) {
          const at = yield* nowIso
          const full: Row = {
            ...row,
            ts: chTime(typeof row["ts"] === "string" ? row["ts"] : at),
            host_id: identity.hostId,
            host_name: identity.hostName,
            version: config.version,
          }
          for (const [k, max] of [
            ["error", ERROR_CHARS],
            ["message", LOG_CHARS],
          ] as const) {
            const v = full[k]
            if (typeof v === "string" && v.length > max) full[k] = v.slice(0, max)
          }
          if (full["attrs"] !== undefined) full["attrs"] = stringMap(full["attrs"])
          if (full["labels"] !== undefined) full["labels"] = stringMap(full["labels"])
          yield* repo.add(table, toJson(full), at)
          const e = yield* Ref.updateAndGet(exporter, (x): Exporter => ({ ...x, added: x.added + 1 }))
          if (e.added >= BATCH_ROWS && e.state === "ok") {
            yield* Ref.update(exporter, (x): Exporter => ({ ...x, added: 0 }))
            yield* Queue.offer(wake, "now")
          }
        })

        const on = Effect.map(Ref.get(cfgRef), (c) => c !== null)
        const whenOn = (effect: Effect.Effect<void>) => Effect.flatMap(on, (yes) => (yes ? quietly(effect) : Effect.void))

        const emit = (table: Table, row: Row) => whenOn(add(table, row))
        const taskEvent = (task: TaskId, row: Row, table: Table = "events") =>
          whenOn(
            Effect.gen(function* () {
              const ctx = yield* repo.taskContext(task)
              if (ctx !== null) yield* add(table, { ...ctx, ...row })
            }),
          )
        const runEvent = (run: RunId, row: Row) =>
          whenOn(
            Effect.gen(function* () {
              const task = yield* repo.runTask(run)
              if (task !== null) yield* taskEvent(task, { run_id: run, ...row })
            }),
          )
        const profileEvent = (profile: ProfileId, row: Row) =>
          whenOn(
            Effect.gen(function* () {
              const p = yield* repo.profile(profile)
              if (p !== null) yield* add("events", { profile: p.name, ...row })
            }),
          )
        const configEvent = (configId: string, row: Row) =>
          whenOn(
            Effect.gen(function* () {
              const profile = yield* repo.profileWithConfig(configId)
              if (profile === null) return
              const p = yield* repo.profile(ProfileId.make(profile))
              if (p !== null) yield* add("events", { profile: p.name, ...row, attrs: { ...stringMap(row["attrs"]), config_id: configId } })
            }),
          )
        const beganSince = (at: string) =>
          Effect.gen(function* () {
            if (!(yield* on)) return false
            const since = yield* repo.setting(KEYS.since)
            return since === null || at >= since
          })

        // ---- the agents' own events ----

        const read = (path: string) => fs.readFileString(path).pipe(Effect.option)
        /** Whether the login a run uses already exports telemetry of its own: then the run gets none of ours. */
        const ownTelemetry = Effect.fnUntraced(function* (codex: boolean, configDir: string | null) {
          if (config.ownTelemetryEnv) return true
          const expand = (p: string) => (p === "~" ? config.home : p.startsWith("~/") ? `${config.home}${p.slice(1)}` : p)
          const given = configDir !== null && configDir.trim() !== "" ? expand(configDir.trim()) : null
          if (codex) {
            const home = given ?? config.codexHome ?? `${config.home}/.codex`
            const toml = yield* read(`${home}/config.toml`)
            return Option.isSome(toml) && codexTomlSendsOwn(toml.value)
          }
          const dir = given ?? config.claudeConfigDir ?? `${config.home}/.claude`
          for (const file of [
            `${dir}/settings.json`,
            "/etc/claude-code/managed-settings.json",
            "/Library/Application Support/ClaudeCode/managed-settings.json",
          ]) {
            const text = yield* read(file)
            if (Option.isSome(text) && claudeSettingsSendOwn(text.value)) return true
          }
          return false
        })
        /** Whether a run of `task` sends its agent's events here: its profile sends, and its login doesn't send elsewhere. */
        const sends = Effect.fnUntraced(function* (task: TaskId, codex: boolean, configDir: string | null) {
          const cfg = yield* Ref.get(cfgRef)
          if (cfg === null || !cfg.agents) return false
          if ((yield* repo.taskContext(task)) === null) return false
          if (!(yield* ownTelemetry(codex, configDir))) return true
          const key = `${codex ? "codex" : "claude"}:${configDir ?? ""}`
          const first = yield* Ref.modify(told, (s) => [!s.has(key), s.has(key) ? s : new Set([...s, key])] as const)
          if (first)
            yield* say(
              "info",
              `${codex ? "Codex" : "Claude Code"}'s login in ${configDir ?? "its default folder"} sends its own telemetry, so its runs' events aren't sent here`,
            )
          return false
        })
        const runUrl = (run: RunId) => logsUrl(`http://127.0.0.1:${config.port}`, run)
        const forClaude = (task: TaskId, run: RunId, configDir: string | null) =>
          Effect.gen(function* () {
            if (!(yield* sends(task, false, configDir))) return []
            return claudeEnv(runUrl(run), yield* identity.runSecret(run))
          }).pipe(Effect.catchCause(() => Effect.succeed([])))
        const forCodex = (task: TaskId, run: RunId, configDir: string | null) =>
          Effect.gen(function* () {
            if (!(yield* sends(task, true, configDir))) return []
            return codexOverrides(runUrl(run), yield* identity.runSecret(run))
          }).pipe(Effect.catchCause(() => Effect.succeed([])))
        const agentEvents = (run: RunId, rows: ReadonlyArray<AgentEventRow>) =>
          whenOn(
            Effect.gen(function* () {
              const task = yield* repo.runTask(run)
              if (task === null || rows.length === 0) return
              yield* db.tx(Effect.forEach(rows, (r) => taskEvent(task, { run_id: run, ...r }, "agent_events"), { concurrency: 1, discard: true }))
            }),
          )

        // ---- sending ----

        const inflight = Effect.map(repo.setting(KEYS.inflight), (v) => (v === null ? null : Option.getOrNull(Schema.decodeOption(InflightJson)(v))))

        const noteError = (message: string) =>
          Effect.flatMap(nowIso, (at) => Ref.update(exporter, (e): Exporter => ({ ...e, lastError: message.slice(0, ERROR_CHARS), lastErrorAt: at })))

        const addDropped = (n: number) =>
          n <= 0
            ? Effect.void
            : Effect.gen(function* () {
                const was = Number(yield* repo.setting(KEYS.dropped)) || 0
                yield* repo.setSetting(KEYS.dropped, String(was + n))
              })

        /** A send (or reading the outbox) failed: back off, or wait long for a setup error. */
        const failed = Effect.fnUntraced(function* (error: ClickHouseError | string) {
          const setup = typeof error !== "string" && setupError(error)
          const message = typeof error === "string" ? error : error.reason
          const before = yield* Ref.get(exporter)
          const failures = before.failures + 1
          const backoff = Math.min(Duration.toMillis(MAX_BACKOFF), Duration.toMillis(FLUSH) * 2 ** (failures - 1))
          const delay = setup ? SETUP_RETRY : Duration.millis(Math.round(backoff * (0.5 + (yield* Random.next) / 2)))
          const state: TelemetryState = setup ? "error" : "retrying"
          if (before.state !== state || message !== before.lastError) {
            yield* say(
              "warn",
              `sending to ClickHouse failed${setup ? " (check its address, login and grants, and that `huntaway telemetry init` has run)" : ""}: ${message}`,
            )
          }
          yield* noteError(message)
          const next = DateTime.formatIso(DateTime.addDuration(yield* DateTime.now, delay))
          yield* Ref.update(exporter, (e): Exporter => ({ ...e, failures, state, nextAttemptAt: next, delay }))
        })

        /** Batch `b` is done with: its rows go, and it's no longer in flight. */
        const done = (b: Inflight) => db.tx(Effect.andThen(repo.deleteBetween(b.target, b.first, b.last), repo.setSetting(KEYS.inflight, null)))

        /** The batch to send: the one in flight, else the oldest rows of the table whose row is oldest. */
        const nextBatch: Effect.Effect<{ readonly inflight: Inflight; readonly rows: ReadonlyArray<OutboxRow> } | null> = Effect.gen(function* () {
          const kept = yield* inflight
          if (kept !== null) {
            const rows = yield* repo.rowsBetween(kept.target, kept.first, kept.last)
            if (rows.length > 0) return { inflight: kept, rows }
            yield* repo.setSetting(KEYS.inflight, null)
          }
          for (;;) {
            const oldest = yield* repo.oldestTarget
            if (oldest === null) return null
            // From a newer build that has a table this one doesn't know: it can't be sent from here.
            if (!isTable(oldest)) {
              yield* repo.deleteTarget(oldest)
              continue
            }
            const rows = yield* repo.rowsOf(oldest, BATCH_ROWS)
            const first = rows[0]
            const last = rows.at(-1)
            if (first === undefined || last === undefined) return null
            const batch: Inflight = { target: oldest, first: first.id, last: last.id, at: first.at }
            yield* repo.setSetting(
              KEYS.inflight,
              Option.getOrElse(Schema.encodeOption(InflightJson)(batch), () => ""),
            )
            return { inflight: batch, rows }
          }
        })

        /** Sends a batch: true if it's done with (sent, or dropped as rows ClickHouse can't read). */
        const send = Effect.fnUntraced(function* (cfg: Config, b: Inflight, rows: ReadonlyArray<OutboxRow>) {
          const token = `${identity.hostId}:${b.target}:${b.first}-${b.last}:${b.at ?? ""}`
          const result = yield* run$(
            query(cfg.target, `INSERT INTO ${b.target} FORMAT JSONEachRow`, {
              body: rows.map((r) => r.row).join("\n"),
              settings: { ...INSERT_SETTINGS, insert_deduplication_token: token },
            }),
          ).pipe(Effect.result)
          if (result._tag === "Failure") {
            const e = result.failure
            if (badRows(e)) {
              yield* done(b)
              yield* addDropped(rows.length)
              yield* noteError(`ClickHouse couldn't read ${rows.length} ${b.target} rows, which were dropped: ${e.reason}`)
              return true
            }
            yield* failed(e)
            return false
          }
          yield* done(b)
          const at = yield* nowIso
          const was = yield* Ref.getAndUpdate(exporter, (e): Exporter => ({ ...e, sent: e.sent + rows.length, lastOkAt: at, failures: 0, state: "ok" }))
          if (was.state !== "ok") yield* say("info", `sending to ClickHouse at ${cfg.target.url} works again`)
          return true
        })

        /** Drops the oldest rows past the limits (to 90% of them), counted. */
        const cap = Effect.gen(function* () {
          const r = yield* repo.size
          if (r.n <= limits.rows && r.bytes <= limits.bytes) return
          const byRows = r.n - Math.floor(limits.rows * 0.9)
          const byBytes = r.bytes > limits.bytes ? Math.ceil(r.n * (1 - (limits.bytes * 0.9) / r.bytes)) : 0
          const n = Math.max(byRows, byBytes, 1)
          const cut = yield* repo.nthId(n)
          if (cut === null) return
          const gone = yield* repo.deleteUpTo(cut)
          const kept = yield* inflight
          if (kept !== null && kept.first <= cut) yield* repo.setSetting(KEYS.inflight, null)
          yield* addDropped(gone)
          yield* say("warn", `the outbox was over its limit (${r.n} rows, ${Math.round(r.bytes / 1e6)} MB), so its oldest ${gone} rows were dropped`)
        })

        /** Once sending works: an event that says how many rows were dropped since the last one. */
        const reportDropped = Effect.gen(function* () {
          const n = Number(yield* repo.setting(KEYS.dropped)) || 0
          if (n <= 0) return
          yield* repo.setSetting(KEYS.dropped, null)
          yield* add("events", { event: "telemetry_dropped", attrs: { rows: n } })
        })

        const flushInner = Effect.gen(function* () {
          const cfg = yield* Ref.get(cfgRef)
          if (cfg === null) return
          yield* Ref.update(exporter, (e): Exporter => ({ ...e, added: 0 }))
          yield* quietly(cap)
          for (let n = 0; n < 100; n++) {
            if ((yield* Ref.get(cfgRef)) === null) return
            const batch = yield* nextBatch.pipe(
              Effect.catchCause((cause) => Effect.as(failed(`reading the outbox: ${Cause.pretty(cause)}`), "failed" as const)),
            )
            if (batch === "failed") return
            if (batch === null) break
            if (!(yield* send(cfg, batch.inflight, batch.rows))) return
          }
          yield* Ref.update(exporter, (e): Exporter => ({ ...e, state: "ok", failures: 0, nextAttemptAt: null, delay: FLUSH }))
          yield* reportDropped
        })
        const flush = Semaphore.withPermits(
          sending,
          1,
        )(
          flushInner.pipe(
            Effect.catchCauseIf(
              (cause) => !Cause.hasInterrupts(cause),
              (cause) => failed(Cause.pretty(cause)),
            ),
          ),
        ).pipe(
          Effect.catchCauseIf(
            (cause) => !Cause.hasInterrupts(cause),
            () => Effect.void,
          ),
        )

        const run: Effect.Effect<never> = Effect.forever(
          Effect.gen(function* () {
            const { delay } = yield* Ref.get(exporter)
            const woken =
              delay === null
                ? yield* Queue.take(wake)
                : yield* Queue.take(wake).pipe(Effect.timeoutOrElse({ duration: delay, orElse: () => Effect.succeed("now" as const) }))
            yield* drainLogs
            if (woken === "now") yield* flush
          }),
        )

        // ---- metrics ----

        const sample = whenOn(
          Effect.gen(function* () {
            const rows: Array<readonly [string, number]> = []
            const loop = yield* lag.takeMinute
            if (loop !== null) rows.push(["event_loop_delay_p50_ms", loop.p50], ["event_loop_delay_p99_ms", loop.p99], ["event_loop_delay_max_ms", loop.max])
            const mem = process.memoryUsage()
            rows.push(["rss_bytes", mem.rss], ["heap_used_bytes", mem.heapUsed])
            const counts = yield* repo.counts
            rows.push(["runs_running", counts.running], ["tasks_needing_attention", counts.attention])
            rows.push(["telemetry_outbox_rows", (yield* repo.size).n])
            for (const [name, value] of rows) yield* add("metrics", { name, value: Math.round(value * 1000) / 1000, labels: {} })
          }),
        )

        // ---- the logs tee ----

        const log = Effect.fnUntraced(function* (level: LogLine["level"], module: string, text: string) {
          const cfg = yield* Ref.get(cfgRef)
          if (cfg === null || cfg.logs === "off" || module === "telemetry") return
          if (level === "info" && cfg.logs !== "info") return
          const second = Math.floor((yield* Clock.currentTimeMillis) / 1000)
          const w = (yield* Ref.get(exporter)).logWindow
          if (w.second !== second) {
            yield* Ref.update(exporter, (e): Exporter => ({ ...e, logWindow: { second, taken: 0, left: 0 } }))
            if (w.left > 0)
              yield* add("logs", {
                level: "warn",
                module: "telemetry",
                message: `${w.left} log lines weren't sent: more than ${LOG_LINES_PER_SECOND} a second`,
              })
          }
          const now = (yield* Ref.get(exporter)).logWindow
          if (now.taken >= LOG_LINES_PER_SECOND) {
            yield* Ref.update(exporter, (e): Exporter => ({ ...e, logWindow: { ...e.logWindow, left: e.logWindow.left + 1 } }))
            return
          }
          const task = TASK_IN_LINE.exec(text)?.[1] ?? ""
          const runId = RUN_IN_LINE.exec(text)?.[1] ?? ""
          // A line about a task goes only if the task's profile sends (it may name its folder, its branch).
          if (task !== "" && (yield* repo.taskContext(TaskId.make(task))) === null) return
          yield* Ref.update(exporter, (e): Exporter => ({ ...e, logWindow: { ...e.logWindow, taken: e.logWindow.taken + 1 } }))
          yield* add("logs", { level, module, message: text, task_id: task, run_id: runId })
        })

        const drainLogs = Effect.gen(function* () {
          const lines = yield* Queue.clear(logQueue)
          for (const l of lines) yield* quietly(log(l.level, l.module, l.text))
        })

        const logger = Logger.make<unknown, void>((options) => {
          const cfg = Ref.getUnsafe(cfgRef)
          if (cfg === null || cfg.logs === "off") return
          const level = levelOf(options.logLevel)
          if (level === null || (level === "info" && cfg.logs !== "info")) return
          const annotations = options.fiber.getRef(References.CurrentLogAnnotations)
          const module = typeof annotations["module"] === "string" ? annotations["module"] : "server"
          if (module === "telemetry") return
          const parts = Array.isArray(options.message) ? options.message : [options.message]
          const text = parts.map((p) => (typeof p === "string" ? p : String(p))).join(" ")
          if (Queue.offerUnsafe(logQueue, { level, module, text, at: options.date.toISOString() }) && level !== "info") Queue.offerUnsafe(wake, "again")
        })

        // ---- settings and status ----

        const status: Effect.Effect<TelemetryStatus> = Effect.gen(function* () {
          const cfg = yield* Ref.get(cfgRef)
          const e = yield* Ref.get(exporter)
          const queued: Record<string, number> = Object.fromEntries(TABLES.map((t) => [t, 0]))
          for (const r of yield* repo.queued) queued[r.target] = r.n
          return {
            url: yield* repo.setting(KEYS.url),
            database: (yield* repo.setting(KEYS.database)) ?? "huntaway",
            user: yield* repo.setting(KEYS.user),
            has_password: (yield* repo.password) !== null,
            logs: logLevelOf(yield* repo.setting(KEYS.logs)),
            agents: (yield* repo.setting(KEYS.agents)) !== "false",
            flag_url: config.telemetryUrl === null ? null : safeFlagUrl(config.telemetryUrl),
            from: cfg?.from ?? null,
            state: cfg === null ? "off" : e.state,
            queued,
            sent: e.sent,
            dropped: Number(yield* repo.setting(KEYS.dropped)) || 0,
            last_ok_at: ts(e.lastOkAt),
            last_error: e.lastError,
            last_error_at: ts(e.lastErrorAt),
            next_attempt_at: ts(e.nextAttemptAt),
          }
        })

        const update = Effect.fn("Telemetry.update")(function* (patch: TelemetryPatch) {
          const sets: Array<readonly [string, string | null]> = []
          if (patch.url !== undefined) {
            let url = patch.url?.trim() ?? ""
            if (url !== "") {
              const parsed = splitUrl(url)
              if (Result.isFailure(parsed)) return yield* new Invalid({ field: "url", reason: parsed.failure })
              const u = parsed.success
              if (u.user !== "" || u.password !== "")
                return yield* new Invalid({ field: "url", reason: "give the user and password in their own fields, not in the URL" })
              if (u.database !== null) return yield* new Invalid({ field: "url", reason: "give the database in its own field, not in the URL's path" })
              url = u.url
            }
            sets.push([KEYS.url, url === "" ? null : url])
          }
          if (patch.database !== undefined) {
            const d = patch.database?.trim() ?? ""
            if (d !== "" && !/^[A-Za-z_]\w*$/.test(d))
              return yield* new Invalid({ field: "database", reason: "database must be a ClickHouse database name (letters, digits and _)" })
            sets.push([KEYS.database, d === "" ? null : d])
          }
          if (patch.user !== undefined) sets.push([KEYS.user, patch.user?.trim() || null])
          // Not trimmed: a password is as typed.
          if (patch.password !== undefined) sets.push([KEYS.password, patch.password === "" ? null : patch.password])
          if (patch.logs !== undefined) sets.push([KEYS.logs, patch.logs === "warn" ? null : patch.logs])
          if (patch.agents !== undefined) sets.push([KEYS.agents, patch.agents ? null : "false"])
          const was = yield* readConfig
          yield* db.tx(
            Effect.gen(function* () {
              for (const [k, v] of sets) yield* repo.setSetting(k, v)
              // Turned off: what was waiting isn't wanted.
              if (was !== null && (yield* readConfig) === null) {
                yield* repo.deleteAll
                yield* repo.setSetting(KEYS.inflight, null)
                yield* repo.setSetting(KEYS.dropped, null)
              }
            }),
          )
          yield* reload
          return yield* status
        })

        const test = Effect.fn("Telemetry.test")(function* (patch: TelemetryPatch) {
          const saved = yield* readConfig
          let target: Target | null = saved?.target ?? null
          const url = patch.url?.trim() ?? ""
          if (url !== "") {
            const parsed = splitUrl(url)
            if (Result.isFailure(parsed)) return yield* new Invalid({ field: "url", reason: parsed.failure })
            const u = parsed.success
            const database = patch.database?.trim() ?? ""
            const savedPassword = yield* repo.password
            target = {
              url: u.url,
              database: database !== "" ? database : (u.database ?? "huntaway"),
              user: typeof patch.user === "string" ? patch.user.trim() : u.user,
              password: typeof patch.password === "string" ? Redacted.make(patch.password) : (savedPassword ?? Redacted.make(u.password)),
            }
          }
          if (target === null) return { ok: false, error: "no ClickHouse address is set" }
          const result = yield* run$(query(target, "INSERT INTO events FORMAT JSONEachRow", { body: "", timeout: "10 seconds" })).pipe(Effect.result)
          if (result._tag === "Success") return { ok: true, error: null }
          const e = result.failure
          const hint =
            e.code === 60
              ? " (the tables aren't there: run `huntaway telemetry init` with an admin login)"
              : e.code === 81
                ? " (the database isn't there: run `huntaway telemetry init` with an admin login)"
                : ""
          return { ok: false, error: `${e.reason}${hint}` }
        })

        return Telemetry.of({
          on,
          emit,
          taskEvent,
          runEvent,
          profileEvent,
          configEvent,
          beganSince,
          claudeEnv: forClaude,
          codexOverrides: forCodex,
          agentEvents,
          status,
          update,
          test,
          flush,
          sample,
          log: (level, module, text) => quietly(log(level, module, text)),
          drainLogs,
          logger,
          run,
        })
      }),
    )

  static readonly layer = Telemetry.layerWith(LIMITS).pipe(Layer.provideMerge(TelemetryRepo.layer))

  /** The logs tee: the server's logger with the tee beside it. */
  static readonly logs = Layer.unwrap(
    Effect.gen(function* () {
      const telemetry = yield* Telemetry
      return Logger.layer([telemetry.logger], { mergeWithExisting: true })
    }),
  )

  /**
   * The exporter's loop and the minute's metrics, and `server_start`. Not in tests (they flush and sample themselves,
   * on the test clock).
   */
  static readonly exporter = Layer.effectDiscard(
    Effect.gen(function* () {
      const telemetry = yield* Telemetry
      const config = yield* ServerConfig
      const events = yield* Events
      yield* telemetry.run.pipe(Effect.forkScoped)
      yield* telemetry.sample.pipe(Effect.delay(SAMPLE), Effect.forever, Effect.forkScoped)
      yield* telemetry.emit("events", {
        event: "server_start",
        attrs: { boot_id: events.boot, build_id: config.commit ?? "", node: process.version, platform: `${process.platform}-${process.arch}` },
      })
    }),
  )
}
