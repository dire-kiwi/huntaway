//! Cron expressions for the `cron` trigger: five fields, `minute hour day-of-month month
//! day-of-week`, each `*`, a number or name, a range (`1-5`), a step (`*/15`, `8-18/2`) or a list
//! of them (`mon,wed,fri`). Months and weekdays take their first three letters; Sunday is 0 or 7.
//! As in Vixie cron, when both day fields are restricted a day matching either runs. `@hourly`,
//! `@daily`, `@weekly`, `@monthly` and `@yearly` stand for theirs. Times are in the host's time zone.

use super::*;

const MONTHS: &[&str] = &["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS: &[&str] = &["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/// A parsed expression: a bit for each value each field takes.
#[derive(Debug, Clone, PartialEq)]
pub struct Cron {
    minutes: u64,
    hours: u32,
    days: u32,
    months: u16,
    weekdays: u8,
    /// The day-of-month and day-of-week fields were `*`.
    any_day: bool,
    any_weekday: bool,
}

/// One field's values, as bits from `min` to `max` (a weekday 7 is 0, Sunday).
fn field(s: &str, min: u32, max: u32, names: &[&str], what: &str) -> Result<u64, String> {
    let value = |v: &str| -> Result<u32, String> {
        let n = match names.iter().position(|n| n.eq_ignore_ascii_case(v)) {
            Some(i) => i as u32 + if names.len() == 12 { 1 } else { 0 },
            None => v.parse::<u32>().map_err(|_| format!("{what} has {v:?}, which isn't a number{}", if names.is_empty() { "" } else { " or a name" }))?,
        };
        // Sunday is 7 as well as 0.
        let top = if what == "day of week" { 7 } else { max };
        if n < min || n > top {
            return Err(format!("{what} must be from {min} to {top}, not {n}"));
        }
        Ok(n)
    };
    let mut bits = 0u64;
    for part in s.split(',') {
        let (range, step) = match part.split_once('/') {
            Some((r, st)) => (r, st.parse::<u32>().ok().filter(|n| *n > 0).ok_or_else(|| format!("{what} has a bad step {st:?}"))?),
            None => (part, 1),
        };
        let (from, to) = match range {
            "*" => (min, max),
            r => match r.split_once('-') {
                Some((a, b)) => (value(a)?, value(b)?),
                // `5/15` is from 5 to the end, every 15.
                None if part.contains('/') => (value(r)?, max),
                None => {
                    let v = value(r)?;
                    (v, v)
                }
            },
        };
        if from > to {
            return Err(format!("{what} has a range {range} that goes backwards"));
        }
        for v in (from..=to).step_by(step as usize) {
            bits |= 1 << if what == "day of week" { v % 7 } else { v };
        }
    }
    Ok(bits)
}

impl Cron {
    pub fn parse(expr: &str) -> Result<Self, String> {
        let expr = match expr.trim().to_ascii_lowercase().as_str() {
            "@hourly" => "0 * * * *".to_string(),
            "@daily" | "@midnight" => "0 0 * * *".to_string(),
            "@weekly" => "0 0 * * 0".to_string(),
            "@monthly" => "0 0 1 * *".to_string(),
            "@yearly" | "@annually" => "0 0 1 1 *".to_string(),
            e => e.to_string(),
        };
        let f: Vec<&str> = expr.split_whitespace().collect();
        if f.len() != 5 {
            return Err("a cron expression has five fields: minute hour day-of-month month day-of-week (e.g. 0 8 * * mon-fri)".into());
        }
        Ok(Cron {
            minutes: field(f[0], 0, 59, &[], "minute")?,
            hours: field(f[1], 0, 23, &[], "hour")? as u32,
            days: field(f[2], 1, 31, &[], "day of month")? as u32,
            months: field(f[3], 1, 12, MONTHS, "month")? as u16,
            weekdays: field(f[4], 0, 6, DAYS, "day of week")? as u8,
            any_day: f[2] == "*",
            any_weekday: f[4] == "*",
        })
    }

    fn on_date(&self, d: chrono::NaiveDate) -> bool {
        if self.months & (1 << d.month()) == 0 {
            return false;
        }
        let day = self.days & (1 << d.day()) != 0;
        let weekday = self.weekdays & (1 << d.weekday().num_days_from_sunday()) != 0;
        match (self.any_day, self.any_weekday) {
            (true, true) => true,
            (true, false) => weekday,
            (false, true) => day,
            (false, false) => day || weekday,
        }
    }

    /// The first time after `after` that it matches, in `tz`; none if it never does (in the next
    /// four years, so a 29 February counts). A time that doesn't exist that day (the clocks went
    /// forward over it) is the first one after the gap; one that happens twice is the first of them.
    pub fn next_after<Tz: TimeZone>(&self, tz: &Tz, after: DateTime<Utc>) -> Option<DateTime<Utc>> {
        let local = after.with_timezone(tz).naive_local();
        // From the day before, in case `after`'s day there is the next day here.
        let first = local.date() - chrono::TimeDelta::days(1);
        for offset in 0..=(366 * 4 + 2) {
            let date = first + chrono::TimeDelta::days(offset);
            if !self.on_date(date) {
                continue;
            }
            for h in (0..24).filter(|h| self.hours & (1 << h) != 0) {
                for m in (0..60).filter(|m| self.minutes & (1 << m) != 0) {
                    let at = date.and_time(NaiveTime::from_hms_opt(h, m, 0)?);
                    let when = tz.from_local_datetime(&at).earliest().or_else(|| {
                        (1..=24 * 60).find_map(|step| tz.from_local_datetime(&(at + chrono::TimeDelta::minutes(step))).earliest())
                    });
                    if let Some(when) = when.map(|w| w.with_timezone(&Utc))
                        && when > after
                    {
                        return Some(when);
                    }
                }
            }
        }
        None
    }
}
