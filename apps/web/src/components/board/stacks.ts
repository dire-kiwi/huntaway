// Stacks on the board (HA-388, the Stack card of HA-386): a project's tasks grouped into stacks by their stack levels'
// links (`stackedBelowId`), the column a gathered stack's card sits in, whether it can merge as a whole, and whether each
// stack is gathered into one card or spread into its levels' own, kept in this browser. Plain functions of the tasks, no
// React, so the component checks can test them as they are.
import { isArchived, isMerged, readyToCheck, STATUSES, type HostTask as Task } from "@huntaway/client"
import type { Status } from "@huntaway/contracts"
import { sortTasks, type SortKey } from "./boardQuery"

/** The id of the task `t` is stacked on, if it's a stack level (as the server's db.stacked_below). */
export function stackedBelowId(t: Task): string | null {
  return t.kind === "task" && !t.merges_into && t.start_from?.type === "task" ? t.start_from.task_id : null
}

export interface Stack {
  /** `<host>:<bottom task's id>`: what its gathered or spread state is kept by. */
  key: string
  /** The task at the bottom, which starts from a branch (or from a task that's gone). It keeps the stack's title. */
  bottom: Task
  /** The main line, bottom first, in landing order. */
  main: Task[]
  /** The tasks beside it (forks: a second task landing after the same level, and what lands after that), in order. */
  beside: Task[]
  /** All of them: `main`, then `beside`. */
  tasks: Task[]
  /** For a task beside the stack, the id of the task it lands after. */
  after: Record<string, string>
}

const byNumber = (a: Task, b: Task) => a.number - b.number

/**
 * The stacks among `tasks` (a board's, done and archived ones too): from each task that isn't a level on another of
 * them, up through what lands after it. Where two tasks land after the same level (the bottom too), the main line goes
 * on with the one stacked on it on GitHub (`github_stack`: GitHub's stacks are single chains, so one at most), else the
 * lowest numbered, as the server's db.stack_line, which merging the stack merges; the other, and what lands after it,
 * is beside the stack. A stack has at least two tasks. Merged levels stay in it.
 */
const at = (host: string, id: string) => `${host}:${id}`

export function groupStacks(tasks: Task[]): Stack[] {
  const all = new Map(tasks.map((t) => [at(t.host_id, t.id), t]))
  const above = new Map<string, Task[]>()
  for (const t of tasks) {
    const below = stackedBelowId(t)
    if (below && all.has(at(t.host_id, below))) {
      const k = at(t.host_id, below)
      above.set(k, [...(above.get(k) ?? []), t])
    }
  }
  for (const list of above.values()) list.sort(byNumber)
  const levelsOn = (t: Task) => above.get(at(t.host_id, t.id)) ?? []
  const stacks: Stack[] = []
  for (const bottom of tasks) {
    const below = stackedBelowId(bottom)
    if ((below && all.has(at(bottom.host_id, below))) || !levelsOn(bottom).length) continue
    const seen = new Set<string>([bottom.id])
    const main = [bottom]
    const beside: Task[] = []
    const after: Record<string, string> = {}
    // A fork and everything above it, in order.
    const besideFrom = (t: Task, from: Task) => {
      if (seen.has(t.id)) return
      seen.add(t.id)
      beside.push(t)
      after[t.id] = from.id
      for (const up of levelsOn(t)) besideFrom(up, t)
    }
    let level: Task | undefined = bottom
    while (level) {
      const cur: Task = level
      const ups: Task[] = levelsOn(cur).filter((t) => !seen.has(t.id))
      const next: Task | undefined = ups.find((t) => t.github_stack != null) ?? ups[0]
      if (next) {
        seen.add(next.id)
        main.push(next)
      }
      for (const t of ups) if (t !== next) besideFrom(t, cur)
      level = next
    }
    stacks.push({ key: at(bottom.host_id, bottom.id), bottom, main, beside, tasks: [...main, ...beside], after })
  }
  return stacks
}

/** The order the column of a gathered stack's card is picked in, by its open levels' statuses. */
const COLUMN_ORDER: Status[] = ["needs_attention", "in_progress", "in_review", "ready_for_merge", "todo", "backlog"]

/**
 * The column a gathered stack's card sits in: Needs attention if any open level (beside the stack too) is there, else
 * In progress, else In review, else Ready for merge, else To do, else Backlog; Done once every level is done.
 */
export function stackColumn(s: Stack): Status {
  const open = s.tasks.filter((t) => t.status !== "done")
  return COLUMN_ORDER.find((st) => open.some((t) => t.status === st)) ?? "done"
}

