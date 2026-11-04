//! The workflow tools: listing, creating, changing and running a project's workflows (see integrations/workflows.rs).
//! Creating one, changing what it does or turning it on, and deleting one ask the user first, as automations do: a
//! workflow starts agents on the project's tasks and sends them messages.

use super::*;
use crate::integrations::workflows as wf;

/// The workflow an agent names in `workflow_id`: its id, or its name in `project_id` (or the agent's own project).
pub(super) fn resolve_workflow(
    s: &Shared, ctx: &Ctx, args: &Value, profile: Option<&str>, own_project: Option<String>,
) -> std::result::Result<(wf::Workflow, db::Project), ToolError> {
    let r = args["workflow_id"].as_str().map(str::trim).unwrap_or_default();
    if let Some(w) = wf::get(&s.db(), r)? {
        let p = db::get_project(&s.db(), &w.project_id)?;
        if let Some(p) = p.filter(|p| boards(s, ctx).is_ok_and(|b| b.iter().any(|b| b.id == p.profile_id))) {
            return Ok((w, p));
        }
        return Err(ToolError::NotFound(format!("workflow {r}")));
    }
    let p = project_or_own(s, ctx, args["project_id"].as_str().filter(|p| !p.is_empty()).map(String::from), profile, own_project)?;
    let named: Vec<_> = wf::list(&s.db(), &p.id)?.into_iter().filter(|w| w.name.eq_ignore_ascii_case(r)).collect();
    match named.len() {
        0 => Err(ToolError::NotFound(format!("workflow {r} in {} (use list_workflows)", p.key))),
        1 => Ok((named.into_iter().next().unwrap(), p)),
        _ => Err(ToolError::Other(format!("{} has several workflows named {r}; give its id (see list_workflows)", p.key))),
    }
}

/// A workflow as list_workflows shows it.
pub(super) fn workflow_json(w: &wf::Workflow) -> Value {
    wf::to_json(w)
}

/// A workflow as its approval shows it: what it is, with its agent steps' configs by name.
pub(super) fn workflow_view(s: &Shared, id: &str, name: &str, enabled: bool, graph: &wf::Graph) -> Value {
    let configs: Vec<Value> = graph
        .nodes
        .iter()
        .filter_map(|n| match &n.kind {
            wf::NodeKind::Agent { claude_config_id: Some(id), .. } => {
                db::get_claude_config(&s.db(), id).ok().flatten().map(|c| json!({"node": n.id, "id": c.id, "name": c.name, "agent": c.agent}))
            }
            _ => None,
        })
        .collect();
    json!({"id": id, "name": name, "enabled": enabled, "graph": graph, "configs": configs})
}

fn workflow_input(s: &Shared, ctx: &Ctx, op: &str, p: &db::Project, workflow: Value) -> Value {
    json!({"op": op, "project": approval_project(s, p), "task": approval_task(s, ctx), "workflow": workflow})
}

/// What `create_workflow` asks the user to approve: the workflow, checked.
pub(super) fn workflow_creation(s: &Shared, ctx: &Ctx, p: &db::Project, args: &Value) -> ToolResult {
    let name = wf::check_name(&args["name"])?;
    let graph = wf::check_graph(&s.db(), p, &args["graph"])?;
    let enabled = args["enabled"].as_bool().unwrap_or(true);
    let mut input = workflow_input(s, ctx, "create", p, workflow_view(s, "", &name, enabled, &graph));
    input["apply"] = json!({"name": name, "enabled": enabled, "graph": graph});
    input["reason"] = args["reason"].clone();
    Ok(input)
}

/// What `update_workflow` asks the user to approve (Ok), or the change to make without asking (Err): turning it off,
/// or renaming it. Only what differs is changed.
pub(super) fn workflow_update(
    s: &Shared, ctx: &Ctx, w: &wf::Workflow, p: &db::Project, args: &Value,
) -> std::result::Result<std::result::Result<Value, Map<String, Value>>, ToolError> {
    let mut apply = Map::new();
    let name = match &args["name"] {
        Value::Null => w.name.clone(),
        v => wf::check_name(v)?,
    };
    if name != w.name {
        apply.insert("name".into(), json!(name));
    }
    let graph = match &args["graph"] {
        Value::Null => w.graph.clone(),
        v => wf::check_graph(&s.db(), p, v)?,
    };
    if graph != w.graph {
        apply.insert("graph".into(), json!(graph));
    }
    let enabled = match &args["enabled"] {
        Value::Null => w.enabled,
        v => v.as_bool().ok_or_else(|| ToolError::Other("enabled must be true or false".into()))?,
    };
    if enabled != w.enabled {
        apply.insert("enabled".into(), json!(enabled));
    }
    if apply.is_empty() {
        return Err(ToolError::Other("nothing to change".into()));
    }
    if apply.keys().all(|k| k == "name" || k == "enabled") && enabled <= w.enabled {
        return Ok(Err(apply));
    }
    let mut input = workflow_input(s, ctx, "update", p, workflow_view(s, &w.id, &name, enabled, &graph));
    input["before"] = workflow_view(s, &w.id, &w.name, w.enabled, &w.graph);
    input["changes"] = json!(apply.keys().map(|k| k.as_str()).collect::<Vec<_>>());
    input["apply"] = json!(apply);
    input["reason"] = args["reason"].clone();
    Ok(Ok(input))
}

