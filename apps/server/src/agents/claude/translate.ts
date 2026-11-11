import type { Compaction, Item, NewEvent, Notice, ThreadMetadata, Timestamp, ToolCall, ToolStatus, TurnResult } from "@huntaway/contracts"
import { HashMap, Predicate, Schema } from "effect"
import {
  type AssistantLine,
  type ClaudeLine,
  type CompactBoundaryLine,
  type ResultLine,
  type TaskLine,
  TextBlock,
  ThinkingBlock,
  ToolResultBlock,
  ToolUseBlock,
  type UserLine,
} from "./lines.ts"
import { type Call, Draft, get, type ItemMeta, sameSession, type TranslateWarning, type TranslatorState } from "./state.ts"
import { agentResultMeta, subagentResult, subagentStarted, subagentTask } from "./subagents.ts"
import { isTruncated, jsonText, resultText, sameJson, str, toolFields, uint } from "./tools.ts"

// Claude Code's lines to thread events (docs/plan/07-agents.md, The two drivers; inventory 08, section 3.5): the old
// Translator's rules for what the agent says, without the slimmed legacy message in between. `translate` is a pure
// function of the state and one decoded line. Besides the thread's events and the metas of the items they make, it says
// what the line tells the run (`LineEffect`s: a session, a turn starting or ending, the reply being written, a rate
// limit), for the caller to apply. What the board writes itself (the user's messages, notices, requests) is not the
// translator's: `observe` takes it in, and `requestForPrompt` (requests.ts) makes a prompt's request.
//
// Ids are stable: tool calls keep Claude's ids (but for a second call with one id, `legacy:<n>:<block>`), and the other
// items are `legacy:<n>` or `legacy:<n>:<block>`, where `n` is the board's write number for the line (`LineContext`),
// and `legacy:<n>:result` for a turn's result text that no message said.

export { emptyState, ItemMeta, observe, stateFromItems, type TranslateWarning, type TranslatorState } from "./state.ts"

/** What the caller knows of a line that the line does not say. */
export interface LineContext {
  /** The board's write number for the line: the items it makes that have no agent's id are `legacy:<writeNo>…`. */
  readonly writeNo: number
  /** When it was read: its items' `created_at`, and when a subagent ended. */
  readonly at: Timestamp
  /** For a `result` line: what the run knows of the turn it ends. Without it: no cost, not stopped, not a compaction. */
  readonly turn?: TurnFacts
}

export interface TurnFacts {
  /** What the turn added to the session's cost: the increase of its running total (`turnCost`, `RunRepo.addCost`). */
  readonly cost: number
  /** A stop was asked for and this is the turn it cut short (`runs.stop` is `requested`). */
  readonly stopping: boolean
  /** The run is a compaction's (`kind: "compact"`). */
  readonly compact: boolean
}

/** What a line tells the run, for the caller to apply. */
export type LineEffect =
  /** `system/init`: the session the run is in (the task's and the run's `session_id`). */
  | { readonly _tag: "SessionStarted"; readonly sessionId: string }
  /**
   * A turn is going: Claude Code started (`init`, unless the turn is the one a steered message starts), the API started
   * a message (`message_start`), or the main conversation's assistant spoke (`assistant`).
   */
  | { readonly _tag: "TurnStarted"; readonly from: "init" | "message_start" | "assistant" }
  /**
   * `result`: the turn ended. `error`: the run's `result_error` (null if it went well); `interrupted`: the stop cut it
   * short; `usageLimit`: refused for the usage limit (the config is out of usage).
   */
  | { readonly _tag: "TurnEnded"; readonly error: string | null; readonly interrupted: boolean; readonly usageLimit: boolean }
  /** The reply being written starts again: a new message or content block (each text block is an item of its own). */
  | { readonly _tag: "PreviewReset" }
  /** Text streamed for the reply being written (`Threads.preview`): never stored. */
  | { readonly _tag: "PreviewText"; readonly text: string }
  /**
   * Claude Code took in a message the run sent (`isReplay`): its `uuid` (a steered message's id, or the prompt's), and the
   * background task whose `<task-notification>` it was, if it was one.
   */
  | { readonly _tag: "Echoed"; readonly uuid: string | null; readonly taskNotification: string | null }
  /** The main conversation's latest message, where a rewind can resume it (`runs.agent_at`). */
  | { readonly _tag: "AgentAt"; readonly uuid: string }
  /** How much of a usage window is left (`rate_limit_event`, or a turn refused for the usage limit). */
  | { readonly _tag: "RateLimit"; readonly info: unknown }
  /** The conversation was compacted, for the context meter (`compact_metadata` as Claude Code gave it). */
  | { readonly _tag: "Compacted"; readonly metadata: CompactBoundaryLine["compact_metadata"] | null }

