//! Google Workspace for the assistant (API 102): Gmail, Calendar and Drive through a Google Workspace MCP server on the
//! assistant's host, with an OAuth client the user makes, rather than the claude.ai connectors, which come with the Claude
//! login and so would reach every agent on it, project tasks included.
//!
//! The server is [workspace-mcp](https://github.com/taylorwilsdon/google_workspace_mcp) (`uvx workspace-mcp`), a global
//! MCP server of the host named `google` (`SERVER`, the name the approval rules' Google defaults are written for), which
//! the profile switches on. Only the assistant and its routine threads get it: a project's runs skip it whatever their
//! switches say (see agent_tools::add_global). It runs in single-user mode, with Gmail, Calendar and Drive at its
//! `extended` tier, and reads its OAuth client from `client_secret.json` and its refresh token from
//! `credentials/<email>.json`, both in `~/.google_workspace_mcp` in the home of the user the host runs as, readable by
//! that user alone. It's the same in Claude's and Codex's runs: it's a stdio server like any other.
//!
//! The consent step needs a browser, which the host (often headless) hasn't got, and workspace-mcp's own runs only while
//! an agent's turn does, so `huntaway google-auth` (consent.rs) does it: it listens on the host's loopback, which
//! `ssh -L` brings to the user's machine, and writes the credentials file as workspace-mcp reads it.
//!
//! `status` is what the assistant's Google card shows: whether it's connected, as whom, and what's missing if it isn't.

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use axum::Json;
use axum::extract::{Path as UrlPath, Query, State};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::agent::agent_tools::{self, McpServer};
use crate::db;
use crate::state::{ApiError, ApiResult, Shared};
use crate::util::path_str;

pub mod consent;

/// The MCP server's name, so its tools are `mcp__google__<tool>` (agent/approval_rules.rs's `GOOGLE_SERVER`).
pub const SERVER: &str = "google";
/// The package `uvx` runs, pinned: a new release has to be picked, rather than run with the user's mail the day it's out.
pub const PACKAGE: &str = "workspace-mcp@2.3.0";
/// What it serves: Gmail, Calendar and Drive, at the tier with drafts, labels and Drive's listing.
pub const SERVER_ARGS: &[&str] = &["--single-user", "--tools", "gmail", "calendar", "drive", "--tool-tier", "extended"];
/// Where workspace-mcp looks for its OAuth client (`GOOGLE_CLIENT_SECRET_PATH`) and credentials
/// (`WORKSPACE_MCP_CREDENTIALS_DIR`), and the account it acts as (`USER_GOOGLE_EMAIL`).
pub const CLIENT_SECRET_ENV: &str = "GOOGLE_CLIENT_SECRET_PATH";
pub const CREDENTIALS_ENV: &str = "WORKSPACE_MCP_CREDENTIALS_DIR";
pub const EMAIL_ENV: &str = "USER_GOOGLE_EMAIL";
/// The port `huntaway google-auth` listens on by default (on 127.0.0.1), which `ssh -L` forwards.
pub const CONSENT_PORT: u16 = 8765;

/// The scopes workspace-mcp asks for with Gmail, Calendar and Drive (its auth/scopes.py), so the credentials consent.rs
/// writes are enough for every tool it serves and it doesn't ask to sign in again.
pub const SCOPES: &[&str] = &[
    "openid",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/gmail.compose",
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/gmail.labels",
    "https://www.googleapis.com/auth/gmail.settings.basic",
    "https://www.googleapis.com/auth/calendar",
    "https://www.googleapis.com/auth/calendar.readonly",
    "https://www.googleapis.com/auth/calendar.events",
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/drive.readonly",
    "https://www.googleapis.com/auth/drive.file",
];

/// The scopes the brief can't do without: reading mail, the calendar and Drive (a broader one covers each, as Google's do).
const NEEDED: &[(&str, &[&str])] = &[
    ("https://www.googleapis.com/auth/gmail.readonly", &["https://www.googleapis.com/auth/gmail.modify", "https://mail.google.com/"]),
    ("https://www.googleapis.com/auth/calendar.readonly", &["https://www.googleapis.com/auth/calendar"]),
    ("https://www.googleapis.com/auth/drive.readonly", &["https://www.googleapis.com/auth/drive"]),
];

pub fn is_google(server: &str) -> bool {
    server == SERVER
}

