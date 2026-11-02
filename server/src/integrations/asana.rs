//! Asana, for linking a task to the Asana task it's for (API 57). A profile connects with a
//! personal access token (see db::Profile::asana_token), and the link dialog finds tasks with
//! Asana's typeahead search across the user's workspaces, or by a pasted task URL. The link
//! itself is stored on the task as an external link (see db::ExternalLink).

use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

/// Asana's API. `IA_ASANA_URL` points it elsewhere, for a test server.
fn base_url() -> String {
    #[cfg(test)]
    if let Some(url) = TEST_URL.with(|u| u.borrow().clone()) {
        return url;
    }
    std::env::var("IA_ASANA_URL").unwrap_or_else(|_| "https://app.asana.com/api/1.0".into())
}

#[cfg(test)]
thread_local! {
    /// A fake Asana for this thread's test (see tests::fake).
    static TEST_URL: std::cell::RefCell<Option<String>> = const { std::cell::RefCell::new(None) };
}

/// How many tasks a search finds at most in each workspace (Asana's typeahead takes up to 100).
const SEARCH_RESULTS: usize = 25;

const TASK_FIELDS: &str = "name,completed,permalink_url,notes,assignee.name,projects.name,workspace.name";

/// The Asana user a token belongs to.
#[derive(Debug, PartialEq)]
pub struct User {
    pub name: String,
    pub email: Option<String>,
    /// Workspace gids.
    pub workspaces: Vec<String>,
}

impl User {
    /// How the profile shows who it's connected as.
    pub fn label(&self) -> String {
        match &self.email {
            Some(e) if !e.is_empty() && *e != self.name => format!("{} ({e})", self.name),
            _ => self.name.clone(),
        }
    }
}

/// An Asana task, as the link dialog lists it.
#[derive(Serialize, Debug, PartialEq)]
pub struct AsanaTask {
    pub gid: String,
    pub name: String,
    pub url: String,
    pub completed: bool,
    /// Its description, as plain text.
    pub notes: String,
    pub assignee: Option<String>,
    pub projects: Vec<String>,
    pub workspace: Option<String>,
}

impl AsanaTask {
    fn from_json(v: &Value) -> Option<Self> {
        let gid = v["gid"].as_str()?.to_string();
        let url = v["permalink_url"].as_str().map(str::to_string).unwrap_or_else(|| format!("https://app.asana.com/0/0/{gid}"));
        Some(Self {
            name: v["name"].as_str().unwrap_or_default().to_string(),
            completed: v["completed"].as_bool().unwrap_or(false),
            notes: v["notes"].as_str().unwrap_or_default().to_string(),
            assignee: v["assignee"]["name"].as_str().map(str::to_string),
            projects: v["projects"].as_array().into_iter().flatten().filter_map(|p| p["name"].as_str().map(str::to_string)).collect(),
            workspace: v["workspace"]["name"].as_str().map(str::to_string),
            gid,
            url,
        })
    }
}

/// Why a call to Asana failed, in words for the user.
#[derive(Debug, PartialEq)]
pub enum Error {
    /// Asana turned the token down.
    Unauthorized,
    NotFound,
    Other(String),
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        match self {
            Error::Unauthorized => write!(f, "Asana didn't accept the token; check it in Asana's developer console, or connect again"),
            Error::NotFound => write!(f, "Asana has no such task, or the token can't see it"),
            Error::Other(e) => write!(f, "Asana: {e}"),
        }
    }
}

async fn get(token: &str, path: &str, query: &[(&str, &str)]) -> Result<Value, Error> {
    let http = reqwest::Client::builder().timeout(Duration::from_secs(15)).build().map_err(|e| Error::Other(e.to_string()))?;
    let url = reqwest::Url::parse_with_params(&format!("{}{path}", base_url()), query).map_err(|e| Error::Other(e.to_string()))?;
    let resp = http.get(url).bearer_auth(token).send().await.map_err(|e| Error::Other(e.to_string()))?;
    let status = resp.status();
    let body: Value = resp.json().await.unwrap_or(Value::Null);
    match status.as_u16() {
        200..=299 => Ok(body["data"].clone()),
        401 => Err(Error::Unauthorized),
        403 | 404 => Err(Error::NotFound),
        _ => {
            let msg = body["errors"][0]["message"].as_str().map(str::to_string).unwrap_or_else(|| format!("HTTP {status}"));
            Err(Error::Other(msg))
        }
    }
}

