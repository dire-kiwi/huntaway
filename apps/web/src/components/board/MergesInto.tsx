// "Merges into" (API 133, HA-295): a task whose work merges into another task's branch instead of the project's base
// branch. Its card says where it goes, the other's card how many of those merging into it are merged, and the task view
// picks it, lists them, and asks where they go once the one they merge into is closed without being merged, or deleted.
import { clsx } from "clsx"
import { GitMerge } from "lucide-react"
import { useState, type ReactNode } from "react"
import { useShallow, type State } from "../boardHelpers"
import { documentsOnly, isMerged, isScratch, keyPrefix, STATUSES, type HostProject as Project, type HostTask as Task } from "@huntaway/client"
import { TaskId } from "@huntaway/contracts"
import { openTask } from "../../state/route"

import { Button, CARD_BADGE, ProgressCount, Wide } from "../ui"
import { LinkedTaskRow, stackedBelowId, useOpenLevels, useStackState, useStacksOn } from "./StackedOn"
import { board, useBoard } from "../../state/board"
import { useMutation } from "../../state/mutation"

type StoreState = State

const keyOf = (t: Task, project?: Project | null) => `${keyPrefix(t, project ?? undefined)}-${t.number}`
const statusLabel = (t: Task) => (isMerged(t) ? "merged" : t.status === "done" ? "closed" : (STATUSES.find((s) => s.id === t.status)?.label ?? t.status))

/** Whether the task's host takes merges_into: every host on this server does. */
export function useMergesIntoOn(_hostId: string | undefined): boolean {
  return true
}

/**
 * The first task the task's work goes to that isn't merged (as the server's db.first_target): what it merges into, or
 * past that once it's merged, what that merges into, and so on. Null when it merges into none, or they're all merged.
 */
export function firstTargetId(task: Task, tasks: Record<string, Task>): string | null {
  let at = task
  for (let i = 0; i < 16 && at.merges_into; i++) {
    const target = tasks[at.merges_into]
    if (!target || !isMerged(target)) return at.merges_into
    at = target
  }
  return null
}

type TargetState = "none" | "open" | "merged" | "closed" | "deleted"

/**
 * Where the task it merges into stands, past those merged since (as the server's db.target_state): `open` while the first
 * that isn't merged is still to be, `merged` once they all are, `closed` when that one's done without being merged and
 * `deleted` once it's gone. The last two hold its merge until the user says where it goes; `goneId`/`gone` is that one.
 */
export function useTargetState(task: Task): { st: TargetState; goneId: string | null; gone: Task | undefined } {
  const goneId = useBoard((s) => (task.merges_into ? firstTargetId(task, s.tasks) : null))
  const gone = useBoard((s) => (goneId ? s.tasks[goneId] : undefined))
  const st: TargetState = !task.merges_into ? "none" : !goneId ? "merged" : !gone ? "deleted" : gone.status === "done" ? "closed" : "open"
  return { st, goneId, gone }
}

const EMPTY: Task[] = []

/** The tasks merging into each task, by its id, in number order; each list kept as it was while it's the same tasks. */
const incomingIndex = (() => {
  let tasks: Record<string, Task> | undefined
  let last: Record<string, Task[]> = {}
  return (s: StoreState) => {
    if (s.tasks === tasks) return last
    tasks = s.tasks
    const next: Record<string, Task[]> = {}
    for (const t of Object.values(tasks)) if (t.kind === "task" && t.merges_into) (next[t.merges_into] ??= []).push(t)
    for (const [id, list] of Object.entries(next)) {
      list.sort((a, b) => a.number - b.number)
      const before = last[id]
      if (before && before.length === list.length && before.every((t, i) => t === list[i])) next[id] = before
    }
    last = next
    return last
  }
})()

/** The tasks that merge into task `id`, done ones too. */
export function useIncoming(id: string): Task[] {
  return useBoard((s) => incomingIndex(s)[id] ?? EMPTY)
}

