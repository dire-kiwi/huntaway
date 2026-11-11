import { Predicate, Result, Schema } from "effect"

// The lines Claude Code writes to a run's `out.jsonl` that the server reads (docs/plan/inventory/01-run-lifecycle.md,
// section 5, "Claude lines the server reads"), a schema each. Each declares the fields the server reads and no more:
// decoding drops the rest (a message's usage, a block's signature), which is what the old `slim` step did by hand. What
// Claude Code passes through from a tool or a model (a tool's input, a result's content, a rate limit's details) stays
// `Schema.Unknown`, kept as given. `decodeLine` never throws: a line that is not JSON, not one of these, or one of these
// with a field of the wrong type comes back as a `LineProblem`, which the caller logs and skips.

/** The subagent call a line belongs to; null or absent for the main conversation. */
const parent = { parent_tool_use_id: Schema.optionalKey(Schema.NullOr(Schema.String)) }
const session = { session_id: Schema.optionalKey(Schema.String) }
const uuid = { uuid: Schema.optionalKey(Schema.String) }
const count = Schema.optionalKey(Schema.NullOr(Schema.Finite))
const text = Schema.optionalKey(Schema.NullOr(Schema.String))

/** `system`/`init`: a session started or resumed, and a turn starts. What it lists is for the board's tool lists. */
export const InitLine = Schema.Struct({
  type: Schema.Literal("system"),
  subtype: Schema.Literal("init"),
  ...session,
  model: Schema.optionalKey(Schema.Unknown),
  tools: Schema.optionalKey(Schema.Unknown),
  mcp_servers: Schema.optionalKey(Schema.Unknown),
  skills: Schema.optionalKey(Schema.Unknown),
  slash_commands: Schema.optionalKey(Schema.Unknown),
  agents: Schema.optionalKey(Schema.Unknown),
  plugins: Schema.optionalKey(Schema.Unknown),
})
export type InitLine = typeof InitLine.Type

export const CompactMetadata = Schema.Struct({ trigger: text, pre_tokens: count, post_tokens: count, duration_ms: count })
export type CompactMetadata = typeof CompactMetadata.Type

/** `system`/`compact_boundary`: the conversation (a subagent's, with its parent) was compacted. */
export const CompactBoundaryLine = Schema.Struct({
  type: Schema.Literal("system"),
  subtype: Schema.Literal("compact_boundary"),
  ...parent,
  ...session,
  compact_metadata: Schema.optionalKey(Schema.NullOr(CompactMetadata)),
})
export type CompactBoundaryLine = typeof CompactBoundaryLine.Type

/** `system`/`background_tasks_changed`: every background task Claude Code has going. */
export const BackgroundTasksLine = Schema.Struct({
  type: Schema.Literal("system"),
  subtype: Schema.Literal("background_tasks_changed"),
  ...session,
  tasks: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.Unknown))),
})
export type BackgroundTasksLine = typeof BackgroundTasksLine.Type

/** `system`/`task_*`: a subagent (`local_agent`) or a background command (`local_bash`) started, got on, changed or ended. */
export const TaskLine = Schema.Struct({
  type: Schema.Literal("system"),
  subtype: Schema.Literals(["task_started", "task_progress", "task_updated", "task_notification"]),
  ...session,
  task_id: text,
  tool_use_id: text,
  task_type: text,
  description: text,
  prompt: text,
  subagent_type: text,
  model: text,
  is_backgrounded: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
  status: text,
  summary: text,
  usage: Schema.optionalKey(Schema.NullOr(Schema.Struct({ total_tokens: count, tool_uses: count, duration_ms: count }))),
  patch: Schema.optionalKey(Schema.NullOr(Schema.Struct({ status: text }))),
})
export type TaskLine = typeof TaskLine.Type

/** `stream_event`: the API's own stream, of which the server reads where messages and blocks start and text deltas. */
export const StreamEventLine = Schema.Struct({
  type: Schema.Literal("stream_event"),
  ...parent,
  ...session,
  event: Schema.Struct({
    type: Schema.String,
    delta: Schema.optionalKey(Schema.Struct({ type: Schema.optionalKey(Schema.String), text: Schema.optionalKey(Schema.String) })),
  }),
})
export type StreamEventLine = typeof StreamEventLine.Type

export const TextBlock = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String })
export const ThinkingBlock = Schema.Struct({ type: Schema.Literal("thinking"), thinking: Schema.String })
export const ToolUseBlock = Schema.Struct({ type: Schema.Literal("tool_use"), id: Schema.String, name: Schema.String, input: Schema.Unknown })
export type ToolUseBlock = typeof ToolUseBlock.Type
/** A block of a type the server does not read (`redacted_thinking`, a newer one). */
export const OtherBlock = Schema.Struct({ type: Schema.String })

