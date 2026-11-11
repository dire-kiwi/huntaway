import { Context, Effect, FileSystem, Layer, Schema } from "effect"
import type { GitFileDiff, GitResetMode, Project, Task, GitShown, GitStashAction, GitStashMode, GitStatus, RepoState, TaskId } from "@huntaway/contracts"
import type { TaskNotFound } from "../tasks/Tasks.ts"
import {
  badPath,
  badRev,
  BASE_COMMITS,
  listed,
  LOG_FORMAT,
  MAX_COMMITS,
  MAX_DIFF,
  numstatPaths,
  outsideFolder,
  parseLog,
  parseShown,
  parseStashes,
  parseStatus,
  REPO_STATES,
  SHOW_FORMAT,
  STASH_FORMAT,
  withPaths,
} from "./changes/parse.ts"
import { clearLocation, Git } from "./Git.ts"
import type { GitFailed } from "./Git.ts"
import { lines, truncate } from "./paths.ts"
import { TaskBase } from "./TaskBase.ts"

// The Changes tab (docs/plan/06-server.md, Git; inventory 04, section 2.8; huntaway's git/git_view.ts), a lazygit-style
// view of a task's repository: the working tree's files, the commits on the task's branch and the stashes, the diff of
// a file, commit or stash, and what can be done from there: staging and unstaging whole files or chosen lines (a patch
// the web app makes from a file's diff, applied to the index), discarding, committing, amending, stashing and resetting.
// Everything runs at the top of the folder `TaskBase.changesDir` gives: the task's worktree once it's ready, else its
// project's repository, with paths unquoted, no editor and no optional locks (polling the status mustn't take the index
// lock an agent's git command may want).
//
// A project's folder may be only part of a repository (a subfolder of a monorepo, or of a home folder kept as a dotfiles
// repository). Then the view is of that folder's files and the commits that touch them, staging and discarding is of
// its files only, and what would act on the whole repository (committing what's staged outside it, amending, stashing
// and resetting) is refused.

/** Git refused (its own message, the old 409), the action would act on the whole repository, or the stashes changed. */
export class ChangesRefused extends Schema.TaggedError<ChangesRefused, { readonly brand: unique symbol }>()("ChangesRefused", {
  reason: Schema.Literals(["git_refused", "whole_repository", "changed_meanwhile"]),
  detail: Schema.String,
}) {}

/** A request that is wrong (the old 400): a path outside the repository or the project's folder, a revision that isn't a hash. */
export class ChangesInvalid extends Schema.TaggedError<ChangesInvalid, { readonly brand: unique symbol }>()("ChangesInvalid", {
  field: Schema.String,
  reason: Schema.String,
}) {}

export type ChangesError = TaskNotFound | ChangesRefused | ChangesInvalid | GitFailed

export interface ChangesTabShape {
  /** The files with changes, the branch, its commits and the stashes; `available: false` when it isn't a git repository. */
  readonly status: (task: TaskId) => Effect.Effect<GitStatus, ChangesError>
  /**
   * A file's (or folder's) unstaged or `staged` changes, or an `untracked` file as if it were added, without rename
   * detection, for the web app to make patches of chosen lines from.
   */
  readonly diff: (task: TaskId, path: string, options: { readonly staged: boolean; readonly untracked: boolean }) => Effect.Effect<GitFileDiff, ChangesError>
  /** A commit's message and changes (a merge's against its first parent), or with `stash` a stash's (with its untracked files). */
  readonly show: (task: TaskId, rev: string, stash: boolean) => Effect.Effect<GitShown, ChangesError>
  /** Stages the files as they are (removed ones too), or everything (no paths). */
  readonly stage: (task: TaskId, paths: ReadonlyArray<string>) => Effect.Effect<void, ChangesError>
  /** Puts the files (or everything) in the index back as they are in HEAD. */
  readonly unstage: (task: TaskId, paths: ReadonlyArray<string>) => Effect.Effect<void, ChangesError>
  /**
   * Throws away the files' changes, deleting untracked ones (and, with `staged`, ones only in the index). With `staged`,
   * staged changes go too, back to HEAD; otherwise just what isn't staged, back to the index.
   */
  readonly discard: (task: TaskId, paths: ReadonlyArray<string>, staged: boolean) => Effect.Effect<void, ChangesError>
  /** Applies a patch of chosen lines to the index (`cached`: staging or unstaging lines) or the working tree (discarding them). */
  readonly apply: (task: TaskId, patch: string, options: { readonly cached: boolean; readonly reverse: boolean }) => Effect.Effect<void, ChangesError>
  /**
   * Commits what's staged. `amend`: into the last commit, with its message unless one is given. `reword`: just the last
   * commit's message, leaving out what's staged. The new HEAD.
   */
  readonly commit: (task: TaskId, message: string, options: { readonly amend: boolean; readonly reword: boolean }) => Effect.Effect<string, ChangesError>
  /**
   * Stashes changes (`push`: `mode` `all` with untracked files, `staged`, or `unstaged`, all but what's staged), or
   * applies, pops or drops the stash at `index` whose commit is `sha`, so that a list that changed since doesn't pick
   * another. What git said.
   */
  readonly stash: (task: TaskId, request: StashRequest) => Effect.Effect<string, ChangesError>
  /** Moves the branch to a commit. */
  readonly reset: (task: TaskId, rev: string, mode: GitResetMode) => Effect.Effect<void, ChangesError>
}

