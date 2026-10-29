//! Skills and MCP servers for agents, global or per project.
//!
//! The host keeps skills (a `SKILL.md` each) and MCP servers outside any repository: global
//! ones, which each profile switches on or off by default and each project can override, and a
//! project's own. Before each run the skills that are on are written to
//! `<data>/projects/<id>/agent/.claude/skills/<name>/SKILL.md`, which the agent gets with
//! `--add-dir` (Claude Code loads `.claude/skills` from added directories), and the servers go
//! into the run's `--mcp-config` next to the board's own.
//!
//! Skills and servers that come from elsewhere (the Claude config, its plugins, claude.ai
//! connectors, the repository) can be turned off per project: they're denied with
//! `--disallowedTools Skill(<name>)` / `mcp__<server>`. To list them, each run's `init`
//! message records what the agent had, per Claude config ("seen").

use std::path::{Path as FsPath, PathBuf};

use axum::Json;
use axum::extract::{Path, State};
use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::runner::MCP_SERVER_NAME;
use crate::state::{ApiError, ApiResult, Shared};
use crate::util::{new_id, now};

#[derive(Serialize, Clone, Debug)]
pub struct Skill {
    pub id: String,
    /// None for a global skill.
    pub project_id: Option<String>,
    pub name: String,
    pub description: String,
    /// The whole `SKILL.md`, frontmatter included.
    pub content: String,
    /// As for `McpServer::enabled`.
    pub enabled: bool,
    pub created_at: String,
    pub updated_at: String,
}

impl Skill {
    fn from_row(r: &Row) -> rusqlite::Result<Self> {
        let content: String = r.get("content")?;
        Ok(Self {
            id: r.get("id")?,
            project_id: r.get("project_id")?,
            name: r.get("name")?,
            description: frontmatter(&content).map(|f| f.description).unwrap_or_default(),
            content,
            enabled: r.get("enabled")?,
            created_at: r.get("created_at")?,
            updated_at: r.get("updated_at")?,
        })
    }
}

#[derive(Serialize, Clone, Debug)]
pub struct McpServer {
    pub id: String,
    /// None for a global server.
    pub project_id: Option<String>,
    pub name: String,
    /// An `mcpServers` entry: `{"type": "stdio", "command", "args", "env"}` or
    /// `{"type": "http" | "sse", "url", "headers"}`.
    pub config: Value,
    /// A project's own server can be switched off. Global ones are switched per profile and
    /// project instead (see `switches`).
    pub enabled: bool,
    /// Its tools run without asking (`--allowedTools mcp__<name>`).
    pub auto_allow: bool,
    pub created_at: String,
    pub updated_at: String,
}

impl McpServer {
    fn from_row(r: &Row) -> rusqlite::Result<Self> {
        let config: String = r.get("config")?;
        Ok(Self {
            id: r.get("id")?,
            project_id: r.get("project_id")?,
            name: r.get("name")?,
            config: serde_json::from_str(&config).unwrap_or_else(|_| json!({})),
            enabled: r.get("enabled")?,
            auto_allow: r.get("auto_allow")?,
            created_at: r.get("created_at")?,
            updated_at: r.get("updated_at")?,
        })
    }
}

/// Skills and servers from outside the project that it turns off, and what its agents had.
#[derive(Serialize, Deserialize, Default, Debug, PartialEq)]
pub struct Overrides {
    pub disabled_skills: Vec<String>,
    pub disabled_mcp_servers: Vec<String>,
    /// Claude config id (empty for Claude's default) → what its last run in the project had.
    pub seen: Map<String, Value>,
}

// `project_id IS ?1` matches NULL (global) too.

fn list_skills(c: &Connection, project_id: Option<&str>) -> rusqlite::Result<Vec<Skill>> {
    let mut st = c.prepare("SELECT * FROM agent_skills WHERE project_id IS ?1 ORDER BY name")?;
    st.query_map([project_id], Skill::from_row)?.collect()
}

fn get_skill(c: &Connection, project_id: Option<&str>, id: &str) -> rusqlite::Result<Option<Skill>> {
    c.query_row("SELECT * FROM agent_skills WHERE project_id IS ?1 AND id=?2", params![project_id, id], Skill::from_row).optional()
}

fn list_mcp_servers(c: &Connection, project_id: Option<&str>) -> rusqlite::Result<Vec<McpServer>> {
    let mut st = c.prepare("SELECT * FROM agent_mcp_servers WHERE project_id IS ?1 ORDER BY name")?;
    st.query_map([project_id], McpServer::from_row)?.collect()
}

fn get_mcp_server(c: &Connection, project_id: Option<&str>, id: &str) -> rusqlite::Result<Option<McpServer>> {
    c.query_row("SELECT * FROM agent_mcp_servers WHERE project_id IS ?1 AND id=?2", params![project_id, id], McpServer::from_row).optional()
}

/// Whether global skills and servers are on: a profile's defaults (`scope` "profile") or a
/// project's overrides ("project"), by item id. Items without one are off for a profile, and
/// follow the profile in a project.
fn switches(c: &Connection, scope: &str, scope_id: &str) -> rusqlite::Result<Map<String, Value>> {
    let mut st = c.prepare("SELECT item_id, enabled FROM agent_tool_switches WHERE scope=?1 AND scope_id=?2")?;
    st.query_map([scope, scope_id], |r| Ok((r.get::<_, String>(0)?, Value::Bool(r.get(1)?))))?.collect()
}

fn get_overrides(c: &Connection, project_id: &str) -> rusqlite::Result<Overrides> {
    let row: Option<(String, String, String)> = c
        .query_row(
            "SELECT disabled_skills, disabled_mcp_servers, seen FROM project_agent_tools WHERE project_id=?1",
            [project_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    let Some((skills, servers, seen)) = row else { return Ok(Overrides::default()) };
    Ok(Overrides {
        disabled_skills: serde_json::from_str(&skills).unwrap_or_default(),
        disabled_mcp_servers: serde_json::from_str(&servers).unwrap_or_default(),
        seen: serde_json::from_str(&seen).unwrap_or_default(),
    })
}

fn set_overrides(c: &Connection, project_id: &str, o: &Overrides) -> rusqlite::Result<()> {
    c.execute(
        "INSERT INTO project_agent_tools (project_id, disabled_skills, disabled_mcp_servers, seen) VALUES (?1,?2,?3,?4)
         ON CONFLICT(project_id) DO UPDATE SET disabled_skills=?2, disabled_mcp_servers=?3, seen=?4",
        params![project_id, json!(o.disabled_skills).to_string(), json!(o.disabled_mcp_servers).to_string(), Value::Object(o.seen.clone()).to_string()],
    )?;
    Ok(())
}

// ---------- validation ----------

#[derive(Debug, PartialEq)]
struct Frontmatter {
    name: String,
    description: String,
    /// `user-invocable: false` hides a skill from Claude Code's `/` commands (only Claude uses it).
    user_invocable: bool,
}

/// `name` and `description` from a `SKILL.md`'s YAML frontmatter. Handles plain, quoted and
/// block (`>`, `|`) scalars, which is all skills use for these two.
fn frontmatter(content: &str) -> Option<Frontmatter> {
    let content = content.trim_start_matches('\u{feff}');
    let rest = content.strip_prefix("---")?.trim_start_matches([' ', '\t']);
    let rest = rest.strip_prefix("\r\n").or_else(|| rest.strip_prefix('\n'))?;
    let end = rest.lines().position(|l| l.trim_end() == "---")?;
    let lines: Vec<&str> = rest.lines().take(end).collect();
    let raw = |key: &str| lines.iter().find_map(|l| l.strip_prefix(key)?.strip_prefix(':')).map(str::trim);
    let field = |key: &str| -> Option<String> {
        let i = lines.iter().position(|l| l.strip_prefix(key).is_some_and(|r| r.starts_with(':')))?;
        let value = lines[i][key.len() + 1..].trim();
        if value.starts_with('>') || value.starts_with('|') {
            let block: Vec<&str> = lines[i + 1..].iter().take_while(|l| l.trim().is_empty() || l.starts_with([' ', '\t'])).map(|l| l.trim()).collect();
            let sep = if value.starts_with('>') { " " } else { "\n" };
            return Some(block.join(sep).trim().to_string());
        }
        let unquoted = value
            .strip_prefix('"')
            .and_then(|v| v.strip_suffix('"'))
            .or_else(|| value.strip_prefix('\'').and_then(|v| v.strip_suffix('\'')))
            .unwrap_or(value);
        Some(unquoted.to_string())
    };
    Some(Frontmatter {
        name: field("name").unwrap_or_default(),
        description: field("description").unwrap_or_default(),
        user_invocable: raw("user-invocable").is_none_or(yaml_true),
    })
}

/// Whether a frontmatter value is true as Claude Code reads it: true, yes, on or 1, in any case,
/// maybe quoted or with a comment after it. Anything else, such as an empty value, isn't.
fn yaml_true(raw: &str) -> bool {
    let quoted = ['"', '\''].into_iter().find_map(|q| {
        let (inner, rest) = raw.strip_prefix(q)?.split_once(q)?;
        Some((inner, rest))
    });
    let (value, rest) = match quoted {
        Some((inner, rest)) => (Some(inner), rest.trim_start()),
        None => {
            let mut words = raw.splitn(2, char::is_whitespace);
            (words.next().filter(|w| !w.is_empty() && !w.starts_with('#')), words.next().unwrap_or("").trim_start())
        }
    };
    let rest_is_comment = rest.is_empty() || rest.starts_with('#');
    value.is_some_and(|v| rest_is_comment && ["true", "yes", "on", "1"].contains(&v.to_ascii_lowercase().as_str()))
}

/// Claude Code's limit for a skill's description.
const MAX_DESCRIPTION: usize = 1024;

fn check_skill(content: &str) -> ApiResult<Frontmatter> {
    let f = frontmatter(content).ok_or_else(|| ApiError::bad("SKILL.md must start with a frontmatter block (--- name: …, description: … ---)"))?;
    let valid = !f.name.is_empty()
        && f.name.len() <= 64
        && f.name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        && !f.name.starts_with('-');
    if !valid {
        return Err(ApiError::bad("the skill's name must be lowercase letters, numbers and hyphens (at most 64)"));
    }
    if f.description.is_empty() {
        return Err(ApiError::bad("the skill needs a description: Claude uses it to decide when to use the skill"));
    }
    if f.description.chars().count() > MAX_DESCRIPTION {
        return Err(ApiError::bad(format!("the skill's description is too long (at most {MAX_DESCRIPTION} characters)")));
    }
    Ok(f)
}

fn check_server_name(name: &str) -> ApiResult<()> {
    if name.is_empty() || name.len() > 64 || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
        return Err(ApiError::bad("the server's name must be letters, numbers, - and _ (at most 64)"));
    }
    if crate::runner::is_board_server(name) {
        return Err(ApiError::bad(format!("{name} is the board's own server")));
    }
    Ok(())
}

/// A server's `mcpServers` entry, with `type` filled in.
fn check_server_config(config: &Value) -> ApiResult<Value> {
    let mut config = config.as_object().cloned().ok_or_else(|| ApiError::bad("the server's config must be a JSON object"))?;
    let has = |k: &str| config.get(k).and_then(|v| v.as_str()).is_some_and(|v| !v.trim().is_empty());
    let kind = match config.get("type").and_then(|t| t.as_str()) {
        Some(t) => t.to_string(),
        None if has("url") => "http".into(),
        None => "stdio".into(),
    };
    match kind.as_str() {
        "stdio" if !has("command") => return Err(ApiError::bad("a stdio server needs a command")),
        "http" | "sse" if !has("url") => return Err(ApiError::bad(format!("an {kind} server needs a url"))),
        "stdio" | "http" | "sse" => {}
        _ => return Err(ApiError::bad("type must be stdio, http or sse")),
    }
    for (key, what) in [("args", "a list of strings"), ("env", "an object of strings"), ("headers", "an object of strings")] {
        let ok = match config.get(key) {
            None => true,
            Some(Value::Array(a)) => key == "args" && a.iter().all(|v| v.is_string()),
            Some(Value::Object(o)) => key != "args" && o.values().all(|v| v.is_string()),
            Some(_) => false,
        };
        if !ok {
            return Err(ApiError::bad(format!("{key} must be {what}")));
        }
    }
    config.insert("type".into(), json!(kind));
    Ok(Value::Object(config))
}

/// A skill from outside the board, as typed to turn it off: it goes into a `Skill(<name>)` rule,
/// so spaces, commas and parentheses would break the rules. Plugin skills are `<plugin>:<skill>`.
fn valid_other_skill(name: &str) -> bool {
    !name.is_empty() && name.len() <= 200 && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | ':' | '.'))
}

