//! Checking what the API is given: triggers, actions, and when a trigger next fires.

use super::*;

pub(super) fn bad(m: impl Into<String>) -> ApiError {
    ApiError::bad(m)
}

fn parse_daily_time(t: &str) -> Option<NaiveTime> {
    NaiveTime::parse_from_str(t.trim(), "%H:%M").ok()
}

fn weekday(d: &str) -> Option<Weekday> {
    WEEKDAYS.iter().position(|w| w.eq_ignore_ascii_case(d.trim())).map(|i| Weekday::try_from(i as u8).unwrap())
}

fn check_weekdays(weekdays: &[String]) -> ApiResult<Vec<String>> {
    let mut days = Vec::new();
    for d in weekdays {
        let w = weekday(d).ok_or_else(|| bad(format!("weekdays must be from {WEEKDAYS:?}")))?;
        days.push(w.num_days_from_monday());
    }
    days.sort();
    days.dedup();
    Ok(if days.len() == 7 { vec![] } else { days.into_iter().map(|d| WEEKDAYS[d as usize].to_string()).collect() })
}

/// When an `at` trigger fires: a UTC RFC 3339 time, or a local `YYYY-MM-DD HH:MM` (or with a `T`)
/// in `tz`.
pub fn parse_at<Tz: TimeZone>(at: &str, tz: &Tz) -> Option<DateTime<Utc>> {
    let at = at.trim();
    parse_time(at).or_else(|| {
        let local = ["%Y-%m-%d %H:%M", "%Y-%m-%dT%H:%M", "%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S"]
            .iter()
            .find_map(|f| chrono::NaiveDateTime::parse_from_str(at, f).ok())?;
        tz.from_local_datetime(&local).earliest().map(|t| t.with_timezone(&Utc))
    })
}

/// A trigger as it's stored: checked, and tidied (weekdays in order, each once).
pub fn check_trigger(t: Trigger) -> ApiResult<Trigger> {
    Ok(match t {
        Trigger::Interval { every_minutes } if !(MIN_INTERVAL_MINUTES..=MAX_INTERVAL_MINUTES).contains(&every_minutes) => {
            return Err(bad(format!("every_minutes must be from {MIN_INTERVAL_MINUTES} to {MAX_INTERVAL_MINUTES} (31 days)")));
        }
        Trigger::Interval { every_minutes } => Trigger::Interval { every_minutes },
        Trigger::Daily { time, weekdays } => {
            let at = parse_daily_time(&time).ok_or_else(|| bad("time must be a time of day like 09:30"))?;
            Trigger::Daily { time: at.format("%H:%M").to_string(), weekdays: check_weekdays(&weekdays)? }
        }
        Trigger::Cron { expr } => {
            let expr = expr.split_whitespace().collect::<Vec<_>>().join(" ");
            let cron = cron::Cron::parse(&expr).map_err(bad)?;
            if cron.next_after(&Local, Utc::now()).is_none() {
                return Err(bad(format!("the cron expression {expr} never matches")));
            }
            Trigger::Cron { expr }
        }
        Trigger::At { at } => {
            let when = parse_at(&at, &Local).ok_or_else(|| bad("at must be a time like 2026-11-05 09:30 (in the host's time zone) or 2026-11-04T20:30:00Z"))?;
            Trigger::At { at: fmt(when) }
        }
        Trigger::Webhook { filters, coalesce_seconds, coalesce_key } => {
            if filters.len() > MAX_FILTERS {
                return Err(bad(format!("a webhook can have at most {MAX_FILTERS} filters")));
            }
            for f in &filters {
                if !valid_path(f.path.trim()) {
                    return Err(bad(format!("filter path {:?} must name a value, like event, action, labels or body.issue.title", f.path)));
                }
                let needs_value = !matches!(f.op, FilterOp::Exists | FilterOp::NotExists);
                if needs_value && wanted(f).is_empty() {
                    return Err(bad(format!("the filter on {} needs a value", f.path.trim())));
                }
            }
            if coalesce_seconds > MAX_COALESCE_SECONDS {
                return Err(bad(format!("coalesce_seconds must be at most {MAX_COALESCE_SECONDS}")));
            }
            if coalesce_key.len() > 500 {
                return Err(bad("coalesce_key is too long"));
            }
            let filters = filters.into_iter().map(|f| Filter { path: f.path.trim().to_string(), ..f }).collect();
            Trigger::Webhook { filters, coalesce_seconds, coalesce_key: coalesce_key.trim().to_string() }
        }
    })
}