/// workspace-mcp's own folder, `~/.google_workspace_mcp`, where its defaults are.
pub fn home_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from(".")).join(".google_workspace_mcp")
}

pub fn default_client_secret() -> PathBuf {
    home_dir().join("client_secret.json")
}

pub fn default_credentials_dir() -> PathBuf {
    home_dir().join("credentials")
}

/// The server's `mcpServers` entry: `uvx` running workspace-mcp, with absolute paths (an MCP config doesn't expand `~`), and
/// the account to act as when it's known.
pub fn server_config(email: Option<&str>) -> Value {
    let mut env = json!({
        CLIENT_SECRET_ENV: path_str(&default_client_secret()),
        CREDENTIALS_ENV: path_str(&default_credentials_dir()),
    });
    if let Some(e) = email {
        env[EMAIL_ENV] = json!(e);
    }
    let args: Vec<&str> = [PACKAGE].into_iter().chain(SERVER_ARGS.iter().copied()).collect();
    json!({"type": "stdio", "command": "uvx", "args": args, "env": env})
}

/// A credentials file's name for an account, as workspace-mcp makes it (Python's `quote(email, safe="@._-")`).
pub fn credentials_file(email: &str) -> String {
    let mut name = String::new();
    for b in email.bytes() {
        if b.is_ascii_alphanumeric() || b"@._-".contains(&b) {
            name.push(b as char);
        } else {
            name.push_str(&format!("%{b:02X}"));
        }
    }
    format!("{name}.json")
}

/// The account a credentials file is for, from its name (undoing `credentials_file`), if it's one.
fn account_of(file: &str) -> Option<String> {
    let stem = file.strip_suffix(".json")?;
    let bytes = stem.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        let hex = (bytes[i] == b'%').then(|| bytes.get(i + 1..i + 3)).flatten().and_then(|h| std::str::from_utf8(h).ok()).and_then(|h| u8::from_str_radix(h, 16).ok());
        match hex {
            Some(b) => {
                out.push(b);
                i += 3;
            }
            None => {
                out.push(bytes[i]);
                i += 1;
            }
        }
    }
    let email = String::from_utf8(out).ok()?;
    email.contains('@').then_some(email)
}

/// Whether a file can be read by others than its owner.
fn private(meta: &std::fs::Metadata) -> bool {
    meta.permissions().mode() & 0o077 == 0
}

/// A file the server reads, as the card shows it.
#[derive(Serialize, Debug, PartialEq)]
pub struct FileState {
    pub path: String,
    pub exists: bool,
    /// Readable by its owner alone.
    pub private: bool,
}

fn file_state(path: &Path) -> FileState {
    let meta = std::fs::metadata(path).ok();
    FileState { path: path_str(path), exists: meta.as_ref().is_some_and(|m| m.is_file()), private: meta.as_ref().is_some_and(private) }
}

/// An account with credentials in the server's folder.
#[derive(Serialize, Debug, PartialEq)]
pub struct Account {
    pub email: String,
    pub file: String,
    /// It has a refresh token, so the server can go on using it (without one it lasts an hour).
    pub refresh_token: bool,
    pub private: bool,
    pub scopes: Vec<String>,
    /// What the brief needs that it wasn't granted (an unticked box on Google's consent screen).
    pub missing_scopes: Vec<String>,
}

/// The accounts with credentials in `dir`, by email.
pub fn accounts(dir: &Path) -> Vec<Account> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut out: Vec<Account> = entries
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            let email = account_of(&name)?;
            let meta = std::fs::metadata(e.path()).ok().filter(|m| m.is_file())?;
            let v: Value = std::fs::read_to_string(e.path()).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null);
            let scopes: Vec<String> = v["scopes"].as_array().into_iter().flatten().filter_map(|s| s.as_str().map(String::from)).collect();
            let missing_scopes = NEEDED
                .iter()
                .filter(|(s, broader)| !scopes.iter().any(|g| g == s || broader.contains(&g.as_str())))
                .map(|(s, _)| s.to_string())
                .collect();
            Some(Account {
                email,
                file: path_str(&e.path()),
                refresh_token: v["refresh_token"].as_str().is_some_and(|t| !t.is_empty()),
                private: private(&meta),
                scopes,
                missing_scopes,
            })
        })
        .collect();
    out.sort_by(|a, b| a.email.cmp(&b.email));
    out
}

