// Port of server/src/review/stats.rs.
/**
 * What reviewers reported, kept for statistics (`GET /profiles/{id}/token-stats`, see analytics.rs): a row in
 * `review_stats` for each `submit_review`, for the task reviewed, with how many serious and minor issues it listed, and
 * the effort the work reviewed was done at, so issues can be told by model and effort (see `work_effort`). A task's
 * `review` only has its latest round.
 *
 * Each row has its review's `round`: when the round started (Review.started_at), which every reviewer's submission in
 * it shares, so a round's outcome is its reviewers' together. A reviewer that submits twice in a run is kept once, with
 * what it submitted last.
 *
 * Reviews from before this was kept are read from their threads, where each `submit_review` call is (see `backfill`).
 * They didn't list minor issues: only whether their summary mentions any. Their rounds are worked out from their
 * reviewers' runs: a round's reviewers start together, so runs started within `ROUND_GAP` of each other are one
 * round's, but for two runs of one reviewer.
 */
import * as db from "../db.ts";
import type { Conn } from "../db.ts";
import { err_str, now } from "../util.ts";

/** Reviewer runs of a task started within this many seconds of the one before are one round's. */
const ROUND_GAP = 120;

/** What one `submit_review` reported. */
export interface Submission {
  task_id: string;
  thread_id: string;
  /** When its round started. */
  round: string | null;
  run_id: string | null;
  /** pass or issues */
  verdict: string;
  serious: number;
  /** Null for reviews from before minor issues were listed. */
  minor: number | null;
  summary: string | null;
  /** Which agent reviewed, e.g. "Codex · gpt-5.1". */
  label: string | null;
}

export function record(c: Conn, s: Submission, at: string): void {
  const noted = (s.minor != null && s.minor > 0) || (s.summary != null && mentions_minor(s.summary));
  // What the run submitted before: this replaces it.
  if (s.run_id != null) db.run(c, "DELETE FROM review_stats WHERE thread_id=?1 AND run_id=?2", s.thread_id, s.run_id);
  const effort = work_effort(c, s.task_id, at);
  db.run(
    c,
    "INSERT INTO review_stats (task_id, thread_id, round, run_id, at, verdict, serious, minor, minor_noted, label, effort) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
    s.task_id,
    s.thread_id,
    s.round ?? at,
    s.run_id,
    at,
    s.verdict,
    s.serious,
    s.minor,
    noted,
    s.label ? s.label : null,
    effort,
  );
}

/**
 * The effort the work reviewed was done at: that of the task's latest run before `at`, as its agent was given it (see
 * runner/launch.rs), so a later change of the task's effort or the host's default doesn't move it. A task with no such
 * run (from before runs kept it) has the effort it's set to now.
 */
export function work_effort(c: Conn, task_id: string, at: string): string | null {
  // A database being migrated from before version 83 has no such column yet.
  const kept = !!db.value<number>(c, "SELECT COUNT(*) > 0 FROM pragma_table_info('runs') WHERE name='effort'");
  const run = kept
    ? db.value<string | null>(
        c,
        "SELECT effort FROM runs WHERE task_id=?1 AND kind='prompt' AND effort IS NOT NULL AND created_at < ?2 ORDER BY created_at DESC, rowid DESC LIMIT 1",
        task_id,
        at,
      )
    : undefined;
  if (run != null) {
    const e = run.trim();
    return e ? e : null;
  }
  return task_effort(c, task_id);
}

/**
 * The effort a task's agent is set to work at: its own, else the host's default, as a run starts with (see
 * runner/launch.rs). Null is the agent's own default.
 */
export function task_effort(c: Conn, task_id: string): string | null {
  const own = db.value<string | null>(c, "SELECT effort FROM tasks WHERE id=?1", task_id) ?? null;
  const effort = own != null && own.trim() !== "" ? own : (db.value<string>(c, "SELECT value FROM settings WHERE key='default_effort'") ?? null);
  const e = effort?.trim();
  return e ? e : null;
}

