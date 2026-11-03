//! Which file in a data dir the database is in. Builds from the move onto agent-threads on (HA-128) use `FILE`, which
//! they copy from the file older builds use (`OLDER`) on their first start, and migrate. The older file is only ever
//! read (which leaves an empty `-wal` beside it if it had none, as any reader does), so an older build started on the data dir again opens it as it was at the switch, at a version it knows.
//! What was done in between is only in `FILE`.
//!
//! The copy records the older file's state then (`db_origin`). If an older build has used it since, the next start
//! here says so, and copies it again only when asked (`--recopy-db`, or Settings → Server, which `request_recopy`s),
//! since that discards what was done in `FILE` since the first copy (it's kept in `FILE.replaced` until the next one).

use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use anyhow::{Context, Result, bail, ensure};
use rusqlite::{Connection, OpenFlags, OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::util::{now, path_str};

/// This build's database file. A build whose database older builds mustn't open takes the next number, copying
/// it from this one (which then goes first in its `OLDER`).
pub const FILE: &str = "huntaway-2.db";
/// The files older builds use, newest first: they open the first that's there (`huntaway.db`, or `issue-agent.db`
/// from before the rename to Huntaway), and make a `huntaway.db` if neither is.
pub const OLDER: &[&str] = &["huntaway.db", "issue-agent.db"];
/// Asks the next start to copy the older file again (see `request_recopy`).
const RECOPY: &str = "recopy-db";

/// A file's size and modification time, which change when SQLite writes to it.
#[derive(Serialize, Deserialize, PartialEq, Eq, Debug, Clone, Copy)]
pub struct Stamp {
    pub len: u64,
    pub modified_ns: u64,
}

impl Stamp {
    fn of(path: &Path) -> std::io::Result<Stamp> {
        let m = std::fs::metadata(path)?;
        let modified_ns = m.modified()?.duration_since(UNIX_EPOCH).map_or(0, |d| d.as_nanos() as u64);
        Ok(Stamp { len: m.len(), modified_ns })
    }
}

/// The state of a database file and its write-ahead log, to tell whether anything has written to it since. An empty
/// log is the same as none: opening a database read-only makes one if there isn't one. The `-shm` file is left out,
/// since readers write to it.
#[derive(Serialize, Deserialize, PartialEq, Eq, Debug, Clone, Copy)]
pub struct FileState {
    pub db: Stamp,
    pub wal: Option<Stamp>,
}

impl FileState {
    pub fn of(path: &Path) -> Result<FileState> {
        let db = Stamp::of(path).with_context(|| format!("reading {}", path_str(path)))?;
        let wal = Stamp::of(&suffixed(path, "-wal")).ok().filter(|s| s.len > 0);
        Ok(FileState { db, wal })
    }
}

/// Where `FILE` was copied from (`db_origin`).
#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct Origin {
    /// The older file's name in the data dir.
    pub source: String,
    /// Its `user_version` then.
    pub source_version: i64,
    pub copied_at: String,
    #[serde(skip)]
    pub state: FileState,
}

/// Which file the database is in, and whether the older one has changed since it was copied (`/admin/server`'s
/// `database`, API 104).
#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct Status {
    /// `FILE`.
    pub file: String,
    pub copied_from: Option<Origin>,
    /// The file an older build would open now, if it's had changes since the copy (or since `FILE` was made, when it
    /// wasn't copied): an older build has used the data dir since, and its changes aren't in `FILE`.
    pub older_changed: Option<String>,
}

pub fn origin(c: &Connection) -> Result<Option<Origin>> {
    let row = c
        .query_row("SELECT source, source_version, source_state, copied_at FROM db_origin WHERE id=1", [], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?))
        })
        .optional()?;
    let Some((source, source_version, state, copied_at)) = row else { return Ok(None) };
    let state = serde_json::from_str(&state).with_context(|| format!("db_origin's source_state {state:?}"))?;
    Ok(Some(Origin { source, source_version, copied_at, state }))
}

/// The file an older build would open in `data_dir`, if there's one.
pub fn older(data_dir: &Path) -> Option<&'static str> {
    OLDER.iter().copied().find(|f| data_dir.join(f).is_file())
}

/// `Status` for the database `c` in `data_dir`.
pub fn status(data_dir: &Path, c: &Connection) -> Result<Status> {
    let copied_from = origin(c)?;
    let older_changed = older(data_dir).filter(|f| match &copied_from {
        Some(o) => o.source != *f || FileState::of(&data_dir.join(f)).map_or(true, |s| s != o.state),
        None => true,
    });
    Ok(Status { file: FILE.into(), copied_from, older_changed: older_changed.map(String::from) })
}

/// Ask the next start to copy the older file into `FILE` again (if it's still changed then).
pub fn request_recopy(data_dir: &Path) -> Result<()> {
    std::fs::write(data_dir.join(RECOPY), now()).context("asking for the database to be copied again")
}

