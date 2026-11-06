// Backups of the board's database around updates, so a release can be rolled back with its data (new in the
// TypeScript server; the Rust server has no counterpart). A backup is a consistent copy made with `VACUUM INTO`, in
// `<data dir>/backups/`, named after the versions it's between, and gzipped once the server is up. One is made
//
// - when a server starts on a data dir that a different version last ran on (`server_version`), before it opens the
//   database and migrates it, unless that version was this server's too (0.4.0 or later) and the database's schema is
//   already this server's (so opening it changes nothing that the version before can't read): that covers updating onto
//   this release, whichever server did it;
// - before this server restarts onto a release that won't make one itself (Roll back to a Rust release, 0.3.x or
//   earlier, or to a server whose version isn't known). It then records that version in `server_version`, as the Rust
//   server doesn't write it, so that whichever TypeScript server starts after it backs the database up again (HA-184).
//
// Without a backup, neither goes ahead: a server that can't make one doesn't start (an update onto it isn't settled, so
// it's marked bad and the version before it starts again, see update/staging.ts), and a Roll back that can't make one
// fails, with the running server left as it is. An Update or Roll back onto a TypeScript release checks that the disk
// has room for the backup that one will make, for the same reason. `IA_SKIP_DB_BACKUP=1` goes ahead without one, and
// `IA_SKIP_DB_BACKUP_ONCE=1` (the desktop app's "Start without a backup") does that for this start only.
//
// Copies take a lot of room (the live board's database is 835 MB), so they're gzipped (about a quarter of that) and few
// are kept: the newest KEEP, and the newest from before a major change (another major version, or minor before 1.0, or
// from the Rust server), which is the one to go back with if the rest of that release line is no good.
//
// To go back to one: stop the server, move `huntaway.db` (and any `huntaway.db-wal` and `huntaway.db-shm` beside it)
// aside, and `gunzip -c` the backup to `huntaway.db` (or copy it there, if it isn't gzipped yet). A server on the new
// database file (db/file.ts) backs up `huntaway-2.db`, so its backups go back there. On its first start there's none to
// back up: making it only reads the older file, which stays as it was.
import { DatabaseSync } from "node:sqlite";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  statfsSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { join } from "node:path";
import type { Conn } from "./db.ts";
import { in_worker } from "./worker.ts";

/** How many of the newest backups are kept, besides the newest from before a major change. */
export const KEEP = 2;

/** What a backup has to leave free on its disk, so that the board can carry on writing. */
export const HEADROOM = 100_000_000;

/** The first release that runs the TypeScript server, which backs the database up when it starts. */
export const FIRST_TS: [number, number, number] = [0, 4, 0];

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

/**
 * The server that last ran on `data_dir`, as far as can be told: `last_version`, unless a backup made since it was
 * recorded was for a switch to a server that doesn't record its version (a Rust release). Then it's that one. (0.4.0
 * backed up the database before a Roll back to a Rust release, but didn't record it, HA-184.)
 */
export function last_server(data_dir: string): string | null {
  const last = last_version(data_dir);
  let since: number;
  try {
    since = statSync(join(data_dir, VERSION_FILE)).mtimeMs;
  } catch {
    return last;
  }
  const newest = list(backup_dir(data_dir))[0];
  return newest && !is_ts(newest.to) && newest.t >= since ? newest.to : last;
}

/** Record that `version` runs on `data_dir`, once its database is open (or that it's about to, see `before_switch`). */
export function record_version(data_dir: string, version: string) {
  try {
    if (last_version(data_dir) !== version) writeFileSync(join(data_dir, VERSION_FILE), `${version}\n`);
  } catch (e) {
    console.error(`recording the server's version in ${data_dir}:`, e);
  }
}

/** `v` (`1.2.3`, `v1.2.3-rc.1`) as [major, minor, patch], or null when it isn't a version ("before", "bundled"). */
function version_parts(v: string | null): [number, number, number] | null {
  const m = v === null ? null : /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Whether `v` is a release of the TypeScript server (0.4.0 or later), which backs the database up itself when it starts. */
export function is_ts(v: string | null): boolean {
  const p = version_parts(v);
  if (p === null) return false;
  for (let i = 0; i < 3; i++) if (p[i] !== FIRST_TS[i]) return p[i] > FIRST_TS[i];
  return true;
}

/** Whether going from `from` to `to` is a major change: from the Rust server (or an unknown version) to this one, or to another major version (minor, before 1.0). */
export function major_change(from: string | null, to: string | null): boolean {
  const [a, b] = [version_parts(from), version_parts(to)];
  if (a === null || b === null || is_ts(from) !== is_ts(to)) return true;
  return a[0] !== b[0] || (a[0] === 0 && a[1] !== b[1]);
}

/** The database's schema version (`PRAGMA user_version`), or null when it can't be read. */
export function schema_version(db_path: string): number | null {
  let c: DatabaseSync | undefined;
  try {
    c = new DatabaseSync(db_path, { readOnly: true });
    return Number((c.prepare("PRAGMA user_version").get() as any).user_version);
  } catch {
    return null;
  } finally {
    c?.close();
  }
}

const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, "_");