/// The skills to turn off from a `disabled_skills` patch. The UI sends the whole list, so a bad
/// name saved before names were checked would fail every later toggle: only new bad names are
/// refused. Saved ones are kept (runs skip them), since a queued save may still send them, and
/// switching one back on removes it.
fn check_disabled_skills(saved: &[String], v: Vec<String>) -> ApiResult<Vec<String>> {
    if let Some(bad) = v.iter().find(|n| !valid_other_skill(n) && !saved.contains(n)) {
        return Err(ApiError::bad(format!("{bad:?} isn't a skill name: skill names are letters, numbers, -, _, : and .")));
    }
    Ok(v)
}

/// How Claude Code names a server in its tool names (`mcp__<name>__<tool>`).
pub fn tool_prefix(server: &str) -> String {
    let name: String = server.chars().map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' }).collect();
    format!("mcp__{name}")
}

fn unique(c: &Connection, table: &str, project_id: Option<&str>, name: &str, except: Option<&str>) -> ApiResult<()> {
    let taken: Option<String> = c
        .query_row(&format!("SELECT id FROM {table} WHERE project_id IS ?1 AND name=?2"), params![project_id, name], |r| r.get(0))
        .optional()?;
    match taken {
        Some(id) if Some(id.as_str()) != except => {
            Err(ApiError::conflict(format!("there's already one named {name} {}", if project_id.is_some() { "in this project" } else { "on this host" })))
        }
        _ => Ok(()),
    }
}

fn check_project(c: &Connection, project_id: &str) -> ApiResult<crate::db::Project> {
    crate::db::get_project(c, project_id)?.ok_or_else(|| ApiError::not_found("project"))
}

// ---------- API ----------

fn overview(c: &Connection, project: &crate::db::Project) -> ApiResult<Value> {
    let o = get_overrides(c, &project.id)?;
    Ok(json!({
        "skills": list_skills(c, Some(&project.id))?,
        "mcp_servers": list_mcp_servers(c, Some(&project.id))?,
        "disabled_skills": o.disabled_skills,
        "disabled_mcp_servers": o.disabled_mcp_servers,
        "seen": o.seen,
        "global_skills": list_skills(c, None)?,
        "global_mcp_servers": list_mcp_servers(c, None)?,
        "profile_switches": switches(c, "profile", &project.profile_id)?,
        "project_switches": switches(c, "project", &project.id)?,
    }))
}

pub async fn get(State(s): State<Shared>, Path(project_id): Path<String>) -> ApiResult<Json<Value>> {
    let c = s.db();
    let p = check_project(&c, &project_id)?;
    Ok(Json(overview(&c, &p)?))
}

#[derive(Deserialize)]
pub struct OverridesPatch {
    disabled_skills: Option<Vec<String>>,
    disabled_mcp_servers: Option<Vec<String>>,
}

/// Turn skills and servers from outside the board off (or back on) in a project.
pub async fn patch(State(s): State<Shared>, Path(project_id): Path<String>, Json(b): Json<OverridesPatch>) -> ApiResult<Json<Value>> {
    let c = s.db();
    let p = check_project(&c, &project_id)?;
    let tidy = |v: Vec<String>| {
        let mut v: Vec<String> = v.into_iter().map(|n| n.trim().to_string()).filter(|n| !n.is_empty()).collect();
        v.sort();
        v.dedup();
        v
    };
    let mut o = get_overrides(&c, &project_id)?;
    if let Some(v) = b.disabled_skills {
        o.disabled_skills = check_disabled_skills(&o.disabled_skills, tidy(v))?;
    }
    if let Some(v) = b.disabled_mcp_servers {
        // Servers' names can be anything (claude.ai connectors have spaces): `tool_prefix` makes
        // them into the tool names Claude Code uses.
        if v.iter().any(|n| crate::runner::is_board_server(n.trim())) {
            return Err(ApiError::bad(format!("{MCP_SERVER_NAME} can't be turned off")));
        }
        o.disabled_mcp_servers = tidy(v);
    }
    set_overrides(&c, &project_id, &o)?;
    Ok(Json(overview(&c, &p)?))
}

/// The host's global skills and servers, and every profile's defaults for them.
pub async fn get_global(State(s): State<Shared>) -> ApiResult<Json<Value>> {
    let c = s.db();
    let mut profiles = Map::new();
    for p in crate::db::list_profiles(&c)? {
        profiles.insert(p.id.clone(), Value::Object(switches(&c, "profile", &p.id)?));
    }
    Ok(Json(json!({
        "skills": list_skills(&c, None)?,
        "mcp_servers": list_mcp_servers(&c, None)?,
        "profile_switches": profiles,
    })))
}

#[derive(Deserialize)]
pub struct SwitchBody {
    /// "profile" or "project".
    scope: String,
    scope_id: String,
    item_id: String,
    /// None clears it: a profile's default goes back to off, a project follows its profile.
    enabled: Option<bool>,
}

/// Switch a global skill or server on or off for a profile (by default) or a project.
pub async fn set_switch(State(s): State<Shared>, Json(b): Json<SwitchBody>) -> ApiResult<Json<Value>> {
    let c = s.db();
    let exists = match b.scope.as_str() {
        "profile" => crate::db::get_profile(&c, &b.scope_id)?.is_some(),
        "project" => crate::db::get_project(&c, &b.scope_id)?.is_some(),
        _ => return Err(ApiError::bad("scope must be profile or project")),
    };
    if !exists {
        return Err(ApiError::not_found(&b.scope));
    }
    if get_skill(&c, None, &b.item_id)?.is_none() && get_mcp_server(&c, None, &b.item_id)?.is_none() {
        return Err(ApiError::not_found("global skill or MCP server"));
    }
    match b.enabled {
        Some(on) => c.execute(
            "INSERT INTO agent_tool_switches (scope, scope_id, item_id, enabled) VALUES (?1,?2,?3,?4)
             ON CONFLICT(scope, scope_id, item_id) DO UPDATE SET enabled=?4",
            params![b.scope, b.scope_id, b.item_id, on],
        )?,
        None => c.execute("DELETE FROM agent_tool_switches WHERE scope=?1 AND scope_id=?2 AND item_id=?3", params![b.scope, b.scope_id, b.item_id])?,
    };
    Ok(Json(json!({"ok": true})))
}

