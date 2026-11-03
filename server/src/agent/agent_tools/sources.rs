//! Skill sources: git repositories whose skills the host offers, as `npx skills add owner/repo` does.
//!
//! Adding a source clones the repository (shallow) into `<data>/skill-sources/<id>/` and looks for
//! skills in it: any folder with a `SKILL.md` (the repository's root included). Each becomes a global
//! skill with `source_id` set, so profiles and projects switch it on like any other global skill; it
//! starts off everywhere. Updating a source clones it again and brings the skills up to date: ones that
//! are new appear (off), ones that went are removed, and the rest keep their switches. Before a run,
//! an enabled skill's whole folder is copied to the project's skills folder (see `sync_skills`), so its
//! scripts and references come with it.

use super::*;

use axum::http::StatusCode;
use std::os::unix::fs::PermissionsExt;

/// One source operation at a time: they clone, swap folders and write skills, and two at once for the
/// same source would race. (Runs only read the clones.)
static BUSY: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// How long a clone may take.
const CLONE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(180);
/// How deep in a repository to look for skills, and how many to take from one.
const MAX_DEPTH: usize = 6;
const MAX_SKILLS: usize = 200;
/// The most a skill's folder may hold, and the most a `SKILL.md` may be.
const MAX_SKILL_BYTES: u64 = 25 << 20;
const MAX_SKILL_MD: u64 = 256 << 10;

#[derive(Serialize, Clone, Debug)]
pub struct SkillSource {
    pub id: String,
    pub url: String,
    /// The branch or tag cloned; None for the repository's default branch.
    #[serde(rename = "ref")]
    pub git_ref: Option<String>,
    /// Shown in the lists: the repository's name.
    pub name: String,
    /// The commit the clone is at.
    pub commit: Option<String>,
    pub synced_at: Option<String>,
    /// Why the last update failed, if it did. The skills from the update before stay.
    pub error: Option<String>,
    /// Things in the repository that were left out: skills that aren't valid, or whose name is taken.
    pub notes: Vec<String>,
    pub created_at: String,
}

impl SkillSource {
    fn from_row(r: &Row) -> rusqlite::Result<Self> {
        let notes: String = r.get("notes")?;
        Ok(Self {
            id: r.get("id")?,
            url: r.get("url")?,
            git_ref: r.get("git_ref")?,
            name: r.get("name")?,
            commit: r.get("commit_sha")?,
            synced_at: r.get("synced_at")?,
            error: r.get("error")?,
            notes: serde_json::from_str(&notes).unwrap_or_default(),
            created_at: r.get("created_at")?,
        })
    }
}

pub(super) fn list_sources(c: &Connection) -> rusqlite::Result<Vec<SkillSource>> {
    let mut st = c.prepare("SELECT * FROM skill_sources ORDER BY name, created_at")?;
    st.query_map([], SkillSource::from_row)?.collect()
}

pub(super) fn get_source(c: &Connection, id: &str) -> rusqlite::Result<Option<SkillSource>> {
    c.query_row("SELECT * FROM skill_sources WHERE id=?1", [id], SkillSource::from_row).optional()
}

/// Where the sources are cloned, a folder for each.
pub(super) fn sources_root(state: &Shared) -> PathBuf {
    state.data_dir.join("skill-sources")
}

// ---------- what to clone ----------

