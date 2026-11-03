//! The API: an automation's JSON, and its routes' handlers.

use super::*;

/// An automation as the API shows it: its webhook path, and whether it has a secret (never the
/// secret itself), and its latest run.
pub fn to_json(c: &Connection, a: &Automation) -> Value {
    let mut v = json!({
        "id": a.id,
        "profile_id": a.profile_id,
        "project_id": a.project_id,
        "name": a.name,
        "enabled": a.enabled,
        "trigger": a.trigger,
        "action": a.action,
        "active_hours": a.active_hours,
        "precheck": a.precheck,
        "budget_usd": a.budget_usd,
        "next_run_at": a.next_run_at,
        "last_run_at": a.last_run_at,
        "created_at": a.created_at,
        "updated_at": a.updated_at,
    });
    // What its runs cost (those kept), and today in the host's time zone, against its budget.
    v["cost_usd"] = json!(routines::spent(c, &a.id).unwrap_or(0.0));
    v["cost_today_usd"] = json!(routines::spent_today(c, &a.id, Utc::now(), &Local).unwrap_or(0.0));
    if a.is_webhook() {
        v["hook_path"] = json!(a.hook_path());
        v["has_secret"] = json!(a.secret.as_deref().is_some_and(|s| !s.is_empty()));
    }
    v["last_run"] = runs(c, &a.id, 1).ok().and_then(|r| r.into_iter().next()).map(|r| run_json(c, &r)).unwrap_or(Value::Null);
    v
}

/// A run, with the key and title of its task.
pub fn run_json(c: &Connection, r: &Run) -> Value {
    let mut v = json!(r);
    if let Some(t) = r.task_id.as_deref().and_then(|id| db::get_task(c, id).ok().flatten()) {
        let project = t.project_id.as_deref().and_then(|p| db::get_project(c, p).ok().flatten());
        let key = crate::agent::runner::key_prefix(&t, project.as_ref());
        v["task"] = json!({"key": format!("{key}-{}", t.number), "title": t.title, "status": t.status, "running": t.running});
        // A routine thread's cost so far, while it works.
        if r.cost_usd.is_none() && t.is_routine() {
            v["cost_usd"] = json!(t.cost_usd);
        }
    }
    // The agent run that took its message in, while it works (see routines::agent_run_ended).
    if r.cost_usd.is_none() && v["cost_usd"].is_null() {
        let so_far: Option<f64> = c
            .query_row(
                "SELECT x.cost_usd / (SELECT COUNT(*) FROM automation_runs y WHERE y.agent_run_id = x.id) FROM automation_runs r JOIN runs x ON x.id = r.agent_run_id
                 WHERE r.id = ?1",
                [&r.id],
                |r| r.get(0),
            )
            .optional()
            .ok()
            .flatten();
        if let Some(cost) = so_far {
            v["cost_usd"] = json!(cost);
        }
    }
    v
}

fn project(c: &Connection, id: &str) -> ApiResult<db::Project> {
    db::get_project(c, id)?.ok_or_else(|| ApiError::not_found("project"))
}

pub fn automation(c: &Connection, id: &str) -> ApiResult<Automation> {
    get(c, id)?.ok_or_else(|| ApiError::not_found("automation"))
}

pub fn check_name(v: &Value) -> ApiResult<String> {
    match v.as_str().map(str::trim) {
        Some(n) if !n.is_empty() && n.chars().count() <= 100 => Ok(n.to_string()),
        _ => Err(bad("name must be 1 to 100 characters")),
    }
}

fn check_secret(v: &Value) -> ApiResult<Option<String>> {
    match v {
        Value::Null => Ok(None),
        Value::String(s) if s.is_empty() => Ok(None),
        // GitHub signs with the secret as it's given, so one trimmed here would never match.
        Value::String(s) if s.trim() != s => Err(bad("secret can't start or end with spaces or line breaks")),
        Value::String(s) if s.len() <= 200 => Ok(Some(s.clone())),
        _ => Err(bad("secret must be a string of up to 200 characters")),
    }
}

