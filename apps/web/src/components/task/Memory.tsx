// The assistant's Memory tab (6.7): its USER.md, MEMORY.md and daily logs, which the board loads into each of its runs.
// Edit them, see each file's history and restore a version, or import what another assistant knows about you
// (`assistant.memory`, `memoryFile`, `writeMemoryFile`, `memoryHistory`, `memoryDiff`, `restoreMemory`, `importMemory`).
import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react"
import { mutate, query, type HostTask as Task, type QueryResult } from "@huntaway/client"
import { ProfileId, type MemoryCommit, type MemoryFileInfo } from "@huntaway/contracts"
import { clsx } from "clsx"
import { Cause, Exit } from "effect"
import { AsyncResult, Atom } from "effect/reactivity"
import { Copy, FileText, History, Import, Loader2, RotateCcw, Save } from "lucide-react"
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { errorText, isTagged, runExit, useMutation } from "../../state/mutation"
import { registry } from "../../state/registry"
import { Button, copyText, isoOf, localeString, millisOf, Modal, ModalFooter, resultError, resultValue, Textarea, timeAgo } from "../ui"

/**
 * An edit not saved yet. `base`: what the editor opened (null for a file that wasn't there), which the save checks is
 * still what's there.
 */
interface Draft {
  readonly content: string
  readonly base: string | null
}

/**
 * A memory file as its editors share it, by host, task and path, kept for the page's life rather than in the editor,
 * which goes when another file or tab is opened: the edit not saved yet (kept while the tab is closed or another file is
 * open), a save on its way, and one refused because the assistant changed the file. So the editor shown when a save ends
 * (a new one, if the file was opened again) takes it in without losing what was typed meanwhile.
 */
interface FileState {
  readonly draft: Draft | null
  readonly saving: boolean
  readonly conflict: boolean
  /** What the last save or restore wrote, until the file is read again: `over` is the read it was written over. */
  readonly written: { readonly content: string; readonly over: unknown } | null
}

const UNTOUCHED: FileState = { draft: null, saving: false, conflict: false, written: null }

const fileStates = Atom.family((_key: string) => Atom.make(UNTOUCHED).pipe(Atom.keepAlive))

/** A memory file of a task's assistant. */
interface FileRef {
  readonly host: string
  readonly profile: string
  readonly path: string
  /** What its state is kept by: host, task and path. */
  readonly key: string
}

const fileRef = (task: Task, path: string): FileRef => ({ host: task.host_id, profile: task.profile_id, path, key: `${task.host_id}:${task.id}:${path}` })

/** What's in the file now, read again as the assistant's turns start and end, and after a change of its memory. */
const fileRead = (f: FileRef) => query("assistant.memoryFile", f.host, { profile_id: ProfileId.make(f.profile), path: f.path })

/** A file that isn't there yet: nothing to read (its base is null). */
const NO_FILE: Atom.Atom<QueryResult<"assistant.memoryFile">> = Atom.make(AsyncResult.initial())

/** The read of the file a save or restore ends over (see `FileState.written`). */
const readNow = (f: FileRef, exists: boolean): unknown => (exists ? resultValue(registry.get(fileRead(f))) : undefined)

/**
 * Saves `content` over `base` (what the editor opened), whichever editor of the file started it, and gives why it failed,
 * if it did with something other than the assistant having changed the file. What it wrote is the new base, and the
 * draft (what was typed since, in this editor or one before it) stays on top of it.
 */
function saveFile(f: FileRef, exists: boolean, content: string, base: string | null, force: boolean): Promise<string | null> {
  const atom = fileStates(f.key)
  if (registry.get(atom).saving) return Promise.resolve(null)
  registry.update(atom, (s) => ({ ...s, saving: true, conflict: false }))
  const write = mutate("assistant.writeMemoryFile", f.host, {
    profile_id: ProfileId.make(f.profile),
    path: f.path,
    content,
    expected: base,
    ...(force ? { force } : {}),
  })
  return runExit(write).then((exit) => {
    const s = registry.get(atom)
    if (Exit.isSuccess(exit)) {
      const written = exit.value.content
      const draft = !s.draft || s.draft.content === written ? null : { content: s.draft.content, base: written }
      registry.set(atom, { ...s, saving: false, draft, written: { content: written, over: readNow(f, exists) } })
      return null
    }
    const failure = Cause.hasInterruptsOnly(exit.cause) ? undefined : Cause.squash(exit.cause)
    // A forced save refused too (a file the history leaves out, changed since it was opened) says why.
    const conflict = isTagged(failure, "Conflict") && !force
    registry.set(atom, { ...s, saving: false, conflict })
    return conflict || failure === undefined ? null : errorText(failure)
  })
}

