import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import * as backup from "./backup.ts";
import { temp_dir } from "./testing.ts";

/** A database in WAL mode at schema `schema` with rows in it that are still only in the WAL, as a running server leaves it. */
function board(dir: string, rows: number, schema = 87): [string, DatabaseSync] {
  const path = join(dir, "huntaway.db");
  const c = new DatabaseSync(path);
  c.exec(`PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS tasks (id INTEGER PRIMARY KEY, title TEXT); PRAGMA user_version=${schema}`);
  for (let i = 0; i < rows; i++) c.prepare("INSERT INTO tasks (title) VALUES (?)").run(`task ${i}`);
  return [path, c];
}

/** `board`, closed. */
function closed_board(dir: string, rows: number, schema = 87): string {
  const [path, c] = board(dir, rows, schema);
  c.close();
  return path;
}

const count = (path: string) => {
  const c = new DatabaseSync(path, { readOnly: true });
  try {
    return (c.prepare("SELECT COUNT(*) AS n FROM tasks").get() as any).n;
  } finally {
    c.close();
  }
};

const names = (dir: string) => readdirSync(backup.backup_dir(dir)).sort();

/** Run `f` with environment variable `k` set to `v`. */
async function with_env<T>(k: string, v: string, f: () => T | Promise<T>): Promise<T> {
  process.env[k] = v;
  try {
    return await f();
  } finally {
    delete process.env[k];
  }
}

/** Run `f` with the disk's free space reported as `free`. */
async function with_free<T>(free: number, f: () => T | Promise<T>): Promise<T> {
  const was = backup.disk.free;
  backup.disk.free = () => free;
  try {
    return await f();
  } finally {
    backup.disk.free = was;
  }
}

test("a_new_version_backs_up_the_database_before_it_opens_it", () => {
  const dir = temp_dir();
  const path = closed_board(dir, 3, 86);
  // A data dir the Rust server ran on records no version.
  const made = backup.on_start(dir, path, "0.4.0", 87);
  assert.ok(made && made.includes("huntaway-before-to-0.4.0-"), String(made));
  assert.equal(count(made!), 3);
  backup.record_version(dir, "0.4.0");
  // The same version again: no backup.
  assert.equal(backup.on_start(dir, path, "0.4.0", 87), null);
  // The next one, which migrates the database: a backup named after both.
  const next = backup.on_start(dir, path, "0.5.0", 88);
  assert.ok(next && next.includes("huntaway-0.4.0-to-0.5.0-"), String(next));
  assert.equal(names(dir).length, 2);
});

test("a_fresh_data_dir_has_nothing_to_back_up", () => {
  const dir = temp_dir();
  assert.equal(backup.on_start(dir, join(dir, "huntaway.db"), "0.4.0", 87), null);
  assert.ok(!existsSync(backup.backup_dir(dir)));
});

/** HA-184: a backup only when opening the database may change it. */
test("a_new_version_that_doesnt_migrate_the_database_doesnt_back_it_up", () => {
  const dir = temp_dir();
  const path = closed_board(dir, 1, 87);
  backup.record_version(dir, "0.4.0");
  assert.equal(backup.on_start(dir, path, "0.4.1", 87), null);
  assert.ok(!existsSync(backup.backup_dir(dir)));
  // A newer server migrated it (a roll back onto this one): backed up.
  const down = backup.on_start(dir, path, "0.4.1", 86);
  assert.ok(down && down.includes("huntaway-0.4.0-to-0.4.1-"), String(down));
  // From the Rust server, or from a version it doesn't know: backed up whatever the schema.
  backup.record_version(dir, "0.3.1");
  assert.ok(backup.on_start(dir, path, "0.4.1", 87)?.includes("huntaway-0.3.1-to-0.4.1-"));
  backup.record_version(dir, "unknown");
  assert.ok(backup.on_start(dir, path, "0.4.1", 87)?.includes("huntaway-unknown-to-0.4.1-"));
});

test("a_switch_to_a_rust_release_backs_up_what_the_running_server_has_open_including_its_wal", async () => {
  const dir = temp_dir();
  const [, c] = board(dir, 5);
  backup.record_version(dir, "0.4.1");
  const made = await backup.before_switch(dir, c, "0.4.1", "0.3.1");
  assert.ok(made && made.includes("huntaway-0.4.1-to-0.3.1-"), String(made));
  assert.equal(count(made!), 5);
  c.close();
});

