import { Cause, Context, Effect, FiberMap, FiberSet, Layer } from "effect"
import type { RunId } from "@huntaway/contracts"
import { Changes } from "../platform/Changes.ts"
import type { RunExitStatus } from "../platform/Changes.ts"
import type { Run } from "./Run.ts"
import { RunDir } from "./RunDir.ts"
import { RunOutput } from "./RunOutput.ts"
import { RunRepo } from "./RunRepo.ts"
import { Shim } from "./Shim.ts"

// Following a run (docs/plan/07-agents.md, Following; inventory 01, section 5): read its output from the saved offset,
// hand each line to `RunOutput`, save the offset after each chunk, and once it has exited and everything is read, tell
// the reactor (`RunExited`). One fiber per live run, in a `FiberMap` keyed by run id. Interrupting one never signals
// the agent: agents outlive the server, and stopping one is `Runs.stop`'s.

/** How long the follower waits when there is nothing new. */
export const FOLLOW_POLL = "200 millis"
/** Every this many idle passes, the follower checks that the run's shim is alive on this boot. */
export const SHIM_CHECK_EVERY = 10

export const FOLDER_REMOVED = "the run's folder was removed"
export const SHIM_VANISHED = "the run's supervisor (ia-shim) disappeared"

export interface RunFollowerShape {
  /** Follow a run from its saved offset until it exits, in the background. Following it again replaces the first. */
  readonly follow: (run: Run) => Effect.Effect<void>
  /** Stop following a run (its fiber only; the agent is not signalled). */
  readonly stop: (run: RunId) => Effect.Effect<void>
  readonly isFollowing: (run: RunId) => Effect.Effect<boolean>
}

export class RunFollower extends Context.Service<RunFollower, RunFollowerShape>()("huntaway-server/runs/RunFollower") {
  static readonly layer = Layer.effect(
    RunFollower,
    Effect.gen(function* () {
      const dir = yield* RunDir
      const repo = yield* RunRepo
      const shim = yield* Shim
      const changes = yield* Changes
      const output = yield* RunOutput
      const fibers = yield* FiberMap.make<RunId>()
      // Agents whose shim vanished, being stopped.
      const orphans = yield* FiberSet.make()

      const exited = (run: Run, exit: RunExitStatus, errorTail: string) => changes.offer({ _tag: "RunExited", run: run.id, task: run.task_id, exit, errorTail })

      const apply = (run: Run, line: string) =>
        output.handle(run, line).pipe(Effect.catchCause((cause) => Effect.logError(`run=${run.id} handling a line of output failed`, cause)))

      const loop = (run: Run) =>
        Effect.gen(function* () {
          let offset = run.out_offset
          let idle = 0
          while (true) {
            const chunk = yield* dir.readOutput(run.id, offset)
            for (const line of chunk.lines) yield* apply(run, line)
            if (chunk.end > offset) offset = yield* repo.saveOffset(run.id, chunk.end)
            if (chunk.exit !== null && chunk.drained) return yield* exited(run, chunk.exit, yield* dir.errorTail(run.id))
            if (chunk.lines.length > 0) continue
            // Its folder was removed with its task, maybe before its exit was seen here, so nothing will write one now.
            if (!(yield* dir.exists(run.id))) return yield* exited(run, { code: null, signal: null, error: FOLDER_REMOVED }, "")
            idle += 1
            // A shim that vanished without recording an exit (killed, or the machine rebooted). Its agent may have
            // outlived it, and would go on working for a run the board is about to end.
            if (idle % SHIM_CHECK_EVERY === 0 && (yield* shim.vanished(run.id))) {
              yield* FiberSet.run(orphans, shim.stopOrphan(run.id))
              const written = yield* dir.writeExit(run.id, { code: null, signal: null, error: SHIM_VANISHED }).pipe(
                Effect.as(true),
                Effect.catch((e) => Effect.logError(`run=${run.id} recording its vanished shim: ${e.reason}`).pipe(Effect.as(false))),
              )
              if (written) continue
            }
            yield* Effect.sleep(FOLLOW_POLL)
          }
        }).pipe(
          Effect.onError((cause) => (Cause.hasInterruptsOnly(cause) ? Effect.void : Effect.logError(`run=${run.id} following its output failed`, cause))),
          Effect.annotateLogs({ module: "runs" }),
        )

      return RunFollower.of({
        follow: (run) => FiberMap.run(fibers, run.id, loop(run)).pipe(Effect.asVoid),
        stop: (run) => FiberMap.remove(fibers, run),
        isFollowing: (run) => FiberMap.has(fibers, run),
      })
    }),
  )
}
