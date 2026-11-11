import type { Item, NewEvent, SubagentState, SubagentStatus, Timestamp, ToolCall, ToolStatus, TurnResult } from "@huntaway/contracts"
import { HashMap, HashSet, Option, Predicate } from "effect"
import type { ItemMeta } from "../../threads/model.ts"
import { BOARD_SERVER_NAMES } from "@huntaway/shared"
import { RESULT_MAX_BYTES, sameJson, toolFields, truncate } from "../claude/tools.ts"
import { field, ownThread, shownAtStart, strField, subagentId, toolOutput, toolUse } from "./items.ts"
import type { CodexLine } from "./lines.ts"

// A Codex run's output to thread events (docs/plan/07-agents.md, The two drivers; inventory 08, section 3.6): the old
// `agent/codex/driver.ts`'s `map`, with the thread-side parts of its `handle` and of `output.ts`' `finish_turn`, as a pure
// function of the translator's state and one decoded line. Each app-server notification is mapped straight onto the
// thread's items, shaped as the board's Claude items are, so the thread view, the readers and the tools' names are the
// same for both agents: tool calls have the board's names (Bash, ApplyPatch, `mcp__<server>__<tool>`, WebSearch and
// WebFetch, Read, TodoWrite) with their normalized fields and Codex's ids; a subagent (a child thread) is an Agent call,
// `codex-agent-<thread id>`, which its items have as their parent; the agent's messages, reasoning and compactions are
// items with Codex's ids; a turn's end is a `turn_result` item, `legacy:<write no>`, as a Claude result makes. What a line
// tells the run (its session, a turn starting or ending, the reply being written, a subagent's end, rate limits…) is a
// `CodexEffect` for the caller to apply.
//
// The state is what the old driver read of the stored thread through its View: the tool calls (in full, with their
// place), and the ids of the other items, so that a notification read again (its offset wasn't saved) changes nothing
// more, and a turn's end cancels the main conversation's calls it left open, in thread order. It is immutable (persistent
// maps): a caller whose write failed keeps the state from before the line. What the board writes itself (the user's
// messages, requests) is taken in with `observe`; a restarted server rebuilds it with `stateFromItems`.

/** A tool call the thread has, and its place in the thread. */
interface Placed {
  readonly call: ToolCall
  readonly pos: number
}

export interface CodexState {
  /** The thread's tool calls, by id. */
  readonly calls: HashMap.HashMap<string, Placed>
  /** The ids of its other items. */
  readonly others: HashSet.HashSet<string>
  /** The next item's place. */
  readonly next: number
}

/** A thread with nothing in it yet. */
export const emptyState: CodexState = { calls: HashMap.empty(), others: HashSet.empty(), next: 0 }

/** What the caller knows of a line that the line does not say. */
export interface CodexLineContext {
  /** The task's Codex session: its main thread's id. Notifications from other threads are its subagents'. */
  readonly session: string | null
  /** The run is a compaction (`/compact`). */
  readonly compact: boolean
  /** When the line was read: its items' `created_at`, and when a subagent ended. */
  readonly at: Timestamp
  /** The board's write number for the line: a turn's end is `legacy:<writeNo>` (see `numbered`). */
  readonly writeNo: number
  /** A stop was asked for (`runs.stop` is `requested`): the turn it cuts short ends interrupted. */
  readonly stopping: boolean
  /** The run has seen a turn's end: a compaction's second report of its end (`thread/compacted`) is not another. */
  readonly sawResult: boolean
}

