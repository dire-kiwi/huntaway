import { useMemo, useState } from "react"
import { useAtom } from "@effect/atom-react"
import { Atom } from "effect/reactivity"
import { type HostTask as Task } from "@huntaway/client"
import { TaskId, type Status } from "@huntaway/contracts"
import { board } from "../../../state/board"
import { exitError, useMutation } from "../../../state/mutation"
import { stacksAtom, stackViewsAtom } from "../../../state/prefs"

import { StatusIcon, type MenuItem } from "../../ui"
import { showsStatus, type BoardQuery, type SortKey } from "../boardQuery"
import { stackTitle, type OnStackMenu } from "../StackCard"
import { columnEntries, groupStacks, isGathered, mergeCheck, withAll, withStack, type MergeCheck, type Stack, type StackViews } from "../stacks"
import type { DropTarget } from "./model"

/** Which stacks are gathered, in this browser: the switch (`ia.board.stacks`) and the ones set on their own. */
const stackViewsKept = Atom.writable(
  (get): StackViews => ({ gathered: get(stacksAtom) !== "spread", own: get(stackViewsAtom) }),
  (ctx, v: StackViews) => {
    ctx.set(stacksAtom, v.gathered ? "gathered" : "spread")
    ctx.set(stackViewsAtom, v.own)
  },
)

/** Whether stack `st` can merge as a whole (API 153): every host on this server can. */
const checkOf = (st: Stack): MergeCheck | null => mergeCheck(st, board.get().tasks)
/** Whether its title and description can be kept (API 152): every host on this server can. */
const hasMeta = (_st: Stack) => true

/**
 * The board's stacks (HA-388): on the kanban board (not in rows of pens) the gathered ones are each one card in place of
 * their levels' cards, and a spread one's cards carry its tab. Which are gathered is kept in this browser. Also the
 * gathered card's menu, its drag, its edit dialog, and merging a whole stack (`tasks.mergeStack`, 4.8).
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
  const [views, changeViews] = useAtom(stackViewsKept)
  // A gathered stack's menu, where it was opened, and the stack being dragged or edited.
  const [menu, setMenu] = useState<{ x: number; y: number; key: string } | null>(null)
  const [dragStack, setDragStack] = useState<Stack | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [, mergeStackCall] = useMutation("tasks.mergeStack")

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
  const mergeStack = (st: Stack, setErr: (msg: string | null) => void) => {
    const check = checkOf(st)
    if (!check) return
    if (!check.ok) return setErr(`The stack can't merge yet. ${check.reason}`)
    setErr(null)
    // The levels as moved come back as events.
    void mergeStackCall(st.bottom.host_id, { id: TaskId.make(st.bottom.id) }).then((exit) => {
      const failed = exitError(exit)
      if (failed !== null) setErr(`Couldn't merge the stack: ${failed}`)
    })
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
              onSelect: () => mergeStack(st, setErr),
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
