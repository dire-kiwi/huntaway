import { clsx } from "clsx"
import { ChevronLeft, ChevronRight, Plus } from "lucide-react"
import { inTab, type PenLanes } from "../penModel"
import { IconButton, StatusIcon } from "../../ui"
import { Cards, type CardsProps } from "./Cards"
import { DropColumn } from "./DropColumn"
import { LaneHeader, NoLanes } from "./Lanes"
import { CAN_ADD } from "./model"
import type { BoardColumn } from "./useBoardColumn"

/** The kanban board: a column for each status. */
export function Kanban(props: CardsProps & { canAdd: boolean }) {
  const { board, q, drops, menus, stacks, canAdd } = props
  const { shownStatuses } = board
  const { backlogOpen, toggleBacklog } = q
  const { dropTarget } = drops
  return (
    // w-max keeps the right padding when the columns overflow; min-w-full lets them grow to fill a wide window.
    <div className="flex h-full w-max min-w-full gap-3 p-4">
      {shownStatuses.map((s) =>
        s.id === "backlog" && !backlogOpen ? (
          // Parked work stays out of the way: a strip at the start that opens into a column and still takes drops.
          <DropColumn
            key={s.id}
            status={s.id}
            drops={drops.drops}
            className={clsx(
              "flex h-full w-10 min-w-10 shrink-0 flex-col rounded-xl border bg-panel/50 transition-colors",
              stacks.overColumn(dropTarget, s.id) ? "border-accent/40 bg-accent/[0.03]" : "border-line/70",
            )}
          >
            <button
              title={`Show the backlog (${stacks.columnCount(s.id)})`}
              onClick={toggleBacklog}
              className="flex h-full w-full flex-col items-center gap-2 rounded-xl pt-3 text-muted transition-colors hover:bg-raised/40 hover:text-fg"
            >
              <ChevronRight size={14} className="text-faint" />
              <StatusIcon status={s.id} />
              <span className="text-[12px] text-faint">{stacks.columnCount(s.id)}</span>
              <span className="text-[12.5px] font-medium [writing-mode:vertical-rl]">{s.label}</span>
            </button>
          </DropColumn>
        ) : (
          <DropColumn
            key={s.id}
            status={s.id}
            drops={drops.drops}
            className={clsx(
              "flex h-full w-[240px] min-w-[240px] flex-1 flex-col rounded-xl border bg-panel/50 transition-colors",
              stacks.overColumn(dropTarget, s.id) ? "border-accent/40 bg-accent/[0.03]" : "border-line/70",
            )}
          >
            <div className="flex items-center gap-2 px-3 pt-3 pb-[7px]">
              <StatusIcon status={s.id} />
              <span className="text-[12.5px] font-medium">{s.label}</span>
              <span className="text-[12px] text-faint">{stacks.columnCount(s.id)}</span>
              <div className="ml-auto flex items-center gap-0.5">
                {canAdd && CAN_ADD.has(s.id) && (
                  <IconButton className="h-6 w-6" title={`New task in ${s.label}`} onClick={() => menus.setNewIn(s.id)}>
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
              <Cards {...props} status={s.id} />
            </div>
          </DropColumn>
        ),
      )}
    </div>
  )
}

/** The narrow layout's board: one column at a time, picked above it or by swiping sideways. */
export function NarrowColumns(props: CardsProps & { canAdd: boolean; lanes?: PenLanes | undefined; column: BoardColumn }) {
  const { board, drops, menus, canAdd, lanes, column } = props
  const { shownStatuses, shown } = board
  const { shownColumn, pickColumn, columnsRef, columnTabsRef, onColumnsScroll, onColumnsScrollEnd } = column
  return (
    <>
      <div
        ref={columnTabsRef}
        role="tablist"
        aria-label="Columns"
        className="flex shrink-0 gap-1.5 overflow-x-auto border-b border-line px-3 py-2 [scrollbar-width:none]"
      >
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
            <span className="text-faint">{props.stacks.columnCount(s.id)}</span>
          </button>
        ))}
      </div>
      <div
        ref={columnsRef}
        onScroll={onColumnsScroll}
        onScrollEnd={onColumnsScrollEnd}
        className="flex min-h-0 flex-1 snap-x snap-mandatory overflow-x-auto overscroll-x-contain [scrollbar-width:none]"
      >
        {shownStatuses.map((s) => {
          const add = canAdd && CAN_ADD.has(s.id) && (
            <button
              onClick={() => menus.newTaskIn(s.id)}
              className="flex h-10 w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-line text-[12.5px] text-muted hover:text-fg"
            >
              <Plus size={14} /> New task in {s.label}
            </button>
          )
          const panel = "h-full w-full shrink-0 snap-start snap-always overflow-y-auto px-3 pt-3 pb-6"
          // In rows of pens, the column's tasks under their pens' headers.
          return lanes ? (
            <div key={s.id} role="tabpanel" aria-label={s.label} inert={s.id !== shownColumn} className={clsx(panel, "space-y-4")}>
              <NoLanes lanes={lanes} />
              {lanes.tabs.map((lane) => (
                <DropColumn key={lane.key} status={s.id} drops={drops.laneDrops(lane)} aria-label={`The ${lane.name} pen`} className="space-y-2">
                  <LaneHeader {...props} lanes={lanes} lane={lane} count={shown[s.id].filter((t) => inTab(lane, t)).length} className="w-fit" />
                  {!lanes.collapsed.has(lane.key) && <Cards {...props} status={s.id} lane={lane} />}
                </DropColumn>
              ))}
              {add}
            </div>
          ) : (
            <DropColumn
              key={s.id}
              status={s.id}
              drops={drops.drops}
              role="tabpanel"
              aria-label={s.label}
              inert={s.id !== shownColumn}
              className={clsx(panel, "space-y-2")}
            >
              <Cards {...props} status={s.id} />
              {add}
            </DropColumn>
          )
        })}
      </div>
    </>
  )
}
