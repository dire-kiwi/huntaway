import { clsx } from "clsx"
import { Check, ChevronRight } from "lucide-react"
import { createContext, Fragment, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react"
import { useNarrow } from "../../narrow"
import { after } from "../../state/timers"

/**
 * `divider` puts a line above the item, to set it apart from the ones before; `danger` shows it in red. An item with
 * `items` opens a menu of them beside it (on hover, a click or ArrowRight; on a phone, under it in place) and does
 * nothing itself.
 */
export type MenuItem = {
  label: ReactNode
  checked?: boolean | undefined
  divider?: boolean | undefined
  danger?: boolean | undefined
  items?: MenuItem[] | undefined
  onSelect?: (() => void) | undefined
}

/**
 * Places the menu again for its size now, as a submenu opened in place under its item (on a phone) makes it taller: it
 * moves up to stay on screen, then scrolls. Returns the menu, placed, or nothing.
 */
const Refit = createContext<() => HTMLElement | null>(() => null)

/** A menu's own items, not those of a menu opened from one of them. */
const ownItems = (menu: Element): HTMLElement[] =>
  Array.from(menu.querySelectorAll<HTMLElement>("[role^=menuitem]")).filter((el) => el.closest("[role=menu]") === menu)

/**
 * A menu at the cursor (for a right-click), kept on screen. Pressing outside it, Escape, scrolling,
 * resizing or leaving the window closes it; the arrow keys move between its items, and into and out of its submenus.
 */
export function ContextMenu({ x, y, title, items, onClose }: { x: number; y: number; title?: ReactNode | undefined; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: x, top: y })
  // What it was opened on: the topmost element at (x, y) other than the menu, which is placed there first.
  const anchor = useRef<Element | undefined>(undefined)
  // At (x, y) where it fits, else as near as it does. Set on the element too, so what measures it next sees it there.
  const place = useCallback((): HTMLElement | null => {
    const el = ref.current
    if (!el) return null
    const r = el.getBoundingClientRect()
    const at = { left: Math.max(4, Math.min(x, window.innerWidth - r.width - 4)), top: Math.max(4, Math.min(y, window.innerHeight - r.height - 4)) }
    el.style.left = `${at.left}px`
    el.style.top = `${at.top}px`
    setPos((p) => (p.left === at.left && p.top === at.top ? p : at))
    return el
  }, [x, y])
  useLayoutEffect(() => {
    const el = place()
    if (!el) return undefined
    anchor.current = document.elementsFromPoint(x, y).find((e) => !el.contains(e))
    ;(el.querySelector<HTMLElement>("[aria-checked=true]") ?? el.querySelector<HTMLElement>("[role^=menuitem]"))?.focus()
    // And again as its size changes (a submenu in place closing, say).
    const watch = new ResizeObserver(() => place())
    watch.observe(el)
    return () => watch.disconnect()
  }, [x, y, place])
  useEffect(() => {
    // Closed after the event, so whatever else handles it (the side panel closing on a click
    // outside it) still sees the menu, marked data-modal, and leaves it alone.
    const close = () => after(0, onClose)
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
      // Within the menu (or submenu) the focus is in.
      const root = ref.current
      const focused = document.activeElement
      const menu = (root && focused && root.contains(focused) && focused.closest("[role=menu]")) || root
      const all = menu ? ownItems(menu) : []
      const i = all.findIndex((el) => el === focused)
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
      <Refit.Provider value={place}>
        <Items items={items} onClose={onClose} />
      </Refit.Provider>
    </div>
  )
}

const itemClass = "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] outline-none hover:bg-white/5 focus:bg-white/5 narrow:py-2.5"

/** A menu's items; `back` is the item it was opened from, for a submenu, which ArrowLeft goes back to. */
function Items({ items, onClose, back }: { items: MenuItem[]; onClose: () => void; back?: (() => void) | undefined }) {
  const narrow = useNarrow()
  // The item whose submenu is open, by its place.
  const [open, setOpen] = useState<number | null>(null)
  // Moving the pointer onto another item opens (or closes) its submenu a moment later, so crossing an item on the way
  // into an open submenu doesn't close it.
  const pending = useRef<(() => void) | null>(null)
  const hover = (place: number | null) => {
    pending.current?.()
    pending.current = place === open ? null : after(120, () => setOpen(place))
  }
  useEffect(() => () => pending.current?.(), [])
  // The items are the menu as it was opened, and have no ids: their places are their keys.
  return items
    .map((item, place) => ({ item, place, key: `item-${place}` }))
    .map(({ item, place, key }) => {
      const sub = item.items
      const divider = item.divider && place > 0 && <div role="separator" className="mx-1 my-1 h-px bg-line" />
      const mark = <span className="w-3.5 shrink-0 text-accent">{item.checked && <Check size={14} />}</span>
      if (!sub)
        return (
          <Fragment key={key}>
            {divider}
            <button
              role="menuitemradio"
              aria-checked={!!item.checked}
              onMouseEnter={() => !narrow && hover(null)}
              onKeyDown={(e) => {
                if (e.key !== "ArrowLeft" || !back) return
                e.preventDefault()
                e.stopPropagation()
                back()
              }}
              onClick={() => {
                onClose()
                item.onSelect?.()
              }}
              className={clsx(itemClass, item.danger ? "text-red-400" : "text-fg")}
            >
              {mark}
              {item.label}
            </button>
          </Fragment>
        )
      const isOpen = open === place
      return (
        <Fragment key={key}>
          {divider}
          <SubMenu
            item={item}
            sub={sub}
            open={isOpen}
            inline={narrow}
            mark={mark}
            onHover={() => !narrow && hover(place)}
            onStay={() => {
              pending.current?.()
              pending.current = null
            }}
            onOpen={(v) => {
              pending.current?.()
              pending.current = null
              setOpen(v ? place : null)
            }}
            onBack={back}
            onClose={onClose}
          />
        </Fragment>
      )
    })
}

/** An item that opens a menu of `sub`: floating beside it, or (`inline`, on a phone) under it in this menu. */
function SubMenu({
  item,
  sub,
  open,
  inline,
  mark,
  onHover,
  onStay,
  onOpen,
  onBack,
  onClose,
}: {
  item: MenuItem
  sub: MenuItem[]
  open: boolean
  inline: boolean
  mark: ReactNode
  onHover: () => void
  onStay: () => void
  onOpen: (open: boolean) => void
  onBack: (() => void) | undefined
  onClose: () => void
}) {
  const button = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  // Whether its first item takes the focus when it opens: from the keyboard, not the pointer.
  const focusFirst = useRef(false)
  return (
    <>
      <button
        ref={button}
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={open}
        onMouseEnter={onHover}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft" && onBack) {
            e.preventDefault()
            e.stopPropagation()
            onBack()
          } else if (e.key === "ArrowRight" && !inline) {
            e.preventDefault()
            focusFirst.current = true
            onOpen(true)
          }
        }}
        onClick={(e) => {
          // A click from the keyboard (Enter or Space) has no pointer behind it.
          focusFirst.current = e.detail === 0
          onOpen(inline ? !open : true)
        }}
        className={clsx(itemClass, "text-fg", open && "bg-white/5")}
      >
        {mark}
        <span className="min-w-0 flex-1">{item.label}</span>
        <ChevronRight size={13} className={clsx("shrink-0 text-faint transition-transform", inline && open && "rotate-90")} />
      </button>
      {open &&
        (inline ? (
          <InPlace trigger={button}>
            <Items items={sub} onClose={onClose} />
          </InPlace>
        ) : (
          <Floating anchor={button} panel={panel} focusFirst={focusFirst} onStay={onStay}>
            <Items
              items={sub}
              onClose={onClose}
              back={() => {
                onOpen(false)
                button.current?.focus()
              }}
            />
          </Floating>
        ))}
    </>
  )
}

