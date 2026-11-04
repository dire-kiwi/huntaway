//! Subscription usage (session and weekly limits) for each Claude config. Codex configs get
//! theirs from `codex app-server` (see agent/codex.rs).
//!
//! Two sources feed it: Anthropic's OAuth usage endpoint (what `/usage` in Claude Code shows),
//! called with the config's own login, and the `rate_limit_event`s agents print as they run.
//! The login is only read, never refreshed: refreshing rotates the token underneath any
//! `claude` running with the config. An expired login refreshes on the config's next run.
//!
//! Only configs with `show_usage` turned on are fetched and listed. The endpoint's rate limit is
//! per account, and every host with a copy of the login (PR previews, test servers) would
//! otherwise poll it too.
//!
//! A config with a proxy (CLIProxyAPI, see `ClaudeConfig::api_url`) pools several logins, none of
//! them in its directory. Its usage is each of the proxy's Claude accounts' (asked for through
//! the proxy's management API, with each account's own token, see `fetch_proxy`), and its limits
//! are the pool's: each limit's average over the accounts, resetting when the first of them does
//! (see `pool_limits`). Its runs' `rate_limit_event`s are about whichever account served them, so
//! they don't change its limits, only whether it's out (the proxy only passes a refusal on once
//! every account it could try has refused).
//!
//! A config is *out* when a run on it was refused for its usage limit (Claude Code's
//! `rate_limit_event` with status `rejected`, Codex's `usageLimitExceeded`), until that limit
//! resets. Usage at 100% alone doesn't make it out: a plan with extra usage carries on past it.
//! A run that stops on its limit leaves the reset on its task (`Task::limit_reset_at`), and its
//! profile's `limit_wait` and `limit_switch` say what the board does about it (see `before_run`
//! and `resume_loop`).

use std::time::{Duration, Instant};

use axum::Json;
use axum::extract::{Path, Query, State};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::db;
use crate::state::{ApiError, ApiResult, Shared};
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
    /// Until when the config is out of usage (API 81): when the limit a run on it was refused
    /// for resets. Kept in memory, so a restart forgets it until a run is refused again.
    pub out_until: Option<String>,
    /// For a config with a proxy (API 106): each of the proxy's Claude accounts, whose limits
    /// `limits` pools. Left out for other configs.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub accounts: Option<Vec<Account>>,
    #[serde(skip)]
    fetched: Option<Instant>,
}

