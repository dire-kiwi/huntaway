import { Result } from "effect"
import { canMoveTo, Conflict, takesStatus, threadKindOf } from "@huntaway/contracts"
import type { AgentConfigId, ConflictReason, Invalid, NewTask, ProfileId, ProjectId, StartFrom, Task, TaskId, TaskPatch, Timestamp } from "@huntaway/contracts"
import type { Actor } from "../platform/Changes.ts"
import {
  checkBaseBranch,
  checkDependencies,
  checkExternalLinks,
  checkFanout,
  checkMarks,
  checkMergesInto,
  checkStartFrom,
  checkUrl,
  holding,
  indexTasks,
  invalid,
  isMerged,
  isScratch,
  orderLabels,
  placeholderTitle,
  rfc3339Utc,
  todosRefusal,
} from "./checks.ts"
import type { ProjectFacts, TaskIndex } from "./checks.ts"

// The rules of a task's changes (docs/plan/06-server.md, Tasks), as plain functions of the rows they read: the old
// `api/tasks.ts` (`update_task_inner`), `api/new_task.ts` and `db/tasks/write.ts` (`update_task`'s side effects),
// without the orchestration that followed them, which the reactor has. Nothing here does I/O: what a rule needs from
// other tables or from git and GitHub comes in `facts`, which are false or empty until the milestone that fills them.

export type { ProjectFacts } from "./checks.ts"

/** What no change sets: the task's identity, its number, what is worked out from other rows, and the times the store keeps. */
type FixedField = "id" | "profile_id" | "project_id" | "kind" | "number" | "key" | "queued_message" | "steering" | "created_at" | "updated_at"
export type TaskField = Exclude<keyof Task, FixedField>
/** The columns a change writes, as the task's fields. */
export type TaskColumns = { -readonly [K in TaskField]?: Task[K] }

const conflict = (reason: ConflictReason, detail: string) => Result.fail(new Conflict({ reason, detail }))
const changes = (columns: TaskColumns, ...fields: ReadonlyArray<TaskField>) => fields.some((f) => Object.hasOwn(columns, f))

const sameStart = (a: StartFrom | null, b: StartFrom | null): boolean => {
  if (a === null || b === null) return a === b
  if (a.type === "branch") return b.type === "branch" && a.branch === b.branch
  if (a.type === "task") return b.type === "task" && a.task_id === b.task_id
  if (a.type === "commit") return b.type === "commit" && a.commit === b.commit
  return b.type === "pull_request" && a.number === b.number && a.repo === b.repo
}

/** `before` with `columns` written over it. */
const withColumns = (before: Task, columns: TaskColumns): Task => Object.assign({}, before, columns)

/** The preview of pull request `prUrl` (`…/pull/<n>`) by the project's template, if both are there. */
export const previewFor = (template: string, prUrl: string | null): string | null => {
  const n = prUrl === null ? undefined : /^https?:\/\/[^/]+\/[^/]+\/[^/]+\/pull\/(\d+)/.exec(prUrl)?.[1]
  return n === undefined ? null : template.replaceAll("{pr}", n)
}

// ---- derived columns --------------------------------------------------------------------------------------------

/**
 * What follows from `columns` written over `before`, whoever writes them (huntaway's db/tasks/write.ts `update_task`):
 * a done task has a resolution (`done` unless told otherwise) and the time it was done, kept while it stays done, and any
 * other task has neither; a done task isn't restacked; out of its merge (anywhere but Ready for merge, Needs attention
 * while merging, or merged) it's out of its stack's run; moved anywhere but In progress or Needs attention, it loses its
 * place to rejoin the merge queue; and a merge's approval goes with the merge. Where its project gives each pull
 * request a preview (`previews`, with `{pr}` for its number), the preview follows the pull request unless it was set to
 * something else (huntaway's state.ts `preview_following_pr`). Returns `columns` with those added.
 */
