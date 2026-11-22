// HE-79: the Code tab's file tree, with a finder over it (`t` goes to it): the working tree's files, folders open as
// they're clicked, and the files with changes marked as the Changes tab lists them.
import type { GitFile, GitTree } from "@huntaway/contracts"
import { clsx } from "clsx"
import { ChevronDown, ChevronRight, FileText, Search } from "lucide-react"
import { memo, useDeferredValue, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react"
import { baseName, ancestors, buildTree, findFiles, rows, type Row } from "./tree"

/** A file's change as one letter, and its colour; folders with changes in them get a dot. */
function changeOf(f: GitFile): { readonly letter: string; readonly className: string } {
  if (f.x === "?" || f.x === "A") return { letter: f.x === "?" ? "U" : "A", className: "text-emerald-400" }
  if (f.x === "U" || f.y === "U") return { letter: "!", className: "text-red-400" }
  if (f.x === "R" || f.y === "R") return { letter: "R", className: "text-sky-400" }
  return { letter: "M", className: "text-amber-300" }
}

export function FileTree({
  tree,
  changed,
  open,
  at,
  filterRef,
  onOpen,
  onToggle,
}: {
  tree: GitTree
  changed: ReadonlyArray<GitFile>
  open: ReadonlySet<string>
  at: string | null
  filterRef: RefObject<HTMLInputElement | null>
  onOpen: (path: string) => void
  onToggle: (folder: string) => void
}) {
  const [filter, setFilter] = useState("")
  const [pick, setPick] = useState(0)
  const query = useDeferredValue(filter)
  const folder = tree.folder ?? null
  const root = useMemo(() => buildTree(tree.files, folder), [tree.files, folder])
  const shown = useMemo(() => rows(root, open), [root, open])
  const found = useMemo(() => findFiles(tree.files, query), [tree.files, query])
  const marks = useMemo(() => {
    const files = new Map(changed.map((f) => [f.path, changeOf(f)]))
    const folders = new Set(changed.flatMap((f) => ancestors(f.path)))
    return { files, folders }
  }, [changed])
  const finding = query.trim() !== ""
  const shownPick = Math.min(pick, Math.max(0, found.length - 1))

  const onKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault()
      setPick(Math.max(0, Math.min(found.length - 1, shownPick + (e.key === "ArrowDown" ? 1 : -1))))
    } else if (e.key === "Enter") {
      // What's typed, though the list may not have caught up with it yet.
      const p = (query === filter ? found : findFiles(tree.files, filter))[shownPick]
      if (p) {
        onOpen(p)
        setFilter("")
      }
    } else if (e.key === "Escape" && filter) {
      e.preventDefault()
      e.stopPropagation()
      setFilter("")
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="p-2">
        <label className="flex items-center gap-1.5 rounded-md border border-line bg-bg px-2 py-1 focus-within:border-accent/60">
          <Search size={12} className="shrink-0 text-faint" />
          <input
            ref={filterRef}
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value)
              setPick(0)
            }}
            onKeyDown={onKey}
            placeholder="Go to file"
            aria-label="Go to file"
            className="min-w-0 flex-1 bg-transparent text-[12px] text-fg outline-none placeholder:text-faint"
          />
          {!filter && <kbd className="rounded border border-line px-1 text-[10px] text-faint">t</kbd>}
        </label>
      </div>
      <div className="min-h-0 flex-1 overflow-auto pb-2 text-[12.5px]" role="tree" aria-label="Files">
        {finding ? (
          found.length === 0 ? (
            <div className="px-3 py-2 text-faint">No file matches.</div>
          ) : (
            found.map((p, i) => (
              <button
                key={p}
                onClick={() => {
                  onOpen(p)
                  setFilter("")
                }}
                onMouseEnter={() => setPick(i)}
                className={clsx("flex w-full min-w-0 items-baseline gap-2 px-3 py-0.5 text-left", i === shownPick ? "bg-raised text-fg" : "text-muted")}
              >
                <span className="shrink-0">{baseName(p)}</span>
                <span className="truncate text-[11px] text-faint">{p.slice(folder?.length ?? 0, p.length - baseName(p).length)}</span>
              </button>
            ))
          )
        ) : (
          shown.map((r) => (
            <TreeRow
              key={`${r.kind}:${r.path}`}
              row={r}
              selected={r.path === at}
              mark={r.kind === "file" ? (marks.files.get(r.path) ?? null) : null}
              dot={r.kind === "folder" && marks.folders.has(r.path)}
              onOpen={onOpen}
              onToggle={onToggle}
            />
          ))
        )}
        {tree.truncated && <div className="px-3 py-2 text-[11px] text-faint">Only the first 50,000 files are listed.</div>}
        {!finding && tree.files.length === 0 && <div className="px-3 py-2 text-faint">No files.</div>}
      </div>
    </div>
  )
}

const TreeRow = memo(function TreeRow({
  row: r,
  selected,
  mark,
  dot,
  onOpen,
  onToggle,
}: {
  row: Row
  selected: boolean
  mark: { readonly letter: string; readonly className: string } | null
  dot: boolean
  onOpen: (path: string) => void
  onToggle: (folder: string) => void
}) {
  const folder = r.kind === "folder"
  return (
    <button
      role="treeitem"
      aria-expanded={folder ? r.open : undefined}
      aria-selected={selected}
      title={r.path}
      onClick={() => (folder ? onToggle(r.path) : onOpen(r.path))}
      className={clsx(
        "flex w-full min-w-0 items-center gap-1 py-[3px] pr-2 text-left",
        selected ? "bg-accent/20 text-fg" : "text-muted hover:bg-raised hover:text-fg",
      )}
      style={{ paddingLeft: `${8 + r.depth * 12}px` }}
    >
      {folder ? (
        r.open ? (
          <ChevronDown size={13} className="shrink-0 text-faint" />
        ) : (
          <ChevronRight size={13} className="shrink-0 text-faint" />
        )
      ) : (
        <FileText size={12} className="mx-[0.5px] shrink-0 text-faint" />
      )}
      <span className={clsx("min-w-0 flex-1 truncate", mark?.className)}>{r.name}</span>
      {mark && <span className={clsx("shrink-0 text-[10.5px] font-medium", mark.className)}>{mark.letter}</span>}
      {dot && <span className="size-1.5 shrink-0 rounded-full bg-amber-300/70" title="Has changes" />}
    </button>
  )
})
