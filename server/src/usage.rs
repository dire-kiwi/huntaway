//! Subscription usage (session and weekly limits) for each Claude config. Codex configs get
//! theirs from `codex app-server` (see codex.rs).
//!
//! Two sources feed it: Anthropic's OAuth usage endpoint (what `/usage` in Claude Code shows),
//! called with the config's own login, and the `rate_limit_event`s agents print as they run.
//! The login is only read, never refreshed: refreshing rotates the token underneath any
//! `claude` running with the config. An expired login refreshes on the config's next run.
//!
//! Only configs with `show_usage` turned on are fetched and listed. The endpoint's rate limit is
//! per account, and every host with a copy of the login (PR previews, test servers) would
//! otherwise poll it too.

use std::time::{Duration, Instant};

use axum::Json;
use axum::extract::{Query, State};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::db;
use crate::state::{ApiResult, Shared};
use crate::util::expand_tilde;

const USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
/// How long a fetched snapshot is good for before a plain `GET /usage` fetches again
/// (a little under the UI's 5-minute poll).
const MAX_AGE: Duration = Duration::from_secs(4 * 60);
/// Minimum gap between fetches for one config, even when a refresh is asked for.
const MIN_GAP: Duration = Duration::from_secs(30);

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Limit {
    /// `session`, `weekly`, or `weekly:<model>`.
    pub id: String,
    pub label: String,
    /// 0–100, how much of the limit is used.
    pub percent: f64,
    pub resets_at: Option<String>,
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct Usage {
    pub config_id: String,
    pub limits: Vec<Limit>,
    /// Plan from the login, e.g. `max`, `pro`.
    pub plan: Option<String>,
    /// When `limits` was last updated (by a fetch or an agent run).
    pub updated_at: Option<String>,
    /// Why the last fetch didn't work; `limits` may still hold older numbers.
    pub error: Option<String>,
    #[serde(skip)]
    fetched: Option<Instant>,
}

impl Usage {
    /// Replace or add limits by id, keeping the ones `new` doesn't mention.
    fn merge(&mut self, new: Vec<Limit>) {
        for l in new {
            match self.limits.iter_mut().find(|x| x.id == l.id) {
                Some(x) => *x = l,
                None => self.limits.push(l),
            }
        }
        self.limits.sort_by_key(|l| (l.id != "session", l.id != "weekly", l.id.clone()));
    }
}

#[derive(Deserialize)]
pub struct UsageQuery {
    #[serde(default)]
    refresh: bool,
}

/// `GET /usage`: every config on this host that shows its usage, fetching ones that are stale.
pub async fn list(State(s): State<Shared>, Query(q): Query<UsageQuery>) -> ApiResult<Json<Value>> {
    let configs: Vec<_> = db::list_claude_configs(&s.db())?.into_iter().filter(|c| c.show_usage).collect();
    let due: Vec<_> = {
        let cache = s.usage.lock().unwrap();
        configs
            .iter()
            .filter(|p| {
                let fetched = cache.get(&p.id).and_then(|u| u.fetched);
                fetched.is_none_or(|t| t.elapsed() >= if q.refresh { MIN_GAP } else { MAX_AGE })
            })
            .cloned()
            .collect()
    };
    futures::future::join_all(due.iter().map(|c| refresh(&s, c))).await;
    let cache = s.usage.lock().unwrap();
    let out: Vec<Usage> = configs
        .iter()
        .map(|c| cache.get(&c.id).cloned().unwrap_or_else(|| Usage { config_id: c.id.clone(), ..Default::default() }))
        .collect();
    Ok(Json(json!(out)))
}

async fn refresh(s: &Shared, config: &db::ClaudeConfig) {
    let (config_id, config_dir) = (config.id.as_str(), config.config_dir.as_str());
    let result = if config.is_codex() { crate::codex::rate_limits(config.dir()).await } else { fetch(config_dir).await };
    let mut cache = s.usage.lock().unwrap();
    let u = cache.entry(config_id.to_string()).or_insert_with(|| Usage { config_id: config_id.to_string(), ..Default::default() });
    u.fetched = Some(Instant::now());
    match result {
        Ok((plan, limits)) => {
            // A fresh fetch is the whole picture: drop limits it no longer reports.
            u.limits.clear();
            u.merge(limits);
            u.plan = plan;
            u.updated_at = Some(crate::util::now());
            u.error = None;
        }
        Err(e) => {
            tracing::debug!(config = config_id, "usage fetch failed: {e}");
            u.error = Some(e);
        }
    }
}

#[derive(Deserialize)]
struct Credentials {
    #[serde(rename = "claudeAiOauth")]
    oauth: Option<OAuth>,
}

#[derive(Deserialize)]
struct OAuth {
    #[serde(rename = "accessToken")]
    access_token: String,
    #[serde(rename = "expiresAt")]
    expires_at: Option<i64>,
    #[serde(rename = "subscriptionType")]
    subscription_type: Option<String>,
}

async fn fetch(config_dir: &str) -> Result<(Option<String>, Vec<Limit>), String> {
    let dir = expand_tilde(if config_dir.trim().is_empty() { "~/.claude" } else { config_dir });
    let path = dir.join(".credentials.json");
    let raw = match tokio::fs::read_to_string(&path).await {
        Ok(r) => r,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(format!("No Claude login in {}", dir.display()));
        }
        Err(e) => return Err(format!("Can't read {}: {e}", path.display())),
    };
    let creds: Credentials = serde_json::from_str(&raw).map_err(|e| format!("Can't parse {}: {e}", path.display()))?;
    let oauth = creds.oauth.ok_or("Not signed in with a Claude subscription")?;
    if oauth.expires_at.is_some_and(|t| t <= chrono::Utc::now().timestamp_millis()) {
        return Err("Login expired; it refreshes on this config's next agent run".into());
    }
    let res = http()
        .get(USAGE_URL)
        .bearer_auth(&oauth.access_token)
        .header("anthropic-beta", "oauth-2025-04-20")
        .send()
        .await
        .map_err(|e| format!("Usage request failed: {e}"))?;
    let status = res.status();
    if !status.is_success() {
        let body = res.text().await.unwrap_or_default();
        let msg = serde_json::from_str::<Value>(&body).ok().and_then(|v| v["error"]["message"].as_str().map(String::from));
        return Err(format!("Usage request failed ({status}){}", msg.map(|m| format!(": {m}")).unwrap_or_default()));
    }
    let v: Value = res.json().await.map_err(|e| format!("Bad usage response: {e}"))?;
    Ok((oauth.subscription_type, parse_limits(&v)))
}

