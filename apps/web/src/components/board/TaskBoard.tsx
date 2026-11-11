import { Plus, X } from "lucide-react"
import { useEffect, useMemo, type ReactNode } from "react"
import { type HostProfile as Profile, type HostProject as Project, type HostTask as Task } from "@huntaway/client"
import type { Status } from "@huntaway/contracts"
import { moveToPen, type PenLanes } from "./pens"
import { FilterBar, FilterMenu, SearchBox, SortMenu } from "./BoardControls"

import { useConfirmDone } from "./ConfirmDone"
import { useConfirmTodos } from "./ConfirmTodos"
import { ReminderModal } from "../task/Reminders"
import { TitleModal } from "../layout/TitleModal"
import { useSelection } from "../../selection"
import { penItems } from "./Pens"
import { LassoPath, SelectionBar, useClearSelection, useLasso } from "./Lasso"
import { GraphView } from "./GraphView"
import { Button, ContextMenu, errorText, IconButton } from "../ui"
import { useNarrow } from "../../narrow"
import { NewTaskModal } from "../layout/NewTaskModal"
import { PROJECT_KEY } from "../layout/newTask/draft"
import type { CardsProps } from "./taskBoard/Cards"
import { Kanban, NarrowColumns } from "./taskBoard/Columns"
import { KanbanLanes, ListLanes } from "./taskBoard/Lanes"
import { ListView } from "./taskBoard/ListView"
import { CardMenu, PenMenu } from "./taskBoard/Menus"
import { ViewToggle } from "./taskBoard/ViewToggle"
import { useBoardColumn } from "./taskBoard/useBoardColumn"
import { useBoardDrops } from "./taskBoard/useBoardDrops"
import { useBoardLayout } from "./taskBoard/useBoardLayout"
import { useBoardMenus } from "./taskBoard/useBoardMenus"
import { useBoardQuery } from "./taskBoard/useBoardQuery"
import { useBoardStacks } from "./taskBoard/useBoardStacks"
import { StackEditModal, StacksSwitch, stackTitle } from "./StackCard"
import { useBoardTasks } from "./taskBoard/useBoardTasks"
import { useBoard } from "../../state/board"

/** Lets the tasks picked with the lasso go, as what the board shows changes (`_shows`). */
const clearPicked = (_shows: unknown): void => useSelection.getState().clear()

/**
 * The tasks of `projects` by status, as columns or a list. A group's board may have no projects left, only group tasks. A profile's board spans
 * hosts, and may have no projects, only scratch tasks.
 */
