import { clsx } from "clsx"
import { Option, Schema } from "effect"
import { BookOpen, Bot, ChevronRight, FileText, Globe, LayoutGrid, ListChecks, Loader2, Monitor, Pencil, Search, Terminal, Wrench, X } from "lucide-react"
import { memo, useContext, useState, type ReactNode } from "react"
import { lineage, SubagentRowCtx, ThreadCtx, usePendingFocus, useThread } from "./context"
import type { Any, Call } from "./threadModel"

export function toolMeta(name: string, input: Any, cwd?: string | null): { icon: ReactNode; label: string; summary: string } {
  const rel = (p?: string) => (p && cwd && p.startsWith(cwd + "/") ? p.slice(cwd.length + 1) : (p ?? ""))
  const s = 13
  switch (name) {
    case "Bash":
      return { icon: <Terminal size={s} />, label: "Ran", summary: input?.command ?? "" }
    case "Read":
      return { icon: <FileText size={s} />, label: "Read", summary: rel(input?.file_path) }
    case "Edit":
    case "MultiEdit":
      return { icon: <Pencil size={s} />, label: "Edited", summary: rel(input?.file_path) }
    case "Write":
      return { icon: <Pencil size={s} />, label: "Wrote", summary: rel(input?.file_path) }
    // Codex's file edits (see agent/codex.rs on the server).
    case "ApplyPatch": {
      const changes: Any[] = input?.changes ?? []
      const label = changes.length && changes.every((c) => c.kind === "add") ? "Wrote" : changes.every((c) => c.kind === "delete") ? "Deleted" : "Edited"
      return { icon: <Pencil size={s} />, label, summary: changes.map((c) => rel(c.path)).join(", ") }
    }
    case "NotebookEdit":
      return { icon: <Pencil size={s} />, label: "Edited", summary: rel(input?.notebook_path) }
    case "Grep":
      return { icon: <Search size={s} />, label: "Searched", summary: `${input?.pattern ?? ""}${input?.path ? `  in ${rel(input.path)}` : ""}` }
    case "Glob":
      return { icon: <Search size={s} />, label: "Listed", summary: input?.pattern ?? "" }
    case "WebFetch":
      return { icon: <Globe size={s} />, label: "Fetched", summary: input?.url ?? "" }
    case "WebSearch":
      return { icon: <Globe size={s} />, label: "Searched web", summary: input?.query ?? "" }
    case "Task":
    case "Agent":
      return { icon: <Bot size={s} />, label: "Subagent", summary: input?.description ?? "" }
    case "TodoWrite":
      return { icon: <ListChecks size={s} />, label: "Updated todos", summary: `${input?.todos?.length ?? 0} items` }
  }
  // The board's own server; mcp__issue_agent__ is its name before the rename to Huntaway.
  const board = /^mcp__(huntaway|issue_agent)__/
  if (board.test(name)) {
    const tool = name.replace(board, "")
    return {
      icon: <LayoutGrid size={s} />,
      label: "Board",
      summary: `${tool}${input?.title ? `  “${input.title}”` : input?.question ? `  ${input.question}` : ""}`,
    }
  }
  // The run's docs server (HA-280).
  if (name.startsWith("mcp__docs__")) {
    const what = input?.title ?? input?.slug
    return { icon: <BookOpen size={s} />, label: "Docs", summary: `${name.slice("mcp__docs__".length)}${what ? `  “${what}”` : ""}` }
  }
  // The run's desktop server (HA-273).
  if (name.startsWith("mcp__desktop__")) {
    const tool = name.slice("mcp__desktop__".length)
    return { icon: <Monitor size={s} />, label: DESKTOP_LABELS[tool] ?? "Desktop", summary: desktopSummary(tool, input) }
  }
  return { icon: <Wrench size={s} />, label: name.replace(/^mcp__/, "").replace(/__/g, " · "), summary: "" }
}

const DESKTOP_LABELS: Record<string, string> = {
  health: "Checked the desktop",
  apps: "Listed apps",
  windows: "Listed windows",
  read: "Read a window",
  screen: "Looked",
  zoom: "Zoomed in",
  verify: "Verified",
  op_status: "Looked up",
  act: "Acted",
  launch: "Launched",
  clipboard: "Clipboard",
}

const clip = (t: string, n = 40) => (t.length > n ? `${t.slice(0, n - 1)}…` : t)

