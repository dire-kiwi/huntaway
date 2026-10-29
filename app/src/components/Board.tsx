import clsx from "clsx";
import { Archive, CheckCheck, ChevronLeft, ChevronRight, Clock, Cpu, Folder, FolderGit2, Gauge, GitBranch, Kanban, Layers, Link2, List, MessagesSquare, NotebookPen, Plus, Settings2, X } from "lucide-react";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent, type ReactNode, type WheelEvent } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  agentOf,
  agentWaiting,
  api,
  canRunAgents,
  hostStatuses,
  hostSupports,
  isArchived,
  isMerged,
  isScratch,
  mergeQueued,
  STATUSES,
  worktreesOn,
  type ClaudeConfig,
  type DocumentType,
  type Host,
  type Profile,
  type Project,
  type Resolution,
  type Effort,
  type ExternalLink,
  type Status,
  type Task,
  type TaskType,
  asanaLink,
} from "../api";
import { effortOptions, inheritedModel, isClaudeModel, modelOptions, useConfigsModels } from "../agents";
import { harnessesOf, harnessWords, newFanoutId, sameHarness, type Harness, type HarnessConfig, type HarnessWord } from "../harnesses";
import { groupProjects, groupTasks, inGroupTaskGroup } from "../projectGroups";
import { dropPosition } from "../taskOrder";
import { allValues, completionAt, findTokens, insertCompletion, lastValue, placeWords, removeTokens, resolveTokens, stripTokens, type Token, type TokenPrefix, type Vocab } from "../taskTokens";
import { EMPTY_QUERY, isFiltering, isSortKey, showsStatus, sortTasks, taskKind, taskMatcher, type BoardQuery, type SortKey, type TaskKind } from "../boardQuery";
import { FilterBar, FilterMenu, SearchBox, SortMenu, type FilterOption } from "./BoardControls";
import { navigate, openTask, usePanel } from "../router";
import { isGroupTask, keyPrefix, scratchHost, useAvailableConfigs, useHost, useStore } from "../store";
import { ConfigSelect } from "./ClaudeConfigs";
import { withAttachments, type AttachmentRef } from "../attachments";
import { AttachButton, DraftAttachments, useAttachmentDraft } from "./Attachments";
import { AsanaIcon, AsanaPicker, ExternalLinkIcon, LinkList, LINKS_API, usesAsana } from "./ExternalLinks";
import { ReviewBadge } from "./Review";
import { DependencyBadge } from "./Dependencies";
import { FanoutBadge } from "./Fanout";
import { ReminderModal, reminderItems, starItem, TaskMarks } from "./Reminders";
import { REMINDERS_API } from "../reminders";
import { SCRATCH_TYPE, TASK_TYPES, TaskTypeBadge } from "./Document";
import { ActivityTime, BranchIcon, Button, CARD_BADGE, CardState, ContextMenu, cost, IconButton, Input, Modal, PrIcon, PreviewDot, ProgressCount, RESOLUTION_LABELS, ResolutionBadge, RunningDot, RunState, showsPreview, StatusIcon, STATUS_COLOR, SUBMIT_KEYS, Toggle, useClock, Wide } from "./ui";

/** How many of a subproject's tasks are done. */
export type Progress = { done: number; total: number };

// A subproject's scratch tasks aren't part of its work.
const subprojectWork = (t: Task) => t.kind === "task" && !!t.parent_id && !isScratch(t);

/** Progress of every subproject on the board, by subproject id. */
export function useProgress(): Record<string, Progress> {
  const all = useStore((s) => s.tasks);
  return useMemo(() => {
    const by: Record<string, Progress> = {};
    for (const t of Object.values(all)) {
      if (!subprojectWork(t)) continue;
      const p = (by[t.parent_id!] ??= { done: 0, total: 0 });
      p.total++;
      if (t.status === "done") p.done++;
    }
    return by;
  }, [all]);
}

/** One subproject's progress (none without tasks). Unlike useProgress, it only re-renders when that changes. */
export function useSubprojectProgress(id: string): Progress | undefined {
  return useStore(
    useShallow((s) => {
      const p = { done: 0, total: 0 };
      for (const t of Object.values(s.tasks)) {
        if (t.parent_id !== id || !subprojectWork(t)) continue;
        p.total++;
        if (t.status === "done") p.done++;
      }
      return p.total ? p : undefined;
    }),
  );
}

/**
 * How many of the tasks each group task's agent created in the group's projects are done, by
 * the group task's id; and for a plan in a project, of the tasks its agent broke it into.
 */
