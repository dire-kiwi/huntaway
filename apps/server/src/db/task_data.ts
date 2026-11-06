// Port of server/src/db/task_data.rs: values kept on a task as JSON: its external links, its pull request's checks,
// context, the agent's wait, steers, reviewers and reviews.
//
// Each struct has a `<Type>_from_json(v)` that does what serde's Deserialize does: it checks the value's shape (throwing
// as serde would fail), fills in `#[serde(default)]`s, and builds an object that `JSON.stringify` writes as serde would
// (fields with `skip_serializing_if` left out when they're skipped, unknown fields dropped).
import type { Conn } from "../db.ts";
import { get_task } from "./tasks.ts";

// ---- what serde's derived Deserialize checks ----

function fail(msg: string): never {
  throw new Error(msg);
}

function obj(v: any, what: string): any {
  if (v === null || typeof v !== "object" || Array.isArray(v)) fail(`invalid type: expected struct ${what}`);
  return v;
}

/** A required string field. */
export function de_str(v: any, k: string): string {
  const x = v[k];
  if (x === undefined) fail(`missing field \`${k}\``);
  if (typeof x !== "string") fail(`invalid type for \`${k}\`: expected a string`);
  return x;
}

/** An `Option<String>` field (missing or null is None). */
export function de_opt_str(v: any, k: string): string | null {
  const x = v[k];
  if (x == null) return null;
  if (typeof x !== "string") fail(`invalid type for \`${k}\`: expected a string`);
  return x;
}

/** A `#[serde(default)] String` field. */
export function de_def_str(v: any, k: string): string {
  return v[k] === undefined ? "" : de_str(v, k);
}

/** A required unsigned integer field (`u32`, `u64`, `usize`). */
export function de_uint(v: any, k: string): number {
  const x = v[k];
  if (x === undefined) fail(`missing field \`${k}\``);
  if (typeof x !== "number" || !Number.isInteger(x) || x < 0) fail(`invalid type for \`${k}\`: expected an unsigned integer`);
  return x;
}

export function de_opt_uint(v: any, k: string): number | null {
  return v[k] == null ? null : de_uint(v, k);
}

/** A `#[serde(default)]` unsigned integer field. */
export function de_def_uint(v: any, k: string): number {
  return v[k] === undefined ? 0 : de_uint(v, k);
}

/** A `#[serde(default)] bool` field. */
export function de_def_bool(v: any, k: string): boolean {
  const x = v[k];
  if (x === undefined) return false;
  if (typeof x !== "boolean") fail(`invalid type for \`${k}\`: expected a boolean`);
  return x;
}

/** A `Vec<T>` field, `#[serde(default)]` if `def`. */
export function de_vec<T>(v: any, k: string, f: (x: any) => T, def = true): T[] {
  const x = v[k];
  if (x === undefined && def) return [];
  if (!Array.isArray(x)) fail(x === undefined ? `missing field \`${k}\`` : `invalid type for \`${k}\`: expected a sequence`);
  return x.map(f);
}

const string_item = (x: any): string => (typeof x === "string" ? x : fail("invalid type: expected a string"));

/** Sets `k` on `o` only if it's set: a field with `skip_serializing_if = "Option::is_none"` (or another test). */
function put(o: any, k: string, x: any, skip: boolean) {
  if (!skip) o[k] = x;
}

// ---- the structs ----

/** A task in another tracker that a task is for (stored on its task as JSON). Only Asana's for now. */
export interface ExternalLink {
  /** Which tracker: `asana`. */
  provider: string;
  /** The task's id there (an Asana task's gid). */
  id: string;
  url: string;
  /** Its name there, when it was linked. */
  title: string;
}

export function ExternalLink_from_json(v: any): ExternalLink {
  obj(v, "ExternalLink");
  return { provider: de_str(v, "provider"), id: de_str(v, "id"), url: de_str(v, "url"), title: de_def_str(v, "title") };
}

export const LINK_PROVIDERS = ["asana"];

/** How many external links a task can have. */
export const MAX_LINKS = 20;

/**
 * How a task's pull request's checks stood on its head commit when the board last read them: by a `wait` on it, while
 * it's watched in review, when its state is read for *Done when merged*, or for *Fix broken checks* (see
 * mcp/pr_watch.rs's record_checks). Stored on its task as JSON.
 */
