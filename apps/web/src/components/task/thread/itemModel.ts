// What a thread shows, built from its items (the old src/itemModel.ts): the adapter from the shared model (threads.ts,
// apps/server/src/threads/protocol.ts) onto the ThreadModel (threadModel.ts) that the thread's components draw. It draws
// a thread as the board drew it from its messages before threads moved onto items.
//
// What the items don't say, the board's `metadata` on them does (converter 4 on the server): an auto message, a turn's
// cost and turns, a compaction's tokens after, a request's stored prompt or question, and its message's id. An item
// that came from one message keeps that message's id in its key (`legacy:<id>[:<block>]` is `<id>[.<block>]`), so the
// rows that take a message id from them (rewinding, a prompt's "moved on") have it.
//
// A new snapshot rebuilds the model, but what it leaves as it was stays the same objects: apply_event keeps the
// identity of the items an event doesn't change, and what's made of each is kept by item (`made`).

import type { Item as ThreadItem, Snapshot, ThreadRequest, ToolCall } from "@huntaway/contracts"
import type { Subagent, SubagentStatus } from "./subagentView"
import { fieldsOf, listOf, numberOf, shown, stringOf, type Fields } from "./fields"
import {
  reuseItems,
  shallowEqual,
  type Call,
  type CompactMeta,
  type Item,
  type PromptData,
  type QuestionData,
  type QuestionOption,
  type ReportData,
  type ResultData,
  type ThreadModel,
  type ToolResult,
} from "./threadModel"

/** `legacy:<message id>[:<block>]`: the message an item came from, and the key of the row made of it. */
const LEGACY = /^legacy:(\d+)(?::(.+))?$/

/** The id of the message an item (or a board question's request) came from, if its id says. */
export function messageIdOf(id: string): number | undefined {
  const m = LEGACY.exec(id)
  return m ? Number(m[1]) : undefined
}

/** The key of the row made of an item: `<id>` or `<id>.<block>` for one that came from a message, else its id. */
export function keyOf(id: string): string {
  const m = LEGACY.exec(id)
  return m ? (m[2] !== undefined ? `${m[1]}.${m[2]}` : (m[1] ?? id)) : id
}

/** A tool call's tool's name as the harness gave it (an MCP tool's item has its server's name apart). */
export function toolName(t: { name: string; kind: string; server?: string | undefined }): string {
  if (t.kind === "mcp" && t.server) return `mcp__${t.server}__${t.name}`
  if (t.kind === "app") return `mcp__app__${t.name}`
  return t.name
}

/** What's made of each item and request, while it stays the same object: a cache of one kind of thing made. */
function cache<T>(): (of: object, make: () => T) => T {
  const made = new WeakMap<object, T>()
  return (of, make) => {
    const had = made.get(of)
    if (had !== undefined) return had
    const v = make()
    made.set(of, v)
    return v
  }
}
const onceCall = cache<Call>()
const onceResult = cache<ToolResult>()
const onceTurn = cache<ResultData>()
const onceCompact = cache<CompactMeta>()
const oncePrompt = cache<PromptData>()
const onceQuestion = cache<QuestionData>()
const onceReport = cache<ReportData>()

/** The board's own facts on an item or request (its `metadata`), read through fields.ts. */
const meta = (x: { readonly metadata?: Readonly<Record<string, unknown>> }): Fields => x.metadata ?? {}

const callOf = (it: ToolCall): Call =>
  onceCall(it, () => {
    const call: Call = { id: it.id, name: toolName(it), input: it.input }
    const result = resultOf(it)
    if (result) call.result = result
    return call
  })

const resultOf = (it: ToolCall): ToolResult | undefined => {
  const result = it.result
  return result ? onceResult(result, () => ({ content: result.content, isError: it.status !== "completed" })) : undefined
}

/** A turn's end as the result row reads it (as Claude's result message has it). */
const resultData = (it: Extract<ThreadItem, { type: "turn_result" }>) =>
  onceTurn(it, (): ResultData => {
    const md = meta(it)
    return {
      subtype: stringOf(md.subtype) ?? (it.ok ? "success" : "error"),
      is_error: !it.ok,
      ...(it.interrupted ? { interrupted: true } : {}),
      ...(it.duration_ms != null ? { duration_ms: it.duration_ms } : {}),
      ...optional("num_turns", numberOf(md.num_turns)),
      ...optional("total_cost_usd", numberOf(md.total_cost_usd)),
    }
  })

