import { Option, Predicate, Schema } from "effect"

// What the adapter reads of the Agent Client Protocol (https://agentclientprotocol.com, schema v1; t3code's
// packages/effect-acp/src/_generated/schema-v1.gen.ts was the reference): the agent's answers to `initialize`,
// `session/new` (`session/resume`, `session/load`), `session/set_config_option` and `session/prompt`, its
// `session/update` notifications and its `session/request_permission` requests. Lenient, as the Codex side is: unknown
// fields are ignored, a field the adapter doesn't need is `Unknown`, and a message that doesn't decode is `None` for the
// caller to skip (and say so), never thrown. Agents add to the protocol (Antigravity's `_meta`, nonstandard `rawInput`
// keys), so what isn't the protocol's core is read field by field (`map.ts`).

const isRecord = (v: unknown): v is Readonly<Record<string, unknown>> => Predicate.isObject(v) && !Array.isArray(v)

const Opt = <S extends Schema.Top>(s: S) => Schema.optionalKey(Schema.NullOr(s))

/** `initialize`'s answer: what the agent can do. */
export const InitializeResponse = Schema.Struct({
  protocolVersion: Opt(Schema.Finite),
  agentCapabilities: Opt(
    Schema.Struct({
      loadSession: Opt(Schema.Boolean),
      sessionCapabilities: Opt(Schema.Struct({ resume: Opt(Schema.Unknown) })),
      mcpCapabilities: Opt(Schema.Struct({ http: Opt(Schema.Boolean), sse: Opt(Schema.Boolean) })),
    }),
  ),
  agentInfo: Opt(Schema.Struct({ name: Opt(Schema.String), version: Opt(Schema.String) })),
})
export type InitializeResponse = typeof InitializeResponse.Type

/** One choice of a select config option. */
export const SelectValue = Schema.Struct({ value: Schema.String, name: Opt(Schema.String), description: Opt(Schema.String) })
export type SelectValue = typeof SelectValue.Type

/** A session config option, as the adapter reads it: a select's id, category, current value and choices (grouped or not). */
export const ConfigOption = Schema.Struct({
  id: Schema.String,
  name: Opt(Schema.String),
  category: Opt(Schema.String),
  type: Opt(Schema.String),
  currentValue: Opt(Schema.Unknown),
  options: Opt(Schema.Array(Schema.Unknown)),
})
export type ConfigOption = typeof ConfigOption.Type

/** `session/new`'s (and `session/resume`'s, `session/load`'s) answer. */
export const SessionResponse = Schema.Struct({
  sessionId: Opt(Schema.String),
  modes: Opt(
    Schema.Struct({
      currentModeId: Opt(Schema.String),
      availableModes: Opt(Schema.Array(Schema.Struct({ id: Schema.String, name: Opt(Schema.String) }))),
    }),
  ),
  configOptions: Opt(Schema.Array(Schema.Unknown)),
  models: Opt(
    Schema.Struct({
      currentModelId: Opt(Schema.String),
      availableModels: Opt(Schema.Array(Schema.Struct({ modelId: Schema.String, name: Opt(Schema.String), description: Opt(Schema.String) }))),
    }),
  ),
})
export type SessionResponse = typeof SessionResponse.Type

/** A turn's token use (`session/prompt`'s `usage`, unstable in the protocol). */
export const PromptUsage = Schema.Struct({
  totalTokens: Opt(Schema.Finite),
  inputTokens: Opt(Schema.Finite),
  outputTokens: Opt(Schema.Finite),
  thoughtTokens: Opt(Schema.Finite),
  cachedReadTokens: Opt(Schema.Finite),
  cachedWriteTokens: Opt(Schema.Finite),
})
export type PromptUsage = typeof PromptUsage.Type

/** `session/prompt`'s answer: why the turn ended. */
export const PromptResponse = Schema.Struct({ stopReason: Opt(Schema.String), usage: Opt(PromptUsage) })
export type PromptResponse = typeof PromptResponse.Type

/** A tool call's fields, in `tool_call`, `tool_call_update` and a permission request's `toolCall` (all but the id optional). */
export const ToolCallFields = Schema.Struct({
  toolCallId: Schema.String,
  title: Opt(Schema.String),
  kind: Opt(Schema.String),
  status: Opt(Schema.String),
  content: Opt(Schema.Array(Schema.Unknown)),
  locations: Opt(Schema.Array(Schema.Unknown)),
  rawInput: Schema.optionalKey(Schema.Unknown),
  rawOutput: Schema.optionalKey(Schema.Unknown),
  _meta: Schema.optionalKey(Schema.Unknown),
})
export type ToolCallFields = typeof ToolCallFields.Type

