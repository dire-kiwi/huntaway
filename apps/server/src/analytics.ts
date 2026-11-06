// Port of server/src/analytics.rs.
/**
 * Prompt analytics: when the user prompted which task, and when agents ran, for time tracking; and the tokens agents
 * used, and what reviews found (`token_report`).
 *
 * Built from what threads already record (user messages and runs), so it covers history from before it existed. The UI
 * turns the events into active time and calendar views; this only picks them out. Review threads count towards the task
 * they review.
 */
import * as db from "./db.ts";
import type { Conn } from "./db.ts";
import { ApiError, type Req } from "./http.ts";
import type { AppState } from "./state.ts";
import * as history from "./threads/history.ts";

/** The board's own prompt when a task is started, before those messages were marked `start` (see runner::send_run). */
export const START_TEXT = "Start working on this task.";
/** The board's prompt when the user moves a task to "Ready for merge" (see runner::request_merge). */
export const MERGE_PREFIX = 'The user moved this task to "Ready for merge"';
/** Prompts are cut to this many characters; the dashboard only shows a preview. */
export const TEXT_LIMIT = 280;

export interface Event {
  at: string;
  task_id: string;
  /** `prompt` (typed by the user), `start` (the task was started) or `merge` (moved to Ready for merge). */
  kind: string;
  text: string;
}

export interface Run {
  task_id: string;
  /** `prompt`, `compact` or `review`. */
  kind: string;
  started_at: string;
  /** Null while the run is going. */
  ended_at: string | null;
}

export interface TaskInfo {
  id: string;
  project_id: string | null;
  kind: string;
  number: number;
  title: string;
  status: string;
}

export interface ProjectInfo {
  id: string;
  name: string;
  key: string;
}

export interface Report {
  events: Event[];
  runs: Run[];
  /** Every task the events and runs refer to. */
  tasks: TaskInfo[];
  projects: ProjectInfo[];
}

/** The query's `from` and `to`, as axum's `Query<RangeQuery>` takes them. */
function range(r: Req): [string, string] {
  for (const k of ["from", "to"]) {
    if (r.query[k] === undefined) throw new ApiError(400, `Failed to deserialize query string: missing field \`${k}\``);
  }
  return [parse_ts(r.query.from, "from"), parse_ts(r.query.to, "to")];
}

const RFC3339 = /^(\d{4}-\d{2}-\d{2})[Tt ](\d{2}:\d{2}:\d{2})(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;

export function parse_ts(s: string, what: string): string {
  const m = RFC3339.exec(s);
  const bad = () => ApiError.bad(`${what} must be an RFC 3339 time`);
  if (!m) throw bad();
  const frac = m[3] ? m[3].slice(0, 4).padEnd(4, "0") : "";
  const t = new Date(`${m[1]}T${m[2]}${frac}${m[4].toUpperCase()}`);
  if (Number.isNaN(t.getTime())) throw bad();
  // Stored times are all in this form, so they compare as strings.
  return t.toISOString();
}

/** `GET /profiles/{id}/analytics?from=&to=`: the profile's activity in `[from, to)`. */
export async function get(s: AppState, r: Req): Promise<any> {
  const [from, to] = range(r);
  return report(s.db(), r.params.id, from, to);
}

/** What a user message on a thread counts as, if anything. */
export function classify(data: any): string | null {
  if (data?.from_agent === true) return null;
  const text = typeof data?.text === "string" ? data.text : "";
  if (data?.auto !== true) return "prompt";
  if (data.start === true || text === START_TEXT) return "start";
  if (text.startsWith(MERGE_PREFIX)) return "merge";
  return null;
}

export function clip(text: string): string {
  const cs = Array.from(text);
  return cs.length > TEXT_LIMIT ? `${cs.slice(0, TEXT_LIMIT).join("").trimEnd()}…` : text;
}

/** A review thread's activity belongs to the task under review. */
const OWNER = "COALESCE(CASE WHEN t.kind='review' THEN t.parent_id END, t.id)";

export function report(c: Conn, profile_id: string, from: string, to: string): Report {
  const events: Event[] = [];
  // From each thread's items (threads/history.ts).
  for (const r of history.user_messages_between(c, profile_id, from, to, OWNER)) {
    const data = r.data;
    const kind = classify(data);
    if (kind !== null) {
      const text = kind === "prompt" ? clip(typeof data?.text === "string" ? data.text : "") : "";
      events.push({ at: r.at, task_id: r.owner, kind, text });
    }
  }
  const runs: Run[] = db
    .all(
      c,
      `SELECT ${OWNER} AS owner, r.kind AS kind, r.created_at AS created_at, r.ended_at AS ended_at FROM runs r JOIN tasks t ON t.id=r.task_id
         WHERE t.profile_id=?1 AND r.created_at < ?3 AND (r.ended_at IS NULL OR r.ended_at > ?2)
         ORDER BY r.created_at`,
      profile_id,
      from,
      to,
    )
    .map((r) => ({ task_id: r.owner, kind: r.kind, started_at: r.created_at, ended_at: r.ended_at ?? null }));
  const [tasks, projects] = tasks_and_projects(c, profile_id, [...events.map((e) => e.task_id), ...runs.map((r) => r.task_id)]);
  return { events, runs, tasks, projects };
}

const byteOrder = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));