/** Every level is archived (done for two days by `now`): the card leaves the board with them. */
export const stackArchived = (s: Stack, now: number) => s.tasks.every((t) => isArchived(t, now))

/** The main line's open levels, bottom first: what merging the stack merges. */
export const openMain = (s: Stack) => s.main.filter((t) => t.status !== "done")

/** The level the stack's landing waits on: its lowest open main-line level. */
export const landsNext = (s: Stack): Task | undefined => openMain(s)[0]

/** The run of the merge queue the stack is merging in (API 153), if it is. */
export const stackRun = (s: Stack) => openMain(s).find((t) => t.stack_run)?.stack_run ?? null

/** The quoted title of a level, which is how the card names one (never by key). */
export const named = (t: Task) => `“${t.title}”`

/** "“A”", "“A” and “B”", "“A”, “B” and 2 more". */
export function namesOf(tasks: Task[], max = 3) {
  const names = tasks.slice(0, tasks.length > max ? max - 1 : max).map(named)
  if (tasks.length > max) return `${names.join(", ")} and ${tasks.length - names.length} more`
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : (names[0] ?? "")
}

const statusLabel = (t: Task) => STATUSES.find((s) => s.id === t.status)?.label.toLowerCase() ?? t.status

/** Why a level isn't through review yet, in a few words. */
function notThroughWhy(t: Task) {
  if (t.status !== "in_review") return statusLabel(t)
  if (t.running) return "its agent is working"
  if (t.review?.state === "running") return "being reviewed"
  if (t.review?.state === "issues") return "its review found issues"
  return "its review didn't finish"
}

/** Whether a stack can merge as a whole now (as the server's merge-stack checks), and if not why. */
export interface MergeCheck {
  ok: boolean
  /** Why not, naming the levels by title. */
  reason: string | null
  /** The open main-line levels that aren't through review yet. */
  waiting: Task[]
}

/**
 * Whether stack `s` can be moved to Ready for merge as a whole (API 153), as the server's condition: every open level of
 * its main line is in review with no review or a passed one and its agent not running, or in Ready for merge already;
 * at least one is in review; no open task merges into an open level; and the lowest open level isn't held (the level
 * below it was closed without being merged, or deleted). `all` is the store's tasks, by id. Tasks beside the stack
 * aren't part of it.
 */
const no = (reason: string, waiting: Task[] = []): MergeCheck => ({ ok: false, reason, waiting })

export function mergeCheck(s: Stack, all: Record<string, Task>): MergeCheck {
  const open = openMain(s)
  if (!open.length) return no("Every level of the stack has landed.")
  if (stackRun(s)) return no("The stack is merging.")
  const waiting = open.filter((t) => !readyToCheck(t) && t.status !== "ready_for_merge")
  if (waiting.length) return no(`Not through review yet: ${waiting.map((t) => `${named(t)} (${notThroughWhy(t)})`).join(", ")}.`, waiting)
  if (!open.some((t) => t.status === "in_review")) return no("Every open level is in Ready for merge already.")
  const ids = new Set(open.map((t) => t.id))
  const incoming = Object.values(all).filter((t) => t.status !== "done" && t.merges_into && ids.has(t.merges_into) && t.host_id === s.bottom.host_id)
  if (incoming.length) {
    const into = (t: Task) => open.find((l) => l.id === t.merges_into)
    return no(`Tasks merge into a level first: ${incoming.map((t) => `${named(t)} into ${((i) => (i ? named(i) : "a level"))(into(t))}`).join(", ")}.`)
  }
  const low = open[0]
  if (!low) return { ok: true, reason: null, waiting: [] }
  const belowId = stackedBelowId(low)
  const below = belowId ? all[belowId] : undefined
  if (belowId && (!below || (below.status === "done" && !isMerged(below))))
    return no(`${named(low)} waits for you to choose where it goes, as the level below it was ${below ? "closed without being merged" : "deleted"}.`)
  return { ok: true, reason: null, waiting: [] }
}

/** A card in a kanban column: a task's own, or a gathered stack's (with how many of its levels the filters leave out). */
export type ColumnEntry = { task: Task; stack?: undefined } | { task: Task; stack: Stack; hidden: number }