/// The repository to clone from what was typed: a URL (https, http, ssh, git or file), an scp-style
/// `git@host:owner/repo`, a local path, or `owner/repo` for GitHub, as `npx skills add` takes.
/// Anything that git could take as an option or another transport (`ext::`) is refused.
pub(super) fn normalize_url(input: &str) -> ApiResult<String> {
    let url = input.trim();
    if url.is_empty() {
        return Err(ApiError::bad("the repository is needed: a git URL, or owner/repo for GitHub"));
    }
    if url.starts_with('-') || url.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(ApiError::bad("that isn't a git repository URL"));
    }
    let scheme = url.split_once("://").map(|(s, _)| s.to_ascii_lowercase());
    let github = || {
        let mut parts = url.split('/');
        let (owner, repo, rest) = (parts.next()?, parts.next()?, parts.next());
        let word = |s: &str| !s.is_empty() && s != "." && s != ".." && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
        (rest.is_none() && word(owner) && word(repo)).then(|| format!("https://github.com/{owner}/{}", repo.trim_end_matches(".git")))
    };
    match scheme.as_deref() {
        Some("https" | "http" | "ssh" | "git" | "file") => Ok(url.to_string()),
        Some(other) => Err(ApiError::bad(format!("{other}:// repositories aren't supported: use https, ssh or git"))),
        None if url.starts_with('/') => Ok(url.to_string()),
        // `git@github.com:owner/repo`; a `::` is git's `ext::` and similar transports.
        None if !url.contains("::") && url.split_once(':').is_some_and(|(host, path)| host.contains('@') && !host.contains('/') && !path.is_empty()) => {
            Ok(url.to_string())
        }
        None => github().ok_or_else(|| ApiError::bad("that isn't a git repository: use a URL, git@host:owner/repo, a path or owner/repo")),
    }
}

/// A branch or tag to clone, if one is given.
pub(super) fn check_ref(r: Option<String>) -> ApiResult<Option<String>> {
    let Some(r) = r.map(|r| r.trim().to_string()).filter(|r| !r.is_empty()) else { return Ok(None) };
    let ok = !r.starts_with(['-', '/']) && !r.contains("..") && r.len() <= 200 && r.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '/' | '+' | '@'));
    if ok { Ok(Some(r)) } else { Err(ApiError::bad("the branch or tag has characters a git ref can't have")) }
}

/// The repository's name for lists: the last part of its path, less `.git`.
pub(super) fn source_name(url: &str) -> String {
    let path = url.trim_end_matches('/');
    let last = path.rsplit(['/', ':']).next().unwrap_or(path);
    let name = last.strip_suffix(".git").unwrap_or(last);
    if name.is_empty() { "skills".into() } else { name.chars().take(80).collect() }
}

// ---------- cloning ----------

/// Shallow-clones `url` into `dest` (which mustn't exist), and returns the commit it's at.
async fn clone(url: &str, git_ref: Option<&str>, dest: &FsPath) -> anyhow::Result<String> {
    let mut cmd = tokio::process::Command::new("git");
    cmd.args(["clone", "--depth", "1", "--single-branch", "--no-tags", "--quiet"]);
    if let Some(r) = git_ref {
        cmd.args(["--branch", r]);
    }
    cmd.arg("--").arg(url).arg(dest);
    cmd.stdin(std::process::Stdio::null())
        .kill_on_drop(true)
        // Never wait for a password, and only the transports we accept (not `ext::`, which runs commands).
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_ALLOW_PROTOCOL", "https:http:ssh:git:file");
    if std::env::var_os("GIT_SSH_COMMAND").is_none() && std::env::var_os("GIT_SSH").is_none() {
        cmd.env("GIT_SSH_COMMAND", "ssh -o BatchMode=yes");
    }
    let out = tokio::time::timeout(CLONE_TIMEOUT, cmd.output())
        .await
        .map_err(|_| anyhow::anyhow!("cloning {url} took more than {} seconds", CLONE_TIMEOUT.as_secs()))?
        .map_err(|e| anyhow::anyhow!("couldn't run git: {e}"))?;
    if !out.status.success() {
        let why = String::from_utf8_lossy(&out.stderr);
        let why = why.lines().map(str::trim).filter(|l| !l.is_empty()).rev().take(3).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join(" ");
        // GitHub answers for a repository that isn't there as it does for a private one.
        let hint = if why.contains("terminal prompts disabled") { " (the repository may not exist, or it's private and this host has no git credentials for it)" } else { "" };
        anyhow::bail!("couldn't clone {url}{}: {why}{hint}", git_ref.map(|r| format!(" at {r}")).unwrap_or_default());
    }
    let head = tokio::process::Command::new("git").arg("-C").arg(dest).args(["rev-parse", "HEAD"]).stdin(std::process::Stdio::null()).output().await?;
    Ok(String::from_utf8_lossy(&head.stdout).trim().to_string())
}

// ---------- finding skills ----------

