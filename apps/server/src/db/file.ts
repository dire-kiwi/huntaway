// Port of server/src/db/file.rs from the Rust attempt at agent threads (HA-153, on ia/ha-128-implement-agent-threads-from-feasibility):
// which file in a data dir the database is in.
//
// Builds that use `FILE` copy it from the file older builds use (`OLDER`) on their first start, and migrate the copy. The
// older file is only ever read (which leaves an empty `-wal` and a `-shm` beside it if it had none, as any reader does),
// so an older build started on the data dir again (Roll back) opens it as it was at the switch, at a version it knows.
// What was done in between is only in `FILE`.
//
// The copy records the older file's state then (`db_origin`, a table only `FILE` has). If an older build has used it
// since, the next start here says so, and copies it again only when asked (`--recopy-db`, or Copy again in Settings →
// Server, which `request_recopy`s), since that discards what was done in `FILE` since the first copy (it's kept in
// `FILE.replaced` until the next one).
//
// On since the release where an older build can no longer read what this one writes (HA-222: threads move onto items,
// and their messages stop being written, see threads/source.ts). `IA_NEW_DB_FILE=0` keeps a server on the older file,
// where its threads stay on their messages.
import { DatabaseSync } from "node:sqlite";
import { closeSync, existsSync, fsyncSync, openSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { check_room } from "../backup.ts";
import { now } from "../util.ts";
import type { Conn } from "../db.ts";
import { one, run, value } from "../db.ts";
import { open as open_db, VERSION } from "./schema.ts";

/**
 * This build's database file, when `enabled`. A build whose database older builds mustn't open takes the next number,
 * copying it from this one (which then goes first in its `OLDER`).
 */
export const FILE = "huntaway-2.db";
/**
 * The files older builds use, newest first: they open the first that's there (`huntaway.db`, or `issue-agent.db` from
 * before the rename to Huntaway), and make a `huntaway.db` if neither is.
 */
export const OLDER = ["huntaway.db", "issue-agent.db"];
/** Asks the next start to copy the older file again (see `request_recopy`). */
export const RECOPY = "recopy-db";

/** The environment variable that turns `FILE` on (`1`) or off (`0`), over `ON_BY_DEFAULT`. */
export const ENV = "IA_NEW_DB_FILE";
/** Whether a server uses `FILE` when `ENV` doesn't say: since HA-222, which moves threads onto items. */
export const ON_BY_DEFAULT = true;

/** Whether this server keeps the board in `FILE` (see `ENV`). */
export function enabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env[ENV]?.trim().toLowerCase();
  if (v === undefined || v === "") return ON_BY_DEFAULT;
  return !["0", "false", "no", "off"].includes(v);
}

/** A file's size and modification time, which change when SQLite writes to it. */
export interface Stamp {
  len: number;
  /** Nanoseconds, as a string: they're more than a double holds exactly. */
  modified_ns: string;
}

function stamp_of(path: string): Stamp {
  const m = statSync(path, { bigint: true });
  return { len: Number(m.size), modified_ns: String(m.mtimeNs) };
}

/**
 * The state of a database file and its write-ahead log, to tell whether anything has written to it since. An empty log
 * is the same as none: opening a database read-only makes one if there isn't one. The `-shm` file is left out, since
 * readers write to it.
 */
export interface FileState {
  db: Stamp;
  wal: Stamp | null;
}

export function file_state(path: string): FileState {
  let db: Stamp;
  try {
    db = stamp_of(path);
  } catch (e) {
    throw new Error(`reading ${path}`, { cause: e });
  }
  let wal: Stamp | null = null;
  try {
    wal = stamp_of(`${path}-wal`);
  } catch {}
  return { db, wal: wal && wal.len > 0 ? wal : null };
}

const same_state = (a: FileState, b: FileState) => JSON.stringify(a) === JSON.stringify(b);

/** Where `FILE` was copied from (`db_origin`). */
export interface Origin {
  /** The older file's name in the data dir. */
  source: string;
  /** Its `user_version` then. */
  source_version: number;
  copied_at: string;
  state: FileState;
}

/**
 * Which file the database is in, and whether the older one has changed since it was copied (`/admin/server`'s `database`,
 * API 108).
 */
export interface Status {
  /** `FILE`. */
  file: string;
  copied_from: Origin | null;
  /**
   * The file an older build would open now, if it's had changes since the copy (or since `FILE` was made, when it wasn't
   * copied): an older build has used the data dir since, and its changes aren't in `FILE`.
   */
  older_changed: string | null;
}