/** What a line tells the run, for the caller to apply. */
export type CodexEffect =
  /** A main thread started (`thread/started`, not a child's) that isn't the task's session yet: the task's and the run's session. */
  | { readonly _tag: "SessionStarted"; readonly sessionId: string }
  /** The main thread's turn started: where a rewind takes the thread back to (`runs.agent_at`). */
  | { readonly _tag: "TurnStarted"; readonly turnId: string }
  /**
   * The main thread's turn ended (`turn/completed`, or `thread/compacted` for a compaction): `error` is the run's
   * `result_error` (null if it went well), `interrupted` a stop cut it short, `usageLimit` refused for the usage limit.
   */
  | { readonly _tag: "TurnEnded"; readonly error: string | null; readonly interrupted: boolean; readonly usageLimit: boolean }
  /** The reply being written starts again (a turn or an agent message starts or ends). */
  | { readonly _tag: "PreviewReset" }
  /** Text streamed for the reply being written (`Threads.preview`): never stored. */
  | { readonly _tag: "PreviewText"; readonly text: string }
  /** The main thread started a tool call that isn't the board's `wait`, or a collab call: the run's wait ends. */
  | { readonly _tag: "Working" }
  /** A subagent (its Agent call `id`) ended, or is running again: for the wait tool. */
  | { readonly _tag: "SubagentEnded"; readonly id: string; readonly status: SubagentStatus; readonly summary: string | null }
  /** A warning for the thread (`Threads.notice`, level `warning`). */
  | { readonly _tag: "Notice"; readonly text: string; readonly detail: string | null }
  /** The account's rate limits (`account/rateLimits/updated`'s `rateLimits`), for the config's usage. */
  | { readonly _tag: "RateLimits"; readonly rateLimits: unknown }
  /** The thread's token usage (`thread/tokenUsage/updated`'s params), for the context meter. */
  | { readonly _tag: "TokenUsage"; readonly params: unknown }
  /** The main conversation was compacted, for the context meter. */
  | { readonly _tag: "Compacted"; readonly trigger: "manual" | "auto" }
  /** A tool call finished: it may have changed the task's documents. */
  | { readonly _tag: "ToolDone" }
  /** The model took in a message the run sent (its id). */
  | { readonly _tag: "Echoed"; readonly uuid: string }
  /** A new thread wouldn't take the board's tools as dynamic tools: its session has the board's MCP server instead. */
  | { readonly _tag: "BoardToolsRefused" }

export interface TranslateWarning {
  readonly code: string
  readonly text: string
}

/** What one line made. */
export interface Translated {
  readonly state: CodexState
  /** To append to the thread, in order. */
  readonly events: ReadonlyArray<NewEvent>
  /** The items whose meta the line set. */
  readonly metas: ReadonlyMap<string, ItemMeta>
  readonly effects: ReadonlyArray<CodexEffect>
  readonly warnings: ReadonlyArray<TranslateWarning>
}

/** How long a subagent's description is, from its prompt. */
const DESCRIPTION_MAX = 200

const isRecord = (v: unknown): v is Readonly<Record<string, unknown>> => Predicate.isObject(v) && !Array.isArray(v)
/** A string that isn't empty, as the translator reads one. */
const textOf = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined)
const has = (v: unknown, key: string): boolean => isRecord(v) && key in v

// ---------- the state ----------

/** An item added (or replacing the one with its id), or a patch to a call. */
const apply = (s: CodexState, e: NewEvent): CodexState => {
  if (e.type === "item.added") {
    const item = e.item
    const was = Option.getOrUndefined(HashMap.get(s.calls, item.id))
    const known = was !== undefined || HashSet.has(s.others, item.id)
    const pos = was?.pos ?? s.next
    const next = known ? s.next : s.next + 1
    if (item.type === "tool_call") return { calls: HashMap.set(s.calls, item.id, { call: item, pos }), others: HashSet.remove(s.others, item.id), next }
    return { calls: HashMap.remove(s.calls, item.id), others: HashSet.add(s.others, item.id), next }
  }
  if (e.type === "item.updated") {
    const was = Option.getOrUndefined(HashMap.get(s.calls, e.item_id))
    if (was === undefined) return s
    return { ...s, calls: HashMap.set(s.calls, e.item_id, { call: patchedCall(was.call, e.patch), pos: was.pos }) }
  }
  return s
}

/** A call with `patch`'s fields set, and those set to null removed. */
const patchedCall = (call: ToolCall, patch: Readonly<Record<string, unknown>>): ToolCall => {
  const next: Record<string, unknown> = { ...call }
  for (const [k, v] of Object.entries(patch)) {
    if (k === "id" || k === "type") continue
    if (v === null) Reflect.deleteProperty(next, k)
    else next[k] = v
  }
  return { ...call, ...next, id: call.id, type: "tool_call" }
}

/** The state after events written to the thread (the board's own, or a line's). */
export const observe = (state: CodexState, events: ReadonlyArray<NewEvent>): CodexState => events.reduce(apply, state)