/// A skill in a clone.
#[derive(Debug, PartialEq)]
pub(super) struct Found {
    /// Its folder relative to the clone's root, with `/`s ("" for the root).
    pub(super) path: String,
    pub(super) name: String,
    pub(super) content: String,
}

/// The skills in a clone, and what was left out. A folder with a `SKILL.md` is a skill and its
/// folders belong to it; other folders are looked into, to `MAX_DEPTH` (not `.git`, `node_modules`
/// or hidden folders other than `.claude`, `.agents` and `.codex`). When a name turns up twice the
/// first is taken, with visible folders ahead of hidden ones.
pub(super) fn discover(root: &FsPath) -> (Vec<Found>, Vec<String>) {
    let (mut found, mut notes) = (Vec::new(), Vec::new());
    walk(root, "", 0, &mut found, &mut notes);
    (found, notes)
}

fn walk(dir: &FsPath, rel: &str, depth: usize, found: &mut Vec<Found>, notes: &mut Vec<String>) {
    let label = if rel.is_empty() { "the repository's root" } else { rel };
    let skill_md = dir.join("SKILL.md");
    if std::fs::symlink_metadata(&skill_md).is_ok_and(|m| m.is_file()) {
        if found.len() >= MAX_SKILLS {
            let note = format!("only the first {MAX_SKILLS} skills are taken");
            if !notes.contains(&note) {
                notes.push(note);
            }
            return;
        }
        let content = match std::fs::metadata(&skill_md) {
            Ok(m) if m.len() > MAX_SKILL_MD => Err("its SKILL.md is too big".to_string()),
            Ok(_) => std::fs::read_to_string(&skill_md).map_err(|_| "its SKILL.md isn't text".to_string()),
            Err(e) => Err(e.to_string()),
        };
        let checked = content.and_then(|content| {
            let f = check_skill(&content).map_err(|e| e.1)?;
            if folder_size(dir) > MAX_SKILL_BYTES {
                return Err(format!("its folder is bigger than {} MB", MAX_SKILL_BYTES >> 20));
            }
            Ok((f.name, content))
        });
        match checked {
            Ok((name, _)) if found.iter().any(|f| f.name == name) => notes.push(format!("{label}: another skill is named {name}")),
            Ok((name, content)) => found.push(Found { path: rel.to_string(), name, content }),
            Err(why) => notes.push(format!("{label}: {why}")),
        }
        return;
    }
    if depth >= MAX_DEPTH {
        return;
    }
    let mut subs: Vec<(bool, String)> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|n| n != ".git" && n != "node_modules" && (!n.starts_with('.') || matches!(n.as_str(), ".claude" | ".agents" | ".codex")))
        .map(|n| (n.starts_with('.'), n))
        .collect();
    subs.sort();
    for (_, name) in subs {
        let child = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
        walk(&dir.join(&name), &child, depth + 1, found, notes);
    }
}

/// The size of the files in a folder, not following links.
fn folder_size(dir: &FsPath) -> u64 {
    let mut total = 0;
    for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let Ok(t) = e.file_type() else { continue };
        if t.is_dir() && e.file_name() != ".git" {
            total += folder_size(&e.path());
        } else if t.is_file() {
            total += e.metadata().map_or(0, |m| m.len());
        }
        if total > MAX_SKILL_BYTES {
            break;
        }
    }
    total
}

// ---------- copying a skill to a run's folder ----------

