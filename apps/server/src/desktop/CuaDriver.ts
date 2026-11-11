import { Clock, Config, Context, Effect, Exit, FiberHandle, FileSystem, Layer, Option, Ref, Schema, Scope, Semaphore } from "effect"
import type { Duration } from "effect"
import { ChildProcessSpawner } from "effect/process"
import type { DesktopDriverStatus } from "@huntaway/contracts"
import { nowTimestamp } from "../platform/columns.ts"
import { DataDir } from "../platform/DataDir.ts"
import { Proc } from "../platform/Proc.ts"
import { ServerConfig } from "../platform/ServerConfig.ts"
import { CuaResult, isVersion, LOCKERS, newestFirst, SESSION_VARS, sessionEnv, sessionKind } from "./cua.ts"
import type { Env } from "./cua.ts"
import { DriverError, startDriver } from "./driverProcess.ts"
import type { DriverProcess } from "./driverProcess.ts"

// The host's one Cua Driver (huntaway's desktop.ts `find` and desktop/driver.ts; docs/plan/inventory/05-hosts-update.md
// 2.8): `cua-driver mcp`, a child of this server spoken MCP to over its stdio. On Linux it owns the driver's runtime for
// as long as its stdin is open, so every task's calls go through this one process. It starts when a call needs it and
// stops after `IDLE` without one; stopping closes its stdin, then kills it if it hasn't gone 5 s later. Where the
// driver comes from: the server's `HUNTAWAY_CUA_DRIVER`, else the newest the host's page installed
// (`<data>/cua-driver/<version>/cua-driver`), else `cua-driver` on PATH. Never this machine's desktop in tests: their
// configuration names the fake driver (`@huntaway/testing`'s `fake-cua-driver`) and says whether the screen is locked.

export { DriverError } from "./driverProcess.ts"

/** Stop the driver after this long without a call. */
export const IDLE: Duration.Input = "10 minutes"
/** How long the driver has to start (and answer `initialize` and `tools/list`). */
const START: Duration.Input = "30 seconds"
/** A call's default time limit. */
export const CALL: Duration.Input = "120 seconds"
/** How long a stopped driver has to exit on its own before it is killed. */
const STOP_GRACE: Duration.Input = "5 seconds"
/** How long whether the screen is locked is kept. */
const LOCK_CACHE_MS = 2000

/** Where the driver comes from. */
export type DriverSource = "env" | "installed" | "path"

export interface Found {
  readonly path: string
  readonly source: DriverSource
  /** An installed one's version (its folder's name); null for the others, whose version isn't known without running them. */
  readonly version: string | null
}

/** The driver as the host's page shows it (without its stderr, which `stderr` gives). */
export type DriverStatus = Omit<DesktopDriverStatus, "stderr">

/** The running driver, and what it offers: each tool's argument names. */
interface Running {
  readonly proc: DriverProcess
  readonly scope: Scope.Closeable
  readonly tools: ReadonlyMap<string, ReadonlySet<string>>
  readonly env: Env
}

interface State {
  readonly running: Running | null
  readonly status: DriverStatus
  /** Bumped by every stop: a start that was going when it came doesn't keep what it started. */
  readonly generation: number
}

const STOPPED: DriverStatus = { state: "stopped", version: null, error: null, started_at: null, last_call_at: null, tools: 0 }

const ToolList = Schema.Struct({
  tools: Schema.optional(
    Schema.Array(
      Schema.Struct({
        name: Schema.String,
        inputSchema: Schema.optional(Schema.Struct({ properties: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)) })),
      }),
    ),
  ),
})
const InitializeResult = Schema.Struct({ serverInfo: Schema.optional(Schema.Struct({ version: Schema.optional(Schema.String) })) })
const decodeTools = Schema.decodeUnknownOption(ToolList)
const decodeInit = Schema.decodeUnknownOption(InitializeResult)
const decodeResult = Schema.decodeUnknownOption(CuaResult)