/** The state that goes on from a thread's stored items, in order (a restarted server's). */
export const stateFromItems = (items: ReadonlyArray<Item>): CodexState =>
  observe(
    emptyState,
    items.map((item): NewEvent => ({ type: "item.added", item })),
  )

/** The main conversation's tool calls that have no result yet, in thread order (a turn's end cancels them). */
const openCalls = (s: CodexState): ReadonlyArray<string> =>
  [...HashMap.values(s.calls)]
    .filter((p) => p.call.parent_id === undefined && (p.call.status === "running" || p.call.status === "pending") && p.call.kind !== "subagent")
    .toSorted((a, b) => a.pos - b.pos)
    .map((p) => p.call.id)

// ---------- one line ----------

/** One line's working copy of the state and what it makes. */
class Out {
  s: CodexState
  readonly ctx: CodexLineContext
  readonly events: Array<NewEvent> = []
  readonly metas = new Map<string, ItemMeta>()
  readonly effects: Array<CodexEffect> = []
  readonly warnings: Array<TranslateWarning> = []

  constructor(state: CodexState, ctx: CodexLineContext) {
    this.s = state
    this.ctx = ctx
  }

  private push(e: NewEvent): void {
    this.events.push(e)
    this.s = apply(this.s, e)
  }

  has(id: string): boolean {
    return HashMap.has(this.s.calls, id) || HashSet.has(this.s.others, id)
  }

  call(id: string): ToolCall | undefined {
    return Option.getOrUndefined(HashMap.get(this.s.calls, id))?.call
  }

  add(item: Item): void {
    this.push({ type: "item.added", item })
  }

  /** Sets the fields of `patch` that would change on call `id`, if the thread has it. */
  update(id: string, patch: Readonly<Record<string, unknown>>): void {
    const it: Readonly<Record<string, unknown>> | undefined = this.call(id)
    if (it === undefined) return
    const changes = Object.entries(patch).filter(([k, v]) => k !== "id" && k !== "type" && (v === null ? k in it : !sameJson(it[k], v)))
    if (changes.length === 0) return
    this.push({ type: "item.updated", item_id: id, patch: Object.fromEntries(changes) })
  }
}

/** Whether `name` is the board's `wait` tool (`mcp__huntaway__wait`, or under one of its older names). */
const isWaitTool = (name: string): boolean => {
  if (!name.startsWith("mcp__") || !name.endsWith("__wait") || name.length < 11) return false
  return BOARD_SERVER_NAMES.includes(name.slice(5, name.length - 6))
}

/** The lines that may need the board's write number: those that may end a turn (its `turn_result` is `legacy:<n>`). */
export const numbered = (line: CodexLine): boolean => line._tag === "Notification" && (line.method === "turn/completed" || line.method === "thread/compacted")

/** What line `line` makes of the thread whose state is `state`, and the state after it. */
export const translate = (state: CodexState, line: CodexLine, ctx: CodexLineContext): Translated => {
  const out = new Out(state, ctx)
  switch (line._tag) {
    case "Echo":
      if (line.uuid !== null) out.effects.push({ _tag: "Echoed", uuid: line.uuid })
      break
    case "BoardTools":
      if (line.dynamic === false) out.effects.push({ _tag: "BoardToolsRefused" })
      break
    case "Notification":
      notification(out, line.method, line.params, line.emittedAtMs)
      break
    // Requests are answered and resolutions settled by the line handler; the model is the token counts'.
    case "Request":
    case "Resolved":
    case "Model":
      break
  }
  return { state: out.s, events: out.events, metas: out.metas, effects: out.effects, warnings: out.warnings }
}

