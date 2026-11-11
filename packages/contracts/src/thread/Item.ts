import { Schema } from "effect"
import { Todo } from "../task.ts"
import { Timestamp } from "../time.ts"

// A thread's items: the entries of the conversation, told apart by `type`. Item ids keep the old forms, which the
// board keys on across areas (docs/plan/inventory/08-threads.md, 3.2): `legacy:<n>` for an item a board write made
// (`<n>` its write number), `legacy:<n>:<block>` for one content block of an agent's message, `legacy:<n>:result` for a
// turn's result text nobody said, and the agent's own id for a tool call (Claude's `toolu_…`, Codex's item id).

/** The board's own facts about an item or request that the protocol does not model, sent as given. */
export const ThreadMetadata = Schema.Record(Schema.String, Schema.Unknown)
export type ThreadMetadata = typeof ThreadMetadata.Type

/** What every item has besides its type. */
const itemBase = {
  id: Schema.String,
  /** The subagent tool call this item belongs to. Absent for the main conversation. */
  parent_id: Schema.optionalKey(Schema.String),
  created_at: Schema.optionalKey(Timestamp),
  /**
   * The board's own facts (inventory 08, 3.3): a user message the board sent itself (`auto`), a turn result's
   * `subtype`, `num_turns` and `total_cost_usd`, a compaction's `post_tokens`, a text from a turn's result
   * (`from_result`), a subagent call's `description` and `prompt`, a routine report's whole report.
   */
  metadata: Schema.optionalKey(ThreadMetadata),
}

/** A message to the agent. */
export const UserMessage = Schema.Struct({
  ...itemBase,
  type: Schema.Literal("user_message"),
  text: Schema.String,
  /** Sent while a turn was running, so it joined that turn. */
  steered: Schema.optionalKey(Schema.Boolean),
})
export type UserMessage = typeof UserMessage.Type

/** Text from the agent, as Markdown. */
export const AssistantMessage = Schema.Struct({ ...itemBase, type: Schema.Literal("assistant_message"), text: Schema.String })
export type AssistantMessage = typeof AssistantMessage.Type

/** The agent's thinking, or a summary of it. */
export const Reasoning = Schema.Struct({ ...itemBase, type: Schema.Literal("reasoning"), text: Schema.String })
export type Reasoning = typeof Reasoning.Type

/** What a tool does, for permission policies and for picking a renderer. */
export const ToolKind = Schema.Literals(["shell", "read", "edit", "search", "web", "mcp", "app", "subagent", "todo", "other"])
export type ToolKind = typeof ToolKind.Type

/** pending: called, not started. running: no result yet. completed; failed (the result is the error); denied; cancelled (its turn ended first). */
export const ToolStatus = Schema.Literals(["pending", "running", "completed", "failed", "denied", "cancelled"])
export type ToolStatus = typeof ToolStatus.Type

/** What a tool returned. For a failed call, `content` is the error. */
export const ToolResult = Schema.Struct({
  /** The result as text. Images are `[image]`. */
  content: Schema.String,
  /** `content` was cut short. */
  truncated: Schema.optionalKey(Schema.Boolean),
  /** shell: the command's exit code. */
  exit_code: Schema.optionalKey(Schema.Finite),
})
export type ToolResult = typeof ToolResult.Type

export const FileChange = Schema.Struct({
  path: Schema.String,
  op: Schema.Literals(["add", "update", "delete"]),
  /** A unified diff of the change, or the content of an added file. */
  diff: Schema.optionalKey(Schema.String),
  move_to: Schema.optionalKey(Schema.String),
})
export type FileChange = typeof FileChange.Type

export const SubagentStatus = Schema.Literals(["running", "completed", "failed", "stopped"])
export type SubagentStatus = typeof SubagentStatus.Type