export interface CuaDriverShape {
  /** Where the host page's installs go, each in a folder named for its version. */
  readonly installRoot: string
  /** The installed versions, newest first. */
  readonly installedVersions: Effect.Effect<ReadonlyArray<string>>
  /** The driver this host would run, or null if it has none. */
  readonly find: Effect.Effect<Found | null>
  /** Start it if it isn't running; fails if it can't start. */
  readonly start: Effect.Effect<void, DriverError>
  /** Whether the running driver offers `tool` (and, with `arg`, takes that argument). */
  readonly has: (tool: string, arg?: string) => Effect.Effect<boolean>
  /** Call one of the driver's tools (starting it if need be); its MCP result. */
  readonly call: (tool: string, args: Readonly<Record<string, unknown>>, timeout?: Duration.Input) => Effect.Effect<CuaResult, DriverError>
  /** Stop it (it starts again on the next call). */
  readonly stop: Effect.Effect<void>
  readonly status: Effect.Effect<DriverStatus>
  /** The last lines it wrote to stderr, for the host's page. */
  readonly stderr: Effect.Effect<string>
  /** The environment it runs with: the running driver's, else the one it would start with. */
  readonly env: Effect.Effect<Env>
  /** What kind of desktop it sees (`sessionKind`). */
  readonly session: Effect.Effect<string | null>
  /** Whether the screen is locked: true, false, or null where it can't be told (not Linux). Kept for 2 s. */
  readonly locked: Effect.Effect<boolean | null>
}