const notification = (out: Out, method: string, p: unknown, emittedAtMs: number | null): void => {
  const ctx = out.ctx
  const own = ownThread(p, ctx.session)
  // What comes before its items.
  switch (method) {
    case "thread/started": {
      const thread = field(p, "thread")
      const id = strField(thread, "id")
      const src = field(thread, "source")
      const sub = has(src, "subAgent") || has(src, "subagent")
      const sender = strField(thread, "parentThreadId") ?? strField(field(subAgentOf(src), "thread_spawn"), "parent_thread_id")
      if (id !== null && sender === null && !sub && ctx.session !== id) out.effects.push({ _tag: "SessionStarted", sessionId: id })
      break
    }
    case "turn/started":
      if (own) {
        const turn = strField(field(p, "turn"), "id")
        if (turn !== null) out.effects.push({ _tag: "TurnStarted", turnId: turn })
        out.effects.push({ _tag: "PreviewReset" })
      }
      break
    case "item/agentMessage/delta": {
      const t = strField(p, "delta")
      if (own && t !== null) out.effects.push({ _tag: "PreviewText", text: t })
      return
    }
    case "item/started": {
      const item = field(p, "item")
      const kind = strField(item, "type") ?? ""
      // A tool call of its own thread means it's working again. Hosted subAgentActivity items are notifications, not
      // the parent calling a tool.
      const tu = toolUse(item)
      if (own && (kind === "collabAgentToolCall" || (tu !== null && !isWaitTool(tu[0])))) out.effects.push({ _tag: "Working" })
      if (kind === "agentMessage" && own) out.effects.push({ _tag: "PreviewReset" })
      break
    }
    case "item/completed": {
      const kind = strField(field(p, "item"), "type") ?? ""
      if ((kind === "agentMessage" || kind === "plan") && own) out.effects.push({ _tag: "PreviewReset" })
      break
    }
    case "error":
      if (field(p, "willRetry") === true) {
        out.effects.push({ _tag: "Notice", text: `Codex: ${strField(field(p, "error"), "message") ?? "error"} (retrying)`, detail: null })
      }
      return
    case "warning": {
      const m = strField(p, "message")
      if (m !== null) out.effects.push({ _tag: "Notice", text: `Codex: ${m}`, detail: null })
      return
    }
    case "mcpServer/startupStatus/updated":
      if (field(p, "status") === "failed") {
        out.effects.push({ _tag: "Notice", text: `MCP server ${strField(p, "name") ?? "?"} failed to start`, detail: strField(p, "error") })
      }
      return
    case "account/rateLimits/updated":
      out.effects.push({ _tag: "RateLimits", rateLimits: field(p, "rateLimits") })
      return
    case "thread/tokenUsage/updated":
      out.effects.push({ _tag: "TokenUsage", params: p })
      return
  }
  map(out, method, p, emittedAtMs)
  // What comes after its items.
  if (method === "item/completed") {
    const item = field(p, "item")
    const kind = strField(item, "type") ?? ""
    if (kind === "contextCompaction") {
      if (own) out.effects.push({ _tag: "Compacted", trigger: ctx.compact ? "manual" : "auto" })
    } else if (!["agentMessage", "plan", "reasoning"].includes(kind) && toolUse(item) !== null) {
      out.effects.push({ _tag: "ToolDone" })
    }
  } else if (method === "turn/completed" && own) {
    finishTurn(out, field(p, "turn"))
  } else if (method === "thread/compacted" && own && ctx.compact) {
    // `/compact` ends here when its turn isn't reported.
    finishTurn(out, { status: "completed" })
  }
}

/** A thread's `source.subAgent` (v2) or `source.subagent` (older). */
const subAgentOf = (src: unknown): unknown => (has(src, "subAgent") ? field(src, "subAgent") : field(src, "subagent"))