/** What one line made. */
export interface Translated {
  readonly state: TranslatorState
  /** To append to the thread, in order (`Threads.appendFromAgent`). */
  readonly events: ReadonlyArray<NewEvent>
  /** The items whose meta the line set, with all of their meta now. */
  readonly metas: ReadonlyMap<string, ItemMeta>
  readonly effects: ReadonlyArray<LineEffect>
  readonly warnings: ReadonlyArray<TranslateWarning>
}

const isText = Schema.is(TextBlock)
const isThinking = Schema.is(ThinkingBlock)
const isToolUse = Schema.is(ToolUseBlock)
const isToolResult = Schema.is(ToolResultBlock)

/** How Claude Code's result for a call that was stopped starts (a denied call's is the denial's message). */
const REJECTED = "The user doesn't want to proceed with this tool use."
const INTERRUPTED = "[Request interrupted"

/** One step's builder: the draft state and what the line makes. */
class Step extends Draft {
  readonly effects: Array<LineEffect> = []
  readonly ctx: LineContext

  constructor(state: TranslatorState, ctx: LineContext) {
    super(state)
    this.ctx = ctx
  }

  id(suffix?: string | number): string {
    return suffix === undefined ? `legacy:${this.ctx.writeNo}` : `legacy:${this.ctx.writeNo}:${suffix}`
  }
}

/** What line `line` makes of the thread whose state is `state`, and the state after it. */
export const translate = (state: TranslatorState, line: ClaudeLine, ctx: LineContext): Translated => {
  const step = new Step(state, ctx)
  switch (line.type) {
    case "system":
      if (line.subtype === "init") {
        if (line.session_id !== undefined && line.session_id !== "") step.effects.push({ _tag: "SessionStarted", sessionId: line.session_id })
        step.effects.push({ _tag: "TurnStarted", from: "init" })
      } else if (line.subtype === "compact_boundary") compactBoundary(step, line)
      else if (line.subtype !== "background_tasks_changed") job(step, line)
      break
    case "stream_event":
      streamEvent(step, line)
      break
    case "assistant":
      assistant(step, line)
      break
    case "user":
      user(step, line)
      break
    case "result":
      result(step, line)
      break
    case "rate_limit_event":
      if (line.rate_limit_info !== undefined) step.effects.push({ _tag: "RateLimit", info: line.rate_limit_info })
      break
    case "control_request":
    case "control_cancel_request":
    case "control_response":
      break
  }
  return { state: step.s, events: step.events, metas: step.metas, effects: step.effects, warnings: step.warnings }
}

// ---------- what a line tells the run ----------

/**
 * The run's `result_error` for a turn's result: its text, its errors, or what it ended with; null if it went well.
 */
export const resultError = (line: ResultLine): string | null => {
  if (line.is_error !== true && (typeof line.subtype !== "string" || line.subtype === "success")) return null
  if (typeof line.result === "string") return line.result
  if (Array.isArray(line.errors)) return line.errors.filter((x): x is string => typeof x === "string").join("\n")
  return `run ended with ${jsonText(line.subtype ?? null)}`
}

