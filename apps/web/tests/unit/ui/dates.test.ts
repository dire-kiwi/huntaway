import { describe, expect, it } from "@effect/vitest"
import { isoOf, localeDateString, localeString, localeTimeString, localMillis, localParts, millisOf } from "../../../src/components/ui/dates"

const AT = "2026-11-01T09:00:00.000Z"
const MS = 1_793_523_600_000
const UTC = { timeZone: "UTC" } as const

describe("dates", () => {
  it("reads ISO times and milliseconds; NaN for what isn't one, as Date did", () => {
    expect(millisOf(AT)).toBe(MS)
    expect(millisOf(MS)).toBe(MS)
    expect(millisOf("not a time")).toBeNaN()
    expect(isoOf(MS)).toBe(AT)
  })

  it("formats as Date's toLocale…String, with its defaults when no field is asked for", () => {
    expect(localeString(AT, UTC, "en-US")).toBe("11/1/2026, 9:00:00 AM")
    expect(localeDateString(AT, UTC, "en-US")).toBe("11/1/2026")
    expect(localeTimeString(AT, UTC, "en-US")).toBe("9:00:00 AM")
    expect(localeDateString(AT, { ...UTC, month: "short", day: "numeric" }, "en-US")).toBe("Nov 1")
    expect(localeTimeString(AT, { ...UTC, hour: "2-digit", minute: "2-digit" }, "en-US")).toBe("09:00 AM")
    expect(localeString(AT, { ...UTC, dateStyle: "medium" }, "en-US")).toBe("Nov 1, 2026")
    expect(localeString("not a time")).toBe("Invalid Date")
  })

  it("takes a time apart in the browser's zone and puts it back together", () => {
    const parts = localParts(AT)
    expect(parts.month).toBeGreaterThanOrEqual(1)
    expect(localMillis(parts)).toBe(MS)
  })
})