/** `{ [key]: value }`, or nothing when there is no value. */
function optional<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  const out: Partial<Record<K, V>> = {}
  if (value !== undefined) out[key] = value
  return out
}

const compactMeta = (it: Extract<ThreadItem, { type: "compaction" }>) =>
  onceCompact(it, (): CompactMeta => ({
    ...(it.trigger ? { trigger: it.trigger } : {}),
    ...(it.tokens_before != null ? { pre_tokens: it.tokens_before } : {}),
    ...optional("post_tokens", numberOf(meta(it).post_tokens)),
  }))

/** A routine's report: what the board put on its notice, or its text. */
const reportData = (it: Extract<ThreadItem, { type: "notice" }>) =>
  onceReport(it, (): ReportData => {
    if (!it.metadata) return { text: it.text }
    const md = it.metadata
    return {
      automation: stringOf(md.automation),
      task_id: stringOf(md.task_id),
      key: stringOf(md.key),
      outcome: stringOf(md.outcome),
      text: stringOf(md.text),
    }
  })

/** A permission request's status as the board keeps it, for a request from before its metadata (converter 2). */
function statusOf(r: ThreadRequest): string {
  const res = r.resolution
  if (!res) return "pending"
  if (res.outcome === "allow" || res.outcome === "answer") return r.type === "question" && r.id.startsWith("legacy:") ? "answered" : "allowed"
  if (res.outcome === "deny") return "denied"
  return "expired"
}

/** The answers shown on a question's card, question by question. */
const answersOf = (x: unknown): ReadonlyArray<ReadonlyArray<string>> | undefined =>
  Array.isArray(x) ? listOf(x).map((a) => listOf(a).flatMap((s) => (typeof s === "string" && s !== "" ? [s] : []))) : undefined

/** A permission prompt's card as the board stored it (the request's metadata), with the tool's input. */
function promptOf(r: ThreadRequest, md: Fields, input: unknown): PromptData {
  const rule = fieldsOf(md.rule)
  return {
    request_id: stringOf(md.request_id) ?? r.id,
    status: stringOf(md.status) ?? statusOf(r),
    tool_name: stringOf(md.tool_name) ?? "",
    input,
    ...optional("tool_use_id", stringOf(md.tool_use_id)),
    ...optional("kind", stringOf(md.kind)),
    ...optional("agent", stringOf(md.agent)),
    ...(md.rule === undefined ? {} : { rule: { tool: shown(rule.tool) } }),
    ...optional("expires_at", stringOf(md.expires_at)),
    ...optional("note", stringOf(md.note)),
    ...(md.late === true ? { late: true } : {}),
    ...optional("feedback", stringOf(md.feedback)),
    ...optional("mode", stringOf(md.mode)),
    ...optional("answers", answersOf(md.answers)),
  }
}

/** A permission prompt's message data (what the board stored, in its metadata), which its card reads. */
const promptData = (r: ThreadRequest) =>
  oncePrompt(r, (): PromptData => {
    // Its message's id is the board's, not the message's.
    if (r.metadata) return promptOf(r, r.metadata, r.type === "permission" ? r.input : r.metadata.input)
    // Kept before the board's record was (converter 2): what the request says.
    const base = { request_id: r.id, status: statusOf(r), ...(r.tool_call_id ? { tool_use_id: r.tool_call_id } : {}) }
    // (The board's own approvals are `app` requests named by their tool alone.)
    if (r.type === "permission") return { ...base, tool_name: r.kind === "app" ? r.name : toolName(r), input: r.input }
    if (r.type === "plan") return { ...base, tool_name: "ExitPlanMode", input: { plan: r.plan } }
    const qs = r.questions.map((q) => ({ question: q.question, header: q.header, options: q.options ?? [], multiSelect: !!q.multi_select }))
    return { ...base, tool_name: "AskUserQuestion", input: { questions: qs } }
  })

