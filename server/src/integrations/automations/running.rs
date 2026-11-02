//! Running an automation: its action, receiving a webhook delivery, and the scheduler that claims
//! due runs and coalesced batches.

use super::*;

/// What a run says it did, for the description of the task it creates or the message it sends.
fn how(source: &str, event: Option<&str>) -> String {
    match (source, event) {
        ("schedule", _) => "on its schedule".into(),
        ("webhook", Some(e)) => format!("from a webhook delivery ({e})"),
        ("webhook", None) => "from a webhook delivery".into(),
        (_, Some(e)) => format!("from a test delivery ({e}) on the board"),
        _ => "by hand, from the board".into(),
    }
}

/// Does what the automation does, for run `run_id`, and records how it went.
pub(super) async fn run_action(s: &Shared, a: &Automation, run_id: &str, source: &str, delivery: Option<&Delivery>, count: i64) -> Option<Run> {
    let vars = Vars { automation: a, source, delivery, count, now: Utc::now() };
    let event = delivery.and_then(Delivery::event_label);
    let result = act(s, a, &vars, event.as_deref());
    if let Err((_, e)) = &result {
        tracing::warn!(automation = %a.id, "automation \"{}\" failed: {e}", a.name);
    }
    let run = {
        let c = s.db();
        if let Err(e) = finish(&c, run_id, &result) {
            tracing::error!(automation = %a.id, "recording an automation's run: {e}");
        }
        let _ = c.execute("UPDATE automations SET last_run_at=?2 WHERE id=?1", params![a.id, crate::util::now()]);
        get_run(&c, run_id).ok().flatten()
    };
    changed(s, a);
    run
}

/// The task the automation's action made or messaged, or why it couldn't (with the task, if it
/// made one but couldn't start it).
fn act(s: &Shared, a: &Automation, vars: &Vars, event: Option<&str>) -> Result<Option<String>, (Option<String>, String)> {
    let fail = |e: ApiError| (None, e.1);
    let project = db::get_project(&s.db(), &a.project_id).map_err(|e| (None, format!("{e:#}")))?.ok_or((None, "the project is gone".to_string()))?;
    if project.archived_at.is_some() {
        return Err((None, "the project is archived".into()));
    }
    let how = how(vars.source, event);
    match &a.action {
        Action::CreateTask { title, description, task_type, labels, claude_config_id, model, effort, status, start } => {
            let (title, title_untrusted) = render(title, vars, Out::Title);
            let title = if title.is_empty() { format!("{} ({})", a.name, vars.now.with_timezone(&Local).format("%Y-%m-%d %H:%M")) } else { title };
            let (body, body_untrusted) = render(description, vars, Out::Text);
            let mut text = String::new();
            if title_untrusted || body_untrusted {
                text.push_str(&untrusted_note(&a.name, title_untrusted));
            }
            if !body.trim().is_empty() {
                text.push_str(body.trim_end());
                text.push_str("\n\n");
            }
            text.push_str(&format!("*Created by the automation \"{}\" {how}.*", a.name));
            let task = CreateTask {
                title,
                description: text,
                status: Some(status.clone()),
                task_type: task_type.clone(),
                labels: Some(json!(labels)),
                claude_config_id: claude_config_id.clone(),
                model: model.clone(),
                effort: effort.clone(),
                ..Default::default()
            };
            let t = api::create_task_inner(s, &project.id, task).map_err(fail)?;
            if *start {
                crate::agent::runner::send(s, &t.id, "").map_err(|e| (Some(t.id.clone()), format!("created the task, but couldn't start its agent: {}", e.1)))?;
            }
            Ok(Some(t.id))
        }
        Action::SendToTask { task_id, message } => {
            let t = target_task(&s.db(), &project, task_id).map_err(fail)?;
            let (body, untrusted) = render(message, vars, Out::Text);
            let note = if untrusted { untrusted_note(&a.name, false) } else { String::new() };
            let text = format!("From the automation \"{}\", {how}:\n\n{note}{}", a.name, body.trim());
            crate::agent::runner::send_from_agent(s, &t.id, &text).map_err(|e| (Some(t.id.clone()), e.1))?;
            Ok(Some(t.id))
        }
    }
}

