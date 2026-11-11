import { useLayoutEffect, useRef, useState, type WheelEvent } from "react"
import { WIDE_BOARD, WIDE_VIEWS } from "./model"

// A plain wheel scrolls the board sideways when it overflows, unless a column's list under the pointer can scroll that way.
const onKanbanWheel = (e: WheelEvent<HTMLDivElement>) => {
  const board = e.currentTarget
  if (e.shiftKey || e.ctrlKey || e.deltaY === 0 || Math.abs(e.deltaX) >= Math.abs(e.deltaY) || board.scrollWidth <= board.clientWidth) return
  for (let el = e.target instanceof HTMLElement ? e.target : null; el && el !== board; el = el.parentElement) {
    const y = getComputedStyle(el).overflowY
    if ((y === "auto" || y === "scroll") && (e.deltaY < 0 ? el.scrollTop > 0 : el.scrollTop + el.clientHeight < el.scrollHeight - 1)) return
  }
  board.scrollLeft += e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * board.clientWidth : e.deltaY
}

/** The board's root element and what fits at its width, and the kanban board's scrolling. */
export function useBoardLayout() {
  // The search, filter and sort controls go in the header when the board is wide enough for them beside
  // its title and buttons (a subproject's has the most), and otherwise in a row of their own below it.
  const [root, setRoot] = useState<HTMLDivElement | null>(null)
  const [wide, setWide] = useState(true)
  const [roomy, setRoomy] = useState(true)
  useLayoutEffect(() => {
    if (!root) return undefined
    const fits = (width: number) => {
      setWide(width >= WIDE_BOARD)
      setRoomy(width >= WIDE_VIEWS)
    }
    fits(root.getBoundingClientRect().width)
    const ro = new ResizeObserver(([e]) => e && fits(e.contentRect.width))
    ro.observe(root)
    return () => ro.disconnect()
  }, [root])

  const kanbanRef = useRef<HTMLDivElement>(null)

  return { root, setRoot, wide, roomy, kanbanRef, onKanbanWheel }
}

export type BoardLayout = ReturnType<typeof useBoardLayout>
