import { describe, expect, it } from "@effect/vitest"
import { addDays, addMonths, atHour, dayKey, localDay, partsOf, startOfDay, startOfMonth, startOfWeek } from "../../src/components/settings/analytics/analytics"
import { parseDay, PRESETS, presetRange } from "../../src/components/settings/analytics/range"

// The Analytics page's calendar arithmetic, in the zone the tests run in (as `Date`'s local setters did it): days move by
// date, so a daylight saving change on the way doesn't shift them off midnight.

/** 3 pm on a local date. */
const afternoon = (y: number, m: number, d: number) => atHour(localDay(y, m, d), 15)

describe("analytics dates", () => {
  it("takes a time to its day, week (from Monday) and month", () => {
    // Thursday 12 November 2026.
    const t = afternoon(2026, 11, 12)
    expect(partsOf(t)).toMatchObject({ year: 2026, month: 11, day: 12, hour: 15, weekDay: 4 })
    expect(startOfDay(t)).toBe(localDay(2026, 11, 12))
    expect(startOfWeek(t)).toBe(localDay(2026, 11, 9))
    expect(startOfWeek(afternoon(2026, 11, 15))).toBe(localDay(2026, 11, 9))
    expect(startOfWeek(afternoon(2026, 11, 16))).toBe(localDay(2026, 11, 16))
    expect(startOfMonth(t)).toBe(localDay(2026, 11, 1))
    expect(dayKey(atHour(localDay(2026, 3, 5), 23))).toBe("2026-03-05")
  })

  it("moves by calendar days and months, keeping the time of day", () => {
    expect(addDays(afternoon(2026, 12, 30), 3)).toBe(afternoon(2027, 1, 2))
    expect(addDays(localDay(2026, 3, 1), -1)).toBe(localDay(2026, 2, 28))
    // To the first of the month, so the 31st doesn't skip a short one.
    expect(addMonths(afternoon(2026, 1, 31), 1)).toBe(afternoon(2026, 2, 1))
    expect(addMonths(localDay(2026, 1, 15), -2)).toBe(localDay(2025, 11, 1))
  })

  it("goes from each day of a year to the next, across daylight saving changes", () => {
    for (let i = 0; i < 365; i++) {
      // Days past the end of January roll over, as Date's did.
      const day = localDay(2026, 1, 1 + i)
      const next = localDay(2026, 1, 2 + i)
      const { year, month, day: date } = partsOf(next)
      expect(startOfDay(addDays(day, 1))).toBe(next)
      expect(startOfDay(atHour(next, 12))).toBe(next)
      expect(dayKey(addDays(day, 1))).toBe(`${year}-${String(month).padStart(2, "0")}-${String(date).padStart(2, "0")}`)
    }
    expect(dayKey(localDay(2026, 1, 366))).toBe("2027-01-01")
  })

  it("reads a picked day, rolling over as Date did", () => {
    expect(parseDay("2026-11-02")).toBe(localDay(2026, 11, 2))
    expect(parseDay("2026-13-01")).toBe(localDay(2027, 1, 1))
  })
})

/** Midnight of a day in 2026. */
const day = (m: number, d: number) => localDay(2026, m, d)

describe("presetRange", () => {
  const now = afternoon(2026, 11, 12)
  const custom = { from: "2026-11-05", to: "2026-11-01" }

  it("covers what each preset says, the end not included", () => {
    const ranges = Object.fromEntries(PRESETS.map((p) => [p.id, presetRange(p.id, custom, now)]))
    expect(ranges).toEqual({
      today: { from: day(11, 12), to: day(11, 13) },
      yesterday: { from: day(11, 11), to: day(11, 12) },
      this_week: { from: day(11, 9), to: day(11, 16) },
      last_week: { from: day(11, 2), to: day(11, 9) },
      this_month: { from: day(11, 1), to: day(12, 1) },
      last_month: { from: day(10, 1), to: day(11, 1) },
      last_7: { from: day(11, 6), to: day(11, 13) },
      last_30: { from: day(10, 14), to: day(11, 13) },
      // The custom days in either order, both included.
      custom: { from: day(11, 1), to: day(11, 6) },
    })
  })

  it("takes January's last month from the year before", () => {
    expect(presetRange("last_month", custom, afternoon(2026, 1, 20))).toEqual({ from: localDay(2025, 12, 1), to: localDay(2026, 1, 1) })
  })
})
