//! What the task tools return (a task's details, fields and summary) and some of what they take
//! (marks, reminders).

use super::*;

/// The fields offered to agents, shared by the overview and paginated reads. Do not serialize
/// the database Task here: it includes fields the tools don't expose (including private links).
pub(super) fn task_details(s: &Shared, ctx: &Ctx, t: &Task) -> ToolResult {
    let mut out = summarize(s, t);
    out["description"] = json!(t.description);
    out["worktree_path"] = json!(t.worktree_path);
    out["last_message"] = json!(db::last_assistant_text(&s.db(), &t.id)?);
    // A task can create tasks on boards the caller cannot use (or no longer can use).
    let readable = boards(s, ctx)?;
    let created: Vec<Task> = db::created_tasks(&s.db(), &t.id)?.into_iter().filter(|c| readable.iter().any(|b| b.id == c.profile_id)).collect();
    if !created.is_empty() {
        out["created_tasks"] = json!(created.iter().map(|c| summary(s, c)).collect::<Vec<_>>());
    }
    Ok(out)
}

/// Strings are read as plain text; everything else is read as pretty JSON, including null.
fn field_text(value: &Value) -> String {
    value.as_str().map(String::from).unwrap_or_else(|| serde_json::to_string_pretty(value).unwrap())
}

pub(super) fn task_overview(details: Value) -> Value {
    let mut out = Map::new();
    let mut lengths = Map::new();
    let mut omitted = Vec::new();
    // Bound both each value and the whole response, even if several metadata fields grow.
    // Count serialized bytes too: escapes and nested JSON can be much larger than plain text.
    let mut budget = 6000;
    for (name, value) in details.as_object().unwrap() {
        lengths.insert(name.clone(), json!(field_text(value).chars().count()));
        let size = serde_json::to_string_pretty(value).unwrap().len();
        if size <= 1000 && size <= budget {
            budget -= size;
            out.insert(name.clone(), value.clone());
        } else {
            omitted.push(name.clone());
        }
    }
    out.insert("field_lengths".into(), json!(lengths));
    out.insert("omitted_fields".into(), json!(omitted));
    Value::Object(out)
}

pub(super) fn task_field(details: &Value, args: &Value) -> ToolResult {
    let fields = details.as_object().unwrap();
    let field = args["field"].as_str().unwrap_or_default();
    let value = fields.get(field).ok_or_else(|| ToolError::Other(format!(
        "unknown task field {field:?}; available fields: {} (see get_task's field_lengths)", fields.keys().cloned().collect::<Vec<_>>().join(", ")
    )))?;
    let number = |name: &str, default: usize| -> std::result::Result<usize, ToolError> {
        match args.get(name) {
            None => Ok(default),
            Some(v) => v.as_u64().and_then(|n| usize::try_from(n).ok())
                .ok_or_else(|| ToolError::Other(format!("{name} must be a non-negative integer"))),
        }
    };
    let offset = number("offset", 0)?;
    let limit = number("limit", TASK_FIELD_DEFAULT_LIMIT)?;
    if limit == 0 || limit > TASK_FIELD_MAX_LIMIT {
        return Err(ToolError::Other(format!("limit must be between 1 and {TASK_FIELD_MAX_LIMIT}")));
    }
    let text = field_text(value);
    let total_length = text.chars().count();
    let content: String = text.chars().skip(offset).take(limit).collect();
    let length = content.chars().count();
    let next = offset.saturating_add(length);
    Ok(json!({
        "task_id": details["id"], "field": field, "format": if value.is_string() { "text" } else { "json" },
        "offset": offset, "limit": limit, "length": length, "total_length": total_length,
        "next_offset": (next < total_length).then_some(next), "content": content,
    }))
}

pub(super) fn summarize(s: &Shared, t: &Task) -> Value {
    let mut v = summary(s, t);
    if !t.depends_on.is_empty() {
        let key = project_key(s, t);
        let deps: Vec<Value> = t
            .depends_on
            .iter()
            .filter_map(|id| db::get_task(&s.db(), id).ok().flatten())
            // Only ever in its own project (and so on its board); anything else is left out.
            .filter(|d| d.project_id.is_some() && d.project_id == t.project_id)
            .map(|d| json!({"key": format!("{key}-{}", d.number), "title": d.title, "status": d.status, "merged": db::is_merged(&d)}))
            .collect();
        if !deps.is_empty() {
            v["depends_on"] = json!(deps);
        }
    }
    if t.waiting {
        v["queued_for_dependencies"] = json!(true);
    }
    if t.subproject {
        v["is_subproject"] = json!(true);
    }
    if let (None, Some(g)) = (&t.project_id, &t.group_name) {
        v["group_task"] = json!(g);
    }
    // Its labels, and where the plan, artifact or diagram each asks for is, for agents on this host to read.
    let documents = crate::documents::paths(s, t);
    if !documents.is_empty() {
        v["labels"] = json!(documents.iter().map(|(l, _)| l).collect::<Vec<_>>());
        v["documents"] = documents.iter().map(|(l, f)| (l.to_string(), json!(crate::util::path_str(f)))).collect::<serde_json::Map<_, _>>().into();
    }
    if t.is_scratch() {
        v["type"] = json!(db::SCRATCH);
    }
    if let Some(sp) = t.parent_id.as_deref().filter(|_| t.kind == "task").and_then(|id| db::get_task(&s.db(), id).ok().flatten()) {
        v["subproject"] = json!(format!("{}-{}", project_key(s, &sp), sp.number));
    }
    v
}