export interface PrChecks {
  /** The pull request read (see pr_watch::Target::url). */
  url: string;
  /** The head commit whose checks these are. */
  head: string;
  /** `failed` (one or more did), `passed` (all those that have to), `pending` or `none`. */
  outcome: string;
  /** The checks that failed (`FAILED_MAX` at most). */
  failed: FailedCheck[];
  /** How many more failed than are listed. */
  more_failed: number;
  pending: number;
  passed: number;
  /** When a read first found them like this. */
  since: string;
}

export function PrChecks_default(): PrChecks {
  return { url: "", head: "", outcome: "", failed: [], more_failed: 0, pending: 0, passed: 0, since: "" };
}

export function PrChecks_from_json(v: any): PrChecks {
  obj(v, "PrChecks");
  return {
    url: de_str(v, "url"),
    head: de_str(v, "head"),
    outcome: de_str(v, "outcome"),
    failed: de_vec(v, "failed", FailedCheck_from_json),
    more_failed: de_def_uint(v, "more_failed"),
    pending: de_def_uint(v, "pending"),
    passed: de_def_uint(v, "passed"),
    since: de_str(v, "since"),
  };
}

export interface FailedCheck {
  /** `Workflow / job` for GitHub Actions, the check's or status's name otherwise. */
  name: string;
  /** How it ended: `failure`, `cancelled`, `timed_out`… */
  conclusion: string;
  url: string | null;
}

export function FailedCheck_from_json(v: any): FailedCheck {
  obj(v, "FailedCheck");
  return { name: de_str(v, "name"), conclusion: de_str(v, "conclusion"), url: de_opt_str(v, "url") };
}

/** How much of a thread's context window its agent's session uses (see agent/context.rs), stored on its task as JSON. */
export interface Context {
  /** Tokens in the context window as of the agent's latest reply. */
  tokens: number;
  /** The model's context window, once known. */
  max_tokens: number | null;
  /** Where Claude Code compacts the session by itself, if it does. */
  compact_at: number | null;
  model: string | null;
  updated_at: string;
  /** When the breakdown of what's in it (`GET /tasks/{id}/context`) was taken, if there is one. */
  detail_at: string | null;
}

export function Context_default(): Context {
  return { tokens: 0, max_tokens: null, compact_at: null, model: null, updated_at: "", detail_at: null };
}

export function Context_from_json(v: any): Context {
  obj(v, "Context");
  return {
    tokens: de_uint(v, "tokens"),
    max_tokens: de_opt_uint(v, "max_tokens"),
    compact_at: de_opt_uint(v, "compact_at"),
    model: de_opt_str(v, "model"),
    updated_at: de_str(v, "updated_at"),
    detail_at: de_opt_str(v, "detail_at"),
  };
}

/**
 * What a task's worktree starts from instead of the project's base branch (API 96), stored on it as JSON (tagged by
 * `type`). Set before the worktree is made; worktree::setup turns it into the task's base branch (which its pull request
 * targets and its changes are compared with) and the commit its branch starts at.
 * - `branch`: a branch, local or on the remote, which becomes the task's base branch.
 * - `task`: another task in the project (by id): its branch, so the task is stacked on it.
 * - `pull_request`: a pull request in the project's GitHub repository: its branch, as for a task. `repo` (`OWNER/REPO`)
 *   is the repository its URL named, if it was given one.
 * - `commit`: a commit (its SHA, in full when it was found in the repository); the base branch stays the project's.
 */
export type StartFrom =
  | { type: "branch"; branch: string }
  | { type: "task"; task_id: string }
  | { type: "pull_request"; number: number; repo?: string }
  | { type: "commit"; commit: string };

export function StartFrom_from_json(v: any): StartFrom {
  obj(v, "StartFrom");
  switch (v.type) {
    case "branch":
      return { type: "branch", branch: de_str(v, "branch") };
    case "task":
      return { type: "task", task_id: de_str(v, "task_id") };
    case "pull_request": {
      const o: any = { type: "pull_request", number: de_uint(v, "number") };
      put(o, "repo", de_opt_str(v, "repo"), v.repo == null);
      return o;
    }
    case "commit":
      return { type: "commit", commit: de_str(v, "commit") };
    case undefined:
      return fail("missing field `type`");
    default:
      return fail(`unknown variant \`${v.type}\`, expected one of \`branch\`, \`task\`, \`pull_request\`, \`commit\``);
  }
}

