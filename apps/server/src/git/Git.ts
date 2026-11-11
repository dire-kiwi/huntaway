import { Context, Duration, Effect, FileSystem, Layer, Schema, Stream } from "effect"
import type { PlatformError, Scope } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { ServerConfig } from "../platform/ServerConfig.ts"
import { lines } from "./paths.ts"

// Running git (docs/plan/06-server.md, Git; inventory 04, section 2.1; huntaway's git/worktree.ts): `git -C <dir> …` in
// the agents' environment with `GIT_TERMINAL_PROMPT=0`, so git never waits for credentials; `GIT_OPTIONAL_LOCKS=0` for
// what polls a worktree (the Changes tab, checkpoints), so a read never takes the index lock an agent's git may want. A
// non-zero exit is a result (`run`, `bytes`); `ok` turns it into `GitFailed` with git's own message, as the old `git_ok`.

/** What is kept of a command's output by default: a patch is cut at 2,000,000 characters, a file diff refused past 4 MiB. */
export const MAX_GIT_OUTPUT = 64 * 1024 * 1024

/** Git could not be run, did not end in time, or (`ok`) exited non-zero: `reason` is git's own message. */
export class GitFailed extends Schema.TaggedError<GitFailed, { readonly brand: unique symbol }>()("GitFailed", {
  /** `git <args>`, cut to 200 characters. */
  command: Schema.String,
  reason: Schema.String,
  /** The exit code; null when it did not start or was stopped. */
  code: Schema.NullOr(Schema.Int),
}) {}

export interface GitOptions {
  /** Written to git's stdin (else it is empty). */
  readonly stdin?: string | Uint8Array
  /** Default 60 seconds. */
  readonly timeout?: Duration.Input
  /** Set (or, undefined, removed) over the agents' environment. */
  readonly env?: Readonly<Record<string, string | undefined>>
  /** `GIT_OPTIONAL_LOCKS=0`: for reads that poll a worktree, which must not take its index lock. */
  readonly noLocks?: boolean
  /** Run in this folder instead of `-C <dir>` (`dir` is then left out of the arguments). */
  readonly bare?: boolean
  /** Bytes kept of stdout (default `MAX_GIT_OUTPUT`); `truncated` says more was printed. */
  readonly maxBytes?: number
}

export interface GitOutput {
  readonly code: number
  readonly ok: boolean
  readonly stdout: string
  readonly stderr: string
}

export interface GitBytes {
  readonly code: number
  readonly ok: boolean
  readonly stdout: Uint8Array
  readonly stderr: string
  /** stdout was longer than `maxBytes`. */
  readonly truncated: boolean
}

/** The variables that point git at another repository, index or object store: cleared where the board's own git must not follow them. */
export const GIT_LOCATION_VARS = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_COMMON_DIR", "GIT_NAMESPACE"] as const

/** The location variables, unset: for `GitOptions.env`. */
export const clearLocation: Readonly<Record<string, undefined>> = Object.fromEntries(GIT_LOCATION_VARS.map((name) => [name, undefined]))

export interface GitShape {
  /** `git -C dir args`: its output as text, and how it exited. Fails only when git could not run or timed out. */
  readonly run: (dir: string, args: ReadonlyArray<string>, options?: GitOptions) => Effect.Effect<GitOutput, GitFailed>
  /** As `run`, with stdout as bytes (a diff that may not be UTF-8, an object's contents). */
  readonly bytes: (dir: string, args: ReadonlyArray<string>, options?: GitOptions) => Effect.Effect<GitBytes, GitFailed>
  /** As `run`, failing with `git <args> failed: <stderr>` on a non-zero exit: its stdout. */
  readonly ok: (dir: string, args: ReadonlyArray<string>, options?: GitOptions) => Effect.Effect<string, GitFailed>
  /** Whether `dir` is in a git repository. */
  readonly isRepo: (dir: string) => Effect.Effect<boolean>
  /** The branch checked out in `dir` (`symbolic-ref`), or null (detached, not a repository). */
  readonly currentBranch: (dir: string) => Effect.Effect<string | null>
  /** The commit `rev` names, if it names one. */
  readonly commit: (repo: string, rev: string) => Effect.Effect<string | null>
  /** Whether commit `a` is in `b`'s history (or is `b`). */
  readonly isAncestor: (repo: string, a: string, b: string) => Effect.Effect<boolean>
  /** The worktree (main checkout included) that has `branchRef` (`refs/heads/x`) checked out, if any. */
  readonly checkedOutIn: (repo: string, branchRef: string) => Effect.Effect<string | null>
  /** Whether `dir` is one of `repo`'s worktrees (the main checkout included), by git's own list. */
  readonly isWorktreeOf: (repo: string, dir: string) => Effect.Effect<boolean>
  /**
   * Whether git takes `name` for a branch name (`git check-ref-format --branch`), run outside any repository so that
   * `@{-1}` (the branch checked out before) isn't taken for the one it names.
   */
  readonly validBranchName: (name: string) => Effect.Effect<boolean>
  /** The real path (`realpath`), or null when it can't be resolved (the old `canonicalize`). */
  readonly canonicalize: (path: string) => Effect.Effect<string | null>
}

const collect = (stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>, max: number) =>
  stream.pipe(
    Stream.runFold(
      () => ({ chunks: [] as Array<Uint8Array>, size: 0, truncated: false }),
      (acc, chunk) => {
        if (acc.size >= max) return { ...acc, truncated: true }
        const room = max - acc.size
        const part = chunk.length > room ? chunk.subarray(0, room) : chunk
        acc.chunks.push(part)
        return { chunks: acc.chunks, size: acc.size + part.length, truncated: acc.truncated || part.length < chunk.length }
      },
    ),
    Effect.map(({ chunks, size, truncated }) => {
      const out = new Uint8Array(size)
      let at = 0
      for (const c of chunks) {
        out.set(c, at)
        at += c.length
      }
      return { bytes: out, truncated }
    }),
  )