/**
 * The kanban board's columns with `stacks` (the gathered ones) each one card: `shown` is each column's tasks the filters
 * keep (`keep`), sorted. A stack's levels leave their columns, and its card goes in its column (stackColumn) when any of
 * its levels that isn't archived is kept (`keep`, and its status is `shows`n); when the status filter hides that column,
 * in the first column shown that a kept level is in, by stackColumn's order. `hidden` counts the levels left out; `task` is then the stack's level in that column it takes the place of (its
 * top-most there, by hand), which a drop above the card goes before. Sorted otherwise, the card goes by its latest active
 * level (latest activity), its bottom task's age (newest, oldest), its title or what its levels cost together.
 */
export function columnEntries(
  shown: Record<Status, Task[]>,
  stacks: Stack[],
  keep: (t: Task) => boolean,
  /** Whether the status filter shows a status's column. */
  shows: (s: Status) => boolean,
  sort: SortKey,
  now: number,
  title: (s: Stack) => string,
): Record<Status, ColumnEntry[]> {
  const gathered = new Set(stacks.flatMap((s) => s.tasks.map((t) => `${t.host_id}:${t.id}`)))
  const reps = new Map<Task, ColumnEntry>()
  const columns = byStatus((k) =>
    shown[k]
      .filter((t) => !gathered.has(`${t.host_id}:${t.id}`))
      .map((t) => {
        reps.set(t, { task: t })
        return t
      }),
  )
  for (const s of stacks) {
    if (stackArchived(s, now)) continue
    const live = s.tasks.filter((t) => !isArchived(t, now))
    // The levels the filters keep, by status too: with the stack's own column filtered out, its card goes in the first
    // column shown that one of them is in, in the order its column is picked in.
    const kept = live.filter((t) => keep(t) && shows(t.status))
    if (!kept.length) continue
    const own = stackColumn(s)
    const col = shows(own) ? own : (([...COLUMN_ORDER, "done"] satisfies Status[]).find((st) => kept.some((t) => t.status === st)) ?? own)
    const anchor = live.filter((t) => t.status === col).toSorted((a, b) => a.position - b.position || a.created_at.localeCompare(b.created_at))[0] ?? s.bottom
    const rep: Task = Object.assign({}, anchor, {
      title: title(s),
      last_activity_at: s.tasks.reduce((a, t) => (t.last_activity_at > a ? t.last_activity_at : a), s.bottom.last_activity_at),
      created_at: s.bottom.created_at,
      cost_usd: s.tasks.reduce((n, t) => n + t.cost_usd, 0),
    })
    reps.set(rep, { task: anchor, stack: s, hidden: live.length - kept.length })
    columns[col].push(rep)
  }
  return byStatus((k) => {
    const ts = columns[k]
    const sorted = sort === "manual" ? ts.toSorted((a, b) => a.position - b.position || a.created_at.localeCompare(b.created_at)) : sortTasks(ts, sort)
    return sorted.flatMap((t) => reps.get(t) ?? [])
  })
}

/** A value for each status, as `f` gives it. */
export function byStatus<T>(f: (s: Status) => T): Record<Status, T> {
  return {
    backlog: f("backlog"),
    todo: f("todo"),
    in_progress: f("in_progress"),
    needs_attention: f("needs_attention"),
    in_review: f("in_review"),
    ready_for_merge: f("ready_for_merge"),
    done: f("done"),
  }
}

/** Where a spread stack's level is: its place in the main line ("2 of 3"), or beside it. */
export function placeIn(s: Stack, t: Task): { n: number; of: number; beside: boolean } {
  const i = s.main.indexOf(t)
  return i >= 0 ? { n: i + 1, of: s.main.length, beside: false } : { n: s.beside.indexOf(t) + 1, of: s.main.length, beside: true }
}

/**
 * Whether stacks are gathered (the top bar's switch, for every board), and the stacks gathered or spread one at a time
 * since it was last flipped (by their keys), in this browser (`stackViewsKept` in taskBoard/useBoardStacks).
 */
export interface StackViews {
  /** The switch: every stack gathered unless it says otherwise. */
  readonly gathered: boolean
  /** The stacks gathered (true) or spread (false) on their own, by key. */
  readonly own: Readonly<Record<string, boolean>>
}

export const isGathered = (v: StackViews, s: Stack) => v.own[s.key] ?? v.gathered

/** `v` with stack `s` gathered or spread on its own. */
export const withStack = (v: StackViews, s: Stack, gathered: boolean): StackViews => {
  const own = { ...v.own }
  if (gathered === v.gathered) delete own[s.key]
  else own[s.key] = gathered
  return { ...v, own }
}

/** `v` with every stack gathered or spread: the switch, which forgets the ones set on their own. */
export const withAll = (gathered: boolean): StackViews => ({ gathered, own: {} })
