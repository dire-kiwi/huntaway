import { Cause, Context, Effect, FiberSet, Layer, Ref, Schema } from "effect"
import { Conflict } from "@huntaway/contracts"
import type { RestartJob, RestartPhase } from "@huntaway/contracts"
import { Events } from "../platform/Events.ts"
import { ServerConfig } from "../platform/ServerConfig.ts"
import { restartArgs, Supervisor } from "./Supervisor.ts"

/** A restart job that stopped short: why, for the job's `failed` phase. */
export class JobFailed extends Schema.TaggedError<JobFailed, { readonly brand: unique symbol }>()("JobFailed", { reason: Schema.String }) {}

/** The log's tail is kept: a build's output can be long. */
const LOG_MAX = 200_000
const LOG_KEEP = 150_000

/** How long a restart waits before it execs, so the websocket delivers the last events. */
const LAST_EVENTS = "300 millis"

export interface RestartsShape {
  /** The job running, or the last one that failed. */
  readonly current: Effect.Effect<RestartJob | null>
  /**
   * Start `job` in the background, unless one is running (`Conflict`, `restart_in_progress`). A job only ends by
   * failing (it restarts the server otherwise), and its failure is shown in its `failed` phase.
   */
  readonly begin: (job: Effect.Effect<void, JobFailed>) => Effect.Effect<void, Conflict>
  readonly phase: (phase: RestartPhase, error?: string | null) => Effect.Effect<void>
  readonly log: (line: string) => Effect.Effect<void>
  /** Exec `exe` with this server's arguments (and `env` on top of its environment), in the `restarting` phase. */
  readonly restartInto: (exe: string, env?: ReadonlyArray<readonly [string, string]>) => Effect.Effect<never, JobFailed>
}

/** The one restart (or update) job of this server, which every way of restarting goes through, and its events. */
export class Restarts extends Context.Service<Restarts, RestartsShape>()("huntaway-server/update/Restarts") {
  static readonly layer = Layer.effect(
    Restarts,
    Effect.gen(function* () {
      const events = yield* Events
      const supervisor = yield* Supervisor
      const config = yield* ServerConfig
      const job = yield* Ref.make<RestartJob | null>(null)
      const running = yield* FiberSet.make()

      const phase = (to: RestartPhase, error: string | null = null) =>
        Ref.update(job, (j) => (j === null ? j : { phase: to, log: j.log, error })).pipe(Effect.andThen(events.emit({ type: "restart", phase: to, error })))

      const log = (line: string) =>
        Ref.update(job, (j) => {
          if (j === null) return j
          const all = `${j.log}${line}\n`
          return { phase: j.phase, error: j.error, log: all.length > LOG_MAX ? all.slice(all.length - LOG_KEEP) : all }
        }).pipe(Effect.andThen(events.emit({ type: "restart_log", line })))

      const begin = Effect.fn("Restarts.begin")(function* (work: Effect.Effect<void, JobFailed>) {
        const started = yield* Ref.modify(job, (j): readonly [boolean, RestartJob | null] =>
          j !== null && j.phase !== "failed" ? [false, j] : [true, { phase: "starting", log: "", error: null }],
        )
        if (!started) return yield* new Conflict({ reason: "restart_in_progress", detail: "a restart is already in progress" })
        const failed = (cause: Cause.Cause<JobFailed>) => {
          const reason = cause.reasons.find((r) => r._tag === "Fail")
          const why = reason !== undefined && reason._tag === "Fail" ? reason.error.reason : Cause.pretty(cause)
          return Effect.logError(`restart failed: ${why}`).pipe(Effect.andThen(phase("failed", why)))
        }
        return yield* Effect.asVoid(FiberSet.run(running, work.pipe(Effect.catchCause(failed))))
      })

      const restartInto = Effect.fn("Restarts.restartInto")(function* (exe: string, env: ReadonlyArray<readonly [string, string]> = []) {
        // Agents keep running under ia-shim; the new process follows them on.
        yield* phase("restarting")
        yield* Effect.sleep(LAST_EVENTS)
        return yield* supervisor.exec(exe, restartArgs(config.args), env).pipe(Effect.mapError((e) => new JobFailed({ reason: e.message })))
      })

      return Restarts.of({ current: Ref.get(job), begin, phase, log, restartInto })
    }).pipe(Effect.annotateLogs({ module: "update" })),
  )
}
