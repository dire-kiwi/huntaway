import { clsx } from "clsx"
import { StatusIcon } from "../../ui"
import { BIN_BOX, Bin, BinHeader } from "./Bin"
import { Cards, type CardsProps } from "./Cards"
import { DropColumn } from "./DropColumn"
import { QUEUE } from "./model"

/**
 * Ready for merge on the kanban board: a label in its header, in place of a column (HE-52). A task or a gathered stack
 * dropped on the label goes to the end of the merge queue. Its popover is the queue, in the order it merges, whose
 * cards are a column's: drop one between them, drag them to reorder or out to another column, open their menus.
 */
export function MergeQueue(props: CardsProps & { labelled: boolean }) {
  const { drops, stacks, labelled } = props
  const count = stacks.columnCount(QUEUE)
  const hot = stacks.overColumn(drops.dropTarget, QUEUE)
  return (
    <Bin
      icon={<StatusIcon status={QUEUE} size={13} />}
      name="Ready for merge"
      count={count}
      title={`Ready for merge: ${count} task${count === 1 ? "" : "s"} merging or waiting to merge. Drop a task here to have its agent merge it`}
      labelled={labelled}
      hot={hot}
      tone={{ hot: "border-st-merge bg-st-merge/15 text-fg ring-2 ring-st-merge/30", open: "border-st-merge/60 bg-st-merge/10 text-fg" }}
      label={{ "data-status": QUEUE, onDragOver: (e) => drops.drops.onDragOver(e, QUEUE), onDrop: (e) => drops.drops.onDrop(e, QUEUE) }}
      onLeave={drops.drops.onLeave}
    >
      <DropColumn status={QUEUE} drops={drops.drops} aria-label="The merge queue" className={clsx(BIN_BOX, hot ? "border-st-merge/60" : "border-line-strong")}>
        <BinHeader icon={<StatusIcon status={QUEUE} />} name="Ready for merge" count={count} note="top merges first" />
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-2 pt-px pb-3">
          <Cards {...props} status={QUEUE} />
        </div>
      </DropColumn>
    </Bin>
  )
}
