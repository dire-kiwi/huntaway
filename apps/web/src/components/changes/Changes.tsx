// The Changes tab: a lazygit-style view of a task's repository. Panels down the left list the
// branch (Status), the changed files, the commits and the stashes; the main panel on the right shows
// what's selected in them. Files and folders are staged, discarded and committed from the files
// panel, and a file's lines from the main panel (Enter goes into it): space stages or unstages the
// line under the cursor, `v` selects a range of lines and `a` the whole hunk. `?` lists the keys,
// and the bar at the bottom shows (and does) the ones for where you are.
//
// Diffs are highlighted, unified or side by side (`|`), and lines in them can be commented on for the agent (`n`,
// or a line's comment button): the comments wait in a review at the bottom, and in the thread's composer, until
// they're sent (see lineComments.ts).
import { useAtom } from "@effect/atom-react"
import { clsx } from "clsx"
import { Loader2 } from "lucide-react"
import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react"

import { invalidateGroups, type HostTask as Task } from "@huntaway/client"
import type { Turn } from "@huntaway/contracts"
import { runExit } from "../../state/mutation"
import { after } from "../../state/timers"
import { untracked } from "./diffs"
import { clearReview, commentLines, editComment, openDraft, useReview, type CommentLines, type CommentSource } from "./lineComments"
import { hasTurns, useTurns } from "../task/turns"
import { CommentsContext, type CommentsApi } from "./DiffLines"
import { RewindDialog } from "../task/Rewind"
import { rewound } from "../task/thread/Composer"
import { ContextMenu, type MenuItem } from "../ui"
import { DialogView, OptionsBar } from "./git/Dialogs"
import { MainPanel } from "./git/MainPanel"

import { ReviewBar } from "./git/ReviewBar"
import { SidePanels } from "./git/SidePanels"
import { useFileDiffs } from "./git/useFileDiffs"
import { useGitActions } from "./git/useGitActions"
import { useGitKeys } from "./git/useGitKeys"
import { useGitSelection } from "./git/useGitSelection"
import { useGitReads, useGitStatus } from "./git/useGitStatus"
import { useShownDiffs } from "./git/useShownDiffs"
import { useStaging } from "./git/useStaging"
import { layoutAtom, NOT_UTF8, SIDES, stageRows, STAGED, toggled, UNSTAGED, type Dialog, type Option, type Pane, type Side } from "./git/model"

// Step 1 (docs/plan/09-frontend.md, "Step 1 as done for changes/"): every host on this server has the Changes tab's git
// methods, so the old view of a host from before them (the branch's whole diff alone) is gone.

export function ChangesView({ task }: { task: Task }) {
  return <GitView key={task.id} task={task} />
}

/**
 * The view: its state is in hooks (the repository's status, where you are and what's selected, the selected file's
 * diffs and the lines picked in them, what the main panel shows, the actions and the keys), drawn by SidePanels and
 * MainPanel.
 */