#[derive(Deserialize)]
pub struct SkillBody {
    content: Option<String>,
    enabled: Option<bool>,
}

fn create_skill_in(c: &Connection, project_id: Option<&str>, b: SkillBody) -> ApiResult<Skill> {
    let content = b.content.unwrap_or_default();
    let f = check_skill(&content)?;
    unique(c, "agent_skills", project_id, &f.name, None)?;
    let (id, at) = (new_id(), now());
    c.execute(
        "INSERT INTO agent_skills (id, project_id, name, content, enabled, created_at, updated_at) VALUES (?1,?2,?3,?4,?5,?6,?6)",
        params![id, project_id, f.name, content, b.enabled.unwrap_or(true), at],
    )?;
    get_skill(c, project_id, &id)?.ok_or_else(|| ApiError::not_found("skill"))
}

fn update_skill_in(c: &Connection, project_id: Option<&str>, id: &str, b: SkillBody) -> ApiResult<Skill> {
    let skill = get_skill(c, project_id, id)?.ok_or_else(|| ApiError::not_found("skill"))?;
    let (name, content) = match b.content {
        Some(content) => {
            let f = check_skill(&content)?;
            unique(c, "agent_skills", project_id, &f.name, Some(id))?;
            (f.name, content)
        }
        None => (skill.name.clone(), skill.content),
    };
    c.execute(
        "UPDATE agent_skills SET name=?1, content=?2, enabled=?3, updated_at=?4 WHERE id=?5",
        params![name, content, b.enabled.unwrap_or(skill.enabled), now(), id],
    )?;
    if name != skill.name {
        forget_board_skill(c, project_id, &skill.name)?;
    }
    get_skill(c, project_id, id)?.ok_or_else(|| ApiError::not_found("skill"))
}

/// A board skill was renamed or deleted: runs that had it reported it by its old name, which
/// mustn't stay in the `/` menu (see for_task), so it's forgotten wherever no skill of the board's
/// has that name now. A skill of that name from elsewhere is found again: in its folder, or by the
/// next run.
fn forget_board_skill(c: &Connection, project_id: Option<&str>, name: &str) -> anyhow::Result<()> {
    let projects: Vec<String> = match project_id {
        Some(p) => vec![p.to_string()],
        None => c.prepare("SELECT project_id FROM project_agent_tools")?.query_map([], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?,
    };
    for id in projects {
        let Some(project) = crate::db::get_project(c, &id)? else { continue };
        if effective(c, &project)?.0.iter().any(|s| s.name == name) {
            continue;
        }
        let mut o = get_overrides(c, &id)?;
        for seen in o.seen.values_mut() {
            for list in ["skills", "board_skills"] {
                if let Some(a) = seen[list].as_array_mut() {
                    a.retain(|v| v.as_str().or(v["name"].as_str()) != Some(name));
                }
            }
        }
        set_overrides(c, &id, &o)?;
    }
    Ok(())
}

fn delete_in(c: &Connection, table: &str, project_id: Option<&str>, id: &str) -> ApiResult<Json<Value>> {
    let skill = if table == "agent_skills" { get_skill(c, project_id, id)? } else { None };
    let n = c.execute(&format!("DELETE FROM {table} WHERE project_id IS ?1 AND id=?2"), params![project_id, id])?;
    if n == 0 {
        return Err(ApiError::not_found(if table == "agent_skills" { "skill" } else { "MCP server" }));
    }
    if let Some(skill) = skill {
        forget_board_skill(c, project_id, &skill.name)?;
    }
    Ok(Json(json!({"ok": true})))
}

pub async fn create_skill(State(s): State<Shared>, Path(project_id): Path<String>, Json(b): Json<SkillBody>) -> ApiResult<Json<Skill>> {
    let c = s.db();
    check_project(&c, &project_id)?;
    Ok(Json(create_skill_in(&c, Some(&project_id), b)?))
}

pub async fn update_skill(State(s): State<Shared>, Path((project_id, id)): Path<(String, String)>, Json(b): Json<SkillBody>) -> ApiResult<Json<Skill>> {
    Ok(Json(update_skill_in(&s.db(), Some(&project_id), &id, b)?))
}

pub async fn delete_skill(State(s): State<Shared>, Path((project_id, id)): Path<(String, String)>) -> ApiResult<Json<Value>> {
    delete_in(&s.db(), "agent_skills", Some(&project_id), &id)
}

pub async fn create_global_skill(State(s): State<Shared>, Json(b): Json<SkillBody>) -> ApiResult<Json<Skill>> {
    Ok(Json(create_skill_in(&s.db(), None, b)?))
}

pub async fn update_global_skill(State(s): State<Shared>, Path(id): Path<String>, Json(b): Json<SkillBody>) -> ApiResult<Json<Skill>> {
    Ok(Json(update_skill_in(&s.db(), None, &id, b)?))
}

pub async fn delete_global_skill(State(s): State<Shared>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    delete_in(&s.db(), "agent_skills", None, &id)
}

#[derive(Deserialize)]
pub struct McpServerBody {
    name: Option<String>,
    config: Option<Value>,
    enabled: Option<bool>,
    auto_allow: Option<bool>,
}

fn create_mcp_server_in(c: &Connection, project_id: Option<&str>, b: McpServerBody) -> ApiResult<McpServer> {
    let name = b.name.unwrap_or_default().trim().to_string();
    check_server_name(&name)?;
    let config = check_server_config(&b.config.unwrap_or(Value::Null))?;
    unique(c, "agent_mcp_servers", project_id, &name, None)?;
    let (id, at) = (new_id(), now());
    c.execute(
        "INSERT INTO agent_mcp_servers (id, project_id, name, config, enabled, auto_allow, created_at, updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?7)",
        params![id, project_id, name, config.to_string(), b.enabled.unwrap_or(true), b.auto_allow.unwrap_or(false), at],
    )?;
    get_mcp_server(c, project_id, &id)?.ok_or_else(|| ApiError::not_found("MCP server"))
}

fn update_mcp_server_in(c: &Connection, project_id: Option<&str>, id: &str, b: McpServerBody) -> ApiResult<McpServer> {
    let server = get_mcp_server(c, project_id, id)?.ok_or_else(|| ApiError::not_found("MCP server"))?;
    let name = match b.name {
        Some(n) => {
            let n = n.trim().to_string();
            check_server_name(&n)?;
            unique(c, "agent_mcp_servers", project_id, &n, Some(id))?;
            n
        }
        None => server.name,
    };
    let config = match b.config {
        Some(v) => check_server_config(&v)?,
        None => server.config,
    };
    c.execute(
        "UPDATE agent_mcp_servers SET name=?1, config=?2, enabled=?3, auto_allow=?4, updated_at=?5 WHERE id=?6",
        params![name, config.to_string(), b.enabled.unwrap_or(server.enabled), b.auto_allow.unwrap_or(server.auto_allow), now(), id],
    )?;
    get_mcp_server(c, project_id, id)?.ok_or_else(|| ApiError::not_found("MCP server"))
}

pub async fn create_mcp_server(State(s): State<Shared>, Path(project_id): Path<String>, Json(b): Json<McpServerBody>) -> ApiResult<Json<McpServer>> {
    let c = s.db();
    check_project(&c, &project_id)?;
    Ok(Json(create_mcp_server_in(&c, Some(&project_id), b)?))
}

pub async fn update_mcp_server(
    State(s): State<Shared>,
    Path((project_id, id)): Path<(String, String)>,
    Json(b): Json<McpServerBody>,
) -> ApiResult<Json<McpServer>> {
    Ok(Json(update_mcp_server_in(&s.db(), Some(&project_id), &id, b)?))
}

pub async fn delete_mcp_server(State(s): State<Shared>, Path((project_id, id)): Path<(String, String)>) -> ApiResult<Json<Value>> {
    delete_in(&s.db(), "agent_mcp_servers", Some(&project_id), &id)
}

pub async fn create_global_mcp_server(State(s): State<Shared>, Json(b): Json<McpServerBody>) -> ApiResult<Json<McpServer>> {
    Ok(Json(create_mcp_server_in(&s.db(), None, b)?))
}

pub async fn update_global_mcp_server(State(s): State<Shared>, Path(id): Path<String>, Json(b): Json<McpServerBody>) -> ApiResult<Json<McpServer>> {
    Ok(Json(update_mcp_server_in(&s.db(), None, &id, b)?))
}

pub async fn delete_global_mcp_server(State(s): State<Shared>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    delete_in(&s.db(), "agent_mcp_servers", None, &id)
}

// ---------- runs ----------

/// What a run in a project gets on top of the board's own setup.
#[derive(Default, Debug)]
pub struct RunTools {
    /// Directory holding `.claude/skills`, for `--add-dir`.
    pub skills_dir: Option<String>,
    /// Extra `mcpServers` entries.
    pub mcp_servers: Map<String, Value>,
    /// For `--allowedTools`.
    pub allowed: Vec<String>,
    /// For `--disallowedTools`.
    pub disallowed: Vec<String>,
}

fn skills_root(state: &Shared, project_id: &str) -> PathBuf {
    state.data_dir.join("projects").join(project_id).join("agent")
}

/// What's on in a project: its own enabled skills and servers, then the global ones switched on
/// for it (its override, else its profile's default). A project's own one takes the name while
/// it's on; switched off, the global one with that name is used if it's on.
fn effective(c: &Connection, project: &crate::db::Project) -> rusqlite::Result<(Vec<Skill>, Vec<McpServer>)> {
    let (profile, own) = (switches(c, "profile", &project.profile_id)?, switches(c, "project", &project.id)?);
    let on = |id: &str| own.get(id).or_else(|| profile.get(id)).and_then(|v| v.as_bool()).unwrap_or(false);
    let mut skills = list_skills(c, Some(&project.id))?;
    let mut servers = list_mcp_servers(c, Some(&project.id))?;
    skills.retain(|s| s.enabled);
    servers.retain(|s| s.enabled);
    for g in list_skills(c, None)? {
        if g.enabled && on(&g.id) && !skills.iter().any(|s| s.name == g.name) {
            skills.push(g);
        }
    }
    for g in list_mcp_servers(c, None)? {
        if g.enabled && on(&g.id) && !servers.iter().any(|s| s.name == g.name) {
            servers.push(g);
        }
    }
    Ok((skills, servers))
}

/// Set up a project's skills and servers for a run.
pub fn for_run(state: &Shared, project_id: &str) -> anyhow::Result<RunTools> {
    let (skills, servers, o) = {
        let c = state.db();
        let project = crate::db::get_project(&c, project_id)?.ok_or_else(|| anyhow::anyhow!("project not found"))?;
        let (skills, servers) = effective(&c, &project)?;
        (skills, servers, get_overrides(&c, project_id)?)
    };
    let enabled: Vec<&Skill> = skills.iter().collect();
    let root = skills_root(state, project_id);
    sync_skills(&root.join(".claude").join("skills"), &enabled)?;
    let mut t = RunTools { skills_dir: (!enabled.is_empty()).then(|| crate::util::path_str(&root)), ..Default::default() };
    for s in servers {
        if s.auto_allow {
            t.allowed.push(tool_prefix(&s.name));
        }
        t.mcp_servers.insert(s.name, s.config);
    }
    // Lists saved before names were checked may have bad ones.
    t.disallowed.extend(o.disabled_skills.iter().filter(|n| valid_other_skill(n)).map(|n| format!("Skill({n})")));
    t.disallowed.extend(o.disabled_mcp_servers.iter().map(|n| tool_prefix(n)));
    Ok(t)
}

/// Make `dir` hold exactly these skills. Files that are already right are left alone, since
/// other agents in the project may be reading them.
fn sync_skills(dir: &FsPath, skills: &[&Skill]) -> std::io::Result<()> {
    if let Ok(entries) = std::fs::read_dir(dir) {
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if !skills.iter().any(|s| s.name == name) {
                let path = e.path();
                if path.is_dir() { std::fs::remove_dir_all(&path)? } else { std::fs::remove_file(&path)? }
            }
        }
    }
    for s in skills {
        let file = dir.join(&s.name).join("SKILL.md");
        if std::fs::read_to_string(&file).ok().as_deref() != Some(s.content.as_str()) {
            std::fs::create_dir_all(dir.join(&s.name))?;
            std::fs::write(&file, &s.content)?;
        }
    }
    Ok(())
}

