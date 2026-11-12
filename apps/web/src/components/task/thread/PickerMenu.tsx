// A button with a menu above it, for a choice in the message box's bar: the permission mode's look (ModeSelect), for the
// model and effort.
import { clsx } from "clsx"
import { Check, ChevronDown } from "lucide-react"
import { Fragment, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react"
import { useDismiss } from "../../ui"

/** `divider` puts a line above the option; `hint` is a second, fainter line. */
export type PickerOption = { value: string; label: ReactNode; hint?: ReactNode | undefined; divider?: boolean | undefined }

export const pickerButtonClass =
  "flex h-6 min-w-0 max-w-44 items-center gap-1 rounded-md border border-line px-1.5 text-[11.5px] text-muted outline-none hover:border-line-strong hover:bg-white/5 focus-visible:border-accent/60"

/**
 * Opens on a click, or ArrowUp/ArrowDown on the button, with the chosen option focused; the arrow keys, Home and End move
 * between the options, and Escape or Tab close it, Escape back to the button.
 */
export function PickerMenu({
  title,
  icon,
  label,
  options,
  value,
  onPick,
  footer,
}: {
  /** The button's tooltip and the menu's name. */
  title: string
  icon?: ReactNode
  /** What the button shows. */
  label: ReactNode
  options: ReadonlyArray<PickerOption>
  value: string
  onPick: (value: string) => void
  footer?: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const close = (refocus: boolean) => {
    setOpen(false)
    if (refocus) button.current?.focus()
  }
  // Escape puts the focus back on the button; a press outside moves it on, after this, to where it lands.
  const root = useDismiss<HTMLDivElement>(open, () => close(!!menu.current?.contains(document.activeElement)))
  // How far left it moves to stay on a narrow screen: from the room right of the button, measured before it opens (a
  // menu past the edge of a phone's screen widens the page).
  const room = useRef(0)
  const [shift, setShift] = useState(0)
  const show = () => {
    room.current = window.innerWidth - (button.current?.getBoundingClientRect().left ?? 0)
    setOpen(true)
  }
  useLayoutEffect(() => {
    if (!open) return
    const el = menu.current
    if (el) setShift(Math.min(0, room.current - 8 - el.offsetWidth))
    ;(el?.querySelector<HTMLElement>("[aria-checked=true]") ?? el?.querySelector<HTMLElement>("[role=menuitemradio]"))?.focus()
  }, [open])
  const pick = (v: string) => {
    close(true)
    onPick(v)
  }
  const onMenuKey = (e: KeyboardEvent) => {
    if (e.key === "Tab") {
      close(false)
      return
    }
    const all = Array.from(menu.current?.querySelectorAll<HTMLElement>("[role=menuitemradio]") ?? [])
    const i = all.findIndex((el) => el === document.activeElement)
    const next = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: all.length - 1 }[e.key]
    if (next === undefined || !all.length) return
    e.preventDefault()
    all[(next + all.length) % all.length]?.focus()
  }
  return (
    <div ref={root} className="relative min-w-0">
      <button
        ref={button}
        type="button"
        title={title}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={(e) => {
          if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault()
            show()
          }
        }}
        className={clsx(pickerButtonClass, "w-full")}
      >
        {icon && <span className="shrink-0 text-faint">{icon}</span>}
        <span className="min-w-0 truncate">{label}</span>
        <ChevronDown size={11} className="shrink-0 text-faint" />
      </button>
      {open && (
        <div
          ref={menu}
          role="menu"
          aria-label={title}
          onKeyDown={onMenuKey}
          style={{ left: shift }}
          className="absolute bottom-full z-20 mb-1.5 max-h-80 w-64 overflow-y-auto rounded-lg border border-line-strong bg-panel-2 p-1 shadow-xl"
        >
          {options.map((o) => (
            <Fragment key={o.value}>
              {o.divider && <div role="separator" className="mx-1 my-1 h-px bg-line" />}
              <button
                type="button"
                role="menuitemradio"
                aria-checked={o.value === value}
                onClick={() => pick(o.value)}
                className={clsx(
                  "flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left outline-none hover:bg-white/5 focus:bg-white/5 narrow:py-2.5",
                  o.value === value && "bg-white/[0.04]",
                )}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12.5px] text-fg">{o.label}</span>
                  {o.hint && <span className="block truncate text-[11.5px] text-faint">{o.hint}</span>}
                </span>
                {o.value === value && <Check size={13} className="mt-0.5 shrink-0 text-accent" />}
              </button>
            </Fragment>
          ))}
          {footer && <div className="px-2 pt-1 pb-0.5 text-[11px] text-faint">{footer}</div>}
        </div>
      )}
    </div>
  )
}