export function TaskBoard({
  boardKey,
  hostId,
  projects,
  group,
  profiles,
  targets,
  scratch,
  ready = true,
  notice,
  renderHeader,
  only,
  penLabels = true,
  onOpenPen,
  onCreated,
  lanes,
}: {
  /** Which board it is, to keep its search and filters by (each board has its own; give it as the `key` too). */
  boardKey: string
  /** Where `projects` are, for a project's or group's board. */
  hostId?: string | undefined
  projects: ReadonlyArray<Project>
  /** The group `projects` are, whose group tasks show too. */
  group?: string | undefined
  /** For a profile's board, the profile on each host (by `<host>:<profile id>`): its tasks in no project show too. */
  profiles?: Set<string> | undefined
  /** The projects a new task can go in, if not `projects`. */
  targets?: Project[] | undefined
  /** Where its scratch tasks go, for a profile's board. */
  scratch?: Profile | null | undefined
  /**
   * Whether New task's dialog can open yet. A profile's board waits for its projects: a dialog opened before them
   * would start in no project and keep its draft there, where the next one (starting in a project) doesn't look (HA-93).
   * New task clicked meanwhile opens it once it can.
   */
  ready?: boolean | undefined
  /** Shown above the tasks. */
  notice?: ReactNode | undefined
  /** The header, given the search, filter, sort and view controls to show in it. */
  renderHeader: (slots: { controls: ReactNode; newTask: () => void }) => ReactNode
  /** Only the tasks it keeps (a pen's, on a profile's board), the same function while it keeps the same ones. */
  only?: ((t: Task) => boolean) | undefined
  /** Whether cards whose tasks are in pens have their pen's label over them (not on a pen's own tab). */
  penLabels?: boolean | undefined
  /** Opens a pen's tab (by its key) on this board, when a card's pen label is clicked; else it opens the profile's board. */
  onOpenPen?: ((key: string) => void) | undefined
  /** Told of the tasks New task made. */
  /** Its promise's failure (the tasks couldn't go in the tab's pen, say) is shown. */
  onCreated?: ((tasks: ReadonlyArray<Task>) => Promise<void> | void) | undefined
  /**
   * Rows of pens (HA-292), for the Active and Inactive views: the tasks (which `only` keeps to these pens' ones) in a row
   * for each, across the columns. A task dropped in a row goes in its pen.
   */
  lanes?: PenLanes | undefined
}) {
  const choices = targets ?? projects
  const project = choices[0]
  const hosts = useBoard((s) => s.hosts)
  // Asks before a task whose work isn't merged goes into Done.
  const { confirmDone, dialog: doneDialog } = useConfirmDone()
  // Asks before a task whose todo list isn't complete leaves In progress (API 148).
  const { confirmTodos, dialog: todosDialog } = useConfirmTodos()
  const layout = useBoardLayout()
  const { root, setRoot, wide, roomy, kanbanRef, onKanbanWheel } = layout
  const q = useBoardQuery(boardKey, kanbanRef)
  const { view, changeView, query, setQuery, search, setSearch, sort, changeSort } = q
  const narrow = useNarrow()
  const board = useBoardTasks({ hosts, hostId, projects, group, profiles, only, query, sort })
  const { tasks, columns, projectOf, progressOf, shownStatuses, filtering, shown, shownTasks, total } = board
  // The tasks picked with the lasso, which finds them in what the view draws. Changing what the board shows lets them go.
  const pickedIds = useSelection((s) => s.ids)
  const allTasks = useBoard((s) => s.tasks)
  const picked = useMemo(() => [...pickedIds].map((id) => allTasks[id]).filter((t): t is Task => t?.kind === "task"), [allTasks, pickedIds])
  // The stacks gathered into one card each, on the kanban board (not in rows of pens).
  const stacks = useBoardStacks({
    tasks,
    shown,
    keep: board.keep,
    now: board.now,
    query,
    sort,
    kanban: view === "board" && !lanes,
  })
  // Changing what the board shows lets the picked tasks go.
  const shows = useMemo(() => ({ view, query, only, views: stacks.views }), [view, query, only, stacks.views])
  useEffect(() => clearPicked(shows), [shows])
  const lassoPath = useLasso(root)
  useClearSelection(true)
  const column = useBoardColumn({ boardKey, shownStatuses, count: stacks.columnCount, total })
  const drops = useBoardDrops({ sort, columns, shown, stacks, confirmTodos, confirmDone })
  const { dropErr, setDropErr } = drops
  const menus = useBoardMenus({
    statuses: board.statuses,
    columns,
    confirmTodos,
    confirmDone,
    dropTask: drops.dropTask,
    setDropErr,
  })
  const { newIn, setNewIn, newLane, setNewLane, menu, menuTask, onMenu, picking, setPicking, renaming, setRenaming, penMenu, setPenMenu, newPen } = menus
  const canAdd = !!project || !!scratch
  const stackMenu = stacks.menu ? stacks.byKey(stacks.menu.key) : undefined
  const editStack = stacks.editing ? stacks.byKey(stacks.editing) : undefined

  // A column or section with nothing to show: filtered out, or empty.
  const emptyText = (status: Status) =>
    columns[status].some((t) => !stacks.inGathered(t))
      ? "No matching tasks"
      : narrow
        ? "No tasks"
        : status === "in_progress"
          ? "Drop a task here to start its agent"
          : status === "ready_for_merge"
            ? "Drop a task here to have its agent merge it"
            : "No tasks"

  const cards: CardsProps = { board, q, drops, menus, stacks, penLabels, onOpenPen, emptyText }

  const queryControls = (
    <>
      <SearchBox
        value={search}
        onChange={setSearch}
        tasks={tasks}
        keyOf={board.keyOf}
        projectName={board.projectName}
        showProject={projects.length > 1 || !!group || !!profiles}
        align={wide ? "right" : "left"}
      />
      <FilterMenu
        query={query}
        onChange={setQuery}
        statuses={board.statusOptions}
        kinds={board.kinds}
        projects={board.projectOptions}
        align={wide ? "right" : "left"}
      />
      <SortMenu sort={sort} onChange={changeSort} />
    </>
  )
  const controls = (
    <>
      {wide && queryControls}
      {stacks.kanban && stacks.stacks.length > 0 && <StacksSwitch gathered={stacks.views.gathered} onChange={stacks.gatherAll} labelled={roomy} />}
      <ViewToggle view={view} onChange={changeView} wide={wide} roomy={roomy} />
    </>
  )

  return (
    <div ref={setRoot} className="flex h-full min-h-0 flex-col">
      {renderHeader({ controls, newTask: () => setNewIn("todo") })}
      {notice && <div className="border-b border-line bg-panel/60 px-5 py-2 text-[12.5px] text-muted narrow:px-3">{notice}</div>}
      {(filtering || !wide) && (
        <FilterBar
          query={query}
          onChange={setQuery}
          tools={!wide && queryControls}
          shown={board.shownCount}
          total={total}
          statuses={board.statusOptions}
          projects={board.projectOptions}
        />
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
        // The triage view shows each task's last reply and a composer: not yet on this server (it needs threads, M2).
        <div className="p-8 text-muted">Triage is not yet on this server: it comes with threads.</div>
      ) : view === "graph" ? (
        <GraphView tasks={shownTasks} projectOf={projectOf} progressOf={progressOf} onMenu={onMenu} />
      ) : view === "list" && lanes ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <ListLanes {...cards} lanes={lanes} canAdd={canAdd} />
        </div>
      ) : view === "list" ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <ListView {...cards} canAdd={canAdd} />
        </div>
      ) : narrow ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <NarrowColumns {...cards} canAdd={canAdd} lanes={lanes} column={column} />
        </div>
      ) : lanes ? (
        <div ref={kanbanRef} className="kanban-scroll min-h-0 flex-1 overflow-auto">
          <KanbanLanes {...cards} lanes={lanes} canAdd={canAdd} />
        </div>
      ) : (
        <div ref={kanbanRef} onWheel={onKanbanWheel} className="kanban-scroll min-h-0 flex-1 overflow-x-auto">
          <Kanban {...cards} canAdd={canAdd} />
        </div>
      )}
      {menu && menuTask && <CardMenu menus={menus} task={menuTask} picked={picked} projectOf={projectOf} setDropErr={setDropErr} />}
      {stackMenu && stacks.menu && (
        <ContextMenu
          x={stacks.menu.x}
          y={stacks.menu.y}
          title={`Stack: ${stackTitle(stackMenu)}`}
          items={stacks.menuItems(stackMenu, setDropErr)}
          onClose={() => stacks.setMenu((m) => (m === stacks.menu ? null : m))}
        />
      )}
      {editStack && <StackEditModal stack={editStack} onClose={() => stacks.setEditing(null)} />}
      {picking && <ReminderModal task={picking} onClose={() => setPicking(null)} />}
      {renaming && <TitleModal task={renaming} onClose={() => setRenaming(null)} />}
      {doneDialog}
      {todosDialog}
      {menus.newPenDialog}
      {penMenu && picked.length > 0 && <PenMenu at={penMenu} menus={menus} picked={picked} setDropErr={setDropErr} />}
      <LassoPath path={lassoPath} />
      <SelectionBar
        count={picked.length}
        onClear={() => useSelection.getState().clear()}
        onPen={picked.some((t) => penItems(t, picked, setDropErr, newPen).length) ? (e) => setPenMenu({ x: e.clientX, y: e.clientY }) : undefined}
      />
      {newIn && canAdd && ready && (
        <NewTaskModal
          // A group's (or profile's) new task starts in the project last picked for one, if it's on the board.
          project={(choices.length > 1 && choices.find((p) => p.id === localStorage.getItem(PROJECT_KEY))) || project}
          projects={choices.length > 1 || group || scratch ? choices : undefined}
          group={group}
          scratch={scratch}
          status={newIn}
          onClose={() => {
            setNewIn(null)
            setNewLane(null)
          }}
          // Made in a pen's row, it goes in the pen.
          onCreated={(made) => {
            void Promise.resolve(onCreated?.(made)).catch((e) => setDropErr(errorText(e)))
            if (newLane) void moveToPen(made, newLane.name).catch((e) => setDropErr(errorText(e)))
          }}
        />
      )}
    </div>
  )
}

/** A board's New task button: just its + in the narrow layout. */
export function NewTaskButton({ onClick }: { onClick: () => void }) {
  return (
    <Button size="sm" variant="primary" onClick={onClick} aria-label="New task" className="narrow:h-9 narrow:w-9 narrow:px-0">
      <Plus size={14} /> <span className="narrow:hidden">New task</span>
    </Button>
  )
}