/** The old `map`: the notification's events in the thread. */
const map = (out: Out, method: string, p: unknown, emittedAtMs: number | null): void => {
  const ctx = out.ctx
  const own = ownThread(p, ctx.session)
  const threadId = strField(p, "threadId")
  const parent = threadId !== null && !own ? subagentId(threadId) : undefined
  switch (method) {
    case "thread/started": {
      const thread = field(p, "thread")
      const id = strField(thread, "id")
      if (id === null) break
      // v2 says subAgent; older notifications subagent.
      const src = field(thread, "source")
      const spawn = field(subAgentOf(src), "thread_spawn")
      const sender = strField(thread, "parentThreadId") ?? strField(spawn, "parent_thread_id")
      if (sender !== null) {
        const role = strField(thread, "agentRole") ?? strField(spawn, "agent_role")
        subagentStarted(out, id, sender, { prompt: field(thread, "preview"), description: field(thread, "agentNickname"), subagent_type: role })
      }
      break
    }
    case "turn/started":
      if (!own && threadId !== null) subagentStatus(out, threadId, "running", null)
      break
    case "item/started": {
      const item = field(p, "item")
      const kind = strField(item, "type") ?? ""
      if (!shownAtStart(kind) || (kind === "collabAgentToolCall" && field(item, "tool") === "spawnAgent")) break
      const id = strField(item, "id")
      const tu = toolUse(item)
      if (id !== null && tu !== null && !out.has(id)) addCall(out, id, tu[0], tu[1], parent)
      break
    }
    case "item/completed":
      completed(out, p, parent)
      break
    case "turn/plan/updated": {
      // The turn's plan, one call a turn (and thread), as its latest update has it.
      const steps = field(p, "plan")
      const todos = (Array.isArray(steps) ? steps : []).map((s: unknown) => {
        const st = field(s, "status")
        return { content: field(s, "step"), status: st === "inProgress" ? "in_progress" : st === "completed" ? "completed" : "pending" }
      })
      const turn = strField(p, "turnId") ?? (emittedAtMs !== null && Number.isInteger(emittedAtMs) ? String(emittedAtMs) : "")
      const id = `plan-${threadId ?? ""}-${turn}`
      const fields = toolFields("TodoWrite", { todos })
      if (out.has(id)) out.update(id, { input: fields.input, todos: fields.todos ?? [] })
      else addCall(out, id, "TodoWrite", { todos }, parent, { status: "completed", result: { content: "" } })
      break
    }
    case "turn/completed":
      if (!own) {
        if (threadId === null) break
        const turn = field(p, "turn")
        const st = field(turn, "status")
        const status: SubagentStatus = st === "completed" ? "completed" : st === "interrupted" ? "stopped" : "failed"
        subagentStatus(out, threadId, status, strField(field(turn, "error"), "message"))
      } else {
        // Codex never completes a call its turn's interruption cut short: it ends with the turn.
        for (const id of openCalls(out.s)) out.update(id, { status: "cancelled" })
      }
      break
    case "thread/status/changed":
      if (!own && field(field(p, "status"), "type") === "systemError" && threadId !== null) subagentStatus(out, threadId, "failed", null)
      break
    case "thread/closed":
      if (!own && threadId !== null) subagentStatus(out, threadId, "stopped", null)
      break
  }
}

/** A tool call, `id`, of tool `name` with `input`, running unless `extra` says. */
const addCall = (out: Out, id: string, name: string, input: unknown, parent: string | undefined, extra: Partial<ToolCall> = {}): void => {
  const call: ToolCall = {
    id,
    type: "tool_call",
    ...toolFields(name, input),
    status: "running",
    created_at: out.ctx.at,
    ...extra,
    ...(parent === undefined ? {} : { parent_id: parent }),
  }
  out.add(call)
}

/** An item that's written once, when it's complete: added, or (read again) left as it is. */
const put = (out: Out, item: Item): void => {
  if (!out.has(item.id)) out.add(item)
}

const completed = (out: Out, p: unknown, parent: string | undefined): void => {
  const item = field(p, "item")
  const kind = strField(item, "type") ?? ""
  const id = strField(item, "id") ?? ""
  subagentItem(out, p)
  const under = <T extends Item>(it: T): T => (parent === undefined ? it : { ...it, parent_id: parent })
  if (kind === "agentMessage" || kind === "plan") {
    const text = strField(item, "text")
    if (text !== null && text.trim() !== "") put(out, under({ id, type: "assistant_message", text, created_at: out.ctx.at }))
  } else if (kind === "reasoning") {
    const parts = (k: string): ReadonlyArray<string> => {
      const v = field(item, k)
      return Array.isArray(v) ? v.filter((x: unknown): x is string => typeof x === "string") : []
    }
    let text = parts("summary")
    if (text.length === 0) text = parts("content")
    const joined = text.join("\n\n")
    if (joined.trim() !== "") put(out, under({ id, type: "reasoning", text: joined, created_at: out.ctx.at }))
  } else if (kind === "contextCompaction") {
    put(out, under({ id, type: "compaction", trigger: out.ctx.compact ? "manual" : "auto", created_at: out.ctx.at }))
  } else {
    const tu = toolUse(item)
    if (tu === null) return
    if (!out.has(id)) addCall(out, id, tu[0], tu[1], parent)
    const [text, isError] = toolOutput(item)
    const content = truncate(text, RESULT_MAX_BYTES)
    const exit = field(item, "exitCode")
    const result = {
      content,
      ...(content !== text ? { truncated: true } : {}),
      ...(kind === "commandExecution" && typeof exit === "number" && Number.isInteger(exit) ? { exit_code: exit } : {}),
    }
    const status: ToolStatus = field(item, "status") === "declined" ? "denied" : isError ? "failed" : "completed"
    out.update(id, { status, result })
  }
}