/** The tasks `ids` refer to, and the profile's projects. */
function tasks_and_projects(c: Conn, profile_id: string, ids: string[]): [TaskInfo[], ProjectInfo[]] {
  const sorted = [...new Set(ids)].sort(byteOrder);
  const tasks: TaskInfo[] = [];
  for (const id of sorted) {
    const r = db.one(c, "SELECT id, project_id, kind, number, title, status FROM tasks WHERE id=?1", id);
    if (r) tasks.push({ id: r.id, project_id: r.project_id ?? null, kind: r.kind, number: r.number, title: r.title, status: r.status });
  }
  const projects = db
    .all(c, "SELECT id, name, key FROM projects WHERE profile_id=?1 ORDER BY created_at", profile_id)
    .map((r) => ({ id: r.id, name: r.name, key: r.key }));
  return [tasks, projects];
}

/** A turn's end or a compaction (see db::SCHEMA_V69). */
export interface ContextStat {
  at: string;
  task_id: string;
  /** `turn` or `compact`. */
  kind: string;
  /** A turn's: the context it left. A compaction's: the context before it. */
  tokens: number | null;
  /** A turn's: what its first request to the model held, so a session started afresh starts small. */
  start_tokens: number | null;
  /** A compaction's: the context after it, if the agent says. */
  post_tokens: number | null;
  /** The model's context window, if it was known. */
  max_tokens: number | null;
  model: string | null;
  /** A compaction's: `auto` (the agent's own, as its context filled up), `user` (`/compact`) or `idle` (the board's, after the session sat idle). */
  source: string | null;
  /** A turn's cost, if the agent reports it (Claude Code does). */
  cost_usd: number | null;
  /** How long a compaction took, if the agent says. */
  duration_ms: number | null;
}

export interface ContextReport {
  stats: ContextStat[];
  tasks: TaskInfo[];
  projects: ProjectInfo[];
}

/** `GET /profiles/{id}/context-stats?from=&to=`: how big the profile's threads' contexts were at the end of each turn in `[from, to)`, and the compactions then. */
export async function context(s: AppState, r: Req): Promise<any> {
  const [from, to] = range(r);
  return context_report(s.db(), r.params.id, from, to);
}

export function context_report(c: Conn, profile_id: string, from: string, to: string): ContextReport {
  // Review threads count as themselves here: their contexts are their own.
  const stats: ContextStat[] = db
    .all(
      c,
      `SELECT s.at, s.task_id, s.kind, s.tokens, s.post_tokens, s.max_tokens, s.model, s.source, s.cost_usd, s.duration_ms, s.start_tokens
         FROM context_stats s JOIN tasks t ON t.id=s.task_id
         WHERE t.profile_id=?1 AND s.at >= ?2 AND s.at < ?3 ORDER BY s.at`,
      profile_id,
      from,
      to,
    )
    .map((r) => ({
      at: r.at,
      task_id: r.task_id,
      kind: r.kind,
      tokens: r.tokens ?? null,
      start_tokens: r.start_tokens ?? null,
      post_tokens: r.post_tokens ?? null,
      max_tokens: r.max_tokens ?? null,
      model: r.model ?? null,
      source: r.source ?? null,
      cost_usd: r.cost_usd ?? null,
      duration_ms: r.duration_ms ?? null,
    }));
  const [tasks, projects] = tasks_and_projects(
    c,
    profile_id,
    stats.map((s) => s.task_id),
  );
  return { stats, tasks, projects };
}

