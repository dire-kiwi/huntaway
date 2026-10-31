import clsx from "clsx";
import { CheckCheck, Clock, Ellipsis, Folder, GitMerge, Hourglass, Kanban, Layers } from "lucide-react";
import { memo, type KeyboardEvent, type MouseEvent } from "react";
import { agentWaiting, isScratch, limitQueued, mergeQueued, rejoinsMerge, taskLabels, type Project, type Task } from "../api";
import { inGroupTaskGroup } from "../projectGroups";
import { navigate, openTask, usePanelOpen } from "../router";
import { isGroupTask, keyPrefix, useStore } from "../store";
import { ExternalLinkIcon } from "./ExternalLinks";
import { ReviewBadge } from "./Review";
import { DependencyBadge } from "./Dependencies";
import { FanoutBadge } from "./Fanout";
import { TaskMarks } from "./Reminders";
import { TaskTypeBadge } from "./Document";
import { ActivityTime, BranchIcon, CARD_BADGE, CardState, ChecksMark, cost, PrIcon, PreviewDot, ProgressCount, ResolutionBadge, RunState, showsPreview, StatusIcon, WaitReason, Wide } from "./ui";
import { useNarrow, useTouch } from "../narrow";
import { resetsIn, resetTime } from "../usageConfigs";


/** How many of a subproject's tasks are done. */
export type Progress = { done: number; total: number };

// A subproject's scratch tasks aren't part of its work.
const subprojectWork = (t: Task) => t.kind === "task" && !!t.parent_id && !isScratch(t);

type StoreState = ReturnType<typeof useStore.getState>;

/**
 * A store selector of progress by id, worked out again only when the tasks or projects change, which
 * keeps each progress object that's the same as before (and the record, when they all are): a task
 * event doesn't redraw the memoized cards whose progress it leaves be, or what shows none of it.
 */
function progressSelector(compute: (tasks: Record<string, Task>, projects: Project[]) => Record<string, Progress>) {
  let tasks: Record<string, Task> | undefined;
  let projects: Project[] | undefined;
  let last: Record<string, Progress> = {};
  return (s: StoreState) => {
    if (s.tasks === tasks && s.projects === projects) return last;
    tasks = s.tasks;
    projects = s.projects;
    const next = compute(tasks, projects);
    let same = Object.keys(next).length === Object.keys(last).length;
    for (const [id, p] of Object.entries(next)) {
      const before = last[id];
      if (before && before.done === p.done && before.total === p.total) next[id] = before;
      else same = false;
    }
    if (!same) last = next;
    return last;
  };
}

const subprojectProgress = progressSelector((all) => {
  const by: Record<string, Progress> = {};
  for (const t of Object.values(all)) {
    if (!subprojectWork(t)) continue;
    const p = (by[t.parent_id!] ??= { done: 0, total: 0 });
    p.total++;
    if (t.status === "done") p.done++;
  }
  return by;
});

const createdProgress = progressSelector((all, projects) => {
  const by: Record<string, Progress> = {};
  for (const t of Object.values(all)) {
    if (t.kind !== "task" || !t.created_by) continue;
    const creator = all[t.created_by];
    if (!creator || !(isGroupTask(creator) ? inGroupTaskGroup(t, creator, projects) : taskLabels(creator).includes("plan"))) continue;
    const p = (by[t.created_by] ??= { done: 0, total: 0 });
    p.total++;
    if (t.status === "done") p.done++;
  }
  return by;
});

/** Progress of every subproject on the board, by subproject id. */
export function useProgress(): Record<string, Progress> {
  return useStore(subprojectProgress);
}

/** One subproject's progress (none without tasks). Unlike useProgress, it only re-renders when that changes. */
export function useSubprojectProgress(id: string): Progress | undefined {
  return useStore((s) => subprojectProgress(s)[id]);
}

/**
 * How many of the tasks each group task's agent created in the group's projects are done, by
 * the group task's id; and for a plan in a project, of the tasks its agent broke it into.
 */
export function useCreatedProgress(): Record<string, Progress> {
  return useStore(createdProgress);
}

