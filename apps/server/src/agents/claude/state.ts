import type { Item, NewEvent, RequestResolution, SubagentState, ThreadMetadata, ThreadRequest, Timestamp, ToolKind, ToolStatus } from "@huntaway/contracts"
import { HashMap, Option } from "effect"
import type { ToolResultBlock } from "./lines.ts"
import { sameJson, str } from "./tools.ts"
import { ItemMeta } from "../../threads/model.ts"

// The Claude translator's state (docs/plan/07-agents.md, The two drivers): what it knows of a thread to place what the
// agent says next. It is immutable: `translate` returns a new state and leaves the one it was given as it was, so a caller
// whose write of the events failed keeps the state from before the line. Its maps are persistent (`HashMap`), so a step
// copies only what it changes. `Draft` is one step's working copy, with the events, metas, effects and warnings it makes.

/** What the board knows of an item that the item does not say: the thread store's (inventory 08 §3.3). */
export { ItemMeta }

/** A tool call so far. */
export interface Call {
  readonly item: string
  /** The agent's id for it (the item's, but for a second call with one id). */
  readonly callId: string
  readonly kind: ToolKind
  readonly status: ToolStatus
  readonly title: string | undefined
  readonly hasResult: boolean
  readonly subagent: SubagentState | undefined
  /** The model its input asks for (a subagent's). */
  readonly model: string | undefined
  /** The tool_use id of the subagent call it was made in, as its line said. */
  readonly parentRaw: string | null
  readonly session: string | undefined
  readonly input: unknown
  /** Its item's metadata (a subagent's description and prompt, as its task_started says them). */
  readonly metadata: ThreadMetadata | undefined
  readonly subagentTask: string | undefined
  readonly shownTasks: ReadonlyArray<string>
}

/** What a task_* line's `task_id` is about: a subagent's call, or a task another item shows (a Bash command's run). */
export type Job = { readonly agent: string } | "shown"

/** A tool result that came before its call: given to it when it comes. */
export interface EarlyResult {
  readonly writeNo: number
  readonly at: Timestamp
  readonly block: ToolResultBlock
  readonly meta: Readonly<Record<string, unknown>>
  readonly parentRaw: string | null
  readonly session: string | undefined
}

/** A prompt for a call id the thread has, none of whose calls asked it: it waits for one with its input. */
export interface WaitingPrompt {
  readonly request: string
  readonly input: unknown
  /** It is linked to the one call with the id for now. */
  readonly linked: boolean
}

export interface TranslatorState {
  /** The tool calls, by item id. */
  readonly calls: HashMap.HashMap<string, Call>
  /** The items of the calls with each tool_use id, in order. */
  readonly byCall: HashMap.HashMap<string, ReadonlyArray<string>>
  /** Claude's task ids (task_started) and what they are. */
  readonly jobs: HashMap.HashMap<string, Job>
  /** The thread's requests, as written (by the board). */
  readonly requests: HashMap.HashMap<string, ThreadRequest>
  /** By parent ("" for the main conversation), the latest item if it is a compaction, which a summary goes into. */
  readonly compaction: HashMap.HashMap<string, string>
  /** The session the agent's lines were last in. */
  readonly session: string | undefined
  /** What the main conversation's latest assistant message said since the turn started: what its result usually says again. */
  readonly lastText: string | null
  /** Results that came before their call, by its id. Held in memory only: `stateFromItems` has none. */
  readonly early: HashMap.HashMap<string, ReadonlyArray<EarlyResult>>
  /** Prompts waiting for a call with their id and input, by the id. Held in memory only, as `early`. */
  readonly waitingPrompts: HashMap.HashMap<string, ReadonlyArray<WaitingPrompt>>
}

/** A thread with nothing in it yet. */
export const emptyState: TranslatorState = {
  calls: HashMap.empty(),
  byCall: HashMap.empty(),
  jobs: HashMap.empty(),
  requests: HashMap.empty(),
  compaction: HashMap.empty(),
  session: undefined,
  lastText: null,
  early: HashMap.empty(),
  waitingPrompts: HashMap.empty(),
}