/** `Status` as the API has it: without the older file's state, which is only for telling whether it changed. */
export function status_json(st: Status) {
  const o = st.copied_from;
  return { file: st.file, copied_from: o && { source: o.source, source_version: o.source_version, copied_at: o.copied_at }, older_changed: st.older_changed };
}

/**
 * The older file's state at the copy, in `FILE` only: its name in the data dir, its `user_version`, and its `FileState` as
 * JSON. One row at most, replaced when it's copied again. It isn't a migration, so the board's schema (and the older
 * file's) is the same whichever file a build uses.
 */
const ORIGIN_TABLE = `CREATE TABLE IF NOT EXISTS db_origin (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  source TEXT NOT NULL,
  source_version INTEGER NOT NULL,
  source_state TEXT NOT NULL,
  copied_at TEXT NOT NULL
);`;

export function origin(c: Conn): Origin | null {
  if (!value(c, "SELECT 1 FROM sqlite_master WHERE type='table' AND name='db_origin'")) return null;
  const row = one<any>(c, "SELECT source, source_version, source_state, copied_at FROM db_origin WHERE id=1");
  if (!row) return null;
  let state: FileState;
  try {
    state = JSON.parse(row.source_state);
  } catch (e) {
    throw new Error(`db_origin's source_state ${JSON.stringify(row.source_state)}`, { cause: e });
  }
  return { source: row.source, source_version: Number(row.source_version), copied_at: row.copied_at, state };
}

const is_file = (p: string) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/** The file an older build would open in `data_dir`, if there's one. */
export function older(data_dir: string): string | null {
  return OLDER.find((f) => is_file(join(data_dir, f))) ?? null;
}

/** `Status` for the database `c` in `data_dir`. */
export function status(data_dir: string, c: Conn): Status {
  const copied_from = origin(c);
  const o = older(data_dir);
  let changed = o !== null;
  if (o !== null && copied_from && copied_from.source === o) {
    try {
      changed = !same_state(file_state(join(data_dir, o)), copied_from.state);
    } catch {
      changed = true;
    }
  }
  return { file: FILE, copied_from, older_changed: changed ? o : null };
}

/** `status` for the server's database `c`, when it's `FILE` in `data_dir` (null when it's another file, or in memory). */
export function current(data_dir: string, c: Conn): Status | null {
  const at = c.location();
  if (!at || basename(at) !== FILE || resolve(dirname(at)) !== resolve(data_dir)) return null;
  return status(data_dir, c);
}

/** Ask the next start to copy the older file into `FILE` again (if it's still changed then). */
export function request_recopy(data_dir: string) {
  try {
    writeFileSync(join(data_dir, RECOPY), now());
  } catch (e) {
    throw new Error("asking for the database to be copied again", { cause: e });
  }
}

/**
 * Open the database in `data_dir` (`FILE`) and migrate it. On the first start, it's copied from the file an older build
 * uses, if there's one; when an older build has used that since, it's copied again if `recopy` (or `request_recopy`)
 * asks, and otherwise this warns.
 */