fn http() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(|| reqwest::Client::builder().timeout(Duration::from_secs(10)).build().unwrap_or_default())
}

/// Limits from the usage endpoint: its `limits` list, or the older per-window fields.
fn parse_limits(v: &Value) -> Vec<Limit> {
    if let Some(list) = v["limits"].as_array() {
        return list
            .iter()
            .filter_map(|l| {
                let percent = l["percent"].as_f64()?;
                let model = l["scope"]["model"]["display_name"].as_str();
                let (id, label) = match (l["kind"].as_str()?, model) {
                    ("session", _) => ("session".to_string(), "Session".to_string()),
                    ("weekly_all", _) => ("weekly".to_string(), "Weekly".to_string()),
                    (_, Some(m)) if l["group"] == "weekly" => (format!("weekly:{}", m.to_lowercase()), format!("Weekly · {m}")),
                    (k, _) => (k.to_string(), k.replace('_', " ")),
                };
                Some(Limit { id, label, percent, resets_at: l["resets_at"].as_str().map(String::from) })
            })
            .collect();
    }
    let windows = [
        ("five_hour", "session", "Session"),
        ("seven_day", "weekly", "Weekly"),
        ("seven_day_opus", "weekly:opus", "Weekly · Opus"),
        ("seven_day_sonnet", "weekly:sonnet", "Weekly · Sonnet"),
    ];
    windows
        .iter()
        .filter_map(|(key, id, label)| {
            let w = &v[*key];
            Some(Limit {
                id: id.to_string(),
                label: label.to_string(),
                percent: w["utilization"].as_f64()?,
                resets_at: w["resets_at"].as_str().map(String::from),
            })
        })
        .collect()
}