/** Why a line made less than it might have (the old translator's warning codes). Worth a debug log, nothing more. */
export interface TranslateWarning {
  readonly code: string
  readonly text: string
}

export const get = <V>(map: HashMap.HashMap<string, V>, key: string): V | undefined => Option.getOrUndefined(HashMap.get(map, key))

/** Whether two sessions can be the same one: they are, or one isn't known. */
export const sameSession = (a: string | undefined, b: string | undefined): boolean => a === undefined || b === undefined || a === b

/** A call's meta: what the board keeps of it beside its item. */
export const callMeta = (c: Call): ItemMeta => ({
  ...(c.callId !== c.item ? { call_id: c.callId } : {}),
  ...(c.session === undefined ? {} : { session: c.session }),
  ...(c.subagentTask === undefined ? {} : { subagent_task: c.subagentTask }),
  ...(c.shownTasks.length > 0 ? { shown_tasks: c.shownTasks } : {}),
})

/** One step's working copy of the state, and what the step makes. */
export class Draft {
  s: TranslatorState
  readonly events: Array<NewEvent> = []
  readonly metas = new Map<string, ItemMeta>()
  readonly warnings: Array<TranslateWarning> = []

  constructor(state: TranslatorState) {
    this.s = state
  }

  warn(code: string, text: string): void {
    this.warnings.push({ code, text })
  }

  /** Item `item` is added at the end: it is the latest of its conversation, a compaction or not. */
  noteItem(item: Item): void {
    const parent = item.parent_id ?? ""
    this.s = { ...this.s, compaction: item.type === "compaction" ? HashMap.set(this.s.compaction, parent, item.id) : HashMap.remove(this.s.compaction, parent) }
  }

  add(item: Item): void {
    this.noteItem(item)
    this.events.push({ type: "item.added", item })
  }

  update(id: string, patch: Readonly<Record<string, unknown>>): void {
    this.events.push({ type: "item.updated", item_id: id, patch })
  }

  setMeta(id: string, meta: ItemMeta): void {
    if (Object.keys(meta).length > 0) this.metas.set(id, meta)
  }

  /** Opens `request`, or replaces the one with its id in place. */
  open(request: ThreadRequest): void {
    this.s = { ...this.s, requests: HashMap.set(this.s.requests, request.id, request) }
    this.events.push({ type: "request.opened", request })
  }

  call(item: string): Call | undefined {
    return get(this.s.calls, item)
  }

  callsWith(callId: string): ReadonlyArray<Call> {
    return (get(this.s.byCall, callId) ?? []).flatMap((id) => {
      const c = this.call(id)
      return c === undefined ? [] : [c]
    })
  }

  /** Call `c` as it is now, added if it is new. Its meta is the step's if it changed. */
  putCall(c: Call): void {
    const was = this.call(c.item)
    const byCall = was === undefined ? HashMap.set(this.s.byCall, c.callId, [...(get(this.s.byCall, c.callId) ?? []), c.item]) : this.s.byCall
    this.s = { ...this.s, calls: HashMap.set(this.s.calls, c.item, c), byCall }
    const meta = callMeta(c)
    if (!sameJson(was === undefined ? {} : callMeta(was), meta)) this.setMeta(c.item, meta)
  }

  setJob(task: string, job: Job): void {
    this.s = { ...this.s, jobs: HashMap.set(this.s.jobs, task, job) }
  }

  /** Whether the call's prompt was denied (or its plan sent back), so its error result is a denial. */
  denied(item: string): boolean {
    for (const r of HashMap.values(this.s.requests)) if (r.tool_call_id === item && r.type !== "question" && r.resolution?.outcome === "deny") return true
    return false
  }

  /** The item of the call that made the subagent `c` is in, for a request's `parent_id`. */
  parentOf(c: Call): string | undefined {
    if (c.parentRaw === null) return undefined
    return this.callsWith(c.parentRaw).find((x) => sameSession(x.session, c.session))?.item ?? c.parentRaw
  }
}

