import type { Task } from "@huntaway/contracts"
import { isMerged } from "../tasks/checks.ts"
import { activeMerge, mergeLanes, queuedMerges, stackedBelow, stackRunLanes, stackRuns, stackRunTasks, stackWaits } from "../tasks/lanes.ts"
import type { Rows } from "../tasks/lanes.ts"

// What the merge queue does next (docs/plan/06-server.md, Merge; inventory 04, sections 2.14–2.16; huntaway's
// agent/runner/merge.ts `start_next_merge`, `settle_stack_runs`, `awaits_approvals` and review/merge_gate.ts
// `needs_summary`): a plain function of a project's task rows. `Merges.reconcileLane` gathers the rows, calls
// `decideLanes` under the project's merges lock, and carries the plan out.

/** A task whose merge needs the user's approval and hasn't been summarised for it yet. */
export const needsSummary = (t: Task, approvalRequired: boolean): boolean => t.merge_approval === null && approvalRequired

/**
 * Whether `t` is a level of a stack's run with levels whose merges still wait for the user's approval: the run starts once
 * each is approved, so that it doesn't hold its lane while it waits for the user.
 */
export const awaitsApprovals = (rows: Rows, t: Task, approvalRequired: boolean): boolean =>
  t.stack_run !== null &&
  stackRunTasks(rows, t.stack_run).some((x) => x.status !== "done" && (x.merge_approval === "pending" || needsSummary(x, approvalRequired)))

/**
 * The levels that leave their stack's run: a level that left the merge (stepped out, denied, moved, closed: the task's
 * own rules take it out of the run) takes those above it out too, and a run with no level left to merge is over (all its
 * levels leave, quietly). `said`: the level is told it no longer merges with its stack.
 */
export const settleStackRuns = (rows: Rows): ReadonlyArray<{ readonly id: Task["id"]; readonly said: boolean }> => {
  const out: Array<{ readonly id: Task["id"]; readonly said: boolean }> = []
  for (const run of stackRuns(rows)) {
    const levels = stackRunTasks(rows, run)
    const byId = new Map<string, Task>(levels.map((t) => [t.id, t]))
    const open = levels.filter((t) => t.status !== "done")
    const inRun = (t: Task, depth = 0): boolean => {
      const below = stackedBelow(rows, t)
      if (below === null) return true
      if (below.task === null || depth > 64) return false
      if (below.task.status === "done") return isMerged(below.task)
      const b = byId.get(below.id)
      return b !== undefined && inRun(b, depth + 1)
    }
    const leaving = open.filter((t) => !inRun(t))
    const over = leaving.length === open.length
    for (const t of over ? levels : leaving) out.push({ id: t.id, said: leaving.includes(t) })
  }
  return out
}

/** What `decideLanes` is given: a project's task rows and what its merges need. */
export interface LaneFacts {
  /** The project's tasks (`kind=task`), done ones too. */
  readonly tasks: Rows
  /** The tasks whose latest run said they're finished (`finish_work`): a merge handed to a workflow holds its lane. */
  readonly finished: ReadonlySet<string>
  /** The project is archived: its merges wait until it's unarchived. */
  readonly archived: boolean
  /** Its merges wait for the user's approval (its `merge_approval`, else its profile's). */
  readonly approvalRequired: boolean
}

/** What the merge queue does now. */
export interface LanePlan {
  /** Levels that leave their stack's run (`settleStackRuns`), written first. */
  readonly leaveRun: ReadonlyArray<{ readonly id: Task["id"]; readonly said: boolean }>
  /** Tasks whose agents summarise their merge for the user's approval (out of the queue meanwhile), whatever the slot. */
  readonly summarise: ReadonlyArray<Task>
  /** Tasks whose agents are asked to merge now: the first eligible of each lane whose slot is free. */
  readonly start: ReadonlyArray<Task>
}

/**
 * The old `start_next_merge`: each lane with tasks queued whose slot is free gives its first queued task in column order
 * the merge, unless a stack's run under way holds the lane for its own levels, or the task's run still waits for
 * approvals; tasks needing approval are summarised regardless of the slot, and so are a run's levels waiting for the one
 * below (which aren't queued yet).
 */
export const decideLanes = (f: LaneFacts): LanePlan => {
  const leaveRun = settleStackRuns(f.tasks)
  const leaving = new Set(leaveRun.map((l) => l.id))
  const rows: Rows = leaving.size === 0 ? f.tasks : f.tasks.map((t) => (leaving.has(t.id) ? Object.assign({}, t, { stack_run: null }) : t))
  const held = stackRunLanes(rows)
  const summarise: Array<Task> = []
  const start: Array<Task> = []
  // A run's levels are all summarised for approval before the first merges, those waiting for the one below too.
  for (const run of stackRuns(rows)) {
    for (const t of stackRunTasks(rows, run)) {
      if (t.status === "ready_for_merge" && t.merging && !t.running && stackWaits(rows, t) && needsSummary(t, f.approvalRequired)) summarise.push(t)
    }
  }
  for (const lane of mergeLanes(rows, f.archived)) {
    const free = activeMerge(rows, lane, f.finished) === null
    // A stack's run under way in the lane has it to itself until its last level is merged.
    const run = held.get(lane ?? "")
    let next: Task | null = null
    for (const t of queuedMerges(rows, lane, f.archived)) {
      if (needsSummary(t, f.approvalRequired)) summarise.push(t)
      else if (free && next === null && (run === undefined || t.stack_run === run) && !awaitsApprovals(rows, t, f.approvalRequired)) next = t
    }
    if (next !== null) start.push(next)
  }
  return { leaveRun, summarise, start }
}
