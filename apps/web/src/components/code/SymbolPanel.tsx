// HE-79: the Code tab's side panel: where the symbol clicked is defined and used (`git.symbol`, found by search, as
// GitHub's search-based navigation does), or the file's outline (the names it defines).
import { useAtomValue } from "@effect/atom-react"
import { query, type QueryOptions } from "@huntaway/client"
import type { GitSymbolHit, TaskId } from "@huntaway/contracts"
import { outline } from "@huntaway/shared"
import { X } from "lucide-react"
import { useMemo, useState } from "react"
import { IconButton, Loading } from "../ui"
import type { Looked } from "./state"
import { baseName } from "./tree"

const MARK = "rounded-[2px] bg-amber-400/20 text-fg"

export function SymbolPanel({
  h,
  id,
  looked,
  at,
  onOpen,
  onClose,
}: {
  h: string
  id: TaskId
  looked: Looked
  /** The file and line shown, whose hit is picked. */
  at: { readonly path: string; readonly line: number | null } | null
  onOpen: (path: string, line: number) => void
  onClose: () => void
}) {
  const result = useAtomValue(query("git.symbol", h, { id, name: looked.name, path: looked.from }, { focus: true }))
  return (
    <div className="flex min-h-0 flex-1 flex-col" aria-label="Symbol">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-fg">{looked.name}</span>
        <IconButton title="Close (Esc)" onClick={onClose}>
          <X size={14} />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 overflow-auto pb-3 text-[12px]">
        <Loading result={result} waiting={<div className="px-3 py-2 text-faint">Searching…</div>}>
          {(r) => {
            const defs = r.hits.filter((x) => x.definition)
            const refs = r.hits.filter((x) => !x.definition)
            return (
              <>
                <Section title="Definitions" hits={defs} name={r.name} at={at} empty="No definition found." onOpen={onOpen} />
                <Section title="References" hits={refs} name={r.name} at={at} empty="No other uses." onOpen={onOpen} />
                {r.truncated && <div className="px-3 pt-2 text-[11px] text-faint">Only the first 1,000 lines are shown.</div>}
                <div className="px-3 pt-3 text-[11px] text-faint">
                  Found by searching for the name as a word, so a definition is a line that looks like one.
                </div>
              </>
            )
          }}
        </Loading>
      </div>
    </div>
  )
}

function Section({
  title,
  hits,
  name,
  at,
  empty,
  onOpen,
}: {
  title: string
  hits: ReadonlyArray<GitSymbolHit>
  name: string
  at: { readonly path: string; readonly line: number | null } | null
  empty: string
  onOpen: (path: string, line: number) => void
}) {
  // By file, in the order they came.
  const files = useMemo(() => {
    const by = new Map<string, Array<GitSymbolHit>>()
    for (const x of hits) by.set(x.path, [...(by.get(x.path) ?? []), x])
    return [...by]
  }, [hits])
  return (
    <section className="pt-2">
      <h3 className="px-3 pb-1 text-[11px] font-medium tracking-wide text-faint uppercase">
        {title} <span className="font-normal">{hits.length}</span>
      </h3>
      {files.length === 0 && <div className="px-3 text-faint">{empty}</div>}
      {files.map(([path, list]) => (
        <div key={path} className="pb-1">
          <div className="flex min-w-0 items-baseline gap-1.5 px-3 pt-1" title={path}>
            <span className="shrink-0 text-muted">{baseName(path)}</span>
            <span className="truncate text-[11px] text-faint">{path.slice(0, path.length - baseName(path).length)}</span>
          </div>
          {list.map((x) => (
            <button
              key={x.line}
              onClick={() => onOpen(x.path, x.line)}
              className={
                at?.path === x.path && at.line === x.line
                  ? "flex w-full gap-2 bg-accent/20 px-3 py-0.5 text-left font-mono text-[11.5px] text-fg"
                  : "flex w-full gap-2 px-3 py-0.5 text-left font-mono text-[11.5px] text-muted hover:bg-raised hover:text-fg"
              }
            >
              <span className="w-[4ch] shrink-0 text-right text-faint">{x.line}</span>
              <HitText hit={x} name={name} />
            </button>
          ))}
        </div>
      ))}
    </section>
  )
}

/** A hit's line without its indent, the name marked. */
function HitText({ hit, name }: { hit: GitSymbolHit; name: string }) {
  const indent = hit.text.length - hit.text.trimStart().length
  const text = hit.text.slice(indent)
  const col = hit.column - indent
  if (hit.column < 0 || col < 0) return <span className="min-w-0 truncate">{text}</span>
  return (
    <span className="min-w-0 truncate whitespace-pre">
      {text.slice(0, col)}
      <span className={MARK}>{text.slice(col, col + name.length)}</span>
      {text.slice(col + name.length)}
    </span>
  )
}

/** The names the file defines, indented as they are in it; a click goes to one. */
export function OutlinePanel({
  h,
  id,
  path,
  reads,
  line,
  onLine,
  onClose,
}: {
  h: string
  id: TaskId
  path: string
  reads: QueryOptions
  line: number | null
  onLine: (line: number) => void
  onClose: () => void
}) {
  const result = useAtomValue(query("git.readFile", h, { id, path }, reads))
  const [filter, setFilter] = useState("")
  return (
    <div className="flex min-h-0 flex-1 flex-col" aria-label="Outline">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <span className="min-w-0 flex-1 text-[12px] text-fg">Symbols in this file</span>
        <IconButton title="Close" onClick={onClose}>
          <X size={14} />
        </IconButton>
      </div>
      <div className="px-2 pt-2">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter symbols"
          className="w-full rounded-md border border-line bg-bg px-2 py-1 text-[12px] text-fg outline-none placeholder:text-faint focus:border-accent/60"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-auto py-2 text-[12px]">
        <Loading result={result}>{(f) => <Outline text={f.text ?? ""} path={path} filter={filter} line={line} onLine={onLine} />}</Loading>
      </div>
    </div>
  )
}

function Outline({ text, path, filter, line, onLine }: { text: string; path: string; filter: string; line: number | null; onLine: (line: number) => void }) {
  const entries = useMemo(() => outline(text, path), [text, path])
  const q = filter.trim().toLowerCase()
  const shown = q ? entries.filter((e) => e.name.toLowerCase().includes(q)) : entries
  // Indents as steps: each distinct indent one deeper.
  const steps = useMemo(() => [...new Set(entries.map((e) => e.depth))].toSorted((a, b) => a - b), [entries])
  if (shown.length === 0) return <div className="px-3 text-faint">{entries.length === 0 ? "No symbols found." : "None match."}</div>
  return (
    <>
      {shown.map((e) => (
        <button
          key={e.line}
          onClick={() => onLine(e.line)}
          className={
            e.line === line
              ? "flex w-full items-baseline gap-2 bg-accent/20 py-0.5 pr-3 text-left font-mono text-[11.5px] text-fg"
              : "flex w-full items-baseline gap-2 py-0.5 pr-3 text-left font-mono text-[11.5px] text-muted hover:bg-raised hover:text-fg"
          }
          style={{ paddingLeft: `${12 + (q ? 0 : steps.indexOf(e.depth)) * 12}px` }}
        >
          <span className="min-w-0 flex-1 truncate">{e.name}</span>
          <span className="shrink-0 text-[10.5px] text-faint">{e.line}</span>
        </button>
      ))}
    </>
  )
}