/** What one run used of one model (see agent/tokens.ts), or one model call that isn't a run (see agent/tokens/calls.ts). */
export interface UsageRow {
  /** Null for a call that isn't a run. */
  run_id: string | null;
  /** A call's that isn't a run (API 100): the rows of a call, one for each model it used, share it. */
  call_id: string | null;
  /** The thread the run was in: a task, or a review or summary thread. A title's task; null for a window's restart. */
  task_id: string | null;
  /** The run's: `prompt`, `compact` or `review`; or the call's: `title` or `window`. */
  kind: string;
  at: string;
  model: string;
  /** `claude` or `codex`. */
  runtime: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  reasoning_tokens: number;
  /** Claude Code's; Codex doesn't say. */
  cost_usd: number | null;
  /** A guess: from its cost alone, or scaled to it. */
  estimated: boolean;
}

/** What a reviewer reported (see review/stats.ts). */
export interface ReviewRow {
  /** The task reviewed. */
  task_id: string;
  thread_id: string;
  at: string;
  /** `pass` or `issues`. */
  verdict: string;
  serious: number;
  /** Null for reviews from before minor issues were listed. */
  minor: number | null;
  /** It listed minor issues, or its summary mentions some. */
  minor_noted: boolean;
  label: string | null;
  /** The model the reviewer's run used most, once its tokens are counted. */
  model: string | null;
  /** Which of its task's review rounds it was in, from 1 (see `rounds`). */
  round: number;
  /** The effort the reviewed task's agent was set to work at when this was submitted (API 101); null is the agent's own default. */
  effort: string | null;
  /** The model the reviewed task's agent used most in the run before this review (API 101), if its tokens are counted. */
  task_model: string | null;
}

/** One round of review of a task: its reviewers' submissions together. */
export interface RoundRow {
  task_id: string;
  /** From 1, in the order the task's rounds started. */
  round: number;
  /** When it started. */
  at: string;
  /** `issues` if a reviewer found serious issues, else `pass`. */
  verdict: string;
  serious: number;
  /** How many reviewers submitted in it. */
  reviewers: number;
}

/** A task created by another's agent. */
export interface FollowUp {
  task_id: string;
  created_by: string;
  at: string;
}

/** A `TaskInfo` (flattened) with more. */
export interface UsageTask extends TaskInfo {
  /** A review thread's task, or a subproject task's subproject. */
  parent_id: string | null;
  task_type: string | null;
  subproject: boolean;
  group_name: string | null;
  /** The model its own runs used most (by output), of those counted. */
  model: string | null;
}

export interface TokenReport {
  usage: UsageRow[];
  reviews: ReviewRow[];
  /** Every round of review of the tasks `reviews` are for, those outside the range included, so a task's first round is its first. */
  rounds: RoundRow[];
  /** Tasks created by the agents of the tasks in `tasks`. */
  follow_ups: FollowUp[];
  /** Every task the rows refer to, the parents of those, and the follow-ups. */
  tasks: UsageTask[];
  projects: ProjectInfo[];
  /** The profile's runs that have ended but whose tokens aren't counted yet. */
  pending: number;
}

/** `GET /profiles/{id}/token-stats?from=&to=`: the tokens the profile's runs that started in `[from, to)` used, the reviews then and the follow-up tasks their tasks' agents created. */
export async function tokens(s: AppState, r: Req): Promise<any> {
  const [from, to] = range(r);
  return token_report(s.db(), r.params.id, from, to);
}

/** The model a run used most, by output. */
const RUN_MODEL = "(SELECT u.model FROM token_usage u WHERE u.run_id=?1 ORDER BY u.output_tokens DESC, u.cost_usd DESC LIMIT 1)";