/**
 * What it is, as people and agents read it: `task ABC-12` (`key` is its project's key), `branch feature`,
 * `pull request #12` or `commit 0123abcd`.
 */
export function describe(sf: StartFrom, c: Conn, key: string): string {
  switch (sf.type) {
    case "branch":
      return `branch ${sf.branch}`;
    case "task": {
      let t: { number: number } | null = null;
      try {
        t = get_task(c, sf.task_id);
      } catch {}
      return t ? `task ${key}-${t.number}` : "a deleted task";
    }
    case "pull_request":
      return `pull request ${sf.repo ?? ""}#${sf.number}`;
    case "commit":
      return `commit ${Array.from(sf.commit).slice(0, 12).join("")}`;
  }
}

/** What an agent in the `wait` tool is waiting for (see mcp/wait.rs), stored on its task as JSON. */
export interface AgentWait {
  /** What it's waiting on, in the agent's words. */
  reason: string | null;
  since: string;
  /** When the wait ends at the latest. */
  until: string;
  /** Tasks whose next change of status ends the wait, with the status each had. */
  tasks: WaitTask[];
  /** A shell command run while waiting, whose exit ends the wait. */
  command?: string;
  /** The tool call that's waiting, and its run. */
  call_id: string;
  run_id: string;
  /**
   * Set as the task is moved to this column (from the board or `update_task`), which ends the wait. Recorded with the
   * move, so the wait can tell it from the status changes the board makes itself (a subagent's permission prompt and
   * its answer).
   */
  moved_to?: string;
  /** The first subagent that finished during the wait, kept until the call returns (also across a server restart). */
  subagent_finished?: any;
  /** A pull request whose news ends the wait (API 62, see mcp/pr_watch.rs). */
  pull_request?: WaitPr;
}

export function AgentWait_from_json(v: any): AgentWait {
  obj(v, "AgentWait");
  const o: any = { reason: de_opt_str(v, "reason"), since: de_str(v, "since"), until: de_str(v, "until"), tasks: de_vec(v, "tasks", WaitTask_from_json) };
  put(o, "command", de_opt_str(v, "command"), v.command == null);
  o.call_id = de_str(v, "call_id");
  o.run_id = de_str(v, "run_id");
  put(o, "moved_to", de_opt_str(v, "moved_to"), v.moved_to == null);
  put(o, "subagent_finished", v.subagent_finished, v.subagent_finished == null);
  put(o, "pull_request", v.pull_request == null ? null : WaitPr_from_json(v.pull_request), v.pull_request == null);
  return o;
}

/** The pull request a wait watches. */
export interface WaitPr {
  url: string;
  /** `OWNER/REPO`, or `HOST/OWNER/REPO` off github.com. */
  repo: string;
  number: number;
  /** What ends the wait (see pr_watch::EVENTS); its being merged or closed always does. */
  events: string[];
  /**
   * What a read found that ends the wait, kept until the call returns (also across a server restart), with what the
   * agent has been told once it has (see pr_watch::News).
   */
  news?: any;
}

export function WaitPr_from_json(v: any): WaitPr {
  obj(v, "WaitPr");
  const o: any = { url: de_str(v, "url"), repo: de_str(v, "repo"), number: de_uint(v, "number"), events: de_vec(v, "events", string_item, false) };
  put(o, "news", v.news, v.news == null);
  return o;
}

export interface WaitTask {
  id: string;
  key: string;
  status: string;
}

export function WaitTask_from_json(v: any): WaitTask {
  obj(v, "WaitTask");
  return { id: de_str(v, "id"), key: de_str(v, "key"), status: de_str(v, "status") };
}

/** A message sent to a running agent, kept until the agent takes it in (see runner::steer). */
export interface Steer {
  /** Also the stream-json message's uuid, which the agent echoes back when it takes it in. */
  id: string;
  text: string;
  from_agent: boolean;
  /** The run it was sent to. */
  run_id: string;
  /** Written to the run's input. Until then it's waiting for the run to start. */
  written: boolean;
  /** The automation runs whose messages it carries (see Queued.routine_runs). Left out when there are none. */
  routine_runs?: string[];
  /** A routine's (see Queued.routine): a project automation's carries its runs, but isn't. Left out when false. */
  routine?: boolean;
}

