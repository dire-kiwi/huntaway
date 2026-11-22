import { describe, expect, it } from "@effect/vitest"
import { forInput } from "../../src/components/task/thread/a2ui/dates"

// HE-77 review: a time-only DateTimeInput showed nothing, as its value was cut as if it were a date-time.
describe("forInput", () => {
  it("shows a time from a time, a date-time or what the input wrote", () => {
    expect(forInput("time", "14:30")).toBe("14:30")
    expect(forInput("time", "09:00:00")).toBe("09:00")
    expect(forInput("time", "2026-03-14T09:15:00Z")).toBe("09:15")
  })

  it("shows a date, and a date-time", () => {
    expect(forInput("date", "2026-03-14T09:15:00Z")).toBe("2026-03-14")
    expect(forInput("datetime-local", "2026-03-14T09:15:00Z")).toBe("2026-03-14T09:15")
    expect(forInput("datetime-local", "2026-03-14")).toBe("2026-03-14T00:00")
    expect(forInput("datetime-local", "")).toBe("")
  })
})
