//! `huntaway gh-mcp`: a stdio MCP server that runs the GitHub CLI for agents. Claude Code can
//! sandbox Bash, and there `gh` (and `git push`) often can't reach GitHub or the user's stored
//! login. MCP servers run outside the sandbox, so going through these tools works either way.
//! Every run gets it as the `gh` server (see `runs::start`), working in the run's directory.
//!
//! A profile (on each host) can pick the GitHub account its agents act as, and a project can
//! pick its own (`github_account`). The run passes it as `IA_GH_ACCOUNT`, and each call then runs
//! with that account's token from gh's own logins (`gh auth token --user`), whichever account is
//! active in gh, and with no other credentials (see `GhEnv`). Claude runs also get `huntaway gh-hook`, which turns away `gh` in Bash in favour
//! of these tools.

use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use serde_json::{Value, json};
use tokio::io::AsyncWriteExt;

pub const SERVER_NAME: &str = "gh";

/// Tools that only read, so they run without asking (`--allowedTools mcp__gh__<name>`).
pub const READ_ONLY: &[&str] = &["pr_view", "pr_list", "pr_checks", "pr_diff", "issue_view", "issue_list", "run_list", "run_view"];

/// The rest, which reviewers don't get.
pub const WRITES: &[&str] = &["pr_create", "pr_comment", "pr_edit", "pr_merge", "issue_create", "issue_comment", "api", "gh", "git_push"];

/// Sent with `initialize`; Claude Code adds it to the agent's system prompt.
const INSTRUCTIONS: &str = "GitHub through the gh CLI, run outside any sandbox with the user's GitHub login. Use these \
tools instead of running gh in Bash (where it may not reach GitHub or its login, or act as the wrong account), and \
git_push instead of `git push` if that fails. They work in your working directory's repository by default; pass repo \
(OWNER/REPO) for another one, or dir to run in another checkout. pr_* tools take a pull request number, URL or branch, \
defaulting to the current branch's PR. For anything else, call the gh tool with gh's arguments.";

/// The environment variable a run's account comes in (see `Account`).
pub const ACCOUNT_ENV: &str = "IA_GH_ACCOUNT";

/// A GitHub account gh is signed in to: a login on github.com, or `HOST/LOGIN` on another
/// GitHub host (Enterprise Cloud with data residency, `*.ghe.com`, or Enterprise Server).
#[derive(Debug, PartialEq, Clone)]
pub struct Account {
    pub host: String,
    pub login: String,
}

impl Account {
    pub fn parse(s: &str) -> Option<Self> {
        let s = s.trim();
        let (host, login) = s.split_once('/').unwrap_or(("github.com", s));
        // Logins are letters, digits and hyphens (Enterprise managed users add `_shortcode`).
        let login_ok = !login.is_empty() && login.len() <= 100 && !login.starts_with('-') && login.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
        let host_ok = !host.is_empty() && !host.starts_with(['-', '.']) && host.chars().all(|c| c.is_ascii_alphanumeric() || ".-:".contains(c));
        (login_ok && host_ok).then(|| Self { host: host.to_ascii_lowercase(), login: login.to_string() })
    }

    /// The run's account, if it has one.
    fn from_env() -> Option<Self> {
        Self::parse(&std::env::var(ACCOUNT_ENV).ok()?)
    }

    fn is_github_com(&self) -> bool {
        self.host == "github.com"
    }

    /// The account's token from gh's logins on this host.
    async fn token(&self) -> Result<String> {
        let out = tokio::process::Command::new(gh_program())
            .args(["auth", "token", &format!("--hostname={}", self.host), &format!("--user={}", self.login)])
            // Its own token, not one in the environment.
            .env_remove("GH_TOKEN")
            .env_remove("GITHUB_TOKEN")
            .env_remove("GH_ENTERPRISE_TOKEN")
            .env_remove("GITHUB_ENTERPRISE_TOKEN")
            .stdin(Stdio::null())
            .kill_on_drop(true)
            .output();
        let out = tokio::time::timeout(Duration::from_secs(30), out)
            .await
            .map_err(|_| anyhow!("couldn't get a token for the GitHub account {self}: gh auth token timed out"))?
            .with_context(|| format!("couldn't get a token for the GitHub account {self}: couldn't run gh"))?;
        let token = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if !out.status.success() || token.is_empty() {
            bail!(
                "the GitHub account {self} isn't signed in to gh on this host ({}). Sign in to it with `gh auth login{}`, or pick \
                 another account in the profile's or project's settings.",
                String::from_utf8_lossy(&out.stderr).trim(),
                if self.is_github_com() { String::new() } else { format!(" --hostname {}", self.host) }
            );
        }
        Ok(token)
    }

    /// The environment that makes gh act as the account and no other, given its token: see `GhEnv`.
    fn env(&self, token: &str) -> Result<GhEnv> {
        use std::io::Write;
        use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
        let root = dirs::cache_dir().unwrap_or_else(std::env::temp_dir).join("huntaway").join("gh-account");
        std::fs::create_dir_all(&root).with_context(|| format!("couldn't create {}", root.display()))?;
        // Left behind by a process that was killed while gh ran.
        let stale = std::time::SystemTime::now() - Duration::from_secs(24 * 3600);
        for e in std::fs::read_dir(&root).into_iter().flatten().flatten() {
            if e.metadata().and_then(|m| m.modified()).is_ok_and(|t| t < stale) {
                let _ = std::fs::remove_dir_all(e.path());
            }
        }
        let dir = root.join(crate::util::new_id());
        std::fs::DirBuilder::new().mode(0o700).create(&dir).with_context(|| format!("couldn't create {}", dir.display()))?;
        let env = GhEnv { account: self.clone(), dir };
        // As gh writes a login it keeps out of the keyring (`gh auth login --insecure-storage`).
        // JSON strings are YAML's double-quoted ones.
        let (host, login, token) = (json!(self.host), json!(self.login), json!(token));
        let hosts = format!(
            "{host}:\n    users:\n        {login}:\n            oauth_token: {token}\n    oauth_token: {token}\n    user: {login}\n    git_protocol: https\n"
        );
        let mut f = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(env.dir.join("hosts.yml"))?;
        f.write_all(hosts.as_bytes())?;
        Ok(env)
    }

    /// Whether `host` (of a URL) is one of the account's: its host, or its API's (`api.github.com`
    /// for github.com, `api.acme.ghe.com` for `acme.ghe.com`; Enterprise Server's API is on its
    /// host), uploads' or gists' (`gist.github.com`).
    fn owns_host(&self, host: &str) -> bool {
        let host = host.to_ascii_lowercase();
        host == self.host || ["api.", "uploads.", "gist."].iter().any(|p| host.strip_prefix(p) == Some(self.host.as_str()))
    }

    /// Fails if a gh command (its arguments and `GH_REPO`) names a host other than the account's,
    /// where gh would act as another account (or send this one's token): `--hostname`, a
    /// repository given as `HOST/OWNER/REPO` or a URL (with `--repo`, `--source` or
    /// `--branch-repo`), and the command's arguments that say where it goes, as its help has them:
    /// URLs as a pull request, issue or gist (`gh pr view <url>`) or API endpoint, and
    /// repositories as `HOST/OWNER/REPO`, `[USER@]HOST:PATH` or a URL (`gh repo clone <repository>`).
    /// What else it's given (texts, fields, search queries, a repository's homepage) isn't checked.
    /// Without its help (gh missing, a command gh doesn't have), every argument is, but options'
    /// values that are always content (see `CONTENT_OPTIONS`).
    fn check_targets<S: AsRef<str>>(&self, args: &[S], repo: Option<&str>) -> Result<()> {
        let args: Vec<&str> = args.iter().map(AsRef::as_ref).collect();
        let help = command_help(&args);
        self.check_targets_with(&args, repo, help.as_ref())
    }

    /// `check_targets` with the command's help (see `command_help`), if there is one.
    fn check_targets_with(&self, args: &[&str], repo: Option<&str>, help: Option<&CommandHelp>) -> Result<()> {
        let mut hosts: Vec<String> = Vec::new();
        hosts.extend(repo.and_then(repo_host));
        match help {
            Some(help) => hosts.extend(help.targets(args)),
            None => hosts.extend(fallback_targets(args)),
        }
        match hosts.iter().find(|h| !self.owns_host(h)) {
            Some(h) => bail!("this project's GitHub account is {self}, so the gh tools only reach {}: not {h}", self.host),
            None => Ok(()),
        }
    }

    /// Fails if git would use any of `urls` (see `push_urls`) as another account:
    /// on another host, or over HTTP(S) with credentials in the URL, which git uses instead of
    /// asking the credential helper for the account's (see `git_config`).
    fn check_git_urls(&self, urls: &[String]) -> Result<()> {
        // URLs, not a gh command: each is checked.
        let urls: Vec<&str> = urls.iter().map(String::as_str).collect();
        self.check_targets_with(&urls, None, None)?;
        for url in urls {
            let lower = url.trim().to_ascii_lowercase();
            if let Some(rest) = lower.strip_prefix("https://").or_else(|| lower.strip_prefix("http://")) {
                if rest.split(['/', '?', '#']).next().is_some_and(|authority| authority.contains('@')) {
                    bail!("the remote URL has a login in it, which git would use instead of the GitHub account {self}: remove it from the remote's URL");
                }
            }
        }
        Ok(())
    }

    /// git's `-c` options that give the account's token (in `IA_GH_GIT_TOKEN`) for HTTPS on its
    /// host, in place of other credential helpers for that host (such as gh's own, which would
    /// use gh's active account). Fetches and pushes over SSH still use
    /// the host's SSH keys.
    fn git_config(&self) -> Vec<String> {
        let key = format!("credential.https://{}.helper", self.host);
        let helper = r#"!f() { test "$1" = get && echo username=x-access-token && echo "password=$IA_GH_GIT_TOKEN"; }; f"#;
        vec!["-c".into(), format!("{key}="), "-c".into(), format!("{key}={helper}")]
    }
}

/// A repository's host, given as `HOST/OWNER/REPO` or a URL (`OWNER/REPO` has none).
fn repo_host(r: &str) -> Option<String> {
    let parts: Vec<&str> = r.trim().split('/').collect();
    match parts[..] {
        [host, _, _] => Some(host.to_string()),
        _ => url_host(r),
    }
}

/// gh options whose value is where a command goes: a host, or a repository (see `repo_host`).
const TARGET_OPTIONS: &[&str] = &["--hostname", "--repo", "--source", "--branch-repo"];

/// What gh's help says about one of its commands.
#[derive(Clone, Debug, Default, PartialEq)]
struct CommandHelp {
    /// How many words name it (`pr view` is two).
    path: usize,
    /// Its options: short name, long name, and whether it takes a value.
    options: Vec<(Option<char>, String, bool)>,
    /// Its arguments as its usage has them (`[<number> | <url> | <branch>]`, `<files>...`).
    arguments: Vec<String>,
}

impl CommandHelp {
    /// Parse `gh <command> --help`.
    fn parse(help: &str) -> Option<CommandHelp> {
        let mut lines = help.lines();
        lines.by_ref().find(|l| l.trim() == "USAGE")?;
        let usage = lines.next()?.trim().strip_prefix("gh ")?;
        let path = usage.split_whitespace().take_while(|w| !w.starts_with(['<', '[', '{'])).count();
        let rest: String = usage.split_whitespace().skip(path).collect::<Vec<_>>().join(" ");
        // Its groups at the top level, `[<number> | <url>]`, `<files>...`, up to `[flags]` and `--`.
        let mut arguments = Vec::new();
        let (mut group, mut depth) = (String::new(), 0);
        for c in rest.chars().chain([' ']) {
            match c {
                '[' | '{' | '<' => depth += 1,
                ']' | '}' | '>' => depth -= 1,
                _ => {}
            }
            if c == ' ' && depth == 0 {
                let g = std::mem::take(&mut group);
                if g == "[flags]" || g.starts_with("[--") || g == "--" {
                    break;
                }
                if !g.is_empty() {
                    arguments.push(g);
                }
            } else {
                group.push(c);
            }
        }
        let mut options = Vec::new();
        for line in help.lines() {
            let line = line.trim_start();
            if !line.starts_with('-') {
                continue;
            }
            // `-q, --jq expression   Filter …`: its names, then its value's, before the description.
            let words: Vec<&str> = line.split("  ").next().unwrap_or_default().split_whitespace().collect();
            let names: Vec<&str> = words.iter().map(|w| w.trim_end_matches(',')).take_while(|w| w.starts_with('-')).collect();
            let Some(long) = names.iter().find(|n| n.starts_with("--")) else { continue };
            let short = names.iter().find(|n| !n.starts_with("--")).and_then(|n| n.chars().nth(1));
            options.push((short, long.to_string(), words.len() > names.len()));
        }
        Some(CommandHelp { path, options, arguments })
    }