/** A result's cost as `RunRepo.addCost` takes it: the session's running total, its session, and whether a model counted it. */
export const turnCost = (line: ResultLine): { readonly total: number; readonly session: string | null; readonly counted: boolean } | null =>
  typeof line.total_cost_usd === "number"
    ? {
        total: line.total_cost_usd,
        session: line.session_id ?? null,
        counted: Predicate.isObject(line.modelUsage) && Object.keys(line.modelUsage).length > 0,
      }
    : null

const originKind = (origin: unknown): unknown => (Predicate.isObject(origin) ? origin["kind"] : undefined)

/**
 * Whether a result ends no turn of the run's (the follower skips it): a leftover background task's notification dealt
 * with before the run's first result (`num_turns` 0, HA-404), or, while the run waits for Claude Code to take its prompt
 * in (`awaiting`), a turn it took on its own or on other messages (HA-405).
 */
export const isForeignResult = (line: ResultLine, run: { readonly sawResult: boolean; readonly awaiting: boolean }): boolean => {
  if (originKind(line.origin) === "task-notification" && line.num_turns === 0 && !run.sawResult) return true
  if (!run.awaiting) return false
  if (line.origin !== undefined && line.origin !== null) return true
  return Array.isArray(line.user_message_uuids) && line.user_message_uuids.length > 0
}

/** The background task whose outcome an echoed user message gives the agent: Claude Code's `<task-notification>`. */
const taskNotification = (line: UserLine): string | null => {
  if (originKind(line.origin) !== "task-notification" || (line.parent_tool_use_id ?? null) !== null) return null
  const c = line.message.content
  const text = typeof c === "string" ? c : c.map((b) => (isText(b) ? b.text : "")).join("")
  const m = /<task-id>([^<]+)<\/task-id>/.exec(text)
  return m?.[1]?.trim() ?? null
}

/** A turn refused for the usage limit says when the limit resets. */
const usageLimitInfo = (step: Step, line: AssistantLine | UserLine): void => {
  const params = line.api_error_params
  const info = Predicate.isObject(params) ? params["rate_limit_info"] : undefined
  if (line.api_error === "usage_limit_reached" && Predicate.isObject(info)) step.effects.push({ _tag: "RateLimit", info: { rate_limit_info: info } })
}

const streamEvent = (step: Step, line: Extract<ClaudeLine, { type: "stream_event" }>): void => {
  // Only the main conversation streams a preview.
  if ((line.parent_tool_use_id ?? null) !== null) return
  const event = line.event
  if (event.type === "message_start") step.effects.push({ _tag: "TurnStarted", from: "message_start" }, { _tag: "PreviewReset" })
  else if (event.type === "content_block_start") step.effects.push({ _tag: "PreviewReset" })
  else if (event.type === "content_block_delta" && event.delta?.type === "text_delta" && event.delta.text !== undefined)
    step.effects.push({ _tag: "PreviewText", text: event.delta.text })
}

// ---------- parents ----------

/**
 * The item of the subagent call that `parent` (a tool_use id) names, for an item's `parent_id`, made in `session`: the
 * one with the id in the same session. A call the thread doesn't have yet keeps its id (its item's, if it comes). Null
 * (with a warning) if there's no telling which call it is: the item can't go in the main conversation instead.
 */
const parentFor = (step: Step, parent: string | undefined, session: string | undefined): { readonly ok: string | undefined } | null => {
  if (parent === undefined) return { ok: undefined }
  const all = step.callsWith(parent)
  if (all.length === 0) return { ok: parent }
  const found = all.filter((c) => sameSession(c.session, session))
  const c = found.length === 1 ? found[0] : undefined
  if (c === undefined) {
    step.warn("ambiguous_parent", `its parent call ${parent} could be any of ${found.length} calls with the id`)
    return null
  }
  if (c.kind !== "subagent") step.warn("parent_not_subagent", `its parent ${parent} is a ${c.kind} call, not a subagent's`)
  return { ok: c.item }
}

const withParent = <T extends Item>(item: T, parent: string | undefined): T => (parent === undefined ? item : { ...item, parent_id: parent })

// ---------- the lines ----------

