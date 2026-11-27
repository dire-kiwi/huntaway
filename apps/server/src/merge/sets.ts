import type { Task } from "@huntaway/contracts"
import { isMerged } from "../tasks/checks.ts"
import { statusLabel } from "../workflows/graph.ts"

// Sets across repositories landing together (HE-119; docs/plan/07-agents.md, Work across repositories): what the merge
// queue tells a set's threads, as plain functions. Whether a set's task waits is `tasks/sets.ts` `setWaitsFor`, which
// `decideLanes` reads.

const listed = (tasks: ReadonlyArray<Task>) =>
  tasks.map((t) => `${t.key} (${t.status === "ready_for_merge" ? "waiting for approval" : statusLabel(t.status)})`).join(", ")

/** Why a set's task in Ready for merge doesn't merge yet: the tasks of its set it waits for (`setWaitsFor`). */
export const setWaitText = (waits: ReadonlyArray<Task>): string =>
  `Waits for the rest of its set before it merges: ${listed(waits)}. Once every open task of the set is in Ready for merge, each merges in its own project's queue`

/**
 * Whether a change of a set's task is its merge failing: it was in the merge, not waiting on the user, and now needs
 * attention there (not for the user's approval), or it left the merge without being merged (not stepping out to make
 * changes, which rejoins it).
 */
export const mergeFailed = (before: Task, after: Task): boolean => {
  if (!before.merging || before.status === "needs_attention" || isMerged(after)) return false
  if (after.merging) return after.status === "needs_attention" && after.merge_approval !== "pending"
  return !after.remerge
}

/** What the lead's thread is told when `failed`'s merge failed once `merged`, others of its set, had merged. */
export const setMergeFailedText = (failed: Task, merged: ReadonlyArray<Task>): string => {
  const why =
    failed.status === "needs_attention" && failed.attention_reason !== null
      ? failed.attention_reason
      : `it left the merge without being merged (it's in ${statusLabel(failed.status)} now)`
  const keys = merged.map((t) => t.key).join(", ")
  return `${failed.key} couldn't merge, after ${keys} of its set ${merged.length === 1 ? "has" : "have"} merged: ${why}. The set's tasks not merged yet wait until it's in Ready for merge again; settle it with ${failed.key}, or close it as not done`
}
