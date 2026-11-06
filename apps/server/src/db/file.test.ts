// Port of server/src/db/file/tests.rs (HA-153, on ia/ha-128-implement-agent-threads-from-feasibility).
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { temp_dir } from "../testing.ts";
import { VERSION } from "./schema.ts";
import type { Conn } from "../db.ts";
import { copy, enabled, FILE, OLDER, older, open, RECOPY, remove_db, request_recopy, status } from "./file.ts";

/**
 * A database as an older build left it: in WAL mode, at version 0, with only a `marker` table saying `v`. Version 0 so
 * that opening the copy runs every migration, whatever the latest is.
 */
function old_db(path: string, v = "old") {
  const c = new DatabaseSync(path);
  c.exec("PRAGMA journal_mode=WAL");
  mark(c, v);
  c.close();
}

/** Write `v` in the marker table (made if it isn't there). */
function mark(c: Conn, v: string) {
  c.exec("CREATE TABLE IF NOT EXISTS marker (id INTEGER PRIMARY KEY CHECK (id = 1), v TEXT NOT NULL)");
  c.prepare("INSERT INTO marker (id, v) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET v=excluded.v").run(v);
}

/** Write `v` in the marker table of the file at `path`. */
function mark_file(path: string, v: string) {
  const c = new DatabaseSync(path);
  mark(c, v);
  c.close();
}

const marked = (c: Conn) => (c.prepare("SELECT v FROM marker WHERE id=1").get() as any)?.v ?? null;
const marked_file = (path: string) => {
  const c = new DatabaseSync(path, { readOnly: true });
  try {
    return marked(c);
  } finally {
    c.close();
  }
};
const version = (c: Conn) => Number((c.prepare("PRAGMA user_version").get() as any).user_version);

/**
 * The bytes of a database file and its log. An empty log is none: reading a database with none (read-only, as the copy
 * does) leaves an empty one, as any reader does.
 */
function bytes(path: string): [string, string | null] {
  let wal: string | null = null;
  try {
    wal = readFileSync(`${path}-wal`).toString("base64");
  } catch {}
  return [readFileSync(path).toString("base64"), wal || null];
}

/** A file's modification time, in nanoseconds. */
const mtime = (path: string) => statSync(path, { bigint: true }).mtimeNs;