/// Open the database in `data_dir` (`FILE`) and migrate it. On the first start, it's copied from the file an older
/// build uses, if there's one; when an older build has used that since, it's copied again if `recopy` (or
/// `request_recopy`) asks, and otherwise this warns.
pub fn open(data_dir: &Path, recopy: bool) -> Result<(Connection, Status)> {
    let path = data_dir.join(FILE);
    let marker = data_dir.join(RECOPY);
    let recopy = recopy || marker.exists();
    if path.exists() {
        let conn = super::open(&path)?;
        let st = status(data_dir, &conn)?;
        let Some(older) = st.older_changed.clone() else {
            if recopy {
                tracing::info!("not copying the database again: {}", match older(data_dir) {
                    Some(f) => format!("{f} hasn't changed since it was copied into {FILE}"),
                    None => format!("there's no older database to copy into {FILE}"),
                });
                remove(&marker)?;
            }
            return Ok((conn, st));
        };
        if !recopy {
            let since = st.copied_from.as_ref().map_or(format!("{FILE} was made"), |o| format!("it was copied into {FILE} at {}", o.copied_at));
            tracing::warn!(
                "{older} has changed since {since}: an older build of Huntaway has used this data dir since, and what it did isn't \
                 in {FILE}, which this build uses. To start from {older} again, discarding what's been done in {FILE} since, restart \
                 with --recopy-db (or use Copy again in Settings → Server)"
            );
            return Ok((conn, st));
        }
        let partial = copy(data_dir, &older)?;
        // Set the current file aside in one piece: without its log, which would be applied to the new file.
        let mode: String = conn.query_row("PRAGMA journal_mode=DELETE", [], |r| r.get(0))?;
        ensure!(mode == "delete", "couldn't take {FILE} out of WAL mode to set it aside (it's {mode})");
        drop(conn);
        let replaced = data_dir.join(format!("{FILE}.replaced"));
        remove_db(&replaced)?;
        std::fs::rename(&path, &replaced).with_context(|| format!("setting {FILE} aside"))?;
        install(&partial, &path)?;
        remove(&marker)?;
        tracing::warn!("copied {older} into {FILE} again; what {FILE} had before is in {}, until the next copy", path_str(&replaced));
    } else if let Some(older) = older(data_dir) {
        let started = std::time::Instant::now();
        tracing::info!("copying {older} into {FILE}, which this build uses (an older build keeps using {older} as it is now)");
        let partial = copy(data_dir, older)?;
        install(&partial, &path)?;
        tracing::info!("copied {older} into {FILE} in {:.1}s", started.elapsed().as_secs_f64());
    }
    remove(&marker)?;
    let conn = super::open(&path)?;
    let st = status(data_dir, &conn)?;
    Ok((conn, st))
}

/// Copy the older file `source` in `data_dir` into `FILE.partial`, a consistent copy with what's in its log, and
/// migrate it, recording where it came from. `source` is only read.
fn copy(data_dir: &Path, source: &str) -> Result<PathBuf> {
    let src = data_dir.join(source);
    let partial = data_dir.join(format!("{FILE}.partial"));
    // Left by a start that stopped before it was done.
    remove_db(&partial)?;
    // Before reading, so a write while it's copied shows as a change.
    let state = FileState::of(&src)?;
    let version: i64 = (|| {
        let c = Connection::open_with_flags(&src, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)?;
        c.busy_timeout(std::time::Duration::from_secs(5))?;
        let version = c.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        c.execute("VACUUM INTO ?1", [path_str(&partial)])?;
        anyhow::Ok(version)
    })()
    .with_context(|| format!("copying {source} into {}", path_str(&partial)))?;
    if version > super::VERSION {
        tracing::warn!("{source} is at database version {version}, newer than this build's {}: what's newer may not be migrated", super::VERSION);
    }
    {
        let c = super::open(&partial).with_context(|| format!("migrating the copy of {source}"))?;
        c.execute(
            "INSERT OR REPLACE INTO db_origin (id, source, source_version, source_state, copied_at) VALUES (1, ?1, ?2, ?3, ?4)",
            params![source, version, serde_json::to_string(&state)?, now()],
        )?;
        // So the file is complete without its log when it's renamed.
        let mode: String = c.query_row("PRAGMA journal_mode=DELETE", [], |r| r.get(0))?;
        ensure!(mode == "delete", "the copy of {source} stayed in {mode} mode");
    }
    std::fs::File::open(&partial)?.sync_all()?;
    Ok(partial)
}

/// Rename the finished copy `partial` to `path`, which isn't there, after removing any log or shared memory left
/// from an earlier file of that name.
fn install(partial: &Path, path: &Path) -> Result<()> {
    if path.exists() {
        bail!("{} is there already", path_str(path));
    }
    for s in ["-wal", "-shm", "-journal"] {
        remove(&suffixed(path, s))?;
    }
    std::fs::rename(partial, path).with_context(|| format!("renaming {} to {}", path_str(partial), path_str(path)))?;
    #[cfg(unix)]
    if let Some(dir) = path.parent() {
        std::fs::File::open(dir)?.sync_all()?;
    }
    Ok(())
}

/// Remove a database and its log, shared memory and journal, if they're there.
fn remove_db(path: &Path) -> Result<()> {
    for s in ["", "-wal", "-shm", "-journal"] {
        remove(&suffixed(path, s))?;
    }
    Ok(())
}

fn remove(path: &Path) -> Result<()> {
    match std::fs::remove_file(path) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e).with_context(|| format!("removing {}", path_str(path))),
        _ => Ok(()),
    }
}

fn suffixed(path: &Path, suffix: &str) -> PathBuf {
    let mut s = path.as_os_str().to_owned();
    s.push(suffix);
    PathBuf::from(s)
}

#[cfg(test)]
mod tests;