export interface StashRequest {
  readonly action: GitStashAction
  readonly mode?: GitStashMode | undefined
  readonly message?: string | undefined
  readonly index?: number | undefined
  readonly sha?: string | undefined
}

/** The task's changes: the top of the working tree they're in, the folder `changesDir` gave, and where that is in it. */
interface Repo {
  readonly top: string
  readonly dir: string
  /** Where `dir` is from `top` (`web/`, with its slash) when it isn't the top: the view is of it only. */
  readonly folder: string | null
  readonly task: Task
  readonly project: Project
}

/** What a git command did; `utf8` says whether its output was text a patch can be made from. */
interface Out {
  readonly ok: boolean
  readonly stdout: string
  readonly stderr: string
  readonly utf8: boolean
  /** Its output was longer than it was let be. */
  readonly truncated: boolean
}

const DIFF_ARGS = ["--no-color", "--no-ext-diff", "--src-prefix=a/", "--dst-prefix=b/"]

const lossy = new TextDecoder()
const strict = new TextDecoder("utf-8", { fatal: true })
const isUtf8 = (bytes: Uint8Array) => {
  try {
    strict.decode(bytes)
    return true
  } catch {
    return false
  }
}

const invalid = (field: string, reason: string) => new ChangesInvalid({ field, reason })

/** Git's own message for a command that failed: the repository isn't in a state for it. */
const failed = (o: Out) => new ChangesRefused({ reason: "git_refused", detail: [o.stderr.trim(), o.stdout.trim()].find((m) => m !== "") ?? "git failed" })

/** Refuses what would act on the whole repository when the project's folder is only part of it. */
const wholeRepo = (repo: Repo, what: string) =>
  repo.folder === null
    ? Effect.void
    : Effect.fail(
        new ChangesRefused({
          reason: "whole_repository",
          detail: `${what} would act on the whole repository at ${repo.top}, and the project's folder is only its ${repo.folder} folder: do it in a terminal there`,
        }),
      )

/** Checks paths from the top of the repository: in it, and in the project's folder. */
const checkPaths = (repo: Repo, paths: ReadonlyArray<string>) => {
  for (const p of paths) {
    const bad = badPath(p) ?? (repo.folder !== null ? outsideFolder(p, repo.folder) : null)
    if (bad !== null) return Effect.fail(invalid("paths", bad))
  }
  return Effect.void
}

/** The paths, or (none given) every file in the view. */
const orAll = (repo: Repo, paths: ReadonlyArray<string>): ReadonlyArray<string> => (repo.folder !== null && paths.length === 0 ? [repo.folder] : paths)