/// Makes `to` hold the same files as the skill folder `from`, leaving files that are already right
/// alone (other agents may be reading them). Links are skipped, so a repository can't make a run's
/// folder show files from elsewhere, and so is `.git`.
pub(super) fn copy_skill(from: &FsPath, to: &FsPath) -> std::io::Result<()> {
    if std::fs::symlink_metadata(to).is_ok_and(|m| !m.is_dir()) {
        std::fs::remove_file(to)?;
    }
    std::fs::create_dir_all(to)?;
    let wanted = |name: &std::ffi::OsStr| {
        name != ".git" && std::fs::symlink_metadata(from.join(name)).is_ok_and(|m| m.is_dir() || m.is_file())
    };
    for e in std::fs::read_dir(to)?.flatten() {
        if !wanted(&e.file_name()) {
            let path = e.path();
            let is_dir = e.file_type().is_ok_and(|t| t.is_dir());
            if is_dir { std::fs::remove_dir_all(&path)? } else { std::fs::remove_file(&path)? }
        }
    }
    for e in std::fs::read_dir(from)?.flatten() {
        let name = e.file_name();
        if !wanted(&name) {
            continue;
        }
        let (src, dst) = (e.path(), to.join(&name));
        if e.file_type()?.is_dir() {
            copy_skill(&src, &dst)?;
        } else {
            if std::fs::symlink_metadata(&dst).is_ok_and(|m| !m.is_file()) {
                std::fs::remove_dir_all(&dst).or_else(|_| std::fs::remove_file(&dst))?;
            }
            let same = std::fs::metadata(&dst).is_ok_and(|d| d.len() == e.metadata().map_or(u64::MAX, |m| m.len()))
                && std::fs::read(&dst).ok() == std::fs::read(&src).ok();
            if !same {
                std::fs::copy(&src, &dst)?;
            } else {
                // A commit may only make a script executable (or not): the copy follows.
                let want = std::fs::metadata(&src)?.permissions();
                if std::fs::metadata(&dst)?.permissions().mode() & 0o777 != want.mode() & 0o777 {
                    std::fs::set_permissions(&dst, want)?;
                }
            }
        }
    }
    Ok(())
}

// ---------- the API ----------

#[derive(Deserialize)]
pub struct AddSource {
    pub(super) url: Option<String>,
    #[serde(rename = "ref")]
    pub(super) git_ref: Option<String>,
}

/// A fresh clone of a source and the skills in it, in a folder beside where it will go.
struct Fetched {
    dir: PathBuf,
    commit: String,
    found: Vec<Found>,
    notes: Vec<String>,
}

async fn fetch(state: &Shared, id: &str, url: &str, git_ref: Option<&str>) -> anyhow::Result<Fetched> {
    let root = sources_root(state);
    std::fs::create_dir_all(&root)?;
    let dir = root.join(format!("{id}.new"));
    let _ = std::fs::remove_dir_all(&dir);
    let result = async {
        let commit = clone(url, git_ref, &dir).await?;
        let scan = dir.clone();
        let (found, notes) = tokio::task::spawn_blocking(move || discover(&scan)).await?;
        Ok(Fetched { dir: dir.clone(), commit, found, notes })
    }
    .await;
    if result.is_err() {
        let _ = std::fs::remove_dir_all(&dir);
    }
    result
}

/// Puts a fetched clone where the source's is, in place of the one before.
fn install(state: &Shared, id: &str, fetched: &Fetched) -> std::io::Result<()> {
    let (live, old) = (sources_root(state).join(id), sources_root(state).join(format!("{id}.old")));
    let _ = std::fs::remove_dir_all(&old);
    if live.exists() {
        std::fs::rename(&live, &old)?;
    }
    if let Err(e) = std::fs::rename(&fetched.dir, &live) {
        let _ = std::fs::rename(&old, &live);
        return Err(e);
    }
    let _ = std::fs::remove_dir_all(&old);
    Ok(())
}

/// Brings a source's skills in line with a fresh clone: adds new ones (off everywhere), updates the
/// ones that stay and removes the ones that went. Returns what was left out. All or nothing.
fn apply(c: &Connection, id: &str, fetched: &Fetched) -> ApiResult<Vec<String>> {
    c.execute_batch("SAVEPOINT apply_source")?;
    match apply_in(c, id, fetched) {
        Ok(notes) => {
            c.execute_batch("RELEASE apply_source")?;
            Ok(notes)
        }
        Err(e) => {
            let _ = c.execute_batch("ROLLBACK TO apply_source; RELEASE apply_source");
            Err(e)
        }
    }
}