    /// The hosts `args` (gh's arguments, the command first) name where the command goes (see
    /// `Account::check_targets`).
    fn targets(&self, args: &[&str]) -> Vec<String> {
        let mut hosts = Vec::new();
        let mut target_option = |long: &str, value: &str| {
            if long == "--hostname" {
                hosts.push(value.trim().to_ascii_lowercase());
            } else if TARGET_OPTIONS.contains(&long) {
                hosts.extend(repo_host(value));
            }
        };
        let (mut i, mut words, mut dashes) = (0, 0, false);
        let mut positional = Vec::new();
        while let Some(&a) = args.get(i) {
            i += 1;
            if dashes || !a.starts_with('-') || a == "-" {
                positional.push(a);
                continue;
            }
            if a == "--" {
                dashes = true;
            } else if let Some(long) = a.strip_prefix("--") {
                let (name, attached) = match long.split_once('=') {
                    Some((name, value)) => (format!("--{name}"), Some(value)),
                    None => (a.to_string(), None),
                };
                let takes = self.options.iter().any(|(_, l, v)| *l == name && *v);
                let value = attached.or_else(|| takes.then(|| args.get(i).copied()).flatten());
                if takes && attached.is_none() {
                    i += 1;
                }
                if let Some(v) = value {
                    target_option(&name, v);
                }
            } else {
                // A cluster of short options: the first taking a value takes the rest, or the next word.
                for (at, c) in a.char_indices().skip(1) {
                    let Some((_, long, true)) = self.options.iter().find(|(s, _, _)| *s == Some(c)) else { continue };
                    let rest = &a[at + c.len_utf8()..];
                    let value = if rest.is_empty() {
                        i += 1;
                        args.get(i - 1).copied()
                    } else {
                        Some(rest.strip_prefix('=').unwrap_or(rest))
                    };
                    if let Some(v) = value {
                        target_option(long, v);
                    }
                    break;
                }
            }
        }
        for a in positional.into_iter().skip(self.path) {
            let argument = self.arguments.get(words).or(self.arguments.last().filter(|g| g.ends_with("..."))).map(|g| g.to_ascii_lowercase());
            words += 1;
            let Some(argument) = argument else { continue };
            let repository = argument.contains("repo");
            if repository || argument.contains("url") || argument.contains("endpoint") {
                hosts.extend(url_host(a).or_else(|| if repository { positional_host(a) } else { None }));
            }
        }
        hosts
    }
}

/// The top-level commands of gh whose help `command_help` reads (not aliases or extensions,
/// whose `--help` may run something).
const GH_COMMANDS: &[&str] = &[
    "agent-task", "api", "attestation", "auth", "browse", "cache", "codespace", "cs", "discussion", "extension", "ext", "gist", "gpg-key",
    "issue", "label", "org", "pr", "project", "release", "repo", "ruleset", "run", "search", "secret", "ssh-key", "status", "variable",
    "workflow",
];

/// The help of the gh command `args` run (`gh pr view --help`), kept for the next time.
fn command_help(args: &[&str]) -> Option<CommandHelp> {
    static CACHE: std::sync::Mutex<Vec<(String, Option<CommandHelp>)>> = std::sync::Mutex::new(Vec::new());
    let command = *args.first().filter(|c| GH_COMMANDS.contains(c))?;
    let sub = args.get(1).filter(|s| !s.is_empty() && s.chars().all(|c| c.is_ascii_lowercase() || c == '-'));
    let key = format!("{command} {}", sub.copied().unwrap_or_default());
    if let Some((_, help)) = CACHE.lock().unwrap().iter().find(|(k, _)| *k == key) {
        return help.clone();
    }
    let mut cmd = std::process::Command::new(gh_program());
    cmd.arg(command).args(sub).arg("--help").env("GH_NO_UPDATE_NOTIFIER", "1").env("NO_COLOR", "1").stdin(Stdio::null()).stderr(Stdio::null());
    let help = cmd.output().ok().filter(|o| o.status.success()).and_then(|o| CommandHelp::parse(&String::from_utf8_lossy(&o.stdout)));
    CACHE.lock().unwrap().push((key, help.clone()));
    help
}

/// The hosts a gh command's arguments name, read without its help: `--hostname`, `--repo`'s
/// host, and every other argument's that's a URL or a repository on a host of its own, but the
/// values of `CONTENT_OPTIONS`.
fn fallback_targets(args: &[&str]) -> Vec<String> {
    let mut hosts: Vec<String> = Vec::new();
    let api = args.first() == Some(&"api");
    let mut i = 0;
    while let Some(&a) = args.get(i) {
        // Texts, fields and the like aren't where the command goes, whatever is in them.
        if let Some(taken) = content_option(a, api) {
            i += taken;
            continue;
        }
        let value = |flag: &str| match a.strip_prefix(flag) {
            Some("") => args.get(i + 1).copied(),
            Some(v) => v.strip_prefix('=').or(if flag.starts_with("--") { None } else { Some(v) }),
            None => None,
        };
        if let Some(h) = value("--hostname") {
            hosts.push(h.to_string());
        } else if let Some(r) = value("--repo").or_else(|| value("-R")) {
            hosts.extend(repo_host(r));
        } else {
            hosts.extend(url_host(a).or_else(|| positional_host(a)));
        }
        i += 1;
    }
    hosts
}

/// gh's options whose values are content (texts, fields, headers, output formats), not where
/// the command goes: long ones, short ones in any command, and short ones in `gh api`'s (where
/// `-f` is `--raw-field`; elsewhere it may be a flag without a value, such as `--force`).
const CONTENT_OPTIONS: &[&str] = &[
    "--body", "--body-file", "--title", "--field", "--raw-field", "--header", "--jq", "--template", "--input", "--notes", "--notes-file",
    "--subject", "--search", "--label", "--add-label", "--remove-label",
];
const CONTENT_SHORT: &str = "btqF";
const API_CONTENT_SHORT: &str = "fH";

/// How many arguments a content option at `arg` takes up (two when its value is the next one),
/// if it is one (see `CONTENT_OPTIONS`).
fn content_option(arg: &str, api: bool) -> Option<usize> {
    if let Some(long) = arg.strip_prefix("--") {
        let (name, value) = match long.split_once('=') {
            Some((name, _)) => (name, true),
            None => (long, false),
        };
        return CONTENT_OPTIONS.contains(&format!("--{name}").as_str()).then_some(if value { 1 } else { 2 });
    }
    let letter = arg.strip_prefix('-')?.chars().next()?;
    let short = CONTENT_SHORT.contains(letter) || (api && API_CONTENT_SHORT.contains(letter));
    short.then_some(if arg.chars().count() == 2 { 2 } else { 1 })
}

/// The host an argument of a gh command (or a push URL) names when it's a repository on a host
/// of its own: `HOST/OWNER/REPO[/…]` (a host has a `.` or a port in it, so `OWNER/REPO` and API
/// paths don't count), or `[USER@]HOST:PATH` as git has it. Without a user, the host needs a `.`,
/// so search qualifiers (`repo:o/r`, `is:open`) and SSH aliases (`github-work:o/r`, the host's
/// own way to pick an SSH identity) don't count.
fn positional_host(arg: &str) -> Option<String> {
    if arg.starts_with(['-', '.', '/', '~']) || arg.contains(char::is_whitespace) {
        return None;
    }
    if let Some((user_host, _)) = arg.split_once(':').filter(|(h, _)| !h.contains('/')) {
        let (user, host) = match user_host.rsplit_once('@') {
            Some((user, host)) => (Some(user), host),
            None => (None, user_host),
        };
        let hostname = !host.is_empty() && host.chars().all(|c| c.is_ascii_alphanumeric() || ".-".contains(c));
        return (hostname && (user.is_some() || host.contains('.'))).then(|| host.to_ascii_lowercase());
    }
    let parts: Vec<&str> = arg.split('/').collect();
    let host = parts[0];
    let hostname = host.chars().all(|c| c.is_ascii_alphanumeric() || ".-:".contains(c));
    (hostname && parts.len() >= 3 && parts[1..3].iter().all(|p| !p.is_empty()) && (host.contains('.') || host.contains(':')))
        .then(|| host.split(':').next().unwrap_or(host).to_ascii_lowercase())
}

#[cfg(test)]
thread_local! {
    pub(crate) static TEST_GH_PROGRAM: std::cell::RefCell<Option<String>> = const { std::cell::RefCell::new(None) };
}

/// The gh to run: `IA_GH_BIN` (for `gh-run`, which is `gh` on its commands' PATH), or else `gh`.
pub(crate) fn gh_program() -> String {
    #[cfg(test)]
    if let Some(program) = TEST_GH_PROGRAM.with_borrow(Clone::clone) { return program }
    std::env::var("IA_GH_BIN").ok().filter(|b| !b.is_empty()).unwrap_or_else(|| "gh".into())
}

/// The host of a URL (`https://`, `ssh://`, …).
fn url_host(s: &str) -> Option<String> {
    let s = s.trim().to_ascii_lowercase();
    let (scheme, rest) = s.split_once("://")?;
    if scheme.is_empty() || !scheme.chars().all(|c| c.is_ascii_alphanumeric() || "+.-".contains(c)) {
        return None;
    }
    let authority = rest.split(['/', '?', '#']).next()?;
    Some(authority.rsplit('@').next()?.split(':').next()?.to_string())
}

/// Every URL `remote` (a remote's name) pushes to in `dir`, with git's URL rewrites
/// (`pushInsteadOf`, `insteadOf`) applied. None if there's no such remote.
async fn push_urls(dir: Option<&std::path::Path>, remote: &str) -> Option<Vec<String>> {
    let mut cmd = tokio::process::Command::new("git");
    cmd.args(["remote", "get-url", "--push", "--all", "--", remote]).stdin(Stdio::null());
    if let Some(d) = dir {
        cmd.current_dir(d);
    }
    let out = cmd.output().await.ok()?;
    let urls: Vec<String> = String::from_utf8_lossy(&out.stdout).lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect();
    (out.status.success() && !urls.is_empty()).then_some(urls)
}

/// git's `-c` options that empty every `http.extraHeader` (generic, and scoped to a URL or path)
/// configured where `dir` pushes from, so no `Authorization` header pushes as another account
/// instead of the credential helper's (see `Account::git_config`). An empty value clears the
/// headers set before it for its own key only, so each key that's set is cleared.
async fn extra_header_resets(dir: Option<&std::path::Path>) -> Vec<String> {
    let mut cmd = tokio::process::Command::new("git");
    cmd.args(["config", "--get-regexp", r"^http\..*extraheader$"]).stdin(Stdio::null());
    if let Some(d) = dir {
        cmd.current_dir(d);
    }
    let out = cmd.output().await.map(|o| String::from_utf8_lossy(&o.stdout).into_owned()).unwrap_or_default();
    let mut keys: Vec<&str> = out.lines().filter_map(|l| l.split(' ').next()).filter(|k| !k.is_empty()).collect();
    keys.push("http.extraheader");
    keys.sort();
    keys.dedup();
    keys.into_iter().flat_map(|k| ["-c".to_string(), format!("{k}=")]).collect()
}

impl std::fmt::Display for Account {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.is_github_com() { write!(f, "{}", self.login) } else { write!(f, "{}/{}", self.host, self.login) }
    }
}

