import type { Task } from "@huntaway/contracts"
import { isMerged } from "./checks.ts"

// What a task's work goes to and how it merges, as plain functions of its project's task rows (docs/plan/06-server.md,
// Merge; inventory 04, sections 2.14 and 2.16; huntaway's db/tasks/stacks.ts and db/tasks/merges.ts): the task it merges
// into, the stack level it lands after, stacks and their main line, the merge lane a task merges in, the task holding a
// lane's slot, those queued for it, and the lanes a stack's run holds. The merge queue is derived from these rows each
// time and never kept in memory. `merge/decide.ts` decides what to start from them; `runs/` reads the active merge of a
// lane and whether a merge is held; `git/` and `github/` read the stacks.

/** A project's tasks (`kind=task`, done ones too), as the rules read them. */
export type Rows = ReadonlyArray<Task>

/** How deep a walk through targets and levels goes: each step is to a task it merges into or starts from. */
const DEPTH = 16

const find = (rows: Rows, id: string): Task | null => rows.find((t) => t.id === id) ?? null

/** Board order: position, then when it was made. */
const byBoard = (a: Task, b: Task) => a.position - b.position || a.created_at.localeCompare(b.created_at)

/** The tasks that start from task `id` (`start_from` that task), oldest first. */
export const stackedOn = (rows: Rows, id: string): Array<Task> =>
  rows.filter((t) => t.start_from?.type === "task" && t.start_from.task_id === id).toSorted((a, b) => a.created_at.localeCompare(b.created_at))

/** The tasks that merge into task `id`, in board order, done ones too. */
export const mergingInto = (rows: Rows, id: string): Array<Task> => rows.filter((t) => t.merges_into === id && t.kind === "task").toSorted(byBoard)

/**
 * The first task `t`'s work goes to that isn't merged yet: what it merges into, or past that once it's merged, what that
 * merges into, and so on. `task` is null once that one's deleted. Null when it merges into none, or they're all merged.
 */
export const firstTarget = (rows: Rows, t: Task): { readonly id: string; readonly task: Task | null } | null => {
  let at = t
  for (let i = 0; i < DEPTH && at.merges_into !== null; i++) {
    const target = find(rows, at.merges_into)
    if (target === null) return { id: at.merges_into, task: null }
    if (!isMerged(target)) return { id: target.id, task: target }
    at = target
  }
  return null
}

/**
 * Where what `t` merges into stands, past its targets merged since: `none` without one, `open` while the first not merged
 * is still to be, `merged` once they all are, `closed` when that one's done without being merged, `deleted` once it's
 * gone. The last two hold `t`'s merge until the user says where it goes.
 */
export const targetState = (rows: Rows, t: Task): "none" | "open" | "merged" | "closed" | "deleted" => {
  if (t.merges_into === null) return "none"
  const f = firstTarget(rows, t)
  if (f === null) return "merged"
  if (f.task === null) return "deleted"
  return f.task.status === "done" ? "closed" : "open"
}

/** The open tasks whose work goes to task `id`: merging into it, or into its merged ones in turn (huntaway's `db.reaching`). */
export const reaching = (rows: Rows, id: string): Array<Task> => {
  const out: Array<Task> = []
  const seen = new Set<string>([id])
  const walk = (to: string, depth: number) => {
    if (depth > DEPTH) return
    for (const x of mergingInto(rows, to)) {
      if (seen.has(x.id)) continue
      seen.add(x.id)
      if (x.status !== "done") out.push(x)
      else if (isMerged(x)) walk(x.id, depth + 1)
    }
  }
  walk(id, 0)
  return out
}

/**
 * The task a stack level lands after: what `t` starts from (a task) when it merges into none. `task` is null once that
 * one's deleted. Null for any other task.
 */
export const stackedBelow = (rows: Rows, t: Task): { readonly id: string; readonly task: Task | null } | null => {
  if (t.kind !== "task" || t.merges_into !== null || t.start_from?.type !== "task") return null
  return { id: t.start_from.task_id, task: find(rows, t.start_from.task_id) }
}

/**
 * Where stack level `t` stands: `none` for a task that isn't one; `open` while the task below isn't merged (its merge
 * waits); `restack` once it is, until the board has restacked it; `conflict` when that needs its agent; `merged` once
 * done; `closed` when the one below was closed without being merged and `deleted` once it's gone, which hold its merge.
 */
export const stackState = (rows: Rows, t: Task): "none" | "open" | "restack" | "conflict" | "merged" | "closed" | "deleted" => {
  if (t.status !== "done" && t.restack === "due") return "restack"
  if (t.status !== "done" && t.restack === "conflict") return "conflict"
  const below = stackedBelow(rows, t)
  if (below === null) return "none"
  if (below.task === null) return "deleted"
  if (isMerged(below.task)) return "merged"
  return below.task.status === "done" ? "closed" : "open"
}