/** A submenu opened under its item, `trigger`: the menu is placed again for it, and scrolls to show it (and its item). */
function InPlace({ trigger, children }: { trigger: RefObject<HTMLElement | null>; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const refit = useContext(Refit)
  useLayoutEffect(() => {
    const menu = refit()
    const group = ref.current?.getBoundingClientRect()
    const item = trigger.current?.getBoundingClientRect()
    if (!menu || !group || !item) return
    const box = menu.getBoundingClientRect()
    const below = group.bottom - (box.bottom - 4)
    if (below > 0) menu.scrollTop += Math.min(below, item.top - (box.top + 4))
  }, [refit, trigger])
  return (
    <div ref={ref} role="group" className="ml-3 border-l border-line pl-1">
      {children}
    </div>
  )
}

/** A submenu's own panel, beside `anchor` (on its right, or its left where that doesn't fit) and on screen. */
function Floating({
  anchor,
  panel,
  focusFirst,
  onStay,
  children,
}: {
  anchor: RefObject<HTMLElement | null>
  panel: RefObject<HTMLDivElement | null>
  focusFirst: RefObject<boolean>
  onStay: () => void
  children: ReactNode
}) {
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  useLayoutEffect(() => {
    const el = panel.current
    const a = anchor.current?.getBoundingClientRect()
    if (!el || !a) return
    const r = el.getBoundingClientRect()
    const right = a.right + 6
    const left = right + r.width + 4 <= window.innerWidth ? right : a.left - r.width - 6
    setPos({ left: Math.max(4, Math.min(left, window.innerWidth - r.width - 4)), top: Math.max(4, Math.min(a.top - 5, window.innerHeight - r.height - 4)) })
  }, [anchor, panel])
  // Once it's placed: hidden, it can't take the focus.
  const placed = pos !== null
  useLayoutEffect(() => {
    const el = panel.current
    if (placed && el && focusFirst.current) (el.querySelector<HTMLElement>("[aria-checked=true]") ?? el.querySelector<HTMLElement>("[role^=menuitem]"))?.focus()
  }, [placed, panel, focusFirst])
  return (
    <div
      ref={panel}
      role="menu"
      // Measured where it is first drawn, out of sight, then placed.
      style={pos ?? { left: 0, top: 0, visibility: "hidden" }}
      onMouseEnter={onStay}
      className="fixed z-50 min-w-44 rounded-lg border border-line bg-panel p-1 shadow-2xl shadow-black/50 max-h-[calc(100%-8px)] overflow-y-auto"
    >
      {children}
    </div>
  )
}
