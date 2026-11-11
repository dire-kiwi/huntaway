import { Effect, Option } from "effect"
import type { FileSystem } from "effect"
import { byteString, fsPath, head, lossy, nulList, splitNul, withScratchIndex } from "./git.ts"
import type { Tools } from "./git.ts"
import { CheckpointFailed } from "./model.ts"

// Restoring a worktree's files to a checkpoint (huntaway's git/checkpoints/restore.ts). Paths are byte strings (see
// git.ts); one that isn't UTF-8 is left as it is.

export interface Restored {
  readonly written: number
  readonly removed: number
  /**
   * Files left as they are: submodules and other repositories, files the index marks skip-worktree or assume-unchanged,
   * files the checkpoints don't have (see `safeToWrite`), and paths that aren't UTF-8.
   */
  readonly skipped: ReadonlyArray<string>
  /** The files written or removed. */
  readonly changed: ReadonlySet<string>
  /** The files marked skip-worktree or assume-unchanged. */
  readonly hidden: ReadonlySet<string>
}

/**
 * The normal parts of a relative path (a byte string), as Rust's `Path::components` gives them: null if it has any
 * other (root, `..`, a `.` past the first).
 */
const parts = (rel: string): Array<string> | null => {
  if (rel.startsWith("/")) return null
  const ps = rel.split("/").filter((p, i) => p !== "" && !(p === "." && i > 0))
  return ps.some((p) => p === "." || p === "..") ? null : ps
}

const lstat = (fs: FileSystem.FileSystem, path: string) => Effect.map(Effect.option(fs.lstat(path)), Option.getOrNull)

/**
 * Whether the file `rel` can be written in the worktree at `top` without losing anything that isn't in the checkpoint
 * taken just before (`inNow`: that has the file): `checkout-index -f` would remove a folder in its way with all that's
 * in it, and overwrite whatever is there. So not where a folder is (one the restore didn't empty: it holds ignored
 * files, say), not inside another repository or through a symlink, and not over a file the checkpoint doesn't have (one
 * ignored since, too big, or unreadable).
 */
const safeToWrite = Effect.fnUntraced(function* (fs: FileSystem.FileSystem, top: string, rel: string, inNow: boolean) {
  const ps = parts(rel)
  if (ps === null || ps.length === 0) return false
  let dir = ""
  for (const d of ps.slice(0, -1)) {
    dir = dir === "" ? d : `${dir}/${d}`
    const path = fsPath(top, dir)
    if (path === null) return false
    const m = yield* lstat(fs, path)
    // Not there: nothing below it is either.
    if (m === null) return true
    if (m.type !== "Directory") return false
    if ((yield* lstat(fs, `${path}/.git`)) !== null) return false
  }
  const path = fsPath(top, rel)
  if (path === null) return false
  const m = yield* lstat(fs, path)
  if (m === null) return true
  if (m.type === "Directory") return false
  return inNow
})

/**
 * Remove the file `rel` from the worktree at `top` (not a folder, and nothing through a symlink), then the folders it
 * leaves empty: `removed`, `absent` (nothing to remove), or `skipped` (a path that isn't UTF-8).
 */
const removeFile = Effect.fnUntraced(function* (fs: FileSystem.FileSystem, top: string, rel: string) {
  const ps = parts(rel)
  if (ps === null) return yield* new CheckpointFailed({ reason: `${lossy(rel)} is not a path in the worktree` })
  if (ps.length === 0) return "absent" as const
  const dirs: Array<string> = []
  let dir = ""
  for (const d of ps.slice(0, -1)) {
    dir = dir === "" ? d : `${dir}/${d}`
    const path = fsPath(top, dir)
    if (path === null) return "skipped" as const
    const m = yield* lstat(fs, path)
    if (m === null || m.type !== "Directory") return "absent" as const
    dirs.push(path)
  }
  const path = fsPath(top, rel)
  if (path === null) return "skipped" as const
  const m = yield* lstat(fs, path)
  if (m === null || m.type === "Directory") return "absent" as const
  yield* fs.remove(path).pipe(Effect.mapError((e) => new CheckpointFailed({ reason: `removing ${lossy(rel)}: ${e.message}` })))
  // The folders it was in, deepest first, up to (not including) the top, while they're empty.
  for (const d of dirs.toReversed()) {
    const left = yield* Effect.option(fs.readDirectory(d))
    if (Option.isNone(left) || left.value.length > 0) break
    if (Option.isNone(yield* Effect.option(fs.remove(d, { recursive: true })))) break
  }
  return "removed" as const
})

/**
 * Make the worktree at `top`, whose files are `now` (a tree from `snapshot`), have the files of tree `to`: only the
 * files that differ are written or removed, and only where nothing else would go with them (ignored files and the rest
 * are left alone).
 */
export const restore = Effect.fnUntraced(function* (t: Tools, top: string, now: string, to: string) {
  const raw = yield* t.ok(top, ["diff-tree", "-r", "-z", "--no-renames", now, to])
  const hidden = new Set<string>()
  for (const e of splitNul(yield* t.ok(top, ["ls-files", "-v", "-z"]))) {
    const tag = e[0] ?? ""
    if (e.length > 2 && (tag === "S" || (tag >= "a" && tag <= "z"))) hidden.add(e.slice(2))
  }
  const skipped: Array<string> = []
  const changed = new Set<string>()
  // (path, whether `now` has it)
  const write: Array<readonly [string, boolean]> = []
  const remove: Array<string> = []
  const fields = byteString(raw).split("\0")
  for (let i = 0; i < fields.length; i++) {
    const meta = fields[i] ?? ""
    if (meta === "") continue
    if (i + 1 >= fields.length) break
    const path = fields[++i] ?? ""
    // `:<old mode> <new mode> <old sha> <new sha> <status>`
    const m = meta.replace(/^:+/, "").split(" ")
    const [oldMode, newMode] = [m[0] ?? "", m[1] ?? ""]
    if (oldMode === "160000" || newMode === "160000" || hidden.has(path)) skipped.push(lossy(path))
    else if (newMode === "000000") remove.push(path)
    else write.push([path, oldMode !== "000000"])
  }
  let removed = 0
  for (const p of remove) {
    const done = yield* removeFile(t.fs, top, p)
    if (done === "removed") {
      removed += 1
      changed.add(p)
    } else if (done === "skipped") skipped.push(lossy(p))
  }
  const ok: Array<string> = []
  for (const [p, inNow] of write) {
    if (yield* safeToWrite(t.fs, top, p, inNow)) ok.push(p)
    else skipped.push(lossy(p))
  }
  if (ok.length > 0) {
    yield* withScratchIndex(t, top, false, (env) =>
      Effect.andThen(t.ok(top, ["read-tree", to], { env }), t.ok(top, ["checkout-index", "-f", "-z", "--stdin"], { env, stdin: nulList(ok) })),
    )
    for (const p of ok) changed.add(p)
  }
  const restored: Restored = { written: ok.length, removed, skipped, changed, hidden }
  return restored
})

/** Put `paths` back in the index as they are in HEAD. */
export const unstaged = Effect.fnUntraced(function* (t: Tools, top: string, paths: ReadonlySet<string>) {
  if (paths.size === 0 || (yield* head(t, top)) === null) return
  const sorted = [...paths].toSorted()
  yield* t.ok(top, ["--literal-pathspecs", "reset", "-q", "--pathspec-from-file=-", "--pathspec-file-nul"], { stdin: nulList(sorted) })
})
