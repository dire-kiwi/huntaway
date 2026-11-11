import { Deferred, Effect, Path, Queue, Ref, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

// A server through its launcher (bin/huntaway) followed across restarts: the launcher keeps its process id while the
// server it runs is exec'd again (a restart, an Update, a crash), and each server prints its own ready line.

export const launcherUrl = new URL("../../bin/huntaway", import.meta.url)

const ReadyLine = Schema.fromJsonString(Schema.Struct({ port: Schema.Int, token: Schema.NullOr(Schema.String) }))

/**
 * `bin/huntaway <args>` with `env` added (a variable set to `undefined` is taken out), for the scope: every
 * `HUNTAWAY_READY` its servers print, its log (stderr), and its exit code. It is stopped when the scope closes.
 */
export const launchServer = (args: ReadonlyArray<string>, env: Readonly<Record<string, string | undefined>> = {}) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const path = yield* Path.Path
    const bin = yield* path.fromFileUrl(launcherUrl)
    const handle = yield* spawner.spawn(ChildProcess.make(bin, args, { env, extendEnv: true }))
    const ready = yield* Queue.unbounded<{ readonly port: number; readonly token: string }>()
    const log = yield* Ref.make("")
    yield* handle.stdout.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.runForEach((line) =>
        line.startsWith("HUNTAWAY_READY ")
          ? Schema.decodeEffect(ReadyLine)(line.slice("HUNTAWAY_READY ".length)).pipe(
              Effect.flatMap(({ port, token }) => Queue.offer(ready, { port, token: token ?? "" })),
            )
          : Effect.void,
      ),
      Effect.forkScoped,
    )
    yield* handle.stderr.pipe(
      Stream.decodeText(),
      Stream.runForEach((text) => Ref.update(log, (all) => all + text)),
      Effect.forkScoped,
    )
    const exited = yield* Deferred.make<number>()
    yield* handle.exitCode.pipe(
      Effect.flatMap((code) => Deferred.succeed(exited, Number(code))),
      Effect.forkScoped,
    )
    /** The next server it runs is up (or it exited first, which fails the test with its log). */
    const nextReady = Effect.raceFirst(
      Queue.take(ready),
      Deferred.await(exited).pipe(
        Effect.andThen((code) => Ref.get(log).pipe(Effect.andThen((text) => Effect.die(`the server exited with ${code}:\n${text}`)))),
      ),
    )
    return { pid: Number(handle.pid), nextReady, exited: Deferred.await(exited), log: Ref.get(log) }
  })