const ContentChunk = Schema.Struct({ content: Opt(Schema.Unknown) })
const PlanUpdate = Schema.Struct({ entries: Opt(Schema.Array(Schema.Unknown)) })
const UsageUpdate = Schema.Struct({ used: Schema.Finite, size: Schema.Finite })

/** A `session/update`'s update, by `sessionUpdate`; `Other` for the ones the adapter has no use for. */
export type SessionUpdate =
  | { readonly _tag: "AgentMessage"; readonly text: string }
  | { readonly _tag: "AgentThought"; readonly text: string }
  | { readonly _tag: "UserMessage"; readonly text: string }
  | { readonly _tag: "ToolCall"; readonly fields: ToolCallFields }
  | { readonly _tag: "ToolCallUpdate"; readonly fields: ToolCallFields }
  | { readonly _tag: "Plan"; readonly entries: ReadonlyArray<unknown> }
  | { readonly _tag: "Usage"; readonly used: number; readonly size: number }
  | { readonly _tag: "Other"; readonly kind: string }

const decodeChunk = Schema.decodeUnknownOption(ContentChunk)
const decodeTool = Schema.decodeUnknownOption(ToolCallFields)
const decodePlan = Schema.decodeUnknownOption(PlanUpdate)
const decodeUsage = Schema.decodeUnknownOption(UsageUpdate)

/** A content block's text (a `text` block; the others, images and resources, have none the board shows). */
export const blockText = (block: unknown): string => (isRecord(block) && block["type"] === "text" && typeof block["text"] === "string" ? block["text"] : "")

/** A `session/update`'s `update`, or None for one that doesn't decode. */
export const sessionUpdate = (update: unknown): Option.Option<SessionUpdate> => {
  if (!isRecord(update) || typeof update["sessionUpdate"] !== "string") return Option.none()
  const kind = update["sessionUpdate"]
  const chunk = (tag: "AgentMessage" | "AgentThought" | "UserMessage") =>
    Option.map(decodeChunk(update), (c): SessionUpdate => ({ _tag: tag, text: blockText(c.content) }))
  switch (kind) {
    case "agent_message_chunk":
      return chunk("AgentMessage")
    case "agent_thought_chunk":
      return chunk("AgentThought")
    case "user_message_chunk":
      return chunk("UserMessage")
    case "tool_call":
      return Option.map(decodeTool(update), (fields): SessionUpdate => ({ _tag: "ToolCall", fields }))
    case "tool_call_update":
      return Option.map(decodeTool(update), (fields): SessionUpdate => ({ _tag: "ToolCallUpdate", fields }))
    case "plan":
      return Option.map(decodePlan(update), (p): SessionUpdate => ({ _tag: "Plan", entries: p.entries ?? [] }))
    case "usage_update":
      return Option.map(decodeUsage(update), (u): SessionUpdate => ({ _tag: "Usage", used: u.used, size: u.size }))
    default:
      return Option.some({ _tag: "Other", kind })
  }
}

/** A permission option the agent offers. */
export const PermissionOption = Schema.Struct({ optionId: Schema.String, name: Opt(Schema.String), kind: Opt(Schema.String) })
export type PermissionOption = typeof PermissionOption.Type

/** `session/request_permission`'s params. */
export const PermissionRequest = Schema.Struct({
  sessionId: Opt(Schema.String),
  toolCall: ToolCallFields,
  options: Schema.Array(PermissionOption),
})
export type PermissionRequest = typeof PermissionRequest.Type

export const decodeInitialize = Schema.decodeUnknownOption(InitializeResponse)
export const decodeSession = Schema.decodeUnknownOption(SessionResponse)
export const decodePrompt = Schema.decodeUnknownOption(PromptResponse)
export const decodePermission = Schema.decodeUnknownOption(PermissionRequest)
const decodeConfigOption = Schema.decodeUnknownOption(ConfigOption)
const decodeSelectValue = Schema.decodeUnknownOption(SelectValue)

/** The config options of an answer (`configOptions`), those that decode. */
export const configOptions = (list: ReadonlyArray<unknown> | null | undefined): ReadonlyArray<ConfigOption> =>
  (list ?? []).flatMap((o) => Option.toArray(decodeConfigOption(o)))

/** A select option's choices, its groups' flattened. */
export const selectValues = (option: ConfigOption): ReadonlyArray<SelectValue> =>
  (option.options ?? []).flatMap((o): ReadonlyArray<SelectValue> => {
    if (isRecord(o) && Array.isArray(o["options"]) && !("value" in o)) return o["options"].flatMap((x: unknown) => Option.toArray(decodeSelectValue(x)))
    return Option.toArray(decodeSelectValue(o))
  })

/** The JSON-RPC error code an agent signed out answers `session/new` with (Antigravity: "Authentication required"). */
export const AUTH_REQUIRED = -32000