/// The environment for gh to act as one account and no other. gh's config is a folder of its own
/// (GH_CONFIG_DIR, removed when this is dropped) with a login for the account's host only, so gh
/// has no token for any other host, whatever a command names: unlike GH_ENTERPRISE_TOKEN, which
/// gh sends to every host but github.com. There are no tokens in the environment, the keyring is
/// out of reach on Linux (gh looks there for hosts it has no login for: the Secret Service, over
/// the session bus), and GH_HOST is the account's host, so calls that don't name a host go there
/// and gh refuses a repository whose remotes are elsewhere.
#[derive(Debug)]
pub struct GhEnv {
    account: Account,
    dir: std::path::PathBuf,
}

impl Drop for GhEnv {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// Where gh (and the GitHub tools it follows) may find tokens in the environment.
const TOKEN_VARS: &[&str] = &["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"];

impl GhEnv {
    /// Set up `cmd`, a gh command, to run as the account. Check its targets first (`check`), and
    /// set GH_REPO after this if it has one (an inherited one is removed).
    pub fn apply(&self, cmd: &mut tokio::process::Command) {
        for v in TOKEN_VARS.iter().chain(&["GH_REPO"]) {
            cmd.env_remove(v);
        }
        cmd.env("GH_CONFIG_DIR", &self.dir).env("GH_HOST", &self.account.host);
        if cfg!(target_os = "linux") {
            cmd.env("DBUS_SESSION_BUS_ADDRESS", "disabled:");
        }
    }

    /// Fails if gh with these arguments (and `GH_REPO`) would reach another host than the
    /// account's (see `Account::check_targets`).
    pub fn check(&self, args: &[&str], repo: Option<&str>) -> Result<()> {
        self.account.check_targets(args, repo)
    }

    /// The environment for a shell command (a wait's) whose gh calls act as the account. The
    /// shell doesn't get the token: `gh` on its PATH is a script in `shim_dir` that runs `exe
    /// gh-run`, which checks each call's targets as the gh tools do and runs gh with the token.
    pub fn shell_env(&self, exe: &std::path::Path, shim_dir: &std::path::Path) -> Result<Vec<(&'static str, String)>> {
        let path = std::env::var_os("PATH").unwrap_or_default();
        let real = std::env::split_paths(&path).filter(|d| d != shim_dir).map(|d| d.join("gh")).find(|g| g.is_file()).context("gh isn't installed")?;
        std::fs::create_dir_all(shim_dir)?;
        let shim = shim_dir.join("gh");
        let script = format!("#!/bin/sh\nexec '{}' gh-run \"$@\"\n", crate::util::path_str(exe).replace('\'', r"'\''"));
        if std::fs::read_to_string(&shim).ok().as_deref() != Some(script.as_str()) {
            // Written aside and renamed, so a command running it never sees half of it.
            let tmp = shim_dir.join(format!(".gh-{}", crate::util::new_id()));
            std::fs::write(&tmp, &script)?;
            std::fs::set_permissions(&tmp, std::os::unix::fs::PermissionsExt::from_mode(0o755))?;
            std::fs::rename(&tmp, &shim)?;
        }
        let mut dirs = vec![shim_dir.to_path_buf()];
        dirs.extend(std::env::split_paths(&path).filter(|d| d != shim_dir));
        Ok(vec![
            ("PATH", crate::util::path_str(std::path::Path::new(&std::env::join_paths(dirs)?))),
            (ACCOUNT_ENV, self.account.to_string()),
            ("IA_GH_BIN", crate::util::path_str(&real)),
        ])
    }
}

/// `huntaway gh-run <args>`: gh in a wait's command, for a task with a GitHub account (see
/// `GhEnv::shell_env`). Refuses calls that would reach another host, and runs the rest with the
/// account's token. Returns gh's exit code.
pub async fn gh_run(args: Vec<String>) -> Result<i32> {
    let account = Account::from_env().with_context(|| format!("{ACCOUNT_ENV} isn't set"))?;
    let repo = std::env::var("GH_REPO").ok().filter(|r| !r.is_empty());
    refuse(&args)?;
    account.check_targets(&args, repo.as_deref())?;
    let env = account.env(&account.token().await?)?;
    let mut cmd = tokio::process::Command::new(gh_program());
    cmd.args(&args);
    env.apply(&mut cmd);
    if let Some(r) = repo {
        cmd.env("GH_REPO", r);
    }
    Ok(cmd.status().await.context("couldn't run gh")?.code().unwrap_or(1))
}

/// The environment that makes gh act as `account` (a profile's or project's, see `Account`), for
/// the host's own gh calls. Fails when that account isn't signed in to gh.
pub async fn account_env(account: Option<&str>) -> Result<Option<GhEnv>> {
    let Some(a) = account.and_then(Account::parse) else { return Ok(None) };
    Ok(Some(a.env(&a.token().await?)?))
}

/// Give a host-side fetch the selected account's credentials for HTTPS on its host. Resolve
/// insteadOf rewrites first; SSH, local repositories and other hosts keep git's usual auth.
/// No repository or global config is written, and a missing login never falls back to another.
pub async fn authenticate_fetch(cmd: &mut tokio::process::Command, repo: &std::path::Path, remote: &str, account: Option<&str>) -> Result<()> {
    let Some(account) = account.and_then(Account::parse) else { return Ok(()) };
    let out = crate::worktree::git(repo, &["remote", "get-url", "--", remote]).await?;
    if !out.ok { bail!("couldn't read the fetch URL for {remote}: {}", out.stderr.trim()) }
    let url = out.stdout.trim();
    if !url.to_ascii_lowercase().starts_with("https://") || url_host(url).as_deref() != Some(account.host.as_str()) {
        return Ok(());
    }
    account.check_git_urls(&[url.to_string()])?;
    let token = account.token().await?;
    cmd.args(extra_header_resets(Some(repo)).await).args(account.git_config()).env("IA_GH_GIT_TOKEN", token);
    Ok(())
}

/// The accounts gh is signed in to on this host, for picking one: `{accounts: [{account, host,
/// login, active, ok}], error}`. `account` is what a profile or project saves.
pub async fn accounts() -> Value {
    let out = tokio::process::Command::new(gh_program())
        .args(["auth", "status", "--json=hosts"])
        .env("GH_PROMPT_DISABLED", "1")
        .stdin(Stdio::null())
        .kill_on_drop(true)
        .output();
    let out = match tokio::time::timeout(Duration::from_secs(30), out).await {
        Ok(Ok(out)) => out,
        Ok(Err(e)) => return json!({"accounts": [], "error": format!("couldn't run gh: {e}")}),
        Err(_) => return json!({"accounts": [], "error": "gh auth status timed out"}),
    };
    match serde_json::from_slice::<Value>(&out.stdout) {
        Ok(v) if out.status.success() => json!({"accounts": accounts_from_status(&v), "error": null}),
        _ => json!({"accounts": [], "error": format!("gh auth status failed: {}", String::from_utf8_lossy(&out.stderr).trim())}),
    }
}

fn accounts_from_status(v: &Value) -> Vec<Value> {
    let mut out = Vec::new();
    for (host, list) in v["hosts"].as_object().into_iter().flatten() {
        for a in list.as_array().into_iter().flatten() {
            let Some(account) = a["login"].as_str().and_then(|l| Account::parse(&format!("{host}/{l}"))) else { continue };
            out.push(json!({
                "account": account.to_string(),
                "host": account.host,
                "login": account.login,
                "active": a["active"] == true,
                "ok": a["state"] == "success",
            }));
        }
    }
    out
}

/// `huntaway gh-hook`: Claude Code's PreToolUse hook for Bash in runs that have this server.
/// Turns away commands that run gh, saying to use these tools instead: gh in Bash may not reach
/// GitHub from the sandbox, and would act as gh's active account rather than the run's.
pub fn bash_hook() -> Result<()> {
    let mut input = String::new();
    std::io::Read::read_to_string(&mut std::io::stdin(), &mut input)?;
    let call: Value = serde_json::from_str(&input).unwrap_or_default();
    if let Some(reason) = hook_denial(&call) {
        println!("{}", json!({"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": reason}}));
    }
    Ok(())
}

/// Why a tool call (a hook's input) is turned away, if it is.
fn hook_denial(call: &Value) -> Option<String> {
    let command = call["tool_input"]["command"].as_str().filter(|_| call["tool_name"] == "Bash")?;
    // A command the check can't read (it panics) is turned away too, rather than let through.
    let runs_gh = std::panic::catch_unwind(|| crate::changes::runs_program(command, "gh")).unwrap_or(true);
    runs_gh.then(|| {
        format!(
            "Don't run the GitHub CLI (gh) in Bash here: use the `{SERVER_NAME}` MCP server's tools instead (mcp__{SERVER_NAME}__pr_view, \
             pr_create, pr_checks, pr_merge, issue_view, api and the others; mcp__{SERVER_NAME}__gh runs any other gh command, with \
             gh's arguments). They run gh outside the sandbox as the GitHub account this project uses. Run the rest of the \
             command on its own."
        )
    })
}

/// Output beyond this is cut from the middle.
const MAX_OUTPUT: usize = 60_000;
const TIMEOUT: Duration = Duration::from_secs(600);