/**
 * A subagent (child thread `thread`, spawned by thread `sender`) has started, with what's known of it: its Agent call,
 * the first time, and its details, which can come later than the call (thread/started and the spawn's completion race).
 * A call that's running in the background is done once it has started it.
 */
const subagentStarted = (
  out: Out,
  thread: string,
  sender: string | null,
  meta: { readonly prompt?: unknown; readonly description?: unknown; readonly model?: unknown; readonly subagent_type?: unknown },
): void => {
  const ctx = out.ctx
  if (thread === ctx.session) return
  const id = subagentId(thread)
  const parent = sender !== null && sender !== ctx.session ? subagentId(sender) : undefined
  const prompt = typeof meta.prompt === "string" ? meta.prompt : ""
  const description = truncate(prompt === "" ? (typeof meta.description === "string" ? meta.description : "") : prompt, DESCRIPTION_MAX)
  const had = out.call(id)
  if (had === undefined && out.has(id)) return
  const fresh = had === undefined
  const it: ToolCall = had ?? {
    id,
    type: "tool_call",
    ...toolFields("Agent", {
      description,
      prompt,
      model: meta.model ?? null,
      subagent_type: meta.subagent_type ?? null,
      run_in_background: true,
    }),
    status: "running",
    created_at: ctx.at,
    ...(parent === undefined ? {} : { parent_id: parent }),
  }
  const s: { -readonly [K in keyof SubagentState]: SubagentState[K] } = {
    ...(it.subagent ?? { status: "running" }),
    status: it.subagent?.status ?? "running",
    background: true,
  }
  const type = textOf(meta.subagent_type)
  if (type !== undefined) s.agent_type = type
  const model = textOf(meta.model) ?? textOf(field(it.input, "model"))
  if (model !== undefined) s.model = model
  // What the board shows as its description and prompt, as the latest says them.
  const said: Record<string, unknown> = { ...it.metadata }
  if (description !== "") said["description"] = description
  if (prompt !== "") said["prompt"] = prompt
  const patch: Record<string, unknown> = { subagent: s }
  if (Object.keys(said).length > 0) patch["metadata"] = said
  if (it.status === "running" && it.result === undefined) patch["status"] = "completed"
  if (fresh) {
    out.add(patchedCall(it, patch))
    // Codex's id for it, as the messages path's task_started gave it.
    out.metas.set(id, { subagent_task: thread })
  } else out.update(id, patch)
}

/**
 * Child thread `thread`'s subagent is running again, or has ended (`status`, with its report or error, `summary`). A
 * background subagent's report is kept; its end, the first time.
 */
const subagentStatus = (out: Out, thread: string, status: SubagentStatus, summary: string | null): void => {
  const id = subagentId(thread)
  const it = out.call(id)
  if (it === undefined) return
  if (status !== "running") out.effects.push({ _tag: "SubagentEnded", id, status, summary: summary === null ? null : truncate(summary, RESULT_MAX_BYTES) })
  const s = it.subagent
  if (s === undefined) return
  const next: { -readonly [K in keyof SubagentState]: SubagentState[K] } = { ...s }
  if (status === "running") {
    next.status = "running"
    delete next.summary
    delete next.ended_at
  } else {
    if (s.status === "running") {
      next.status = status
      next.ended_at ??= out.ctx.at
    }
    if (s.background === true && textOf(summary) !== undefined && summary !== null) next.summary = truncate(summary, RESULT_MAX_BYTES)
  }
  out.update(id, { subagent: next })
}

/** Codex's collab agent states, as subagents' statuses. */
const STATES: Readonly<Record<string, SubagentStatus>> = {
  pendingInit: "running",
  running: "running",
  completed: "completed",
  errored: "failed",
  notFound: "failed",
  shutdown: "stopped",
  interrupted: "stopped",
}

