import { BOARD_SERVER_NAMES, BOARD_TOOLS } from "@huntaway/shared"
import { Predicate } from "effect"
import { jsonText } from "../claude/tools.ts"
import { MODEL_METHOD, toolUse } from "../codex/items.ts"
import { unifiedDiff } from "./diff.ts"
import { blockText } from "./protocol.ts"
import type { PermissionOption, PermissionRequest, PromptUsage, SessionUpdate, ToolCallFields } from "./protocol.ts"

// An ACP session's messages as a Codex run's output lines (the contract at the top of spec.ts), as a pure function of
// the mapping's state and one message: `(state, message) → (state, lines)`. The adapter (adapter/run.ts) writes the
// lines to the run's output, where the board reads them as it reads `codex-run`'s (`agents/codex/lines.ts`,
// `translate.ts`). Item ids start with the run's `seed`, so a resumed session's next run doesn't reuse the ids of the
// thread's items: `<seed>:msg:<n>` (an agent message), `<seed>:think:<n>` (reasoning), `<seed>:tool:<toolCallId>`.
//
// - Text chunks make one item each run of chunks: an `agentMessage` (with `item/agentMessage/delta`s, for the reply
//   being written) or a `reasoning` item, completed when another kind of update (a tool call, a plan, the other kind of
//   text) comes, or the turn ends.
// - A tool call is an item from its first `tool_call` (once it says enough: an `execute` call its command, an edit its
//   changes; or a permission is asked about it, or it's done) to the `tool_call_update` that says it's `completed` or
//   `failed`: a `commandExecution` (kind `execute`, or a command in Antigravity's `rawInput` keys), a `fileChange` (a
//   `diff` content, or kind `edit`/`delete`/`move`), an `mcpToolCall` (Antigravity's `_meta.is_mcp_tool_call`, or an
//   `mcp__<server>__<tool>` title), else a `dynamicToolCall` in namespace `acp` named for its kind (or its title). A call
//   whose permission the board refused is `declined` (denied in the thread).
// - A plan is `turn/plan/updated`; a `usage_update` (the context's size) and the prompt's `usage` (the turn's tokens)
//   `thread/tokenUsage/updated`, whose `total` adds up the run's turns.
// - A permission request is one of Codex's requests (an id of the mapping's own), with its item as `item`.

/** A line of output (a Codex-shaped notification or request), to write as JSON. */
export type Line = Readonly<Record<string, unknown>>

/** Token counts as Codex's `thread/tokenUsage/updated` has them (`inputTokens` with the cached ones). */
export interface Tokens {
  readonly inputTokens: number
  readonly cachedInputTokens: number
  readonly outputTokens: number
  readonly reasoningOutputTokens: number
  readonly totalTokens: number
}

const zero: Tokens = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 }

type ItemType = "commandExecution" | "fileChange" | "mcpToolCall" | "dynamicToolCall"

/** A tool call of the turn: what the agent said of it so far, and how far the board has seen it. */
interface Tool {
  readonly itemId: string
  readonly fields: ToolCallFields
  /** Fixed when its item starts. */
  readonly type: ItemType | null
  readonly started: boolean
  readonly done: boolean
  /** The board refused its permission: it ends `declined`. */
  readonly rejected: boolean
}

/** The text item being streamed. */
interface Text {
  readonly type: "agentMessage" | "reasoning"
  readonly id: string
  readonly text: string
}

export interface AcpState {
  readonly seed: string
  /** The ACP session: the Codex thread. */
  readonly threadId: string
  readonly turnId: string | null
  readonly turns: number
  /** Text items so far, for their ids. */
  readonly texts: number
  readonly text: Text | null
  /** The turn's tool calls, by ACP `toolCallId`. */
  readonly tools: ReadonlyMap<string, Tool>
  /** The run's tokens so far. */
  readonly total: Tokens
  /** The context's latest size (`usage_update`). */
  readonly context: { readonly used: number; readonly size: number } | null
  /** Requests so far, for their ids. */
  readonly requests: number
}

export interface Step {
  readonly state: AcpState
  readonly lines: ReadonlyArray<Line>
}

