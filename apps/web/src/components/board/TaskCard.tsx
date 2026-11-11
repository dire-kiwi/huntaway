import { clsx } from "clsx"
import { Clock, Ellipsis, Folder, GitMerge, Hourglass, ShieldQuestionMark } from "lucide-react"
import { memo, type KeyboardEvent, type MouseEvent, type ReactNode } from "react"
import {
  agentWaiting,
  isScratch,
  keyPrefix,
  limitQueued,
  mergeAwaitsApproval,
  mergeQueued,
  rejoinsMerge,
  taskLabels,
  type HostProject as Project,
  type HostTask as Task,
} from "@huntaway/client"
import type { Todo as TaskTodo } from "@huntaway/contracts"
import { inGroupTaskGroup } from "../../projectGroups"
import { openTask, usePanelOpen } from "../../state/route"
import { useSelectable } from "../../selection"
import { isGroupTask, type State } from "../boardHelpers"
import { withKeys } from "./ConfirmTodos"
import { DependencyBadge } from "./Dependencies"
import { FanoutBadge } from "./Fanout"
import { IncomingBadge, MergesIntoBadge } from "./MergesInto"
import { LevelsBadge, StackedOnBadge, useStackWait } from "./StackedOn"
import { TaskMarks } from "../task/Reminders"
import { TaskTypeBadge } from "../task/documentInfo"
import { AgentIcon } from "../ui/AgentIcon"
import {
  ActivityTime,
  BranchIcon,
  CARD_BADGE,
  CardState,
  ChecksMark,
  cost,
  PrIcon,
  PreviewDot,
  ProgressCount,
  ResolutionBadge,
  RunState,
  showsPreview,
  StatusIcon,
  useClock,
  WaitReason,
  Wide,
} from "../ui"
import { useNarrow, useTouch } from "../../narrow"
import { resetsIn, resetTime } from "../ui/usageConfigs"
import { useBoard } from "../../state/board"

/** How many of the tasks a group task or a plan created are done. */
export type Progress = { done: number; total: number }

type StoreState = State

/**
 * A store selector of progress by id, worked out again only when the tasks or projects change, which
 * keeps each progress object that's the same as before (and the record, when they all are): a task
 * event doesn't redraw the memoized cards whose progress it leaves be, or what shows none of it.
 */
function progressSelector(compute: (tasks: Readonly<Record<string, Task>>, projects: ReadonlyArray<Project>) => Record<string, Progress>) {
  let tasks: Readonly<Record<string, Task>> | undefined
  let projects: ReadonlyArray<Project> | undefined
  let last: Record<string, Progress> = {}
  return (s: StoreState) => {
    if (s.tasks === tasks && s.projects === projects) return last
    tasks = s.tasks
    projects = s.projects
    const next = compute(tasks, projects)
    let same = Object.keys(next).length === Object.keys(last).length
    for (const [id, p] of Object.entries(next)) {
      const before = last[id]
      if (before && before.done === p.done && before.total === p.total) next[id] = before
      else same = false
    }
    if (!same) last = next
    return last
  }
}

const createdProgress = progressSelector((all, projects) => {
  const by: Record<string, Progress> = {}
  for (const t of Object.values(all)) {
    if (t.kind !== "task" || !t.created_by) continue
    const creator = all[t.created_by]
    if (!creator || !(isGroupTask(creator) ? inGroupTaskGroup(t, creator, projects) : taskLabels(creator).includes("plan"))) continue
    const p = (by[t.created_by] ??= { done: 0, total: 0 })
    p.total++
    if (t.status === "done") p.done++
  }
  return by
})

/**
 * How many of the tasks each group task's agent created in the group's projects are done, by
 * the group task's id; and for a plan in a project, of the tasks its agent broke it into.
 */
export function useCreatedProgress(): Record<string, Progress> {
  return useBoard(createdProgress)
}

export function GroupTaskBadge({ progress, compact }: { progress?: Progress | undefined; compact?: boolean | undefined }) {
  if (compact)
    return (
      <span
        className={clsx(CARD_BADGE, "text-accent")}
        title={`Group task: plans the work of the group's projects and creates their tasks${progress?.total ? ` (${progress.done} of ${progress.total} done)` : ""}`}
      >
        <Folder size={11} /> {progress?.total ? <ProgressCount progress={progress} /> : <Wide>group task</Wide>}
      </span>
    )
  return (
    <span className="flex items-center gap-1 text-accent" title="Group task: plans the work of the group's projects and creates their tasks">
      <Folder size={11} /> {progress?.total ? `${progress.done}/${progress.total} done` : "group task"}
    </span>
  )
}