/**
 * The open tasks whose work goes to task `id` (as the server's db.reaching): those merging into it that aren't done, and
 * those merging into one of its merged ones, and so on.
 */
function reachingOf(id: string, s: StoreState): Task[] {
  const index = incomingIndex(s)
  const out: Task[] = []
  const seen = new Set([id])
  const walk = (to: string, depth: number) => {
    if (depth > 16) return
    for (const t of index[to] ?? EMPTY) {
      if (seen.has(t.id)) continue
      seen.add(t.id)
      if (t.status !== "done") out.push(t)
      else if (isMerged(t)) walk(t.id, depth + 1)
    }
  }
  walk(id, 0)
  return out
}

/** The open tasks whose work goes to task `id` (see reachingOf). */
export function useReaching(id: string | null): Task[] {
  return useBoard(useShallow((s) => (id ? reachingOf(id, s) : EMPTY)))
}

/** The open tasks whose work goes to task `id`, as read from the store now (for a confirm). */
export const openIncomingNow = (id: string) => reachingOf(id, board.get())

/** "HA-3", "HA-3 and HA-4", "HA-3, HA-4 and HA-5". */
export function keyList(tasks: Task[], project?: Project | null) {
  const keys = tasks.map((t) => keyOf(t, project))
  return keys.length > 1 ? `${keys.slice(0, -1).join(", ")} and ${keys[keys.length - 1]}` : (keys[0] ?? "")
}

/** On a card: the task it merges into ("→ HA-12"), that it's merged into it, or that its merge waits as that one was closed or deleted. Opens that task. */
export function MergesIntoBadge({ task, project, compact }: { task: Task; project?: Project | undefined; compact?: boolean | undefined }) {
  const on = useMergesIntoOn(task.host_id)
  const target = useBoard((s) => (task.merges_into ? s.tasks[task.merges_into] : undefined))
  const { st, gone } = useTargetState(task)
  if (!on || !task.merges_into) return null
  const merged = task.status === "done" && isMerged(task)
  // Closed itself, it isn't going anywhere.
  if (task.status === "done" && !merged) return null
  const held = !merged && (st === "closed" || st === "deleted")
  const key = target ? keyOf(target, project) : null
  // "HA-12", or "12" on a narrow card.
  const shortKey = target ? (
    compact ? (
      <span>
        <Wide>{keyPrefix(target, project)}-</Wide>
        {target.number}
      </span>
    ) : (
      key
    )
  ) : null
  const label = merged ? (
    <>
      {compact ? <Wide>merged into </Wide> : "merged into "}
      {shortKey ?? "a deleted task"}
    </>
  ) : held ? (
    st === "deleted" ? (
      "target deleted"
    ) : (
      // The one that holds it: what it merges into, or one past it that that was merged into.
      <>{gone && gone !== target ? keyOf(gone, project) : shortKey} closed</>
    )
  ) : (
    <>→ {shortKey}</>
  )
  const title = merged
    ? `Merged into ${key ?? "a task that's since been deleted"}${target ? ` (${target.title})` : ""}`
    : held
      ? st === "deleted"
        ? "The task this one merges into was deleted: its merge waits until you choose where it goes now (in its sidebar)"
        : `${gone ? `${keyOf(gone, project)} (${gone.title})` : key}, which this merges into${gone && gone !== target ? ` by way of ${key}` : ""}, was closed without being merged: its merge waits until you choose where it goes now (in its sidebar)`
      : st === "merged"
        ? `Merges into ${key} (${target?.title}), which is merged: it goes where that went`
        : `Merges into ${key}'s branch (${target?.title}) rather than the base branch`
  return (
    <button
      type="button"
      className={clsx(compact ? CARD_BADGE : "flex items-center gap-1", "hover:underline", merged ? "text-st-done" : held ? "text-st-attention" : "text-muted")}
      title={title}
      onClick={(e) => {
        e.stopPropagation()
        if (target) openTask(target.id)
      }}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <GitMerge size={11} /> {label}
    </button>
  )
}

