import { Context, Effect } from "effect"
import { Atom, type AtomRegistry, Reactivity } from "effect/reactivity"
import { TaskId } from "@huntaway/contracts"
import type { HostBoard } from "./board/hostBoard.ts"
import type { Methods } from "./rpc.ts"

// What reads a query again (docs/plan/09-frontend.md, Queries, mutations, invalidation). A component never refetches
// because it thinks something changed: a query is read again when
//
// - a mutation on its host has run that `invalidates` names (by default its own group: `git.stage` reads `git.*`
//   again, `agentTools.update` reads `agentTools.*`), which is what the old components did by hand after a change;
// - what `triggers` picks from its host's board changes (a task's run starting or stopping, its worktree, an event's count),
//   which replaces the old listener sets and dependency arrays.

/** The method's group: `git` for `git.status`, `hub` for `hub.hosts.list`. */
export type GroupOf<M extends string> = M extends `${infer G}.${string}` ? G : never

/** The groups a mutation reads again on its host besides its own (a rewind changes a task's git state). */
export const invalidates: { readonly [M in keyof Methods]?: ReadonlyArray<GroupOf<keyof Methods>> } = {
  "checkpoints.rewind": ["git"],
  "checkpoints.cancelRewind": ["git"],
  // Removing worktrees frees disk space: the host's disk usage is measured again (the old Disk tab's Reclaim space).
  "projects.removeMergedWorktrees": ["analytics"],
}

/** What a query reads again on, as picked from its host's board: it is read again whenever the value changes. */
export type BoardTrigger<M extends keyof Methods> = (board: HostBoard, payload: Methods[M]["payload"]) => string | number

/** A task's run and worktree, which its git state changes with. */
const taskState = (board: HostBoard, id: string): string => {
  const t = board.tasks.get(TaskId.make(id))
  return t ? `${t.running}:${t.worktree_state}` : ""
}

/** Per method, what of the board a query of it is read again on (none: only mutations and its own refresh). */
export const triggers: { readonly [M in keyof Methods]?: BoardTrigger<M> } = {
  // A task's git state changes as its agent starts and stops, and with its worktree (the old useGitStatus).
  "git.status": (board, p) => taskState(board, p.id),
  "git.taskDiff": (board, p) => taskState(board, p.id),
}

/** The key a host's group is invalidated by. */
export const groupKey = (host: string, group: string): string => `${host}\u0000${group}`

/** The runtime whose `Reactivity` the queries register with (the registry's one, shared by every runtime it makes). */
const reactivityRuntime = Atom.runtime(Reactivity.layer)

/** Reads again the queries of `groups` on `host`. */
export const invalidateGroups = (host: string, groups: ReadonlyArray<string>): Effect.Effect<void, never, AtomRegistry.AtomRegistry> =>
  Effect.flatMap(Atom.getResult(reactivityRuntime), (context) =>
    Effect.sync(() => Context.get(context, Reactivity.Reactivity).invalidateUnsafe(groups.map((g) => groupKey(host, g)))),
  ).pipe(Effect.ignore)

/** The groups a mutation of `method` reads again: its own, and what `invalidates` adds. */
export const groupsInvalidatedBy = (method: keyof Methods): ReadonlyArray<string> => [method.slice(0, method.indexOf(".")), ...(invalidates[method] ?? [])]