export const deriveColumns = (before: Task, columns: TaskColumns, now: Timestamp, previews: string | null = null): TaskColumns => {
  const out: TaskColumns = { ...columns }
  // Its preview follows its pull request where the project has one per pull request, unless it was set otherwise.
  if (previews !== null && changes(columns, "pr_url") && !changes(columns, "preview_url")) {
    const own = before.preview_url !== null && before.preview_url !== previewFor(previews, before.pr_url)
    const preview = previewFor(previews, columns.pr_url ?? null)
    if (!own && preview !== before.preview_url) out.preview_url = preview
  }
  const after = (): Task => withColumns(before, out)
  if (changes(columns, "status", "resolution")) {
    const t = after()
    if (t.status === "done") {
      out.resolution = t.resolution ?? "done"
      out.done_at = t.done_at ?? now
    } else {
      out.resolution = null
      out.done_at = null
    }
  }
  if (changes(columns, "status") && after().status === "done" && after().restack !== null) out.restack = null
  if (changes(columns, "status", "merging", "resolution")) {
    const t = after()
    const merge = t.status === "ready_for_merge" || (t.status === "needs_attention" && t.merging) || isMerged(t)
    if (t.stack_run !== null && !merge) out.stack_run = null
  }
  if (changes(columns, "status") && !changes(columns, "remerge")) {
    const t = after()
    if (t.remerge && t.status !== "in_progress" && t.status !== "needs_attention") out.remerge = false
  }
  if (changes(columns, "status", "merging", "remerge")) {
    const t = after()
    if (t.merge_approval !== null && !t.merging && !t.remerge) out.merge_approval = null
  }
  return out
}

// ---- update -----------------------------------------------------------------------------------------------------

/**
 * Whether the task's pull request has the approving review its project or profile asks for before a merge (M5 reads it
 * from GitHub, before the task's lock is taken). `url` is the pull request it was read for.
 */
export type PrApproval =
  | { readonly _tag: "NotRequired" }
  | { readonly _tag: "Required"; readonly url: string | null; readonly approved: boolean; readonly error: string | null }

/** What `decideUpdate` needs from beyond the task's row. */
export interface UpdateFacts {
  /** Its project; null for a task in none. */
  readonly project: ProjectFacts | null
  /** A run of the task's is going (M2 on; always false before). */
  readonly running: boolean
  /** The configs it may run with: its project's, else its profile's. */
  readonly configs: ReadonlyArray<AgentConfigId>
  /** The tasks the change may name or link to: its project's, and any the patch names by id. */
  readonly tasks: ReadonlyArray<Task>
  /** Git finds changes of its own to merge (M4; false before, as for a task whose worktree isn't made). */
  readonly gitWork: boolean
  /** Its worktree's folder exists (M4). */
  readonly worktreeFolderExists: boolean
  /** The commit its branch started from (M4): kept as where it starts when it no longer follows its target's branch. */
  readonly startCommit: string | null
  readonly prApproval: PrApproval
  /** A position after every task in its project's Ready for merge column. */
  readonly endOfMergeQueue: number
}

export interface Decision {
  readonly columns: TaskColumns
  /** What the board tells the task's thread about the change (thread notes arrive with threads, M2). */
  readonly notes: ReadonlyArray<string>
}

/** Threads that work in a folder of their own, and so have nothing to merge. */
const ownFolderKinds: ReadonlySet<string> = new Set(["Scratch", "Assistant", "Routine", "PensRoot", "Pen", "Document"])

/**
 * The fields that make task `t` merge into `target` (null: the base branch) instead of what it merges into now
 * (huntaway's api/incoming.ts `retarget_fields`). Before its branch is made, it starts from the target's branch unless it
 * was given somewhere else to start from; with a branch made from the old target's, it keeps the commit it started from
 * and goes to the target's branch from there.
 */
export const retargetColumns = (t: Task, target: Task | null, tasks: TaskIndex, startCommit: string | null): TaskColumns => {
  const out: TaskColumns = { merges_into: target?.id ?? null }
  const sf = t.start_from
  const fromOld = sf?.type === "task" && sf.task_id === t.merges_into
  if (t.branch === null) {
    if (sf === null || fromOld) {
      out.start_from = target === null ? null : { type: "task", task_id: target.id }
      out.base_branch = null
    }
    return out
  }
  const old = t.merges_into === null ? undefined : tasks.get(t.merges_into)
  const following = fromOld || t.base_branch === null || old === undefined || t.base_branch === old.branch
  if (fromOld) out.start_from = startCommit === null ? null : { type: "commit", commit: startCommit }
  if (following) out.base_branch = target?.branch ?? null
  return out
}