/** A scratch task's badge, and its labels': a plan's with how the tasks it created are doing (`progress`, which a group
 *  task shows on its own badge). */
function TypeBadges({ task, progress, compact }: { task: Task; progress?: Progress | undefined; compact?: boolean | undefined }) {
  const ownProgress = isGroupTask(task) ? undefined : progress
  return (
    <>
      {isScratch(task) && <TaskTypeBadge type="scratch" compact={compact} />}
      {taskLabels(task).map((l) => (
        <TaskTypeBadge key={l} type={l} progress={l === "plan" ? ownProgress : undefined} compact={compact} />
      ))}
    </>
  )
}

/**
 * What kind of task it is and where it stands, on a card (`compact`: icons, with their words once the card has room) or
 * a list row: a group task's progress, its type and labels, the merge queue, what it waits on, what it
 * merges into and what merges into it, its fan-out and its review.
 */
function TaskBadges({
  task,
  project,
  progress,
  compact,
}: {
  task: Task
  project?: Project | undefined
  progress?: Progress | undefined
  compact?: boolean | undefined
}) {
  const badge = compact ? clsx(CARD_BADGE, "text-muted") : "flex items-center gap-1 text-muted"
  const words = (text: string) => (compact ? <Wide>{text}</Wide> : text)
  // A stack level waits for the one below it instead (its own badge says so).
  const stackWait = useStackWait(task, project)
  return (
    <>
      {isGroupTask(task) && <GroupTaskBadge progress={progress} compact={compact} />}
      <TypeBadges task={task} progress={progress} compact={compact} />
      {mergeQueued(task) && !stackWait && (
        <span className={badge} title="Queued to merge: waits for the merge in progress in this project">
          <Clock size={11} /> {words("queued to merge")}
        </span>
      )}
      {mergeAwaitsApproval(task) && (
        <span className={badge} title="The merge waits for your approval: its agent summarizes what will be merged, then you approve or deny it in its thread">
          <ShieldQuestionMark size={11} /> {words("merge needs approval")}
        </span>
      )}
      {rejoinsMerge(task) && (
        <span className={badge} title="Stepped out of the merge queue to make changes: rejoins it when its agent is done">
          <GitMerge size={11} /> {words("rejoins merge queue")}
        </span>
      )}
      {limitQueued(task) && task.limit_reset_at && <LimitBadge at={task.limit_reset_at} className={badge} words={words} />}
      <DependencyBadge task={task} project={project} compact={compact} />
      <MergesIntoBadge task={task} project={project} compact={compact} />
      <IncomingBadge task={task} project={project} compact={compact} />
      <StackedOnBadge task={task} project={project} compact={compact} />
      <LevelsBadge task={task} project={project} compact={compact} />
      {task.fanout_id && <FanoutBadge task={task} />}
      {/* Its review (task/Review) comes with reviews on this server. */}
    </>
  )
}

/** Opens a task's menu at a right-click, or with `move` from its menu button (which moves it to another column). */
export type OnMenu = (e: MouseEvent, task: Task, move?: boolean) => void

/** `onMenu` decides whether to replace the browser's menu (preventDefault). */
const menuHandler = (task: Task, onMenu?: OnMenu) => onMenu && ((e: MouseEvent) => onMenu(e, task))

/**
 * The button that opens a task's menu to move it to another column: what dragging it does, where that doesn't work. On
 * phones and touch screens only.
 */
function MoveButton({ task, onMenu, className }: { task: Task; onMenu?: OnMenu | undefined; className?: string | undefined }) {
  const narrow = useNarrow()
  const touch = useTouch()
  if (!onMenu || !(narrow || touch)) return null
  return (
    <button
      title="Move to…"
      aria-label={`Move ${task.title} to…`}
      aria-haspopup="menu"
      className={clsx("flex shrink-0 items-center justify-center rounded-md text-faint hover:bg-white/5 hover:text-fg", className)}
      onClick={(e) => {
        e.stopPropagation()
        onMenu(e, task, true)
      }}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <Ellipsis size={16} />
    </button>
  )
}