pub fn parse<T: serde::de::DeserializeOwned>(what: &str, v: &Value) -> ApiResult<T> {
    serde_json::from_value(v.clone()).map_err(|e| bad(format!("{what}: {e}")))
}

/// `GET /projects/{id}/automations`: the project's automations, and the host's time zone their
/// times of day are in.
pub async fn list_handler(State(s): State<Shared>, Path(project_id): Path<String>) -> ApiResult<Json<Value>> {
    let c = s.db();
    project(&c, &project_id)?;
    let list: Vec<Value> = list(&c, &project_id)?.iter().map(|a| to_json(&c, a)).collect();
    Ok(Json(json!({"automations": list, "time_zone": time_zone()})))
}

/// `GET /profiles/{id}/automations`: the profile's routines, and the host's time zone their times are in.
pub async fn list_routines_handler(State(s): State<Shared>, Path(profile_id): Path<String>) -> ApiResult<Json<Value>> {
    let c = s.db();
    db::get_profile(&c, &profile_id)?.ok_or_else(|| ApiError::not_found("profile"))?;
    let list: Vec<Value> = list_routines(&c, &profile_id)?.iter().map(|a| to_json(&c, a)).collect();
    Ok(Json(json!({"automations": list, "time_zone": time_zone()})))
}

/// `POST /projects/{id}/automations`: `{name, trigger, action, enabled?, secret?, active_hours?, precheck?, budget_usd?}`.
pub async fn create_handler(State(s): State<Shared>, Path(project_id): Path<String>, Json(b): Json<Map<String, Value>>) -> ApiResult<Json<Value>> {
    let a = create(&s, &project_id, &b)?;
    Ok(Json(to_json(&s.db(), &a)))
}

/// `POST /profiles/{id}/automations`: a routine, as `create_handler` takes, whose action is `message_assistant`.
pub async fn create_routine_handler(State(s): State<Shared>, Path(profile_id): Path<String>, Json(b): Json<Map<String, Value>>) -> ApiResult<Json<Value>> {
    let a = create_routine(&s, &profile_id, &b)?;
    Ok(Json(to_json(&s.db(), &a)))
}

pub fn create(s: &Shared, project_id: &str, b: &Map<String, Value>) -> ApiResult<Automation> {
    let p = project(&s.db(), project_id)?;
    create_in(s, Owner::Project(p), b)
}

/// Adds a routine to a profile.
pub fn create_routine(s: &Shared, profile_id: &str, b: &Map<String, Value>) -> ApiResult<Automation> {
    db::get_profile(&s.db(), profile_id)?.ok_or_else(|| ApiError::not_found("profile"))?;
    create_in(s, Owner::Profile(profile_id.to_string()), b)
}

/// When a schedule that's on and has just been set (or turned on) first runs: an `at` that's
/// passed can't be.
fn first_run(trigger: &Trigger, active: Option<&ActiveHours>, now: DateTime<Utc>) -> ApiResult<Option<String>> {
    let next = next_run(trigger, active, now, &Local);
    if next.is_none() && matches!(trigger, Trigger::At { .. }) {
        return Err(bad("its time (at) has passed: give it one to come"));
    }
    Ok(next.map(fmt))
}

