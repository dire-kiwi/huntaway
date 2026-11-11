import { Effect, Option, Schema } from "effect"
import { McpSchema } from "effect/ai"
import { toJson } from "../platform/columns.ts"
import type { ServerName, ToolResult } from "./tool.ts"

// The JSON-RPC the board's MCP servers speak (docs/plan/inventory/03-mcp.md 2.1, 2.2 and 7), shared by the transports:
// how a message is read (leniently, as the old server read it), and the shapes of the answers.

/** The MCP version an `initialize` without one is answered with. */
export const DEFAULT_PROTOCOL = "2025-06-18"

/** A JSON-RPC id. */
export type RpcId = string | number

const isRpcId = (u: unknown): u is RpcId => typeof u === "string" || typeof u === "number"

/** A message as it arrives, read leniently: what is not a string method, or not an id, is not there. */
const Message = Schema.Struct({
  id: Schema.optional(Schema.Unknown),
  method: Schema.optional(Schema.Unknown),
  params: Schema.optional(Schema.Unknown),
})

/** What a message is: a request (it has an id), a notification (it has none), or not a message at all. */
export type Incoming =
  | { readonly _tag: "Request"; readonly id: RpcId; readonly method: string; readonly params: unknown }
  | { readonly _tag: "Notification"; readonly method: string; readonly params: unknown }
  | { readonly _tag: "Invalid" }

export const readMessage = (u: unknown): Incoming => {
  const found = Schema.decodeUnknownOption(Message)(u)
  if (Option.isNone(found)) return { _tag: "Invalid" }
  const { id, method, params } = found.value
  const name = typeof method === "string" ? method : ""
  return isRpcId(id) ? { _tag: "Request", id, method: name, params } : { _tag: "Notification", method: name, params }
}

const CallParams = Schema.Struct({
  name: Schema.optional(Schema.Unknown),
  arguments: Schema.optional(Schema.Unknown),
  _meta: Schema.optional(Schema.Struct({ progressToken: Schema.optional(Schema.Unknown) })),
})

/** A `tools/call`'s tool, its arguments (null if none) and its progress token, if it has one. */
export interface CallParams {
  readonly name: string
  readonly args: unknown
  readonly progressToken: RpcId | undefined
}

export const callParams = (params: unknown): CallParams => {
  const found = Option.getOrUndefined(Schema.decodeUnknownOption(CallParams)(params))
  const token = found?._meta?.progressToken
  return {
    name: typeof found?.name === "string" ? found.name : "",
    args: found?.arguments ?? null,
    progressToken: isRpcId(token) ? token : undefined,
  }
}

const CancelledParams = Schema.Struct({ requestId: Schema.optional(Schema.Unknown) })

/** The JSON-RPC id a `notifications/cancelled` names, if it names one. */
export const cancelledId = (params: unknown): RpcId | undefined => {
  const id = Option.getOrUndefined(Schema.decodeUnknownOption(CancelledParams)(params))?.requestId
  return isRpcId(id) ? id : undefined
}

/** The `protocolVersion` an `initialize` asks for. */
export const askedProtocol = (params: unknown): string => {
  const found = Option.getOrUndefined(Schema.decodeUnknownOption(Schema.Struct({ protocolVersion: Schema.optional(Schema.Unknown) }))(params))
  return typeof found?.protocolVersion === "string" ? found.protocolVersion : DEFAULT_PROTOCOL
}

/** A JSON-RPC answer. */
export type RpcResponse =
  | { readonly jsonrpc: "2.0"; readonly id: RpcId | null; readonly result: unknown }
  | { readonly jsonrpc: "2.0"; readonly id: RpcId | null; readonly error: { readonly code: number; readonly message: string } }

export const rpcResult = (id: RpcId | null, result: unknown): RpcResponse => ({ jsonrpc: "2.0", id, result })

export const rpcError = (id: RpcId | null, code: number, message: string): RpcResponse => ({ jsonrpc: "2.0", id, error: { code, message } })

export const METHOD_NOT_FOUND = McpSchema.METHOD_NOT_FOUND_ERROR_CODE
export const PARSE_ERROR = McpSchema.PARSE_ERROR_CODE
export const INVALID_REQUEST = McpSchema.INVALID_REQUEST_ERROR_CODE
export const INTERNAL_ERROR = McpSchema.INTERNAL_ERROR_CODE

/** A `tools/call` result that is an error the board gives itself (the call was lost to a restart, say): its text as it is. */
export const toolError = (text: string) => ({ content: [{ type: "text", text }], isError: true })

const PrettyJson = Schema.fromJsonString(Schema.Unknown, { space: 2 })

/** A tool's result that is MCP content already (the gh tools' output, `isError` when gh failed). */
const Content = Schema.Struct({ content: Schema.Array(Schema.Unknown), isError: Schema.optional(Schema.Boolean) })
const isContent = Schema.is(Content)

/**
 * A `tools/call`'s result: what the tool gave, as pretty JSON text, or its error. The board's other servers' tools
 * (gh's) give their content as it is.
 */
export const callResult = (result: ToolResult, server: ServerName = "huntaway"): Effect.Effect<unknown> =>
  result._tag === "Err"
    ? Effect.succeed(toolError(`Error: ${result.message}`))
    : server !== "huntaway" && isContent(result.value)
      ? Effect.succeed(result.value)
      : Schema.encodeEffect(PrettyJson)(result.value).pipe(
          Effect.orDie,
          Effect.map((text) => ({ content: [{ type: "text", text }] })),
        )

/**
 * What a board call that came on a run's output (`mcp_message`) is recorded with (`mcp_calls.args`): the request and
 * the JSON-RPC id its answer goes back with, and the tool's arguments. What answering it again after a restart takes.
 * `codex` marks a Codex run's (M5).
 */
export const SavedControlCall = Schema.Struct({
  request_id: Schema.String,
  rpc_id: Schema.Union([Schema.String, Schema.Finite]),
  arguments: Schema.optional(Schema.Unknown),
  codex: Schema.optional(Schema.Unknown),
})
export type SavedControlCall = typeof SavedControlCall.Type

/** A Claude `control_response` line answering control request `request_id` with an in-process server's message. */
export const mcpResponseLine = (requestId: string, response: RpcResponse) =>
  toJson({ type: "control_response", response: { subtype: "success", request_id: requestId, response: { mcp_response: response } } })

/** A Claude `control_response` line refusing control request `request_id`. */
export const controlErrorLine = (requestId: string, error: string) =>
  toJson({ type: "control_response", response: { subtype: "error", request_id: requestId, error } })
