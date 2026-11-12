import { describe, expect, it } from "@effect/vitest"
import { isoOf, localMillis, localParts, millisOf } from "../../../src/components/ui/dates"
import { fromLocalInput, reminderLabel, reminderPresets, toLocalInput } from "../../../src/components/ui/reminders"

// Saturday 31 January 2026, 15:20 here.
const NOW = localMillis({ year: 2026, month: 1, day: 31, hour: 15, minute: 20, second: 0, millisecond: 0 })

describe("reminders", () => {
  it("offers an hour, three hours, tomorrow at 9:00 and next Monday at 9:00, across a month's end", () => {
    const [hour, three, tomorrow, monday] = reminderPresets(NOW).map((p) => p.at)
    expect(hour).toBe(NOW + 3_600_000)
    expect(three).toBe(NOW + 3 * 3_600_000)
    expect(localParts(tomorrow ?? 0)).toMatchObject({ year: 2026, month: 2, day: 1, hour: 9, minute: 0 })
    expect(localParts(monday ?? 0)).toMatchObject({ month: 2, day: 2, hour: 9, weekDay: 1 })
  })

  it("puts a time in a datetime-local input and reads it back", () => {
    expect(toLocalInput(NOW)).toBe("2026-01-31T15:20")
    expect(millisOf(fromLocalInput("2026-01-31T15:20") ?? "")).toBe(NOW)
    expect(millisOf(fromLocalInput("2026-01-31T15:20:30") ?? "")).toBe(NOW + 30_000)
    expect(fromLocalInput("")).toBeNull()
    expect(fromLocalInput("soon")).toBeNull()
  })

  it("labels a reminder by how far off it is", () => {
    expect(reminderLabel(isoOf(NOW - 1), NOW)).toBe("due")
    expect(reminderLabel(isoOf(NOW + 12 * 60_000), NOW)).toBe("in 12m")
    expect(reminderLabel(isoOf(NOW + 5 * 3_600_000), NOW)).toBe("in 5h")
    expect(reminderLabel(isoOf(localMillis({ year: 2026, month: 2, day: 3, hour: 9, minute: 5 })), NOW)).toBe("Tue 09:05")
    expect(reminderLabel(isoOf(localMillis({ year: 2026, month: 2, day: 12, hour: 9 })), NOW)).toBe("12 Feb")
  })
})