/// How long something a run had stays listed after runs stop reporting it.
const SEEN_DAYS: i64 = 14;

/// A run's `init` message: remember the skills and MCP servers its agent had, so the project's
/// settings can list them. Runs don't always report everything (claude.ai connectors may still
/// be connecting), so what earlier runs had is kept for a while.
pub fn record_seen(c: &Connection, project_id: &str, config_id: Option<&str>, init: &Value) -> anyhow::Result<()> {
    let at = now();
    let cutoff = (chrono::Utc::now() - chrono::Duration::days(SEEN_DAYS)).to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let mut o = get_overrides(c, project_id)?;
    let key = config_id.unwrap_or("").to_string();
    let before = o.seen.get(&key).cloned().unwrap_or(Value::Null);
    let merge = |now: Vec<Value>, before: &Value| -> Vec<Value> {
        let mut all: Vec<Value> = now.into_iter().map(|mut v| {
            v["at"] = json!(at);
            v
        }).collect();
        for old in before.as_array().into_iter().flatten() {
            let fresh = old["at"].as_str().is_some_and(|t| t > cutoff.as_str());
            if fresh && !all.iter().any(|v| v["name"] == old["name"]) {
                all.push(old.clone());
            }
        }
        all.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
        all
    };
    let skills = init["skills"].as_array().into_iter().flatten().filter_map(|s| s.as_str()).map(|n| json!({"name": n})).collect();
    let servers = init["mcp_servers"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|s| !s["name"].as_str().is_some_and(crate::runner::is_board_server))
        .map(|s| json!({"name": s["name"], "status": s["status"], "source": s["source"]}))
        .collect();
    // The board's own skills the run was given, so they can be told from others once they're turned
    // off, renamed or deleted.
    let project = crate::db::get_project(c, project_id)?;
    let board: Vec<String> = project.map(|p| effective(c, &p)).transpose()?.map_or_else(Vec::new, |(s, _)| s.into_iter().map(|s| s.name).collect());
    let (skills, servers) = (merge(skills, &before["skills"]), merge(servers, &before["mcp_servers"]));
    o.seen.insert(key, json!({"skills": skills, "mcp_servers": servers, "board_skills": board, "at": at}));
    set_overrides(c, project_id, &o)?;
    Ok(())
}

// ---------- a task's skills, for the composer ----------

/// A skill the user can call in a message to a task's agent: `/name` for Claude Code, which
/// expands it in `-p` mode as at its own prompt, and `$name` for Codex, whose agents use a skill
/// the user names.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct TaskSkill {
    pub name: String,
    pub description: String,
}

/// `GET /tasks/{id}/skills`: the skills a task's agent can be asked to use, for the composer's
/// `/` menu (API 54).
pub async fn for_task(State(s): State<Shared>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let (config, (cwd, add_dirs), repo, board, board_off, o) = {
        let c = s.db();
        let task = crate::db::get_task(&c, &id)?.ok_or_else(|| ApiError::not_found("task"))?;
        let config = crate::db::task_claude_config(&c, &task)?;
        let project = task.project_id.as_deref().map(|p| crate::db::get_project(&c, p)).transpose()?.flatten();
        let places = skill_places(&s, &c, &task, project.as_ref())?;
        let (board, board_off, o) = match &project {
            Some(p) => {
                let on = effective(&c, p)?.0;
                let off = board_skills_off(&c, p, &on)?;
                (on, off, get_overrides(&c, &p.id)?)
            }
            None => Default::default(),
        };
        (config, places, project.map(|p| crate::util::expand_tilde(&p.repo_path)), board, board_off, o)
    };
    let codex = config.as_ref().is_some_and(|c| c.is_codex());
    let dir = config.as_ref().map_or(if codex { "~/.codex" } else { "~/.claude" }, |c| c.dir()).to_string();
    let skills = if codex {
        // Codex finds a repository's skills from where it runs; it doesn't read added folders.
        crate::codex::skills(&dir, cwd.as_deref()).await.unwrap_or_else(|e| {
            tracing::warn!("listing Codex skills: {e:#}");
            Vec::new()
        })
    } else {
        let key = config.as_ref().map_or("", |c| c.id.as_str());
        // The board's own skills the last run had that are off now aren't given to runs any more;
        // a folder's skill of the same name is still found below.
        let seen = reported_skills(o.seen.get(key), &board, &board_off);
        let dir = crate::util::expand_tilde(&dir);
        // Claude Code reads skills from where it runs and the folders it's given.
        let dirs: Vec<PathBuf> = cwd.into_iter().chain(add_dirs).collect();
        tokio::task::spawn_blocking(move || claude_skills(&dir, &dirs, repo.as_deref(), &seen)).await.unwrap_or_default()
    };
    let skills = with_board_skills(skills, board, codex, &o.disabled_skills);
    Ok(Json(json!({"agent": if codex { "codex" } else { "claude" }, "skills": skills})))
}

/// Adds the board's own skills, which runs get from its folder (see for_run), and takes out the
/// ones the project turns off.
fn with_board_skills(mut skills: Vec<TaskSkill>, board: Vec<Skill>, codex: bool, disabled: &[String]) -> Vec<TaskSkill> {
    for b in board {
        // Claude Code turns down `/name` for a skill that isn't `user-invocable`.
        if !codex && frontmatter(&b.content).is_some_and(|f| !f.user_invocable) {
            skills.retain(|s| s.name != b.name);
            continue;
        }
        match skills.iter_mut().find(|s| s.name == b.name) {
            Some(s) => s.description = b.description,
            None => skills.push(TaskSkill { name: b.name, description: b.description }),
        }
    }
    skills.retain(|s| !disabled.contains(&s.name));
    skills.sort_by(|a, b| a.name.cmp(&b.name));
    skills.dedup_by(|a, b| a.name == b.name);
    skills
}

