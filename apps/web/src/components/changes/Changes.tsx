// HE-96: the Changes tab, laid out as the Code tab is: the tree of the files the task changed on the left (the Code
// tab's, with its finder, `t`), and on the right the diff of the file picked, or all of them until one is. The changes
// are the task's own work against where it started, uncommitted and untracked files too (`git.taskDiff`), read again
// every few seconds as the agent may be making them. Each file opens in the Code tab, at its first change.
//
// Diffs are highlighted, unified or side by side (`|`), and lines in them can be commented on for the agent (pick them
// by their numbers, then `n` or a line's comment button): the comments wait in a review at the bottom, and in the
// thread's composer, until they're sent (see lineComments.ts).
import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react"
import { Atom } from "effect/reactivity"
import { clsx } from "clsx"
import { Copy, FileCode, FolderTree } from "lucide-react"
import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react"

import { query, type HostTask as Task } from "@huntaway/client"
import { TaskId, type DiffResult, type GitFile, type GitTree } from "@huntaway/contracts"
import { after } from "../../state/timers"
import { FileTree } from "../code/FileTree"
import { codeState, goTo } from "../code/state"
import { ancestors, buildTree, rows } from "../code/tree"
import { copyText, IconButton, Loading, resultValue, useConfirm } from "../ui"
import { CommentsContext, type CommentsApi } from "./DiffLines"
import { parseDiff, type FileDiff } from "./diffs"
import { clearReview, editComment, openDraft, useReview, type CommentLines } from "./lineComments"
import { layoutAtom } from "./git/model"
import { BranchHead, branchSource, LayoutToggle, Note, PatchView } from "./git/Patches"
import { ReviewBar } from "./git/ReviewBar"
import { useGitReads, useKept } from "./git/useGitStatus"

/** Below this width the tree and the diff take turns, as the Code tab's tree and file do. */
const NARROW = 760

/** The line of the file as it is now that its first change is at (a removal: the line after it). */
function firstChange(f: FileDiff): number | null {
  const h = f.hunks[0]
  if (!h) return null
  const i = h.lines.findIndex((l) => l.kind !== " ")
  const at = h.lines.slice(Math.max(0, i)).find((l) => l.new !== undefined)
  return at?.new ?? Math.max(1, h.newStart)
}

/** Where the tab is, by host and task, kept for the page's life as the Code tab's is: the file picked, the folders closed. */
interface ChangesPlace {
  readonly at: string | null
  readonly closed: ReadonlySet<string>
}
const START: ChangesPlace = { at: null, closed: new Set() }
const changesState = Atom.family((_key: string) => Atom.make(START).pipe(Atom.keepAlive))

/** A changed file as the Code tab's tree marks it: added, deleted, renamed or changed. */
const asChanged = (f: FileDiff): GitFile => ({
  path: f.path,
  orig_path: f.oldPath !== f.newPath ? f.oldPath : null,
  x: f.oldPath === null ? "A" : f.newPath === null ? "D" : f.oldPath !== f.newPath ? "R" : "M",
  y: " ",
})

export function ChangesView({ task, onShowCode }: { task: Task; onShowCode: () => void }) {
  return <ChangesTree key={`${task.host_id}:${task.id}`} task={task} onShowCode={onShowCode} />
}

