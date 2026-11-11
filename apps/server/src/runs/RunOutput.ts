import { Context, Effect, Layer } from "effect"
import type { Run } from "./Run.ts"

export interface RunOutputShape {
  /**
   * One line of a run's output (stream-json for Claude, JSON-RPC for Codex), in order. Safe to repeat: after a crash
   * the lines after the saved offset are read again. A line that cannot be handled is logged and skipped by the
   * handler; a defect is logged by the follower, which carries on with the next line. `run` is the run as it was when
   * following began: its progress columns are the row's.
   */
  readonly handle: (run: Run, line: string) => Effect.Effect<void>
}

/**
 * What the follower does with each line of a run's output (docs/plan/07-agents.md, Following). The Claude and Codex
 * pieces supply the real handler (a driver's translator, the thread, the run's progress columns), here in `runs/`
 * because it writes the `runs` table, which `agents/` cannot reach.
 */
export class RunOutput extends Context.Service<RunOutput, RunOutputShape>()("huntaway-server/runs/RunOutput") {
  /** Until the drivers come: each line is logged at debug level and dropped. */
  static readonly layerLog = Layer.succeed(
    RunOutput,
    RunOutput.of({
      handle: Effect.fnUntraced(function* (run: Run, line: string) {
        yield* Effect.logDebug(`run=${run.id} output not handled yet: ${line.slice(0, 200)}`)
      }),
    }),
  )
}
