import { Plus, X } from "lucide-react"
import { useRef, useState } from "react"
import { Input } from "../../ui"

/** A daily trigger's `time` as its times (`11:00, 16:30`), and back. */
export const timesOf = (time: string): string[] => time.split(",").map((t) => t.trim())
export const timeOfTimes = (times: ReadonlyArray<string>): string => times.join(", ")

/**
 * The times of day a routine runs at, starting from `initial`: one input each, a × to take one out while there are
 * others, and a + to add one an hour after the last. `onChange` hears each change.
 */
export function TimesInput({ initial, onChange }: { initial: ReadonlyArray<string>; onChange: (times: string[]) => void }) {
  // Each time keeps its row (and its input's focus) as the others come and go.
  const next = useRef(initial.length)
  const [rows, setRows] = useState(() => initial.map((time, id) => ({ id, time })))
  const set = (now: ReadonlyArray<{ readonly id: number; readonly time: string }>) => {
    setRows([...now])
    onChange(now.map((r) => r.time))
  }
  const add = () => {
    const [h = 9, m = 0] = (rows.at(-1)?.time ?? "08:00").split(":").map(Number)
    set([...rows, { id: next.current++, time: `${String(Math.min(23, h + 1)).padStart(2, "0")}:${String(m).padStart(2, "0")}` }])
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {rows.map((r, i) => (
        <span key={r.id} className="inline-flex items-center gap-0.5">
          <Input
            type="time"
            className="w-28"
            aria-label={rows.length > 1 ? `Time ${i + 1}` : "Time"}
            value={r.time}
            onChange={(e) => set(rows.map((x) => (x.id === r.id ? { id: x.id, time: e.target.value } : x)))}
          />
          {rows.length > 1 && (
            <button
              type="button"
              aria-label={`Remove ${r.time}`}
              title="Remove this time"
              onClick={() => set(rows.filter((x) => x.id !== r.id))}
              className="rounded p-0.5 text-faint hover:text-fg"
            >
              <X size={12} />
            </button>
          )}
        </span>
      ))}
      <button type="button" aria-label="Add a time" title="Add a time" onClick={add} className="rounded p-1 text-faint hover:text-fg">
        <Plus size={13} />
      </button>
    </span>
  )
}
