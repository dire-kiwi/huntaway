//! What turns changed: the files between two checkpoints, without those git brought in, and their
//! stats and patches.

use super::*;

/// What the reflog says about how HEAD got to each commit: whether it was made in this worktree
/// (committed, amended, picked, merged) rather than moved to (a fast-forward, reset or checkout).
pub(super) fn creates_commit(subject: &str) -> bool {
    let action = subject.split(':').next().unwrap_or("");
    action.starts_with("commit")
        || action.starts_with("cherry-pick")
        || action.starts_with("revert")
        || action == "am"
        || ["(pick)", "(reword)", "(edit)", "(squash)", "(fixup)", "(continue)"].iter().any(|a| action.ends_with(a))
        || subject.contains(": Merge made by")
}

/// The commits made in the worktree at `top`, from its HEAD's reflog (None if it has none).
async fn made_here(top: &Path) -> Result<Option<HashSet<String>>> {
    let o = run(top, &["log", "-g", "-n", "20000", "--format=%H%x1f%gs", "HEAD", "--"], &[], None).await?;
    if !o.ok {
        return Ok(None);
    }
    let text = String::from_utf8_lossy(&o.stdout);
    let made: HashSet<String> = text.lines().filter_map(|l| l.split_once('\x1f')).filter(|(_, s)| creates_commit(s)).map(|(h, _)| h.to_string()).collect();
    Ok((!text.trim().is_empty()).then_some(made))
}

/// The paths each commit changed against the parent given with it (`commit [parent]` lines).
async fn changed_by(top: &Path, pairs: &[(String, Option<String>)]) -> Result<BTreeSet<Vec<u8>>> {
    if pairs.is_empty() {
        return Ok(BTreeSet::new());
    }
    let input: String = pairs.iter().map(|(c, p)| format!("{c}{}\n", p.as_ref().map(|p| format!(" {p}")).unwrap_or_default())).collect();
    let o = run_ok(top, &["diff-tree", "--stdin", "-r", "--root", "--name-only", "-z", "--no-commit-id", "--no-renames"], &[], Some(input.as_bytes())).await?;
    Ok(split_nul(&o.stdout).map(<[u8]>::to_vec).collect())
}

pub(super) async fn names(top: &Path, from: &str, to: &str) -> Result<BTreeSet<Vec<u8>>> {
    let o = run_ok(top, &["diff-tree", "-r", "-z", "--name-only", "--no-renames", from, to], &[], None).await?;
    Ok(split_nul(&o.stdout).map(<[u8]>::to_vec).collect())
}

/// The files git brought in between two checkpoints of the worktree at `top` (from HEAD
/// `from_head` to HEAD `to_head` and the files `to_tree`) that weren't changed in the worktree
/// itself: those changed by commits HEAD moved to rather than made here (a pull, a fast-forward
/// merge, the commits a rebase went onto) and by merges made here, except where a merge's result
/// isn't git's own (conflicts resolved), where a commit made here changed them too, or where
/// they're changed and not committed.
pub(super) async fn brought_in(top: &Path, from_head: Option<&str>, to_head: Option<&str>, to_tree: &str) -> Result<BTreeSet<Vec<u8>>> {
    let (Some(hb), Some(ha)) = (from_head, to_head) else { return Ok(BTreeSet::new()) };
    if hb == ha {
        return Ok(BTreeSet::new());
    }
    let max = format!("--max-count={}", MAX_COMMITS + 1);
    let list = run_ok(top, &["rev-list", "--parents", &max, ha, &format!("^{hb}"), "--"], &[], None).await?;
    let commits: Vec<Vec<String>> = String::from_utf8_lossy(&list.stdout).lines().map(|l| l.split_whitespace().map(String::from).collect()).filter(|c: &Vec<String>| !c.is_empty()).collect();
    if commits.is_empty() || commits.len() > MAX_COMMITS {
        return Ok(BTreeSet::new());
    }
    // Without a reflog it can't tell: nothing is left out.
    let Some(made) = made_here(top).await? else { return Ok(BTreeSet::new()) };
    let pair = |c: &Vec<String>| (c[0].clone(), c.get(1).cloned());
    let (own, other): (Vec<&Vec<String>>, Vec<&Vec<String>>) = commits.iter().partition(|c| made.contains(&c[0]));
    let merges: Vec<&Vec<String>> = own.iter().copied().filter(|c| c.len() > 2).collect();
    if other.is_empty() && merges.is_empty() {
        return Ok(BTreeSet::new());
    }
    let mut touched = changed_by(top, &own.iter().filter(|c| c.len() <= 2).map(|c| pair(c)).collect::<Vec<_>>()).await?;
    for m in &merges {
        let o = run(top, &["show", "--remerge-diff", "--format=", "--name-only", "-z", &m[0], "--"], &[], None).await?;
        if o.ok {
            touched.extend(split_nul(&o.stdout).map(<[u8]>::to_vec));
        } else {
            // A git from before remerge diffs (2.36): all of the merge counts as the turn's.
            touched.extend(changed_by(top, &[pair(m)]).await?);
        }
    }
    touched.extend(names(top, ha, to_tree).await?);
    let mut pairs: Vec<(String, Option<String>)> = other.iter().map(|c| pair(c)).collect();
    pairs.extend(merges.iter().map(|c| pair(c)));
    let brought = changed_by(top, &pairs).await?;
    Ok(brought.difference(&touched).cloned().collect())
}