const n = (x: number) => x.toLocaleString("en")

/** Files a run is told: USER.md and MEMORY.md, and today's and yesterday's logs. */
const LOADED = new Set(["user", "memory"])

const TITLES: Record<MemoryFileInfo["kind"], string> = { user: "About you", memory: "Memory", log: "Daily logs", other: "Other files" }

export function MemoryView({ task, onShowThread }: { task: Task; onShowThread: () => void }) {
  // Read again whenever a turn starts or ends, as the assistant may have changed its files, and after a change of them.
  const read = useAtomValue(query("assistant.memory", task.host_id, { profile_id: ProfileId.make(task.profile_id) }))
  const overview = resultValue(read)
  const error = resultError(read)
  const [path, setPath] = useState("USER.md")
  const [importing, setImporting] = useState(false)

  // Today's log is listed before it's written, to start it.
  const files = useMemo(() => {
    const list = overview?.files ?? []
    if (!overview || list.some((f) => f.path === overview.today)) return list
    const today: MemoryFileInfo = { path: overview.today, kind: "log", size: 0, chars: null, modified: null }
    const at = list.findIndex((f) => f.kind === "other")
    return at < 0 ? [...list, today] : [...list.slice(0, at), today, ...list.slice(at)]
  }, [overview])
  const file = files.find((f) => f.path === path)

  if (!overview)
    return (
      <div className="p-8 text-[13px] text-muted">
        {error ? `Couldn't open the assistant's memory: ${error}` : <Loader2 size={14} className="animate-spin" />}
      </div>
    )

  const loadedLogs = new Set([overview.today, yesterday(overview.today)])
  const groups = (["user", "memory", "log", "other"] as const).map((k) => ({ kind: k, files: files.filter((f) => f.kind === k) })).filter((g) => g.files.length)

  return (
    <div className="flex h-full min-h-0 narrow:flex-col">
      <aside className="flex w-64 shrink-0 flex-col border-r border-line bg-panel/40 narrow:max-h-[35%] narrow:w-full narrow:border-r-0 narrow:border-b">
        <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
          <span className="text-xs font-medium text-muted">Memory</span>
          <Button size="sm" variant="ghost" onClick={() => setImporting(true)} title="Bring in what another assistant knows about you">
            <Import size={13} /> Import
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto py-1">
          {groups.map((g) => (
            <div key={g.kind} className="py-1">
              <div className="px-3 py-1 text-[11px] font-medium tracking-wide text-faint uppercase">{TITLES[g.kind]}</div>
              {g.files.map((f) => {
                const loaded = LOADED.has(f.kind) || loadedLogs.has(f.path)
                const over = loaded && ((f.chars ?? 0) > overview.cap || f.size > overview.cap_bytes)
                return (
                  <button
                    key={f.path}
                    onClick={() => setPath(f.path)}
                    className={clsx(
                      "flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px]",
                      f.path === path ? "bg-raised text-fg" : "text-muted hover:text-fg",
                    )}
                    title={loaded ? "Loaded into each of the assistant's runs" : "Not loaded: the assistant reads it when it needs it"}
                  >
                    <FileText size={13} className={clsx("shrink-0", loaded ? "text-accent" : "text-faint")} />
                    <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{f.kind === "log" ? f.path.slice("memory/".length) : f.path}</span>
                    <Unsaved file={fileRef(task, f.path)} />
                    {f.chars === null && f.modified === null ? (
                      <span className="text-[11px] text-faint">new</span>
                    ) : loaded && f.chars !== null ? (
                      <span className={clsx("text-[11px] tabular-nums", over ? "text-amber-300" : "text-faint")}>{n(f.chars)}</span>
                    ) : null}
                  </button>
                )
              })}
            </div>
          ))}
        </div>
        <p className="border-t border-line px-3 py-2 text-[11px] leading-snug text-faint narrow:hidden">
          Highlighted files go into every run, up to {n(overview.cap)} characters ({n(Math.floor(overview.cap_bytes / 1024))} KB) each. The assistant keeps them
          up to date; you can edit them too.
        </p>
      </aside>
      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        <FileEditor
          key={`${task.id}:${path}`}
          task={task}
          path={path}
          file={file}
          cap={LOADED.has(file?.kind ?? "other") || loadedLogs.has(path) ? overview.cap : undefined}
          capBytes={overview.cap_bytes}
          history={overview.history}
        />
      </section>
      {importing && (
        <ImportDialog
          task={task}
          prompt={overview.import_prompt}
          onClose={() => setImporting(false)}
          onSent={() => {
            setImporting(false)
            onShowThread()
          }}
        />
      )}
    </div>
  )
}