/** What a desktop call did, in a few words (the server's journal says it the same way, see mcp/desktop_mcp.ts). */
function desktopSummary(tool: string, input: Any): string {
  const where = input?.pid != null ? `pid ${input.pid}${input.window_id != null ? `, window ${input.window_id}` : ""}` : ""
  if (tool === "act") {
    const steps: Any[] = Array.isArray(input?.steps) ? input.steps : []
    const say = (st: Any) => {
      const a = st?.args ?? {}
      const t = String(st?.tool ?? "?")
      if ((t === "type_text" || t === "type") && typeof a.text === "string") return `type “${clip(a.text)}”`
      if (t === "set_value" && a.value != null) return `set “${clip(String(a.value))}”`
      if ((t === "press_key" || t === "press") && a.key) return `press ${a.key}`
      if (t === "hotkey" && Array.isArray(a.keys)) return `press ${a.keys.join("+")}`
      return t.replace(/_/g, " ")
    }
    const listed = steps.slice(0, 4).map(say).join(", ")
    return steps.length > 4 ? `${listed}, … (${steps.length} steps)` : listed
  }
  if (tool === "launch") return String(input?.name ?? input?.launch_path ?? input?.bundle_id ?? "")
  if (tool === "clipboard") return typeof input?.text === "string" ? `copy “${clip(input.text)}”` : "read"
  if (tool === "read") return `${input?.query ? `“${input.query}” in ` : ""}${where}`
  if (tool === "screen") return where || "the whole desktop"
  if (tool === "op_status") return String(input?.op_id ?? "")
  if (tool === "windows") return input?.app ? String(input.app) : where
  return where
}

// The link to the document a `publish_document` call published (PublishedDoc, HA-281) comes with the board's docs (M6).

/** A tool's input as indented JSON, as the old view showed one it has no view of its own for. */
const encodePretty = Schema.encodeUnknownOption(Schema.fromJsonString(Schema.Unknown, { space: 2 }))
const prettyJson = (value: unknown): string => Option.getOrElse(encodePretty(value), () => String(value))

/** A list's items with their places, for keys: what is drawn of an agent's input has nothing better to key on. */
const numbered = <T,>(list: ReadonlyArray<T>): Array<{ n: number; value: T }> => list.map((value, n) => ({ n, value }))

const listOf = (x: unknown): Any[] => (Array.isArray(x) ? x : [])

function EditDiff({ oldStr, newStr }: { oldStr: string; newStr: string }) {
  return (
    <pre className="overflow-x-auto rounded-md border border-line bg-[#0c0c10] p-2 font-mono text-[12px] leading-[1.45]">
      {numbered(oldStr.split("\n")).map((l) => (
        <div key={`o${l.n}`} className="bg-red-500/10 text-red-300">
          - {l.value}
        </div>
      ))}
      {numbered(newStr.split("\n")).map((l) => (
        <div key={`n${l.n}`} className="bg-emerald-500/10 text-emerald-300">
          + {l.value}
        </div>
      ))}
    </pre>
  )
}

const lineTone = (l: string) =>
  l.startsWith("+") && !l.startsWith("+++")
    ? "bg-emerald-500/10 text-emerald-300"
    : l.startsWith("-") && !l.startsWith("---")
      ? "bg-red-500/10 text-red-300"
      : l.startsWith("@@")
        ? "text-faint"
        : "text-[#c9c9d6]"

/** A unified diff, as Codex reports a file change. */
function PatchDiff({ change }: { change: Any }) {
  const lines = String(change.diff ?? "")
    .replace(/\n$/, "")
    .split("\n")
  return (
    <div>
      <div className="mb-1 font-mono text-[11.5px] text-muted">
        {change.kind === "add" ? "new " : change.kind === "delete" ? "deleted " : ""}
        {change.path}
        {change.move_path ? ` → ${change.move_path}` : ""}
      </div>
      <pre className="max-h-80 overflow-auto rounded-md border border-line bg-[#0c0c10] p-2 font-mono text-[12px] leading-[1.45]">
        {numbered(lines).map((l) => (
          <div key={l.n} className={lineTone(l.value)}>
            {l.value || " "}
          </div>
        ))}
      </pre>
    </div>
  )
}

