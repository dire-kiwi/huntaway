//! Profiles (one per Claude login) and Claude configs (the config folders profiles and tasks run with).

use super::*;

/// An agent's config directory (its login, settings and history): Claude Code's, passed to
/// agents as CLAUDE_CONFIG_DIR, or Codex's, passed as CODEX_HOME. Profiles and projects pick
/// which ones their threads can use, so a thread's config also decides which agent runs it.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ClaudeConfig {
    pub id: String,
    pub name: String,
    /// May start with `~`. Empty means the agent's default (`~/.claude`, `~/.codex`).
    pub config_dir: String,
    /// One of AGENTS.
    pub agent: String,
    /// Whether the board fetches and shows its plan's usage limits (see usage.rs).
    pub show_usage: bool,
    /// Whether the board starts its plan's next 5-hour window as soon as one ends (see window.rs).
    #[serde(default)]
    pub restart_window: bool,
    pub created_at: String,
}

impl ClaudeConfig {
    fn from_row(r: &Row) -> rusqlite::Result<Self> {
        Ok(Self {
            id: r.get("id")?,
            name: r.get("name")?,
            config_dir: r.get("config_dir")?,
            agent: r.get("agent")?,
            show_usage: r.get("show_usage")?,
            restart_window: r.get("restart_window")?,
            created_at: r.get("created_at")?,
        })
    }

    pub fn is_codex(&self) -> bool {
        self.agent == "codex"
    }