/** HA-184: TS v → Roll back → Rust → Update → TS v backs up, though the Rust server doesn't record its version. */
test("a_server_that_starts_after_a_rust_release_backs_up_even_at_its_own_version", async () => {
  const dir = temp_dir();
  const [path, c] = board(dir, 2);
  backup.record_version(dir, "0.4.1");
  await backup.before_switch(dir, c, "0.4.1", "0.3.1");
  c.close();
  assert.equal(backup.last_version(dir), "0.3.1");
  // The Rust release runs (and records nothing), then an Update starts 0.4.1 again, at the same schema.
  const made = backup.on_start(dir, path, "0.4.1", 87);
  assert.ok(made && made.includes("huntaway-0.3.1-to-0.4.1-"), String(made));
  backup.record_version(dir, "0.4.1");
  assert.equal(backup.on_start(dir, path, "0.4.1", 87), null);
});

test("a_roll_back_to_the_apps_own_server_of_unknown_version_backs_up_too", async () => {
  const dir = temp_dir();
  const [path, c] = board(dir, 1);
  backup.record_version(dir, "0.4.1");
  const made = await backup.before_switch(dir, c, "0.4.1", null);
  assert.ok(made && made.includes("huntaway-0.4.1-to-unknown-"), String(made));
  c.close();
  assert.ok(backup.on_start(dir, path, "0.4.1", 87)?.includes("huntaway-unknown-to-0.4.1-"));
});

/** 0.4.0 backed up before rolling back to a Rust release, but didn't record it: the backup's name says so. */
test("a_roll_back_that_0_4_0_made_to_a_rust_release_is_seen_from_its_backup", () => {
  const dir = temp_dir();
  const path = closed_board(dir, 1);
  backup.record_version(dir, "0.4.0");
  const was = Date.now() / 1000 - 60;
  utimesSync(join(dir, backup.VERSION_FILE), was, was);
  mkdirSync(backup.backup_dir(dir));
  writeFileSync(join(backup.backup_dir(dir), "huntaway-0.4.0-to-0.3.1-2026-11-05T01-00-00Z.db"), "");
  assert.equal(backup.last_server(dir), "0.3.1");
  assert.ok(backup.on_start(dir, path, "0.4.0", 87)?.includes("huntaway-0.3.1-to-0.4.0-"));
  // One from before the version was recorded doesn't count.
  backup.record_version(dir, "0.4.1");
  assert.equal(backup.last_server(dir), "0.4.1");
});