export function Steer_from_json(v: any): Steer {
  obj(v, "Steer");
  const s: Steer = {
    id: de_str(v, "id"),
    text: de_str(v, "text"),
    from_agent: de_def_bool(v, "from_agent"),
    run_id: de_str(v, "run_id"),
    written: de_def_bool(v, "written"),
  };
  return Steer_with(s, Array.isArray(v.routine_runs) ? v.routine_runs.filter((x: any) => typeof x === "string") : [], v.routine === true);
}

/** `s` with its automation runs and routine marker, as serde writes them (skipped when empty or false). */
export function Steer_with(s: Steer, routine_runs: string[], routine: boolean): Steer {
  const { id, text, from_agent, run_id, written } = s;
  const out: Steer = { id, text, from_agent, run_id, written };
  if (routine_runs.length) out.routine_runs = [...routine_runs];
  if (routine) out.routine = true;
  return out;
}

/** One of a project's reviewers: the agent that reviews, in a review thread of its own. */
export interface Reviewer {
  /** None uses the reviewed task's config. */
  claude_config_id: string | null;
  /** None uses the default (the project's, profile's or host's, as for any thread). */
  model: string | null;
  effort: string | null;
  /**
   * Only for a summarizer (API 103): what to call it where its summary is shown, so summarizers that differ in their
   * skills or prompt can be told apart.
   */
  name?: string;
  /**
   * Skills its agent uses while it works: named in its prompt (for a reviewer too, API 105). The board's skills (a
   * project's own or global ones) among them are on in its thread whether or not they are for the project.
   */
  skills?: string[];
  /**
   * Replaces the board's instructions on how to write the summary (for a summarizer), so a prompt can be tried against
   * another's, or the project's *In review* prompt, what to look for (for a reviewer, API 105). None uses the board's,
   * or the project's.
   */
  prompt?: string;
}

export function Reviewer_default(): Reviewer {
  return { claude_config_id: null, model: null, effort: null };
}

export function Reviewer_from_json(v: any): Reviewer {
  obj(v, "Reviewer");
  const o: any = { claude_config_id: de_opt_str(v, "claude_config_id"), model: de_opt_str(v, "model"), effort: de_opt_str(v, "effort") };
  put(o, "name", de_opt_str(v, "name"), v.name == null);
  const skills = de_vec(v, "skills", string_item);
  put(o, "skills", skills, !skills.length);
  put(o, "prompt", de_opt_str(v, "prompt"), v.prompt == null);
  return o;
}

/**
 * A task's latest review (see review.rs), stored on the task as JSON. With several reviewers, `reviewers` has each
 * one's part and the rest combines them.
 */
export interface Review {
  /** The (first) review thread: a `review` task whose parent is this task. */
  thread_id: string;
  /** running, passed, issues, failed or stopped */
  state: string;
  /** The commit reviewed. */
  head: string | null;
  /** What the reviewer reported (or why the review failed). */
  summary: string | null;
  /** Serious issues the reviewer found, which go back to the task's agent to fix. */
  issues: string[];
  /** Set by `submit_review` while the review is running: pass or issues. */
  verdict?: string;
  /** Reviews in a row that sent issues back to the agent (capped by the project's review_rounds, plus `extra_rounds`). */
  fixes: number;
  /** Rounds of fixes the user added after the task ran out of them (API 93, see review::extend). */
  extra_rounds: number;
  updated_at: string;
  /**
   * When this round of review started: the round each reviewer's submission is kept with, for statistics (see
   * review/stats.rs). Missing on reviews started before it was kept.
   */
  started_at?: string;
  /** Each reviewer's part (API 29). Empty in reviews from before there could be several. */
  reviewers: ReviewerRun[];
}

export function Review_default(): Review {
  return { thread_id: "", state: "", head: null, summary: null, issues: [], fixes: 0, extra_rounds: 0, updated_at: "", reviewers: [] };
}

export function Review_from_json(v: any): Review {
  obj(v, "Review");
  const o: any = { thread_id: de_str(v, "thread_id"), state: de_str(v, "state"), head: de_opt_str(v, "head"), summary: de_opt_str(v, "summary") };
  o.issues = de_vec(v, "issues", string_item);
  put(o, "verdict", de_opt_str(v, "verdict"), v.verdict == null);
  o.fixes = de_def_uint(v, "fixes");
  o.extra_rounds = de_def_uint(v, "extra_rounds");
  o.updated_at = de_str(v, "updated_at");
  put(o, "started_at", de_opt_str(v, "started_at"), v.started_at == null);
  o.reviewers = de_vec(v, "reviewers", ReviewerRun_from_json);
  return o;
}

