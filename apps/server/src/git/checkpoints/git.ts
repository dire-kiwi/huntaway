import type { FileSystem } from "effect"
import { Effect, Option } from "effect"
import type { GitBytes, GitFailed, GitShape } from "../Git.ts"
import { clearLocation } from "../Git.ts"
import { lines } from "../paths.ts"
import { CheckpointFailed, MAX_UNTRACKED, MAX_UNTRACKED_FILE } from "./model.ts"
import type { Checkpoint, Snap } from "./model.ts"

// Running git for checkpoints (huntaway's git/checkpoints/git.ts): never with a git environment the server may have
// been started with (`GIT_DIR` and the like cleared), never taking an optional lock (`GIT_OPTIONAL_LOCKS=0`), scratch
// indexes, snapshots of a worktree, and the checkpoint refs.
//
// Paths from git are bytes. They are kept as "byte strings" (one char per byte, so any path round-trips into git's
// stdin), shown decoded as UTF-8 (`lossy`), and given to the file system as UTF-8 text (`fsPath`): a path that isn't
// UTF-8 is not touched on disk (a rewind leaves it as it is, and says so).

/** What the checkpoint code runs git and the file system with. */
export interface Tools {
  /** `git -C dir args` for checkpoints; fails only when git could not run. */
  readonly run: (dir: string, args: ReadonlyArray<string>, options?: RunOptions) => Effect.Effect<GitBytes, GitFailed>
  /** As `run`, failing on a non-zero exit with `git <first arg> failed: <stderr>`. */
  readonly ok: (dir: string, args: ReadonlyArray<string>, options?: RunOptions) => Effect.Effect<Uint8Array, CheckpointFailed>
  readonly fs: FileSystem.FileSystem
  /** A fresh unique name (a scratch index's). */
  readonly uuid: Effect.Effect<string>
}

export interface RunOptions {
  readonly env?: Readonly<Record<string, string>>
  readonly stdin?: string | Uint8Array
}

/** The checkpoint tools over `Git`. Long timeouts: a snapshot of a large worktree takes what it takes. */
export const tools = (git: GitShape, fs: FileSystem.FileSystem, uuid: Effect.Effect<string>): Tools => {
  const run = (dir: string, args: ReadonlyArray<string>, options: RunOptions = {}) =>
    git.bytes(dir, args, {
      env: { ...clearLocation, ...options.env },
      noLocks: true,
      timeout: "10 minutes",
      ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
    })
  const ok = (dir: string, args: ReadonlyArray<string>, options?: RunOptions) =>
    run(dir, args, options).pipe(
      Effect.mapError((e) => new CheckpointFailed({ reason: `git ${args[0] ?? ""} failed: ${e.reason}` })),
      Effect.flatMap((out) =>
        out.ok ? Effect.succeed(out.stdout) : Effect.fail(new CheckpointFailed({ reason: `git ${args[0] ?? ""} failed: ${out.stderr.trim()}` })),
      ),
    )
  return { run, ok, fs, uuid }
}

const utf8 = new TextDecoder()
const strictUtf8 = new TextDecoder("utf-8", { fatal: true })

/** Bytes as a byte string: one char per byte. */
export const byteString = (bytes: Uint8Array): string => {
  let out = ""
  for (let i = 0; i < bytes.length; i += 8192) out += String.fromCharCode(...bytes.subarray(i, i + 8192))
  return out
}

/** A byte string's bytes. */
export const bytesOf = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff)

/** Output as text, trimmed. */
export const text = (bytes: Uint8Array): string => utf8.decode(bytes).trim()

/** NUL-separated output's non-empty parts, as byte strings. */
export const splitNul = (bytes: Uint8Array): Array<string> =>
  byteString(bytes)
    .split("\0")
    .filter((p) => p !== "")

/** A path from git (a byte string) as text. */
export const lossy = (p: string): string => utf8.decode(bytesOf(p))

/** A path from git (a byte string) under `top`, for the file system; null when it isn't UTF-8. */
export const fsPath = (top: string, rel: string): string | null => {
  try {
    return `${top}/${strictUtf8.decode(bytesOf(rel))}`
  } catch {
    return null
  }
}

/** NUL-terminated paths (byte strings), as `--stdin -z` and `--pathspec-file-nul` take them. */
export const nulList = (paths: Iterable<string>): Uint8Array => {
  let s = ""
  for (const p of paths) s += `${p}\0`
  return bytesOf(s)
}

/** The lines of text output. */
export const outputLines = (bytes: Uint8Array): Array<string> => lines(utf8.decode(bytes))

/** The folder of a path. */
const dirname = (p: string): string => {
  const i = p.lastIndexOf("/")
  return i <= 0 ? "/" : p.slice(0, i)
}

const fsFailed = (what: string) => (e: { readonly message: string }) => new CheckpointFailed({ reason: `${what}: ${e.message}` })

/**
 * Runs `use` with an index of its own in the worktree's git directory (`GIT_INDEX_FILE`), removed after: a copy of the
 * worktree's index (so `git add` only looks again at what changed), or an empty one.
 */
