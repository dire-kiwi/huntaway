//! The automation tools: listing, creating, changing and running a project's automations, or
//! the agent's own profile's routines (see integrations/automations.rs).

use super::*;
use crate::integrations::automations::{self, Owner};

/// Whether a call is about the caller's profile's routines rather than a project's automations:
/// it says `routines`, or its action messages the assistant, or it names no project and comes from
/// the assistant (or one of its routine threads), which is in none.
pub(super) fn wants_routines(ctx: &Ctx, args: &Value) -> bool {
    args["routines"] == true
        || args["action"]["kind"] == "message_assistant"
        || (args["project_id"].as_str().is_none_or(str::is_empty) && ctx.task.as_ref().is_some_and(|t| t.is_assistants()))
}

/// The caller's own profile, whose routines it can see and change: other profiles' agents can't
/// reach them, as they can't its assistant.
pub(super) fn own_routines(s: &Shared, ctx: &Ctx, profile: Option<&str>) -> std::result::Result<Owner, ToolError> {
    let own = boards(s, ctx)?.into_iter().find(|b| ctx.is_own(b)).ok_or_else(|| ToolError::Other("routines are for an agent on its own profile's host".into()))?;
    if profile.is_some_and(|p| !p.eq_ignore_ascii_case(&own.name) && p != own.id) {
        return Err(ToolError::Other(format!("an agent can only use its own profile's routines ({})", own.name)));
    }
    Ok(Owner::Profile(own.id))
}

/// The automation an agent names in `automation_id`: its id, or its name in `project_id` (or
/// the agent's own project, or with `routines` its own profile's routines). Only one in a
/// project on a board the agent can use, or a routine of its own profile.
pub(super) fn resolve_automation(
    s: &Shared, ctx: &Ctx, args: &Value, profile: Option<&str>, own_project: Option<String>,
) -> std::result::Result<(automations::Automation, Owner), ToolError> {
    let r = args["automation_id"].as_str().map(str::trim).unwrap_or_default();
    let by_id = automations::get(&s.db(), r)?;
    if let Some(a) = by_id {
        if a.is_routine() {
            if ctx.profile_id.as_deref() == Some(a.profile_id.as_str()) {
                return Ok((a.clone(), Owner::Profile(a.profile_id)));
            }
            return Err(ToolError::NotFound(format!("automation {r}")));
        }
        let p = db::get_project(&s.db(), a.project_id.as_deref().unwrap_or_default())?;
        if let Some(p) = p.filter(|p| boards(s, ctx).is_ok_and(|b| b.iter().any(|b| b.id == p.profile_id))) {
            return Ok((a, Owner::Project(p)));
        }
        return Err(ToolError::NotFound(format!("automation {r}")));
    }
    if wants_routines(ctx, args) {
        let owner = own_routines(s, ctx, profile)?;
        let named: Vec<_> = automations::list_routines(&s.db(), owner.profile_id())?.into_iter().filter(|a| a.name.eq_ignore_ascii_case(r)).collect();
        return match named.len() {
            0 => Err(ToolError::NotFound(format!("routine {r} (use list_automations with routines=true)"))),
            1 => Ok((named.into_iter().next().unwrap(), owner)),
            _ => Err(ToolError::Other(format!("there are several routines named {r}; give its id (see list_automations)"))),
        };
    }
    let p = project_or_own(s, ctx, args["project_id"].as_str().filter(|p| !p.is_empty()).map(String::from), profile, own_project)?;
    let named: Vec<_> = automations::list(&s.db(), &p.id)?.into_iter().filter(|a| a.name.eq_ignore_ascii_case(r)).collect();
    match named.len() {
        0 => Err(ToolError::NotFound(format!("automation {r} in {} (use list_automations)", p.key))),
        1 => Ok((named.into_iter().next().unwrap(), Owner::Project(p))),
        _ => Err(ToolError::Other(format!("{} has several automations named {r}; give its id (see list_automations)", p.key))),
    }
}

pub(super) fn has_secret(a: &automations::Automation) -> bool {
    a.secret.as_deref().is_some_and(|s| !s.is_empty())
}

