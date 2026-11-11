import { Clock, Context, Effect, FiberSet, FileSystem, Layer, Option, Schedule, Schema } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import type { RunId } from "@huntaway/contracts"
import type { ProcessSpec } from "../agents/AgentDriver.ts"
import { ServerConfig } from "../platform/ServerConfig.ts"
import { RunDir } from "./RunDir.ts"

// ia-shim, the per-run supervisor (docs/plan/07-agents.md; inventory 01, section 5): finding it, starting a run under
// it, and the signals the server sends a run's process group. The shim detaches the agent from the server, which never
// holds a pipe to it and never signals the shim. Every signal is guarded by the boot id in `run.json`: after a reboot a
// recorded pid may be someone else's process.

/** How long a run's agent has after SIGTERM before SIGKILL. */
export const KILL_GRACE = "10 seconds"
/** How long a vanished shim's agent has after SIGTERM before SIGKILL (the old `REAP_GRACE`). */
export const ORPHAN_GRACE_MS = 10_000

/** A run could not be started. `reason` is what the old server said. */
export class ShimFailed extends Schema.TaggedError<ShimFailed, { readonly brand: unique symbol }>()("ShimFailed", {
  run: Schema.String,
  reason: Schema.String,
}) {}

/** This checkout's Cargo `target/` (the Rust workspace is the repository's root, with ia-shim in rust/shim). */
const TARGET_DIR = decodeURIComponent(new URL("../../../../target/", import.meta.url).pathname)

type Signal = "SIGTERM" | "SIGKILL" | 0

/** `kill(2)`, ignoring failures; true when it was delivered. */
const signal = (pid: number, sig: Signal) =>
  Effect.sync(() => {
    try {
      process.kill(pid, sig)
      return true
    } catch {
      return false
    }
  })

/** Whether a process (or, with a negative pid, a process group) exists. One we may not signal exists too. */
const alive = (pid: number) =>
  Effect.sync(() => {
    try {
      process.kill(pid, 0)
      return true
    } catch (e) {
      return e instanceof Error && "code" in e && e.code === "EPERM"
    }
  })

export interface ShimShape {
  /** The ia-shim to run agents under: `--shim-bin`, else the newer of the checkout's `target/{release,debug}/ia-shim`, else `ia-shim` beside bin/huntaway. */
  readonly binary: Effect.Effect<string | null>
  /**
   * Start `ia-shim <run dir> -- <program> <args…>` in the spec's directory with the agent's environment (the
   * server's without its own settings, plus the spec's pairs), and wait up to 5 seconds for the agent to start (`pid`)
   * or fail (`exit`). The folder must have been written (`RunDir.prepare`).
   */
  readonly spawn: (run: RunId, spec: ProcessSpec) => Effect.Effect<void, ShimFailed>
  /**
   * Signal the agent's process group (SIGTERM, and SIGKILL 10 seconds later if it has not exited). False when there
   * is nothing to signal: it has exited, has no pid, or the machine rebooted since it started.
   */
  readonly kill: (run: RunId) => Effect.Effect<boolean>
  /** Whether a pid names a live process. */
  readonly isAlive: (pid: number) => Effect.Effect<boolean>
  /** The run's shim is gone without writing `exit`: its pid is dead, or from before a reboot. */
  readonly vanished: (run: RunId) => Effect.Effect<boolean>
  /**
   * Stop the agent of a run whose shim vanished (nothing else will: `kill` goes by the exit the shim would have
   * written). Marked `orphan` until its group has gone, so a restart carries on (`watchOrphan`). Waits until then.
   */
  readonly stopOrphan: (run: RunId) => Effect.Effect<void>
  /** Carry on stopping a run marked `orphan`: SIGTERM, SIGKILL after 10 seconds, until its process group is gone. */
  readonly watchOrphan: (run: RunId) => Effect.Effect<void>
  /**
   * Make sure nothing goes on of a run whose launch failed or was stopped (the old `reap`): its input is closed, and an
   * agent the shim starts after this (it was slow, or the launch gave up waiting, or was stopped while it waited) is
   * stopped. The shim may start once `spec.json` is written; the run is marked `reap` while it is watched, so that a
   * restart carries on (`watchReap`). Returns at once: the watch is the server's.
   */
  readonly reap: (run: RunId) => Effect.Effect<void>
  /** Watch a run marked `reap` until its agent has exited or can no longer start (`REAP_WAIT`), stopping it if it starts. */
  readonly watchReap: (run: RunId) => Effect.Effect<void>
}

