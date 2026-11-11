import { useLayoutEffect, useRef, useState, type RefObject } from "react"
import { TaskId, type GitCommit, type GitStash, type GitStatus, type Turn } from "@huntaway/contracts"
import { rpc } from "../../../state/rpc"
import { fileRows, hasStaged, hasUnstaged, linesPatch, untracked, type FileRow } from "../diffs"
import { copyText } from "../../ui"
import type { FileDiffsView } from "./useFileDiffs"
import type { GitSelection } from "./useGitSelection"
import type { Staging } from "./useStaging"
import { errText, rowPath, short, withOrig, type Dialog, type MenuEntry, type Pane } from "./model"

export type GitActions = ReturnType<typeof useGitActions>

export interface GitActionsOptions {
  h: string
  id: string
  status: GitStatus | null
  refresh: () => Promise<GitStatus | null>
  /** Whether a change is being made: the polls wait, and so do keys. */
  busyRef: RefObject<boolean>
  sel: GitSelection
  /** The files panel's selected row, if that's the panel you're in, and its diffs. */
  target: FileRow | undefined
  diffs: FileDiffsView
  staging: Staging
  setDialog: (d: Dialog) => void
  setFlash: (f: { text: string; error?: boolean } | null) => void
  setRewinding: (t: Turn) => void
}

