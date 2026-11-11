import { Schema } from "effect"
import { Timestamp } from "../time.ts"
import { ThreadMetadata, ToolKind } from "./Item.ts"
import { ThreadPermissionMode } from "./Thread.ts"

// What the agent asks the user: permission for a tool, questions, a plan. A request stays in the thread with its
// resolution once answered. Its id is the prompt's (`permission_requests.id`), or `legacy:<n>` for a question the board
// asked itself (`<n>` its write number).

/** How a request was answered, as `respond` sends it and `request.resolved` repeats it. */
export const RequestResolution = Schema.Struct({
  /** allow, deny: a permission or a plan. answer: a question. cancel: any, dismissed or its run ended first. */
  outcome: Schema.Literals(["allow", "deny", "answer", "cancel"]),
  /** allow, deny: the same for matching calls from now on. */
  always: Schema.optionalKey(Schema.Boolean),
  /** deny: why, which the agent is told. answer: a note with the answers. cancel: why. */
  message: Schema.optionalKey(Schema.String),
  /** A plan's allow: the mode to carry on in. */
  permission_mode: Schema.optionalKey(ThreadPermissionMode),
  /** answer: for each question's id, the chosen option labels and the free text. */
  answers: Schema.optionalKey(Schema.Record(Schema.String, Schema.Array(Schema.String))),
})
export type RequestResolution = typeof RequestResolution.Type

/** What every request has besides its type. */
const requestBase = {
  id: Schema.String,
  /** The tool call it is for, when there is one. */
  tool_call_id: Schema.optionalKey(Schema.String),
  /** The subagent tool call that is asking, if one is. */
  parent_id: Schema.optionalKey(Schema.String),
  /** Absent while it is open. */
  resolution: Schema.optionalKey(RequestResolution),
  created_at: Schema.optionalKey(Timestamp),
  /** The board's own record of it, which its cards draw (inventory 08, 3.3). */
  metadata: Schema.optionalKey(ThreadMetadata),
}

/** The agent wants to call a tool, and the permission policy said ask. */
export const PermissionRequest = Schema.Struct({
  ...requestBase,
  type: Schema.Literal("permission"),
  name: Schema.String,
  kind: ToolKind,
  server: Schema.optionalKey(Schema.String),
  input: Schema.Unknown,
  title: Schema.optionalKey(Schema.String),
})
export type PermissionRequest = typeof PermissionRequest.Type

export const QuestionOption = Schema.Struct({ label: Schema.String, description: Schema.optionalKey(Schema.String) })
export type QuestionOption = typeof QuestionOption.Type

export const Question = Schema.Struct({
  /** Unique within the request: the key of its answer. */
  id: Schema.String,
  question: Schema.String,
  header: Schema.optionalKey(Schema.String),
  /** With none, the answer is free text. */
  options: Schema.optionalKey(Schema.Array(QuestionOption)),
  multi_select: Schema.optionalKey(Schema.Boolean),
  /** Free text as well as the options. */
  allow_other: Schema.optionalKey(Schema.Boolean),
  /** Don't show or log the answer. */
  secret: Schema.optionalKey(Schema.Boolean),
})
export type Question = typeof Question.Type

/** The agent asks the user questions (Claude's AskUserQuestion, Codex's requestUserInput, the board's own). */
export const QuestionRequest = Schema.Struct({ ...requestBase, type: Schema.Literal("question"), questions: Schema.NonEmptyArray(Question) })
export type QuestionRequest = typeof QuestionRequest.Type

/** The agent has a plan and asks to start on it (Claude's ExitPlanMode). */
export const PlanRequest = Schema.Struct({
  ...requestBase,
  type: Schema.Literal("plan"),
  /** Markdown. */
  plan: Schema.String,
})
export type PlanRequest = typeof PlanRequest.Type

export const ThreadRequest = Schema.Union([PermissionRequest, QuestionRequest, PlanRequest])
export type ThreadRequest = typeof ThreadRequest.Type
