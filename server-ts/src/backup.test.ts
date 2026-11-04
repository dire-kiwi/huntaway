import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { existsSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as backup from "./backup.ts";
import { temp_dir } from "./testing.ts";

/** A database in WAL mode with a row in it that's still only in the WAL, as a running server leaves it. */
function board(dir: string, rows: number): [string, DatabaseSync] {
  const path = join(dir, "huntaway.db");
  const c = new DatabaseSync(path);
  c.exec("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS tasks (id INTEGER PRIMARY KEY, title TEXT)");
  for (let i = 0; i < rows; i++) c.prepare("INSERT INTO tasks (title) VALUES (?)").run(`task ${i}`);
  return [path, c];
}

const count = (path: string) => {
  const c = new DatabaseSync(path, { readOnly: true });
  try {
    return (c.prepare("SELECT COUNT(*) AS n FROM tasks").get() as any).n;
  } finally {
    c.close();
  }
};

test("a_new_version_backs_up_the_database_before_it_opens_it", () => {
  const dir = temp_dir();
  const [path, c] = board(dir, 3);
  c.close();
  // A data dir the Rust server ran on records no version.
  const made = backup.on_start(dir, path, "0.3.0");
  assert.ok(made && made.includes("huntaway-before-to-0.3.0-"), String(made));
  assert.equal(count(made!), 3);
  backup.record_version(dir, "0.3.0");
  // The same version again: no backup.
  assert.equal(backup.on_start(dir, path, "0.3.0"), null);
  // The next one: a backup named after both.
  const next = backup.on_start(dir, path, "0.4.0");
  assert.ok(next && next.includes("huntaway-0.3.0-to-0.4.0-"), String(next));
  assert.equal(readdirSync(backup.backup_dir(dir)).length, 2);
});

test("a_fresh_data_dir_has_nothing_to_back_up", () => {
  const dir = temp_dir();
  assert.equal(backup.on_start(dir, join(dir, "huntaway.db"), "0.3.0"), null);
  assert.ok(!existsSync(backup.backup_dir(dir)));
});

test("a_switch_backs_up_what_the_running_server_has_open_including_its_wal", () => {
  const dir = temp_dir();
  const [, c] = board(dir, 5);
  const made = backup.before_switch(dir, c, "0.3.0", "0.2.1");
  assert.ok(made && made.includes("huntaway-0.3.0-to-0.2.1-"), String(made));
  assert.equal(count(made!), 5);
  c.close();
});

test("only_the_newest_backups_are_kept", () => {
  const dir = temp_dir();
  const [path, c] = board(dir, 1);
  c.close();
  const bdir = backup.backup_dir(dir);
  for (let i = 0; i < backup.KEEP + 2; i++) {
    const p = backup.backup(dir, path, `v${i}`);
    // Each older than the next.
    const t = Date.now() / 1000 - 100 + i;
    utimesSync(p, t, t);
  }
  writeFileSync(join(bdir, "huntaway-cut-short.db.partial"), "");
  backup.prune(bdir);
  const left = readdirSync(bdir).sort();
  assert.equal(left.length, backup.KEEP, left.join(" "));
  assert.ok(!left.some((f) => f.startsWith("huntaway-v0-") || f.startsWith("huntaway-v1-") || f.endsWith(".partial")), left.join(" "));
});

test("a_failed_backup_leaves_no_file_and_the_server_starts", () => {
  const dir = temp_dir();
  const path = join(dir, "huntaway.db");
  writeFileSync(path, "not a database");
  assert.equal(backup.on_start(dir, path, "0.3.0"), null);
  assert.deepEqual(readdirSync(backup.backup_dir(dir)), []);
});