/// A delivery to `a`: `Some(raw body, signature header)` for one from outside, which is checked
/// and deduplicated, None for a test delivery from the board. Returns its run (or why it didn't
/// run), or an error: a 429 when too many coalesced runs are waiting (recorded as skipped).
pub(super) async fn receive(s: &Shared, a: &Automation, delivery: Delivery, raw: Option<(&[u8], Option<&str>)>) -> ApiResult<Run> {
    let now = Utc::now();
    let source = if raw.is_some() { "webhook" } else { "manual" };
    let Trigger::Webhook { filters, coalesce_seconds, coalesce_key } = &a.trigger else {
        return Err(bad("not a webhook"));
    };
    let mut run = Run::new(&a.id, source, "running", now);
    run.delivery_id = delivery.delivery_id();
    run.event = delivery.event_label();
    let record = |run: Run| -> ApiResult<Run> {
        let mut run = run;
        if run.status != "running" && run.status != "pending" {
            run.finished_at = Some(fmt(now));
        }
        insert_run(&s.db(), &run)?;
        changed(s, a);
        Ok(run)
    };
    if let Some((body, signature)) = raw {
        if let Some(secret) = a.secret.as_deref().filter(|s| !s.is_empty())
            && !signed(secret, body, signature)
        {
            let why = if signature.is_some() { "its X-Hub-Signature-256 doesn't match the secret" } else { "it isn't signed (no X-Hub-Signature-256)" };
            return record(Run { status: "rejected".into(), ..run }.with_detail(format!("Rejected: {why}")));
        }
        // A signed delivery without an id is known by its body, so one that's been captured can't
        // be sent again with its id header taken out (which only the secret's holder could change).
        if a.secret.as_deref().is_some_and(|s| !s.is_empty()) && run.delivery_id.is_none() {
            run.delivery_id = Some(body_id(body));
        }
        if !a.enabled {
            return record(Run { status: "skipped".into(), ..run }.with_detail("Skipped: the automation is off"));
        }
    }
    if delivery.event() == Some("ping") && !filters.iter().any(takes_ping) {
        return record(Run { status: "filtered".into(), ..run }.with_detail("Ignored: GitHub's ping, sent when a webhook is added (a filter on event equal to ping takes it)"));
    }
    let vars = Vars { automation: a, source, delivery: Some(&delivery), count: 1, now };
    if let Some(why) = failed_filter(filters, &vars) {
        return record(Run { status: "filtered".into(), ..run }.with_detail(why));
    }
    let payload = serde_json::to_string(&delivery).ok();
    let coalesce = raw.is_some() && *coalesce_seconds > 0;
    {
        // One lock for the checks and the record, so two deliveries at once can't both pass them.
        let c = s.db();
        let cutoff = fmt(now - chrono::TimeDelta::days(DEDUPE_DAYS));
        if raw.is_some()
            && let Some(id) = &run.delivery_id
        {
            let seen: Option<String> = c
                .query_row(
                    "SELECT id FROM automation_runs WHERE automation_id=?1 AND delivery_id=?2 AND created_at >= ?3
                       AND status IN ('pending','coalesced','running','ok') ORDER BY created_at LIMIT 1",
                    params![a.id, id, cutoff],
                    |r| r.get(0),
                )
                .optional()?;
            if seen.is_some() {
                drop(c);
                let why = if id.starts_with("body-sha256:") {
                    "Dropped: this delivery came before (it has no delivery id header, so it's known by its signed body)"
                } else {
                    "Dropped: this delivery came before"
                };
                return record(Run { status: "duplicate".into(), batch_id: seen, ..run }.with_detail(why));
            }
        }
        if coalesce {
            let key = render(coalesce_key, &vars, Out::Title).0;
            let batch: Option<String> = c
                .query_row(
                    "SELECT id FROM automation_runs WHERE automation_id=?1 AND status='pending' AND COALESCE(batch_key,'')=?2 LIMIT 1",
                    params![a.id, key],
                    |r| r.get(0),
                )
                .optional()?;
            let mut run = run;
            run.batch_key = Some(key);
            match batch {
                Some(batch) => {
                    // The batch runs with the latest delivery's values.
                    c.execute("UPDATE automation_runs SET count=count+1, payload=?2, delivery_id=COALESCE(delivery_id,?3), event=?4 WHERE id=?1", params![
                        batch,
                        payload,
                        run.delivery_id,
                        run.event
                    ])?;
                    let run = Run { status: "coalesced".into(), batch_id: Some(batch), finished_at: Some(fmt(now)), ..run };
                    insert_run(&c, &run)?;
                    drop(c);
                    changed(s, a);
                    return Ok(run);
                }
                None => {
                    let waiting: i64 = c.query_row("SELECT COUNT(*) FROM automation_runs WHERE automation_id=?1 AND status='pending'", [&a.id], |r| r.get(0))?;
                    if waiting >= MAX_PENDING {
                        let why = format!("{MAX_PENDING} coalesced runs are waiting already");
                        let run = Run { status: "skipped".into(), finished_at: Some(fmt(now)), ..run }.with_detail(format!("Turned away: {why}"));
                        insert_run(&c, &run)?;
                        drop(c);
                        changed(s, a);
                        return Err(ApiError(StatusCode::TOO_MANY_REQUESTS, why));
                    }
                    let run = Run {
                        status: "pending".into(),
                        payload,
                        due_at: Some(fmt(now + chrono::TimeDelta::seconds(*coalesce_seconds as i64))),
                        ..run
                    };
                    insert_run(&c, &run)?;
                    drop(c);
                    changed(s, a);
                    return Ok(run);
                }
            }
        }
        run.payload = payload;
        insert_run(&c, &run)?;
    }
    changed(s, a);
    Ok(run_action(s, a, &run.id, source, Some(&delivery), 1).await.unwrap_or(run))
}