/** Give the rows of `review_stats` the effort their task has now (see migration 82). */
export function backfill_efforts(c: Conn): void {
  const ids = db.all<{ task_id: string }>(c, "SELECT DISTINCT task_id FROM review_stats").map((r) => r.task_id);
  for (const id of ids) db.run(c, "UPDATE review_stats SET effort=?2 WHERE task_id=?1", id, task_effort(c, id));
}

/** Record a submission made now. */
export function record_now(c: Conn, s: Submission): void {
  try {
    record(c, s, now());
  } catch (e) {
    console.warn(`task ${s.task_id}: recording a review's outcome: ${err_str(e)}`);
  }
}

const MINOR = new Set(["minor", "nit", "nits", "nitpick", "nitpicks", "suggestion", "suggestions"]);
const DENIAL = new Set(["no", "without", "nor", "any", "zero"]);

/**
 * Whether a review's summary says it found minor issues: "minor", "nit" or "nitpick", or "suggestion", as words, unless
 * only to say there are none ("no minor issues"): a "no", "any" and the like a few words before it in the same clause.
 */
export function mentions_minor(summary: string): boolean {
  const lower = summary.toLowerCase();
  return lower.split(/[.,;:!?\n]/).some((clause) => {
    const words = clause.split(/[^\p{Alphabetic}\p{Nd}\p{Nl}\p{No}]/u).filter((w) => w);
    return words.some((w, i) => MINOR.has(w) && !words.slice(Math.max(0, i - 4), i).some((p) => DENIAL.has(p)));
  });
}

/** The serious issues a submission lists, as review::submit counts them. */
export function serious_count(args: any): number {
  const si = args?.serious_issues;
  let n = 0;
  if (Array.isArray(si)) n = si.filter((i) => typeof i === "string" && i.trim() !== "").length;
  else if (typeof si === "string" && si.trim() !== "") n = 1;
  // A reviewer that wants fixes but didn't list them described them in its summary.
  return n === 0 && args?.verdict === "needs_fixes" ? 1 : n;
}

/** The minor issues a submission lists, if it has the field. */
export function minor_list(args: any): string[] | null {
  const m = args?.minor_issues;
  if (Array.isArray(m)) return m.filter((i) => typeof i === "string").map((i: string) => i.trim()).filter((i) => i !== "");
  if (typeof m === "string") return m.trim() === "" ? [] : [m.trim()];
  return null;
}

/**
 * Every `submit_review` in review threads (Claude Code's tool calls, and Codex's as the board shows them), but those
 * the board refused (a round that had ended), for the task each reviews. The run is the thread's latest to start before
 * the call, and the reviewer's label the one the task's latest review has for the thread, if it's in it.
 */
export function backfill(c: Conn): void {
  const done = !!db.value<number>(c, "SELECT EXISTS(SELECT 1 FROM review_stats)");
  if (done) return;
  const rows = db.all<{ task_id: string; parent_id: string; created_at: string; data: string }>(
    c,
    `SELECT m.task_id, t.parent_id, m.created_at, m.data FROM messages m JOIN tasks t ON t.id=m.task_id
     WHERE t.kind='review' AND COALESCE(t.task_type, '') != 'summary' AND t.parent_id IS NOT NULL
       AND m.kind='claude' AND m.data LIKE '%submit_review%'
     ORDER BY m.id`,
  );
  // The calls the board refused: its answer says so.
  const refused = new Set<string>();
  const refusing = db.all<{ task_id: string; data: string }>(
    c,
    `SELECT m.task_id, m.data FROM messages m JOIN tasks t ON t.id=m.task_id
     WHERE t.kind='review' AND m.kind='claude' AND m.data LIKE '%nothing to submit%'`,
  );
  for (const { task_id: thread_id, data } of refusing) {
    let m: any;
    try {
      m = JSON.parse(data);
    } catch {
      continue;
    }
    for (const id of refusals(m)) refused.add(`${thread_id}\0${id}`);
  }
  // Each task's reviewer runs' rounds, worked out once.
  const rounds = new Map<string, Map<string, string>>();
  for (const { task_id: thread_id, parent_id, created_at: at, data } of rows) {
    let v: any;
    try {
      v = JSON.parse(data);
    } catch {
      continue;
    }
    const blocks = v?.message?.content;
    if (!Array.isArray(blocks)) continue;
    for (const b of blocks) {
      if (!(b?.type === "tool_use" && typeof b.name === "string" && b.name.endsWith("submit_review"))) continue;
      const id = typeof b.id === "string" ? b.id : "";
      if (refused.has(`${thread_id}\0${id}`)) continue;
      const parent = db.one<{ review: string | null }>(c, "SELECT review FROM tasks WHERE id=?1", parent_id);
      if (!parent) continue;
      let label: string | null = null;
      if (parent.review != null) {
        try {
          const r = db.Review_from_json(JSON.parse(parent.review));
          label = r.reviewers.find((p) => p.thread_id === thread_id)?.label ?? null;
        } catch {}
      }
      const run_id = db.value<string>(c, "SELECT id FROM runs WHERE task_id=?1 AND created_at <= ?2 ORDER BY created_at DESC LIMIT 1", thread_id, at) ?? null;
      if (!rounds.has(parent_id)) rounds.set(parent_id, run_rounds(c, parent_id));
      const round = run_id != null ? (rounds.get(parent_id)!.get(run_id) ?? null) : null;
      const input = b.input;
      const serious = serious_count(input);
      const minor = minor_list(input);
      const s: Submission = {
        task_id: parent_id,
        thread_id,
        round,
        run_id,
        verdict: serious > 0 ? "issues" : "pass",
        serious,
        minor: minor ? minor.length : null,
        summary: typeof input?.summary === "string" ? input.summary : null,
        label,
      };
      record(c, s, at);
    }
  }
}