fn tools() -> Value {
    let repo = json!({"type": "string", "description": "OWNER/REPO, if not the working directory's repository"});
    let dir = json!({"type": "string", "description": "Directory to run in (defaults to your working directory)"});
    let pr = json!({"type": "string", "description": "Pull request number, URL or branch; defaults to the current branch's"});
    let issue = json!({"type": "string", "description": "Issue number or URL"});
    let limit = json!({"type": "integer", "minimum": 1, "maximum": 1000, "description": "At most this many (default 30)"});
    let tool = |name: &str, description: &str, mut props: Value, required: &[&str]| {
        props["repo"] = repo.clone();
        props["dir"] = dir.clone();
        // Codex runs tools marked read-only without asking, and asks for the rest.
        let annotations = json!({"readOnlyHint": READ_ONLY.contains(&name)});
        json!({"name": name, "description": description, "annotations": annotations, "inputSchema": {"type": "object", "properties": props, "required": required}})
    };
    json!([
        tool("pr_create", "Open a pull request for the current branch (push it first, e.g. with git_push). Without a title, gh fills the title and body from the commits.", json!({
            "title": {"type": "string"},
            "body": {"type": "string", "description": "Markdown"},
            "base": {"type": "string", "description": "Branch to merge into (defaults to the repository's default branch)"},
            "head": {"type": "string", "description": "Branch to merge from (defaults to the current branch)"},
            "draft": {"type": "boolean"}
        }), &[]),
        tool("pr_view", "A pull request's details as JSON: state, branches, mergeability, review decision, checks and body; with comments, its comments and reviews too.", json!({
            "pr": pr, "comments": {"type": "boolean"}
        }), &[]),
        tool("pr_list", "List pull requests as JSON.", json!({
            "state": {"type": "string", "enum": ["open", "closed", "merged", "all"], "description": "Default open"},
            "head": {"type": "string", "description": "Only PRs from this branch"},
            "base": {"type": "string", "description": "Only PRs into this branch"},
            "author": {"type": "string", "description": "Only PRs by this user (@me for yourself)"},
            "search": {"type": "string", "description": "GitHub search query"},
            "limit": limit
        }), &[]),
        tool("pr_checks", "A pull request's CI checks as JSON (name, state, bucket pass/fail/pending/skipping, link).", json!({"pr": pr}), &[]),
        tool("pr_diff", "A pull request's diff.", json!({
            "pr": pr, "name_only": {"type": "boolean", "description": "Only the names of the changed files"}
        }), &[]),
        tool("pr_comment", "Comment on a pull request.", json!({"pr": pr, "body": {"type": "string", "description": "Markdown"}}), &["body"]),
        tool("pr_edit", "Change a pull request's title, body or base branch.", json!({
            "pr": pr, "title": {"type": "string"}, "body": {"type": "string"}, "base": {"type": "string"}
        }), &[]),
        tool("pr_merge", "Merge a pull request on GitHub. This doesn't touch local branches or worktrees.", json!({
            "pr": pr,
            "method": {"type": "string", "enum": ["merge", "squash", "rebase"], "description": "Default merge"},
            "auto": {"type": "boolean", "description": "Merge once the required checks pass, instead of now"},
            "delete_branch": {"type": "boolean", "description": "Delete the PR's branch on GitHub after merging (not with auto, or for a PR from a fork)"}
        }), &[]),
        tool("issue_view", "An issue's details as JSON; with comments, its comments too.", json!({
            "issue": issue, "comments": {"type": "boolean"}
        }), &["issue"]),
        tool("issue_list", "List issues as JSON.", json!({
            "state": {"type": "string", "enum": ["open", "closed", "all"], "description": "Default open"},
            "label": {"type": "string"},
            "assignee": {"type": "string", "description": "@me for yourself"},
            "search": {"type": "string", "description": "GitHub search query"},
            "limit": limit
        }), &[]),
        tool("issue_create", "Open an issue.", json!({
            "title": {"type": "string"},
            "body": {"type": "string", "description": "Markdown"},
            "labels": {"type": "array", "items": {"type": "string"}}
        }), &["title"]),
        tool("issue_comment", "Comment on an issue.", json!({"issue": issue, "body": {"type": "string", "description": "Markdown"}}), &["issue", "body"]),
        tool("run_list", "List recent GitHub Actions workflow runs as JSON.", json!({
            "branch": {"type": "string"},
            "workflow": {"type": "string", "description": "Workflow name or file"},
            "limit": limit
        }), &[]),
        tool("run_view", "A workflow run's jobs and steps, or with log_failed, the logs of its failed steps.", json!({
            "run_id": {"type": "string", "description": "The run's id (databaseId in run_list)"},
            "log_failed": {"type": "boolean"}
        }), &["run_id"]),
        tool("api", "Call the GitHub REST API (gh api). {owner} and {repo} in the endpoint are filled in from the repository.", json!({
            "endpoint": {"type": "string", "description": "e.g. repos/{owner}/{repo}/pulls/1/comments, or graphql"},
            "method": {"type": "string", "enum": ["GET", "POST", "PATCH", "PUT", "DELETE"], "description": "Default GET (POST when there are fields)"},
            "fields": {"type": "object", "description": "Parameters: query parameters for GET, otherwise the request body. Strings are sent as they are; numbers, booleans and null as JSON."},
            "jq": {"type": "string", "description": "jq expression to filter the response with"},
            "paginate": {"type": "boolean", "description": "Fetch every page"}
        }), &["endpoint"]),
        tool("gh", "Run any gh command, for what the other tools don't cover. Nothing is interactive: pass everything as arguments.", json!({
            "args": {"type": "array", "items": {"type": "string"}, "description": "gh's arguments, e.g. [\"release\", \"list\"]"}
        }), &["args"]),
        tool("git_push", "Push a branch with git, outside the sandbox and with the user's git credentials.", json!({
            "remote": {"type": "string", "description": "Default origin"},
            "branch": {"type": "string", "description": "Default the current branch"},
            "force_with_lease": {"type": "boolean", "description": "Overwrite the remote branch if it hasn't changed since you last fetched it"}
        }), &[]),
    ])
}

/// A command to run for a tool call.
#[derive(Debug, PartialEq)]
struct Command {
    program: &'static str,
    args: Vec<String>,
    /// Exit codes that aren't failures (`gh pr checks` exits 8 while checks are pending).
    ok_codes: &'static [i32],
    /// The call's `repo`, given to gh as `GH_REPO`: not every gh command takes `--repo` (`gh
    /// api` doesn't).
    repo: Option<String>,
}

fn command(tool: &str, a: &Value) -> Result<Command> {
    let s = |k: &str| a[k].as_str().map(str::trim).filter(|v| !v.is_empty());
    let text = |k: &str| a[k].as_str(); // bodies keep their whitespace
    let yes = |k: &str| a[k].as_bool() == Some(true);
    let mut args: Vec<String> = Vec::new();
    // `--flag=value`, so a value starting with `-` isn't taken for a flag.
    let flag = |args: &mut Vec<String>, f: &str, v: Option<&str>| {
        if let Some(v) = v {
            args.push(format!("--{f}={v}"));
        }
    };
    let words = |args: &mut Vec<String>, w: &[&str]| args.extend(w.iter().map(|w| w.to_string()));
    let target = |args: &mut Vec<String>, k: &str| {
        if let Some(v) = s(k) {
            if v.starts_with('-') {
                return Err(anyhow!("bad {k}: {v}"));
            }
            args.push(v.to_string());
        }
        Ok(())
    };
    let limit = |args: &mut Vec<String>| {
        if let Some(n) = a["limit"].as_u64() {
            args.push(format!("--limit={n}"));
        }
    };
    let mut ok_codes: &'static [i32] = &[0];
    match tool {
        "pr_create" => {
            words(&mut args, &["pr", "create"]);
            match s("title") {
                Some(t) => {
                    flag(&mut args, "title", Some(t));
                    flag(&mut args, "body", Some(text("body").unwrap_or("")));
                }
                None if text("body").is_some() => bail!("give a title with the body, or neither to fill both from the commits"),
                None => args.push("--fill".into()),
            }
            flag(&mut args, "base", s("base"));
            flag(&mut args, "head", s("head"));
            if yes("draft") {
                args.push("--draft".into());
            }
        }
        "pr_view" => {
            words(&mut args, &["pr", "view"]);
            target(&mut args, "pr")?;
            let mut fields = "number,title,state,isDraft,url,author,headRefName,baseRefName,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,body".to_string();
            if yes("comments") {
                fields.push_str(",comments,reviews");
            }
            flag(&mut args, "json", Some(&fields));
        }
        "pr_list" => {
            words(&mut args, &["pr", "list"]);
            for k in ["state", "head", "base", "author", "search"] {
                flag(&mut args, k, s(k));
            }
            limit(&mut args);
            flag(&mut args, "json", Some("number,title,state,isDraft,url,author,headRefName,baseRefName,updatedAt"));
        }
        "pr_checks" => {
            words(&mut args, &["pr", "checks"]);
            target(&mut args, "pr")?;
            flag(&mut args, "json", Some("name,state,bucket,workflow,link,startedAt,completedAt"));
            ok_codes = &[0, 8];
        }
        "pr_diff" => {
            words(&mut args, &["pr", "diff"]);
            target(&mut args, "pr")?;
            if yes("name_only") {
                args.push("--name-only".into());
            }
        }
        "pr_comment" | "issue_comment" => {
            words(&mut args, &[if tool == "pr_comment" { "pr" } else { "issue" }, "comment"]);
            target(&mut args, if tool == "pr_comment" { "pr" } else { "issue" })?;
            flag(&mut args, "body", Some(text("body").context("body is required")?));
        }
        "pr_edit" => {
            words(&mut args, &["pr", "edit"]);
            target(&mut args, "pr")?;
            let before = args.len();
            flag(&mut args, "title", s("title"));
            flag(&mut args, "body", text("body"));
            flag(&mut args, "base", s("base"));
            if args.len() == before {
                bail!("nothing to change: give a title, body or base");
            }
        }
        "pr_merge" => {
            // `--repo` keeps gh from cleaning up locally (switching branches, deleting the head
            // branch and any worktree it's checked out in), so `run` resolves the PR to its
            // number and repository first.
            words(&mut args, &["pr", "merge"]);
            let (Some(number), Some(repo)) = (s("pr").filter(|n| n.chars().all(|c| c.is_ascii_digit())), s("repo")) else {
                bail!("pr_merge needs the PR's number and repository");
            };
            args.push(number.into());
            flag(&mut args, "repo", Some(repo));
            args.push(match s("method").unwrap_or("merge") {
                "merge" => "--merge".into(),
                "squash" => "--squash".into(),
                "rebase" => "--rebase".into(),
                m => bail!("unknown merge method {m}"),
            });
            if yes("auto") {
                args.push("--auto".into());
            }
            if yes("delete_branch") {
                args.push("--delete-branch".into());
            }
        }
        "issue_view" => {
            words(&mut args, &["issue", "view"]);
            target(&mut args, "issue")?;
            let mut fields = "number,title,state,url,author,assignees,labels,createdAt,body".to_string();
            if yes("comments") {
                fields.push_str(",comments");
            }
            flag(&mut args, "json", Some(&fields));
        }
        "issue_list" => {
            words(&mut args, &["issue", "list"]);
            for k in ["state", "label", "assignee", "search"] {
                flag(&mut args, k, s(k));
            }
            limit(&mut args);
            flag(&mut args, "json", Some("number,title,state,url,author,assignees,labels,updatedAt"));
        }
        "issue_create" => {
            words(&mut args, &["issue", "create"]);
            flag(&mut args, "title", Some(s("title").context("title is required")?));
            flag(&mut args, "body", Some(text("body").unwrap_or("")));
            for l in a["labels"].as_array().into_iter().flatten().filter_map(|l| l.as_str()) {
                flag(&mut args, "label", Some(l));
            }
        }
        "run_list" => {
            words(&mut args, &["run", "list"]);
            flag(&mut args, "branch", s("branch"));
            flag(&mut args, "workflow", s("workflow"));
            limit(&mut args);
            flag(&mut args, "json", Some("databaseId,workflowName,displayTitle,headBranch,event,status,conclusion,url,createdAt"));
        }
        "run_view" => {
            words(&mut args, &["run", "view"]);
            let id = s("run_id").context("run_id is required")?;
            if !id.chars().all(|c| c.is_ascii_digit()) {
                bail!("bad run_id: {id}");
            }
            args.push(id.into());
            if yes("log_failed") {
                args.push("--log-failed".into());
            }
        }
        "api" => {
            words(&mut args, &["api"]);
            let endpoint = s("endpoint").context("endpoint is required")?;
            if endpoint.starts_with('-') {
                bail!("bad endpoint: {endpoint}");
            }
            args.push(endpoint.into());
            flag(&mut args, "method", s("method"));
            for (k, v) in a["fields"].as_object().into_iter().flatten() {
                match v {
                    Value::String(v) => args.extend(["--raw-field".into(), format!("{k}={v}")]),
                    // -F reads `@file` values from disk; JSON scalars never start with `@`.
                    Value::Number(_) | Value::Bool(_) | Value::Null => args.extend(["--field".into(), format!("{k}={v}")]),
                    _ => bail!("field {k}: only strings, numbers, booleans and null (use graphql variables or a string for more)"),
                }
            }
            flag(&mut args, "jq", s("jq"));
            if yes("paginate") {
                args.push("--paginate".into());
            }
        }
        "gh" => {
            let list = a["args"].as_array().context("args must be a list of strings")?;
            for v in list {
                args.push(v.as_str().context("args must be a list of strings")?.to_string());
            }
            if args.is_empty() {
                bail!("args is empty");
            }
            refuse(&args)?;
        }
        "git_push" => {
            args.push("push".into());
            if yes("force_with_lease") {
                args.push("--force-with-lease".into());
            }
            let remote = s("remote").unwrap_or("origin");
            let branch = s("branch").unwrap_or("HEAD");
            if remote.starts_with('-') || branch.starts_with('-') {
                bail!("bad remote or branch");
            }
            // A branch name, not a refspec: `+HEAD:refs/heads/master` would force-push master.
            if branch.contains([':', '+', '^', '~', '*', '?', '[', '\\']) || branch.contains("..") || branch.contains(char::is_whitespace) {
                bail!("branch must be a branch name");
            }
            // HEAD pushes the current branch under its own name, and -u makes it the upstream.
            args.extend(["-u".into(), remote.into(), branch.into()]);
            return Ok(Command { program: "git", args, ok_codes, repo: None });
        }
        _ => bail!("unknown tool {tool}"),
    }
    Ok(Command { program: "gh", args, ok_codes, repo: s("repo").map(String::from) })
}