/// The star and reminder `create_task` gives the new task, checked in full before the task is
/// created (and its agent started), so a call that fails leaves no task behind for a retry to
/// duplicate.
pub(super) fn new_task_marks(args: &Value) -> std::result::Result<Vec<(&'static str, Value)>, ToolError> {
    let given = reminder_args(args)?;
    let mut marks: Vec<(&str, Value)> = api::MARK_FIELDS.iter().filter_map(|k| given.get(*k).map(|v| (*k, v.clone()))).collect();
    api::check_reminder(None, &mut marks)?;
    Ok(marks)
}

/// Task `t`, just made by `create_task`, with who made it and the star and reminder it was given.
pub(super) fn created(s: &Shared, ctx: &Ctx, mut t: Task, marks: &[(&str, Value)]) -> std::result::Result<Task, ToolError> {
    // Kept so a group task (or any task) can show how the tasks it created are doing.
    if let Some(own) = ctx.task.as_ref().filter(|own| own.kind == "task") {
        t = s.update_task(&t.id, &[("created_by", json!(own.id))])?.unwrap_or(t);
    }
    if !marks.is_empty() {
        t = s.update_task(&t.id, marks)?.unwrap_or(t);
    }
    Ok(t)
}

/// `starred`, `remind_at` and `reminder` from `create_task` or `update_task`, with the time made
/// absolute (see reminder_time). The API checks the rest.
pub(super) fn reminder_args(args: &Value) -> std::result::Result<Map<String, Value>, ToolError> {
    let mut body = Map::new();
    for k in ["starred", "reminder"] {
        if !args[k].is_null() {
            body.insert(k.into(), args[k].clone());
        }
    }
    match &args["remind_at"] {
        Value::Null => {}
        Value::String(at) => {
            let at = reminder_time(at, chrono::Utc::now()).ok_or_else(|| {
                ToolError::Other(
                    "remind_at must be a delay like 30m, 2h, 3d or 1w, a time like 2026-05-01T09:00:00Z (or 2026-05-01 09:00 in the host's time zone), \
                     or an empty string to clear the reminder"
                        .into(),
                )
            })?;
            body.insert("remind_at".into(), json!(at));
        }
        other => {
            body.insert("remind_at".into(), other.clone());
        }
    }
    Ok(body)
}

/// A reminder's time as RFC 3339, from what an agent passes: a delay from `now` (`30m`, `2h`,
/// `1d 12h`, `in 3 days`, `1w`), an RFC 3339 time, or a date and time (or just a date, at 9:00)
/// in the host's time zone. Blank clears the reminder. None if it's none of those.
pub(super) fn reminder_time(v: &str, now: chrono::DateTime<chrono::Utc>) -> Option<String> {
    use chrono::{Local, NaiveDate, NaiveDateTime, TimeDelta, TimeZone};
    let v = v.trim();
    if v.is_empty() {
        return Some(String::new());
    }
    if chrono::DateTime::parse_from_rfc3339(v).is_ok() {
        return Some(v.to_string());
    }
    let local = ["%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M"]
        .iter()
        .find_map(|f| NaiveDateTime::parse_from_str(v, f).ok())
        .or_else(|| NaiveDate::parse_from_str(v, "%Y-%m-%d").ok().and_then(|d| d.and_hms_opt(9, 0, 0)));
    if let Some(t) = local {
        return Local.from_local_datetime(&t).earliest().map(|t| t.with_timezone(&chrono::Utc).to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
    }
    // A delay: numbers each followed by a unit, e.g. "1h30m" or "in 2 days".
    let rest = v.strip_prefix("in ").unwrap_or(v).to_ascii_lowercase();
    let mut chars = rest.chars().filter(|c| !c.is_whitespace() && *c != ',').peekable();
    let mut total = TimeDelta::zero();
    let mut any = false;
    while chars.peek().is_some() {
        let n: String = std::iter::from_fn(|| chars.next_if(char::is_ascii_digit)).collect();
        let unit: String = std::iter::from_fn(|| chars.next_if(char::is_ascii_alphabetic)).collect();
        let n: i64 = n.parse().ok().filter(|n| *n <= 10_000)?;
        total += match unit.as_str() {
            "m" | "min" | "mins" | "minute" | "minutes" => TimeDelta::minutes(n),
            "h" | "hr" | "hrs" | "hour" | "hours" => TimeDelta::hours(n),
            "d" | "day" | "days" => TimeDelta::days(n),
            "w" | "wk" | "week" | "weeks" => TimeDelta::weeks(n),
            _ => return None,
        };
        any = true;
    }
    any.then(|| (now + total).to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
}

pub(super) fn summary(s: &Shared, t: &Task) -> Value {
    let profile = db::get_profile(&s.db(), &t.profile_id).ok().flatten().map(|p| p.name);
    let mut v = json!({
        "id": t.id,
        "key": format!("{}-{}", project_key(s, t), t.number),
        "title": t.title,
        "status": t.status,
        "resolution": t.resolution,
        "running": t.running,
        "attention_reason": t.attention_reason,
        "branch": t.branch,
        "preview_url": t.preview_url,
        "pr_url": t.pr_url,
        "review": t.review.as_ref().map(|r| json!({"state": r.state, "summary": r.summary, "issues": r.issues})),
        "project_id": t.project_id,
        "profile": profile,
        "host": s.host_name,
    });
    if !t.external_links.is_empty() {
        v["external_links"] = json!(t.external_links);
    }
    if t.starred {
        v["starred"] = json!(true);
    }
    if let Some(at) = &t.remind_at {
        v["remind_at"] = json!(at);
        v["reminder"] = json!(t.reminder);
    }
    v
}
