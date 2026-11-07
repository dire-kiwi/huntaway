// Pens (HA-285): a profile's named sets of tasks, from any of its projects (and its tasks in no project), which the
// profile's board shows as tabs. A task is in one pen at most (`tasks.pen_id`); a pen can be hidden from the tabs and
// shown again, and the tabs are in the pens' order. The profile's pens thread (see agent/pens.ts) and any agent with the
// board tools can arrange them, as the user can on the board.
import { all, one, run, tx, value, type Conn } from "../db.ts";
import { new_id, now } from "../util.ts";

/** The table (migration 106), and tasks' `pen_id`. */
export const PENS_SCHEMA = `
CREATE TABLE IF NOT EXISTS pens (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  position REAL NOT NULL,
  hidden INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS pens_name ON pens(profile_id, name COLLATE NOCASE);
`;

/** How long a pen's name can be. */
export const PEN_NAME_MAX = 60;

export interface Pen {
  id: string;
  profile_id: string;
  name: string;
  /** Where its tab goes among the profile's pens' (lowest first). */
  position: number;
  /** Left out of the board's tabs (its tasks stay in it). */
  hidden: boolean;
  created_at: string;
  updated_at: string;
}

function pen_from(r: any): Pen {
  return {
    id: r.id,
    profile_id: r.profile_id,
    name: r.name,
    position: r.position,
    hidden: !!r.hidden,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

/** A profile's pens, in their tabs' order. */
export function list_pens(c: Conn, profile_id: string): Pen[] {
  return all(c, "SELECT * FROM pens WHERE profile_id=?1 ORDER BY position, created_at", profile_id).map(pen_from);
}

export function get_pen(c: Conn, id: string): Pen | null {
  const r = one(c, "SELECT * FROM pens WHERE id=?1", id);
  return r ? pen_from(r) : null;
}

/** A profile's pen by its name (in any case). */
export function pen_by_name(c: Conn, profile_id: string, name: string): Pen | null {
  const r = one(c, "SELECT * FROM pens WHERE profile_id=?1 AND name=?2 COLLATE NOCASE", profile_id, name.trim());
  return r ? pen_from(r) : null;
}

/** A pen's name as it's kept: trimmed, not blank, not too long. Throws an Error saying what's wrong. */
export function check_pen_name(name: unknown): string {
  const n = typeof name === "string" ? name.trim().replace(/\s+/g, " ") : "";
  if (!n) throw new Error("a pen's name must be a non-empty string");
  if (n.length > PEN_NAME_MAX) throw new Error(`a pen's name can be ${PEN_NAME_MAX} characters at most`);
  return n;
}

/** Adds a pen at the end of the profile's tabs. Throws if the profile has a pen by that name. */
export function insert_pen(c: Conn, profile_id: string, name: string, hidden = false): Pen {
  const n = check_pen_name(name);
  return tx(c, () => {
    if (pen_by_name(c, profile_id, n)) throw new Error(`there's a pen named ${n} already`);
    const position = Number(value(c, "SELECT COALESCE(MAX(position), 0) + 1 FROM pens WHERE profile_id=?1", profile_id) ?? 1);
    const id = new_id();
    const at = now();
    run(
      c,
      "INSERT INTO pens (id, profile_id, name, position, hidden, created_at, updated_at) VALUES (?1,?2,?3,?4,?5,?6,?6)",
      id,
      profile_id,
      n,
      position,
      hidden ? 1 : 0,
      at,
    );
    return get_pen(c, id)!;
  });
}

/** The profile's pen by that name, made (at the end of its tabs) if it has none. */
export function pen_named(c: Conn, profile_id: string, name: string): Pen {
  return pen_by_name(c, profile_id, check_pen_name(name)) ?? insert_pen(c, profile_id, name);
}

/**
 * Changes a pen's name, whether it's hidden, or where its tab goes: `index` moves it to that place among the profile's
 * pens (0 is the first; past the end is the last), renumbering them. Throws if another pen has the new name.
 */
export function update_pen(c: Conn, id: string, ch: { name?: string; hidden?: boolean; index?: number }): Pen | null {
  return tx(c, () => {
    const p = get_pen(c, id);
    if (!p) return null;
    if (ch.name !== undefined) {
      const n = check_pen_name(ch.name);
      const other = pen_by_name(c, p.profile_id, n);
      if (other && other.id !== id) throw new Error(`there's a pen named ${n} already`);
      run(c, "UPDATE pens SET name=?2 WHERE id=?1", id, n);
    }
    if (ch.hidden !== undefined) run(c, "UPDATE pens SET hidden=?2 WHERE id=?1", id, ch.hidden ? 1 : 0);
    if (ch.index !== undefined) {
      const others = list_pens(c, p.profile_id).filter((x) => x.id !== id);
      const at = Math.max(0, Math.min(others.length, Math.trunc(ch.index)));
      others.splice(at, 0, p);
      others.forEach((x, i) => run(c, "UPDATE pens SET position=?2 WHERE id=?1", x.id, i + 1));
    }
    run(c, "UPDATE pens SET updated_at=?2 WHERE id=?1", id, now());
    return get_pen(c, id);
  });
}

/** Deletes a pen; its tasks are in no pen after. The ids of those tasks. */
export function delete_pen(c: Conn, id: string): string[] {
  return tx(c, () => {
    const ids = all(c, "UPDATE tasks SET pen_id=NULL WHERE pen_id=?1 RETURNING id", id).map((r) => r.id as string);
    run(c, "DELETE FROM pens WHERE id=?1", id);
    return ids;
  });
}

/** How many tasks (not review threads) each of a profile's pens has, by pen id. */
export function pen_counts(c: Conn, profile_id: string): Map<string, number> {
  const rows = all(
    c,
    "SELECT t.pen_id AS id, COUNT(*) AS n FROM tasks t JOIN pens p ON p.id=t.pen_id WHERE p.profile_id=?1 AND t.kind='task' GROUP BY t.pen_id",
    profile_id,
  );
  return new Map(rows.map((r) => [r.id as string, Number(r.n)]));
}
