import { Clock, Console, Context, Deferred, Effect, FileSystem, Layer, Option, Path, PubSub, Ref, Schema, SynchronizedRef } from "effect"
import type { Digest } from "effect/crypto"
import type { HttpClient } from "effect/http"
import type { ChildProcessSpawner } from "effect/process"
import { chooseServer, parseVersion, releaseEnv, serverExe, serverFiles } from "../shared/versions.ts"
import { markVersionBad, readAppState } from "./appState.ts"
import { Desktop } from "./Desktop.ts"
import { NoServer, StartFailed, startWithFallback } from "./fallback.ts"
import type { BackupFailure } from "./fallback.ts"
import { healthy } from "./health.ts"
import { installKindOf, serverPath } from "./install.ts"
import { spawnServer } from "./ServerProcess.ts"
import type { ServerHandle } from "./ServerProcess.ts"
import { frameStamp } from "./stamp.ts"

// The board's server, for the windows: the one configured (remote mode), one already running on the port, or one
// started here through the launcher (docs/plan/inventory/10-web-client.md §9.1). A server started here that stops after
// it was ready is started again with backoff; one this app attached to is left alone, and so is everything on quit but
// a server started here.

/** The server the board is on. */
export interface Target {
  readonly base: string
  readonly token: string
}

/** No server could be found or started; the error page says why. */
export class ServerUnavailable extends Schema.TaggedError<ServerUnavailable, { readonly brand: unique symbol }>()("ServerUnavailable", {
  message: Schema.String,
  title: Schema.NullOr(Schema.String),
  backup: Schema.NullOr(Schema.Struct({ reason: Schema.String, why: Schema.String, dir: Schema.String })),
}) {}

/** What the windows hear: a server is there now (windows on the error page load the board), or none, and why. */
export type ServerNews = { readonly _tag: "Up" } | { readonly _tag: "Down"; readonly error: ServerUnavailable }

/** The server's last lines of output kept for the error page. */
export const LOG_LINES = 40
/** How long a start waits for the ready line before it counts as slow. */
export const READY_TIMEOUT = "15 seconds"
/** A server started here that stops this many times in RESTART_WINDOW_MS is not started again by itself. */
const MAX_RESTARTS = 5
const RESTART_WINDOW_MS = 5 * 60_000

/** A server to start. `bundled`: the one in a release build's resources. */
interface ServerChoice {
  readonly bin: string
  readonly version: string | null
  readonly bundled: boolean
}

/** What the server's methods run on. */
type Needs = ChildProcessSpawner.ChildProcessSpawner | HttpClient.HttpClient | FileSystem.FileSystem | Path.Path | Digest.Digest

const unavailable = (error: { readonly message: string; readonly backup?: BackupFailure | null }, title: string | null = null) =>
  new ServerUnavailable({ message: error.message, title, backup: error.backup ?? null })

export class Servers extends Context.Service<
  Servers,
  {
    /** The server to use, found or started (one at a time: windows that load together share one). */
    readonly resolve: Effect.Effect<Target, ServerUnavailable>
    /** The last server resolved. */
    readonly target: Effect.Effect<Option.Option<Target>>
    /** What the windows hear about the server. */
    readonly news: PubSub.PubSub<ServerNews>
    /** How many board windows are open: a server lost with none open is not started again. */
    readonly setWindows: (count: number) => Effect.Effect<void>
    /** The next start goes ahead without a backup of the database (the error page's "Start without a backup"). */
    readonly skipBackupOnce: Effect.Effect<void>
    /** The server's last lines of output and the shell's notes about its start. */
    readonly log: Effect.Effect<ReadonlyArray<string>>
    /** Whether a server started here is running, read at once: Electron's before-quit decides there and then. */
    readonly runningNow: () => boolean
    /**
     * The app is quitting: stop the server started here (SIGTERM, SIGKILL after 10 seconds), then run `then`. False when
     * there is none, and the app may quit at once.
     */
    readonly quit: (then: Effect.Effect<void>) => Effect.Effect<boolean>
  }
