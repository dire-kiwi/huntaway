// Stack levels (API 142, HA-297): a task started from another (start_from a task, without merges_into) lands on its own
// after the one below: its merge waits until that's merged, then it's restacked onto where that went. Its card and task
// view say how that stands, apart from "Merges into", and the task below lists them. Only a level whose pull request is
// in a stack on GitHub with the one below's (API 150, HA-336: `github_stack`, which GitHub then restacks) is called
// "stacked"; the others "land after" the task below, as ordinary pull requests on its branch that the board restacks.
import { clsx } from "clsx"
import { ArrowUpFromLine, Layers } from "lucide-react"
import type { ReactNode } from "react"
import { useShallow, type State } from "../boardHelpers"
import { isMerged, keyPrefix, STATUSES, type HostProject as Project, type HostTask as Task } from "@huntaway/client"
import { openTask } from "../../state/route"

import { CARD_BADGE, StatusIcon, Wide } from "../ui"
import { stackedBelowId } from "./stacks"
import { board, useBoard } from "../../state/board"

type StoreState = State

export const keyOf = (t: Task, project?: Project | null) => `${keyPrefix(t, project ?? undefined)}-${t.number}`
export const statusLabel = (t: Task) => (isMerged(t) ? "merged" : t.status === "done" ? "closed" : (STATUSES.find((s) => s.id === t.status)?.label ?? t.status))

/** Whether the task's host has stack levels: every host on this server does. */
export function useStacksOn(_hostId: string | undefined): boolean {
  return true
}

export { stackedBelowId }

/** Whether stack level `t`'s pull request is in a stack on GitHub (API 150): only then is it "stacked". */
export const onGitHub = (t: Task) => t.github_stack != null

/** The page of the GitHub stack level `t`'s pull request is in, if it's in one. */
export function githubStackUrl(t: Task): string | null {
  if (t.github_stack == null || !t.pr_url) return null
  const m = t.pr_url.match(/^(https:\/\/[^/]+\/[^/]+\/[^/]+)\/pull\/\d+/)
  return m ? `${m[1]}/stack/${t.github_stack}` : null
}

/** Who restacks stack level `t` once the task below is merged. */
export const restacker = (t: Task) => (onGitHub(t) ? "GitHub" : "the board")

/** The icon of stack level `t`: stacked layers on GitHub, else an arrow up from the task below. */
export function LevelIcon({ task, size = 11, className }: { task: Task; size?: number | undefined; className?: string | undefined }) {
  return onGitHub(task) ? <Layers size={size} className={className} /> : <ArrowUpFromLine size={size} className={className} />
}

export type StackState = "none" | "open" | "restack" | "conflict" | "merged" | "closed" | "deleted"

/**
 * Where stack level `task` stands (as the server's db.stack_state): `open` while the task below isn't merged (its
 * merge waits), `restack` while the board restacks it onto where that went, `conflict` when that needs its agent,
 * `merged` once it's done, `closed`/`deleted` when the one below was closed without being merged or deleted, which holds
 * its merge until you say where it goes.
 */
export function useStackState(task: Task): { st: StackState; belowId: string | null; below: Task | undefined } {
  const belowId = stackedBelowId(task)
  const below = useBoard((s) => (belowId ? s.tasks[belowId] : undefined))
  const open = task.status !== "done"
  let st: StackState
  if (open && task.restack === "due") st = "restack"
  else if (open && task.restack === "conflict") st = "conflict"
  else if (!belowId) st = "none"
  else if (!below) st = "deleted"
  else if (isMerged(below)) st = "merged"
  else st = below.status === "done" ? "closed" : "open"
  return { st, belowId, below }
}

/**
 * What stack level `task`'s merge waits for in "Ready for merge" (rather than another merge, see mergeQueued): the task
 * below to be merged, or the board's restack of it. Null when it doesn't.
 */
export function useStackWait(task: Task, project?: Project | null): string | null {
  const on = useStacksOn(task.host_id)
  const { st, below } = useStackState(task)
  if (!on || task.status !== "ready_for_merge") return null
  const key = below ? keyOf(below, project) : "the task below"
  const by = restacker(task)
  if (st === "open")
    return `Waits for ${key}, which it ${onGitHub(task) ? "is stacked on (on GitHub)" : "lands after"}, to be merged. Then ${by} restacks it onto where that went, and it merges there.`
  if (st === "restack") return `${key} is merged: it waits for ${by} to restack it onto where that went, then merges there.`
  if (st === "conflict") return `${key} is merged, but the board couldn't restack it onto where that went: it waits for its agent to.`
  return null
}

const EMPTY: Task[] = []

/** The stack levels on each task, by its id, in number order; each list kept as it was while it's the same tasks. */
const levelsIndex = (() => {
  let tasks: Record<string, Task> | undefined
  let last: Record<string, Task[]> = {}
  return (s: StoreState) => {
    if (s.tasks === tasks) return last
    tasks = s.tasks
    const next: Record<string, Task[]> = {}
    for (const t of Object.values(tasks)) {
      const below = stackedBelowId(t)
      if (below) (next[below] ??= []).push(t)
    }
    for (const [id, list] of Object.entries(next)) {
      list.sort((a, b) => a.number - b.number)
      const before = last[id]
      if (before && before.length === list.length && before.every((t, i) => t === list[i])) next[id] = before
    }
    last = next
    return last
  }
})()

/** The stack levels on task `id`, done ones too. */
export function useLevels(id: string | null): Task[] {
  return useBoard((s) => (id ? (levelsIndex(s)[id] ?? EMPTY) : EMPTY))
}