/** Whether stack level `t`'s merge waits for the level below it: merged, then restacked. */
export const stackWaits = (rows: Rows, t: Task): boolean => {
  const st = stackState(rows, t)
  return st === "open" || st === "restack" || st === "conflict"
}

/** The open stack levels on task `id`: tasks that start from it and merge into no task, in board order. */
export const stackedLevels = (rows: Rows, id: string): Array<Task> =>
  rows
    .filter((t) => t.kind === "task" && t.merges_into === null && t.status !== "done" && t.start_from?.type === "task" && t.start_from.task_id === id)
    .toSorted(byBoard)

/** Whether `t`'s merge is held until the user says where it goes: its target, or the level below, closed or deleted. */
export const mergeHeld = (rows: Rows, t: Task): boolean => {
  const st = targetState(rows, t)
  if (st === "closed" || st === "deleted") return true
  const stack = stackState(rows, t)
  return stack === "closed" || stack === "deleted"
}

const HELD = ": choose where it merges now"

/**
 * Why a task merging into a closed or deleted task needs attention: `key` is that task's key (null once deleted). With
 * `stacked`, a stack level whose level below it is.
 */
export const heldReason = (key: string | null, deleted: boolean, stacked: boolean): string => {
  const link = stacked ? "lands after" : "merges into"
  if (key === null) return `The task this one ${link} was deleted${HELD}`
  return `${key}, which this task ${link}, was ${deleted ? "deleted" : "closed without being merged"}${HELD}`
}

/** Whether `reason` is one `heldReason` gave. */
export const isHeldReason = (reason: string | null): boolean => reason !== null && reason.endsWith(HELD)

/** Why held task `t` needs attention (huntaway's runner/output.ts `held_reason_of`), or null when it isn't held. */
export const heldReasonOf = (rows: Rows, t: Task): string | null => {
  if (!mergeHeld(rows, t)) return null
  const st = targetState(rows, t)
  if (st !== "closed" && st !== "deleted") {
    const below = stackedBelow(rows, t)?.task ?? null
    return below === null ? heldReason(null, true, true) : heldReason(below.key, false, true)
  }
  const target = firstTarget(rows, t)?.task ?? null
  return target === null ? heldReason(null, true, false) : heldReason(target.key, false, false)
}

/**
 * The merge lane `t` merges in: tasks merge one at a time per branch they merge into. The first open task its work goes
 * to (past targets merged since; a stack level goes in the lane of the level below once that's merged), else null for
 * the project's own lane. (Subprojects' lanes went with subprojects.)
 */
export const mergeLane = (rows: Rows, t: Task): string | null => {
  let at = t
  for (let i = 0; i < DEPTH; i++) {
    const below = stackedBelow(rows, at)?.task ?? null
    if (below === null || !isMerged(below)) break
    at = below
  }
  const f = firstTarget(rows, at)
  return f !== null && f.task !== null && f.task.status !== "done" ? f.task.id : null
}

/**
 * A task its agent merged and said so (`finish_work`: `finished` is its latest run's), out of the merge queue but still
 * in Ready for merge until its project's workflow moves it to Done (HA-276).
 */
export const isHandoff = (t: Task, finished: ReadonlySet<string>): boolean => t.status === "ready_for_merge" && !t.merging && !t.running && finished.has(t.id)

/**
 * The task holding lane `lane`'s slot: merging, and running or waiting on the user, not waiting for its approval; or
 * handed from its merge to its workflow (`isHandoff`). `finished`: the tasks whose latest run said they're finished.
 */
export const activeMerge = (rows: Rows, lane: string | null, finished: ReadonlySet<string>): Task | null =>
  rows
    .filter(
      (t) => t.kind === "task" && ((t.merging && (t.running || t.status === "needs_attention")) || isHandoff(t, finished)) && t.merge_approval !== "pending",
    )
    .toSorted((a, b) => a.position - b.position)
    .find((t) => mergeLane(rows, t) === lane) ?? null

/** The tasks waiting in Ready for merge, in column order, held ones too; none in an archived project. */
const waitingMerges = (rows: Rows, archived: boolean): Array<Task> =>
  archived
    ? []
    : rows.filter((t) => t.kind === "task" && t.merging && !t.running && t.status === "ready_for_merge" && t.merge_approval !== "pending").toSorted(byBoard)

