import { clsx } from "clsx"
import { Bot, ChevronDown, Loader2 } from "lucide-react"
import { useMemo, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { useNarrow } from "../../narrow"
import { subagentTitle, useSubagentView } from "../task/thread/subagentView"
import { SubagentStatusBadge } from "../task/thread/subagents"
import { useThreadModel } from "../task/thread/threadView"
import { useDismiss } from "../ui"

/** Running/finished counts of the thread's subagents; opens a list that shows each one's own thread. */
export function AgentsPill({
  task,
  onReveal,
  align = "right",
  className,
}: {
  task: { readonly host_id: string; readonly id: string; readonly running: boolean }
  onReveal?: (() => void) | undefined
  /** Which of the pill's edges the list hangs from: its right at the right of a header, its left where it's on the left. */
  align?: "left" | "right" | undefined
  className?: string | undefined
}) {
  // The thread's own model (itemModel builds it once for both): a long thread's window knows the subagents started
  // before it, so the list has every one.
  const model = useThreadModel(task)
  const subagents = useMemo(() => [...model.subagents.values()], [model.subagents])
  const viewing = useSubagentView((s) => s.open[task.id])
  const show = useSubagentView((s) => s.show)
  const [open, setOpen] = useState(false)
  // In the narrow layout the list is a sheet along the window's bottom, drawn on the page's body: the header's row of
  // controls fades its end out with a mask, which would hide it.
  const narrow = useNarrow()
  const menu = useRef<HTMLDivElement>(null)
  const root = useDismiss<HTMLDivElement>(open, () => setOpen(false), menu)

  if (subagents.length === 0) return null
  const running = subagents.filter((s) => s.status === "running").length
  const settled = subagents.length - running
  // Newest first, running ones on top.
  const list = subagents.toReversed().toSorted((a, b) => Number(b.status === "running") - Number(a.status === "running"))

  const items = list.map((s) => (
    <button
      key={s.id}
      onClick={() => {
        setOpen(false)
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
        <span className="text-faint">
          {running > 0 && `${running} running`}
          {running > 0 && settled > 0 && " · "}
          {settled > 0 && `${settled} done`}
        </span>
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
            className={clsx(
              "absolute top-full z-30 mt-1.5 max-h-96 w-96 max-w-[calc(100vw-1.5rem)] overflow-y-auto rounded-lg border border-line-strong bg-panel-2 p-1 shadow-xl",
              align === "left" ? "left-0" : "right-0",
            )}
          >
            {items}
          </div>
        ))}
    </div>
  )
}