fn create_in(s: &Shared, owner: Owner, b: &Map<String, Value>) -> ApiResult<Automation> {
    let now = Utc::now();
    let null = Value::Null;
    let a = {
        let c = s.db();
        let name = check_name(&b.get("name").cloned().unwrap_or_default())?;
        let trigger = check_trigger(parse("trigger", b.get("trigger").unwrap_or(&null))?)?;
        let action = check_action(&c, &owner, parse("action", b.get("action").unwrap_or(&null))?)?;
        let enabled = b.get("enabled").and_then(Value::as_bool).unwrap_or(true);
        let secret = check_secret(b.get("secret").unwrap_or(&null))?;
        let active = check_active_hours(b.get("active_hours").unwrap_or(&null))?;
        let precheck = check_precheck(b.get("precheck").unwrap_or(&null))?;
        let budget = check_budget(b.get("budget_usd").unwrap_or(&null))?;
        let next = if enabled { first_run(&trigger, active.as_ref(), now)? } else { None };
        let id = new_id();
        c.execute(
            "INSERT INTO automations (id,profile_id,project_id,name,enabled,trigger,action,token,secret,next_run_at,active_hours,precheck,budget_usd,created_at,updated_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?14)",
            params![
                id,
                owner.profile_id(),
                owner.project_id(),
                name,
                enabled,
                json!(trigger).to_string(),
                json!(action).to_string(),
                new_token(),
                secret,
                next,
                active.map(|h| json!(h).to_string()),
                precheck,
                budget,
                fmt(now)
            ],
        )?;
        automation(&c, &id)?
    };
    changed(s, &a);
    Ok(a)
}

pub async fn get_handler(State(s): State<Shared>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let c = s.db();
    let a = automation(&c, &id)?;
    Ok(Json(to_json(&c, &a)))
}

/// `PATCH /automations/{id}`: any of `name`, `enabled`, `trigger`, `action`, `secret` (blank
/// clears it), `rotate_token` (a new webhook URL; the old one stops working), `active_hours`,
/// `precheck` and `budget_usd` (null clears them).
pub async fn update_handler(State(s): State<Shared>, Path(id): Path<String>, Json(b): Json<Map<String, Value>>) -> ApiResult<Json<Value>> {
    let a = update(&s, &id, &b)?;
    Ok(Json(to_json(&s.db(), &a)))
}

pub fn update(s: &Shared, id: &str, b: &Map<String, Value>) -> ApiResult<Automation> {
    let now = Utc::now();
    let a = {
        let c = s.db();
        let a = automation(&c, id)?;
        let owner = owner(&c, &a)?;
        let name = match b.get("name") {
            Some(v) => check_name(v)?,
            None => a.name.clone(),
        };
        let trigger = match b.get("trigger") {
            Some(v) => check_trigger(parse("trigger", v)?)?,
            None => a.trigger.clone(),
        };
        let action = match b.get("action") {
            Some(v) => check_action(&c, &owner, parse("action", v)?)?,
            None => a.action.clone(),
        };
        let enabled = match b.get("enabled") {
            Some(v) => v.as_bool().ok_or_else(|| bad("enabled must be true or false"))?,
            None => a.enabled,
        };
        let secret = match b.get("secret") {
            Some(v) => check_secret(v)?,
            None => a.secret.clone(),
        };
        let token = if b.get("rotate_token").and_then(Value::as_bool) == Some(true) { new_token() } else { a.token.clone() };
        let active = match b.get("active_hours") {
            Some(v) => check_active_hours(v)?,
            None => a.active_hours.clone(),
        };
        let precheck = match b.get("precheck") {
            Some(v) => check_precheck(v)?,
            None => a.precheck.clone(),
        };
        let budget = match b.get("budget_usd") {
            Some(v) => check_budget(v)?,
            None => a.budget_usd,
        };
        // A schedule starts over from now when it's turned on or changed; it doesn't run while it's off.
        let next = match (enabled, enabled != a.enabled || trigger != a.trigger || active != a.active_hours) {
            (false, _) => None,
            (true, true) => first_run(&trigger, active.as_ref(), now)?,
            (true, false) => a.next_run_at.clone(),
        };
        c.execute(
            "UPDATE automations SET name=?2, enabled=?3, trigger=?4, action=?5, secret=?6, token=?7, next_run_at=?8, active_hours=?9, precheck=?10, budget_usd=?11,
               updated_at=?12 WHERE id=?1",
            params![
                a.id,
                name,
                enabled,
                json!(trigger).to_string(),
                json!(action).to_string(),
                secret,
                token,
                next,
                active.map(|h| json!(h).to_string()),
                precheck,
                budget,
                fmt(now)
            ],
        )?;
        automation(&c, id)?
    };
    changed(s, &a);
    Ok(a)
}