/** `merges_into` in an update: the columns that change what `before` merges into, or null when it merges there already. */
const mergesIntoColumns = (
  before: Task,
  given: string | null,
  columns: TaskColumns,
  facts: UpdateFacts,
  tasks: TaskIndex,
): Result.Result<TaskColumns | null, Invalid | Conflict> =>
  Result.gen(function* () {
    const project = facts.project
    if (project === null || before.kind !== "task") return yield* invalid("merges_into", "merges_into is for a task in a project")
    const target = yield* checkMergesInto(tasks, project, before, given)
    if ((target?.id ?? null) === before.merges_into) return null
    if (target !== null) {
      const inWorktree = columns.use_worktree ?? (before.use_worktree || before.branch !== null)
      if (!inWorktree) return yield* invalid("merges_into", "merges_into is for a task with a worktree")
    }
    if (before.status === "done") return yield* invalid("merges_into", "the task is done, so what it merged into stays as it was")
    if (before.merging) return yield* conflict("merging", "the task is merging: move it out of Ready for merge to change what it merges into")
    const out = retargetColumns(before, target, tasks, facts.startCommit)
    // Where it starts, if the same change says, is what it says.
    return changes(columns, "start_from", "base_branch") ? { merges_into: out.merges_into ?? null } : out
  })

/**
 * The columns `patch` writes on `before`, with what follows from them, or why it's refused (huntaway's api/tasks.ts
 * `update_task_inner` and `check_todos`, and api/tasks.md 7.7): the field rules, what a move to each status sets, and the
 * refusals. `actor` decides whether the agent's todo list holds the task in In progress (a user's move unless it says
 * `todos_override`, an agent's always; the board's own moves never).
 */
