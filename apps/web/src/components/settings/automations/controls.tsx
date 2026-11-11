import { clsx } from "clsx"
import { type ReactNode } from "react"

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { id: T; label: ReactNode }[]; onChange: (v: T) => void }) {
  return (
    <div className="inline-flex rounded-md border border-line bg-panel p-0.5">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          onClick={() => onChange(o.id)}
          className={clsx("flex items-center gap-1.5 rounded px-2.5 py-1 text-[12.5px]", value === o.id ? "bg-raised text-fg" : "text-muted hover:text-fg")}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export const selectClass = "h-8 w-full rounded-md border border-line bg-panel px-2 text-[13px] outline-none"