/** The dot of a file with an edit not saved yet, in the list. */
function Unsaved({ file }: { file: FileRef }) {
  const unsaved = useAtomValue(fileStates(file.key), (s) => s.draft !== null)
  return unsaved ? <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" title="Not saved" /> : null
}

const DAY = 24 * 60 * 60 * 1000

/** The day before `memory/YYYY-MM-DD.md`, as a log's path. */
function yesterday(today: string) {
  const m = /(\d{4})-(\d{2})-(\d{2})/.exec(today)
  if (!m) return ""
  const day = millisOf(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`)
  return Number.isNaN(day) ? "" : `memory/${isoOf(day - DAY).slice(0, 10)}.md`
}

function FileEditor({
  task,
  path,
  file,
  cap,
  capBytes,
  history,
}: {
  task: Task
  path: string
  file: MemoryFileInfo | undefined
  /** How much of it a run is told, if it's loaded. */
  cap?: number | undefined
  /** And in bytes. */
  capBytes: number
  history: boolean
}) {
  const ref = fileRef(task, path)
  const atom = fileStates(ref.key)
  const state = useAtomValue(atom)
  const update = useAtomSet(atom)
  const [error, setError] = useState<string>()
  const busy = state.saving
  const conflict = state.conflict
  const [showHistory, setShowHistory] = useState(false)
  const [viewing, setViewing] = useState<MemoryCommit>()
  const modified = file?.modified
  const exists = !!modified

  // What's there now, read again as the assistant may have changed it (its turns) and after a change of the memory (null:
  // not there yet). A draft keeps its own base, so a save still checks against what it was written over; and the draft's
  // base is there from the first render, so a Ctrl+S on the file just opened again saves it before the file is read
  // (HA-240).
  const fileAtom = exists ? fileRead(ref) : NO_FILE
  const read = useAtomValue(fileAtom)
  const refresh = useAtomRefresh(fileAtom)
  const refreshList = useAtomRefresh(query("assistant.memory", task.host_id, { profile_id: ProfileId.make(task.profile_id) }))
  const readValue = resultValue(read)
  const there = !exists ? null : readValue?.content
  const shown = state.written && state.written.over === readValue ? state.written.content : there
  const base = state.draft ? state.draft.base : shown
  const content = state.draft ? state.draft.content : (base ?? "")
  const shownError = error ?? resultError(read) ?? undefined

  const dirty = base !== undefined && content !== (base ?? "")
  const edit = (c: string) => {
    if (base === undefined) return
    // While a save is on its way, even a change back to what was there is kept, as it isn't what's being saved.
    update((s) => ({ ...s, draft: c === (base ?? "") && !s.saving ? null : { content: c, base } }))
  }

  const save = (force = false) => {
    // Nothing to save (Ctrl+S on a file as it is, or a log not written yet, which would make it empty).
    if (base === undefined || (!dirty && !force)) return
    setError(undefined)
    void saveFile(ref, exists, content, base, force).then((failed) => {
      if (failed !== null) setError(failed)
    })
  }
  const discard = () => {
    update((s) => ({ ...s, draft: null, conflict: false, written: null }))
    setError(undefined)
    refresh()
    refreshList()
  }

  // Ctrl+S saves wherever the focus is in the tab (rather than saving the page).
  const saveRef = useRef(save)
  useLayoutEffect(() => {
    saveRef.current = save
  })
  useEffect(() => {
    if (viewing) return undefined
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s" && !document.querySelector("[data-modal]")) {
        e.preventDefault()
        saveRef.current()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [viewing])

  const chars = Array.from(content).length
  // Past the cap in bytes (as text in a script of 3 or 4 bytes a character can be) before the one in characters.
  const bytes = content.length > capBytes / 4 ? new TextEncoder().encode(content).length : 0
  const over = cap !== undefined && (chars > cap || bytes > capBytes)
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2">
        <span className="font-mono text-[13px] text-fg">{path}</span>
        {cap !== undefined && (
          <span
            className={clsx("text-[11px] tabular-nums", over ? "text-amber-300" : "text-faint")}
            title="How much of it the assistant is told at the start of each run"
          >
            {n(chars)} / {n(cap)} characters{chars <= cap && over && ` (over ${n(Math.floor(capBytes / 1024))} KB)`}
            {over && (path.startsWith("memory/") ? ": only the end is loaded" : ": the rest isn't loaded")}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          {history && exists && (
            <Button
              size="sm"
              variant={showHistory ? "secondary" : "ghost"}
              onClick={() => {
                setShowHistory(!showHistory)
                setViewing(undefined)
              }}
            >
              <History size={13} /> History
            </Button>
          )}
          {dirty && !viewing && (
            <Button size="sm" variant="ghost" onClick={discard} title="Drop your changes">
              Revert
            </Button>
          )}
          {!viewing && (
            <Button size="sm" variant="primary" disabled={!dirty || busy} onClick={() => save()} title="Save (Ctrl+S)">
              {busy ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />} Save
            </Button>
          )}
        </div>
      </div>
      {conflict && (
        <div className="flex flex-wrap items-center gap-2 border-b border-amber-500/25 bg-amber-500/10 px-4 py-2 text-[12.5px] text-amber-200">
          The assistant changed {path} since you opened it.
          <Button size="sm" onClick={discard}>
            Load its version
          </Button>
          <Button size="sm" variant="danger" onClick={() => save(true)}>
            Overwrite it with yours
          </Button>
        </div>
      )}
      {shownError && <div className="border-b border-line px-4 py-2 text-[12.5px] text-red-300">{shownError}</div>}
      <div className="flex min-h-0 flex-1 narrow:flex-col">
        {viewing ? (
          <CommitView
            key={viewing.sha}
            task={task}
            path={path}
            commit={viewing}
            onBack={() => setViewing(undefined)}
            onRestored={(c) => {
              update((s) => ({ ...s, draft: null, written: { content: c, over: readNow(ref, exists) } }))
              setViewing(undefined)
            }}
            dirty={dirty}
          />
        ) : (
          <textarea
            aria-label={`Edit ${path}`}
            value={content}
            disabled={base === undefined}
            spellCheck={false}
            onChange={(e) => edit(e.target.value)}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                e.preventDefault()
                save()
              }
            }}
            placeholder={exists ? "" : `${path} isn't there yet: write it, then save.`}
            className="min-h-0 flex-1 resize-none bg-transparent px-4 py-3 font-mono [font-variant-ligatures:none] text-[12.5px] leading-relaxed text-fg outline-none placeholder:text-faint"
          />
        )}
        {showHistory && <HistoryList task={task} path={path} viewing={viewing} onView={setViewing} />}
      </div>
    </div>
  )
}