fn apply_in(c: &Connection, id: &str, fetched: &Fetched) -> ApiResult<Vec<String>> {
    let mut notes = fetched.notes.clone();
    let existing: Vec<Skill> = c.prepare("SELECT * FROM agent_skills WHERE source_id=?1")?.query_map([id], Skill::from_row)?.collect::<rusqlite::Result<_>>()?;
    let at = now();
    // Which existing skill each found one is: the one at its path, else (the folder was moved) the one
    // with its name that no found skill is at the path of, so it keeps its id and switches.
    let at_path = |f: &Found| existing.iter().find(|s| s.source_path.as_deref() == Some(f.path.as_str()));
    let mut matched: Vec<Option<&Skill>> = fetched
        .found
        .iter()
        .map(|f| {
            at_path(f).or_else(|| {
                existing.iter().find(|s| s.name == f.name && !fetched.found.iter().any(|o| s.source_path.as_deref() == Some(o.path.as_str())))
            })
        })
        .collect();
    // A name is taken only by a skill that isn't from this source: its own skills give theirs up as
    // they're renamed, moved or removed. (The found ones have names of their own, see `discover`.)
    let mut keep = vec![true; fetched.found.len()];
    for (i, f) in fetched.found.iter().enumerate() {
        let taken: bool = c.query_row(
            "SELECT COUNT(*) > 0 FROM agent_skills WHERE project_id IS NULL AND name=?1 AND (source_id IS NULL OR source_id != ?2)",
            params![f.name, id],
            |r| r.get(0),
        )?;
        if taken {
            notes.push(format!("{}: a skill named {} is already on this host", if f.path.is_empty() { "the repository's root" } else { &f.path }, f.name));
            keep[i] = false;
        }
    }
    // The ones that are gone, or left out, are removed.
    let used = |s: &Skill| fetched.found.iter().zip(&matched).zip(&keep).any(|((_, m), k)| *k && m.is_some_and(|m| m.id == s.id));
    let gone: Vec<&Skill> = existing.iter().filter(|s| !used(s)).collect();
    for s in &gone {
        c.execute("DELETE FROM agent_skills WHERE id=?1", [&s.id])?;
    }
    for (i, k) in keep.iter().enumerate() {
        if !k {
            matched[i] = None;
        }
    }
    // Renames in two steps, so that skills can swap names or pass them along.
    let renamed: Vec<(&Found, &Skill)> =
        fetched.found.iter().zip(&matched).zip(&keep).filter(|(_, k)| **k).filter_map(|((f, m), _)| Some((f, (*m)?))).filter(|(f, s)| f.name != s.name).collect();
    for (_, s) in &renamed {
        c.execute("UPDATE agent_skills SET name=?1 WHERE id=?2", params![format!("\u{0}renaming {}", s.id), s.id])?;
    }
    for ((f, before), k) in fetched.found.iter().zip(&matched).zip(&keep) {
        if !k {
            continue;
        }
        match before {
            Some(s) => {
                c.execute("UPDATE agent_skills SET name=?1, content=?2, source_path=?3, updated_at=?4 WHERE id=?5", params![f.name, f.content, f.path, at, s.id])?;
            }
            None => {
                c.execute(
                    "INSERT INTO agent_skills (id, project_id, name, content, enabled, source_id, source_path, created_at, updated_at) VALUES (?1,NULL,?2,?3,1,?4,?5,?6,?6)",
                    params![new_id(), f.name, f.content, id, f.path, at],
                )?;
            }
        }
    }
    // What runs reported under the names that went (see forget_board_skill) is forgotten once all are settled.
    for name in gone.iter().map(|s| &s.name).chain(renamed.iter().map(|(_, s)| &s.name)) {
        forget_board_skill(c, None, name)?;
    }
    Ok(notes)
}

