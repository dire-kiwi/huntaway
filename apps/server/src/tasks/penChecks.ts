import { Result } from "effect"
import { Invalid, PenColor, threadKindOf } from "@huntaway/contracts"
import type { PenId, TaskPatch, ThreadKindFields } from "@huntaway/contracts"

// The rules of pens (huntaway's db/pens.ts and api/pens.ts `task_pen`, docs/plan/inventory/02-agent-support.md 2.9):
// pure functions, shared by `Pens` and by a task's update, which can put it in a pen by name.

/** The colours a pen can have, in the order new pens get them (each as unlike the ones before it as can be). */
export const PEN_COLORS: ReadonlyArray<PenColor> = PenColor.literals

/** How long a pen's name can be. */
export const PEN_NAME_MAX = 60

/** A pen's name as it is kept: trimmed, its spaces collapsed, not blank, not too long. */
export const checkPenName = (name: string): Result.Result<string, Invalid> => {
  const n = name.trim().replace(/\s+/g, " ")
  if (n === "") return Result.fail(new Invalid({ field: "name", reason: "a pen's name must be a non-empty string" }))
  if (n.length > PEN_NAME_MAX) return Result.fail(new Invalid({ field: "name", reason: `a pen's name can be ${PEN_NAME_MAX} characters at most` }))
  return Result.succeed(n)
}

/** The colour for a new pen beside pens with `used` colours: the first none of them has, else the first of those fewest have. */
export const nextPenColor = (used: ReadonlyArray<string>): PenColor => {
  const n = (c: string) => used.filter((u) => u === c).length
  return PEN_COLORS.reduce((best, c) => (n(c) < n(best) ? c : best), "blue")
}

/** A colour read from a row: one of `PEN_COLORS`, else the first (a pen from before colours). */
export const penColorOf = (stored: string): PenColor => PEN_COLORS.find((c) => c === stored) ?? "blue"

/** The pens' order once pen `id` moves to place `index` among them (0 is the first; past the end is the last). */
export const reordered = <A extends { readonly id: string }>(pens: ReadonlyArray<A>, id: string, index: number): ReadonlyArray<A> => {
  const moved = pens.find((p) => p.id === id)
  if (moved === undefined) return pens
  const others = pens.filter((p) => p.id !== id)
  const at = Math.max(0, Math.min(others.length, Math.trunc(index)))
  return [...others.slice(0, at), moved, ...others.slice(at)]
}

/** Only a task on the board can be in a pen: not a review thread, the assistant or its routines, or the pens' threads. */
export const canBeInPen = (task: ThreadKindFields): boolean => {
  if (task.kind !== "task") return false
  const tag = threadKindOf(task)._tag
  return tag === "Code" || tag === "Scratch" || tag === "Group" || tag === "Document"
}

/** Which pen a task update asks for: none asked (`Keep`), out of its pen, a pen by id, or one by name (made if missing). */
export type PenWanted =
  | { readonly _tag: "Keep" }
  | { readonly _tag: "Out" }
  | { readonly _tag: "ById"; readonly id: PenId }
  | { readonly _tag: "ByName"; readonly name: string }

/**
 * The pen `patch` asks for task `task` (huntaway's api/pens.ts `task_pen`): `pen` (a name) wins over `pen_id`; null or
 * blank takes it out, which any task may be. A task off the board can't go into one.
 */
const refused = (field: string) => Result.fail(new Invalid({ field, reason: "only a task on the board can be in a pen" }))

export const penWanted = (task: ThreadKindFields, patch: Pick<TaskPatch, "pen" | "pen_id">): Result.Result<PenWanted, Invalid> => {
  if (patch.pen !== undefined) {
    const name = patch.pen
    if (name === null || name.trim() === "") return Result.succeed({ _tag: "Out" })
    if (!canBeInPen(task)) return refused("pen")
    return Result.map(checkPenName(name), (n): PenWanted => ({ _tag: "ByName", name: n }))
  }
  const id = patch.pen_id
  if (id === undefined) return Result.succeed({ _tag: "Keep" })
  if (id === null || id.trim() === "") return Result.succeed({ _tag: "Out" })
  if (!canBeInPen(task)) return refused("pen_id")
  return Result.succeed({ _tag: "ById", id })
}