const compactBoundary = (step: Step, line: CompactBoundaryLine): void => {
  const meta = line.compact_metadata ?? {}
  step.effects.push({ _tag: "Compacted", metadata: line.compact_metadata ?? null })
  // A subagent's own conversation compacted.
  const parent = parentFor(step, str(line, "parent_tool_use_id"), str(line, "session_id"))
  if (parent === null) return
  const trigger = meta.trigger === "auto" || meta.trigger === "manual" ? meta.trigger : undefined
  const before = uint(meta.pre_tokens)
  const after = uint(meta.post_tokens)
  const item: Compaction = {
    id: step.id(),
    type: "compaction",
    created_at: step.ctx.at,
    ...(trigger === undefined ? {} : { trigger }),
    ...(before === undefined ? {} : { tokens_before: before }),
    ...(after === undefined ? {} : { metadata: { post_tokens: after } }),
  }
  step.add(withParent(item, parent.ok))
}

const assistant = (step: Step, line: AssistantLine): void => {
  usageLimitInfo(step, line)
  const parentRaw = str(line, "parent_tool_use_id")
  if (parentRaw === undefined) step.effects.push({ _tag: "TurnStarted", from: "assistant" })
  // Thinking blocks with no text were never kept, and the blocks' indexes (in ids) are of those left.
  const blocks: ReadonlyArray<unknown> = line.message.content.filter((b) => !(b.type === "thinking" && !(isThinking(b) && b.thinking !== "")))
  if (blocks.length === 0) return
  if (line.uuid !== undefined && parentRaw === undefined) step.effects.push({ _tag: "AgentAt", uuid: line.uuid })
  const session = str(line, "session_id")
  if (session !== undefined) step.s = { ...step.s, session }
  const parent = parentFor(step, parentRaw, session)
  if (parent === null) return
  // An API error (a usage limit, say) Claude Code shows as the assistant's text.
  if (line.is_api_error_message === true) {
    const text = blocks.flatMap((b) => (isText(b) ? [b.text] : []))
    // Always with a code, which tells it from the board's own notices (the readers take it as the agent's).
    const code = str(line, "api_error") ?? str(line, "error") ?? "api_error"
    const notice: Notice = { id: step.id(), type: "notice", level: "error", text: text.join("\n"), code, created_at: step.ctx.at }
    step.add(withParent(notice, parent.ok))
    return
  }
  const texts: Array<string> = []
  blocks.forEach((block, i) => {
    if (isText(block)) {
      if (!block.text.trim()) return
      step.add(withParent({ id: step.id(i), type: "assistant_message", text: block.text, created_at: step.ctx.at }, parent.ok))
      texts.push(block.text)
    } else if (isThinking(block)) {
      if (!block.thinking.trim()) return
      step.add(withParent({ id: step.id(i), type: "reasoning", text: block.thinking, created_at: step.ctx.at }, parent.ok))
    } else if (isToolUse(block)) {
      toolUse(step, line, i, block, parent.ok)
    } else if (!Predicate.isObject(block) || block["type"] !== "redacted_thinking") {
      step.warn("unknown_block", `an assistant block of type ${jsonText(Predicate.isObject(block) ? block["type"] : null)}`)
    }
  })
  if (parent.ok === undefined && texts.length > 0) step.s = { ...step.s, lastText: texts.join("\n") }
}

