use std::path::{Path, PathBuf};

pub fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

pub fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

pub fn new_token() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

/// Compares secrets (tokens, webhook secrets) without giving away, by how long it takes, how much
/// of one matched.
pub fn same_secret(a: &str, b: &str) -> bool {
    aws_lc_rs::constant_time::verify_slices_are_equal(a.as_bytes(), b.as_bytes()).is_ok()
}

/// Expand a leading `~` to the user's home directory.
pub fn expand_tilde(p: &str) -> PathBuf {
    let p = p.trim();
    if p == "~" {
        return dirs::home_dir().unwrap_or_else(|| PathBuf::from(p));
    }
    if let Some(rest) = p.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest);
        }
    }
    PathBuf::from(p)
}

pub fn slugify(s: &str, max: usize) -> String {
    let mut out = String::new();
    let mut dash = false;
    for c in s.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
            dash = false;
        } else if !dash && !out.is_empty() {
            out.push('-');
            dash = true;
        }
        if out.len() >= max {
            break;
        }
    }
    out.trim_matches('-').to_string()
}

/// Derive a short uppercase key (e.g. "IA") from a project name.
pub fn derive_key(name: &str) -> String {
    let words: Vec<&str> = name
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|w| !w.is_empty())
        .collect();
    let key: String = if words.len() >= 2 {
        words.iter().take(3).filter_map(|w| w.chars().next()).collect()
    } else {
        words.first().map(|w| w.chars().take(3).collect()).unwrap_or_default()
    };
    let key = key.to_ascii_uppercase();
    if key.is_empty() { "T".into() } else { key }
}

pub fn path_str(p: &Path) -> String {
    p.to_string_lossy().to_string()
}

/// Whether `dir` is a git repository's top folder: a quick check without running git. Unlike
/// worktree::is_git_repo, it doesn't count a folder inside one (such as a home folder kept in git).
pub fn is_git_root(dir: &Path) -> bool {
    dir.join(".git").exists()
}

/// Whether the git repository whose top folder is `dir` has a commit checked out (HEAD names a
/// commit, or a branch that exists), which a worktree needs to branch from. A quick look at its
/// files, like `is_git_root`; git is only run for a repository whose refs aren't kept in files.
pub fn has_commits(dir: &Path) -> bool {
    let dot_git = dir.join(".git");
    // A linked worktree or a submodule has a `.git` file naming its git dir.
    let git_dir = match std::fs::read_to_string(&dot_git) {
        Ok(s) => match s.trim().strip_prefix("gitdir:") {
            Some(d) => dir.join(d.trim()),
            None => return false,
        },
        Err(_) if dot_git.is_dir() => dot_git,
        Err(_) => return false,
    };
    let Ok(head) = std::fs::read_to_string(git_dir.join("HEAD")) else { return false };
    let Some(branch) = head.trim().strip_prefix("ref:").map(str::trim) else {
        // Detached at a commit.
        return head.trim().len() >= 40 && head.trim().chars().all(|c| c.is_ascii_hexdigit());
    };
    // A linked worktree keeps its branches in the repository's own git dir.
    let common = match std::fs::read_to_string(git_dir.join("commondir")) {
        Ok(c) => git_dir.join(c.trim()),
        Err(_) => git_dir.clone(),
    };
    if common.join("reftable").exists() {
        return std::process::Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok_and(|s| s.success());
    }
    common.join(branch).is_file()
        || std::fs::read_to_string(common.join("packed-refs"))
            .is_ok_and(|p| p.lines().any(|l| l.split_once(' ').is_some_and(|(_, r)| r == branch)))
}

/// Truncate a string to at most `max` bytes on a char boundary.
pub fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n… [truncated {} bytes]", &s[..end], s.len() - end)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn git(dir: &Path, args: &[&str]) {
        let ok = std::process::Command::new("git").arg("-C").arg(dir).args(args).env("GIT_CONFIG_GLOBAL", "/dev/null").status().unwrap().success();
        assert!(ok, "git {args:?}");
    }

    #[test]
    fn tells_a_repository_with_commits() {
        let dir = std::env::temp_dir().join(format!("ia-util-{}", new_id()));
        let repo = dir.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        assert!(!is_git_root(&repo) && !has_commits(&repo));
        git(&repo, &["init", "-q", "-b", "main"]);
        assert!(is_git_root(&repo) && !has_commits(&repo));
        git(&repo, &["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "first"]);
        assert!(has_commits(&repo));
        // Packed, as `git gc` leaves them.
        git(&repo, &["pack-refs", "--all"]);
        assert!(!repo.join(".git/refs/heads/main").exists() && has_commits(&repo));
        // Detached, and on a branch with no commits yet.
        git(&repo, &["checkout", "-q", "--detach"]);
        assert!(has_commits(&repo));
        git(&repo, &["checkout", "-q", "--orphan", "fresh"]);
        assert!(!has_commits(&repo));
        git(&repo, &["checkout", "-q", "main"]);
        // A linked worktree, whose `.git` is a file and whose branches are in the repository's git dir.
        let linked = dir.join("linked");
        git(&repo, &["worktree", "add", "-q", "-b", "side", &path_str(&linked)]);
        assert!(linked.join(".git").is_file() && has_commits(&linked));
        std::fs::remove_dir_all(&dir).ok();
    }
}