/// Who a token belongs to, which also checks it.
pub async fn me(token: &str) -> Result<User, Error> {
    let v = get(token, "/users/me", &[("opt_fields", "name,email,workspaces")]).await?;
    Ok(User {
        name: v["name"].as_str().unwrap_or_default().to_string(),
        email: v["email"].as_str().map(str::to_string),
        workspaces: v["workspaces"].as_array().into_iter().flatten().filter_map(|w| w["gid"].as_str().map(str::to_string)).collect(),
    })
}

pub async fn task(token: &str, gid: &str) -> Result<AsanaTask, Error> {
    let v = get(token, &format!("/tasks/{gid}"), &[("opt_fields", TASK_FIELDS)]).await?;
    AsanaTask::from_json(&v).ok_or(Error::NotFound)
}

/// The tasks a search finds: the task a pasted URL (or gid) names, or else those whose names
/// match `q` in each of the user's workspaces (with `q` empty, the ones Asana ranks first,
/// which are those the user looked at lately), open ones first.
pub async fn search(token: &str, q: &str) -> Result<Vec<AsanaTask>, Error> {
    let q = q.trim();
    if let Some(gid) = task_gid(q) {
        return Ok(vec![task(token, &gid).await?]);
    }
    let user = me(token).await?;
    let count = SEARCH_RESULTS.to_string();
    let lookups = user.workspaces.iter().map(|w| {
        let path = format!("/workspaces/{w}/typeahead");
        let count = &count;
        async move { get(token, &path, &[("resource_type", "task"), ("query", q), ("count", count), ("opt_fields", TASK_FIELDS)]).await }
    });
    let mut tasks = Vec::new();
    for found in futures::future::join_all(lookups).await {
        tasks.extend(found?.as_array().into_iter().flatten().filter_map(AsanaTask::from_json));
    }
    // Stable, so each workspace's keep Asana's order.
    tasks.sort_by_key(|t| t.completed);
    Ok(tasks)
}

