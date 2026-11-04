//! The API: workflows' and runs' JSON, and their routes' handlers.

use axum::Json;
use axum::extract::{Path, State};

use super::*;

pub fn to_json(w: &Workflow) -> Value {
    json!({
        "id": w.id,
        "project_id": w.project_id,
        "name": w.name,
        "enabled": w.enabled,
        "graph": w.graph,
        "created_at": w.created_at,
        "updated_at": w.updated_at,
    })
}

/// A run, with its workflow's name (or none, once the workflow is deleted).
pub fn run_json(c: &Connection, r: &Run) -> Value {
    let mut v = json!(r);
    v["workflow_name"] = json!(get(c, &r.workflow_id).ok().flatten().map(|w| w.name));
    v
}

fn workflow(c: &Connection, id: &str) -> ApiResult<Workflow> {
    get(c, id)?.ok_or_else(|| ApiError::not_found("workflow"))
}

/// `GET /projects/{id}/workflows`.
pub async fn list_handler(State(s): State<Shared>, Path(project_id): Path<String>) -> ApiResult<Json<Value>> {
    let c = s.db();
    db::get_project(&c, &project_id)?.ok_or_else(|| ApiError::not_found("project"))?;
    let all: Vec<Value> = list(&c, &project_id)?.iter().map(to_json).collect();
    Ok(Json(json!({"workflows": all})))
}

/// `POST /projects/{id}/workflows`: `{name, graph, enabled?}`.
pub async fn create_handler(State(s): State<Shared>, Path(project_id): Path<String>, Json(b): Json<Map<String, Value>>) -> ApiResult<Json<Value>> {
    Ok(Json(to_json(&create(&s, &project_id, &b)?)))
}

pub async fn get_handler(State(s): State<Shared>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    Ok(Json(to_json(&workflow(&s.db(), &id)?)))
}

/// `PATCH /workflows/{id}`: any of `{name, graph, enabled}`.
pub async fn update_handler(State(s): State<Shared>, Path(id): Path<String>, Json(b): Json<Map<String, Value>>) -> ApiResult<Json<Value>> {
    Ok(Json(to_json(&update(&s, &id, &b)?)))
}

pub async fn delete_handler(State(s): State<Shared>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    delete(&s, &id)?;
    Ok(Json(json!({"deleted": true})))
}

/// `POST /workflows/{id}/run`: `{task_id}`, whether or not the workflow is on or its trigger matches.
pub async fn run_handler(State(s): State<Shared>, Path(id): Path<String>, Json(b): Json<Map<String, Value>>) -> ApiResult<Json<Value>> {
    let task = b.get("task_id").and_then(Value::as_str).ok_or_else(|| bad("task_id is needed"))?;
    let run = start(&s, &id, task, true).await?.ok_or_else(|| ApiError::conflict("the workflow didn't run"))?;
    Ok(Json(run_json(&s.db(), &run)))
}

/// `GET /tasks/{id}/workflow-runs`: the latest run of each workflow on the task, and the project's workflows (to run
/// one by hand).
pub async fn task_runs_handler(State(s): State<Shared>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let c = s.db();
    let task = db::get_task(&c, &id)?.ok_or_else(|| ApiError::not_found("task"))?;
    let runs: Vec<Value> = latest_runs(&c, &task.id)?.iter().map(|r| run_json(&c, r)).collect();
    let workflows: Vec<Value> = match task.project_id.as_deref().filter(|_| task.kind == "task") {
        Some(p) => list(&c, p)?.iter().map(|w| json!({"id": w.id, "name": w.name, "enabled": w.enabled})).collect(),
        None => Vec::new(),
    };
    Ok(Json(json!({"runs": runs, "workflows": workflows})))
}

/// `POST /workflow-runs/{id}/stop`.
pub async fn stop_run_handler(State(s): State<Shared>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    get_run(&s.db(), &id)?.ok_or_else(|| ApiError::not_found("workflow run"))?;
    Ok(Json(json!({"stopped": stop_run(&s, &id, "Stopped by the user.")})))
}