export const withScratchIndex = <A, E>(
  t: Tools,
  top: string,
  copy: boolean,
  use: (env: Readonly<Record<string, string>>) => Effect.Effect<A, E>,
): Effect.Effect<A, E | CheckpointFailed> =>
  Effect.acquireUseRelease(
    Effect.gen(function* () {
      const index = text(yield* t.ok(top, ["rev-parse", "--path-format=absolute", "--git-path", "index"]))
      const scratch = `${dirname(index)}/huntaway-checkpoint-${yield* t.uuid}.index`
      if (copy && (yield* t.fs.exists(index).pipe(Effect.orElseSucceed(() => false)))) {
        // The copy keeps the index's time (HA-237). Git takes an entry whose file changed in the second the index was
        // written for one that may have changed since, and reads the file; with the copy's own, later time it trusts the
        // entry, so a file rewritten in that second at the same size, as the agent's first edit after the worktree's
        // checkout can be, looks unchanged. Read before copying, so an index written meanwhile gets an earlier time
        // rather than a later one (which only means more files read), and to the second, at or before git's own reading.
        const info = yield* t.fs.stat(index).pipe(Effect.mapError(fsFailed("reading the worktree's index")))
        const seconds = Math.floor(
          Option.getOrElse(
            Option.map(info.mtime, (d) => d.getTime()),
            () => 0,
          ) / 1000,
        )
        yield* t.fs.copyFile(index, scratch).pipe(Effect.mapError(fsFailed("copying the worktree's index")))
        yield* t.fs.utimes(scratch, seconds, seconds).pipe(Effect.mapError(fsFailed("copying the worktree's index")))
      }
      return scratch
    }),
    (scratch) => use({ GIT_INDEX_FILE: scratch }),
    (scratch) => Effect.andThen(t.fs.remove(scratch, { force: true }).pipe(Effect.ignore), t.fs.remove(`${scratch}.lock`, { force: true }).pipe(Effect.ignore)),
  )

const IDENTITY = {
  GIT_AUTHOR_NAME: "Huntaway",
  GIT_AUTHOR_EMAIL: "huntaway@localhost",
  GIT_COMMITTER_NAME: "Huntaway",
  GIT_COMMITTER_EMAIL: "huntaway@localhost",
}

/** The worktree's HEAD commit, null before its first. */
export const head = (t: Tools, top: string): Effect.Effect<string | null> =>
  t.run(top, ["rev-parse", "-q", "--verify", "HEAD^{commit}"]).pipe(
    Effect.map((o) => (o.ok && text(o.stdout) !== "" ? text(o.stdout) : null)),
    Effect.orElseSucceed(() => null),
  )

/**
 * The tree of everything in the worktree at `top` that git doesn't ignore, and its HEAD, as a commit (`last`'s, when
 * nothing has changed since it).
 */
export const snapshot = Effect.fnUntraced(function* (t: Tools, top: string, last: Checkpoint | null) {
  // Before the files, so a commit made meanwhile shows up in the files rather than only in HEAD.
  const h = yield* head(t, top)
  const tree = yield* withScratchIndex(t, top, true, (env) =>
    Effect.gen(function* () {
      const untracked = splitNul(yield* t.ok(top, ["ls-files", "-z", "--others", "--exclude-standard"], { env }))
      if (untracked.length > MAX_UNTRACKED) {
        return yield* new CheckpointFailed({
          reason: `the worktree has ${untracked.length} untracked files, too many to take a checkpoint of (should some be ignored?)`,
        })
      }
      let spec = ".\0"
      for (const p of untracked) {
        const path = fsPath(top, p)
        const info = path === null ? null : Option.getOrNull(yield* Effect.option(t.fs.lstat(path)))
        if (info !== null && info.type === "File" && Number(info.size) > MAX_UNTRACKED_FILE) spec += `:(exclude,literal)${p}\0`
      }
      // A file that can't be read is left out, rather than the whole checkpoint.
      const added = yield* t
        .run(top, ["-c", "core.splitIndex=false", "add", "-A", "--ignore-errors", "--pathspec-from-file=-", "--pathspec-file-nul"], {
          env,
          stdin: bytesOf(spec),
        })
        .pipe(Effect.mapError((e) => new CheckpointFailed({ reason: `git add failed: ${e.reason}` })))
      if (!added.ok) yield* Effect.logWarning(`git add for a checkpoint in ${top}: ${added.stderr.trim()}`)
      return text(yield* t.ok(top, ["write-tree"], { env }))
    }),
  )
  if (last !== null && last.tree === tree && last.head === h) {
    const same: Snap = { sha: last.sha, tree, head: h }
    return same
  }
  const sha = text(yield* t.ok(top, ["commit-tree", "--no-gpg-sign", "-m", "Huntaway checkpoint", ...(h === null ? [] : ["-p", h]), tree], { env: IDENTITY }))
  const snap: Snap = { sha, tree, head: h }
  return snap
})