export class CuaDriver extends Context.Service<CuaDriver, CuaDriverShape>()("huntaway-server/desktop/CuaDriver") {
  static readonly layer = Layer.effect(
    CuaDriver,
    Effect.gen(function* () {
      const config = yield* ServerConfig
      const dataDir = yield* DataDir
      const fs = yield* FileSystem.FileSystem
      const proc = yield* Proc
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const layerScope = yield* Effect.scope
      const idle = yield* FiberHandle.make<void, never>()
      const starting = yield* Semaphore.make(1)
      const state = yield* Ref.make<State>({ running: null, status: STOPPED, generation: 0 })
      const lockCache = yield* Ref.make<{ readonly at: number; readonly locked: boolean | null } | null>(null)
      const installRoot = dataDir.file("cua-driver")
      const platform = process.platform
      // Given in tests (and test servers): then neither the session nor the screen's lock is asked of the machine.
      const given = config.desktopLocked

      const exists = (path: string) => fs.exists(path).pipe(Effect.orElseSucceed(() => false))

      const installedVersions = Effect.gen(function* () {
        const names = yield* fs.readDirectory(installRoot).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []))
        const found = yield* Effect.filter(names.filter(isVersion), (v) => exists(`${installRoot}/${v}/cua-driver`), { concurrency: 1 })
        return newestFirst(found)
      })

      const find = Effect.gen(function* () {
        if (config.cuaDriver !== null) return { path: config.cuaDriver, source: "env", version: null } satisfies Found
        const v = (yield* installedVersions)[0]
        if (v !== undefined) return { path: `${installRoot}/${v}/cua-driver`, source: "installed", version: v } satisfies Found
        for (const dir of config.path.split(":")) {
          if (dir === "") continue
          const p = `${dir}/cua-driver`
          if (yield* exists(p)) return { path: p, source: "path", version: null } satisfies Found
        }
        return null
      })

      /** The server's own session variables (and `XDG_RUNTIME_DIR`, `XDG_SESSION_ID`), as its environment has them. */
      const ownEnv = Effect.gen(function* () {
        const out: Record<string, string | undefined> = {}
        for (const k of [...SESSION_VARS, "XDG_RUNTIME_DIR", "XDG_SESSION_ID", "CUA_DRIVER_RS_ENABLE_WAYLAND"]) {
          const v = yield* Config.String(k).pipe(
            Config.option,
            Effect.orElseSucceed(() => Option.none<string>()),
          )
          if (Option.isSome(v)) out[k] = v.value
        }
        return out
      })

      /** The environment a start gives the driver over the server's: the graphical session's, found if the server lacks it. */
      const freshEnv = Effect.gen(function* () {
        const own = yield* ownEnv
        const linux = platform === "linux"
        if (given !== null || !linux || (own["WAYLAND_DISPLAY"] ?? "") !== "" || (own["DISPLAY"] ?? "") !== "") return sessionEnv(own, linux, "", [])
        const systemd = yield* proc.run("systemctl", ["--user", "show-environment"], { timeout: "5 seconds" }).pipe(
          Effect.map((r) => (r.code === 0 ? r.stdout : "")),
          Effect.orElseSucceed(() => ""),
        )
        const runtime = own["XDG_RUNTIME_DIR"] ?? ""
        const sockets = runtime === "" ? [] : yield* fs.readDirectory(runtime).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []))
        return sessionEnv(own, linux, systemd, sockets)
      })

      const env = Effect.flatMap(Ref.get(state), (s) => (s.running !== null ? Effect.succeed(s.running.env) : freshEnv))

      const setStatus = (f: (s: DriverStatus) => DriverStatus) => Ref.update(state, (s) => ({ ...s, status: f(s.status) }))

      /** Ends a driver: its stdin closed, then killed if it hasn't gone after the grace. In the background. */
      const end = (running: Running) =>
        running.proc.close.pipe(
          Effect.andThen(Effect.timeout(running.proc.exited, STOP_GRACE)),
          Effect.ignore,
          Effect.andThen(Scope.close(running.scope, Exit.void)),
          Effect.forkIn(layerScope),
          Effect.asVoid,
        )

      const stop = Effect.gen(function* () {
        yield* FiberHandle.clear(idle)
        const was = yield* Ref.modify(state, (s): readonly [Running | null, State] => [
          s.running,
          {
            running: null,
            generation: s.generation + 1,
            status: s.running === null && s.status.state !== "starting" ? s.status : { ...s.status, state: "stopped", error: null, tools: 0 },
          },
        ])
        if (was !== null) yield* end(was)
      })

      /** After a call, or a start: the driver stops once it has gone `IDLE` without another. */
      const touch = Effect.gen(function* () {
        const at = yield* nowTimestamp
        yield* setStatus((s) => ({ ...s, last_call_at: at }))
        yield* FiberHandle.run(idle, Effect.andThen(Effect.sleep(IDLE), stop))
      })

      /** The driver has exited by itself (`why`): forgotten, unless another has replaced it. */
      const exited = (running: Running, why: string) =>
        Effect.gen(function* () {
          const gone = yield* Ref.modify(state, (s): readonly [boolean, State] =>
            s.running?.proc !== running.proc
              ? [false, s]
              : [
                  true,
                  {
                    ...s,
                    running: null,
                    status: {
                      ...s.status,
                      state: why.startsWith("stopped") || why === "exited (0)" ? "stopped" : "failed",
                      error: `Cua Driver ${why}`,
                      tools: 0,
                    },
                  },
                ],
          )
          if (gone) yield* Scope.close(running.scope, Exit.void)
        })

      const launch = Effect.gen(function* () {
        const found = yield* find
        if (found === null)
          return yield* new DriverError({ reason: "Cua Driver isn't installed on this host: install it from the host's page in Settings → Hosts" })
        const generation = (yield* Ref.get(state)).generation
        const at = yield* nowTimestamp
        yield* setStatus((s) => ({ ...s, state: "starting", error: null, started_at: at }))
        const driverEnv = yield* freshEnv
        const scope = yield* Scope.make()
        const p = yield* startDriver(found.path, driverEnv).pipe(Scope.provide(scope), Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner))
        const handshake = Effect.gen(function* () {
          const init = yield* p.request(
            "initialize",
            { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "huntaway", version: "1" } },
            START,
            "initialize",
          )
          yield* p.notify("notifications/initialized")
          const list = yield* p.request("tools/list", {}, START, "tools/list")
          const tools = new Map<string, ReadonlySet<string>>()
          for (const t of Option.getOrUndefined(decodeTools(list))?.tools ?? []) tools.set(t.name, new Set(Object.keys(t.inputSchema?.properties ?? {})))
          return { version: Option.getOrUndefined(decodeInit(init))?.serverInfo?.version ?? null, tools }
        })
        const shook = yield* Effect.result(handshake)
        if (shook._tag === "Failure") {
          yield* setStatus((s) => ({ ...s, state: "failed", error: shook.failure.reason }))
          yield* end({ proc: p, scope, tools: new Map(), env: driverEnv })
          return yield* shook.failure
        }
        const running: Running = { proc: p, scope, tools: shook.success.tools, env: driverEnv }
        const kept = yield* Ref.modify(state, (s): readonly [boolean, State] =>
          s.generation !== generation
            ? [false, s]
            : [true, { ...s, running, status: { ...s.status, state: "running", version: shook.success.version, error: null, tools: running.tools.size } }],
        )
        if (!kept) {
          yield* end(running)
          return yield* new DriverError({ reason: "Cua Driver was stopped while it started" })
        }
        // It's forgotten once it exits by itself.
        yield* p.exited.pipe(
          Effect.flatMap((why) => exited(running, why)),
          Effect.forkIn(layerScope),
        )
        return yield* touch
      })

      const start = Effect.flatMap(Ref.get(state), (s) => (s.running !== null ? Effect.void : launch)).pipe(Semaphore.withPermits(starting, 1))

      const has = (tool: string, arg?: string) =>
        Effect.map(Ref.get(state), (s) => {
          const args = s.running?.tools.get(tool)
          return args !== undefined && (arg === undefined || args.has(arg))
        })

      const call = Effect.fn("CuaDriver.call")(function* (tool: string, args: Readonly<Record<string, unknown>>, timeout: Duration.Input = CALL) {
        yield* start
        const s = yield* Ref.get(state)
        const running = s.running
        if (running === null) return yield* new DriverError({ reason: "Cua Driver stopped" })
        if (!running.tools.has(tool)) {
          return yield* new DriverError({ reason: `this host's Cua Driver (${s.status.version ?? "unknown version"}) has no ${tool} tool` })
        }
        yield* touch
        const result = yield* running.proc.request("tools/call", { name: tool, arguments: args }, timeout, tool).pipe(Effect.ensuring(touch))
        return Option.getOrElse(decodeResult(result), (): CuaResult => ({ content: [] }))
      })

      /** A short query of the session; a failure reads as no answer. */
      const run = (cmd: string, args: ReadonlyArray<string>) =>
        proc.run(cmd, args, { timeout: "3 seconds" }).pipe(Effect.orElseSucceed(() => ({ code: 1, stdout: "", stderr: "" })))

      /** Whether a screen locker runs, or logind says the session is locked. */
      const askLocked = Effect.fnUntraced(function* (driverEnv: Env) {
        const uid = String(process.getuid?.() ?? "")
        const user = yield* run("loginctl", ["show-user", uid, "-p", "Display", "--value"])
        const session = (driverEnv["XDG_SESSION_ID"] ?? "") !== "" ? (driverEnv["XDG_SESSION_ID"] ?? "") : user.stdout.trim()
        if (session !== "") {
          const hint = yield* run("loginctl", ["show-session", session, "-p", "LockedHint", "--value"])
          if (hint.stdout.trim() === "yes") return true
        }
        const p = yield* run("pgrep", ["-u", uid, "-x", LOCKERS.join("|")])
        return p.code === 0 && p.stdout.trim() !== ""
      })

      const locked = Effect.gen(function* () {
        if (given !== null) return given
        if (platform !== "linux") return null
        const now = yield* Clock.currentTimeMillis
        const kept = yield* Ref.get(lockCache)
        if (kept !== null && now - kept.at < LOCK_CACHE_MS) return kept.locked
        const is = yield* askLocked(yield* env)
        yield* Ref.set(lockCache, { at: now, locked: is })
        return is
      })

      return CuaDriver.of({
        installRoot,
        installedVersions,
        find,
        start,
        has,
        call,
        stop,
        status: Effect.map(Ref.get(state), (s) => s.status),
        stderr: Effect.flatMap(Ref.get(state), (s) => (s.running === null ? Effect.succeed("") : s.running.proc.stderr)),
        env,
        session: Effect.map(env, (e) => sessionKind(e, platform)),
        locked,
      })
    }),
  )
}