function ChangesTree({ task, onShowCode }: { task: Task; onShowCode: () => void }) {
  const [h, id] = [task.host_id, task.id]
  const reads = useGitReads(false)
  const result = useAtomValue(query("git.taskDiff", h, { id: TaskId.make(id) }, reads))
  // The same diff (most reads): the same object, so what's picked in it stays.
  const diff = useKept(resultValue(result))
  const files = useMemo(() => parseDiff(diff?.patch ?? ""), [diff])
  const byPath = useMemo(() => new Map(files.map((f) => [f.path, f])), [files])
  // New files whose contents the diff hasn't (only the first 50's are read), listed all the same.
  const unread = useMemo(() => new Set((diff?.untracked ?? []).filter((p) => !byPath.has(p))), [diff, byPath])
  const paths = useMemo(() => [...files.map((f) => f.path), ...unread], [files, unread])
  const tree = useMemo<GitTree>(() => ({ available: true, files: paths, folder: null, truncated: false }), [paths])
  const changed = useMemo(() => [...files.map(asChanged), ...[...unread].map((path) => ({ path, orig_path: null, x: "A", y: " " }))], [files, unread])
  // The diff was cut (at 2 MB): the files after the cut aren't in it, nor in the tree.
  const cut = diff?.patch?.includes("\n… [truncated") ?? false
  const [{ at, closed }, setPlace] = useAtom(changesState(`${h}:${id}`))
  const setAt = (path: string | null) => setPlace((p) => ({ ...p, at: path }))
  // Every folder open, but those closed.
  const open = useMemo(() => new Set(paths.flatMap(ancestors).filter((f) => !closed.has(f))), [paths, closed])
  // The files in the tree's order, for `j`/`k`.
  const order = useMemo(
    () =>
      rows(buildTree(paths, null), new Set(paths.flatMap(ancestors)))
        .filter((r) => r.kind === "file")
        .map((r) => r.path),
    [paths],
  )
  const file = at === null ? undefined : byPath.get(at)
  // A new file picked whose contents the diff hasn't.
  const unreadAt = at !== null && unread.has(at) ? at : null
  const pickedPath = file?.path ?? unreadAt
  const shownFiles = useMemo(() => (file ? [file] : files), [file, files])
  const [layout, setLayout] = useAtom(layoutAtom)
  const toggleLayout = () => setLayout(layout === "split" ? "unified" : "split")
  const source = useMemo(() => branchSource(diff?.base), [diff?.base])
  const setCode = useAtomSet(codeState(`${h}:${id}`))
  const openPath = (path: string, line: number | null) => {
    setCode((s) => goTo(s, { path, line }))
    onShowCode()
  }
  const openInCode = (f: FileDiff) => openPath(f.path, firstChange(f))

  const root = useRef<HTMLDivElement>(null)
  const filterRef = useRef<HTMLInputElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const [narrow, setNarrow] = useState(false)
  const [treeShown, setTreeShown] = useState(true)
  const [findAsked, setFindAsked] = useState(0)
  const [flash, setFlash] = useState<string | null>(null)
  useLayoutEffect(() => {
    if (findAsked > 0) filterRef.current?.focus()
  }, [findAsked])
  useLayoutEffect(() => {
    const el = root.current
    if (!el) return undefined
    const ro = new ResizeObserver(([e]) => {
      if (e) setNarrow(e.contentRect.width < NARROW)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  useEffect(() => {
    if (!flash) return undefined
    return after("4 seconds", () => setFlash(null))
  }, [flash])
  const focusView = useCallback(() => root.current?.focus({ preventScroll: true }), [])
  useEffect(focusView, [focusView])
  const pickFile = (path: string | null) => {
    setAt(path)
    // The button clicked for it may be gone now ("All changes"), which would leave the focus nowhere.
    focusView()
    if (path !== null) setTreeShown(false)
    scroller.current?.scrollTo({ top: 0 })
  }

  // Comments for the agent: the task's review, the draft to focus, and the lines picked in a diff (see PatchView).
  const review = useReview(h, id)
  const [focusDraft, setFocusDraft] = useState<{ id: string } | null>(null)
  const picked = useRef<{ owner: object; comment: () => void } | null>(null)
  const [pickOwner, setPickOwner] = useState<object | null>(null)
  const pickLines = useCallback((owner: object, comment: (() => void) | null) => {
    if (comment) picked.current = { owner, comment }
    else if (picked.current?.owner === owner) picked.current = null
    else return
    setPickOwner(comment ? owner : null)
  }, [])
  const comments = useMemo<CommentsApi>(
    () => ({
      hostId: h,
      taskId: id,
      review,
      focus: focusDraft,
      open: (lines) => {
        if (lines) setFocusDraft({ id: openDraft(h, id, lines) })
      },
      edit: (c) => {
        const draftId = editComment(h, id, c)
        if (draftId) setFocusDraft({ id: draftId })
      },
      done: () => {
        setFocusDraft(null)
        root.current?.focus({ preventScroll: true })
      },
      pickOwner,
      pick: pickLines,
    }),
    [h, id, review, focusDraft, pickOwner, pickLines],
  )
  // A comment in the review: to its file's diff, and scrolled to once it's drawn.
  const [jump, setJump] = useState<string | null>(null)
  const jumpTo = (c: CommentLines, anchorId: string) => {
    pickFile(byPath.has(c.path) ? c.path : null)
    setJump(anchorId)
  }
  const jumpNow = useEffectEvent(() => {
    if (!jump) return
    const el = root.current?.querySelector(`[data-comment="${CSS.escape(jump)}"]`)
    if (!el) return
    el.scrollIntoView({ block: "center" })
    setJump(null)
  })
  useEffect(() => jumpNow())
  // Off the jump once the diff it's in has come and it isn't there (outdated, or on lines not shown).
  useEffect(() => {
    if (!jump) return undefined
    return after("3 seconds", () => setJump(null))
  }, [jump])
  const { ask, dialog } = useConfirm()
  const discardReview = () =>
    ask({
      title: "Discard the comments",
      body: `Throw away ${review.comments.length + review.drafts.length === 1 ? "the comment for the agent, which hasn't" : "all the comments for the agent that haven't"} been sent?`,
      action: "Discard",
      danger: true,
      onConfirm: () => clearReview(h, id),
    })

  const onKey = (e: ReactKeyboardEvent) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.metaKey || e.ctrlKey || e.altKey) return
    // A dialog open over the view (Discard the comments) has the keys.
    if (dialog || (e.target instanceof Element && e.target.closest("[data-modal]"))) return
    const step = (by: number) => {
      const i = at === null ? -1 : order.indexOf(at)
      const next = order[Math.max(0, Math.min(order.length - 1, i < 0 ? (by > 0 ? 0 : order.length - 1) : i + by))]
      if (next !== undefined) pickFile(next)
    }
    const keys: Record<string, () => void> = {
      t: () => {
        setTreeShown(true)
        setFindAsked((n) => n + 1)
      },
      j: () => step(1),
      k: () => step(-1),
      "|": toggleLayout,
      n: () =>
        picked.current
          ? picked.current.comment()
          : setFlash("Pick lines by their numbers first (drag or shift-click for more), or use a line's comment button"),
      Escape: () => (at !== null ? pickFile(null) : undefined),
    }
    const run = keys[e.key]
    if (!run || (e.key === "Escape" && at === null)) return
    e.preventDefault()
    e.stopPropagation()
    run()
  }

  const treeView = (
    <Loading result={result}>
      {(d: DiffResult) =>
        d.available ? (
          <FileTree
            tree={tree}
            changed={changed}
            open={open}
            at={at}
            filterRef={filterRef}
            showIgnored={false}
            empty="No changes yet."
            onOpen={(p) => {
              pickFile(p)
              focusView()
            }}
            onToggle={(f) =>
              setPlace((p) => {
                const next = new Set(p.closed)
                if (!next.delete(f)) next.add(f)
                return { ...p, closed: next }
              })
            }
          />
        ) : (
          <div className="p-3 text-[12.5px] text-muted">No changes to show: {d.reason ?? "not a git repository"}.</div>
        )
      }
    </Loading>
  )

  return (
    <div
      ref={root}
      tabIndex={-1}
      // The keys that work on every page leave this view's alone (usePageShortcuts).
      data-own-keys
      onKeyDown={onKey}
      // Keys go to the view after a click anywhere in it (a line number picked doesn't take the focus), but in a field,
      // a dialog or a menu.
      onMouseDownCapture={(e) => {
        if (!(e.target instanceof Element && e.target.closest("input, textarea, [data-modal], [role^=menu]"))) focusView()
      }}
      className="flex h-full min-h-0 flex-col outline-none"
      data-testid="changes-view"
    >
      <CommentsContext.Provider value={comments}>
        <div className="flex min-h-0 flex-1">
          {(!narrow || treeShown) && (
            <aside className={clsx("flex min-h-0 flex-col border-r border-line", narrow ? "w-full" : "w-64 shrink-0")}>
              {cut && (
                <div className="shrink-0 border-b border-line px-3 py-1.5 text-[11.5px] text-amber-300" role="note">
                  The diff is too big to read whole: the files after its first 2 MB aren&apos;t listed.
                </div>
              )}
              {treeView}
            </aside>
          )}
          {(!narrow || !treeShown) && (
            <div className="flex min-w-0 flex-1 flex-col">
              <div className="flex h-9 shrink-0 items-center gap-1 border-b border-line px-2">
                {narrow && (
                  <IconButton
                    title="Files"
                    onClick={() => {
                      setTreeShown(true)
                      focusView()
                    }}
                  >
                    <FolderTree size={14} />
                  </IconButton>
                )}
                {pickedPath !== null ? (
                  <>
                    <button
                      className="shrink-0 text-[12px] text-muted hover:text-fg hover:underline"
                      onClick={() => pickFile(null)}
                      title="All the changes (Esc)"
                    >
                      All changes
                    </button>
                    <span className="shrink-0 px-1 text-faint">/</span>
                    <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-fg" title={pickedPath} data-testid="changes-path">
                      {pickedPath}
                    </span>
                    {file && (
                      <span className="shrink-0 px-1 font-mono text-[11px]">
                        <span className="text-emerald-400">+{file.adds}</span> <span className="text-red-400">−{file.dels}</span>
                      </span>
                    )}
                    <IconButton title="Copy the path" onClick={() => copyText(pickedPath)}>
                      <Copy size={13} />
                    </IconButton>
                    {(file ? file.newPath !== null : true) && (
                      <IconButton title="Open in the Code tab" onClick={() => (file ? openInCode(file) : openPath(pickedPath, null))}>
                        <FileCode size={14} />
                      </IconButton>
                    )}
                  </>
                ) : (
                  <span className="min-w-0 flex-1 truncate text-[12px] text-muted">
                    {diff?.available
                      ? `${paths.length}${cut ? "+" : ""} file${paths.length === 1 ? "" : "s"} changed${diff.base ? ` against ${diff.base}` : ""}`
                      : "Changes"}
                  </span>
                )}
                <span className="shrink-0 font-mono text-[11px]">
                  <LayoutToggle layout={layout} onToggle={toggleLayout} />
                </span>
              </div>
              <div ref={scroller} className="@container min-h-0 flex-1 overflow-auto bg-bg py-1.5 font-mono text-[12px] leading-[18px]">
                {diff && !diff.available ? (
                  <Note error>Diff unavailable: {diff.reason}</Note>
                ) : unreadAt !== null ? (
                  <div className="px-1.5 font-sans text-[13px] text-muted">
                    A new file. Its contents aren&apos;t in the diff, which reads only the first 50 new files and its first 2 MB:{" "}
                    <button className="text-accent hover:underline" onClick={() => openPath(unreadAt, null)}>
                      open it in the Code tab
                    </button>{" "}
                    to see it.
                  </div>
                ) : (
                  diff && (
                    <PatchView
                      files={shownFiles}
                      layout={layout}
                      source={source}
                      empty="No changes yet."
                      head={!file && <BranchHead diff={diff} />}
                      onOpenFile={openInCode}
                    />
                  )
                )}
              </div>
            </div>
          )}
        </div>
        <ReviewBar task={task} review={review} onJump={jumpTo} onDiscard={discardReview} onError={setFlash} />
        {flash && (
          <div className="shrink-0 border-t border-line px-3 py-1 text-[11.5px] text-muted" role="status">
            {flash}
          </div>
        )}
      </CommentsContext.Provider>
      {dialog}
    </div>
  )
}