/// `POST /api/hooks/{id}/{token}`: a webhook delivery. It doesn't take the board's token: the
/// token in the path is the automation's own, and reaches only it.
pub async fn webhook(State(s): State<Shared>, Path((id, token)): Path<(String, String)>, uri: Uri, headers: HeaderMap, body: Bytes) -> Response {
    let not_found = || (StatusCode::NOT_FOUND, Json(json!({"error": "no such webhook"}))).into_response();
    let a = match get(&s.db(), &id) {
        Ok(Some(a)) => a,
        Ok(None) => return not_found(),
        Err(e) => return ApiError::from(e).into_response(),
    };
    if !a.is_webhook() || !same_secret(&a.token, &token) {
        return not_found();
    }
    let signature = headers.get("x-hub-signature-256").and_then(|v| v.to_str().ok());
    // Counted after the signature check, so that anyone with the URL can't use up the minute's
    // deliveries with unsigned ones. Those have a limit of their own, past which they aren't recorded.
    let genuine = a.secret.as_deref().filter(|s| !s.is_empty()).is_none_or(|secret| signed(secret, &body, signature));
    if !allow_delivery(&if genuine { a.id.clone() } else { format!("{}:unsigned", a.id) }) {
        return (StatusCode::TOO_MANY_REQUESTS, Json(json!({"error": format!("too many deliveries: at most {RATE_PER_MINUTE} a minute")}))).into_response();
    }
    let delivery = Delivery::parse(&headers, uri.query(), &body);
    match receive(&s, &a, delivery, Some((&body, signature))).await {
        Ok(run) => {
            let status = match run.status.as_str() {
                "rejected" => StatusCode::UNAUTHORIZED,
                "skipped" => StatusCode::CONFLICT,
                "failed" => StatusCode::INTERNAL_SERVER_ERROR,
                "duplicate" => StatusCode::OK,
                _ => StatusCode::ACCEPTED,
            };
            // The sender sees why a delivery was turned away, but not what went wrong inside or which task it made.
            let detail = if run.status == "failed" { Some("the automation's action failed: see its deliveries on the board".into()) } else { run.detail };
            (status, Json(json!({"run": run.id, "status": run.status, "detail": detail}))).into_response()
        }
        Err(e) if e.0.is_server_error() => {
            tracing::warn!("webhook delivery to automation {}: {}", a.id, e.1);
            (e.0, Json(json!({"error": "the delivery couldn't be taken"}))).into_response()
        }
        Err(e) => e.into_response(),
    }
}