function GitView({ task }: { task: Task }) {
  const [h, id] = [task.host_id, task.id]
  // The agent's turns, from their checkpoints (API 70): a fifth panel.
  const turns = useTurns(task)
  const sides: Side[] = hasTurns(task) ? [...SIDES, "turns"] : SIDES
  const [rewinding, setRewinding] = useState<Turn | null>(null)
  const busyRef = useRef(false)
  const queuedRef = useRef<[string, boolean][]>([])
  const [flash, setFlash] = useState<{ text: string; error?: boolean } | null>(null)
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; title: string; items: MenuItem[] } | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const [focused, setFocused] = useState(false)
  const [narrow, setNarrow] = useState(false)
  const [layout, setLayout] = useAtom(layoutAtom)
  const focusRoot = useCallback(() => root.current?.focus({ preventScroll: true }), [])
  // What's being done (a change), while the polls wait.
  const [busy, setBusy] = useState<string | null>(null)
  const reads = useGitReads(busy !== null)
  // Everything the tab reads, again (`R`): the host's `git.*` queries.
  const refresh = () => void runExit(invalidateGroups(h, ["git"]))

  const { status, loadErr } = useGitStatus(task, reads)
  const sel = useGitSelection(status, turns.data?.turns)
  const { side, setSide, inMain, setInMain, fileRow, setCollapsed, setFileKey, setCommitSha, setStashSha, setTurnN } = sel
  const target = side === "files" ? fileRow : undefined
  const d = useFileDiffs(h, id, target, reads)
  const staging = useStaging(target, d, sel, focusRoot)
  const { paneFile, hasPane, activePane, cur, anchor, setAnchor, hunkMode, setHunkMode } = staging
  const shown = useShownDiffs(h, id, sel, reads)
  const actions = useGitActions({ h, id, status, busy, setBusy, busyRef, sel, target, staging, setDialog, setFlash, setRewinding })

  // Comments for the agent: the task's review, the draft to focus, and the lines picked in a patch (see PatchView).
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
        if (!lines) return
        // What was typed after the key that opened it is the note's, not keys for the view.
        queuedRef.current = []
        setFocusDraft({ id: openDraft(h, id, lines) })
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

  useEffect(() => root.current?.focus({ preventScroll: true }), [])
  // Back to the view when a dialog closes (one opened from another, as a menu's can be, has nowhere to go back to).
  const dialogOpen = !!dialog || !!menu || !!rewinding
  const wasOpen = useRef(false)
  // Before the next key comes in, rather than once painted.
  useLayoutEffect(() => {
    if (wasOpen.current && !dialogOpen) root.current?.focus({ preventScroll: true })
    wasOpen.current = dialogOpen
  }, [dialogOpen])
  useLayoutEffect(() => {
    const el = root.current
    if (!el) return undefined
    const ro = new ResizeObserver(([e]) => {
      if (e) setNarrow(e.contentRect.width < 720)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  useEffect(() => {
    if (!flash || flash.error) return undefined
    return after("4 seconds", () => setFlash(null))
  }, [flash])

  const focusSide = (s: Side) => {
    setSide(s)
    setInMain(false)
    root.current?.focus({ preventScroll: true })
  }
  const enterMain = () => {
    if (side === "files") {
      if (!fileRow) return
      if (!fileRow.file) return setCollapsed((c) => toggled(c, fileRow.key))
      // Still loading, it goes in, and comes out again if there's nothing to stage.
      if (d.diffs && !hasPane("unstaged") && !hasPane("staged"))
        return setFlash({ text: d.diffs.tooLarge ? "The diff is too big to stage by line" : d.diffs.notUtf8 ? NOT_UTF8 : "No lines to stage in this file" })
    }
    setInMain(true)
  }
  const toggleLayout = () => {
    setLayout(layout === "split" ? "unified" : "split")
  }
  const layoutOption: Option = { key: "|", label: layout === "split" ? "Unified" : "Split", run: toggleLayout }

  // A comment on lines of a file's diff being staged: the range (or hunk) picked, or the cursor's line, or with
  // `at` (a line's comment button), that line unless it's in what's picked.
  const isUntracked = !!target?.file && untracked(target.file)
  const stagingSources = useMemo<Record<Pane, CommentSource>>(
    () => ({ unstaged: isUntracked ? { key: "unstaged", label: "an untracked file" } : UNSTAGED, staged: STAGED }),
    [isUntracked],
  )
  const stagingSource = (p: Pane) => stagingSources[p]
  const commentStaging = (p: Pane = activePane, at?: number) => {
    const f = paneFile(p)
    if (!f) return
    const rs = stageRows(f)
    let [from, to] = [cur, cur]
    if (hunkMode && cur >= 0) {
      const hunk = rs[cur]?.hunk
      from = rs.findIndex((r) => r.hunk === hunk)
      to = rs.findLastIndex((r) => r.hunk === hunk)
    } else if (anchor !== null && cur >= 0) [from, to] = [Math.min(anchor, cur), Math.max(anchor, cur)]
    if (at !== undefined && !(inMain && p === activePane && cur >= 0 && at >= from && at <= to)) [from, to] = [at, at]
    if (from < 0) return
    comments.open(
      commentLines(
        f,
        stagingSource(p),
        rs.slice(from, to + 1).filter((r) => r.line >= 0),
      ),
    )
    setAnchor(null)
    setHunkMode(false)
  }
  const commentKey = () => {
    if (staging.active) return commentStaging()
    if (picked.current) return picked.current.comment()
    setFlash({
      text: inMain
        ? "Pick lines by their numbers first (drag or shift-click for more), or use a line's comment button"
        : "Go into a diff (Enter) to pick lines to comment on",
    })
  }
  // A comment in the review: to its diff, and scrolled to.
  const [jump, setJump] = useState<string | null>(null)
  const jumpTo = (c: CommentLines, anchorId: string) => {
    if (c.where === "unstaged" || c.where === "staged") {
      setCollapsed((cs) => new Set([...cs].filter((k) => !c.path.startsWith(k))))
      setSide("files")
      setFileKey(c.path)
    } else if (c.where === "branch") setSide("status")
    else if (c.where.startsWith("commit:")) {
      setSide("commits")
      setCommitSha(c.where.slice("commit:".length))
    } else if (c.where.startsWith("stash:")) {
      setSide("stash")
      setStashSha(c.where.slice("stash:".length))
    } else if (c.where.startsWith("turn:")) {
      setSide("turns")
      setTurnN(Number(c.where.split(":")[2]))
    }
    setInMain(false)
    setJump(anchorId)
  }
  // To the comment once it's drawn: after each render while there's one to go to.
  const jumpNow = useEffectEvent(() => {
    if (!jump) return
    const el = root.current?.querySelector(`[data-comment="${CSS.escape(jump)}"]`)
    if (!el) return
    el.scrollIntoView({ block: "center" })
    setJump(null)
  })
  useEffect(() => jumpNow())
  // Off the jump once the diffs it's in have come and it isn't there (outdated, or folded away).
  useEffect(() => {
    if (!jump) return undefined
    return after("3 seconds", () => setJump(null))
  }, [jump])
  const discardReview = () =>
    setDialog({
      kind: "confirm",
      title: "Discard the comments",
      body: `Throw away ${review.comments.length + review.drafts.length === 1 ? "the comment for the agent, which hasn't" : "all the comments for the agent that haven't"} been sent?`,
      yes: "Discard",
      danger: true,
      onYes: () => clearReview(h, id),
    })

  const { options, onKey, mainScroll } = useGitKeys({
    sides,
    sel,
    staging,
    actions,
    refresh,
    toggleLayout,
    layoutOption,
    commentKey,
    focusSide,
    enterMain,
    setDialog,
    dialog: !!dialog,
    menu: !!menu,
    rewinding: !!rewinding,
    busyRef,
    queuedRef,
  })

  const shell = (children: ReactNode) => (
    <div
      ref={root}
      tabIndex={0}
      // The keys that work on every page leave this view's alone (usePageShortcuts).
      data-own-keys
      onKeyDown={onKey}
      onFocus={() => setFocused(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setFocused(false)
      }}
      // Keys go to the view after a click anywhere in it (buttons in it don't take the focus).
      onMouseDownCapture={(e) => {
        if (!(e.target instanceof Element && e.target.closest("input, textarea, [data-modal], [role^=menu]"))) root.current?.focus({ preventScroll: true })
      }}
      className="flex h-full min-h-0 flex-col bg-bg font-mono text-[12px] leading-[18px] outline-none"
    >
      <CommentsContext.Provider value={comments}>{children}</CommentsContext.Provider>
    </div>
  )
  if (!status)
    return shell(
      <div className="flex h-full items-center justify-center font-sans text-[13px] text-faint">
        {loadErr ? <span className="text-red-400">Couldn't read the repository: {loadErr}</span> : <Loader2 size={16} className="animate-spin" />}
      </div>,
    )
  if (!status.available) return shell(<div className="p-5 font-sans text-[13px] text-muted">Changes unavailable: {status.reason}</div>)

  const opts = options()
  return shell(
    <>
      {(task.running || status.state || loadErr || status.folder) && (
        <div className="shrink-0 border-b border-line px-3 py-1 text-[11.5px]">
          {status.folder && (
            <div className="text-amber-300">
              The project's folder is only <span className="font-mono">{status.folder}</span> in the repository at{" "}
              <span className="font-mono">{status.dir}</span>: this shows its files and the commits that touch them. Committing what's staged elsewhere,
              amending, stashing and resetting are left to a terminal.
            </div>
          )}
          {loadErr && <div className="text-red-400">Couldn't refresh: {loadErr}</div>}
          {status.state && <div className="text-amber-300">The repository is {status.state}: finish or abort that in the terminal.</div>}
          {task.running && <div className="text-faint">The agent is working in this folder: changes made here may clash with its own.</div>}
        </div>
      )}
      <div className={clsx("flex min-h-0 flex-1 gap-2 px-2 pt-3 pb-1", narrow && "flex-col")}>
        <SidePanels
          status={status}
          sides={sides}
          sel={sel}
          actions={actions}
          turns={turns}
          focused={focused}
          narrow={narrow}
          focusSide={focusSide}
          setMenu={setMenu}
        />
        <MainPanel
          status={status}
          sel={sel}
          staging={staging}
          d={d}
          shown={shown}
          actions={actions}
          turns={turns}
          layout={layout}
          toggleLayout={toggleLayout}
          focused={focused}
          mainScroll={mainScroll}
          stagingSource={stagingSource}
          commentStaging={commentStaging}
        />
      </div>
      <ReviewBar task={task} review={review} onJump={jumpTo} onDiscard={discardReview} onError={(text) => setFlash({ text, error: true })} />
      <OptionsBar options={opts[0]?.items ?? []} busy={actions.busy} flash={flash} onDismiss={() => setFlash(null)} />
      {menu && <ContextMenu x={menu.x} y={menu.y} title={menu.title} items={menu.items} onClose={() => setMenu(null)} />}
      {dialog && <DialogView dialog={dialog} options={opts} onClose={() => setDialog(null)} />}
      {rewinding && (
        <RewindDialog
          task={task}
          turn={rewinding}
          head={turns.data?.available ? turns.data.head : null}
          onClose={() => setRewinding(null)}
          onDone={(r, convo) => {
            rewound(task, r, convo)
            setFlash({ text: `Rewound to before turn ${rewinding.turn}: ${r.written} restored, ${r.removed} removed` })
            // What the rewind restored (task/Rewind.tsx calls `checkpoints.rewind` itself, not as a mutation that would).
            refresh()
          }}
        />
      )}
    </>,
  )
}
