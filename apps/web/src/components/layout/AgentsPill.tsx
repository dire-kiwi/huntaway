import { clsx } from "clsx"
import { Bot, ChevronDown, Loader2 } from "lucide-react"
import { useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react"
import { createPortal } from "react-dom"
import { useNarrow } from "../../narrow"
import { subagentTitle, useSubagentView, type Subagent } from "../task/thread/subagentView"
import { SubagentStatusBadge } from "../task/thread/subagents"
import { useThreadModel } from "../task/thread/threadView"
import { useDismiss } from "../ui"

/** The thread's subagents, newest first with the running ones on top, and how many are running and done. */
export function useSubagentList(task: { readonly host_id: string; readonly id: string; readonly running: boolean }) {
  // The thread's own model (itemModel builds it once for both): a long thread's window knows the subagents started
  // before it, so the list has every one.
  const model = useThreadModel(task)
  return useMemo(() => {
    const list = [...model.subagents.values()].toReversed().toSorted((a, b) => Number(b.status === "running") - Number(a.status === "running"))
    const running = list.filter((s) => s.status === "running").length
    return { list, running, settled: list.length - running }
  }, [model.subagents])
}

/** How many of the thread's subagents are running and done. */
export const subagentCounts = (running: number, settled: number) =>
  [running > 0 && `${running} running`, settled > 0 && `${settled} done`].filter(Boolean).join(" · ")

/** The subagents as buttons that each show the subagent's own thread (after `onPick`, and `onReveal` to show the thread). */
export function SubagentItems({
  task,
  list,
  onPick,
  onReveal,
}: {
  task: { readonly id: string }
  list: readonly Subagent[]
  onPick?: (() => void) | undefined
  onReveal?: (() => void) | undefined
}) {
  const viewing = useSubagentView((s) => s.open[task.id])
  const show = useSubagentView((s) => s.show)
  return list.map((s) => (
    <button
      key={s.id}
      onClick={() => {
        onPick?.()
        onReveal?.()
        show(task.id, s.id)
      }}
      className={clsx("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-white/5", viewing === s.id && "bg-white/5")}
    >
      <Bot size={13} className="shrink-0 text-muted" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12.5px] text-fg">{subagentTitle(s)}</span>
        <span className="block truncate text-[11px] text-faint">
          {[s.agentType, s.model, s.status === "running" ? s.activity : null].filter(Boolean).join(" · ")}
        </span>
      </span>
      <SubagentStatusBadge s={s} compact />
    </button>
  ))
}

/**
 * Running/finished counts of the thread's subagents; opens a list that shows each one's own thread. Where the column
 * beside the thread is shown, the list is there instead (details/SubagentsSection.tsx, HE-112).
 */
export function AgentsPill({
  task,
  onReveal,
  className,
}: {
  task: { readonly host_id: string; readonly id: string; readonly running: boolean }
  onReveal?: (() => void) | undefined
  className?: string | undefined
}) {
  const { list, running, settled } = useSubagentList(task)
  const [open, setOpen] = useState(false)
  // In the narrow layout the list is a sheet along the window's bottom, drawn on the page's body: the header's row of
  // controls fades its end out with a mask, which would hide it.
  const narrow = useNarrow()
  const menu = useRef<HTMLDivElement>(null)
  const root = useDismiss<HTMLDivElement>(open, () => setOpen(false), menu)
  const place = usePlace(root, open && !narrow)

  if (list.length === 0) return null
  const items = <SubagentItems task={task} list={list} onPick={() => setOpen(false)} onReveal={onReveal} />

  return (
    <div ref={root} className={clsx("relative shrink-0", className)}>
      <button
        onClick={() => setOpen(!open)}
        title="Subagents in this thread"
        aria-expanded={open}
        className={clsx(
          "flex h-7 items-center gap-1.5 rounded-lg border px-2 text-[12px] hover:bg-white/5",
          running ? "border-st-progress/40 text-fg" : "border-line text-muted",
        )}
      >
        {running ? <Loader2 size={12} className="animate-spin text-st-progress" /> : <Bot size={13} />}
        Agents
        <span className="text-faint">{subagentCounts(running, settled)}</span>
        <ChevronDown size={11} className="text-faint" />
      </button>
      {open &&
        (narrow ? (
          createPortal(
            <div ref={menu} className="fixed inset-x-2 bottom-2 z-50 max-h-[60%] overflow-y-auto rounded-lg border border-line-strong bg-panel-2 p-1 shadow-xl">
              {items}
            </div>,
            document.body,
          )
        ) : (
          <div
            style={place ?? undefined}
            className={clsx(
              "absolute top-full z-30 mt-1.5 max-h-96 overflow-y-auto rounded-lg border border-line-strong bg-panel-2 p-1 shadow-xl",
              !place && "invisible",
            )}
          >
            {items}
          </div>
        ))}
    </div>
  )
}

/** How wide the list is, where there's room, and how far it stays from the edges of what would cut it off. */
const WIDTH = 384
const EDGE = 8

/**
 * Where the list goes beside the pill (`root`) while it's `open`: under it, lined up with its right edge, unless that
 * would put it past what cuts it off on the left (the task dialog, the window), which can be close when there are many
 * controls after the pill; then as far right as fits. Null until it's measured.
 */
function usePlace(root: RefObject<HTMLElement | null>, open: boolean): { left: number; width: number } | null {
  const [place, setPlace] = useState<{ left: number; width: number } | null>(null)
  useLayoutEffect(() => {
    if (!open) return undefined
    const measure = () => {
      const el = root.current
      if (!el) return
      let lo = EDGE
      let hi = window.innerWidth - EDGE
      for (let p = el.parentElement; p; p = p.parentElement) {
        if (getComputedStyle(p).overflowX === "visible") continue
        const r = p.getBoundingClientRect()
        lo = Math.max(lo, r.left + EDGE)
        hi = Math.min(hi, r.right - EDGE)
      }
      const b = el.getBoundingClientRect()
      const width = Math.min(WIDTH, hi - lo)
      setPlace({ left: Math.max(lo, Math.min(b.right, hi) - width) - b.left, width })
    }
    measure()
    window.addEventListener("resize", measure)
    return () => {
      window.removeEventListener("resize", measure)
      setPlace(null)
    }
  }, [root, open])
  return place
}
