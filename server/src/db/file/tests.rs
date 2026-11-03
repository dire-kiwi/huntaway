use super::*;
use crate::db::{get_setting, set_setting};

/// A database as a build before this one left it, at version 85 (no `db_origin`), with setting `from` = `old`.
fn old_db(path: &Path) {
    let c = crate::db::open(path).unwrap();
    c.execute_batch("DROP TABLE db_origin; PRAGMA user_version=85;").unwrap();
    set_setting(&c, "from", Some("old")).unwrap();
}

fn version(c: &Connection) -> i64 {
    c.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap()
}

/// The bytes of a database file and its log. An empty log is none: reading a database with none (read-only, as the
/// copy does) leaves an empty one, as any reader does.
fn bytes(path: &Path) -> (Vec<u8>, Option<Vec<u8>>) {
    (std::fs::read(path).unwrap(), std::fs::read(suffixed(path, "-wal")).ok().filter(|w| !w.is_empty()))
}

fn setting(c: &Connection, key: &str) -> Option<String> {
    get_setting(c, key).unwrap()
}

#[test]
fn the_first_start_copies_the_older_file_and_migrates_the_copy() {
    let dir = crate::testing::temp_dir();
    let old = dir.join("huntaway.db");
    old_db(&old);
    // An older build still has it open, with a write in its log that hasn't been checkpointed.
    let writer = Connection::open(&old).unwrap();
    writer.execute_batch("PRAGMA wal_autocheckpoint=0;").unwrap();
    set_setting(&writer, "in_wal", Some("yes")).unwrap();
    assert!(std::fs::metadata(suffixed(&old, "-wal")).unwrap().len() > 0);
    let before = bytes(&old);

    let (c, st) = open(&dir, false).unwrap();
    assert_eq!(version(&c), crate::db::VERSION);
    assert_eq!((setting(&c, "from").as_deref(), setting(&c, "in_wal").as_deref()), (Some("old"), Some("yes")));
    // The agent-threads tables are there, on the new file only.
    c.execute_batch("SELECT * FROM at_threads").unwrap();
    let o = st.copied_from.clone().unwrap();
    assert_eq!((o.source.as_str(), o.source_version), ("huntaway.db", 85));
    assert_eq!(st.older_changed, None);
    assert_eq!(st.file, FILE);
    assert!(dir.join(FILE).is_file() && !dir.join(format!("{FILE}.partial")).exists());

    // The older file is as it was, and an older build still opens it at its own version.
    assert_eq!(bytes(&old), before);
    assert_eq!(version(&writer), 85);
    assert_eq!(writer.query_row("SELECT COUNT(*) FROM sqlite_master WHERE name='db_origin'", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
    assert_eq!(setting(&writer, "in_wal").as_deref(), Some("yes"));
    drop(writer);
}

#[test]
fn a_later_start_uses_the_new_file() {
    let dir = crate::testing::temp_dir();
    old_db(&dir.join("huntaway.db"));
    let (c, first) = open(&dir, false).unwrap();
    set_setting(&c, "from", Some("new")).unwrap();
    drop(c);
    let before = bytes(&dir.join("huntaway.db"));
    let (c, again) = open(&dir, false).unwrap();
    assert_eq!(setting(&c, "from").as_deref(), Some("new"));
    assert_eq!(again, first);
    assert_eq!(bytes(&dir.join("huntaway.db")), before);
    // Asking to copy again when the older file hasn't changed keeps the new file's changes.
    drop(c);
    let (c, st) = open(&dir, true).unwrap();
    assert_eq!((setting(&c, "from").as_deref(), st), (Some("new"), first));
}

#[test]
fn a_copy_that_stopped_part_way_is_done_again() {
    let dir = crate::testing::temp_dir();
    old_db(&dir.join("huntaway.db"));
    // What a start that was killed while it copied leaves.
    let partial = dir.join(format!("{FILE}.partial"));
    std::fs::write(&partial, "half a database").unwrap();
    std::fs::write(suffixed(&partial, "-journal"), "junk").unwrap();
    // And the log of an earlier huntaway-2.db that was removed without it, which mustn't be applied to the copy.
    let wal = {
        let c = crate::db::open(&dir.join(FILE)).unwrap();
        c.execute_batch("PRAGMA wal_autocheckpoint=0;").unwrap();
        set_setting(&c, "from", Some("a stale log")).unwrap();
        std::fs::read(suffixed(&dir.join(FILE), "-wal")).unwrap()
    };
    remove_db(&dir.join(FILE)).unwrap();
    std::fs::write(suffixed(&dir.join(FILE), "-wal"), wal).unwrap();
    let (c, st) = open(&dir, false).unwrap();
    assert_eq!(setting(&c, "from").as_deref(), Some("old"));
    assert_eq!(st.copied_from.unwrap().source, "huntaway.db");
    assert!(!partial.exists() && !suffixed(&partial, "-journal").exists());
}

#[test]
fn a_crash_before_the_rename_leaves_the_older_file_in_use_and_copies_again() {
    let dir = crate::testing::temp_dir();
    old_db(&dir.join("huntaway.db"));
    // Copied and migrated, but not renamed yet.
    let partial = copy(&dir, "huntaway.db").unwrap();
    assert!(partial.is_file() && !dir.join(FILE).exists());
    // An older build would open huntaway.db still; this build copies it again.
    assert_eq!(older(&dir), Some("huntaway.db"));
    let (c, _) = open(&dir, false).unwrap();
    assert_eq!(setting(&c, "from").as_deref(), Some("old"));
    assert!(!partial.exists());
}

#[test]
fn an_older_build_using_the_older_file_since_is_reported_and_copied_again_on_request() {
    let dir = crate::testing::temp_dir();
    let old = dir.join("huntaway.db");
    old_db(&old);
    let (c, first) = open(&dir, false).unwrap();
    set_setting(&c, "from", Some("new")).unwrap();
    drop(c);
    // An older build runs on huntaway.db for a while.
    set_setting(&Connection::open(&old).unwrap(), "from", Some("old, later")).unwrap();

    let (c, st) = open(&dir, false).unwrap();
    assert_eq!(st.older_changed.as_deref(), Some("huntaway.db"));
    assert_eq!(st.copied_from, first.copied_from);
    // Nothing's copied without asking.
    assert_eq!(setting(&c, "from").as_deref(), Some("new"));
    drop(c);

    request_recopy(&dir).unwrap();
    let (c, st) = open(&dir, false).unwrap();
    assert_eq!(setting(&c, "from").as_deref(), Some("old, later"));
    assert_eq!(st.older_changed, None);
    assert_ne!(st.copied_from.as_ref().unwrap().state, first.copied_from.as_ref().unwrap().state);
    assert!(!dir.join(RECOPY).exists());
    // What the new file had is set aside, whole.
    let replaced = dir.join(format!("{FILE}.replaced"));
    assert!(!suffixed(&replaced, "-wal").exists());
    assert_eq!(setting(&Connection::open(&replaced).unwrap(), "from").as_deref(), Some("new"));
    set_setting(&c, "from", Some("new again")).unwrap();
    drop(c);

    // And copied again with --recopy-db, after the older build has run again.
    set_setting(&Connection::open(&old).unwrap(), "from", Some("old, later still")).unwrap();
    let (c, st) = open(&dir, true).unwrap();
    assert_eq!((setting(&c, "from").as_deref(), st.older_changed), (Some("old, later still"), None));
    assert_eq!(setting(&Connection::open(&replaced).unwrap(), "from").as_deref(), Some("new again"));
}

#[test]
fn a_data_dir_from_before_the_rename_is_copied_from_issue_agent_db() {
    let dir = crate::testing::temp_dir();
    let old = dir.join("issue-agent.db");
    old_db(&old);
    drop(Connection::open(&old).unwrap());
    let before = bytes(&old);
    let (c, st) = open(&dir, false).unwrap();
    assert_eq!(setting(&c, "from").as_deref(), Some("old"));
    assert_eq!(st.copied_from.unwrap().source, "issue-agent.db");
    assert_eq!(bytes(&old), before);
    // No huntaway.db, which an older build would open instead of issue-agent.db.
    assert!(!dir.join("huntaway.db").exists());
    assert_eq!(older(&dir), Some("issue-agent.db"));
}

#[test]
fn huntaway_db_goes_before_issue_agent_db() {
    let dir = crate::testing::temp_dir();
    old_db(&dir.join("huntaway.db"));
    let c = crate::db::open(&dir.join("issue-agent.db")).unwrap();
    set_setting(&c, "from", Some("before the rename")).unwrap();
    drop(c);
    let (c, st) = open(&dir, false).unwrap();
    assert_eq!((setting(&c, "from").as_deref(), st.copied_from.unwrap().source.as_str()), (Some("old"), "huntaway.db"));
}

#[test]
fn a_fresh_data_dir_gets_only_the_new_file() {
    let dir = crate::testing::temp_dir();
    let (c, st) = open(&dir, false).unwrap();
    assert_eq!(version(&c), crate::db::VERSION);
    assert_eq!((st.copied_from, st.older_changed), (None, None));
    drop(c);
    assert!(OLDER.iter().all(|f| !dir.join(f).exists()));
    // An older build that makes its own file there afterwards is noticed.
    old_db(&dir.join("huntaway.db"));
    let (_, st) = open(&dir, false).unwrap();
    assert_eq!(st.older_changed.as_deref(), Some("huntaway.db"));
}