export function ToolInput({ name, input }: { name: string; input: Any }) {
  if (name === "Bash") return <CodeBlock text={input?.command ?? ""} />
  if (name === "ApplyPatch")
    return (
      <div className="space-y-2">
        {numbered(listOf(input?.changes)).map((c) => (
          <PatchDiff key={c.n} change={c.value} />
        ))}
      </div>
    )
  if (name === "Edit") return <EditDiff oldStr={input?.old_string ?? ""} newStr={input?.new_string ?? ""} />
  if (name === "MultiEdit")
    return (
      <div className="space-y-1">
        {numbered(listOf(input?.edits)).map((e) => (
          <EditDiff key={e.n} oldStr={e.value.old_string ?? ""} newStr={e.value.new_string ?? ""} />
        ))}
      </div>
    )
  if (name === "Write") return <CodeBlock text={input?.content ?? ""} max="max-h-64" />
  if (name === "TodoWrite")
    return (
      <ul className="space-y-0.5 text-[12.5px]">
        {numbered(listOf(input?.todos)).map(({ n, value: t }) => (
          <li key={n} className={clsx("flex gap-2", t.status === "completed" && "text-faint line-through")}>
            <span>{t.status === "completed" ? "✓" : t.status === "in_progress" ? "◐" : "○"}</span>
            {t.content}
          </li>
        ))}
      </ul>
    )
  return <CodeBlock text={prettyJson(input)} />
}

export function CodeBlock({ text, max = "max-h-80", tone }: { text: string; max?: string | undefined; tone?: "error" | undefined }) {
  return (
    <pre
      className={clsx(
        "overflow-auto rounded-md border border-line bg-[#0c0c10] p-2 font-mono text-[12px] leading-[1.45] whitespace-pre-wrap break-words",
        max,
        tone === "error" ? "text-red-300" : "text-[#c9c9d6]",
      )}
    >
      {text || <span className="text-faint">(empty)</span>}
    </pre>
  )
}

/** Tools whose input already shows the change, so only an error result is worth showing. */
const EDIT_TOOLS = new Set(["Edit", "Write", "ApplyPatch"])

const ToolRow = memo(function ToolRow({ call, running, cwd }: { call: Call; running: boolean; cwd?: string | null | undefined }) {
  const sub = useThread((t) => t.subagents.get(call.id))
  const subagentRow = useContext(SubagentRowCtx)
  if (sub && subagentRow) return subagentRow(call, sub)
  return <PlainToolRow call={call} running={running} cwd={cwd} />
})

function PlainToolRow({ call, running, cwd }: { call: Call; running: boolean; cwd?: string | null | undefined }) {
  const [open, setOpen] = useState(false)
  const m = toolMeta(call.name, call.input, cwd)
  const pending = !call.result
  return (
    <div data-tool-row>
      <button onClick={() => setOpen(!open)} className="group flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[12.5px] hover:bg-white/[0.03]">
        <ChevronRight size={12} className={clsx("shrink-0 text-faint transition-transform", open && "rotate-90")} />
        <span className="shrink-0 text-muted">{m.icon}</span>
        <span className="shrink-0 text-muted">{m.label}</span>
        <span className="min-w-0 truncate font-mono text-[12px] text-[#b9b9c8]">{m.summary}</span>
        <span className="ml-auto shrink-0">
          {pending && running ? (
            <Loader2 size={12} className="animate-spin text-st-progress" />
          ) : call.result?.isError ? (
            <X size={12} className="text-red-400" />
          ) : null}
        </span>
      </button>
      {open && (
        <div className="space-y-2 px-2 pb-2 pl-7">
          <ToolInput name={call.name} input={call.input} />
          {call.result && !EDIT_TOOLS.has(call.name) && <CodeBlock text={call.result.content} tone={call.result.isError ? "error" : undefined} />}
          {call.result?.isError && EDIT_TOOLS.has(call.name) && <CodeBlock text={call.result.content} tone="error" />}
        </div>
      )}
    </div>
  )
}

export const ToolGroup = memo(function ToolGroup({ calls, running, cwd }: { calls: Call[]; running: boolean; cwd?: string | null | undefined }) {
  const [expanded, setExpanded] = useState(false)
  const LIMIT = 6
  const hidden = calls.length - LIMIT
  const source = useContext(ThreadCtx)
  const focus = usePendingFocus()
  // A request to reveal a subagent among the hidden calls opens them (once, as it comes; adjusted while drawing).
  const [seen, setSeen] = useState(focus)
  if (focus !== seen) {
    setSeen(focus)
    if (focus && hidden > 0 && source) {
      const path = lineage(source.data.subagents, focus.id)
      if (calls.slice(0, hidden).some((c) => path.includes(c.id))) setExpanded(true)
    }
  }
  const shown = expanded || hidden <= 0 ? calls : calls.slice(-LIMIT)
  return (
    <div className="rounded-lg border border-line bg-panel/60 py-1">
      {!expanded && hidden > 0 && (
        <button onClick={() => setExpanded(true)} className="px-3 py-1 text-[12px] text-faint hover:text-muted">
          Show {hidden} earlier tool call{hidden > 1 ? "s" : ""}
        </button>
      )}
      {shown.map((c) => (
        <ToolRow key={c.id} call={c} running={running} cwd={cwd} />
      ))}
    </div>
  )
})