function HistoryList({ task, path, viewing, onView }: { task: Task; path: string; viewing: MemoryCommit | undefined; onView: (c: MemoryCommit) => void }) {
  // Read again as the file is (the assistant's turns, a change of the memory).
  const read = useAtomValue(query("assistant.memoryHistory", task.host_id, { profile_id: ProfileId.make(task.profile_id), path }))
  const commits = resultValue(read)?.commits
  const error = resultError(read)
  return (
    <div className="w-72 shrink-0 overflow-y-auto border-l border-line narrow:max-h-[40%] narrow:w-full narrow:border-t narrow:border-l-0">
      {error && <div className="p-3 text-[12px] text-red-300">{error}</div>}
      {!commits && !error && <Loader2 size={14} className="m-3 animate-spin text-muted" />}
      {commits?.length === 0 && <div className="p-3 text-[12px] text-muted">No history yet.</div>}
      {commits?.map((c, i) => (
        <button
          key={c.sha}
          onClick={() => onView(c)}
          className={clsx("block w-full border-b border-line/60 px-3 py-2 text-left", viewing?.sha === c.sha ? "bg-raised" : "hover:bg-white/5")}
        >
          <div className="truncate text-[12.5px] text-fg">{c.message}</div>
          <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-faint">
            <span className={c.author === "You" ? "text-accent" : undefined}>{c.author}</span>
            <span title={localeString(c.date)}>{timeAgo(c.date)}</span>
            <span className="font-mono">{c.sha.slice(0, 7)}</span>
            {i === 0 && <span>(current)</span>}
          </div>
        </button>
      ))}
    </div>
  )
}

/** Lines with keys: a line's text, and which of the lines with that text it is (lines have no other identity). */
function keyed(lines: ReadonlyArray<string>): Array<{ text: string; key: string }> {
  const seen = new Map<string, number>()
  return lines.map((text) => {
    const nth = (seen.get(text) ?? 0) + 1
    seen.set(text, nth)
    return { text, key: `${nth}\u0000${text}` }
  })
}

/** The patch's own header lines (diff --git, index, ---/+++) say nothing the title doesn't. */
const HEADER = /^(diff --git|index |--- |\+\+\+ |new file mode|deleted file mode|similarity|rename )/

