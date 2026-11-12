import { DateTime, Option } from "effect"

// Times as the components show them, through Effect's `DateTime` rather than `Date` (the lint's `global-date`). The
// wire's times are ISO strings; these read them, and format them as `Date`'s `toLocale…String` did, so nothing on
// screen changes. The time now is `nowMillis` or `useNow` (state/clock.ts).

/** A time the components are given: an ISO string from the wire, or milliseconds since the epoch. */
export type At = string | number

/** Milliseconds since the epoch of an ISO time (or of milliseconds); NaN when it isn't one, as `Date` gave. */
export function millisOf(at: At): number {
  return Option.match(DateTime.make(at), { onNone: () => Number.NaN, onSome: DateTime.toEpochMillis })
}

/** The ISO string of a time (`Date#toISOString`): `2026-11-01T09:00:00.000Z`. */
export function isoOf(at: At): string {
  return DateTime.formatIso(DateTime.makeUnsafe(at))
}

const DATE_FIELDS = ["weekday", "year", "month", "day", "dateStyle"] as const
const TIME_FIELDS = ["dayPeriod", "hour", "minute", "second", "fractionalSecondDigits", "timeStyle"] as const
const DATE_DEFAULTS: Intl.DateTimeFormatOptions = { year: "numeric", month: "numeric", day: "numeric" }
const TIME_DEFAULTS: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "numeric", second: "numeric" }

const has = (options: Intl.DateTimeFormatOptions, fields: ReadonlyArray<keyof Intl.DateTimeFormatOptions>) => fields.some((f) => options[f] !== undefined)

/** Formats with the defaults `Date`'s methods add when no date or time field is asked for (ECMA-402's ToDateTimeOptions). */
function format(at: At, locales: Intl.LocalesArgument, options: Intl.DateTimeFormatOptions, fill: "any" | "date" | "time"): string {
  const ms = millisOf(at)
  if (Number.isNaN(ms)) return "Invalid Date"
  const needed = fill === "date" ? !has(options, DATE_FIELDS) : fill === "time" ? !has(options, TIME_FIELDS) : !has(options, [...DATE_FIELDS, ...TIME_FIELDS])
  const defaults = fill === "date" ? DATE_DEFAULTS : fill === "time" ? TIME_DEFAULTS : { ...DATE_DEFAULTS, ...TIME_DEFAULTS }
  return new Intl.DateTimeFormat(locales, needed ? { ...options, ...defaults } : options).format(ms)
}

/** `new Date(at).toLocaleString(locales, options)`. */
export const localeString = (at: At, options: Intl.DateTimeFormatOptions = {}, locales?: Intl.LocalesArgument): string => format(at, locales, options, "any")

/** `new Date(at).toLocaleDateString(locales, options)`. */
export const localeDateString = (at: At, options: Intl.DateTimeFormatOptions = {}, locales?: Intl.LocalesArgument): string =>
  format(at, locales, options, "date")

/** `new Date(at).toLocaleTimeString(locales, options)`. */
export const localeTimeString = (at: At, options: Intl.DateTimeFormatOptions = {}, locales?: Intl.LocalesArgument): string =>
  format(at, locales, options, "time")

/** A time in this browser's time zone. */
export const local = (at: At): DateTime.Zoned => DateTime.makeZonedUnsafe(at, { timeZone: DateTime.zoneMakeLocal() })

/**
 * The parts of a time in this browser's time zone: `month` is 1 to 12 (`Date#getMonth` was 0 to 11), `weekDay` 0 for
 * Sunday as `getDay`.
 */
export const localParts = (at: At): DateTime.DateTime.PartsWithWeekday => DateTime.toParts(local(at))

/** Milliseconds of a wall-clock time in this browser's time zone (`new Date(y, m - 1, d, …).getTime()`, month 1 to 12). */
export const localMillis = (parts: Partial<DateTime.DateTime.Parts>): number =>
  DateTime.toEpochMillis(DateTime.makeZonedUnsafe(parts, { timeZone: DateTime.zoneMakeLocal(), adjustForTimeZone: true }))
