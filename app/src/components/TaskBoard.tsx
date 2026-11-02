import clsx from "clsx";
import { Archive, ChevronLeft, ChevronRight, GanttChart, Inbox, Kanban, List, MonitorPlay, Network, Plus, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentProps, type DragEvent, type MouseEvent, type ReactNode, type UIEvent, type WheelEvent } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  api,
  canRunAgents,
  hostStatuses,
  hostSupports,
  isArchived,
  STATUSES,
  taskLabels,
  type Host,
  type Profile,
  type Project,
  type Resolution,
  type Status,
  type Task,
} from "../api";
import { groupTasks } from "../projectGroups";
import { dropPosition } from "../taskOrder";
import { EMPTY_QUERY, isFiltering, isSortKey, showsStatus, sortTasks, taskKinds, taskMatcher, type BoardQuery, type SortKey, type TaskKind } from "../boardQuery";
import { FilterBar, FilterMenu, SearchBox, SortMenu, type FilterOption } from "./BoardControls";
import { isGroupTask, keyPrefix, useStore } from "../store";
import { useConfirmDone } from "./ConfirmDone";
import { COMPARE_API } from "./Fanout";
import { openCompare } from "../router";
import { ReminderModal, reminderItems, starItem } from "./Reminders";
import { titleItem, TitleModal } from "./TitleModal";
import { REMINDERS_API } from "../reminders";
import { TimelineView } from "./TimelineView";
import { GraphView } from "./GraphView";
import { TriageView } from "./TriageView";
import { LiveView } from "./LiveView";
import { Button, ContextMenu, IconButton, RESOLUTION_LABELS, StatusIcon, STATUS_COLOR, useClock, type MenuItem } from "./ui";
import { useNarrow } from "../narrow";
import { TaskCard, TaskRow, useProgress, useCreatedProgress } from "./TaskCard";
import { NewTaskModal, PROJECT_KEY } from "./NewTaskModal";

// Columns that get a "new task" button. New work starts in To do or Backlog.
const CAN_ADD: ReadonlySet<Status> = new Set<Status>(["todo", "backlog"]);

// Board and List show the tasks by status; the others are other ways of looking at the same tasks (HA-5).
const VIEWS = [
  { id: "board", label: "Board", icon: Kanban, title: "Board view: a column for each status" },
  { id: "list", label: "List", icon: List, title: "List view: a section for each status" },
  { id: "triage", label: "Triage", icon: Inbox, title: "Triage view: what needs you, most pressing first" },
  { id: "live", label: "Live", icon: MonitorPlay, title: "Live view: the working agents side by side" },
  { id: "timeline", label: "Timeline", icon: GanttChart, title: "Timeline view: when agents ran, and how long tasks have waited on you" },
  { id: "graph", label: "Graph", icon: Network, title: "Graph view: which tasks led to which, and what waits on what" },
] as const;
type BoardView = (typeof VIEWS)[number]["id"];
const isView = (v: string | null): v is BoardView => VIEWS.some((x) => x.id === v);
const VIEW_KEY = "ia.boardView";
// How wide a board has to be for every view's name to show in the view switch (see `labelled` in TaskBoard).
const WIDE_VIEWS = 1500;
// Whether the kanban board's Backlog column is open (it starts collapsed), on this client.
const BACKLOG_KEY = "ia.board.backlog";
// Whether the list view's Archived section is open (it starts collapsed), on this client.
const ARCHIVED_KEY = "ia.board.archived";
// How wide a board has to be for its search, filter and sort controls to go in its header (see TaskBoard).
const WIDE_BOARD = 1180;
// How the boards sort their tasks, on this client.
const SORT_KEY = "ia.board.sort";
// The column each board shows in the narrow layout (one at a time), on this client.
const columnKey = (board: string) => `ia.board.column.${board}`;
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

/**
 * The tasks of `projects` by status, as columns or a list; with `subproject`, that subproject's
 * tasks. A group's board may have no projects left, only group tasks. A profile's board spans
 * hosts, and may have no projects, only scratch tasks.
 */
