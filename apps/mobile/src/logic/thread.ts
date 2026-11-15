import type { Item, Snapshot, ThreadRequest, ToolCall } from "@huntaway/contracts"

// What a thread shows on the phone (a smaller cut of the web's itemModel.ts, as the old app's thread.ts was): the
// user's messages, the agent's text, each tool call in one line, the board's notices, a routine's report, a failed
// turn, and the requests (prompts, questions, plans) after the call they are for. Subagents' own items, a window's
// context items, reasoning and compactions are left out.

export type Row =
  | { readonly type: "user"; readonly key: string; readonly text: string }
  | { readonly type: "text"; readonly key: string; readonly text: string }
  | { readonly type: "tool"; readonly key: string; readonly name: string; readonly summary: string; readonly status: ToolCall["status"] }
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

/** Whether a request is still waiting for its answer. */
export const isOpen = (r: ThreadRequest): boolean => r.resolution === undefined

/**
 * A question the board asked itself with its request_user_input tool, rather than the agent's own: answered as the
 * user's message (`threads.answerQuestion`), not as the agent's prompt (`permissions.answer`).
 */
export const isBoardQuestion = (r: ThreadRequest): boolean => r.type === "question" && r.id.startsWith("legacy:")

/** One item's row, if it has one. */
function rowOf(it: Item): Row | null {
  switch (it.type) {
    case "user_message":
      return it.text.trim() === "" ? null : { type: "user", key: it.id, text: it.text }
    case "assistant_message":
      return it.text.trim() === "" || it.metadata?.["from_result"] === true ? null : { type: "text", key: it.id, text: it.text }
    case "tool_call": {
      const name = toolName(it)
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