test("the_first_start_copies_the_older_file_and_migrates_the_copy", () => {
  const dir = temp_dir();
  const old = join(dir, "huntaway.db");
  old_db(old);
  // An older build still has it open, with a write in its log that hasn't been checkpointed.
  const writer = new DatabaseSync(old);
  writer.exec("PRAGMA wal_autocheckpoint=0");
  mark(writer, "in the log");
  assert.ok(statSync(`${old}-wal`).size > 0);
  const before = bytes(old), before_mtime = mtime(old);

  const { conn: c, status: st } = open(dir, false);
  assert.equal(version(c), VERSION);
  assert.equal(marked(c), "in the log");
  // The board's tables are there, on the new file only.
  c.exec("SELECT * FROM tasks");
  const o = st.copied_from!;
  assert.deepEqual([o.source, o.source_version], ["huntaway.db", 0]);
  assert.equal(st.older_changed, null);
  assert.equal(st.file, FILE);
  assert.ok(existsSync(join(dir, FILE)) && !existsSync(join(dir, `${FILE}.partial`)));
  c.close();

  // The older file is as it was, byte for byte, and an older build still opens it at its own version.
  assert.deepEqual(bytes(old), before);
  assert.equal(mtime(old), before_mtime);
  assert.equal(version(writer), 0);
  assert.equal((writer.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('db_origin', 'tasks')").get() as any).n, 0);
  assert.equal(marked(writer), "in the log");
  writer.close();
});

test("a_later_start_uses_the_new_file", () => {
  const dir = temp_dir();
  old_db(join(dir, "huntaway.db"));
  let { conn: c, status: first } = open(dir, false);
  mark(c, "new");
  c.close();
  const before = bytes(join(dir, "huntaway.db"));
  const again = open(dir, false);
  assert.equal(marked(again.conn), "new");
  assert.deepEqual(again.status, first);
  assert.deepEqual(bytes(join(dir, "huntaway.db")), before);
  again.conn.close();
  // Asking to copy again when the older file hasn't changed keeps the new file's changes.
  const asked = open(dir, true);
  assert.equal(marked(asked.conn), "new");
  assert.deepEqual(asked.status, first);
  asked.conn.close();
});

test("a_copy_that_stopped_part_way_is_done_again", () => {
  const dir = temp_dir();
  old_db(join(dir, "huntaway.db"));
  // What a start that was killed while it copied leaves.
  const partial = join(dir, `${FILE}.partial`);
  writeFileSync(partial, "half a database");
  writeFileSync(`${partial}-journal`, "junk");
  // And the log of an earlier huntaway-2.db that was removed without it, which mustn't be applied to the copy.
  const path = join(dir, FILE);
  const c = new DatabaseSync(path);
  c.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0");
  mark(c, "a stale log");
  const wal = readFileSync(`${path}-wal`);
  // Closing would checkpoint it into the file: copy the log first, and put it back once the file has gone.
  c.close();
  remove_db(path);
  writeFileSync(`${path}-wal`, wal);

  const { conn, status: st } = open(dir, false);
  assert.equal(marked(conn), "old");
  assert.equal(st.copied_from!.source, "huntaway.db");
  assert.ok(!existsSync(partial) && !existsSync(`${partial}-journal`));
  conn.close();
});

test("a_crash_before_the_rename_leaves_the_older_file_in_use_and_copies_again", () => {
  const dir = temp_dir();
  old_db(join(dir, "huntaway.db"));
  // Copied and migrated, but not renamed yet.
  const partial = copy(dir, "huntaway.db");
  assert.ok(existsSync(partial) && !existsSync(join(dir, FILE)));
  // An older build would open huntaway.db still; this build copies it again.
  assert.equal(older(dir), "huntaway.db");
  const { conn } = open(dir, false);
  assert.equal(marked(conn), "old");
  assert.ok(!existsSync(partial));
  conn.close();
});

test("an_older_build_using_the_older_file_since_is_reported_and_copied_again_on_request", () => {
  const dir = temp_dir();
  const old = join(dir, "huntaway.db");
  old_db(old);
  const first = open(dir, false);
  mark(first.conn, "new");
  first.conn.close();
  // An older build runs on huntaway.db for a while.
  mark_file(old, "old, later");

  let { conn: c, status: st } = open(dir, false);
  assert.equal(st.older_changed, "huntaway.db");
  assert.deepEqual(st.copied_from, first.status.copied_from);
  // Nothing's copied without asking.
  assert.equal(marked(c), "new");
  c.close();

  request_recopy(dir);
  ({ conn: c, status: st } = open(dir, false));
  assert.equal(marked(c), "old, later");
  assert.equal(st.older_changed, null);
  assert.notDeepEqual(st.copied_from!.state, first.status.copied_from!.state);
  assert.ok(!existsSync(join(dir, RECOPY)));
  // What the new file had is set aside, whole.
  const replaced = join(dir, `${FILE}.replaced`);
  assert.ok(!existsSync(`${replaced}-wal`));
  assert.equal(marked_file(replaced), "new");
  mark(c, "new again");
  c.close();

  // And copied again with --recopy-db, after the older build has run again.
  mark_file(old, "old, later still");
  ({ conn: c, status: st } = open(dir, true));
  assert.deepEqual([marked(c), st.older_changed], ["old, later still", null]);
  assert.equal(marked_file(replaced), "new again");
  c.close();
});

test("a_data_dir_from_before_the_rename_is_copied_from_issue_agent_db", () => {
  const dir = temp_dir();
  const old = join(dir, "issue-agent.db");
  old_db(old);
  const before = bytes(old);
  const { conn, status: st } = open(dir, false);
  assert.equal(marked(conn), "old");
  assert.equal(st.copied_from!.source, "issue-agent.db");
  assert.deepEqual(bytes(old), before);
  // No huntaway.db, which an older build would open instead of issue-agent.db.
  assert.ok(!existsSync(join(dir, "huntaway.db")));
  assert.equal(older(dir), "issue-agent.db");
  conn.close();
});

test("huntaway_db_goes_before_issue_agent_db", () => {
  const dir = temp_dir();
  old_db(join(dir, "huntaway.db"));
  old_db(join(dir, "issue-agent.db"), "before the rename");
  const { conn, status: st } = open(dir, false);
  assert.deepEqual([marked(conn), st.copied_from!.source], ["old", "huntaway.db"]);
  conn.close();
});

test("a_fresh_data_dir_gets_only_the_new_file", () => {
  const dir = temp_dir();
  let { conn: c, status: st } = open(dir, false);
  assert.equal(version(c), VERSION);
  assert.deepEqual([st.copied_from, st.older_changed], [null, null]);
  c.close();
  assert.ok(OLDER.every((f) => !existsSync(join(dir, f))));
  // An older build that makes its own file there afterwards is noticed.
  old_db(join(dir, "huntaway.db"));
  ({ conn: c, status: st } = open(dir, false));
  assert.equal(st.older_changed, "huntaway.db");
  assert.deepEqual(status(dir, c), st);
  c.close();
});

/**
 * HA-153 review: copying again when asked, from an older file that can't be copied (not a database, or a full disk),
 * went wrong on every start after, since the request stayed. The board carries on with the file it has, and the request
 * goes.
 */
test("copying_again_that_fails_carries_on_with_the_new_file", () => {
  const dir = temp_dir();
  old_db(join(dir, "huntaway.db"));
  const first = open(dir, false);
  mark(first.conn, "new");
  first.conn.close();
  remove_db(join(dir, "huntaway.db"));
  writeFileSync(join(dir, "huntaway.db"), "not a database");
  for (const recopy of [false, true]) {
    if (!recopy) request_recopy(dir);
    const { conn, status: st } = open(dir, recopy);
    assert.equal(marked(conn), "new");
    // Still changed, so Settings → Server still offers it.
    assert.equal(st.older_changed, "huntaway.db");
    assert.ok(!existsSync(join(dir, RECOPY)) && !existsSync(join(dir, `${FILE}.partial`)));
    assert.ok(!existsSync(join(dir, `${FILE}.replaced`)));
    conn.close();
  }
});

// HA-222 turned it on.
test("the_new_file_is_on_unless_ia_new_db_file_turns_it_off", () => {
  assert.equal(enabled({}), true);
  assert.equal(enabled({ IA_NEW_DB_FILE: "" }), true);
  for (const off of ["0", "false", "no", "off"]) assert.equal(enabled({ IA_NEW_DB_FILE: off }), false, off);
  for (const on of ["1", "true", "yes"]) assert.equal(enabled({ IA_NEW_DB_FILE: on }), true, on);
});
