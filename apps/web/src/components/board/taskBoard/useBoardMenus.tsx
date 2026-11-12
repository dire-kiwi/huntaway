import { useCallback, useState, type MouseEvent } from "react"
import { Effect } from "effect"
import { isArchived, type HostTask as Task } from "@huntaway/client"
import type { Resolution, Status } from "@huntaway/contracts"
import type { TaskUpdateOptions } from "../ConfirmTodos"
import type { PenTab } from "../penModel"

import { isoOf, StatusIcon, type MenuItem } from "../../ui"
import { useNewPen } from "../Pens"
import { moveTaskEffect } from "../../boardHelpers"
import { useBoard } from "../../../state/board"
import { nowMillis } from "../../../state/clock"
import { exitError, runExit } from "../../../state/mutation"

/**
 * The board's menus and dialogs: a card's menu and what its items do, the picked tasks' pen menu, the task being
 * renamed or given a reminder, and where New task was clicked.
 */
export function useBoardMenus({
  statuses,
  columns,
  confirmTodos,
  confirmDone,
  dropTask,
  setDropErr,
}: {
  statuses: { id: Status; label: string }[]
  columns: Record<Status, Task[]>
  confirmTodos: (task: Task, status: Status) => Promise<TaskUpdateOptions | null>
  confirmDone: (task: Task, resolution?: Resolution) => Promise<boolean>
  dropTask: (task: Task, status: Status, before: string | null) => Promise<void>
  setDropErr: (msg: string | null) => void
}) {
  const [newIn, setNewIn] = useState<Status | null>(null)
  // The pen's row New task was clicked in, whose pen the task goes in.
  const [newLane, setNewLane] = useState<PenTab | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; taskId: string; move?: boolean | undefined } | null>(null)
  const [picking, setPicking] = useState<Task | null>(null)
  const [renaming, setRenaming] = useState<Task | null>(null)
  // Where the picked tasks' pen menu is, from the selection bar.
  const [penMenu, setPenMenu] = useState<{ x: number; y: number } | null>(null)
  const { newPen, dialog: newPenDialog } = useNewPen(setDropErr)

  // Moves a task to the end of Done with that resolution (one already done keeps its place). An archived one comes back
  // into Done, done from now, as dragging it there does.
  const complete = (task: Task, resolution: Resolution): Promise<void> => {
    const unarchive = isArchived(task, nowMillis())
    const stays = task.status === "done" && !unarchive
    if (stays && task.resolution === resolution) return Promise.resolve()
    const move = Effect.gen(function* () {
      const anyway = yield* Effect.promise(() => confirmTodos(task, "done"))
      if (!anyway) return
      // Unmerged work, or (closing it) tasks merging into it.
      if (!(yield* Effect.promise(() => confirmDone(task, resolution)))) return
      const done = columns.done.filter((t) => t.id !== task.id)
      const position = stays ? task.position : (done.at(-1)?.position ?? 0) + 1
      const done_at = stays ? task.done_at : isoOf(nowMillis())
      setDropErr(null)
      yield* moveTaskEffect(task, { status: "done", resolution, position, ...anyway, ...(unarchive && done_at && { done_at }) })
    })
    return runExit(move).then((exit) => {
      const failed = exitError(exit)
      if (failed !== null) setDropErr(failed)
    })
  }
  // The same function from render to render, so the (memoized) cards don't all redraw.
  const onMenu = useCallback((e: MouseEvent, task: Task, move?: boolean) => {
    e.preventDefault()
    // From its menu button, under the button.
    const r = move && e.currentTarget instanceof HTMLElement ? e.currentTarget.getBoundingClientRect() : null
    setMenu({ x: r ? r.right : e.clientX, y: r ? r.bottom + 4 : e.clientY, taskId: task.id, move })
  }, [])

  const menuTask = useBoard((s) => (menu ? s.tasks[menu.taskId] : null))
  // The tasks made from the same prompt as it, it among them, to compare (see Compare.tsx).
  const menuSiblings = useBoard((s) =>
    menuTask?.fanout_id ? Object.values(s.tasks).filter((t) => t.host_id === menuTask.host_id && t.fanout_id === menuTask.fanout_id).length : 0,
  )
  /** The columns to move a task to from its menu: all but Done where Done's resolutions follow them. */
  const moveItems = (task: Task): MenuItem[] =>
    statuses
      .filter((s) => s.id !== "done")
      .map((s) => ({
        label: (
          <span className="flex items-center gap-2">
            <StatusIcon status={s.id} size={13} /> {s.label}
          </span>
        ),
        checked: task.status === s.id && !isArchived(task, nowMillis()),
        onSelect: () => (task.status !== s.id || isArchived(task, nowMillis())) && dropTask(task, s.id, null),
      }))

  const newTaskIn = (status: Status, lane: PenTab | null = null) => {
    setNewIn(status)
    setNewLane(lane)
  }

  return {
    newIn,
    setNewIn,
    newLane,
    setNewLane,
    newTaskIn,
    menu,
    setMenu,
    menuTask,
    menuSiblings,
    moveItems,
    complete,
    onMenu,
    picking,
    setPicking,
    renaming,
    setRenaming,
    penMenu,
    setPenMenu,
    newPen,
    newPenDialog,
  }
}

export type BoardMenus = ReturnType<typeof useBoardMenus>