    /// The config directory, with the agent's default for an empty one. May start with `~`.
    pub fn dir(&self) -> &str {
        match self.config_dir.trim() {
            "" if self.is_codex() => "~/.codex",
            "" => "~/.claude",
            d => d,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Profile {
    pub id: String,
    pub name: String,
    /// The Claude configs its threads can use, the default first.
    pub claude_config_ids: Vec<String>,
    /// The default config's directory, for clients from before configs were separate.
    pub claude_config_dir: String,
    pub default_model: Option<String>,
    /// Names of the other profiles whose agents may read and change this profile's board
    /// through their board tools (`*` for every profile). Names, since profiles are matched by
    /// name across hosts.
    pub agent_access: Vec<String>,
    /// The GitHub account its agents' gh tools act as (see gh_mcp.rs): a login on github.com, or
    /// `HOST/LOGIN` for another GitHub host. None uses gh's active account on the host.
    #[serde(default)]
    pub github_account: Option<String>,
    /// The folder the new project dialog's GitHub tab clones repositories into, each into a
    /// folder of its own. None for `~/<name>` (see `clone_dir_or_default`). May start with `~`.
    #[serde(default)]
    pub clone_dir: Option<String>,
    /// The Asana personal access token its tasks' Asana links are looked up with (see asana.rs).
    /// Never sent to the board, which sees `asana_user` instead.
    #[serde(default, skip_serializing)]
    pub asana_token: Option<String>,
    /// Who the Asana token belongs to, as Asana named them when it was set; None when there's none.
    #[serde(default)]
    pub asana_user: Option<String>,
    /// Whether it uses Asana (API 60): off, its tasks can't be linked to Asana tasks and the
    /// board leaves Asana out. Its token is kept, for when it's turned on again.
    #[serde(default = "yes")]
    pub asana_enabled: bool,
    /// When a run stops because its config's usage limit ran out, its task waits in "In progress"
    /// for the limit to reset and then carries on, and tasks started on a config that's out wait
    /// for it too (API 81, see usage.rs). Off, the task needs attention, offering to do that.
    #[serde(default)]
    pub limit_wait: bool,
    /// Tasks whose agent hasn't started yet start on the next of their configs that isn't out of
    /// usage, when theirs is (API 81).
    #[serde(default)]
    pub limit_switch: bool,
    /// Who reviews the tasks of its projects that have no reviewers of their own (API 87, see
    /// `reviewers_for`). Empty is one reviewer with the task's config.
    #[serde(default)]
    pub reviewers: Vec<Reviewer>,
    /// Who summarises them, for its projects with no summarizer of their own (API 87, see
    /// `summarizer_for`). None is the task's config with the default model and effort.
    #[serde(default)]
    pub summarizer: Option<Reviewer>,
    /// A task moved to "Ready for merge" has its agent summarise what it would merge, and merges
    /// only once the user approves (API 92, see merge_gate.rs). Its projects can say otherwise.
    #[serde(default)]
    pub merge_approval: bool,
    pub created_at: String,
}

pub(super) fn yes() -> bool {
    true
}

/// Profiles with the directory of their default config.
const PROFILE_SELECT: &str = "SELECT p.*, (SELECT config_dir FROM claude_configs WHERE id=json_extract(p.claude_config_ids, '$[0]')) AS default_config_dir FROM profiles p";

impl Profile {
    fn from_row(r: &Row) -> rusqlite::Result<Self> {
        Ok(Self {
            id: r.get("id")?,
            name: r.get("name")?,
            claude_config_ids: json_list(r.get("claude_config_ids")?),
            claude_config_dir: r.get::<_, Option<String>>("default_config_dir")?.unwrap_or_default(),
            default_model: r.get("default_model")?,
            agent_access: json_list(r.get("agent_access")?),
            github_account: r.get("github_account")?,
            clone_dir: r.get("clone_dir")?,
            asana_token: r.get("asana_token")?,
            asana_user: r.get("asana_user")?,
            asana_enabled: r.get("asana_enabled")?,
            limit_wait: r.get("limit_wait")?,
            limit_switch: r.get("limit_switch")?,
            reviewers: r.get::<_, Option<String>>("reviewers")?.and_then(|v| serde_json::from_str(&v).ok()).unwrap_or_default(),
            summarizer: r.get::<_, Option<String>>("summarizer")?.and_then(|v| serde_json::from_str(&v).ok()),
            merge_approval: r.get("merge_approval")?,
            created_at: r.get("created_at")?,
        })
    }

    /// Whether agents in the profile named `name` may use this profile's board.
    pub fn grants(&self, name: &str) -> bool {
        self.name == name || self.agent_access.iter().any(|n| n == "*" || n == name)
    }

    /// The folder its repositories are cloned into: its own, or `~/<name>`. May start with `~`.
    pub fn clone_dir_or_default(&self) -> String {
        match self.clone_dir.as_deref().map(str::trim) {
            Some(d) if !d.is_empty() => d.to_string(),
            _ => default_clone_dir(&self.name),
        }
    }
}

/// The clone folder of a profile that hasn't picked one: `~/<name>` (`~/work`, `~/personal`).
/// The UI has the same (`defaultCloneDir`).
pub fn default_clone_dir(name: &str) -> String {
    let name = name.trim().replace('/', "-");
    if name.is_empty() || name == "." || name == ".." { "~".into() } else { format!("~/{name}") }
}

// ---------- profiles ----------

pub fn list_profiles(c: &Connection) -> Result<Vec<Profile>> {
    let mut st = c.prepare(&format!("{PROFILE_SELECT} ORDER BY p.created_at"))?;
    let rows = st.query_map([], Profile::from_row)?.collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

pub fn get_profile(c: &Connection, id: &str) -> Result<Option<Profile>> {
    Ok(c.query_row(&format!("{PROFILE_SELECT} WHERE p.id=?1"), [id], Profile::from_row).optional()?)
}

/// Who reviews `project`'s tasks: its own reviewers, or else its profile's, or else one reviewer
/// with the task's config.
pub fn reviewers_for(c: &Connection, project: &Project) -> Result<Vec<Reviewer>> {
    if !project.reviewers.is_empty() {
        return Ok(project.reviewers.clone());
    }
    let profile = get_profile(c, &project.profile_id)?.map(|p| p.reviewers).unwrap_or_default();
    Ok(if profile.is_empty() { vec![Reviewer::default()] } else { profile })
}

/// Who summarises `project`'s tasks: its own summarizer, or else its profile's, or else the
/// task's config with the defaults.
pub fn summarizer_for(c: &Connection, project: &Project) -> Result<Reviewer> {
    if let Some(r) = &project.summarizer {
        return Ok(r.clone());
    }
    Ok(get_profile(c, &project.profile_id)?.and_then(|p| p.summarizer).unwrap_or_default())
}

pub fn insert_profile(c: &Connection, name: &str, config_ids: &[String], model: Option<&str>) -> Result<Profile> {
    let id = new_id();
    c.execute(
        "INSERT INTO profiles (id,name,claude_config_ids,default_model,created_at) VALUES (?1,?2,?3,?4,?5)",
        params![id, name, json!(config_ids).to_string(), model, now()],
    )?;
    Ok(get_profile(c, &id)?.unwrap())
}

/// A profile called `name` with the Claude config in `dir` (see `config_for_dir`), unless there's
/// a profile of that name already, which is left as it is. Some(the new profile) if it made one.
pub fn ensure_profile(c: &Connection, name: &str, dir: &str) -> Result<Option<Profile>> {
    if list_profiles(c)?.iter().any(|p| p.name.eq_ignore_ascii_case(name)) {
        return Ok(None);
    }
    let config = config_for_dir(c, name, dir)?;
    Ok(Some(insert_profile(c, name, &[config], None)?))
}

// ---------- Claude configs ----------

pub fn list_claude_configs(c: &Connection) -> Result<Vec<ClaudeConfig>> {
    let mut st = c.prepare("SELECT * FROM claude_configs ORDER BY name COLLATE NOCASE, created_at")?;
    let rows = st.query_map([], ClaudeConfig::from_row)?.collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

pub fn get_claude_config(c: &Connection, id: &str) -> Result<Option<ClaudeConfig>> {
    Ok(c.query_row("SELECT * FROM claude_configs WHERE id=?1", [id], ClaudeConfig::from_row).optional()?)
}

pub fn insert_claude_config(c: &Connection, name: &str, config_dir: &str, agent: &str) -> Result<ClaudeConfig> {
    let id = new_id();
    c.execute(
        "INSERT INTO claude_configs (id,name,config_dir,agent,created_at) VALUES (?1,?2,?3,?4,?5)",
        params![id, name, config_dir.trim(), agent, now()],
    )?;
    Ok(get_claude_config(c, &id)?.unwrap())
}

const CLAUDE_CONFIG_COLUMNS: &[&str] = &["name", "config_dir", "agent", "show_usage", "restart_window"];

pub fn update_claude_config(c: &Connection, id: &str, fields: &[(&str, Value)]) -> Result<Option<ClaudeConfig>> {
    update_generic(c, "claude_configs", CLAUDE_CONFIG_COLUMNS, id, fields)?;
    get_claude_config(c, id)
}

/// Delete a config and take it off every profile and project. Threads that ran with it go
/// back to their project's or profile's default.
pub fn delete_claude_config(c: &Connection, id: &str) -> Result<()> {
    c.execute("DELETE FROM claude_configs WHERE id=?1", [id])?;
    let drop = |list: Vec<String>| json!(list.into_iter().filter(|x| x != id).collect::<Vec<_>>()).to_string();
    for p in list_profiles(c)?.into_iter().filter(|p| p.claude_config_ids.iter().any(|x| x == id)) {
        c.execute("UPDATE profiles SET claude_config_ids=?1 WHERE id=?2", params![drop(p.claude_config_ids), p.id])?;
    }
    let projects: Vec<(String, String)> = {
        let mut st = c.prepare("SELECT id, claude_config_ids FROM projects WHERE claude_config_ids IS NOT NULL")?;
        st.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<rusqlite::Result<_>>()?
    };
    for (pid, ids) in projects {
        let ids = json_list(ids);
        if ids.iter().any(|x| x == id) {
            let rest: Vec<String> = ids.into_iter().filter(|x| x != id).collect();
            // An override left empty goes back to the profile's.
            let v = (!rest.is_empty()).then(|| json!(rest).to_string());
            c.execute("UPDATE projects SET claude_config_ids=?1 WHERE id=?2", params![v, pid])?;
        }
    }
    Ok(())
}

/// The config using `dir`, creating one called `name` if there's none.
pub fn config_for_dir(c: &Connection, name: &str, dir: &str) -> Result<String> {
    let dir = dir.trim();
    let sql = "SELECT id FROM claude_configs WHERE config_dir=?1 AND agent='claude' ORDER BY created_at LIMIT 1";
    if let Some(id) = c.query_row(sql, [dir], |r| r.get(0)).optional()? {
        return Ok(id);
    }
    Ok(insert_claude_config(c, name, dir, "claude")?.id)
}

/// The configs a new thread can pick from: its project's override, else its profile's, the
/// default first.
pub fn available_configs(c: &Connection, profile_id: &str, project: Option<&Project>) -> Result<Vec<ClaudeConfig>> {
    let ids = match project.and_then(|p| p.claude_config_ids.clone()).filter(|ids| !ids.is_empty()) {
        Some(ids) => ids,
        None => get_profile(c, profile_id)?.map(|p| p.claude_config_ids).unwrap_or_default(),
    };
    let mut out = Vec::new();
    for id in ids {
        if let Some(cfg) = get_claude_config(c, &id)? {
            out.push(cfg);
        }
    }
    Ok(out)
}

/// The config a thread runs with: its own, else the default for its project and profile.
/// None means Claude's default config.
pub fn task_claude_config(c: &Connection, task: &Task) -> Result<Option<ClaudeConfig>> {
    match task.claude_config_id.as_deref() {
        Some(id) => {
            if let Some(cfg) = get_claude_config(c, id)? {
                return Ok(Some(cfg));
            }
        }
        // A thread is given a config when it starts (see runner::launch), so one that has a
        // session without one started in Claude's default config, and its conversation is there.
        None if task.session_id.is_some() => return Ok(None),
        None => {}
    }
    let project = task.project_id.as_deref().map(|id| get_project(c, id)).transpose()?.flatten();
    Ok(available_configs(c, &task.profile_id, project.as_ref())?.into_iter().next())
}

/// The CLAUDE_CONFIG_DIR (or, for Codex, CODEX_HOME) for a thread, if it isn't the agent's default.
pub fn task_config_dir(c: &Connection, task: &Task) -> Result<Option<String>> {
    Ok(task_claude_config(c, task)?.map(|cfg| cfg.config_dir).filter(|d| !d.trim().is_empty()))
}

/// Whether a thread runs on Codex rather than Claude Code (see codex.rs).
pub fn task_is_codex(c: &Connection, task: &Task) -> Result<bool> {
    Ok(task_claude_config(c, task)?.is_some_and(|cfg| cfg.is_codex()))
}

const PROFILE_COLUMNS: &[&str] = &["name", "claude_config_ids", "default_model", "agent_access", "github_account", "clone_dir", "asana_token", "asana_user", "asana_enabled", "limit_wait", "limit_switch", "reviewers", "summarizer", "merge_approval"];

pub fn update_profile(c: &Connection, id: &str, fields: &[(&str, Value)]) -> Result<Option<Profile>> {
    update_generic(c, "profiles", PROFILE_COLUMNS, id, fields)?;
    get_profile(c, id)
}