/** A board question's options, as its card and its answer read them. */
const optionsOf = (x: unknown): ReadonlyArray<QuestionOption> =>
  listOf(x).map((o) =>
    typeof o === "string" ? { label: o, description: undefined } : { label: shown(fieldsOf(o).label), description: stringOf(fieldsOf(o).description) },
  )

/** What a board question's resolution says of its card: its status, and the answer given. */
function boardQuestionState(r: Extract<ThreadRequest, { type: "question" }>, options: ReadonlyArray<QuestionOption>): Pick<QuestionData, "status" | "answer"> {
  const res = r.resolution
  if (!res) return { status: "pending" }
  if (res.outcome === "answer") {
    const given = Object.values(res.answers ?? {})[0] ?? []
    const labels = new Set(options.map((o) => o.label))
    const choices = given.filter((a) => labels.has(a))
    const typed = given.filter((a) => !labels.has(a))
    return { status: "answered", answer: { choices, text: typed.length ? typed.join("\n") : null } }
  }
  const why = res.message ?? ""
  return { status: why.startsWith("Replaced") ? "replaced" : why.startsWith("Expired") ? "expired" : "replied" }
}

/** An answer a board question's card was given, as its metadata keeps it. */
function answerOf(x: unknown): QuestionData["answer"] {
  if (x === undefined || x === null) return undefined
  const a = fieldsOf(x)
  return { choices: listOf(a.choices).flatMap((c) => (typeof c === "string" ? [c] : [])), text: stringOf(a.text) ?? null }
}

/** A question asked with the board's request_user_input: its message data. */
const questionData = (r: Extract<ThreadRequest, { type: "question" }>) =>
  onceQuestion(r, (): QuestionData => {
    if (r.metadata) {
      const md = r.metadata
      const options = optionsOf(md.options)
      // The board's card keeps its state in the request (permissions/Questions.ts): open is pending, an answer answered
      // (the picks, then what was typed), a cancellation replied, replaced or expired, as its message says.
      const state = md.status === undefined ? boardQuestionState(r, options) : { status: shown(md.status), ...optional("answer", answerOf(md.answer)) }
      return {
        question: shown(md.question),
        options,
        multi_select: !!md.multi_select,
        allow_other: md.allow_other !== false,
        ...state,
        ...(md.merge_approval === true ? { merge_approval: true } : {}),
      }
    }
    const [q] = r.questions
    return {
      question: q.question,
      options: (q.options ?? []).map((o) => ({ label: o.label, description: o.description })),
      multi_select: !!q.multi_select,
      allow_other: q.allow_other !== false,
      status: statusOf(r),
    }
  })

/** Whether a request is one of the board's own questions (request_user_input, a merge approval), not a permission prompt. */
const boardQuestion = (r: ThreadRequest): r is Extract<ThreadRequest, { type: "question" }> =>
  r.type === "question" && messageIdOf(r.id) !== undefined && !meta(r).tool_name

/** A request's message id, which orders it among the items and keys its row. */
const requestMessage = (r: ThreadRequest): number | undefined => {
  const n = meta(r).message_id
  return typeof n === "number" ? n : messageIdOf(r.id)
}

/** The view's rows of one conversation (the main one, or a subagent's). */
class Rows {
  items: Item[] = []

  private push(it: Item) {
    this.items.push(it)
  }

  private tool(call: Call) {
    const last = this.items[this.items.length - 1]
    // A group of calls is a new object (its calls are copied), so the one before stays as it was.
    if (last?.type === "tools") this.items[this.items.length - 1] = { ...last, calls: [...last.calls, call] }
    else this.push({ type: "tools", key: keyOf(call.id), calls: [call] })
  }