export function TaskBoard({
  boardKey,
  hostId,
  projects,
  subproject,
  group,
  profiles,
  targets,
  scratch,
  ready = true,
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
  /**
   * Whether New task's dialog can open yet. A profile's board waits for its projects: a dialog opened before them
   * would start in no project and keep its draft there, where the next one (starting in a project) doesn't look (HA-93).
   * New task clicked meanwhile opens it once it can.
   */
  ready?: boolean;
  /** Shown above the tasks. */
  notice?: ReactNode;
  /** The header, given the search, filter, sort and view controls to show in it. */
  header: (slots: { controls: ReactNode; newTask: () => void }) => ReactNode;
}) {
  const choices = targets ?? projects;
  const project = choices[0] as Project | undefined;
  const hosts = useStore((s) => s.hosts);
  const hostOf = (t: Task) => hosts.find((h) => h.id === t.host_id);
  const upsertTask = useStore((s) => s.upsertTask);
  const [newIn, setNewIn] = useState<Status | null>(null);
  const [view, setView] = useState<BoardView>(() => {
    const v = localStorage.getItem(VIEW_KEY);
    return isView(v) ? v : "board";
  });
  const [collapsed, setCollapsed] = useState<Set<Status>>(() => new Set());
  const [backlogOpen, setBacklogOpen] = useState(() => localStorage.getItem(BACKLOG_KEY) === "open");
  const [archivedOpen, setArchivedOpen] = useState(() => localStorage.getItem(ARCHIVED_KEY) === "open");
  const [dropTarget, setDropTarget] = useState<{ status: Status; before: string | null } | null>(null);
  const [dropErr, setDropErr] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; taskId: string; move?: boolean } | null>(null);
  const [picking, setPicking] = useState<Task | null>(null);
  const [renaming, setRenaming] = useState<Task | null>(null);
  // Asks before a task whose work isn't merged goes into Done.
  const { confirmDone, dialog: doneDialog } = useConfirmDone();
  const [query, setQuery] = useState(() => loadQuery(boardKey));
  const narrow = useNarrow();
  const [column, setColumn] = useState<Status | null>(() => localStorage.getItem(columnKey(boardKey)) as Status | null);
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
  const [roomy, setRoomy] = useState(true);
  useLayoutEffect(() => {
    if (!root) return;
    const fits = (width: number) => {
      setWide(width >= WIDE_BOARD);
      setRoomy(width >= WIDE_VIEWS);
    };
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
  const progressOf = (t: Task) => (isGroupTask(t) || (!t.subproject && taskLabels(t).includes("plan")) ? createdProgress[t.id] : progress[t.id]);
  const parentId = subproject?.id ?? null;
  // Project ids are only unique on their host.
  const byId = useMemo(() => new Map(projects.map((p) => [`${p.host_id}:${p.id}`, p])), [projects]);

  // The board's tasks, picked in the store: an event about a task on another board leaves this one be.
  // Worked out again only when the tasks change, and the same list while it has the same tasks.
  const pickTasks = useMemo(() => {
    let from: Record<string, Task> | undefined;
    let picked: Task[] = [];
    return (s: { tasks: Record<string, Task> }) => {
      if (s.tasks === from) return picked;
      from = s.tasks;
      const list = Object.values(from);
      picked = [
        ...list.filter((t) => t.project_id && byId.has(`${t.host_id}:${t.project_id}`) && t.kind === "task" && (t.parent_id ?? null) === parentId),
        ...(group && hostId && !subproject ? groupTasks(list, hostId, group) : []),
        ...(profiles ? list.filter((t) => !t.project_id && t.kind === "task" && profiles.has(`${t.host_id}:${t.profile_id}`)) : []),
      ];
      return picked;
    };
  }, [byId, parentId, group, hostId, subproject, profiles]);
  const tasks = useStore(useShallow(pickTasks));

  // Done tasks are archived as they pass two days in Done, while the board is open too.
  const now = useClock(60_000);
  const { columns, archived } = useMemo(() => {
    const by: Record<Status, Task[]> = { todo: [], in_progress: [], needs_attention: [], in_review: [], ready_for_merge: [], done: [], backlog: [] };
    const archived: Task[] = [];
    for (const t of tasks) (isArchived(t, now) ? archived : by[t.status])?.push(t);
    for (const k of Object.keys(by) as Status[]) by[k].sort((a, b) => a.position - b.position || a.created_at.localeCompare(b.created_at));
    // The latest done first.
    const doneAt = (t: Task) => t.done_at ?? t.updated_at;
    archived.sort((a, b) => doneAt(b).localeCompare(doneAt(a)));
    return { columns: by, archived };
  }, [tasks, now]);
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
  // For the views that aren't by status: every task shown, in the order of the statuses.
  const shownTasks = useMemo(
    () => [...shownStatuses.flatMap((s) => shown[s.id]), ...(showsStatus(query, "done") ? shownArchived : [])],
    // shownStatuses is a new array each render, but follows `statuses` and `query`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [shown, shownArchived, statuses, query],
  );
  const total = statuses.reduce((n, s) => n + columns[s.id].length, archived.length);
  const shownCount = shownStatuses.reduce((n, s) => n + shown[s.id].length, showsStatus(query, "done") ? shownArchived.length : 0);
  // The filter menu's choices: the board's statuses, the kinds of task it has, and its projects (with "No project" for its group and scratch tasks).
  const statusOptions: FilterOption<Status>[] = statuses.map((s) => ({ id: s.id, label: s.label }));
  const kinds = useMemo(() => {
    const on = new Set<TaskKind>(query.kinds);
    for (const ts of [...Object.values(columns), archived]) for (const t of ts) for (const k of taskKinds(t)) on.add(k);
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

  // The narrow layout's board shows one column at a time, picked above it or by swiping sideways: the one picked
  // last, while it's shown. Until one is picked, what needs attention, or else the first column with tasks.
  const firstColumn = () => {
    const work = shownStatuses.filter((s) => s.id !== "backlog");
    return (work.find((s) => s.id === "needs_attention" && shown[s.id].length) ?? work.find((s) => shown[s.id].length) ?? work[0] ?? shownStatuses[0])?.id;
  };
  const shownColumn = column && shownStatuses.some((s) => s.id === column) ? column : firstColumn();
  // Which that is is settled once the board has tasks, so it doesn't change under you as they move.
  const settle = !column && total > 0 ? shownColumn : undefined;
  useEffect(() => {
    if (settle) setColumn(settle);
  }, [settle]);
  const columnIndex = shownStatuses.findIndex((s) => s.id === shownColumn);
  const columnsRef = useRef<HTMLDivElement>(null);
  const columnTabsRef = useRef<HTMLDivElement>(null);
  /**
   * The column being scrolled to, which the columns passed on the way don't take over from, until the scroll ends: on a
   * busy phone it can take a while to get going, and a column it had barely left took back over (HA-92). Without
   * scrollend (Safari before 26), until the scroll has had time to end.
   */
  const scrollingTo = useRef<{ index: number; timer?: ReturnType<typeof setTimeout> } | null>(null);
  const pickColumn = (s: Status) => {
    setColumn(s);
    localStorage.setItem(columnKey(boardKey), s);
  };
  useLayoutEffect(() => {
    const el = columnsRef.current;
    if (!el || columnIndex < 0) return;
    columnTabsRef.current?.querySelector("[aria-selected=true]")?.scrollIntoView({ block: "nearest", inline: "nearest" });
    // At once when the board opens, smoothly from one column to another.
    const smooth = el.dataset.shown === "1";
    el.dataset.shown = "1";
    const left = columnIndex * el.clientWidth;
    if (Math.abs(el.scrollLeft - left) <= 1) return;
    if (smooth) {
      clearTimeout(scrollingTo.current?.timer);
      scrollingTo.current = { index: columnIndex, timer: "onscrollend" in window ? undefined : setTimeout(() => (scrollingTo.current = null), 800) };
    }
    el.scrollTo({ left, behavior: smooth ? "smooth" : "instant" });
  }, [columnIndex, narrow, view]);
  const onColumnsScroll = (e: UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const i = Math.round(el.scrollLeft / el.clientWidth);
    if (Math.abs(el.scrollLeft - i * el.clientWidth) > 2) return;
    if (scrollingTo.current) {
      if (scrollingTo.current.index === i) scrollingTo.current = null;
      return;
    }
    const s = shownStatuses[i]?.id;
    if (s && s !== shownColumn) pickColumn(s);
  };
  // Where it ended is picked, if that isn't where it was going (a swipe took over).
  const onColumnsScrollEnd = (e: UIEvent<HTMLDivElement>) => {
    if (!scrollingTo.current) return;
    scrollingTo.current = null;
    onColumnsScroll(e);
  };

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

  const onDrop = (e: DragEvent, status: Status) => {
    e.preventDefault();
    const target = dropTarget;
    setDropTarget(null);
    const task = useStore.getState().tasks[e.dataTransfer.getData("text/task-id")];
    if (task) moveTask(task, status, target?.before ?? null);
  };
  const drops: Drops = { onDragOver, onDrop, onLeave: () => setDropTarget(null) };

  /** Moves `task` into column `status` before task `before`, or after its last task shown: as dropping it there does. */
  const moveTask = async (task: Task, status: Status, before: string | null) => {
    const id = task.id;
    // Dropped on its own top half (the drop line shows above it): it stays where it is.
    if (before === id) return;
    // Dragged from the Archived section back into Done, it's done from now (and archived again in two days).
    const unarchive = status === "done" && isArchived(task, Date.now());
    // Sorted, it keeps its place in its own column, and goes last in another.
    if (sort !== "manual" && task.status === status && !unarchive) return;
    const col = columns[status].filter((t) => t.id !== id);
    // Before the card it's dropped above, or after the last card shown, which with filters may not be the column's last.
    const last = shown[status].filter((t) => t.id !== id).at(-1);
    const idx = sort !== "manual" ? -1 : before ? col.findIndex((t) => t.id === before) : last ? col.findIndex((t) => t.id === last.id) + 1 : -1;
    const { position, moves } = dropPosition(col, idx === -1 ? col.length : idx);
    if (task.status === status && task.position === position && !moves.length && !unarchive) return;
    if (status === "done" && !(await confirmDone(task))) return;
    const host = hostOf(task);
    // The server (API 19) gives a task moved into Done the "done" resolution and clears it on the way out.
    const resolution = hostSupports(host, 19) ? (status === "done" ? (task.resolution ?? "done") : null) : task.resolution;
    // As the server sets it (API 53). Hosts from before go by the time the task last changed, which this move changes too.
    const done_at = status !== "done" ? null : unarchive || task.status !== "done" ? new Date().toISOString() : task.done_at;
    const all = useStore.getState().tasks;
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

  // Moves a task to the end of Done with that resolution (one already done keeps its place). An archived one comes back
  // into Done, done from now, as dragging it there does.
  const complete = async (task: Task, resolution: Resolution) => {
    const unarchive = isArchived(task, Date.now());
    const stays = task.status === "done" && !unarchive;
    if (stays && task.resolution === resolution) return;
    if (resolution === "done" && !(await confirmDone(task))) return;
    const done = columns.done.filter((t) => t.id !== task.id);
    const position = stays ? task.position : done.length ? done[done.length - 1].position + 1 : 1;
    const done_at = stays ? task.done_at : new Date().toISOString();
    upsertTask({ ...task, status: "done", resolution, position, done_at });
    setDropErr(null);
    try {
      await api.updateTask(task.host_id, task.id, { status: "done", resolution, position, ...(unarchive && hostSupports(hostOf(task), 53) && { done_at }) });
    } catch (e) {
      upsertTask(task);
      setDropErr((e as Error).message);
    }
  };
  // Older hosts have no resolutions, so their tasks keep the browser's menu. The same function
  // from render to render, so the (memoized) cards don't all redraw.
  const onMenu = useCallback(
    (e: MouseEvent, task: Task, move?: boolean) => {
      if (!move && !hostSupports(hosts.find((h) => h.id === task.host_id), 19)) return;
      e.preventDefault();
      // From its menu button, under the button.
      const r = move ? (e.currentTarget as HTMLElement).getBoundingClientRect() : null;
      setMenu({ x: r ? r.right : e.clientX, y: r ? r.bottom + 4 : e.clientY, taskId: task.id, move });
    },
    [hosts],
  );

  const menuTask = useStore((s) => (menu ? s.tasks[menu.taskId] : null));
  // The tasks made from the same prompt as it, it among them, to compare (see Compare.tsx).
  const menuSiblings = useStore((s) =>
    menuTask?.fanout_id ? Object.values(s.tasks).filter((t) => t.host_id === menuTask.host_id && t.fanout_id === menuTask.fanout_id).length : 0,
  );
  /** The columns to move a task to from its menu: all but Done where Done's resolutions follow them. */
  const moveItems = (task: Task): MenuItem[] =>
    statuses
      .filter((s) => s.id !== "done" || !hostSupports(hostOf(task), 19))
      .map((s) => ({
        label: (
          <span className="flex items-center gap-2">
            <StatusIcon status={s.id} size={13} /> {s.label}
          </span>
        ),
        checked: task.status === s.id && !isArchived(task, Date.now()),
        onSelect: () => (task.status !== s.id || isArchived(task, Date.now())) && moveTask(task, s.id, null),
      }));
  const canAdd = !!project || !!scratch;

  // A column or section with nothing to show: filtered out, or empty.
  const emptyText = (status: Status) =>
    columns[status].length
      ? "No matching tasks"
      : narrow
        ? "No tasks"
        : status === "in_progress"
          ? "Drop a task here to start its agent"
          : status === "ready_for_merge"
            ? "Drop a task here to have its agent merge it"
            : "No tasks";

  // Every view's name on a roomy board, the current one's on a wide one, and only icons on a narrow one.
  const labelled = (id: BoardView) => roomy || (wide && view === id);
  const viewToggle = (
    <div className="mr-1 flex items-center rounded-md border border-line p-0.5">
      {VIEWS.map(({ id, label, icon: Icon, title }) => (
        <button
          key={id}
          title={title}
          aria-label={`${label} view`}
          aria-pressed={view === id}
          onClick={() => changeView(id)}
          className={clsx(
            "inline-flex h-6 items-center gap-1 rounded text-xs font-medium transition-colors narrow:h-8",
            labelled(id) ? "px-2" : "px-1.5",
            view === id ? "bg-raised text-fg" : "text-muted hover:text-fg",
          )}
        >
          <Icon size={13} /> {labelled(id) && <span className="narrow:hidden">{label}</span>}
        </button>
      ))}
    </div>
  );

  /** A column's cards, with where a dragged one would go, and what it says when it has none. */
  const cards = (status: Status) => (
    <>
      {shown[status].map((t) => (
        <div key={t.id}>
          {dropTarget?.status === status && dropTarget.before === t.id && <DropLine status={status} />}
          <TaskCard task={t} project={projectOf(t)} progress={progressOf(t)} onMenu={onMenu} />
        </div>
      ))}
      {sort === "manual" && dropTarget?.status === status && dropTarget.before === null && <DropLine status={status} />}
      {shown[status].length === 0 && <div className="px-2 py-6 text-center text-[12px] text-faint">{emptyText(status)}</div>}
      {status === "done" && shownArchived.length > 0 && (
        <button
          onClick={showArchived}
          title="Tasks done for two days or more are in the list view"
          className="flex w-full items-center justify-center gap-1.5 rounded-md py-1.5 text-[12px] text-faint transition-colors hover:bg-raised/40 hover:text-fg"
        >
          <Archive size={12} /> {shownArchived.length} archived
        </button>
      )}
    </>
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
      {notice && <div className="border-b border-line bg-panel/60 px-5 py-2 text-[12.5px] text-muted narrow:px-3">{notice}</div>}
      {(filtering || !wide) && (
        <FilterBar query={query} onChange={setQuery} tools={!wide && queryControls} shown={shownCount} total={total} statuses={statusOptions} projects={projectOptions} />
      )}
      {dropErr && (
        <div className="flex items-center gap-2 border-b border-line bg-red-500/10 px-5 py-2 text-[12.5px] text-red-300 narrow:px-3">
          <span className="min-w-0 flex-1">{dropErr}</span>
          <IconButton className="h-6 w-6" title="Dismiss" onClick={() => setDropErr(null)}>
            <X size={14} />
          </IconButton>
        </div>
      )}
      {view === "triage" ? (
        <TriageView tasks={shownTasks} projectOf={projectOf} onMenu={onMenu} />
      ) : view === "live" ? (
        <LiveView tasks={shownTasks} projectOf={projectOf} onMenu={onMenu} />
      ) : view === "timeline" ? (
        <TimelineView tasks={shownTasks} projectOf={projectOf} onMenu={onMenu} />
      ) : view === "graph" ? (
        <GraphView tasks={shownTasks} projectOf={projectOf} progressOf={progressOf} onMenu={onMenu} />
      ) : view === "list" ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="space-y-5 p-6 narrow:p-3">
            {shownStatuses.map((s) => {
              const items = shown[s.id];
              // The backlog is open or collapsed in both views at once, and starts collapsed.
              const open = s.id === "backlog" ? backlogOpen : !collapsed.has(s.id);
              return (
                <DropColumn
                  key={s.id}
                  status={s.id}
                  drops={drops}
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
                </DropColumn>
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
      ) : narrow ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div ref={columnTabsRef} role="tablist" aria-label="Columns" className="flex shrink-0 gap-1.5 overflow-x-auto border-b border-line px-3 py-2 [scrollbar-width:none]">
            {shownStatuses.map((s) => (
              <button
                key={s.id}
                role="tab"
                aria-selected={s.id === shownColumn}
                onClick={() => pickColumn(s.id)}
                className={clsx(
                  "flex h-9 shrink-0 items-center gap-1.5 rounded-full border px-3 text-[12.5px] transition-colors",
                  s.id === shownColumn ? "border-accent/50 bg-accent/10 text-fg" : "border-line text-muted",
                )}
              >
                <StatusIcon status={s.id} size={13} />
                {s.label}
                <span className="text-faint">{shown[s.id].length}</span>
              </button>
            ))}
          </div>
          <div ref={columnsRef} onScroll={onColumnsScroll} onScrollEnd={onColumnsScrollEnd} className="flex min-h-0 flex-1 snap-x snap-mandatory overflow-x-auto overscroll-x-contain [scrollbar-width:none]">
            {shownStatuses.map((s) => (
              <DropColumn
                key={s.id}
                status={s.id}
                drops={drops}
                role="tabpanel"
                aria-label={s.label}
                inert={s.id !== shownColumn}
                className="h-full w-full shrink-0 snap-start snap-always space-y-2 overflow-y-auto px-3 pt-3 pb-6"
              >
                {cards(s.id)}
                {canAdd && CAN_ADD.has(s.id) && (
                  <button
                    onClick={() => setNewIn(s.id)}
                    className="flex h-10 w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-line text-[12.5px] text-muted hover:text-fg"
                  >
                    <Plus size={14} /> New task in {s.label}
                  </button>
                )}
              </DropColumn>
            ))}
          </div>
        </div>
      ) : (
        <div ref={kanbanRef} onWheel={onKanbanWheel} className="kanban-scroll min-h-0 flex-1 overflow-x-auto">
          {/* w-max keeps the right padding when the columns overflow; min-w-full lets them grow to fill a wide window. */}
          <div className="flex h-full w-max min-w-full gap-3 p-4">
            {shownStatuses.map((s) =>
              s.id === "backlog" && !backlogOpen ? (
                // Parked work stays out of the way: a strip at the start that opens into a column and still takes drops.
                <DropColumn
                  key={s.id}
                  status={s.id}
                  drops={drops}
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
                </DropColumn>
              ) : (
                <DropColumn
                  key={s.id}
                  status={s.id}
                  drops={drops}
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
                  <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-2 pt-px pb-3">{cards(s.id)}</div>
                </DropColumn>
              ),
            )}
          </div>
        </div>
      )}
      {menu && menuTask && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          title={`${menu.move ? "Move" : "Complete"} ${keyPrefix(menuTask, projectOf(menuTask))}-${menuTask.number} ${menu.move ? "to" : "as"}`}
          items={[
            ...(menu.move ? moveItems(menuTask) : []),
            ...(hostSupports(hostOf(menuTask), 19)
              ? (Object.keys(RESOLUTION_LABELS) as Resolution[]).map((r, i) => ({
                  label: menu.move ? (
                    <span className="flex items-center gap-2">
                      <StatusIcon status="done" size={13} /> {RESOLUTION_LABELS[r]}
                    </span>
                  ) : (
                    RESOLUTION_LABELS[r]
                  ),
                  // An archived task isn't in Done: picking its resolution brings it back.
                  checked: menuTask.status === "done" && menuTask.resolution === r && !isArchived(menuTask, Date.now()),
                  divider: i === 0,
                  onSelect: () => complete(menuTask, r),
                }))
              : []),
            ...(hostSupports(hostOf(menuTask), REMINDERS_API)
              ? [starItem(menuTask, setDropErr, true), ...reminderItems(menuTask, () => setPicking(menuTask), setDropErr)]
              : []),
            titleItem(() => setRenaming(menuTask), true),
            ...(menuSiblings > 1 && hostSupports(hostOf(menuTask), COMPARE_API)
              ? [{ label: `Compare all ${menuSiblings} from its prompt`, divider: true, onSelect: () => openCompare(menuTask.id) }]
              : []),
          ]}
          // A right-click on another task may already have opened its menu in place of this one.
          onClose={() => setMenu((m) => (m === menu ? null : m))}
        />
      )}
      {picking && <ReminderModal task={picking} onClose={() => setPicking(null)} />}
      {renaming && <TitleModal task={renaming} onClose={() => setRenaming(null)} />}
      {doneDialog}
      {newIn && canAdd && ready && (
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

/** A board's New task button: just its + in the narrow layout. */
export function NewTaskButton({ onClick }: { onClick: () => void }) {
  return (
    <Button size="sm" variant="primary" onClick={onClick} aria-label="New task" className="narrow:h-9 narrow:w-9 narrow:px-0">
      <Plus size={14} /> <span className="narrow:hidden">New task</span>
    </Button>
  );
}

type Drops = { onDragOver: (e: DragEvent, status: Status) => void; onDrop: (e: DragEvent, status: Status) => void; onLeave: () => void };

/** A column or section that tasks dragged onto it move to: to `status`, where `drops` says. */
function DropColumn({ status, drops, ...props }: { status: Status; drops: Drops } & Omit<ComponentProps<"section">, "onDragOver" | "onDragLeave" | "onDrop">) {
  return (
    <section
      {...props}
      onDragOver={(e) => drops.onDragOver(e, status)}
      onDragLeave={(e) => {
        // Not when it's onto a card in it.
        if (!e.currentTarget.contains(e.relatedTarget as Node)) drops.onLeave();
      }}
      onDrop={(e) => drops.onDrop(e, status)}
    />
  );
}

function DropLine({ status, className = "mb-2 h-0.5 rounded-full" }: { status: Status; className?: string }) {
  return <div className={className} style={{ background: STATUS_COLOR[status] }} />;
}