export function useCreatedProgress(): Record<string, Progress> {
  const all = useStore((s) => s.tasks);
  const projects = useStore((s) => s.projects);
  return useMemo(() => {
    const by: Record<string, Progress> = {};
    for (const t of Object.values(all)) {
      if (t.kind !== "task" || !t.created_by) continue;
      const creator = all[t.created_by];
      if (!creator || !(isGroupTask(creator) ? inGroupTaskGroup(t, creator, projects) : creator.task_type === "plan")) continue;
      const p = (by[t.created_by] ??= { done: 0, total: 0 });
      p.total++;
      if (t.status === "done") p.done++;
    }
    return by;
  }, [all, projects]);
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

/** Opens a task's menu at a right-click. */
type OnMenu = (e: MouseEvent, task: Task) => void;

/** `onMenu` decides whether to replace the browser's menu (preventDefault). */
const menuHandler = (task: Task, onMenu?: OnMenu) => onMenu && ((e: MouseEvent) => onMenu(e, task));

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
  const open = usePanel()?.taskId === task.id;
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
          {task.subproject && <SubprojectBadge progress={progress} compact />}
          {isGroupTask(task) && <GroupTaskBadge progress={progress} compact />}
          {task.task_type && <TaskTypeBadge type={task.task_type} progress={isGroupTask(task) ? undefined : progress} compact />}
          {mergeQueued(task) && (
            <span className={clsx(CARD_BADGE, "text-muted")} title="Queued to merge: waits for the merge in progress in this project">
              <Clock size={11} /> <Wide>queued to merge</Wide>
            </span>
          )}
          <DependencyBadge task={task} project={project} compact />
          {task.fanout_id && <FanoutBadge task={task} />}
          <ReviewBadge task={task} compact />
          <TaskMarks task={task} compact />
        </div>
        <CardState task={task} />
      </div>
      <div className={clsx("text-[13px] leading-snug", task.status === "done" && task.resolution === "wont_fix" ? "text-muted" : "text-fg")}>{task.title}</div>
      {task.attention_reason && task.status === "needs_attention" && (
        <div className="mt-2 rounded-md bg-st-attention/[0.08] px-2 py-1.5 text-[12px] leading-snug text-amber-200/90">
          <div className="line-clamp-3">{task.attention_reason}</div>
        </div>
      )}
      {agentWaiting(task)?.reason && <div className="mt-1 line-clamp-2 text-[12px] leading-snug text-muted">{agentWaiting(task)!.reason}</div>}
      {(task.subproject || task.branch || task.pr_url || task.external_links?.length || task.cost_usd > 0 || showsPreview(task)) && (
        <div className="mt-2 flex items-center gap-2 text-[11px] text-faint">
          {task.subproject && <SubprojectBoardButton task={task} icon />}
          {showsPreview(task) && <PreviewDot url={task.preview_url!} label />}
          {task.branch && <BranchIcon branch={task.branch} className={task.worktree_state === "ready" ? "text-muted" : ""} />}
          {task.pr_url && <PrIcon url={task.pr_url} className="text-muted" />}
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

// Columns that get a "new task" button. New work starts in To do or Backlog.
const CAN_ADD: ReadonlySet<Status> = new Set<Status>(["todo", "backlog"]);

// The "Start agent now" choice is remembered per project on this client.
const startKey = (projectId: string) => `ia.startAgent.${projectId}`;
// Remembers the "Add another" toggle between dialogs.
const ADD_ANOTHER_KEY = "ia.newTask.addAnother";
// The model and effort last picked for a new task in a project, on this client. Blank (the
// default) leaves it to the project, profile and host settings.
const modelKey = (projectId: string) => `ia.newTask.model.${projectId}`;
const effortKey = (projectId: string) => `ia.newTask.effort.${projectId}`;
// The Claude config last picked, when the project offers more than one.
const configKey = (projectId: string) => `ia.newTask.claudeConfig.${projectId}`;
// The project last picked for a new task (or groupTarget, or scratchTarget).
const PROJECT_KEY = "ia.newTask.project";
// What's been written for a new task and not yet created, so closing the dialog doesn't lose it.
// One per project, or per subproject for the dialog that adds to it.
const draftKey = (projectId: string, subprojectId?: string) => `ia.newTask.draft.${subprojectId ?? projectId}`;
// Stands in for a project id in the keys above for a group's group tasks, and for a profile's scratch tasks.
const groupTarget = (hostId: string, group: string) => `group:${hostId}:${group}`;
const scratchTarget = (p: Profile) => `scratch:${p.host_id}:${p.id}`;

interface Draft {
  description: string;
  /** Uploaded attachments, which are on the project's host. */
  files: AttachmentRef[];
  /** The Asana tasks picked for it, in the project's profile. */
  links?: ExternalLink[];
  /** Some of the tasks for its models were made, and these are the rest of the set (IA-227). */
  fanout?: PendingFanout | null;
}

/** A set of tasks from one prompt that only some of were made: what the rest are made with when it's tried again. */
interface PendingFanout {
  /** The id they share; null on hosts before API 61. */
  id: string | null;
  /** The keys of those made. */
  made: string[];
  /** The efforts those made took, so a `^` only they take is still one. */
  efforts: string[];
}

const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
const isPendingFanout = (f: unknown): f is PendingFanout => {
  const x = f as PendingFanout | null;
  return !!x && (x.id === null || typeof x.id === "string") && strings(x.made) && strings(x.efforts);
};

const isLink = (l: unknown): l is ExternalLink => {
  const x = l as ExternalLink | null;
  return !!x && x.provider === "asana" && typeof x.id === "string" && typeof x.url === "string" && typeof x.title === "string";
};

function loadDraft(key: string): Draft | null {
  try {
    const d = JSON.parse(localStorage.getItem(key) ?? "null");
    if (!d || typeof d.description !== "string") return null;
    return {
      description: d.description,
      files: Array.isArray(d.files) ? d.files : [],
      links: Array.isArray(d.links) ? d.links.filter(isLink) : [],
      fanout: isPendingFanout(d.fanout) ? d.fanout : null,
    };
  } catch {
    return null;
  }
}

const pickerClass = "h-7 rounded-md border border-line bg-panel px-1.5 text-[12.5px] text-fg outline-none";

/** The task's own model: blank for whatever the project, profile or host picks. */
export function ModelPicker({
  value,
  onChange,
  inherited,
  options,
  placeholder = "model id, e.g. claude-opus-5-5",
}: {
  value: string;
  onChange: (v: string) => void;
  inherited?: string | null;
  /** Claude's aliases, or a Codex config's models. */
  options: { id: string; label: string }[];
  placeholder?: string;
}) {
  const [editing, setEditing] = useState(false);
  if (editing) {
    return (
      <Input
        autoFocus
        value={value}
        placeholder={placeholder}
        className="h-7 w-52 font-mono text-[12px]"
        onChange={(e) => onChange(e.target.value.trim())}
        onBlur={() => setEditing(false)}
        onKeyDown={(e) => {
          // Enter confirms the model rather than submitting the dialog.
          if (e.key === "Enter" && !e.ctrlKey && !e.metaKey) {
            e.preventDefault();
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
    );
  }
  return (
    <select
      className={pickerClass}
      title="Model"
      value={value}
      onChange={(e) => (e.target.value === "__custom" ? setEditing(true) : onChange(e.target.value))}
    >
      <option value="">{inherited ? `Default model (${inherited})` : "Default model"}</option>
      {options.map((m) => (
        <option key={m.id} value={m.id}>
          {m.label}
        </option>
      ))}
      {value && !options.some((m) => m.id === value) && <option value={value}>{value}</option>}
      <option value="__custom">Specific model…</option>
    </select>
  );
}

/** What the new task dialog makes: code (null), a subproject, a document or a scratch task. */
type NewTaskType = TaskType | "subproject" | null;

const documentTypeOf = (t: NewTaskType): DocumentType | null => (t === "plan" || t === "artifact" || t === "diagram" ? t : null);

/** A subproject, which the new task dialog offers as a type of task in a project that uses worktrees (API 17). */
const SUBPROJECT_TYPE = {
  id: "subproject" as const,
  label: "Subproject",
  icon: <Layers size={12} />,
  hint: "A task with its own worktree, thread and pull request, and a board of tasks that branch from its branch and merge back into it",
};

// The words `@` takes besides project keys: a group task, and a scratch task in no project. `!default` and `^default`
// leave the model and effort to the project, profile and host.
const GROUP_WORD = "group";
const NONE_WORD = "none";
const DEFAULT_WORD = "default";

/** `/type` names a type by its id, and a task (code) as `task`. */
const typeWord = (t: NewTaskType) => t ?? "task";

/** A value offered for a token as it's typed. */
type Suggestion = { value: string; label: string; hint?: string };

/** The token prefixes, in the order the legend and the placeholder give them. */
const TOKEN_HELP: { prefix: TokenPrefix; what: string; asks: string }[] = [
  { prefix: "/", what: "type", asks: "a type" },
  { prefix: "@", what: "where", asks: "where it goes" },
  { prefix: "!", what: "model", asks: "a model (or several, for a task each)" },
  { prefix: "^", what: "effort", asks: "effort" },
  { prefix: "#", what: "waits for", asks: "a task to wait for" },
];

// The editor's text and the highlighting behind it are laid out alike, so the highlights line up with what's typed.
const EDITOR_TEXT = "m-0 px-2.5 py-2 text-[13px] leading-[1.6] whitespace-pre-wrap break-words";

/** A value in the "Reads as" row: one a token set has an × that takes the token out; a dashed one is the default. */
function ReadsChip({ icon, label, title, onRemove, removeTitle = "Remove", dashed }: { icon?: ReactNode; label: ReactNode; title?: string; onRemove?: () => void; removeTitle?: string; dashed?: boolean }) {
  return (
    <span
      title={title}
      className={clsx(
        "inline-flex h-6 max-w-64 items-center gap-1 rounded-md border px-1.5 text-[12px]",
        dashed ? "border-dashed border-line-strong pr-2 text-faint" : "border-line bg-panel-2 text-fg",
      )}
    >
      {icon && <span className="shrink-0 text-accent">{icon}</span>}
      <span className="truncate">{label}</span>
      {onRemove && (
        <button type="button" className="-mr-0.5 shrink-0 rounded p-0.5 text-faint hover:bg-white/5 hover:text-fg" title={removeTitle} aria-label={removeTitle} onClick={onRemove}>
          <X size={11} />
        </button>
      )}
    </span>
  );
}

/**
 * The new task form. Its options are tokens typed in the description (IA-220): `/plan` its type, `@IA` where it goes
 * (or `@group`, `@none`), `!sonnet` its model (several make a task with each, IA-227), `^high` its effort and `#IA-212`
 * a task to merge first. They're taken
 * out of what its agent is given. With none, it goes where the dialog was opened, with the options last picked there.
 */
export function NewTaskModal({
  project: initial,
  projects,
  subproject,
  group: groupName,
  scratch,
  onClose,
  status = "todo",
}: {
  /** Where it goes. Without one, it can only be a scratch task (`scratch`). */
  project?: Project;
  /** Projects to pick from (`@` and their key), starting at `project`. Without them the task goes in `project`. */
  projects?: Project[];
  /** Add the task to this subproject. */
  subproject?: Task;
  /** The group `projects` are, which offers a group task too: one in no project that plans the group's work (API 34). */
  group?: string;
  /** The profile (on the host its scratch tasks go to) that offers a scratch task in no project too, with no repository (API 47). */
  scratch?: Profile | null;
  onClose: () => void;
  status?: Status;
}) {
  const hosts = useStore((s) => s.hosts);
  const initialHost = useHost(initial?.host_id);
  // A group task goes in the first project's profile and host, and remembers its options per group.
  const group = !!initial && !subproject && hostSupports(initialHost, 34) ? groupName : undefined;
  // Where it goes without an `@`: the project it's opened in, or no project or the group task, if that was last picked.
  // Once a task is created, where it went is where the next one starts (as it would in a new dialog).
  // It's kept by id, so it's the project as the board has it now (a refresh can find a repository became git's).
  const [base, setBase] = useState(() => ({
    projectId: initial?.id,
    noProject: !!scratch && (!initial || localStorage.getItem(PROJECT_KEY) === scratchTarget(scratch)),
    asGroup: !!group && !!initial && localStorage.getItem(PROJECT_KEY) === groupTarget(initial.host_id, group),
  }));
  const baseProject = (initial?.id === base.projectId ? initial : projects?.find((p) => p.id === base.projectId)) ?? initial;
  const basePref =
    base.noProject && scratch ? scratchTarget(scratch) : base.asGroup && group ? groupTarget(baseProject!.host_id, group) : baseProject!.id;
  // The draft is kept where the dialog starts, wherever its tokens send the task, so it comes back with them.
  const draft = draftKey(basePref, subproject?.id);
  const [saved] = useState(() => loadDraft(draft));
  const [description, setDescription] = useState(saved?.description ?? "");

  // The token being typed, to suggest values for: unless Escape closed the list for it, or the editor isn't focused.
  const input = useRef<HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState(description.length);
  const [focused, setFocused] = useState(true);
  const [closedAt, setClosedAt] = useState<number | null>(null);
  const typing = focused ? completionAt(description, caret) : null;
  const completing = typing && typing.start !== closedAt ? typing : null;
  const found = useMemo(() => findTokens(description), [description]);

  // `@`: a project by its key (with its host or profile where that's ambiguous, or the key is `none` or `group`), the
  // group task or no project. A subproject's task stays in it.
  const profiles = useStore((s) => s.profiles);
  const placeNames = subproject
    ? []
    : placeWords(
        (projects ?? []).map((p) => ({
          key: p.key,
          host: hosts.find((h) => h.id === p.host_id)?.name ?? p.host_id,
          profile: profiles.find((x) => x.host_id === p.host_id && x.id === p.profile_id)?.name ?? p.profile_id,
        })),
        [GROUP_WORD, NONE_WORD],
      );
  const atVocab = subproject ? [] : [...placeNames, ...(group ? [GROUP_WORD] : []), ...(scratch ? [NONE_WORD] : [])];
  // An `@` being typed waits while it could still become another (`@S` of `@SD`), so the task doesn't go somewhere
  // else on the way (which can drop its files and Asana tasks); it's taken once it's picked, finished with a space or
  // left, and before Ctrl+Enter creates the task (see submit).
  const typed = completing?.prefix === "@" ? found.find((t) => t.start === completing.start) : undefined;
  const heldBack = typed && atVocab.some((v) => v.length > typed.word.length && v.toLowerCase().startsWith(typed.word.toLowerCase())) ? typed : undefined;
  const resolve = (vocab: Vocab) => resolveTokens(heldBack ? found.filter((t) => t !== heldBack) : found, vocab);
  // Meanwhile the task stays where the text last settled (also when the caret only moves into an `@` already taken,
  // or when the dialog opens with the caret after one), so nothing goes until the `@` being typed is done.
  const settledAt = useRef<{ at: string | undefined } | null>(null);
  if (!heldBack) settledAt.current = { at: lastValue(resolve({ "@": atVocab }), "@") };
  else settledAt.current ??= { at: lastValue(resolveTokens(found, { "@": atVocab }), "@") };
  const at = settledAt.current.at;
  const atProject = at === undefined ? undefined : projects?.[placeNames.indexOf(at)];
  const project = atProject ?? baseProject;
  // The project's host decides which types it offers, while the task is in no project too.
  const projectHost = useHost(project?.host_id);
  // What it makes: code (null); a subproject, with its own board of tasks (API 17); a plan,
  // artifact or diagram, which its agent writes in the task's own folder rather than a worktree
  // (API 42); or a scratch task, whose agent works in its own folder on whatever it's asked
  // (in no project, API 47, or in the project, API 51). Each is offered where it can go.
  const types = hostSupports(projectHost, 42);
  const canSubproject = !subproject && !!project && hostSupports(projectHost, 17) && worktreesOn(project);
  const projectScratch = !!project && hostSupports(projectHost, 51);
  // The types it can be, by the project's host (or the scratch task's, in no project).
  const typeTabs: { id: NewTaskType; label: string; icon: ReactNode; hint: string }[] = [
    ...(project ? [{ id: null, label: "Task", icon: <FolderGit2 size={12} />, hint: "Its agent works on the code" }] : []),
    ...(canSubproject ? [SUBPROJECT_TYPE] : []),
    ...(project && types ? TASK_TYPES : []),
    ...(scratch || projectScratch ? [SCRATCH_TYPE] : []),
  ];
  const typeOf = (word: string | undefined) => typeTabs.find((t) => typeWord(t.id) === word);
  const typeAsked = typeOf(lastValue(resolve({ "/": typeTabs.map((t) => typeWord(t.id)) }), "/"))?.id;
  const asked = typeAsked !== undefined;
  // Without an `@`, a type keeps the task where it is, except that a scratch task starts out in no project when
  // that's offered, and another type in no project, or a scratch task or subproject in a group, goes in the project.
  let noProject = at === NONE_WORD;
  let asGroup = at === GROUP_WORD;
  if (!at) {
    noProject = base.noProject;
    asGroup = base.asGroup && !!group;
    if (asked && typeAsked === "scratch" && scratch && !noProject) [noProject, asGroup] = [true, false];
    else if (asked && noProject && typeAsked !== "scratch" && project) noProject = false;
    else if (asked && asGroup && (typeAsked === "scratch" || typeAsked === "subproject")) asGroup = false;
  }
  noProject = !!scratch && (noProject || !project);
  asGroup = asGroup && !noProject && !!group;
  // Where it goes: the project's host and profile, or the scratch task's in no project.
  const target = noProject ? { host_id: scratch!.host_id, profile_id: scratch!.id } : { host_id: project!.host_id, profile_id: project!.profile_id };
  const host = useHost(target.host_id);
  const prefId = noProject ? scratchTarget(scratch!) : asGroup ? groupTarget(target.host_id, group!) : project!.id;
  // The project it's in, if it's in one.
  const inProject = noProject || asGroup ? undefined : project;
  // The types it can be where it goes; one asked for that isn't falls back to the first that is.
  const offered: NewTaskType[] = noProject
    ? ["scratch"]
    : asGroup
      ? [null, ...(types ? TASK_TYPES.map((t) => t.id) : [])]
      : [null, ...(canSubproject ? ["subproject" as const] : []), ...(types ? TASK_TYPES.map((t) => t.id) : []), ...(projectScratch ? ["scratch" as const] : [])];

  const agents = canRunAgents(host);
  const hostCount = hosts.length;
  const profile = useStore((s) => s.profiles.find((p) => p.host_id === target.host_id && p.id === target.profile_id));
  const hostSettings = useStore((s) => s.hostSettings[target.host_id]);
  // The model, effort and config last picked where it goes, which tokens override.
  const [model, setModel] = useState(() => localStorage.getItem(modelKey(prefId)) ?? "");
  const [effort, setEffort] = useState(() => (localStorage.getItem(effortKey(prefId)) ?? "") as Effort | "");
  const efforts = hostSupports(host, 14);
  // A group or scratch task isn't in the project, so the project's own configs don't apply to it.
  const configs = useAvailableConfigs(target.host_id, target.profile_id, inProject);
  // A subproject's tasks start out with its config.
  const [configPref, setConfigPref] = useState(() => subproject?.claude_config_id ?? localStorage.getItem(configKey(prefId)) ?? "");
  const config = configs.some((c) => c.id === configPref) ? configPref : (configs[0]?.id ?? "");
  const pickConfig = configs.length > 1;
  const configObj = configs.find((c) => c.id === config);
  const codex = agentOf(configObj) === "codex";
  // Every config's models, as a `!` can send the task to any of them (IA-227).
  const discovery = useConfigsModels(configs);
  const configModels = discovery.models;
  const models = configObj ? configModels[configObj.id] : null;
  const modelList = modelOptions(configObj, models);
  // Models and efforts are the agent's own, so picking another agent starts them over.
  const setConfig = (id: string) => {
    if (agentOf(configs.find((c) => c.id === id)) !== agentOf(configObj)) {
      setModel("");
      setEffort("");
    }
    setConfigPref(id);
  };

  // Tasks to merge before its agent starts (API 24), as `#` and their key.
  const preTokens = resolve({ "/": offered.map(typeWord) });
  const typeTab = typeOf(lastValue(preTokens, "/"));
  const taskType: NewTaskType = typeTab ? typeTab.id : offered[0];
  const deps = hostSupports(host, 24) && !!inProject && taskType !== "scratch";
  const depProject = deps ? inProject : undefined;
  const depTasks = useStore(
    useShallow((s) =>
      depProject
        ? Object.values(s.tasks)
            .filter((t) => t.kind === "task" && t.project_id === depProject.id && !isMerged(t))
            .sort((a, b) => b.number - a.number)
        : [],
    ),
  );
  const depKey = (t: Task) => `${depProject?.key}-${t.number}`;

  // What `!` names: a model of any of the configs, or one's default model (see harnesses.ts). With no configs to pick
  // from, Claude's own config.
  const harnessConfigs: HarnessConfig[] = configs.length
    ? configs.map((c) => ({ id: c.id, name: c.name, agent: agentOf(c), models: modelOptions(c, configModels[c.id]) }))
    : [{ id: "", name: "", agent: "claude", models: modelList }];
  // Claude takes a full model id too (what "Specific model…" was for), in the picked config or the first Claude one.
  const claudeConfig = harnessConfigs.find((c) => c.id === config && c.agent === "claude") ?? harnessConfigs.find((c) => c.agent === "claude");
  const specific: HarnessWord[] = claudeConfig
    ? found
        .filter((t) => t.prefix === "!" && /^claude-[\w.-]+$/i.test(t.word))
        .map((t) => ({ word: t.word.toLowerCase(), harness: { config: claudeConfig.id, model: t.word.toLowerCase() }, label: t.word.toLowerCase() }))
    : [];
  const harnessVocab = [...harnessWords(harnessConfigs, config, DEFAULT_WORD), ...specific];
  const modelVocab = harnessVocab.map((w) => w.word);
  // A task for each harness named (`!opus !gpt-5.5` makes two from one prompt); with none, one in the picked config
  // with the model last picked there.
  const named = harnessesOf(harnessVocab, allValues(resolve({ "!": modelVocab }), "!"));
  const runs: Harness[] = named.length ? named : [{ config, model: codex && isClaudeModel(model) ? "" : model }];
  // Several harnesses make a task each. After only some of them could be made, those left (even one) are made as part
  // of the same set when it's tried again: linked to the others by its id (null on hosts before API 61), in a worktree.
  // Kept with the draft, so closing the dialog (or reloading) before trying again doesn't lose it.
  const [pending, setPending] = useState<PendingFanout | null>(() => saved?.fanout ?? null);
  // Taking all the text out starts over.
  useEffect(() => {
    if (!description.trim()) setPending(null);
  }, [description]);
  const many = runs.length > 1;
  const fanout = many || pending !== null;
  const runConfig = (h: Harness) => configs.find((c) => c.id === h.config);
  // The efforts any of them takes; one that doesn't take the effort picked gets its default.
  const runEfforts = (h: Harness) => effortOptions(runConfig(h), configModels[h.config] ?? null, h.model);
  // Those of the tasks already made too, so a `^` that only they take is still read as one when the rest are made.
  const effortList = efforts ? [...new Set([...runs.flatMap(runEfforts), ...(pending?.efforts ?? [])])] : [];
  const harnessOf = (word: string | undefined) => harnessVocab.find((w) => w.word === word)?.harness;
  const runInherits = (h: Harness) => inheritedModel(runConfig(h), configModels[h.config] ?? null, inProject?.model, profile?.default_model, hostSettings?.default_model);
  // A harness as the "Reads as" row has it: its model (or the one it inherits), and its config where there are several.
  const runLabel = (h: Harness) => {
    const c = harnessConfigs.find((x) => x.id === h.config);
    const inherits = h.model ? undefined : runInherits(h);
    const m = h.model ? (c?.models.find((x) => x.id === h.model)?.label ?? h.model) : inherits ? `default model (${inherits})` : "default model";
    return pickConfig && c ? `${m} · ${c.name}` : m;
  };
  const tokens = resolve({
    "@": atVocab,
    "/": offered.map(typeWord),
    "!": modelVocab,
    ...(efforts ? { "^": [DEFAULT_WORD, ...effortList] } : {}),
    ...(deps ? { "#": depTasks.map(depKey) } : {}),
  });
  const effortAsked = lastValue(tokens, "^");
  const pickedEffort = (effortAsked === undefined ? effort : effortAsked === DEFAULT_WORD ? "" : effortAsked) as Effort | "";
  const dependsOn = allValues(tokens, "#").flatMap((k) => depTasks.filter((t) => depKey(t) === k).map((t) => t.id));
  // What its agent is given: the description without its tokens.
  const text = stripTokens(description, tokens);

  const docType = documentTypeOf(taskType);
  // A subproject's branch is what its tasks branch from, so it and they get worktrees.
  const asSubproject = taskType === "subproject";
  const codeTask = taskType === null || asSubproject;
  const noun = taskType === "scratch" ? "scratch task" : asGroup && !docType ? "group task" : (taskType ?? "task");

  const attach = useAttachmentDraft(target.host_id, hostSupports(host, 18), saved?.files);
  // The Asana tasks it's for (API 57), in the profile it goes in, unless that has Asana turned off.
  const linking = hostSupports(host, LINKS_API) && usesAsana(profile);
  const [links, setLinks] = useState<ExternalLink[]>(saved?.links ?? []);
  const [pickingLink, setPickingLink] = useState(false);
  const hasContent = !!text.trim() || attach.items.length > 0;
  // Saved as it's written, tokens and all (and when it's only tokens, the options they pick). Files still uploading are left out until they're on the host.
  const draftJson =
    description.trim() || attach.files.length || links.length || pending
      ? JSON.stringify({ description, files: attach.files, links, ...(pending ? { fanout: pending } : {}) } satisfies Draft)
      : null;
  useEffect(() => {
    if (draftJson) localStorage.setItem(draft, draftJson);
    else localStorage.removeItem(draft);
  }, [draft, draftJson]);
  // Whether the repo is a git repository can have changed since the board loaded the project
  // (an agent may have run `git init`), and it decides whether new tasks get a worktree.
  useEffect(() => {
    if (!project) return;
    api
      .getProject(project.host_id, project.id)
      .then((p) => useStore.getState().upsertProject({ ...p, host_id: project.host_id }))
      .catch(() => {});
  }, [project?.host_id, project?.id]);
  // Follows the project until it's changed here.
  const [worktreeChoice, setWorktree] = useState<boolean | null>(null);
  const worktreePref = worktreeChoice ?? (!!inProject && worktreesOn(inProject));
  // Tasks made from one prompt each get a worktree too, so their agents don't change the same checkout (as in t3code).
  const worktree = !!inProject && codeTask && (worktreePref || fanout || asSubproject || !!subproject);
  // What can't be made a task for each of several harnesses.
  const fanoutBlock = !fanout
    ? null
    : asSubproject
      ? "A subproject has one agent, so it takes one model."
      : asGroup && !docType
        ? "A group task has one agent, so it takes one model."
        : worktree && inProject?.is_git === false
          ? `${inProject.name} isn't a git repository, so its tasks can't each have their own worktree: pick one model, or make it a scratch task.`
          : null;
  // What a Codex config's models say waits for them: which model a `!` that names none yet is (so a harness isn't left
  // out, with its token sent as text), and whether the effort picked is one a Codex harness's model takes (it's only
  // sent if it is). If they couldn't be fetched, it says so.
  const unknownModels = tokens.filter((t) => t.prefix === "!" && t.value === undefined);
  const asText = unknownModels.map((t) => `!${t.word}`).join(", ");
  const effortWaits = (c: ClaudeConfig) => efforts && !!pickedEffort && runs.some((h) => h.config === c.id);
  const waitsFor = (c: ClaudeConfig) => unknownModels.length > 0 || effortWaits(c);
  const loadingFor = discovery.loading.filter(waitsFor);
  const failedFor = discovery.failed.filter((f) => waitsFor(f.config));
  const configNames = (cs: { name: string }[]) => cs.map((c) => c.name).join(", ");
  const unknown = (cs: ClaudeConfig[]) =>
    unknownModels.length ? `which ${asText} is` : `whether ${cs.length > 1 ? "they take" : "it takes"} ${pickedEffort} effort`;
  const modelsLoading = loadingFor.length > 0;
  const modelsBlock = modelsLoading
    ? `Loading ${configNames(loadingFor)}'s models, to see ${unknown(loadingFor)}…`
    : failedFor.length
      ? `Couldn't load ${configNames(failedFor.map((f) => f.config))}'s models (${failedFor[0].error}), so there's no telling ${unknown(failedFor.map((f) => f.config))}: take ${unknownModels.length ? "it" : "the effort"} out, or open the dialog again to try again.`
      : null;
  const submitBlock = fanoutBlock ?? modelsBlock;
  const [startPref, setStartPref] = useState(() => localStorage.getItem(startKey(prefId)) === "1");
  const start = agents && startPref;
  const setStart = (v: boolean) => {
    setStartPref(v);
    localStorage.setItem(startKey(prefId), v ? "1" : "0");
  };
  const [addAnother, setAddAnother] = useState(() => localStorage.getItem(ADD_ANOTHER_KEY) === "1");
  const changeAddAnother = (v: boolean) => {
    setAddAnother(v);
    localStorage.setItem(ADD_ANOTHER_KEY, v ? "1" : "0");
  };
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // The last task created while "Add another" is on, so there's feedback that it went through (its key as it was made,
  // as the dialog may have moved since).
  const [created, setCreated] = useState<{ key: string; title: string } | null>(null);

  // Somewhere else (by an `@`, or a type that goes elsewhere) brings its own remembered options. Asana tasks go along
  // within the profile, which is where they were found, and files uploaded to another host would be lost.
  const was = useRef({ prefId, ...target });
  const switched = useRef(false);
  useEffect(() => {
    const from = was.current;
    if (from.prefId === prefId) return;
    was.current = { prefId, ...target };
    setModel(localStorage.getItem(modelKey(prefId)) ?? "");
    setEffort((localStorage.getItem(effortKey(prefId)) ?? "") as Effort | "");
    setConfigPref(localStorage.getItem(configKey(prefId)) ?? "");
    setStartPref(localStorage.getItem(startKey(prefId)) === "1");
    setWorktree(null);
    setCreated(null);
    setPending(null);
    switched.current = true;
    if (from.host_id !== target.host_id || from.profile_id !== target.profile_id) setLinks([]);
    if (from.host_id !== target.host_id) attach.clear();
  }, [prefId, target.host_id, target.profile_id]); // eslint-disable-line react-hooks/exhaustive-deps
  // A draft brought back (by Add another) has its files and Asana tasks where its own tokens send it, so they're put
  // back after the move there above has dropped those of where the dialog was.
  // So is the note of the task just created, which the move drops.
  const [restoring, setRestoring] = useState<{ draft: Draft; made: { key: string; title: string } } | null>(null);
  useEffect(() => {
    if (!restoring) return;
    const { draft: theirs, made } = restoring;
    setRestoring(null);
    attach.clear();
    setLinks(theirs.links ?? []);
    setPending(theirs.fanout ?? null);
    if (attach.enabled) attach.restore(theirs.files);
    setCreated(made);
  }, [restoring]); // eslint-disable-line react-hooks/exhaustive-deps

  // Where the caret goes once a change to the text is drawn: at first, after a draft that comes back.
  const caretTo = useRef<number | null>(description.length);
  const edit = (next: string, at: number) => {
    setDescription(next);
    setCaret(at);
    setClosedAt(null);
    caretTo.current = at;
  };
  useLayoutEffect(() => {
    if (caretTo.current === null || !input.current) return;
    input.current.focus();
    input.current.setSelectionRange(caretTo.current, caretTo.current);
    caretTo.current = null;
  }, [description]);
  // Takes tokens out of the text (the "Reads as" row's ×).
  const untoken = (which: (t: Token) => boolean) => {
    const gone = tokens.filter((t) => t.value !== undefined && which(t));
    const next = removeTokens(description, gone);
    edit(next, Math.min(next.length, Math.max(0, caret - gone.filter((t) => t.end <= caret).reduce((n, t) => n + t.end - t.start, 0))));
  };
  // A legend's prefix, typed at the caret, to pick its value from the list.
  const typePrefix = (prefix: TokenPrefix) => {
    const space = caret > 0 && !/\s/.test(description[caret - 1]) ? " " : "";
    edit(description.slice(0, caret) + space + prefix + description.slice(caret), caret + space.length + 1);
  };

  // Ctrl+Enter in an `@` being typed takes it as it is first (and what it brings, from the next render on), so what's
  // created is what the text says.
  const [settling, setSettling] = useState(0);
  const submit = async () => {
    if (heldBack) {
      setClosedAt(heldBack.start);
      setSettling(1);
      return;
    }
    if (!hasContent || busy || attach.uploading || submitBlock) return;
    setBusy(true);
    setErr(null);
    // A task for each harness, one after another, so a failure leaves the rest to try again.
    const tasks: Task[] = [];
    const fanoutId = pending ? pending.id : fanout && hostSupports(host, 61) ? newFanoutId() : null;
    const shared = fanoutId ? { fanout_id: fanoutId } : {};
    try {
      for (const run of runs) {
        // The server titles it from the description.
        const runEffort = efforts && pickedEffort && runEfforts(run).includes(pickedEffort) ? pickedEffort : undefined;
        const common = {
          description: withAttachments(text, attach.files),
          start,
          status,
          model: run.model || undefined,
          effort: runEffort,
          ...(pickConfig ? { claude_config_id: run.config } : {}),
          ...(linking && links.length ? { external_links: links } : {}),
        };
        try {
          tasks.push(
            noProject
              ? await api.createScratchTask(target.host_id, target.profile_id, { ...common, ...shared })
              : asGroup && group
                ? await api.createGroupTask(target.host_id, target.profile_id, { ...common, ...shared, group, ...(docType ? { task_type: docType } : {}) })
                : await api.createTask(project!.host_id, project!.id, {
                    ...common,
                    ...shared,
                    use_worktree: worktree,
                    ...(subproject ? { parent_id: subproject.id } : {}),
                    // Sent as the flag, which hosts before API 51 take too.
                    ...(asSubproject ? { subproject: true } : taskType ? { task_type: taskType } : {}),
                    ...(deps && dependsOn.length ? { depends_on: dependsOn } : {}),
                  }),
          );
        } catch (e) {
          if (!tasks.length) throw e;
          // Those made are taken out of the text, so trying again makes the others.
          const done = runs.slice(0, tasks.length);
          untoken((t) => t.prefix === "!" && done.some((h) => sameHarness(harnessOf(t.value), h)));
          const keys = tasks.map((t) => `${keyPrefix(t, inProject)}-${t.number}`);
          setPending({ id: fanoutId, made: [...(pending?.made ?? []), ...keys], efforts: effortList });
          setErr(`Made ${keys.join(", ")}, but not the one with ${runLabel(run)}: ${(e as Error).message}`);
          setBusy(false);
          return;
        }
      }
      setPending(null);
      // One harness is what's picked from then on; several (or what's left of them) leave what was picked as it was.
      const only = fanout ? null : runs[0];
      if (only) {
        const m = named.length ? only.model : model;
        setModel(m);
        localStorage.setItem(modelKey(prefId), m);
        if (only.config !== config) setConfigPref(only.config);
        if (pickConfig) localStorage.setItem(configKey(prefId), only.config);
      }
      setEffort(pickedEffort);
      if (efforts) localStorage.setItem(effortKey(prefId), pickedEffort);
      // Where it went is where the next one starts, where there's a choice.
      if (projects?.length) localStorage.setItem(PROJECT_KEY, prefId);
      localStorage.removeItem(draft);
      if (!addAnother) return onClose();
      const made = { key: tasks.map((t) => `${keyPrefix(t, inProject)}-${t.number}`).join(", "), title: tasks[0].title };
      setCreated(made);
      // The dialog starts there now too, as it would opened again, so the next one's draft is kept there. A draft
      // already there comes back, rather than being written over.
      const there = projects?.length ? draftKey(prefId, subproject?.id) : draft;
      const theirs = there !== draft ? loadDraft(there) : null;
      if (projects?.length) setBase({ projectId: project?.id, noProject, asGroup });
      attach.clear();
      if (theirs) {
        edit(theirs.description, theirs.description.length);
        setRestoring({ draft: theirs, made });
      } else {
        // Or it keeps the same options (its tokens) for the next one.
        const kept = tokens.flatMap((t) => (t.value !== undefined ? [description.slice(t.start, t.end)] : [])).join(" ");
        edit(kept && `${kept} `, kept ? kept.length + 1 : 0);
        setLinks([]);
      }
      setBusy(false);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };

  // What's offered for each prefix as it's typed.
  const inherited = inheritedModel(configObj, models, inProject?.model, profile?.default_model, hostSettings?.default_model);
  useEffect(() => {
    const justSwitched = switched.current;
    switched.current = false;
    if (!settling) return;
    // Somewhere else's remembered options are only in place after another render.
    if (justSwitched) return setSettling((n) => n + 1);
    setSettling(0);
    submit();
  });
  const suggestions: Record<TokenPrefix, Suggestion[]> = {
    "/": typeTabs.map((t) => ({ value: typeWord(t.id), label: t.label, hint: t.hint })),
    "@": subproject
      ? []
      : [
          ...(projects ?? []).map((p, i) => ({ value: placeNames[i], label: p.name, hint: hostCount > 1 ? hosts.find((h) => h.id === p.host_id)?.name : undefined })),
          ...(group ? [{ value: GROUP_WORD, label: `Group task (${group})`, hint: "Plans the work across the group's projects" }] : []),
          ...(scratch ? [{ value: NONE_WORD, label: `No project (${scratch.name})`, hint: "A scratch task, with no repository" }] : []),
        ],
    // Each `!` makes a task with its model, so naming several makes a task for each (IA-227).
    "!": harnessVocab
      .filter((w) => !specific.includes(w))
      .map((w) => ({
        value: w.word,
        label: w.word === DEFAULT_WORD && !pickConfig ? (inherited ? `Default model (${inherited})` : "Default model") : w.label,
        hint: named.length ? "Another ! makes another task from this prompt, with that model" : undefined,
      })),
    "^": efforts
      ? [
          { value: DEFAULT_WORD, label: hostSettings?.default_effort ? `Default effort (${hostSettings.default_effort})` : "Default effort" },
          ...effortList.map((e) => ({ value: e, label: `${e} effort` })),
        ]
      : [],
    "#": depTasks.map((t) => ({ value: depKey(t), label: t.title })),
  };
  // The one that's what's typed comes first, then those starting with it, then those whose name has it.
  const query = completing?.query.toLowerCase() ?? "";
  const matches = completing
    ? [
        ...suggestions[completing.prefix].filter((s) => s.value.toLowerCase() === query),
        ...suggestions[completing.prefix].filter((s) => s.value.toLowerCase() !== query && s.value.toLowerCase().startsWith(query)),
        ...(query ? suggestions[completing.prefix].filter((s) => !s.value.toLowerCase().startsWith(query) && s.label.toLowerCase().includes(query)) : []),
      ].slice(0, 8)
    : [];
  const listOpen = !!completing && matches.length > 0;
  const [hl, setHl] = useState(0);
  const lit = Math.min(hl, matches.length - 1);
  const pick = (s: Suggestion) => {
    if (!completing) return;
    const r = insertCompletion(description, completing, completing.prefix, s.value);
    edit(r.text, r.caret);
  };

  // The highlighting behind the editor, sized to its text area (without a scrollbar) and scrolled with it.
  const mirror = useRef<HTMLDivElement>(null);
  const marker = useRef<HTMLSpanElement>(null);
  const [listAt, setListAt] = useState<{ top: number; left: number } | null>(null);
  const [scrolled, setScrolled] = useState(0);
  useLayoutEffect(() => {
    const ta = input.current;
    const m = mirror.current;
    if (!ta || !m) return;
    const fit = () => {
      m.style.width = `${ta.clientWidth}px`;
      m.style.height = `${ta.clientHeight}px`;
      m.scrollTop = ta.scrollTop;
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(ta);
    return () => ro.disconnect();
  }, []);
  useLayoutEffect(() => {
    const ta = input.current;
    const m = mirror.current;
    if (m && ta) m.scrollTop = ta.scrollTop;
    const k = marker.current;
    const next = listOpen && k && m && ta ? { top: k.offsetTop + k.offsetHeight - m.scrollTop + 2, left: Math.max(0, Math.min(k.offsetLeft, ta.clientWidth - 288)) } : null;
    setListAt((cur) => (cur?.top === next?.top && cur?.left === next?.left ? cur : next));
  }, [listOpen, completing?.start, description, scrolled]);
  const highlighted: ReactNode[] = [];
  {
    let at = 0;
    const marks = [...found.map((t) => ({ at: t.start, token: t })), ...(listOpen ? [{ at: completing!.start, token: null }] : [])].sort((a, b) => a.at - b.at || (a.token ? 1 : -1));
    for (const { token: t, at: s } of marks) {
      highlighted.push(description.slice(at, s));
      if (!t) {
        highlighted.push(<span key="caret" ref={marker} />);
        at = s;
        continue;
      }
      const known = tokens.find((x) => x.start === t.start);
      // The token being typed isn't marked until it's settled.
      const settled = !!known;
      highlighted.push(
        <span
          key={t.start}
          className={clsx(
            settled && "rounded-[3px]",
            known?.value !== undefined ? "bg-accent/20 text-[#c8c8ff] ring-1 ring-accent/30" : settled && "bg-amber-500/10 text-amber-300 ring-1 ring-amber-500/30",
          )}
        >
          {description.slice(t.start, t.end)}
        </span>,
      );
      at = t.end;
    }
    highlighted.push(description.slice(at));
  }

  // The prefixes that can set something here, for the legend and the placeholder, with an example of each.
  const example: Partial<Record<TokenPrefix, string>> = {
    ...(typeTabs.length > 1 ? { "/": typeTabs.some((t) => t.id === "plan") ? "plan" : typeWord(typeTabs.find((t) => t.id !== offered[0])?.id ?? null) } : {}),
    ...(atVocab.length ? { "@": placeNames[(projects ?? []).findIndex((p) => p.id !== project?.id)] ?? atVocab[0] } : {}),
    "!": modelList[0]?.id ?? DEFAULT_WORD,
    ...(efforts ? { "^": effortList.includes("high") ? "high" : (effortList[0] ?? DEFAULT_WORD) } : {}),
    ...(deps ? { "#": depTasks[0] ? depKey(depTasks[0]) : `${depProject!.key}-1` } : {}),
  };
  const help = TOKEN_HELP.filter((h) => example[h.prefix]);
  const tokenHint = `Type ${help.map((h, i) => `${i === help.length - 1 && i > 0 ? "or " : ""}${h.prefix} for ${h.asks}`).join(", ")}.`;

  // What the tokens set, and what a token set (its × takes it out).
  const setBy = (prefix: TokenPrefix) => tokens.some((t) => t.prefix === prefix && t.value !== undefined);
  const removeKind = (prefix: TokenPrefix) => () => untoken((t) => t.prefix === prefix);
  const typeInfo = typeTabs.find((t) => t.id === taskType);
  const modelLabel = (m: string) => modelList.find((x) => x.id === m)?.label ?? m;
  const where = subproject
    ? `${project!.key}-${subproject.number} ${subproject.title}`
    : noProject
      ? scratch!.name
      : asGroup
        ? docType ? `the ${group} group` : group
        : `${project!.name}${hostCount > 1 && projects?.some((p) => p.host_id !== project!.host_id) ? ` (${host?.name})` : ""}`;

  return (
    <Modal
      title={
        <span>
          New {noun} <span className="font-normal text-muted">{asGroup ? "for" : "in"} {where}</span>
        </span>
      }
      onClose={onClose}
      // Not while the Asana dialog is open over it, whose Enter (with Ctrl or Cmd too) is its own.
      onSubmit={pickingLink ? undefined : submit}
      width="max-w-xl"
    >
      <form
        className="space-y-3"
        {...attach.dropProps}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div
          className={clsx(
            "relative rounded-md border border-line bg-panel focus-within:border-accent/60 focus-within:ring-2 focus-within:ring-accent/15",
            attach.dragging && "border-accent/60 bg-accent/5",
          )}
        >
          <div ref={mirror} aria-hidden className={clsx(EDITOR_TEXT, "pointer-events-none absolute top-0 left-0 overflow-hidden text-fg")}>
            {highlighted}
            {"\n"}
          </div>
          <textarea
            ref={input}
            autoFocus
            rows={8}
            spellCheck={false}
            aria-label="Description"
            placeholder={`${
              noProject
                ? "Ask anything, or describe what to try out or look into (markdown). Its agent works in its own folder, with no repository, and can use the board."
                : taskType === "scratch"
                  ? "Ask anything about the project, or describe what to look into or try out (markdown). Its agent works in its own folder, reads the repository and can use the board."
                  : taskType === "plan"
                    ? "Describe what to plan. Its agent looks into it and writes an HTML plan that you iterate on together (markdown)."
                    : taskType === "artifact"
                      ? "Describe the artifact: what it's for and what it should show or do (markdown). Its agent designs it as an HTML page, kept and shown in the task."
                      : taskType === "diagram"
                        ? "Describe what to diagram: the flow, structure or sequence to show (markdown). Its agent draws it as a Mermaid diagram."
                        : asGroup
                          ? "Describe the work. Its agent plans it across the group's projects and creates their tasks (markdown)."
                          : asSubproject
                            ? "Describe the subproject. Its agent plans it as a series of small tasks, which merge into its branch (markdown)."
                            : "Describe the task. This becomes the agent's instructions (markdown), and a title is written from it."
            } ${tokenHint}`}
            value={description}
            onChange={(e) => {
              setHl(0);
              setDescription(e.target.value);
              setCaret(e.target.selectionStart);
              setClosedAt(null);
            }}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onScroll={(e) => {
              if (mirror.current) mirror.current.scrollTop = e.currentTarget.scrollTop;
              setScrolled(e.currentTarget.scrollTop);
            }}
            onKeyDown={(e) => {
              if (!listOpen || e.nativeEvent.isComposing) return;
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                setHl((lit + (e.key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length);
              } else if ((e.key === "Enter" && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) || (e.key === "Tab" && !e.shiftKey)) {
                e.preventDefault();
                pick(matches[lit]);
              } else if (e.key === "Escape") {
                // Closes the list, not the dialog.
                e.preventDefault();
                e.stopPropagation();
                setClosedAt(completing!.start);
              }
            }}
            onPaste={attach.onPaste}
            className={clsx(EDITOR_TEXT, "relative block w-full resize-y bg-transparent text-transparent caret-fg outline-none selection:bg-accent/30 placeholder:text-faint")}
          />
          {listOpen && listAt && (
            <div
              role="listbox"
              aria-label={TOKEN_HELP.find((h) => h.prefix === completing!.prefix)!.what}
              className="absolute z-10 w-72 rounded-lg border border-line-strong bg-panel-2 p-1 shadow-xl shadow-black/50"
              style={{ top: listAt.top, left: listAt.left }}
              // Keeps the editor focused, so picking doesn't close the list first.
              onMouseDown={(e) => e.preventDefault()}
            >
              <div className="px-2 pt-1 pb-1 text-[10.5px] font-semibold tracking-wider text-faint uppercase">
                {{ "/": "Type", "@": "Where it goes", "!": "Model", "^": "Effort", "#": "Depends on" }[completing!.prefix]}
              </div>
              {matches.map((s, i) => (
                <button
                  key={s.value}
                  type="button"
                  role="option"
                  aria-selected={i === lit}
                  title={s.hint}
                  onMouseEnter={() => setHl(i)}
                  onClick={() => pick(s)}
                  className={clsx("flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[12.5px]", i === lit ? "bg-raised text-fg" : "text-muted")}
                >
                  <code className="shrink-0 font-mono text-[12px] text-accent">
                    {completing!.prefix}
                    {s.value}
                  </code>
                  <span className="truncate">{s.label}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1.5 text-[12px] text-faint" aria-label="Reads as">
          <span className="mr-0.5">Reads as</span>
          {typeInfo && (
            <ReadsChip
              icon={asGroup && !docType ? <Folder size={12} /> : typeInfo.icon}
              label={asGroup && !docType ? "Group task" : typeInfo.label}
              title={typeInfo.hint}
              onRemove={setBy("/") ? removeKind("/") : undefined}
              removeTitle="Remove the type"
            />
          )}
          <ReadsChip
            icon={noProject ? <NotebookPen size={12} /> : asGroup ? <Folder size={12} /> : <FolderGit2 size={12} />}
            label={noProject ? `No project (${scratch!.name})` : asGroup ? group : subproject ? `${project!.key}-${subproject.number}` : project!.name}
            onRemove={setBy("@") ? removeKind("@") : undefined}
            removeTitle="Go back to where it started"
          />
          {named.length ? (
            // One for each task it makes, with the model it names.
            named.map((h) => (
              <ReadsChip
                key={`${h.config}/${h.model}`}
                icon={<Cpu size={12} />}
                label={runLabel(h)}
                onRemove={() => untoken((t) => t.prefix === "!" && sameHarness(harnessOf(t.value), h))}
                removeTitle={fanout ? "Don't make a task with this model" : "Remove the model"}
              />
            ))
          ) : model ? (
            <ReadsChip
              icon={<Cpu size={12} />}
              label={modelLabel(runs[0].model || model)}
              title={codex && !runs[0].model ? "A Claude model, which Codex doesn't run: it uses the default" : undefined}
              onRemove={() => setModel("")}
              removeTitle="Use the default model"
            />
          ) : (
            <ReadsChip dashed label={inherited ? `default model (${inherited})` : "default model"} />
          )}
          {efforts &&
            (pickedEffort ? (
              <ReadsChip
                icon={<Gauge size={12} />}
                label={`${pickedEffort} effort`}
                onRemove={setBy("^") ? removeKind("^") : () => setEffort("")}
                removeTitle={setBy("^") ? "Remove the effort" : "Use the default effort"}
              />
            ) : (
              <ReadsChip
                dashed
                label={hostSettings?.default_effort ? `default effort (${hostSettings.default_effort})` : "default effort"}
                onRemove={setBy("^") ? removeKind("^") : undefined}
              />
            ))}
          {dependsOn.map((id) => {
            const t = depTasks.find((x) => x.id === id)!;
            return (
              <ReadsChip
                key={id}
                icon={<Link2 size={12} />}
                label={`after ${depKey(t)}`}
                title={`Its agent starts once ${depKey(t)} (${t.title}) is merged`}
                onRemove={() => untoken((x) => x.prefix === "#" && x.value === depKey(t))}
              />
            );
          })}
        </div>
        <div className="flex flex-wrap gap-x-3.5 gap-y-1 text-[11.5px] text-faint">
          {help.map((h) => (
            <button key={h.prefix} type="button" className="hover:text-muted" title={`Type ${h.prefix} for ${h.asks}`} onClick={() => typePrefix(h.prefix)}>
              <code className="font-mono text-muted">
                {h.prefix}
                {example[h.prefix]}
              </code>{" "}
              {h.what}
            </button>
          ))}
        </div>
        <DraftAttachments draft={attach} hostId={target.host_id} />
        <div className="flex flex-wrap items-center gap-x-5 gap-y-3 pt-1">
          {!subproject && inProject && taskType === null && !fanout && <Toggle checked={worktree} onChange={setWorktree} label="Own git worktree" />}
          {agents && <Toggle checked={start} onChange={setStart} label="Start agent now" />}
          {pickConfig && <ConfigSelect className={pickerClass} configs={configs} value={config} onChange={setConfig} />}
          <div className="-my-1 ml-auto flex items-center gap-1">
            {linking && (
              <button
                type="button"
                onClick={() => setPickingLink(true)}
                title="Link the Asana task this is for"
                className="flex h-7 items-center justify-center gap-1.5 rounded-md px-2 text-[12px] text-faint hover:bg-white/5 hover:text-fg"
              >
                <AsanaIcon size={13} /> Link Asana task
              </button>
            )}
            <AttachButton draft={attach} label="Attach files" />
          </div>
        </div>
        {linking && links.length > 0 && <LinkList chips links={links} onRemove={(l) => setLinks((ls) => ls.filter((x) => x !== l))} />}
        {asGroup && !docType && (
          <div className="text-[12px] text-muted">
            In no project: it shows on this group's board, and its agent breaks the work into tasks in{" "}
            {projects?.map((p) => p.name).join(", ")} and follows them. It doesn't change the repositories itself.
          </div>
        )}
        {noProject && (
          <div className="text-[12px] text-muted">
            In no project: it shows on the {scratch!.name} board{hostCount > 1 ? ` and runs on ${host?.name}` : ""}. Its agent works in the task's own folder, with
            no repository, and can look across the board and create and start tasks.
          </div>
        )}
        {taskType === "scratch" && inProject && (
          <div className="text-[12px] text-muted">
            Its agent works in the task's own folder and reads{" "}
            {subproject ? "the repository and the subproject's worktree without changing them" : "the repository without changing it"}, and can look across the
            board and create and start tasks{subproject ? " (in the subproject)" : ""}. There's no worktree, review or merge.
          </div>
        )}
        {docType && (
          <div className="text-[12px] text-muted">
            {asGroup
              ? `In no project: it shows on this group's board, and its agent reads ${projects?.map((p) => p.name).join(", ")} as it writes the ${docType}.`
              : `Its agent reads the repository and writes the ${docType} in the task's own folder, without changing the code.`}{" "}
            The task shows it as it's written; reply in the task to iterate on it.
          </div>
        )}
        {(asSubproject || (subproject && taskType === null)) && (
          <div className="text-[12px] text-muted">
            {subproject
              ? `Branches from ${subproject.branch ?? "the subproject's branch"} and merges back into it.`
              : "It gets its own worktree and thread, and a board of tasks: each branches from the subproject's branch and merges back into it, and the subproject is merged as a whole through its own pull request."}
          </div>
        )}
        {fanout && (
          <div className={clsx("text-[12px]", fanoutBlock ? "text-amber-300" : "text-muted")}>
            {fanoutBlock ??
              (many
                ? `Makes ${runs.length} ${noun}s from this prompt, one with each model${worktree ? ", each in its own worktree" : ""}${pending ? `, with ${pending.made.join(", ")}` : ", so you can compare what they do"}. Their cards say which is which.`
                : `Makes the ${noun} left from this prompt, with ${pending!.made.join(", ")}${worktree ? ", in its own worktree" : ""}. Their cards say which is which.`)}
          </div>
        )}
        {modelsBlock && <div className={clsx("text-[12px]", modelsLoading ? "text-muted" : "text-amber-300")}>{modelsBlock}</div>}
        {err && <div className="text-xs text-red-400">{err}</div>}
        <div className="-mx-4 flex items-center justify-end gap-2 border-t border-line px-4 pt-4">
          <span className="mr-auto flex min-w-0 items-center gap-3">
            <Toggle checked={addAnother} onChange={changeAddAnother} label="Add another" />
            {created && (
              <span className="truncate text-xs text-muted" title={created.title}>
                Created {created.key}
              </span>
            )}
          </span>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={busy || attach.uploading || !hasContent || !!submitBlock}>
            {many
              ? start && deps && dependsOn.length
                ? `Create & queue ${runs.length}`
                : start
                  ? `Create & start ${runs.length}`
                  : `Create ${runs.length} ${noun}s`
              : start && deps && dependsOn.length
                ? "Create & queue"
                : start
                  ? "Create & start"
                  : `Create ${noun}`}
            <span className="translate-y-px text-[11px] font-normal text-white/60">{SUBMIT_KEYS}</span>
          </Button>
        </div>
      </form>
      {pickingLink && (
        <AsanaPicker
          hostId={target.host_id}
          profileId={target.profile_id}
          linked={links}
          onClose={() => setPickingLink(false)}
          onPick={(t) => {
            setPickingLink(false);
            setLinks((ls) => [...ls, asanaLink(t)]);
            // Nothing written yet (tokens aside): the Asana task says what to do.
            const about = [t.name, t.notes.trim()].filter(Boolean).join("\n\n");
            const next = description.trim() ? `${description.trimEnd()}\n\n${about}` : about;
            if (!text.trim()) edit(next, next.length);
            else input.current?.focus();
          }}
        />
      )}
    </Modal>
  );
}

export const TaskRow = memo(function TaskRow({ task, project, progress, onMenu }: { task: Task; project?: Project; progress?: Progress; onMenu?: OnMenu }) {
  const open = usePanel()?.taskId === task.id;
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
      className={clsx("flex cursor-pointer items-start gap-3 px-4 py-2.5 transition-colors outline-none hover:bg-raised focus-visible:ring-1 focus-visible:ring-accent focus-visible:ring-inset", open ? "bg-raised shadow-[inset_2px_0_0_var(--color-accent)]" : "bg-panel/60")}
    >
      <span className="pt-0.5">
        <StatusIcon status={task.status} />
      </span>
      <span className="w-14 shrink-0 pt-px font-mono text-[11.5px] text-faint">
        {keyPrefix(task, project)}-{task.number}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] text-fg">{task.title}</div>
        {task.attention_reason && task.status === "needs_attention" && (
          <div className="mt-0.5 line-clamp-2 text-[12px] text-amber-200/80">{task.attention_reason}</div>
        )}
        {agentWaiting(task)?.reason && <div className="mt-0.5 truncate text-[12px] text-muted">{agentWaiting(task)!.reason}</div>}
      </div>
      <div className="flex shrink-0 items-center gap-3 pt-px text-[11.5px] text-faint">
        <TaskMarks task={task} />
        {task.subproject && <SubprojectBadge progress={progress} />}
        {task.subproject && <SubprojectBoardButton task={task} />}
        {isGroupTask(task) && <GroupTaskBadge progress={progress} />}
        {task.task_type && <TaskTypeBadge type={task.task_type} progress={isGroupTask(task) ? undefined : progress} />}
        {task.running && <RunState task={task} />}
        {mergeQueued(task) && (
          <span className="flex items-center gap-1 text-muted" title="Waits for the merge in progress in this project">
            <Clock size={11} /> queued to merge
          </span>
        )}
        <DependencyBadge task={task} project={project} />
        {task.fanout_id && <FanoutBadge task={task} />}
        <ReviewBadge task={task} />
        <ResolutionBadge task={task} />
        {showsPreview(task) && <PreviewDot url={task.preview_url!} label />}
        {task.branch && <BranchIcon branch={task.branch} className={task.worktree_state === "ready" ? "text-muted" : ""} />}
        {task.pr_url && <PrIcon url={task.pr_url} className="text-muted" />}
        {task.external_links?.map((l) => <ExternalLinkIcon key={l.id} link={l} />)}
        {cost(task.cost_usd) && <span>{cost(task.cost_usd)}</span>}
        <span className="w-14 text-right">
          <ActivityTime task={task} />
        </span>
      </div>
    </div>
  );
});

type BoardView = "board" | "list";
const VIEW_KEY = "ia.boardView";
// Whether the kanban board's Backlog column is open (it starts collapsed), on this client.
const BACKLOG_KEY = "ia.board.backlog";
// Whether the list view's Archived section is open (it starts collapsed), on this client.
const ARCHIVED_KEY = "ia.board.archived";
// How wide a board has to be for its search, filter and sort controls to go in its header (see TaskBoard).
const WIDE_BOARD = 1180;
// How the boards sort their tasks, on this client.
const SORT_KEY = "ia.board.sort";
// Each board's search and filters, in this tab (so they last over a reload, and don't stay on forever).
const queryKey = (board: string) => `ia.board.query.${board}`;

function loadQuery(board: string): BoardQuery {
  try {
    const q = JSON.parse(sessionStorage.getItem(queryKey(board)) ?? "null");
    if (!q || typeof q !== "object") return EMPTY_QUERY;
    const list = (v: unknown) => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);
    return { search: typeof q.search === "string" ? q.search : "", statuses: list(q.statuses) as Status[], kinds: list(q.kinds) as TaskKind[], projects: list(q.projects), flags: list(q.flags) as BoardQuery["flags"] };
  } catch {
    return EMPTY_QUERY;
  }
}

/** A subproject's own board: its tasks, beside a link to its agent's thread. */
export function SubprojectBoard({ taskId }: { taskId: string }) {
  const task = useStore((s) => s.tasks[taskId]);
  if (!task) return <div className="p-8 text-muted">Loading subproject…</div>;
  if (!task.project_id || !task.subproject) return <div className="p-8 text-muted">This task isn't a subproject.</div>;
  return <Board projectId={task.project_id} subproject={task} />;
}

/** A project's board, or with `subproject`, that subproject's board. */
export function Board({ projectId, subproject }: { projectId: string; subproject?: Task }) {
  const project = useStore((s) => s.projects.find((p) => p.id === projectId));
  const hostCount = useStore((s) => s.hosts.length);
  const host = useStore((s) => s.hosts.find((h) => h.id === project?.host_id));
  const archived = useStore((s) => (project ? undefined : s.archived.find((p) => p.id === projectId)));
  const projects = useMemo(() => (project ? [project] : []), [project]);
  if (archived)
    return (
      <div className="p-8 text-muted">
        {archived.name} is archived.{" "}
        <button className="text-accent hover:underline" onClick={() => navigate({ name: "settings" })}>
          Unarchive it in Settings
        </button>{" "}
        to see its board.
      </div>
    );
  if (!project) return <div className="p-8 text-muted">Project not found.</div>;
  const boardKey = subproject ? `subproject:${project.host_id}:${subproject.id}` : `project:${project.host_id}:${project.id}`;
  return (
    <TaskBoard
      key={boardKey}
      boardKey={boardKey}
      hostId={project.host_id}
      projects={projects}
      subproject={subproject}
      header={({ controls, newTask }) =>
        subproject ? (
          <header className="drag flex h-12 shrink-0 items-center gap-2 border-b border-line px-3">
            <IconButton className="no-drag" title={`Back to ${project.name}`} onClick={() => navigate({ name: "board", projectId })}>
              <ChevronLeft size={16} />
            </IconButton>
            <button className="no-drag text-[12.5px] text-muted hover:text-fg" onClick={() => navigate({ name: "board", projectId })}>
              {project.name}
            </button>
            <ChevronRight size={12} className="text-faint" />
            <Layers size={14} className="shrink-0 text-accent" />
            <span className="font-mono text-[12px] text-faint">
              {project.key}-{subproject.number}
            </span>
            <h1 className="min-w-0 truncate text-[13.5px] font-medium">{subproject.title}</h1>
            {subproject.branch && (
              <span className="hidden min-w-0 items-center gap-1 text-[11.5px] text-faint md:flex" title="Its tasks branch from and merge into this branch">
                <GitBranch size={11} className="shrink-0" />
                <span className="truncate font-mono">{subproject.branch}</span>
              </span>
            )}
            <div className="no-drag ml-auto flex items-center gap-1.5">
              {controls}
              <Button size="sm" variant="ghost" onClick={() => openTask(subproject.id)} title="The subproject's own agent, which plans and coordinates its tasks">
                {subproject.running ? <RunningDot /> : <MessagesSquare size={14} />} Thread
              </Button>
              <Button size="sm" variant="primary" onClick={newTask}>
                <Plus size={14} /> New task
              </Button>
            </div>
          </header>
        ) : (
          <header className="drag flex h-12 shrink-0 items-center gap-3 border-b border-line px-5">
            <FolderGit2 size={16} className="text-muted" />
            <div className="flex min-w-0 items-baseline gap-2">
              <h1 className="shrink-0 text-[14px] font-semibold">{project.name}</h1>
              <span className="truncate font-mono text-[11.5px] text-faint">
                {hostCount > 1 && <span className="mr-1.5 font-sans text-muted">{host?.name} ·</span>}
                {project.repo_path}
              </span>
            </div>
            <div className="no-drag ml-auto flex items-center gap-1.5">
              {controls}
              <IconButton title="Project settings" onClick={() => navigate({ name: "projectSettings", projectId })}>
                <Settings2 size={15} />
              </IconButton>
              <Button size="sm" variant="primary" onClick={newTask}>
                <Plus size={14} /> New task
              </Button>
            </div>
          </header>
        )
      }
    />
  );
}

/** A group's board: the tasks of all its projects together. */
export function GroupBoard({ hostId, group }: { hostId: string; group: string }) {
  const all = useStore((s) => s.projects);
  const hostCount = useStore((s) => s.hosts.length);
  const host = useHost(hostId);
  const projects = useMemo(() => groupProjects(all, hostId, group), [all, hostId, group]);
  // Ungrouping or deleting its last project leaves its group tasks, which keep the board.
  const hasTasks = useStore((s) => groupTasks(Object.values(s.tasks), hostId, group).length > 0);
  if (!projects.length && !hasTasks) return <div className="p-8 text-muted">Group not found.</div>;
  return (
    <TaskBoard
      key={`group:${hostId}:${group}`}
      boardKey={`group:${hostId}:${group}`}
      hostId={hostId}
      projects={projects}
      group={group}
      notice={
        !projects.length &&
        `${group} has no projects any more, so only its group tasks are left. Their agents can still run, and you can delete them; put a project back in the group to plan in it again.`
      }
      header={({ controls, newTask }) => (
        <header className="drag flex h-12 shrink-0 items-center gap-3 border-b border-line px-5">
          <Folder size={16} className="shrink-0 text-muted" />
          <div className="flex min-w-0 items-baseline gap-2">
            <h1 className="shrink-0 text-[14px] font-semibold">{group}</h1>
            <span className="min-w-0 truncate text-[11.5px] text-faint">
              {hostCount > 1 && <span className="mr-1.5 text-muted">{host?.name} ·</span>}
              {projects.map((p, i) => (
                <span key={p.id}>
                  {i > 0 && ", "}
                  <button className="no-drag hover:text-fg" title={`Open the ${p.name} board`} onClick={() => navigate({ name: "board", projectId: p.id })}>
                    {p.name}
                  </button>
                </span>
              ))}
            </span>
          </div>
          <div className="no-drag ml-auto flex items-center gap-1.5">
            {controls}
            {projects.length > 0 && (
              <Button size="sm" variant="primary" onClick={newTask}>
                <Plus size={14} /> New task
              </Button>
            )}
          </div>
        </header>
      )}
    />
  );
}

/**
 * The tasks of `projects` by status, as columns or a list; with `subproject`, that subproject's
 * tasks. A group's board may have no projects left, only group tasks. A profile's board spans
 * hosts, and may have no projects, only scratch tasks.
 */
function TaskBoard({
  boardKey,
  hostId,
  projects,
  subproject,
  group,
  profiles,
  targets,
  scratch,
  notice,
  header,
}: {
  /** Which board it is, to keep its search and filters by (each board has its own; give it as the `key` too). */
  boardKey: string;
  /** Where `projects` are, for a project's, subproject's or group's board. */
  hostId?: string;
  projects: Project[];
  subproject?: Task;
  /** The group `projects` are, whose group tasks show too. */
  group?: string;
  /** For a profile's board, the profile on each host (by `<host>:<profile id>`): its tasks in no project show too. */
  profiles?: Set<string>;
  /** The projects a new task can go in, if not `projects`. */
  targets?: Project[];
  /** Where its scratch tasks go, for a profile's board. */
  scratch?: Profile | null;
  /** Shown above the tasks. */
  notice?: ReactNode;
  /** The header, given the search, filter, sort and view controls to show in it. */
  header: (slots: { controls: ReactNode; newTask: () => void }) => ReactNode;
}) {
  const choices = targets ?? projects;
  const project = choices[0] as Project | undefined;
  const hosts = useStore((s) => s.hosts);
  const hostOf = (t: Task) => hosts.find((h) => h.id === t.host_id);
  const all = useStore((s) => s.tasks);
  const upsertTask = useStore((s) => s.upsertTask);
  const [newIn, setNewIn] = useState<Status | null>(null);
  const [view, setView] = useState<BoardView>(() => (localStorage.getItem(VIEW_KEY) === "list" ? "list" : "board"));
  const [collapsed, setCollapsed] = useState<Set<Status>>(() => new Set());
  const [backlogOpen, setBacklogOpen] = useState(() => localStorage.getItem(BACKLOG_KEY) === "open");
  const [archivedOpen, setArchivedOpen] = useState(() => localStorage.getItem(ARCHIVED_KEY) === "open");
  const [dropTarget, setDropTarget] = useState<{ status: Status; before: string | null } | null>(null);
  const [dropErr, setDropErr] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; taskId: string } | null>(null);
  const [picking, setPicking] = useState<Task | null>(null);
  const [query, setQuery] = useState(() => loadQuery(boardKey));
  useEffect(() => {
    if (isFiltering(query)) sessionStorage.setItem(queryKey(boardKey), JSON.stringify(query));
    else sessionStorage.removeItem(queryKey(boardKey));
  }, [boardKey, query]);
  const [sort, setSort] = useState<SortKey>(() => {
    const s = localStorage.getItem(SORT_KEY);
    return isSortKey(s) ? s : "manual";
  });
  const changeSort = (s: SortKey) => {
    setSort(s);
    localStorage.setItem(SORT_KEY, s);
  };
  // The search, filter and sort controls go in the header when the board is wide enough for them beside
  // its title and buttons (a subproject's has the most), and otherwise in a row of their own below it.
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const [wide, setWide] = useState(true);
  useLayoutEffect(() => {
    if (!root) return;
    const fits = (width: number) => setWide(width >= WIDE_BOARD);
    fits(root.getBoundingClientRect().width);
    const ro = new ResizeObserver(([e]) => fits(e.contentRect.width));
    ro.observe(root);
    return () => ro.disconnect();
  }, [root]);
  // Across hosts, the columns any of them has (each takes the tasks it can): those with the
  // projects, and for a profile's board every host with the profile, whose tasks in no project
  // show whether or not it has projects or can run agents.
  const statuses = useMemo(() => {
    const on: (Host | undefined)[] = hostId
      ? [hosts.find((h) => h.id === hostId)]
      : hosts.filter((h) => projects.some((p) => p.host_id === h.id) || [...(profiles ?? [])].some((k) => k.startsWith(`${h.id}:`)));
    const ids = new Set(on.flatMap((h) => hostStatuses(h).map((s) => s.id)));
    const shown = STATUSES.filter((s) => ids.has(s.id) || s.id === "todo");
    // Parked work comes first in both views, where it's out of the way collapsed.
    return [...shown.filter((s) => s.id === "backlog"), ...shown.filter((s) => s.id !== "backlog")];
  }, [hosts, hostId, projects, profiles]);
  const progress = useProgress();
  const createdProgress = useCreatedProgress();
  const progressOf = (t: Task) => (isGroupTask(t) || t.task_type === "plan" ? createdProgress[t.id] : progress[t.id]);
  const parentId = subproject?.id ?? null;
  // Project ids are only unique on their host.
  const byId = useMemo(() => new Map(projects.map((p) => [`${p.host_id}:${p.id}`, p])), [projects]);

  // Done tasks are archived as they pass two days in Done, while the board is open too.
  const now = useClock(60_000);
  const { columns, archived } = useMemo(() => {
    const list = Object.values(all);
    const tasks = [
      ...list.filter((t) => t.project_id && byId.has(`${t.host_id}:${t.project_id}`) && t.kind === "task" && (t.parent_id ?? null) === parentId),
      ...(group && hostId && !subproject ? groupTasks(list, hostId, group) : []),
      ...(profiles ? list.filter((t) => !t.project_id && t.kind === "task" && profiles.has(`${t.host_id}:${t.profile_id}`)) : []),
    ];
    const by: Record<Status, Task[]> = { todo: [], in_progress: [], needs_attention: [], in_review: [], ready_for_merge: [], done: [], backlog: [] };
    const archived: Task[] = [];
    for (const t of tasks) (isArchived(t, now) ? archived : by[t.status])?.push(t);
    for (const k of Object.keys(by) as Status[]) by[k].sort((a, b) => a.position - b.position || a.created_at.localeCompare(b.created_at));
    // The latest done first.
    const doneAt = (t: Task) => t.done_at ?? t.updated_at;
    archived.sort((a, b) => doneAt(b).localeCompare(doneAt(a)));
    return { columns: by, archived };
  }, [all, byId, parentId, group, hostId, subproject, profiles, now]);
  const projectOf = (t: Task) => byId.get(`${t.host_id}:${t.project_id ?? ""}`);

  // What the search, filters and sort leave of `columns` and `archived`, to show. Dropping a task
  // still places it among all of its column's tasks, filtered out or not.
  const shownStatuses = statuses.filter((s) => showsStatus(query, s.id));
  const filtering = isFiltering(query);
  const { shown, shownArchived } = useMemo(() => {
    const match = taskMatcher(
      query,
      (t) => `${keyPrefix(t, byId.get(`${t.host_id}:${t.project_id ?? ""}`))}-${t.number}`,
      (t) => byId.get(`${t.host_id}:${t.project_id ?? ""}`)?.name ?? t.group_name ?? undefined,
    );
    const shown = Object.fromEntries(Object.entries(columns).map(([k, ts]) => [k, sortTasks(ts.filter(match), sort)])) as Record<Status, Task[]>;
    return { shown, shownArchived: sortTasks(archived.filter(match), sort) };
  }, [columns, archived, query, sort, byId]);
  const total = statuses.reduce((n, s) => n + columns[s.id].length, archived.length);
  const shownCount = shownStatuses.reduce((n, s) => n + shown[s.id].length, showsStatus(query, "done") ? shownArchived.length : 0);
  // The filter menu's choices: the board's statuses, the kinds of task it has, and its projects (with "No project" for its group and scratch tasks).
  const statusOptions: FilterOption<Status>[] = statuses.map((s) => ({ id: s.id, label: s.label }));
  const kinds = useMemo(() => {
    const on = new Set<TaskKind>(query.kinds);
    for (const ts of [...Object.values(columns), archived]) for (const t of ts) on.add(taskKind(t));
    return [...on];
  }, [columns, archived, query.kinds]);
  const projectOptions = useMemo(() => {
    const options: FilterOption<string>[] = projects.map((p) => ({ id: `${p.host_id}:${p.id}`, label: hosts.length > 1 && !hostId ? `${p.name} (${hosts.find((h) => h.id === p.host_id)?.name ?? "?"})` : p.name }));
    if (group || profiles) options.push({ id: "", label: group ? "Group tasks" : "No project" });
    return options;
  }, [projects, hosts, hostId, group, profiles]);

  const changeView = (v: BoardView) => {
    setView(v);
    localStorage.setItem(VIEW_KEY, v);
  };

  const kanbanRef = useRef<HTMLDivElement>(null);
  const toggleBacklog = () => {
    setBacklogOpen(!backlogOpen);
    localStorage.setItem(BACKLOG_KEY, backlogOpen ? "closed" : "open");
    // The column opens at the start, which may be scrolled out of view: bring it back.
    if (!backlogOpen) requestAnimationFrame(() => kanbanRef.current?.scrollTo({ left: 0, behavior: "smooth" }));
  };

  // A plain wheel scrolls the board sideways when it overflows, unless a column's list under the pointer can scroll that way.
  const onKanbanWheel = (e: WheelEvent<HTMLDivElement>) => {
    const board = e.currentTarget;
    if (e.shiftKey || e.ctrlKey || e.deltaY === 0 || Math.abs(e.deltaX) >= Math.abs(e.deltaY) || board.scrollWidth <= board.clientWidth) return;
    for (let el = e.target as HTMLElement | null; el && el !== board; el = el.parentElement) {
      const y = getComputedStyle(el).overflowY;
      if ((y === "auto" || y === "scroll") && (e.deltaY < 0 ? el.scrollTop > 0 : el.scrollTop + el.clientHeight < el.scrollHeight - 1)) return;
    }
    board.scrollLeft += e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * board.clientWidth : e.deltaY;
  };

  const toggleArchived = (open = !archivedOpen) => {
    setArchivedOpen(open);
    localStorage.setItem(ARCHIVED_KEY, open ? "open" : "closed");
  };
  // From the kanban board's Done column, which leaves archived tasks out.
  const showArchived = () => {
    changeView("list");
    toggleArchived(true);
    requestAnimationFrame(() => document.getElementById("archived-tasks")?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };

  const toggleCollapsed = (status: Status) =>
    setCollapsed((c) => {
      const next = new Set(c);
      if (!next.delete(status)) next.add(status);
      return next;
    });

  const onDragOver = (e: DragEvent, status: Status) => {
    if (!e.dataTransfer.types.includes("text/task-id")) return;
    e.preventDefault();
    const col = e.currentTarget as HTMLElement;
    const cards = Array.from(col.querySelectorAll<HTMLElement>("[data-task]"));
    const before = cards.find((c) => {
      const r = c.getBoundingClientRect();
      return e.clientY < r.top + r.height / 2;
    });
    // Sorted other than by hand, a task dropped goes to the end of its column, wherever it's let go.
    const beforeId = sort === "manual" ? (before?.dataset.task ?? null) : null;
    if (dropTarget?.status !== status || dropTarget.before !== beforeId) setDropTarget({ status, before: beforeId });
  };

  const onDrop = async (e: DragEvent, status: Status) => {
    e.preventDefault();
    const id = e.dataTransfer.getData("text/task-id");
    const target = dropTarget;
    setDropTarget(null);
    const task = all[id];
    if (!task) return;
    // Dragged from the Archived section back into Done, it's done from now (and archived again in two days).
    const unarchive = status === "done" && isArchived(task, Date.now());
    // Sorted, it keeps its place in its own column, and goes last in another.
    if (sort !== "manual" && task.status === status && !unarchive) return;
    const col = columns[status].filter((t) => t.id !== id);
    // Before the card it's dropped above, or after the last card shown, which with filters may not be the column's last.
    const last = shown[status].filter((t) => t.id !== id).at(-1);
    const idx = sort !== "manual" ? -1 : target?.before ? col.findIndex((t) => t.id === target.before) : last ? col.findIndex((t) => t.id === last.id) + 1 : -1;
    const { position, moves } = dropPosition(col, idx === -1 ? col.length : idx);
    if (task.status === status && task.position === position && !moves.length && !unarchive) return;
    const host = hostOf(task);
    // The server (API 19) gives a task moved into Done the "done" resolution and clears it on the way out.
    const resolution = hostSupports(host, 19) ? (status === "done" ? (task.resolution ?? "done") : null) : task.resolution;
    // As the server sets it (API 53). Hosts from before go by the time the task last changed, which this move changes too.
    const done_at = status !== "done" ? null : unarchive || task.status !== "done" ? new Date().toISOString() : task.done_at;
    const moved = moves.map((m) => ({ before: all[m.id], position: m.position }));
    upsertTask({ ...task, status, position, resolution, done_at });
    for (const m of moved) upsertTask({ ...m.before, position: m.position });
    setDropErr(null);
    try {
      await Promise.all([
        api.updateTask(task.host_id, id, { status, position, ...(unarchive && hostSupports(host, 53) && { done_at: done_at! }) }),
        ...moved.map((m) => api.updateTask(m.before.host_id, m.before.id, { position: m.position })),
      ]);
      // Dragging a fresh task into "In progress" kicks off its agent (on a host that can run one).
      if (status === "in_progress" && task.status !== "in_progress" && !task.session_id && !task.running && canRunAgents(host)) {
        await api.send(task.host_id, id, "");
      }
    } catch (e) {
      upsertTask(task);
      for (const m of moved) upsertTask(m.before);
      setDropErr((e as Error).message);
    }
  };

  // Moves a task to the end of Done with that resolution (one already done keeps its place).
  const complete = async (task: Task, resolution: Resolution) => {
    if (task.status === "done" && task.resolution === resolution) return;
    const done = columns.done.filter((t) => t.id !== task.id);
    const position = task.status === "done" ? task.position : done.length ? done[done.length - 1].position + 1 : 1;
    upsertTask({ ...task, status: "done", resolution, position, done_at: task.status === "done" ? task.done_at : new Date().toISOString() });
    setDropErr(null);
    try {
      await api.updateTask(task.host_id, task.id, { status: "done", resolution, position });
    } catch (e) {
      upsertTask(task);
      setDropErr((e as Error).message);
    }
  };
  // Older hosts have no resolutions, so their tasks keep the browser's menu. The same function
  // from render to render, so the (memoized) cards don't all redraw.
  const onMenu = useCallback(
    (e: MouseEvent, task: Task) => {
      if (!hostSupports(hosts.find((h) => h.id === task.host_id), 19)) return;
      e.preventDefault();
      setMenu({ x: e.clientX, y: e.clientY, taskId: task.id });
    },
    [hosts],
  );

  const menuTask = menu && all[menu.taskId];
  const canAdd = !!project || !!scratch;

  // A column or section with nothing to show: filtered out, or empty.
  const emptyText = (status: Status) =>
    columns[status].length
      ? "No matching tasks"
      : status === "in_progress"
        ? "Drop a task here to start its agent"
        : status === "ready_for_merge"
          ? "Drop a task here to have its agent merge it"
          : "No tasks";

  const viewToggle = (
    <div className="mr-1 flex items-center rounded-md border border-line p-0.5">
      {(
        [
          { id: "board", label: "Board", icon: Kanban },
          { id: "list", label: "List", icon: List },
        ] as const
      ).map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          title={`${label} view`}
          onClick={() => changeView(id)}
          className={clsx(
            "inline-flex h-6 items-center gap-1 rounded px-2 text-xs font-medium transition-colors",
            view === id ? "bg-raised text-fg" : "text-muted hover:text-fg",
          )}
        >
          <Icon size={13} /> {label}
        </button>
      ))}
    </div>
  );

  const queryControls = (
    <>
      <SearchBox value={query.search} onChange={(search) => setQuery({ ...query, search })} />
      <FilterMenu query={query} onChange={setQuery} statuses={statusOptions} kinds={kinds} projects={projectOptions} align={wide ? "right" : "left"} />
      <SortMenu sort={sort} onChange={changeSort} />
    </>
  );
  const controls = (
    <>
      {wide && queryControls}
      {viewToggle}
    </>
  );

  return (
    <div ref={setRoot} className="flex h-full min-h-0 flex-col">
      {header({ controls, newTask: () => setNewIn("todo") })}
      {notice && <div className="border-b border-line bg-panel/60 px-5 py-2 text-[12.5px] text-muted">{notice}</div>}
      {(filtering || !wide) && (
        <FilterBar query={query} onChange={setQuery} tools={!wide && queryControls} shown={shownCount} total={total} statuses={statusOptions} projects={projectOptions} />
      )}
      {dropErr && (
        <div className="flex items-center gap-2 border-b border-line bg-red-500/10 px-5 py-2 text-[12.5px] text-red-300">
          <span className="min-w-0 flex-1">{dropErr}</span>
          <IconButton className="h-6 w-6" title="Dismiss" onClick={() => setDropErr(null)}>
            <X size={14} />
          </IconButton>
        </div>
      )}
      {view === "list" ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="space-y-5 p-6">
            {shownStatuses.map((s) => {
              const items = shown[s.id];
              // The backlog is open or collapsed in both views at once, and starts collapsed.
              const open = s.id === "backlog" ? backlogOpen : !collapsed.has(s.id);
              return (
                <section
                  key={s.id}
                  onDragOver={(e) => onDragOver(e, s.id)}
                  onDragLeave={(e) => {
                    if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropTarget(null);
                  }}
                  onDrop={(e) => onDrop(e, s.id)}
                >
                  <div className="mb-2 flex items-center gap-2">
                    <button
                      onClick={() => (s.id === "backlog" ? toggleBacklog() : toggleCollapsed(s.id))}
                      className={clsx(
                        "flex items-center gap-2 rounded-md text-left",
                        !open && dropTarget?.status === s.id && "ring-1 ring-accent/40 ring-offset-4 ring-offset-bg",
                      )}
                    >
                      <ChevronRight size={14} className={clsx("text-faint transition-transform", open && "rotate-90")} />
                      <StatusIcon status={s.id} />
                      <h2 className="text-[13px] font-medium">{s.label}</h2>
                      <span className="text-[12px] text-faint">{items.length}</span>
                    </button>
                    {canAdd && CAN_ADD.has(s.id) && (
                      <IconButton className="ml-auto h-6 w-6" title={`New task in ${s.label}`} onClick={() => setNewIn(s.id)}>
                        <Plus size={14} />
                      </IconButton>
                    )}
                  </div>
                  {open &&
                    (items.length === 0 ? (
                      <div
                        className={clsx(
                          "rounded-lg border border-dashed px-4 py-4 text-center text-[12.5px] text-faint transition-colors",
                          dropTarget?.status === s.id ? "border-accent/40 bg-accent/[0.03]" : "border-line",
                        )}
                      >
                        {emptyText(s.id)}
                      </div>
                    ) : (
                      <div
                        className={clsx(
                          "overflow-hidden rounded-lg border transition-colors",
                          dropTarget?.status === s.id ? "border-accent/40" : "border-line",
                        )}
                      >
                        {items.map((t, i) => (
                          <div key={t.id} className={clsx(i > 0 && "border-t border-line")}>
                            {dropTarget?.status === s.id && dropTarget.before === t.id && <DropLine status={s.id} className="h-0.5" />}
                            <TaskRow task={t} project={projectOf(t)} progress={progressOf(t)} onMenu={onMenu} />
                          </div>
                        ))}
                        {sort === "manual" && dropTarget?.status === s.id && dropTarget.before === null && <DropLine status={s.id} className="h-0.5" />}
                      </div>
                    ))}
                </section>
              );
            })}
            {/* Done for two days: off the kanban board, and here last, collapsed. Dragging one back into Done brings it back. */}
            {showsStatus(query, "done") && (
              <section id="archived-tasks" className="scroll-mt-6">
                <div className="mb-2 flex items-center gap-2">
                  <button onClick={() => toggleArchived()} className="flex items-center gap-2 rounded-md text-left" title="Tasks done for two days or more">
                    <ChevronRight size={14} className={clsx("text-faint transition-transform", archivedOpen && "rotate-90")} />
                    <Archive size={14} className="text-faint" />
                    <h2 className="text-[13px] font-medium">Archived</h2>
                    <span className="text-[12px] text-faint">{shownArchived.length}</span>
                  </button>
                </div>
                {archivedOpen &&
                  (shownArchived.length === 0 ? (
                    <div className="rounded-lg border border-dashed border-line px-4 py-4 text-center text-[12.5px] text-faint">
                      {archived.length ? "No matching tasks" : "Tasks done for two days move here"}
                    </div>
                  ) : (
                    <div className="overflow-hidden rounded-lg border border-line">
                      {shownArchived.map((t, i) => (
                        <div key={t.id} className={clsx(i > 0 && "border-t border-line")}>
                          <TaskRow task={t} project={projectOf(t)} progress={progressOf(t)} onMenu={onMenu} />
                        </div>
                      ))}
                    </div>
                  ))}
              </section>
            )}
          </div>
        </div>
      ) : (
        <div ref={kanbanRef} onWheel={onKanbanWheel} className="kanban-scroll min-h-0 flex-1 overflow-x-auto">
          {/* w-max keeps the right padding when the columns overflow; min-w-full lets them grow to fill a wide window. */}
          <div className="flex h-full w-max min-w-full gap-3 p-4">
            {shownStatuses.map((s) =>
              s.id === "backlog" && !backlogOpen ? (
                // Parked work stays out of the way: a strip at the start that opens into a column and still takes drops.
                <section
                  key={s.id}
                  onDragOver={(e) => onDragOver(e, s.id)}
                  onDragLeave={(e) => {
                    if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropTarget(null);
                  }}
                  onDrop={(e) => onDrop(e, s.id)}
                  className={clsx(
                    "flex h-full w-10 min-w-10 shrink-0 flex-col rounded-xl border bg-panel/50 transition-colors",
                    dropTarget?.status === s.id ? "border-accent/40 bg-accent/[0.03]" : "border-line/70",
                  )}
                >
                  <button
                    title={`Show the backlog (${shown[s.id].length})`}
                    onClick={toggleBacklog}
                    className="flex h-full w-full flex-col items-center gap-2 rounded-xl pt-3 text-muted transition-colors hover:bg-raised/40 hover:text-fg"
                  >
                    <ChevronRight size={14} className="text-faint" />
                    <StatusIcon status={s.id} />
                    <span className="text-[12px] text-faint">{shown[s.id].length}</span>
                    <span className="text-[12.5px] font-medium [writing-mode:vertical-rl]">{s.label}</span>
                  </button>
                </section>
              ) : (
                <section
                  key={s.id}
                  onDragOver={(e) => onDragOver(e, s.id)}
                  onDragLeave={(e) => {
                    if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropTarget(null);
                  }}
                  onDrop={(e) => onDrop(e, s.id)}
                  className={clsx(
                    "flex h-full w-[240px] min-w-[240px] flex-1 flex-col rounded-xl border bg-panel/50 transition-colors",
                    dropTarget?.status === s.id ? "border-accent/40 bg-accent/[0.03]" : "border-line/70",
                  )}
                >
                  <div className="flex items-center gap-2 px-3 pt-3 pb-[7px]">
                    <StatusIcon status={s.id} />
                    <span className="text-[12.5px] font-medium">{s.label}</span>
                    <span className="text-[12px] text-faint">{shown[s.id].length}</span>
                    <div className="ml-auto flex items-center gap-0.5">
                      {canAdd && CAN_ADD.has(s.id) && (
                        <IconButton className="h-6 w-6" title={`New task in ${s.label}`} onClick={() => setNewIn(s.id)}>
                          <Plus size={14} />
                        </IconButton>
                      )}
                      {s.id === "backlog" && (
                        <IconButton className="h-6 w-6" title="Collapse the backlog" onClick={toggleBacklog}>
                          <ChevronLeft size={14} />
                        </IconButton>
                      )}
                    </div>
                  </div>
                  {/* pt-px leaves room for the open card's ring, which the scroll area would clip at the top. */}
                  <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-2 pt-px pb-3">
                    {shown[s.id].map((t) => (
                      <div key={t.id}>
                        {dropTarget?.status === s.id && dropTarget.before === t.id && <DropLine status={s.id} />}
                        <TaskCard task={t} project={projectOf(t)} progress={progressOf(t)} onMenu={onMenu} />
                      </div>
                    ))}
                    {sort === "manual" && dropTarget?.status === s.id && dropTarget.before === null && <DropLine status={s.id} />}
                    {shown[s.id].length === 0 && <div className="px-2 py-6 text-center text-[12px] text-faint">{emptyText(s.id)}</div>}
                    {s.id === "done" && shownArchived.length > 0 && (
                      <button
                        onClick={showArchived}
                        title="Tasks done for two days or more are in the list view"
                        className="flex w-full items-center justify-center gap-1.5 rounded-md py-1.5 text-[12px] text-faint transition-colors hover:bg-raised/40 hover:text-fg"
                      >
                        <Archive size={12} /> {shownArchived.length} archived
                      </button>
                    )}
                  </div>
                </section>
              ),
            )}
          </div>
        </div>
      )}
      {menu && menuTask && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          title={`Complete ${keyPrefix(menuTask, projectOf(menuTask))}-${menuTask.number} as`}
          items={[
            ...(Object.keys(RESOLUTION_LABELS) as Resolution[]).map((r) => ({
              label: RESOLUTION_LABELS[r],
              checked: menuTask.status === "done" && menuTask.resolution === r,
              onSelect: () => complete(menuTask, r),
            })),
            ...(hostSupports(hostOf(menuTask), REMINDERS_API)
              ? [starItem(menuTask, setDropErr, true), ...reminderItems(menuTask, () => setPicking(menuTask), setDropErr)]
              : []),
          ]}
          // A right-click on another task may already have opened its menu in place of this one.
          onClose={() => setMenu((m) => (m === menu ? null : m))}
        />
      )}
      {picking && <ReminderModal task={picking} onClose={() => setPicking(null)} />}
      {newIn && canAdd && (
        <NewTaskModal
          // A group's (or profile's) new task starts in the project last picked for one, if it's on the board.
          project={(choices.length > 1 && choices.find((p) => p.id === localStorage.getItem(PROJECT_KEY))) || project}
          projects={choices.length > 1 || group || scratch ? choices : undefined}
          subproject={subproject}
          group={group}
          scratch={scratch}
          status={newIn}
          onClose={() => setNewIn(null)}
        />
      )}
    </div>
  );
}

function DropLine({ status, className = "mb-2 h-0.5 rounded-full" }: { status: Status; className?: string }) {
  return <div className={className} style={{ background: STATUS_COLOR[status] }} />;
}

/** Projects a new task can go in: those on a connected host. */
function useTaskProjects(projects: Project[]) {
  const hosts = useStore((s) => s.hosts);
  return useMemo(() => projects.filter((p) => hosts.some((h) => h.id === p.host_id && h.connected)), [projects, hosts]);
}

/** A profile's board: the tasks of all its projects on every host, its group tasks and its scratch tasks. */
export function ProfileBoard({ profile }: { profile: string }) {
  const all = useStore((s) => s.projects);
  const profiles = useStore((s) => s.profiles);
  const hosts = useStore((s) => s.hosts);
  const loaded = useStore((s) => s.loaded);
  // The profile on each host that has it, by `<host>:<profile id>`.
  const ids = useMemo(() => new Set(profiles.filter((p) => p.name === profile).map((p) => `${p.host_id}:${p.id}`)), [profiles, profile]);
  const projects = useMemo(() => all.filter((p) => ids.has(`${p.host_id}:${p.profile_id}`)), [all, ids]);
  const targets = useTaskProjects(projects);
  // Recomputed with the hosts and their settings, which pick where scratch tasks go.
  const hostSettings = useStore((s) => s.hostSettings);
  const scratch = useMemo(() => scratchHost(profile), [profile, profiles, hosts, hostSettings]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!ids.size) return <div className="p-8 text-muted">{loaded ? "Profile not found." : "Loading…"}</div>;
  const on = hosts.filter((h) => profiles.some((p) => p.host_id === h.id && p.name === profile));
  return (
    <TaskBoard
      boardKey={`profile:${profile}`}
      projects={projects}
      profiles={ids}
      targets={targets}
      scratch={scratch}
      header={({ controls, newTask }) => (
        <header className="drag flex h-12 shrink-0 items-center gap-3 border-b border-line px-5">
          <ProfileAvatar name={profile} />
          <div className="flex min-w-0 items-baseline gap-2">
            <h1 className="shrink-0 text-[14px] font-semibold">{profile}</h1>
            <span className="min-w-0 truncate text-[11.5px] text-faint">
              {hosts.length > 1 && <span className="mr-1.5 text-muted">{on.map((h) => h.name).join(", ")} ·</span>}
              {projects.length ? `${projects.length} project${projects.length === 1 ? "" : "s"}` : "No projects yet"}
            </span>
          </div>
          <div className="no-drag ml-auto flex items-center gap-1.5">
            {controls}
            {(targets.length > 0 || scratch) && (
              <Button size="sm" variant="primary" onClick={newTask}>
                <Plus size={14} /> New task
              </Button>
            )}
          </div>
        </header>
      )}
    />
  );
}

/** A profile's initial, as its rows and its board show it. */
/** A profile's initial; `muted` greys it out (the sidebar's profiles other than the one it lists the projects of). */
export function ProfileAvatar({ name, className, muted }: { name: string; className?: string; muted?: boolean }) {
  return (
    <span
      className={clsx(
        "flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded text-[10px] font-bold uppercase",
        muted ? "bg-white/[0.06] text-muted" : "bg-accent/20 text-accent",
        className,
      )}
    >
      {name[0] ?? "?"}
    </span>
  );
}
