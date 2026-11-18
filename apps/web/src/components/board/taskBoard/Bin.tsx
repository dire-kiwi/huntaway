import { clsx } from "clsx"
import { useEffect, useId, useLayoutEffect, useRef, useState, type DragEvent, type ReactNode } from "react"

/** How far a bin's popover stays from the window's edges. */
const EDGE = 8

/**
 * A label in the kanban board's header for tasks kept out of the columns (HE-52): Ready for merge's queue, the tasks
 * waiting on a reminder. Tasks are dropped on the label (`onDragOver` and `onDrop`, which take them or not). What's in
 * it (`children`, the popover's box) shows while the pointer is on the label or something is dragged over it, and a
 * click keeps it open until a click outside it or Escape (not a press: a card pressed to drag it in mustn't close it).
 */
export function Bin({
  icon,
  name,
  count,
  title,
  labelled,
  hot,
  tone,
  label: labelProps,
  onLeave,
  children,
}: {
  icon: ReactNode
  name: string
  count: number
  title: string
  /** Whether the label has its name, or only its icon and count. */
  labelled: boolean
  /** Whether what's dragged over it would go in it. */
  hot: boolean
  /** The label's classes while it's `hot`, and while its popover is open. */
  tone: { hot: string; open: string }
  label: {
    onDragOver: (e: DragEvent<HTMLButtonElement>) => void
    onDrop: (e: DragEvent<HTMLButtonElement>) => void
    "data-status"?: string | undefined
    "data-bin"?: string | undefined
  }
  /** A drag left the label and its popover. */
  onLeave?: (() => void) | undefined
  children: ReactNode
}) {
  // "hover" while the pointer is on it, "pinned" once it's clicked.
  const [shown, setShown] = useState<"hover" | "pinned" | null>(null)
  // Something is dragged over the label or the popover; a card was picked up from the popover and is still being dragged.
  const [over, setOver] = useState(false)
  const [carrying, setCarrying] = useState(false)
  // A card dragged out of it hides it (out of the way of the columns) until the drag comes back or ends.
  const open = carrying ? over : shown !== null || over
  const root = useRef<HTMLDivElement>(null)
  const label = useRef<HTMLButtonElement>(null)
  const popover = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number; maxHeight: number } | null>(null)
  const id = useId()

  // Placed in the window under the label, kept within its sides, as the board's header doesn't scroll.
  useLayoutEffect(() => {
    if (!open) return undefined
    const place = () => {
      const b = label.current?.getBoundingClientRect()
      const p = popover.current?.getBoundingClientRect()
      if (!b || !p) return
      setPos({
        left: Math.max(EDGE, Math.min(b.right - p.width, window.innerWidth - p.width - EDGE)),
        top: b.bottom,
        maxHeight: window.innerHeight - b.bottom - EDGE,
      })
    }
    place()
    window.addEventListener("resize", place)
    return () => window.removeEventListener("resize", place)
  }, [open])

  // Pinned, a click outside it or Escape closes it.
  useEffect(() => {
    if (shown !== "pinned") return undefined
    const onClick = (e: MouseEvent) => {
      if (!(e.target instanceof Node && root.current?.contains(e.target))) setShown(null)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return
      e.preventDefault() // so it doesn't close the task panel as well
      setShown(null)
    }
    document.addEventListener("click", onClick, true)
    document.addEventListener("keydown", onKey, true)
    return () => {
      document.removeEventListener("click", onClick, true)
      document.removeEventListener("keydown", onKey, true)
    }
  }, [shown])

  // A drag ends with a drop anywhere, or none: the popover it opened closes. A card dropped in a column may be gone
  // from the popover by the time its drag ends, so the end isn't heard from the card.
  useEffect(() => {
    if (!over && !carrying) return undefined
    const end = () => {
      setOver(false)
      setCarrying(false)
      // The pointer that was on the label when a card was picked up from its popover is elsewhere now.
      if (carrying) setShown((s) => (s === "hover" ? null : s))
    }
    window.addEventListener("drop", end, true)
    window.addEventListener("dragend", end, true)
    return () => {
      window.removeEventListener("drop", end, true)
      window.removeEventListener("dragend", end, true)
    }
  }, [over, carrying])

  return (
    <div
      ref={root}
      className="relative flex"
      // A touch is a click, which pins it: only a mouse hovers.
      onPointerEnter={(e) => e.pointerType === "mouse" && setShown((s) => s ?? "hover")}
      onPointerLeave={() => setShown((s) => (s === "hover" ? null : s))}
      onDragEnter={() => setOver(true)}
      onDragLeave={(e) => {
        if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return
        setOver(false)
        onLeave?.()
      }}
      // A card picked up from the popover keeps it drawn (hidden once the drag leaves it) until the drag ends: a drag
      // whose card is taken out of the page goes nowhere.
      onDragStart={() => setCarrying(true)}
    >
      <button
        ref={label}
        type="button"
        title={open ? undefined : title}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={title}
        {...labelProps}
        onClick={() => setShown(shown === "pinned" ? null : "pinned")}
        onDrop={(e) => {
          setOver(false)
          labelProps.onDrop(e)
        }}
        className={clsx(
          "inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-xs font-medium transition-colors",
          hot ? tone.hot : open ? tone.open : "border-line text-muted hover:text-fg",
        )}
      >
        {icon}
        {labelled && <span>{name}</span>}
        <span className={clsx("tabular-nums", count ? "text-fg" : "text-faint")}>{count}</span>
      </button>
      {(open || carrying) && (
        // The padding joins it to the label, so the pointer (or a drag) can move onto the popover.
        <div
          ref={popover}
          id={id}
          className={clsx("fixed z-40 flex w-[290px] flex-col pt-1.5", (!open || !pos) && "pointer-events-none invisible")}
          style={pos ?? { left: 0, top: 0 }}
        >
          {children}
        </div>
      )}
    </div>
  )
}

/** A bin's popover's header: its icon, name and count, and a note on the right. */
export function BinHeader({ icon, name, count, note }: { icon: ReactNode; name: string; count: number; note: string }) {
  return (
    <div className="flex items-center gap-2 px-3 pt-3 pb-[7px]">
      {icon}
      <span className="text-[12.5px] font-medium">{name}</span>
      <span className="text-[12px] text-faint">{count}</span>
      <span className="ml-auto text-[11.5px] text-faint">{note}</span>
    </div>
  )
}

/** A bin's popover's box. */
export const BIN_BOX = "flex min-h-0 flex-col rounded-xl border bg-panel-2 shadow-xl shadow-black/50 transition-colors"
