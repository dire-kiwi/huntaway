import { Context, Effect } from "effect"
import { Atom, type AtomRegistry, Reactivity } from "effect/reactivity"
import { TaskId } from "@huntaway/contracts"
import type { HostBoard } from "./board/hostBoard.ts"
import { isAssistant } from "./logic/assistant.ts"
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
}

/** What a query reads again on, as picked from its host's board: it is read again whenever the value changes. */
export type BoardTrigger<M extends keyof Methods> = (board: HostBoard, payload: Methods[M]["payload"]) => string | number

/** A task's run and worktree, which its git state changes with. */
const taskState = (board: HostBoard, id: string): string => {
  const t = board.tasks.get(TaskId.make(id))
  return t ? `${t.running}:${t.worktree_state}` : ""
}

/** Whether a profile's assistant is running a turn (its memory changes with its turns). */
const assistantRunning = (board: HostBoard, profile: string): string => {
  for (const t of board.tasks.values()) if (t.profile_id === profile && isAssistant(t)) return String(t.running)
  return ""
}

/** Per method, what of the board a query of it is read again on (none: only mutations and its own refresh). */
export const triggers: { readonly [M in keyof Methods]?: BoardTrigger<M> } = {
  // A task's git state changes as its agent starts and stops, and with its worktree (the old useGitStatus).
  "git.status": (board, p) => taskState(board, p.id),
  "git.taskDiff": (board, p) => taskState(board, p.id),
  // 6.7: a profile's approval rules and action log, on its `approval_rules` and `approval_log` events.
  "approvalRules.get": (board, p) => board.approvalRules.get(`rules ${p.profile_id}`) ?? 0,
  "approvalRules.log": (board, p) => board.approvalRules.get(`log ${p.profile_id}`) ?? 0,
  // A task's documents (the assistant's brief), as one of them changes (its `document_at`).
  "tasks.document": (board, p) => board.tasks.get(p.id)?.document_at ?? "",
  // The assistant's memory, as a turn of its starts and ends (it may have changed its files).
  "assistant.memory": (board, p) => assistantRunning(board, p.profile_id),
  "assistant.memoryFile": (board, p) => assistantRunning(board, p.profile_id),
  "assistant.memoryHistory": (board, p) => assistantRunning(board, p.profile_id),
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