export const initialState = (seed: string, threadId: string): AcpState => ({
  seed,
  threadId,
  turnId: null,
  turns: 0,
  texts: 0,
  text: null,
  tools: new Map(),
  total: zero,
  context: null,
  requests: 0,
})

const isRecord = (v: unknown): v is Readonly<Record<string, unknown>> => Predicate.isObject(v) && !Array.isArray(v)
const str = (v: unknown, key: string): string | null => {
  const x = isRecord(v) ? v[key] : undefined
  return typeof x === "string" ? x : null
}
const firstStr = (v: unknown, keys: ReadonlyArray<string>): string | null => {
  for (const k of keys) {
    const s = str(v, k)
    if (s !== null && s.trim() !== "") return s
  }
  return null
}
const int = (v: unknown, keys: ReadonlyArray<string>): number | null => {
  for (const k of keys) {
    const x = isRecord(v) ? v[k] : undefined
    if (typeof x === "number" && Number.isInteger(x)) return x
  }
  return null
}

// ---------- lines ----------

/** The session started (or was resumed): its id is the thread's. */
export const threadStarted = (state: AcpState): Line => ({ method: "thread/started", params: { thread: { id: state.threadId } } })

/** The model the session runs on, for the board's token counts. */
export const modelLine = (state: AcpState, model: string): Line => ({ method: MODEL_METHOD, params: { threadId: state.threadId, model } })

/** A warning for the thread. */
export const warning = (message: string): Line => ({ method: "warning", params: { message } })