/** A UTC time for a file name: 2026-11-05T01-02-03Z. */
const stamp = (d = new Date()) =>
  d
    .toISOString()
    .replace(/\.\d+Z$/, "Z")
    .replaceAll(":", "-");

/** A backup's name: `huntaway-<from>-to-<to>-<time>.db`, then `.db.gz` once it's compressed. */
const NAME = /^huntaway-(.+)-to-(.+)-(\d{4}-\d\d-\d\dT\d\d-\d\d-\d\dZ)\.db(\.gz)?$/;

/** The free space on the disk that `dir` is on. Replaceable, for tests. */
export const disk = {
  free(dir: string): number {
    const st = statfsSync(dir);
    return st.bavail * st.bsize;
  },
};

/** A backup that wasn't tried, as the disk hasn't room for it. */
export class NoRoom extends Error {
  constructor(dir: string, free: number, needed: number) {
    super(`there isn't room for it: ${mb(free)} is free on the disk with ${dir}, and the copy needs about ${mb(needed)}, with ${mb(HEADROOM)} to spare`);
  }
}

const mb = (n: number) => (n >= 10e9 ? `${(n / 1e9).toFixed(0)} GB` : n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.ceil(n / 1e6)} MB`);

/** About how big a copy of the database at `db_path` is: its file and its WAL (VACUUM INTO leaves out the free pages). */
function size_of(db_path: string): number {
  let n = 0;
  for (const f of [db_path, `${db_path}-wal`]) {
    try {
      n += statSync(f).size;
    } catch {}
  }
  return n;
}

/** Throws NoRoom when `dir`'s disk can't take a copy of `needed` bytes and keep HEADROOM free. */
export function check_room(dir: string, needed: number) {
  let free: number;
  try {
    free = disk.free(dir);
  } catch {
    return; // can't tell: the copy will say
  }
  if (free < needed + HEADROOM) throw new NoRoom(dir, free, needed);
}

/**
 * Copy the database to `<data dir>/backups/huntaway-<label>-<time>.db` with `VACUUM INTO`, through `conn` (one this
 * process has open) or a connection of its own to `db_path`, then drop the backups no longer kept (see `prune`). Returns
 * the backup's path. Throws NoRoom without trying when the disk hasn't room for it.
 */
export function backup(data_dir: string, db_path: string, label: string, conn?: Conn): string {
  const dir = backup_dir(data_dir);
  mkdirSync(dir, { recursive: true });
  // The file's size is known only for one on disk: a connection's in-memory database (tests') is small anyway.
  if (!conn) check_room(dir, size_of(db_path));
  const path = join(dir, `huntaway-${safe(label)}-${stamp()}.db`);
  // Written beside it first, so a backup that's cut short (a full disk) doesn't look like a good one.
  const partial = `${path}.partial`;
  rmSync(partial, { force: true });
  const c = conn ?? new DatabaseSync(db_path);
  try {
    // A connection of its own to a running server's database waits for a write that's being committed, rather than
    // failing as busy.
    if (!conn) c.exec("PRAGMA busy_timeout=10000");
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

interface Backup {
  /** The file's name in the backups folder. */
  f: string;
  from: string;
  to: string;
  t: number;
  gz: boolean;
}

/** The backups in `dir`, newest first, each once (a `.db` that's being compressed has a `.db.gz` beside it for a moment). */
export function list(dir: string): Backup[] {
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return [];
  }
  const out = new Map<string, Backup>();
  for (const f of files) {
    const m = NAME.exec(f);
    if (!m) continue;
    let t: number;
    try {
      t = statSync(join(dir, f)).mtimeMs;
    } catch {
      continue;
    }
    const key = f.replace(/\.gz$/, "");
    const seen = out.get(key);
    // The uncompressed one counts until the compressed one has replaced it; either way, its time is the backup's.
    if (!seen || seen.gz) out.set(key, { f, from: m[1], to: m[2], t: seen ? Math.max(seen.t, t) : t, gz: !!m[4] });
  }
  return [...out.values()].sort((a, b) => b.t - a.t || b.f.localeCompare(a.f));
}

/** Which of `backups` (newest first) to keep: the newest KEEP, and the newest from before a major change. */
export function kept(backups: Backup[]): Backup[] {
  const keep = backups.slice(0, KEEP);
  const major = backups.find((b) => major_change(b.from === "before" ? null : b.from, b.to));
  if (major && !keep.includes(major)) keep.push(major);
  return keep;
}

/** Drop the backups `kept` doesn't keep (and any partial ones, unless `partials` is false: one is being written). */
export function prune(dir: string, partials = true) {
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return;
  }
  if (partials) for (const f of files.filter((f) => f.endsWith(".partial"))) rmSync(join(dir, f), { force: true });
  const all = list(dir);
  const keep = new Set(kept(all).map((b) => b.f.replace(/\.gz$/, "")));
  for (const b of all) {
    const base = b.f.replace(/\.gz$/, "");
    if (keep.has(base)) continue;
    rmSync(join(dir, base), { force: true });
    rmSync(join(dir, `${base}.gz`), { force: true });
  }
}

/**
 * Gzip the backups in `<data dir>/backups` that aren't yet, one at a time (each `X.db` to `X.db.gz`, written beside it
 * first), and drop the backups no longer kept. zlib compresses on libuv's thread pool, so the server's thread only passes
 * the data along. Returns the files it compressed. A backup that can't be compressed (a full disk) is left as it is.
 */
export async function compress_all(data_dir: string): Promise<string[]> {
  const dir = backup_dir(data_dir);
  const done: string[] = [];
  for (const b of list(dir)) {
    if (b.gz) continue;
    const src = join(dir, b.f);
    const out = `${src}.gz`;
    const partial = `${out}.partial`;
    try {
      const { mtime } = statSync(src);
      await pipeline(createReadStream(src, { highWaterMark: 1 << 20 }), createGzip(), createWriteStream(partial));
      renameSync(partial, out);
      // Its time is the backup's, which `prune` and `last_server` go by.
      utimesSync(out, mtime, mtime);
      rmSync(src, { force: true });
      done.push(out);
    } catch (e) {
      rmSync(partial, { force: true });
      console.error(`couldn't compress the database backup ${src} (it's kept as it is):`, e);
    }
  }
  prune(dir, false);
  return done;
}

/** `IA_SKIP_DB_BACKUP=1`: go ahead without a backup when one can't be made. */
export const SKIP_ENV = "IA_SKIP_DB_BACKUP";
/** `IA_SKIP_DB_BACKUP_ONCE=1`: the same, for this start only (the desktop app's "Start without a backup"). */
export const SKIP_ONCE_ENV = "IA_SKIP_DB_BACKUP_ONCE";

const is_set = (name: string) => !["", "0", "false", "no", "off"].includes((process.env[name] ?? "").trim().toLowerCase());

/** Why a backup failed, for people: what to do about it depends on it. */
export type Reason = "space" | "permissions" | "other";

/** A backup that couldn't be made, which stopped what needed it. `why` is what went wrong, without the advice. */
export class BackupFailed extends Error {
  reason: Reason;
  why: string;
  dir: string;
  constructor(message: string, reason: Reason, why: string, dir: string) {
    super(message);
    this.reason = reason;
    this.why = why;
    this.dir = dir;
  }
}

/** What made `e` (a backup's failure) happen, as a Reason and a sentence. */
export function explain(e: unknown, dir: string): [Reason, string] {
  if (e instanceof NoRoom) return ["space", e.message];
  // Errors from a worker thread come back with their message and cause, but not their class or code.
  const causes: any[] = [];
  for (let c: any = e; c && causes.length < 5; c = c.cause) causes.push(c);
  const codes = causes.map((c) => String(c?.code ?? ""));
  const errcodes = causes.map((c) => Number(c?.errcode) & 0xff);
  const text = causes.map((c) => String(c?.message ?? c)).join(": ");
  // SQLite's FULL (13), its I/O errors from a full disk, and the file system's.
  if (
    codes.includes("ENOSPC") ||
    codes.includes("EDQUOT") ||
    errcodes.includes(13) ||
    /disk is full|no space left|quota exceeded|there isn't room for it/i.test(text)
  ) {
    let free = "";
    try {
      free = ` (${mb(disk.free(dir))} free)`;
    } catch {}
    return ["space", `the disk with ${dir} is full${free}`];
  }
  // The file system's, and SQLite's READONLY (8) and CANTOPEN (14), which it gives when it can't create the file.
  if (
    ["EACCES", "EPERM", "EROFS"].some((c) => codes.includes(c)) ||
    errcodes.includes(8) ||
    errcodes.includes(14) ||
    /permission denied|read-only file system/i.test(text)
  ) {
    return ["permissions", `Huntaway isn't allowed to write to ${dir} (${causes.at(-1)?.message ?? text})`];
  }
  return ["other", text];
}

