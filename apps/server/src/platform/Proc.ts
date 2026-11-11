import { Context, Duration, Effect, Layer, Schema, Stream } from "effect"
import type { PlatformError, Scope } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

/** What is kept of a command's output, per stream. */
export const MAX_OUTPUT = 16 * 1024 * 1024

/** A command could not be started, or did not end within its time. */
export class ProcFailed extends Schema.TaggedError<ProcFailed, { readonly brand: unique symbol }>()("ProcFailed", {
  command: Schema.String,
  reason: Schema.String,
}) {}

export interface ProcResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

export interface RunOptions {
  readonly cwd?: string
  /** Default 60 seconds. */
  readonly timeout?: Duration.Input
  readonly env?: Record<string, string | undefined>
  readonly stdin?: string
}

export interface ProcShape {
  /** Run a command to its end and keep its output (up to `MAX_OUTPUT` each). A non-zero exit is a result, not a failure. */
  readonly run: (command: string, args: ReadonlyArray<string>, options?: RunOptions) => Effect.Effect<ProcResult, ProcFailed>
}

const collect = (stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>) =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (text, chunk) => (text.length >= MAX_OUTPUT ? text : text + chunk),
    ),
  )

/**
 * Running commands (docs/plan/06-server.md, Proc): with a timeout, a cap on what is kept, killed with the server.
 * Agents do not run through this: they run under ia-shim and outlive the server.
 */
export class Proc extends Context.Service<Proc, ProcShape>()("huntaway-server/platform/Proc") {
  static readonly layer = Layer.effect(
    Proc,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const run = Effect.fn("Proc.run")(function* (command: string, args: ReadonlyArray<string>, options: RunOptions = {}) {
        const name = [command, ...args].join(" ").slice(0, 200)
        const once: Effect.Effect<ProcResult, PlatformError.PlatformError, Scope.Scope> = Effect.gen(function* () {
          const handle = yield* spawner.spawn(
            ChildProcess.make(command, args, {
              ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
              ...(options.env === undefined ? {} : { env: options.env, extendEnv: true }),
              ...(options.stdin === undefined ? {} : { stdin: Stream.make(new TextEncoder().encode(options.stdin)) }),
            }),
          )
          const [stdout, stderr, code] = yield* Effect.all([collect(handle.stdout), collect(handle.stderr), handle.exitCode], { concurrency: 3 })
          return { code: Number(code), stdout, stderr }
        })
        return yield* once.pipe(
          Effect.scoped,
          Effect.mapError((e) => new ProcFailed({ command: name, reason: e.message })),
          Effect.timeoutOrElse({
            duration: options.timeout ?? "60 seconds",
            orElse: () =>
              Effect.fail(
                new ProcFailed({ command: name, reason: `timed out after ${Duration.format(Duration.fromInputUnsafe(options.timeout ?? "60 seconds"))}` }),
              ),
          }),
        )
      })
      return Proc.of({ run })
    }),
  )
}
