import { Effect } from "effect"
import type { FileSystem, PlatformError } from "effect"
import type { Project } from "@huntaway/contracts"
import { entries } from "../../projects/checks.ts"
import type { GitShape } from "../Git.ts"
import { pathStartsWith, samePath, stripPathPrefix } from "../paths.ts"
import { fail, fromGit, orFail } from "./failed.ts"

// The repository's ignored files a project brings into each new task worktree, before its setup script runs, so the
// script and the agent can rely on them: `.env` files, local config, credentials, big caches (huntaway's
// git/worktree_files.ts; inventory 04, section 2.4).
//
// - `copy_files` (and the repository's `.worktreeinclude`, as Claude Code and Orca read it) are .gitignore-style patterns
//   (`.env` at any depth, `/.env` only at the top, `config/*.local.json`, `!` to leave one out). Each untracked file of
//   the repository folder they match is copied when git ignores it, both there and on the task's branch; a file the
//   worktree already has is never overwritten.
// - `link_folders` are folders, relative to the repository, symlinked into the worktree instead (a model cache, say).
//   Each must be ignored by git with nothing tracked in it. A link isn't a folder to git, so a `node_modules/` pattern
//   doesn't ignore it: when nothing else does, it's added to the repository's `info/exclude`, so the link isn't
//   committed, doesn't show as untracked, and doesn't keep the worktree from being removed. Removing the worktree removes
//   the link, not what it points to.
//
// Nothing is read through a symlink in the repository (one could lead out of it, to its `.git`, or to tracked files under
// an ignored name), nor from outside it (no `..`, no absolute paths), and nothing is written through a symlink in the
// worktree. The links made in each worktree are kept in its git folder (`huntaway-links`), so they're pointed at the
// repository's new place if it moves, whatever the setting says by then. File names are taken as UTF-8.

/** The repository's own list of files to copy, as other tools read it. */
export const INCLUDE_FILE = ".worktreeinclude"

/** What `bringIn` did, for the task's thread. */
export interface Report {
  readonly copied: Array<string>
  readonly linked: Array<string>
  /** Already in the worktree (checked out, or from an earlier setup), so left as they are. */
  readonly existing: Array<string>
  /** What was asked for but not brought in, and why. */
  readonly skipped: Array<string>
  /** Whether the repository's `.worktreeinclude` was read. */
  includeFile: boolean
}

const pluralN = (n: number) => (n === 1 ? "" : "s")
const sentence = (s: string) => (s === "" ? "" : `${s.charAt(0).toUpperCase()}${s.slice(1)}`)

/** The thread event for the report (level, text, detail), or null when nothing was asked for. */
export const reportEvent = (r: Report): readonly ["info" | "warn", string, string] | null => {
  const c = r.copied.length
  const l = r.linked.length
  const e = r.existing.length
  const s = r.skipped.length
  if (c + l + e + s === 0 && !r.includeFile) return null
  const parts: Array<string> = []
  if (c > 0 || l === 0) parts.push(`Copied ${c} file${pluralN(c)}`)
  if (l > 0) parts.push(`linked ${l} folder${pluralN(l)}`)
  let text = `${sentence(parts.join(" and "))} from the repository`
  if (s > 0) text += ` (${s} left out)`
  const detail = [
    ...(r.includeFile ? [`Read ${INCLUDE_FILE}`] : []),
    ...r.copied.map((p) => `copied ${p}`),
    ...r.linked.map((p) => `linked ${p}`),
    ...r.existing.map((p) => `already there: ${p}`),
    ...r.skipped.map((p) => `left out: ${p}`),
  ]
  return [s > 0 ? "warn" : "info", text, detail.join("\n")]
}

/** Why a `copy_files` pattern can't be used, if it can't: it mustn't climb out with `..`. */
export const checkPattern = (p: string): string | null => {
  const q = p.startsWith("!") ? p.slice(1) : p
  return q.split("/").includes("..") ? `${q}: patterns are relative to the repository, without ..` : null
}