/// An automation as list_automations shows it, with its webhook's full URL when the host's
/// public_url is set.
pub(super) fn automation_json(s: &Shared, a: &automations::Automation) -> Value {
    let c = s.db();
    let mut v = automations::to_json(&c, a);
    if a.is_webhook() {
        match db::get_setting(&c, "public_url").ok().flatten().filter(|u| !u.is_empty()) {
            Some(url) => v["webhook_url"] = json!(format!("{url}{}", a.hook_path())),
            None => v["webhook_note"] = json!("hook_path is on this host; the full URL depends on how it's reached from outside (the host's public_url setting isn't set)"),
        }
    }
    v
}

/// What an automation runs under besides its trigger and action, as its approval shows them.
#[derive(Default, Clone, PartialEq)]
pub(super) struct Guards {
    pub active_hours: Option<automations::ActiveHours>,
    pub precheck: Option<String>,
    pub budget_usd: Option<f64>,
}

impl Guards {
    pub fn of(a: &automations::Automation) -> Self {
        Guards { active_hours: a.active_hours.clone(), precheck: a.precheck.clone(), budget_usd: a.budget_usd }
    }
}

/// An automation as its approval shows it: what it is, and the task its message goes to and
/// the agent config its tasks use, by name.
#[allow(clippy::too_many_arguments)]
pub(super) fn automation_view(
    s: &Shared, id: &str, name: &str, enabled: bool, trigger: &automations::Trigger, action: &automations::Action, signed: bool, guards: &Guards,
) -> Value {
    use automations::Action;
    let mut v = json!({"id": id, "name": name, "enabled": enabled, "trigger": trigger, "action": action, "signed": signed});
    if let Some(h) = &guards.active_hours {
        v["active_hours"] = json!(h);
    }
    if let Some(p) = &guards.precheck {
        v["precheck"] = json!(p);
    }
    if let Some(b) = guards.budget_usd {
        v["budget_usd"] = json!(b);
    }
    match action {
        Action::SendToTask { task_id, .. } => {
            let t = db::get_task(&s.db(), task_id).ok().flatten();
            if let Some(t) = t {
                v["target"] = json!({"id": t.id, "key": format!("{}-{}", project_key(s, &t), t.number), "title": t.title, "status": t.status});
            }
        }
        Action::CreateTask { claude_config_id: Some(id), .. } => {
            let c = db::get_claude_config(&s.db(), id).ok().flatten();
            if let Some(c) = c {
                v["config"] = json!({"id": c.id, "name": c.name, "agent": c.agent});
            }
        }
        Action::CreateTask { .. } | Action::MessageAssistant { .. } => {}
    }
    v
}

/// What an automation approval asks: `op` (create, update or delete) on `automation` (see
/// automation_view) in project `p` (or for a routine, of profile `p`), asked by the calling agent,
/// with the time zone its times of day are in.
pub(super) fn automation_input(s: &Shared, ctx: &Ctx, op: &str, owner: &Owner, automation: Value) -> Value {
    let time_zone = automations::time_zone();
    let mut v = json!({"op": op, "task": approval_task(s, ctx), "automation": automation, "time_zone": time_zone});
    match owner {
        Owner::Project(p) => v["project"] = approval_project(s, p),
        Owner::Profile(id) => {
            let name = db::get_profile(&s.db(), id).ok().flatten().map(|p| p.name).unwrap_or_default();
            v["profile"] = json!({"id": id, "name": name, "host": s.host_name});
        }
    }
    v
}

/// An automation's action as an agent gives it, checked against its owner: a message's task
/// can be named by key, and has to be one of the project's.
fn automation_action(s: &Shared, ctx: &Ctx, owner: &Owner, v: &Value, profile: Option<&str>) -> std::result::Result<automations::Action, ToolError> {
    use automations::{self as au, Action};
    let action = match (au::parse::<Action>("action", v)?, owner) {
        (Action::SendToTask { task_id, message }, Owner::Project(p)) => {
            let t = resolve_task(s, ctx, task_id.trim(), profile).map_err(|e| match e {
                ToolError::NotFound(_) => ToolError::Other(format!("task {task_id} not found in {}", p.key)),
                e => e,
            })?;
            Action::SendToTask { task_id: t.id, message }
        }
        (a, _) => a,
    };
    Ok(au::check_action(&s.db(), owner, action)?)
}

