// Backups of the board's database around updates, so a release can be rolled back with its data (new in the
// TypeScript server; the Rust server has no counterpart). A backup is a consistent copy made with `VACUUM INTO`, in
// `<data dir>/backups/`, named after the versions it's between: one is made
//
// - when a server starts on a data dir that a different version (or the Rust server, which doesn't record it) last ran
//   on, before it opens the database and migrates it: that covers updating onto this release, whichever server did it;
// - before this server restarts onto another release (Update or Roll back), as the server it starts may not make one.
//
// The newest KEEP are kept. To go back to one: stop the server, move `huntaway.db` (and any `huntaway.db-wal` and
// `huntaway.db-shm` beside it) aside, and copy the backup to `huntaway.db`.
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Conn } from "./db.ts";

/** How many backups are kept. */
export const KEEP = 5;

/** The file that records the version of the server that last opened this data dir's database. */
export const VERSION_FILE = "server_version";

export function backup_dir(data_dir: string): string {
  return join(data_dir, "backups");
}

/** The version that last ran on `data_dir` (null: none recorded, as on a data dir the Rust server ran on). */
export function last_version(data_dir: string): string | null {
  try {
    return readFileSync(join(data_dir, VERSION_FILE), "utf8").trim() || null;
  } catch {
    return null;
  }
}

/** Record that `version` runs on `data_dir`, once its database is open. */
export function record_version(data_dir: string, version: string) {
  try {
    if (last_version(data_dir) !== version) writeFileSync(join(data_dir, VERSION_FILE), `${version}\n`);
  } catch (e) {
    console.error(`recording the server's version in ${data_dir}:`, e);
  }
}

const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, "_");

/** A UTC time for a file name: 2026-11-05T01-02-03Z. */
const stamp = (d = new Date()) => d.toISOString().replace(/\.\d+Z$/, "Z").replaceAll(":", "-");

/**
 * Copy the database to `<data dir>/backups/huntaway-<label>-<time>.db` with `VACUUM INTO`, through `conn` (one this
 * process has open) or a connection of its own to `db_path`, then drop all but the newest KEEP. Returns the backup's path.
 */
export function backup(data_dir: string, db_path: string, label: string, conn?: Conn): string {
  const dir = backup_dir(data_dir);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `huntaway-${safe(label)}-${stamp()}.db`);
  // Written beside it first, so a backup that's cut short (a full disk) doesn't look like a good one.
  const partial = `${path}.partial`;
  rmSync(partial, { force: true });
  const c = conn ?? new DatabaseSync(db_path);
  try {
    c.prepare("VACUUM INTO ?").run(partial);
  } catch (e) {
    rmSync(partial, { force: true });
    throw new Error(`backing up ${db_path}`, { cause: e });
  } finally {
    if (!conn) c.close();
  }
  renameSync(partial, path);
  prune(dir);
  return path;
}

/** Drop all but the newest KEEP backups (and any partial ones). */
export function prune(dir: string) {
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return;
  }
  for (const f of files.filter((f) => f.endsWith(".partial"))) rmSync(join(dir, f), { force: true });
  const backups = files
    .filter((f) => f.startsWith("huntaway-") && f.endsWith(".db"))
    .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t || b.f.localeCompare(a.f));
  for (const { f } of backups.slice(KEEP)) rmSync(join(dir, f), { force: true });
}

/**
 * At startup, before the database is opened: back it up if another version last ran on this data dir. Returns the
 * backup's path, or null when none was needed (a new data dir, or the same version). A failed backup is logged, and the
 * server starts all the same.
 */
export function on_start(data_dir: string, db_path: string, version: string): string | null {
  if (!existsSync(db_path)) return null;
  const last = last_version(data_dir);
  if (last === version) return null;
  try {
    const path = backup(data_dir, db_path, `${last ?? "before"}-to-${version}`);
    console.error(`backed up the database from before ${version} to ${path}`);
    return path;
  } catch (e) {
    console.error(`couldn't back up the database before starting ${version}:`, e);
    return null;
  }
}

/** Before restarting onto another release (`to`): back up the database this server has open. */
export function before_switch(data_dir: string, conn: Conn, from: string, to: string): string | null {
  try {
    const path = backup(data_dir, "the database", `${from}-to-${to}`, conn);
    console.error(`backed up the database before switching to ${to}: ${path}`);
    return path;
  } catch (e) {
    console.error(`couldn't back up the database before switching to ${to}:`, e);
    return null;
  }
}