/// The hours a run may start in, as they're stored (none for any time).
pub fn check_active_hours(v: &Value) -> ApiResult<Option<ActiveHours>> {
    if v.is_null() {
        return Ok(None);
    }
    let h: ActiveHours = parse("active_hours", v)?;
    let time = |t: &str| parse_daily_time(t).ok_or_else(|| bad("active_hours' start and end must be times of day like 08:00"));
    let (start, end) = (time(&h.start)?, time(&h.end)?);
    if start == end {
        return Err(bad("active_hours' start and end can't be the same (leave active_hours out for any time)"));
    }
    Ok(Some(ActiveHours { start: start.format("%H:%M").to_string(), end: end.format("%H:%M").to_string(), weekdays: check_weekdays(&h.weekdays)? }))
}

/// A precheck command as it's stored (none for blank).
pub fn check_precheck(v: &Value) -> ApiResult<Option<String>> {
    match v {
        Value::Null => Ok(None),
        Value::String(s) if s.trim().is_empty() => Ok(None),
        Value::String(s) if s.chars().count() <= 4000 => Ok(Some(s.trim().to_string())),
        _ => Err(bad("precheck must be a command of up to 4000 characters")),
    }
}

/// A budget a day as it's stored (none for no limit).
pub fn check_budget(v: &Value) -> ApiResult<Option<f64>> {
    match v {
        Value::Null => Ok(None),
        v => match v.as_f64() {
            Some(n) if n == 0.0 => Ok(None),
            Some(n) if n > 0.0 && n <= 10_000.0 => Ok(Some(n)),
            _ => Err(bad("budget_usd must be a number of dollars from 0 (no limit) to 10000")),
        },
    }
}

/// What an automation belongs to: a project, or for a routine, a profile.
#[derive(Clone, Debug)]
pub enum Owner {
    Project(db::Project),
    Profile(String),
}

impl Owner {
    pub fn profile_id(&self) -> &str {
        match self {
            Owner::Project(p) => &p.profile_id,
            Owner::Profile(id) => id,
        }
    }

    pub fn project_id(&self) -> Option<&str> {
        match self {
            Owner::Project(p) => Some(&p.id),
            Owner::Profile(_) => None,
        }
    }
}

/// What `a` belongs to (its project must still be there).
pub fn owner(c: &Connection, a: &Automation) -> ApiResult<Owner> {
    Ok(match &a.project_id {
        Some(id) => Owner::Project(db::get_project(c, id)?.ok_or_else(|| ApiError::not_found("project"))?),
        None => Owner::Profile(a.profile_id.clone()),
    })
}