const toolUse = (step: Step, line: AssistantLine, i: number, block: ToolUseBlock, parent: string | undefined): void => {
  const callId = block.id
  // A call keeps its id as its item's, but for the first: one with an id an earlier call has is `legacy:<n>:<block>`.
  const id = callId !== "" && step.call(callId) === undefined ? callId : step.id(i)
  if (id !== callId) step.warn("duplicate_call", `tool call ${jsonText(callId)} is there twice; this one is ${id}`)
  const fields = toolFields(block.name, block.input)
  const item: ToolCall = { id, type: "tool_call", ...fields, status: "running", created_at: step.ctx.at }
  step.add(withParent(item, parent))
  const session = str(line, "session_id")
  const parentRaw = str(line, "parent_tool_use_id") ?? null
  const c: Call = {
    item: id,
    callId,
    kind: fields.kind,
    status: "running",
    title: fields.title,
    hasResult: false,
    subagent: undefined,
    model: str(block.input, "model"),
    parentRaw,
    session,
    input: fields.input,
    metadata: undefined,
    subagentTask: undefined,
    shownTasks: [],
  }
  step.putCall(c)
  // What came before it: a prompt that named it by its id, before its subagent was known, and a prompt or result waiting for it.
  for (const r of HashMap.values(step.s.requests)) {
    if (r.tool_call_id === id && parent !== undefined && r.parent_id === undefined) step.open({ ...r, parent_id: parent })
  }
  const prompts = get(step.s.waitingPrompts, callId) ?? []
  const p = prompts.findIndex((w) => sameJson(w.input, fields.input))
  const waiting = prompts[p]
  if (waiting !== undefined) {
    const rest = prompts.filter((_, j) => j !== p)
    step.s = { ...step.s, waitingPrompts: rest.length > 0 ? HashMap.set(step.s.waitingPrompts, callId, rest) : HashMap.remove(step.s.waitingPrompts, callId) }
    const r = get(step.s.requests, waiting.request)
    if (r !== undefined) step.open({ ...r, tool_call_id: id, ...(parent === undefined ? {} : { parent_id: parent }) })
  }
  const early = get(step.s.early, callId) ?? []
  const e = early.findIndex((x) => x.parentRaw === parentRaw && sameSession(x.session, session))
  const held = early[e]
  if (held !== undefined) {
    const rest = early.filter((_, j) => j !== e)
    step.s = { ...step.s, early: rest.length > 0 ? HashMap.set(step.s.early, callId, rest) : HashMap.remove(step.s.early, callId) }
    toolResult(step, held.at, c, held.block, held.meta)
  }
}

const user = (step: Step, line: UserLine): void => {
  usageLimitInfo(step, line)
  // The echo of a message the run sent: the board writes a steered message itself when it sees it.
  if (line.isReplay === true) {
    step.effects.push({ _tag: "Echoed", uuid: line.uuid ?? null, taskNotification: taskNotification(line) })
    return
  }
  const content = line.message.content
  if (Array.isArray(content) && content.length === 0) return
  const parentRaw = str(line, "parent_tool_use_id")
  if (line.uuid !== undefined && parentRaw === undefined) step.effects.push({ _tag: "AgentAt", uuid: line.uuid })
  const session = str(line, "session_id")
  if (session !== undefined) step.s = { ...step.s, session }
  if (typeof content === "string") {
    // The summary a compacted conversation goes on from: the latest compaction of the same conversation.
    const parent = parentFor(step, parentRaw, session)
    if (parent === null) return
    const id = get(step.s.compaction, parent.ok ?? "")
    if (line.isSynthetic === true && id !== undefined) step.update(id, { summary: content })
    else step.warn("unplaced_text", "user text from Claude Code that isn't a compaction's summary")
    return
  }
  const blocks: ReadonlyArray<unknown> = content
  for (const block of blocks) {
    if (isToolResult(block)) {
      resultFor(step, line, block.tool_use_id ?? "", block)
    } else if (isText(block)) {
      if (line.isSynthetic === true) continue // What Claude Code adds for the model after an image, say.
      const interrupted = block.text.startsWith(INTERRUPTED)
      if (parentRaw !== undefined && !interrupted) continue // A subagent's prompt, which its call's input has.
      if (!interrupted) {
        step.warn("unplaced_text", "user text from Claude Code that isn't a tool's result")
        continue
      }
      const parent = parentFor(step, parentRaw, session)
      if (parent === null) continue
      const notice: Notice = { id: step.id(), type: "notice", level: "info", code: "interrupted", text: block.text, created_at: step.ctx.at }
      step.add(withParent(notice, parent.ok))
    } else {
      step.warn("unknown_block", `a user block of type ${jsonText(Predicate.isObject(block) ? block["type"] : null)}`)
    }
  }
}

