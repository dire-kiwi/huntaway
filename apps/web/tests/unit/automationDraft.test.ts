import { describe, expect, it } from "@effect/vitest"
import { inputMillis, localInput } from "../../src/components/settings/automations/draft"
import { isoOf, localMillis, localParts } from "../../src/components/ui/dates"

describe("automation draft times", () => {
  it("writes a time as a datetime-local value in the browser's zone, and reads it back to the minute", () => {
    const at = "2026-11-01T09:30:45.123Z"
    const value = localInput(at)
    expect(value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
    const p = localParts(at)
    expect(inputMillis(value)).toBe(localMillis({ year: p.year, month: p.month, day: p.day, hour: p.hour, minute: p.minute }))
    expect(localInput(isoOf(inputMillis(value)))).toBe(value)
  })

  it("reads seconds when the value has them, and nothing from what isn't a value", () => {
    expect(inputMillis("2026-11-01T09:30:15") - inputMillis("2026-11-01T09:30")).toBe(15_000)
    expect(inputMillis("")).toBeNaN()
    expect(inputMillis("tomorrow")).toBeNaN()
  })
})
