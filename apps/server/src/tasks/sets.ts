import { Result } from "effect"
import { Invalid } from "@huntaway/contracts"
import type { NewTask, Task, TaskId } from "@huntaway/contracts"
import { slugify } from "../platform/slug.ts"
import { isMerged } from "./checks.ts"
import { PEN_NAME_MAX } from "./penChecks.ts"

// Sets of tasks across repositories (HE-117; docs/plan/07-agents.md, Work across repositories): one task per
// repository, made together, the first the set's lead, all on one branch name. The rules, as plain functions.

/** How many other projects a set can take: eight repositories in all, T3 Code's default. */
export const SET_OTHERS_MAX = 7

/** How far a taken branch name is counted on (`-2` up to this). */
export const BRANCH_SUFFIX_MAX = 50

const refuse = (field: string, reason: string) => Result.fail(new Invalid({ field, reason }))
const given = (v: string | null | undefined) => typeof v === "string" && v.trim() !== ""

/**
 * Whether `input` (with `also_in`) can be a set: a task in a project, with a worktree, starting from its project's base
 * branch and merging into it, and with a title to name the set's tasks and pen after. A review or stack thread can't be
 * asked for (`NewTask` makes neither), so only scratch and group tasks are refused by kind.
 */
export const checkSet = (input: NewTask, also: ReadonlyArray<string>): Result.Result<void, Invalid> => {
  const why = "a set of tasks across repositories"
  if (input.task_type === "scratch") return refuse("also_in", `a scratch task can't be ${why}: it has no worktree or branch`)
  if (input.group !== undefined) return refuse("also_in", `a group task can't be ${why}: it plans across the group's projects, with no worktree`)
  if (input.project_id === undefined) return refuse("also_in", `${why} starts in a project: give project_id`)
  if (input.use_worktree === false) return refuse("also_in", `${why} works in a worktree in each repository: leave use_worktree on`)
  if (given(input.merges_into)) {
    return refuse("also_in", `${why} can't merge into another task: each of its tasks merges into its own project's base branch`)
  }
  const from = input.start_from
  if (from !== undefined && from !== null && (typeof from !== "string" || from.trim() !== "")) {
    return refuse("also_in", `${why} can't start from elsewhere: each of its worktrees starts from its own project's base branch`)
  }
  if ((input.title ?? "").trim() === "") return refuse("title", `${why} needs a title: its tasks and its pen are named after it`)
  if (also.length > SET_OTHERS_MAX) return refuse("also_in", `${why} takes ${SET_OTHERS_MAX} other projects at most`)
  return Result.succeed(undefined)
}

/** The branch a set led by `leadKey` (e.g. "HE-7") and titled `title` is named for, before it's made free: `ia/he-7-<slug>`. */
export const setBranchBase = (leadKey: string, title: string): string => {
  const slug = slugify(title, 40)
  return `ia/${leadKey.toLowerCase()}${slug === "" ? "" : `-${slug}`}`
}

/** Whether branch `name` can't be made beside branch `other`: the same, or one a folder of the other (`a` and `a/b`). */
const clashes = (name: string, other: string) => name === other || other.startsWith(`${name}/`) || name.startsWith(`${other}/`)

/**
 * The first of `base`, `base-2` … `base-50` that no name in `taken` clashes with (T3 Code's `freeBranchName`), where
 * `taken` is every repository's local and remote branches without their remote; null if all of them are taken.
 */
export const freeBranchName = (base: string, taken: ReadonlyArray<string>): string | null => {
  for (let n = 1; n <= BRANCH_SUFFIX_MAX; n++) {
    const name = n === 1 ? base : `${base}-${n}`
    if (!taken.some((t) => clashes(name, t))) return name
  }
  return null
}

/** The pen a set goes in when it's given none: named after its title, cut to a pen name's length. */
export const setPenName = (title: string): string => title.trim().replace(/\s+/g, " ").slice(0, PEN_NAME_MAX).trim()

// ---- landing together and leaving the set (HE-119) ------------------------------------------------------------------

/** The id of the lead of the set `t` is in: its own when it leads one, or is in none. */
export const leadOf = (t: Pick<Task, "id" | "lead_id">): TaskId => t.lead_id ?? t.id

/** The tasks of `t`'s set among `rows` (any projects'), `t` too, in the order of `rows`. Just `t` for a task in no set. */
export const setOf = (rows: ReadonlyArray<Task>, t: Task): Array<Task> => {
  const lead = leadOf(t)
  const set = rows.filter((x) => x.kind === "task" && leadOf(x) === lead)
  return set.some((x) => x.id === t.id) ? set : [...set, t]
}

/**
 * Whether `t` counts as landing for its set: in Ready for merge (queued, merging, or handed to its workflow once merged)
 * and not waiting for the user's approval of its merge, which may yet be denied.
 */
export const readyToLand = (t: Task): boolean => t.status === "ready_for_merge" && t.merge_approval !== "pending"

/**
 * The tasks of its set that `t`'s merge waits for (`set`: its set's rows, as `setOf` or `TaskRepo.inSet` give them): every
 * other open task that isn't in Ready for merge yet. A task closed (as not done or won't fix) or merged doesn't count.
 * Empty for a task in no set, and once the whole set is there: then each merges in its own project's queue.
 */
export const setWaitsFor = (set: ReadonlyArray<Task>, t: Task): Array<Task> =>
  set.filter((x) => x.id !== t.id && x.kind === "task" && x.status !== "done" && !readyToLand(x))

/** Whether `t` was closed without being merged: done as not done or won't fix. */
export const closedUnmerged = (t: Pick<Task, "status" | "resolution">): boolean => t.status === "done" && !isMerged(t)

/**
 * What a set's task leaving it writes on the others (`set`: the set's rows in the order they were made, `gone` among them
 * as it was): the lead deleted or closed hands the set to the next open task by creation (deleted, to the next task when
 * none is open), whose `lead_id` is cleared, and every other task's, a closed lead's too (it's in the set again once
 * reopened), names it. A set down to one task is an ordinary task: its `lead_id` is null. A follower leaving changes
 * nobody's, nor does a closed lead when no task is open (it still leads the set).
 */
export const handOnSet = (set: ReadonlyArray<Task>, gone: Task, how: "deleted" | "closed"): Array<{ readonly id: TaskId; readonly lead_id: TaskId | null }> => {
  if (gone.lead_id !== null && gone.lead_id !== undefined) return []
  const rest = set.filter((x) => x.id !== gone.id && leadOf(x) === gone.id)
  const heir = rest.find((x) => x.status !== "done") ?? (how === "deleted" ? rest[0] : undefined)
  if (heir === undefined) return []
  const others = how === "deleted" ? rest : [...rest, gone]
  return others.flatMap((x) => {
    const lead_id = x.id === heir.id ? null : heir.id
    return (x.lead_id ?? null) === lead_id ? [] : [{ id: x.id, lead_id }]
  })
}