/** A `link_folders` entry as a path relative to the repository, or why it isn't one. */
export const linkPath = (p: string): { readonly ok: string } | { readonly err: string } => {
  const path = p.replace(/\/+$/, "")
  if (path.startsWith("/") || p.startsWith("~")) return { err: `${p}: folders are relative to the repository` }
  const out: Array<string> = []
  for (const c of path.split("/")) {
    if (c === "" || c === ".") continue
    if (c === ".." || c === ".git") return { err: `${p}: folders are relative to the repository, inside it, without .. or .git` }
    out.push(c)
  }
  if (out.length === 0) return { err: `${p}: name a folder inside the repository` }
  return { ok: out.join("/") }
}

/** The components of a relative path. */
const components = (p: string) => p.split("/").filter((c) => c !== "" && c !== ".")

/** Whether a pattern names a path rather than matching several (no wildcards, not a negation). */
const isLiteral = (p: string) => !p.startsWith("!") && !/[*?[\\]/.test(p)

/**
 * Whether file `f` is (or is in) what literal pattern `p` names, as git would match it: a pattern with a slash before its
 * end is anchored at the top, one without matches at any depth.
 */
export const literalMatches = (p: string, f: string): boolean => {
  const name = p.replace(/\/+$/, "")
  const anchored = name.includes("/")
  const want = components(name.replace(/^\/+/, ""))
  const fc = components(f)
  const starts = (from: number) => want.length <= fc.length - from && want.every((c, i) => fc[from + i] === c)
  if (anchored) return starts(0)
  for (let skip = 0; skip < fc.length; skip++) if (starts(skip)) return true
  return false
}

const join = (a: string, b: string) => (b === "" ? a : `${a.replace(/\/+$/, "")}/${b}`)
const dirname = (p: string) => {
  const i = p.replace(/\/+$/, "").lastIndexOf("/")
  return i <= 0 ? "/" : p.slice(0, i)
}

/** A platform error as the old server's io errors read: its description. */
const ioText = (e: PlatformError.PlatformError) => e.message

const notFound = (e: PlatformError.PlatformError) => e.reason._tag === "NotFound"

/** What files.ts reaches: git and the file system. */
export interface FilesDeps {
  readonly git: GitShape
  readonly fs: FileSystem.FileSystem
}

/** `lstat`, or null when nothing is there. */
const lstat = (fs: FileSystem.FileSystem, path: string) =>
  fs.lstat(path).pipe(
    Effect.map((info) => ({ ok: info }) as const),
    Effect.catch((e) => Effect.succeed(notFound(e) ? ({ ok: null } as const) : ({ err: e } as const))),
  )

/** Whether `p` is a folder, through symlinks. */
const isDir = (fs: FileSystem.FileSystem, p: string) =>
  fs.stat(p).pipe(
    Effect.map((i) => i.type === "Directory"),
    Effect.orElseSucceed(() => false),
  )

const realPath = (fs: FileSystem.FileSystem, p: string) => fs.realPath(p).pipe(Effect.orElseSucceed(() => null))

/**
 * Refuses `rel` of the repository at `top` if it, or a folder it's in, is a symlink: the git checks that it's ignored and
 * untracked are of its own path, not of where a link leads. Null when it isn't one.
 */
const symlinkIn = Effect.fnUntraced(function* (fs: FileSystem.FileSystem, top: string, rel: string) {
  let path = top
  const cs = components(rel)
  for (let i = 0; i < cs.length; i++) {
    path = join(path, cs[i] ?? "")
    const m = yield* lstat(fs, path)
    if ("err" in m) return `can't read it (${ioText(m.err)})`
    if (m.ok === null) return null
    if (m.ok.type === "SymbolicLink") return i + 1 === cs.length ? "a symbolic link" : `${stripPathPrefix(path, top) ?? path} is a symbolic link`
  }
  return null
})

/** Why `rel` can't go in the worktree `wt`, if it can't: one of the folders it's in there is a symlink, or something else that isn't a folder. */
const notAFolder = Effect.fnUntraced(function* (fs: FileSystem.FileSystem, wt: string, rel: string) {
  let dir = wt
  for (const c of components(rel).slice(0, -1)) {
    dir = join(dir, c)
    const m = yield* lstat(fs, dir)
    if ("err" in m || m.ok === null) return null
    if (m.ok.type !== "Directory") return `${stripPathPrefix(dir, wt) ?? dir} in the worktree isn't a folder`
  }
  return null
})

/** Creates the folders `rel` is in inside the worktree `wt`, refusing to go through a symlink (or anything else that isn't a folder) on the way. */
const makeParents = Effect.fnUntraced(function* (fs: FileSystem.FileSystem, wt: string, rel: string) {
  let dir = wt
  for (const c of components(rel).slice(0, -1)) {
    dir = join(dir, c)
    const m = yield* lstat(fs, dir)
    if ("err" in m) return `checking ${dir} failed (${ioText(m.err)})`
    if (m.ok === null) {
      const made = yield* Effect.result(fs.makeDirectory(dir))
      if (made._tag === "Failure") return `creating ${dir} failed (${ioText(made.failure)})`
      continue
    }
    if (m.ok.type !== "Directory") return `${stripPathPrefix(dir, wt) ?? dir} in the worktree isn't a folder`
  }
  return null
})

/** Whether git ignores `rel` in the checkout at `dir`. */
const isIgnored = (g: GitShape, dir: string, rel: string) =>
  g.run(dir, ["check-ignore", "-q", "--", rel]).pipe(
    Effect.map((o) => o.ok),
    Effect.orElseSucceed(() => false),
  )

/** Which of `files` git ignores in the checkout at `dir` (tracked files aren't). */
const ignored = Effect.fnUntraced(function* (g: GitShape, dir: string, files: ReadonlyArray<string>) {
  if (files.length === 0) return new Set<string>()
  const out = yield* g.run(dir, ["check-ignore", "-z", "--stdin"], { stdin: files.map((f) => `${f}\0`).join("") }).pipe(Effect.mapError(fromGit))
  // 1 is none of them.
  if (!out.ok && out.code !== 1) return yield* fail(`git check-ignore failed: ${out.stderr.trim()}`)
  return new Set(out.stdout.split("\0").filter((p) => p !== ""))
})

/** The repository's `.worktreeinclude`, if it has one: a file of its own, not a symlink (which could lead anywhere, and its lines end up in the thread). */
const includeFile = Effect.fnUntraced(function* (fs: FileSystem.FileSystem, top: string) {
  const path = join(top, INCLUDE_FILE)
  const meta = yield* lstat(fs, path)
  if ("err" in meta) return { err: `can't read it (${ioText(meta.err)})` } as const
  if (meta.ok === null) return { ok: null } as const
  if (meta.ok.type === "SymbolicLink") return { err: "a symbolic link" } as const
  if (meta.ok.type !== "File") return { err: "not a file" } as const
  if (Number(meta.ok.size) > 64 * 1024) return { err: "bigger than 64 KiB" } as const
  const text = yield* Effect.result(fs.readFileString(path))
  return text._tag === "Failure" ? ({ err: `can't read it (${ioText(text.failure)})` } as const) : ({ ok: text.success } as const)
})

/** Copies `rel` from the repository at `top` into the worktree `wt`: true if copied, false if the worktree has it already, or why it can't be. */
const copyOne = Effect.fnUntraced(function* (fs: FileSystem.FileSystem, top: string, canonTop: string, wt: string, rel: string) {
  const sym = yield* symlinkIn(fs, top, rel)
  if (sym !== null) return { err: sym } as const
  const src = join(top, rel)
  const meta = yield* lstat(fs, src)
  if ("err" in meta) return { err: `can't read it (${ioText(meta.err)})` } as const
  if (meta.ok === null) return { err: "can't read it (not found)" } as const
  if (meta.ok.type !== "File") return { err: "not a file" } as const
  const real = yield* realPath(fs, src)
  if (real === null || !pathStartsWith(real, canonTop)) return { err: "not in the repository" } as const
  const dest = join(wt, rel)
  const there = yield* lstat(fs, dest)
  if (!("err" in there) && there.ok !== null) return { ok: false } as const
  const made = yield* makeParents(fs, wt, rel)
  if (made !== null) return { err: made } as const
  const copied = yield* Effect.result(fs.copyFile(src, dest))
  if (copied._tag === "Failure") return { err: `copying it failed (${ioText(copied.failure)})` } as const
  return { ok: true } as const
})

/**
 * Copies the files `patterns` match, except those under `links` (which are linked instead) and the project's worktrees
 * folder `worktrees`.
 */
const copy = Effect.fnUntraced(function* (
  deps: FilesDeps,
  report: Report,
  top: string,
  canonTop: string,
  worktrees: string | null,
  wt: string,
  patterns: ReadonlyArray<string>,
  links: ReadonlyArray<string>,
) {
  const { git: g, fs } = deps
  const args = ["ls-files", "-z", "--others", "--ignored", ...patterns.flatMap((p) => ["-x", p])]
  const out = yield* orFail(g.ok(top, args))
  // A nested repository (a worktree kept in the repository, say) is listed as a folder.
  const found = out.split("\0").filter((p) => p !== "" && !p.endsWith("/"))
  for (const p of patterns.filter(isLiteral)) {
    if (!found.some((f) => literalMatches(p, f))) {
      const why = (yield* fs.exists(join(top, p.replace(/^\/+/, ""))).pipe(Effect.orElseSucceed(() => false)))
        ? "tracked by git, not copied"
        : "not in the repository"
      report.skipped.push(`${p}: ${why}`)
    }
  }
  const wanted: Array<string> = []
  for (const f of found) {
    // What's in a folder that's linked comes with it.
    let linked = false
    for (const l of links) if (pathStartsWith(f, l) && (yield* isDir(fs, join(top, l)))) linked = true
    if (linked) continue
    if (worktrees !== null && pathStartsWith(join(canonTop, f), worktrees)) continue
    // Not into the worktree through a symlink (which git can't say it ignores, either).
    const why = yield* notAFolder(fs, wt, f)
    if (why !== null) report.skipped.push(`${f}: ${why}`)
    else wanted.push(f)
  }
  const inRepo = yield* ignored(g, top, wanted)
  const inWt = yield* ignored(g, wt, wanted)
  const notIgnored: Array<string> = []
  const todo: Array<string> = []
  for (const f of wanted) {
    if (!inRepo.has(f)) notIgnored.push(f)
    else if (!inWt.has(f)) report.skipped.push(`${f}: not ignored by git on the task's branch`)
    else todo.push(f)
  }
  if (notIgnored.length > 0) {
    const n = notIgnored.length
    const more = n > 10 ? ` and ${n - 10} more` : ""
    report.skipped.push(`${n} matching file${pluralN(n)} git doesn't ignore (only ignored files are copied): ${notIgnored.slice(0, 10).join(", ")}${more}`)
  }
  for (const f of todo) {
    const r = yield* copyOne(fs, top, canonTop, wt, f)
    if ("err" in r) report.skipped.push(`${f}: ${r.err}`)
    else if (r.ok) report.copied.push(f)
    else report.existing.push(f)
  }
})

const EXCLUDE_HEADER =
  "# Folders Huntaway links into task worktrees (a project's Folders to link). Git doesn't take a\n" +
  "# symbolic link for a folder, so a `name/` pattern doesn't ignore the link.\n"

/**
 * Adds `/<rel>` to the `info/exclude` of the repository that worktree `wt` is of (shared by all its worktrees), once.
 * Read and appended to with nothing in between that yields to git, so links set up at once don't lose each other's lines.
 */
const exclude = Effect.fnUntraced(function* (deps: FilesDeps, wt: string, rel: string) {
  const { git: g, fs } = deps
  const file = (yield* g.ok(wt, ["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"]).pipe(Effect.mapError(fromGit))).trim()
  let line = "/"
  for (const ch of rel) line += "\\*?[".includes(ch) ? `\\${ch}` : ch
  if (line.endsWith(" ")) line = `${line.slice(0, -1)}\\ `
  const text = yield* fs.readFileString(file).pipe(Effect.catch((e) => (notFound(e) ? Effect.succeed("") : fail(`reading ${file}: ${ioText(e)}`))))
  if (text.split("\n").includes(line)) return
  let add = ""
  if (text !== "" && !text.endsWith("\n")) add += "\n"
  if (!text.includes(EXCLUDE_HEADER)) add += EXCLUDE_HEADER
  add += `${line}\n`
  yield* fs.makeDirectory(dirname(file), { recursive: true }).pipe(Effect.ignore)
  yield* fs.writeFileString(file, add, { flag: "a" }).pipe(Effect.catch((e) => fail(`adding to ${file}: ${ioText(e)}`)))
})

/** The file in a worktree's git folder that lists the links made in it, one path per line. It goes with the worktree when git removes it. */
const RECORD = "huntaway-links"

const recordFile = (g: GitShape, wt: string) => g.ok(wt, ["rev-parse", "--absolute-git-dir"]).pipe(Effect.map((d) => join(d.trim(), RECORD)))

/** Adds `rel` to the links recorded for worktree `wt`. */
const record = Effect.fnUntraced(function* (deps: FilesDeps, wt: string, rel: string) {
  const file = yield* recordFile(deps.git, wt)
  const text = yield* deps.fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""))
  if (text.split("\n").includes(rel)) return
  yield* deps.fs.writeFileString(file, `${rel}\n`, { flag: "a" })
})

