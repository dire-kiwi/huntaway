import type { GitCommit, GitFile, GitStash } from "@huntaway/contracts"
import { lines } from "../paths.ts"

// What the Changes tab reads of git's output, and the checks of what it is given (huntaway's git/git_view.ts; inventory
// 04, section 2.8). Plain functions: the service running git is `../ChangesTab.ts`.

/** Past this a file's diff isn't sent, and only the whole file can be staged; a commit's or stash's is cut here. */
export const MAX_DIFF = 4 * 1024 * 1024
/** Files listed at most (an untracked folder that should have been ignored can hold many). */
export const MAX_FILES = 5000
/** Commits listed on the branch, and from its base before it. */
export const MAX_COMMITS = 300
export const BASE_COMMITS = 30

/** Rust's `str::splitn`: at most `n` parts, the last holding the rest. */
export const splitn = (s: string, n: number, sep: string): Array<string> => {
  const parts: Array<string> = []
  let rest = s
  while (parts.length < n - 1) {
    const k = rest.indexOf(sep)
    if (k < 0) break
    parts.push(rest.slice(0, k))
    rest = rest.slice(k + sep.length)
  }
  parts.push(rest)
  return parts
}

/** `str::parse::<i64>()`, or 0. */
const toInt = (s: string): number => (/^[+-]?\d+$/.test(s) ? Number(s) : 0)

const parseU32 = (s: string): number => (/^\+?\d+$/.test(s) && Number(s) <= 0xffffffff ? Number(s) : 0)

/** One side of a porcelain v2 `XY`, as `--short` shows it. */
const side = (c: string) => (c === "." ? " " : c)

export interface Status {
  readonly head: string | null
  readonly branch: string | null
  readonly upstream: string | null
  readonly ahead: number
  readonly behind: number
  readonly files: ReadonlyArray<GitFile>
  readonly truncated: boolean
}

/**
 * `git status --porcelain=v2 -z --branch`. Each file has its index (`x`) and working tree (`y`) state as `git status
 * --short` shows them: `M`, `A`, `D`, `R`, `C`, `T`, a space for unchanged, `??` for untracked, and the two sides of a
 * conflict (`UU`, `AA`, …).
 */
export const parseStatus = (out: string): Status => {
  let head: string | null = null
  let branch: string | null = null
  let upstream: string | null = null
  let ahead = 0
  let behind = 0
  let truncated = false
  const files: Array<GitFile> = []
  const recs = out.split("\0")
  for (let i = 0; i < recs.length; i++) {
    const rec = recs[i] ?? ""
    if (rec.startsWith("# ")) {
      const h = rec.slice(2)
      const sp = h.indexOf(" ")
      const [k, v] = sp >= 0 ? [h.slice(0, sp), h.slice(sp + 1)] : [h, ""]
      if (k === "branch.oid" && v !== "(initial)") head = v
      else if (k === "branch.head" && v !== "(detached)") branch = v
      else if (k === "branch.upstream") upstream = v
      else if (k === "branch.ab") {
        for (const n of v.split(" ")) {
          if (n.startsWith("+")) ahead = parseU32(n.slice(1))
          else if (n.startsWith("-")) behind = parseU32(n.slice(1))
        }
      }
      continue
    }
    // Ordinary (1), renamed or copied (2, followed by the path it came from), unmerged (u), untracked (?).
    let xy: string
    let path: string
    let orig: string | null = null
    const first = rec[0]
    if (first === "1" || first === "2" || first === "u") {
      const parts = splitn(rec, first === "1" ? 9 : first === "2" ? 10 : 11, " ")
      if (parts.length < 3) continue
      xy = parts[1] ?? ""
      path = parts[parts.length - 1] ?? ""
      if (first === "2") {
        orig = i + 1 < recs.length ? (recs[i + 1] ?? null) : null
        i++
      }
    } else if (first === "?") {
      xy = "??"
      path = rec.slice(2)
    } else continue
    if (files.length >= MAX_FILES) {
      truncated = true
      continue
    }
    const c = Array.from(xy)
    files.push({ path, orig_path: orig, x: side(c[0] ?? " "), y: side(c[1] ?? " ") })
  }
  return { head, branch, upstream, ahead, behind, files, truncated }
}