/** On the card of a task others merge into: how many of them are merged ("2/3 merged"), each with where it stands in its title. */
export function IncomingBadge({ task, project, compact }: { task: Task; project?: Project | undefined; compact?: boolean | undefined }) {
  const on = useMergesIntoOn(task.host_id)
  const incoming = useIncoming(task.id)
  if (!on || !incoming.length) return null
  const progress = { done: incoming.filter(isMerged).length, total: incoming.length }
  const all = progress.done === progress.total
  const title = `Merging into this task's branch:\n${incoming.map((t) => `${keyOf(t, project)} ${t.title} (${statusLabel(t)})`).join("\n")}`
  return (
    <span className={clsx(compact ? CARD_BADGE : "flex items-center gap-1", all ? "text-st-done" : "text-muted")} title={title}>
      <GitMerge size={11} className="rotate-180" />{" "}
      {compact ? (
        <ProgressCount progress={progress} word="merged" />
      ) : (
        <span>
          {progress.done}/{progress.total} merged
        </span>
      )}
    </span>
  )
}

/**
 * The tasks task `task` can merge into (as the server's check_merges_into): code tasks in its project with a branch of
 * their own (or a worktree to make one), not itself, not done, and none that merges into it or builds
 * on it, directly or through others. Newest first.
 */
export function useTargets(task: Task): Task[] {
  return useBoard(
    useShallow((s) => {
      // What leads back to it can't be one.
      const leadsBack = (t: Task) => {
        const seen = new Set<string>([t.id])
        const stack = [t]
        while (stack.length) {
          const next = stack.pop()
          if (!next) break
          for (const id of [next.merges_into, next.start_from?.type === "task" ? next.start_from.task_id : null, next.parent_id]) {
            if (!id) continue
            if (id === task.id) return true
            if (seen.has(id)) continue
            seen.add(id)
            const n = s.tasks[id]
            if (n) stack.push(n)
          }
        }
        return false
      }
      return Object.values(s.tasks)
        .filter(
          (t) =>
            t.kind === "task" &&
            t.host_id === task.host_id &&
            t.project_id === task.project_id &&
            t.id !== task.id &&
            t.status !== "done" &&
            !isScratch(t) &&
            !documentsOnly(t) &&
            (t.use_worktree || !!t.branch) &&
            !leadsBack(t),
        )
        .toSorted((a, b) => b.number - a.number)
    }),
  )
}

const selectClass = "h-7 w-full rounded-md border border-line bg-panel px-2 text-[12px] text-muted outline-none disabled:opacity-60"
const errBox = "rounded bg-red-500/10 p-2 text-[11.5px] whitespace-pre-wrap text-red-300"

