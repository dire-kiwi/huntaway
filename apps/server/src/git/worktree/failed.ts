import { Effect, Schema } from "effect"
import type { GitFailed } from "../Git.ts"

/**
 * A worktree could not be set up or removed, or where a task starts could not be worked out: `reason` is what the old
 * server's error said (git's own message, "… is in the way", "worktree has uncommitted changes: …"), shown in the thread
 * and returned by the RPCs.
 */
export class WorktreeFailed extends Schema.TaggedError<WorktreeFailed, { readonly brand: unique symbol }>()("WorktreeFailed", {
  reason: Schema.String,
}) {
  override get message(): string {
    return this.reason
  }
}

/** Fail with `reason`. */
export const fail = (reason: string) => Effect.fail(new WorktreeFailed({ reason }))

/** A `GitFailed` as the old `git_ok`'s error: `git <args> failed: <stderr>`. */
export const fromGit = (e: GitFailed) => new WorktreeFailed({ reason: e.code === null ? `${e.command}: ${e.reason}` : `${e.command} failed: ${e.reason}` })

/** `context`: the old `context(what, e)`, "<what>: <reason>". */
export const within =
  (what: string) =>
  <A, R>(effect: Effect.Effect<A, WorktreeFailed | GitFailed, R>): Effect.Effect<A, WorktreeFailed, R> =>
    effect.pipe(Effect.mapError((e) => new WorktreeFailed({ reason: `${what}: ${e._tag === "GitFailed" ? fromGit(e).reason : e.reason}` })))

/** A `GitFailed` as a `WorktreeFailed`. */
export const orFail = <A, R>(effect: Effect.Effect<A, WorktreeFailed | GitFailed, R>): Effect.Effect<A, WorktreeFailed, R> =>
  effect.pipe(Effect.mapError((e) => (e._tag === "GitFailed" ? fromGit(e) : e)))
