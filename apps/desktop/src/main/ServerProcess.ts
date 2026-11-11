import { Deferred, Effect, Exit, Fiber, Option, Ref, Schema, Scope, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { BackupFailure, StartFailed } from "./fallback.ts"

// One server started by the shell, through the launcher (`bin/huntaway serve …`, bundled or the checkout's): what it
// says on stdout (`HUNTAWAY_READY {"port":…,"token":…}`, or `HUNTAWAY_BACKUP_FAILED {reason, why, dir}` before it
// exits), the last lines of its output, and its exit. Stopping it is SIGTERM to the launcher, which stops node, and
// SIGKILL after 10 seconds. Only the launcher is signalled: agents run under ia-shim and outlive the server.

const ReadyLine = Schema.fromJsonString(Schema.Struct({ port: Schema.Finite, token: Schema.NullOr(Schema.String) }))
const BackupLine = Schema.fromJsonString(BackupFailure)

/** How long to wait for the last of a server's output after it exits (agents it started may hold its pipes). */
const DRAIN = "500 millis"

export interface ServerCommand {
  readonly bin: string
  readonly args: ReadonlyArray<string>
  /** Over the shell's own environment. */
  readonly env: Readonly<Record<string, string | undefined>>
}

export interface ServerHandle {
  readonly pid: number
  /** Its token once it printed its ready line (null when it was given one, which it doesn't print). */
  readonly ready: Deferred.Deferred<string | null>
  /** Its exit code (null when a signal ended it), once it has exited and the last of its output is in. */
  readonly exited: Deferred.Deferred<number | null>
  /** Why it couldn't back up the database, if it said so. */
  readonly backup: Ref.Ref<BackupFailure | null>
  /** SIGTERM, SIGKILL after 10 seconds; waits for it to exit. */
  readonly stop: Effect.Effect<void>
}

/** The token in a `HUNTAWAY_READY {…}` line, or none if `line` is not one. */
export const readyToken = (line: string): Effect.Effect<Option.Option<string | null>> => {
  const at = line.indexOf("HUNTAWAY_READY ")
  if (at < 0) return Effect.succeedNone
  return Schema.decodeEffect(ReadyLine)(line.slice(at + "HUNTAWAY_READY ".length).trim()).pipe(
    Effect.map((ready) => Option.some(ready.token)),
    Effect.orElseSucceed(() => Option.none()),
  )
}

/** The failure in a `HUNTAWAY_BACKUP_FAILED {…}` line, or none. */
export const backupFailure = (line: string): Effect.Effect<Option.Option<BackupFailure>> => {
  const at = line.indexOf("HUNTAWAY_BACKUP_FAILED ")
  if (at < 0) return Effect.succeedNone
  return Schema.decodeEffect(BackupLine)(line.slice(at + "HUNTAWAY_BACKUP_FAILED ".length).trim()).pipe(Effect.option)
}

/**
 * Start `command`, reporting each line of its output to `onLine`. Fails (`early`) if it can't be run at all. The
 * process lives until `stop`, or until it exits by itself.
 */
export const spawnServer = Effect.fn("spawnServer")(function* (
  command: ServerCommand,
  onLine: (stream: "stdout" | "stderr", line: string) => Effect.Effect<void>,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const scope = yield* Scope.make()
  const handle = yield* spawner
    .spawn(
      ChildProcess.make(command.bin, command.args, {
        env: command.env,
        extendEnv: true,
        // Its own process group would have the spawner signal the whole group, agents' helpers included.
        detached: false,
        stdin: "ignore",
        killSignal: "SIGTERM",
        forceKillAfter: "10 seconds",
      }),
    )
    .pipe(
      Scope.provide(scope),
      Effect.catch((error) =>
        Scope.close(scope, Exit.void).pipe(Effect.andThen(Effect.fail(new StartFailed({ message: error.message, early: true, backup: null })))),
      ),
    )
  const ready = yield* Deferred.make<string | null>()
  const exited = yield* Deferred.make<number | null>()
  const backup = yield* Ref.make<BackupFailure | null>(null)

  const lines = (stream: "stdout" | "stderr", bytes: Stream.Stream<Uint8Array, unknown>) =>
    bytes.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.runForEach((line) =>
        Effect.gen(function* () {
          yield* onLine(stream, line)
          if (stream !== "stdout") return
          const token = yield* readyToken(line)
          if (Option.isSome(token)) yield* Deferred.succeed(ready, token.value)
          const failure = yield* backupFailure(line)
          if (Option.isSome(failure)) yield* Ref.set(backup, failure.value)
        }),
      ),
      Effect.ignore,
    )
  const output = yield* Effect.all([lines("stdout", handle.stdout), lines("stderr", handle.stderr)], { concurrency: 2, discard: true }).pipe(
    Effect.forkIn(scope),
  )
  yield* handle.exitCode.pipe(
    Effect.map((code): number | null => Number(code)),
    Effect.orElseSucceed(() => null),
    // Once it has exited and the last of its output is in: when its pipes close, unless agents it started still hold them.
    Effect.tap(() => Fiber.join(output).pipe(Effect.timeoutOption(DRAIN))),
    Effect.flatMap((code) => Deferred.succeed(exited, code)),
    Effect.forkIn(scope),
  )
  return {
    pid: Number(handle.pid),
    ready,
    exited,
    backup,
    stop: Scope.close(scope, Exit.void),
  } satisfies ServerHandle
})
