import { useAtom } from "@effect/atom-react"
import { useLayoutEffect, useRef, useState, type UIEvent } from "react"
import type { Status } from "@huntaway/contracts"
import { boardColumnAtom } from "../../../state/prefs"
import { after } from "../../../state/timers"

/** The columns' elements that have been scrolled to a column once: after that they scroll smoothly. */
const shownColumns = new WeakSet<HTMLElement>()

/** The column the narrow layout's board shows (kept by `boardKey`), and its scrolling into view. */
export function useBoardColumn({
  boardKey,
  shownStatuses,
  count,
  total,
}: {
  boardKey: string
  shownStatuses: { id: Status; label: string }[]
  /** How many cards each column shows. */
  count: (status: Status) => number
  total: number
}) {
  // The one picked, kept in this browser (`ia.board.column.<board>`); until then, the one settled on below (not kept).
  const [picked, setPicked] = useAtom(boardColumnAtom(boardKey))
  const [settled, setColumn] = useState<Status | null>(null)
  const column = picked ?? settled

  // The narrow layout's board shows one column at a time, picked above it or by swiping sideways: the one picked
  // last, while it's shown. Until one is picked, what needs attention, or else the first column with tasks.
  const firstColumn = () => {
    const work = shownStatuses.filter((s) => s.id !== "backlog")
    return (work.find((s) => s.id === "needs_attention" && count(s.id)) ?? work.find((s) => count(s.id)) ?? work[0] ?? shownStatuses[0])?.id
  }
  const shownColumn = column && shownStatuses.some((s) => s.id === column) ? column : firstColumn()
  // Which that is is settled once the board has tasks, so it doesn't change under you as they move.
  const settle = !column && total > 0 ? shownColumn : undefined
  if (settle) setColumn(settle)
  const columnIndex = shownStatuses.findIndex((s) => s.id === shownColumn)
  // The columns' element (a callback ref): its scroll is set again whenever it's drawn anew (the narrow layout, the view).
  const [columnsEl, columnsRef] = useState<HTMLDivElement | null>(null)
  const columnTabsRef = useRef<HTMLDivElement>(null)
  /**
   * The column being scrolled to, which the columns passed on the way don't take over from, until the scroll ends: on a
   * busy phone it can take a while to get going, and a column it had barely left took back over (HA-92). Without
   * scrollend (Safari before 26), until the scroll has had time to end.
   */
  const scrollingTo = useRef<{ index: number; cancel?: (() => void) | undefined } | null>(null)
  const pickColumn = (s: Status) => setPicked(s)
  useLayoutEffect(() => {
    const el = columnsEl
    if (!el || columnIndex < 0) return
    columnTabsRef.current?.querySelector("[aria-selected=true]")?.scrollIntoView({ block: "nearest", inline: "nearest" })
    // At once when the board opens, smoothly from one column to another.
    const smooth = shownColumns.has(el)
    shownColumns.add(el)
    const left = columnIndex * el.clientWidth
    if (Math.abs(el.scrollLeft - left) <= 1) return
    if (smooth) {
      scrollingTo.current?.cancel?.()
      scrollingTo.current = {
        index: columnIndex,
        cancel: "onscrollend" in window ? undefined : after(800, () => (scrollingTo.current = null)),
      }
    }
    el.scrollTo({ left, behavior: smooth ? "smooth" : "instant" })
  }, [columnIndex, columnsEl])
  const onColumnsScroll = (e: UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget
    const i = Math.round(el.scrollLeft / el.clientWidth)
    if (Math.abs(el.scrollLeft - i * el.clientWidth) > 2) return
    if (scrollingTo.current) {
      if (scrollingTo.current.index === i) scrollingTo.current = null
      return
    }
    const s = shownStatuses[i]?.id
    if (s && s !== shownColumn) pickColumn(s)
  }
  // Where it ended is picked, if that isn't where it was going (a swipe took over).
  const onColumnsScrollEnd = (e: UIEvent<HTMLDivElement>) => {
    if (!scrollingTo.current) return
    scrollingTo.current = null
    onColumnsScroll(e)
  }

  return { shownColumn, pickColumn, columnsRef, columnTabsRef, onColumnsScroll, onColumnsScrollEnd }
}

export type BoardColumn = ReturnType<typeof useBoardColumn>
