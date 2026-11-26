import type { Item, Snapshot, ThreadRequest, ToolCall } from "@huntaway/contracts"
import { type DocRef, publishedDoc } from "./links"

// What a thread shows on the phone (a smaller cut of the web's itemModel.ts, as the old app's thread.ts was): the
// user's messages, the agent's text, each tool call in one line, the board's notices, a routine's report, a failed
// turn, and the requests (prompts, questions, plans) after the call they are for. Subagents' own items, a window's
// context items, reasoning and compactions are left out. HE-99: a run of tool calls is one row that opens
// (`foldTools`), so a phone's screen shows what was said rather than what was run, and a document an agent published
// is a row that opens it.

/** A tool call, in one line. */
export interface ToolRow {
  readonly type: "tool"
  readonly key: string
  readonly name: string
  readonly summary: string
  readonly status: ToolCall["status"]
}

export type Row =
  | { readonly type: "user"; readonly key: string; readonly text: string }
  | { readonly type: "text"; readonly key: string; readonly text: string }
  | ToolRow
  /** A document the agent published (the docs plugin's `publish_document`), which opens in the app. */
  | { readonly type: "doc"; readonly key: string; readonly doc: DocRef }
  | { readonly type: "notice"; readonly key: string; readonly level: "info" | "warning" | "error"; readonly text: string }
  | { readonly type: "report"; readonly key: string; readonly automation: string; readonly outcome: string; readonly text: string }
  | { readonly type: "failed"; readonly key: string; readonly text: string }
  | { readonly type: "request"; readonly key: string; readonly request: ThreadRequest }

/** A metadata field as a string, if it is one. */
const meta = (it: { readonly metadata?: Readonly<Record<string, unknown>> }, key: string): string | undefined => {
  const v = it.metadata?.[key]
  return typeof v === "string" ? v : undefined
}

/** A tool's name as the agent knows it: an MCP tool with its server's, the board's own tools on `app`. */
export const toolName = (t: Pick<ToolCall, "name" | "kind" | "server">): string => {
  if (t.kind === "mcp" && t.server !== undefined) return `mcp__${t.server}__${t.name}`
  return t.kind === "app" ? `mcp__app__${t.name}` : t.name
}

/** A short name for a tool, as the line shows it: an MCP tool's own name, without its server's. */
export const shortToolName = (name: string): string => (name.startsWith("mcp__") ? name.slice(name.lastIndexOf("__") + 2) : name)