/** What a failed or timed-out read gives instead. */
const quietly = <A>(effect: Effect.Effect<A, GitFailed>, fallback: A) => effect.pipe(Effect.orElseSucceed(() => fallback))

const decoder = new TextDecoder()
const text = (bytes: Uint8Array) => decoder.decode(bytes)

export class Git extends Context.Service<Git, GitShape>()("huntaway-server/git/Git") {
  static readonly layer = Layer.effect(
    Git,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const config = yield* ServerConfig
      const fs = yield* FileSystem.FileSystem

      const bytes = Effect.fn("Git.bytes")(function* (dir: string, args: ReadonlyArray<string>, options: GitOptions = {}) {
        const argv = options.bare === true ? [...args] : ["-C", dir, ...args]
        const command = ["git", ...args].join(" ").slice(0, 200)
        const timeout = options.timeout ?? "60 seconds"
        const env = {
          ...config.agentEnv,
          GIT_TERMINAL_PROMPT: "0",
          ...(options.noLocks === true ? { GIT_OPTIONAL_LOCKS: "0" } : {}),
          ...options.env,
        }
        const input =
          options.stdin === undefined ? new Uint8Array(0) : typeof options.stdin === "string" ? new TextEncoder().encode(options.stdin) : options.stdin
        const once: Effect.Effect<GitBytes, PlatformError.PlatformError, Scope.Scope> = Effect.gen(function* () {
          const handle = yield* spawner.spawn(
            ChildProcess.make("git", argv, {
              ...(options.bare === true ? { cwd: dir } : {}),
              env,
              extendEnv: true,
              stdin: Stream.make(input),
            }),
          )
          const [stdout, stderr, code] = yield* Effect.all(
            [collect(handle.stdout, options.maxBytes ?? MAX_GIT_OUTPUT), collect(handle.stderr, 1024 * 1024), handle.exitCode],
            {
              concurrency: 3,
            },
          )
          const n = Number(code)
          return { code: n, ok: n === 0, stdout: stdout.bytes, stderr: text(stderr.bytes), truncated: stdout.truncated }
        })
        return yield* once.pipe(
          Effect.scoped,
          Effect.mapError((e) => new GitFailed({ command, reason: `failed to run git: ${e.message}`, code: null })),
          Effect.timeoutOrElse({
            duration: timeout,
            orElse: () => Effect.fail(new GitFailed({ command, reason: `timed out after ${Duration.format(Duration.fromInputUnsafe(timeout))}`, code: null })),
          }),
        )
      })

      const run = Effect.fn("Git.run")(function* (dir: string, args: ReadonlyArray<string>, options?: GitOptions) {
        const out = yield* bytes(dir, args, options)
        const result: GitOutput = { code: out.code, ok: out.ok, stdout: text(out.stdout), stderr: out.stderr }
        return result
      })

      const ok = Effect.fn("Git.ok")(function* (dir: string, args: ReadonlyArray<string>, options?: GitOptions) {
        const out = yield* run(dir, args, options)
        if (!out.ok) return yield* new GitFailed({ command: ["git", ...args].join(" ").slice(0, 200), reason: out.stderr.trim(), code: out.code })
        return out.stdout
      })

      const canonicalize = (path: string) => fs.realPath(path).pipe(Effect.orElseSucceed(() => null))

      const worktreeList = (repo: string) => quietly(ok(repo, ["worktree", "list", "--porcelain"]).pipe(Effect.map(lines)), null)

      return Git.of({
        run,
        bytes,
        ok,
        isRepo: (dir) =>
          quietly(
            Effect.map(run(dir, ["rev-parse", "--git-dir"]), (o) => o.ok),
            false,
          ),
        currentBranch: (dir) =>
          quietly(
            Effect.map(run(dir, ["symbolic-ref", "--short", "HEAD"]), (o) => (o.ok && o.stdout.trim() !== "" ? o.stdout.trim() : null)),
            null,
          ),
        commit: (repo, rev) =>
          quietly(
            Effect.map(ok(repo, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`]), (s) => s.trim()),
            null,
          ),
        isAncestor: (repo, a, b) =>
          quietly(
            Effect.map(run(repo, ["merge-base", "--is-ancestor", a, b]), (o) => o.ok),
            false,
          ),
        checkedOutIn: Effect.fnUntraced(function* (repo: string, branchRef: string) {
          const list = yield* worktreeList(repo)
          if (list === null) return null
          let dir: string | null = null
          for (const line of list) {
            if (line.startsWith("worktree ")) dir = line.slice("worktree ".length)
            else if (line.startsWith("branch ") && line.slice("branch ".length) === branchRef) return dir
          }
          return null
        }),
        isWorktreeOf: Effect.fnUntraced(function* (repo: string, dir: string) {
          const list = yield* worktreeList(repo)
          if (list === null) return false
          const d = (yield* canonicalize(dir)) ?? dir
          for (const line of list) {
            if (!line.startsWith("worktree ")) continue
            if ((yield* canonicalize(line.slice("worktree ".length))) === d) return true
          }
          return false
        }),
        validBranchName: (name) =>
          name.includes("@{")
            ? Effect.succeed(false)
            : quietly(
                Effect.map(
                  run("/", ["check-ref-format", "--branch", name], { bare: true, env: { GIT_DIR: undefined, GIT_WORK_TREE: undefined } }),
                  (o) => o.ok,
                ),
                false,
              ),
        canonicalize,
      })
    }),
  )
}