/// An action as it's stored: checked against the automation's project, so it can only make tasks
/// there, with its agent configs, and only message its tasks. A routine's (a profile's) can only
/// message its assistant, and a project's can't.
pub fn check_action(c: &Connection, owner: &Owner, a: Action) -> ApiResult<Action> {
    let blank = |v: Option<String>| v.map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
    let project = match (owner, &a) {
        (Owner::Profile(_), Action::MessageAssistant { message, mode }) => {
            if message.trim().is_empty() {
                return Err(bad("the message can't be blank"));
            }
            if message.chars().count() > MAX_TEXT_CHARS {
                return Err(bad("the message is too long"));
            }
            return Ok(Action::MessageAssistant { message: message.clone(), mode: *mode });
        }
        (Owner::Profile(_), _) => return Err(bad("a routine (a profile's automation) can only message the assistant (message_assistant)")),
        (Owner::Project(_), Action::MessageAssistant { .. }) => return Err(bad("message_assistant is for a profile's routines, not a project's automations")),
        (Owner::Project(p), _) => p,
    };
    Ok(match a {
        Action::CreateTask { title, description, task_type, labels, claude_config_id, model, effort, status, start } => {
            if title.trim().is_empty() {
                return Err(bad("the task's title can't be blank"));
            }
            if title.chars().count() > 500 || description.chars().count() > MAX_TEXT_CHARS {
                return Err(bad("the task's title or description is too long"));
            }
            let mut task_type = blank(task_type);
            // A label as its type, as before API 71.
            let labels: Vec<Value> = labels.into_iter().chain(task_type.take_if(|t| db::LABELS.contains(&t.as_str()))).map(Value::String).collect();
            let labels = crate::agent::documents::check_labels(&Value::Array(labels)).map_err(bad)?.into_iter().map(String::from).collect();
            if task_type.as_deref().is_some_and(|t| !db::TASK_TYPES.contains(&t)) {
                return Err(bad(format!("task_type must be one of {:?}", db::TASK_TYPES)));
            }
            let effort = blank(effort);
            if effort.as_deref().is_some_and(|e| !db::THREAD_EFFORTS.contains(&e)) {
                return Err(bad(format!("effort must be one of {:?}", db::THREAD_EFFORTS)));
            }
            if !["todo", "backlog"].contains(&status.as_str()) {
                return Err(bad("status must be todo or backlog (a task that's started moves to in_progress)"));
            }
            let claude_config_id = api::pick_config(c, &project.profile_id, Some(project), blank(claude_config_id).as_deref())?;
            Action::CreateTask { title: title.trim().to_string(), description, task_type, labels, claude_config_id, model: blank(model), effort, status, start }
        }
        Action::SendToTask { task_id, message } => {
            if message.trim().is_empty() {
                return Err(bad("the message can't be blank"));
            }
            if message.chars().count() > MAX_TEXT_CHARS {
                return Err(bad("the message is too long"));
            }
            let t = target_task(c, project, task_id.trim())?;
            Action::SendToTask { task_id: t.id, message }
        }
        Action::MessageAssistant { .. } => unreachable!("checked above"),
    })
}

/// The task a message goes to: one of the project's own tasks, never another project's (or
/// another profile's).
pub(super) fn target_task(c: &Connection, project: &db::Project, task_id: &str) -> ApiResult<db::Task> {
    match db::get_task(c, task_id)? {
        Some(t) if t.kind == "task" && t.project_id.as_deref() == Some(project.id.as_str()) => Ok(t),
        Some(_) => Err(bad("an automation can only send messages to tasks in its own project")),
        None => Err(ApiError::not_found("task")),
    }
}

/// When a schedule next runs after `now`, in `tz`; none for a webhook.
pub fn next_after<Tz: TimeZone>(trigger: &Trigger, now: DateTime<Utc>, tz: &Tz) -> Option<DateTime<Utc>> {
    match trigger {
        Trigger::Interval { every_minutes } => Some(now + chrono::TimeDelta::minutes(*every_minutes as i64)),
        Trigger::Daily { time, weekdays } => {
            let days: Vec<Weekday> = weekdays.iter().filter_map(|d| weekday(d)).collect();
            next_daily(tz, parse_daily_time(time)?, &days, now)
        }
        Trigger::Cron { expr } => cron::Cron::parse(expr).ok()?.next_after(tz, now),
        Trigger::At { at } => parse_time(at).filter(|t| *t > now),
        Trigger::Webhook { .. } => None,
    }
}

/// When a schedule next runs after `now`, in its active hours (if it has them): see `align`.
pub fn next_run<Tz: TimeZone>(trigger: &Trigger, active: Option<&ActiveHours>, now: DateTime<Utc>, tz: &Tz) -> Option<DateTime<Utc>> {
    align(trigger, active, next_after(trigger, now, tz)?, tz)
}

