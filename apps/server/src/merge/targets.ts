import { Result } from "effect"
import type { Task } from "@huntaway/contracts"
import { retargetColumns } from "../tasks/decide.ts"
import type { TaskColumns } from "../tasks/decide.ts"
import { indexTasks, isMerged, isScratch } from "../tasks/checks.ts"
import { firstTarget, isHeldReason, mergeHeld, reaching, stackedBelow, stackedLevels, stackLine, stackState, targetState } from "../tasks/lanes.ts"
import type { Rows } from "../tasks/lanes.ts"

// Where tasks go when what they merge into (or land after) was closed or deleted, and which stack levels a whole-stack
// merge moves (huntaway's api/incoming.ts `set_merge_target`, `set_stack_target`, `unflag`, `onward_of`, and
// api/stack_merge.ts `stack_to_merge`): plain functions of the project's rows. `Merges` reads git and writes.

/** Where the open tasks merging into (or stacked on) the same closed or deleted task go now. */
export type Choice = { readonly _tag: "Onward" } | { readonly _tag: "Close" } | { readonly _tag: "Heir"; readonly id: string }

/** `onward`, `close`, or a task's id. */
export const choiceOf = (to: string): Choice | null => {
  const t = to.trim()
  if (t === "") return null
  return t === "onward" ? { _tag: "Onward" } : t === "close" ? { _tag: "Close" } : { _tag: "Heir", id: t }
}

/** What a choice is about: the task that held `t`'s merge, and the open tasks sharing it. */
export interface Held {
  /** A target (`merges_into`) closed or deleted, or the level below (`stack`). */
  readonly stacked: boolean
  readonly goneId: string
  /** Null once deleted. */
  readonly gone: Task | null
  readonly siblings: ReadonlyArray<Task>
}

/** What held `t`'s merge, or null when nothing does (its target and the level below are open, merged or none). */
export const heldBy = (rows: Rows, t: Task): Held | null => {
  const st = targetState(rows, t)
  if (st === "closed" || st === "deleted") {
    const f = firstTarget(rows, t)
    if (f === null) return null
    return { stacked: false, goneId: f.id, gone: st === "closed" ? f.task : null, siblings: reaching(rows, f.id) }
  }
  const stack = stackState(rows, t)
  const below = stackedBelow(rows, t)
  if ((stack === "closed" || stack === "deleted") && below !== null) {
    return { stacked: true, goneId: below.id, gone: below.task, siblings: stackedLevels(rows, below.id) }
  }
  return null
}

/** Out of Needs attention if a held merge put it there, back to where its work stands. */
export const unflag = (x: Task): TaskColumns =>
  x.status === "needs_attention" && isHeldReason(x.attention_reason)
    ? { status: x.session_id !== null || x.branch !== null ? "in_review" : "todo", attention_reason: null, merging: false, remerge: false }
    : {}

/** The open task those merging into `t` go to once it's merged: what it merges into, past those merged since; or none. */
export const onwardOf = (rows: Rows, t: Task): Task | null => {
  const find = (id: string | null) => (id === null ? null : (rows.find((x) => x.id === id) ?? null))
  let next = find(t.merges_into)
  for (let i = 0; i < 16 && next !== null && isMerged(next); i++) next = find(next.merges_into)
  return next !== null && next.status !== "done" ? next : null
}

/** A change to one of the tasks a choice moves: its columns, and what its thread is told. */
export interface Moved {
  readonly task: Task
  readonly columns: TaskColumns
  readonly said: string
}

/**
 * Where each task merging into a closed or deleted target goes (`Onward` or `Heir`): into the heir (the others) or where
 * that one was going, with a branch made from that task's keeping where it started and being asked about its commits
 * (`carries`). `starts`: each task's start ref's commit, if it has one.
 */
export const retargets = (rows: Rows, held: Held, heir: Task | null, starts: ReadonlyMap<string, string | null>, base: string | null): Array<Moved> => {
  const goneKey = held.gone?.key ?? "the deleted task it merged into"
  const onward = held.gone === null ? null : onwardOf(rows, held.gone)
  const index = indexTasks(rows)
  return held.siblings.map((x) => {
    const to = heir !== null && x.id !== heir.id ? heir : onward
    const columns: TaskColumns = { ...retargetColumns(x, to, index, starts.get(x.id) ?? null), ...unflag(x) }
    // A branch made from that task's (or one merged into it) may still have its commits, which its merge asks about.
    if (x.branch !== null && x.start_from?.type === "task") columns.carries = { key: held.gone?.key ?? null, commit: starts.get(x.id) ?? null }
    const where = to?.key ?? base ?? "the base branch"
    return {
      task: x,
      columns,
      said: heir?.id === x.id ? `Takes ${goneKey}'s place: merges into ${where} now` : `Merges into ${where} now, instead of ${goneKey}`,
    }
  })
}

/**
 * Where each stack level on a closed or deleted level goes (`Onward` or `Heir`): stacked on the heir (the others), or
 * where that one was going (stacked on the level below it while that's open, else into the task it merges into, else to
 * where it went, `went`), from the commit where its own work starts; those with a branch are restacked there.
 */
