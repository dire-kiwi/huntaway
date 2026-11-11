import { Effect, Layer } from "effect"
import { requestId } from "../../agents/codex/requests.ts"
import { AgentRequests } from "../../runs/AgentRequests.ts"
import { BOARD_SERVER } from "../tool.ts"
import { controlCallId, ToolCalls } from "../ToolCalls.ts"

// The board's tools for Codex runs (docs/plan/07-agents.md, Board tools: Dispatch; inventory 03, 2.1): a new Codex
// thread is given them as dynamic tools (a namespace named for the board's server, `agents/codex/requests.ts`'
// `boardTools`), and Codex calls each with an `item/tool/call` request, which the adapter writes to the run's output.
// Each is a board call like any other (`ToolCalls`), recorded as `stdio:<run id>:codex:<id>` with what answering it
// again takes (the request's id, `codex: true`), so a line read again finds the same call and a restart takes it up
// again (`ToolCalls.resume`); it is answered on the run's input with a `codex_response` before it is recorded done.
// Codex gives up on a call with `serverRequest/resolved`, which the line handler hands to `AgentRequests.cancel` as
// request `codex:<id>`: `McpControl`'s cancel finds the same call id.

/** The dynamic-tools transport registered with the runs area (`AgentRequests`), for Codex's `item/tool/call` requests. */
export const McpCodexRegistered = Layer.effectDiscard(
  Effect.gen(function* () {
    const toolCalls = yield* ToolCalls
    const requests = yield* AgentRequests
    yield* requests.registerCodex("tool", {
      handle: (run, request, call) =>
        Effect.gen(function* () {
          const id = yield* requestId(request.id)
          yield* toolCalls.call({
            call_id: controlCallId(run.id, id),
            run: run.id,
            server: BOARD_SERVER,
            tool: call.tool,
            args: call.args,
            answer: { request_id: id, rpc_id: request.id, codex: true },
          })
        }).pipe(Effect.annotateLogs({ module: "mcp" })),
    })
  }),
)