const firstLine = (text: string, max = 90): string => {
  const line = text.trim().split("\n")[0] ?? ""
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/** What a tool call did, in a few words: its command, file, query or URL, else its title. */
export const toolSummary = (t: Pick<ToolCall, "command" | "path" | "query" | "url" | "title" | "changes">): string => {
  const first = t.changes?.[0]?.path
  const said = t.command ?? t.path ?? first ?? t.query ?? t.url ?? t.title ?? ""
  return firstLine(said)
}

/** A short view of what a prompt's tool would do, from what the agent asked with: its command, file, address… */
export const inputText = (input: unknown): string => {
  if (typeof input !== "object" || input === null) return ""
  for (const f of ["command", "file_path", "path", "url", "query", "description", "prompt"]) {
    const v: unknown = Reflect.get(input, f)
    if (typeof v === "string" && v.trim() !== "") return v.length > 400 ? `${v.slice(0, 399)}…` : v
  }
  return ""
}

/** Whether a request is still waiting for its answer. */
export const isOpen = (r: ThreadRequest): boolean => r.resolution === undefined

/**
 * A question the board asked itself with its request_user_input tool, rather than the agent's own: answered as the
 * user's message (`threads.answerQuestion`), not as the agent's prompt (`permissions.answer`).
 */
export const isBoardQuestion = (r: ThreadRequest): boolean => r.type === "question" && r.id.startsWith("legacy:")

/** The docs plugin's tool that publishes a document, as an agent knows it. */
const PUBLISH = "mcp__docs__publish_document"

/** One item's row, if it has one. */
function rowOf(it: Item): Row | null {
  switch (it.type) {
    case "user_message":
      return it.text.trim() === "" ? null : { type: "user", key: it.id, text: it.text }
    case "assistant_message":
      return it.text.trim() === "" || it.metadata?.["from_result"] === true ? null : { type: "text", key: it.id, text: it.text }
    case "tool_call": {
      const name = toolName(it)
      const doc = name === PUBLISH && it.status === "completed" && it.result !== undefined ? publishedDoc(it.result.content) : null
      if (doc !== null) return { type: "doc", key: it.id, doc }
      return { type: "tool", key: it.id, name, summary: toolSummary(it), status: it.status }
    }
    case "notice":
      if (it.code === "interrupted") return null
      if (it.code === "routine_report")
        return {
          type: "report",
          key: it.id,
          automation: meta(it, "automation") ?? "A routine",
          outcome: meta(it, "outcome") ?? "reported",
          text: meta(it, "text") ?? it.text,
        }
      // An API error of the agent's is the agent speaking.
      if (it.level === "error" && it.code !== undefined) return { type: "text", key: it.id, text: it.text }
      return { type: "notice", key: it.id, level: it.level, text: it.text }
    case "turn_result":
      return it.ok || it.interrupted === true ? null : { type: "failed", key: it.id, text: it.error ?? "The run failed." }
    case "reasoning":
    case "compaction":
      return null
  }
  return null
}

/**
 * A thread's rows, oldest first (pure): its main conversation's items after the window's context items, each request
 * after the tool call it is for, and the others where they were asked (by `created_at`), else at the end.
 */
export function threadRows(snap: Pick<Snapshot, "items" | "requests" | "context">): ReadonlyArray<Row> {
  const items = snap.items.slice(snap.context?.length ?? 0).filter((it) => it.parent_id === undefined)
  const requests = snap.requests.filter((r) => r.parent_id === undefined)
  const calls = new Set(items.flatMap((it) => (it.type === "tool_call" ? [it.id] : [])))
  const byCall = new Map<string, Array<ThreadRequest>>()
  const loose: Array<ThreadRequest> = []
  for (const r of requests) {
    if (r.tool_call_id !== undefined && calls.has(r.tool_call_id)) byCall.set(r.tool_call_id, [...(byCall.get(r.tool_call_id) ?? []), r])
    else loose.push(r)
  }
  const out: Array<Row> = []
  let next = 0
  const askedBefore = (at: string | undefined): void => {
    while (next < loose.length) {
      const r = loose[next]
      if (r === undefined || at === undefined || r.created_at === undefined || r.created_at >= at) return
      out.push({ type: "request", key: r.id, request: r })
      next++
    }
  }
  for (const it of items) {
    askedBefore(it.created_at)
    const row = rowOf(it)
    if (row !== null) out.push(row)
    for (const r of byCall.get(it.id) ?? []) out.push({ type: "request", key: r.id, request: r })
  }
  for (const r of loose.slice(next)) out.push({ type: "request", key: r.id, request: r })
  return out
}

/** A thread's row as a phone draws it: a row, or a run of tool calls in one. */
export type Shown = Exclude<Row, ToolRow> | { readonly type: "tools"; readonly key: string; readonly calls: ReadonlyArray<ToolRow> }

/** A run of tool calls' key: its first call's, so a run that grows keeps the row it had (and whether it was open). */
const runOf = (calls: ReadonlyArray<ToolRow>): Shown => ({ type: "tools", key: `tools:${calls[0]?.key ?? ""}`, calls })

/** `rows` with every run of tool calls next to each other folded into one row (pure). */
export function foldTools(rows: ReadonlyArray<Row>): ReadonlyArray<Shown> {
  const out: Array<Shown> = []
  let run: Array<ToolRow> = []
  for (const row of rows) {
    if (row.type === "tool") {
      run.push(row)
      continue
    }
    if (run.length > 0) out.push(runOf(run))
    run = []
    out.push(row)
  }
  if (run.length > 0) out.push(runOf(run))
  return out
}

/** A run of tool calls in a few words: how many, how many failed, and whether one is still going. */
export function toolsSummary(calls: ReadonlyArray<Pick<ToolRow, "status">>): { readonly label: string; readonly running: boolean; readonly failed: number } {
  const failed = calls.filter((c) => c.status === "failed" || c.status === "denied").length
  const running = calls.some((c) => c.status === "running" || c.status === "pending")
  const label = `${calls.length} ${calls.length === 1 ? "step" : "steps"}${failed === 0 ? "" : `, ${failed} failed`}`
  return { label, running, failed }
}
