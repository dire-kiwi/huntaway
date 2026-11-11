import { Effect, Layer } from "effect"
import { Dependencies } from "../tasks/Dependencies.ts"

/**
 * Startup step 5 (docs/plan/06-server.md, Startup): call every reconciler once, which is how the server recovers from
 * stopping between a commit and what should have followed it. M1 has the dependencies; runs, prompts, merges,
 * reviews, workflows, restacks and releases join with their areas, in the order the plan lists.
 */
export const RecoveryLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const dependencies = yield* Dependencies
    yield* dependencies.reconcile(null)
  }).pipe(Effect.withSpan("Recovery"), Effect.annotateLogs({ module: "recovery" })),
)