/** The open stack levels on task `id` (as the server's db.stacked_levels). */
export function useOpenLevels(id: string | null): Task[] {
  return useBoard(useShallow((s) => (id ? (levelsIndex(s)[id] ?? EMPTY).filter((t) => t.status !== "done") : EMPTY)))
}

/** The open stack levels on task `id`, as read from the store now (for a confirm). */
export const openLevelsNow = (id: string) => (levelsIndex(board.get())[id] ?? EMPTY).filter((t) => t.status !== "done")

/**
 * On a card: the task it's stacked on on GitHub ("⧉ stacked on HA-12") or lands after ("after HA-12"), and once it's
 * in Ready for merge, that it waits for it; that it's being restacked, or couldn't be; or that the one below was closed
 * or deleted. Opens that task.
 */
export function StackedOnBadge({ task, project, compact }: { task: Task; project?: Project | undefined; compact?: boolean | undefined }) {
  const on = useStacksOn(task.host_id)
  const { st, below } = useStackState(task)
  if (!on || st === "none" || st === "merged" || task.status === "done") return null
  const key = below ? keyOf(below, project) : null
  const shortKey = below ? (
    compact ? (
      <span>
        <Wide>{keyPrefix(below, project)}-</Wide>
        {below.number}
      </span>
    ) : (
      key
    )
  ) : null
  const held = st === "closed" || st === "deleted"
  const waits = st === "open" && task.status === "ready_for_merge"
  const label =
    st === "restack" ? (
      "restacking"
    ) : st === "conflict" ? (
      "restack conflict"
    ) : st === "deleted" ? (
      "below deleted"
    ) : st === "closed" ? (
      <>{shortKey} closed</>
    ) : waits ? (
      <>waits for {shortKey}</>
    ) : onGitHub(task) ? (
      <>stacked on {shortKey}</>
    ) : (
      <>after {shortKey}</>
    )
  const title =
    st === "restack"
      ? `${key ?? "The task below"} is merged: ${restacker(task)} is restacking this onto where it went`
      : st === "conflict"
        ? `${key ?? "The task below"} is merged, but the board couldn't restack this onto where it went: its agent is asked to`
        : st === "deleted"
          ? "The task this landed after was deleted: its merge waits until you choose where it goes now (in its sidebar)"
          : st === "closed"
            ? `${key} (${below?.title}), which this lands after, was closed without being merged: its merge waits until you choose where it goes now (in its sidebar)`
            : onGitHub(task)
              ? `Stacked on ${key} (${below?.title}) on GitHub: its pull request is in a GitHub stack with ${key}'s, and it merges after it${waits ? ", which it waits for" : ""}. Once ${key} is merged, GitHub restacks it.`
              : `Lands after ${key} (${below?.title}): its pull request targets that branch, and it merges after ${key}${waits ? ", which it waits for" : ""}. It's an ordinary pull request, not in a stack on GitHub: the board restacks it once ${key} is merged.`
  return (
    <button
      type="button"
      className={clsx(compact ? CARD_BADGE : "flex items-center gap-1", "hover:underline", held || st === "conflict" ? "text-st-attention" : "text-muted")}
      title={title}
      onClick={(e) => {
        e.stopPropagation()
        if (below) openTask(below.id)
      }}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <LevelIcon task={task} /> {label}
    </button>
  )
}

/**
 * On the card of a task others land after: how many ("2 stacked" when they're all in a stack on GitHub with it, else
 * "2 after"), each with where it stands in its title.
 */
export function LevelsBadge({ task, project, compact }: { task: Task; project?: Project | undefined; compact?: boolean | undefined }) {
  const on = useStacksOn(task.host_id)
  const levels = useOpenLevels(task.id)
  if (!on || !levels.length || task.status === "done") return null
  const stacked = levels.every(onGitHub)
  const title = `Landing after this task:\n${levels
    .map((t) => `${keyOf(t, project)} ${t.title} (${statusLabel(t)}${onGitHub(t) ? ", stacked on it on GitHub" : ""})`)
    .join("\n")}`
  const word = stacked ? " stacked" : " after"
  return (
    <span className={clsx(compact ? CARD_BADGE : "flex items-center gap-1", "text-muted")} title={title}>
      {stacked ? <Layers size={11} className="rotate-180" /> : <ArrowUpFromLine size={11} className="rotate-180" />} {levels.length}
      {compact ? <Wide>{word}</Wide> : word}
    </span>
  )
}

/** The title of the task view's section on the task stack level `task` lands after. */
export const stackedOnTitle = (task: Task) => (onGitHub(task) ? "Stacked on" : "Lands after")

/** The title of the task view's section on the levels that land after it. */
export const levelsTitle = (levels: Task[]) => (levels.length && levels.every(onGitHub) ? "Stacked on this" : "Landing after this")

/**
 * A task's row in the task view's lists of the tasks linked to it (stack levels, tasks merging into it): its status,
 * key and title, and "merged" once it is. Opens the task. `icon` goes before "merged", the children after it.
 */
export function LinkedTaskRow({
  task: t,
  project,
  icon,
  children,
}: {
  task: Task
  project?: Project | null | undefined
  icon?: ReactNode | undefined
  children?: ReactNode | undefined
}) {
  return (
    <button
      className="group flex w-full items-center gap-2 rounded-md px-1 py-1 text-left text-[12.5px] hover:bg-white/[0.03]"
      onClick={() => openTask(t.id)}
      title={statusLabel(t)}
    >
      <StatusIcon status={t.status} size={13} />
      <span className="shrink-0 font-mono text-[11.5px] text-faint">{keyOf(t, project)}</span>
      <span className="min-w-0 flex-1 truncate text-muted group-hover:text-fg">{t.title}</span>
      {icon}
      {isMerged(t) && <span className="shrink-0 text-[11px] text-st-done">merged</span>}
      {children}
    </button>
  )
}
