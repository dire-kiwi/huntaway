import { Effect, Option, Result } from "effect"
import type { PlatformError, FileSystem } from "effect"
import { Invalid, NotFound, Unavailable } from "@huntaway/contracts"
import type { MemoryFileInfo } from "@huntaway/contracts"
import type { ProcShape } from "../../platform/Proc.ts"
import { LOG_DIR } from "../../prompts/memory.ts"
import {
  BRIEF_FILE,
  BRIEF_ITEMS_FILE,
  changedMessage,
  charCount,
  compareFiles,
  gitlinks,
  kindOf,
  loaded,
  MAX_COMMITTED,
  MAX_DEPTH,
  MAX_FILE,
  MAX_LISTED,
  MAX_WALKED,
  pathNames,
  SEEDS,
  whoNameEmail,
} from "./text.ts"
import type { Who } from "./text.ts"

// The assistant's workspace on disk (huntaway's agent/assistant/memory/workspace.ts, paths.ts and the reading half of
// api.ts): its files, and their history, a git repository beside it (`<workspace>.git`) that only the board writes.
// Nothing here follows a symlink: a path through one could lead out of the workspace, or to another assistant's. The
// functions take the services they need (`Memory` holds them) and run with the workspace's lock held where they say.

/** What the workspace's functions use. */
export interface WorkspaceDeps {
  readonly fs: FileSystem.FileSystem
  readonly proc: ProcShape
}

/** git's result: whether it succeeded, and what it wrote. */
export interface GitOut {
  readonly ok: boolean
  readonly stdout: string
  readonly stderr: string
}

/**
 * The workspace's git folder: `<workspace>.git` next to it (`assistants/<task id>.git`), outside it, so nothing the
 * assistant writes in its workspace is git's config, hooks or filters.
 */
export const gitDir = (dir: string): string => `${dir.replace(/\/+$/u, "")}.git`

const parentOf = (path: string) => path.slice(0, Math.max(path.lastIndexOf("/"), 1))

/** git's environment variables that would point it at another repository, index, config or diff program: unset. */
const UNSET = [
  "GIT_CONFIG",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_EXTERNAL_DIFF",
]

/** None of the user's config (hooks, filters, fsmonitor, signing), and a commit's own maintenance not left running. */
const FIXED = [
  "-c",
  "commit.gpgsign=false",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.quotepath=false",
  "-c",
  "core.fsmonitor=false",
  // A commit's `git maintenance --auto` (or `gc --auto`) runs before git exits, not in the background, where it would
  // work in the repository with the workspace's lock released.
  "-c",
  "maintenance.autoDetach=false",
  "-c",
  "gc.autoDetach=false",
]

const alreadyThere = (e: PlatformError.PlatformError) => e.reason._tag === "AlreadyExists"
const failed = (what: string) => (e: { readonly message: string }) => new Unavailable({ what: "assistant memory", reason: `${what}: ${e.message}` })

const utf8 = new TextDecoder("utf-8", { fatal: true })
const encoder = new TextEncoder()