/** `e` as the error that stops what needed the backup, unless IA_SKIP_DB_BACKUP says to go ahead (null). */
function failed(e: unknown, what: string, data_dir: string): BackupFailed | null {
  const dir = backup_dir(data_dir);
  const [reason, why] = explain(e, dir);
  const skip = [SKIP_ENV, SKIP_ONCE_ENV].find(is_set);
  if (skip) {
    console.error(`couldn't back up the database before ${what} (${why}); going ahead without one, as ${skip} says`);
    return null;
  }
  const advice =
    reason === "space"
      ? `Free some space on that disk (the backups in ${dir} can go)`
      : reason === "permissions"
        ? `Let Huntaway write to ${dir}`
        : `Check that Huntaway can write to ${dir}`;
  return new BackupFailed(
    `couldn't back up the database before ${what}, so it didn't go ahead: ${why}. ${advice}, or set ${SKIP_ENV}=1 to go ahead without a backup`,
    reason,
    why,
    dir,
  );
}

/**
 * At startup, before the database is opened: back it up if another version last ran on this data dir and opening it may
 * change it (see the top of this file). `schema` is this server's schema version. Returns the backup's path, or null
 * when none was needed (a new data dir, the same version, or the same schema). Throws a BackupFailed when it can't make
 * one.
 */
