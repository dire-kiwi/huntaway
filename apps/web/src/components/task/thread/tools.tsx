import { clsx } from "clsx"
import { Option, Schema } from "effect"
import { BookOpen, Bot, ChevronRight, FileText, Globe, LayoutGrid, ListChecks, Loader2, Monitor, Pencil, Search, Terminal, Wrench, X } from "lucide-react"
import { memo, useContext, useState, type ReactNode } from "react"
import { navigate } from "../../../state/route"
// 6.3
import { publishedDocPath } from "../../docs/docs"
import { lineage, SubagentRowCtx, ThreadCtx, usePendingFocus, useThread } from "./context"
import { fieldsOf, listOf, shown, stringOf, type Fields } from "./fields"
import type { Call } from "./threadModel"

export function toolMeta(name: string, input: unknown, cwd?: string | null): { icon: ReactNode; label: string; summary: string } {
  const rel = (p?: string) => (p && cwd && p.startsWith(cwd + "/") ? p.slice(cwd.length + 1) : (p ?? ""))
  const i = fieldsOf(input)
  const s = 13
  switch (name) {
    case "Bash":
      return { icon: <Terminal size={s} />, label: "Ran", summary: shown(i.command) }
    case "Read":
      return { icon: <FileText size={s} />, label: "Read", summary: rel(stringOf(i.file_path)) }
    case "Edit":
    case "MultiEdit":
      return { icon: <Pencil size={s} />, label: "Edited", summary: rel(stringOf(i.file_path)) }
    case "Write":
      return { icon: <Pencil size={s} />, label: "Wrote", summary: rel(stringOf(i.file_path)) }
    // Codex's file edits (see agent/codex.rs on the server).
    case "ApplyPatch": {
      const changes = listOf(i.changes).map(fieldsOf)
      const label = changes.length && changes.every((c) => c.kind === "add") ? "Wrote" : changes.every((c) => c.kind === "delete") ? "Deleted" : "Edited"
      return { icon: <Pencil size={s} />, label, summary: changes.map((c) => rel(stringOf(c.path))).join(", ") }
    }
    case "NotebookEdit":
      return { icon: <Pencil size={s} />, label: "Edited", summary: rel(stringOf(i.notebook_path)) }
    case "Grep": {
      const path = stringOf(i.path)
      return { icon: <Search size={s} />, label: "Searched", summary: `${shown(i.pattern)}${path ? `  in ${rel(path)}` : ""}` }
    }
    case "Glob":
      return { icon: <Search size={s} />, label: "Listed", summary: shown(i.pattern) }
    case "WebFetch":
      return { icon: <Globe size={s} />, label: "Fetched", summary: shown(i.url) }
    case "WebSearch":
      return { icon: <Globe size={s} />, label: "Searched web", summary: shown(i.query) }
    case "Task":
    case "Agent":
      return { icon: <Bot size={s} />, label: "Subagent", summary: shown(i.description) }
    case "TodoWrite":
      return { icon: <ListChecks size={s} />, label: "Updated todos", summary: `${listOf(i.todos).length} items` }
  }
  // The board's own server; mcp__issue_agent__ is its name before the rename to Huntaway.
  const board = /^mcp__(huntaway|issue_agent)__/
  if (board.test(name)) {
    const tool = name.replace(board, "")
    const title = shown(i.title)
    const question = shown(i.question)
    return { icon: <LayoutGrid size={s} />, label: "Board", summary: `${tool}${title ? `  “${title}”` : question ? `  ${question}` : ""}` }
  }
  // The run's docs server (HA-280).
  if (name.startsWith("mcp__docs__")) {
    const what = stringOf(i.title) ?? stringOf(i.slug)
    return { icon: <BookOpen size={s} />, label: "Docs", summary: `${name.slice("mcp__docs__".length)}${what ? `  “${what}”` : ""}` }
  }
  // The run's desktop server (HA-273).
  if (name.startsWith("mcp__desktop__")) {
    const tool = name.slice("mcp__desktop__".length)
    return { icon: <Monitor size={s} />, label: DESKTOP_LABELS[tool] ?? "Desktop", summary: desktopSummary(tool, i) }
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

/** One step of a desktop `act` call, in a few words. */
function stepSays(step: unknown): string {
  const st = fieldsOf(step)
  const a = fieldsOf(st.args)
  const t = st.tool === undefined || st.tool === null ? "?" : shown(st.tool)
  if ((t === "type_text" || t === "type") && typeof a.text === "string") return `type “${clip(a.text)}”`
  if (t === "set_value" && a.value != null) return `set “${clip(shown(a.value))}”`
  if ((t === "press_key" || t === "press") && a.key) return `press ${shown(a.key)}`
  if (t === "hotkey" && Array.isArray(a.keys)) return `press ${listOf(a.keys).map(shown).join("+")}`
  return t.replace(/_/g, " ")
}

/** What a desktop call did, in a few words (the server's journal says it the same way, see mcp/desktop_mcp.ts). */
function desktopSummary(tool: string, input: Fields): string {
  const where = input.pid != null ? `pid ${shown(input.pid)}${input.window_id != null ? `, window ${shown(input.window_id)}` : ""}` : ""
  if (tool === "act") {
    const steps = listOf(input.steps)
    const listed = steps.slice(0, 4).map(stepSays).join(", ")
    return steps.length > 4 ? `${listed}, … (${steps.length} steps)` : listed
  }
  if (tool === "launch") return shown(input.name ?? input.launch_path ?? input.bundle_id)
  if (tool === "clipboard") return typeof input.text === "string" ? `copy “${clip(input.text)}”` : "read"
  if (tool === "read") return `${input.query ? `“${shown(input.query)}” in ` : ""}${where}`
  if (tool === "screen") return where || "the whole desktop"
  if (tool === "op_status") return shown(input.op_id)
  if (tool === "windows") return input.app ? shown(input.app) : where
  return where
}

/** 6.3: the link to the document a `publish_document` call published, which opens in the board (HA-281). */
function PublishedDoc({ call }: { call: Call }) {
  if (call.name !== "mcp__docs__publish_document" || !call.result || call.result.isError) return null
  const doc = publishedDocPath(call.result.content)
  if (!doc) return null
  return (
    <a
      href={doc.path}
      onClick={(e) => {
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
        e.preventDefault()
        navigate(doc.path)
      }}
      className="ml-7 flex w-fit items-center gap-1.5 rounded px-2 py-0.5 text-[12.5px] text-accent hover:bg-white/[0.03] hover:underline"
    >
      <BookOpen size={12} />
      Open “{stringOf(fieldsOf(call.input).title) ?? doc.slug}”{doc.version !== null ? ` (v${doc.version})` : ""} in Docs
    </a>
  )
}

/** A tool's input as indented JSON, as the old view showed one it has no view of its own for. */
const encodePretty = Schema.encodeUnknownOption(Schema.fromJsonString(Schema.Unknown, { space: 2 }))
const prettyJson = (value: unknown): string => Option.getOrElse(encodePretty(value), () => String(value))

/** A list's items with their places, for keys: what is drawn of an agent's input has nothing better to key on. */
const numbered = <T,>(list: ReadonlyArray<T>): Array<{ n: number; value: T }> => list.map((value, n) => ({ n, value }))

/** A list in a tool's input, each item's fields. */
const objectsOf = (x: unknown): ReadonlyArray<Fields> => listOf(x).map(fieldsOf)

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
function PatchDiff({ change }: { change: Fields }) {
  const lines = shown(change.diff).replace(/\n$/, "").split("\n")
  return (
    <div>
      <div className="mb-1 font-mono text-[11.5px] text-muted">
        {change.kind === "add" ? "new " : change.kind === "delete" ? "deleted " : ""}
        {shown(change.path)}
        {change.move_path ? ` → ${shown(change.move_path)}` : ""}
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

export function ToolInput({ name, input }: { name: string; input: unknown }) {
  const i = fieldsOf(input)
  if (name === "Bash") return <CodeBlock text={shown(i.command)} />
  if (name === "ApplyPatch")
    return (
      <div className="space-y-2">
        {numbered(objectsOf(i.changes)).map((c) => (
          <PatchDiff key={c.n} change={c.value} />
        ))}
      </div>
    )
  if (name === "Edit") return <EditDiff oldStr={shown(i.old_string)} newStr={shown(i.new_string)} />
  if (name === "MultiEdit")
    return (
      <div className="space-y-1">
        {numbered(objectsOf(i.edits)).map((e) => (
          <EditDiff key={e.n} oldStr={shown(e.value.old_string)} newStr={shown(e.value.new_string)} />
        ))}
      </div>
    )
  if (name === "Write") return <CodeBlock text={shown(i.content)} max="max-h-64" />
  if (name === "TodoWrite")
    return (
      <ul className="space-y-0.5 text-[12.5px]">
        {numbered(objectsOf(i.todos)).map(({ n, value: t }) => (
          <li key={n} className={clsx("flex gap-2", t.status === "completed" && "text-faint line-through")}>
            <span>{t.status === "completed" ? "✓" : t.status === "in_progress" ? "◐" : "○"}</span>
            {shown(t.content)}
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
      <PublishedDoc call={call} />
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
  // Null at first: a row that mounts while a reveal is pending (as the rows around it open) acts on it too.
  const [seen, setSeen] = useState<typeof focus>(null)
  if (focus !== seen) {
    setSeen(focus)
    if (focus && hidden > 0 && source) {
      const path = lineage(source.data.subagents, focus.id)
      if (calls.slice(0, hidden).some((c) => path.includes(c.id))) setExpanded(true)
    }
  }
  const visible = expanded || hidden <= 0 ? calls : calls.slice(-LIMIT)
  return (
    <div className="rounded-lg border border-line bg-panel/60 py-1">
      {!expanded && hidden > 0 && (
        <button onClick={() => setExpanded(true)} className="px-3 py-1 text-[12px] text-faint hover:text-muted">
          Show {hidden} earlier tool call{hidden > 1 ? "s" : ""}
        </button>
      )}
      {visible.map((c) => (
        <ToolRow key={c.id} call={c} running={running} cwd={cwd} />
      ))}
    </div>
  )
})