/// Fails for gh commands no agent gets, whatever its permission mode (the gh tool's approval
/// doesn't apply in auto or bypass): `gh auth` (`gh auth token` would put the account's token in
/// the thread, as would `config get` of a host's `oauth_token`), and those that change what later
/// gh commands run (extensions, aliases, settings).
/// gh's command comes first: a flag before it could take the next argument as its value, so
/// only `--help` and `--version` may.
fn refuse<S: AsRef<str>>(args: &[S]) -> Result<()> {
    let args: Vec<&str> = args.iter().map(AsRef::as_ref).skip_while(|a| ["--help", "-h", "--version"].contains(a)).collect();
    let refused = match args[..] {
        [first, ..] if first.starts_with('-') => bail!("put gh's command first, e.g. [\"release\", \"list\", {first:?}]"),
        ["auth", ..] => "gh auth",
        ["extension" | "extensions" | "ext", ..] => "gh extension",
        // Their subcommands come first too, for the same reason.
        ["alias" | "config", second, ..] if second.starts_with('-') => bail!("put the subcommand straight after {:?}", args[0]),
        ["alias", "set" | "import" | "delete", ..] => "changing gh's aliases",
        ["config", "set" | "clear-cache", ..] => "changing gh's settings",
        // A host's settings are its login, token and all (`config get -h HOST oauth_token` prints it).
        ["config", ref rest @ ..] if rest.iter().any(|a| a.contains("oauth_token") || a.starts_with("-h") || a.starts_with("--host")) => {
            "reading a host's gh settings"
        }
        _ => return Ok(()),
    };
    bail!("{refused} isn't available to agents; ask the user to run it")
}

/// A PR's number and `[HOST/]OWNER/REPO`, from its URL.
fn pr_from_url(url: &str) -> Option<(String, String)> {
    let rest = url.trim().strip_prefix("https://").or_else(|| url.trim().strip_prefix("http://"))?;
    let parts: Vec<&str> = rest.split('/').collect();
    let [host, owner, name, "pull", number] = parts[..] else { return None };
    if number.is_empty() || !number.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let repo = if host == "github.com" { format!("{owner}/{name}") } else { format!("{host}/{owner}/{name}") };
    Some((number.to_string(), repo))
}

/// pr_merge's arguments with `pr` and `repo` resolved to the PR's number and repository.
async fn resolve_pr(a: &Value) -> Result<Value> {
    let mut args = vec!["pr".to_string(), "view".into()];
    if let Some(pr) = a["pr"].as_str().map(str::trim).filter(|p| !p.is_empty()) {
        if pr.starts_with('-') {
            bail!("bad pr: {pr}");
        }
        args.push(pr.into());
    }
    args.extend(["--json=url".into(), "--jq=.url".into()]);
    let c = Command { program: "gh", args, ok_codes: &[0], repo: a["repo"].as_str().map(str::trim).filter(|r| !r.is_empty()).map(String::from) };
    let (text, failed) = exec(&c, a).await?;
    if failed {
        bail!("couldn't find the pull request: {text}");
    }
    let (number, repo) = pr_from_url(&text).with_context(|| format!("unexpected pull request URL {text}"))?;
    let mut a = a.clone();
    a["pr"] = json!(number);
    a["repo"] = json!(repo);
    Ok(a)
}

/// Where a call runs: its `dir`, or the run's directory.
fn work_dir(a: &Value) -> Option<PathBuf> {
    let dir = a["dir"].as_str().filter(|d| !d.trim().is_empty()).map(String::from).or_else(|| std::env::var("IA_CWD").ok())?;
    Some(crate::util::expand_tilde(&dir))
}

/// Keep the start and end of long output (a log's failure is usually at the end).
fn clip(s: &str) -> String {
    if s.len() <= MAX_OUTPUT {
        return s.to_string();
    }
    let floor = |mut i: usize| {
        while !s.is_char_boundary(i) {
            i -= 1;
        }
        i
    };
    let head = floor(MAX_OUTPUT / 2);
    let tail = floor(s.len() - MAX_OUTPUT / 2);
    format!("{}\n\n[… {} bytes cut …]\n\n{}", &s[..head], tail - head, &s[tail..])
}

/// Run a tool call: its output, and whether it failed.
async fn run(tool: &str, a: &Value) -> Result<(String, bool)> {
    let a = if tool == "pr_merge" { resolve_pr(a).await? } else { a.clone() };
    exec(&command(tool, &a)?, &a).await
}

/// Run a command where call `a` runs, as the run's account if it has one: its output, and
/// whether it failed.
async fn exec(c: &Command, a: &Value) -> Result<(String, bool)> {
    let mut cmd = tokio::process::Command::new(if c.program == "gh" { gh_program() } else { c.program.to_string() });
    // Kept until gh is done with it.
    let mut _gh_env = None;
    if let Some(account) = Account::from_env() {
        if c.program == "git" {
            // To another host, the push would go as whoever git's credentials (or SSH keys) there
            // are. So it's to a remote by name, all of whose push URLs (as git rewrites them) are
            // checked: a URL given as the remote would be rewritten when pushing.
            let remote = c.args.iter().position(|a| a == "-u").and_then(|i| c.args.get(i + 1)).map_or("origin", String::as_str);
            let Some(urls) = push_urls(work_dir(a).as_deref(), remote).await else {
                bail!("there's no remote named {remote}: with a GitHub account set, git_push takes a remote's name (add one with git remote add)");
            };
            account.check_git_urls(&urls)?;
            let token = account.token().await?;
            cmd.args(extra_header_resets(work_dir(a).as_deref()).await).args(account.git_config()).env("IA_GH_GIT_TOKEN", &token);
        } else {
            account.check_targets(&c.args, c.repo.as_deref())?;
            let env = account.env(&account.token().await?)?;
            env.apply(&mut cmd);
            _gh_env = Some(env);
        }
    }
    cmd.args(&c.args)
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_PAGER", "cat")
        .env("GH_NO_UPDATE_NOTIFIER", "1")
        .env("NO_COLOR", "1")
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    // Only the call's own repository, which was checked.
    cmd.env_remove("GH_REPO");
    if let Some(r) = &c.repo {
        cmd.env("GH_REPO", r);
    }
    if let Some(d) = work_dir(a) {
        if !d.is_dir() {
            bail!("{} is not a directory", d.display());
        }
        cmd.current_dir(d);
    }
    let child = cmd.spawn().with_context(|| format!("couldn't run {}", c.program))?;
    let out = tokio::time::timeout(TIMEOUT, child.wait_with_output())
        .await
        .map_err(|_| anyhow!("{} timed out after {} seconds", c.program, TIMEOUT.as_secs()))??;
    let (stdout, stderr) = (String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    let failed = !out.status.code().is_some_and(|code| c.ok_codes.contains(&code));
    let mut text = stdout.trim_end().to_string();
    if !stderr.trim().is_empty() {
        if !text.is_empty() {
            text.push_str("\n\n");
        }
        text.push_str(stderr.trim_end());
    }
    if failed {
        text.push_str(&format!("\n\n({} exited with {})", c.program, out.status));
    } else if text.is_empty() {
        text = "Done.".into();
    }
    Ok((clip(text.trim_start()), failed))
}

async fn handle(req: Value) -> Option<Value> {
    let id = req.get("id").cloned()?; // notifications get no response
    let method = req["method"].as_str().unwrap_or("");
    let result = match method {
        "initialize" => Ok(json!({
            "protocolVersion": req["params"]["protocolVersion"].as_str().unwrap_or("2025-06-18"),
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "huntaway-gh", "version": env!("CARGO_PKG_VERSION")},
            "instructions": match Account::from_env() {
                Some(a) => format!("{INSTRUCTIONS} They act as the GitHub account {a}."),
                None => INSTRUCTIONS.to_string(),
            },
        })),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({"tools": tools()})),
        "tools/call" => {
            let name = req["params"]["name"].as_str().unwrap_or("");
            Ok(match run(name, &req["params"]["arguments"]).await {
                Ok((text, failed)) => json!({"content": [{"type": "text", "text": text}], "isError": failed}),
                Err(e) => json!({"content": [{"type": "text", "text": format!("Error: {e:#}")}], "isError": true}),
            })
        }
        _ => Err(json!({"code": -32601, "message": format!("method not found: {method}")})),
    };
    Some(match result {
        Ok(r) => json!({"jsonrpc": "2.0", "id": id, "result": r}),
        Err(e) => json!({"jsonrpc": "2.0", "id": id, "error": e}),
    })
}