  item(it: ThreadItem) {
    const key = keyOf(it.id)
    switch (it.type) {
      case "user_message":
        this.push({ type: "user", key, text: it.text, auto: meta(it).auto === true ? true : undefined, steered: it.steered })
        return
      case "assistant_message":
        // A turn's result text that no message said: its turn's end shows instead.
        if (meta(it).from_result) return
        this.push({ type: "text", key, text: it.text })
        return
      case "reasoning":
        this.push({ type: "thinking", key, text: it.text })
        return
      case "tool_call":
        this.tool(callOf(it))
        return
      case "notice":
        // Claude Code's "[Request interrupted…]": nothing's drawn for it.
        if (it.code === "interrupted") return
        if (it.code === "routine_report") return this.push({ type: "report", key, data: reportData(it) })
        // An API error Claude Code gave as the assistant's text (the board's own events have no code).
        if (it.code) return this.push({ type: "text", key: `${key}.0`, text: it.text })
        this.push({ type: "event", key, level: it.level === "warning" ? "warn" : it.level, text: it.text, detail: it.detail ?? null })
        return
      case "compaction": {
        const row: Item = { type: "compact", key, meta: compactMeta(it) }
        if (it.summary) row.summary = it.summary
        this.push(row)
        return
      }
      case "turn_result": {
        const data = resultData(it)
        const last = this.items[this.items.length - 1]
        // A `/compact` run's turn is just the compaction.
        if (last?.type === "compact" && data.num_turns === 0 && it.ok && data.subtype === "success")
          this.items[this.items.length - 1] = { ...last, result: data }
        else this.push({ type: "result", key, data })
        return
      }
    }
  }

  request(r: ThreadRequest) {
    const n = requestMessage(r)
    const key = n !== undefined ? String(n) : r.id
    if (boardQuestion(r)) this.push({ type: "question", key, id: n ?? 0, data: questionData(r) })
    else this.push({ type: "permission", key, data: promptData(r) })
  }
}

/**
 * Whether request `r` goes before item `it` in the thread: its message was stored before the item's. Items made from
 * one message have its id in theirs (`legacy:`); tool calls don't, so they go by when they were stored, and a request
 * stored in the same millisecond as an item goes after it (prompts come after the call they ask about).
 */
function before(r: ThreadRequest, rid: number | undefined, it: ThreadItem): boolean {
  const iid = messageIdOf(it.id)
  if (rid !== undefined && iid !== undefined) return rid < iid
  return !!r.created_at && !!it.created_at && r.created_at < it.created_at
}

/** The subagent that a subagent's call shows. */
function subagentOf(it: ToolCall, running: boolean, waiting: Set<string>): Subagent {
  const s = it.subagent
  const input = fieldsOf(it.input)
  let status: SubagentStatus =
    s?.status ?? (it.status === "running" || it.status === "pending" ? "running" : it.status === "completed" ? "completed" : "failed")
  // One that never said it ended, in a run that has: stopped with it.
  if (!running && status === "running") status = "stopped"
  // What its task_started said it's doing, over its call's input (a forked Skill's has neither).
  const said = meta(it)
  const prompt = said.prompt ?? input.prompt
  const sub: Subagent = {
    id: it.id,
    description: stringOf(said.description) ?? it.title ?? stringOf(input.description) ?? "",
    prompt: typeof prompt === "string" ? prompt : "",
    background: !!(s?.background ?? input.run_in_background),
    status,
    startedAt: it.created_at ?? "",
    parent: it.parent_id ?? null,
  }
  const type = s?.agent_type ?? stringOf(input.subagent_type)
  if (type) sub.agentType = type
  const model = s?.model ?? stringOf(input.model)
  if (model) sub.model = model
  if (s?.activity) sub.activity = s.activity
  if (s?.summary) sub.summary = s.summary
  if (s?.tool_uses != null) sub.toolUses = s.tool_uses
  if (s?.ended_at) sub.endedAt = s.ended_at
  if (waiting.has(it.id)) sub.awaitingApproval = true
  return sub
}

type Shown = Pick<Snapshot, "items" | "requests" | "context">

/**
 * The model of a thread from its items and requests (a snapshot or window), reusing what's unchanged from `prev`. A
 * window's context items (the subagent calls its items belong to, from before it) aren't rows of the main conversation
 * until the page with them is loaded, but their subagents are known.
 */
