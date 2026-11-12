import { Context, Effect, Hash } from "effect"
import { Atom, type AtomRegistry, Reactivity } from "effect/reactivity"
import { TaskId } from "@huntaway/contracts"
import { docsKey, type HostBoard } from "./board/hostBoard.ts"
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
  // Removing worktrees frees disk space: the host's disk usage is measured again (the old Disk tab's Reclaim space).
  "projects.removeMergedWorktrees": ["analytics"],
  // Picking one of a prompt's tasks completes the others and removes their worktrees: the compare view's diffs change.
  "tasks.pickFanout": ["git"],
  // A host's settings are part of what its status (`release_prereleases`: the release checks run again) and its
  // settings sync (`settings_sync`) say.
  "host.updateSettings": ["admin", "settingsSync"],
}

/** What a query reads again on, as picked from its host's board: it is read again whenever the value changes. */
export type BoardTrigger<M extends keyof Methods> = (board: HostBoard, payload: Methods[M]["payload"]) => string | number

/** A task's run and worktree, which its git state changes with. */
const taskState = (board: HostBoard, id: string): string => {
  const t = board.tasks.get(TaskId.make(id))
  return t ? `${t.running}:${t.worktree_state}` : ""
}

/** The number of the host's latest `docs` / `doc_comments` / `docs_site` event about a profile (and document). */
const docsSeq = (board: HostBoard, kind: "docs" | "comments" | "site", profile: string, slug = ""): number => board.docs.get(docsKey(kind, profile, slug)) ?? 0

/** A task's branch and column as well: what its diff against its base is taken from (the compare view's diffs). */
const taskBranch = (board: HostBoard, id: string): string => {
  const t = board.tasks.get(TaskId.make(id))
  return t ? `${t.running}:${t.worktree_state}:${t.status}:${t.branch ?? ""}` : ""
}

/** The tasks made from the same prompt as `id` (it among them): each one's column, run and worktree. */
const fanoutState = (board: HostBoard, id: string): string => {
  const fanout = board.tasks.get(TaskId.make(id))?.fanout_id
  if (!fanout) return ""
  return [...board.tasks.values()]
    .filter((t) => t.fanout_id === fanout)
    .map((t) => `${t.id}:${t.status}:${t.running}:${t.worktree_state}`)
    .join(",")
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
  // 6.3: the Docs page reads a profile's documents again on its `docs` events, and on `docs_site` (their published
  // state is the site's); a document's comments on its `doc_comments`; the latest version (not a numbered one) on `docs`.
  "docs.list": (board, p) => `${docsSeq(board, "docs", p.profile_id)}:${docsSeq(board, "site", p.profile_id)}`,
  "docs.get": (board, p) => `${docsSeq(board, "docs", p.profile_id)}:${docsSeq(board, "site", p.profile_id)}`,
  "docs.labels": (board, p) => docsSeq(board, "docs", p.profile_id),
  "docs.version": (board, p) => (p.version === null ? docsSeq(board, "docs", p.profile_id) : 0),
  "docs.comments": (board, p) => docsSeq(board, "comments", p.profile_id, p.slug),
  "docs.hostedStatus": (board, p) => docsSeq(board, "site", p.profile_id),
  // A task's skills are its config's (the old SkillMenu's cache was per config).
  "tasks.skills": (board, p) => board.tasks.get(p.id)?.claude_config_id ?? "",
  // A project's system prompt is made from its settings and the host's default mode (anyone's change to either).
  "projects.systemPrompt": (board, p) => {
    const project = board.projects.find((x) => x.id === p.id)
    return `${project ? Hash.hash(project) : ""}:${board.settings.default_permission_mode ?? ""}`
  },
  // A task's diff against its base: also its column and branch (the old compare view read it again on them).
  "git.taskDiff": (board, p) => taskBranch(board, p.id),
  // A file's diffs too: its content can change while its state in the status doesn't (the old tab read them with it).
  "git.diff": (board, p) => taskState(board, p.id),
  // The compare view's facts, as one of the prompt's tasks moves, starts or stops, or its worktree changes.
  "tasks.fanout": (board, p) => fanoutState(board, p.id),
  // A host's status is another once it has booted again (a restart, an update): its new boot id, commit and version.
  "admin.status": (board) => board.boot,
  // What a host's settings sync lists changes with its settings (the old SettingsSyncRow read it again on them).
  "settingsSync.get": (board) => Hash.hash(board.settings),
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