export const decideUpdate = (before: Task, patch: TaskPatch, facts: UpdateFacts, actor: Actor, now: Timestamp): Result.Result<Decision, Invalid | Conflict> =>
  Result.gen(function* () {
    const kind = threadKindOf(before)
    const status = patch.status
    const tasks = indexTasks(facts.tasks)

    // The agent's unfinished todo list holds it in In progress (HA-330).
    if (status !== undefined) {
      const user = actor._tag === "User" || actor._tag === "Device"
      if (actor._tag === "Agent" || (user && patch.todos_override !== true)) {
        const items = holding(before, status)
        if (items.length > 0) return yield* conflict("todos_unfinished", todosRefusal(items, actor._tag === "Agent"))
      }
    }
    // Lasting threads (the assistant, the pens thread, a pen's thread) are never reviewed, merged, done or parked.
    if (status !== undefined && status !== before.status && takesStatus(kind) && !canMoveTo(kind, status)) {
      const who =
        kind._tag === "Assistant" ? "the assistant" : kind._tag === "Pen" ? "a pen's thread" : kind._tag === "PensRoot" ? "the pens thread" : "this thread"
      return yield* invalid("status", `${who} can't go to review, merge, Done or Backlog`)
    }

    // A task with no changes to merge (and so no pull request) skips the merge and is done.
    const toMerge = status === "ready_for_merge" && before.status !== "ready_for_merge" && before.kind === "task"
    const ownFolder = ownFolderKinds.has(kind._tag)
    const incomingWork = facts.tasks.some((t) => t.merges_into === before.id && t.kind === "task" && !isScratch(t))
    const workToMerge = facts.project !== null && facts.project.is_git && (incomingWork || facts.gitWork)
    const nothingToMerge = toMerge && (ownFolder || !workToMerge)

    const columns: TaskColumns = { ...(yield* checkMarks(before, patch)) }
    if (patch.title !== undefined) {
      const title = patch.title.trim()
      if (title === "") return yield* invalid("title", "title must be a non-empty string")
      columns.title = title
    }
    if (patch.title_pinned !== undefined) columns.title_pinned = patch.title_pinned
    if (patch.description !== undefined) columns.description = patch.description ?? ""
    if (patch.position !== undefined) columns.position = patch.position
    if (patch.use_worktree !== undefined) columns.use_worktree = patch.use_worktree
    if (patch.model !== undefined) columns.model = patch.model
    if (patch.base_branch !== undefined) columns.base_branch = yield* checkBaseBranch(patch.base_branch)

    if (patch.start_from !== undefined) {
      if (facts.project === null) return yield* invalid("start_from", "start_from is for a task in a project")
      const sf = yield* checkStartFrom(tasks, facts.project, before.id, patch.start_from)
      if (sf !== null) {
        if (!(columns.use_worktree ?? before.use_worktree)) return yield* invalid("start_from", "start_from is for a task with a worktree")
        if (columns.base_branch !== undefined && columns.base_branch !== null) return yield* invalid("start_from", "give start_from or base_branch, not both")
      }
      // Its branch started where it did, and is set up again from there.
      if (before.branch !== null && !sameStart(sf, before.start_from)) {
        return yield* conflict("worktree_made", `the task's branch ${before.branch} exists already, so it starts from where it did`)
      }
      // What it starts from decides its base branch, as the worktree is made.
      if (sf !== null && !changes(columns, "base_branch")) columns.base_branch = null
      columns.start_from = sf
    } else if (columns.base_branch !== undefined && columns.base_branch !== null && before.start_from !== null) {
      columns.start_from = null
    }
    // Changing what it merges into moves where it starts with it, which isn't a change to its worktree's settings.
    const worktreeSettings = changes(columns, "use_worktree", "base_branch", "start_from")
    const retarget = patch.merges_into === undefined ? null : yield* mergesIntoColumns(before, patch.merges_into, columns, facts, tasks)

    if (patch.labels !== undefined) {
      if (before.kind !== "task") return yield* invalid("labels", "only a task can have labels")
      columns.labels = orderLabels(patch.labels)
    }
    // A title renamed by hand stays as it is rather than following the user's prompts, unless the same change says otherwise.
    if (columns.title !== undefined && columns.title !== before.title && patch.title_pinned === undefined) columns.title_pinned = true
    if (before.project_id === null && columns.use_worktree === true) {
      return yield* invalid("use_worktree", "a task without a project can't have a worktree")
    }
    if (ownFolder && columns.use_worktree === true) {
      return yield* invalid("use_worktree", "a scratch task, or one that makes only documents, can't have a worktree")
    }
    if (patch.preview_url !== undefined) columns.preview_url = yield* checkUrl("preview_url", patch.preview_url)
    if (patch.pr_url !== undefined) columns.pr_url = yield* checkUrl("pr_url", patch.pr_url)
    if (patch.external_links !== undefined) columns.external_links = yield* checkExternalLinks(patch.external_links)
    if (patch.effort !== undefined) columns.effort = patch.effort
    if (patch.permission_mode !== undefined) columns.permission_mode = patch.permission_mode
    if (patch.claude_config_id !== undefined) {
      // Its conversation is kept in the config it started in, so it can only move before then.
      if (before.session_id !== null || before.running || facts.running) {
        return yield* conflict("has_session", "the agent has already started with its Claude config")
      }
      if (!facts.configs.includes(patch.claude_config_id)) {
        return yield* invalid("claude_config_id", "claude_config_id must be one of the project's (or profile's) Claude configs")
      }
      columns.claude_config_id = patch.claude_config_id
    }
    if (patch.depends_on !== undefined) {
      if (before.kind !== "task") return yield* invalid("depends_on", "only tasks can have dependencies")
      columns.depends_on = yield* checkDependencies(tasks, before.id, before.project_id, patch.depends_on)
    }
    if (patch.resolution !== undefined) {
      // Checked against where the task ends up; moving it in or out of Done sets or clears it (`deriveColumns`).
      if (patch.resolution !== null && (status ?? before.status) !== "done") return yield* invalid("resolution", "resolution can only be set on a done task")
      columns.resolution = patch.resolution
    }
    if (patch.done_at !== undefined) {
      if ((status ?? before.status) !== "done") return yield* invalid("done_at", "done_at can only be set on a done task")
      const at = rfc3339Utc(patch.done_at)
      if (at === null) return yield* invalid("done_at", "done_at must be an RFC 3339 time")
      columns.done_at = at
    }

    // A merging task's agent can step out of the merge queue to fix what the merge turned up, and rejoin it when its run ends.
    const remerge = patch.remerge === true
    if (remerge && !(before.merging && facts.running && status === "in_progress")) {
      return yield* invalid("remerge", "remerge only takes a task out of the merge queue while its agent is merging it, with status in_progress")
    }
    if (remerge && before.merge_approval === "pending") {
      return yield* invalid(
        "remerge",
        "the merge hasn't been approved yet, so it isn't in the merge queue to step out of: summarize what will be merged and end your turn",
      )
    }

    let merge = false
    if (status !== undefined) {
      columns.status = status
      merge = toMerge
      if (status !== "needs_attention") columns.attention_reason = null
      // Only In progress holds a task queued for its dependencies.
      if (status !== "in_progress" && before.waiting) columns.waiting = false
      // Anywhere but Ready for merge (or waiting on the user while merging) ends a merge.
      if (merge || (status !== "ready_for_merge" && status !== "needs_attention")) columns.merging = merge
      // Moved there again, a merge that needs approval is summarised again, unless it's approved already.
      if (merge && before.merge_approval !== "approved") columns.merge_approval = null
      // Moved there on its own, it's in no stack's run.
      if (merge) columns.stack_run = null
      if (remerge) columns.remerge = true
      // Moving it ends its agent's wait, told so in the same write.
      if (before.agent_wait !== null && status !== before.status) columns.agent_wait = { ...before.agent_wait, moved_to: status }
    }

    // A setup that failed before making the branch left nothing to tear down, so it can be put right and set up again.
    const unmade =
      before.worktree_state === "none" ||
      (before.worktree_state === "error" && before.branch === null && (before.worktree_path === null || !facts.worktreeFolderExists))
    if (worktreeSettings && before.worktree_state === "error" && unmade) {
      columns.worktree_state = "none"
      columns.worktree_error = null
    }
    if (worktreeSettings && !unmade) return yield* conflict("worktree_made", "tear down the worktree before changing worktree settings")
    if (retarget !== null) Object.assign(columns, retarget)
    if (merge && (before.running || facts.running)) {
      return yield* conflict("agent_running", "the agent is still running; wait for it to finish before moving the task to Ready for merge")
    }

    const notes: Array<string> = []
    if (merge && nothingToMerge) {
      merge = false
      delete columns.position
      columns.status = "done"
      columns.merging = false
      notes.push(
        kind._tag === "Scratch"
          ? "Nothing to merge (a scratch task has no repository), so it's done"
          : ownFolder
            ? "Nothing to merge (the board keeps the task's documents), so it's done"
            : "Nothing to merge (the task has no changes), so it's done",
      )
    }
    // Where the project or profile asks for it, the pull request needs an approving review on GitHub first. The pull
    // request it will have is the one checked, if the same change sets it.
    if (merge && !remerge && facts.prApproval._tag === "Required") {
      const approval = facts.prApproval
      if (patch.pr_url === undefined && approval.url !== before.pr_url) {
        return yield* conflict("changed_meanwhile", "the task's pull request changed meanwhile; try again")
      }
      if (approval.error !== null) {
        return yield* conflict("pr_not_approved", `can't move the task to Ready for merge until its pull request is approved on GitHub: ${approval.error}`)
      }
      if (!approval.approved) {
        return yield* conflict("pr_not_approved", "the task's pull request has no approving review on GitHub yet, so it can't go to Ready for merge")
      }
    }
    // Moved without a position (by an agent, say), it joins the back of the merge queue.
    if (merge && columns.position === undefined) columns.position = facts.endOfMergeQueue
    return { columns: deriveColumns(before, columns, now, facts.project?.pr_preview_url ?? null), notes }
  })