/** How long the shim of a launch given up on may still start its agent. */
export const REAP_WAIT_MS = 60_000
/** How long a reaped agent has after SIGTERM before SIGKILL. */
export const REAP_GRACE_MS = 10_000

export class Shim extends Context.Service<Shim, ShimShape>()("huntaway-server/runs/Shim") {
  static readonly layer = Layer.effect(
    Shim,
    Effect.gen(function* () {
      const config = yield* ServerConfig
      const fs = yield* FileSystem.FileSystem
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const dir = yield* RunDir
      // The SIGKILLs that follow a SIGTERM: the server's, interrupted when it stops (as the old timers were unref'd).
      const escalations = yield* FiberSet.make()

      const isFile = (path: string) =>
        fs.stat(path).pipe(
          Effect.map((info) =>
            info.type === "File"
              ? Option.some(
                  Option.getOrElse(
                    Option.map(info.mtime, (d) => d.getTime()),
                    () => 0,
                  ),
                )
              : Option.none<number>(),
          ),
          Effect.orElseSucceed(() => Option.none<number>()),
        )

      const binary = Effect.gen(function* () {
        if (config.shimBin !== null) return config.shimBin
        let found: { readonly path: string; readonly mtime: number } | null = null
        for (const profile of ["release", "debug"]) {
          const path = `${TARGET_DIR}${profile}/ia-shim`
          const mtime = yield* isFile(path)
          if (Option.isSome(mtime) && (found === null || mtime.value > found.mtime)) found = { path, mtime: mtime.value }
        }
        if (found !== null) return found.path
        if (config.exe === null) return null
        return `${config.exe.slice(0, Math.max(0, config.exe.lastIndexOf("/")))}/ia-shim`
      })

      const expand = (path: string) => (path === "~" ? config.home : path.startsWith("~/") ? `${config.home}${path.slice(1)}` : path)

      const spawn = Effect.fn("Shim.spawn")(function* (run: RunId, spec: ProcessSpec) {
        const fail = (reason: string) => new ShimFailed({ run, reason })
        const { agent } = yield* dir.pids(run)
        if (agent !== null || (yield* dir.exit(run)) !== null) return yield* fail(`run ${run} was already started`)
        const shim = yield* binary
        if (shim === null || Option.isNone(yield* isFile(shim))) {
          return yield* fail(`ia-shim not found (build it with \`cargo build --release -p ia-shim\` at the top of the checkout, or give --shim-bin)`)
        }
        const cwd = expand(spec.cwd)
        const isDir = yield* fs.stat(cwd).pipe(
          Effect.map((info) => info.type === "Directory"),
          Effect.orElseSucceed(() => false),
        )
        if (!isDir) return yield* fail(`working directory ${cwd} does not exist`)
        const env: Record<string, string | undefined> = { ...config.agentEnv }
        for (const [name, value] of spec.env) env[name] = value
        // The shim forks and its first process exits at once: the agent is its detached child. Not detached here, so
        // that nothing kills this short-lived process's group when its scope closes (the forked shim may not have left
        // it yet).
        const code = yield* spawner
          .exitCode(
            ChildProcess.make(shim, [dir.path(run), "--", spec.program, ...spec.args], {
              cwd,
              env,
              extendEnv: true,
              detached: false,
              stdin: "ignore",
              stdout: "ignore",
              stderr: "ignore",
            }),
          )
          .pipe(Effect.mapError((e) => fail(`failed to launch ia-shim: ${e.message}`)))
        if (Number(code) !== 0) return yield* fail(`ia-shim exited with exit status: ${code}`)
        const started = Effect.gen(function* () {
          if ((yield* dir.pids(run)).agent !== null) return { started: true, error: null }
          const exit = yield* dir.exit(run)
          if (exit !== null) return { started: false, error: exit.error ?? "the run exited immediately" }
          return { started: false, error: null }
        })
        const state = yield* started.pipe(Effect.repeat({ schedule: Schedule.spaced("50 millis"), until: (s) => s.started || s.error !== null, times: 99 }))
        if (state.error !== null) return yield* fail(state.error)
        return state.started ? undefined : yield* fail("the run did not start within 5s")
      })

      const kill = Effect.fn("Shim.kill")(function* (run: RunId) {
        // Not after a reboot: its process group is gone, and its id may be another of the user's now.
        if ((yield* dir.exit(run)) !== null || (yield* dir.rebooted(run))) return false
        const { agent } = yield* dir.pids(run)
        if (agent === null) return false
        yield* signal(-agent, "SIGTERM")
        yield* FiberSet.run(
          escalations,
          Effect.gen(function* () {
            yield* Effect.sleep(KILL_GRACE)
            if ((yield* dir.exit(run)) === null) yield* signal(-agent, "SIGKILL")
          }),
        )
        return true
      })

      const vanished = (run: RunId) =>
        Effect.gen(function* () {
          const { shim } = yield* dir.pids(run)
          if (shim === null) return false
          const gone = !(yield* alive(shim)) || (yield* dir.rebooted(run))
          return gone && (yield* dir.exit(run)) === null
        })

      const watchOrphan = Effect.fn("Shim.watchOrphan")(function* (run: RunId) {
        // Read once: the folder may yet go with its task.
        const { agent } = yield* dir.pids(run)
        if (agent !== null && !(yield* dir.rebooted(run))) {
          const since = yield* Clock.currentTimeMillis
          let sig: "SIGTERM" | "SIGKILL" = "SIGTERM"
          // The group, which may outlive its leader (its id is not given to a new process while it is in use).
          while (yield* alive(-agent)) {
            if (sig === "SIGTERM" || (yield* Clock.currentTimeMillis) - since >= ORPHAN_GRACE_MS) {
              yield* signal(-agent, sig)
              sig = "SIGKILL"
            }
            yield* Effect.sleep("100 millis")
          }
        }
        yield* dir.setMarker(run, "orphan", false).pipe(Effect.catch((e) => Effect.logWarning(`run=${run} unmarking an orphan: ${e.reason}`)))
      })

      const stopOrphan = Effect.fn("Shim.stopOrphan")(function* (run: RunId) {
        const { agent } = yield* dir.pids(run)
        if (agent === null || !(yield* alive(agent)) || (yield* dir.rebooted(run))) return
        yield* Effect.logWarning(`run=${run} stopping an agent whose supervisor (ia-shim) disappeared`)
        yield* dir.setMarker(run, "orphan", true).pipe(Effect.catch((e) => Effect.logError(`run=${run} marking an agent to stop: ${e.reason}`)))
        yield* watchOrphan(run)
      })

      const closeInput = (run: RunId) => dir.closeInput(run).pipe(Effect.catch((e) => Effect.logError(`run=${run} closing the agent's input: ${e.reason}`)))

      const watchReap = Effect.fn("Shim.watchReap")(function* (run: RunId) {
        const since = yield* Clock.currentTimeMillis
        let stopping: number | null = null
        while ((yield* dir.exit(run)) === null) {
          const now = yield* Clock.currentTimeMillis
          const { agent } = yield* dir.pids(run)
          if (agent === null) {
            if (now - since >= REAP_WAIT_MS) break
            // One gone without its exit recorded went with a reboot, say, and another process may have its pid since.
          } else if (!(yield* alive(agent)) || (yield* dir.rebooted(run))) break
          else if (stopping === null) {
            yield* Effect.logWarning(`run=${run} stopping an agent that started after its launch was given up on`)
            yield* closeInput(run)
            yield* signal(-agent, "SIGTERM")
            stopping = now
          } else if (now - stopping >= REAP_GRACE_MS) yield* signal(-agent, "SIGKILL")
          yield* Effect.sleep(stopping !== null ? "100 millis" : "20 millis")
        }
        yield* dir.setMarker(run, "reap", false).pipe(Effect.catch((e) => Effect.logWarning(`run=${run} unmarking a reap: ${e.reason}`)))
      })

      const reap = Effect.fn("Shim.reap")(function* (run: RunId) {
        yield* closeInput(run)
        // The shim is started once spec.json is written.
        const specWritten = yield* fs.exists(`${dir.path(run)}/spec.json`).pipe(Effect.orElseSucceed(() => false))
        if (!specWritten || (yield* dir.exit(run)) !== null) return
        yield* dir.setMarker(run, "reap", true).pipe(Effect.catch((e) => Effect.logError(`run=${run} marking a run to stop: ${e.reason}`)))
        yield* FiberSet.run(escalations, watchReap(run))
      })

      return Shim.of({ binary, spawn, kill, isAlive: alive, vanished, stopOrphan, watchOrphan, reap, watchReap })
    }),
  )
}