/** A summary of a task's changes (see review/summary.rs), stored on the task as JSON. */
export interface ChangeSummary {
  /** The summary thread: a `review` task of type `summary` whose parent is this task. */
  thread_id: string;
  /** Who writes it, e.g. "Claude · haiku". */
  label: string;
  /** The summarizer's name, when it has one (see Reviewer.name). */
  name?: string;
  /** The skills its summarizer was asked to use. */
  skills?: string[];
  /** Whether its summarizer had a prompt of its own. */
  custom_prompt?: boolean;
  /** running, done, failed or stopped */
  state: string;
  /** The commit summarised. */
  head: string | null;
  /** The summary (Markdown), or why there's none. */
  text: string | null;
  /** The thread's last run before this one (empty if it had none), as ReviewerRun.after_run. */
  after_run?: string;
  updated_at: string;
}

export function ChangeSummary_default(): ChangeSummary {
  return { thread_id: "", label: "", state: "", head: null, text: null, updated_at: "" };
}

export function ChangeSummary_from_json(v: any): ChangeSummary {
  obj(v, "ChangeSummary");
  const o: any = { thread_id: de_str(v, "thread_id"), label: de_def_str(v, "label") };
  put(o, "name", de_opt_str(v, "name"), v.name == null);
  const skills = de_vec(v, "skills", string_item);
  put(o, "skills", skills, !skills.length);
  const custom = de_def_bool(v, "custom_prompt");
  put(o, "custom_prompt", custom, !custom);
  o.state = de_str(v, "state");
  o.head = de_opt_str(v, "head");
  o.text = de_opt_str(v, "text");
  put(o, "after_run", de_opt_str(v, "after_run"), v.after_run == null);
  o.updated_at = de_str(v, "updated_at");
  return o;
}

/** A task's `summary` column: the list of its summaries, or the one summary saved before there could be several. */
export function summaries_column(v: string | null | undefined): ChangeSummary[] {
  if (v == null) return [];
  let x: any;
  try {
    x = JSON.parse(v);
  } catch {
    return [];
  }
  try {
    if (Array.isArray(x)) return x.map(ChangeSummary_from_json);
    if (x !== null && typeof x === "object") return [ChangeSummary_from_json(x)];
  } catch {}
  return [];
}

/** One reviewer's part of a review. */
export interface ReviewerRun {
  thread_id: string;
  /** Which agent reviews, e.g. "Codex · gpt-5.1". */
  label: string;
  /** running, passed, issues, failed or stopped */
  state: string;
  summary: string | null;
  issues: string[];
  /** Set by `submit_review` while it's running: pass or issues. */
  verdict?: string;
  /**
   * The thread's last run before this round (empty if it had none): the round's reviewer is a later one, so an earlier
   * run's late verdict or end doesn't end this part. Missing on parts recorded before this was kept, which any run of the
   * thread ends.
   */
  after_run?: string;
}

export function ReviewerRun_default(): ReviewerRun {
  return { thread_id: "", label: "", state: "", summary: null, issues: [] };
}

export function ReviewerRun_from_json(v: any): ReviewerRun {
  obj(v, "ReviewerRun");
  const o: any = { thread_id: de_str(v, "thread_id"), label: de_str(v, "label"), state: de_str(v, "state"), summary: de_opt_str(v, "summary") };
  o.issues = de_vec(v, "issues", string_item);
  put(o, "verdict", de_opt_str(v, "verdict"), v.verdict == null);
  put(o, "after_run", de_opt_str(v, "after_run"), v.after_run == null);
  return o;
}

/** A JSON column read as a `T` (with `from_json`), or null if it's null, not JSON or not a `T`. */
export function json_opt<T>(v: string | null | undefined, from_json: (x: any) => T): T | null {
  if (v == null) return null;
  try {
    return from_json(JSON.parse(v));
  } catch {
    return null;
  }
}

/** A JSON list column read as `T`s, or empty if it's null, not JSON or not a list of `T`s. */
export function json_vec<T>(v: string | null | undefined, from_json: (x: any) => T): T[] {
  if (v == null) return [];
  try {
    const x = JSON.parse(v);
    return Array.isArray(x) ? x.map(from_json) : [];
  } catch {
    return [];
  }
}