/** A commit's change to the file (the view is keyed by the commit), and Restore. */
function CommitView({
  task,
  path,
  commit,
  dirty,
  onBack,
  onRestored,
}: {
  task: Task
  path: string
  commit: MemoryCommit
  dirty: boolean
  onBack: () => void
  onRestored: (content: string) => void
}) {
  const profile_id = ProfileId.make(task.profile_id)
  const read = useAtomValue(query("assistant.memoryDiff", task.host_id, { profile_id, rev: commit.sha, path }))
  const diff = resultValue(read)?.diff
  const [restoring, restoreMemory] = useMutation("assistant.restoreMemory")
  const busy = restoring.busy
  const error = restoring.error ?? resultError(read)
  const restore = () => {
    if (busy || (dirty && !window.confirm(`Restoring drops the changes you haven't saved to ${path}.`))) return
    void restoreMemory(task.host_id, { profile_id, path, rev: commit.sha }).then((exit) => {
      if (Exit.isSuccess(exit)) onRestored(exit.value.content)
    })
  }
  const lines = keyed((diff ?? "").split("\n").filter((l) => !HEADER.test(l)))
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2 text-[12.5px]">
        <span className="text-muted">
          {commit.message} · {commit.author}, {localeString(commit.date)}
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          <Button size="sm" variant="ghost" onClick={onBack}>
            Back to editing
          </Button>
          <Button size="sm" onClick={restore} disabled={busy} title={`Put ${path} back as it was after this change`}>
            <RotateCcw size={13} /> Restore this version
          </Button>
        </div>
      </div>
      {error && <div className="px-4 py-2 text-[12.5px] text-red-300">{error}</div>}
      <pre className="min-h-0 flex-1 overflow-auto px-4 py-3 font-mono [font-variant-ligatures:none] text-[12px] leading-relaxed">
        {diff === undefined && !error ? (
          <Loader2 size={14} className="animate-spin text-muted" />
        ) : lines
            .map((l) => l.text)
            .join("")
            .trim() === "" ? (
          <span className="text-muted">No changes to {path} in this commit.</span>
        ) : (
          lines.map(({ text: l, key }) => (
            <div
              key={key}
              className={clsx(
                "whitespace-pre-wrap",
                l.startsWith("+")
                  ? "bg-emerald-500/10 text-emerald-200"
                  : l.startsWith("-")
                    ? "bg-red-500/10 text-red-200"
                    : l.startsWith("@@")
                      ? "text-faint"
                      : "text-muted",
              )}
            >
              {l || " "}
            </div>
          ))
        )}
      </pre>
    </div>
  )
}

/** Sends another assistant's answer to the task's assistant (`onSent` once it has). */
function ImportDialog({ task, prompt, onClose, onSent }: { task: Task; prompt: string; onClose: () => void; onSent: () => void }) {
  const [text, setText] = useState("")
  const [copied, setCopied] = useState(false)
  const [{ busy, error }, importMemory] = useMutation("assistant.importMemory")
  const send = () => {
    if (!text.trim() || busy) return
    void importMemory(task.host_id, { profile_id: ProfileId.make(task.profile_id), text }).then((exit) => {
      if (Exit.isSuccess(exit)) onSent()
    })
  }
  return (
    <Modal title="Import memory from another assistant" onClose={onClose} onSubmit={send} width="max-w-2xl">
      <div className="space-y-4 text-[13px]">
        <div className="space-y-1.5">
          <div className="text-muted">
            1. Paste this into the assistant that knows you (ChatGPT, Claude.ai, Gemini…), in a chat where it can use its memory:
          </div>
          <div className="relative rounded-md border border-line bg-raised/50 p-3 pr-20 text-[12.5px] leading-relaxed text-fg">
            {prompt}
            <Button
              size="sm"
              className="absolute top-2 right-2"
              onClick={() => {
                copyText(prompt)
                setCopied(true)
              }}
            >
              <Copy size={12} /> {copied ? "Copied" : "Copy"}
            </Button>
          </div>
        </div>
        <div className="space-y-1.5">
          <div className="text-muted">2. Paste its answer here. Your assistant folds it into USER.md and MEMORY.md, and tells you what it changed.</div>
          <Textarea aria-label="The other assistant's answer" rows={10} value={text} onChange={(e) => setText(e.target.value)} placeholder="Its answer…" />
        </div>
        <ModalFooter>
          {error && <div className="mb-2 text-[12.5px] text-red-300">{error}</div>}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" disabled={!text.trim() || busy} onClick={send}>
              {busy && <Loader2 size={13} className="animate-spin" />} Send to the assistant
            </Button>
          </div>
        </ModalFooter>
      </div>
    </Modal>
  )
}
