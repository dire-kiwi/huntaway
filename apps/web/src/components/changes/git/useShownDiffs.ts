import { useAtomValue } from "@effect/atom-react"
import { AsyncResult, Atom } from "effect/reactivity"
import { useMemo } from "react"
import { TaskId, type DiffResult, type GitShown, type TurnDiff } from "@huntaway/contracts"
import { query, type QueryOptions } from "@huntaway/client"
import { parseDiff } from "../diffs"
import type { CommentSource } from "../lineComments"
import type { GitSelection } from "./useGitSelection"
import { short } from "./model"
import { useKept } from "./useGitStatus"
import { resultError, resultValue } from "../../ui"

export type ShownDiffs = ReturnType<typeof useShownDiffs>

/** What isn't shown: no read. */
const nothing: Atom.Atom<AsyncResult.AsyncResult<never>> = Atom.make(AsyncResult.initial())

/** What a read gave (null: nothing to read), kept as it was while it's the same (so what's picked in it stays), or why it failed. */
function useRead<A>(read: Atom.Atom<AsyncResult.AsyncResult<A, unknown>> | null): { value?: A; error?: string } | null {
  const result = useAtomValue<AsyncResult.AsyncResult<A, unknown>>(read ?? nothing)
  const error = resultError(result)
  const value = useKept(resultValue(result))
  if (error !== null) return { error }
  return value === undefined ? null : { value }
}

/**
 * What the main panel shows for the panel you're in, other than a file's: the branch's changes against its base (the
 * Status panel's, read as the status is, `reads`), a turn's, or a commit's or stash's.
 */
export function useShownDiffs(h: string, id: string, sel: GitSelection, reads: QueryOptions) {
  const { side, turn, commit, stash } = sel
  const task = TaskId.make(id)
  // The same diff (most checks): the same object, so what's picked in it stays.
  const branchRead = useRead(side === "status" ? query("git.taskDiff", h, { id: task }, reads) : null)
  const branch: DiffResult | null = branchRead ? (branchRead.value ?? { available: false, reason: branchRead.error ?? "" }) : null
  // A turn's changes.
  const turnKey = side === "turns" && turn?.diff && turn.before_n !== null ? `${turn.before_n}:${turn.n}` : null
  const [from = 0, to = 0] = (turnKey ?? "").split(":").map(Number)
  const turnRead = useRead(turnKey ? query("checkpoints.turnDiff", h, { task_id: task, from, to }) : null)
  const turnShown: { key: string; diff?: TurnDiff; error?: string } | null =
    turnRead && turnKey
      ? { key: turnKey, ...(turnRead.value ? { diff: turnRead.value } : {}), ...(turnRead.error !== undefined ? { error: turnRead.error } : {}) }
      : null
  const showSha = side === "commits" ? commit?.sha : side === "stash" ? stash?.sha : undefined
  const shownRead = useRead(showSha ? query("git.show", h, { id: task, rev: showSha, stash: side === "stash" }) : null)
  const shown: { sha: string; commit?: GitShown; patch?: string; error?: string } | null =
    shownRead && showSha
      ? {
          sha: showSha,
          ...(shownRead.value?.message !== undefined ? { commit: shownRead.value } : {}),
          ...(shownRead.value ? { patch: shownRead.value.patch } : {}),
          ...(shownRead.error !== undefined ? { error: shownRead.error } : {}),
        }
      : null
  const shownFiles = useMemo(() => parseDiff(shown?.patch ?? ""), [shown?.patch])
  const stashIndex = side === "stash" ? stash?.index : undefined
  const shownSha = shown?.sha
  const shownSource = useMemo<CommentSource | undefined>(
    () =>
      shownSha === undefined
        ? undefined
        : stashIndex !== undefined
          ? { key: `stash:${shownSha}`, label: `stash@{${stashIndex}}` }
          : { key: `commit:${shownSha}`, label: `commit ${short(shownSha)}` },
    [shownSha, stashIndex],
  )
  return {
    branch,
    /** The selected turn's changes, once they've come. */
    turnShown,
    /** The selected commit's or stash's, once they've come. */
    shown,
    shownFiles,
    shownSource,
  }
}
