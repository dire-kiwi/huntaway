//! Restoring a worktree's files to a checkpoint.

use super::*;

#[derive(Debug, Default, PartialEq)]
pub struct Restored {
    pub written: usize,
    pub removed: usize,
    /// Files left as they are: submodules and other repositories, files the index marks
    /// skip-worktree or assume-unchanged, and files the checkpoints don't have (see `safe_to_write`).
    pub skipped: Vec<String>,
    /// The files written or removed.
    pub(super) changed: BTreeSet<Vec<u8>>,
    /// The files marked skip-worktree or assume-unchanged.
    pub(super) hidden: HashSet<Vec<u8>>,
}

/// Make the worktree at `top`, whose files are `now` (a tree from `snapshot`), have the files of
/// tree `to`: only the files that differ are written or removed, and only where nothing else would
/// go with them (ignored files and the rest are left alone).
pub(super) async fn restore(top: &Path, now: &str, to: &str) -> Result<Restored> {
    let raw = run_ok(top, &["diff-tree", "-r", "-z", "--no-renames", now, to], &[], None).await?;
    let mut out = Restored::default();
    out.hidden = {
        let o = run_ok(top, &["ls-files", "-v", "-z"], &[], None).await?;
        split_nul(&o.stdout).filter(|e| e.len() > 2 && (e[0] == b'S' || e[0].is_ascii_lowercase())).map(|e| e[2..].to_vec()).collect()
    };
    // (path, whether `now` has it)
    let (mut write, mut remove): (Vec<(Vec<u8>, bool)>, Vec<Vec<u8>>) = (Vec::new(), Vec::new());
    let mut fields = raw.stdout.split(|b| *b == 0);
    while let Some(meta) = fields.next() {
        if meta.is_empty() {
            continue;
        }
        let Some(path) = fields.next() else { break };
        // `:<old mode> <new mode> <old sha> <new sha> <status>`
        let meta = String::from_utf8_lossy(meta);
        let mut m = meta.trim_start_matches(':').split(' ');
        let (old_mode, new_mode) = (m.next().unwrap_or(""), m.next().unwrap_or(""));
        if old_mode == "160000" || new_mode == "160000" || out.hidden.contains(path) {
            out.skipped.push(lossy(path));
        } else if new_mode == "000000" {
            remove.push(path.to_vec());
        } else {
            write.push((path.to_vec(), old_mode != "000000"));
        }
    }
    for p in remove {
        if remove_file(top, &p)? {
            out.removed += 1;
            out.changed.insert(p);
        }
    }
    let (write, left): (Vec<_>, Vec<_>) = write.into_iter().partition(|(p, in_now)| safe_to_write(top, p, *in_now));
    out.skipped.extend(left.iter().map(|(p, _)| lossy(p)));
    if !write.is_empty() {
        let scratch = ScratchIndex::new(top, false).await?;
        run_ok(top, &["read-tree", to], &scratch.env(), None).await?;
        run_ok(top, &["checkout-index", "-f", "-z", "--stdin"], &scratch.env(), Some(&nul_list(write.iter().map(|(p, _)| p.as_slice())))).await?;
        out.written = write.len();
        out.changed.extend(write.into_iter().map(|(p, _)| p));
    }
    Ok(out)
}

/// Whether the file `rel` can be written in the worktree at `top` without losing anything that
/// isn't in the checkpoint taken just before (`in_now`: that has the file): `checkout-index -f`
/// would remove a folder in its way with all that's in it, and overwrite whatever is there.
/// So not where a folder is (one the restore didn't empty: it holds ignored files, say), not
/// inside another repository or through a symlink, and not over a file the checkpoint doesn't
/// have (one ignored since, too big, or unreadable).
fn safe_to_write(top: &Path, rel: &[u8], in_now: bool) -> bool {
    let rel = Path::new(OsStr::from_bytes(rel));
    let Some(parts) = rel.components().map(|c| if let Component::Normal(p) = c { Some(p) } else { None }).collect::<Option<Vec<_>>>() else { return false };
    let Some((name, dirs)) = parts.split_last() else { return false };
    let mut dir = top.to_path_buf();
    for d in dirs {
        dir.push(d);
        match std::fs::symlink_metadata(&dir) {
            Ok(m) if m.is_dir() => {
                if std::fs::symlink_metadata(dir.join(".git")).is_ok() {
                    return false;
                }
            }
            Ok(_) => return false,
            // Not there: nothing below it is either.
            Err(_) => return true,
        }
    }
    match std::fs::symlink_metadata(dir.join(name)) {
        Err(_) => true,
        Ok(m) if m.is_dir() => false,
        Ok(_) => in_now,
    }
}

/// Put `paths` back in the index as they are in HEAD.
pub(super) async fn unstaged(top: &Path, paths: &BTreeSet<Vec<u8>>) -> Result<()> {
    if !paths.is_empty() && head(top).await?.is_some() {
        run_ok(top, &["--literal-pathspecs", "reset", "-q", "--pathspec-from-file=-", "--pathspec-file-nul"], &[], Some(&nul_list(paths.iter().map(Vec::as_slice)))).await?;
    }
    Ok(())
}

/// Remove the file `rel` from the worktree at `top` (not a folder, and nothing through a symlink),
/// then the folders it leaves empty. Whether there was one to remove.
fn remove_file(top: &Path, rel: &[u8]) -> Result<bool> {
    let rel = Path::new(OsStr::from_bytes(rel));
    let parts: Vec<&OsStr> = rel.components().map(|c| match c {
        Component::Normal(p) => Some(p),
        _ => None,
    }).collect::<Option<_>>().context("not a path in the worktree")?;
    let Some((name, dirs)) = parts.split_last() else { return Ok(false) };
    let mut dir = top.to_path_buf();
    for d in dirs {
        dir.push(d);
        match std::fs::symlink_metadata(&dir) {
            Ok(m) if m.is_dir() => {}
            _ => return Ok(false),
        }
    }
    let path = dir.join(name);
    match std::fs::symlink_metadata(&path) {
        Ok(m) if !m.is_dir() => std::fs::remove_file(&path).with_context(|| format!("removing {}", path.display()))?,
        _ => return Ok(false),
    }
    let mut d = path.parent();
    while let Some(dir) = d.filter(|d| *d != top && d.starts_with(top)) {
        if std::fs::remove_dir(dir).is_err() {
            break;
        }
        d = dir.parent();
    }
    Ok(true)
}