export function GroupTaskBadge({ progress, compact }: { progress?: Progress; compact?: boolean }) {
  if (compact)
    return (
      <span
        className={clsx(CARD_BADGE, "text-accent")}
        title={`Group task: plans the work of the group's projects and creates their tasks${progress?.total ? ` (${progress.done} of ${progress.total} done)` : ""}`}
      >
        <Folder size={11} /> {progress?.total ? <ProgressCount progress={progress} /> : <Wide>group task</Wide>}
      </span>
    );
  return (
    <span className="flex items-center gap-1 text-accent" title="Group task: plans the work of the group's projects and creates their tasks">
      <Folder size={11} /> {progress?.total ? `${progress.done}/${progress.total} done` : "group task"}
    </span>
  );
}

/** A scratch task's badge, and its labels': a plan's with how the tasks it created are doing (`progress`, which a group
 *  task or a subproject shows on its own badge). */
function TypeBadges({ task, progress, compact }: { task: Task; progress?: Progress; compact?: boolean }) {
  const ownProgress = isGroupTask(task) || task.subproject ? undefined : progress;
  return (
    <>
      {isScratch(task) && <TaskTypeBadge type="scratch" compact={compact} />}
      {taskLabels(task).map((l) => (
        <TaskTypeBadge key={l} type={l} progress={l === "plan" ? ownProgress : undefined} compact={compact} />
      ))}
    </>
  );
}

/** Opens a subproject's own board of tasks, as a kanban board or a list. */
export const openSubprojectBoard = (t: Task) => navigate({ name: "subproject", taskId: t.id });

/** `compact`, on a card: an icon and "2/8", and its words once the card has room. */
export function SubprojectBadge({ progress, compact }: { progress?: Progress; compact?: boolean }) {
  // Every task merged into its branch: the subproject waits in review to be merged as a whole.
  const merged = !!progress?.total && progress.done === progress.total;
  if (compact)
    return (
      <span
        className={clsx(CARD_BADGE, merged ? "text-st-done" : "text-accent")}
        title={
          merged
            ? "Subproject: all its tasks are merged into its branch"
            : `Subproject: its tasks merge into its branch${progress?.total ? ` (${progress.done} of ${progress.total} done)` : ""}`
        }
      >
        {merged ? <CheckCheck size={11} /> : <Layers size={11} />}{" "}
        {progress?.total ? <ProgressCount progress={progress} word={merged ? "merged" : "done"} /> : <Wide>subproject</Wide>}
      </span>
    );
  if (merged && progress)
    return (
      <span className="flex items-center gap-1 text-st-done" title="Subproject: all its tasks are merged into its branch">
        <CheckCheck size={11} /> {progress.total === 1 ? "task merged" : `all ${progress.total} merged`}
      </span>
    );
  return (
    <span className="flex items-center gap-1 text-accent" title="Subproject: its tasks merge into its branch">
      <Layers size={11} /> {progress?.total ? `${progress.done}/${progress.total} done` : "subproject"}
    </span>
  );
}

/**
 * On a subproject's card or row: opens its board, while clicking the rest of the card opens the subproject itself beside
 * the board. On a card (`icon`) it's just the icon.
 */
function SubprojectBoardButton({ task, icon }: { task: Task; icon?: boolean }) {
  return (
    <button
      type="button"
      className={clsx(
        "-my-0.5 flex shrink-0 items-center gap-1 rounded text-[11px] text-muted hover:bg-panel hover:text-fg",
        icon ? "-mx-0.5 p-0.5" : "border border-line px-1.5 py-px hover:border-line-strong",
      )}
      title="Open the subproject's board of tasks"
      aria-label={icon ? "Board" : undefined}
      onClick={(e) => {
        e.stopPropagation();
        openSubprojectBoard(task);
      }}
    >
      <Kanban size={icon ? 12 : 11} /> {!icon && "Board"}
    </button>
  );
}