/** The links recorded for worktree `wt`, as paths inside it. */
const recorded = Effect.fnUntraced(function* (deps: FilesDeps, wt: string) {
  const file = yield* recordFile(deps.git, wt).pipe(Effect.orElseSucceed(() => null))
  if (file === null) return []
  const text = yield* deps.fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""))
  return text.split("\n").filter((p) => p !== "" && !p.startsWith("/") && p.split("/").every((c) => c !== "" && c !== "." && c !== ".." && c !== ".git"))
})

/** Links folder `rel` of the repository at `top` into the worktree `wt`: what it links to, null if the worktree has something there already, or why it can't. */
const link = Effect.fnUntraced(function* (deps: FilesDeps, top: string, canonTop: string, wt: string, rel: string) {
  const { git: g, fs } = deps
  const sym = yield* symlinkIn(fs, top, rel)
  if (sym !== null) return { err: sym } as const
  const src = join(top, rel)
  const m = yield* lstat(fs, src)
  if ("err" in m) return { err: `can't read it (${ioText(m.err)})` } as const
  if (m.ok === null) return { err: "not in the repository" } as const
  if (m.ok.type !== "Directory") return { err: "not a folder" } as const
  const real = yield* realPath(fs, src)
  if (real === null) return { err: "can't read it" } as const
  if (!pathStartsWith(real, canonTop) || samePath(real, canonTop)) return { err: "not in the repository" } as const
  const w = yield* realPath(fs, wt)
  if (w !== null && pathStartsWith(w, real)) return { err: "the worktree is inside it" } as const
  const tracked = yield* g.run(top, ["ls-files", "-z", "--", `:(literal)${rel}`]).pipe(Effect.result)
  if (tracked._tag === "Failure") return { err: tracked.failure.reason } as const
  if (!tracked.success.ok) return { err: `git ls-files failed: ${tracked.success.stderr.trim()}` } as const
  if (tracked.success.stdout !== "") return { err: "git tracks files in it" } as const
  if (!(yield* isIgnored(g, top, rel))) return { err: "not ignored by git" } as const
  const dest = join(wt, rel)
  const there = yield* lstat(fs, dest)
  if (!("err" in there) && there.ok !== null) return { ok: null } as const
  const made = yield* makeParents(fs, wt, rel)
  if (made !== null) return { err: made } as const
  const linked = yield* Effect.result(fs.symlink(src, dest))
  if (linked._tag === "Failure") return { err: `linking it failed (${ioText(linked.failure)})` } as const
  if (!(yield* isIgnored(g, wt, rel))) {
    const excluded = yield* Effect.result(exclude(deps, wt, rel))
    if (excluded._tag === "Failure" || !(yield* isIgnored(g, wt, rel))) {
      yield* fs.remove(dest).pipe(Effect.ignore)
      const why = excluded._tag === "Failure" ? excluded.failure.reason : "the repository's .gitignore files say not to ignore it"
      return { err: `the link would be an untracked file in the worktree (${why})` } as const
    }
  }
  yield* record(deps, wt, rel).pipe(Effect.catch((e) => Effect.logWarning(`recording the link ${rel} in ${wt}: ${e.message}`)))
  return { ok: src } as const
})

