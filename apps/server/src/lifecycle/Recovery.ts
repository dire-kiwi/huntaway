import { Effect, Layer } from "effect"
import { Tokens } from "../agents/Tokens.ts"
import { ToolCalls } from "../mcp/ToolCalls.ts"
import { Permissions } from "../permissions/Permissions.ts"
import { Runs } from "../runs/Runs.ts"

/**
 * Startup step 5 (docs/plan/06-server.md, Startup): call every reconciler once, which is how the server recovers from
 * stopping between a commit and what should have followed it. M1 has the dependencies; runs, prompts, merges,
 * reviews, workflows, restacks and releases join with their areas, in the order the plan lists. The board calls that
 * came on runs' output and were cut short are taken up again (`ToolCalls.resume`): run again if safe, else answered
 * that they were interrupted. Permission prompts whose run had ended expire (`Permissions.expireOrphans`); re-attaching a
 * run takes up its open `can_use_tool` prompts (`AgentRequests.resume`). The runs that ended
 * while the server was down have their tokens counted, as the old startup did (`tokens::count_pending`).
 */
export const RecoveryLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const runs = yield* Runs
    const toolCalls = yield* ToolCalls
    const permissions = yield* Permissions
    const tokens = yield* Tokens
    // Prompts whose run had already ended expire (re-attaching asks the open ones of the runs it adopts again, and
    // expires those of the runs it ends: `AgentRequests`' `resume` and `ended`).
    yield* permissions.expireOrphans
    // The runs that had not exited are adopted (or ended), then the waiting tasks whose dependencies merged start.
    yield* runs.reattach
    yield* runs.startUnblocked(null)
    yield* toolCalls.resume
    yield* tokens.countPending(null)
  }).pipe(Effect.withSpan("Recovery"), Effect.annotateLogs({ module: "recovery" })),
)