/// The task an Asana task URL (or a bare gid) names: `https://app.asana.com/0/<project>/<task>`
/// (`/f` after it, or `/0/<project>/<task>/<subtask>`), or the newer
/// `https://app.asana.com/1/<workspace>/project/<project>/task/<task>`.
pub fn task_gid(q: &str) -> Option<String> {
    let gid = |s: &str| (!s.is_empty() && s.chars().all(|c| c.is_ascii_digit())).then(|| s.to_string());
    if q.len() >= 10 {
        if let Some(g) = gid(q) {
            return Some(g);
        }
    }
    let rest = q.strip_prefix("https://").or_else(|| q.strip_prefix("http://"))?;
    let path = rest.strip_prefix("app.asana.com/")?;
    let path = path.split(['?', '#']).next().unwrap_or_default();
    let parts: Vec<&str> = path.split('/').filter(|p| !p.is_empty()).collect();
    if let Some(i) = parts.iter().rposition(|p| *p == "task") {
        return parts.get(i + 1).and_then(|p| gid(p));
    }
    match parts.as_slice() {
        ["0", _project, ids @ ..] => ids.iter().rev().find_map(|p| gid(p)).filter(|_| !ids.is_empty()),
        _ => None,
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use axum::Json;
    use axum::extract::{Path, Query};
    use axum::http::{HeaderMap, StatusCode};
    use axum::routing::get;
    use serde_json::json;
    use std::collections::HashMap;

    /// The token the fake Asana takes.
    pub const TOKEN: &str = "good-token";

    fn task_json(gid: &str, name: &str, completed: bool) -> Value {
        json!({"gid": gid, "name": name, "completed": completed, "permalink_url": format!("https://app.asana.com/0/1/{gid}"),
               "notes": format!("Notes for {name}"), "assignee": {"name": "Ivy"}, "projects": [{"name": "Web"}], "workspace": {"name": "Acme"}})
    }

    /// Starts a fake Asana API with two workspaces for this thread's test to call.
    pub async fn fake() {
        let authed = |h: &HeaderMap| h.get("authorization").and_then(|v| v.to_str().ok()) == Some(&format!("Bearer {TOKEN}"));
        let unauthorized = || (StatusCode::UNAUTHORIZED, Json(json!({"errors": [{"message": "Not Authorized"}]})));
        let app = axum::Router::new()
            .route(
                "/users/me",
                get(move |h: HeaderMap| async move {
                    if !authed(&h) {
                        return unauthorized();
                    }
                    (StatusCode::OK, Json(json!({"data": {"gid": "9", "name": "Ivy", "email": "ivy@example.com", "workspaces": [{"gid": "100"}, {"gid": "200"}]}})))
                }),
            )
            .route(
                "/workspaces/{w}/typeahead",
                get(move |h: HeaderMap, Path(w): Path<String>, Query(q): Query<HashMap<String, String>>| async move {
                    if !authed(&h) {
                        return unauthorized();
                    }
                    assert_eq!(q.get("resource_type").map(String::as_str), Some("task"));
                    let all = match w.as_str() {
                        "100" => vec![task_json("1001", "Fix login", true), task_json("1002", "Fix signup", false)],
                        _ => vec![task_json("2001", "Write docs", false)],
                    };
                    let query = q.get("query").cloned().unwrap_or_default().to_lowercase();
                    let found: Vec<Value> = all.into_iter().filter(|t| t["name"].as_str().unwrap().to_lowercase().contains(&query)).collect();
                    (StatusCode::OK, Json(json!({"data": found})))
                }),
            )
            .route(
                "/tasks/{gid}",
                get(move |h: HeaderMap, Path(gid): Path<String>| async move {
                    if !authed(&h) {
                        return unauthorized();
                    }
                    match gid.as_str() {
                        "1002" => (StatusCode::OK, Json(json!({"data": task_json("1002", "Fix signup", false)}))),
                        _ => (StatusCode::NOT_FOUND, Json(json!({"errors": [{"message": "Unknown object"}]}))),
                    }
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        TEST_URL.with(|u| *u.borrow_mut() = Some(url));
    }

    #[test]
    fn searches_every_workspace_and_finds_tasks_by_url() {
        crate::testing::run(async || {
            fake().await;
            let user = me(TOKEN).await.unwrap();
            assert_eq!((user.label(), user.workspaces), ("Ivy (ivy@example.com)".to_string(), vec!["100".to_string(), "200".to_string()]));
            assert_eq!(me("nope").await, Err(Error::Unauthorized));
            // Open tasks first, each workspace's in Asana's order.
            let names = |ts: Vec<AsanaTask>| ts.into_iter().map(|t| t.name).collect::<Vec<_>>();
            assert_eq!(names(search(TOKEN, "").await.unwrap()), ["Fix signup", "Write docs", "Fix login"]);
            assert_eq!(names(search(TOKEN, " fix ").await.unwrap()), ["Fix signup", "Fix login"]);
            let found = search(TOKEN, "https://app.asana.com/0/1/1002/f").await.unwrap();
            assert_eq!(found.len(), 1);
            let t = &found[0];
            assert_eq!((t.gid.as_str(), t.url.as_str(), t.notes.as_str()), ("1002", "https://app.asana.com/0/1/1002", "Notes for Fix signup"));
            assert_eq!((t.assignee.as_deref(), t.projects.clone(), t.workspace.as_deref()), (Some("Ivy"), vec!["Web".to_string()], Some("Acme")));
            assert_eq!(search(TOKEN, "https://app.asana.com/0/1/5555").await, Err(Error::NotFound));
        })
    }

    #[test]
    fn reads_task_urls() {
        assert_eq!(task_gid("https://app.asana.com/0/1200000000000001/1200000000000002").as_deref(), Some("1200000000000002"));
        assert_eq!(task_gid("https://app.asana.com/0/1200000000000001/1200000000000002/f").as_deref(), Some("1200000000000002"));
        assert_eq!(task_gid("https://app.asana.com/0/0/1200000000000002?focus=true").as_deref(), Some("1200000000000002"));
        assert_eq!(task_gid("https://app.asana.com/1/1111111111/project/2222222222/task/3333333333").as_deref(), Some("3333333333"));
        assert_eq!(task_gid("https://app.asana.com/1/1111111111/task/3333333333?focus=true").as_deref(), Some("3333333333"));
        assert_eq!(task_gid("1200000000000002").as_deref(), Some("1200000000000002"));
        // A project, not a task.
        assert_eq!(task_gid("https://app.asana.com/0/1200000000000001"), None);
        assert_eq!(task_gid("https://app.asana.com/1/1111111111/project/2222222222/list"), None);
        // Words and short numbers are searched for.
        assert_eq!(task_gid("fix login"), None);
        assert_eq!(task_gid("2024"), None);
        assert_eq!(task_gid("https://example.com/0/1/2"), None);
    }
}
