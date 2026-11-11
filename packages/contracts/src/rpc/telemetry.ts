import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { Invalid } from "../errors.ts"
import { Auth, RequiredScope } from "../session.ts"
import { Timestamp } from "../time.ts"

// The host's telemetry (docs/plan/06-server.md, Platform: `Telemetry`; inventory 07, routes 31–32, and the old
// `GET /api/debug/event-loop`): where its rows go (a ClickHouse of the user's own), how sending is going, a test insert,
// and the event loop's measurements (`Lag`). The password is write-only: no answer has it.

/** Which of the server's log lines go to the `logs` table. */
export const TelemetryLogs = Schema.Literals(["off", "warn", "info"])
export type TelemetryLogs = typeof TelemetryLogs.Type

/** `ok`: sending (or nothing to send); `retrying`: a send failed and is tried again soon; `error`: ClickHouse or its login is set up wrong. */
export const TelemetryState = Schema.Literals(["off", "ok", "retrying", "error"])
export type TelemetryState = typeof TelemetryState.Type

/** The host's telemetry settings, without the password, and how sending is going. */
export const TelemetryStatus = Schema.Struct({
  url: Schema.NullOr(Schema.String),
  database: Schema.String,
  user: Schema.NullOr(Schema.String),
  has_password: Schema.Boolean,
  logs: TelemetryLogs,
  /** Runs send their agents' own OpenTelemetry events (for the profiles that send). */
  agents: Schema.Boolean,
  /** `--telemetry-url`'s ClickHouse without its login, which is used while the settings have none. */
  flag_url: Schema.NullOr(Schema.String),
  /** Where the address in use came from. */
  from: Schema.NullOr(Schema.Literals(["settings", "flag"])),
  state: TelemetryState,
  /** Rows waiting in the outbox, by table. */
  queued: Schema.Record(Schema.String, Schema.Int),
  /** Rows sent since the server started. */
  sent: Schema.Int,
  /** Rows dropped since sending last worked. */
  dropped: Schema.Int,
  last_ok_at: Schema.NullOr(Timestamp),
  last_error: Schema.NullOr(Schema.String),
  last_error_at: Schema.NullOr(Timestamp),
  next_attempt_at: Schema.NullOr(Timestamp),
})
export interface TelemetryStatus extends Schema.Schema.Type<typeof TelemetryStatus> {}

/**
 * A change to the settings: `url` null or blank turns telemetry off (and deletes what waits); `password` null clears
 * it; a field left out stays.
 */
export const TelemetryPatch = Schema.Struct({
  url: Schema.optional(Schema.NullOr(Schema.String)),
  database: Schema.optional(Schema.NullOr(Schema.String)),
  user: Schema.optional(Schema.NullOr(Schema.String)),
  password: Schema.optional(Schema.NullOr(Schema.String)),
  logs: Schema.optional(TelemetryLogs),
  agents: Schema.optional(Schema.Boolean),
})
export interface TelemetryPatch extends Schema.Schema.Type<typeof TelemetryPatch> {}

export const TelemetryTestResult = Schema.Struct({ ok: Schema.Boolean, error: Schema.NullOr(Schema.String) })
export interface TelemetryTestResult extends Schema.Schema.Type<typeof TelemetryTestResult> {}

/** A stall of the event loop: when, for how long. */
export const EventLoopStall = Schema.Struct({ at: Timestamp, ms: Schema.Finite })

/** The event loop's delay since the server started (or the last reset), in ms, and its stalls, newest first. */
export const EventLoopReport = Schema.Struct({
  since: Timestamp,
  stall_log_ms: Schema.Finite,
  delay_ms: Schema.NullOr(
    Schema.Struct({
      count: Schema.Int,
      min: Schema.Finite,
      mean: Schema.Finite,
      p50: Schema.Finite,
      p90: Schema.Finite,
      p99: Schema.Finite,
      max: Schema.Finite,
    }),
  ),
  stalls: Schema.Array(EventLoopStall),
})
export interface EventLoopReport extends Schema.Schema.Type<typeof EventLoopReport> {}

export class TelemetryRpcs extends RpcGroup.make(
  Rpc.make("admin.telemetry", { success: TelemetryStatus }).annotate(RequiredScope, "admin"),
  Rpc.make("admin.updateTelemetry", { payload: { patch: TelemetryPatch }, success: TelemetryStatus, error: Invalid }).annotate(RequiredScope, "admin"),
  /** An empty insert into `events` with the values given (a password left out is the saved one), else the saved ones. */
  Rpc.make("admin.testTelemetry", { payload: { patch: TelemetryPatch }, success: TelemetryTestResult, error: Invalid }).annotate(RequiredScope, "admin"),
  /** The event loop's measurements; `reset` starts them again after answering. */
  Rpc.make("admin.eventLoop", { payload: { reset: Schema.optional(Schema.Boolean) }, success: EventLoopReport }).annotate(RequiredScope, "admin"),
).middleware(Auth) {}
