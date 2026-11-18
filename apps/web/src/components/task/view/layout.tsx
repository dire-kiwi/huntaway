import { Maximize2, Minimize2, X } from "lucide-react"
import { useLayoutEffect, useState } from "react"
import { closeTask, closeTaskModal, setPanelExpanded } from "../../../state/route"
import { useNarrow } from "../../../narrow"
import { IconButton } from "../../ui"

/**
 * "thread", "changes", "review", "terminal", "details", `tool:<id>` for a terminal tool, or for a plan,
 * artifact or diagram task its type, for its document.
 */
export type Tab = string

/** "page": the whole screen. "expanded": a dialog over the board, as a task opens (HE-30). "panel": collapsed beside it. "modal": a dialog over any page, apart from the side panel (see useTaskModal). */
export type Mode = "page" | "panel" | "expanded" | "modal"

// Below this width the key items beside the thread are left to the Details tab, which is then one list rather than two
// columns, and the header's controls move into a second row.
const WIDE = 880

/** Whether the element is at least WIDE (taken as wide until measured, but for the narrow layout), followed as it
 * resizes, and its width (null until measured). Use the returned ref on it. */
export function useWide() {
  const [el, setEl] = useState<HTMLElement | null>(null)
  const [width, setWidth] = useState<number | null>(null)
  const narrow = useNarrow()
  useLayoutEffect(() => {
    if (!el) return undefined
    // The first size comes from the observer, which reports it as soon as it starts watching.
    const ro = new ResizeObserver(([e]) => {
      if (e) setWidth(e.contentRect.width)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [el])
  return [setEl, width === null ? !narrow : width >= WIDE, width] as const
}

/** How wide the title stays beside the header's controls before they go to a row of their own. */
const TITLE_MIN = 120

/**
 * Whether the header's controls go in the title row: where they may (`wide`), and the title keeps `TITLE_MIN` of its
 * width beside them (or all of it, if shorter). The tabs, pills and buttons vary from task to task, so it's measured:
 * when they don't fit, the width they'd need is kept, and they go back once the view (`width`, useWide's) is that wide.
 * Use the returned ref on the title row, which holds the title's `h1` and is as wide as the view. Starts again when
 * `reset` changes.
 */
export function useControlsFit(wide: boolean, width: number | null, reset: string) {
  const [row, setRow] = useState<HTMLElement | null>(null)
  const [need, setNeed] = useState({ reset, px: 0 })
  const inRow = wide && (width === null || need.reset !== reset || width >= need.px)
  useLayoutEffect(() => {
    if (!row || !inRow) return undefined
    const check = () => {
      const title = row.querySelector("h1")
      if (!title) return
      // What the title is short of, and how far the row overflows once it's down to nothing.
      const short = Math.min(TITLE_MIN, title.scrollWidth) - title.clientWidth + Math.max(0, row.scrollWidth - row.clientWidth)
      // The row's width as it is now: the observer can see a new size before `width` has caught up with it.
      if (short > 0) setNeed({ reset, px: row.getBoundingClientRect().width + short })
    }
    // The row is as wide as the view, so it sees every resize of it; a change in any of the row's parts (a pill coming, a
    // tab) changes the title's width, or the controls'.
    const ro = new ResizeObserver(check)
    const watch = () => {
      ro.observe(row)
      // Observing one already observed does nothing.
      for (const el of row.children) ro.observe(el)
    }
    watch()
    // Parts come and go (the title's h1 is a new one after it's edited), and a new title's text can be longer than the
    // room the old one had without its box changing: watch the new parts, and measure again.
    const mo = new MutationObserver(() => {
      watch()
      check()
    })
    mo.observe(row, { childList: true, subtree: true, characterData: true })
    return () => {
      ro.disconnect()
      mo.disconnect()
    }
  }, [row, inRow, reset])
  return [setRow, inRow] as const
}

/** Expand into a dialog or back into the side panel, and close. The narrow layout has a back button instead. A task dialog
 *  over the page (mode "modal") only closes. */
export function PanelButtons({ mode }: { mode: Exclude<Mode, "page"> }) {
  const expanded = mode === "expanded"
  if (useNarrow()) return null
  return (
    <div className="no-drag flex shrink-0 items-center gap-0.5">
      {mode !== "modal" && (
        <IconButton title={expanded ? "Collapse into the side panel" : "Expand into a dialog"} onClick={() => setPanelExpanded(!expanded)}>
          {expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        </IconButton>
      )}
      <IconButton title="Close (Esc)" onClick={() => (mode === "modal" ? closeTaskModal() : closeTask())}>
        <X size={16} />
      </IconButton>
    </div>
  )
}
