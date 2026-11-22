import { Context, Effect, FileSystem, Layer } from "effect"
import type { GitFileContent, GitSymbol, GitSymbolHit, GitTree, TaskId } from "@huntaway/contracts"
import { definesName, isName, occurrences } from "@huntaway/shared"
import { badPath, outsideFolder } from "./changes/parse.ts"
import { ChangesInvalid, type ChangesError } from "./ChangesTab.ts"
import { clearLocation, Git } from "./Git.ts"
import { lines } from "./paths.ts"
import { TaskBase } from "./TaskBase.ts"

// HE-79: the Code tab (docs/plan/06-server.md, "As built in HE-79: FilesTab"): a task's files as they are in its working
// tree, a file's contents, and where a symbol is defined and used. In the folder the Changes tab is of
// (`TaskBase.changesDir`: the task's worktree once it's ready, else its project's repository), from the top of the
// repository, and only in the project's folder when that's part of a repository. Reads only, with no optional locks.

/** Files listed at most. */
export const MAX_FILES = 50_000
/** Files read whole at most (bytes). */
export const MAX_FILE = 2 * 1024 * 1024
/** How much of a file is looked at for a NUL, which makes it binary (as git does). */
const SNIFF = 8000
/** Lines a symbol's search returns at most, and how much of a line's text. */
export const MAX_HITS = 1000
const MAX_HIT_TEXT = 400
/** What of `git grep`'s output is read (it's cut there). */
const MAX_GREP = 4 * 1024 * 1024

export interface FilesTabShape {
  /** The working tree's files (but what git ignores), from the top of the repository; `available: false` when it isn't one. */
  readonly files: (task: TaskId) => Effect.Effect<GitTree, ChangesError>
  /** A file's contents, from the top of the repository: none in `.git`, outside the project's folder or through a link out of it. */
  readonly read: (task: TaskId, path: string) => Effect.Effect<GitFileContent, ChangesError>
  /** The lines `name` is on as a word, the ones defining it first, and `from`'s (the file it was looked up in) before others'. */
  readonly symbol: (task: TaskId, name: string, from: string | undefined) => Effect.Effect<GitSymbol, ChangesError>
}

const invalid = (field: string, reason: string) => new ChangesInvalid({ field, reason })

const lossy = new TextDecoder()
const strict = new TextDecoder("utf-8", { fatal: true })
const decode = (bytes: Uint8Array): { readonly text: string; readonly utf8: boolean } => {
  try {
    return { text: strict.decode(bytes), utf8: true }
  } catch {
    return { text: lossy.decode(bytes), utf8: false }
  }
}

/** The end of a git command's arguments: the project's folder, when it's part of the repository. */
const scope = (folder: string | null) => ["--", ...(folder !== null ? [folder] : [])]

/** `git grep -n -z`'s lines: the path, the line's number and its text, NUL apart. */
export function parseGrep(out: string, name: string): Array<GitSymbolHit> {
  const hits: Array<GitSymbolHit> = []
  for (const row of out.split("\n")) {
    const a = row.indexOf("\0")
    const b = a < 0 ? -1 : row.indexOf("\0", a + 1)
    if (b < 0) continue
    const path = row.slice(0, a)
    const line = Number(row.slice(a + 1, b))
    const full = row.slice(b + 1)
    if (!Number.isInteger(line)) continue
    const column = occurrences(full.length > 4 * MAX_HIT_TEXT ? full.slice(0, 4 * MAX_HIT_TEXT) : full, name)[0] ?? -1
    // A long line (minified code) is cut around the name, so the name is still in it.
    const from = column > MAX_HIT_TEXT / 2 ? column - MAX_HIT_TEXT / 4 : 0
    const text = full.slice(from, from + MAX_HIT_TEXT)
    hits.push({ path, line, column: column < 0 ? -1 : column - from, text, definition: full.length <= 1000 && definesName(full, name, path) })
  }
  return hits
}

/** The hits in the order they're shown: definitions first, and in each, `from`'s before the rest (in the order git gave). */
export function orderHits(hits: ReadonlyArray<GitSymbolHit>, from: string | undefined): Array<GitSymbolHit> {
  const rank = (h: GitSymbolHit) => (h.definition ? 0 : 2) + (h.path === from ? 0 : 1)
  return hits
    .map((h, i) => ({ h, i }))
    .toSorted((x, y) => rank(x.h) - rank(y.h) || x.i - y.i)
    .map(({ h }) => h)
}