/**
 * A tool_result block for call `id`: for the call with the id in the same subagent and session that's still waiting for
 * its result. With no call with the id yet, it waits for it.
 */
const resultFor = (step: Step, line: UserLine, id: string, block: ToolResultBlock): void => {
  const parentRaw = str(line, "parent_tool_use_id") ?? null
  const session = str(line, "session_id")
  const meta = agentResultMeta(line.tool_use_result)
  const all = step.callsWith(id)
  const found = all.filter((c) => c.parentRaw === parentRaw && sameSession(c.session, session) && !c.hasResult)
  const c = found.length === 1 ? found[0] : undefined
  if (c !== undefined) toolResult(step, step.ctx.at, c, block, meta)
  else if (found.length > 1) step.warn("ambiguous_call", `a result for call ${id}, which ${found.length} calls with the id are waiting for`)
  else if (all.length > 0) step.warn("unmatched_result", `a result for call ${id}, which no call with the id is waiting for`)
  else {
    // Before its call: given to it when it comes.
    const held = [...(get(step.s.early, id) ?? []), { writeNo: step.ctx.writeNo, at: step.ctx.at, block, meta, parentRaw, session }]
    step.s = { ...step.s, early: HashMap.set(step.s.early, id, held) }
  }
}

/** A tool_result block for call `c` (`meta`: what was kept of its line's tool_use_result), read `at`. */
const toolResult = (step: Step, at: Timestamp, c: Call, block: ToolResultBlock, meta: Readonly<Record<string, unknown>>): void => {
  const text = resultText(block.content)
  const isError = block.is_error === true
  // Claude Code's result for a call a stop cut short (a denied call's is the denial's message).
  const interrupted = text.startsWith(INTERRUPTED) || text.startsWith(REJECTED)
  const status: ToolStatus = !isError ? "completed" : step.denied(c.item) ? "denied" : interrupted ? "cancelled" : "failed"
  const patch: Record<string, unknown> = { status, result: isTruncated(text) ? { content: text, truncated: true } : { content: text } }
  if (c.hasResult) step.warn("second_result", `call ${c.callId} has a result already; this one replaces it`)
  let next: Call = { ...c, status, hasResult: true }
  if (c.kind === "subagent") {
    const s = subagentResult(c.subagent, isError, interrupted, meta, text, at)
    if (s !== undefined) {
      patch["subagent"] = s
      next = { ...next, subagent: s }
    }
  }
  step.putCall(next)
  step.update(c.item, patch)
}

/**
 * A task_* line: how a subagent (or a Bash command's run) is getting on. Claude Code's say which task by `task_id`, and
 * started ones which call by `tool_use_id`. The session they name is not used (the old board did not keep it).
 */
const job = (step: Step, line: TaskLine): void => {
  const task = line.task_id ?? ""
  const calls = step.callsWith(line.tool_use_id ?? "")
  const only = calls.length === 1 ? calls[0] : undefined
  if (line.subtype === "task_started") {
    const type = line.task_type ?? null
    if (type !== null && type !== "local_agent") {
      if (task) step.setJob(task, "shown")
      if (only !== undefined && task) step.putCall({ ...only, shownTasks: [...only.shownTasks, task] })
      if (type !== "local_bash") step.warn("unknown_task_type", `a background task of type ${jsonText(type)}`)
      return
    }
    if (only === undefined) {
      if (task) step.setJob(task, "shown")
      if (calls.length === 0) step.warn("missing_parent", `a subagent started by call ${jsonText(line.tool_use_id ?? "")}, which isn't in the thread`)
      else step.warn("ambiguous_call", `a subagent started by call ${line.tool_use_id ?? ""}, which ${calls.length} calls have as their id`)
      return
    }
    startedJob(step, line, only, task)
    return
  }
  let found = get(step.s.jobs, task)
  if (found === undefined && only?.subagent !== undefined) found = { agent: only.item }
  if (found === undefined) {
    step.warn("unknown_task", `a ${line.subtype} for a background task that never started (${jsonText(task)})`)
    return
  }
  if (found === "shown") return
  const c = step.call(found.agent)
  if (c?.subagent === undefined) return
  const next = subagentTask(c.subagent, line, step.ctx.at)
  if (sameJson(next, c.subagent)) return
  step.putCall({ ...c, subagent: next })
  step.update(c.item, { subagent: next })
}

