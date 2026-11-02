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

/// A trigger as it's stored: checked, and tidied (weekdays in order, each once).
pub fn check_trigger(t: Trigger) -> ApiResult<Trigger> {
    Ok(match t {
        Trigger::Interval { every_minutes } if !(MIN_INTERVAL_MINUTES..=MAX_INTERVAL_MINUTES).contains(&every_minutes) => {
            return Err(bad(format!("every_minutes must be from {MIN_INTERVAL_MINUTES} to {MAX_INTERVAL_MINUTES} (31 days)")));
        }
        Trigger::Interval { every_minutes } => Trigger::Interval { every_minutes },
        Trigger::Daily { time, weekdays } => {
            let at = parse_daily_time(&time).ok_or_else(|| bad("time must be a time of day like 09:30"))?;
            let mut days = Vec::new();
            for d in &weekdays {
                let w = weekday(d).ok_or_else(|| bad(format!("weekdays must be from {WEEKDAYS:?}")))?;
                days.push(w.num_days_from_monday());
            }
            days.sort();
            days.dedup();
            let weekdays = if days.len() == 7 { vec![] } else { days.into_iter().map(|d| WEEKDAYS[d as usize].to_string()).collect() };
            Trigger::Daily { time: at.format("%H:%M").to_string(), weekdays }
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

/// An action as it's stored: checked against the automation's project, so it can only make tasks
/// there, with its agent configs, and only message its tasks.
pub fn check_action(c: &Connection, project: &db::Project, a: Action) -> ApiResult<Action> {
    let blank = |v: Option<String>| v.map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
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
        Trigger::Webhook { .. } => None,
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