/**
 * Codex's collab tool calls (spawning, waiting on, messaging and closing a child thread) and its hosted
 * subAgentActivity items say how its children are getting on: each child is one Agent call.
 */
const subagentItem = (out: Out, p: unknown): void => {
  const session = out.ctx.session
  const item = field(p, "item")
  const sender = strField(item, "senderThreadId") ?? strField(p, "threadId")
  const type = field(item, "type")
  if (type === "subAgentActivity") {
    const thread = strField(item, "agentThreadId")
    if (thread === null || thread === session) return
    const kind = field(item, "kind")
    if (kind === "started") subagentStarted(out, thread, sender, { model: field(item, "model"), description: field(item, "agentPath") })
    const status: SubagentStatus | null = kind === "started" ? "running" : kind === "completed" ? "completed" : kind === "interrupted" ? "stopped" : null
    if (status !== null) subagentStatus(out, thread, status, null)
    return
  }
  if (type !== "collabAgentToolCall") return
  const tool = strField(item, "tool") ?? ""
  const listed = field(item, "receiverThreadIds")
  const receivers = (Array.isArray(listed) ? listed : []).filter((t: unknown): t is string => typeof t === "string" && t !== session)
  const failed = field(item, "status") === "failed"
  for (const thread of receivers) {
    if (tool === "spawnAgent" && !failed) subagentStarted(out, thread, sender, { prompt: field(item, "prompt"), model: field(item, "model") })
    if (!failed) {
      const status: SubagentStatus | null = ["resumeAgent", "sendInput", "followupTask"].includes(tool)
        ? "running"
        : ["closeAgent", "interruptAgent"].includes(tool)
          ? "stopped"
          : null
      if (status !== null) subagentStatus(out, thread, status, null)
    }
  }
  const states = field(item, "agentsStates")
  if (!isRecord(states)) return
  for (const thread of Object.keys(states).toSorted()) {
    if (thread === session) continue
    const st = states[thread]
    const status = STATES[strField(st, "status") ?? ""]
    if (status !== undefined) subagentStatus(out, thread, status, strField(st, "message"))
  }
}

/**
 * The main thread's turn ended (the old `finish_turn` and `record_result`'s result): the run's result, and the turn's
 * `turn_result` item, as a Claude result line saying the same would make. A compaction may report its end twice
 * (`turn/completed` and `thread/compacted`): the second is ignored.
 */
const finishTurn = (out: Out, turn: unknown): void => {
  const ctx = out.ctx
  if (ctx.compact && ctx.sawResult) return
  const status = strField(turn, "status") ?? "completed"
  const error =
    status === "completed"
      ? null
      : status === "interrupted"
        ? "The turn was interrupted"
        : (strField(field(turn, "error"), "message") ?? `the turn ended as ${status}`)
  const usageLimit = field(field(turn, "error"), "codexErrorInfo") === "usageLimitExceeded"
  const interrupted = ctx.stopping && error !== null
  out.effects.push({ _tag: "TurnEnded", error, interrupted, usageLimit })
  const ok = error === null
  const subtype = ok ? "success" : "error_during_execution"
  const text = textOf(error)
  const duration = field(turn, "durationMs")
  const durationMs = typeof duration === "number" && Number.isInteger(duration) && duration >= 0 ? duration : undefined
  const id = `legacy:${ctx.writeNo}`
  const item: TurnResult = {
    id,
    type: "turn_result",
    ok,
    created_at: ctx.at,
    ...(interrupted ? { interrupted: true } : {}),
    // An interrupted turn's result says nothing more than that.
    ...(!ok && (text !== undefined || !interrupted) ? { error: text ?? subtype } : {}),
    ...(durationMs === undefined ? {} : { duration_ms: durationMs }),
    metadata: { subtype, num_turns: ctx.compact ? 0 : 1, total_cost_usd: 0 },
  }
  out.add(item)
  const meta: ItemMeta = { ...(text === undefined ? {} : { result_text: text }), ...(ctx.compact ? { compact: true } : {}) }
  if (Object.keys(meta).length > 0) out.metas.set(id, meta)
}
