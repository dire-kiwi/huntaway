import { useState } from "react"
import { Input } from "../../ui"

export const pickerClass = "h-7 rounded-md border border-line bg-panel px-1.5 text-[12.5px] text-fg outline-none"

/** The task's own model: blank for whatever the project, profile or host picks. */
export function ModelPicker({
  value,
  onChange,
  inherited,
  options,
  placeholder = "model id, e.g. claude-opus-5-5",
  commitOnBlur = false,
  className = pickerClass,
}: {
  value: string
  onChange: (v: string) => void
  inherited?: string | null | undefined
  /** Claude's aliases, or a Codex config's models. */
  options: { id: string; label: string }[]
  placeholder?: string | undefined
  /**
   * For a model that's saved as it changes: the specific model is typed into a draft, and `onChange` is called once with
   * the whole id, on blur or Enter, rather than for every key.
   */
  commitOnBlur?: boolean | undefined
  className?: string | undefined
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState("")
  const startEditing = () => {
    setDraft(value)
    setEditing(true)
  }
  if (editing && commitOnBlur) {
    return (
      <Input
        autoFocus
        value={draft}
        placeholder={placeholder}
        className="h-7 w-52 font-mono text-[12px]"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          setEditing(false)
          const v = draft.trim()
          if (v !== value) onChange(v)
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.ctrlKey && !e.metaKey) {
            e.preventDefault()
            e.currentTarget.blur()
          }
        }}
      />
    )
  }
  if (editing) {
    return (
      <Input
        autoFocus
        value={value}
        placeholder={placeholder}
        className="h-7 w-52 font-mono text-[12px]"
        onChange={(e) => onChange(e.target.value.trim())}
        onBlur={() => setEditing(false)}
        onKeyDown={(e) => {
          // Enter confirms the model rather than submitting the dialog.
          if (e.key === "Enter" && !e.ctrlKey && !e.metaKey) {
            e.preventDefault()
            e.currentTarget.blur()
          }
        }}
      />
    )
  }
  return (
    <select className={className} title="Model" value={value} onChange={(e) => (e.target.value === "__custom" ? startEditing() : onChange(e.target.value))}>
      <option value="">{inherited ? `Default model (${inherited})` : "Default model"}</option>
      {options.map((m) => (
        <option key={m.id} value={m.id}>
          {m.label}
        </option>
      ))}
      {value && !options.some((m) => m.id === value) && <option value={value}>{value}</option>}
      <option value="__custom">Specific model…</option>
    </select>
  )
}
