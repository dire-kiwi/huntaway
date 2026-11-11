import { useMemo } from "react"
import { TaskId, type DiffResult, type GitShown, type GitStatus, type TurnDiff } from "@huntaway/contracts"
import { rpc } from "../../../state/rpc"

import { parseDiff } from "../diffs"
import type { CommentSource } from "../lineComments"
import type { GitSelection } from "./useGitSelection"
import { short } from "./model"
import { useLoaded } from "./useLoaded"

export type ShownDiffs = ReturnType<typeof useShownDiffs>

/** A number for each status read, so the branch's diff is read again when the status changes (it's kept as it was otherwise). */
const serials = new WeakMap<object, number>()
const counter = { n: 0 }
const serialOf = (o: object | null) => {
  if (o === null) return 0
  const n = serials.get(o) ?? ++counter.n
  serials.set(o, n)
  return n
}

/**
 * What the main panel shows for the panel you're in, other than a file's: the branch's changes against its base (the
 * Status panel's, fetched again when the status changes or a check is asked for, `askedTick`), a turn's, or a
 * commit's or stash's.
 */
export function useShownDiffs(h: string, id: string, sel: GitSelection, status: GitStatus | null, askedTick: number) {
  const { side, turn, commit, stash } = sel
  const task = TaskId.make(id)
  // The same diff (most checks): the same object, so what's picked in it stays.
  const branchRead = useLoaded(side === "status" ? `${h}\n${id}\n${askedTick}\n${serialOf(status)}` : null, () => rpc(h, "git.taskDiff", { id: task }))
  const branch: DiffResult | null = branchRead ? (branchRead.value ?? { available: false, reason: branchRead.error ?? "" }) : null
  // A turn's changes.
  const turnKey = side === "turns" && turn?.diff && turn.before_n !== null ? `${turn.before_n}:${turn.n}` : null
  const turnRead = useLoaded(turnKey && `${h}\n${id}\n${turnKey}`, () => {
    const [from = 0, to = 0] = (turnKey ?? "").split(":").map(Number)
    return rpc(h, "checkpoints.turnDiff", { task_id: task, from, to })
  })
  const turnShown: { key: string; diff?: TurnDiff; error?: string } | null =
    turnRead && turnKey
      ? { key: turnKey, ...(turnRead.value ? { diff: turnRead.value } : {}), ...(turnRead.error !== undefined ? { error: turnRead.error } : {}) }
      : null
  const showSha = side === "commits" ? commit?.sha : side === "stash" ? stash?.sha : undefined
  const shownRead = useLoaded(showSha ? `${h}\n${id}\n${side}\n${showSha}` : null, () =>
    rpc(h, "git.show", { id: task, rev: showSha ?? "", stash: side === "stash" }),
  )
  const shown: { sha: string; commit?: GitShown; patch?: string; error?: string } | null =
    shownRead && showSha && shownRead.key.endsWith(`\n${showSha}`)
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
    turnShown: turnShown?.key === turnKey ? turnShown : null,
    /** The selected commit's or stash's, once they've come. */
    shown,
    shownFiles,
    shownSource,
  }
}
