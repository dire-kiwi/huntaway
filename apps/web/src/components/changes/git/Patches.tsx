// Diffs as the Changes tab shows them: several files' (the branch's, a review round's), each folded under its header,
// with lines picked by their numbers to comment on.
import { clsx } from "clsx"
import { useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { FileCode } from "lucide-react"
import type { DiffResult } from "@huntaway/contracts"
import { parseDiff, type FileDiff } from "../diffs"
import { commentLines, type CommentSource } from "../lineComments"
import { CommentsContext, DiffLines, diffRows, type Layout, type PickHow } from "../DiffLines"

/** Each of a list's items with its place in it: for lines, which have no other identity, to key them by. */
const numbered = <T,>(items: ReadonlyArray<T>) => items.map((item, n) => ({ item, n }))

/** Diffs this big start folded. */
const big = (f: FileDiff) => f.adds + f.dels > 1500

/** A diff with no lines to stage (a conflict's, a binary file's), as it is. */
export function RawDiff({ file }: { file: FileDiff }) {
  const lines = file.combined ? file.raw : file.header.slice(1)
  return (
    <div className="w-max min-w-full px-1.5 whitespace-pre">
      {file.binary && <div className="text-muted">Binary file: stage or discard it whole from the files panel.</div>}
      {file.combined && <div className="mb-1 text-amber-300">A conflict: resolve it in the file, then stage it from the files panel.</div>}
      {numbered(lines).map(({ item: l, n }) => (
        <div
          key={n}
          className={clsx(
            /^(\+\+|\+ | \+)/.test(l) ? "text-emerald-300" : /^(--|- | -)/.test(l) ? "text-red-300" : l.startsWith("@@") ? "text-accent" : "text-[#b4b4c4]",
          )}
        >
          {l || " "}
        </div>
      ))}
    </div>
  )
}

/**
 * Several files' diffs (a commit's, the branch's), each under a header that folds it away. With a `source`, lines
 * are picked by their numbers (drag or shift-click for more) and commented on for the agent.
 */
export function PatchView({
  files,
  head,
  empty,
  layout,
  source,
  onOpenFile,
}: {
  files: FileDiff[]
  head?: ReactNode
  empty: string
  layout: Layout
  source?: CommentSource | undefined
  /** A button on each file's header (but a deleted one's) that opens it in the Code tab. */
  onOpenFile?: ((f: FileDiff) => void) | undefined
}) {
  const [folded, setFolded] = useState<Record<string, boolean>>({})
  const isFolded = (f: FileDiff, i: number) => folded[`${i}:${f.path}`] ?? big(f)
  const refs = useRef<(HTMLDivElement | null)[]>([])
  // The lines picked: in which file, and from which row to which (rows as DiffLines counts them).
  const [sel, setSel] = useState<{ file: number; anchor: number; cursor: number } | null>(null)
  const dragging = useRef(false)
  const comments = useContext(CommentsContext)
  const [me] = useState(() => ({}))
  // Comments need the view's (not there for a host from before it).
  if (!comments) source = undefined
  // Files that change (a refresh) or a new patch: nothing picked (state adjusted during render).
  const [forFiles, setForFiles] = useState(files)
  if (forFiles !== files) {
    setForFiles(files)
    setSel(null)
  }
  const commentOn = (k: number, from: number, to: number) => {
    const f = files[k]
    if (!f || !source || !comments) return
    const rows = diffRows(f).slice(Math.min(from, to), Math.max(from, to) + 1)
    comments.open(
      commentLines(
        f,
        source,
        rows.filter((r) => r.line >= 0),
      ),
    )
    setSel(null)
  }
  // `n` comments on what's picked here, until another diff picks lines.
  const { pick, pickOwner } = comments ?? {}
  useEffect(() => {
    if (!pick) return
    pick(me, sel ? () => commentOn(sel.file, sel.anchor, sel.cursor) : null)
  })
  useEffect(() => () => pick?.(me, null), [pick, me])
  // Another diff picked lines: none here (state adjusted during render).
  if (sel && pickOwner && pickOwner !== me) setSel(null)
  useEffect(() => {
    const up = () => void (dragging.current = false)
    window.addEventListener("mouseup", up)
    return () => window.removeEventListener("mouseup", up)
  }, [])
  const onLine = (k: number, i: number, how: PickHow) => {
    if (how === "enter") {
      if (dragging.current) setSel((s) => (s && s.file === k ? { ...s, cursor: i } : s))
      return
    }
    if (how === "shift") {
      setSel((s) => (s && s.file === k ? { ...s, cursor: i } : { file: k, anchor: i, cursor: i }))
      return
    }
    dragging.current = true
    setSel({ file: k, anchor: i, cursor: i })
  }
  const chosen = useMemo(() => {
    if (!sel) return null
    const set = new Set<number>()
    for (let i = Math.min(sel.anchor, sel.cursor); i <= Math.max(sel.anchor, sel.cursor); i++) set.add(i)
    return set
  }, [sel])
  return (
    <div className="min-w-full">
      {head}
      {!files.length && <div className="px-1.5 text-faint">{empty}</div>}
      {files.length > 1 && (
        <div className="mb-2 px-1.5">
          <div className="text-faint">
            {files.length} files changed, <span className="text-emerald-400">+{files.reduce((a, f) => a + f.adds, 0)}</span>{" "}
            <span className="text-red-400">−{files.reduce((a, f) => a + f.dels, 0)}</span>
          </div>
          {numbered(files).map(({ item: f, n: i }) => (
            <div key={i} className="flex cursor-pointer gap-2 hover:bg-white/5" onClick={() => refs.current[i]?.scrollIntoView({ block: "start" })}>
              <span className="min-w-0 flex-1 truncate text-muted">{fileLabel(f)}</span>
              <span className="shrink-0 text-emerald-400">+{f.adds}</span>
              <span className="w-[6ch] shrink-0 text-red-400">−{f.dels}</span>
            </div>
          ))}
        </div>
      )}
      {files.map((f, i) => {
        const k = `${i}:${f.path}`
        const fold = isFolded(f, i)
        return (
          <div key={k} ref={(el) => void (refs.current[i] = el)} data-file={f.path}>
            <div
              data-file-head
              onClick={() => setFolded((s) => ({ ...s, [k]: !fold }))}
              className="sticky top-[-6px] z-10 flex cursor-pointer gap-2 border-y border-line bg-panel-2 px-1.5"
            >
              <span className="text-faint">{fold ? "▶" : "▼"}</span>
              <span className="min-w-0 flex-1 truncate text-fg">{fileLabel(f)}</span>
              <span className="shrink-0 text-emerald-400">+{f.adds}</span>
              <span className="shrink-0 text-red-400">−{f.dels}</span>
              {onOpenFile && f.newPath !== null && (
                <button
                  tabIndex={-1}
                  title="Open in the Code tab"
                  aria-label={`Open ${f.path} in the Code tab`}
                  onClick={(e) => {
                    e.stopPropagation()
                    onOpenFile(f)
                  }}
                  className="shrink-0 text-faint hover:text-fg"
                >
                  <FileCode size={12} />
                </button>
              )}
            </div>
            {!fold && (
              <div className={clsx("py-0.5", layout === "split" ? "w-full" : "w-max min-w-full")}>
                {f.binary ? (
                  <div className="px-1.5 text-muted">Binary file</div>
                ) : f.combined || !f.hunks.length ? (
                  <RawDiff file={f} />
                ) : (
                  <DiffLines
                    file={f}
                    layout={layout}
                    source={source}
                    chosen={sel?.file === i ? chosen : null}
                    pick={source ? "numbers" : null}
                    onLine={(row, how) => onLine(i, row, how)}
                    onComment={(row) => (sel?.file === i && chosen?.has(row) ? commentOn(i, sel.anchor, sel.cursor) : commentOn(i, row, row))}
                  />
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

const fileLabel = (f: FileDiff) =>
  f.oldPath && f.newPath && f.oldPath !== f.newPath
    ? `${f.oldPath} → ${f.newPath}`
    : f.oldPath === null
      ? `${f.path} (new)`
      : f.newPath === null
        ? `${f.path} (deleted)`
        : f.path

/** A patch shown as the Changes tab shows one, for elsewhere (the review tab's rounds of fixes). */
export function PatchBox({ patch, empty }: { patch: string; empty: string }) {
  const files = useMemo(() => parseDiff(patch), [patch])
  return (
    <div className="max-h-[480px] overflow-auto rounded-md border border-line bg-bg py-1.5 font-mono text-[12px] leading-[18px]">
      <PatchView files={files} empty={empty} layout="unified" />
    </div>
  )
}

/** What comments on the branch's changes are on. */
export const branchSource = (base: string | null | undefined): CommentSource => ({
  key: "branch",
  label: base ? `the branch's changes against ${base}, uncommitted ones too` : "the branch's changes",
})

/** Where the branch's changes are from, and its commits. */
export function BranchHead({ diff }: { diff: DiffResult }) {
  return (
    <div className="mb-2 px-1.5">
      {diff.merge_base && (
        <div className="text-faint">
          From {diff.merge_base.slice(0, 8)} on {diff.base}
          {diff.branch ? `: the commits on ${diff.branch} (the task has no worktree)` : ", with uncommitted changes"}
        </div>
      )}
      {diff.commits?.trim() && <div className="mt-1 whitespace-pre-wrap text-muted">{diff.commits.trim()}</div>}
      {diff.patch?.includes("\n… [truncated") && <div className="mt-1 text-amber-300">The diff is too big to show all of it.</div>}
    </div>
  )
}

/** The branch's changes against its base: its commits, and everything changed (uncommitted work too). */
export function BranchView({ diff, layout }: { diff: DiffResult | null; layout: Layout }) {
  const files = useMemo(() => parseDiff(diff?.patch ?? ""), [diff])
  const base = diff?.base
  const source = useMemo(() => branchSource(base), [base])
  if (!diff) return null
  if (!diff.available) return <Note error>Diff unavailable: {diff.reason}</Note>
  return <PatchView files={files} layout={layout} source={source} empty="No changes yet." head={<BranchHead diff={diff} />} />
}

/** Unified or side-by-side diffs (`|`). */
export function LayoutToggle({ layout, onToggle }: { layout: Layout; onToggle: () => void }) {
  return (
    <span className="flex gap-0.5" title="Unified or split diffs (|)">
      {(["unified", "split"] as Layout[]).map((l) => (
        <button
          key={l}
          tabIndex={-1}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => l !== layout && onToggle()}
          className={clsx("rounded px-1", l === layout ? "bg-white/10 text-fg" : "text-faint hover:text-muted")}
        >
          {l}
        </button>
      ))}
    </span>
  )
}

export function Note({ children, error }: { children: ReactNode; error?: boolean }) {
  return <div className={clsx("px-1.5 text-[12px]", error ? "text-red-400" : "text-muted")}>{children}</div>
}