export function on_start(data_dir: string, db_path: string, version: string, schema: number): string | null {
  if (!existsSync(db_path)) return null;
  const last = last_server(data_dir);
  if (last === version) return null;
  if (is_ts(last) && is_ts(version) && schema_version(db_path) === schema) {
    console.error(`${last} last ran on this data dir, and its database is already at this server's schema (${schema}), so it isn't backed up`);
    return null;
  }
  try {
    const path = backup(data_dir, db_path, `${last ?? "before"}-to-${version}`);
    console.error(`backed up the database from before ${version} to ${path}`);
    return path;
  } catch (e) {
    const err = failed(e, `starting ${version}`, data_dir);
    if (err) throw err;
    return null;
  }
}

/** Backups (and compressing them) one at a time: a backup's prune would delete the file being compressed. */
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(f: () => Promise<T>): Promise<T> {
  const next = queue.then(f, f);
  queue = next.catch(() => {});
  return next;
}

/** Compress the backups in the background, once the server is up (see `compress_all`). */
export function compress_later(data_dir: string): Promise<string[]> {
  return serial(() => compress_all(data_dir));
}

/**
 * Before restarting onto another release, `to` (null when its version isn't known): when it's a TypeScript release, it
 * backs the database up itself when it starts, if it needs to, so this only checks that the disk has room for that. When
 * it isn't (a Rust release, or unknown), this backs up the database this server has open, and records `to` in
 * `server_version` (or `unknown`): the server after it sees that it wasn't the last to run. Throws a BackupFailed when it
 * can't make one (see the top of this file), before anything has changed. Returns the backup's path, if it made one.
 *
 * The copy is made in a worker thread, with a connection of its own (which sees what `conn` has committed, its WAL
 * included), as it takes a while on a big board (HA-183: 0.7 s for 880 MB on a fast disk) and would hold up every other
 * request, websocket and agent's output meanwhile. An in-memory database (tests') is copied through `conn`.
 *
 * If the restart fails, the caller records this server's version again (`record_version`).
 */
export async function before_switch(data_dir: string, conn: Conn, from: string, to: string | null): Promise<string | null> {
  const target = to ?? "unknown";
  const file = conn.location();
  try {
    if (is_ts(to)) {
      if (file) {
        mkdirSync(backup_dir(data_dir), { recursive: true });
        check_room(backup_dir(data_dir), size_of(file));
      }
      return null;
    }
    const label = `${from}-to-${target}`;
    if (file) {
      mkdirSync(backup_dir(data_dir), { recursive: true });
      check_room(backup_dir(data_dir), size_of(file));
    }
    const path = await serial(async () =>
      file ? await in_worker<string>(new URL(import.meta.url), "backup", [data_dir, file, label]) : backup(data_dir, "the database", label, conn),
    );
    console.error(`backed up the database before switching to ${target}: ${path}`);
    record_version(data_dir, target);
    return path;
  } catch (e) {
    const err = failed(e, `switching to ${target}`, data_dir);
    if (err) throw err;
    // Going ahead without one: the server after this one still needs to know it wasn't the last.
    if (!is_ts(to)) record_version(data_dir, target);
    return null;
  }
}