/// The Google server on this host, as the card shows it.
#[derive(Serialize, Debug)]
pub struct ServerState {
    pub id: String,
    pub enabled: bool,
    /// The profile switches it on (its assistant's runs get it).
    pub on: bool,
    pub command: String,
    /// The command is on this host's PATH (or is a path to a program).
    pub command_found: bool,
}

/// Whether Google is connected for a profile's assistant here, and if not, why not.
#[derive(Serialize, Debug)]
pub struct Status {
    pub connected: bool,
    /// The account it acts as.
    pub account: Option<String>,
    /// What's in the way, in words, when it isn't connected.
    pub problem: Option<String>,
    /// What's off but doesn't stop it.
    pub warnings: Vec<String>,
    pub server: Option<ServerState>,
    pub client_secret: FileState,
    pub credentials_dir: String,
    pub accounts: Vec<Account>,
    /// What to run on this host to sign in (see consent.rs).
    pub consent_command: String,
    /// This host's name, for the ssh command.
    pub host: String,
    /// The port the consent command listens on.
    pub consent_port: u16,
}

/// Whether `cmd` can be run: a path to a file, or a name found on PATH.
pub fn command_found(cmd: &str) -> bool {
    let cmd = cmd.trim();
    if cmd.is_empty() {
        return false;
    }
    let runnable = |p: &Path| std::fs::metadata(p).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0);
    if cmd.contains('/') {
        return runnable(&crate::util::expand_tilde(cmd));
    }
    std::env::var_os("PATH").is_some_and(|path| std::env::split_paths(&path).any(|d| runnable(&d.join(cmd))))
}

/// A config's env value, if it sets it (and it isn't blank).
fn env_of<'a>(config: &'a Value, key: &str) -> Option<&'a str> {
    config["env"][key].as_str().map(str::trim).filter(|v| !v.is_empty())
}

/// Profile `profile_id`'s Google status on this host.
pub fn status(s: &Shared, profile_id: &str) -> ApiResult<Status> {
    let server: Option<McpServer> = agent_tools::global_mcp_server(&s.db(), SERVER)?;
    let on = match &server {
        Some(m) => agent_tools::profile_switch(&s.db(), profile_id, &m.id)?.unwrap_or(false),
        None => false,
    };
    let config = server.as_ref().map(|m| m.config.clone()).unwrap_or(Value::Null);
    let secret = env_of(&config, CLIENT_SECRET_ENV).map(crate::util::expand_tilde).unwrap_or_else(default_client_secret);
    let creds = env_of(&config, CREDENTIALS_ENV).map(crate::util::expand_tilde).unwrap_or_else(default_credentials_dir);
    // The client's id and secret can be given in the env instead of a file.
    let secret_in_env = env_of(&config, "GOOGLE_OAUTH_CLIENT_ID").is_some() && env_of(&config, "GOOGLE_OAUTH_CLIENT_SECRET").is_some();
    let client_secret = file_state(&secret);
    let accounts = accounts(&creds);
    let wanted = env_of(&config, EMAIL_ENV).map(String::from);
    let server_state = server.as_ref().map(|m| {
        let command = m.config["command"].as_str().unwrap_or("").to_string();
        ServerState { id: m.id.clone(), enabled: m.enabled, on, command_found: command_found(&command), command }
    });
    let mut warnings = Vec::new();
    let account = match &wanted {
        Some(w) => accounts.iter().find(|a| a.email.eq_ignore_ascii_case(w)),
        None => accounts.iter().find(|a| a.refresh_token).or(accounts.first()),
    };
    let consent_command = format!("huntaway google-auth --client-secret {}", path_str(&secret));
    let problem = match (&server_state, account) {
        (None, _) => Some("There's no Google server on this host yet: add it here.".to_string()),
        (Some(m), _) if !m.enabled => Some("The Google server is switched off (Settings → Agent tools).".into()),
        (Some(m), _) if !m.on => Some("The Google server isn't switched on for this profile: switch it on here.".into()),
        (Some(m), _) if !m.command_found => Some(format!("{} isn't on this host's PATH: install uv (https://docs.astral.sh/uv/) for the user the host runs as.", m.command)),
        _ if !client_secret.exists && !secret_in_env => Some(format!("There's no OAuth client at {}: download your Desktop app client's JSON there.", client_secret.path)),
        (_, None) if wanted.is_some() => Some(format!("There are no credentials for {} in {}: sign in with {consent_command}.", wanted.clone().unwrap_or_default(), path_str(&creds))),
        (_, None) => Some(format!("Not signed in to Google yet: run {consent_command} on this host (see the README's An assistant host).")),
        (_, Some(a)) if !a.refresh_token => Some(format!("{}'s credentials have no refresh token, so they stop working within the hour: sign in again with {consent_command}.", a.email)),
        _ => None,
    };
    if let Some(a) = account {
        if !a.private {
            warnings.push(format!("{} can be read by other users on this host: chmod 600 it.", a.file));
        }
        if !a.missing_scopes.is_empty() {
            warnings.push(format!("{} wasn't given everything the brief reads ({}): sign in again and tick every box.", a.email, a.missing_scopes.join(", ")));
        }
    }
    if client_secret.exists && !client_secret.private {
        warnings.push(format!("{} can be read by other users on this host: chmod 600 it.", client_secret.path));
    }
    if wanted.is_none() && accounts.len() > 1 {
        warnings.push(format!("There are credentials for {} accounts: set {EMAIL_ENV} in the server's env to pick one.", accounts.len()));
    }
    Ok(Status {
        connected: problem.is_none(),
        account: account.filter(|_| problem.is_none()).map(|a| a.email.clone()),
        problem,
        warnings,
        server: server_state,
        client_secret,
        credentials_dir: path_str(&creds),
        accounts,
        consent_command,
        host: s.host_name.clone(),
        consent_port: CONSENT_PORT,
    })
}

