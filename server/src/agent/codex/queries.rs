//! One-off queries to Codex: task titles, models, skills and rate limits.

use super::*;
use crate::agent::tokens::calls::Spent;

/// A short-lived title query using this config's model and login, without a task session.
pub async fn task_title(codex_home: &str, cwd: &Path, instructions: &str, input: &str, spent: &mut Option<Spent>) -> Result<String> {
    let mut rpc = Rpc::start(Some(codex_home), cwd)?;
    let work = async {
        rpc.initialize().await?;
        // Config overrides merge maps, so an empty map alone would keep the user's servers.
        let config = rpc.request("config/read", json!({"includeLayers": false, "cwd": crate::util::path_str(cwd)})).await?;
        let servers: Map<String, Value> = config["config"]["mcp_servers"].as_object().into_iter().flatten()
            .map(|(name, _)| (name.clone(), json!({"enabled": false}))).collect();
        let started = rpc.request("thread/start", json!({
            "cwd": crate::util::path_str(cwd), "ephemeral": true,
            "approvalPolicy": "never", "sandbox": "read-only",
            "baseInstructions": instructions, "developerInstructions": "",
            "config": {"mcp_servers": servers, "project_doc_max_bytes": 0, "web_search": "disabled",
                "features.shell_tool": false, "features.apply_patch_freeform": false, "features.multi_agent": false, "features.apps": false},
        })).await?;
        let thread = started["thread"]["id"].as_str().context("no title thread id")?;
        let model = started["model"].as_str().filter(|m| !m.is_empty()).unwrap_or("codex").to_string();
        rpc.request("turn/start", json!({"threadId": thread, "effort": "low",
            "input": [{"type": "text", "text": input, "text_elements": []}]})).await?;
        let mut title = String::new();
        while let Some(msg) = rpc.incoming.recv().await {
            if let Some(id) = msg.get("id") {
                // A title never needs tools or approvals.
                rpc.sender().error(id, "Tools are unavailable while writing a task title");
                continue;
            }
            let p = &msg["params"];
            if p["threadId"].as_str() != Some(thread) { continue }
            match msg["method"].as_str() {
                // Its thread's totals so far (see agent/tokens/calls.rs). Codex (0.166) sends the
                // last of them just before `turn/completed`, and nothing for the thread after it.
                Some("thread/tokenUsage/updated") => *spent = Some(Spent::codex(&model, &p["tokenUsage"])),
                Some("item/completed") if p["item"]["type"] == "agentMessage" => {
                    title = p["item"]["text"].as_str().unwrap_or("").to_string();
                }
                Some("turn/completed") => {
                    if p["turn"]["status"] != "completed" {
                        bail!("codex title turn failed: {}", p["turn"]);
                    }
                    return Ok(title);
                }
                _ => {}
            }
        }
        bail!("codex app-server exited before writing a title")
    };
    tokio::time::timeout(Duration::from_secs(60), work).await.context("codex title timed out")?
}

/// Run a few requests against a short-lived app-server for the config at `codex_home`.
async fn query(codex_home: &str, requests: &[(&str, Value)]) -> Result<Vec<Value>> {
    let rpc = Rpc::start(Some(codex_home), &std::env::temp_dir())?;
    let work = async {
        rpc.initialize().await?;
        let mut out = Vec::new();
        for (m, p) in requests {
            out.push(rpc.request(m, p.clone()).await?);
        }
        Ok::<_, anyhow::Error>(out)
    };
    tokio::time::timeout(Duration::from_secs(20), work).await.map_err(|_| anyhow!("codex app-server didn't answer"))?
}

#[derive(Serialize, Clone, Debug)]
pub struct Model {
    pub id: String,
    pub name: String,
    pub is_default: bool,
    pub efforts: Vec<String>,
    pub default_effort: Option<String>,
}

static MODELS: std::sync::Mutex<Option<HashMap<String, (Instant, Vec<Model>)>>> = std::sync::Mutex::new(None);

/// The models a Codex config can use (cached for 10 minutes).
pub async fn models(codex_home: &str) -> Result<Vec<Model>> {
    if let Some((at, m)) = MODELS.lock().unwrap().get_or_insert_default().get(codex_home) {
        if at.elapsed() < Duration::from_secs(600) {
            return Ok(m.clone());
        }
    }
    let r = query(codex_home, &[("model/list", json!({}))]).await?;
    let list: Vec<Model> = r[0]["data"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|m| m["hidden"] != true)
        .map(|m| Model {
            id: m["model"].as_str().or(m["id"].as_str()).unwrap_or("").to_string(),
            name: m["displayName"].as_str().or(m["model"].as_str()).unwrap_or("").to_string(),
            is_default: m["isDefault"] == true,
            efforts: m["supportedReasoningEfforts"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|e| e["reasoningEffort"].as_str().map(String::from))
                .collect(),
            default_effort: m["defaultReasoningEffort"].as_str().map(String::from),
        })
        .filter(|m| !m.id.is_empty())
        .collect();
    MODELS.lock().unwrap().get_or_insert_default().insert(codex_home.to_string(), (Instant::now(), list.clone()));
    Ok(list)
}

