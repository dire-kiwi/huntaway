import { Maximize2, Minimize2, X } from "lucide-react"
import { useLayoutEffect, useState } from "react"
import { closeTask, closeTaskModal, setPanelExpanded } from "../../../state/route"
import { useNarrow } from "../../../narrow"
import { IconButton } from "../../ui"

/**
 * "thread", "changes", "review", "summary", "terminal", "details" (when too narrow for them beside the thread),
 * `tool:<id>` for a terminal tool, or for a plan, artifact or diagram task its type, for its document.
 */
export type Tab = string

/** "page": the whole screen. "panel": beside the board. "expanded": a dialog over it. "modal": a dialog over any page, apart from the side panel (see useTaskModal). */
export type Mode = "page" | "panel" | "expanded" | "modal"

// Below this width the details move from a column beside the thread into their own tab, and the
// header's controls into a second row.
const WIDE = 880

/** Whether the element is at least WIDE (taken as wide until measured, but for the narrow layout), followed as it
 * resizes, and whether it has been measured. Use the returned ref on it. */
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
  return [setEl, width === null ? !narrow : width >= WIDE, width !== null] as const
}

/** Expand into a dialog or back into the side panel, and close. The narrow layout has a back button instead. A task dialog
 *  over the page (mode "modal") only closes. */
export function PanelButtons({ mode }: { mode: Exclude<Mode, "page"> }) {
  const expanded = mode === "expanded"
  if (useNarrow()) return null
  return (
    <div className="no-drag flex shrink-0 items-center gap-0.5">
      {mode !== "modal" && (
        <IconButton title={expanded ? "Collapse into the side panel" : "Expand"} onClick={() => setPanelExpanded(!expanded)}>
          {expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        </IconButton>
      )}
      <IconButton title="Close (Esc)" onClick={() => (mode === "modal" ? closeTaskModal() : closeTask())}>
        <X size={16} />
      </IconButton>
    </div>
  )
}
