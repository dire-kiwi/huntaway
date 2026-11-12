import { addDays, addMonths, startOfDay, startOfMonth, startOfWeek } from "./analytics"

export type Preset = "today" | "yesterday" | "this_week" | "last_week" | "this_month" | "last_month" | "last_7" | "last_30" | "custom"
export const PRESETS: { id: Preset; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "yesterday", label: "Yesterday" },
  { id: "this_week", label: "This week" },
  { id: "last_week", label: "Last week" },
  { id: "this_month", label: "This month" },
  { id: "last_month", label: "Last month" },
  { id: "last_7", label: "Last 7 days" },
  { id: "last_30", label: "Last 30 days" },
  { id: "custom", label: "Custom…" },
]
/** Whether `v` is one of the presets (as kept, or picked). */
export const isPreset = (v: unknown): v is Preset => PRESETS.some((p) => p.id === v)

export type Range = { from: number; to: number }

const parseDay = (s: string) => {
  const [y, m, d] = s.split("-").map(Number)
  return new Date(y ?? 1970, (m || 1) - 1, d || 1).getTime()
}

export function presetRange(p: Preset, custom: { from: string; to: string }): Range {
  const today = startOfDay(Date.now())
  const week = startOfWeek(today)
  const month = startOfMonth(today)
  switch (p) {
    case "today":
      return { from: today, to: addDays(today, 1) }
    case "yesterday":
      return { from: addDays(today, -1), to: today }
    case "this_week":
      return { from: week, to: addDays(week, 7) }
    case "last_week":
      return { from: addDays(week, -7), to: week }
    case "this_month":
      return { from: month, to: addMonths(month, 1) }
    case "last_month":
      return { from: addMonths(month, -1), to: month }
    case "last_7":
      return { from: addDays(today, -6), to: addDays(today, 1) }
    case "last_30":
      return { from: addDays(today, -29), to: addDays(today, 1) }
    case "custom":
      break
  }
  const a = parseDay(custom.from)
  const b = parseDay(custom.to)
  return { from: Math.min(a, b), to: addDays(Math.max(a, b), 1) }
}