pub(super) fn workflow_deletion(s: &Shared, ctx: &Ctx, w: &wf::Workflow, p: &db::Project, reason: Option<String>) -> Value {
    let mut input = workflow_input(s, ctx, "delete", p, workflow_view(s, &w.id, &w.name, w.enabled, &w.graph));
    input["reason"] = json!(reason);
    input
}

/// Asks the user to approve the workflow change `input` describes, then makes it, exactly as they saw it.
pub(super) async fn change_workflow(s: &Shared, ctx: &Ctx, input: &Value) -> ToolResult {
    let op = input["op"].as_str().unwrap_or_default();
    let tool = format!("{op}_workflow");
    let id = input["workflow"]["id"].as_str().unwrap_or_default();
    let approved = match ask_user(s, ctx, &tool, input).await {
        Ok(a) => a,
        Err(_) if op != "create" && wf::get(&s.db(), id)?.is_none() => {
            return Err(ToolError::Other(format!("the workflow \"{}\" was deleted meanwhile, so nothing was changed", input["workflow"]["name"].as_str().unwrap_or(id))));
        }
        Err(e) => return Err(e),
    };
    let apply = approved["apply"].as_object().cloned().unwrap_or_default();
    let w = match op {
        "create" => wf::create(s, approved["project"]["id"].as_str().unwrap_or_default(), &apply)?,
        "update" => wf::update(s, id, &apply)?,
        _ => {
            let w = wf::delete(s, id)?;
            return Ok(json!({"deleted": true, "id": w.id, "name": w.name}));
        }
    };
    Ok(workflow_json(&w))
}

/// `run_workflow`: runs it on a task of its project now, and returns the run as it is once its first steps started.
pub(super) async fn run_workflow(s: &Shared, ctx: &Ctx, args: &Value, profile: Option<&str>, own_project: Option<String>) -> ToolResult {
    let (w, p) = resolve_workflow(s, ctx, args, profile, own_project)?;
    let r = args["task_id"].as_str().map(str::trim).unwrap_or_default();
    let t = resolve_task(s, ctx, r, profile).map_err(|e| match e {
        ToolError::NotFound(_) => ToolError::Other(format!("task {r} not found in {}", p.key)),
        e => e,
    })?;
    if t.project_id.as_deref() != Some(p.id.as_str()) {
        return Err(ToolError::Other(format!("task {r} isn't in {}, the workflow's project", p.key)));
    }
    let run = wf::start(s, &w.id, &t.id, true).await?.ok_or_else(|| ToolError::Other("the workflow didn't run".into()))?;
    Ok(wf::run_json(&s.db(), &run))
}

/// A task's latest workflow runs, briefly, for get_task: each step's state and output.
pub(super) fn task_workflows(s: &Shared, task_id: &str) -> Value {
    let c = s.db();
    let runs = wf::latest_runs(&c, task_id).unwrap_or_default();
    let list: Vec<Value> = runs
        .iter()
        .map(|r| {
            let steps: Vec<Value> = r
                .graph
                .nodes
                .iter()
                .filter(|n| matches!(n.kind, wf::NodeKind::Agent { .. }))
                .map(|n| {
                    let nr = r.node(&n.id);
                    json!({"name": wf::node_name(n), "state": nr.state, "port": nr.port, "text": nr.text, "issues": nr.issues})
                })
                .collect();
            json!({
                "workflow": wf::get(&c, &r.workflow_id).ok().flatten().map(|w| w.name),
                "state": r.state,
                "started_at": r.created_at,
                "steps": steps,
            })
        })
        .collect();
    json!(list)
}
