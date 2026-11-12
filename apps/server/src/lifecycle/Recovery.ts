import { Effect, Layer } from "effect"
import { Tokens } from "../agents/Tokens.ts"
import { StackTitles } from "../agents/StackTitles.ts"
import { Worktrees } from "../git/Worktrees.ts"
import { ToolCalls } from "../mcp/ToolCalls.ts"
import { Permissions } from "../permissions/Permissions.ts"
import { Merges } from "../merge/Merges.ts"
import { Restack } from "../git/Restack.ts"
import { GhStacks } from "../github/GhStacks.ts"
import { Reviews } from "../review/Reviews.ts"
import { Runs } from "../runs/Runs.ts"
import { WorkflowEngine } from "../workflows/WorkflowEngine.ts"

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
    const worktrees = yield* Worktrees
    const reviews = yield* Reviews
    const merges = yield* Merges
    // Worktrees a stopped server left half set up or half removed (4.1): marked failed, or ready or gone by their folder,
    // before anything sets one up again.
    yield* worktrees.recover
    // Prompts whose run had already ended expire (re-attaching asks the open ones of the runs it adopts again, and
    // expires those of the runs it ends: `AgentRequests`' `resume` and `ended`).
    yield* permissions.expireOrphans
    // The runs that had not exited are adopted (or ended), then the waiting tasks whose dependencies merged start.
    yield* runs.reattach
    // 4.7: the merges queued when the server stopped start where their lanes are free.
    yield* merges.reconcileAll
    yield* runs.startUnblocked(null)
    // 4.6: reviews and summaries left running whose threads have no run going end as their runs did.
    yield* reviews.reconcileAll
    // 6.6: workflow runs a restart interrupted go on (their steps that were running on the board itself failed).
    yield* (yield* WorkflowEngine).resume
    // 4.8: the restacks that were due when the server stopped, and the stack levels to link on GitHub (both in the background).
    yield* (yield* Restack).resume
    yield* (yield* GhStacks).linkAll
    yield* toolCalls.resume
    yield* tokens.countPending(null)
    // A release is settled by `serve` once the server listens, not here (Releases.settle).
    // 4.8: a minute on, the open stacks whose titles weren't written from what their levels say now (in the background).
    yield* (yield* StackTitles).resume
  }).pipe(Effect.withSpan("Recovery"), Effect.annotateLogs({ module: "recovery" })),
)