/// An automation's guards as an agent gives them, each kept as it was if left out.
fn automation_guards(args: &Value, was: &Guards) -> std::result::Result<Guards, ToolError> {
    use crate::integrations::automations as au;
    let given = |k: &str| args.as_object().is_some_and(|o| o.contains_key(k));
    Ok(Guards {
        active_hours: if given("active_hours") { au::check_active_hours(&args["active_hours"])? } else { was.active_hours.clone() },
        precheck: if given("precheck") { au::check_precheck(&args["precheck"])? } else { was.precheck.clone() },
        budget_usd: if given("budget_usd") { au::check_budget(&args["budget_usd"])? } else { was.budget_usd },
    })
}

/// What `create_automation` asks the user to approve: the automation, checked.
pub(super) fn automation_creation(s: &Shared, ctx: &Ctx, owner: &Owner, args: &Value, profile: Option<&str>) -> ToolResult {
    use crate::integrations::automations as au;
    let name = au::check_name(&args["name"])?;
    let trigger = au::check_trigger(au::parse("trigger", &args["trigger"])?)?;
    let action = automation_action(s, ctx, owner, &args["action"], profile)?;
    let guards = automation_guards(args, &Guards::default())?;
    let enabled = args["enabled"].as_bool().unwrap_or(true);
    let generate_secret = args["generate_secret"].as_bool().unwrap_or(false);
    if generate_secret && !matches!(trigger, au::Trigger::Webhook { .. }) {
        return Err(ToolError::Other("only a webhook can have a secret".into()));
    }
    if enabled && matches!(trigger, au::Trigger::At { .. }) && au::next_after(&trigger, chrono::Utc::now(), &chrono::Local).is_none() {
        return Err(ToolError::Other("its time (at) has passed: give it one to come".into()));
    }
    let view = automation_view(s, "", &name, enabled, &trigger, &action, generate_secret, &guards);
    let mut input = automation_input(s, ctx, "create", owner, view);
    input["apply"] = json!({
        "name": name, "enabled": enabled, "trigger": trigger, "action": action, "generate_secret": generate_secret,
        "active_hours": guards.active_hours, "precheck": guards.precheck, "budget_usd": guards.budget_usd,
    });
    input["reason"] = args["reason"].clone();
    Ok(input)
}

