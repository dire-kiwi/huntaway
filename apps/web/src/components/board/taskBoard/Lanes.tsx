import { clsx } from "clsx"
import { ChevronLeft, ChevronRight, Fence, Plus } from "lucide-react"
import { PEN_COLORS } from "@huntaway/client"
import { inTab, type PenLanes, type PenTab } from "../pens"
import { IconButton, StatusIcon } from "../../ui"
import { TaskRow } from "../TaskCard"
import { Cards, type CardsProps } from "./Cards"
import { DropColumn } from "./DropColumn"
import { CAN_ADD } from "./model"

/** What the rows of pens are drawn from, with the cards'. */
export type LanesProps = CardsProps & { lanes: PenLanes; canAdd: boolean }

/** A pen's row's header: its name and how many tasks it has (`count`), which collapses or opens it, and its New task. */
export function LaneHeader({
  lane,
  count,
  className,
  lanes,
  drops,
  menus,
  canAdd,
}: LanesProps & { lane: PenTab; count: number; className?: string | undefined }) {
  const open = !lanes.collapsed.has(lane.key)
  return (
    <div
      data-pen-lane={lane.name}
      {...drops.penDrop(lane)}
      className={clsx("flex items-center gap-1 rounded-md pr-1 transition-colors", drops.overLane === lane.key && "bg-accent/15", className)}
    >
      <button
        aria-expanded={open}
        onClick={() => lanes.onToggle(lane.key)}
        title={open ? `Collapse the ${lane.name} pen's row` : `Show the ${lane.name} pen's tasks`}
        className="flex min-w-0 items-center gap-2 rounded-md py-0.5 pr-1 text-left"
      >
        <ChevronRight size={14} className={clsx("shrink-0 text-faint transition-transform", open && "rotate-90")} />
        <Fence size={13} className="shrink-0" style={{ color: PEN_COLORS[lane.color].base }} />
        <h2 className="truncate text-[13px] font-medium">{lane.name}</h2>
        <span className="text-[12px] text-faint">{count}</span>
      </button>
      {canAdd && (
        <IconButton className="h-6 w-6" title={`New task in the ${lane.name} pen`} onClick={() => menus.newTaskIn("todo", lane)}>
          <Plus size={14} />
        </IconButton>
      )}
    </div>
  )
}

/** What rows of pens say when there are no pens. */
export function NoLanes({ lanes }: { lanes: PenLanes }) {
  return !lanes.tabs.length && <div className="px-4 py-12 text-center text-[12.5px] text-faint">{lanes.empty}</div>
}

/** The list view in rows of pens: a section for each, of its tasks in the order of the statuses. */
export function ListLanes(props: LanesProps) {
  const { lanes, board, drops, menus } = props
  const { shownTasks, projectOf, progressOf } = board
  const { overLane, penDrop } = drops
  return (
    <div className="space-y-5 p-6 narrow:p-3">
      <NoLanes lanes={lanes} />
      {lanes.tabs.map((lane) => {
        const items = shownTasks.filter((t) => inTab(lane, t))
        return (
          <section key={lane.key} {...penDrop(lane)} aria-label={`The ${lane.name} pen`}>
            <LaneHeader {...props} lane={lane} count={items.length} className="mb-2 w-fit" />
            {!lanes.collapsed.has(lane.key) &&
              (items.length === 0 ? (
                <div
                  className={clsx(
                    "rounded-lg border border-dashed px-4 py-4 text-center text-[12.5px] text-faint transition-colors",
                    overLane === lane.key ? "border-accent/40 bg-accent/[0.03]" : "border-line",
                  )}
                >
                  No tasks: drop one here to put it in the pen
                </div>
              ) : (
                <div className={clsx("overflow-hidden rounded-lg border transition-colors", overLane === lane.key ? "border-accent/40" : "border-line")}>
                  {items.map((t, i) => (
                    <div key={t.id} className={clsx(i > 0 && "border-t border-line")}>
                      <TaskRow task={t} project={projectOf(t)} progress={progressOf(t)} onMenu={menus.onMenu} />
                    </div>
                  ))}
                </div>
              ))}
          </section>
        )
      })}
    </div>
  )
}

