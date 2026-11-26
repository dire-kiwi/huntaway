// HE-79: the Code tab: a task's files as they are in its working tree (where the Changes tab looks: its worktree once
// ready, else its project's repository). The tree and a finder on the left (`t`), the file in the middle, highlighted,
// and on the right where the name clicked in it is defined and used, or the file's outline. A Markdown file shows as
// its preview first. The places gone to are kept, to go back to (the back button, Alt+←). HE-90: what git ignores, when
// it's shown, with what's in the ignored folders opened.
import { useAtom, useAtomValue } from "@effect/atom-react"
import { query, type HostTask as Task, type QueryOptions } from "@huntaway/client"
import { TaskId, type GitFileContent, type GitTree } from "@huntaway/contracts"
import { clsx } from "clsx"
import { ArrowLeft, Copy, FolderTree, ListTree } from "lucide-react"
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react"
import { codeIgnoredAtom } from "../../state/prefs"
import { useVisible } from "../../state/visibility"
import { langFor } from "../changes/highlight"
import { statusQuery } from "../changes/git/useGitStatus"
import { MarkdownView } from "../task/thread/MarkdownView"
import { copyText, IconButton, Loading, resultValue } from "../ui"
import { FileTree } from "./FileTree"
import { CodeLines } from "./FileView"
import { codeState, goBack, goTo, toggleFolder } from "./state"
import { OutlinePanel, SymbolPanel } from "./SymbolPanel"
import { ancestors, filesAsked } from "./tree"

/** Below this width the tree and the file take turns, and the side panel goes under the file. */
const NARROW = 760

const README = /^readme(?:\.(?:md|markdown|txt|rst))?$/i