/** The model task `?1`'s own agent used most in its latest counted run that started before `?2`: the one whose work was reviewed. */
const TASK_MODEL = `(SELECT u.model FROM token_usage u WHERE u.run_id=(
    SELECT r.id FROM runs r WHERE r.task_id=?1 AND r.kind='prompt' AND r.created_at < ?2 AND EXISTS (SELECT 1 FROM token_usage x WHERE x.run_id=r.id)
    ORDER BY r.created_at DESC LIMIT 1) ORDER BY u.output_tokens DESC, u.cost_usd DESC LIMIT 1)`;

export function token_report(c: Conn, profile_id: string, from: string, to: string): TokenReport {
  const usage: UsageRow[] = db
    .all(
      c,
      `SELECT u.run_id, r.task_id, r.kind, r.created_at, u.model, u.runtime, u.input_tokens, u.output_tokens, u.cache_read_tokens,
           u.cache_write_tokens, u.reasoning_tokens, u.cost_usd, u.estimated
         FROM token_usage u JOIN runs r ON r.id=u.run_id JOIN tasks t ON t.id=r.task_id
         WHERE t.profile_id=?1 AND r.created_at >= ?2 AND r.created_at < ?3 ORDER BY r.created_at`,
      profile_id,
      from,
      to,
    )
    .map((r) => ({
      run_id: r.run_id ?? null,
      call_id: null,
      task_id: r.task_id ?? null,
      kind: r.kind,
      at: r.created_at,
      model: r.model,
      runtime: r.runtime,
      input_tokens: r.input_tokens,
      output_tokens: r.output_tokens,
      cache_read_tokens: r.cache_read_tokens,
      cache_write_tokens: r.cache_write_tokens,
      reasoning_tokens: r.reasoning_tokens,
      cost_usd: r.cost_usd ?? null,
      estimated: !!r.estimated,
    }));
  usage.push(...call_usage(c, profile_id, from, to));
  usage.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

  const reviews: ReviewRow[] = [];
  const round_of: string[] = [];
  const rows = db.all(
    c,
    `SELECT s.task_id, s.thread_id, s.at, s.verdict, s.serious, s.minor, s.minor_noted, s.label, s.run_id, s.round, s.effort
         FROM review_stats s JOIN tasks t ON t.id=s.task_id
         WHERE t.profile_id=?1 AND s.at >= ?2 AND s.at < ?3 ORDER BY s.at`,
    profile_id,
    from,
    to,
  );
  for (const r of rows) {
    round_of.push(r.round);
    const model = r.run_id != null ? (db.value<string | null>(c, `SELECT ${RUN_MODEL}`, r.run_id) ?? null) : null;
    const worked = db.value<string | null>(c, `SELECT ${TASK_MODEL}`, r.task_id, r.at) ?? null;
    reviews.push({
      task_id: r.task_id,
      thread_id: r.thread_id,
      at: r.at,
      verdict: r.verdict,
      serious: r.serious,
      minor: r.minor ?? null,
      minor_noted: !!r.minor_noted,
      label: r.label ?? null,
      model,
      round: 0,
      effort: r.effort ?? null,
      task_model: worked,
    });
  }
  const [rounds, numbers] = review_rounds(
    c,
    reviews.map((r) => r.task_id),
  );
  reviews.forEach((r, i) => {
    r.round = numbers.get(`${r.task_id}\u0000${round_of[i]}`) ?? 0;
  });

  // The tasks the rows are for, with the tasks their threads review and the subprojects they're in.
  const seen = new Set([...usage.flatMap((u) => (u.task_id !== null ? [u.task_id] : [])), ...reviews.flatMap((r) => [r.task_id, r.thread_id])]);
  // Each once (a task has many runs).
  const ids = [...seen];
  for (let i = 0; i < ids.length; i++) {
    const p = db.value<string>(c, "SELECT parent_id FROM tasks WHERE id=?1 AND parent_id IS NOT NULL", ids[i]);
    if (p != null && !seen.has(p)) {
      seen.add(p);
      ids.push(p);
    }
  }

  const follow_ups: FollowUp[] = db
    .all(c, "SELECT id, created_by, created_at FROM tasks WHERE created_by IS NOT NULL AND profile_id=?1", profile_id)
    .map((r) => ({ task_id: r.id, created_by: r.created_by, at: r.created_at }))
    .filter((f) => seen.has(f.created_by));
  const [infos, projects] = tasks_and_projects(c, profile_id, [...ids, ...follow_ups.map((f) => f.task_id)]);
  const tasks: UsageTask[] = infos.map((info) => {
    const r = db.one(
      c,
      `SELECT parent_id, task_type, subproject, group_name,
           (SELECT u.model FROM token_usage u JOIN runs r ON r.id=u.run_id WHERE r.task_id=tasks.id
            GROUP BY u.model ORDER BY SUM(u.output_tokens) DESC, SUM(u.cost_usd) DESC LIMIT 1) AS model
         FROM tasks WHERE id=?1`,
      info.id,
    );
    if (!r) throw new Error("Query returned no rows");
    return {
      ...info,
      parent_id: r.parent_id ?? null,
      task_type: r.task_type ?? null,
      subproject: !!r.subproject,
      group_name: r.group_name ?? null,
      model: r.model ?? null,
    };
  });

  const pending =
    db.value<number>(
      c,
      "SELECT COUNT(*) FROM runs r JOIN tasks t ON t.id=r.task_id WHERE t.profile_id=?1 AND r.status='exited' AND r.usage_at IS NULL",
      profile_id,
    ) ?? 0;
  return { usage, reviews, rounds, follow_ups, tasks, projects, pending };
}