/// One of a proxy's Claude accounts (API 106).
#[derive(Serialize, Clone, Debug, Default, PartialEq)]
pub struct Account {
    /// Its email, or the proxy's name for it.
    pub name: String,
    pub limits: Vec<Limit>,
    /// Why its usage couldn't be read, or why the proxy isn't using it.
    pub error: Option<String>,
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

/// Fetch the config's usage now: whether that worked (the last numbers stay if it didn't).
pub async fn refresh(s: &Shared, config: &db::ClaudeConfig) -> bool {
    let (config_id, config_dir) = (config.id.as_str(), config.config_dir.as_str());
    let mut accounts = None;
    let result = if let Some(url) = config.proxy() {
        fetch_proxy(url, config.management_key.as_deref()).await.map(|a| {
            let pooled = (Some(format!("{} account{}", a.len(), if a.len() == 1 { "" } else { "s" })), pool_limits(&a));
            accounts = Some(a);
            pooled
        })
    } else if config.is_codex() {
        #[cfg(test)]
        let r = TEST_CODEX.with_borrow(|r| r.clone()).ok_or("no codex in tests".to_string()).map(|rl| (None, crate::agent::codex::limits(&rl)));
        #[cfg(not(test))]
        let r = crate::agent::codex::rate_limits(config.dir()).await;
        r
    } else {
        fetch(config_dir).await
    };
    let mut cache = s.usage.lock().unwrap();
    let u = cache.entry(config_id.to_string()).or_insert_with(|| Usage { config_id: config_id.to_string(), ..Default::default() });
    u.fetched = Some(Instant::now());
    match result {
        Ok((plan, limits)) => {
            // A fresh fetch is the whole picture: drop limits it no longer reports.
            u.limits.clear();
            u.merge(limits);
            u.plan = plan;
            u.accounts = accounts;
            u.updated_at = Some(crate::util::now());
            u.error = None;
            true
        }
        Err(e) => {
            tracing::debug!(config = config_id, "usage fetch failed: {e}");
            u.error = Some(e);
            false
        }
    }
}

/// The config's session (5-hour) limit as last seen: None when its usage has none, else when it
/// resets (None when that isn't known, as when no window is running).
pub fn session_reset(s: &Shared, config_id: &str) -> Option<Option<chrono::DateTime<chrono::Utc>>> {
    let cache = s.usage.lock().unwrap();
    let limit = cache.get(config_id)?.limits.iter().find(|l| l.id == "session")?;
    Some(limit.resets_at.as_deref().and_then(parse_time))
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

/// The usage of each Claude account of the CLIProxyAPI at `url`, read through its management API
/// with `key`: its credentials, then Anthropic's usage endpoint for each with the account's own
/// token (`requests/api-call`, which puts the token in for `$TOKEN$`), all at once.
async fn fetch_proxy(url: &str, key: Option<&str>) -> Result<Vec<Account>, String> {
    let key = key.filter(|k| !k.trim().is_empty()).ok_or("Add the proxy's management key to this config to see its accounts' usage")?;
    let base = format!("{}/v8/management", url.trim_end_matches('/'));
    let v = proxy_json(http().get(format!("{base}/credentials")).bearer_auth(key)).await?;
    let claude: Vec<&Value> = v["files"].as_array().into_iter().flatten().filter(|c| c["provider"] == "claude" && c["disabled"] != true).collect();
    let accounts = futures::future::join_all(claude.iter().map(|c| account_usage(&base, key, c))).await;
    Ok(accounts)
}

async fn account_usage(base: &str, key: &str, cred: &Value) -> Account {
    let field = |k: &str| cred[k].as_str().map(str::trim).filter(|t| !t.is_empty());
    let name = field("email").or(field("label")).or(field("name")).unwrap_or("Claude account").to_string();
    // A number in some versions.
    let index = match &cred["auth_index"] {
        Value::String(t) => t.clone(),
        v => v.to_string(),
    };
    let body = json!({
        "auth_index": index,
        "method": "GET",
        "url": USAGE_URL,
        "header": {"Authorization": "Bearer $TOKEN$", "anthropic-beta": "oauth-2025-04-20"},
    });
    let (limits, mut error) = match proxy_json(http().post(format!("{base}/requests/api-call")).bearer_auth(key).json(&body)).await {
        Ok(r) if r["status_code"].as_u64() == Some(200) => match serde_json::from_str::<Value>(r["body"].as_str().unwrap_or("")) {
            Ok(v) => (parse_limits(&v), None),
            Err(e) => (vec![], Some(format!("Bad usage response: {e}"))),
        },
        Ok(r) => {
            let msg = serde_json::from_str::<Value>(r["body"].as_str().unwrap_or("")).ok().and_then(|v| v["error"]["message"].as_str().map(String::from));
            (vec![], Some(format!("Usage request failed ({}){}", r["status_code"], msg.map(|m| format!(": {m}")).unwrap_or_default())))
        }
        Err(e) => (vec![], Some(e)),
    };
    // What the proxy says about it, when it isn't using it (a cooldown, a login that needs renewing).
    if cred["unavailable"] == true && error.is_none() {
        error = Some(field("status_message").map(|m| format!("Unavailable: {m}")).unwrap_or_else(|| "Unavailable".into()));
    }
    Account { name, limits, error }
}

/// A management API request's JSON, or why there's none.
async fn proxy_json(req: reqwest::RequestBuilder) -> Result<Value, String> {
    let res = req.send().await.map_err(|e| format!("Proxy request failed: {e}"))?;
    let status = res.status();
    let body = res.text().await.unwrap_or_default();
    let v: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
    if !status.is_success() {
        let msg = v["error"].as_str().map(String::from).unwrap_or_else(|| body.chars().take(200).collect());
        let hint = if msg.contains("remote management disabled") { " (set management.allow-remote: true in its config.yaml)" } else { "" };
        return Err(format!("Proxy request failed ({status}): {msg}{hint}"));
    }
    if v.is_null() {
        return Err("Bad response from the proxy".into());
    }
    Ok(v)
}

/// A pool's limits from its accounts': for each limit, the average of the accounts that report it
/// (how much of the pool's room is used, for accounts on the same plan), resetting when the first
/// of them does (when some room comes back). Accounts without numbers are left out.
fn pool_limits(accounts: &[Account]) -> Vec<Limit> {
    let mut out: Vec<Limit> = vec![];
    let mut counts: Vec<usize> = vec![];
    for l in accounts.iter().flat_map(|a| &a.limits) {
        match out.iter().position(|x| x.id == l.id) {
            Some(i) => {
                out[i].percent += l.percent;
                counts[i] += 1;
                let soonest = match (&out[i].resets_at, &l.resets_at) {
                    (Some(a), Some(b)) => [a, b].into_iter().min_by_key(|t| parse_time(t)).cloned(),
                    (a, b) => a.clone().or(b.clone()),
                };
                out[i].resets_at = soonest;
            }
            None => {
                out.push(l.clone());
                counts.push(1);
            }
        }
    }
    for (l, n) in out.iter_mut().zip(counts) {
        l.percent = (l.percent / n as f64 * 10.0).round() / 10.0;
    }
    out
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

/// A `rate_limit_event` from an agent run with `config_id`: update its session and weekly limits,
/// and whether it's out of usage.
pub fn on_rate_limit_event(s: &Shared, config_id: &str, v: &Value) {
    on_rate_limit(s, config_id, v, true);
}

/// The same for a run through a proxy: only whether it's out, as its limits are one account's.
pub fn on_proxy_rate_limit_event(s: &Shared, config_id: &str, v: &Value) {
    on_rate_limit(s, config_id, v, false);
}

fn on_rate_limit(s: &Shared, config_id: &str, v: &Value, windows: bool) {
    let info = &v["rate_limit_info"];
    // A plan with extra usage reports its used-up limit as rejected while its turns go on, on
    // the extra usage (as Claude Code works out `isUsingOverage`).
    let overage = info["isUsingOverage"] == true || matches!(info["overageStatus"].as_str(), Some("allowed" | "allowed_warning"));
    match info["status"].as_str() {
        Some("rejected") if !overage => set_out(s, config_id, info["resetsAt"].as_i64().and_then(timestamp)),
        // Allowed again (or on extra usage), whatever said it was out before.
        Some(_) => set_out(s, config_id, None),
        None => {}
    }
    if !windows {
        return;
    }
    let windows = &info["unifiedWindows"];
    let mut limits = vec![];
    for (key, id, label) in [("five_hour", "session", "Session"), ("seven_day", "weekly", "Weekly")] {
        let w = &windows[key];
        let Some(util) = w["utilization"].as_f64() else { continue };
        let resets_at = w["resetsAt"].as_i64().and_then(|t| chrono::DateTime::from_timestamp(t, 0)).map(|t| t.to_rfc3339());
        limits.push(Limit { id: id.into(), label: label.into(), percent: (util * 1000.0).round() / 10.0, resets_at });
    }
    set_limits(s, config_id, limits, None);
}

/// A Unix time, as the board writes times that are compared as text (`limit_reset_at`).
fn timestamp(t: i64) -> Option<String> {
    chrono::DateTime::from_timestamp(t, 0).map(|t| t.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
}

fn parse_time(t: &str) -> Option<chrono::DateTime<chrono::Utc>> {
    chrono::DateTime::parse_from_rfc3339(t).ok().map(|t| t.with_timezone(&chrono::Utc))
}

/// Mark `config_id` out of usage until `until` (None: not out), telling the board if that changes.
fn set_out(s: &Shared, config_id: &str, until: Option<String>) {
    let usage = {
        let mut cache = s.usage.lock().unwrap();
        if until.is_none() && cache.get(config_id).is_none_or(|u| u.out_until.is_none()) {
            return;
        }
        let u = cache.entry(config_id.to_string()).or_insert_with(|| Usage { config_id: config_id.to_string(), ..Default::default() });
        if u.out_until == until {
            return;
        }
        u.out_until = until;
        u.clone()
    };
    s.emit(json!({"type": "usage", "usage": usage}));
}

/// When `config_id` is out of usage until, if it is now.
pub fn out_until(s: &Shared, config_id: &str) -> Option<String> {
    let cache = s.usage.lock().unwrap();
    let until = cache.get(config_id)?.out_until.clone()?;
    parse_time(&until).is_some_and(|t| t > chrono::Utc::now()).then_some(until)
}

/// A Codex turn on `config_id` failed with `usageLimitExceeded`. Codex doesn't say which limit,
/// so it's out until the latest reset of the limits it last reported as used up.
pub fn codex_refused(s: &Shared, config_id: &str) {
    let until = {
        let cache = s.usage.lock().unwrap();
        let limits = cache.get(config_id).map(|u| u.limits.clone()).unwrap_or_default();
        limits.iter().filter(|l| l.percent >= 100.0).filter_map(|l| parse_time(l.resets_at.as_deref()?)).max()
    };
    if let Some(t) = until {
        set_out(s, config_id, Some(t.to_rfc3339_opts(chrono::SecondsFormat::Secs, true)));
    }
}

/// A run of `task_id` on `config_id` stopped because the config is out of usage: note on the
/// task when the limit resets, for `finish` to act on as the run ends (see runner::finish).
/// Nothing is noted when the reset isn't known (or is past), and the run just fails.
pub fn ran_out(s: &Shared, task_id: &str, config_id: &str) {
    if let Some(until) = out_until(s, config_id) {
        let _ = s.update_task(task_id, &[("limit_reset_at", json!(until))]);
    }
}

/// Whether a reset noted as `limit_reset_at` has come. A minute late, for clocks that disagree.
pub fn reset_due(limit_reset_at: &str) -> bool {
    parse_time(limit_reset_at).is_none_or(|t| t + chrono::Duration::minutes(1) <= chrono::Utc::now())
}

/// Before a run of `task` (not running) starts with `message`: if its config is out of usage,
/// start a task that hasn't run yet on the next config with room (`limit_switch`), or queue it
/// until the limit resets (`limit_wait`). Returns the task if it's been queued.
pub fn before_run(s: &Shared, task: &db::Task, message: Option<db::Queued>) -> ApiResult<Option<db::Task>> {
    // Already waiting for a reset (by itself or when asked, see `wait_for_reset`): a message
    // joins the queue, whatever the profile's settings and even if a restart has forgotten
    // that the config is out.
    if let Some(until) = task.limit_reset_at.as_deref().filter(|t| task.waiting && !reset_due(t)) {
        let config = db::task_claude_config(&s.db(), task)?.map(|c| c.name).unwrap_or_else(|| "its config".into());
        return Ok(Some(crate::agent::runner::wait_for_limit(s, task, &config, until, message)?));
    }
    let (profile, config, project) = {
        let c = s.db();
        let Some(profile) = db::get_profile(&c, &task.profile_id)? else { return Ok(None) };
        if !profile.limit_wait && !profile.limit_switch {
            return Ok(None);
        }
        let Some(config) = db::task_claude_config(&c, task)? else { return Ok(None) };
        let project = task.project_id.as_deref().map(|p| db::get_project(&c, p)).transpose()?.flatten();
        (profile, config, project)
    };
    let Some(until) = out_until(s, &config.id) else { return Ok(None) };
    if profile.limit_switch && task.session_id.is_none() {
        // Another of its configs with the same agent, so its model and effort still apply.
        let others = db::available_configs(&s.db(), &task.profile_id, project.as_ref())?;
        let agent = if config.is_codex() { "codex" } else { "claude" };
        let next = others.into_iter().find(|c| c.id != config.id && c.is_codex() == config.is_codex() && out_until(s, &c.id).is_none());
        if let Some(next) = next.filter(|_| crate::agent::runs::has_agent(agent)) {
            // Only while it still hasn't started: its conversation stays in the config it starts in.
            let moved = s.update_task_if(&task.id, &[("claude_config_id", json!(next.id))], |c| {
                Ok(db::get_task(c, &task.id)?.is_some_and(|t| t.session_id.is_none()) && !db::has_active_run(c, &task.id)?)
            })?;
            if moved.is_some() {
                s.add_event(&task.id, "info", format!("Starting on {} instead: {} is out of usage", next.name, config.name), Some(format!("{} resets at {until}", config.name)));
                return Ok(None);
            }
        }
    }
    if !profile.limit_wait {
        return Ok(None);
    }
    let t = crate::agent::runner::wait_for_limit(s, task, &config.name, &until, message)?;
    Ok(Some(t))
}

/// `POST /tasks/{id}/wait-for-limit` (API 81): a task whose agent stopped because its config ran
/// out of usage waits in "In progress" for the limit to reset, and its agent carries on then.
pub async fn wait_for_reset(State(s): State<Shared>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let task = db::get_task(&s.db(), &id)?.ok_or_else(|| ApiError::not_found("task"))?;
    if task.kind != "task" {
        return Err(ApiError::bad("only tasks can wait for a usage limit to reset"));
    }
    // Out of the merge queue's slot while it waited, another merge could start alongside it.
    if task.merging {
        return Err(ApiError::conflict("a merge can't wait for a usage limit to reset, as it would give up its place in the merge queue; message its agent once the limit has reset"));
    }
    let Some(until) = task.limit_reset_at.clone().filter(|t| !reset_due(t)) else {
        return Err(ApiError::conflict("its agent isn't out of usage (or the limit has reset already)"));
    };
    if s.is_running(&id) {
        return Err(ApiError::conflict("its agent is running"));
    }
    let config = db::task_claude_config(&s.db(), &task)?.map(|c| c.name).unwrap_or_else(|| "its config".into());
    Ok(Json(json!(crate::agent::runner::wait_for_limit(&s, &task, &config, &until, None)?)))
}

/// Background loop: carry on with the tasks waiting for a usage limit to reset, once it has.
pub fn resume_loop(s: &Shared) {
    let s = s.clone();
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(30));
        loop {
            tick.tick().await;
            let due = {
                let c = s.db();
                let held: rusqlite::Result<Vec<String>> = c
                    .prepare("SELECT limit_reset_at FROM tasks WHERE waiting=1 AND limit_reset_at IS NOT NULL")
                    .and_then(|mut st| st.query_map([], |r| r.get(0))?.collect());
                held.unwrap_or_default().iter().any(|t| reset_due(t))
            };
            if due {
                crate::agent::runner::start_unblocked(&s, None);
            }
        }
    });
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
thread_local! {
    /// Stands in for `codex app-server`'s `rateLimits` in tests (an error for None).
    pub static TEST_CODEX: std::cell::RefCell<Option<Value>> = const { std::cell::RefCell::new(None) };
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
            let dir = crate::testing::temp_dir().join("claude");
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
    fn a_refused_run_marks_its_config_out_until_the_reset() {
        crate::testing::run(async || {
            let s = crate::testing::state();
            let soon = chrono::Utc::now().timestamp() + 600;
            let event = |status: &str| json!({"type": "rate_limit_event", "rate_limit_info": {"status": status, "resetsAt": soon, "unifiedWindows": {"five_hour": {"utilization": 1, "resetsAt": soon}}}});
            on_rate_limit_event(&s, "c", &event("allowed_warning"));
            assert_eq!(out_until(&s, "c"), None, "at 100% on extra usage, it isn't out");
            on_rate_limit_event(&s, "c", &event("rejected"));
            assert_eq!(out_until(&s, "c"), timestamp(soon));
            assert_eq!(s.usage.lock().unwrap()["c"].limits[0].percent, 100.0);
            // Allowed again (extra usage bought, say).
            on_rate_limit_event(&s, "c", &event("allowed"));
            assert_eq!(out_until(&s, "c"), None);
            // Rejected, but carrying on with extra usage (as a plan with it enabled reports every turn).
            on_rate_limit_event(&s, "c", &event("rejected"));
            let overage = json!({"rate_limit_info": {"status": "rejected", "resetsAt": soon, "overageStatus": "allowed", "isUsingOverage": true}});
            on_rate_limit_event(&s, "c", &overage);
            assert_eq!(out_until(&s, "c"), None, "extra usage clears it");
            on_rate_limit_event(&s, "d", &overage);
            assert_eq!(out_until(&s, "d"), None);
            on_rate_limit_event(&s, "d", &json!({"rate_limit_info": {"status": "rejected", "resetsAt": soon, "overageStatus": "allowed_warning"}}));
            assert_eq!(out_until(&s, "d"), None);
            // A reset that's past isn't out.
            on_rate_limit_event(&s, "c", &json!({"rate_limit_info": {"status": "rejected", "resetsAt": soon - 1200}}));
            assert_eq!(out_until(&s, "c"), None);

            // Codex doesn't say which limit: the latest reset of those used up.
            let at = |t: i64| chrono::DateTime::from_timestamp(t, 0).unwrap().to_rfc3339();
            let lim = |id: &str, p: f64, t: i64| Limit { id: id.into(), label: id.into(), percent: p, resets_at: Some(at(t)) };
            set_limits(&s, "x", vec![lim("session", 100.0, soon), lim("weekly", 100.0, soon + 60), lim("weekly:x", 50.0, soon + 999)], None);
            codex_refused(&s, "x");
            assert_eq!(out_until(&s, "x"), timestamp(soon + 60));
            set_limits(&s, "y", vec![lim("session", 50.0, soon)], None);
            codex_refused(&s, "y");
            assert_eq!(out_until(&s, "y"), None, "no reset known");
        })
    }

    #[test]
    fn a_proxied_run_s_rate_limits_only_mark_it_out() {
        crate::testing::run(async || {
            let s = crate::testing::state();
            let soon = chrono::Utc::now().timestamp() + 600;
            set_limits(&s, "p", vec![Limit { id: "session".into(), label: "Session".into(), percent: 20.0, resets_at: None }], None);
            let event = |status: &str| json!({"rate_limit_info": {"status": status, "resetsAt": soon, "unifiedWindows": {"five_hour": {"utilization": 0.9, "resetsAt": soon}}}});
            // One account's numbers aren't the pool's.
            on_proxy_rate_limit_event(&s, "p", &event("allowed"));
            assert_eq!(s.usage.lock().unwrap()["p"].limits[0].percent, 20.0);
            // A refusal the proxy passed on: every account it could try refused.
            on_proxy_rate_limit_event(&s, "p", &event("rejected"));
            assert_eq!(out_until(&s, "p"), timestamp(soon));
            assert_eq!(s.usage.lock().unwrap()["p"].limits[0].percent, 20.0);
            on_proxy_rate_limit_event(&s, "p", &event("allowed"));
            assert_eq!(out_until(&s, "p"), None);
        })
    }

    #[test]
    fn a_pool_s_limits_are_its_accounts_averaged_resetting_with_the_first() {
        let lim = |id: &str, p: f64, at: Option<&str>| Limit { id: id.into(), label: id.into(), percent: p, resets_at: at.map(String::from) };
        let acct = |limits| Account { name: "a".into(), limits, error: None };
        let accounts = [
            acct(vec![lim("session", 100.0, Some("2026-11-04T10:00:00Z")), lim("weekly", 40.0, Some("2026-11-09T00:00:00Z"))]),
            acct(vec![lim("session", 30.0, Some("2026-11-04T08:30:00+00:00")), lim("weekly", 20.0, None), lim("weekly:opus", 5.0, None)]),
            // Its usage couldn't be read: it counts for nothing.
            Account { name: "b".into(), limits: vec![], error: Some("no".into()) },
        ];
        assert_eq!(
            pool_limits(&accounts),
            vec![
                lim("session", 65.0, Some("2026-11-04T08:30:00+00:00")),
                lim("weekly", 30.0, Some("2026-11-09T00:00:00Z")),
                lim("weekly:opus", 5.0, None)
            ]
        );
        assert_eq!(pool_limits(&[]), vec![]);
    }

    /// A CLIProxyAPI's management API with two Claude accounts (one whose usage fails), a Codex one
    /// and a disabled one, answering only `key`. Its address, and the requests it got.
    async fn fake_proxy(key: &'static str) -> (String, std::sync::Arc<std::sync::Mutex<Vec<Value>>>) {
        use axum::http::{HeaderMap, StatusCode};
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::<Value>::new()));
        let authed = move |h: &HeaderMap| h.get("authorization").and_then(|v| v.to_str().ok()) == Some(&format!("Bearer {key}"));
        let creds = move |h: HeaderMap| async move {
            if !authed(&h) {
                return (StatusCode::UNAUTHORIZED, Json(json!({"error": "invalid management key"})));
            }
            (StatusCode::OK, Json(json!({"files": [
                {"auth_index": "a1", "provider": "claude", "email": "one@example.com", "name": "claude-one.json", "disabled": false},
                {"auth_index": 2, "provider": "claude", "name": "claude-two.json", "unavailable": true, "status_message": "cooling down"},
                {"auth_index": "c1", "provider": "codex", "email": "codex@example.com"},
                {"auth_index": "d1", "provider": "claude", "email": "off@example.com", "disabled": true},
            ]})))
        };
        let log = seen.clone();
        let call = move |h: HeaderMap, Json(b): Json<Value>| {
            let log = log.clone();
            async move {
                if !authed(&h) {
                    return (StatusCode::UNAUTHORIZED, Json(json!({"error": "invalid management key"})));
                }
                log.lock().unwrap().push(b.clone());
                let usage = json!({"five_hour": {"utilization": 40.0, "resets_at": "2026-11-04T10:00:00Z"}, "seven_day": {"utilization": 10.0, "resets_at": null}});
                let res = match b["auth_index"].as_str() {
                    Some("a1") => json!({"status_code": 200, "header": {}, "body": usage.to_string()}),
                    _ => json!({"status_code": 401, "header": {}, "body": json!({"error": {"message": "token expired"}}).to_string()}),
                };
                (StatusCode::OK, Json(res))
            }
        };
        let app = axum::Router::new()
            .route("/v8/management/credentials", axum::routing::get(creds))
            .route("/v8/management/requests/api-call", axum::routing::post(call));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (format!("http://{addr}/"), seen)
    }