export const AssistantBlock = Schema.Union([TextBlock, ThinkingBlock, ToolUseBlock, OtherBlock])
export type AssistantBlock = typeof AssistantBlock.Type

/** `assistant`: one message of the model's (or Claude Code's own, for an API error), each block an item. */
export const AssistantLine = Schema.Struct({
  type: Schema.Literal("assistant"),
  ...parent,
  ...session,
  ...uuid,
  message: Schema.Struct({
    id: Schema.optionalKey(Schema.String),
    model: Schema.optionalKey(Schema.String),
    content: Schema.Array(AssistantBlock),
    /** For the context meter. */
    usage: Schema.optionalKey(Schema.Unknown),
  }),
  /** An API error (a usage limit, say) that Claude Code shows as the assistant's text. */
  is_api_error_message: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
  api_error: Schema.optionalKey(Schema.Unknown),
  api_error_params: Schema.optionalKey(Schema.Unknown),
  error: Schema.optionalKey(Schema.Unknown),
})
export type AssistantLine = typeof AssistantLine.Type

export const ToolResultBlock = Schema.Struct({
  type: Schema.Literal("tool_result"),
  tool_use_id: Schema.optionalKey(Schema.String),
  /** A string, or a list of text and image parts. */
  content: Schema.optionalKey(Schema.Unknown),
  is_error: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
})
export type ToolResultBlock = typeof ToolResultBlock.Type

export const UserBlock = Schema.Union([ToolResultBlock, TextBlock, OtherBlock])
export type UserBlock = typeof UserBlock.Type

/**
 * `user`: tool results, a compaction's summary (`isSynthetic`), "[Request interrupted…]", and the echo of a message the
 * run sent (`isReplay`, with its `uuid`).
 */
export const UserLine = Schema.Struct({
  type: Schema.Literal("user"),
  ...parent,
  ...session,
  ...uuid,
  message: Schema.Struct({ content: Schema.Union([Schema.String, Schema.Array(UserBlock)]) }),
  isSynthetic: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
  isReplay: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
  /** What the tool returned besides its text: for an Agent call, whether it went to the background, its model… */
  tool_use_result: Schema.optionalKey(Schema.Unknown),
  /** What started the turn, for a message Claude Code took on its own (`{kind: "task-notification"}`). */
  origin: Schema.optionalKey(Schema.Unknown),
  api_error: Schema.optionalKey(Schema.Unknown),
  api_error_params: Schema.optionalKey(Schema.Unknown),
})
export type UserLine = typeof UserLine.Type

/** `result`: a turn ended. */
export const ResultLine = Schema.Struct({
  type: Schema.Literal("result"),
  ...session,
  ...uuid,
  subtype: text,
  is_error: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
  result: text,
  errors: Schema.optionalKey(Schema.Unknown),
  duration_ms: count,
  duration_api_ms: count,
  num_turns: count,
  /** The session's running total, which a resumed session goes on from. */
  total_cost_usd: count,
  modelUsage: Schema.optionalKey(Schema.Unknown),
  usage: Schema.optionalKey(Schema.Unknown),
  origin: Schema.optionalKey(Schema.Unknown),
  user_message_uuids: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.Unknown))),
  api_error: Schema.optionalKey(Schema.Unknown),
  api_error_params: Schema.optionalKey(Schema.Unknown),
})
export type ResultLine = typeof ResultLine.Type

/** A permission prompt: the agent wants to call a tool. */
export const CanUseTool = Schema.Struct({
  subtype: Schema.Literal("can_use_tool"),
  tool_name: Schema.String,
  input: Schema.optionalKey(Schema.Unknown),
  tool_use_id: text,
  permission_suggestions: Schema.optionalKey(Schema.Unknown),
  blocked_path: Schema.optionalKey(Schema.Unknown),
  decision_reason: Schema.optionalKey(Schema.Unknown),
  agent_id: Schema.optionalKey(Schema.Unknown),
})
export type CanUseTool = typeof CanUseTool.Type

/** A call to one of the board's MCP servers, over the run's files. */
export const McpMessage = Schema.Struct({ subtype: Schema.Literal("mcp_message"), server_name: Schema.String, message: Schema.Unknown })
export type McpMessage = typeof McpMessage.Type

/** Any other request, which the server answers with an error. */
export const OtherRequest = Schema.Struct({ subtype: Schema.String })

export const ControlRequestLine = Schema.Struct({
  type: Schema.Literal("control_request"),
  request_id: Schema.String,
  request: Schema.Union([CanUseTool, McpMessage, OtherRequest]),
})
export type ControlRequestLine = typeof ControlRequestLine.Type

/** Claude Code no longer wants the answer to a request (its turn was interrupted). */
export const ControlCancelLine = Schema.Struct({ type: Schema.Literal("control_cancel_request"), request_id: Schema.String })
export type ControlCancelLine = typeof ControlCancelLine.Type