export class FilesTab extends Context.Service<FilesTab, FilesTabShape>()("huntaway-server/git/FilesTab") {
  static readonly layer = Layer.effect(
    FilesTab,
    Effect.gen(function* () {
      const g = yield* Git
      const base = yield* TaskBase
      const fs = yield* FileSystem.FileSystem

      /** Runs git in `dir`, paths unquoted, keeping at most `max` bytes of its output. */
      const run = (dir: string, args: ReadonlyArray<string>, max?: number) =>
        g.bytes(dir, ["-c", "core.quotePath=false", ...args], { noLocks: true, env: clearLocation, ...(max !== undefined ? { maxBytes: max } : {}) })

      /** The top of the task's working tree and where the project's folder is in it (`web/`), or null when it's no repository. */
      const repoOf = Effect.fnUntraced(function* (task: TaskId) {
        const { dir } = yield* base.changesDir(task)
        const o = yield* run(dir, ["rev-parse", "--show-toplevel", "--show-prefix"])
        if (!o.ok) return null
        const [top = "", prefix = ""] = lines(lossy.decode(o.stdout))
        return { top, folder: prefix !== "" ? prefix : null }
      })

      const need = Effect.fnUntraced(function* (task: TaskId) {
        const repo = yield* repoOf(task)
        if (repo === null) return yield* invalid("repository", "not a git repository")
        return repo
      })

      const files = Effect.fn("FilesTab.files")(function* (id: TaskId) {
        const repo = yield* repoOf(id)
        if (repo === null) return { available: false, reason: "not a git repository", files: [], truncated: false } satisfies GitTree
        const { top, folder } = repo
        // What git tracks, with each file's mode: a submodule (a gitlink, mode 160000) is a folder of another repository.
        const tracked = yield* run(top, ["--literal-pathspecs", "ls-files", "-z", "--cached", "--stage", ...scope(folder)], 32 * 1024 * 1024)
        if (!tracked.ok) return yield* invalid("repository", tracked.stderr.trim() || "git ls-files failed")
        // And what it would: an untracked repository of its own is listed as its folder (`nested/`), which isn't a file.
        const others = yield* run(top, ["--literal-pathspecs", "ls-files", "-z", "--others", "--exclude-standard", ...scope(folder)], 32 * 1024 * 1024)
        if (!others.ok) return yield* invalid("repository", others.stderr.trim() || "git ls-files failed")
        // Files deleted from the working tree are still in the index: they aren't there to read.
        const deleted = yield* run(top, ["--literal-pathspecs", "ls-files", "-z", "--deleted", ...scope(folder)])
        const gone = new Set(lossy.decode(deleted.stdout).split("\0"))
        const entries = (o: { readonly stdout: Uint8Array; readonly truncated: boolean }) => {
          const list = lossy.decode(o.stdout).split("\0")
          // The last one may have been cut short.
          if (o.truncated) list.pop()
          return list
        }
        const cached = entries(tracked).flatMap((e) => {
          const tab = e.indexOf("\t")
          return tab < 0 || e.startsWith("160000 ") ? [] : [e.slice(tab + 1)]
        })
        const all = [...new Set([...cached, ...entries(others)])].filter((p) => p !== "" && !p.endsWith("/") && !gone.has(p))
        const listed = { truncated: tracked.truncated || others.truncated }
        all.sort()
        const result: GitTree = { available: true, folder, files: all.slice(0, MAX_FILES), truncated: listed.truncated || all.length > MAX_FILES }
        return result
      })

      const read = Effect.fn("FilesTab.read")(function* (id: TaskId, path: string) {
        const { top, folder } = yield* need(id)
        /** Why `p` (from the top) isn't a file of the view: in `.git` (in any case: a file system may ignore it), or outside the project's folder. */
        const outside = (p: string) =>
          (p.split("/").some((c) => c.toLowerCase() === ".git") ? `not a file of the working tree: ${path}` : null) ??
          (folder !== null ? outsideFolder(p, folder) : null)
        const bad = badPath(path) ?? outside(path)
        if (bad !== null) return yield* invalid("path", bad)
        const missing = () => invalid("path", `no such file: ${path}`)
        // A link is followed only to a file in the repository.
        const realTop = yield* fs.realPath(top).pipe(Effect.mapError(missing))
        const real = yield* fs.realPath(`${top}/${path}`).pipe(Effect.mapError(missing))
        if (!real.startsWith(`${realTop}/`)) return yield* invalid("path", `${path} is a link out of the repository`)
        // Nor through a link into `.git` or out of the project's folder.
        if (outside(real.slice(realTop.length + 1)) !== null) return yield* invalid("path", `${path} is a link out of the project's files`)
        const info = yield* fs.stat(real).pipe(Effect.mapError(missing))
        if (info.type !== "File") return yield* invalid("path", `${path} isn't a file`)
        const size = Number(info.size)
        if (size > MAX_FILE) return { path, size, too_large: true } satisfies GitFileContent
        const bytes = yield* fs.readFile(real).pipe(Effect.mapError(missing))
        if (bytes.subarray(0, SNIFF).includes(0)) return { path, size, binary: true } satisfies GitFileContent
        const { text, utf8 } = decode(bytes)
        return { path, size, text, ...(utf8 ? {} : { not_utf8: true }) } satisfies GitFileContent
      })

      const symbol = Effect.fn("FilesTab.symbol")(function* (id: TaskId, name: string, from: string | undefined) {
        if (!isName(name)) return yield* invalid("name", `not a symbol's name: ${name.slice(0, 100)}`)
        const { top, folder } = yield* need(id)
        // A word (`-w`), as given (`-F`), in text files (`-I`), untracked ones too; `-e` so the name is never an option. Not
        // as the user's settings would have it: `submodule.recurse` refuses `--untracked`, `grep.column` adds a field.
        const o = yield* run(
          top,
          [
            "--literal-pathspecs",
            "grep",
            "-n",
            "-z",
            "-I",
            "-w",
            "-F",
            "--untracked",
            "--no-color",
            "--no-recurse-submodules",
            "--no-column",
            "-e",
            name,
            ...scope(folder),
          ],
          MAX_GREP,
        )
        // `git grep` exits 1 when nothing matches.
        if (!o.ok && o.code !== 1) return yield* invalid("repository", o.stderr.trim() || "git grep failed")
        const hits = parseGrep(lossy.decode(o.stdout), name)
        if (o.truncated) hits.pop()
        const result: GitSymbol = { name, hits: orderHits(hits, from).slice(0, MAX_HITS), truncated: o.truncated || hits.length > MAX_HITS }
        return result
      })

      return FilesTab.of({ files, read, symbol })
    }),
  )
}
