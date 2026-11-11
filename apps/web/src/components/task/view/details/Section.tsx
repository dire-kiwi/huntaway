import { clsx } from "clsx"
import { ChevronRight } from "lucide-react"
import { useState, type ReactNode } from "react"
import { Input, parseJson, toJson, useDraft } from "../../../ui"

const COLLAPSED_KEY = "ia.details.collapsed"

/** Which collapsible sections are open or closed in this browser, by `collapsible` key: true for collapsed. */
function loadCollapsed(): Record<string, boolean> {
  try {
    const kept = parseJson(localStorage.getItem(COLLAPSED_KEY))
    if (typeof kept !== "object" || kept === null) return {}
    return Object.fromEntries(Object.entries(kept).filter((e): e is [string, boolean] => typeof e[1] === "boolean"))
  } catch {
    return {}
  }
}

/**
 * A part of a task's details. With `collapsible` (a key, kept in this browser), its title shows or hides it, and it starts
 * closed unless `open` says otherwise.
 */
export function Section({
  title,
  children,
  right,
  collapsible,
  open: openByDefault = false,
}: {
  title: string
  children: ReactNode
  right?: ReactNode | undefined
  collapsible?: string | undefined
  open?: boolean | undefined
}) {
  const [open, setOpenState] = useState(() => (collapsible ? !(loadCollapsed()[collapsible] ?? !openByDefault) : true))
  const setOpen = (on: boolean) => {
    setOpenState(on)
    if (!collapsible) return
    try {
      localStorage.setItem(COLLAPSED_KEY, toJson({ ...loadCollapsed(), [collapsible]: !on }))
    } catch {
      /* ignore */
    }
  }
  return (
    <section className="border-b border-line px-4 py-4">
      <div className={clsx("flex items-center justify-between", open && "mb-2.5")}>
        {collapsible ? (
          <button
            onClick={() => setOpen(!open)}
            aria-expanded={open}
            className="-ml-1 flex items-center gap-1 text-[11px] font-semibold tracking-wide text-faint uppercase hover:text-muted"
          >
            <ChevronRight size={12} className={clsx("transition-transform", open && "rotate-90")} />
            {title}
          </button>
        ) : (
          <h3 className="text-[11px] font-semibold tracking-wide text-faint uppercase">{title}</h3>
        )}
        {right}
      </div>
      {open && children}
    </section>
  )
}

export function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-3 py-1 text-[12.5px]">
      <span className="w-20 shrink-0 text-faint">{label}</span>
      <span className="min-w-0 flex-1 break-words text-muted">{children}</span>
    </div>
  )
}

/**
 * A field saved when it loses focus. It follows the task's value only while it's neither focused nor changed, so a
 * value the agent sets meanwhile doesn't overwrite what's being typed (and isn't written back over with the old one).
 */
export function TextInput({ value, placeholder, onSave }: { value: string | null; placeholder: string; onSave: (v: string) => void }) {
  const [focused, setFocused] = useState(false)
  const { draft: v, setDraft: setV, dirty } = useDraft(value ?? "", focused)
  return (
    <Input
      value={v}
      placeholder={placeholder}
      onChange={(e) => setV(e.target.value)}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false)
        if (!dirty) return
        setV(v.trim())
        onSave(v.trim())
      }}
      onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
      className="h-7 text-[12px]"
    />
  )
}