/** A card or row that opens its task: a button to the keyboard and screen readers too (Enter or Space opens it). */
const opensTask = (task: Task, open: boolean) => ({
  role: "button",
  tabIndex: 0,
  "aria-current": open || undefined,
  onClick: () => openTask(task.id),
  onKeyDown: (e: KeyboardEvent) => {
    // Not a key pressed on a button inside it.
    if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return
    e.preventDefault()
    openTask(task.id)
  },
})

// Memoized, like TaskRow: a task's change redraws its own card, not every card on the board.
/** Waiting for its config's usage limit to reset at `at`, and how long that is from now (by the second). */
function LimitBadge({ at, className, words }: { at: string; className: string; words: (text: string) => ReactNode }) {
  const now = useClock(1000)
  return (
    <span className={className} title={`Waiting for its config's usage limit to reset (${resetTime(at)}); its agent carries on then`}>
      <Hourglass size={11} /> {words("usage resets")} {resetsIn(at, now)}
    </span>
  )
}

/** How many of its agent's todos a card lists; the rest are counted. */
const CARD_TODOS = 5

/** The agent's todo list (HA-316), as the thread shows a todo call's: its first few items, and how many more it has. */
function CardTodos({ todos }: { todos: ReadonlyArray<TaskTodo> }) {
  const more = todos.length - CARD_TODOS
  return (
    <ul className="mt-2 space-y-0.5 text-[12px] leading-snug" aria-label="Todo list">
      {withKeys(todos.slice(0, CARD_TODOS)).map(({ item: t, key }) => (
        <li
          key={key}
          className={clsx("flex gap-1.5", t.status === "completed" ? "text-faint line-through" : t.status === "in_progress" ? "text-fg" : "text-muted")}
        >
          <span className="shrink-0">{t.status === "completed" ? "✓" : t.status === "in_progress" ? "◐" : "○"}</span>
          <span className="truncate">{t.text}</span>
        </li>
      ))}
      {more > 0 && (
        <li className="text-faint">
          ({more} more item{more === 1 ? "" : "s"})
        </li>
      )}
    </ul>
  )
}

export const TaskCard = memo(function TaskCard({
  task,
  project,
  progress,
  draggable = true,
  onMenu,
}: {
  task: Task
  project?: Project | undefined
  progress?: Progress | undefined
  draggable?: boolean | undefined
  onMenu?: OnMenu | undefined
}) {
  const open = usePanelOpen(task.id)
  const wait = agentWaiting(task)
  const selectable = useSelectable(task.id)
  return (
    <div
      draggable={draggable}
      onDragStart={(e) => {
        e.dataTransfer.setData("text/task-id", task.id)
        e.dataTransfer.effectAllowed = "move"
      }}
      {...opensTask(task, open)}
      onContextMenu={menuHandler(task, onMenu)}
      {...selectable}
      className={clsx(
        "group @container relative cursor-pointer overflow-hidden rounded-lg border bg-panel-2 p-3 transition-colors outline-none hover:border-line-strong hover:bg-raised focus-visible:ring-1 focus-visible:ring-accent",
        task.status === "needs_attention" ? "border-st-attention/35" : task.review?.state === "running" ? "border-st-review/40" : "border-line",
        open && "bg-raised ring-1 ring-accent/60",
      )}
    >
      {/* One line that never wraps: the key and the state stay whole, and badges that don't fit are cut off. */}
      <div className="mb-1 flex items-center gap-2 text-[11px] text-faint">
        <span className="flex shrink-0 items-center gap-1 font-mono">
          <AgentIcon task={task} size={11} />
          {keyPrefix(task, project)}-{task.number}
        </span>
        <div className="flex min-w-0 items-center gap-2 overflow-hidden">
          <TaskBadges task={task} project={project} progress={progress} compact />
          <TaskMarks task={task} compact />
        </div>
        <CardState task={task} />
        <MoveButton task={task} onMenu={onMenu} className="-my-2.5 -mr-2 h-8 w-8" />
      </div>
      <div className={clsx("text-[13px] leading-snug", task.status === "done" && task.resolution === "wont_fix" ? "text-muted" : "text-fg")}>{task.title}</div>
      {task.attention_reason && task.status === "needs_attention" && (
        <div className="mt-2 rounded-md bg-st-attention/[0.08] px-2 py-1.5 text-[12px] leading-snug text-amber-200/90">
          <div className="line-clamp-3">{task.attention_reason}</div>
        </div>
      )}
      {wait && <WaitReason wait={wait} className="mt-1 line-clamp-2 text-[12px] leading-snug text-muted" />}
      {!!task.todos?.length && <CardTodos todos={task.todos} />}
      {(task.branch || task.pr_url || task.cost_usd > 0 || showsPreview(task)) && (
        <div className="mt-2 flex items-center gap-2 text-[11px] text-faint">
          {showsPreview(task) && task.preview_url && <PreviewDot url={task.preview_url} host={task.host_id} label />}
          {task.branch && <BranchIcon branch={task.branch} className={task.worktree_state === "ready" ? "text-muted" : ""} />}
          {task.pr_url && <PrIcon url={task.pr_url} className="text-muted" />}
          <ChecksMark task={task} />
          {/* Its Asana links (task/ExternalLinks) come with Asana on this server. */}
          {cost(task.cost_usd) && <span className="ml-auto shrink-0">{cost(task.cost_usd)}</span>}
        </div>
      )}
      {/* How much of a plan's or group task's work is done, along the bottom edge. */}
      {!!progress?.total && (
        <div className="absolute inset-x-0 bottom-0 h-[3px] bg-line" title={`${progress.done} of ${progress.total} tasks done`}>
          <div
            className={clsx("h-full", progress.done === progress.total ? "bg-st-done" : "bg-accent")}
            style={{ width: `${(100 * progress.done) / progress.total}%` }}
          />
        </div>
      )}
    </div>
  )
})