/// Where a task's agent runs and the folders it's given to read, as runner::launch has them, for
/// the skills it finds there: a plan, artifact, diagram or scratch task in its own folder, reading
/// its project's; a review thread in the reviewed task's worktree; a task in its worktree once it
/// has one, else the project's checkout; one in no project in its profile's scratch folder.
fn skill_places(state: &Shared, c: &Connection, task: &crate::db::Task, project: Option<&crate::db::Project>) -> anyhow::Result<(Option<PathBuf>, Vec<PathBuf>)> {
    let parent = task.parent_id.as_deref().map(|id| crate::db::get_task(c, id)).transpose()?.flatten();
    let worktree = |t: &crate::db::Task| t.worktree_path.clone().filter(|_| t.worktree_state == "ready");
    let repo = project.map(|p| p.repo_path.clone());
    let mut add_dirs: Vec<String> = Vec::new();
    let cwd = if let Some(doc) = crate::documents::work_dir(state, task) {
        add_dirs.extend(repo.clone());
        add_dirs.extend(parent.as_ref().filter(|t| task.kind == "task" && t.subproject).and_then(worktree));
        Some(doc)
    } else if let Some(p) = project {
        let reviewed = parent.as_ref().filter(|_| task.kind == "review");
        Some(crate::util::expand_tilde(&reviewed.map_or_else(|| worktree(task), worktree).unwrap_or_else(|| p.repo_path.clone())))
    } else {
        Some(state.profile_scratch_dir(&task.profile_id))
    };
    // A group task reads its group's projects.
    if let (Some(g), None, "task") = (&task.group_name, project, task.kind.as_str()) {
        add_dirs.extend(crate::db::group_projects(c, &task.profile_id, g)?.into_iter().map(|p| p.repo_path));
    }
    Ok((cwd, add_dirs.iter().map(|d| crate::util::expand_tilde(d)).collect()))
}

/// The board's own skills for a project that aren't on for it (`on`, see effective), by name.
fn board_skills_off(c: &Connection, project: &crate::db::Project, on: &[Skill]) -> rusqlite::Result<Vec<String>> {
    let mut all = list_skills(c, Some(&project.id))?;
    all.extend(list_skills(c, None)?);
    Ok(all.into_iter().map(|s| s.name).filter(|n| !on.iter().any(|s| s.name == *n)).collect())
}

/// The skills Claude Code has with a config dir and working directory, for the `/` menu: the ones
/// its last run in the project reported (`last_run`), which are the ones a user can call, and the
/// ones in the config's and the repository's `skills` folders, which `/<folder>` calls, so a task
/// has them before any run has reported them. One changed since that run to say a user can't
/// call it (`user-invocable: false`) is left out. Descriptions come from the `SKILL.md`s, also
/// those of synced skills and installed plugins' (skills bundled with Claude Code have none).
/// `dirs` are where it runs and the folders it's given; `repo` is the project's main checkout,
/// which plugins installed for the project name.
fn claude_skills(config_dir: &FsPath, dirs: &[PathBuf], repo: Option<&FsPath>, last_run: &[String]) -> Vec<TaskSkill> {
    let user = config_dir.join("skills");
    // A personal skill wins over the repository's of the same name, as in Claude Code.
    let mut own = Vec::new();
    find_skills(&user, 1, "", &mut own);
    dirs.iter().for_each(|d| find_skills(&d.join(".claude").join("skills"), 1, "", &mut own));
    add_aliases(&mut own);
    // A plugin's are `<plugin>:<folder>`, in the installation that applies here.
    let mut plugins = Vec::new();
    let places: Vec<&FsPath> = dirs.iter().map(PathBuf::as_path).chain(repo).collect();
    for (plugin, path) in installed_plugins(config_dir, &places) {
        let mut found = Vec::new();
        find_skills(&path.join("skills"), 1, &format!("{plugin}:"), &mut found);
        add_aliases(&mut found);
        plugins.extend(found);
    }
    // Synced ones are in skills/synced/<bucket>/<folder>, under a plugin name the board can't tell,
    // so they only give descriptions.
    let mut synced = Vec::new();
    find_skills(&user.join("synced"), 2, "", &mut synced);
    let exact = |n: &str| own.iter().chain(&plugins).find(|f| f.name == n);
    let describe = |n: &str| {
        let short = n.rsplit_once(':').map(|(_, s)| s);
        let by_short = short.and_then(|s| synced.iter().chain(own.iter().filter(|f| !f.alias)).find(|f| f.name == s));
        exact(n).or(by_short).map(|f| f.description.clone()).unwrap_or_default()
    };
    let folders = own.iter().filter(|f| !f.alias).map(|f| f.name.as_str());
    let mut names: Vec<&str> = last_run.iter().map(String::as_str).chain(folders).collect();
    names.sort();
    names.dedup();
    names
        .into_iter()
        .filter(|n| !exact(n).is_some_and(|f| !f.user_invocable))
        .map(|n| TaskSkill { name: n.to_string(), description: describe(n) })
        .collect()
}

/// The skills the last run reported (see last_run_skills) less the board's own that aren't on any
/// more: those it gave the run (turned off, renamed or deleted since), and for runs recorded
/// before the board noted those, the ones that are off now.
fn reported_skills(seen: Option<&Value>, on: &[Skill], off: &[String]) -> Vec<String> {
    let given: Vec<&str> = seen.and_then(|s| s["board_skills"].as_array()).into_iter().flatten().filter_map(Value::as_str).collect();
    let gone = |n: &str| !on.iter().any(|s| s.name == n) && (given.contains(&n) || off.iter().any(|o| o == n));
    last_run_skills(seen).into_iter().filter(|n| !gone(n)).collect()
}

/// The skills a project's last run with a Claude config reported (see record_seen), rather than
/// all those runs had lately: one that a user can no longer call stops being reported.
fn last_run_skills(seen: Option<&Value>) -> Vec<String> {
    let Some(seen) = seen else { return Vec::new() };
    let skills = seen["skills"].as_array().into_iter().flatten();
    skills.filter(|s| s["at"] == seen["at"]).filter_map(|s| s["name"].as_str().map(String::from)).collect()
}

/// The plugins installed in a Claude config for the folders a task works in, each with the
/// folder of its installation that applies: one for the project (`local`, then `project`, by
/// `projectPath`) over the user's.
fn installed_plugins(config_dir: &FsPath, places: &[&FsPath]) -> Vec<(String, PathBuf)> {
    let Ok(file) = std::fs::read_to_string(config_dir.join("plugins").join("installed_plugins.json")) else { return Vec::new() };
    let v: Value = serde_json::from_str(&file).unwrap_or_default();
    let same = |a: &FsPath, b: &FsPath| a == b || std::fs::canonicalize(a).is_ok_and(|a| std::fs::canonicalize(b).is_ok_and(|b| a == b));
    let mut out = Vec::new();
    for (id, installs) in v["plugins"].as_object().into_iter().flatten() {
        let plugin = id.split('@').next().unwrap_or(id);
        let rank = |i: &Value| {
            let here = || i["projectPath"].as_str().is_some_and(|p| places.iter().any(|d| same(FsPath::new(p), d)));
            match i["scope"].as_str() {
                Some("local") if here() => Some(3),
                Some("project") if here() => Some(2),
                Some("local" | "project") => None,
                _ => Some(1),
            }
        };
        let best = installs.as_array().into_iter().flatten().filter_map(|i| Some((rank(i)?, i["installPath"].as_str()?))).max_by_key(|(r, _)| *r);
        if let Some((_, path)) = best {
            out.push((plugin.to_string(), PathBuf::from(path)));
        }
    }
    out
}

/// A skill in a folder, from its `SKILL.md`.
struct FoundSkill {
    /// `<prefix><folder>`, the name that always calls it, or for an alias its frontmatter's `name`.
    name: String,
    /// Its frontmatter's `name`, if that's another (see add_aliases).
    other_name: Option<String>,
    /// Found by its frontmatter's `name`: not listed by itself.
    alias: bool,
    description: String,
    user_invocable: bool,
}

fn subdirs(dir: &FsPath) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::fs::read_dir(dir).into_iter().flatten().flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect();
    dirs.sort();
    dirs
}

/// The skills in `dir` (folders with a `SKILL.md`), looking `depth` folders down, named
/// `<prefix><folder>`.
fn find_skills(dir: &FsPath, depth: usize, prefix: &str, out: &mut Vec<FoundSkill>) {
    for path in subdirs(dir) {
        let folder = path.file_name().unwrap_or_default().to_string_lossy().to_string();
        if folder.starts_with('.') || folder == "node_modules" {
            continue;
        }
        match std::fs::read_to_string(path.join("SKILL.md")) {
            Ok(content) => {
                let name = format!("{prefix}{folder}");
                if !out.iter().any(|f| f.name == name) {
                    let f = frontmatter(&content);
                    // A plugin's skill may name itself with the plugin's prefix already.
                    let alias = f.as_ref().filter(|f| !f.name.is_empty()).map(|f| match f.name.starts_with(prefix) {
                        true => f.name.clone(),
                        false => format!("{prefix}{}", f.name),
                    });
                    let (description, user_invocable) = f.map_or((String::new(), true), |f| (f.description, f.user_invocable));
                    out.push(FoundSkill { other_name: alias.filter(|a| *a != name), name, alias: false, description, user_invocable });
                }
            }
            Err(_) if depth > 1 => find_skills(&path, depth - 1, prefix, out),
            Err(_) => {}
        }
    }
}

