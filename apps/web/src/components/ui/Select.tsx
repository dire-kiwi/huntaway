import { clsx } from "clsx"
import { Check, ChevronDown } from "lucide-react"
import {
  Children,
  isValidElement,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react"

/** How far the list stays from the window's edges, and from its button. */
const EDGE = 8
const GAP = 4
/** The tallest the list grows before it scrolls. */
const MAX_HEIGHT = 360
/** How long after a key press the next one still adds to the text being typed to find an option. */
const TYPEAHEAD_MS = 700

type Option = { value: string; label: ReactNode; text: string; disabled: boolean }

/** An option's text, for finding it by typing and for sizing the button. */
const textOf = (node: ReactNode): string =>
  typeof node === "string" || typeof node === "number" ? String(node) : Array.isArray(node) ? node.map((n: ReactNode) => textOf(n)).join("") : ""

/** The `<option>`s among the children (in arrays, as a `.map` makes them; `false` and `null` left out). */
function optionsOf(children: ReactNode): Option[] {
  return Children.toArray(children).flatMap((child) => {
    if (!isValidElement<ComponentProps<"option">>(child) || child.type !== "option") return []
    const { value, children: label, disabled } = child.props
    const text = textOf(label)
    return [{ value: value === undefined ? text : String(value), label, text: text.trim(), disabled: !!disabled }]
  })
}

/** The next option from `from` in direction `dir` that can be picked, or `from` when there's none. */
function step(options: Option[], from: number, dir: 1 | -1) {
  for (let i = from + dir; i >= 0 && i < options.length; i += dir) if (!options[i]?.disabled) return i
  return from
}

/**
 * A select drawn by the page rather than the browser, so its list looks like the rest of the app: a button that shows
 * the picked option and opens a list of them under it (or above it, when there's no room under). It's used as a
 * `<select>` is, with `<option value>` children, except that `onChange` gets the picked value (a string, as
 * `e.target.value` was) and only when it changes. As a native one, its width is its widest option's unless its class
 * gives one, a value no option has shows the first, and typing an option's first letters picks it.
 *
 * The keyboard's focus stays on the button while the list is open: the arrow keys, Home and End move through the
 * options, Enter or Space picks one, and Escape, Tab or a press anywhere else closes it. The button is a combobox to
 * assistive technology and to the page's shortcuts, which leave keys pressed on one alone.
 */
export function Select({
  value,
  onChange,
  children,
  className,
  title,
  disabled,
  "aria-label": ariaLabel,
}: {
  value: string | number
  onChange: (value: string) => void
  children: ReactNode
  className?: string | undefined
  title?: string | undefined
  disabled?: boolean | undefined
  "aria-label"?: string | undefined
}) {
  const options = optionsOf(children)
  const picked = options.findIndex((o) => o.value === String(value))
  const shown = options[picked] ?? options[0]
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const button = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLSpanElement>(null)
  const [pos, setPos] = useState<CSSProperties | null>(null)
  const typed = useRef({ text: "", at: -Infinity })
  const id = useId()
  const optionId = (i: number) => `${id}-${i}`

  const show = () => {
    setActive(picked >= 0 && !options[picked]?.disabled ? picked : step(options, -1, 1))
    setPos(null)
    setOpen(true)
    button.current?.focus()
  }
  const choose = (i: number) => {
    const o = options[i]
    if (o && !o.disabled && o.value !== String(value)) onChange(o.value)
  }

  // Placed in the window (`position: fixed`), so a dialog or a scrolling panel doesn't cut it off, and moved with the
  // button when anything scrolls.
  useLayoutEffect(() => {
    if (!open) return undefined
    const place = () => {
      const b = button.current?.getBoundingClientRect()
      const l = list.current
      if (!b || !l) return
      const want = Math.min(l.scrollHeight + 2, MAX_HEIGHT)
      const below = window.innerHeight - b.bottom - GAP - EDGE
      const above = b.top - GAP - EDGE
      const under = below >= want || below >= above
      const maxHeight = Math.min(MAX_HEIGHT, under ? below : above)
      const width = Math.max(l.offsetWidth, b.width)
      setPos({
        left: Math.max(EDGE, Math.min(b.left, window.innerWidth - width - EDGE)),
        top: under ? b.bottom + GAP : b.top - GAP - Math.min(want, maxHeight),
        minWidth: b.width,
        maxWidth: window.innerWidth - 2 * EDGE,
        maxHeight,
      })
    }
    place()
    const onScroll = (e: Event) => {
      if (!(e.target instanceof Node && list.current?.contains(e.target))) place()
    }
    window.addEventListener("scroll", onScroll, true)
    window.addEventListener("resize", place)
    return () => {
      window.removeEventListener("scroll", onScroll, true)
      window.removeEventListener("resize", place)
    }
  }, [open])

  // Escape closes the list and nothing else: not the dialog or the task panel it's in, nor a popover around it.
  useEffect(() => {
    if (!open) return undefined
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return
      e.preventDefault()
      e.stopPropagation()
      setOpen(false)
    }
    window.addEventListener("keydown", onKey, true)
    return () => window.removeEventListener("keydown", onKey, true)
  }, [open])

  // The highlighted option is kept in view as the list opens and as the highlight moves; not on other redraws (a board
  // update, a scroll that moves the list), which would undo the wheel's scrolling of the list.
  const placed = pos !== null
  useEffect(() => {
    if (open && placed) document.getElementById(`${id}-${active}`)?.scrollIntoView({ block: "nearest" })
  }, [open, placed, active, id])

  /**
   * The option a key typed at `at` (the event's time) picks, with the keys typed just before it: the next one starting
   * with a letter pressed again and again, else the first from `from` that starts with the text.
   */
  const find = (key: string, from: number, at: number) => {
    const t = typed.current
    t.text = at - t.at > TYPEAHEAD_MS ? key.toLowerCase() : t.text + key.toLowerCase()
    t.at = at
    const again = /^(.)\1*$/su.test(t.text)
    const order = options.map((_, i) => (from + (again ? 1 : 0) + i) % options.length)
    const matches = (i: number, text: string) => !options[i]?.disabled && options[i]?.text.toLowerCase().startsWith(text)
    return order.find((i) => matches(i, t.text)) ?? (again ? order.find((i) => matches(i, t.text.slice(0, 1))) : undefined)
  }
  /** Whether a key is typed text: a Space only after other keys, as it's otherwise what opens the list or picks. */
  const typing = (e: ReactKeyboardEvent) => e.key.length === 1 && (e.key !== " " || e.timeStamp - typed.current.at <= TYPEAHEAD_MS)

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.ctrlKey || e.metaKey) return
    if (!open) {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key) && !typing(e)) {
        e.preventDefault()
        show()
      } else if (typing(e) && !e.altKey) {
        e.preventDefault()
        const i = find(e.key, Math.max(picked, 0), e.timeStamp)
        if (i !== undefined) choose(i)
      }
      return
    }
    const to = {
      ArrowDown: step(options, active, 1),
      ArrowUp: step(options, active, -1),
      Home: step(options, -1, 1),
      End: step(options, options.length, -1),
    }[e.key]
    if (to !== undefined) {
      e.preventDefault()
      setActive(to)
    } else if (typing(e)) {
      e.preventDefault()
      const i = find(e.key, active, e.timeStamp)
      if (i !== undefined) setActive(i)
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault()
      choose(active)
      setOpen(false)
    } else if (e.key === "Tab") setOpen(false)
  }

  return (
    // The button is its parent's child as the select was, so the parent's layout (a `space-y` margin under each
    // child but the last) reaches it. The list goes before it, so the button stays the last child when it was; it's
    // `fixed`, so the margin it may get then moves nothing.
    <>
      {open && (
        <span
          ref={list}
          id={`${id}-list`}
          role="listbox"
          style={pos ?? { left: 0, top: 0 }}
          // Keeps the focus on the button, so it doesn't close; nor does a press on it reach what it's in.
          onMouseDown={(e) => {
            e.preventDefault()
            e.stopPropagation()
          }}
          onClick={(e) => {
            // Not a press on the `<label>` it may be in, which would press the button again.
            e.preventDefault()
            e.stopPropagation()
          }}
          className={clsx(
            "fixed z-50 block overflow-y-auto rounded-lg border border-line bg-panel p-1 text-fg shadow-2xl shadow-black/50",
            !pos && "invisible",
          )}
        >
          {options.map((o, i) => (
            <span
              key={o.value}
              id={optionId(i)}
              role="option"
              aria-selected={i === picked}
              data-value={o.value}
              aria-disabled={o.disabled || undefined}
              onMouseMove={() => !o.disabled && i !== active && setActive(i)}
              onClick={() => {
                if (o.disabled) return
                choose(i)
                setOpen(false)
              }}
              className={clsx(
                "flex cursor-default items-center gap-2 whitespace-nowrap rounded-md px-2 py-1.5 text-[13px] narrow:py-2.5",
                o.disabled ? "text-faint" : i === active && "bg-white/8",
              )}
            >
              <span className="w-3.5 shrink-0 text-accent">{i === picked && <Check size={14} />}</span>
              {o.label}
            </span>
          ))}
        </span>
      )}
      <button
        ref={button}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? `${id}-list` : undefined}
        aria-activedescendant={open && pos ? optionId(active) : undefined}
        aria-label={ariaLabel}
        title={title}
        disabled={disabled}
        data-value={shown?.value ?? ""}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={onKeyDown}
        // Space would press the button again as it's let go.
        onKeyUp={(e) => e.key === " " && e.preventDefault()}
        onBlur={() => setOpen(false)}
        className={clsx("inline-flex cursor-default items-center gap-1 text-left outline-none focus-visible:border-accent/60 disabled:opacity-60", className)}
      >
        {/* The picked option's text first, so the button's baseline is that text's, as a native select's is. Under it,
            every option's text in the same cell, unseen, so the button is as wide as the widest (unless its class
            sets a width); in `::before`, so it isn't text on the page. */}
        <span className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)]">
          <span className="col-start-1 row-start-1 truncate">{shown?.label}</span>
          {options.map((o) => (
            <span key={o.value} aria-hidden data-text={o.text} className="invisible col-start-1 row-start-1 h-0 truncate before:content-[attr(data-text)]" />
          ))}
        </span>
        <ChevronDown size={13} className="shrink-0 opacity-60" />
      </button>
    </>
  )
}