/** `git log` with `LOG_FORMAT`'s lines. */
export const parseLog = (out: string, onBranch: boolean, unpushed: ReadonlySet<string>): Array<GitCommit> => {
  const commits: Array<GitCommit> = []
  for (const l of lines(out)) {
    const parts = splitn(l, 4, "\x1f")
    if (parts.length !== 4) continue
    const [sha = "", author = "", time = "", subject = ""] = parts
    commits.push({ sha, author, time: toInt(time), subject, on_branch: onBranch, unpushed: unpushed.has(sha) })
  }
  return commits
}

export const LOG_FORMAT = "--format=%H%x1f%an%x1f%at%x1f%s"
export const STASH_FORMAT = "--format=%H%x1f%ct%x1f%gs"
export const SHOW_FORMAT = "--format=%H%x1f%an%x1f%ae%x1f%at%x1f%B"

/** `git stash list` with `STASH_FORMAT`'s lines, numbered as git numbers them. */
export const parseStashes = (out: string): Array<GitStash> => {
  const list: Array<GitStash> = []
  lines(out).forEach((l, index) => {
    const parts = splitn(l, 3, "\x1f")
    if (parts.length !== 3) return
    const [sha = "", time = "", subject = ""] = parts
    list.push({ index, sha, time: toInt(time), subject })
  })
  return list
}

/** A commit's metadata (`SHOW_FORMAT`), or null when it isn't that. */
export const parseShown = (out: string) => {
  const parts = splitn(out, 5, "\x1f")
  if (parts.length !== 5) return null
  const [sha = "", author = "", email = "", time = "", message = ""] = parts
  return { sha, author, email, time: toInt(time), message: message.trimEnd() }
}

/** The paths in `git apply --numstat -z`: `added\tdeleted\tpath`, or for a rename an empty path followed by where it's from and to. */
export const numstatPaths = (out: string): Array<string> => {
  const paths: Array<string> = []
  const records = out.split("\0")
  for (let i = 0; i < records.length; i++) {
    const p = splitn(records[i] ?? "", 3, "\t")[2]
    if (p === "") {
      paths.push(...records.slice(i + 1, i + 3))
      i += Math.min(2, records.length - i - 1)
    } else if (p !== undefined) paths.push(p)
  }
  return paths
}

/** Which of `paths` are in `out`, a NUL-separated list of paths. */
export const listed = (out: string, paths: ReadonlyArray<string>): Array<string> => {
  const have = new Set(out.split("\0"))
  return paths.filter((p) => have.has(p))
}

/** Why `p` isn't a path in the repository from its top (empty, absolute, or leaving it), or null when it is. */
export const badPath = (p: string): string | null =>
  p === "" || p.startsWith("/") || p.split("/").some((c) => c === "..") ? `not a path in the repository: ${p}` : null

/** Why `rev` isn't a commit given by its hash (so never taken for an option or a path), or null when it is. */
export const badRev = (rev: string): string | null => (rev.length < 4 || rev.length > 64 || !/^[0-9a-fA-F]+$/.test(rev) ? `not a commit hash: ${rev}` : null)

/** Why `p` (a path from the repository's top) isn't in the project's `folder` (`web/`, with its slash), or null when it is. */
export const outsideFolder = (p: string, folder: string): string | null =>
  p.startsWith(folder) || p === folder.replace(/\/+$/, "") ? null : `${p} isn't in the project's folder (${folder})`

/** A git command on `paths`, taken literally (not for commands that run others, as `stash`'s `git clean -- :/` would be taken literally too). */
export const withPaths = (args: ReadonlyArray<string>, paths: ReadonlyArray<string>): Array<string> => ["--literal-pathspecs", ...args, "--", ...paths]

/** The files git says the repository is in the middle of something with, in its git folder, and what. */
export const REPO_STATES = [
  ["rebase-merge", "rebasing"],
  ["rebase-apply", "rebasing"],
  ["MERGE_HEAD", "merging"],
  ["CHERRY_PICK_HEAD", "cherry-picking"],
  ["REVERT_HEAD", "reverting"],
] as const