/**
 * What kind of task it is and where it stands, on a card (`compact`: icons, with their words once the card has room) or
 * a list row: a subproject's or group task's progress, its type and labels, the merge queue, what it waits on, its
 * fan-out and its review.
 */
function TaskBadges({ task, project, progress, compact }: { task: Task; project?: Project; progress?: Progress; compact?: boolean }) {
  const badge = compact ? clsx(CARD_BADGE, "text-muted") : "flex items-center gap-1 text-muted";
  const words = (text: string) => (compact ? <Wide>{text}</Wide> : text);
  return (
    <>
      {task.subproject && <SubprojectBadge progress={progress} compact={compact} />}
      {isGroupTask(task) && <GroupTaskBadge progress={progress} compact={compact} />}
      <TypeBadges task={task} progress={progress} compact={compact} />
      {mergeQueued(task) && (
        <span className={badge} title="Queued to merge: waits for the merge in progress in this project">
          <Clock size={11} /> {words("queued to merge")}
        </span>
      )}
      {rejoinsMerge(task) && (
        <span className={badge} title="Stepped out of the merge queue to make changes: rejoins it when its agent is done">
          <GitMerge size={11} /> {words("rejoins merge queue")}
        </span>
      )}
      {limitQueued(task) && (
        <span className={badge} title={`Waiting for its config's usage limit to reset (${resetTime(task.limit_reset_at!)}); its agent carries on then`}>
          <Hourglass size={11} /> {words("usage resets")} {resetsIn(task.limit_reset_at!, Date.now())}
        </span>
      )}
      <DependencyBadge task={task} project={project} compact={compact} />
      {task.fanout_id && <FanoutBadge task={task} />}
      <ReviewBadge task={task} compact={compact} />
    </>
  );
}

/** Opens a task's menu at a right-click, or with `move` from its menu button (which moves it to another column). */
export type OnMenu = (e: MouseEvent, task: Task, move?: boolean) => void;

/** `onMenu` decides whether to replace the browser's menu (preventDefault). */
const menuHandler = (task: Task, onMenu?: OnMenu) => onMenu && ((e: MouseEvent) => onMenu(e, task));

/**
 * The button that opens a task's menu to move it to another column: what dragging it does, where that doesn't work. On
 * phones and touch screens only.
 */
function MoveButton({ task, onMenu, className }: { task: Task; onMenu?: OnMenu; className?: string }) {
  const narrow = useNarrow();
  const touch = useTouch();
  if (!onMenu || !(narrow || touch)) return null;
  return (
    <button
      title="Move to…"
      aria-label={`Move ${task.title} to…`}
      aria-haspopup="menu"
      className={clsx("flex shrink-0 items-center justify-center rounded-md text-faint hover:bg-white/5 hover:text-fg", className)}
      onClick={(e) => {
        e.stopPropagation();
        onMenu(e, task, true);
      }}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <Ellipsis size={16} />
    </button>
  );
}

/** A card or row that opens its task: a button to the keyboard and screen readers too (Enter or Space opens it). */
const opensTask = (task: Task, open: boolean) => ({
  role: "button",
  tabIndex: 0,
  "aria-current": open || undefined,
  onClick: () => openTask(task.id),
  onKeyDown: (e: KeyboardEvent) => {
    // Not a key pressed on a button inside it.
    if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
    e.preventDefault();
    openTask(task.id);
  },
});

