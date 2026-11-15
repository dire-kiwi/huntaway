import { clsx } from "clsx"
import { CircleHelp } from "lucide-react"
import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react"
import { useDismiss } from "./hooks"

/** How far the help stays from the window's edges. */
const EDGE = 8

/**
 * A ? beside a label, for what would otherwise be a line of text under the field. Its help shows while the pointer is
 * on it (or it has the keyboard's focus), and a click keeps it open until a press outside it or Escape, which is how
 * it opens on a touch screen. `label` is what it explains.
 *
 * The help is placed in the window (`position: fixed`), under the ? or above it when there's no room under, and kept
 * within the window's sides, so a scrolling page doesn't cut it off. Don't put it inside a `<label>` or a button.
 */
export function Help({ label, children, className }: { label: string; children: ReactNode; className?: string | undefined }) {
  // "hover" while the pointer or the keyboard's focus is on it, "pinned" once it's clicked.
  const [shown, setShown] = useState<"hover" | "pinned" | null>(null)
  const open = shown !== null
  const root = useDismiss<HTMLSpanElement>(open, () => setShown(null))
  const button = useRef<HTMLButtonElement>(null)
  const popover = useRef<HTMLSpanElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const id = useId()
  useLayoutEffect(() => {
    if (!open) return undefined
    const place = () => {
      const b = button.current?.getBoundingClientRect()
      const p = popover.current?.getBoundingClientRect()
      if (!b || !p) return
      const under = b.bottom + p.height + EDGE <= window.innerHeight || b.top - p.height < EDGE
      setPos({
        left: Math.max(EDGE, Math.min(b.left - 10, window.innerWidth - p.width - EDGE)),
        top: under ? b.bottom : b.top - p.height,
      })
    }
    place()
    // Whatever scrolls (the page, a dialog) moves the ? it's under.
    window.addEventListener("scroll", place, true)
    window.addEventListener("resize", place)
    return () => {
      window.removeEventListener("scroll", place, true)
      window.removeEventListener("resize", place)
    }
  }, [open])
  return (
    <span
      ref={root}
      className={clsx("inline-flex", className)}
      // A touch is a click, which pins it: only a mouse hovers.
      onPointerEnter={(e) => e.pointerType === "mouse" && setShown((s) => s ?? "hover")}
      onPointerLeave={() => setShown((s) => (s === "hover" ? null : s))}
      onBlur={(e) => {
        // Tabbing on closes it; a press on its own text (to select it) doesn't.
        if (e.relatedTarget instanceof Node && !e.currentTarget.contains(e.relatedTarget)) setShown(null)
      }}
    >
      <button
        ref={button}
        type="button"
        aria-label={`Help: ${label}`}
        aria-expanded={open}
        aria-describedby={open ? id : undefined}
        onClick={() => setShown(shown === "pinned" ? null : "pinned")}
        onFocus={(e) => e.currentTarget.matches(":focus-visible") && setShown((s) => s ?? "hover")}
        className={clsx(
          "inline-flex h-4 w-4 items-center justify-center rounded-full outline-none transition-colors hover:text-fg focus-visible:ring-2 focus-visible:ring-accent/40",
          open ? "text-fg" : "text-faint",
        )}
      >
        <CircleHelp size={13} />
      </button>
      {open && (
        // The padding joins it to the ?, so the pointer can move onto the help (to select it, or follow a link).
        <span
          ref={popover}
          id={id}
          role="tooltip"
          className={clsx("fixed z-50 block w-80 max-w-[calc(100vw-16px)] py-1.5", !pos && "invisible")}
          style={pos ?? { left: 0, top: 0 }}
        >
          <span className="block space-y-1.5 rounded-lg border border-line-strong bg-panel-2 px-3 py-2 text-left text-[12px] font-normal leading-relaxed text-muted shadow-xl shadow-black/50 [&_code]:font-mono [&_code]:text-[11.5px] [&_code]:text-fg">
            {children}
          </span>
        </span>
      )}
    </span>
  )
}
