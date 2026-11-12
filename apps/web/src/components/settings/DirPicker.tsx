// The folder browser is `host.listDirs` (6.11, for settings/NewProjectModal), keyed by the folder typed once typing paused.
import { useAtomValue } from "@effect/atom-react"
import { query, type QueryResult } from "@huntaway/client"
import type { DirListing } from "@huntaway/contracts"
import { clsx } from "clsx"
import { AsyncResult, Atom } from "effect/reactivity"
import { ArrowUp, Folder, FolderGit2 } from "lucide-react"
import { useEffect, useEffectEvent, useRef, useState, type KeyboardEvent } from "react"
import { after } from "../../state/timers"
import { Input, resultError, resultValue } from "../ui"

const withSlash = (p: string) => (p.endsWith("/") ? p : p + "/")

function commonPrefix(names: string[]) {
  let out = names[0] ?? ""
  for (const n of names) while (!n.startsWith(out)) out = out.slice(0, -1)
  return out
}

type DirEntry = DirListing["entries"][number]

/** No listing while no folder is typed. */
const noListing: Atom.Atom<QueryResult<"host.listDirs">> = Atom.make(AsyncResult.initial())

/** Browse directories on a host. The listing follows what's typed: it shows the folder up to the
 *  last `/`, filtered by the rest. Tab or Enter completes, arrows pick, and `~/` expands. */
export function DirPicker({ hostId, value, onChange }: { hostId: string; value: string; onChange: (v: string) => void }) {
  const [active, setActive] = useState(-1)
  const listRef = useRef<HTMLDivElement>(null)
  const slash = value.lastIndexOf("/")
  const dir = value.slice(0, slash + 1)
  const prefix = value.slice(slash + 1)

  const change = useEffectEvent(onChange)
  // What's typed after `dir` now (an answer comes after more may have been typed).
  const typedAfter = useEffectEvent((d: string) => value.slice(d.length))

  // Start in the host's home folder: the field is given it once per host, when it's read.
  const home = useAtomValue(query("host.listDirs", hostId, {}))
  const homePath = resultValue(home)?.path
  const startedOn = useRef<string | null>(null)
  useEffect(() => {
    if (homePath === undefined || startedOn.current === hostId) return
    startedOn.current = hostId
    change(withSlash(homePath))
  }, [homePath, hostId])

  // The folder typed, once typing has paused.
  const [asked, setAsked] = useState(dir)
  useEffect(() => {
    if (!dir) return undefined
    return after(120, () => setAsked(dir))
  }, [dir])
  const result = useAtomValue(asked ? query("host.listDirs", hostId, { path: asked }) : noListing)
  const failed = resultError(result)
  const read = failed === null ? resultValue(result) : undefined
  // A folder under ~ is listed as the folder it expands to.
  const expanded = read && asked.startsWith("~") ? withSlash(read.path) : null
  useEffect(() => {
    // Expand ~ in place, keeping whatever was typed after the folder (unless the folder typed has changed since).
    if (expanded === null || asked !== dir) return
    change(expanded + typedAfter(asked))
  }, [expanded, asked, dir])

  // The last folder read, which stays up while the same folder is read again (the expanded one, say).
  const [loaded, setLoaded] = useState<{ dir: string; listing: DirListing | undefined; err: string | null } | null>(null)
  const readDir = expanded ?? asked
  if (asked && (read || failed) && (loaded === null || loaded.dir !== readDir || loaded.listing !== read || loaded.err !== failed))
    setLoaded({ dir: readDir, listing: read, err: failed })
  const homeFailed = resultError(home)
  const current = dir === "" ? (homeFailed === null ? null : { listing: undefined, err: homeFailed }) : loaded?.dir === dir ? loaded : null
  const listing = current?.listing
  const lower = prefix.toLowerCase()
  const matches = (listing?.entries ?? []).filter((e) => (!e.hidden || prefix.startsWith(".")) && e.name.toLowerCase().startsWith(lower))
  const exact = listing?.entries.find((e) => e.name === prefix)

  // Nothing picked once what's typed changes.
  const [activeFor, setActiveFor] = useState(value)
  if (activeFor !== value) {
    setActiveFor(value)
    setActive(-1)
  }
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" })
  }, [active])

  const pick = (e: DirEntry | string) => onChange(withSlash(typeof e === "string" ? e : e.path))
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && matches.length) {
      e.preventDefault()
      const n = matches.length
      setActive((a) => (e.key === "ArrowDown" ? (a + 1) % n : a <= 0 ? n - 1 : a - 1))
    } else if (e.key === "Tab" && !e.shiftKey && (active >= 0 || (prefix && matches.length))) {
      e.preventDefault()
      const chosen = active >= 0 ? matches[active] : matches.length === 1 ? matches[0] : undefined
      if (chosen) pick(chosen)
      else {
        const common = commonPrefix(matches.map((m) => m.name))
        if (common.length >= prefix.length) onChange(dir + common)
      }
    } else if (e.key === "Enter") {
      e.preventDefault()
      const chosen = active >= 0 ? matches[active] : exact
      if (chosen) pick(chosen)
    }
  }

  let status: string | null = null
  if (listing && prefix !== "." && prefix !== "..") {
    const target = prefix ? exact : !listing.exists ? undefined : listing
    if (target) status = target.is_git ? "✓ Git repository. Tasks can use worktrees." : "Not a git repository. Worktrees are disabled."
    else if (matches.length) status = "Tab to complete, or keep typing to name a new folder."
    else status = "New folder. It's created when you add the project."
  }

  return (
    <div className="space-y-2">
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="/path/to/repo"
        className="font-mono text-[12px]"
        autoFocus
        autoComplete="off"
        spellCheck={false}
      />
      <div ref={listRef} className="h-56 overflow-y-auto rounded-md border border-line bg-bg/60">
        {listing?.parent && !prefix && (
          <button
            type="button"
            onClick={() => listing.parent && pick(listing.parent)}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] text-muted hover:bg-white/[0.04]"
          >
            <ArrowUp size={13} /> ..
          </button>
        )}
        {matches.map((e, i) => (
          <button
            type="button"
            key={e.path}
            data-active={i === active}
            data-index={i}
            onClick={() => pick(e)}
            className={clsx("flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] hover:bg-white/[0.04]", i === active && "bg-white/[0.07]")}
          >
            {e.is_git ? <FolderGit2 size={13} className="text-accent" /> : <Folder size={13} className="text-faint" />}
            <span className={e.is_git ? "text-fg" : "text-muted"}>{e.name}</span>
          </button>
        ))}
        {current?.err && <div className="p-3 text-[12px] text-red-400">{current.err}</div>}
        {value && !dir && <div className="p-3 text-[12px] text-faint">Enter an absolute path, or start with ~/</div>}
      </div>
      {status && <div className="text-[11.5px] text-faint">{status}</div>}
    </div>
  )
}