export const restacks = (rows: Rows, held: Held, heir: Task | null, starts: ReadonlyMap<string, string | null>, went: string | null): Array<Moved> => {
  const goneKey = held.gone?.key ?? "the deleted task it was stacked on"
  const under = held.gone === null ? null : (stackedBelow(rows, held.gone)?.task ?? null)
  const below = under !== null && under.status !== "done" ? under : null
  const into = held.gone !== null && below === null ? onwardOf(rows, held.gone) : null
  return held.siblings.map((x) => {
    const to = heir !== null && x.id !== heir.id ? heir : below
    let columns: TaskColumns
    let text: string
    if (to !== null) {
      columns = { start_from: { type: "task", task_id: to.id }, base_branch: x.branch !== null ? to.branch : null }
      text = `is stacked on ${to.key} now`
    } else {
      // Its own work starts where it did, whatever it starts from from now on.
      const kept = starts.get(x.id) ?? null
      const from: TaskColumns = { start_from: kept !== null ? { type: "commit", commit: kept } : null }
      if (into !== null) {
        columns = { ...from, merges_into: into.id, base_branch: x.branch !== null ? into.branch : null }
        text = `merges into ${into.key} now`
      } else {
        columns = { ...from, base_branch: x.branch !== null ? went : null }
        text = `goes to ${went ?? "the base branch"} now`
      }
    }
    // Restacked there, without that one's commits.
    if (x.branch !== null) columns.restack = "due"
    return {
      task: x,
      columns: { ...columns, ...unflag(x) },
      said: heir?.id === x.id ? `Takes ${goneKey}'s place: ${text}` : `Instead of ${goneKey}, it ${text}`,
    }
  })
}

// ---- a whole stack's merge --------------------------------------------------------------------------------------

/** A level as a refusal names it: by its title, as the stack card does. */
export const named = (t: Task) => `"${t.title}"`

/** Why level `t` isn't through review, if it isn't: only one in In review, idle, with no review or one that passed is. */
const notThrough = (t: Task): string | null => {
  if (t.status === "ready_for_merge") return null
  const where: Partial<Record<Task["status"], string>> = {
    todo: "isn't started",
    backlog: "isn't started",
    in_progress: "is in progress",
    needs_attention: "needs attention",
  }
  if (t.status !== "in_review") return `${named(t)} ${where[t.status] ?? `is ${t.status.replaceAll("_", " ")}`}`
  if (t.running) return `${named(t)}'s agent is still running`
  const review = t.review?.state ?? null
  if (review === null || review === "passed") return null
  if (review === "running") return `${named(t)} is being reviewed`
  return review === "issues" ? `${named(t)}'s review found issues` : `${named(t)}'s review didn't finish`
}

/** Why a stack can't merge: the task isn't in one (`invalid`), or what holds it (`conflict`). */
export interface StackRefused {
  readonly invalid: boolean
  readonly reason: string
}

/**
 * The open levels of the stack `t` is in that a stack merge moves, bottom first (its main line: tasks landing beside it
 * aren't part of it), or why it can't merge as one yet.
 */
export const stackToMerge = (rows: Rows, t: Task): Result.Result<ReadonlyArray<Task>, StackRefused> => {
  const line = stackLine(rows, t)
  if (line.length < 2) return Result.fail({ invalid: true, reason: "the task isn't in a stack" })
  if (!line.some((x) => x.id === t.id)) return Result.fail({ invalid: true, reason: "the task lands beside its stack, not in it: it merges on its own" })
  const open = line.filter((x) => x.status !== "done")
  if (open.length === 0) return Result.fail({ invalid: false, reason: "every level of the stack is done already" })
  const why: Array<string> = []
  for (const x of open) {
    const reason = notThrough(x)
    if (reason !== null) why.push(reason)
    const below = stackedBelow(rows, x)
    // Below it: nothing (the bottom), a merged level, or an open one that merges with it.
    if (below !== null && below.task === null) why.push(`the task ${named(x)} landed after was deleted: choose where it goes first`)
    else if (below?.task !== undefined && below.task !== null && below.task.status === "done" && !isMerged(below.task)) {
      why.push(`${named(below.task)}, which ${named(x)} lands after, was closed without being merged: choose where it goes first`)
    } else if (x.merges_into === null && mergeHeld(rows, x)) why.push(`${named(x)}'s merge waits for you to choose where it goes`)
    const incoming = reaching(rows, x.id).filter((i) => !isScratch(i))
    if (incoming.length > 0) {
      why.push(`${incoming.length === 1 ? "a task" : `${incoming.length} tasks`} merging into ${named(x)} ${incoming.length === 1 ? "isn't" : "aren't"} done`)
    }
  }
  if (why.length === 0 && !open.some((x) => x.status === "in_review")) why.push("its levels are in Ready for merge already")
  if (why.length > 0) return Result.fail({ invalid: false, reason: `The stack can't merge yet: ${why.join("; ")}` })
  return Result.succeed(open)
}