/// Claude Code may call a skill by its frontmatter's `name` instead of its folder, unless another
/// skill has that name: adds those names, after all the folders', so a run's name for a skill
/// finds it. They aren't listed by themselves.
fn add_aliases(found: &mut Vec<FoundSkill>) {
    let aliases: Vec<FoundSkill> = found
        .iter()
        .filter_map(|f| {
            let name = f.other_name.clone()?;
            Some(FoundSkill { name, other_name: None, alias: true, description: f.description.clone(), user_invocable: f.user_invocable })
        })
        .collect();
    for a in aliases {
        if !found.iter().any(|f| f.name == a.name) {
            found.push(a);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_skill_frontmatter() {
        let f = frontmatter("---\nname: deploy\ndescription: \"Deploy the app\"\nallowed-tools: Bash\n---\n\nBody\n").unwrap();
        assert_eq!(f, Frontmatter { name: "deploy".into(), description: "Deploy the app".into(), user_invocable: true });
        let f = frontmatter("---\nname: 'x'\ndescription: >\n  Folded\n  text\nother: 1\nuser-invocable: false\n---\n").unwrap();
        assert_eq!(f, Frontmatter { name: "x".into(), description: "Folded text".into(), user_invocable: false });
        // As Claude Code reads it.
        let invocable = |v: &str| frontmatter(&format!("---\nname: x\nuser-invocable: {v}\n---\n")).unwrap().user_invocable;
        for v in ["true", "TRUE", "Yes", "on", "1", "true # x", "\"true\"", "'yes' # x"] {
            assert!(invocable(v), "{v}");
        }
        for v in ["false", "FALSE", "no", "off", "0", "false # Only the model", "'false'", "\"true # x\"", "", "# x", "maybe", "true maybe"] {
            assert!(!invocable(v), "{v}");
        }
        assert!(frontmatter("---\nname: x\n---\n").unwrap().user_invocable);
        assert!(frontmatter("no frontmatter").is_none());
        assert!(frontmatter("---\nname: unterminated\n").is_none());
    }

    #[test]
    fn checks_skills() {
        assert!(check_skill("---\nname: ok-1\ndescription: d\n---\n").is_ok());
        assert!(check_skill("---\nname: Bad Name\ndescription: d\n---\n").is_err());
        assert!(check_skill("---\nname: ok\n---\n").is_err());
        assert!(check_skill("# just markdown").is_err());
        let long = |n: usize| format!("---\nname: ok\ndescription: {}\n---\n", "é".repeat(n));
        assert!(check_skill(&long(MAX_DESCRIPTION)).is_ok());
        assert!(check_skill(&long(MAX_DESCRIPTION + 1)).is_err());
        assert!(valid_other_skill("pdf") && valid_other_skill("my-plugin:do_it") && valid_other_skill("Legacy.Command"));
        assert!(!valid_other_skill("two words") && !valid_other_skill("x)") && !valid_other_skill("a,b") && !valid_other_skill(""));
    }

    #[test]
    fn saved_bad_skill_names_dont_block_toggles() {
        let names = |v: &[&str]| v.iter().map(|n| n.to_string()).collect::<Vec<_>>();
        let saved = names(&["old one", "other bad", "pdf"]);
        // Toggling another skill keeps the saved bad names instead of failing, and switching one
        // back on still works while the other is sent.
        assert_eq!(check_disabled_skills(&saved, names(&["docx", "old one", "other bad", "pdf"])).unwrap(), ["docx", "old one", "other bad", "pdf"]);
        assert_eq!(check_disabled_skills(&saved, names(&["other bad"])).unwrap(), ["other bad"]);
        // New bad names are still refused.
        assert!(check_disabled_skills(&saved, names(&["new bad", "pdf"])).is_err());
    }

    #[test]
    fn checks_server_configs() {
        assert_eq!(check_server_config(&json!({"url": "https://x"})).unwrap()["type"], "http");
        assert_eq!(check_server_config(&json!({"command": "npx", "args": ["-y", "pkg"]})).unwrap()["type"], "stdio");
        assert!(check_server_config(&json!({"type": "stdio"})).is_err());
        assert!(check_server_config(&json!({"command": "x", "args": "-y"})).is_err());
        assert!(check_server_config(&json!({"url": "https://x", "headers": {"a": 1}})).is_err());
        assert!(check_server_config(&json!({"type": "ws", "url": "x"})).is_err());
        assert!(check_server_name(MCP_SERVER_NAME).is_err());
        assert!(check_server_name("has space").is_err());
    }

    #[test]
    fn names_server_tools_like_claude_code() {
        assert_eq!(tool_prefix("claude.ai Google Drive"), "mcp__claude_ai_Google_Drive");
        assert_eq!(tool_prefix("my-server_2"), "mcp__my-server_2");
    }

    #[test]
    fn syncs_the_skills_dir() {
        let dir = std::env::temp_dir().join(format!("ia-skills-{}", new_id()));
        let skill = |name: &str, content: &str| Skill {
            id: name.into(),
            project_id: Some("p".into()),
            name: name.into(),
            description: String::new(),
            content: content.into(),
            enabled: true,
            created_at: String::new(),
            updated_at: String::new(),
        };
        let (a, b) = (skill("a", "A"), skill("b", "B"));
        sync_skills(&dir, &[&a, &b]).unwrap();
        assert_eq!(std::fs::read_to_string(dir.join("b/SKILL.md")).unwrap(), "B");
        let a2 = skill("a", "A2");
        sync_skills(&dir, &[&a2]).unwrap();
        assert_eq!(std::fs::read_to_string(dir.join("a/SKILL.md")).unwrap(), "A2");
        assert!(!dir.join("b").exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn lists_a_claude_tasks_skills() {
        let root = std::env::temp_dir().join(format!("ia-task-skills-{}", new_id()));
        let (config, repo) = (root.join("config"), root.join("repo"));
        let skill = |dir: PathBuf, name: &str, description: &str, extra: &str| {
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("SKILL.md"), format!("---\nname: {name}\ndescription: {description}\n{extra}---\n")).unwrap();
        };
        let (personal, project) = (config.join("skills"), repo.join(".claude/skills"));
        skill(personal.join("mine"), "mine", "My own", "");
        skill(project.join("repo-skill"), "repo-skill", "From the repository", "");
        skill(project.join("user-only"), "user-only", "User only", "disable-model-invocation: true\n");
        // Changed since the last run so that only the model can call it.
        skill(project.join("hidden"), "hidden", "Hidden", "user-invocable: false\n");
        // A frontmatter name that's another skill's folder doesn't hide or describe that skill,
        // whether it sorts before it, can be called or is in another folder.
        skill(project.join("aaa-draft"), "deploy", "Draft", "");
        skill(project.join("deploy"), "deploy", "Deploy", "");
        skill(project.join("aab-hidden"), "deploy2", "Hidden draft", "user-invocable: false\n");
        skill(project.join("deploy2"), "deploy2", "Deploy 2", "");
        skill(personal.join("x"), "review", "Personal x", "");
        skill(project.join("review"), "review", "Review", "");
        // Plugins' skills are read from the versions installed, not older ones in the cache.
        let cache = config.join("plugins/cache/market");
        skill(cache.join("plug/1.0.0/skills/lint"), "lint", "Old lints", "user-invocable: false\n");
        skill(cache.join("plug/2.0.0/skills/lint"), "lint", "Lints", "");
        skill(cache.join("upgraded/1.0.0/skills/review"), "review", "Old review", "");
        skill(cache.join("upgraded/2.0.0/skills/review"), "review", "Review", "user-invocable: false\n");
        skill(cache.join("upgraded/1.0.0/skills/fixed"), "fixed", "Old fixed", "user-invocable: false\n");
        skill(cache.join("upgraded/2.0.0/skills/fixed"), "fixed", "Fixed", "");
        let install = |v: &str| json!([{"scope": "user", "installPath": crate::util::path_str(&cache.join(v))}]);
        let main = root.join("main");
        let scoped = |v: &str, scope: &str, project: &FsPath| {
            json!({"scope": scope, "projectPath": crate::util::path_str(project), "installPath": crate::util::path_str(&cache.join(v))})
        };
        let scoped = json!([
            scoped("scoped/2.0.0", "project", &main),
            scoped("scoped/1.0.0", "project", &root.join("elsewhere")),
            {"scope": "user", "installPath": crate::util::path_str(&cache.join("scoped/0.9.0"))},
        ]);
        let installed =
            json!({"version": 2, "plugins": {"plug@market": install("plug/2.0.0"), "upgraded@market": install("upgraded/2.0.0"), "scoped@market": scoped}});
        std::fs::write(config.join("plugins/installed_plugins.json"), installed.to_string()).unwrap();
        // Hidden since the last run, which reported them by their frontmatter names.
        skill(project.join("source"), "alias-hidden", "Hidden", "user-invocable: false\n");
        skill(cache.join("plug/2.0.0/skills/source-qualified"), "plug:alias-qualified", "Hidden", "user-invocable: false\n");
        skill(cache.join("plug/2.0.0/skills/psrc"), "alias-plugin", "Hidden", "user-invocable: no\n");
        // A plugin installed for this project is read from that installation, not another project's or the user's.
        skill(cache.join("scoped/0.9.0/skills/review"), "review", "User's", "user-invocable: false\n");
        skill(cache.join("scoped/1.0.0/skills/review"), "review", "Elsewhere", "user-invocable: false\n");
        skill(cache.join("scoped/2.0.0/skills/review"), "review", "Here", "");
        skill(cache.join("scoped/1.0.0/skills/hidden"), "hidden", "Elsewhere", "");
        skill(cache.join("scoped/2.0.0/skills/hidden"), "hidden", "Here", "user-invocable: false\n");
        skill(personal.join("synced/bucket/pdf"), "pdf", "PDFs", "");
        std::fs::create_dir_all(personal.join("not-a-skill")).unwrap();
        let last_run = [
            "code-review", "anthropic-skills:pdf", "plug:lint", "upgraded:review", "upgraded:fixed", "hidden", "user-only", "deploy", "alias-hidden",
            "plug:alias-qualified", "plug:alias-plugin", "scoped:review", "scoped:hidden",
        ]
        .map(String::from);
        // The task works in `repo` (a worktree, say) of the project checked out at `main`.
        let got = claude_skills(&config, &[repo.clone()], Some(&main), &last_run);
        let got: Vec<(&str, &str)> = got.iter().map(|s| (s.name.as_str(), s.description.as_str())).collect();
        assert_eq!(
            got,
            [
                ("aaa-draft", "Draft"),
                ("anthropic-skills:pdf", "PDFs"),
                ("code-review", ""),
                ("deploy", "Deploy"),
                ("deploy2", "Deploy 2"),
                ("mine", "My own"),
                ("plug:lint", "Lints"),
                ("repo-skill", "From the repository"),
                ("review", "Review"),
                ("scoped:review", "Here"),
                ("upgraded:fixed", "Fixed"),
                ("user-only", "User only"),
                ("x", "Personal x"),
            ]
        );
        // Before any run has reported them, the folders' skills are still there.
        let got = claude_skills(&config, &[], None, &[]);
        assert_eq!(got, [TaskSkill { name: "mine".into(), description: "My own".into() }, TaskSkill { name: "x".into(), description: "Personal x".into() }]);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn finds_skills_where_the_agent_runs() {
        let state = crate::testing::state();
        let c = state.db();
        let p = crate::db::insert_profile(&c, "p", &[], None).unwrap();
        let np = crate::db::NewProject {
            id: "pr", profile_id: &p.id, name: "x", key: "X", repo_path: "/main", scratch_path: "/s", worktrees_root: "/w", base_branch: None, use_worktrees: true,
        };
        let project = crate::db::insert_project(&c, np).unwrap();
        let new = |project_id: Option<&'static str>, kind: &'static str| crate::db::NewTask {
            profile_id: &p.id, project_id, kind, title: "t", description: "", status: "todo", use_worktree: kind == "task" && project_id.is_some(), model: None,
            effort: None, claude_config_id: None,
        };
        let places = |t: &crate::db::Task| {
            let (cwd, add) = skill_places(&state, &c, t, t.project_id.as_ref().map(|_| &project)).unwrap();
            (cwd.map(|d| crate::util::path_str(&d)).unwrap_or_default(), add.iter().map(|d| crate::util::path_str(d)).collect::<Vec<_>>())
        };
        let task = crate::db::insert_task(&c, new(Some("pr"), "task")).unwrap();
        let review = crate::db::insert_task(&c, new(Some("pr"), "review")).unwrap();
        let review = crate::db::update_task(&c, &review.id, &[("parent_id", json!(task.id))]).unwrap().unwrap();
        // Before the worktree is set up, both run in the main checkout; then in the task's worktree.
        assert_eq!(places(&review), ("/main".into(), vec![]));
        let task = crate::db::update_task(&c, &task.id, &[("worktree_path", json!("/w/1")), ("worktree_state", json!("ready"))]).unwrap().unwrap();
        assert_eq!(places(&task), ("/w/1".into(), vec![]));
        assert_eq!(places(&review), ("/w/1".into(), vec![]));
        // A plan works in its own folder, reading the project's checkout.
        let plan = crate::db::insert_task(&c, new(Some("pr"), "task")).unwrap();
        let plan = crate::db::update_task(&c, &plan.id, &[("task_type", json!("plan"))]).unwrap().unwrap();
        let doc = crate::util::path_str(&crate::documents::work_dir(&state, &plan).unwrap());
        assert_eq!(places(&plan), (doc, vec!["/main".to_string()]));
        // A scratch task in no project works in its own folder (or its chat's), one without a type in the profile's.
        let scratch = crate::db::insert_task(&c, new(None, "task")).unwrap();
        assert_eq!(places(&scratch).0, crate::util::path_str(&state.profile_scratch_dir(&p.id)));
        let scratch = crate::db::update_task(&c, &scratch.id, &[("task_type", json!("scratch")), ("work_dir", json!("/chat"))]).unwrap().unwrap();
        assert_eq!(places(&scratch), ("/chat".into(), vec![]));
    }

    #[test]
    fn leaves_out_board_skills_turned_off_since() {
        use crate::db::{NewProject, insert_profile, insert_project};
        let c = crate::db::open(FsPath::new(":memory:")).unwrap();
        let profile = insert_profile(&c, "p", &[], None).unwrap();
        let np = NewProject { id: "a", profile_id: &profile.id, name: "a", key: "X", repo_path: "/x", scratch_path: "/s", worktrees_root: "/w", base_branch: None, use_worktrees: false };
        let a = insert_project(&c, np).unwrap();
        let skill = |project: Option<&str>, name: &str| create_skill_in(&c, project, SkillBody { content: Some(format!("---\nname: {name}\ndescription: d\n---\n")), enabled: None }).unwrap();
        let own = skill(Some("a"), "own");
        let global = skill(None, "global");
        skill(None, "never-on");
        let set = |item: &str, v: bool| c.execute("INSERT OR REPLACE INTO agent_tool_switches VALUES ('project','a',?1,?2)", params![item, v]).unwrap();
        set(&global.id, true);
        let off = || board_skills_off(&c, &a, &effective(&c, &a).unwrap().0).unwrap();
        assert_eq!(off(), ["never-on"]);
        // Turned off after a run had them: the project's own one, and a global one switched off for the project.
        update_skill_in(&c, Some("a"), &own.id, SkillBody { content: None, enabled: Some(false) }).unwrap();
        set(&global.id, false);
        let mut got = off();
        got.sort();
        assert_eq!(got, ["global", "never-on", "own"]);
    }

    #[test]
    fn leaves_out_board_skills_deleted_or_renamed_since() {
        use crate::db::{NewProject, insert_profile, insert_project};
        let c = crate::db::open(FsPath::new(":memory:")).unwrap();
        let profile = insert_profile(&c, "p", &[], None).unwrap();
        let np = NewProject { id: "a", profile_id: &profile.id, name: "a", key: "X", repo_path: "/x", scratch_path: "/s", worktrees_root: "/w", base_branch: None, use_worktrees: false };
        let a = insert_project(&c, np).unwrap();
        let content = |name: &str| Some(format!("---\nname: {name}\ndescription: d\n---\n"));
        let skill = |project: Option<&str>, name: &str| create_skill_in(&c, project, SkillBody { content: content(name), enabled: None }).unwrap();
        let (own, renamed, disabled, global) = (skill(Some("a"), "own"), skill(Some("a"), "renamed"), skill(Some("a"), "disabled"), skill(None, "global"));
        c.execute("INSERT INTO agent_tool_switches VALUES ('project','a',?1,1)", [&global.id]).unwrap();
        record_seen(&c, "a", None, &json!({"skills": ["own", "renamed", "disabled", "global", "external"]})).unwrap();
        let reported = || {
            let on = effective(&c, &a).unwrap().0;
            let off = board_skills_off(&c, &a, &on).unwrap();
            reported_skills(get_overrides(&c, "a").unwrap().seen.get(""), &on, &off)
        };
        assert_eq!(reported(), ["disabled", "external", "global", "own", "renamed"]);
        update_skill_in(&c, Some("a"), &disabled.id, SkillBody { content: None, enabled: Some(false) }).unwrap();
        update_skill_in(&c, Some("a"), &renamed.id, SkillBody { content: content("new-name"), enabled: None }).unwrap();
        assert_eq!(reported(), ["external", "global", "own"]);
        // Deleted, after being turned off or not; a run's own skill of the same name would still be found in its folder.
        for id in [&own.id, &disabled.id, &global.id] {
            c.execute("DELETE FROM agent_skills WHERE id=?1", [id]).unwrap();
        }
        assert_eq!(reported(), ["external"]);
    }

    #[test]
    fn forgets_board_skills_deleted_or_renamed_from_runs_recorded_before() {
        use crate::db::{NewProject, insert_profile, insert_project};
        let c = crate::db::open(FsPath::new(":memory:")).unwrap();
        let profile = insert_profile(&c, "p", &[], None).unwrap();
        let new = |id| NewProject { id, profile_id: &profile.id, name: id, key: "X", repo_path: "/x", scratch_path: "/s", worktrees_root: "/w", base_branch: None, use_worktrees: false };
        let (a, b) = (insert_project(&c, new("a")).unwrap(), insert_project(&c, new("b")).unwrap());
        let content = |name: &str| Some(format!("---\nname: {name}\ndescription: d\n---\n"));
        let skill = |project: Option<&str>, name: &str| create_skill_in(&c, project, SkillBody { content: content(name), enabled: None }).unwrap();
        let (own, renamed, disabled, global) = (skill(Some("a"), "own"), skill(Some("a"), "renamed"), skill(Some("a"), "disabled"), skill(None, "global"));
        // Project b has its own skill named like the global one, which stays.
        skill(Some("b"), "global");
        for p in ["a", "b"] {
            c.execute("INSERT INTO agent_tool_switches VALUES ('project',?1,?2,1)", params![p, global.id]).unwrap();
        }
        // Saved as runs recorded them before the board noted which skills were its own.
        let at = "2026-10-01T00:00:00.000Z";
        let names = ["disabled", "external", "global", "own", "renamed"];
        for p in ["a", "b"] {
            let mut o = get_overrides(&c, p).unwrap();
            let skills: Vec<Value> = names.iter().map(|n| json!({"name": n, "at": at})).collect();
            o.seen.insert("cfg".into(), json!({"skills": skills, "mcp_servers": [], "at": at}));
            set_overrides(&c, p, &o).unwrap();
        }
        let reported = |p: &crate::db::Project| {
            let on = effective(&c, p).unwrap().0;
            let off = board_skills_off(&c, p, &on).unwrap();
            reported_skills(get_overrides(&c, &p.id).unwrap().seen.get("cfg"), &on, &off)
        };
        assert_eq!(reported(&a), names);
        update_skill_in(&c, Some("a"), &disabled.id, SkillBody { content: None, enabled: Some(false) }).unwrap();
        update_skill_in(&c, Some("a"), &renamed.id, SkillBody { content: content("new-name"), enabled: None }).unwrap();
        assert_eq!(reported(&a), ["external", "global", "own"]);
        // Deleted, the disabled one too.
        for (project, id) in [(Some("a"), &own.id), (Some("a"), &disabled.id), (None, &global.id)] {
            assert_eq!(delete_in(&c, "agent_skills", project, id).unwrap().0["ok"], true);
        }
        assert_eq!(reported(&a), ["external"]);
        assert_eq!(reported(&b), ["disabled", "external", "global", "own", "renamed"]);
    }

    #[test]
    fn lists_the_skills_the_last_run_reported() {
        let c = crate::db::open(FsPath::new(":memory:")).unwrap();
        c.execute_batch("PRAGMA foreign_keys=OFF;").unwrap();
        record_seen(&c, "p", Some("cfg"), &json!({"skills": ["kept", "hidden-later"]})).unwrap();
        // An earlier run's, which Claude Code stopped reporting once a user couldn't call it.
        let mut o = get_overrides(&c, "p").unwrap();
        for s in o.seen["cfg"]["skills"].as_array_mut().unwrap() {
            s["at"] = json!("2000-01-01T00:00:00.000Z");
        }
        set_overrides(&c, "p", &o).unwrap();
        record_seen(&c, "p", Some("cfg"), &json!({"skills": ["kept"]})).unwrap();
        let o = get_overrides(&c, "p").unwrap();
        assert_eq!(last_run_skills(o.seen.get("cfg")), ["kept"]);
        assert!(last_run_skills(o.seen.get("other")).is_empty());
    }

    #[test]
    fn adds_the_boards_skills_a_user_can_call() {
        let skill = |name: &str, extra: &str| Skill {
            id: name.into(),
            project_id: Some("p".into()),
            name: name.into(),
            description: format!("{name} (board)"),
            content: format!("---\nname: {name}\ndescription: d\n{extra}---\n"),
            enabled: true,
            created_at: String::new(),
            updated_at: String::new(),
        };
        let found = |names: &[&str]| names.iter().map(|n| TaskSkill { name: n.to_string(), description: String::new() }).collect::<Vec<_>>();
        let board = || {
            vec![
                skill("deploy", ""),
                skill("hidden", "user-invocable: false # Only the model\n"),
                skill("no", "user-invocable: No\n"),
                skill("user-only", "disable-model-invocation: true\n"),
            ]
        };
        let names = |s: Vec<TaskSkill>| s.into_iter().map(|s| s.name).collect::<Vec<_>>();
        // Claude Code won't run `/hidden`, even if a run reported a skill by that name.
        let got = with_board_skills(found(&["zeta", "hidden", "deploy"]), board(), false, &["zeta".into()]);
        assert_eq!(got[0], TaskSkill { name: "deploy".into(), description: "deploy (board)".into() });
        assert_eq!(names(got), ["deploy", "user-only"]);
        // Codex has no such setting.
        assert_eq!(names(with_board_skills(Vec::new(), board(), true, &[])), ["deploy", "hidden", "no", "user-only"]);
    }

    #[test]
    fn global_ones_follow_the_profile_unless_the_project_overrides() {
        use crate::db::{NewProject, insert_profile, insert_project};
        let c = crate::db::open(FsPath::new(":memory:")).unwrap();
        let profile = insert_profile(&c, "p", &[], None).unwrap();
        let new = |id| NewProject { id, profile_id: &profile.id, name: id, key: "X", repo_path: "/x", scratch_path: "/s", worktrees_root: "/w", base_branch: None, use_worktrees: false };
        let (a, b) = (insert_project(&c, new("a")).unwrap(), insert_project(&c, new("b")).unwrap());
        let skill = |project: Option<&str>, name: &str| create_skill_in(&c, project, SkillBody { content: Some(format!("---\nname: {name}\ndescription: d\n---\n")), enabled: None }).unwrap();
        let (on, off) = (skill(None, "on"), skill(None, "off"));
        skill(Some("a"), "own");
        let set = |scope: &str, scope_id: &str, item: &str, v: bool| {
            c.execute("INSERT OR REPLACE INTO agent_tool_switches VALUES (?1,?2,?3,?4)", params![scope, scope_id, item, v]).unwrap();
        };
        set("profile", &profile.id, &on.id, true);
        set("project", "b", &on.id, false);
        set("project", "b", &off.id, true);
        let names = |p: &crate::db::Project| effective(&c, p).unwrap().0.into_iter().map(|s| s.name).collect::<Vec<_>>();
        assert_eq!(names(&a), ["own", "on"]);
        assert_eq!(names(&b), ["off"]);
        // A project's own one takes the name while it's on, and the global one is used while it's off.
        let mine = skill(Some("a"), "on");
        let owners = |p: &crate::db::Project| effective(&c, p).unwrap().0.into_iter().map(|s| s.project_id).collect::<Vec<_>>();
        assert_eq!(owners(&a), [Some("a".to_string()), Some("a".to_string())]);
        update_skill_in(&c, Some("a"), &mine.id, SkillBody { content: None, enabled: Some(false) }).unwrap();
        assert_eq!(names(&a), ["own", "on"]);
        assert_eq!(owners(&a), [Some("a".to_string()), None]);
        // Deleting a global skill drops its switches.
        c.execute("DELETE FROM agent_skills WHERE id=?1", [&off.id]).unwrap();
        assert!(switches(&c, "project", "b").unwrap().get(&off.id).is_none());
    }

    #[test]
    fn records_what_runs_had() {
        let c = crate::db::open(FsPath::new(":memory:")).unwrap();
        c.execute_batch("PRAGMA foreign_keys=OFF;").unwrap();
        let init = json!({
            "skills": ["zeta", "alpha"],
            "mcp_servers": [{"name": MCP_SERVER_NAME, "status": "connected"}, {"name": "claude.ai Gmail", "status": "needs-auth", "source": "claudeai"}],
        });
        record_seen(&c, "p", Some("cfg"), &init).unwrap();
        let names = |key: &str| -> Vec<String> {
            let o = get_overrides(&c, "p").unwrap();
            o.seen["cfg"][key].as_array().unwrap().iter().map(|v| v["name"].as_str().unwrap().to_string()).collect()
        };
        assert_eq!(names("skills"), ["alpha", "zeta"]);
        assert_eq!(names("mcp_servers"), ["claude.ai Gmail"]);
        // A later run that doesn't report everything keeps what earlier ones had...
        record_seen(&c, "p", Some("cfg"), &json!({"skills": ["beta"], "mcp_servers": []})).unwrap();
        assert_eq!(names("skills"), ["alpha", "beta", "zeta"]);
        assert_eq!(names("mcp_servers"), ["claude.ai Gmail"]);
        // ...until it's old.
        let mut o = get_overrides(&c, "p").unwrap();
        o.seen["cfg"]["skills"][0]["at"] = json!("2000-01-01T00:00:00.000Z");
        set_overrides(&c, "p", &o).unwrap();
        record_seen(&c, "p", Some("cfg"), &json!({"skills": ["beta"]})).unwrap();
        assert_eq!(names("skills"), ["beta", "zeta"]);
    }
}
