import { Effect, Layer } from "effect"
import { Tokens } from "../agents/Tokens.ts"
import { ToolCalls } from "../mcp/ToolCalls.ts"
import { Dependencies } from "../tasks/Dependencies.ts"

/**
 * Startup step 5 (docs/plan/06-server.md, Startup): call every reconciler once, which is how the server recovers from
 * stopping between a commit and what should have followed it. M1 has the dependencies; runs, prompts, merges,
 * reviews, workflows, restacks and releases join with their areas, in the order the plan lists. The board calls that
 * came on runs' output and were cut short are taken up again (`ToolCalls.resume`): run again if safe, else answered
 * that they were interrupted. The runs that ended
 * while the server was down have their tokens counted, as the old startup did (`tokens::count_pending`).
 */
export const RecoveryLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const dependencies = yield* Dependencies
    const toolCalls = yield* ToolCalls
    const tokens = yield* Tokens
    yield* dependencies.reconcile(null)
    yield* toolCalls.resume
    yield* tokens.countPending(null)
  }).pipe(Effect.withSpan("Recovery"), Effect.annotateLogs({ module: "recovery" })),
)
