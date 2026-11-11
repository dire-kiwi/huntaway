import { useMemo, useState } from "react"
import { type HostTask as Task } from "@huntaway/client"
import type { Status } from "@huntaway/contracts"

import { StatusIcon, type MenuItem } from "../../ui"
import { showsStatus, type BoardQuery, type SortKey } from "../boardQuery"
import { stackTitle, type OnStackMenu } from "../StackCard"
import {
  columnEntries,
  groupStacks,
  isGathered,
  loadStackViews,
  saveStackViews,
  withAll,
  withStack,
  type MergeCheck,
  type Stack,
  type StackViews,
} from "../stacks"
import type { DropTarget } from "./model"

// Not yet on this server: merging a whole stack (`tasks.mergeStack`) and a stack's title and description
// (`tasks.updateStack`). With them, `checkOf` is `mergeCheck(st, board.get().tasks)` on a host that can.
const checkOf = (_st: Stack): MergeCheck | null => null
const hasMeta = (_st: Stack) => false

/**
 * The board's stacks (HA-388): on the kanban board (not in rows of pens) the gathered ones are each one card in place of
 * their levels' cards, and a spread one's cards carry its tab. Which are gathered is kept in this browser. Also the
 * gathered card's menu, its drag, its edit dialog, and merging a whole stack (not yet on this server: it needs
 * `tasks.mergeStack` and `tasks.updateStack`, M4).
 */
export function useBoardStacks({
  tasks,
  shown,
  keep,
  now,
  query,
  sort,
  kanban,
}: {
  tasks: Task[]
  shown: Record<Status, Task[]>
  keep: (t: Task) => boolean
  now: number
  query: BoardQuery
  sort: SortKey
  /** Whether the board shows its columns without rows of pens: only there are stacks gathered. */
  kanban: boolean
}) {
  const [views, setViews] = useState<StackViews>(loadStackViews)
  const changeViews = (v: StackViews) => {
    setViews(v)
    saveStackViews(v)
  }
  // A gathered stack's menu, where it was opened, and the stack being dragged or edited.
  const [menu, setMenu] = useState<{ x: number; y: number; key: string } | null>(null)
  const [dragStack, setDragStack] = useState<Stack | null>(null)
  const [editing, setEditing] = useState<string | null>(null)

  const stacks = useMemo(() => groupStacks(tasks), [tasks])
  const gathered = useMemo(() => (kanban ? stacks.filter((st) => isGathered(views, st)) : []), [kanban, stacks, views])
  const entries = useMemo(
    () => columnEntries(shown, gathered, keep, (st) => showsStatus(query, st), sort, now, stackTitle),
    [shown, gathered, keep, query, sort, now],
  )
  const spreadOf = useMemo(() => {
    const m = new Map<string, Stack>()
    if (kanban) for (const st of stacks) if (!isGathered(views, st)) for (const t of st.tasks) m.set(t.id, st)
    return m
  }, [kanban, stacks, views])
  const byKey = (key: string) => stacks.find((st) => st.key === key)
  /** Whether what's dragged over column `status` would go there: a gathered stack only into Ready for merge, when it can merge. */
  const overColumn = (dropTarget: DropTarget | null, status: Status) =>
    dropTarget?.status === status && (!dragStack || (status === "ready_for_merge" && !!checkOf(dragStack)?.ok))
  /** How many cards a kanban column shows: a gathered stack counts as one. */
  const columnCount = (status: Status) => (kanban ? entries[status].length : shown[status].length)
  /** Whether task `t` is drawn in a gathered stack's card rather than as its own. */
  const inGathered = (t: Task) => gathered.some((st) => st.tasks.includes(t))

  /** Moves every open level of the stack's main line to Ready for merge, to merge as one run (API 153); or says why not. */
  const mergeStack = async (st: Stack, setErr: (msg: string | null) => void) => {
    const check = checkOf(st)
    if (!check) return
    if (!check.ok) return setErr(`The stack can't merge yet. ${check.reason}`)
    setErr("Couldn't merge the stack: not yet on this server. Spread it to move its levels one at a time.")
  }
  const onMenu: OnStackMenu = (e, st, button) => {
    e.preventDefault()
    const r = button && e.currentTarget instanceof HTMLElement ? e.currentTarget.getBoundingClientRect() : null
    setMenu({ x: r ? r.right : e.clientX, y: r ? r.bottom + 4 : e.clientY, key: st.key })
  }
  const spread = (st: Stack, gather: boolean) => changeViews(withStack(views, st, gather))
  /** The items of a gathered stack's menu. */
  const menuItems = (st: Stack, setErr: (msg: string | null) => void): MenuItem[] => {
    const check = checkOf(st)
    return [
      ...(check && st.main.some((t) => t.status !== "done")
        ? [
            {
              label: (
                <span className="flex flex-col">
                  <span className="flex items-center gap-2">
                    <StatusIcon status="ready_for_merge" size={13} /> Merge the stack
                  </span>
                  {!check.ok && <span className="max-w-64 pl-[21px] text-[11.5px] whitespace-normal text-faint">{check.reason}</span>}
                </span>
              ),
              onSelect: () => void mergeStack(st, setErr),
            },
          ]
        : []),
      { label: "Spread its cards", divider: !!check, onSelect: () => spread(st, false) },
      ...(hasMeta(st) ? [{ label: "Edit its title and description…", onSelect: () => setEditing(st.key) }] : []),
    ]
  }

  return {
    kanban,
    views,
    gatherAll: (g: boolean) => changeViews(withAll(g)),
    stacks,
    entries,
    spreadOf,
    byKey,
    checkOf,
    hasMeta,
    overColumn,
    columnCount,
    inGathered,
    mergeStack,
    spread,
    dragStack,
    setDragStack,
    menu,
    setMenu,
    onMenu,
    menuItems,
    editing,
    setEditing,
  }
}

export type BoardStacks = ReturnType<typeof useBoardStacks>
