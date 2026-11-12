import { assert, describe, it } from "@effect/vitest"
import { DateTime } from "effect"
import type { ActiveHours, Trigger, Weekday } from "@huntaway/contracts"
import { activeContains, formatLocal, fromLocal, HOUR, naive, nextAfter, nextRun, parseAt, parseTime } from "./schedule.ts"

// The old automations' schedule cases (huntaway's automations/tests.test.ts and tests/routines.test.ts): times of day,
// cron expressions and active hours in a time zone with daylight saving. The old tests made New Zealand's rules by
// hand (+12, +13 from 2:00 on 2026-09-27 until 3:00 on 2027-04-04); Pacific/Auckland has the same ones.

const Nz = DateTime.zoneMakeNamedUnsafe("Pacific/Auckland")

const utc = (s: string): number => parseTime(s) ?? assert.fail(`not a time: ${s}`)

/** A local time in New Zealand, `YYYY-MM-DD HH:MM`. */
const nz = (s: string): number => {
  const [d = "", t = ""] = s.split(" ")
  const [y = 0, mo = 0, da = 0] = d.split("-").map(Number)
  const [h = 0, mi = 0] = t.split(":").map(Number)
  const local = naive(y, mo, da, h, mi) ?? assert.fail(`not a date: ${s}`)
  return fromLocal(Nz, local) ?? assert.fail(`not a time in New Zealand: ${s}`)
}

const daily = (time: string, weekdays: ReadonlyArray<Weekday>): Trigger => ({ kind: "daily", time, weekdays })
const cron = (expr: string): Trigger => ({ kind: "cron", expr })
const next = (t: Trigger, after: number) => nextAfter(t, after, Nz) ?? assert.fail(`${t.kind} never runs`)
const c = (e: string, after: number) => next(cron(e), after)
const hours = (start: string, end: string, weekdays: ReadonlyArray<Weekday>): ActiveHours => ({ start, end, weekdays })