/** Tasks waiting in Ready for merge for lane `lane`'s slot, in column order, bar held ones and levels waiting for the one below. */
export const queuedMerges = (rows: Rows, lane: string | null, archived: boolean): Array<Task> =>
  waitingMerges(rows, archived).filter((t) => mergeLane(rows, t) === lane && !mergeHeld(rows, t) && !stackWaits(rows, t))

/** The lanes with tasks queued for them. */
export const mergeLanes = (rows: Rows, archived: boolean): Array<string | null> => [
  ...new Set(
    waitingMerges(rows, archived)
      .filter((t) => !mergeHeld(rows, t) && !stackWaits(rows, t))
      .map((t) => mergeLane(rows, t)),
  ),
]

/** The levels of stack run `run`, merged ones too. */
export const stackRunTasks = (rows: Rows, run: string): Array<Task> => rows.filter((t) => t.stack_run === run && t.kind === "task")

/** The stack runs with levels among `rows`. */
export const stackRuns = (rows: Rows): Array<string> => [...new Set(rows.flatMap((t) => (t.kind === "task" && t.stack_run !== null ? [t.stack_run] : [])))]

/**
 * The lanes held by a stack's run, by lane (`""` for the project's own): a run under way (a level merged, or one has its
 * turn) with levels still to merge holds the lane its lowest open level merges in, so nothing else merges there between
 * its levels, also while the next waits to be restacked.
 */
export const stackRunLanes = (rows: Rows): Map<string, string> => {
  const held = new Map<string, string>()
  for (const run of stackRuns(rows)) {
    const levels = stackRunTasks(rows, run)
    const open = levels.filter((t) => t.status !== "done")
    if (open.length === 0) continue
    // Not one summarising its merge for the user's approval, or waiting for it: that's before the run starts.
    const begun = levels.some((t) => t.status === "done" || (t.merge_approval !== "pending" && (t.running || t.status === "needs_attention")))
    if (!begun) continue
    const lowest = open.find((t) => !open.some((o) => o.id === stackedBelow(rows, t)?.id)) ?? open[0]
    if (lowest !== undefined) held.set(mergeLane(rows, lowest) ?? "", run)
  }
  return held
}

/** Whether `below` is the task `x` lands after, in the same project and profile (a stack doesn't cross them). */
const sameStack = (x: Task, below: Task | null): below is Task =>
  below !== null && below.kind === "task" && below.project_id === x.project_id && below.profile_id === x.profile_id

/**
 * The stack `t` is in (HA-387): its bottom (down the levels while the one below is there, in the same project) and its
 * levels, the bottom first and then everything landing after it, done ones too, each before those landing after it (a
 * fork's by when they were made). Null for a task in no stack.
 */
export const stackOf = (rows: Rows, t: Task): { readonly bottom: Task; readonly levels: ReadonlyArray<Task> } | null => {
  const belowOf = (x: Task): Task | null => {
    const b = stackedBelow(rows, x)?.task ?? null
    return sameStack(x, b) ? b : null
  }
  let bottom = t
  const down = new Set<string>([t.id])
  for (let b = belowOf(t); b !== null && !down.has(b.id); b = belowOf(b)) {
    down.add(b.id)
    bottom = b
  }
  if (bottom.kind !== "task") return null
  const levels: Array<Task> = []
  const seen = new Set<string>()
  const walk = (x: Task) => {
    if (seen.has(x.id) || levels.length >= 256) return
    seen.add(x.id)
    levels.push(x)
    for (const up of stackedOn(rows, x.id)) if (belowOf(up)?.id === x.id) walk(up)
  }
  walk(bottom)
  return levels.length > 1 ? { bottom, levels } : null
}

/**
 * The main line of the stack `t` is in, bottom first, done levels too: down to the task with no level below it, then up
 * through what lands after each; at a fork the one in a stack on GitHub (`github_stack`), else the first by number.
 * Just `t` for a task in no stack.
 */
export const stackLine = (rows: Rows, t: Task): Array<Task> => {
  let bottom = t
  const seen = new Set<string>([t.id])
  for (let i = 0; i < 64; i++) {
    const below = stackedBelow(rows, bottom)?.task ?? null
    if (below === null || seen.has(below.id)) break
    seen.add(below.id)
    bottom = below
  }
  const line = [bottom]
  let at = bottom
  for (let i = 0; i < 64; i++) {
    const on = stackedOn(rows, at.id)
      .filter((x) => x.kind === "task" && x.merges_into === null && !line.some((l) => l.id === x.id))
      .toSorted((a, b) => a.number - b.number)
    const next = on.find((x) => x.github_stack !== null) ?? on[0]
    if (next === undefined) break
    line.push(next)
    at = next
  }
  return line
}