/** The task view's "Merges into": what its work merges into, picked until it's merging or done, and the choice its merge waits on once that's closed or deleted. */
export function MergesIntoSection({ task, project }: { task: Task; project?: Project | null | undefined }) {
  const target = useBoard((s) => (task.merges_into ? s.tasks[task.merges_into] : undefined))
  const targets = useTargets(task)
  const [{ error }, update] = useMutation("tasks.update")
  const err = error === null ? null : `Couldn't change what it merges into: ${error}`
  const { st, goneId, gone } = useTargetState(task)
  const fixed = task.status === "done" || task.merging
  const save = (id: string) => void update(task.host_id, { id: task.id, patch: { merges_into: id ? TaskId.make(id) : null } })
  const base = project?.base_branch || "base branch"
  return (
    <div className="space-y-2">
      {fixed ? (
        <div className="text-[12.5px] text-muted">
          {target ? (
            <button className="group text-left" onClick={() => openTask(target.id)}>
              {isMerged(task) ? "Merged into " : "Merges into "}
              <span className="font-mono text-[11.5px] text-faint">{keyOf(target, project)}</span>{" "}
              <span className="text-fg group-hover:underline">{target.title}</span>
            </button>
          ) : task.merges_into ? (
            "Merges into a task that's since been deleted."
          ) : (
            `Merges into the ${base}.`
          )}
          {task.merging && task.status !== "done" && (
            <div className="mt-1 text-[12px] text-faint">It's merging: move it out of Ready for merge to change this.</div>
          )}
        </div>
      ) : (
        <select
          aria-label="Merges into"
          value={task.merges_into ?? ""}
          onChange={(e) => save(e.target.value)}
          className={selectClass}
          title="The task whose branch this task's work merges into: its worktree starts from that branch, its pull request targets it, and Ready for merge merges it there"
        >
          <option value="">None ({base})</option>
          {/* What it merges into now, if it's not one it could pick (closed, deleted). */}
          {task.merges_into && !targets.some((t) => t.id === task.merges_into) && (
            <option value={task.merges_into}>{target ? `${keyOf(target, project)} ${target.title} (${statusLabel(target)})` : "A deleted task"}</option>
          )}
          {targets.map((t) => (
            <option key={t.id} value={t.id}>
              {keyOf(t, project)} {t.title}
            </option>
          ))}
        </select>
      )}
      {!fixed && st === "merged" && target && <div className="text-[12px] text-faint">{keyOf(target, project)} is merged, so this goes where that went.</div>}
      {(st === "closed" || st === "deleted") && task.status !== "done" && goneId && (
        <HeldChoice hostId={task.host_id} goneId={goneId} gone={gone} project={project} />
      )}
      {err && <div className={errBox}>{err}</div>}
    </div>
  )
}

/** The task view's list of the tasks merging into it, done ones too; and once it's closed without being merged, where the open ones go now. */
export function IncomingSection({ task, project }: { task: Task; project?: Project | null | undefined }) {
  const incoming = useIncoming(task.id)
  const open = incoming.filter((t) => t.status !== "done")
  const closed = task.status === "done" && !isMerged(task)
  return (
    <div className="space-y-2">
      <ul className="space-y-0.5">
        {incoming.map((t) => (
          <li key={t.id}>
            <LinkedTaskRow task={t} project={project} />
          </li>
        ))}
      </ul>
      {!closed && open.length > 0 && (
        <div className="text-[12px] text-faint">
          {task.status === "done" ? "They go where this went." : "They merge into this task's branch, and go where it goes once it's merged."}
        </div>
      )}
      {closed && <HeldChoice hostId={task.host_id} goneId={task.id} gone={task} project={project} />}
    </div>
  )
}

/**
 * The thread, with the choice of where the task merges now above it while its merge is held (the task it merges into
 * was closed without being merged, or deleted): its card's reason sends you here.
 */
export function WithHeldChoice({ task, project, children }: { task: Task; project?: Project | null | undefined; children: ReactNode }) {
  const on = useMergesIntoOn(task.host_id)
  const stacksOn = useStacksOn(task.host_id)
  const target = useTargetState(task)
  // A stack level whose level below was closed or deleted (API 142) is held the same way.
  const stack = useStackState(task)
  const byTarget = target.st === "closed" || target.st === "deleted"
  const byStack = stacksOn && (stack.st === "closed" || stack.st === "deleted")
  const goneId = byTarget ? target.goneId : byStack ? stack.belowId : null
  if (!on || task.status === "done" || !goneId) return children
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mx-auto w-full max-w-3xl shrink-0 px-5 pt-4 narrow:px-3">
        <HeldChoice hostId={task.host_id} goneId={goneId} gone={byTarget ? target.gone : stack.below} project={project} stacked={!byTarget} />
      </div>
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  )
}

/**
 * Where the open tasks merging into `gone` (closed without being merged, or deleted: `goneId` with no `gone`) go now,
 * for all of them at once: where it was going, one of them in its place, or closed too. With `stacked`, the open stack
 * levels on it (API 142), which the board restacks there without its commits.
 */