/// What `update_automation` asks the user to approve (Ok), or the change to make without asking
/// (Err): turning the automation off, or renaming it. Only what differs is changed, so a
/// setting left as it was can't overwrite a change the user made meanwhile.
pub(super) fn automation_update(
    s: &Shared, ctx: &Ctx, a: &automations::Automation, owner: &Owner, args: &Value, profile: Option<&str>,
) -> std::result::Result<std::result::Result<Value, Map<String, Value>>, ToolError> {
    use crate::integrations::automations as au;
    let mut apply = Map::new();
    let name = match &args["name"] {
        Value::Null => a.name.clone(),
        v => au::check_name(v)?,
    };
    if name != a.name {
        apply.insert("name".into(), json!(name));
    }
    let trigger = match &args["trigger"] {
        Value::Null => a.trigger.clone(),
        v => au::check_trigger(au::parse("trigger", v)?)?,
    };
    if trigger != a.trigger {
        apply.insert("trigger".into(), json!(trigger));
    }
    let action = match &args["action"] {
        Value::Null => a.action.clone(),
        v => automation_action(s, ctx, owner, v, profile)?,
    };
    if action != a.action {
        apply.insert("action".into(), json!(action));
    }
    let was = Guards::of(a);
    let guards = automation_guards(args, &was)?;
    if guards.active_hours != was.active_hours {
        apply.insert("active_hours".into(), json!(guards.active_hours));
    }
    if guards.precheck != was.precheck {
        apply.insert("precheck".into(), json!(guards.precheck));
    }
    if guards.budget_usd != was.budget_usd {
        apply.insert("budget_usd".into(), json!(guards.budget_usd));
    }
    let enabled = match &args["enabled"] {
        Value::Null => a.enabled,
        v => v.as_bool().ok_or_else(|| ToolError::Other("enabled must be true or false".into()))?,
    };
    if enabled != a.enabled {
        apply.insert("enabled".into(), json!(enabled));
    }
    let webhook = matches!(trigger, au::Trigger::Webhook { .. });
    let (generate, remove, rotate) = (args["generate_secret"] == true, args["remove_secret"] == true, args["rotate_url"] == true);
    if (generate || rotate) && !webhook {
        return Err(ToolError::Other("only a webhook has a secret or a URL".into()));
    }
    if generate && remove {
        return Err(ToolError::Other("generate_secret and remove_secret can't both be true".into()));
    }
    if generate {
        apply.insert("generate_secret".into(), json!(true));
    } else if remove && has_secret(a) {
        apply.insert("secret".into(), json!(""));
    }
    if rotate {
        apply.insert("rotate_token".into(), json!(true));
    }
    if apply.is_empty() {
        return Err(ToolError::Other("nothing to change".into()));
    }
    // Turning it off, or renaming it, doesn't make it do anything it didn't.
    if apply.keys().all(|k| k == "name" || k == "enabled") && enabled <= a.enabled {
        return Ok(Err(apply));
    }
    let signed = if generate { true } else if remove { false } else { has_secret(a) };
    let mut input = automation_input(s, ctx, "update", owner, automation_view(s, &a.id, &name, enabled, &trigger, &action, signed, &guards));
    input["before"] = automation_view(s, &a.id, &a.name, a.enabled, &a.trigger, &a.action, has_secret(a), &was);
    input["changes"] = json!(apply.keys().map(|k| k.as_str()).collect::<Vec<_>>());
    input["apply"] = json!(apply);
    input["reason"] = args["reason"].clone();
    Ok(Ok(input))
}

/// Asks the user to approve the automation change `input` describes (see automation_input),
/// then makes it, exactly as they saw it. A new secret is made once it's approved, and returned.
pub(super) async fn change_automation(s: &Shared, ctx: &Ctx, input: &Value) -> ToolResult {
    use crate::integrations::automations as au;
    let op = input["op"].as_str().unwrap_or_default();
    let tool = format!("{op}_automation");
    let id = input["automation"]["id"].as_str().unwrap_or_default();
    let approved = match ask_user(s, ctx, &tool, input).await {
        Ok(a) => a,
        // Deleted while the user was asked.
        Err(_) if op != "create" && au::get(&s.db(), id)?.is_none() => {
            return Err(ToolError::Other(format!("the automation \"{}\" was deleted meanwhile, so nothing was changed", input["automation"]["name"].as_str().unwrap_or(id))));
        }
        Err(e) => return Err(e),
    };
    let mut apply = approved["apply"].as_object().cloned().unwrap_or_default();
    let secret = (apply.remove("generate_secret") == Some(json!(true))).then(crate::util::new_token);
    if let Some(secret) = &secret {
        apply.insert("secret".into(), json!(secret));
    }
    let a = match op {
        "create" if approved["profile"].is_object() => au::create_routine(s, approved["profile"]["id"].as_str().unwrap_or_default(), &apply)?,
        "create" => au::create(s, approved["project"]["id"].as_str().unwrap_or_default(), &apply)?,
        "update" => au::update(s, id, &apply)?,
        _ => {
            let a = au::delete(s, id)?;
            return Ok(json!({"deleted": true, "id": a.id, "name": a.name}));
        }
    };
    let mut out = automation_json(s, &a);
    if let Some(secret) = secret {
        out["secret"] = json!(secret);
        out["secret_note"] = json!("Deliveries must be signed with this secret (X-Hub-Signature-256, as GitHub does). It isn't shown again.");
    }
    Ok(out)
}
