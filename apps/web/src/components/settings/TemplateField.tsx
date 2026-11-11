import { clsx } from "clsx"
import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react"
import { templateMatches, templatePick, templateTyped, templateValues, type TemplateGraph } from "../../templateCompletion"
import { Input, Textarea } from "../ui"

/** A workflow template's text box, which lists the `{{…}}` values it can use as one is typed, to pick with the arrows and Enter or Tab. */
export function TemplateField({
  graph,
  self,
  value,
  onChange,
  rows,
  className,
  placeholder,
}: {
  graph: TemplateGraph
  /** The step it's a template of, whose own output it can't use. */
  self: string
  value: string
  onChange: (value: string) => void
  /** A text area this many lines high; a line without. */
  rows?: number | undefined
  className?: string | undefined
  placeholder?: string | undefined
}) {
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null)
  const [caret, setCaret] = useState<number | null>(null)
  const [lit, setLit] = useState(0)
  // The `{{` whose list Escape closed, so it stays closed until another is typed.
  const [closedAt, setClosedAt] = useState<number | null>(null)
  // Where the caret goes once a picked value is in the field, before anything else is typed.
  const place = useRef<number | null>(null)
  useLayoutEffect(() => {
    if (place.current == null) return
    ref.current?.setSelectionRange(place.current, place.current)
    place.current = null
  })

  const typed = caret == null ? null : templateTyped(value, caret)
  const matches = typed ? templateMatches(templateValues(graph, self), typed.query) : []
  const open = typed != null && typed.start !== closedAt && matches.length > 0
  const hl = Math.min(lit, matches.length - 1)

  const pick = (name: string) => {
    if (!typed || caret == null) return
    const next = templatePick(value, caret, typed.start, name)
    onChange(next.text)
    setCaret(next.caret)
    place.current = next.caret
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if (!open || e.nativeEvent.isComposing) return
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault()
      setLit((hl + (e.key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length)
    } else if ((e.key === "Enter" && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) || (e.key === "Tab" && !e.shiftKey)) {
      e.preventDefault()
      const m = matches[hl]
      if (m) pick(m.name)
    } else if (e.key === "Escape") {
      // Closes the list, not the dialog.
      e.preventDefault()
      e.stopPropagation()
      setClosedAt(typed.start)
    }
  }

  const props = {
    ref,
    value,
    placeholder,
    spellCheck: false,
    role: "combobox",
    "aria-expanded": open,
    "aria-autocomplete": "list" as const,
    onChange: (e: { target: HTMLInputElement | HTMLTextAreaElement }) => {
      onChange(e.target.value)
      setCaret(e.target.selectionStart)
      setLit(0)
      setClosedAt(null)
    },
    onSelect: (e: { currentTarget: HTMLInputElement | HTMLTextAreaElement }) => setCaret(e.currentTarget.selectionStart),
    onBlur: () => setCaret(null),
    onKeyDown,
  }

  return (
    <div className="relative">
      {rows ? <Textarea rows={rows} className={className} {...props} /> : <Input className={className} {...props} />}
      {open && (
        <div
          role="listbox"
          aria-label="Template values"
          className="absolute top-full right-0 left-0 z-20 mt-1 max-h-56 overflow-y-auto rounded-lg border border-line-strong bg-panel-2 p-1 shadow-xl shadow-black/50"
          // Keeps the field focused, so picking doesn't close the list first.
          onMouseDown={(e) => e.preventDefault()}
        >
          {matches.map((m, i) => (
            <button
              key={m.name}
              type="button"
              role="option"
              aria-selected={i === hl}
              onMouseEnter={() => setLit(i)}
              onClick={() => pick(m.name)}
              className={clsx("flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[12px]", i === hl ? "bg-raised text-fg" : "text-muted")}
            >
              <code className="shrink-0 font-mono text-[11.5px] text-accent">{`{{${m.name}}}`}</code>
              <span className="truncate">{m.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