pub async fn serve_stdio() -> Result<()> {
    let stdout = std::sync::Arc::new(tokio::sync::Mutex::new(tokio::io::stdout()));
    let mut lines = tokio::io::AsyncBufReadExt::lines(tokio::io::BufReader::new(tokio::io::stdin()));
    // Calls run concurrently, and the ones still running when stdin closes get to finish.
    let mut calls = tokio::task::JoinSet::new();
    while let Some(line) = lines.next_line().await? {
        let Ok(req) = serde_json::from_str::<Value>(&line) else { continue };
        let stdout = stdout.clone();
        calls.spawn(async move {
            if let Some(resp) = handle(req).await {
                let mut out = stdout.lock().await;
                let _ = out.write_all(format!("{resp}\n").as_bytes()).await;
                let _ = out.flush().await;
            }
        });
    }
    calls.join_all().await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(tool: &str, a: Value) -> Vec<String> {
        command(tool, &a).unwrap().args
    }

    #[test]
    fn every_tool_builds_and_read_only_ones_exist() {
        let names: Vec<String> = tools().as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap().to_string()).collect();
        let mut listed: Vec<&str> = READ_ONLY.iter().chain(WRITES).copied().collect();
        listed.sort();
        let mut sorted = names.clone();
        sorted.sort();
        assert_eq!(listed, sorted, "every tool is in READ_ONLY or WRITES");
        for t in tools().as_array().unwrap() {
            let read_only = READ_ONLY.contains(&t["name"].as_str().unwrap());
            assert_eq!(t["annotations"]["readOnlyHint"], read_only, "{}", t["name"]);
        }
        let full = json!({"pr": "3", "repo": "o/r", "issue": "4", "body": "b", "title": "t", "run_id": "5", "endpoint": "user", "args": ["status"]});
        for n in &names {
            assert!(command(n, &full).is_ok(), "{n}");
        }
    }

    #[test]
    fn builds_commands() {
        assert_eq!(args("pr_create", json!({})), ["pr", "create", "--fill"]);
        let create = command("pr_create", &json!({"title": "Fix it", "body": "- one\n", "base": "master", "draft": true, "repo": "o/r"})).unwrap();
        assert_eq!(create.args, ["pr", "create", "--title=Fix it", "--body=- one\n", "--base=master", "--draft"]);
        assert_eq!(create.repo.as_deref(), Some("o/r"));
        // gh api has no --repo: the repository goes in GH_REPO, as for every gh command.
        let api = command("api", &json!({"endpoint": "repos/{owner}/{repo}/pulls", "repo": "cli/cli"})).unwrap();
        assert_eq!((api.args, api.repo.as_deref()), (vec!["api".to_string(), "repos/{owner}/{repo}/pulls".into()], Some("cli/cli")));
        assert!(command("pr_create", &json!({"body": "x"})).is_err());
        // pr_merge always passes --repo (resolved by `run`), so gh leaves local branches alone.
        assert_eq!(
            args("pr_merge", json!({"pr": "12", "repo": "o/r", "delete_branch": true})),
            ["pr", "merge", "12", "--repo=o/r", "--merge", "--delete-branch"]
        );
        assert!(command("pr_merge", &json!({"pr": "12"})).is_err());
        assert!(command("pr_merge", &json!({"pr": "feature", "repo": "o/r"})).is_err());
        assert!(command("pr_edit", &json!({"pr": "1"})).is_err());
        assert_eq!(args("pr_edit", json!({"body": ""})), ["pr", "edit", "--body="]);
        assert_eq!(args("pr_edit", json!({"pr": "1", "title": "T"})), ["pr", "edit", "1", "--title=T"]);
        assert_eq!(command("pr_checks", &json!({})).unwrap().ok_codes, [0, 8]);
        assert_eq!(
            args("api", json!({"endpoint": "repos/{owner}/{repo}/issues", "fields": {"title": "@x"}, "paginate": true})),
            ["api", "repos/{owner}/{repo}/issues", "--raw-field", "title=@x", "--paginate"]
        );
        assert_eq!(args("api", json!({"endpoint": "graphql", "fields": {"n": 2}})), ["api", "graphql", "--field", "n=2"]);
        assert!(command("api", &json!({"endpoint": "x", "fields": {"a": [1]}})).is_err());
        assert!(command("run_view", &json!({"run_id": "1; rm"})).is_err());
        assert!(command("gh", &json!({"args": []})).is_err());
        // Nor what would show the account's token, or change what later gh commands run.
        for refused in [
            &["auth", "token"][..],
            &["auth", "status", "--show-token"],
            &["--help", "auth", "token"],
            &["extension", "install", "o/gh-x"],
            &["ext", "install", "o/gh-x"],
            &["alias", "set", "co", "!sh -c x"],
            &["config", "set", "editor", "x"],
            &["-R", "o/r", "auth", "token"],
            &["config", "get", "-h", "github.com", "oauth_token"],
            &["config", "get", "oauth_token", "--host=github.com"],
            &["config", "get", "-hgithub.com", "user"],
            &["config", "get", "oauth_token"],
            &["config", "--host=github.com", "get", "oauth_token"],
            &["config", "-hgithub.com", "get", "oauth_token"],
            &["config", "--host", "github.com", "get", "oauth_token"],
            &["config", "--help", "get", "-h", "github.com", "user"],
            &["alias", "--help", "set", "co", "!sh"],
        ] {
            let err = command("gh", &json!({"args": refused})).unwrap_err().to_string();
            assert!(err.contains("isn't available to agents") || err.contains("put gh's command first") || err.contains("put the subcommand"), "{refused:?}: {err}");
        }
        for allowed in [&["release", "list"][..], &["--version"], &["alias", "list"], &["config", "get", "editor"], &["issue", "create", "--title", "auth"]] {
            assert!(command("gh", &json!({"args": allowed})).is_ok(), "{allowed:?}");
        }
        let push = command("git_push", &json!({"repo": "ignored"})).unwrap();
        assert_eq!((push.program, push.args), ("git", vec!["push".to_string(), "-u".into(), "origin".into(), "HEAD".into()]));
        assert_eq!(command("git_push", &json!({"branch": "ia/x-1_fix.it"})).unwrap().args, ["push", "-u", "origin", "ia/x-1_fix.it"]);
        // A branch name, not a refspec that would push (or force-push) another ref.
        for bad in ["+HEAD:refs/heads/master", "HEAD:master", ":master", "-f", "a b", "a..b", "x^", "*"] {
            assert!(command("git_push", &json!({"branch": bad})).is_err(), "{bad}");
        }
    }

    #[test]
    fn reads_accounts() {
        let a = |s: &str| Account::parse(s).map(|a| (a.host, a.login));
        assert_eq!(a(" octocat "), Some(("github.com".into(), "octocat".into())));
        assert_eq!(a("GHE.example.com/me_corp"), Some(("ghe.example.com".into(), "me_corp".into())));
        assert_eq!(Account::parse("ghe.example.com/me").unwrap().to_string(), "ghe.example.com/me");
        assert_eq!(Account::parse("github.com/octocat").unwrap().to_string(), "octocat");
        for bad in ["", "-x", "a b", "a/b/c", "/x", "x/", "o;rm", "--user=x"] {
            assert_eq!(a(bad), None, "{bad}");
        }
        let status = json!({"hosts": {
            "github.com": [{"login": "me", "active": true, "state": "success"}, {"login": "work-me", "active": false, "state": "error"}],
            "ghe.example.com": [{"login": "me", "active": true, "state": "success"}]
        }});
        let list = accounts_from_status(&status);
        let names: Vec<(&str, bool, bool)> = list.iter().map(|a| (a["account"].as_str().unwrap(), a["active"] == true, a["ok"] == true)).collect();
        assert_eq!(names, [("ghe.example.com/me", true, true), ("me", true, true), ("work-me", false, false)]);
    }

    #[test]
    fn gh_acts_as_the_account_and_no_other() {
        use std::os::unix::fs::PermissionsExt;
        for (account, host) in [("me", "github.com"), ("acme.ghe.com/me", "acme.ghe.com"), ("ghe.example.com/me", "ghe.example.com")] {
            let mut cmd = tokio::process::Command::new("gh");
            cmd.env("GH_TOKEN", "ambient").env("GITHUB_TOKEN", "ambient").env("GH_ENTERPRISE_TOKEN", "ambient").env("GH_HOST", "elsewhere").env("GH_REPO", "evil.example.com/o/r");
            let env = Account::parse(account).unwrap().env("tok_123").unwrap();
            env.apply(&mut cmd);
            // What the command's environment ends up as: None for a variable removed.
            let vars: std::collections::BTreeMap<String, Option<String>> =
                cmd.as_std().get_envs().map(|(k, v)| (k.to_string_lossy().into_owned(), v.map(|v| v.to_string_lossy().into_owned()))).collect();
            let get = |k: &str| vars.get(k).cloned().flatten();
            assert_eq!(get("GH_HOST").as_deref(), Some(host), "{account}");
            // No token in the environment, nor an inherited repository.
            for v in TOKEN_VARS.iter().chain(&["GH_REPO"]) {
                assert!(vars.contains_key(*v) && get(v).is_none(), "{account} {v}");
            }
            if cfg!(target_os = "linux") {
                // Nor the keyring's logins.
                assert_eq!(get("DBUS_SESSION_BUS_ADDRESS").as_deref(), Some("disabled:"));
            }
            // A login for the account's host only, readable by this user only.
            let dir = std::path::PathBuf::from(get("GH_CONFIG_DIR").unwrap());
            let hosts = std::fs::read_to_string(dir.join("hosts.yml")).unwrap();
            assert!(hosts.starts_with(&format!("\"{host}\":\n")) && hosts.matches("tok_123").count() == 2 && hosts.lines().filter(|l| !l.starts_with(' ')).count() == 1, "{hosts}");
            assert_eq!(std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777, 0o700);
            assert_eq!(std::fs::metadata(dir.join("hosts.yml")).unwrap().permissions().mode() & 0o777, 0o600);
            drop(env);
            assert!(!dir.exists(), "{account}");
        }
    }

    #[test]
    fn gh_sends_the_token_to_the_accounts_host_only() {
        crate::testing::run(async || {
            // Where real gh sends requests, and with what Authorization header (gh's debug output
            // shows whether there's a token). `.invalid` names never resolve, so nothing leaves.
            let requests = async |args: &[&str]| -> Option<Vec<(String, bool)>> {
                let env = Account::parse("ghe.invalid/me").unwrap().env("tok_123").unwrap();
                let mut cmd = tokio::process::Command::new("gh");
                cmd.args(args).env("GH_DEBUG", "api").env("GH_PROMPT_DISABLED", "1").current_dir(&env.dir).stdin(Stdio::null());
                env.apply(&mut cmd);
                let out = tokio::time::timeout(Duration::from_secs(20), cmd.output()).await.ok()?.ok()?;
                let log = String::from_utf8_lossy(&out.stderr).into_owned();
                let mut found = Vec::new();
                for (i, line) in log.lines().enumerate() {
                    if let Some(url) = line.strip_prefix("* Request to ") {
                        let token = log.lines().skip(i + 1).take_while(|l| !l.starts_with("* ")).any(|l| l.starts_with("> Authorization: token"));
                        found.push((url_host(url).unwrap_or_default(), token));
                    }
                }
                Some(found)
            };
            // Without gh, there's nothing to check.
            let Some(own) = requests(&["api", "user"]).await else { return };
            assert_eq!(own, [("ghe.invalid".to_string(), true)]);
            for args in [&["api", "https://evil.invalid/user"][..], &["repo", "clone", "evil.invalid:o/r"], &["repo", "view", "evil.invalid/o/r"], &["api", "--hostname", "evil.invalid", "user"]] {
                let sent = requests(args).await.unwrap();
                assert!(!sent.is_empty() && sent.iter().all(|(host, token)| host == "evil.invalid" && !token), "{args:?}: {sent:?}");
            }
        })
    }

    /// Parts of gh 2.102's help for some of its commands.
    const HELP: &[(&str, &str)] = &[
        ("pr view", r#"USAGE
  gh pr view [<number> | <url> | <branch>] [flags]

FLAGS
  -c, --comments          View pull request comments
  -q, --jq expression     Filter JSON output using a jq expression
      --json fields       Output JSON with the specified fields
  -w, --web               Open a pull request in the browser

INHERITED FLAGS
  -R, --repo [HOST/]OWNER/REPO   Select another repository using the [HOST/]OWNER/REPO format
"#),
        ("issue comment", r#"USAGE
  gh issue comment {<number> | <url>} [flags]

FLAGS
  -b, --body text        The comment body text
  -F, --body-file file   Read body text from file
  -e, --editor           Skip prompts and open the text editor to write the body in

INHERITED FLAGS
  -R, --repo [HOST/]OWNER/REPO   Select another repository using the [HOST/]OWNER/REPO format
"#),
        ("issue transfer", r#"USAGE
  gh issue transfer {<number> | <url>} <destination-repo> [flags]

INHERITED FLAGS
  -R, --repo [HOST/]OWNER/REPO   Select another repository using the [HOST/]OWNER/REPO format
"#),
        ("repo edit", r#"USAGE
  gh repo edit [<repository>] [flags]

FLAGS
      --add-topic strings                        Add repository topic
  -d, --description string                       Description of the repository
      --enable-wiki                              Enable wiki in the repository
  -h, --homepage URL                             Repository home page URL
      --template                                 Make the repository available as a template repository
"#),
        ("search code", r#"USAGE
  gh search code <query> [flags]

FLAGS
  -q, --jq expression      Filter JSON output using a jq expression
  -R, --repo OWNER/REPO    Filter on repository, in OWNER/REPO format
  -w, --web                Open the search query in the web browser
"#),
        ("api", r#"USAGE
  gh api <endpoint> [flags]

FLAGS
  -F, --field key=value          Add a typed parameter in key=value format
  -H, --header key:value         Add a HTTP request header in key:value format
      --hostname string          The GitHub hostname for the request (default "github.com")
  -i, --include                  Include HTTP response status line and headers in the output
  -X, --method string            The HTTP method for the request (default "GET")
      --paginate                 Make additional HTTP requests to fetch all pages of results
  -f, --raw-field key=value      Add a string parameter in key=value format
"#),
        ("repo clone", r#"USAGE
  gh repo clone <repository> [<directory>] [-- <gitflags>...]

FLAGS
  -u, --upstream-remote-name string   Upstream remote name when cloning a fork (default "upstream")
"#),
        ("repo sync", r#"USAGE
  gh repo sync [<destination-repository>] [flags]

FLAGS
  -b, --branch string   Branch to sync (default [default branch])
      --force           Hard reset the branch of the destination repository to match the source repository
  -s, --source string   Source repository
"#),
        ("release upload", r#"USAGE
  gh release upload <tag> <files>... [flags]

FLAGS
      --clobber   Delete and re-upload existing assets of the same name
"#),
    ];

    #[test]
    fn reads_gh_help() {
        let help = |command: &str| CommandHelp::parse(HELP.iter().find(|(c, _)| *c == command).unwrap().1).unwrap();
        let pr_view = help("pr view");
        assert_eq!((pr_view.path, pr_view.arguments.as_slice()), (2, &["[<number> | <url> | <branch>]".to_string()][..]));
        assert!(pr_view.options.contains(&(Some('q'), "--jq".into(), true)) && pr_view.options.contains(&(Some('c'), "--comments".into(), false)));
        assert!(pr_view.options.contains(&(Some('R'), "--repo".into(), true)) && pr_view.options.contains(&(None, "--json".into(), true)));
        assert_eq!(help("repo clone").arguments, ["<repository>", "[<directory>]"]);
        assert_eq!(help("release upload").arguments, ["<tag>", "<files>..."]);
        assert_eq!((help("api").path, help("api").arguments.as_slice()), (1, &["<endpoint>".to_string()][..]));
        assert_eq!(CommandHelp::parse("no usage here"), None);
    }

    #[test]
    fn gh_checks_where_a_command_goes_and_not_what_it_says() {
        let check = |account: &str, args: &[&str], repo: Option<&str>| {
            let help = HELP.iter().find(|(c, _)| args.join(" ").starts_with(c)).and_then(|(_, h)| CommandHelp::parse(h)).unwrap();
            Account::parse(account).unwrap().check_targets_with(args, repo, Some(&help)).is_ok()
        };
        let ghe = "ghe.example.com/me";
        // A repository's homepage and description, search queries, comments, fields and headers.
        for args in [
            &["repo", "edit", "o/r", "--homepage", "https://example.com"][..],
            &["repo", "edit", "o/r", "-h", "https://example.com", "-d", "Mirror of https://example.com/a/b"],
            &["repo", "edit", "--description=see example.com/a/b", "ghe.example.com/o/r"],
            &["search", "code", "https://example.com", "--repo", "o/r"],
            &["search", "code", "example.com/a/b", "evil.example.com:o/r"],
            &["issue", "comment", "1", "--repo", "o/r", "--body", "https://example.com"],
            &["issue", "comment", "-b", "github.com/o/r", "https://ghe.example.com/o/r/issues/1"],
            &["api", "repos/o/r/issues", "--raw-field", "title=CI failure", "-f", "body=.github/workflows/test.yml"],
            &["api", "-H", "Referer: https://example.com", "-F", "url=https://example.com", "repos/o/r/hooks"],
            &["api", "evil.example.com/o/r"],
            &["pr", "view", "--json", "url", "https://ghe.example.com/o/r/pull/1"],
            &["repo", "clone", "ghe.example.com/o/r", "build.d/a/b", "--", "--depth", "https://example.com/x/y"],
            &["release", "upload", "v1", "dist.d/o/r", "https://example.com"],
        ] {
            assert!(check(ghe, args, None), "{args:?}");
        }
        // Where the command goes: its endpoint, pull request, issue or repository, and target options.
        for args in [
            &["repo", "edit", "github.com/o/r", "--homepage", "https://ghe.example.com"][..],
            &["repo", "edit", "--enable-wiki", "https://github.com/o/r"],
            &["repo", "edit", "--template", "github.com/o/r"],
            &["search", "code", "x", "--repo", "github.com/o/r"],
            &["issue", "comment", "--body", "hi", "https://github.com/o/r/issues/1"],
            &["issue", "comment", "-e", "https://github.com/o/r/issues/1"],
            &["issue", "comment", "1", "-Rgithub.com/o/r"],
            &["issue", "transfer", "1", "github.com/o/r"],
            &["issue", "transfer", "1", "git@github.com:o/r.git"],
            &["api", "-f", "x=1", "https://evil.example.com/user"],
            &["api", "--hostname=github.com", "user"],
            &["api", "--paginate", "https://api.github.com/user"],
            &["pr", "view", "-c", "https://github.com/o/r/pull/1"],
            &["pr", "view", "--web", "--", "https://github.com/o/r/pull/1"],
            &["repo", "clone", "evil.example.com:o/r"],
            &["repo", "sync", "--force", "github.com/o/r"],
            &["repo", "sync", "-s", "github.com/o/r"],
            &["repo", "sync", "--source=https://github.com/o/r"],
        ] {
            assert!(!check(ghe, args, None), "{args:?}");
        }
        assert!(!check(ghe, &["pr", "view", "1"], Some("github.com/o/r")));
        assert!(check("me", &["api", "https://gist.github.com/x", "-f", "a=https://ghe.example.com"], None));
    }

    #[test]
    fn gh_reads_its_own_help_for_the_check() {
        // With gh's real help, where there's a gh.
        if std::process::Command::new(gh_program()).arg("--version").output().is_err() {
            return;
        }
        let account = Account::parse("me").unwrap();
        for args in [&["repo", "edit", "o/r", "--homepage", "https://example.com"][..], &["search", "code", "https://example.com", "--repo", "o/r"]] {
            account.check_targets(args, None).unwrap();
        }
        assert!(account.check_targets(&["pr", "view", "https://evil.example.com/o/r/pull/1"], None).is_err());
        assert!(account.check_targets(&["repo", "edit", "evil.example.com/o/r", "--homepage", "https://github.com"], None).is_err());
    }

    #[test]
    fn gh_only_reaches_the_accounts_host() {
        let check = |account: &str, args: &[&str], repo: Option<&str>| {
            // Without gh's help, as when there's no gh (see gh_checks_where_a_command_goes_and_not_what_it_says).
            Account::parse(account).unwrap().check_targets_with(args, repo, None).is_ok()
        };
        let ghe = "ghe.example.com/me";
        assert!(check(ghe, &["api", "user"], Some("o/r")));
        assert!(check(ghe, &["api", "https://ghe.example.com/api/v3/user"], None));
        assert!(check(ghe, &["pr", "view", "https://ghe.example.com/o/r/pull/3"], Some("ghe.example.com/o/r")));
        // Another host's login (from the keyring), or this token sent to another host.
        assert!(!check(ghe, &["api", "https://api.github.com/user"], None));
        assert!(!check(ghe, &["api", "https://evil.example.com/user"], None));
        assert!(!check(ghe, &["api", "HTTPS://user@Evil.example.com:443/x"], None));
        assert!(!check(ghe, &["api", "--hostname", "github.com", "user"], None));
        assert!(!check(ghe, &["api", "--hostname=github.com", "user"], None));
        assert!(!check(ghe, &["pr", "list", "-R", "github.com/o/r"], None));
        assert!(!check(ghe, &["pr", "list", "-Rgithub.com/o/r"], None));
        assert!(!check(ghe, &["pr", "list", "--repo=github.com/o/r"], None));
        assert!(!check(ghe, &["pr", "view", "1"], Some("github.com/o/r")));
        assert!(!check(ghe, &["pr", "view", "https://github.com/o/r/pull/3"], None));
        // github.com accounts reach github.com and its API; text that isn't a target is left alone.
        assert!(check("me", &["api", "https://api.github.com/user", "--raw-field", "body=see https://evil.example.com"], Some("o/r")));
        assert!(check("me", &["pr", "list", "-R", "o/r"], None));
        assert!(!check("me", &["api", "https://api.acme.ghe.com/user"], None));
        assert!(check("acme.ghe.com/me", &["api", "https://api.acme.ghe.com/user"], None));
        // Repositories as arguments of their own (gh repo view, clone, fork, extension install, …).
        assert!(!check(ghe, &["repo", "view", "evil.example.com/o/r", "--json", "name"], None));
        assert!(!check(ghe, &["repo", "clone", "github.com/o/r"], None));
        assert!(!check(ghe, &["repo", "clone", "git@github.com:o/r.git"], None));
        assert!(!check(ghe, &["extension", "install", "evil.example.com:8443/o/gh-x"], None));
        assert!(!check(ghe, &["repo", "clone", "evil.invalid:o/r"], None));
        assert!(check(ghe, &["search", "issues", "repo:o/r", "is:open", "author:me"], None));
        assert!(check(ghe, &["api", "graphql", "-f", "query=query { repository(owner: \"o\") { id } }", "-f", "q=repo:o/r"], None));
        assert!(check(ghe, &["repo", "clone", "ghe.example.com:o/r"], None));
        assert!(check(ghe, &["repo", "view", "o/r", "--json", "name,url"], None));
        assert!(check(ghe, &["repo", "view", "o/r"], None));
        // What issues, comments and fields say isn't where they go.
        assert!(check(ghe, &["api", "repos/o/r/issues", "--raw-field", "title=CI failure", "--raw-field", "body=.github/workflows/test.yml"], None));
        assert!(check(ghe, &["issue", "comment", "1", "--repo", "o/r", "--body", "https://example.com"], None));
        assert!(check(ghe, &["issue", "create", "-t", "github.com/o/r is down", "-b", "see https://github.com/o/r", "--label=github.com/x/y"], None));
        assert!(check(ghe, &["api", "-f", "url=https://example.com", "-H", "Referer: https://example.com", "repos/o/r/hooks", "-q", ".url"], None));
        assert!(check(ghe, &["pr", "create", "--body=https://example.com", "-bhttps://example.com", "--title", "evil.example.com/o/r"], None));
        assert!(check(ghe, &["api", "repos/o/r/contents/x", "--field", "path=docs.d/a/b"], None));
        // But the destination is still checked after them.
        assert!(!check(ghe, &["api", "-f", "x=1", "https://evil.example.com/user"], None));
        assert!(!check(ghe, &["issue", "comment", "--body", "hi", "https://github.com/o/r/issues/1"], None));
        assert!(!check(ghe, &["issue", "comment", "1", "--body=hi", "--repo", "github.com/o/r"], None));
        assert!(!check(ghe, &["repo", "sync", "-f", "github.com/o/r"], None));
        assert!(check(ghe, &["repo", "clone", "ghe.example.com/o/r", "./dir/a.b/c"], None));
        assert!(check(ghe, &["api", "repos/o/r/contents/docs.d/a/b"], None));
        // Pushes: remotes on the account's host, over HTTPS or SSH (the host's SSH keys).
        assert!(check("me", &["https://github.com/o/r.git"], None));
        assert!(check("me", &["git@github.com:o/r.git"], None));
        assert!(check("me", &["ssh://git@github.com/o/r.git"], None));
        assert!(check("me", &["../local/repo.git"], None));
        assert!(!check("me", &["https://gitlab.com/o/r.git"], None));
        assert!(!check("me", &["git@gitlab.com:o/r.git"], None));
        assert!(!check("me", &["ssh://git@gitlab.com/o/r.git"], None));
        assert!(!check("me", &["gitlab.com:o/r.git"], None));
        assert!(check("me", &["github.com:o/r.git"], None));
        assert!(check("me", &["github-work:o/r.git"], None));
    }

    #[test]
    fn a_waits_shell_gets_gh_through_gh_run_and_no_token() {
        let shim_dir = std::env::temp_dir().join(format!("ia-gh-shim-{}", crate::util::new_id()));
        let env = Account::parse("ghe.example.com/me").unwrap().env("tok").unwrap();
        let vars = match env.shell_env(std::path::Path::new("/opt/it's/huntaway"), &shim_dir) {
            Ok(vars) => vars,
            // Without gh there's nothing to put in front of it.
            Err(e) => return assert!(format!("{e:#}").contains("gh isn't installed"), "{e:#}"),
        };
        let get = |k: &str| vars.iter().find(|(n, _)| *n == k).map(|(_, v)| v.clone());
        assert!(get("PATH").unwrap().starts_with(&format!("{}:", shim_dir.display())));
        assert_eq!(get(ACCOUNT_ENV).as_deref(), Some("ghe.example.com/me"));
        let real = get("IA_GH_BIN").unwrap();
        assert!(!real.starts_with(&crate::util::path_str(&shim_dir)) && real.ends_with("/gh"), "{real}");
        // The token stays with gh-run.
        assert!(vars.iter().all(|(k, v)| !TOKEN_VARS.contains(k) && v != "tok"));
        let shim = std::fs::read_to_string(shim_dir.join("gh")).unwrap();
        assert_eq!(shim, "#!/bin/sh\nexec '/opt/it'\\''s/huntaway' gh-run \"$@\"\n");
        assert_eq!(std::os::unix::fs::PermissionsExt::mode(&std::fs::metadata(shim_dir.join("gh")).unwrap().permissions()) & 0o777, 0o755);
        std::fs::remove_dir_all(&shim_dir).ok();
    }

    #[test]
    fn pushes_are_checked_at_every_url_git_would_push_to() {
        crate::testing::run(async || {
            let dir = std::env::temp_dir().join(format!("ia-gh-push-urls-{}", crate::util::new_id()));
            std::fs::create_dir_all(&dir).unwrap();
            let git = |args: &[&str]| {
                let ok = std::process::Command::new("git").args(args).current_dir(&dir).env("GIT_CONFIG_NOSYSTEM", "1").status().unwrap().success();
                assert!(ok, "git {args:?}");
            };
            git(&["init", "-q"]);
            git(&["remote", "add", "origin", "https://github.com/o/r.git"]);
            git(&["remote", "add", "two", "git@github.com:o/r.git"]);
            git(&["config", "--add", "remote.two.pushurl", "git@github.com:o/r.git"]);
            git(&["config", "--add", "remote.two.pushurl", "https://evil.example.com/o/r.git"]);
            git(&["remote", "add", "rewritten", "https://ghe.example.com/o/r.git"]);
            git(&["config", "url.https://evil.example.com/.pushInsteadOf", "https://ghe.example.com/"]);
            // Logins in a URL, which git would use instead of the account's token.
            git(&["remote", "add", "login", "https://other:other-token@github.com/o/r.git"]);
            git(&["remote", "add", "user", "https://other@github.com/o/r.git"]);
            git(&["remote", "add", "ssh-user", "ssh://git@github.com/o/r.git"]);
            let me = Account::parse("me").unwrap();
            let checked = async |remote: &str| match push_urls(Some(&dir), remote).await {
                Some(urls) => me.check_git_urls(&urls).map_err(|e| e.to_string()),
                None => Err("no remote".into()),
            };
            assert_eq!(checked("origin").await, Ok(()));
            // Every push URL, and as git rewrites it.
            assert!(checked("two").await.unwrap_err().contains("not evil.example.com"));
            assert!(checked("rewritten").await.unwrap_err().contains("not evil.example.com"));
            assert!(checked("login").await.unwrap_err().contains("has a login in it"));
            assert!(checked("user").await.unwrap_err().contains("has a login in it"));
            assert_eq!(checked("ssh-user").await, Ok(()));
            // A URL isn't a remote's name: git would rewrite it too.
            assert_eq!(checked("https://github.com/o/r.git").await, Err("no remote".into()));
            assert_eq!(checked("--all").await, Err("no remote".into()));
            std::fs::remove_dir_all(&dir).ok();
        })
    }

    #[test]
    fn pushes_send_no_configured_authorization_header() {
        crate::testing::run(async || {
            // A server that records the Authorization headers git sends, and asks for a login.
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = listener.local_addr().unwrap().port();
            let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
            let recorded = seen.clone();
            let server = tokio::spawn(async move {
                use tokio::io::AsyncReadExt;
                while let Ok((mut conn, _)) = listener.accept().await {
                    let mut request = Vec::new();
                    let mut buf = [0u8; 4096];
                    while !request.windows(4).any(|w| w == b"\r\n\r\n") {
                        match conn.read(&mut buf).await {
                            Ok(0) | Err(_) => break,
                            Ok(n) => request.extend_from_slice(&buf[..n]),
                        }
                    }
                    let text = String::from_utf8_lossy(&request).to_string();
                    let found: Vec<String> = text.lines().filter(|l| l.to_ascii_lowercase().starts_with("authorization:")).map(String::from).collect();
                    recorded.lock().unwrap().extend(found);
                    let reply = "HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm=\"x\"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
                    let _ = conn.write_all(reply.as_bytes()).await;
                }
            });
            let dir = std::env::temp_dir().join(format!("ia-gh-headers-{}", crate::util::new_id()));
            std::fs::create_dir_all(&dir).unwrap();
            let url = format!("http://127.0.0.1:{port}/o/r.git");
            let other = "Authorization: Basic b3RoZXI6b3RoZXItdG9rZW4="; // other:other-token
            let git = |args: &[&str]| std::process::Command::new("git").args(args).current_dir(&dir).status().unwrap();
            git(&["init", "-q"]);
            // Set for every URL, for the server, and for the repository's path.
            for key in ["http.extraHeader".to_string(), format!("http.http://127.0.0.1:{port}/.extraHeader"), format!("http.{url}.extraHeader")] {
                git(&["config", &key, other]);
            }
            let send = async |resets: &[String]| {
                seen.lock().unwrap().clear();
                let mut c = tokio::process::Command::new("git");
                c.args(resets).args(["-c", "credential.helper=", "ls-remote", &url]).current_dir(&dir);
                c.env("GIT_TERMINAL_PROMPT", "0").env("GIT_ASKPASS", "/bin/false").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
                let _ = tokio::time::timeout(Duration::from_secs(20), c.status()).await;
                seen.lock().unwrap().clone()
            };
            // The test sees configured headers...
            assert!(send(&[]).await.iter().any(|h| h.contains("b3RoZXI6")));
            // ...and git_push's resets leave none.
            let resets = extra_header_resets(Some(&dir)).await;
            let sent = send(&resets).await;
            assert!(sent.iter().all(|h| !h.contains("b3RoZXI6")), "{sent:?} with {resets:?}");
            server.abort();
            std::fs::remove_dir_all(&dir).ok();
        })
    }

    #[test]
    fn fetches_use_only_the_selected_accounts_https_credentials() {
        crate::testing::run(async || {
            use std::os::unix::fs::PermissionsExt;
            let dir = std::env::temp_dir().join(format!("ia-gh-fetch-{}", crate::util::new_id()));
            std::fs::create_dir_all(&dir).unwrap();
            let gh = dir.join("gh");
            std::fs::write(&gh, "#!/bin/sh\n[ \"$*\" = 'auth token --hostname=ghe.example.com --user=chosen' ] || exit 1\nprintf test-token\n").unwrap();
            std::fs::set_permissions(&gh, std::fs::Permissions::from_mode(0o755)).unwrap();
            TEST_GH_PROGRAM.set(Some(crate::util::path_str(&gh)));
            let git = |args: &[&str]| {
                assert!(std::process::Command::new("git").args(args).current_dir(&dir).status().unwrap().success());
            };
            git(&["init", "-q"]);
            git(&["remote", "add", "origin", "https://alias/o/r.git"]);
            git(&["config", "url.https://ghe.example.com/.insteadOf", "https://alias/"]);
            git(&["config", "credential.helper", "!f() { echo username=wrong; echo password=wrong; }; f"]);
            git(&["config", "http.extraHeader", "Authorization: wrong"]);
            let mut cmd = tokio::process::Command::new("git");
            cmd.current_dir(&dir);
            authenticate_fetch(&mut cmd, &dir, "origin", Some("ghe.example.com/chosen")).await.unwrap();
            assert!(cmd.as_std().get_args().any(|a| a == "http.extraheader="));
            cmd.args(["credential", "fill"]).stdin(Stdio::piped()).stdout(Stdio::piped());
            let mut child = cmd.spawn().unwrap();
            child.stdin.take().unwrap().write_all(b"protocol=https\nhost=ghe.example.com\n\n").await.unwrap();
            let out = child.wait_with_output().await.unwrap();
            assert!(out.status.success());
            let credentials = String::from_utf8(out.stdout).unwrap();
            assert!(credentials.contains("username=x-access-token\npassword=test-token"), "{credentials}");
            // No account selected leaves git's own authentication alone.
            let mut cmd = tokio::process::Command::new("git");
            authenticate_fetch(&mut cmd, &dir, "origin", None).await.unwrap();
            assert_eq!(cmd.as_std().get_args().count(), 0);
            // A missing login is an error, never the active account or the configured helper.
            let mut cmd = tokio::process::Command::new("git");
            assert!(authenticate_fetch(&mut cmd, &dir, "origin", Some("ghe.example.com/missing")).await.is_err());
            // SSH, local remotes and unrelated HTTPS hosts don't need gh at all.
            for url in ["git@github-work:o/r.git", "/tmp/local.git", "https://elsewhere.example/o/r.git"] {
                git(&["remote", "set-url", "origin", url]);
                let mut cmd = tokio::process::Command::new("git");
                authenticate_fetch(&mut cmd, &dir, "origin", Some("ghe.example.com/missing")).await.unwrap();
                assert_eq!(cmd.as_std().get_args().count(), 0);
                assert_eq!(cmd.as_std().get_envs().count(), 0);
            }
            TEST_GH_PROGRAM.set(None);
            std::fs::remove_dir_all(&dir).ok();
        })
    }

    #[test]
    fn pushes_with_the_accounts_token_over_https() {
        crate::testing::run(async || {
            // What credentials git would use: only ours for the account's host, whatever helper
            // the user has (here a global one, as `gh auth setup-git` adds), and theirs elsewhere.
            let home = std::env::temp_dir().join(format!("ia-gh-push-{}", crate::util::new_id()));
            std::fs::create_dir_all(&home).unwrap();
            let fill = async |host: &str, extra: &[String]| {
                let mut c = tokio::process::Command::new("git");
                c.env("HOME", &home).env("XDG_CONFIG_HOME", &home).env("GIT_CONFIG_NOSYSTEM", "1").env("IA_GH_GIT_TOKEN", "tok123");
                c.args(["-c", "credential.helper=!f() { echo username=theirs; echo password=other; }; f"]).args(extra);
                c.args(["credential", "fill"]).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
                let mut child = c.spawn().unwrap();
                child.stdin.take().unwrap().write_all(format!("protocol=https\nhost={host}\n\n").as_bytes()).await.unwrap();
                String::from_utf8(child.wait_with_output().await.unwrap().stdout).unwrap()
            };
            let config = Account::parse("octocat").unwrap().git_config();
            let ours = fill("github.com", &config).await;
            assert!(ours.contains("username=x-access-token\n") && ours.contains("password=tok123\n"), "{ours}");
            assert!(fill("gitlab.com", &config).await.contains("password=other\n"));
            std::fs::remove_dir_all(&home).ok();
        })
    }

    #[test]
    fn the_hook_turns_away_gh_in_bash() {
        let call = |tool: &str, command: &str| hook_denial(&json!({"tool_name": tool, "tool_input": {"command": command}}));
        for c in ["gh pr view 3", "cd /x && gh pr create --fill", "GH_TOKEN=x /usr/bin/gh api user", "echo $(gh pr list)", "timeout 60 gh run watch", "bash -c 'gh pr checks'",
            "env -u; gh api user", "$'g\\x68' api user", "builtin command gh api user", "eval 'gh api user'"] {
            assert!(call("Bash", c).is_some_and(|r| r.contains("mcp__gh__pr_view")), "{c}");
        }
        for c in ["git push -u origin x", "grep -r gh src", "echo gh", "ls ~/.config/gh", "cargo test gh_mcp"] {
            assert_eq!(call("Bash", c), None, "{c}");
        }
        assert_eq!(call("Read", "gh pr view"), None);
        assert_eq!(hook_denial(&json!({})), None);
    }

    #[test]
    fn reads_pr_urls() {
        assert_eq!(pr_from_url("https://github.com/o/r/pull/12\n"), Some(("12".into(), "o/r".into())));
        assert_eq!(pr_from_url("https://ghe.example.com/o/r/pull/3"), Some(("3".into(), "ghe.example.com/o/r".into())));
        assert_eq!(pr_from_url("https://github.com/o/r/issues/3"), None);
        assert_eq!(pr_from_url("no pull request"), None);
    }

    #[test]
    fn clips_long_output() {
        assert_eq!(clip("short"), "short");
        let long = "é".repeat(MAX_OUTPUT);
        let c = clip(&long);
        assert!(c.len() < long.len() && c.contains("bytes cut"));
    }

    #[test]
    fn runs_gh_and_reports_failures() {
        crate::testing::run(async || {
            // An unknown command fails without touching GitHub (if gh is installed at all).
            if let Ok((text, failed)) = run("gh", &json!({"args": ["no-such-command"]})).await {
                assert!(failed, "{text}");
            }
            let resp = handle(json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list"})).await.unwrap();
            assert!(resp["result"]["tools"].as_array().unwrap().len() > 10);
            assert!(handle(json!({"jsonrpc": "2.0", "method": "notifications/initialized"})).await.is_none());
        })
    }
}