export function open(data_dir: string, recopy: boolean): { conn: Conn; status: Status } {
  const path = join(data_dir, FILE);
  const marker = join(data_dir, RECOPY);
  recopy ||= existsSync(marker);
  if (existsSync(path)) {
    const conn = open_db(path);
    const st = status(data_dir, conn);
    const changed = st.older_changed;
    if (changed === null) {
      if (recopy) {
        const o = older(data_dir);
        console.error(`not copying the database again: ${o ? `${o} hasn't changed since it was copied into ${FILE}` : `there's no older database to copy into ${FILE}`}`);
        remove(marker);
      }
      return { conn, status: st };
    }
    if (!recopy) {
      const since = st.copied_from ? `it was copied into ${FILE} at ${st.copied_from.copied_at}` : `${FILE} was made`;
      console.warn(
        `${changed} has changed since ${since}: an older build of Huntaway has used this data dir since, and what it did isn't in ${FILE}, ` +
          `which this build uses. To start from ${changed} again, discarding what's been done in ${FILE} since, restart with --recopy-db ` +
          `(or use Copy again in Settings → Server)`,
      );
      return { conn, status: st };
    }
    // Asked once: a copy that fails isn't tried again on every start, and the board carries on with FILE as it is.
    remove(marker);
    let partial: string;
    try {
      partial = copy(data_dir, changed);
    } catch (e) {
      console.error(`couldn't copy ${changed} into ${FILE} again, so this build carries on with ${FILE} as it was:`, e);
      remove_db(join(data_dir, `${FILE}.partial`));
      return { conn, status: st };
    }
    // Set the current file aside in one piece: without its log, which would be applied to the new file.
    const mode = value<string>(conn, "PRAGMA journal_mode=DELETE");
    if (mode !== "delete") throw new Error(`couldn't take ${FILE} out of WAL mode to set it aside (it's ${mode})`);
    conn.close();
    const replaced = join(data_dir, `${FILE}.replaced`);
    remove_db(replaced);
    try {
      renameSync(path, replaced);
    } catch (e) {
      throw new Error(`setting ${FILE} aside`, { cause: e });
    }
    install(partial, path);
    console.warn(`copied ${changed} into ${FILE} again; what ${FILE} had before is in ${replaced}, until the next copy`);
  } else {
    const o = older(data_dir);
    if (o !== null) {
      const started = Date.now();
      console.error(`copying ${o} into ${FILE}, which this build uses (an older build keeps using ${o} as it is now)`);
      install(copy(data_dir, o), path);
      console.error(`copied ${o} into ${FILE} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    }
  }
  remove(marker);
  const conn = open_db(path);
  return { conn, status: status(data_dir, conn) };
}

/** About how big a copy of the database at `path` is: its file and its log (VACUUM INTO leaves out the free pages). */
function size_of(path: string): number {
  let n = 0;
  for (const f of [path, `${path}-wal`]) {
    try {
      n += statSync(f).size;
    } catch {}
  }
  return n;
}

/**
 * Copy the older file `source` in `data_dir` into `FILE.partial`, a consistent copy with what's in its log, and migrate
 * it, recording where it came from. `source` is only read. Throws without trying when the disk hasn't room for it.
 */
export function copy(data_dir: string, source: string): string {
  const src = join(data_dir, source);
  const partial = join(data_dir, `${FILE}.partial`);
  // Left by a start that stopped before it was done.
  remove_db(partial);
  // Before reading, so a write while it's copied shows as a change.
  const state = file_state(src);
  let version: number;
  try {
    check_room(data_dir, size_of(src));
    const c = new DatabaseSync(src, { readOnly: true });
    try {
      c.exec("PRAGMA busy_timeout=5000");
      version = Number(value(c, "PRAGMA user_version"));
      c.prepare("VACUUM INTO ?").run(partial);
    } finally {
      c.close();
    }
  } catch (e) {
    remove_db(partial);
    throw new Error(`copying ${source} into ${partial}`, { cause: e });
  }
  if (version > VERSION) console.warn(`${source} is at database version ${version}, newer than this build's ${VERSION}: what's newer may not be migrated`);
  let c: Conn;
  try {
    c = open_db(partial);
  } catch (e) {
    throw new Error(`migrating the copy of ${source}`, { cause: e });
  }
  try {
    c.exec(ORIGIN_TABLE);
    run(c, "INSERT OR REPLACE INTO db_origin (id, source, source_version, source_state, copied_at) VALUES (1, ?1, ?2, ?3, ?4)", source, version, JSON.stringify(state), now());
    // So the file is complete without its log when it's renamed.
    const mode = value<string>(c, "PRAGMA journal_mode=DELETE");
    if (mode !== "delete") throw new Error(`the copy of ${source} stayed in ${mode} mode`);
  } finally {
    c.close();
  }
  sync(partial);
  return partial;
}

/**
 * Rename the finished copy `partial` to `path`, which isn't there, after removing any log or shared memory left from an
 * earlier file of that name.
 */
function install(partial: string, path: string) {
  if (existsSync(path)) throw new Error(`${path} is there already`);
  for (const s of ["-wal", "-shm", "-journal"]) remove(path + s);
  try {
    renameSync(partial, path);
  } catch (e) {
    throw new Error(`renaming ${partial} to ${path}`, { cause: e });
  }
  sync(dirname(path));
}

/** fsync a file or folder. */
function sync(path: string) {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Remove a database and its log, shared memory and journal, if they're there. */
export function remove_db(path: string) {
  for (const s of ["", "-wal", "-shm", "-journal"]) remove(path + s);
}

function remove(path: string) {
  try {
    rmSync(path, { force: true });
  } catch (e) {
    throw new Error(`removing ${path}`, { cause: e });
  }
}