// ---- create -----------------------------------------------------------------------------------------------------

/** Which numbers a new task's comes from: its project's counter, or the next of its family in its profile (`G-`, `S-`, `A-`). */
export type NumberFamily = "project" | "group" | "scratch" | "assistant"

/** Where a new task goes, as the request and the rows found for it say. */
export type Place =
  | { readonly _tag: "Project"; readonly project: ProjectFacts }
  | { readonly _tag: "Scratch"; readonly profile_id: ProfileId }
  /** `projects`: how many of the profile's projects that aren't archived are in the group. */
  | { readonly _tag: "Group"; readonly profile_id: ProfileId; readonly group: string; readonly projects: number }

export interface CreateFacts {
  readonly place: Place
  /** The configs it may run with: its project's, else its profile's. */
  readonly configs: ReadonlyArray<AgentConfigId>
  /** Its project's tasks, for dependencies and what it merges into or starts from. */
  readonly tasks: ReadonlyArray<Task>
}

/** A task to insert: its number and position are the store's to give. */
export interface NewRow {
  readonly family: NumberFamily
  readonly profile_id: ProfileId
  readonly project_id: ProjectId | null
  readonly columns: TaskColumns & { readonly title: string }
  /** Described but not titled: it has a placeholder title, and a generated one is due (with titles, M2). */
  readonly generateTitle: boolean
}