/// What a routine's `{{google}}` says (see automations::delivery): `connected as <email>`, or `not connected: <why>`.
pub fn status_line(s: &Shared, profile_id: &str) -> String {
    match status(s, profile_id) {
        Ok(st) if st.connected => format!("connected as {}", st.account.unwrap_or_default()),
        Ok(st) => format!("not connected: {}", st.problem.unwrap_or_default()),
        Err(e) => format!("not connected: its status couldn't be read ({})", e.1),
    }
}

#[derive(Deserialize, Default)]
pub struct StatusQuery {
    /// Also ask Google whether the refresh token still works (see consent::verify).
    #[serde(default)]
    check: Option<String>,
}

/// `GET /profiles/{id}/assistant/google[?check=1]` (API 102): the Google card's status. With `check`, the account's refresh
/// token is tried with Google too (`verified`, or `verify_error` saying why it failed).
pub async fn get(State(s): State<Shared>, UrlPath(id): UrlPath<String>, Query(q): Query<StatusQuery>) -> ApiResult<Json<Value>> {
    super::memory::elsewhere(&s, &id)?;
    let st = status(&s, &id)?;
    let mut v = json!(st);
    if q.check.is_some_and(|c| !c.is_empty() && c != "0") && st.connected {
        let file = st.accounts.iter().find(|a| Some(&a.email) == st.account.as_ref()).map(|a| PathBuf::from(&a.file));
        let secret = PathBuf::from(&st.client_secret.path);
        match file {
            Some(f) => match consent::verify(&f, st.client_secret.exists.then_some(secret.as_path())).await {
                Ok(()) => v["verified"] = json!(true),
                Err(e) => {
                    v["verified"] = json!(false);
                    v["verify_error"] = json!(format!("{e:#}"));
                }
            },
            None => v["verified"] = json!(false),
        }
    }
    Ok(Json(v))
}

/// `POST /profiles/{id}/assistant/google` (API 102): add the Google server to this host (if it hasn't one called `google`)
/// and switch it on for the profile. A server that's there keeps its config. Returns the status.
pub async fn setup(State(s): State<Shared>, UrlPath(id): UrlPath<String>) -> ApiResult<Json<Value>> {
    super::memory::elsewhere(&s, &id)?;
    {
        let c = s.db();
        db::get_profile(&c, &id)?.ok_or_else(|| ApiError::not_found("profile"))?;
        let server = match agent_tools::global_mcp_server(&c, SERVER)? {
            Some(m) => m,
            None => {
                // The account to act as, if there's one signed in already.
                let signed_in: Vec<Account> = accounts(&default_credentials_dir()).into_iter().filter(|a| a.refresh_token).collect();
                let email = (signed_in.len() == 1).then(|| signed_in[0].email.as_str());
                agent_tools::add_global_mcp_server(&c, SERVER, server_config(email))?
            }
        };
        agent_tools::set_profile_switch(&c, &id, &server.id, true)?;
    }
    Ok(Json(json!(status(&s, &id)?)))
}

#[cfg(test)]
mod tests;