pub async fn delete_handler(State(s): State<Shared>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    delete(&s, &id)?;
    Ok(Json(json!({"ok": true})))
}

pub fn delete(s: &Shared, id: &str) -> ApiResult<Automation> {
    let a = automation(&s.db(), id)?;
    s.db().execute("DELETE FROM automations WHERE id=?1", [id])?;
    // Agents waiting to change or delete it are told it's gone.
    crate::mcp::permissions::expire_for_automation(s, id);
    changed(s, &a);
    Ok(a)
}

#[derive(Deserialize, Default)]
pub struct RunNow {
    /// For a webhook: the test delivery's body (else the latest delivery's, or `{}`).
    #[serde(default)]
    pub payload: Option<Value>,
    /// For a webhook: its event (`X-GitHub-Event`), e.g. `issues`.
    #[serde(default)]
    pub event: Option<String>,
}

/// `POST /automations/{id}/run`: runs it now, whether or not it's on. A webhook's runs a test
/// delivery through its filters (not its signature check, deduplication or coalescing).
pub async fn run_handler(State(s): State<Shared>, Path(id): Path<String>, body: Option<Json<RunNow>>) -> ApiResult<Json<Value>> {
    let a = automation(&s.db(), &id)?;
    let run = run_now(&s, &a, body.map(|Json(b)| b).unwrap_or_default()).await?;
    Ok(Json(run_json(&s.db(), &run)))
}

/// Runs `a` now (see run_handler).
pub async fn run_now(s: &Shared, a: &Automation, b: RunNow) -> ApiResult<Run> {
    Ok(if a.is_webhook() {
        let latest = latest_delivery(&s.db(), &a.id)?;
        let mut delivery = match b.payload {
            Some(body) => Delivery { body, ..Default::default() },
            None => latest.unwrap_or_else(|| Delivery { body: json!({}), ..Default::default() }),
        };
        if let Some(e) = b.event.as_deref().map(str::trim).filter(|e| !e.is_empty()) {
            delivery.headers.insert("x-github-event".into(), json!(e));
        }
        // The same delivery id would be a duplicate of the real one.
        for h in ["x-github-delivery", "x-delivery-id", "idempotency-key"] {
            delivery.headers.remove(h);
        }
        receive(s, a, delivery, None).await?
    } else {
        let r = Run::new(&a.id, "manual", "running", Utc::now());
        insert_run(&s.db(), &r)?;
        run_action_detached(s, a, &r.id, "manual", None, 1).await.unwrap_or(r)
    })
}

/// The latest delivery kept, for the next test delivery.
fn latest_delivery(c: &Connection, automation_id: &str) -> rusqlite::Result<Option<Delivery>> {
    let p: Option<String> = c
        .query_row(
            "SELECT payload FROM automation_runs WHERE automation_id=?1 AND payload IS NOT NULL ORDER BY created_at DESC, rowid DESC LIMIT 1",
            [automation_id],
            |r| r.get(0),
        )
        .optional()?;
    Ok(p.and_then(|p| serde_json::from_str(&p).ok()))
}

/// `GET /automations/{id}/runs`: its latest runs and deliveries, newest first, and the latest
/// delivery's body and event (to start a test delivery from).
pub async fn runs_handler(State(s): State<Shared>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let c = s.db();
    let a = automation(&c, &id)?;
    let list: Vec<Value> = runs(&c, &a.id, KEEP_RECENT)?.iter().map(|r| run_json(&c, r)).collect();
    let latest = latest_delivery(&c, &a.id)?.map(|d| json!({"body": d.body, "event": d.event()}));
    Ok(Json(json!({"runs": list, "latest_delivery": latest})))
}