/** The config a new thread asks for, against those it may use; unset is the first of them (kept with the thread). */
const pickConfig = (configs: ReadonlyArray<AgentConfigId>, given: AgentConfigId | null | undefined): Result.Result<AgentConfigId | null, Invalid> => {
  if (given === null || given === undefined || given === "") return Result.succeed(configs[0] ?? null)
  if (!configs.includes(given)) return invalid("claude_config_id", "claude_config_id must be one of the project's (or profile's) Claude configs")
  return Result.succeed(given)
}

/**
 * The row a new task is (huntaway's api/new_task.ts): a task in a project, a scratch task in none, or a group task.
 * `start` is accepted and not acted on: starting the agent comes with runs (M2).
 */
export const decideCreate = (input: NewTask, facts: CreateFacts, now: Timestamp): Result.Result<NewRow, Invalid | Conflict> =>
  Result.gen(function* () {
    const place = facts.place
    const description = input.description ?? ""
    const given = (input.title ?? "").trim()
    const generateTitle = given === "" && description.trim() !== ""
    let title = given
    if (title === "") {
      if (generateTitle) title = placeholderTitle(description)
      else if (place._tag === "Scratch") title = "New scratch task"
      else return yield* invalid("title", "title or description is required")
    }
    if (place._tag === "Project" && place.project.archived) {
      return yield* conflict("archived", `the project "${place.project.name}" is archived; unarchive it in the board's settings first`)
    }
    const status = input.status ?? "todo"
    // A group task takes no resolution (as before): done, it's done.
    const resolution = place._tag === "Group" ? null : (input.resolution ?? null)
    if (resolution !== null && status !== "done") return yield* invalid("resolution", "resolution can only be set on a done task")
    const dependsOn = input.depends_on ?? []
    const columns: TaskColumns & { title: string } = {
      title,
      description,
      status,
      resolution: status === "done" ? (resolution ?? "done") : null,
      done_at: status === "done" ? now : null,
      model: input.model ?? null,
      effort: input.effort ?? null,
      claude_config_id: yield* pickConfig(facts.configs, input.claude_config_id),
      labels: orderLabels(input.labels ?? []),
      external_links: yield* checkExternalLinks(input.external_links ?? null),
      fanout_id: yield* checkFanout(input.fanout_id),
      use_worktree: false,
    }
    const row = (family: NumberFamily, profile_id: ProfileId, project_id: ProjectId | null): NewRow => ({
      family,
      profile_id,
      project_id,
      columns,
      generateTitle,
    })

    if (place._tag === "Scratch") {
      if (input.use_worktree === true || dependsOn.length > 0) {
        return yield* invalid("use_worktree", "a scratch task can't have a worktree or dependencies")
      }
      columns.task_type = "scratch"
      return row("scratch", place.profile_id, null)
    }
    if (place._tag === "Group") {
      const group = place.group.trim()
      if (group === "" || place.projects === 0) return yield* invalid("group", "group must name a group of the profile's projects")
      if (dependsOn.length > 0) return yield* invalid("depends_on", "a group task can't have dependencies")
      if (input.task_type === "scratch") return yield* invalid("task_type", "a group task can't be a scratch task")
      columns.group_name = group
      return row("group", place.profile_id, null)
    }
    const project = place.project
    const tasks = indexTasks(facts.tasks)
    const taskType = input.task_type ?? null
    // A scratch task works in its own folder instead of a worktree.
    const useWorktree = taskType === null && (input.use_worktree ?? (project.use_worktrees && project.is_git))
    const startFrom = yield* checkStartFrom(tasks, project, null, input.start_from)
    if (startFrom !== null && !useWorktree) return yield* invalid("start_from", "start_from is for a task with a worktree")
    const target = yield* checkMergesInto(tasks, project, null, input.merges_into)
    if (target !== null && !useWorktree) return yield* invalid("merges_into", "merges_into is for a task with a worktree")
    columns.use_worktree = useWorktree
    columns.task_type = taskType
    columns.depends_on = dependsOn.length > 0 ? yield* checkDependencies(tasks, null, project.id, dependsOn) : []
    // It builds on the target's work, unless it was given somewhere else to start from.
    columns.start_from = startFrom ?? (target === null ? null : { type: "task", task_id: target.id })
    columns.merges_into = target?.id ?? null
    return row("project", project.profile_id, project.id)
  })

