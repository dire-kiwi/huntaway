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

/// Make a data dir private to its user, at start: the folder `0700` and its databases (`*.db`, with their
/// `-wal`, `-shm` and `-journal` files) `0600`, whatever the umask made them. Its tokens are made `0600`
/// when they're written. Not a home folder given as the data dir, which other things may need to read.
/// What can't be changed (a folder of another user's, say) is logged, and the server starts anyway.
#[cfg(unix)]
pub fn make_private(data_dir: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let set = |path: &Path, mode: u32| {
        let Ok(meta) = std::fs::symlink_metadata(path) else { return };
        // Not through a link in the folder, which could point anywhere.
        if meta.file_type().is_symlink() || meta.permissions().mode() & 0o777 == mode {
            return;
        }
        if let Err(e) = std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)) {
            tracing::warn!("making {} private: {e}", path.display());
        }
    };
    let home = dirs::home_dir().and_then(|h| h.canonicalize().ok());
    let dir = data_dir.canonicalize().unwrap_or_else(|_| data_dir.to_path_buf());
    if home.as_deref() != Some(dir.as_path()) && dir != Path::new("/") {
        set(&dir, 0o700);
    }
    let Ok(entries) = std::fs::read_dir(&dir) else { return };
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if [".db", ".db-wal", ".db-shm", ".db-journal"].iter().any(|ext| name.ends_with(ext)) {
            set(&e.path(), 0o600);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // HA-120: the live data dir was 0755 and its database 0644, readable by any user on the machine.
    #[cfg(unix)]
    #[test]
    fn makes_an_existing_data_dir_private() {
        use std::os::unix::fs::PermissionsExt;
        let root = crate::testing::temp_dir();
        let dir = root.join("data");
        std::fs::create_dir_all(dir.join("runs")).unwrap();
        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        let chmod = |p: &Path, m: u32| std::fs::set_permissions(p, std::fs::Permissions::from_mode(m)).unwrap();
        // As a server from before left it: a database open in WAL mode, and other files.
        let db = crate::db::open(&dir.join("huntaway.db")).unwrap();
        db.execute_batch("CREATE TABLE t (x); INSERT INTO t VALUES (1);").unwrap();
        for f in ["huntaway.db-wal", "huntaway.db-shm"] {
            assert!(dir.join(f).exists(), "{f}");
        }
        std::fs::write(dir.join("serve.log"), "log").unwrap();
        std::fs::write(root.join("elsewhere.db"), "").unwrap();
        std::os::unix::fs::symlink(root.join("elsewhere.db"), dir.join("linked.db")).unwrap();
        for f in ["huntaway.db", "huntaway.db-wal", "huntaway.db-shm", "serve.log"] {
            chmod(&dir.join(f), 0o644);
        }
        chmod(&root.join("elsewhere.db"), 0o644);
        chmod(&dir, 0o755);
        // Reached through a symlink, as a --data-dir can be.
        let via = root.join("via");
        std::os::unix::fs::symlink(&dir, &via).unwrap();
        make_private(&via);
        assert_eq!(mode(&dir), 0o700);
        for f in ["huntaway.db", "huntaway.db-wal", "huntaway.db-shm"] {
            assert_eq!(mode(&dir.join(f)), 0o600, "{f}");
        }
        // Other files keep their mode (the folder keeps others out), and a link's target is left alone.
        assert_eq!(mode(&dir.join("serve.log")), 0o644);
        assert_eq!(mode(&root.join("elsewhere.db")), 0o644);
        assert_eq!(mode(&dir.join("runs")), 0o755);
        // The database still works, and a second start changes nothing.
        db.execute_batch("INSERT INTO t VALUES (2);").unwrap();
        make_private(&dir);
        assert_eq!(mode(&dir), 0o700);
        drop(db);
        std::fs::remove_dir_all(&root).ok();
    }

    fn git(dir: &Path, args: &[&str]) {
        let ok = std::process::Command::new("git").arg("-C").arg(dir).args(args).env("GIT_CONFIG_GLOBAL", "/dev/null").status().unwrap().success();
        assert!(ok, "git {args:?}");
    }

    #[test]
    fn tells_a_repository_with_commits() {
        let dir = crate::testing::temp_dir();
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
