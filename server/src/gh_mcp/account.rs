//! GitHub accounts gh is signed in to, their tokens, and checking that a command reaches only its
//! account's host.

use super::*;

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
    pub(super) fn from_env() -> Option<Self> {
        Self::parse(&std::env::var(ACCOUNT_ENV).ok()?)
    }

    fn is_github_com(&self) -> bool {
        self.host == "github.com"
    }

    /// The account's token from gh's logins on this host.
    pub(super) async fn token(&self) -> Result<String> {
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
    pub(super) fn env(&self, token: &str) -> Result<GhEnv> {
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
    pub(super) fn check_targets<S: AsRef<str>>(&self, args: &[S], repo: Option<&str>) -> Result<()> {
        let args: Vec<&str> = args.iter().map(AsRef::as_ref).collect();
        let help = command_help(&args);
        self.check_targets_with(&args, repo, help.as_ref())
    }

    /// `check_targets` with the command's help (see `command_help`), if there is one.
    pub(super) fn check_targets_with(&self, args: &[&str], repo: Option<&str>, help: Option<&CommandHelp>) -> Result<()> {
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
    pub(super) fn check_git_urls(&self, urls: &[String]) -> Result<()> {
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
    pub(super) fn git_config(&self) -> Vec<String> {
        let key = format!("credential.https://{}.helper", self.host);
        let helper = r#"!f() { test "$1" = get && echo username=x-access-token && echo "password=$IA_GH_GIT_TOKEN"; }; f"#;
        vec!["-c".into(), format!("{key}="), "-c".into(), format!("{key}={helper}")]
    }
}

impl std::fmt::Display for Account {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.is_github_com() { write!(f, "{}", self.login) } else { write!(f, "{}/{}", self.host, self.login) }
    }
}