// ---- delete -----------------------------------------------------------------------------------------------------

/** Why a task whose target or the level it lands after was closed or deleted waits in Needs attention. */
export const heldReason = (targetKey: string, deleted: boolean, stacked: boolean): string =>
  `${targetKey}, which this task ${stacked ? "lands after" : "merges into"}, was ${deleted ? "deleted" : "closed without being merged"}: choose where it merges now`

/** The open tasks whose work goes to task `id`: merging into it, or into its merged ones in turn (huntaway's `db.reaching`). */
export const reaching = (tasks: ReadonlyArray<Task>, id: TaskId): Array<Task> => {
  const out: Array<Task> = []
  const seen = new Set<string>([id])
  const walk = (to: string, depth: number) => {
    if (depth > 16) return
    for (const x of tasks) {
      if (x.merges_into !== to || x.kind !== "task" || seen.has(x.id)) continue
      seen.add(x.id)
      if (x.status !== "done") out.push(x)
      else if (isMerged(x)) walk(x.id, depth + 1)
    }
  }
  walk(id, 0)
  return out
}

/** The open stack levels on task `id`: tasks that start from it and merge into no task, in board order. */
export const stackedLevels = (tasks: ReadonlyArray<Task>, id: TaskId): Array<Task> =>
  tasks
    .filter((t) => t.kind === "task" && t.merges_into === null && t.status !== "done" && t.start_from?.type === "task" && t.start_from.task_id === id)
    .toSorted((a, b) => a.position - b.position || a.created_at.localeCompare(b.created_at))

/**
 * What changes on the other tasks of `gone`'s project as it is deleted (huntaway's api/tasks.ts `delete_one`, with
 * api/incoming.ts `follow_deleted` and `flag_incoming`): its dependants no longer wait for it; merged, the tasks merging
 * into it go where it went; not merged, those whose work went to it and the stack levels on it are flagged in Needs
 * attention for the user to say where they go (their link stays), unless their agent is running (flagged when its run
 * ends, M2).
 */
export const decideDeleted = (gone: Task, tasks: ReadonlyArray<Task>): ReadonlyArray<{ readonly id: TaskId; readonly columns: TaskColumns }> => {
  const others = tasks.filter((t) => t.id !== gone.id)
  const out = new Map<TaskId, TaskColumns>()
  const add = (id: TaskId, columns: TaskColumns) => out.set(id, { ...out.get(id), ...columns })
  for (const t of others) if (t.depends_on.includes(gone.id)) add(t.id, { depends_on: t.depends_on.filter((d) => d !== gone.id) })
  if (isMerged(gone)) {
    const index = indexTasks(others)
    // Where it went: what it merges into, past those merged since.
    let onward = gone.merges_into === null ? undefined : index.get(gone.merges_into)
    for (let i = 0; i < 16 && onward !== undefined && isMerged(onward); i++) onward = onward.merges_into === null ? undefined : index.get(onward.merges_into)
    const next = onward !== undefined && onward.status !== "done" ? onward : null
    for (const x of others) {
      if (x.merges_into !== gone.id || x.kind !== "task" || (x.status === "done" && !isMerged(x))) continue
      const columns: TaskColumns = { merges_into: next?.id ?? null }
      if (x.status !== "done" && x.branch !== null && (x.base_branch === null || x.base_branch === gone.branch)) {
        columns.base_branch = next?.branch ?? gone.base_branch
      }
      add(x.id, columns)
    }
  } else {
    const flag = (x: Task, stacked: boolean) => {
      if (x.status === "done" || x.kind !== "task" || x.running) return
      add(x.id, { status: "needs_attention", attention_reason: heldReason(gone.key, true, stacked), merging: false, remerge: false, merge_approval: null })
    }
    for (const x of reaching(others, gone.id)) flag(x, false)
    for (const x of stackedLevels(others, gone.id)) flag(x, true)
  }
  return [...out].map(([id, columns]) => ({ id, columns }))
}