/**
 * The round reviewer run `run_id` of `task_id` is in, worked out as `backfill` does: for a review started before rounds
 * were kept, which has no start of its own.
 */
export function run_round(c: Conn, task_id: string, run_id: string): string | null {
  return run_rounds(c, task_id).get(run_id) ?? null;
}

/**
 * The round each of the runs of `task_id`'s review threads (not its summaries) was in, by when the round started: runs
 * started within `ROUND_GAP` of the one before are in its round, unless their thread has a run in it already (a
 * reviewer runs once a round).
 */
function run_rounds(c: Conn, task_id: string): Map<string, string> {
  const runs = db.all<{ id: string; task_id: string; created_at: string }>(
    c,
    `SELECT r.id, r.task_id, r.created_at FROM runs r JOIN tasks t ON t.id=r.task_id
     WHERE t.parent_id=?1 AND t.kind='review' AND COALESCE(t.task_type, '') != 'summary' AND r.kind='review'
     ORDER BY r.created_at`,
    task_id,
  );
  const out = new Map<string, string>();
  const rounds = new Rounds();
  for (const r of runs) out.set(r.id, rounds.place(r.task_id, r.created_at));
  return out;
}

/** An RFC 3339 time in milliseconds, or null if it isn't one. */
function parse_time(at: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/.test(at)) return null;
  const t = Date.parse(at);
  return Number.isNaN(t) ? null : t;
}

/** Puts reviewers' runs, in the order they started, in rounds (see `run_rounds`). */
export class Rounds {
  start = "";
  last: number | null = null;
  threads = new Set<string>();

  /** The start of the round that `thread`'s run starting at `at` is in. */
  place(thread: string, at: string): string {
    return this.place_new(thread, at)[0];
  }

  /** The same, and whether it's a new round. One that starts at the round's own start is in it. */
  place_new(thread: string, at: string): [string, boolean] {
    const t = parse_time(at);
    const near = this.last != null && t != null && Math.trunc((t - this.last) / 1000) <= ROUND_GAP;
    const fresh = this.start === "" || (at !== this.start && (!near || this.threads.has(thread)));
    if (fresh) {
      this.start = at;
      this.threads.clear();
    }
    this.threads.add(thread);
    this.last = t ?? this.last;
    return [this.start, fresh];
  }
}

/** The tool calls thread message `m` has the board refusing. */
function refusals(m: any): string[] {
  const blocks = m?.message?.content;
  if (!Array.isArray(blocks)) return [];
  return blocks
    .filter((b: any) => b?.type === "tool_result" && JSON.stringify(b).includes("nothing to submit"))
    .map((b: any) => b.tool_use_id)
    .filter((id: any): id is string => typeof id === "string");
}
