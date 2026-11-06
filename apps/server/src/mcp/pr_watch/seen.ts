// Port of server/src/mcp/pr_watch/seen.rs: what the agent has been told about each pull request, its task's
// `pr_watches` rows.
import { one, run, type Conn } from "../../db.ts";
import { now } from "../../util.ts";

/** What the agent has been told about a pull request. */
export interface Seen {
  /** The head commit whose checks it was told about. */
  head: string | null;
  /** That commit's failed checks it was told of (see `Check.key`). */
  failed: string[];
  /** Whether it was told that commit's checks passed. */
  passed: boolean;
  /** The comments and reviews it has seen (ids), the latest last. */
  remarks: string[];
  /** Whether it was told the pull request conflicts with its base (and it still does). */
  conflicting: boolean;
}

export function Seen_default(): Seen {
  return { head: null, failed: [], passed: false, remarks: [], conflicting: false };
}

export function Seen_clone(s: Seen): Seen {
  return { head: s.head, failed: [...s.failed], passed: s.passed, remarks: [...s.remarks], conflicting: s.conflicting };
}

function Seen_from_json(v: any): Seen {
  if (!v || typeof v !== "object") throw new Error("not a Seen");
  const strs = (x: any): string[] => {
    if (x == null) return [];
    if (!Array.isArray(x) || x.some((s) => typeof s !== "string")) throw new Error("not a list of strings");
    return x;
  };
  const bool = (x: any) => {
    if (x == null) return false;
    if (typeof x !== "boolean") throw new Error("not a bool");
    return x;
  };
  if (v.head != null && typeof v.head !== "string") throw new Error("not a string");
  return { head: v.head ?? null, failed: strs(v.failed), passed: bool(v.passed), remarks: strs(v.remarks), conflicting: bool(v.conflicting) };
}

/** What a call found and hasn't returned yet: what the agent will have been told once it has. */
export interface Pending {
  call_id: string;
  told: Seen;
  /**
   * Whether the failures in an in-review wake's news were sent by hand (see `told_failures`) before the wake was: it
   * isn't sent then, and the next read works out what's still news. Left out when false.
   */
  superseded?: boolean;
}

/** A `pr_watches` row. */
export interface Row {
  seen: Seen;
  pending?: Pending;
  /** What the last read found (see `summary`), and when. */
  last: any;
  polled_at: string;
  /**
   * How many times in a row news of comments alone woke the agent while its task was in review (see
   * `watch_in_review`), when it last woke it, and whether comments stopped waking it after `COMMENT_WAKES` of those.
   */
  comment_wakes: number;
  woke_at?: string;
  comments_paused: boolean;
}

export function Row_default(): Row {
  return { seen: Seen_default(), last: null, polled_at: "", comment_wakes: 0, comments_paused: false };
}

function Row_from_json(v: any): Row {
  if (!v || typeof v !== "object") throw new Error("not a Row");
  const r: Row = {
    seen: v.seen == null ? Seen_default() : Seen_from_json(v.seen),
    last: v.last ?? null,
    polled_at: typeof v.polled_at === "string" ? v.polled_at : "",
    comment_wakes: typeof v.comment_wakes === "number" ? v.comment_wakes : 0,
    comments_paused: v.comments_paused === true,
  };
  if (v.pending != null) {
    if (typeof v.pending.call_id !== "string") throw new Error("not a Pending");
    const p: Pending = { call_id: v.pending.call_id, told: Seen_from_json(v.pending.told) };
    if (v.pending.superseded === true) p.superseded = true;
    r.pending = p;
  }
  if (typeof v.woke_at === "string") r.woke_at = v.woke_at;
  return r;
}

/** As serde writes a Row: `pending` and `woke_at` only when set, `superseded` only when true. */
function Row_to_json(r: Row): string {
  const o: any = { seen: r.seen };
  if (r.pending) {
    o.pending = { call_id: r.pending.call_id, told: r.pending.told };
    if (r.pending.superseded) o.pending.superseded = true;
  }
  o.last = r.last ?? null;
  o.polled_at = r.polled_at;
  o.comment_wakes = r.comment_wakes;
  if (r.woke_at != null) o.woke_at = r.woke_at;
  o.comments_paused = r.comments_paused;
  return JSON.stringify(o);
}

/** The row for `task_id`'s pull request `key`, if there's one (and it can be read). */
export function load(c: Conn, task_id: string, key: string): Row | null {
  const r = one<{ state: string }>(c, "SELECT state FROM pr_watches WHERE task_id=?1 AND pr=?2", task_id, key);
  if (!r) return null;
  try {
    return Row_from_json(JSON.parse(r.state));
  } catch {
    return null;
  }
}

export function store(c: Conn, task_id: string, key: string, row: Row): void {
  run(
    c,
    `INSERT INTO pr_watches (task_id, pr, state, updated_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(task_id, pr) DO UPDATE SET state=?3, updated_at=?4`,
    task_id,
    key,
    Row_to_json(row),
    now(),
  );
}