/// Claims the schedules due at `now` (moving each one's next run on, and recording the run, so a
/// restart can't run it again) and returns those to run.
fn claim_due<Tz: TimeZone>(s: &Shared, now: DateTime<Utc>, tz: &Tz) -> anyhow::Result<Vec<(Automation, Run)>> {
    let c = s.db();
    let mut st = c.prepare(
        "SELECT a.*, p.archived_at IS NOT NULL AS archived FROM automations a JOIN projects p ON p.id=a.project_id
         WHERE a.enabled=1 AND a.next_run_at IS NOT NULL",
    )?;
    let due: Vec<(Automation, bool)> = st.query_map([], |r| Ok((Automation::from_row(r)?, r.get("archived")?)))?.filter_map(Result::ok).collect();
    drop(st);
    let mut out = Vec::new();
    for (a, archived) in due {
        let Some(due_at) = a.next_run_at.as_deref().and_then(parse_time) else { continue };
        if due_at > now {
            continue;
        }
        let (run, next) = match &a.trigger {
            // An interval keeps its rhythm, unless it's missed one: then it runs once, and goes on from now.
            Trigger::Interval { every_minutes } => {
                let next = due_at + chrono::TimeDelta::minutes(*every_minutes as i64);
                (true, Some(if next > now { next } else { now + chrono::TimeDelta::minutes(*every_minutes as i64) }))
            }
            Trigger::Daily { .. } => (now - due_at <= LATE_GRACE, next_after(&a.trigger, now, tz)),
            Trigger::Webhook { .. } => (false, None),
        };
        let tx = c.unchecked_transaction()?;
        let claimed = tx.execute(
            "UPDATE automations SET next_run_at=?3 WHERE id=?1 AND next_run_at=?2 AND enabled=1",
            params![a.id, a.next_run_at, next.map(fmt)],
        )?;
        if claimed == 0 {
            continue;
        }
        // An archived project's schedules go on without running (or filling its history) until it's unarchived.
        if a.is_webhook() || archived {
            tx.commit()?;
            continue;
        }
        let mut r = Run::new(&a.id, "schedule", if run { "running" } else { "skipped" }, now);
        r.due_at = a.next_run_at.clone();
        if !run {
            let at = due_at.with_timezone(&Local).format("%Y-%m-%d %H:%M");
            r = r.with_detail(format!(
                "Missed: it was due at {at}, when the server wasn't running (or the host was asleep). Runs more than 10 minutes late are skipped."
            ));
            r.finished_at = Some(fmt(now));
        }
        insert_run(&tx, &r)?;
        tx.commit()?;
        if run {
            out.push((a, r));
        } else {
            changed(s, &a);
        }
    }
    Ok(out)
}

/// Claims the coalesced runs whose window has closed.
fn claim_batches(s: &Shared, now: DateTime<Utc>) -> anyhow::Result<Vec<(Automation, Run)>> {
    let c = s.db();
    let mut st = c.prepare("SELECT * FROM automation_runs WHERE status='pending' AND due_at <= ?1")?;
    let due: Vec<Run> = st.query_map([fmt(now)], Run::from_row)?.filter_map(Result::ok).collect();
    drop(st);
    let mut out = Vec::new();
    for r in due {
        let a = get(&c, &r.automation_id)?;
        let (status, detail) = match &a {
            Some(a) if a.enabled && a.is_webhook() => ("running", None),
            _ => ("skipped", Some("Skipped: the automation was turned off (or isn't a webhook any more) before it ran")),
        };
        let claimed = c.execute(
            "UPDATE automation_runs SET status=?2, detail=?3, finished_at=CASE WHEN ?2='skipped' THEN ?4 END WHERE id=?1 AND status='pending'",
            params![r.id, status, detail, fmt(now)],
        )?;
        match a {
            Some(a) if claimed == 1 && status == "running" => out.push((a, r)),
            Some(a) => changed(s, &a),
            None => {}
        }
    }
    Ok(out)
}

/// Runs what's due at `now`: schedules, and coalesced deliveries whose window has closed.
pub async fn tick(s: &Shared, now: DateTime<Utc>) {
    tick_in(s, now, &Local).await
}

pub(super) async fn tick_in<Tz: TimeZone>(s: &Shared, now: DateTime<Utc>, tz: &Tz) {
    match claim_due(s, now, tz) {
        Ok(due) => {
            for (a, r) in due {
                run_action(s, &a, &r.id, "schedule", None, 1).await;
            }
        }
        Err(e) => tracing::error!("checking automations' schedules: {e:#}"),
    }
    match claim_batches(s, now) {
        Ok(due) => {
            for (a, r) in due {
                let delivery: Option<Delivery> = r.payload.as_deref().and_then(|p| serde_json::from_str(p).ok());
                run_action(s, &a, &r.id, "webhook", delivery.as_ref(), r.count).await;
            }
        }
        Err(e) => tracing::error!("checking automations' coalesced deliveries: {e:#}"),
    }
}

/// Starts the scheduler, once runs left over from before a restart are marked as interrupted.
pub fn start(s: &Shared) {
    match mark_interrupted(&s.db()) {
        Ok(0) => {}
        Ok(n) => tracing::warn!("{n} automation run(s) were interrupted by the restart; they aren't run again"),
        Err(e) => tracing::error!("checking for interrupted automation runs: {e}"),
    }
    let s = s.clone();
    tokio::spawn(async move {
        let mut pruned: Option<Instant> = None;
        loop {
            tick(&s, Utc::now()).await;
            if pruned.is_none_or(|p| p.elapsed() > Duration::from_secs(3600)) {
                if let Err(e) = prune(&s.db(), Utc::now()) {
                    tracing::error!("pruning automation runs: {e}");
                }
                pruned = Some(Instant::now());
            }
            tokio::time::sleep(TICK).await;
        }
    });
}
