// The list and the search are `profiles.githubRepos` (6.11), the search's keyed by what was typed once typing paused.
import { useAtomValue } from "@effect/atom-react"
import { query, type QueryResult } from "@huntaway/client"
import type { GithubRepo, GithubRepoList } from "@huntaway/contracts"
import { clsx } from "clsx"
import { AsyncResult, Atom } from "effect/reactivity"
import { Archive, Check, GitFork, Loader2, Lock } from "lucide-react"
import { useEffect, useRef, useState, type KeyboardEvent } from "react"
import { after } from "../../state/timers"
import { filterRepos, mergeRepos, repoFromInput } from "./repoSource"
import { Input, resultError, resultValue, timeAgo } from "../ui"

/** GitHub's mark (Octicons' `mark-github`, MIT), which lucide doesn't have. */
export function GithubMark({ size = 12, className }: { size?: number | undefined; className?: string | undefined }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden className={clsx("shrink-0", className)}>
      <path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z" />
    </svg>
  )
}

/** No search while nothing is typed. */
const noSearch: Atom.Atom<QueryResult<"profiles.githubRepos">> = Atom.make(AsyncResult.initial())

/** A repository to clone: one gh listed or found, or one typed as `OWNER/REPO`. */
export type RepoChoice = Pick<GithubRepo, "full_name" | "name">

/**
 * Picks a GitHub repository that `account` (gh's active one when null) can clone on a host: the ones it owns, collaborates on
 * or contributed to, most recently pushed first, filtered by what's typed, which also searches its organizations' (they can
 * have thousands, so they aren't listed). `OWNER/REPO` or a github.com URL picks any other.
 */
export function GithubRepoPicker({
  hostId,
  account,
  whose,
  value,
  onChange,
}: {
  hostId: string
  account: string | null
  /** Says where the account comes from, e.g. "gh's active account". */
  whose: string
  value: RepoChoice | null
  onChange: (repo: RepoChoice) => void
}) {
  const source = `${hostId}\n${account ?? ""}`
  const [input, setInput] = useState("")
  const [active, setActive] = useState(-1)
  const listRef = useRef<HTMLDivElement>(null)
  const q = input.trim()

  // The list (gh takes a few seconds): what was read stays up while it's read again, and a good list stays up if
  // asking again fails, or gh fails this time.
  const listed = useAtomValue(query("profiles.githubRepos", hostId, { account }))
  const read = resultValue(listed)
  const [good, setGood] = useState<{ source: string; list: GithubRepoList } | null>(null)
  if (read && !read.error && (good?.source !== source || good.list !== read)) setGood({ source, list: read })
  const kept = good?.source === source ? good.list : undefined
  const shown = read && !(read.error && kept) ? read : kept
  const listFailed = resultError(listed)
  const list: { list?: GithubRepoList; err?: string } | null = shown ? { list: shown } : listFailed ? { err: listFailed } : null

  // The search API has a low rate limit, so it waits for a pause in typing.
  const [asked, setAsked] = useState("")
  useEffect(() => {
    if (!q) return undefined
    return after(400, () => setAsked(q))
  }, [q])
  const searched = useAtomValue(asked ? query("profiles.githubRepos", hostId, { account, q: asked }) : noSearch)
  const found = resultValue(searched)
  const searchFailed = resultError(searched)
  const search: { list?: GithubRepoList; err?: string } | null =
    !q || asked !== q ? null : searchFailed ? { err: searchFailed } : found ? { list: found } : null
  const repos = q ? mergeRepos(filterRepos(list?.list?.repos ?? [], q), search?.list?.repos ?? []) : (list?.list?.repos ?? [])
  const typed = repoFromInput(q)
  const options: (GithubRepo | RepoChoice)[] = [
    ...(typed && !repos.some((r) => r.full_name.toLowerCase() === typed.toLowerCase()) ? [{ full_name: typed, name: typed.split("/")[1] ?? typed }] : []),
    ...repos,
  ]
  const as = list?.list?.account ?? account
  const listError = list?.err ?? list?.list?.error
  const searchError = search?.err ?? search?.list?.error

  // Nothing picked once what's typed changes.
  const [activeFor, setActiveFor] = useState(q)
  if (activeFor !== q) {
    setActiveFor(q)
    setActive(-1)
  }
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" })
  }, [active])

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && options.length) {
      e.preventDefault()
      const n = options.length
      setActive((a) => (e.key === "ArrowDown" ? (a + 1) % n : a <= 0 ? n - 1 : a - 1))
    } else if (e.key === "Enter" && (active >= 0 || options.length === 1)) {
      e.preventDefault()
      const chosen = options[Math.max(active, 0)]
      if (chosen) onChange(chosen)
    }
  }

  let status = ""
  if (list && !listError && !q) {
    status = `As ${as ?? "?"} (${whose}): the repositories it owns, collaborates on or contributed to, most recently pushed first. Typing searches its organizations' too.`
  } else if (q && searchError && !listError) status = `Searching its organizations failed: ${searchError}`
  else if (q && search && !options.length) status = "Nothing found. Type OWNER/REPO, or paste a GitHub URL, to clone any repository."

  return (
    <div className="space-y-2">
      <Input
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Search, or OWNER/REPO"
        aria-label="Search repositories"
        autoFocus
        autoComplete="off"
        spellCheck={false}
      />
      <div ref={listRef} role="listbox" aria-label="Repositories" className="h-56 overflow-y-auto rounded-md border border-line bg-bg/60">
        {options.map((r, i) => {
          const repo = "private" in r ? r : null
          const [owner] = r.full_name.split("/")
          const picked = value?.full_name.toLowerCase() === r.full_name.toLowerCase()
          return (
            <button
              type="button"
              key={r.full_name}
              role="option"
              aria-selected={picked}
              data-repo={r.full_name}
              data-active={i === active}
              data-index={i}
              onClick={() => onChange(r)}
              title={repo?.description ?? r.full_name}
              className={clsx(
                "flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] hover:bg-white/[0.04]",
                i === active && "bg-white/[0.07]",
                picked && "bg-accent/10",
              )}
            >
              {picked ? (
                <Check size={13} className="shrink-0 text-accent" />
              ) : repo?.private ? (
                <Lock size={13} className="shrink-0 text-faint" />
              ) : (
                <GithubMark size={13} className="text-faint" />
              )}
              <span className="min-w-0 flex-1 truncate">
                {!repo && <span className="text-muted">Clone </span>}
                <span className="text-muted">{owner}/</span>
                <span className="text-fg">{r.name}</span>
                {repo?.description && <span className="ml-2 text-faint">{repo.description}</span>}
              </span>
              {repo?.fork && (
                <span title="A fork" className="shrink-0 text-faint">
                  <GitFork size={12} />
                </span>
              )}
              {repo?.archived && (
                <span title="Archived" className="shrink-0 text-faint">
                  <Archive size={12} />
                </span>
              )}
              {repo?.pushed_at && <span className="w-16 shrink-0 text-right text-[11px] text-faint">{timeAgo(repo.pushed_at)}</span>}
            </button>
          )
        })}
        {(!list || (q && !search)) && (
          <div className="flex items-center gap-2 px-3 py-1.5 text-[12px] text-faint">
            <Loader2 size={12} className="animate-spin" /> {list ? "Searching its organizations…" : "Asking gh for the repositories…"}
          </div>
        )}
        {listError && <div className="p-3 text-[12px] text-red-400">gh couldn't list the repositories: {listError}</div>}
      </div>
      {status && <div className="text-[11.5px] text-faint">{status}</div>}
    </div>
  )
}