/// `POST /agent-tools/skill-sources` (API 104): clones a repository and adds its skills, off for
/// every profile and project until they're switched on.
pub async fn add_source(State(s): State<Shared>, Json(b): Json<AddSource>) -> ApiResult<Json<Value>> {
    let url = normalize_url(&b.url.unwrap_or_default())?;
    let git_ref = check_ref(b.git_ref)?;
    let _busy = BUSY.lock().await;
    {
        let c = s.db();
        let same = list_sources(&c)?.into_iter().any(|o| o.url == url && o.git_ref == git_ref);
        if same {
            return Err(ApiError::conflict("that repository is already added: update it instead"));
        }
    }
    let id = new_id();
    let fetched = fetch(&s, &id, &url, git_ref.as_deref()).await.map_err(|e| ApiError(StatusCode::BAD_GATEWAY, format!("{e:#}")))?;
    install(&s, &id, &fetched).map_err(|e| ApiError::from(anyhow::Error::from(e)))?;
    let source = {
        let c = s.db();
        c.execute(
            "INSERT INTO skill_sources (id, url, git_ref, name, commit_sha, synced_at, notes, created_at) VALUES (?1,?2,?3,?4,?5,?6,'[]',?6)",
            params![id, url, git_ref, source_name(&url), fetched.commit, now()],
        )?;
        let notes = apply(&c, &id, &fetched)?;
        if skills_of(&c, &id)?.is_empty() {
            // Nothing in it could be added: it isn't a source.
            c.execute("DELETE FROM skill_sources WHERE id=?1", [&id])?;
            drop(c);
            let _ = std::fs::remove_dir_all(sources_root(&s).join(&id));
            let why = if notes.is_empty() { String::new() } else { format!(" ({})", notes.join("; ")) };
            return Err(ApiError::bad(format!("no skills found in {url}: a skill is a folder with a SKILL.md{why}")));
        }
        c.execute("UPDATE skill_sources SET notes=?1 WHERE id=?2", params![json!(notes).to_string(), id])?;
        get_source(&c, &id)?.ok_or_else(|| ApiError::not_found("skill source"))?
    };
    Ok(Json(json!({"source": source, "skills": skills_of(&s.db(), &id)?})))
}

/// `POST /agent-tools/skill-sources/{id}/update`: clones the repository again and brings its skills
/// up to date. If that fails the skills stay as they were, and the source says why.
pub async fn update_source(State(s): State<Shared>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let _busy = BUSY.lock().await;
    let source = get_source(&s.db(), &id)?.ok_or_else(|| ApiError::not_found("skill source"))?;
    let fetched = match fetch(&s, &id, &source.url, source.git_ref.as_deref()).await {
        Ok(f) => f,
        Err(e) => {
            let why = format!("{e:#}");
            s.db().execute("UPDATE skill_sources SET error=?1 WHERE id=?2", params![why, id])?;
            return Err(ApiError(StatusCode::BAD_GATEWAY, why));
        }
    };
    install(&s, &id, &fetched).map_err(|e| ApiError::from(anyhow::Error::from(e)))?;
    let c = s.db();
    let notes = apply(&c, &id, &fetched)?;
    c.execute(
        "UPDATE skill_sources SET commit_sha=?1, synced_at=?2, error=NULL, notes=?3 WHERE id=?4",
        params![fetched.commit, now(), json!(notes).to_string(), id],
    )?;
    let source = get_source(&c, &id)?.ok_or_else(|| ApiError::not_found("skill source"))?;
    Ok(Json(json!({"source": source, "skills": skills_of(&c, &id)?})))
}

/// `DELETE /agent-tools/skill-sources/{id}`: forgets the repository, its clone and its skills.
pub async fn delete_source(State(s): State<Shared>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let _busy = BUSY.lock().await;
    {
        let c = s.db();
        get_source(&c, &id)?.ok_or_else(|| ApiError::not_found("skill source"))?;
        let skills = skills_of(&c, &id)?;
        c.execute("DELETE FROM agent_skills WHERE source_id=?1", [&id])?;
        c.execute("DELETE FROM skill_sources WHERE id=?1", [&id])?;
        for skill in skills {
            forget_board_skill(&c, None, &skill.name)?;
        }
    }
    let _ = std::fs::remove_dir_all(sources_root(&s).join(&id));
    Ok(Json(json!({"ok": true})))
}

pub(super) fn skills_of(c: &Connection, source_id: &str) -> rusqlite::Result<Vec<Skill>> {
    c.prepare("SELECT * FROM agent_skills WHERE source_id=?1 ORDER BY name")?.query_map([source_id], Skill::from_row)?.collect()
}

#[cfg(test)]
mod tests;
