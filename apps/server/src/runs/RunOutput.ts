import { Context, Effect, Layer } from "effect"
import type { Run } from "./Run.ts"
import { RunRepo } from "./RunRepo.ts"

export interface RunOutputShape {
  /**
   * One line of a run's output (stream-json for Claude, JSON-RPC for Codex), in order; `end` is the byte offset after
   * it. The handler saves `end` as the run's offset (`RunRepo.saveOffset`) in the transaction that records what the
   * line says, so that a line read again after a crash is not applied twice. Safe to repeat all the same: a line's
   * effects outside the database (a process, the run's input) may happen again. A line that cannot be handled is
   * logged and skipped by the handler; a defect is logged by the follower, which saves the offset and carries on with
   * the next line. `run` is the run as it was when following began: its progress columns are the row's.
   */
  readonly handle: (run: Run, line: string, end: number) => Effect.Effect<void>
  /**
   * The lines of a chunk read at once, in order, each with the offset after it: as `handle` would one by one, but
   * several to a transaction (a handler that has it says how). The follower uses it when there is one.
   */
  readonly handleChunk?: (run: Run, lines: ReadonlyArray<readonly [line: string, end: number]>) => Effect.Effect<void>
  /**
   * The follower stopped following `run` (it exited, was stopped, its task deleted, or the server is stopping): what the
   * handler kept for it goes. A handler that keeps nothing has none.
   */
  readonly released?: (run: Run) => Effect.Effect<void>
}

/**
 * What the follower does with each line of a run's output (docs/plan/07-agents.md, Following). The Claude and Codex
 * pieces supply the real handler (a driver's translator, the thread, the run's progress columns), here in `runs/`
 * because it writes the `runs` table, which `agents/` cannot reach.
 */
export class RunOutput extends Context.Service<RunOutput, RunOutputShape>()("huntaway-server/runs/RunOutput") {
  /** Each line is logged at debug level and dropped (tests of the follower, a server without a driver). */
  static readonly layerLog = Layer.effect(
    RunOutput,
    Effect.gen(function* () {
      const repo = yield* RunRepo
      return RunOutput.of({
        handle: Effect.fnUntraced(function* (run: Run, line: string, end: number) {
          yield* Effect.logDebug(`run=${run.id} output not handled: ${line.slice(0, 200)}`)
          yield* repo.saveOffset(run.id, end)
        }),
      })
    }),
  )
}