    #[test]
    fn a_proxy_config_s_usage_is_its_claude_accounts() {
        crate::testing::run(async || {
            let s = crate::testing::state();
            let (url, seen) = fake_proxy("mk").await;
            let cfg = {
                let c = s.db();
                let cfg = db::insert_claude_config(&c, "pool", "", "claude").unwrap();
                db::update_claude_config(&c, &cfg.id, &[("show_usage", json!(true)), ("api_url", json!(url)), ("api_key", json!("k"))]).unwrap().unwrap()
            };
            // Without the management key, it says what's missing (and doesn't read ~/.claude's login).
            assert!(!refresh(&s, &cfg).await);
            assert!(s.usage.lock().unwrap()[&cfg.id].error.as_deref().unwrap().contains("management key"), "{:?}", s.usage.lock().unwrap()[&cfg.id].error);
            let wrong = db::update_claude_config(&s.db(), &cfg.id, &[("management_key", json!("nope"))]).unwrap().unwrap();
            assert!(!refresh(&s, &wrong).await);
            assert!(s.usage.lock().unwrap()[&cfg.id].error.as_deref().unwrap().contains("401"));

            let cfg = db::update_claude_config(&s.db(), &cfg.id, &[("management_key", json!("mk"))]).unwrap().unwrap();
            assert!(refresh(&s, &cfg).await);
            let u = s.usage.lock().unwrap()[&cfg.id].clone();
            assert_eq!(u.error, None);
            assert_eq!(u.plan.as_deref(), Some("2 accounts"));
            let accounts = u.accounts.unwrap();
            assert_eq!(accounts.iter().map(|a| a.name.as_str()).collect::<Vec<_>>(), ["one@example.com", "claude-two.json"]);
            assert_eq!(accounts[0].limits.iter().map(|l| (l.id.as_str(), l.percent)).collect::<Vec<_>>(), [("session", 40.0), ("weekly", 10.0)]);
            assert_eq!(accounts[1].limits, vec![]);
            assert_eq!(accounts[1].error.as_deref(), Some("Usage request failed (401): token expired"));
            // The pool is the accounts that have numbers.
            assert_eq!(u.limits.iter().map(|l| (l.id.as_str(), l.percent)).collect::<Vec<_>>(), [("session", 40.0), ("weekly", 10.0)]);
            // Each account's usage was asked for with its own token, by the proxy.
            let seen = seen.lock().unwrap().clone();
            assert_eq!(seen.len(), 2);
            assert_eq!(seen[0]["url"], USAGE_URL);
            assert_eq!(seen[0]["header"]["Authorization"], "Bearer $TOKEN$");
            assert_eq!(seen.iter().map(|b| b["auth_index"].as_str().unwrap().to_string()).collect::<Vec<_>>(), ["a1", "2"]);
            // It's sent to the board with the accounts.
            let v = serde_json::to_value(&s.usage.lock().unwrap()[&cfg.id]).unwrap();
            assert_eq!(v["accounts"][1]["name"], "claude-two.json");
        })
    }

    #[test]
    fn a_reset_is_due_a_minute_after() {
        let at = |secs: i64| (chrono::Utc::now() + chrono::Duration::seconds(secs)).to_rfc3339();
        assert!(!reset_due(&at(60)));
        assert!(!reset_due(&at(-30)));
        assert!(reset_due(&at(-61)));
    }

    #[test]
    fn merge_keeps_unmentioned_limits() {
        let lim = |id: &str, p: f64| Limit { id: id.into(), label: id.into(), percent: p, resets_at: None };
        let mut u = Usage { limits: vec![lim("weekly:fable", 3.0), lim("session", 10.0)], ..Default::default() };
        u.merge(vec![lim("weekly", 50.0), lim("session", 12.0)]);
        assert_eq!(u.limits, vec![lim("session", 12.0), lim("weekly", 50.0), lim("weekly:fable", 3.0)]);
    }
}
