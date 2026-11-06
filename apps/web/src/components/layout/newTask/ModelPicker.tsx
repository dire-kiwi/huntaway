import { useState } from "react";
import { Input } from "../../ui";

export const pickerClass = "h-7 rounded-md border border-line bg-panel px-1.5 text-[12.5px] text-fg outline-none";

/** The task's own model: blank for whatever the project, profile or host picks. */
export function ModelPicker({
  value,
  onChange,
  inherited,
  options,
  placeholder = "model id, e.g. claude-opus-5-5",
}: {
  value: string;
  onChange: (v: string) => void;
  inherited?: string | null;
  /** Claude's aliases, or a Codex config's models. */
  options: { id: string; label: string }[];
  placeholder?: string;
}) {
  const [editing, setEditing] = useState(false);
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
            e.preventDefault();
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
    );
  }
  return (
    <select className={pickerClass} title="Model" value={value} onChange={(e) => (e.target.value === "__custom" ? setEditing(true) : onChange(e.target.value))}>
      <option value="">{inherited ? `Default model (${inherited})` : "Default model"}</option>
      {options.map((m) => (
        <option key={m.id} value={m.id}>
          {m.label}
        </option>
      ))}
      {value && !options.some((m) => m.id === value) && <option value={value}>{value}</option>}
      <option value="__custom">Specific model…</option>
    </select>
  );
}