export function HeldChoice({
  hostId,
  goneId,
  gone,
  project,
  stacked = false,
}: {
  hostId: string
  goneId: string
  gone: Task | undefined
  project?: Project | null | undefined
  stacked?: boolean | undefined
}) {
  // Those merging into its merged ones too (see db.reaching), as the server applies the choice to them all.
  const reaching = useReaching(stacked ? null : goneId)
  const levels = useOpenLevels(stacked ? goneId : null)
  const siblings = stacked ? levels : reaching
  // A stack level goes on to the open level below it, if it has one.
  const belowId = stacked && gone ? stackedBelowId(gone) : null
  const under = useBoard((s) => (belowId ? s.tasks[belowId] : undefined))
  const into = useBoard((s) => (gone?.merges_into ? s.tasks[gone.merges_into] : undefined))
  const onward = under && under.status !== "done" ? under : into
  const [heir, setHeir] = useState("")
  const [{ busy, error: err }, mergeTarget] = useMutation("tasks.mergeTarget")
  if (!siblings.length) return null
  const goneKey = gone ? keyOf(gone, project) : null
  const base = project?.base_branch || "the base branch"
  // Where it was going: what it merged into while that's open, else the base branch.
  const onwardTo = onward && onward.status !== "done" ? keyOf(onward, project) : base
  const choose = (to: string) => {
    // The tasks it changed come back as events.
    const first = siblings[0]
    if (first) void mergeTarget(hostId, { id: TaskId.make(first.id), to })
  }
  const them = siblings.length === 1 ? "it" : `them (${keyList(siblings, project)})`
  const pick = siblings.find((t) => t.id === heir) ?? null
  return (
    <div
      className="space-y-2 rounded-md border border-st-attention/30 bg-st-attention/[0.08] px-2.5 py-2 text-[12px] text-amber-200/90"
      role="group"
      aria-label="Where they merge now"
    >
      <div>
        {goneKey ? `${goneKey} was closed without being merged` : `The task they ${stacked ? "land after" : "merge into"} was deleted`}, so{" "}
        {siblings.length === 1 && siblings[0] ? `${keyOf(siblings[0], project)}'s merge waits` : `the merges of ${keyList(siblings, project)} wait`}. Choose
        where {siblings.length === 1 ? "it goes" : "they all go"} now.
        {stacked ? (
          <span className="text-amber-200/70"> The board restacks {siblings.length === 1 ? "its branch" : "their branches"} there, without its commits.</span>
        ) : (
          goneKey && (
            <span className="text-amber-200/70">
              {" "}
              A branch that started from {goneKey}'s may still have its commits: its next merge asks you whether to keep them.
            </span>
          )
        )}
      </div>
      <div className="flex flex-col items-start gap-1.5">
        <Button size="sm" disabled={busy} onClick={() => choose("onward")}>
          {goneKey ? `Go where ${goneKey} was going (${onwardTo})` : `Merge into ${base} instead`}
        </Button>
        {siblings.length > 1 && (
          <div className="flex w-full items-center gap-1.5">
            <select aria-label="The new target" value={heir} onChange={(e) => setHeir(e.target.value)} className={clsx(selectClass, "min-w-0 flex-1")}>
              <option value="">Pick one of them…</option>
              {siblings.map((t) => (
                <option key={t.id} value={t.id}>
                  {keyOf(t, project)} {t.title}
                </option>
              ))}
            </select>
            <Button
              size="sm"
              disabled={busy || !pick}
              onClick={() => pick && choose(pick.id)}
              title={stacked ? "It takes the closed task's place: the others land after it" : "It takes the closed task's place: the others merge into it"}
            >
              {stacked ? "Put the others after it" : "Make it the new target"}
            </Button>
          </div>
        )}
        <Button size="sm" variant="danger" disabled={busy} onClick={() => choose("close")}>
          Close {them} too
        </Button>
      </div>
      {err && <div className={errBox}>{err}</div>}
    </div>
  )
}