export const TaskRow = memo(function TaskRow({
  task,
  project,
  progress,
  onMenu,
}: {
  task: Task
  project?: Project | undefined
  progress?: Progress | undefined
  onMenu?: OnMenu | undefined
}) {
  const open = usePanelOpen(task.id)
  const wait = agentWaiting(task)
  const selectable = useSelectable(task.id)
  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("text/task-id", task.id)
        e.dataTransfer.effectAllowed = "move"
      }}
      {...opensTask(task, open)}
      onContextMenu={menuHandler(task, onMenu)}
      {...selectable}
      className={clsx(
        "flex cursor-pointer items-start gap-3 px-4 py-2.5 transition-colors outline-none hover:bg-raised focus-visible:ring-1 focus-visible:ring-accent focus-visible:ring-inset narrow:flex-wrap narrow:gap-x-2 narrow:px-3",
        open ? "bg-raised shadow-[inset_2px_0_0_var(--color-accent)]" : "bg-panel/60",
      )}
    >
      <span className="pt-0.5">
        <StatusIcon status={task.status} />
      </span>
      <span className="w-14 shrink-0 pt-px font-mono text-[11.5px] text-faint narrow:w-auto">
        {keyPrefix(task, project)}-{task.number}
      </span>
      <div className="min-w-0 flex-1 narrow:order-last narrow:basis-full narrow:pl-[22px]">
        <div className="truncate text-[13px] text-fg narrow:line-clamp-2 narrow:whitespace-normal">{task.title}</div>
        {task.attention_reason && task.status === "needs_attention" && (
          <div className="mt-0.5 line-clamp-2 text-[12px] text-amber-200/80">{task.attention_reason}</div>
        )}
        {wait && <WaitReason wait={wait} className="mt-0.5 truncate text-[12px] text-muted" />}
      </div>
      {/* On a phone, the title goes on a line of its own under these. */}
      <div className="flex shrink-0 items-center gap-3 pt-px text-[11.5px] text-faint narrow:min-w-0 narrow:flex-1 narrow:gap-2 narrow:overflow-hidden">
        <TaskMarks task={task} />
        <TaskBadges task={task} project={project} progress={progress} />
        {task.running && <RunState task={task} />}
        <ResolutionBadge task={task} />
        {showsPreview(task) && task.preview_url && <PreviewDot url={task.preview_url} host={task.host_id} label />}
        {task.branch && <BranchIcon branch={task.branch} className={task.worktree_state === "ready" ? "text-muted" : ""} />}
        {task.pr_url && <PrIcon url={task.pr_url} className="text-muted" />}
        <ChecksMark task={task} />
        <AgentIcon task={task} />
        {cost(task.cost_usd) && <span>{cost(task.cost_usd)}</span>}
        <span className="w-14 text-right narrow:ml-auto narrow:w-auto narrow:shrink-0">
          <ActivityTime task={task} />
        </span>
      </div>
      <MoveButton task={task} onMenu={onMenu} className="-my-1.5 -mr-1.5 h-8 w-8" />
    </div>
  )
})