/** Copy and link `project`'s files into its task worktree `wt` (see the top of this file). Fails with why it couldn't start. */
export const bringIn = Effect.fnUntraced(function* (
  deps: FilesDeps,
  project: Pick<Project, "repo_path" | "copy_files" | "link_folders" | "worktrees_root">,
  wt: string,
) {
  const { git: g, fs } = deps
  const report: Report = { copied: [], linked: [], existing: [], skipped: [], includeFile: false }
  const top = (yield* g.ok(project.repo_path, ["rev-parse", "--show-toplevel"]).pipe(Effect.mapError(fromGit))).trim()
  const canonTop = yield* realPath(fs, top)
  if (canonTop === null) return yield* fail(`resolving ${top}: No such file or directory`)
  const links: Array<string> = []
  for (const l of entries(project.link_folders)) {
    const r = linkPath(l)
    if ("ok" in r) links.push(r.ok)
    else report.skipped.push(r.err)
  }
  const patterns = entries(project.copy_files)
  const inc = yield* includeFile(fs, top)
  if ("ok" in inc) {
    if (inc.ok !== null) {
      report.includeFile = true
      patterns.push(...entries(inc.ok))
    }
  } else report.skipped.push(`${INCLUDE_FILE}: ${inc.err}, not read`)
  const usable = patterns.filter((p) => {
    const e = checkPattern(p)
    if (e !== null) report.skipped.push(e)
    return e === null
  })
  if (usable.some((p) => !p.startsWith("!"))) yield* copy(deps, report, top, canonTop, yield* realPath(fs, project.worktrees_root), wt, usable, links)
  for (const rel of links) {
    const r = yield* link(deps, top, canonTop, wt, rel)
    if ("err" in r) report.skipped.push(`${rel}: ${r.err}`)
    else if (r.ok === null) report.existing.push(rel)
    else report.linked.push(`${rel} -> ${r.ok}`)
  }
  return report
})

/**
 * Points the folder links in worktree `wt` that lead into the repository's old folder at its new one, after the
 * repository moved and the worktree was repaired (`map` gives a path's new place): those recorded for it, and those the
 * project's `link_folders` name. For relocation (`Relocation`, 6.11).
 */
export const relink = Effect.fnUntraced(function* (deps: FilesDeps, wt: string, linkFolders: string, map: (p: string) => string | null) {
  const { fs } = deps
  const links = yield* recorded(deps, wt)
  for (const l of entries(linkFolders)) {
    const r = linkPath(l)
    if ("ok" in r) links.push(r.ok)
  }
  for (const rel of [...new Set(links)].toSorted()) {
    // Not through a symlink in the worktree.
    if ((yield* notAFolder(fs, wt, rel)) !== null) continue
    const dest = join(wt, rel)
    const old = yield* fs.readLink(dest).pipe(Effect.orElseSucceed(() => null))
    if (old === null) continue
    const neu = map(old)
    if (neu === null || samePath(neu, old)) continue
    yield* fs.remove(dest).pipe(
      Effect.andThen(fs.symlink(neu, dest)),
      Effect.catch((e) => Effect.logWarning(`pointing ${dest} at ${neu}: ${ioText(e)}`)),
    )
  }
})