>()("huntaway-desktop/main/Servers") {
  static readonly layer = Layer.effect(
    Servers,
    Effect.gen(function* () {
      const desktop = yield* Desktop
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      // What the methods need, taken once here (docs/effect.md, Services) and given to each method the service offers.
      const context = yield* Effect.context<Needs>()
      const layerScope = yield* Effect.scope

      const news = yield* PubSub.unbounded<ServerNews>()
      const server = yield* Ref.make<Option.Option<ServerHandle>>(Option.none())
      const stopping = yield* Ref.make(false)
      const failed = yield* Ref.make<ReadonlyArray<string>>([])
      const log = yield* Ref.make<ReadonlyArray<string>>([])
      const skipBackup = yield* Ref.make(false)
      const restarts = yield* Ref.make<ReadonlyArray<number>>([])
      const windows = yield* Ref.make(0)
      const target = yield* Ref.make<Option.Option<Target>>(Option.none())
      const resolving = yield* SynchronizedRef.make<Option.Option<Deferred.Deferred<Target, ServerUnavailable>>>(Option.none())

      const exe = serverExe(desktop.platform)
      const appDir = path.join(desktop.dataDir, "app")
      const base = `http://127.0.0.1:${desktop.port}`
      const isFile = (file: string) =>
        fs.stat(file).pipe(
          Effect.map((info) => info.type === "File"),
          Effect.orElseSucceed(() => false),
        )

      const keep = (line: string) => Ref.update(log, (lines) => [...lines, line].slice(-LOG_LINES))
      /** A line about the server's start, in the app's log and the error page's server output. */
      const note = (line: string) => Console.error(line).pipe(Effect.andThen(keep(line)))

      const readToken = fs.readFileString(path.join(desktop.dataDir, "auth_token")).pipe(
        Effect.map((text) => text.trim()),
        Effect.orElseSucceed(() => ""),
      )

      /** What a release build tells the server it starts, worked out once. */
      const releaseVars = yield* Effect.cached(
        Effect.gen(function* () {
          if (desktop.resourcesDir === null) return {}
          const shell = yield* frameStamp(path.join(desktop.appPath, "dist"), desktop.electronVersion).pipe(
            Effect.tapError((error) => Console.error(`couldn't stamp the app's frame: ${error.message}`)),
            Effect.orElseSucceed(() => ""),
          )
          return releaseEnv({
            releaseUpdates: desktop.releaseUpdates,
            version: desktop.appVersion,
            shell,
            install: yield* installKindOf(desktop),
            bundled: path.join(desktop.resourcesDir, exe),
          })
        }),
      )
      const loginPath = yield* Effect.cached(serverPath(desktop))

      /** The environment for a server started here: a release build's turns on release updates, whichever binary it runs. */
      const serverEnv = Effect.gen(function* () {
        const once = yield* Ref.getAndSet(skipBackup, false)
        return {
          PATH: yield* loginPath,
          ...(yield* releaseVars),
          ...(desktop.file.skipDbBackup ? { HUNTAWAY_SKIP_DB_BACKUP: "1" } : {}),
          ...(once ? { HUNTAWAY_SKIP_DB_BACKUP_ONCE: "1" } : {}),
        }
      })

      /**
       * The server to start: `HUNTAWAY_SERVER_BIN` or desktop.json's `serverBin`; for a release build, the installed
       * version `chooseServer` picks (versions in `skip` failed just now) or the bundled one; from a checkout, its own.
       */
      const findServer = (skip: ReadonlyArray<string>) =>
        Effect.gen(function* () {
          if (desktop.serverBin !== null && (yield* fs.exists(desktop.serverBin).pipe(Effect.orElseSucceed(() => false)))) {
            return { bin: desktop.serverBin, version: null, bundled: false } satisfies ServerChoice
          }
          if (desktop.resourcesDir !== null) {
            const state = yield* readAppState(appDir)
            const listed = [state["trying"], state["current"], state["previous"]].filter((v): v is string => typeof v === "string" && parseVersion(v) !== null)
            const installed = new Set<string>()
            for (const v of listed) {
              const complete = yield* Effect.forEach(serverFiles(exe), (file) => isFile(path.join(appDir, v, file)), { concurrency: 1 })
              if (complete.every(Boolean)) installed.add(v)
            }
            const version = chooseServer({ state, minVersion: desktop.appVersion, skip, installed: (v) => installed.has(v) })
            if (version !== null) return { bin: path.join(appDir, version, exe), version, bundled: false } satisfies ServerChoice
            const bundled = path.join(desktop.resourcesDir, exe)
            if (yield* isFile(bundled)) return { bin: bundled, version: null, bundled: true } satisfies ServerChoice
          }
          if (desktop.checkoutRoot !== null) {
            const root = desktop.checkoutRoot
            // A checkout's server runs from its sources once its dependencies are installed.
            if (yield* isFile(path.join(root, "apps", "server", "node_modules", "effect", "package.json"))) {
              return { bin: path.join(root, "apps", "server", "bin", "huntaway"), version: null, bundled: false } satisfies ServerChoice
            }
          }
          return yield* new NoServer({ message: "Could not find the huntaway server. Run `pnpm install` at the top of the checkout." })
        })

      /** Mark an installed release version bad in state.json, so that it isn't started again. */
      const saveBad = (version: string) =>
        note(`marking huntaway ${version} bad`).pipe(
          Effect.andThen(markVersionBad(appDir, version)),
          Effect.catch((error) => note(`couldn't save that in ${path.join(appDir, "state.json")}: ${error.message}`)),
        )

      const serverArgs = (): ReadonlyArray<string> => [
        "serve",
        "--port",
        String(desktop.port),
        ...(desktop.dataDirGiven ? ["--data-dir", desktop.dataDir] : []),
        ...(desktop.file.host === null ? [] : ["--host", desktop.file.host]),
      ]

      /**
       * Start `choice`, succeeding with its token once it is ready. Fails `early` if it exits (or can't be run) first, or
       * not early after READY_TIMEOUT; then, should it be ready after all while it is still the latest start,
       * `lateReady` runs and the windows hear it is up. If it exits after it was ready, it was lost (serverLost); if it
       * exits after the wait timed out, the next one is started (lateExit).
       */
      const startOne = (choice: ServerChoice, lateReady: Effect.Effect<void, never, Needs>) =>
        Effect.gen(function* () {
          const what = choice.version === null ? (choice.bundled ? " bundled with the app" : "") : ` ${choice.version}`
          yield* Console.log(`starting the huntaway server${what}: ${choice.bin}`)
          const env = yield* serverEnv
          const handle = yield* spawnServer({ bin: choice.bin, args: serverArgs(), env }, (stream, line) =>
            stream === "stdout" ? Console.log(line) : Console.error(line).pipe(Effect.andThen(line.trim() === "" ? Effect.void : keep(line))),
          )
          yield* Ref.set(server, Option.some(handle))
          const timedOut = yield* Ref.make(false)
          const latest = Effect.map(Ref.get(server), (current) => Option.isSome(current) && current.value === handle)

          // What happens when it exits, whenever that is.
          yield* Effect.gen(function* () {
            const code = yield* Deferred.await(handle.exited)
            const wasLatest = yield* latest
            if (wasLatest) yield* Ref.set(server, Option.none())
            yield* Console.error(`huntaway server exited (${code ?? "signal"})`)
            if (yield* Ref.get(stopping)) return
            if (yield* Deferred.isDone(handle.ready)) yield* serverLost
            else if ((yield* Ref.get(timedOut)) && wasLatest) yield* lateExit(choice.version)
          }).pipe(Effect.forkIn(layerScope))
          // Ready only after the wait timed out.
          yield* Effect.gen(function* () {
            yield* Deferred.await(handle.ready)
            if ((yield* Ref.get(timedOut)) && (yield* latest) && !(yield* Ref.get(stopping))) {
              yield* lateReady
              yield* PubSub.publish(news, { _tag: "Up" })
            }
          }).pipe(Effect.forkIn(layerScope))

          const exitedEarly = Effect.gen(function* () {
            const code = yield* Deferred.await(handle.exited)
            const backup = yield* Ref.get(handle.backup)
            const message =
              backup === null ? `Server exited with ${code === null ? "a signal" : `code ${code}`}` : `It couldn't back up the database: ${backup.why}`
            return yield* new StartFailed({ message, early: true, backup })
          })
          return yield* Effect.raceFirst(Deferred.await(handle.ready), exitedEarly).pipe(
            Effect.timeoutOrElse({
              duration: READY_TIMEOUT,
              orElse: () =>
                Ref.set(timedOut, true).pipe(
                  Effect.andThen(Effect.fail(new StartFailed({ message: "Server did not start within 15s", early: false, backup: null }))),
                ),
            }),
          )
        }).pipe(
          Effect.tapError((error) =>
            Effect.gen(function* () {
              if (choice.version !== null && error.early && !(yield* Ref.get(stopping)))
                yield* note(`huntaway ${choice.version} didn't start (${error.message})`)
            }),
          ),
        )

      /**
       * Start a server and succeed with its token. Its callers have found nothing on the port, so for a release build, a
       * version an Update was exec'ing into (`trying`) didn't come up: it is passed over, and marked bad once a server
       * comes up.
       */
      const startServer = Effect.gen(function* () {
        yield* Ref.set(log, [])
        if (desktop.resourcesDir !== null) {
          const trying = (yield* readAppState(appDir))["trying"]
          if (typeof trying === "string" && !(yield* Ref.get(failed)).includes(trying)) {
            yield* note(`huntaway ${trying} didn't come up after an update`)
            yield* Ref.update(failed, (versions) => [...versions, trying])
          }
        }
        const started = yield* startWithFallback({
          choose: findServer,
          start: startOne,
          // Another launch's server may have taken the port meanwhile: then the version isn't to blame.
          portTaken: healthy(base, desktop.port, 3).pipe(Effect.orElseSucceed(() => true)),
          failed,
          saveBad,
          stopping: Ref.get(stopping),
        })
        return started.token ?? (yield* readToken)
      })

      /** An installed version exited before it was ready, but after startServer stopped waiting: start the next one. */
      const lateExit = (version: string | null) =>
        Effect.gen(function* () {
          if (version === null || (yield* Ref.get(stopping)) || (yield* Ref.get(windows)) === 0) return
          yield* note(`huntaway ${version} exited before it was ready`)
          yield* Ref.update(failed, (versions) => (versions.includes(version) ? versions : [...versions, version]))
          yield* PubSub.publish(news, { _tag: "Up" })
        })

      /**
       * The server started here stopped after it was ready. The board stays open and reconnects once there is a server
       * again: one that started meanwhile, or one started here again, waiting longer after each that stops at once
       * (1, 2, 4, 8, 16 seconds). After five of those in five minutes, the error page says why, in every window. (The
       * launcher starts node again itself after a crash, so for it this is once that has given up.)
       */
      const serverLost: Effect.Effect<void, never, Needs> = Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        const recent = (yield* Ref.get(restarts)).filter((t) => now - t < RESTART_WINDOW_MS)
        if (recent.length >= MAX_RESTARTS) {
          yield* Ref.set(restarts, [])
          yield* PubSub.publish(news, {
            _tag: "Down",
            error: unavailable({ message: `It stopped ${recent.length + 1} times in five minutes.` }, "Huntaway's server stopped"),
          })
          return
        }
        yield* Ref.set(restarts, [...recent, now])
        yield* Effect.sleep(Math.min(30_000, 1000 * 2 ** recent.length))
        if ((yield* Ref.get(stopping)) || (yield* Ref.get(windows)) === 0) return
        const up = yield* healthy(base, desktop.port).pipe(
          Effect.flatMap((answers) => (answers ? Effect.succeed(true) : Effect.as(startServer, true))),
          Effect.catch((error) =>
            healthy(base, desktop.port, 3).pipe(
              Effect.orElseSucceed(() => false),
              Effect.tap((answers) =>
                answers
                  ? Effect.void
                  : PubSub.publish(news, {
                      _tag: "Down",
                      error: unavailable(
                        { message: `It didn't start again: ${error.message}`, backup: "backup" in error ? error.backup : null },
                        "Huntaway's server stopped",
                      ),
                    }),
              ),
            ),
          ),
        )
        if (up) yield* Console.log("the huntaway server is up again")
      })

      /** The server to use: the one configured, one already running on the port, or one started here. */
      const resolveTarget = Effect.gen(function* () {
        if (desktop.file.serverUrl !== null) return { base: desktop.file.serverUrl.replace(/\/+$/, ""), token: desktop.file.token ?? "" }
        if (yield* healthy(base, desktop.port)) return { base, token: yield* readToken }
        return yield* startServer.pipe(
          Effect.map((token) => ({ base, token })),
          Effect.catch((error) =>
            // Another launch's server may have taken the port meanwhile: use it.
            healthy(base, desktop.port, 3).pipe(
              Effect.orElseSucceed(() => false),
              Effect.flatMap((answers) => (answers ? Effect.map(readToken, (token) => ({ base, token })) : Effect.fail(error))),
            ),
          ),
        )
      }).pipe(Effect.mapError((error) => unavailable({ message: error.message, backup: error._tag === "StartFailed" ? error.backup : null })))

      const resolve = Effect.gen(function* () {
        const pending = yield* SynchronizedRef.modifyEffect(resolving, (current) =>
          Option.isSome(current)
            ? Effect.succeed([current.value, current] as const)
            : Effect.gen(function* () {
                const deferred = yield* Deferred.make<Target, ServerUnavailable>()
                yield* resolveTarget.pipe(
                  Effect.exit,
                  Effect.flatMap((exit) => Deferred.done(deferred, exit)),
                  Effect.ensuring(SynchronizedRef.set(resolving, Option.none())),
                  Effect.forkIn(layerScope),
                )
                return [deferred, Option.some(deferred)] as const
              }),
        )
        const found = yield* Deferred.await(pending)
        yield* Ref.set(target, Option.some(found))
        return found
      })

      const quit = (then: Effect.Effect<void>) =>
        Effect.gen(function* () {
          const current = yield* Ref.get(server)
          if (Option.isNone(current)) return false
          // Wait for it to exit, so that a relaunch (after an update) starts a new server rather than finding this one going down.
          if (!(yield* Ref.getAndSet(stopping, true))) yield* current.value.stop.pipe(Effect.andThen(then), Effect.forkIn(layerScope))
          return true
        })

      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          yield* Ref.set(stopping, true)
          const current = yield* Ref.get(server)
          if (Option.isSome(current)) yield* current.value.stop
        }),
      )

      return Servers.of({
        resolve: resolve.pipe(Effect.provideContext(context)),
        target: Ref.get(target),
        news,
        setWindows: (count) => Ref.set(windows, count),
        skipBackupOnce: note("starting without a backup of the database, as asked").pipe(Effect.andThen(Ref.set(skipBackup, true))),
        log: Ref.get(log),
        runningNow: () => Option.isSome(Ref.getUnsafe(server)),
        quit: (then) => quit(then).pipe(Effect.provideContext(context)),
      })
    }),
  )
}