/// A `rate_limit_event` from an agent run with `config_id`: update its session and weekly limits.
pub fn on_rate_limit_event(s: &Shared, config_id: &str, v: &Value) {
    let windows = &v["rate_limit_info"]["unifiedWindows"];
    let mut limits = vec![];
    for (key, id, label) in [("five_hour", "session", "Session"), ("seven_day", "weekly", "Weekly")] {
        let w = &windows[key];
        let Some(util) = w["utilization"].as_f64() else { continue };
        let resets_at = w["resetsAt"].as_i64().and_then(|t| chrono::DateTime::from_timestamp(t, 0)).map(|t| t.to_rfc3339());
        limits.push(Limit { id: id.into(), label: label.into(), percent: (util * 1000.0).round() / 10.0, resets_at });
    }
    set_limits(s, config_id, limits, None);
}

/// Limits an agent run reported for `config_id` (and its plan, if it said).
pub fn set_limits(s: &Shared, config_id: &str, limits: Vec<Limit>, plan: Option<&str>) {
    if limits.is_empty() {
        return;
    }
    let usage = {
        let mut cache = s.usage.lock().unwrap();
        let u = cache.entry(config_id.to_string()).or_insert_with(|| Usage { config_id: config_id.to_string(), ..Default::default() });
        let before = (u.limits.clone(), u.plan.clone());
        u.merge(limits);
        if let Some(p) = plan {
            u.plan = Some(p.to_string());
        }
        if (u.limits.clone(), u.plan.clone()) == before {
            return;
        }
        u.updated_at = Some(crate::util::now());
        u.clone()
    };
    s.emit(json!({"type": "usage", "usage": usage}));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_limits_list() {
        let v = json!({
            "five_hour": {"utilization": 14.0, "resets_at": "2026-10-23T12:39:59Z"},
            "limits": [
                {"kind": "session", "group": "session", "percent": 14, "resets_at": "2026-10-23T12:39:59Z", "scope": null},
                {"kind": "weekly_all", "group": "weekly", "percent": 67, "resets_at": "2026-10-24T02:59:59Z", "scope": null},
                {"kind": "weekly_scoped", "group": "weekly", "percent": 0, "resets_at": null, "scope": {"model": {"display_name": "Fable"}}}
            ]
        });
        let l = parse_limits(&v);
        assert_eq!(l.iter().map(|l| l.id.as_str()).collect::<Vec<_>>(), ["session", "weekly", "weekly:fable"]);
        assert_eq!(l[1].percent, 67.0);
        assert_eq!(l[2].label, "Weekly · Fable");
    }

    #[test]
    fn parses_window_fields() {
        let v = json!({"five_hour": {"utilization": 14.0, "resets_at": "x"}, "seven_day": {"utilization": 67.0}, "seven_day_opus": null});
        let l = parse_limits(&v);
        assert_eq!(l.len(), 2);
        assert_eq!(l[0].id, "session");
        assert_eq!(l[1].resets_at, None);
    }

    #[test]
    fn lists_only_configs_that_show_usage() {
        crate::testing::run(async || {
            let s = crate::testing::state();
            // Neither has a login, so the one that's fetched fails without going to the network.
            let dir = std::env::temp_dir().join(format!("ia-usage-{}", crate::util::new_id()));
            let (off, on) = {
                let c = s.db();
                let off = db::insert_claude_config(&c, "off", &dir.to_string_lossy(), "claude").unwrap();
                let on = db::insert_claude_config(&c, "on", &dir.to_string_lossy(), "claude").unwrap();
                db::update_claude_config(&c, &on.id, &[("show_usage", json!(true))]).unwrap();
                (off, on)
            };
            assert!(!off.show_usage);
            let Json(v) = list(State(s.clone()), Query(UsageQuery { refresh: false })).await.unwrap();
            let list = v.as_array().unwrap();
            assert_eq!(list.len(), 1);
            assert_eq!(list[0]["config_id"], on.id);
            assert!(list[0]["error"].as_str().unwrap().starts_with("No Claude login"));
            assert!(!s.usage.lock().unwrap().contains_key(&off.id));
        })
    }

    #[test]
    fn merge_keeps_unmentioned_limits() {
        let lim = |id: &str, p: f64| Limit { id: id.into(), label: id.into(), percent: p, resets_at: None };
        let mut u = Usage { limits: vec![lim("weekly:fable", 3.0), lim("session", 10.0)], ..Default::default() };
        u.merge(vec![lim("weekly", 50.0), lim("session", 12.0)]);
        assert_eq!(u.limits, vec![lim("session", 12.0), lim("weekly", 50.0), lim("weekly:fable", 3.0)]);
    }
}