export const makeWorkspace = ({ fs, proc }: WorkspaceDeps) => {
  /**
   * git in the workspace, as `who`. The workspace's own repository and files, never others: GIT_DIR (`gitDir`, which
   * only the board writes) and GIT_WORK_TREE are the workspace's, and GIT_CEILING_DIRECTORIES stops any search at its
   * folder. Paths are taken literally, not as patterns.
   */
  const git = Effect.fnUntraced(function* (dir: string, who: Who, args: ReadonlyArray<string>, stdin?: string) {
    const [name, email] = whoNameEmail(who)
    const env: Record<string, string | undefined> = Object.fromEntries(UNSET.map((k) => [k, undefined]))
    Object.assign(env, {
      GIT_TERMINAL_PROMPT: "0",
      GIT_LITERAL_PATHSPECS: "1",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_DIR: gitDir(dir),
      GIT_WORK_TREE: dir,
      GIT_CEILING_DIRECTORIES: parentOf(dir),
      GIT_AUTHOR_NAME: name,
      GIT_AUTHOR_EMAIL: email,
      GIT_COMMITTER_NAME: name,
      GIT_COMMITTER_EMAIL: email,
    })
    const out = yield* proc
      .run("git", ["-C", dir, ...FIXED, ...args], { env, timeout: "2 minutes", ...(stdin === undefined ? {} : { stdin }) })
      .pipe(Effect.mapError((e) => new Unavailable({ what: "git", reason: `running git: ${e.reason}` })))
    const result: GitOut = { ok: out.code === 0, stdout: out.stdout, stderr: out.stderr }
    return result
  })

  const gitOk = Effect.fnUntraced(function* (dir: string, who: Who, args: ReadonlyArray<string>, stdin?: string) {
    const o = yield* git(dir, who, args, stdin)
    if (!o.ok) return yield* new Unavailable({ what: "git", reason: `git ${args[0] ?? ""} failed: ${o.stderr.trim()}` })
    return o.stdout
  })

  /** What's at `path`, not following a symlink there; none if nothing is. */
  const lstat = (path: string) => Effect.option(fs.lstat(path))

  const isRealDir = (path: string) => Effect.map(lstat(path), (m) => Option.isSome(m) && m.value.type === "Directory")

  /** Make `dir` if it isn't there (but not its parents), and check it's a folder rather than a symlink to one. */
  const realDir = Effect.fnUntraced(function* (dir: string) {
    yield* fs.makeDirectory(dir).pipe(Effect.catch((e) => (e.reason._tag === "AlreadyExists" ? Effect.void : Effect.fail(failed(`making ${dir}`)(e)))))
    if (yield* isRealDir(dir)) return yield* Effect.void
    return yield* new Unavailable({
      what: "assistant workspace",
      reason: `${dir} isn't a folder of its own (it's a symlink or a file), so the assistant's memory isn't used`,
    })
  })

  /** The files a new workspace starts with, made again if they went missing. A file (or a dangling symlink) that's there is left. */
  const seed = Effect.fnUntraced(function* (dir: string) {
    // Not `mkdir -p`, which would follow a symlink in its place (as is, it's left, and refused when used).
    yield* fs.makeDirectory(`${dir}/${LOG_DIR}`).pipe(Effect.catchIf(alreadyThere, () => Effect.void))
    for (const [name, text] of SEEDS) {
      const path = `${dir}/${name}`
      if (Option.isSome(yield* lstat(path))) continue
      yield* fs.writeFileString(path, text, { flag: "wx" }).pipe(Effect.catchIf(alreadyThere, () => Effect.void))
    }
  })

  /** Whether the workspace has a repository of its own: a real folder at `gitDir`, not a symlink to another's. */
  const isRepo = (dir: string) => isRealDir(gitDir(dir))

  /** The regular file at `path` (not a symlink, nor a FIFO), if there is one. */
  const readPlain = Effect.fnUntraced(function* (path: string) {
    const meta = yield* lstat(path)
    if (Option.isNone(meta) || meta.value.type !== "File") return Option.none<Uint8Array>()
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const file = yield* fs.open(path, { flag: "r", noFollow: true })
        const info = yield* file.stat
        if (info.type !== "File") return Option.none<Uint8Array>()
        const bytes = yield* file.readAlloc(Number(info.size))
        return Option.some(Option.getOrElse(bytes, () => new Uint8Array()))
      }),
    ).pipe(Effect.orElseSucceed(() => Option.none<Uint8Array>()))
  })

  /** A file's text for a run: null if it's missing (or isn't a regular file there, or isn't UTF-8). */
  const readForPrompt = Effect.fnUntraced(function* (dir: string, rel: string) {
    const path = yield* Effect.option(resolve(dir, rel))
    if (Option.isNone(path)) return null
    const bytes = yield* readPlain(path.value)
    if (Option.isNone(bytes)) return null
    return new TextDecoder().decode(bytes.value)
  })

  /**
   * The file `rel` names in the workspace `dir`: a relative path of plain names, not in `.git`, with no symlink on the
   * way (any of which could lead out of the workspace). It may not exist yet.
   */
  const resolve = Effect.fnUntraced(function* (dir: string, rel: string) {
    const names = pathNames(rel)
    if (Result.isFailure(names)) return yield* new Invalid({ field: "path", reason: names.failure })
    let out = dir
    for (const name of names.success) {
      out = `${out}/${name}`
      const meta = yield* lstat(out)
      if (Option.isSome(meta) && meta.value.type === "SymbolicLink") {
        return yield* new Invalid({ field: "path", reason: `"${rel}" goes through a symlink, which may lead out of the workspace` })
      }
    }
    return out
  })

  /** A file's text, for the API: not one that's missing, isn't a file, is too big or isn't text. */
  const readText = Effect.fnUntraced(function* (path: string, rel: string) {
    const meta = yield* lstat(path)
    if (Option.isNone(meta)) return yield* new NotFound({ what: "file", id: rel })
    if (meta.value.type !== "File") return yield* new Invalid({ field: "path", reason: `${rel} isn't a file` })
    if (Number(meta.value.size) > MAX_FILE) return yield* new Invalid({ field: "path", reason: `${rel} is too big to open here` })
    const bytes = yield* readPlain(path)
    if (Option.isNone(bytes)) return yield* new Unavailable({ what: "assistant memory", reason: `reading ${rel}: it isn't a regular file` })
    const text = Result.try({ try: () => utf8.decode(bytes.value), catch: () => `${rel} isn't a text file` })
    if (Result.isFailure(text)) return yield* new Invalid({ field: "path", reason: text.failure })
    return text.success
  })

  /** Write file `rel` (at `path`, as `resolve` checked it) in the workspace, making its folders if need be. */
  const writeFile = Effect.fnUntraced(function* (dir: string, path: string, rel: string, content: string) {
    yield* fs.makeDirectory(parentOf(path), { recursive: true }).pipe(Effect.mapError(failed(`making the folder for ${rel}`)))
    // Made just now, so the way is checked again.
    yield* resolve(dir, rel)
    // Not through a symlink put there since the path was checked.
    yield* Effect.scoped(
      Effect.gen(function* () {
        const file = yield* fs.open(path, { flag: "w", mode: 0o644, noFollow: true })
        yield* file.writeAll(encoder.encode(content))
      }),
    ).pipe(Effect.mapError((e) => new Invalid({ field: "path", reason: `writing ${rel}: ${e.message}` })))
  })

  /** Take the gitlinks (repositories in the workspace) out of the index: git would run `status` in them, with their own config. */
  const dropGitlinks = Effect.fnUntraced(function* (dir: string, who: Who) {
    const links = gitlinks(yield* gitOk(dir, who, ["ls-files", "-s", "-z"]))
    if (links.length === 0) return
    yield* gitOk(dir, who, ["update-index", "--force-remove", "-z", "--stdin"], links.map((p) => `${p}\0`).join(""))
  })

  const tooBig = (dir: string, rel: string) =>
    Effect.map(lstat(`${dir}/${rel}`), (m) => Option.isSome(m) && m.value.type === "File" && Number(m.value.size) > MAX_COMMITTED)

  /** `git add -A` without the brief's files, files over MAX_COMMITTED, names that aren't UTF-8, and repositories in the workspace. */
  const stage = Effect.fnUntraced(function* (dir: string, who: Who) {
    yield* dropGitlinks(dir, who)
    const listed = yield* gitOk(dir, who, ["ls-files", "-z", "--others", "--modified", "--deleted", "--exclude-standard"])
    // Not a repository in the workspace (`--others` gives it as `clone/`), which `add` would make a gitlink.
    const all = [...new Set(listed.split("\0").filter((p) => p !== "" && !p.endsWith("/")))].toSorted()
    const paths: Array<string> = []
    const left: Array<string> = []
    for (const p of all) {
      // The morning brief and its items are written over each day and kept as the assistant's documents.
      if (p === BRIEF_FILE || p === BRIEF_ITEMS_FILE) continue
      // A name that isn't UTF-8 (which reads back with U+FFFD in it) would fail the whole `add`.
      if (p.includes("�") || (yield* tooBig(dir, p))) left.push(p)
      else paths.push(p)
    }
    if (left.length > 0) yield* Effect.logInfo(`${dir}: not committing files over ${MAX_COMMITTED} bytes, or not named in UTF-8: ${left.join(", ")}`)
    // Not `add -A` with no paths, which is all of them.
    if (paths.length === 0) return
    yield* gitOk(dir, who, ["add", "-A", "--pathspec-from-file=-", "--pathspec-file-nul"], paths.map((p) => `${p}\0`).join(""))
    // One made a repository since it was listed.
    yield* dropGitlinks(dir, who)
  })

  /** Commit everything that changed, if anything did, with the workspace's lock held: the commit's id. */
  const commitAllLocked = Effect.fnUntraced(function* (dir: string, who: Who, message: string | null) {
    yield* stage(dir, who)
    const changed = (yield* gitOk(dir, who, ["diff", "--cached", "--name-only"])).split("\n").filter((l) => l !== "")
    if (changed.length === 0) return null
    yield* gitOk(dir, who, ["commit", "-q", "--no-verify", "-m", message ?? changedMessage(changed)])
    return (yield* gitOk(dir, who, ["rev-parse", "HEAD"])).trim()
  })

  /** Whether `rel` is in a repository in the workspace (a folder on the way has a `.git`), whose files the history leaves out. */
  const inNestedRepo = Effect.fnUntraced(function* (dir: string, rel: string) {
    const parts = rel.split("/").filter((c) => c !== "" && c !== ".")
    let p = dir
    for (const c of parts.slice(0, -1)) {
      p = `${p}/${c}`
      if (Option.isSome(yield* lstat(`${p}/.git`))) return true
    }
    return false
  })

  /**
   * Commit one file as it is now (other changes stay, for the next commit), with the workspace's lock held. Not one
   * that `.gitignore` leaves out, nor one in a repository in the workspace.
   */
  const commitFileLocked = Effect.fnUntraced(function* (dir: string, who: Who, rel: string, message: string) {
    if (!(yield* isRepo(dir)) || (yield* inNestedRepo(dir, rel))) return null
    yield* dropGitlinks(dir, who)
    const tracked = (yield* git(dir, who, ["ls-files", "--error-unmatch", "--", rel])).ok
    if (!tracked) {
      if (yield* tooBig(dir, rel)) return null
      // (Not `check-ignore`, which doesn't take paths literally.)
      const ignored = (yield* gitOk(dir, who, ["ls-files", "--others", "--ignored", "--exclude-standard", "--", rel])).trim() !== ""
      if (ignored) return null
    }
    yield* gitOk(dir, who, ["add", "-A", "--", rel])
    if ((yield* git(dir, who, ["diff", "--cached", "--quiet", "--", rel])).ok) return null
    yield* gitOk(dir, who, ["commit", "-q", "--no-verify", "-m", message, "--", rel])
    return (yield* gitOk(dir, who, ["rev-parse", "HEAD"])).trim()
  })

  /** Whether the file `rel` is in the last commit as it is now. */
  const inHistory = Effect.fnUntraced(function* (dir: string, rel: string) {
    return (
      (yield* git(dir, "User", ["ls-files", "--error-unmatch", "--", rel])).ok &&
      (yield* git(dir, "User", ["diff", "--quiet", "--no-ext-diff", "--no-textconv", "HEAD", "--", rel])).ok
    )
  })

  /**
   * The workspace's files (not .git, nor what's behind symlinks), as the Memory tab lists them. Only the files a run is
   * told on `today` are read, for their length in characters; the rest have their size in bytes.
   */
  const list = Effect.fnUntraced(function* (dir: string, today: string) {
    const told = loaded(today)
    const found: Array<readonly [string, FileSystem.File.Info]> = []
    let walked = 0
    const stack: Array<readonly [string, string, number]> = [[dir, "", 0]]
    while (stack.length > 0) {
      const [d, prefix, depth] = stack.pop() ?? [dir, "", 0]
      const names = yield* fs.readDirectory(d).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []))
      for (const name of names) {
        const rel = prefix === "" ? name : `${prefix}/${name}`
        walked++
        if (walked > MAX_WALKED && kindOf(rel) !== "user" && kindOf(rel) !== "memory") continue
        // The morning brief is the assistant's document (its Brief tab), not memory.
        if (prefix === "" && (name === BRIEF_FILE || name === BRIEF_ITEMS_FILE)) continue
        const meta = yield* lstat(`${d}/${name}`)
        if (Option.isNone(meta)) continue
        if (meta.value.type === "Directory") {
          if (name !== ".git" && depth < MAX_DEPTH) stack.push([`${d}/${name}`, rel, depth + 1])
        } else if (meta.value.type === "File") found.push([rel, meta.value])
      }
    }
    // Sorted before the cap, so it's the latest logs and USER.md and MEMORY.md that are listed.
    const sorted = found.toSorted(([a], [b]) => compareFiles(a, b))
    return yield* Effect.forEach(
      sorted.slice(0, MAX_LISTED),
      Effect.fnUntraced(function* ([rel, meta]) {
        let chars: number | null = null
        if (told.includes(rel) && Number(meta.size) <= MAX_FILE) {
          const bytes = yield* readPlain(`${dir}/${rel}`)
          if (Option.isSome(bytes)) {
            const text = Result.try({ try: () => utf8.decode(bytes.value), catch: () => null })
            if (Result.isSuccess(text)) chars = charCount(text.success)
          }
        }
        const info: MemoryFileInfo = {
          path: rel,
          kind: kindOf(rel),
          size: Number(meta.size),
          chars,
          modified: Option.match(meta.mtime, { onNone: () => null, onSome: (d) => d.toISOString() }),
        }
        return info
      }),
      { concurrency: 1 },
    )
  })

  return {
    git,
    gitOk,
    lstat,
    isRealDir,
    realDir,
    seed,
    isRepo,
    readPlain,
    readForPrompt,
    resolve,
    readText,
    writeFile,
    commitAllLocked,
    commitFileLocked,
    inHistory,
    list,
  }
}

export type Workspace = ReturnType<typeof makeWorkspace>