// ---------- what the board writes, and rebuilding from the store ----------

/** What a stored item and its meta say of the state (`stateFromItems`, and the board's own items as they are written). */
const know = (d: Draft, item: Item, meta: ItemMeta | undefined): void => {
  d.noteItem(item)
  if (item.type === "user_message") d.s = { ...d.s, lastText: null }
  if (item.type !== "tool_call") return
  const parent = item.parent_id === undefined ? undefined : d.call(item.parent_id)
  const c: Call = {
    item: item.id,
    callId: meta?.call_id ?? item.id,
    kind: item.kind,
    status: item.status,
    title: item.title,
    hasResult: item.result !== undefined,
    subagent: item.subagent,
    model: str(item.input, "model"),
    parentRaw: parent === undefined ? (item.parent_id ?? null) : parent.callId,
    session: meta?.session,
    input: item.input,
    metadata: item.metadata,
    subagentTask: meta?.subagent_task,
    shownTasks: meta?.shown_tasks ?? [],
  }
  d.putCall(c)
  if (meta?.session !== undefined) d.s = { ...d.s, session: meta.session }
  if (meta?.subagent_task !== undefined) d.setJob(meta.subagent_task, { agent: item.id })
  for (const job of meta?.shown_tasks ?? []) d.setJob(job, "shown")
}

const resolved = (d: Draft, id: string, resolution: RequestResolution): void => {
  const r = get(d.s.requests, id)
  if (r !== undefined) d.s = { ...d.s, requests: HashMap.set(d.s.requests, id, { ...r, resolution }) }
}

/**
 * The state after events the board wrote into the thread itself (`Threads.userMessage`, `notice`, `openRequest`,
 * `resolveRequest`): a user message starts what a turn says afresh, any item ends a compaction's claim to the summary,
 * and requests are what links prompts to calls and makes a denied call's error a denial.
 */
export const observe = (state: TranslatorState, events: ReadonlyArray<NewEvent>, metas: ReadonlyMap<string, ItemMeta> = new Map()): TranslatorState => {
  const d = new Draft(state)
  for (const e of events) {
    if (e.type === "item.added") know(d, e.item, metas.get(e.item.id))
    else if (e.type === "request.opened") d.s = { ...d.s, requests: HashMap.set(d.s.requests, e.request.id, e.request) }
    else if (e.type === "request.resolved") resolved(d, e.request_id, e.resolution)
  }
  return d.s
}

/** The `legacy:<n>` write number an item id carries. */
const writeOf = (id: string): number | undefined => {
  const m = /^legacy:(\d+)/.exec(id)
  return m === null ? undefined : Number(m[1])
}

/**
 * The state that goes on from a thread's stored items (in order), requests and metas: the old `Translator.from`. What a
 * live state held for lines that had not found their call yet (results and prompts that came before it) is not in the
 * store, so a rebuilt state does not have it.
 */
export const stateFromItems = (
  items: ReadonlyArray<Item>,
  requests: ReadonlyArray<ThreadRequest>,
  meta: (id: string) => ItemMeta | undefined,
): TranslatorState => {
  const d = new Draft({ ...emptyState, requests: HashMap.fromIterable(requests.map((r) => [r.id, r] as const)) })
  for (const item of items) know(d, item, meta(item.id))
  // What the latest turn has said so far: its latest main assistant message with text, all of that message's blocks.
  let lastText: string | null = null
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]
    if (item === undefined || item.type === "user_message" || item.type === "turn_result") break
    if (item.type !== "assistant_message" || item.parent_id !== undefined) continue
    const write = writeOf(item.id)
    const texts: Array<string> = []
    for (let j = i; j >= 0; j--) {
      const it = items[j]
      if (it === undefined || it.type === "user_message" || it.type === "turn_result") break
      if (it.type === "assistant_message" && it.parent_id === undefined && write !== undefined && writeOf(it.id) === write) texts.unshift(it.text)
    }
    lastText = texts.length > 0 ? texts.join("\n") : item.text
    break
  }
  return { ...d.s, lastText }
}