// Memoized, like TaskRow: a task's change redraws its own card, not every card on the board.
export const TaskCard = memo(function TaskCard({
  task,
  project,
  progress,
  draggable = true,
  onMenu,
}: {
  task: Task;
  project?: Project;
  progress?: Progress;
  draggable?: boolean;
  onMenu?: OnMenu;
}) {
  const open = usePanelOpen(task.id);
  return (
    <div
      draggable={draggable}
      onDragStart={(e) => {
        e.dataTransfer.setData("text/task-id", task.id);
        e.dataTransfer.effectAllowed = "move";
      }}
      {...opensTask(task, open)}
      onContextMenu={menuHandler(task, onMenu)}
      data-task={task.id}
      className={clsx(
        "group @container relative cursor-pointer overflow-hidden rounded-lg border bg-panel-2 p-3 transition-colors outline-none hover:border-line-strong hover:bg-raised focus-visible:ring-1 focus-visible:ring-accent",
        task.status === "needs_attention" ? "border-st-attention/35" : task.review?.state === "running" ? "border-st-review/40" : "border-line",
        open && "bg-raised ring-1 ring-accent/60",
      )}
    >
      {/* One line that never wraps: the key and the state stay whole, and badges that don't fit are cut off. */}
      <div className="mb-1 flex items-center gap-2 text-[11px] text-faint">
        <span className="shrink-0 font-mono">
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
      {agentWaiting(task) && <WaitReason wait={agentWaiting(task)!} className="mt-1 line-clamp-2 text-[12px] leading-snug text-muted" />}
      {(task.subproject || task.branch || task.pr_url || task.external_links?.length || task.cost_usd > 0 || showsPreview(task)) && (
        <div className="mt-2 flex items-center gap-2 text-[11px] text-faint">
          {task.subproject && <SubprojectBoardButton task={task} icon />}
          {showsPreview(task) && <PreviewDot url={task.preview_url!} label />}
          {task.branch && <BranchIcon branch={task.branch} className={task.worktree_state === "ready" ? "text-muted" : ""} />}
          {task.pr_url && <PrIcon url={task.pr_url} className="text-muted" />}
          <ChecksMark task={task} />
          {task.external_links?.map((l) => <ExternalLinkIcon key={l.id} link={l} />)}
          {cost(task.cost_usd) && <span className="ml-auto shrink-0">{cost(task.cost_usd)}</span>}
        </div>
      )}
      {/* How much of a subproject's, plan's or group task's work is done, along the bottom edge. */}
      {!!progress?.total && (
        <div className="absolute inset-x-0 bottom-0 h-[3px] bg-line" title={`${progress.done} of ${progress.total} tasks done`}>
          <div className={clsx("h-full", progress.done === progress.total ? "bg-st-done" : "bg-accent")} style={{ width: `${(100 * progress.done) / progress.total}%` }} />
        </div>
      )}
    </div>
  );
});

export const TaskRow = memo(function TaskRow({ task, project, progress, onMenu }: { task: Task; project?: Project; progress?: Progress; onMenu?: OnMenu }) {
  const open = usePanelOpen(task.id);
  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("text/task-id", task.id);
        e.dataTransfer.effectAllowed = "move";
      }}
      {...opensTask(task, open)}
      onContextMenu={menuHandler(task, onMenu)}
      data-task={task.id}
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
        {agentWaiting(task) && <WaitReason wait={agentWaiting(task)!} className="mt-0.5 truncate text-[12px] text-muted" />}
      </div>
      {/* On a phone, the title goes on a line of its own under these. */}
      <div className="flex shrink-0 items-center gap-3 pt-px text-[11.5px] text-faint narrow:min-w-0 narrow:flex-1 narrow:gap-2 narrow:overflow-hidden">
        <TaskMarks task={task} />
        <TaskBadges task={task} project={project} progress={progress} />
        {task.subproject && <SubprojectBoardButton task={task} />}
        {task.running && <RunState task={task} />}
        <ResolutionBadge task={task} />
        {showsPreview(task) && <PreviewDot url={task.preview_url!} label />}
        {task.branch && <BranchIcon branch={task.branch} className={task.worktree_state === "ready" ? "text-muted" : ""} />}
        {task.pr_url && <PrIcon url={task.pr_url} className="text-muted" />}
        <ChecksMark task={task} />
        {task.external_links?.map((l) => <ExternalLinkIcon key={l.id} link={l} />)}
        {cost(task.cost_usd) && <span>{cost(task.cost_usd)}</span>}
        <span className="w-14 text-right narrow:ml-auto narrow:w-auto narrow:shrink-0">
          <ActivityTime task={task} />
        </span>
      </div>
      <MoveButton task={task} onMenu={onMenu} className="-my-1.5 -mr-1.5 h-8 w-8" />
    </div>
  );
});