describe("schedules", () => {
  it("times of day follow weekdays and daylight saving", () => {
    // 2026-09-25 is a Friday.
    const weekdays = daily("09:00", ["mon", "tue", "wed", "thu", "fri"])
    assert.strictEqual(next(weekdays, nz("2026-09-25 08:59")), nz("2026-09-25 09:00"))
    assert.strictEqual(next(weekdays, nz("2026-09-25 09:00")), nz("2026-09-28 09:00"))
    // Across the change, 9:00 is still 9:00 local: an hour less in UTC.
    assert.strictEqual(nz("2026-09-28 09:00") - nz("2026-09-25 09:00"), (3 * 24 - 1) * HOUR)
    // 2:30 doesn't exist on 2026-09-27: it runs when the clocks go forward, at 3:00.
    const early = daily("02:30", [])
    assert.strictEqual(next(early, nz("2026-09-26 03:00")), nz("2026-09-27 03:00"))
    assert.strictEqual(nz("2026-09-27 03:00"), utc("2026-09-26T14:00:00Z"))
    assert.strictEqual(next(early, nz("2026-09-27 03:00")), nz("2026-09-28 02:30"))
    // 2:30 happens twice on 2027-04-04: it runs at the first, and not again at the second.
    const first = next(early, nz("2027-04-04 01:00"))
    assert.strictEqual(first, utc("2027-04-03T13:30:00Z"))
    const second = first + HOUR
    assert.strictEqual(formatLocal(Nz, second).slice(11), "02:30")
    assert.strictEqual(next(early, first), utc("2027-04-04T14:30:00Z"))
    assert.isTrue(next(early, first) > second)
    // A weekly run on a day that only comes round next week.
    assert.strictEqual(next(daily("10:00", ["sun"]), nz("2026-09-27 10:00")), nz("2026-10-04 10:00"))
  })

  it("cron expressions follow their fields and daylight saving", () => {
    assert.strictEqual(c("0 8 * * mon-fri", nz("2026-09-25 08:00")), nz("2026-09-28 08:00"))
    assert.strictEqual(c("*/15 9-17 * * *", nz("2026-09-25 17:50")), nz("2026-09-26 09:00"))
    assert.strictEqual(c("*/15 9-17 * * *", nz("2026-09-25 10:01")), nz("2026-09-25 10:15"))
    assert.strictEqual(c("30 7 1 * *", nz("2026-09-25 00:00")), nz("2026-10-01 07:30"))
    assert.strictEqual(c("0 12 * jan,jul *", nz("2026-09-25 00:00")), nz("2027-01-01 12:00"))
    // Both day fields restricted: either one will do, as in Vixie cron.
    assert.strictEqual(c("0 9 13 * fri", nz("2026-09-25 10:00")), nz("2026-10-02 09:00"))
    assert.strictEqual(c("0 9 1 * fri", nz("2026-09-26 10:00")), nz("2026-10-01 09:00"))
    // Sunday is 0 or 7, and @daily is midnight.
    assert.strictEqual(c("0 10 * * 7", nz("2026-09-25 00:00")), c("0 10 * * sun", nz("2026-09-25 00:00")))
    assert.strictEqual(c("@daily", nz("2026-09-25 13:00")), nz("2026-09-26 00:00"))
    assert.strictEqual(c("@HOURLY", nz("2026-09-25 13:10")), nz("2026-09-25 14:00"))
    // 2:30 doesn't exist on 2026-09-27 (the clocks go forward): it runs at 3:00, once.
    assert.strictEqual(c("30 2 * * *", nz("2026-09-26 03:00")), nz("2026-09-27 03:00"))
    assert.strictEqual(c("30 2 * * *", nz("2026-09-27 03:00")), nz("2026-09-28 02:30"))
    // 2:30 happens twice on 2027-04-04: the first, and not the second.
    const first = c("30 2 * * *", nz("2027-04-04 01:00"))
    assert.strictEqual(first, utc("2027-04-03T13:30:00Z"))
    assert.strictEqual(c("30 2 * * *", first), utc("2027-04-04T14:30:00Z"))
    // A 29 February comes round.
    assert.strictEqual(c("0 0 29 2 *", nz("2026-09-25 00:00")), nz("2028-02-29 00:00"))
    // One that never does is none.
    assert.isNull(nextAfter(cron("0 0 30 2 *"), nz("2026-09-25 00:00"), Nz))
  })

  it("a day field that starts with a star keeps its steps and must match too", () => {
    // Stepped days of the month: the 1st, 3rd, … 27th, 29th (2026-09-25 is a Friday).
    assert.strictEqual(c("0 9 */2 * *", nz("2026-09-25 10:00")), nz("2026-09-27 09:00"))
    assert.strictEqual(c("0 9 */2 * *", nz("2026-09-29 10:00")), nz("2026-10-01 09:00"))
    // Stepped weekdays: Sunday, Tuesday, Thursday and Saturday.
    assert.strictEqual(c("0 9 * * */2", nz("2026-09-27 10:00")), nz("2026-09-29 09:00"))
    // With the other field restricted, a day has to match both: an odd day that's a Monday (2026-10-05).
    assert.strictEqual(c("0 9 */2 * mon", nz("2026-09-25 10:00")), nz("2026-10-05 09:00"))
    // The 1st, on a Sunday, Tuesday, Thursday or Saturday: 2026-10-01 is a Thursday.
    assert.strictEqual(c("0 9 1 * */2", nz("2026-09-25 10:00")), nz("2026-10-01 09:00"))
    // Two restricted fields: either will do, so the next Wednesday (2026-09-30) comes before the 1st.
    assert.strictEqual(c("0 9 1 * wed", nz("2026-09-25 10:00")), nz("2026-09-30 09:00"))
    // But `*/31` (the 1st) starts with `*`: the 1st when it's a Wednesday, not until 2027-09-01.
    assert.strictEqual(c("0 9 */31 * wed", nz("2026-09-25 10:00")), nz("2027-09-01 09:00"))
  })

  it("active hours hold back a schedule until they start", () => {
    const night = hours("22:00", "06:00", [])
    assert.isTrue(activeContains(night, nz("2026-09-25 23:30"), Nz))
    assert.isTrue(activeContains(night, nz("2026-09-26 05:59"), Nz))
    assert.isFalse(activeContains(night, nz("2026-09-26 06:00"), Nz))
    assert.isFalse(activeContains(night, nz("2026-09-25 12:00"), Nz))
    // Past midnight belongs to the day the hours started: Friday night's run into Saturday.
    const fridayNight = hours("22:00", "02:00", ["fri"])
    assert.isTrue(activeContains(fridayNight, nz("2026-09-26 01:00"), Nz))
    assert.isFalse(activeContains(fridayNight, nz("2026-09-27 01:00"), Nz))

    const day = hours("08:00", "18:00", ["mon", "tue", "wed", "thu", "fri"])
    const every: Trigger = { kind: "interval", every_minutes: 30 }
    // An interval outside them starts again when they do: Friday evening waits for Monday.
    assert.strictEqual(nextRun(every, day, nz("2026-09-25 17:45"), Nz), nz("2026-09-28 08:00"))
    assert.strictEqual(nextRun(every, day, nz("2026-09-25 10:00"), Nz), nz("2026-09-25 10:30"))
    // A cron expression waits for its next time in them.
    assert.strictEqual(nextRun(cron("15 * * * *"), day, nz("2026-09-25 17:20"), Nz), nz("2026-09-28 08:15"))
    // An at keeps its time.
    const at: Trigger = { kind: "at", at: DateTime.formatIso(DateTime.makeUnsafe(nz("2026-09-26 03:00"))) }
    assert.strictEqual(nextRun(at, day, nz("2026-09-25 17:20"), Nz), nz("2026-09-26 03:00"))
  })

  it("an at is a UTC time or a local one", () => {
    assert.strictEqual(parseAt("2026-11-04T20:30:00Z", Nz), utc("2026-11-04T20:30:00Z"))
    assert.strictEqual(parseAt(" 2026-11-05 09:30 ", Nz), nz("2026-11-05 09:30"))
    assert.strictEqual(parseAt("2026-11-05T09:30:15", Nz), nz("2026-11-05 09:30") + 15_000)
    // Not a time, nor one in the gap.
    assert.isNull(parseAt("2026-02-30 09:00", Nz))
    assert.isNull(parseAt("tomorrow", Nz))
    assert.isNull(parseAt("2026-09-27 02:30", Nz))
  })
})