/**
 * The model calls that weren't runs (see agent/tokens/calls.ts) in `[from, to)`: titles of the profile's tasks, and the
 * restarts of the windows of the configs it's the first profile to use (each config's in one profile's report, though
 * several use it; a config none uses, in the first profile's).
 */
function call_usage(c: Conn, profile_id: string, from: string, to: string): UsageRow[] {
  return db
    .all(
      c,
      `SELECT u.task_id, u.purpose, u.at, u.model, u.runtime, u.input_tokens, u.output_tokens, u.cache_read_tokens, u.cache_write_tokens,
           u.reasoning_tokens, u.cost_usd, u.call_id
         FROM call_usage u LEFT JOIN tasks t ON t.id=u.task_id
         WHERE u.at >= ?2 AND u.at < ?3 AND (t.profile_id=?1 OR (u.task_id IS NULL AND ?1=COALESCE(
           (SELECT p.id FROM profiles p WHERE EXISTS (SELECT 1 FROM json_each(p.claude_config_ids) j WHERE j.value=u.config_id)
            ORDER BY p.created_at, p.id LIMIT 1),
           (SELECT id FROM profiles ORDER BY created_at, id LIMIT 1))))
         ORDER BY u.at`,
      profile_id,
      from,
      to,
    )
    .map((r) => ({
      run_id: null,
      call_id: r.call_id ?? null,
      task_id: r.task_id ?? null,
      kind: r.purpose,
      at: r.at,
      model: r.model,
      runtime: r.runtime,
      input_tokens: r.input_tokens,
      output_tokens: r.output_tokens,
      cache_read_tokens: r.cache_read_tokens,
      cache_write_tokens: r.cache_write_tokens,
      reasoning_tokens: r.reasoning_tokens,
      cost_usd: r.cost_usd ?? null,
      estimated: false,
    }));
}

/**
 * Every round of review of `tasks`, and the number of each task's rounds by when they started (keyed
 * `<task>\0<round>`). A round is its submissions' `round` (see review/stats.ts).
 */
function review_rounds(c: Conn, task_ids: string[]): [RoundRow[], Map<string, number>] {
  const tasks = [...new Set(task_ids)].sort(byteOrder);
  const rounds: RoundRow[] = [];
  const numbers = new Map<string, number>();
  for (const task of tasks) {
    const subs = db.all(c, "SELECT round, verdict, serious FROM review_stats WHERE task_id=?1 ORDER BY round", task);
    let n = 0;
    for (const { round, verdict, serious } of subs) {
      const last = rounds[rounds.length - 1];
      if (!last || last.task_id !== task || last.at !== round) {
        n++;
        rounds.push({ task_id: task, round: n, at: round, verdict: "pass", serious: 0, reviewers: 0 });
      }
      const r = rounds[rounds.length - 1];
      r.reviewers++;
      r.serious += serious;
      if (verdict === "issues") r.verdict = "issues";
      numbers.set(`${task}\u0000${round}`, r.round);
    }
  }
  return [rounds, numbers];
}