/** A subagent as its call shows it. */
export const SubagentState = Schema.Struct({
  status: SubagentStatus,
  /** Its call returned as soon as it started, and it carries on (after its turn has ended too) until it ends. */
  background: Schema.optionalKey(Schema.Boolean),
  agent_type: Schema.optionalKey(Schema.String),
  model: Schema.optionalKey(Schema.String),
  /** What it is doing, as of its latest progress report. */
  activity: Schema.optionalKey(Schema.String),
  tool_uses: Schema.optionalKey(Schema.Finite),
  /** A background subagent's final report, once it has ended. */
  summary: Schema.optionalKey(Schema.String),
  /** When it ended (the first time, if it ran again). */
  ended_at: Schema.optionalKey(Timestamp),
})
export type SubagentState = typeof SubagentState.Type

/**
 * A tool the agent called, with its result once it has one. A subagent is a tool call of kind `subagent`, and the items
 * it makes have its id as their `parent_id`. The fields after `result` are the same facts for every agent.
 */
export const ToolCall = Schema.Struct({
  ...itemBase,
  type: Schema.Literal("tool_call"),
  /** The tool's name as the agent gave it. For an MCP tool, the tool's own name, with the server's in `server`. */
  name: Schema.String,
  kind: ToolKind,
  /** As the agent gave it, kept as it is. */
  input: Schema.Unknown,
  status: ToolStatus,
  result: Schema.optionalKey(ToolResult),
  /** A short summary of the call, e.g. a subagent's description. */
  title: Schema.optionalKey(Schema.String),
  /** shell: the command line. */
  command: Schema.optionalKey(Schema.String),
  /** read, search: the file or folder. */
  path: Schema.optionalKey(Schema.String),
  /** edit: the files it changes. */
  changes: Schema.optionalKey(Schema.Array(FileChange)),
  /** search: the pattern. web: the search query. */
  query: Schema.optionalKey(Schema.String),
  /** web: the URL fetched. */
  url: Schema.optionalKey(Schema.String),
  /** mcp: the MCP server's name. */
  server: Schema.optionalKey(Schema.String),
  /** todo: the whole list after the call. */
  todos: Schema.optionalKey(Schema.Array(Todo)),
  subagent: Schema.optionalKey(SubagentState),
})
export type ToolCall = typeof ToolCall.Type

/** The agent compacted the conversation's context. */
export const Compaction = Schema.Struct({
  ...itemBase,
  type: Schema.Literal("compaction"),
  trigger: Schema.optionalKey(Schema.Literals(["auto", "manual"])),
  summary: Schema.optionalKey(Schema.String),
  tokens_before: Schema.optionalKey(Schema.Finite),
})
export type Compaction = typeof Compaction.Type

/**
 * Something to tell the user that is not the agent talking. A notice with a `code` other than `routine_report` and
 * `interrupted` is an API error of the agent's, and counts as the agent speaking; the board's own events have none.
 */
export const Notice = Schema.Struct({
  ...itemBase,
  type: Schema.Literal("notice"),
  level: Schema.Literals(["info", "warning", "error"]),
  text: Schema.String,
  code: Schema.optionalKey(Schema.String),
  detail: Schema.optionalKey(Schema.String),
})
export type Notice = typeof Notice.Type

/** How a turn ended: the last item of each turn. */
export const TurnResult = Schema.Struct({
  ...itemBase,
  type: Schema.Literal("turn_result"),
  /** It finished without an error. An interrupted turn is not ok. */
  ok: Schema.Boolean,
  interrupted: Schema.optionalKey(Schema.Boolean),
  error: Schema.optionalKey(Schema.String),
  duration_ms: Schema.optionalKey(Schema.Finite),
})
export type TurnResult = typeof TurnResult.Type

/** One entry in a thread, told apart by `type`. */
export const Item = Schema.Union([UserMessage, AssistantMessage, Reasoning, ToolCall, Compaction, Notice, TurnResult])
export type Item = typeof Item.Type
export type ItemType = Item["type"]
