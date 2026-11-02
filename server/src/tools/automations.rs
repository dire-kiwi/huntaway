//! The automation tools: listing, creating, changing and running a project's automations (see
//! automations.rs).

use super::*;

/// The automation an agent names in `automation_id`: its id, or its name in `project_id` (or
/// the agent's own project). Only one in a project on a board the agent can use.
pub(super) fn resolve_automation(
    s: &Shared, ctx: &Ctx, args: &Value, profile: Option<&str>, own_project: Option<String>,
) -> std::result::Result<(crate::automations::Automation, db::Project), ToolError> {
    let r = args["automation_id"].as_str().map(str::trim).unwrap_or_default();
    let by_id = crate::automations::get(&s.db(), r)?;
    if let Some(a) = by_id {
        let p = db::get_project(&s.db(), &a.project_id)?;
        if let Some(p) = p.filter(|p| boards(s, ctx).is_ok_and(|b| b.iter().any(|b| b.id == p.profile_id))) {
            return Ok((a, p));
        }
        return Err(ToolError::NotFound(format!("automation {r}")));
    }
    let p = project_or_own(s, ctx, args["project_id"].as_str().filter(|p| !p.is_empty()).map(String::from), profile, own_project)?;
    let named: Vec<_> = crate::automations::list(&s.db(), &p.id)?.into_iter().filter(|a| a.name.eq_ignore_ascii_case(r)).collect();
    match named.len() {
        0 => Err(ToolError::NotFound(format!("automation {r} in {} (use list_automations)", p.key))),
        1 => Ok((named.into_iter().next().unwrap(), p)),
        _ => Err(ToolError::Other(format!("{} has several automations named {r}; give its id (see list_automations)", p.key))),
    }
}

pub(super) fn has_secret(a: &crate::automations::Automation) -> bool {
    a.secret.as_deref().is_some_and(|s| !s.is_empty())
}

/// An automation as list_automations shows it, with its webhook's full URL when the host's
/// public_url is set.
pub(super) fn automation_json(s: &Shared, a: &crate::automations::Automation) -> Value {
    let c = s.db();
    let mut v = crate::automations::to_json(&c, a);
    if a.is_webhook() {
        match db::get_setting(&c, "public_url").ok().flatten().filter(|u| !u.is_empty()) {
            Some(url) => v["webhook_url"] = json!(format!("{url}{}", a.hook_path())),
            None => v["webhook_note"] = json!("hook_path is on this host; the full URL depends on how it's reached from outside (the host's public_url setting isn't set)"),
        }
    }
    v
}

/// An automation as its approval shows it: what it is, and the task its message goes to and
/// the agent config its tasks use, by name.
#[allow(clippy::too_many_arguments)]
pub(super) fn automation_view(
    s: &Shared, id: &str, name: &str, enabled: bool, trigger: &crate::automations::Trigger, action: &crate::automations::Action, signed: bool,
) -> Value {
    use crate::automations::Action;
    let mut v = json!({"id": id, "name": name, "enabled": enabled, "trigger": trigger, "action": action, "signed": signed});
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
        Action::CreateTask { .. } => {}
    }
    v
}

/// What an automation approval asks: `op` (create, update or delete) on `automation` (see
/// automation_view) in project `p`, asked by the calling agent, with the time zone its times of
/// day are in.
pub(super) fn automation_input(s: &Shared, ctx: &Ctx, op: &str, p: &db::Project, automation: Value) -> Value {
    let time_zone = crate::automations::time_zone();
    json!({"op": op, "project": approval_project(s, p), "task": approval_task(s, ctx), "automation": automation, "time_zone": time_zone})
}

/// An automation's action as an agent gives it, checked against project `p`: a message's task
/// can be named by key, and has to be one of the project's.
fn automation_action(s: &Shared, ctx: &Ctx, p: &db::Project, v: &Value, profile: Option<&str>) -> std::result::Result<crate::automations::Action, ToolError> {
    use crate::automations::{self as au, Action};
    let action = match au::parse::<Action>("action", v)? {
        Action::SendToTask { task_id, message } => {
            let t = resolve_task(s, ctx, task_id.trim(), profile).map_err(|e| match e {
                ToolError::NotFound(_) => ToolError::Other(format!("task {task_id} not found in {}", p.key)),
                e => e,
            })?;
            Action::SendToTask { task_id: t.id, message }
        }
        a => a,
    };
    Ok(au::check_action(&s.db(), p, action)?)
}

/// What `create_automation` asks the user to approve: the automation, checked.
pub(super) fn automation_creation(s: &Shared, ctx: &Ctx, p: &db::Project, args: &Value, profile: Option<&str>) -> ToolResult {
    use crate::automations as au;
    let name = au::check_name(&args["name"])?;
    let trigger = au::check_trigger(au::parse("trigger", &args["trigger"])?)?;
    let action = automation_action(s, ctx, p, &args["action"], profile)?;
    let enabled = args["enabled"].as_bool().unwrap_or(true);
    let generate_secret = args["generate_secret"].as_bool().unwrap_or(false);
    if generate_secret && !matches!(trigger, au::Trigger::Webhook { .. }) {
        return Err(ToolError::Other("only a webhook can have a secret".into()));
    }
    let view = automation_view(s, "", &name, enabled, &trigger, &action, generate_secret);
    let mut input = automation_input(s, ctx, "create", p, view);
    input["apply"] = json!({"name": name, "enabled": enabled, "trigger": trigger, "action": action, "generate_secret": generate_secret});
    input["reason"] = args["reason"].clone();
    Ok(input)
}

/// What `update_automation` asks the user to approve (Ok), or the change to make without asking
/// (Err): turning the automation off, or renaming it. Only what differs is changed, so a
/// setting left as it was can't overwrite a change the user made meanwhile.
pub(super) fn automation_update(
    s: &Shared, ctx: &Ctx, a: &crate::automations::Automation, p: &db::Project, args: &Value, profile: Option<&str>,
) -> std::result::Result<std::result::Result<Value, Map<String, Value>>, ToolError> {
    use crate::automations as au;
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
        v => automation_action(s, ctx, p, v, profile)?,
    };
    if action != a.action {
        apply.insert("action".into(), json!(action));
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
    let mut input = automation_input(s, ctx, "update", p, automation_view(s, &a.id, &name, enabled, &trigger, &action, signed));
    input["before"] = automation_view(s, &a.id, &a.name, a.enabled, &a.trigger, &a.action, has_secret(a));
    input["changes"] = json!(apply.keys().map(|k| k.as_str()).collect::<Vec<_>>());
    input["apply"] = json!(apply);
    input["reason"] = args["reason"].clone();
    Ok(Ok(input))
}

/// Asks the user to approve the automation change `input` describes (see automation_input),
/// then makes it, exactly as they saw it. A new secret is made once it's approved, and returned.
pub(super) async fn change_automation(s: &Shared, ctx: &Ctx, input: &Value) -> ToolResult {
    use crate::automations as au;
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
