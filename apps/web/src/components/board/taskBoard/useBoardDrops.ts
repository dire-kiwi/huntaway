import { useState, type DragEvent } from "react"
import { canRunAgents, isArchived, type HostTask as Task } from "@huntaway/client"
import type { Resolution, Status } from "@huntaway/contracts"
import type { TaskUpdateOptions } from "../ConfirmTodos"
import { inTab, moveToPen, type PenTab } from "../pens"

import { errorText } from "../../ui"
import type { SortKey } from "../boardQuery"
import { dropPosition } from "../taskOrder"
import type { Drops } from "./DropColumn"
import type { DropTarget } from "./model"
import type { BoardStacks } from "./useBoardStacks"
import { moveTask } from "../../boardHelpers"
import { board } from "../../../state/board"
import { rpc } from "../../../state/rpc"

/**
 * Dragging tasks over the board and dropping them: where one would go, the handlers of the columns and of the pens'
 * rows, the move a drop makes (`dropTask`), and what went wrong with one (`dropErr`, which the board's menus use too).
 */
export function useBoardDrops({
  sort,
  columns,
  shown,
  stacks,
  confirmTodos,
  confirmDone,
}: {
  sort: SortKey
  columns: Record<Status, Task[]>
  shown: Record<Status, Task[]>
  stacks: BoardStacks
  confirmTodos: (task: Task, status: Status) => Promise<TaskUpdateOptions | null>
  confirmDone: (task: Task, resolution?: Resolution) => Promise<boolean>
}) {
  // Where a dragged task would go: its column, the card it would go before, and in rows of pens, the row (its key).
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null)
  // The pen's row whose header (or list) a dragged task is over, which it would go in.
  const [overLane, setOverLane] = useState<string | null>(null)
  const [dropErr, setDropErr] = useState<string | null>(null)

  const onDragOver = (e: DragEvent, status: Status, lane?: string) => {
    // A gathered stack only goes to Ready for merge, to merge it as a whole; the other columns refuse it.
    if (e.dataTransfer.types.includes("text/stack-id")) {
      if (status === "ready_for_merge" && !lane) e.preventDefault()
      else e.dataTransfer.dropEffect = "none"
      if (dropTarget?.status !== status || dropTarget.before !== null) setDropTarget({ status, before: null })
      return
    }
    if (!e.dataTransfer.types.includes("text/task-id")) return
    e.preventDefault()
    // A gathered stack's card takes the place of one of its levels, which a task dropped above it goes before.
    const cards = e.currentTarget instanceof HTMLElement ? Array.from(e.currentTarget.querySelectorAll<HTMLElement>("[data-task], [data-drop-before]")) : []
    const before = cards.find((c) => {
      const r = c.getBoundingClientRect()
      return e.clientY < r.top + r.height / 2
    })
    // Sorted other than by hand, a task dropped goes to the end of its column, wherever it's let go.
    const beforeId = sort === "manual" ? (before?.dataset.task ?? before?.dataset.dropBefore ?? null) : null
    if (dropTarget?.status !== status || dropTarget.before !== beforeId || dropTarget.lane !== lane) setDropTarget({ status, before: beforeId, lane })
  }

  const onDrop = (e: DragEvent, status: Status, lane?: PenTab) => {
    e.preventDefault()
    const target = dropTarget
    setDropTarget(null)
    const stackKey = e.dataTransfer.getData("text/stack-id")
    if (stackKey) {
      stacks.setDragStack(null)
      const st = stacks.byKey(stackKey)
      if (st && status === "ready_for_merge") void stacks.mergeStack(st, setDropErr)
      return
    }
    const id = e.dataTransfer.getData("text/task-id")
    const task = board.get().tasks[id]
    if (!task) return
    // Into the row's pen first, which shows at once, so the move to the column keeps it.
    if (lane && !inTab(lane, task)) void moveToPen([task], lane.name).catch((err: unknown) => setDropErr(errorText(err)))
    void dropTask(board.get().tasks[id] ?? task, status, target?.before ?? null)
  }
  const drops: Drops = { onDragOver, onDrop, onLeave: () => setDropTarget(null) }
  // A pen's row's cells: dropped in one, a task goes in its column and its pen.
  const laneDrops = (lane: PenTab): Drops => ({
    onDragOver: (e, status) => onDragOver(e, status, lane.key),
    onDrop: (e, status) => onDrop(e, status, lane),
    onLeave: drops.onLeave,
  })
  // A pen's row's header, collapsed or not, and its list: dropped on it, a task goes in its pen, in the column it's in.
  const penDrop = (lane: PenTab) => ({
    onDragOver: (e: DragEvent) => {
      if (!e.dataTransfer.types.includes("text/task-id")) return
      e.preventDefault()
      // Not the cell it's over too, in the board view.
      e.stopPropagation()
      if (dropTarget) setDropTarget(null)
      if (overLane !== lane.key) setOverLane(lane.key)
    },
    onDragLeave: (e: DragEvent) => {
      if (!(e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget))) setOverLane((o) => (o === lane.key ? null : o))
    },
    onDrop: (e: DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      setOverLane(null)
      const task = board.get().tasks[e.dataTransfer.getData("text/task-id")]
      if (task && !inTab(lane, task)) void moveToPen([task], lane.name).catch((err: unknown) => setDropErr(errorText(err)))
    },
  })

  /** Moves `task` into column `status` before task `before`, or after its last task shown: as dropping it there does. */
  const dropTask = async (task: Task, status: Status, before: string | null) => {
    const id = task.id
    // Dropped on its own top half (the drop line shows above it): it stays where it is.
    if (before === id) return
    // Dragged from the Archived section back into Done, it's done from now (and archived again in two days).
    const unarchive = status === "done" && isArchived(task, Date.now())
    // Sorted, it keeps its place in its own column, and goes last in another.
    if (sort !== "manual" && task.status === status && !unarchive) return
    const col = columns[status].filter((t) => t.id !== id)
    // Before the card it's dropped above, or after the last card shown, which with filters may not be the column's last.
    const last = (stacks.kanban ? stacks.entries[status].map((x) => x.task) : shown[status]).findLast((t) => t.id !== id)
    const idx = sort !== "manual" ? -1 : before ? col.findIndex((t) => t.id === before) : last ? col.findIndex((t) => t.id === last.id) + 1 : -1
    const { position, moves } = dropPosition(col, idx === -1 ? col.length : idx)
    if (task.status === status && task.position === position && !moves.length && !unarchive) return
    const anyway = await confirmTodos(task, status)
    if (!anyway) return
    if (status === "done" && !(await confirmDone(task))) return
    // As the server sets it.
    const done_at = status !== "done" ? null : unarchive || task.status !== "done" ? new Date().toISOString() : task.done_at
    const all = board.get().tasks
    const moved = moves.flatMap((m) => {
      const was = all[m.id]
      return was ? [{ before: was, position: m.position }] : []
    })
    setDropErr(null)
    try {
      // Shown at once, and put back if the host refuses (moveTask).
      await Promise.all([
        moveTask(task, { status, position, ...anyway, ...(unarchive && done_at && { done_at }) }),
        ...moved.map((m) => moveTask(m.before, { position: m.position })),
      ])
      // Moving a fresh task into In progress starts its agent, with the empty message (the old client's `moveTask`).
      const host = board.get().hosts.find((h) => h.id === task.host_id)
      const starts = status === "in_progress" && task.status !== "in_progress" && !task.session_id && !task.running && canRunAgents(host)
      if (starts) await rpc(task.host_id, "tasks.send", { id: task.id, text: "" })
    } catch (e) {
      setDropErr(errorText(e))
    }
  }

  return { dropTarget, setDropTarget, overLane, dropErr, setDropErr, drops, laneDrops, penDrop, dropTask }
}

export type BoardDrops = ReturnType<typeof useBoardDrops>
