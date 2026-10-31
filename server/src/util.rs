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
