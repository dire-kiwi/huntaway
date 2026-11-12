import { Duration, Effect, Schema, Stream } from "effect"
import type { PlatformError } from "effect"
import { ChildProcess } from "effect/process"
import { TaskId } from "@huntaway/contracts"
import type { ChildProcessSpawner } from "effect/process"
import { truncate } from "../git/paths.ts"
import { cut } from "./delivery.ts"

// An automation's precheck (huntaway's routines.precheck; docs/plan/inventory/06-integrations.md 2.3, 6): a bash command
// run before each run, in the assistant's workspace or the project's folder, for up to two minutes. Exit 0 goes on with
// what it printed (`{{precheck}}`); exit 1 skips the run; anything else fails it.

/** How long a precheck may run before it's stopped (and the run fails). */
export const PRECHECK_LIMIT = "120 seconds"
/** What a precheck prints that a template gets, at most. */
const MAX_PRECHECK_CHARS = 20_000

/** Why a run doesn't go on: it's skipped (with why), or it failed. */
export class RunStopped extends Schema.TaggedError<RunStopped, { readonly brand: unique symbol }>()("RunStopped", {
  skipped: Schema.Boolean,
  detail: Schema.String,
  /** The task it made (or messaged) before it failed, if any. */
  task: Schema.NullOr(TaskId),
}) {}

export const skipped = (detail: string) => new RunStopped({ skipped: true, detail, task: null })
export const failed = (detail: string, task: TaskId | null = null) => new RunStopped({ skipped: false, detail, task })

const collect = (s: Stream.Stream<Uint8Array, PlatformError.PlatformError>) =>
  s.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (text, chunk) => (text.length > 4 * MAX_PRECHECK_CHARS ? text : text + chunk),
    ),
  )

const tail = (t: string) => truncate(t, 2000)

/** Runs `command` in `cwd` with `env` over the agents' environment: what it printed, or why the run stops. */
export const runPrecheck = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  env: Readonly<Record<string, string | undefined>>,
  command: string,
  cwd: string,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner
        .spawn(ChildProcess.make("bash", ["-c", command], { cwd, env, extendEnv: true, detached: true, killSignal: "SIGKILL", stdin: "ignore" }))
        .pipe(Effect.mapError((e) => failed(`its precheck failed: ${e.message}`)))
      const ran = yield* Effect.all([collect(handle.stdout), collect(handle.stderr), handle.exitCode], { concurrency: 3 }).pipe(
        Effect.map(([stdout, stderr, code]) => ({ _tag: "Exited", stdout, stderr, code: Number(code) }) as const),
        Effect.catch((e) => Effect.succeed({ _tag: "Signalled", reason: e.message } as const)),
        Effect.timeoutOrElse({ duration: PRECHECK_LIMIT, orElse: () => Effect.succeed({ _tag: "Over" } as const) }),
      )
      if (ran._tag === "Over") {
        yield* handle.kill({ killSignal: "SIGKILL" }).pipe(Effect.ignore)
        return yield* failed(`its precheck failed: it was still running after ${Duration.format(Duration.fromInputUnsafe(PRECHECK_LIMIT))}`)
      }
      if (ran._tag === "Signalled") return yield* failed(`its precheck failed (${ran.reason})`)
      const stdout = ran.stdout.trim()
      const stderr = ran.stderr.trim()
      if (ran.code === 0) return cut(stdout, MAX_PRECHECK_CHARS)
      if (ran.code === 1) {
        const said = [stdout, stderr].find((x) => x !== "")
        return yield* skipped(`Skipped: its precheck found nothing to do (exit 1)${said === undefined ? "" : `: ${tail(said)}`}`)
      }
      const said = stderr === "" ? tail(stdout) : tail(stderr)
      return yield* failed(`its precheck failed (exit status: ${ran.code})${said === "" ? "" : `: ${said}`}`)
    }),
  )