/** The board in rows of pens: the columns' headers, then a row for each pen with a cell in each column. */
export function KanbanLanes(props: LanesProps) {
  const { lanes, board, q, drops, menus, canAdd } = props
  const { shownStatuses, shown } = board
  const { backlogOpen, toggleBacklog } = q
  const { dropTarget, laneDrops } = drops
  // How many of the tasks shown on the board (not archived ones) are in a pen's row.
  const laneCount = (lane: PenTab) => shownStatuses.reduce((n, s) => n + shown[s.id].filter((t) => inTab(lane, t)).length, 0)
  return (
    <div className="w-max min-w-full px-4 pb-4">
      <div className="sticky top-0 z-10 flex gap-3 bg-bg pt-4 pb-1">
        {shownStatuses.map((s) =>
          s.id === "backlog" && !backlogOpen ? (
            <button
              key={s.id}
              title={`Show the backlog (${shown[s.id].length})`}
              onClick={toggleBacklog}
              className="flex h-9 w-10 min-w-10 shrink-0 items-center justify-center rounded-xl border border-line/70 bg-panel/50 text-muted transition-colors hover:bg-raised/40 hover:text-fg"
            >
              <StatusIcon status={s.id} />
            </button>
          ) : (
            <div key={s.id} className="flex h-9 w-[240px] min-w-[240px] flex-1 items-center gap-2 rounded-xl border border-line/70 bg-panel/50 px-3">
              <StatusIcon status={s.id} />
              <span className="text-[12.5px] font-medium">{s.label}</span>
              <span className="text-[12px] text-faint">{shown[s.id].length}</span>
              <div className="ml-auto flex items-center gap-0.5">
                {canAdd && CAN_ADD.has(s.id) && (
                  <IconButton className="h-6 w-6" title={`New task in ${s.label}`} onClick={() => menus.newTaskIn(s.id)}>
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
          ),
        )}
      </div>
      <NoLanes lanes={lanes} />
      {lanes.tabs.map((lane) => (
        <section key={lane.key} className="mt-3" aria-label={`The ${lane.name} pen`}>
          {/* The header stays in view as the board scrolls sideways. */}
          <LaneHeader {...props} lane={lane} count={laneCount(lane)} className="sticky left-4 w-fit" />
          {!lanes.collapsed.has(lane.key) && (
            <div className="mt-1.5 flex gap-3">
              {shownStatuses.map((s) => {
                const here = dropTarget?.status === s.id && dropTarget.lane === lane.key
                return s.id === "backlog" && !backlogOpen ? (
                  <DropColumn
                    key={s.id}
                    status={s.id}
                    drops={laneDrops(lane)}
                    title={`In the backlog: ${shown[s.id].filter((t) => inTab(lane, t)).length}`}
                    className={clsx(
                      "flex w-10 min-w-10 shrink-0 justify-center rounded-xl border bg-panel/50 pt-2 text-[12px] text-faint transition-colors",
                      here ? "border-accent/40 bg-accent/[0.03]" : "border-line/70",
                    )}
                  >
                    {shown[s.id].filter((t) => inTab(lane, t)).length}
                  </DropColumn>
                ) : (
                  <DropColumn
                    key={s.id}
                    status={s.id}
                    drops={laneDrops(lane)}
                    className={clsx(
                      "min-h-14 w-[240px] min-w-[240px] flex-1 space-y-2 rounded-xl border bg-panel/50 p-2 transition-colors",
                      here ? "border-accent/40 bg-accent/[0.03]" : "border-line/70",
                    )}
                  >
                    <Cards {...props} status={s.id} lane={lane} />
                  </DropColumn>
                )
              })}
            </div>
          )}
        </section>
      ))}
    </div>
  )
}