/** What the Changes tab does: staging, discarding, committing, resetting, stashing, rewinding and copying. */
export function useGitActions({ h, id, status, refresh, busyRef, sel, target, diffs, staging, setDialog, setFlash, setRewinding }: GitActionsOptions) {
  const { files, commits, tree, collapsed } = sel
  const { file, chosenRows, drows, hunkMode, setAnchor, activePane, paneFile } = staging
  const task = TaskId.make(id)
  const stage = (paths: ReadonlyArray<string>) => rpc(h, "git.stage", { id: task, paths })
  const unstage = (paths: ReadonlyArray<string>) => rpc(h, "git.unstage", { id: task, paths })
  const commit = (message: string, more: { amend?: boolean; reword?: boolean } = {}) => rpc(h, "git.commit", { id: task, message, ...more })
  const applyPatch = (patch: string, what: "stage" | "unstage" | "discard") =>
    rpc(h, "git.apply", { id: task, patch, cached: what !== "discard", reverse: what !== "stage" })
  const [busy, setBusy] = useState<string | null>(null)
  // Bumped when a change is done: keys wait (`busyRef`) until what it changed is rendered, not only fetched, or one
  // pressed in between would be taken against the old status and diffs (a Tab to a staged diff that isn't there yet).
  const [doneN, setDoneN] = useState(0)
  useLayoutEffect(() => {
    if (doneN >= 0) busyRef.current = false
  }, [doneN, busyRef])
  // The commit message being written, kept when its dialog is closed without committing.
  const draft = useRef("")

  /**
   * Runs a change, one at a time, then shows what's changed (or why it failed): the status and the selected
   * file's diffs, before the keys pressed meanwhile are taken (see `queued`), as lazygit takes them in turn.
   */
  const act = async (label: string, f: () => Promise<unknown>, done?: string) => {
    if (busyRef.current) return false
    busyRef.current = true
    setBusy(label)
    setFlash(null)
    let ok = true
    try {
      await f()
      if (done) setFlash({ text: done })
    } catch (e) {
      ok = false
      setFlash({ text: errText(e), error: true })
    } finally {
      const st = await refresh()
      const row = target && st?.files && fileRows(st.files, tree, collapsed).find((r) => r.key === target.key)
      if (row) await diffs.reload(row)
      setBusy(null)
      setDoneN((n) => n + 1)
    }
    return ok
  }

  const anyUnstaged = files.some(hasUnstaged)
  const anyStaged = files.some(hasStaged)
  const toggleRow = (r: FileRow | undefined) => {
    if (!r) return
    if (r.files.some(hasUnstaged)) void act("Staging", () => stage([rowPath(r)]))
    else void act("Unstaging", () => unstage(r.file ? withOrig(r.files) : [rowPath(r)]))
  }
  const toggleAll = () => {
    if (!files.length) return setFlash({ text: "No changes" })
    if (anyUnstaged) void act("Staging everything", () => stage([]))
    else void act("Unstaging everything", () => unstage([]))
  }
  const discardRow = (r: FileRow | undefined) => {
    if (!r) return
    const name = r.file ? r.file.path : `${r.key} (${r.files.length} file${r.files.length === 1 ? "" : "s"})`
    const items: MenuEntry[] = [
      {
        key: "x",
        label: "Discard all changes",
        hint: r.files.some((f) => untracked(f) || f.x === "A") ? "New files are deleted" : "Staged and unstaged, back to the last commit",
        danger: true,
        run: () => void act("Discarding", () => rpc(h, "git.discard", { id: task, paths: withOrig(r.files), staged: true }), `Discarded ${name}`),
      },
    ]
    if (r.files.some((f) => hasStaged(f) && hasUnstaged(f)))
      items.push({
        key: "u",
        label: "Discard unstaged changes",
        hint: "Keeps what's staged",
        danger: true,
        run: () =>
          void act(
            "Discarding",
            () => rpc(h, "git.discard", { id: task, paths: r.files.filter(hasUnstaged).map((f) => f.path), staged: false }),
            `Discarded unstaged changes in ${name}`,
          ),
      })
    setDialog({ kind: "menu", title: `Discard ${name}`, items })
  }
  const commitDialog = (title: string, yes: string, initial: string, submit: (message: string) => Promise<unknown>, onDraft?: (message: string) => void) => {
    const [summary = "", ...rest] = initial.split("\n")
    setDialog({ kind: "message", title, yes, summary, body: rest.join("\n").replace(/^\n+/, ""), submit, ...(onDraft ? { onDraft } : {}) })
  }
  const startCommit = () => {
    const open = () =>
      commitDialog(
        "Commit",
        "Commit",
        draft.current,
        async (message) => {
          const r = await commit(message)
          draft.current = ""
          setFlash({ text: `Committed ${short(r.head)}` })
          void refresh()
        },
        (message) => {
          draft.current = message
        },
      )
    if (anyStaged) return open()
    if (!files.length) return setFlash({ text: "Nothing to commit" })
    setDialog({
      kind: "confirm",
      title: "Nothing is staged",
      body: "Stage all the changes and commit them?",
      yes: "Stage all",
      onYes: () =>
        void act("Staging everything", () => stage([])).then((ok) => {
          if (ok) open()
        }),
    })
  }
  const head = commits[0]
  // A project folder that's only part of its repository: what acts on the whole repository is left to a terminal.
  const wholeRepo = (what: string) => {
    if (status?.folder) setFlash({ text: `${what} would act on the whole repository, not just ${status.folder}: do it in a terminal`, error: true })
    return !!status?.folder
  }
  const amend = () => {
    if (wholeRepo("Amending")) return
    if (!head) return setFlash({ text: "There's no commit to amend", error: true })
    if (status?.merge_base && !head.on_branch) return setFlash({ text: "The last commit isn't on this branch", error: true })
    setDialog({
      kind: "confirm",
      title: "Amend the last commit",
      body: (
        <>
          Add what's staged to <span className="font-mono text-fg">{short(head.sha)}</span> {head.subject}?{head.unpushed ? "" : " It has been pushed already."}
        </>
      ),
      yes: "Amend",
      onYes: () => void act("Amending", () => commit("", { amend: true }), `Amended ${short(head.sha)}`),
    })
  }
  const reword = (c: GitCommit | undefined) => {
    if (!c || wholeRepo("Rewording")) return
    if (c.sha !== status?.head) return setFlash({ text: "Only the latest commit can be reworded here", error: true })
    void rpc(h, "git.show", { id: task, rev: c.sha })
      .then((r) =>
        commitDialog("Reword the last commit", "Reword", r.message ?? "", async (message) => {
          await commit(message, { reword: true })
          setFlash({ text: "Reworded" })
          void refresh()
        }),
      )
      .catch((e: unknown) => setFlash({ text: errText(e), error: true }))
  }
  const resetMenu = (c: GitCommit | undefined) => {
    if (!c || wholeRepo("Resetting")) return
    const to = `${short(c.sha)} ${c.subject}`
    const reset = (mode: "soft" | "mixed" | "hard") => () =>
      void act("Resetting", () => rpc(h, "git.reset", { id: task, rev: c.sha, mode }), `Reset to ${short(c.sha)}`)
    setDialog({
      kind: "menu",
      title: `Reset the branch to ${to}`,
      items: [
        { key: "s", label: "Soft reset", hint: "The later commits' changes stay, staged", run: reset("soft") },
        { key: "m", label: "Mixed reset", hint: "The later commits' changes stay, unstaged", run: reset("mixed") },
        {
          key: "h",
          label: "Hard reset",
          hint: "The later commits and every uncommitted change are thrown away",
          danger: true,
          run: () =>
            setDialog({
              kind: "confirm",
              title: "Hard reset",
              body: `Throw away every commit after ${to}, and all uncommitted changes?`,
              yes: "Hard reset",
              danger: true,
              onYes: reset("hard"),
            }),
        },
      ],
    })
  }
  const stashPush = (mode: "all" | "staged" | "unstaged") => {
    if (wholeRepo("Stashing")) return
    if (!files.length) return setFlash({ text: "Nothing to stash" })
    setDialog({
      kind: "input",
      title: mode === "all" ? "Stash all changes" : mode === "staged" ? "Stash staged changes" : "Stash unstaged changes",
      placeholder: "Message (optional)",
      yes: "Stash",
      submit: (message) => void act("Stashing", () => rpc(h, "git.stash", { id: task, action: "push", mode, message }), "Stashed"),
    })
  }
  const stashMenu = () =>
    !wholeRepo("Stashing") &&
    setDialog({
      kind: "menu",
      title: "Stash",
      items: [
        { key: "a", label: "Stash all changes", hint: "Untracked files too", run: () => stashPush("all") },
        { key: "s", label: "Stash staged changes", run: () => stashPush("staged") },
        { key: "u", label: "Stash unstaged changes", hint: "What's staged stays", run: () => stashPush("unstaged") },
      ],
    })
  const stashDo = (action: "apply" | "pop" | "drop", s: GitStash | undefined) => {
    if (!s) return
    const [doing = "", done = ""] = { apply: ["Applying", "Applied"], pop: ["Popping", "Popped"], drop: ["Dropping", "Dropped"] }[action]
    const run = () => void act(doing, () => rpc(h, "git.stash", { id: task, action, index: s.index, sha: s.sha }), `${done} stash@{${s.index}}`)
    if (action === "apply") {
      run()
      return
    }
    setDialog({
      kind: "confirm",
      title: action === "pop" ? "Pop the stash" : "Drop the stash",
      body: `${action === "pop" ? "Apply and then drop" : "Throw away"} stash@{${s.index}}: ${s.subject}?`,
      yes: action === "pop" ? "Pop" : "Drop",
      danger: action === "drop",
      onYes: run,
    })
  }
  const rewindTo = (t: Turn | undefined) => {
    if (!t) return
    if (!t.rewind.ok) return setFlash({ text: `Can't rewind to before turn ${t.turn}: ${t.rewind.reason}`, error: true })
    setRewinding(t)
  }
  const copy = (text: string | undefined) => {
    if (!text) return
    copyText(text)
    setFlash({ text: `Copied ${text}` })
  }

  // Lines: staged from the unstaged diff, unstaged from the staged one, discarded from the unstaged one.
  const applyLines = (what: "stage" | "unstage" | "discard") => {
    if (!file || !chosenRows.size) return
    const keys = new Set([...chosenRows].map((i) => `${drows[i]?.hunk}:${drows[i]?.line}`))
    const patch = linesPatch(file, (hunk, line) => keys.has(`${hunk}:${line}`), what !== "stage")
    if (!patch) return
    const n = [...chosenRows].length
    const run = () => {
      setAnchor(null)
      void act(what === "stage" ? "Staging" : what === "unstage" ? "Unstaging" : "Discarding", () => applyPatch(patch, what))
    }
    if (what !== "discard") return run()
    setDialog({
      kind: "confirm",
      title: "Discard lines",
      body: `Throw away ${hunkMode ? "this hunk" : n === 1 ? "this line's change" : `these ${n} lines' changes`}?`,
      yes: "Discard",
      danger: true,
      onYes: run,
    })
  }
  const linesAction = () => applyLines(activePane === "unstaged" ? "stage" : "unstage")
  const discardLines = () => {
    if (activePane === "staged") return setFlash({ text: "Unstage the lines first to discard them", error: true })
    applyLines("discard")
  }
  const hunkAction = (p: Pane, hunk: number, what: "stage" | "unstage" | "discard") => {
    const f = paneFile(p)
    if (!f) return
    const patch = linesPatch(f, (hh) => hh === hunk, what !== "stage")
    if (!patch) return
    const run = () => void act(what === "stage" ? "Staging" : what === "unstage" ? "Unstaging" : "Discarding", () => applyPatch(patch, what))

    if (what === "discard")
      setDialog({ kind: "confirm", title: "Discard the hunk", body: "Throw away this hunk's changes?", yes: "Discard", danger: true, onYes: run })
    else run()
  }

  return {
    busy,
    anyUnstaged,
    toggleRow,
    toggleAll,
    discardRow,
    startCommit,
    amend,
    reword,
    resetMenu,
    stashPush,
    stashMenu,
    stashDo,
    rewindTo,
    copy,
    linesAction,
    discardLines,
    hunkAction,
  }
}