const params = (state: AcpState, rest: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> => ({
  threadId: state.threadId,
  ...(state.turnId === null ? {} : { turnId: state.turnId }),
  ...rest,
})
const itemLine = (state: AcpState, method: "item/started" | "item/completed", item: unknown): Line => ({ method, params: params(state, { item }) })

// ---------- text ----------

const textItem = (t: Text, done: boolean): Line =>
  t.type === "agentMessage"
    ? { type: "agentMessage", id: t.id, text: done ? t.text : "" }
    : { type: "reasoning", id: t.id, summary: done && t.text !== "" ? [t.text] : [], content: [] }

/** The text item being streamed, completed. */
const closeText = (state: AcpState): Step =>
  state.text === null ? { state, lines: [] } : { state: { ...state, text: null }, lines: [itemLine(state, "item/completed", textItem(state.text, true))] }

const chunk = (state: AcpState, type: Text["type"], text: string): Step => {
  if (text === "") return { state, lines: [] }
  const closed = state.text !== null && state.text.type !== type ? closeText(state) : { state, lines: [] }
  let s = closed.state
  const lines: Array<Line> = [...closed.lines]
  if (s.text === null) {
    const n = s.texts + 1
    const t: Text = { type, id: `${s.seed}:${type === "agentMessage" ? "msg" : "think"}:${n}`, text: "" }
    s = { ...s, texts: n, text: t }
    lines.push(itemLine(s, "item/started", textItem(t, false)))
  }
  const open = s.text ?? { type, id: "", text: "" }
  s = { ...s, text: { ...open, text: open.text + text } }
  if (type === "agentMessage") lines.push({ method: "item/agentMessage/delta", params: params(s, { itemId: open.id, delta: text }) })
  return { state: s, lines }
}

// ---------- tool calls ----------

const COMMAND_KEYS = ["CommandLine", "command_line", "commandLine", "command", "cmd"]
const CWD_KEYS = ["Cwd", "WorkingDirectory", "working_dir", "workingDir", "cwd"]

const meta = (f: ToolCallFields): unknown => f._meta

/** The command an `execute` call runs: Antigravity's `rawInput` keys, else its title (without the backticks round it). */
const commandOf = (f: ToolCallFields, execute: boolean): string | null => {
  const raw = firstStr(f.rawInput, COMMAND_KEYS) ?? firstStr(f.rawOutput, ["commandLine", "command_line"])
  if (raw !== null) return raw.trim()
  if (!execute) return null
  const title = (f.title ?? "").trim().replace(/^`(.*)`$/su, "$1")
  return title === "" ? null : title
}

interface Change {
  readonly path: string
  readonly kind: { readonly type: "add" | "delete" | "update" }
  readonly diff: string | null
}

const changesOf = (f: ToolCallFields): ReadonlyArray<Change> => {
  const diffs = (f.content ?? []).flatMap((c): ReadonlyArray<Change> => {
    if (!isRecord(c) || c["type"] !== "diff") return []
    const path = str(c, "path")
    if (path === null) return []
    const before = str(c, "oldText")
    const after = str(c, "newText") ?? ""
    const type = before === null ? "add" : f.kind === "delete" && after === "" ? "delete" : "update"
    return [{ path, kind: { type }, diff: unifiedDiff(before, after) }]
  })
  if (diffs.length > 0) return diffs
  return (f.locations ?? []).flatMap((l): ReadonlyArray<Change> => {
    const path = str(l, "path")
    return path === null ? [] : [{ path, kind: { type: f.kind === "delete" ? "delete" : "update" }, diff: null }]
  })
}

/** The board's own MCP server, which a call of one of its tools is on when the agent doesn't say. */
const BOARD = BOARD_SERVER_NAMES[0] ?? "huntaway"

/** An MCP server's tool call. */
interface Mcp {
  readonly server: string
  readonly tool: string
  readonly args: Readonly<Record<string, unknown>>
}

/**
 * An MCP server's tool call: its server, tool and arguments, if it is one. Antigravity marks them
 * `_meta.is_mcp_tool_call`, titles them `Running <tool>` (`Run <tool>?` when it asks), and has
 * `rawInput: {server, tool, arguments}`; other agents title them `mcp__<server>__<tool>`. A call of one of the board's
 * tools on a server it doesn't name is the board's.
 */
const mcpOf = (f: ToolCallFields): Mcp | null => {
  const raw = isRecord(f.rawInput) ? f.rawInput : undefined
  const title = (f.title ?? "")
    .trim()
    .replace(/^(?:Running|Run|Calling|Call)\s+/u, "")
    .replace(/\?$/u, "")
    .trim()
  const prefixed = /^mcp__(.+?)__(.+)$/u.exec(title)
  if (prefixed !== null) return { server: prefixed[1] ?? "", tool: prefixed[2] ?? "", args: raw ?? {} }
  const m = meta(f)
  if (!isRecord(m) || m["is_mcp_tool_call"] !== true) return null
  const rawServer = firstStr(raw, ["server", "server_name", "serverName"])
  const rawTool = firstStr(raw, ["tool", "tool_name", "toolName"])
  // Antigravity's wrapper: the call's own arguments are inside it.
  const wrapped = (rawServer !== null || rawTool !== null) && raw !== undefined
  const inner = wrapped ? raw["arguments"] : undefined
  const args = wrapped ? (isRecord(inner) ? inner : {}) : (raw ?? {})
  const split = /^([\w-]+)\s*[./:]\s*([\w-]+)$/u.exec(title)
  const bare = /^([A-Za-z0-9_]+)(?::\s*\{.*)?$/su.exec(title)?.[1]
  const tool = rawTool ?? firstStr(m, ["tool_name", "toolName", "tool"]) ?? split?.[2] ?? bare ?? (title === "" ? "tool" : title)
  const server = rawServer ?? firstStr(m, ["server_name", "serverName", "mcp_server", "server"]) ?? split?.[1] ?? (BOARD_TOOLS.includes(tool) ? BOARD : "mcp")
  return { server: server.trim(), tool: tool.trim(), args }
}

const typeOf = (f: ToolCallFields): ItemType => {
  if (mcpOf(f) !== null) return "mcpToolCall"
  if (f.kind === "execute" || ((f.kind === undefined || f.kind === null) && commandOf(f, false) !== null)) return "commandExecution"
  if ((f.content ?? []).some((c) => isRecord(c) && c["type"] === "diff") || ["edit", "delete", "move"].includes(f.kind ?? "")) return "fileChange"
  return "dynamicToolCall"
}

/** Whether a call says enough to be shown: a command its command, an edit its changes. */
const ready = (f: ToolCallFields, type: ItemType): boolean =>
  type === "commandExecution" ? commandOf(f, true) !== null : type === "fileChange" ? changesOf(f).length > 0 : true

/** What a call's result says, as text: its text content, else Antigravity's output keys, else its raw output. */
const outputOf = (f: ToolCallFields): string => {
  const texts = (f.content ?? []).flatMap((c) => {
    if (!isRecord(c) || c["type"] !== "content") return []
    const t = blockText(c["content"])
    return t === "" ? [] : [t]
  })
  if (texts.length > 0) return texts.join("\n")
  const raw = f.rawOutput
  if (raw === undefined || raw === null) return ""
  if (typeof raw === "string") return raw
  const known = firstStr(raw, ["combinedOutput", "combined_output", "output", "stdout", "result", "text"])
  if (known !== null) return known
  return jsonText(raw)
}

const statusOf = (tool: Tool): string => {
  const s = tool.fields.status
  if (s === "completed") return "completed"
  if (s === "failed") return tool.rejected ? "declined" : "failed"
  return tool.rejected && tool.done ? "declined" : "inProgress"
}

const argumentsOf = (f: ToolCallFields): Readonly<Record<string, unknown>> => {
  const raw = f.rawInput
  const paths = (f.locations ?? []).flatMap((l) => {
    const p = str(l, "path")
    return p === null ? [] : [p]
  })
  return {
    ...(f.title === undefined || f.title === null ? {} : { title: f.title }),
    ...(isRecord(raw) ? raw : raw === undefined || raw === null ? {} : { input: raw }),
    ...(paths.length > 0 ? { paths } : {}),
  }
}

/** The Codex item a tool call is, as far as it has gone. */
const codexItem = (tool: Tool): Readonly<Record<string, unknown>> => {
  const f = tool.fields
  const type = tool.type ?? typeOf(f)
  const status = statusOf(tool)
  const finished = status !== "inProgress"
  const base = { id: tool.itemId, status }
  if (type === "commandExecution") {
    const exit = int(f.rawOutput, ["exitCode", "exit_code"])
    return {
      type,
      ...base,
      command: commandOf(f, true) ?? "",
      cwd: firstStr(f.rawInput, CWD_KEYS) ?? firstStr(f.rawOutput, ["workingDir", "working_dir"]),
      ...(finished ? { aggregatedOutput: outputOf(f), exitCode: exit } : {}),
    }
  }
  if (type === "fileChange") return { type, ...base, changes: changesOf(f) }
  if (type === "mcpToolCall") {
    const mcp = mcpOf(f) ?? { server: "mcp", tool: "tool", args: {} }
    const text = outputOf(f)
    return {
      type,
      ...base,
      server: mcp.server,
      tool: mcp.tool,
      arguments: mcp.args,
      ...(finished
        ? status === "completed"
          ? { result: { content: [{ type: "text", text }] }, error: null }
          : { result: null, error: { message: text !== "" ? text : status === "declined" ? "The call was declined." : "The call failed." } }
        : {}),
    }
  }
  const kind = f.kind ?? "other"
  const name = kind !== "other" ? kind : (f.title ?? "").trim() || "other"
  return {
    type,
    ...base,
    namespace: "acp",
    tool: name,
    arguments: argumentsOf(f),
    ...(finished ? { contentItems: [{ type: "inputText", text: outputOf(f) }], success: status === "completed" } : {}),
  }
}

/** Fields of an update over what was known: those it gives replace the earlier. */
const merged = (was: ToolCallFields, next: ToolCallFields): ToolCallFields => {
  const out: Record<string, unknown> = { ...was }
  for (const [k, v] of Object.entries(next)) if (v !== undefined && v !== null) out[k] = v
  return { ...was, ...out, toolCallId: was.toolCallId }
}

/** Antigravity's questions share the permission method; their tool calls aren't tools. */
export const isQuestion = (toolCallId: string): boolean => toolCallId.startsWith("interaction_")

/** A tool call's fields taken in; its item started (if it says enough, or `force`) or completed as they say. */
const onTool = (state: AcpState, fields: ToolCallFields, force: boolean): Step => {
  if (isQuestion(fields.toolCallId)) return { state, lines: [] }
  const closed = closeText(state)
  let s = closed.state
  const lines: Array<Line> = [...closed.lines]
  const was = s.tools.get(fields.toolCallId)
  if (was?.done === true) return { state: s, lines }
  const f = was === undefined ? fields : merged(was.fields, fields)
  const finished = f.status === "completed" || f.status === "failed"
  let tool: Tool =
    was === undefined
      ? { itemId: `${s.seed}:tool:${fields.toolCallId}`, fields: f, type: null, started: false, done: false, rejected: false }
      : { ...was, fields: f }
  if (!tool.started && (force || finished || ready(f, typeOf(f)))) {
    tool = { ...tool, type: typeOf(f), started: true }
    lines.push(itemLine(s, "item/started", codexItem(tool)))
  }
  if (finished && tool.started) {
    tool = { ...tool, done: true }
    lines.push(itemLine(s, "item/completed", codexItem(tool)))
  }
  s = { ...s, tools: new Map([...s.tools, [fields.toolCallId, tool]]) }
  return { state: s, lines }
}

// ---------- the turn ----------

/** A turn starts (a `session/prompt` is sent). */
export const startTurn = (state: AcpState): Step => {
  // Text the agent sent after the last turn's end is completed before this one starts.
  const closed = closeText(state)
  const n = closed.state.turns + 1
  const s: AcpState = { ...closed.state, turns: n, turnId: `${state.seed}:turn:${n}`, tools: new Map(), text: null }
  return {
    state: s,
    lines: [...closed.lines, { method: "turn/started", params: { threadId: s.threadId, turn: { id: s.turnId, status: "inProgress", items: [] } } }],
  }
}

/** The text item being streamed, completed: when the adapter is done, for text the agent sent after its last turn ended. */
export const settle = (state: AcpState): Step => closeText(state)

const PLAN_STATUS: Readonly<Record<string, string>> = { pending: "pending", in_progress: "inProgress", completed: "completed" }

const usageLine = (state: AcpState, last: Tokens): Line => ({
  method: "thread/tokenUsage/updated",
  params: params(state, { tokenUsage: { total: state.total, last, ...(state.context === null ? {} : { modelContextWindow: state.context.size }) } }),
})

/** One `session/update` of the session's. */
export const update = (state: AcpState, u: SessionUpdate): Step => {
  switch (u._tag) {
    case "AgentMessage":
      return chunk(state, "agentMessage", u.text)
    case "AgentThought":
      return chunk(state, "reasoning", u.text)
    case "ToolCall":
    case "ToolCallUpdate":
      return onTool(state, u.fields, false)
    case "Plan": {
      const closed = closeText(state)
      const plan = u.entries.map((e) => ({ step: str(e, "content") ?? "", status: PLAN_STATUS[str(e, "status") ?? ""] ?? "pending" }))
      return { state: closed.state, lines: [...closed.lines, { method: "turn/plan/updated", params: params(closed.state, { plan }) }] }
    }
    case "Usage": {
      // The context's size, for the context meter; no tokens of the run's (the prompt's usage counts those).
      const s: AcpState = { ...state, context: { used: u.used, size: u.size } }
      return { state: s, lines: [usageLine(s, { ...zero, totalTokens: u.used })] }
    }
    // Only a `session/load`'s history has the user's messages, and the adapter drops that.
    case "UserMessage":
    case "Other":
      break
  }
  return { state, lines: [] }
}

/** How a turn ended: the prompt's answer, or its failure (an error, or the agent gone). */
export type TurnEnd =
  | { readonly _tag: "Stopped"; readonly stopReason: string; readonly usage: PromptUsage | null }
  | { readonly _tag: "Failed"; readonly message: string }

const STOPPED: Readonly<Record<string, string>> = {
  max_tokens: "The agent stopped: it reached its token limit.",
  max_turn_requests: "The agent stopped: it reached its limit of requests in a turn.",
  refusal: "The agent refused to go on.",
}

/** A turn's tokens, as Codex counts them: its input with the cached tokens (ACP's agents differ on whether theirs are). */
export const turnTokens = (u: PromptUsage): Tokens => {
  const input = u.inputTokens ?? 0
  const cached = u.cachedReadTokens ?? 0
  const output = u.outputTokens ?? 0
  const total = u.totalTokens ?? input + cached + output
  // A total that has the cached tokens on top of the input's says the input hasn't them.
  const separate = total >= input + cached + output
  return {
    inputTokens: separate ? input + cached : input,
    cachedInputTokens: cached,
    outputTokens: output,
    reasoningOutputTokens: u.thoughtTokens ?? 0,
    totalTokens: total,
  }
}

const plus = (a: Tokens, b: Tokens): Tokens => ({
  inputTokens: a.inputTokens + b.inputTokens,
  cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  reasoningOutputTokens: a.reasoningOutputTokens + b.reasoningOutputTokens,
  totalTokens: a.totalTokens + b.totalTokens,
})

/** The turn ended: its text completed, its refused calls declined, its tokens, and `turn/completed`. */
export const endTurn = (state: AcpState, end: TurnEnd): Step => {
  if (state.turnId === null) return { state, lines: [] }
  const closed = closeText(state)
  let s = closed.state
  const lines: Array<Line> = [...closed.lines]
  for (const tool of s.tools.values()) {
    if (tool.rejected && tool.started && !tool.done) lines.push(itemLine(s, "item/completed", codexItem({ ...tool, done: true })))
  }
  if (end._tag === "Stopped" && end.usage !== null) {
    const turn = turnTokens(end.usage)
    s = { ...s, total: plus(s.total, turn) }
    // The context's size is what the meter shows: the latest `usage_update`'s, else the turn's total.
    lines.push(usageLine(s, { ...turn, totalTokens: s.context?.used ?? turn.totalTokens }))
  }
  const status = end._tag === "Failed" ? "failed" : end.stopReason === "end_turn" ? "completed" : end.stopReason === "cancelled" ? "interrupted" : "failed"
  const message = end._tag === "Failed" ? end.message : (STOPPED[end.stopReason] ?? `The agent stopped (${end.stopReason}).`)
  lines.push({
    method: "turn/completed",
    params: { threadId: s.threadId, turn: { id: s.turnId, status, items: [], error: status === "failed" ? { message } : null } },
  })
  return { state: { ...s, turnId: null, tools: new Map() }, lines }
}

// ---------- permissions ----------

/** A permission request the board (or the adapter) is to answer: its id on the output, and what answering it needs. */
export interface Pending {
  readonly id: number
  /** The agent's JSON-RPC id for it. */
  readonly acpId: unknown
  readonly toolCallId: string
  readonly options: ReadonlyArray<PermissionOption>
  readonly question: boolean
}

/** The question id an Antigravity question is asked under. */
export const QUESTION_ID = "answer"

/** `session/request_permission`: the request line for the board (and the item it's about, started if it wasn't). */
export const askPermission = (state: AcpState, acpId: unknown, req: PermissionRequest): Step & { readonly pending: Pending } => {
  const id = state.requests + 1
  const call = req.toolCall
  const pending: Pending = { id, acpId, toolCallId: call.toolCallId, options: req.options, question: isQuestion(call.toolCallId) }
  if (pending.question) {
    const question = {
      id: QUESTION_ID,
      header: "Question",
      question: (call.title ?? "").trim() || "Choose an option.",
      isOther: false,
      isSecret: false,
      options: req.options.map((o) => ({ label: (o.name ?? "").trim() || o.optionId })),
    }
    const s = { ...state, requests: id }
    return {
      state: s,
      pending,
      lines: [{ id, method: "item/tool/requestUserInput", params: params(s, { itemId: `${s.seed}:q:${call.toolCallId}`, questions: [question] }) }],
    }
  }
  const step = onTool({ ...state, requests: id }, call, true)
  const tool = step.state.tools.get(call.toolCallId)
  if (tool === undefined) return { ...step, pending }
  const item = codexItem(tool)
  const title = (tool.fields.title ?? "").trim()
  let line: Line
  switch (tool.type) {
    case "commandExecution": {
      const command = commandOf(tool.fields, true) ?? ""
      line = {
        id,
        method: "item/commandExecution/requestApproval",
        params: params(step.state, {
          itemId: tool.itemId,
          command,
          cwd: item["cwd"] ?? null,
          ...(title === "" || title === command || title === `\`${command}\`` ? {} : { reason: title }),
        }),
        item,
      }
      break
    }
    case "fileChange":
      line = {
        id,
        method: "item/fileChange/requestApproval",
        params: params(step.state, { itemId: tool.itemId, ...(title === "" ? {} : { reason: title }) }),
        item,
      }
      break
    case "mcpToolCall":
    case "dynamicToolCall":
    case null: {
      const use = toolUse(item)
      line = {
        id,
        method: "acp/requestPermission",
        params: params(step.state, {
          itemId: tool.itemId,
          tool: use?.[0] ?? "tool",
          title: title === "" ? (use?.[0] ?? "tool") : title,
          input: use?.[1] ?? {},
        }),
        item,
      }
    }
  }
  return { state: step.state, pending, lines: [...step.lines, line] }
}

/** The agent's answer to a permission request: an option it offered, or cancelled. */
export type Outcome =
  | { readonly outcome: { readonly outcome: "selected"; readonly optionId: string } }
  | { readonly outcome: { readonly outcome: "cancelled" } }

export const cancelled: Outcome = { outcome: { outcome: "cancelled" } }

const pick = (options: ReadonlyArray<PermissionOption>, kinds: ReadonlyArray<string>): Outcome => {
  for (const k of kinds) {
    const o = options.find((x) => x.kind === k)
    if (o !== undefined) return { outcome: { outcome: "selected", optionId: o.optionId } }
  }
  return cancelled
}

/** A decision as the adapter takes it: from the board's answer, or its own (no board, a full-access mode). */
export type Decision = "allow" | "allowAlways" | "reject"

/** The option for a decision: `allow_once` (or `allow_always`), `reject_once` (or `reject_always`). */
export const outcomeFor = (pending: Pending, decision: Decision): Outcome =>
  decision === "reject"
    ? pick(pending.options, ["reject_once", "reject_always"])
    : decision === "allowAlways"
      ? pick(pending.options, ["allow_always", "allow_once"])
      : pick(pending.options, ["allow_once", "allow_always"])

/** The board's answer (a `codex_response`'s `result`, or its `error`) as the agent's outcome; a refusal marks the call declined. */
export const answerPermission = (
  state: AcpState,
  pending: Pending,
  answer: { readonly result?: unknown; readonly error?: unknown },
): { readonly state: AcpState; readonly outcome: Outcome } => {
  if (pending.question) {
    const answers = isRecord(answer.result) && isRecord(answer.result["answers"]) ? answer.result["answers"][QUESTION_ID] : undefined
    const list = isRecord(answers) && Array.isArray(answers["answers"]) ? answers["answers"] : []
    const chosen = list.find((a: unknown): a is string => typeof a === "string")
    const option = pending.options.find((o) => o.optionId === chosen) ?? pending.options.find((o) => ((o.name ?? "").trim() || o.optionId) === chosen)
    return { state, outcome: option === undefined ? cancelled : { outcome: { outcome: "selected", optionId: option.optionId } } }
  }
  const decision = str(answer.result, "decision")
  const d: Decision =
    answer.error === undefined && (decision === "accept" || decision === "acceptForSession") ? (decision === "accept" ? "allow" : "allowAlways") : "reject"
  return { state: d === "reject" ? rejected(state, pending.toolCallId) : state, outcome: outcomeFor(pending, d) }
}

/** The call's permission was refused: it ends declined. */
export const rejected = (state: AcpState, toolCallId: string): AcpState => {
  const tool = state.tools.get(toolCallId)
  return tool === undefined ? state : { ...state, tools: new Map([...state.tools, [toolCallId, { ...tool, rejected: true }]]) }
}

/** The board's request `pending` no longer needs answering (the turn was cancelled). */
export const resolvedLine = (state: AcpState, pending: Pending): Line => ({
  method: "serverRequest/resolved",
  params: { threadId: state.threadId, requestId: pending.id },
})
