import { useAtomValue } from "@effect/atom-react"
import { clsx } from "clsx"
import { Check, FilePen, FolderX, GitMerge, Unlink } from "lucide-react"
import { AsyncResult, Atom } from "effect/reactivity"
import { query, type HostTask as Task } from "@huntaway/client"
import type { MergeWork } from "@huntaway/contracts"
import { useVisible } from "../../state/visibility"

// HE-51: whether a task in review has something to merge, marked on its card and in its details, so that the tasks with
// nothing left to merge can be moved to Done at a glance. It's `git.mergeWork`, asked of the task's host: the commits
// on its branch that the branch its work goes to doesn't have, and the files in its worktree with uncommitted changes.
// One query per task shared by everything showing it (its card and its details), read again as its agent stops or its
// worktree, branch or column changes (invalidate.ts), as the Changes tab changes its git state, every minute while the
// page is visible (an agent or a terminal outside the board may commit) and when the window gets the focus back.

const POLL = "60 seconds"

/** What is read for a task that isn't in review: nothing. */
const notRead: Atom.Atom<AsyncResult.AsyncResult<MergeWork>> = Atom.make(AsyncResult.initial())

/** Whether a task's mark is shown: a task in review with a branch of its own. */
export const marksMergeWork = (task: Task) => task.status === "in_review" && task.kind === "task" && !!task.project_id && !!task.branch

/** What `task` has to merge, while it's in review: null until the first read comes back, or when it failed. */
export function useMergeWork(task: Task): MergeWork | null {
  const visible = useVisible()
  const read = useAtomValue<AsyncResult.AsyncResult<MergeWork, unknown>>(
    marksMergeWork(task) ? query("git.mergeWork", task.host_id, { id: task.id }, { refresh: visible ? POLL : undefined, focus: true }) : notRead,
  )
  return marksMergeWork(task) ? AsyncResult.getOrElse(read, () => null) : null
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** How a task's work to merge reads: `tone` picks its colour; `short` is the card's words, `long` the details' and the tooltip. */
export interface MergeWorkFacts {
  readonly tone: "changes" | "nothing" | "gone" | "unknown"
  readonly short: string
  readonly long: string
}

/** What `w` says, in words. */
export function mergeWorkFacts(w: MergeWork): MergeWorkFacts {
  const base = w.base ?? "its base branch"
  const commits = w.commits ?? 0
  const uncommitted = w.uncommitted ?? 0
  const lost = w.worktree === "gone" ? "; its worktree's folder is gone" : ""
  if (w.branch === "gone")
    return {
      tone: "gone",
      short: "branch gone",
      long: `Its branch is gone${w.worktree === "gone" ? ", and so is its worktree" : ""}${uncommitted > 0 ? `; its worktree has ${plural(uncommitted, "file")} with uncommitted changes` : ""}`,
    }
  if (commits > 0 || uncommitted > 0) {
    const parts = [
      ...(commits > 0 ? [`${plural(commits, "commit")} not on ${base}`] : []),
      ...(uncommitted > 0 ? [`${plural(uncommitted, "file")} with uncommitted changes`] : []),
    ]
    return { tone: "changes", short: "", long: `To merge: ${parts.join(", ")}${lost}` }
  }
  if (w.commits === null) return { tone: "unknown", short: "", long: `Couldn't count its commits against ${base}${lost}` }
  if (w.worktree === "gone") return { tone: "gone", short: "worktree gone", long: `Nothing to merge into ${base}, but its worktree's folder is gone` }
  return { tone: "nothing", short: "nothing to merge", long: `Nothing to merge: ${base} has all of its commits, and nothing is uncommitted` }
}

/** The card's mark: the commits and uncommitted files to merge, "nothing to merge", or what's gone. */
export function MergeWorkMark({ task, className }: { task: Task; className?: string | undefined }) {
  const w = useMergeWork(task)
  if (!w) return null
  const facts = mergeWorkFacts(w)
  if (facts.tone === "unknown") return null
  return (
    <span
      title={facts.long}
      aria-label={facts.long}
      data-merge-work={facts.tone}
      className={clsx(
        "inline-flex shrink-0 items-center gap-1 whitespace-nowrap",
        facts.tone === "changes" ? "text-st-merge" : facts.tone === "gone" ? "text-amber-300/80" : "text-faint",
        className,
      )}
    >
      {facts.tone === "changes" ? (
        <>
          {!!w.commits && (
            <span className="inline-flex items-center gap-0.5">
              <GitMerge size={11} />
              {w.commits}
            </span>
          )}
          {!!w.uncommitted && (
            <span className="inline-flex items-center gap-0.5">
              <FilePen size={11} />
              {w.uncommitted}
            </span>
          )}
          {w.worktree === "gone" && <FolderX size={11} className="text-amber-300/80" />}
        </>
      ) : (
        <>
          {facts.tone === "nothing" ? <Check size={11} /> : w.branch === "gone" ? <Unlink size={11} /> : <FolderX size={11} />}
          {facts.short}
        </>
      )}
    </span>
  )
}

/** The details' line: what there is to merge, in words. */
export function MergeWorkLine({ task, className }: { task: Task; className?: string | undefined }) {
  const w = useMergeWork(task)
  if (!w) return null
  const facts = mergeWorkFacts(w)
  return (
    <span
      data-merge-work={facts.tone}
      className={clsx(
        "flex items-start gap-1.5 text-[12px]",
        facts.tone === "changes" ? "text-st-merge" : facts.tone === "gone" ? "text-amber-300/80" : "text-muted",
        className,
      )}
    >
      {facts.tone === "nothing" ? (
        <Check size={12} className="mt-0.5 shrink-0" />
      ) : facts.tone === "gone" ? (
        <FolderX size={12} className="mt-0.5 shrink-0" />
      ) : (
        <GitMerge size={12} className="mt-0.5 shrink-0" />
      )}
      <span className="min-w-0">{facts.long}</span>
    </span>
  )
}
