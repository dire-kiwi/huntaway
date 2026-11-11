import { Context, Effect, Layer } from "effect"
import type { TaskId } from "@huntaway/contracts"

// The merge gate (docs/plan/06-server.md, Merge; inventory 04, section 2.15; huntaway's review/merge_gate.ts): why
// the board won't let a task's agent merge now (its merge waits for the user's approval), which the gh tools ask
// before anything that may merge a pull request (`pr_merge`, `gh pr merge`, an API call that mentions merging). Plan
// task 4.7 fills it; until then nothing is blocked.

export interface MergeGateShape {
  /** Why task `task`'s agent may not merge now, or null when it may. */
  readonly blocked: (task: TaskId) => Effect.Effect<string | null>
}

export class MergeGate extends Context.Service<MergeGate, MergeGateShape>()("huntaway-server/merge/MergeGate") {
  /** Nothing is blocked (until 4.7's approvals). */
  static readonly layer = Layer.succeed(MergeGate, MergeGate.of({ blocked: () => Effect.succeed(null) }))
}