/// Lists `models` for a Codex config, as if its app-server had (for tests).
#[cfg(test)]
pub fn set_test_models(codex_home: &str, models: Vec<Model>) {
    MODELS.lock().unwrap().get_or_insert_default().insert(codex_home.to_string(), (Instant::now(), models));
}

type SkillCache = HashMap<(String, Option<PathBuf>), (Instant, Vec<crate::agent::agent_tools::TaskSkill>)>;
static SKILLS: std::sync::Mutex<Option<SkillCache>> = std::sync::Mutex::new(None);

/// The skills a Codex config has in a working directory, for the composer (cached for a minute).
pub async fn skills(codex_home: &str, cwd: Option<&Path>) -> Result<Vec<crate::agent::agent_tools::TaskSkill>> {
    let key = (codex_home.to_string(), cwd.map(Path::to_path_buf));
    if let Some((at, s)) = SKILLS.lock().unwrap().get_or_insert_default().get(&key) {
        if at.elapsed() < Duration::from_secs(60) {
            return Ok(s.clone());
        }
    }
    let cwds: Vec<String> = cwd.map(path_str).into_iter().collect();
    let r = query(codex_home, &[("skills/list", json!({"cwds": cwds}))]).await?;
    let list: Vec<_> = r[0]["data"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|e| e["skills"].as_array().into_iter().flatten())
        .filter(|s| s["enabled"] != false)
        .filter_map(|s| {
            let description = s["shortDescription"].as_str().filter(|d| !d.is_empty()).or(s["description"].as_str()).unwrap_or("");
            Some(crate::agent::agent_tools::TaskSkill { name: s["name"].as_str()?.to_string(), description: description.to_string() })
        })
        .collect();
    SKILLS.lock().unwrap().get_or_insert_default().insert(key, (Instant::now(), list.clone()));
    Ok(list)
}

/// The account's plan and rate limits, for the usage page.
#[cfg_attr(test, allow(dead_code))]
pub async fn rate_limits(codex_home: &str) -> Result<(Option<String>, Vec<crate::agent::usage::Limit>), String> {
    let r = query(codex_home, &[("account/rateLimits/read", Value::Null)]).await.map_err(|e| format!("{e:#}"))?;
    let rl = &r[0]["rateLimits"];
    Ok((rl["planType"].as_str().map(String::from), limits(rl)))
}

/// Codex's windows, told apart by their length (`windowDurationMins`), as Codex's own status
/// does: 5 hours is the session one and a week the weekly one, whichever of `primary` and
/// `secondary` has it (a weekly-only plan's `primary` is weekly). Without a length, `primary` is
/// the session and `secondary` the weekly one; another length is named by it.
pub fn limits(rl: &Value) -> Vec<crate::agent::usage::Limit> {
    let mut out: Vec<crate::agent::usage::Limit> = Vec::new();
    for (key, default_id) in [("primary", "session"), ("secondary", "weekly")] {
        let w = &rl[key];
        let Some(used) = w["usedPercent"].as_f64() else { continue };
        let (id, label) = match w["windowDurationMins"].as_i64() {
            None if default_id == "session" => ("session".to_string(), "Session".to_string()),
            None => ("weekly".to_string(), "Weekly".to_string()),
            Some(300) => ("session".to_string(), "Session".to_string()),
            Some(10080) => ("weekly".to_string(), "Weekly".to_string()),
            Some(m) if m % 1440 == 0 => (format!("window:{m}"), format!("{}-day", m / 1440)),
            Some(m) if m % 60 == 0 => (format!("window:{m}"), format!("{}-hour", m / 60)),
            Some(m) => (format!("window:{m}"), format!("{m}-minute")),
        };
        if out.iter().any(|l| l.id == id) {
            continue;
        }
        let resets_at = w["resetsAt"].as_i64().and_then(|t| chrono::DateTime::from_timestamp(t, 0)).map(|t| t.to_rfc3339());
        out.push(crate::agent::usage::Limit { id, label, percent: used, resets_at });
    }
    out
}
