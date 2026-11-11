import { Effect } from "effect"
import { Conflict, GitRpcs, Invalid, NotFound } from "@huntaway/contracts"
import { TaskBase } from "../git/TaskBase.ts"
import { Worktrees } from "../git/Worktrees.ts"

const notFound = (e: { readonly id: string }) => Effect.fail(new NotFound({ what: "task", id: e.id }))
const busy = (e: { readonly message: string }) => Effect.fail(new Conflict({ reason: "agent_running", detail: e.message }))

export const GitHandlers = GitRpcs.toLayer(
  Effect.gen(function* () {
    const worktrees = yield* Worktrees
    const base = yield* TaskBase
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
    })
  }),
)
