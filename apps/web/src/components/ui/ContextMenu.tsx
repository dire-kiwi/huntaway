import { Check } from "lucide-react"
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react"

/** `divider` puts a line above the item, to set it apart from the ones before. */
export type MenuItem = { label: ReactNode; checked?: boolean | undefined; divider?: boolean | undefined; onSelect: () => void }

/**
 * A menu at the cursor (for a right-click), kept on screen. Pressing outside it, Escape, scrolling,
 * resizing or leaving the window closes it; the arrow keys move between its items.
 */
export function ContextMenu({ x, y, title, items, onClose }: { x: number; y: number; title?: ReactNode | undefined; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: x, top: y })
  // What it was opened on: the topmost element at (x, y) other than the menu, which is placed there first.
  const anchor = useRef<Element | undefined>(undefined)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    anchor.current = document.elementsFromPoint(x, y).find((e) => !el.contains(e))
    const r = el.getBoundingClientRect()
    setPos({ left: Math.max(4, Math.min(x, window.innerWidth - r.width - 4)), top: Math.max(4, Math.min(y, window.innerHeight - r.height - 4)) })
    ;(el.querySelector<HTMLElement>("[aria-checked=true]") ?? el.querySelector<HTMLElement>("[role^=menuitem]"))?.focus()
  }, [x, y])
  useEffect(() => {
    // Closed after the event, so whatever else handles it (the side panel closing on a click
    // outside it) still sees the menu, marked data-modal, and leaves it alone.
    const close = () => setTimeout(onClose)
    const onDown = (e: MouseEvent) => {
      if (!(e.target instanceof Node && ref.current?.contains(e.target))) close()
    }
    // Not its own scrolling: a long menu scrolls on a short screen. Nor a thread following its agent's output
    // (data-autoscroll), which scrolls on every token while a menu is open elsewhere; a menu on something in the
    // thread closes, as that moves away from under it.
    const onScroll = (e: Event) => {
      const target = e.target
      if (!(target instanceof Node) || ref.current?.contains(target)) return
      if (target instanceof Element && target.hasAttribute("data-autoscroll") && !(anchor.current && target.contains(anchor.current))) return
      close()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "Tab") {
        e.preventDefault()
        close()
        return
      }
      const all = Array.from(ref.current?.querySelectorAll<HTMLElement>("[role^=menuitem]") ?? [])
      const i = all.findIndex((el) => el === document.activeElement)
      const next = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: all.length - 1 }[e.key]
      if (next === undefined || !all.length) return
      e.preventDefault()
      all[(next + all.length) % all.length]?.focus()
    }
    window.addEventListener("mousedown", onDown, true)
    window.addEventListener("keydown", onKey, true)
    window.addEventListener("scroll", onScroll, true)
    window.addEventListener("resize", close)
    window.addEventListener("blur", close)
    return () => {
      window.removeEventListener("mousedown", onDown, true)
      window.removeEventListener("keydown", onKey, true)
      window.removeEventListener("scroll", onScroll, true)
      window.removeEventListener("resize", close)
      window.removeEventListener("blur", close)
    }
  }, [onClose])
  return (
    <div
      ref={ref}
      data-modal
      role="menu"
      style={pos}
      className="fixed z-50 min-w-44 rounded-lg border border-line bg-panel p-1 shadow-2xl shadow-black/50 max-h-[calc(100%-8px)] overflow-y-auto"
      onContextMenu={(e) => e.preventDefault()}
    >
      {title && <div className="px-2 pt-1 pb-1.5 text-[11.5px] text-faint">{title}</div>}
      {/* The items are the menu as it was opened, and have no ids: their places are their keys. */}
      {items
        .map((item, place) => ({ item, place, key: `item-${place}` }))
        .map(({ item, place, key }) => (
          <Fragment key={key}>
            {item.divider && place > 0 && <div role="separator" className="mx-1 my-1 h-px bg-line" />}
            <button
              role="menuitemradio"
              aria-checked={!!item.checked}
              onClick={() => {
                onClose()
                item.onSelect()
              }}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-fg outline-none hover:bg-white/5 focus:bg-white/5 narrow:py-2.5"
            >
              <span className="w-3.5 shrink-0 text-accent">{item.checked && <Check size={14} />}</span>
              {item.label}
            </button>
          </Fragment>
        ))}
    </div>
  )
}
