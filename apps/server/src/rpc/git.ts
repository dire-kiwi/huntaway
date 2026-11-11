import { Effect } from "effect"
import { Conflict, GitRpcs, Invalid, NotFound, Unavailable } from "@huntaway/contracts"
import { ChangesTab } from "../git/ChangesTab.ts"
import type { ChangesError } from "../git/ChangesTab.ts"
import { TaskBase } from "../git/TaskBase.ts"
import { Worktrees } from "../git/Worktrees.ts"

const notFound = (e: { readonly id: string }) => Effect.fail(new NotFound({ what: "task", id: e.id }))
const busy = (e: { readonly message: string }) => Effect.fail(new Conflict({ reason: "agent_running", detail: e.message }))

/** The Changes tab's errors on the wire: git's refusal was the old 409, a wrong request the old 400. */
const changes = <A>(effect: Effect.Effect<A, ChangesError>) =>
  effect.pipe(
    Effect.catchTags({
      TaskNotFound: notFound,
      ChangesRefused: (e) => Effect.fail(new Conflict({ reason: e.reason, detail: e.detail })),
      ChangesInvalid: (e) => Effect.fail(new Invalid({ field: e.field, reason: e.reason })),
      GitFailed: (e) => Effect.fail(new Unavailable({ what: "git", reason: e.reason })),
    }),
  )

export const GitHandlers = GitRpcs.toLayer(
  Effect.gen(function* () {
    const worktrees = yield* Worktrees
    const base = yield* TaskBase
    const tab = yield* ChangesTab
    return GitRpcs.of({
      // A setup that fails was the old 400.
      "git.setupWorktree": ({ id }) =>
        worktrees.setup(id, { idle: true }).pipe(
          Effect.catchTags({
            TaskNotFound: notFound,
            AgentInWorktree: busy,
            WorktreeFailed: (e) => Effect.fail(new Invalid({ field: "worktree", reason: e.reason })),
          }),
        ),
      // A teardown refused or failed was the old 409, with its reason.
      "git.teardownWorktree": ({ id, force, delete_branch }) =>
        worktrees.teardown(id, { idle: true, force: force ?? false, deleteBranch: delete_branch ?? false }).pipe(
          Effect.catchTags({
            TaskNotFound: notFound,
            AgentInWorktree: busy,
            WorktreeFailed: (e) => Effect.fail(new Conflict({ reason: "worktree_kept", detail: e.reason })),
          }),
        ),
      "git.taskDiff": ({ id }) => base.diff(id).pipe(Effect.catchTag("TaskNotFound", notFound)),
      "git.status": ({ id }) => changes(tab.status(id)),
      "git.diff": ({ id, path, staged, untracked }) => changes(tab.diff(id, path, { staged: staged ?? false, untracked: untracked ?? false })),
      "git.show": ({ id, rev, stash }) => changes(tab.show(id, rev, stash ?? false)),
      "git.stage": ({ id, paths }) => changes(tab.stage(id, paths)),
      "git.unstage": ({ id, paths }) => changes(tab.unstage(id, paths)),
      "git.discard": ({ id, paths, staged }) => changes(tab.discard(id, paths, staged ?? false)),
      "git.apply": ({ id, patch, cached, reverse }) => changes(tab.apply(id, patch, { cached: cached ?? false, reverse: reverse ?? false })),
      "git.commit": ({ id, message, amend, reword }) =>
        changes(Effect.map(tab.commit(id, message, { amend: amend ?? false, reword: reword ?? false }), (head) => ({ head }))),
      "git.stash": ({ id, ...request }) => changes(Effect.map(tab.stash(id, request), (output) => ({ output }))),
      "git.reset": ({ id, rev, mode }) => changes(tab.reset(id, rev, mode)),
    })
  }),
)