const size = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`)

export function CodeView({ task }: { task: Task }) {
  const h = task.host_id
  const id = TaskId.make(task.id)
  const visible = useVisible()
  // Read again every few seconds while the page is shown, as the agent may be changing them.
  const reads: QueryOptions = { refresh: visible ? "10 seconds" : undefined, focus: true }
  const status = resultValue(useAtomValue(statusQuery(h, task.id)))
  const key = `${h}:${task.id}`
  const [s, setS] = useAtom(codeState(key))
  const [ignoredFlag, setIgnoredFlag] = useAtom(codeIgnoredAtom)
  const showIgnored = ignoredFlag === "1"
  // The last tree read, shown while the tree is read again with another folder opened.
  const [last, setLast] = useState<{ readonly key: string; readonly tree: GitTree } | null>(null)
  const lastTree = last?.key === key ? last.tree : undefined
  const asked = useMemo(() => filesAsked(showIgnored, s.open), [showIgnored, s.open])
  const treeResult = useAtomValue(query("git.files", h, { id, ...asked }, reads))
  const fresh = resultValue(treeResult)
  if (fresh !== undefined && fresh !== lastTree) setLast({ key, tree: fresh })
  const root = useRef<HTMLDivElement>(null)
  const filterRef = useRef<HTMLInputElement>(null)
  const [narrow, setNarrow] = useState(false)
  // Narrow, it opens on the file when there's one to go to (one opened from the Changes tab, HE-96), else on the tree.
  const [treeShown, setTreeShown] = useState(() => s.at === null)
  // `t` goes to the finder, once the tree is shown (it may only now be).
  const [findAsked, setFindAsked] = useState(0)
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

  const tree = fresh ?? lastTree
  const folder = tree?.folder ?? ""
  // A README at the top of the project's folder shows until a file is picked.
  const readme = tree?.files.find((p) => p.startsWith(folder) && README.test(p.slice(folder.length)))
  const at = useMemo(() => s.at ?? (readme ? { path: readme, line: null } : null), [s.at, readme])

  const open = useCallback(
    (path: string, line: number | null = null) => {
      setS((x) => goTo(x, { path, line }))
      setTreeShown(false)
    },
    [setS],
  )
  // Keys go to the view once a file is picked (from the finder too), not to the page.
  const focusView = useCallback(() => root.current?.focus({ preventScroll: true }), [])
  const openFile = useCallback(
    (path: string) => {
      open(path)
      focusView()
    },
    [open, focusView],
  )
  const toggle = useCallback((f: string) => setS((x) => toggleFolder(x, f)), [setS])
  const look = useCallback(
    (name: string | null) => setS((x) => ({ ...x, symbol: name && x.at ? { name, from: x.at.path } : name && at ? { name, from: at.path } : null })),
    [setS, at],
  )
  const onLine = useCallback((line: number) => at && setS((x) => ({ ...goTo(x, { path: at.path, line }), back: x.back })), [setS, at])
  // As the Changes tab does, keys go to the view as it opens.
  useEffect(focusView, [focusView])
  const back = () => {
    setS(goBack)
    // The back button may be disabled now, which would leave the focus nowhere.
    focusView()
  }

  const onKey = (e: ReactKeyboardEvent) => {
    const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement
    if (e.key === "t" && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault()
      setTreeShown(true)
      setFindAsked((n) => n + 1)
    } else if (e.key === "Escape" && !typing && (s.symbol || s.outline)) {
      e.preventDefault()
      e.stopPropagation()
      setS((x) => ({ ...x, symbol: null, outline: false }))
    } else if (e.key === "ArrowLeft" && e.altKey && s.back.length > 0) {
      e.preventDefault()
      back()
    }
  }

  const panel = s.symbol ? (
    <SymbolPanel
      h={h}
      id={id}
      looked={s.symbol}
      at={at}
      onOpen={open}
      onClose={() => {
        look(null)
        focusView()
      }}
    />
  ) : s.outline && at ? (
    <OutlinePanel
      h={h}
      id={id}
      path={at.path}
      reads={reads}
      line={at.line}
      onLine={(line) => open(at.path, line)}
      onClose={() => {
        setS((x) => ({ ...x, outline: false }))
        focusView()
      }}
    />
  ) : null

  const treeOf = (t: GitTree) =>
    t.available ? (
      <FileTree
        tree={t}
        changed={status?.files ?? []}
        open={s.open}
        at={at?.path ?? null}
        filterRef={filterRef}
        showIgnored={showIgnored}
        onIgnored={(show) => setIgnoredFlag(show ? "1" : "0")}
        onOpen={openFile}
        onToggle={toggle}
      />
    ) : (
      <div className="p-3 text-[12.5px] text-muted">No files to show: {t.reason ?? "not a git repository"}.</div>
    )
  const treeView = (
    <Loading result={treeResult} {...(lastTree ? { waiting: treeOf(lastTree) } : {})}>
      {treeOf}
    </Loading>
  )

  return (
    <div ref={root} tabIndex={-1} onKeyDown={onKey} className="flex h-full min-h-0 outline-none" data-testid="code-view">
      {(!narrow || treeShown) && <aside className={clsx("flex min-h-0 flex-col border-r border-line", narrow ? "w-full" : "w-64 shrink-0")}>{treeView}</aside>}
      {(!narrow || !treeShown) && (
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-9 shrink-0 items-center gap-1 border-b border-line px-2">
            {narrow && (
              <IconButton title="Files" onClick={() => setTreeShown(true)}>
                <FolderTree size={14} />
              </IconButton>
            )}
            <IconButton title="Back (Alt+←)" onClick={back} disabled={s.back.length === 0} className="disabled:opacity-30">
              <ArrowLeft size={14} />
            </IconButton>
            {at ? (
              <Crumbs
                path={at.path}
                folder={folder}
                onFolder={(f) => {
                  setS((x) => ({ ...x, open: new Set([...x.open, ...ancestors(`${f}/x`)]) }))
                  setTreeShown(true)
                }}
              />
            ) : (
              <span className="text-[12px] text-faint">Pick a file</span>
            )}
            {at && (
              <>
                <FileFacts h={h} id={id} path={at.path} reads={reads} />
                <IconButton title="Copy the path" onClick={() => copyText(at.path)}>
                  <Copy size={13} />
                </IconButton>
                <IconButton
                  title="Symbols in this file"
                  onClick={() => setS((x) => ({ ...x, outline: !(x.outline && !x.symbol), symbol: null }))}
                  className={clsx(s.outline && !s.symbol && "bg-raised text-fg")}
                >
                  <ListTree size={14} />
                </IconButton>
              </>
            )}
          </div>
          <div className={clsx("flex min-h-0 flex-1", narrow && "flex-col")}>
            <div className="min-h-0 min-w-0 flex-1">
              {at ? (
                <FileBody key={at.path} h={h} id={id} path={at.path} line={at.line} reads={reads} mark={s.symbol?.name ?? null} onLook={look} onLine={onLine} />
              ) : (
                <div className="p-6 text-[13px] text-muted">
                  Pick a file in the tree, or press <kbd className="rounded border border-line px-1 text-[11px]">t</kbd> to find one. Click a name in a file to
                  see where it's defined and used.
                </div>
              )}
            </div>
            {panel && <aside className={clsx("flex min-h-0 flex-col border-line", narrow ? "h-2/5 border-t" : "w-80 shrink-0 border-l")}>{panel}</aside>}
          </div>
        </div>
      )}
    </div>
  )
}

/** The file's path from the project's folder, each folder in it a link that opens it in the tree. */
function Crumbs({ path, folder, onFolder }: { path: string; folder: string; onFolder: (folder: string) => void }) {
  const parts = path.slice(folder.length).split("/")
  return (
    <div className="flex min-w-0 flex-1 items-center overflow-hidden font-mono text-[12px] whitespace-nowrap" title={path} data-testid="code-path">
      {parts.map((p, i) => {
        const last = i === parts.length - 1
        const full = folder + parts.slice(0, i + 1).join("/")
        return (
          <span key={full} className={clsx("flex items-center", last ? "min-w-0 shrink" : "shrink-0")}>
            {last ? (
              <span className="truncate text-fg">{p}</span>
            ) : (
              <>
                <button className="text-muted hover:text-fg hover:underline" onClick={() => onFolder(full)}>
                  {p}
                </button>
                <span className="px-1 text-faint">/</span>
              </>
            )}
          </span>
        )
      })}
    </div>
  )
}

/** The file's lines and size. */
function FileFacts({ h, id, path, reads }: { h: string; id: TaskId; path: string; reads: QueryOptions }) {
  const f = resultValue(useAtomValue(query("git.readFile", h, { id, path }, reads)))
  if (!f || f.path !== path) return null
  const lines = f.text === undefined ? null : f.text.split("\n").length - (f.text.endsWith("\n") ? 1 : 0)
  return (
    <span className="shrink-0 px-1 text-[11px] text-faint">
      {lines !== null && `${lines.toLocaleString()} lines · `}
      {size(f.size)}
    </span>
  )
}

function FileBody({
  h,
  id,
  path,
  line,
  reads,
  mark,
  onLook,
  onLine,
}: {
  h: string
  id: TaskId
  path: string
  line: number | null
  reads: QueryOptions
  mark: string | null
  onLook: (name: string) => void
  onLine: (line: number) => void
}) {
  const result = useAtomValue(query("git.readFile", h, { id, path }, reads))
  const markdown = langFor(path) === "markdown"
  const [preview, setPreview] = useState(markdown && line === null)
  // Going to a line of it shows its code.
  const [lineWas, setLineWas] = useState(line)
  if (lineWas !== line) {
    setLineWas(line)
    if (line !== null) setPreview(false)
  }
  return (
    <Loading result={result}>
      {(f: GitFileContent) =>
        f.binary ? (
          <Note>{`A binary file (${size(f.size)}).`}</Note>
        ) : f.too_large ? (
          <Note>{`Too large to show here (${size(f.size)}).`}</Note>
        ) : (
          <div className="flex h-full min-h-0 flex-col">
            {(markdown || f.not_utf8) && (
              <div className="flex shrink-0 items-center gap-2 border-b border-line/60 px-3 py-1 text-[11.5px]">
                {f.not_utf8 && <span className="text-amber-300">Not UTF-8: shown with what couldn't be read replaced.</span>}
                {markdown && (
                  <div className="ml-auto flex rounded-md border border-line p-0.5">
                    {(["Preview", "Code"] as const).map((v) => (
                      <button
                        key={v}
                        onClick={() => setPreview(v === "Preview")}
                        className={clsx("rounded px-2 py-0.5", preview === (v === "Preview") ? "bg-raised text-fg" : "text-muted hover:text-fg")}
                      >
                        {v}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            <div className="min-h-0 flex-1">
              {markdown && preview ? (
                <div className="h-full overflow-auto px-6 py-4">
                  <MarkdownView text={f.text ?? ""} />
                </div>
              ) : (
                <CodeLines path={path} text={f.text ?? ""} line={line} mark={mark} onLook={onLook} onLine={onLine} />
              )}
            </div>
          </div>
        )
      }
    </Loading>
  )
}

function Note({ children }: { children: string }) {
  return <div className="p-6 text-[13px] text-muted">{children}</div>
}