test("a_switch_to_a_typescript_release_leaves_the_backup_to_it_but_checks_theres_room", async () => {
  const dir = temp_dir();
  const [, c] = board(dir, 1);
  backup.record_version(dir, "0.4.1");
  assert.equal(await backup.before_switch(dir, c, "0.4.1", "0.5.0"), null);
  assert.deepEqual(names(dir), []);
  // It's still for the next one to decide.
  assert.equal(backup.last_version(dir), "0.4.1");
  await with_free(backup.HEADROOM, async () => {
    await assert.rejects(backup.before_switch(dir, c, "0.4.1", "0.5.0"), (e: any) => {
      assert.ok(e instanceof backup.BackupFailed);
      assert.equal(e.reason, "space");
      assert.match(e.message, /^couldn't back up the database before switching to 0\.5\.0, so it didn't go ahead: there isn't room for it: 100 MB is free/);
      assert.ok(e.message.includes("IA_SKIP_DB_BACKUP=1"), e.message);
      return true;
    });
  });
  c.close();
});

test("a_backup_isnt_started_without_room_for_it", async () => {
  const dir = temp_dir();
  const path = closed_board(dir, 1, 86);
  await with_free(backup.HEADROOM + 1000, () => {
    assert.throws(
      () => backup.on_start(dir, path, "0.4.1", 87),
      (e: any) => e instanceof backup.BackupFailed && e.reason === "space" && /starting 0\.4\.1.*there isn't room for it/.test(e.message),
    );
  });
  assert.deepEqual(names(dir), []);
  await with_free(backup.HEADROOM + 10_000_000, () => assert.ok(backup.on_start(dir, path, "0.4.1", 87)));
});

test("only_the_newest_backups_and_the_newest_from_before_a_major_change_are_kept", () => {
  const dir = temp_dir();
  const path = closed_board(dir, 1);
  const bdir = backup.backup_dir(dir);
  const labels = ["0.2.9-to-0.3.0", "0.3.1-to-0.4.0", "before-to-0.4.0", "0.4.0-to-0.4.1", "0.4.1-to-0.4.2", "0.4.2-to-0.4.3", "0.4.3-to-0.4.4"];
  labels.forEach((label, i) => {
    const p = backup.backup(dir, path, label);
    // Each older than the next.
    const t = Date.now() / 1000 - 100 + i;
    utimesSync(p, t, t);
  });
  writeFileSync(join(bdir, "huntaway-cut-short.db.partial"), "");
  backup.prune(bdir);
  // The two newest, and the newest from the Rust server.
  assert.deepEqual(
    names(dir).map((f) => f.replace(/-\d{4}-.*$/, "")),
    ["huntaway-0.4.2-to-0.4.3", "huntaway-0.4.3-to-0.4.4", "huntaway-before-to-0.4.0"],
  );
  assert.ok(backup.major_change("0.4.4", "0.5.0") && backup.major_change("0.9.1", "1.0.0") && backup.major_change("0.4.1", "0.3.1"));
  assert.ok(!backup.major_change("0.4.0", "0.4.1") && !backup.major_change("1.2.0", "1.3.0"));
});

test("backups_are_gzipped_keeping_their_time", async () => {
  const dir = temp_dir();
  const path = closed_board(dir, 4, 86);
  const made = backup.on_start(dir, path, "0.4.1", 87)!;
  const t = Date.now() / 1000 - 3600;
  utimesSync(made, t, t);
  const done = await backup.compress_later(dir);
  assert.deepEqual(done, [`${made}.gz`]);
  assert.deepEqual(names(dir), [`${made.split("/").at(-1)}.gz`]);
  assert.equal(Math.round(statSync(`${made}.gz`).mtimeMs / 1000), Math.round(t));
  // It's the database, as gunzip gives it back.
  const restored = join(dir, "restored.db");
  writeFileSync(restored, gunzipSync(readFileSync(`${made}.gz`)));
  assert.equal(count(restored), 4);
  // Compressed ones count for what's kept, and aren't compressed again.
  assert.deepEqual(await backup.compress_later(dir), []);
  assert.equal(backup.list(backup.backup_dir(dir))[0].gz, true);
});

test("a_server_that_cant_back_up_the_database_doesnt_start_unless_told_to", async () => {
  const dir = temp_dir();
  const path = join(dir, "huntaway.db");
  writeFileSync(path, "not a database");
  assert.throws(
    () => backup.on_start(dir, path, "0.4.0", 87),
    (e: any) =>
      e instanceof backup.BackupFailed &&
      e.reason === "other" &&
      e.message.startsWith("couldn't back up the database before starting 0.4.0, so it didn't go ahead: ") &&
      e.message.includes("IA_SKIP_DB_BACKUP=1"),
  );
  // Nothing half made is left behind.
  assert.deepEqual(names(dir), []);
  assert.equal(await with_env("IA_SKIP_DB_BACKUP", "1", () => backup.on_start(dir, path, "0.4.0", 87)), null);
  // The desktop app's "Start without a backup".
  assert.equal(await with_env("IA_SKIP_DB_BACKUP_ONCE", "1", () => backup.on_start(dir, path, "0.4.0", 87)), null);
  assert.throws(() => backup.on_start(dir, path, "0.4.0", 87));
});

// Not as root, which may write anywhere.
test("a_backup_that_isnt_allowed_says_so", { skip: process.getuid?.() === 0 }, () => {
  const dir = temp_dir();
  const path = closed_board(dir, 1, 86);
  mkdirSync(backup.backup_dir(dir));
  chmodSync(backup.backup_dir(dir), 0o500);
  try {
    assert.throws(
      () => backup.on_start(dir, path, "0.4.1", 87),
      (e: any) => e instanceof backup.BackupFailed && e.reason === "permissions" && e.why.startsWith(`Huntaway isn't allowed to write to ${backup.backup_dir(dir)}`),
    );
  } finally {
    chmodSync(backup.backup_dir(dir), 0o700);
  }
});

test("a_full_disk_is_told_apart", () => {
  const err = Object.assign(new Error("database or disk is full"), { code: "ERR_SQLITE_ERROR", errcode: 13 });
  const [reason, why] = backup.explain(new Error("backing up x", { cause: err }), "/data/backups");
  assert.equal(reason, "space");
  assert.ok(why.startsWith("the disk with /data/backups is full"), why);
  // From a worker thread, only the message is left.
  assert.equal(backup.explain(new Error("backing up x", { cause: new Error("ENOSPC: no space left on device, write") }), "/d")[0], "space");
});

test("a_rollback_to_a_rust_release_that_cant_back_up_the_database_throws", async () => {
  const dir = temp_dir();
  const [, c] = board(dir, 1);
  backup.record_version(dir, "0.4.1");
  writeFileSync(backup.backup_dir(dir), "");
  try {
    await assert.rejects(backup.before_switch(dir, c, "0.4.1", "0.3.1"), /before switching to 0.3.1, so it didn't go ahead/);
    // Nothing changed.
    assert.equal(backup.last_version(dir), "0.4.1");
    // Told to go ahead without one, it still records that a Rust release is next.
    assert.equal(await with_env("IA_SKIP_DB_BACKUP", "1", () => backup.before_switch(dir, c, "0.4.1", "0.3.1")), null);
    assert.equal(backup.last_version(dir), "0.3.1");
  } finally {
    c.close();
  }
});