export function buildItemModel(snap: Shown, running: boolean, prev?: ThreadModel): ThreadModel {
  const main = new Rows()
  const kids = new Map<string, Rows>()
  const rowsOf = (parent: string | undefined) => {
    if (parent === undefined) return main
    let r = kids.get(parent)
    if (!r) kids.set(parent, (r = new Rows()))
    return r
  }
  const results = new Map<string, ToolResult>()
  const callParent = new Map<string, string>()
  const calls: ToolCall[] = []
  let lastSent = 0
  // Requests go in among the items, in the order their messages were stored.
  const requests = snap.requests
    .map((r, i) => ({ r, i, id: requestMessage(r) }))
    .toSorted((a, b) => (a.id !== undefined && b.id !== undefined ? a.id - b.id : (a.r.created_at ?? "").localeCompare(b.r.created_at ?? "")) || a.i - b.i)
  let next = 0
  const place = (r: ThreadRequest) => {
    // A subagent's prompts are answered in the main conversation, and shown in its own thread too.
    main.request(r)
    if (r.parent_id) rowsOf(r.parent_id).request(r)
  }
  const context = snap.context?.length ?? 0
  snap.items.forEach((it, i) => {
    const body = i >= context
    if (body)
      for (let r = requests[next]; r !== undefined && before(r.r, r.id, it); r = requests[next]) {
        place(r.r)
        next++
      }
    if (body || it.parent_id) rowsOf(it.parent_id).item(it)
    if (it.type === "tool_call") {
      calls.push(it)
      const result = resultOf(it)
      if (result) results.set(it.id, result)
      if (it.parent_id) callParent.set(it.id, it.parent_id)
    } else if (it.type === "user_message" && !it.parent_id) {
      const n = messageIdOf(it.id)
      if (n !== undefined && n > lastSent) lastSent = n
    }
  })
  for (const r of requests.slice(next)) place(r.r)

  // The subagents with a prompt waiting.
  const waiting = new Set(snap.requests.flatMap((r) => (!r.resolution && r.parent_id ? [r.parent_id] : [])))
  const subagents = new Map<string, Subagent>()
  for (const it of calls) {
    if (it.kind !== "subagent") continue
    const s = subagentOf(it, running, waiting)
    const old = prev?.subagents.get(s.id)
    subagents.set(s.id, old && shallowEqual(old, s) ? old : s)
  }
  const childItems = new Map<string, Item[]>()
  for (const [id, rows] of kids) {
    const old = prev?.childItems.get(id)
    childItems.set(id, old ? reuseItems(rows.items, old) : rows.items)
  }
  const sameResults = prev && prev.results.size === results.size && [...results].every(([k, v]) => prev.results.get(k) === v)
  const sameParents = prev && prev.callParent.size === callParent.size && [...callParent].every(([k, v]) => prev.callParent.get(k) === v)
  return {
    items: prev ? reuseItems(main.items, prev.items) : main.items,
    results: sameResults ? prev.results : results,
    subagents: prev && sameMap(prev.subagents, subagents) ? prev.subagents : subagents,
    callParent: sameParents ? prev.callParent : callParent,
    lastSent,
    childItems: prev && sameMap(prev.childItems, childItems) ? prev.childItems : childItems,
  }
}

function sameMap<K, V>(a: ReadonlyMap<K, V>, b: ReadonlyMap<K, V>): boolean {
  if (a.size !== b.size) return false
  for (const [k, v] of b) if (a.get(k) !== v) return false
  return true
}

/** The latest model of each thread drawn from items, and what it was built from, so its views build it once. Kept for
 * the page's life: a model is small beside the thread it was built from, which the client drops. */
const models = new Map<string, { snap: Shown; running: boolean; model: ThreadModel }>()

/** The model of task `taskId`'s thread, from its items. */
export function itemModel(taskId: string, snap: Shown, running: boolean): ThreadModel {
  const was = models.get(taskId)
  if (was && was.snap.items === snap.items && was.snap.requests === snap.requests && was.running === running) return was.model
  const model = buildItemModel(snap, running, was?.model)
  models.set(taskId, { snap, running, model })
  return model
}

/** Drops the models of the threads that aren't shown any more. */
export function forgetItemModels(keep: (taskId: string) => boolean) {
  for (const id of models.keys()) if (!keep(id)) models.delete(id)
}