export class ChangesTab extends Context.Service<ChangesTab, ChangesTabShape>()("huntaway-server/git/ChangesTab") {
  static readonly layer = Layer.effect(
    ChangesTab,
    Effect.gen(function* () {
      const g = yield* Git
      const base = yield* TaskBase
      const fs = yield* FileSystem.FileSystem

      /** Runs git in `dir` with paths unquoted and no editor, with `stdin` on its stdin, keeping at most `max` bytes of its output. */
      const run = Effect.fnUntraced(function* (dir: string, args: ReadonlyArray<string>, stdin?: string, max?: number) {
        const o = yield* g.bytes(dir, ["-c", "core.quotePath=false", ...args], {
          noLocks: true,
          env: { ...clearLocation, GIT_EDITOR: "true" },
          ...(stdin !== undefined ? { stdin } : {}),
          ...(max !== undefined ? { maxBytes: max } : {}),
        })
        const out: Out = { ok: o.ok, stdout: lossy.decode(o.stdout), stderr: o.stderr, utf8: isUtf8(o.stdout), truncated: o.truncated }
        return out
      })

      /** `run`, failing with git's own message when git does. */
      const runOk = Effect.fnUntraced(function* (dir: string, args: ReadonlyArray<string>, stdin?: string) {
        const o = yield* run(dir, args, stdin)
        if (!o.ok) return yield* failed(o)
        return o.stdout
      })

      /** The task's working tree, if it's in one. */
      const repoOf = Effect.fnUntraced(function* (task: TaskId) {
        const { dir, task: t, project } = yield* base.changesDir(task)
        const o = yield* run(dir, ["rev-parse", "--show-toplevel", "--show-prefix"])
        if (!o.ok) return null
        const ls = lines(o.stdout)
        const repo: Repo = { top: ls[0] ?? "", dir, folder: ls[1] !== undefined && ls[1] !== "" ? ls[1] : null, task: t, project }
        return repo
      })

      const need = Effect.fnUntraced(function* (task: TaskId) {
        const repo = yield* repoOf(task)
        if (repo === null) return yield* invalid("repository", "not a git repository")
        return repo
      })

      const hasHead = (dir: string) => Effect.map(run(dir, ["rev-parse", "-q", "--verify", "HEAD^{commit}"]), (o) => o.ok)

      /** The commits on the branch since `mergeBase`, then a few from before it; without one, the latest. */
      const commits = Effect.fnUntraced(function* (dir: string, mergeBase: string | null, upstream: boolean, folder: string | null) {
        const unpushedOut = upstream ? (yield* run(dir, ["rev-list", "-n", String(MAX_COMMITS), "@{upstream}..HEAD"])).stdout : ""
        const unpushed = new Set(lines(unpushedOut))
        const log = (range: string, n: number) =>
          Effect.map(
            run(dir, ["--literal-pathspecs", "log", "--no-show-signature", LOG_FORMAT, "-n", String(n), range, "--", ...(folder !== null ? [folder] : [])]),
            (o) => (o.ok ? o.stdout : ""),
          )
        if (mergeBase !== null) {
          const onBranch = parseLog(yield* log(`${mergeBase}..HEAD`, MAX_COMMITS), true, unpushed)
          return [...onBranch, ...parseLog(yield* log(mergeBase, BASE_COMMITS), false, unpushed)]
        }
        return parseLog(yield* log("HEAD", MAX_COMMITS), false, unpushed)
      })

      const stashes = (dir: string) => Effect.map(run(dir, ["stash", "list", "--no-show-signature", STASH_FORMAT]), (o) => parseStashes(o.stdout))

      /** What the repository is in the middle of, if anything. */
      const repoState = Effect.fnUntraced(function* (dir: string) {
        const o = yield* run(dir, ["rev-parse", "--absolute-git-dir"]).pipe(Effect.orElseSucceed(() => null))
        if (o === null || !o.ok) return null
        const gitDir = o.stdout.trim()
        for (const [file, state] of REPO_STATES) {
          if (yield* fs.exists(`${gitDir}/${file}`).pipe(Effect.orElseSucceed(() => false))) {
            const s: RepoState = state
            return s
          }
        }
        return null
      })

      const status = Effect.fn("ChangesTab.status")(function* (id: TaskId) {
        const repo = yield* repoOf(id)
        if (repo === null) return { available: false, reason: "not a git repository" } satisfies GitStatus
        const { top, folder } = repo
        const out = yield* runOk(top, [
          "--literal-pathspecs",
          "status",
          "--porcelain=v2",
          "-z",
          "--branch",
          "--untracked-files=all",
          "--",
          ...(folder !== null ? [folder] : []),
        ])
        const st = parseStatus(out)
        const { base: baseBranch, start } = yield* base.changesBase(repo.dir, repo.task, repo.project)
        const list = st.head !== null ? yield* commits(top, start, st.upstream !== null, folder) : []
        // The repository's stashes aren't the folder's, and can't be used from here.
        const stashList = folder !== null ? [] : yield* stashes(top)
        const result: GitStatus = {
          available: true,
          dir: top,
          folder,
          head: st.head,
          branch: st.branch,
          upstream: st.upstream,
          ahead: st.ahead,
          behind: st.behind,
          base: baseBranch,
          merge_base: start,
          state: yield* repoState(top),
          files: st.files,
          truncated: st.truncated,
          commits: list,
          stashes: stashList,
        }
        return result
      })

      const diff = Effect.fn("ChangesTab.diff")(function* (id: TaskId, path: string, options: { readonly staged: boolean; readonly untracked: boolean }) {
        const repo = yield* need(id)
        yield* checkPaths(repo, [path])
        const args = ["--literal-pathspecs", "diff", ...DIFF_ARGS]
        if (options.untracked) args.push("--no-index", "--", "/dev/null", path)
        else args.push("--no-renames", ...(options.staged ? ["--cached"] : []), "--", path)
        const o = yield* run(repo.top, args, undefined, MAX_DIFF + 1)
        // `--no-index` exits 1 when there's a difference.
        if (!o.ok && !(options.untracked && o.stdout !== "")) return yield* failed(o)
        if (o.truncated) return { patch: "", too_large: true } satisfies GitFileDiff
        // A patch made from a lossily decoded diff would write U+FFFD where its other bytes were: such a file is only
        // staged or discarded whole.
        if (!o.utf8) return { patch: "", not_utf8: true, preview: o.stdout } satisfies GitFileDiff
        return { patch: o.stdout } satisfies GitFileDiff
      })

      const show = Effect.fn("ChangesTab.show")(function* (id: TaskId, rev: string, stash: boolean) {
        const bad = badRev(rev)
        if (bad !== null) return yield* invalid("rev", bad)
        const t = (yield* need(id)).top
        if (stash) {
          const args = ["stash", "show", "-p", "--include-untracked", ...DIFF_ARGS, rev]
          let o = yield* run(t, args)
          // `--include-untracked` is git 2.32's.
          if (!o.ok)
            o = yield* run(
              t,
              args.filter((a) => a !== "--include-untracked"),
            )
          if (!o.ok) return yield* new ChangesRefused({ reason: "git_refused", detail: o.stderr.trim() })
          return { patch: truncate(o.stdout, MAX_DIFF) } satisfies GitShown
        }
        const meta = parseShown(yield* runOk(t, ["show", "-s", "--no-show-signature", SHOW_FORMAT, rev, "--"]))
        if (meta === null) return yield* new ChangesRefused({ reason: "git_refused", detail: `can't read commit ${rev}` })
        const patch = yield* runOk(t, ["show", "--format=", "--no-show-signature", "-M", "-m", "--first-parent", ...DIFF_ARGS, rev, "--"])
        return { ...meta, patch: truncate(patch, MAX_DIFF) } satisfies GitShown
      })

      const stage = Effect.fn("ChangesTab.stage")(function* (id: TaskId, paths: ReadonlyArray<string>) {
        const repo = yield* need(id)
        yield* checkPaths(repo, paths)
        yield* runOk(repo.top, withPaths(["add", "-A"], orAll(repo, paths)))
      })

      const unstage = Effect.fn("ChangesTab.unstage")(function* (id: TaskId, given: ReadonlyArray<string>) {
        const repo = yield* need(id)
        yield* checkPaths(repo, given)
        const paths = orAll(repo, given)
        if (yield* hasHead(repo.top)) yield* runOk(repo.top, withPaths(["reset", "-q", "HEAD"], paths))
        // Before the first commit, there's nothing to go back to: they're taken out of the index.
        else yield* runOk(repo.top, withPaths(["rm", "-r", "-q", "--cached", "--ignore-unmatch"], paths.length === 0 ? ["."] : paths))
      })

      const discard = Effect.fn("ChangesTab.discard")(function* (id: TaskId, paths: ReadonlyArray<string>, staged: boolean) {
        if (paths.length === 0) return yield* invalid("paths", "no files to discard")
        const repo = yield* need(id)
        yield* checkPaths(repo, paths)
        const t = repo.top
        // HA-341: files, as the Changes tab lists them. A folder would have its untracked files cleaned but its tracked
        // ones left as they are, as it's in no list of files.
        for (const p of paths) {
          const info = yield* fs.stat(`${t}/${p}`).pipe(Effect.orElseSucceed(() => null))
          if (info?.type === "Directory") return yield* invalid("paths", `${p} is a folder: discard its files`)
        }
        const inIndex = listed(yield* runOk(t, withPaths(["ls-files", "-z"], paths)), paths)
        const inHead = staged && (yield* hasHead(t)) ? listed(yield* runOk(t, withPaths(["ls-tree", "-r", "-z", "--name-only", "HEAD"], paths)), paths) : []
        const untracked = paths.filter((p) => !inIndex.includes(p) && !inHead.includes(p))
        if (staged) {
          const added = inIndex.filter((p) => !inHead.includes(p))
          if (inHead.length > 0) yield* runOk(t, withPaths(["restore", "--source=HEAD", "--staged", "--worktree"], inHead))
          if (added.length > 0) yield* runOk(t, withPaths(["rm", "-q", "-f"], added))
        } else if (inIndex.length > 0) yield* runOk(t, withPaths(["restore", "--worktree"], inIndex))
        if (untracked.length > 0) yield* runOk(t, withPaths(["clean", "-f", "-q"], untracked))
        return yield* Effect.void
      })

      const apply = Effect.fn("ChangesTab.apply")(function* (id: TaskId, patch: string, options: { readonly cached: boolean; readonly reverse: boolean }) {
        const repo = yield* need(id)
        if (repo.folder !== null) {
          // The files the patch is of, without applying it.
          yield* checkPaths(repo, numstatPaths(yield* runOk(repo.top, ["apply", "--numstat", "-z", "-"], patch)))
        }
        yield* runOk(repo.top, ["apply", "--whitespace=nowarn", ...(options.cached ? ["--cached"] : []), ...(options.reverse ? ["-R"] : []), "-"], patch)
      })

      const commit = Effect.fn("ChangesTab.commit")(function* (id: TaskId, given: string, options: { readonly amend: boolean; readonly reword: boolean }) {
        const repo = yield* need(id)
        const t = repo.top
        if (options.amend || options.reword) yield* wholeRepo(repo, "Changing the last commit")
        // What's staged outside the project's folder would go in the commit too.
        if (repo.folder !== null) {
          const f = repo.folder
          const outside = yield* runOk(t, ["diff", "--cached", "--name-only", "-z", "--", ":(top)", `:(exclude,top,literal)${f}`])
          const file = outside.split("\0").find((p) => p !== "")
          if (file !== undefined) {
            return yield* new ChangesRefused({
              reason: "git_refused",
              detail: `${file} is staged too, and isn't in the project's folder (${f}): unstage what's outside it in a terminal at ${t}, or commit it there`,
            })
          }
        }
        const message = given.trim()
        if (message === "" && !(options.amend && !options.reword)) return yield* invalid("message", "the commit needs a message")
        const args = ["commit", "-q"]
        if (options.reword) args.push("--amend", "--only", "--allow-empty")
        else if (options.amend) args.push("--amend")
        if (message === "") args.push("--no-edit")
        else args.push("-F", "-")
        yield* runOk(t, args, message !== "" ? message : undefined)
        return (yield* runOk(t, ["rev-parse", "HEAD"])).trim()
      })

      const stash = Effect.fn("ChangesTab.stash")(function* (id: TaskId, request: StashRequest) {
        const repo = yield* need(id)
        yield* wholeRepo(repo, "Stashing")
        const t = repo.top
        const message = (request.message ?? "").trim()
        if (request.action === "push") {
          const mode = request.mode ?? "all"
          const args = [
            "stash",
            "push",
            ...(mode === "all" ? ["--include-untracked"] : mode === "staged" ? ["--staged"] : ["--keep-index", "--include-untracked"]),
          ]
          if (message !== "") args.push("-m", message)
          return (yield* runOk(t, args)).trim()
        }
        const { index, sha } = request
        if (index === undefined || sha === undefined) return yield* invalid("index", "which stash?")
        if (index < 0) return yield* invalid("index", `not a stash: ${index}`)
        const name = `stash@{${index}}`
        const at = (yield* run(t, ["rev-parse", "-q", "--verify", name])).stdout
        if (at.trim() !== sha) return yield* new ChangesRefused({ reason: "changed_meanwhile", detail: "the stashes have changed: refresh and try again" })
        return (yield* runOk(t, ["stash", request.action, "-q", name])).trim()
      })

      const reset = Effect.fn("ChangesTab.reset")(function* (id: TaskId, rev: string, mode: GitResetMode) {
        const bad = badRev(rev)
        if (bad !== null) return yield* invalid("rev", bad)
        const repo = yield* need(id)
        yield* wholeRepo(repo, "Resetting")
        return yield* Effect.asVoid(runOk(repo.top, ["reset", "-q", `--${mode}`, `${rev}^{commit}`]))
      })

      return ChangesTab.of({ status, diff, show, stage, unstage, discard, apply, commit, stash, reset })
    }),
  )
}