/// `git diff --numstat` from `from` to `to` (commits), without `excluded`.
pub(super) async fn numstat(top: &Path, from: &str, to: &str, excluded: &BTreeSet<Vec<u8>>) -> Result<(Stats, Vec<String>)> {
    let o = run_ok(top, &["diff", "--numstat", "-z", "--no-renames", "--no-ext-diff", from, to, "--"], &[], None).await?;
    let mut stats = Stats::default();
    let mut left_out = Vec::new();
    for entry in split_nul(&o.stdout) {
        let mut parts = entry.splitn(3, |b| *b == b'\t');
        let (Some(a), Some(d), Some(path)) = (parts.next(), parts.next(), parts.next()) else { continue };
        if excluded.contains(path) {
            left_out.push(lossy(path));
            continue;
        }
        stats.files += 1;
        stats.additions += std::str::from_utf8(a).ok().and_then(|a| a.parse().ok()).unwrap_or(0);
        stats.deletions += std::str::from_utf8(d).ok().and_then(|d| d.parse().ok()).unwrap_or(0);
    }
    Ok((stats, left_out))
}

/// What a turn changed, from checkpoint `before` to `after`.
pub(super) async fn stats(top: &Path, before: &Checkpoint, after: &Snap) -> Result<Stats> {
    let excluded = brought_in(top, before.head.as_deref(), after.head.as_deref(), &after.tree).await?;
    let (mut stats, left_out) = numstat(top, &before.sha, &after.sha, &excluded).await?;
    stats.excluded_count = left_out.len();
    stats.excluded = left_out.into_iter().take(200).collect();
    Ok(stats)
}

/// A C-quoted path from a diff header (`"a/x\ty"`), unquoted.
fn unquote(s: &str) -> Option<(String, &str)> {
    let rest = s.strip_prefix('"')?;
    let mut out = Vec::new();
    let mut chars = rest.char_indices();
    while let Some((i, c)) = chars.next() {
        match c {
            '"' => return Some((String::from_utf8_lossy(&out).into_owned(), &rest[i + 1..])),
            '\\' => {
                let (_, e) = chars.next()?;
                match e {
                    'n' => out.push(b'\n'),
                    't' => out.push(b'\t'),
                    'r' => out.push(b'\r'),
                    'a' => out.push(7),
                    'b' => out.push(8),
                    'f' => out.push(12),
                    'v' => out.push(11),
                    '0'..='7' => {
                        let mut v = e.to_digit(8)?;
                        for _ in 0..2 {
                            let (_, d) = chars.next()?;
                            v = v * 8 + d.to_digit(8)?;
                        }
                        out.push(v as u8);
                    }
                    other => {
                        let mut b = [0; 4];
                        out.extend_from_slice(other.encode_utf8(&mut b).as_bytes());
                    }
                }
            }
            c => {
                let mut b = [0; 4];
                out.extend_from_slice(c.encode_utf8(&mut b).as_bytes());
            }
        }
    }
    None
}

/// The path a `diff --git a/<path> b/<path>` line (without renames, so both are the same) is for.
pub(super) fn header_path(line: &str) -> Option<String> {
    let rest = line.strip_prefix("diff --git ")?;
    if rest.starts_with('"') {
        let (a, _) = unquote(rest)?;
        return a.strip_prefix("a/").map(String::from);
    }
    // `a/<p> b/<p>`: the same path twice.
    let len = rest.len().checked_sub(5)? / 2;
    rest.get(2..2 + len).map(String::from)
}

/// `patch` without the files in `excluded`.
pub(super) fn without(patch: &str, excluded: &HashSet<String>) -> String {
    if excluded.is_empty() {
        return patch.to_string();
    }
    let mut out = String::with_capacity(patch.len());
    let mut keep = true;
    for line in patch.split_inclusive('\n') {
        if line.starts_with("diff --git ") {
            keep = header_path(line.trim_end_matches('\n')).is_none_or(|p| !excluded.contains(&p));
        }
        if keep {
            out.push_str(line);
        }
    }
    out
}