/// `when`, or if it's outside the active hours, the schedule's first time in them: an interval
/// starts again when they do, a time of day or cron expression waits for its next time in them.
/// An `at` keeps its time.
pub fn align<Tz: TimeZone>(trigger: &Trigger, active: Option<&ActiveHours>, when: DateTime<Utc>, tz: &Tz) -> Option<DateTime<Utc>> {
    let Some(active) = active.filter(|_| !matches!(trigger, Trigger::At { .. } | Trigger::Webhook { .. })) else { return Some(when) };
    let mut when = when;
    // Each round moves on to the next window at least, so a year's worth is plenty.
    for _ in 0..800 {
        if active.contains(when, tz) {
            return Some(when);
        }
        let start = active.next_start(when, tz)?;
        when = match trigger {
            Trigger::Interval { .. } => start,
            _ => next_after(trigger, start - chrono::TimeDelta::seconds(1), tz)?,
        };
    }
    None
}

impl ActiveHours {
    fn times(&self) -> Option<(NaiveTime, NaiveTime, Vec<Weekday>)> {
        Some((parse_daily_time(&self.start)?, parse_daily_time(&self.end)?, self.weekdays.iter().filter_map(|d| weekday(d)).collect()))
    }

    /// Whether `t` is in them. Hours past midnight belong to the day they started on.
    pub fn contains<Tz: TimeZone>(&self, t: DateTime<Utc>, tz: &Tz) -> bool {
        let Some((start, end, days)) = self.times() else { return true };
        let local = t.with_timezone(tz).naive_local();
        let (date, time) = (local.date(), local.time());
        let on = |d: chrono::NaiveDate| days.is_empty() || days.contains(&d.weekday());
        if start < end {
            on(date) && time >= start && time < end
        } else {
            (time >= start && on(date)) || (time < end && on(date - chrono::TimeDelta::days(1)))
        }
    }

    /// When they next start after `t`.
    fn next_start<Tz: TimeZone>(&self, t: DateTime<Utc>, tz: &Tz) -> Option<DateTime<Utc>> {
        let (start, _, days) = self.times()?;
        next_daily(tz, start, &days, t)
    }

    /// As the deliveries list says them, e.g. `08:00–22:00 on Mon, Tue`.
    pub fn text(&self) -> String {
        let days = if self.weekdays.is_empty() { String::new() } else { format!(" on {}", self.weekdays.join(", ")) };
        format!("{}–{}{days}", self.start, self.end)
    }
}

/// The first time after `after` that's `at` on one of `days` (any day if none) in `tz`. A time
/// that doesn't exist that day (the clocks went forward over it) is the first one after the gap;
/// one that happens twice (they went back) is the first of the two, so it runs once.
pub fn next_daily<Tz: TimeZone>(tz: &Tz, at: NaiveTime, days: &[Weekday], after: DateTime<Utc>) -> Option<DateTime<Utc>> {
    let today = after.with_timezone(tz).date_naive();
    // From the day before, in case `after`'s day there is the next day here.
    for offset in -1..=8 {
        let date = today + chrono::TimeDelta::days(offset);
        if !days.is_empty() && !days.contains(&date.weekday()) {
            continue;
        }
        let local = date.and_time(at);
        let when = tz.from_local_datetime(&local).earliest().or_else(|| {
            // In a gap: the first minute after it.
            (1..=24 * 60).find_map(|m| tz.from_local_datetime(&(local + chrono::TimeDelta::minutes(m))).earliest())
        });
        if let Some(when) = when.map(|w| w.with_timezone(&Utc))
            && when > after
        {
            return Some(when);
        }
    }
    None
}

/// The host's time zone, as the settings show it: its name where the system says, and its offset now.
pub fn time_zone() -> Value {
    let name = std::env::var("TZ").ok().map(|t| t.trim_start_matches(':').to_string()).filter(|t| !t.is_empty()).or_else(|| {
        let link = std::fs::read_link("/etc/localtime").ok()?;
        let link = link.to_string_lossy();
        link.split_once("zoneinfo/").map(|(_, name)| name.to_string())
    });
    json!({"name": name, "offset": Local::now().format("%:z").to_string()})
}
