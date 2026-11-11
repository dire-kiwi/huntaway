import { Effect, FiberSet, Layer, Option, Schema } from "effect"
import type { RunId } from "@huntaway/contracts"
import { INIT_PREFIX as INIT_PREFIX_, initializeLine, MCP_PROTOCOL } from "../../agents/claude/launch.ts"
import type { BoardManifest } from "../../agents/claude/launch.ts"
import { toJson } from "../../platform/columns.ts"
import { AgentRequests } from "../../runs/AgentRequests.ts"
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

// The `initialize` line, its protocol version, request id and the board's time limit are the launch's
// (`agents/claude/launch.ts`).
export { BOARD_TIMEOUT_MS, INIT_PREFIX, MCP_PROTOCOL as MANIFEST_PROTOCOL } from "../../agents/claude/launch.ts"

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

    const manifest = Effect.fnUntraced(function* (review: boolean) {
      const tools = yield* servers.tools(BOARD_SERVER, review)
      const made: BoardManifest = { initializeResult: servers.initializeResult(BOARD_SERVER, MCP_PROTOCOL), toolsListResult: { tools } }
      return made
    })

    return McpControl.of({
      handle: (run, request) =>
        handle(run, request).pipe(
          Effect.catchCause((cause) => Effect.logError(`run=${run.id} handling MCP request ${request.request_id}`, cause)),
          Effect.annotateLogs({ module: "mcp" }),
        ),
      cancel: (run, requestId) => toolCalls.cancel(run.id, controlCallId(run.id, requestId)),
      manifest,
      initializeLine: Effect.fn("McpControl.initializeLine")(function* (run: RunId, review: boolean) {
        return yield* initializeLine(run, yield* manifest(review))
      }),
      isInitializeResponse: (requestId) => requestId.startsWith(INIT_PREFIX_),
    })
  }),
)

/**
 * `McpControl` registered with the runs area (`AgentRequests`): `mcp_message` requests on a run's output and their
 * cancellations come to it, and the launch puts its manifest in the `initialize` line. Which of the board's HTTP servers
 * (gh, docs, desktop) this server serves is told here too, as their areas come.
 */
export const McpControlRegistered = Layer.effectDiscard(
  Effect.gen(function* () {
    const control = yield* McpControl
    const requests = yield* AgentRequests
    yield* requests.register("mcp_message", {
      handle: (run, line) =>
        line.request.subtype === "mcp_message" && "message" in line.request
          ? control.handle(run, { request_id: line.request_id, server_name: line.request.server_name, message: line.request.message })
          : Effect.void,
      cancel: (run, requestId) => control.cancel(run, requestId),
    })
    // gh's server is served (4.4); docs' (6.3) and the desktop's (6.10) come with their areas: the desktop's while its
    // gate says so (computer use on, a driver to run).
    const servers = yield* McpServers
    yield* requests.provideServers({
      manifest: control.manifest,
      served: Effect.map(servers.serves("desktop"), (desktop) => ({ gh: true, docs: false, desktop })),
    })
  }),
)
