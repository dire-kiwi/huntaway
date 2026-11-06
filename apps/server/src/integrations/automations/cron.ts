// Port of server/src/integrations/automations/cron.rs (HA-122, on the HA-117 branch).
/**
 * Cron expressions for the `cron` trigger: five fields, `minute hour day-of-month month day-of-week`, each `*`, a number
 * or name, a range (`1-5`), a step (`*\/15`, `8-18/2`) or a list of them (`mon,wed,fri`). Months and weekdays take their
 * first three letters; Sunday is 0 or 7. As in Vixie cron, a day must match both day fields if either starts with `*`
 * (as `*` or `*\/2` do, which keep their steps), and either of them otherwise. `@hourly`, `@daily`, `@weekly`, `@monthly`
 * and `@yearly` stand for theirs. Times are in the host's time zone.
 */
import { from_local, local_parts, to_local, type Tz } from "./check.ts";

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const MINUTE = 60_000;
const DAY = 86_400_000;

/** A parsed expression: the values each field takes (a bit for each, as a bigint for the minutes' 60). */
export interface Cron {
  minutes: bigint;
  hours: number;
  days: number;
  months: number;
  weekdays: number;
  /** The day-of-month or day-of-week field started with `*` (Vixie's star flags). */
  star_day: boolean;
  star_weekday: boolean;
}

/** One field's values, as bits from `min` to `max` (a weekday 7 is 0, Sunday). Throws its error as a string. */
function field(s: string, min: number, max: number, names: string[], what: string): bigint {
  const value = (v: string): number => {
    const i = names.findIndex((n) => n.toLowerCase() === v.toLowerCase());
    let n: number;
    if (i >= 0) n = i + (names.length === 12 ? 1 : 0);
    else {
      if (!/^\+?\d+$/.test(v)) throw `${what} has ${JSON.stringify(v)}, which isn't a number${names.length ? " or a name" : ""}`;
      n = Number(v);
    }
    // Sunday is 7 as well as 0.
    const top = what === "day of week" ? 7 : max;
    if (n < min || n > top) throw `${what} must be from ${min} to ${top}, not ${n}`;
    return n;
  };
  let bits = 0n;
  for (const part of s.split(",")) {
    let range = part;
    let step = 1;
    const slash = part.indexOf("/");
    if (slash >= 0) {
      range = part.slice(0, slash);
      const st = part.slice(slash + 1);
      const n = /^\+?\d+$/.test(st) ? Number(st) : NaN;
      if (!(n > 0) || n > 0xffffffff) throw `${what} has a bad step ${JSON.stringify(st)}`;
      step = n;
    }
    let from: number, to: number;
    if (range === "*") [from, to] = [min, max];
    else {
      const dash = range.indexOf("-");
      if (dash >= 0) [from, to] = [value(range.slice(0, dash)), value(range.slice(dash + 1))];
      // `5/15` is from 5 to the end, every 15.
      else if (part.includes("/")) [from, to] = [value(range), max];
      else from = to = value(range);
    }
    if (from > to) throw `${what} has a range ${range} that goes backwards`;
    for (let v = from; v <= to; v += step) bits |= 1n << BigInt(what === "day of week" ? v % 7 : v);
  }
  return bits;
}

/** Parses an expression; throws why it can't as a string (Rust's `Result<Self, String>`). */
export function Cron_parse(expr: string): Cron {
  const e = expr.trim().toLowerCase();
  const aliases: Record<string, string> = {
    "@hourly": "0 * * * *",
    "@daily": "0 0 * * *",
    "@midnight": "0 0 * * *",
    "@weekly": "0 0 * * 0",
    "@monthly": "0 0 1 * *",
    "@yearly": "0 0 1 1 *",
    "@annually": "0 0 1 1 *",
  };
  const f = (aliases[e] ?? e).split(/\s+/).filter((x) => x !== "");
  if (f.length !== 5) throw "a cron expression has five fields: minute hour day-of-month month day-of-week (e.g. 0 8 * * mon-fri)";
  return {
    minutes: field(f[0], 0, 59, [], "minute"),
    hours: Number(field(f[1], 0, 23, [], "hour")),
    days: Number(field(f[2], 1, 31, [], "day of month")),
    months: Number(field(f[3], 1, 12, MONTHS, "month")),
    weekdays: Number(field(f[4], 0, 6, DAYS, "day of week")),
    star_day: f[2].startsWith("*"),
    star_weekday: f[4].startsWith("*"),
  };
}

/** Whether `c` matches the date `date` (milliseconds at its midnight UTC, a NaiveDate). */
function on_date(c: Cron, date: number): boolean {
  const d = new Date(date);
  if ((c.months & (1 << (d.getUTCMonth() + 1))) === 0) return false;
  const day = (c.days & (1 << d.getUTCDate())) !== 0;
  const weekday = (c.weekdays & (1 << d.getUTCDay())) !== 0;
  // A field that starts with `*` matches every day (`*`) or its steps (`*\/2`): both must match. Two restricted fields
  // mean either day will do.
  return c.star_day || c.star_weekday ? day && weekday : day || weekday;
}

/**
 * The first time after `after` that `c` matches, in `tz`; none if it never does (in the next four years, so a 29
 * February counts). A time that doesn't exist that day (the clocks went forward over it) is the first one after the gap;
 * one that happens twice is the first of them.
 */
export function Cron_next_after(c: Cron, tz: Tz, after: number): number | null {
  const l = local_parts(to_local(tz, after));
  // From the day before, in case `after`'s day there is the next day here.
  const first = Date.UTC(l.y, l.mo - 1, l.d) - DAY;
  for (let offset = 0; offset <= 366 * 4 + 2; offset++) {
    const date = first + offset * DAY;
    if (!on_date(c, date)) continue;
    for (let h = 0; h < 24; h++) {
      if ((c.hours & (1 << h)) === 0) continue;
      for (let m = 0; m < 60; m++) {
        if ((c.minutes & (1n << BigInt(m))) === 0n) continue;
        const at = date + h * 3_600_000 + m * MINUTE;
        let when = from_local(tz, at);
        for (let step = 1; when === null && step <= 24 * 60; step++) when = from_local(tz, at + step * MINUTE);
        if (when !== null && when > after) return when;
      }
    }
  }
  return null;
}
