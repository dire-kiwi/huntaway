import { Effect, FiberSet, Layer, Option, Schema } from "effect"
import type { RunId } from "@huntaway/contracts"
import { toJson } from "../../platform/columns.ts"
import { McpControl } from "../../runs/McpControl.ts"
import type { McpMessage } from "../../runs/McpControl.ts"
import type { Run } from "../../runs/Run.ts"
import { RunDir } from "../../runs/RunDir.ts"
import { TaskRepo } from "../../tasks/TaskRepo.ts"
import { callParams, cancelledId, METHOD_NOT_FOUND, mcpResponseLine, readMessage, rpcError, rpcResult, SavedControlCall } from "../jsonrpc.ts"
import type { RpcId, RpcResponse } from "../jsonrpc.ts"
import { McpCallRepo } from "../McpCallRepo.ts"
import { McpServers } from "../McpServers.ts"
import { BOARD_SERVER } from "../tool.ts"
import { controlCallId, ToolCalls } from "../ToolCalls.ts"

// The board's MCP server in process for Claude runs (docs/plan/inventory/03-mcp.md 2.1; inventory 01, section 5): the
// `initialize` control request that starts a run's input registers it with its handshake's results, and Claude Code
// then sends each MCP message as an `mcp_message` control request on the run's output, answered on its input with a
// `control_response` whose `mcp_response` is the JSON-RPC answer. A `tools/call` is a board call like any other
// (`ToolCalls`), recorded as `stdio:<run id>:<request id>` with what answering it again takes, so a line read again finds
// the same call and a restart takes it up again (`ToolCalls.resume`). Claude Code gives up on a call with a
// `notifications/cancelled` naming its JSON-RPC id, and on a prompt with a `control_cancel_request`.

/** The MCP version whose handshake the `initialize` request gives Claude Code up front. */
export const MANIFEST_PROTOCOL = "2025-11-25"

/** The request id prefix of a run's `initialize`. */
export const INIT_PREFIX = "huntaway-init-"

/**
 * Claude Code's per-server time limit for the board's calls (ms), in the `initialize` request and the HTTP server's
 * `mcp.json` entry: without one it gives up on a call after 5 minutes without news, and a call may wait on the user.
 * gh's entry has 900 000, desktop's 300 000, docs' none.
 */
export const BOARD_TIMEOUT_MS = 86_400_000

const SavedJson = Schema.fromJsonString(SavedControlCall)

export const McpControlLive = Layer.effect(
  McpControl,
  Effect.gen(function* () {
    const toolCalls = yield* ToolCalls
    const servers = yield* McpServers
    const calls = yield* McpCallRepo
    const dirs = yield* RunDir
    const tasks = yield* TaskRepo
    const fibers = yield* FiberSet.make()

    const answer = (run: Run, requestId: string, response: RpcResponse) =>
      Effect.gen(function* () {
        const sent = yield* dirs.appendInput(run.id, yield* mcpResponseLine(requestId, response))
        if (!sent) yield* Effect.logWarning(`run=${run.id} the agent no longer takes input, so its ${requestId} wasn't answered`)
      }).pipe(Effect.catch((e) => Effect.logWarning(`run=${run.id} answering its ${requestId}: ${e.reason}`)))

    /** Whether the run is a review thread's, which gets the reviewers' tools (as its launch recorded it, else by its task). */
    const reviews = Effect.fnUntraced(function* (run: Run) {
      const settings = yield* dirs.mcpRun(run.id)
      if (settings !== null) return settings.review
      const task = yield* tasks.get(run.task_id)
      return task?.kind === "review"
    })

    /** Claude Code gave up on the board call it sent with JSON-RPC id `id`: found by the id its answer would go back with. */
    const cancelled = Effect.fnUntraced(function* (run: Run, id: RpcId) {
      for (const open of yield* calls.openOnOutput(run.id)) {
        const saved = Option.getOrUndefined(Schema.decodeOption(SavedJson)(open.args))
        if (saved !== undefined && saved.rpc_id === id && saved.codex === undefined) yield* toolCalls.cancel(run.id, open.id)
      }
    })

    const handle = Effect.fn("McpControl.handle")(function* (run: Run, request: McpMessage) {
      const message = readMessage(request.message)
      if (request.server_name !== BOARD_SERVER) {
        const name = yield* toJson(request.server_name ?? null)
        const id = message._tag === "Request" ? message.id : 0
        return yield* answer(run, request.request_id, rpcError(id, METHOD_NOT_FOUND, `there's no MCP server ${name} in process`))
      }
      // A notification (`notifications/initialized`, `notifications/cancelled`): Claude Code still waits for its
      // control response.
      if (message._tag !== "Request") {
        const id = message._tag === "Notification" && message.method === "notifications/cancelled" ? cancelledId(message.params) : undefined
        if (id !== undefined) yield* cancelled(run, id)
        return yield* answer(run, request.request_id, rpcResult(0, {}))
      }
      if (message.method === "tools/call") {
        const { name, args } = callParams(message.params)
        const call = toolCalls.call({
          call_id: controlCallId(run.id, request.request_id),
          run: run.id,
          server: BOARD_SERVER,
          tool: name,
          args,
          answer: { request_id: request.request_id, rpc_id: message.id },
        })
        return yield* FiberSet.run(fibers, call).pipe(Effect.asVoid)
      }
      // The handshake, and pings: they call nothing.
      return yield* answer(run, request.request_id, yield* servers.answer(BOARD_SERVER, yield* reviews(run), message))
    })

    return McpControl.of({
      handle: (run, request) =>
        handle(run, request).pipe(
          Effect.catchCause((cause) => Effect.logError(`run=${run.id} handling MCP request ${request.request_id}`, cause)),
          Effect.annotateLogs({ module: "mcp" }),
        ),
      cancel: (run, requestId) => toolCalls.cancel(run.id, controlCallId(run.id, requestId)),
      initializeLine: Effect.fn("McpControl.initializeLine")(function* (run: RunId, review: boolean) {
        const tools = yield* servers.tools(BOARD_SERVER, review)
        return yield* toJson({
          type: "control_request",
          request_id: `${INIT_PREFIX}${run}`,
          request: {
            subtype: "initialize",
            sdkMcpServers: [BOARD_SERVER],
            sdkMcpServerConfigs: { [BOARD_SERVER]: { timeout: BOARD_TIMEOUT_MS, disableAutoBackground: true } },
            sdkMcpServerManifests: {
              [BOARD_SERVER]: { initializeResult: servers.initializeResult(BOARD_SERVER, MANIFEST_PROTOCOL), toolsListResult: { tools } },
            },
          },
        })
      }),
      isInitializeResponse: (requestId) => requestId.startsWith(INIT_PREFIX),
    })
  }),
)