const startedJob = (step: Step, line: TaskLine, c: Call, task: string): void => {
  // Started again (it says so when a child's details come late): how it's getting on stays.
  const started = subagentStarted(c.subagent, line, c.model)
  const s = c.subagent === undefined ? started : { ...started, status: c.subagent.status }
  const patch: Record<string, unknown> = { subagent: s }
  let next: Call = { ...c, subagent: s }
  // A Skill forked into an agent has no Agent call: its call becomes the subagent's.
  if (c.kind !== "subagent") {
    patch["kind"] = "subagent"
    next = { ...next, kind: "subagent" }
    const title = str(line, "description")
    if (title !== undefined && !c.title) {
      patch["title"] = title
      next = { ...next, title }
    }
  }
  // What the board shows as its description and prompt, as the latest task_started says them.
  const said: Record<string, unknown> = { ...c.metadata }
  for (const k of ["description", "prompt"]) {
    const v = str(line, k)
    if (v !== undefined) said[k] = v
  }
  if (!sameJson(said, c.metadata ?? {})) {
    const metadata: ThreadMetadata = said
    patch["metadata"] = metadata
    next = { ...next, metadata }
  }
  // A background subagent's call is done once it has started it. Claude Code says so with a result too, later.
  if (s.background === true && c.status === "running" && !c.hasResult) {
    patch["status"] = "completed"
    next = { ...next, status: "completed" }
  }
  if (task) {
    next = { ...next, subagentTask: task }
    step.setJob(task, { agent: c.item })
  }
  step.putCall(next)
  step.update(c.item, patch)
}

const result = (step: Step, line: ResultLine): void => {
  const facts = step.ctx.turn ?? { cost: 0, stopping: false, compact: false }
  const error = resultError(line)
  // The turn a stop cut short.
  const interrupted = facts.stopping && error !== null
  step.effects.push({ _tag: "TurnEnded", error, interrupted, usageLimit: line.api_error === "usage_limit_reached" })
  const ok = line.subtype === "success" && line.is_error !== true
  // What the turn ended by saying, if no message of its said it (a turn a background subagent's report started, say).
  const said = step.s.lastText
  step.s = { ...step.s, lastText: null }
  const text = str(line, "result")
  if (text !== undefined && ok && text.trim() && said?.trim() !== text.trim()) {
    const id = step.id("result")
    // The board's view doesn't draw it (it shows the turn's end): its metadata says so.
    step.add({ id, type: "assistant_message", text, created_at: step.ctx.at, metadata: { from_result: true } })
    step.setMeta(id, { from_result: true })
  }
  const id = step.id()
  const durationMs = uint(line.duration_ms)
  const metadata: Record<string, unknown> = {
    ...(typeof line.subtype === "string" ? { subtype: line.subtype } : {}),
    ...(typeof line.num_turns === "number" ? { num_turns: line.num_turns } : {}),
    total_cost_usd: facts.cost,
  }
  const item: TurnResult = {
    id,
    type: "turn_result",
    ok,
    created_at: step.ctx.at,
    ...(interrupted ? { interrupted: true } : {}),
    // An interrupted turn's result says nothing more than that.
    ...(!ok && (text !== undefined || !interrupted) ? { error: text ?? str(line, "subtype") ?? "error" } : {}),
    ...(durationMs === undefined ? {} : { duration_ms: durationMs }),
    metadata,
  }
  step.add(item)
  // What its result said, whichever way the turn went (the readers take it as what the agent said last there), and
  // whether it was a compaction's.
  step.setMeta(id, { ...(text === undefined ? {} : { result_text: text }), ...(facts.compact ? { compact: true } : {}) })
}