/** Claude Code's answer to a request of the server's (`huntaway-init-…`, `bgstop-…`, `context-…`). */
export const ControlResponseLine = Schema.Struct({
  type: Schema.Literal("control_response"),
  response: Schema.Struct({
    subtype: Schema.String,
    request_id: Schema.optionalKey(Schema.String),
    response: Schema.optionalKey(Schema.Unknown),
    error: Schema.optionalKey(Schema.Unknown),
  }),
})
export type ControlResponseLine = typeof ControlResponseLine.Type

/** How much of a usage window is left, for the config's usage. */
export const RateLimitLine = Schema.Struct({ type: Schema.Literal("rate_limit_event"), ...session, rate_limit_info: Schema.optionalKey(Schema.Unknown) })
export type RateLimitLine = typeof RateLimitLine.Type

/** A line the server reads. */
export const ClaudeLine = Schema.Union([
  InitLine,
  CompactBoundaryLine,
  BackgroundTasksLine,
  TaskLine,
  StreamEventLine,
  AssistantLine,
  UserLine,
  ResultLine,
  ControlRequestLine,
  ControlCancelLine,
  ControlResponseLine,
  RateLimitLine,
])
export type ClaudeLine = typeof ClaudeLine.Type

/** Why a line is skipped. */
export type LineProblem =
  /** Not a JSON object. */
  | { readonly _tag: "NotJson" }
  /** A Codex app-server notification (it has a `method`): the Codex driver's. */
  | { readonly _tag: "Codex" }
  /** A line the server has no use for: Claude Code's status, hook, retry and thinking lines. */
  | { readonly _tag: "Ignored"; readonly type: string; readonly subtype: string | null }
  /** A type (or system subtype) the server does not know: a newer Claude Code's. */
  | { readonly _tag: "Unknown"; readonly type: string; readonly subtype: string | null }
  /** One of the lines above with a field the server reads of the wrong type. */
  | { readonly _tag: "Malformed"; readonly type: string; readonly subtype: string | null; readonly issue: string }

/** System lines the old server read nothing from. */
const ignoredSystem = new Set(["status", "hook_started", "hook_response", "api_retry", "thinking_tokens"])

/** The decoder for each type, made once: `system/<subtype>` for system lines. */
type Decoder = (input: unknown) => Result.Result<ClaudeLine, Schema.SchemaError>
const decoders: ReadonlyMap<string, Decoder> = new Map<string, Decoder>([
  ["system/init", Schema.decodeUnknownResult(InitLine)],
  ["system/compact_boundary", Schema.decodeUnknownResult(CompactBoundaryLine)],
  ["system/background_tasks_changed", Schema.decodeUnknownResult(BackgroundTasksLine)],
  ["system/task_started", Schema.decodeUnknownResult(TaskLine)],
  ["system/task_progress", Schema.decodeUnknownResult(TaskLine)],
  ["system/task_updated", Schema.decodeUnknownResult(TaskLine)],
  ["system/task_notification", Schema.decodeUnknownResult(TaskLine)],
  ["stream_event", Schema.decodeUnknownResult(StreamEventLine)],
  ["assistant", Schema.decodeUnknownResult(AssistantLine)],
  ["user", Schema.decodeUnknownResult(UserLine)],
  ["result", Schema.decodeUnknownResult(ResultLine)],
  ["control_request", Schema.decodeUnknownResult(ControlRequestLine)],
  ["control_cancel_request", Schema.decodeUnknownResult(ControlCancelLine)],
  ["control_response", Schema.decodeUnknownResult(ControlResponseLine)],
  ["rate_limit_event", Schema.decodeUnknownResult(RateLimitLine)],
])

const parseJson = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Unknown))

/** One line of `out.jsonl` (without its newline), decoded; a problem for one to log and skip. */
export const decodeLine = (line: string): Result.Result<ClaudeLine, LineProblem> => {
  const parsed = parseJson(line)
  if (Result.isFailure(parsed) || !Predicate.isObject(parsed.success)) return Result.fail({ _tag: "NotJson" })
  const value = parsed.success
  if (value["method"] !== undefined) return Result.fail({ _tag: "Codex" })
  const type = typeof value["type"] === "string" ? value["type"] : ""
  const subtype = typeof value["subtype"] === "string" ? value["subtype"] : null
  if (type === "system" && subtype !== null && ignoredSystem.has(subtype)) return Result.fail({ _tag: "Ignored", type, subtype })
  const decode = decoders.get(type === "system" ? `system/${subtype ?? ""}` : type)
  if (decode === undefined) return Result.fail({ _tag: "Unknown", type, subtype })
  const decoded = decode(value)
  if (Result.isFailure(decoded)) return Result.fail({ _tag: "Malformed", type, subtype, issue: decoded.failure.message })
  return Result.succeed(decoded.success)
}
