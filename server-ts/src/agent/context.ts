// Port of server/src/agent/context.rs.
/**
 * How full each thread's context window is, like Claude Code's `/context`.
 *
 * The token count follows the agent's replies as it works: each reply's usage (Claude Code's `assistant` messages,
 * Codex's `thread/tokenUsage/updated`) says how much the session sent the model. At the end of each Claude Code turn the
 * board also asks the agent for the breakdown `/context` shows (a `get_context_usage` control request on its input), and
 * keeps the latest one for `GET /tasks/{id}/context`. It asks for the summary: the total is the last reply's usage and
 * the parts are estimated locally. The full one counts each part with Anthropic's token-counting API, which would be
 * more requests every turn, and Claude Code waits for it before exiting (up to 5 minutes), keeping a finished run going.
 *
 * For statistics (`GET /profiles/{id}/context-stats`, see analytics.ts), it also keeps a row for the end of each turn
 * with the context it leaves, and one for each compaction, in `context_stats`, which outlive the session.
 */
import * as db from "../db.ts";
import type { Conn, Context, Run } from "../db.ts";
import { ApiError, type Req } from "../http.ts";
import type { AppState, Shared } from "../state.ts";
import { err_str, new_id, now } from "../util.ts";
import * as runs from "./runs.ts";
import * as history from "../threads/history.ts";

/** Prefix of the control requests' ids, so their responses can be told from others. */
const REQUEST_PREFIX = "context-";

/** serde's `as_u64`: a non-negative whole number, else null. */
const u64 = (v: any): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);
/** serde's `as_i64`. */
const i64 = (v: any): number | null => (typeof v === "number" && Number.isInteger(v) ? v : null);

function current(state: Shared, task_id: string): Context | null {
  return db.get_task(state.db(), task_id)?.context ?? null;
}

function save(state: Shared, task_id: string, ctx: Context, detail: string | null): void {
  const fields: Array<[string, any]> = [["context", ctx]];
  if (detail !== null) fields.push(["context_detail", detail]);
  state.update_task(task_id, fields);
}

/** A Claude Code `assistant` message: its usage is what the session sent the model for it. Subagents' messages are in their own context, not the thread's. */
export function on_assistant(state: Shared, run: Run, v: any): void {
  if (v?.parent_tool_use_id != null) return;
  const u = v?.message?.usage;
  if (u === null || typeof u !== "object" || Array.isArray(u)) return;
  // Synthetic messages (an error, a stop) weren't sent to the model.
  const model = v.message.model;
  if (typeof model === "string" && model.startsWith("<")) return;
  const n = (k: string) => u64(u[k]) ?? 0;
  // Counted as `/context` counts it.
  const tokens = n("input_tokens") + n("cache_creation_input_tokens") + n("cache_read_input_tokens");
  if (tokens === 0) return;
  turn_usage(state, run, tokens);
  set_tokens(state, run.task_id, tokens, null);
}

/** A request in the run's current turn (see `record_turn`): the first says what the turn started from, the latest what it's got to. */
function turn_usage(state: Shared, run: Run, tokens: number): void {
  db.run(state.db(), "UPDATE runs SET turn_start_tokens=COALESCE(turn_start_tokens, ?1), turn_tokens=?1 WHERE id=?2", tokens, run.id);
}

/** Codex's `thread/tokenUsage/updated`, for the thread's own session (not a subagent's). */
export function on_codex_usage(state: Shared, run: Run, p: any): void {
  const task_id = run.task_id;
  const session = db.get_task(state.db(), task_id)?.session_id ?? null;
  if (typeof p?.threadId === "string" && session !== null && session !== p.threadId) return;
  const usage = p?.tokenUsage;
  const tokens = u64(usage?.last?.totalTokens);
  if (tokens === null) return;
  turn_usage(state, run, tokens);
  set_tokens(state, task_id, tokens, u64(usage?.modelContextWindow));
}

/** After compacting, the session starts again from the summary. `meta` is Claude Code's `compact_metadata` (Codex's has just the `trigger`). */
export function on_compacted(state: Shared, run: Run, meta: any): void {
  const task_id = run.task_id;
  const before = current(state, task_id);
  record_compaction(state, run, meta, before);
  const tokens = u64(meta?.post_tokens);
  if (tokens === null) return;
  // A turn the agent compacted in leaves the summary, unless the model goes on after it.
  db.run(state.db(), "UPDATE runs SET turn_tokens=?1 WHERE id=?2 AND turn_tokens IS NOT NULL", tokens, run.id);
  set_tokens(state, task_id, tokens, null);
}

/**
 * Where a compaction in `run` came from (see db::SCHEMA_V69): the agent's own (`trigger` `auto`), the board's after a
 * session sat idle (a `/compact` run that no user message started, see runner::compact) or the user's.
 */
function compaction_source(c: Conn, run: Run, trigger: string): string {
  if (trigger === "auto") return "auto";
  const prompted = history.user_messaged_since(c, run.task_id, run.created_at);
  return run.kind === "compact" && !prompted ? "idle" : "user";
}

function record_compaction(state: Shared, run: Run, meta: any, before: Context | null): void {
  const c = state.db();
  const source = compaction_source(c, run, typeof meta?.trigger === "string" ? meta.trigger : "");
  // Codex doesn't say how big the context was: it's the latest count.
  const tokens = i64(meta?.pre_tokens) ?? (before ? before.tokens : null);
  db.run(
    c,
    `INSERT INTO context_stats (task_id, run_id, kind, at, tokens, post_tokens, max_tokens, model, source, duration_ms)
         VALUES (?1, ?2, 'compact', ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
    run.task_id,
    run.id,
    now(),
    tokens,
    i64(meta?.post_tokens),
    before?.max_tokens ?? null,
    before?.model ?? null,
    source,
    i64(meta?.duration_ms),
  );
}

/**
 * The end of one of the agent's turns: how big a context it started from (its first request to the model) and leaves
 * (what the next prompt starts from), and what it cost, if the agent says. Only for a turn the model answered (not a
 * `/compact`): those are what `turn_usage` follows, while the task's context also changes with breakdowns and
 * compactions.
 */
export function record_turn(state: Shared, run: Run, cost_usd: number | null): void {
  if (run.kind === "compact") return;
  const c = state.db();
  const turn = db.one(c, "SELECT turn_start_tokens, turn_tokens FROM runs WHERE id=?1", run.id);
  if (!turn) throw new Error("Query returned no rows");
  db.run(c, "UPDATE runs SET turn_start_tokens=NULL, turn_tokens=NULL WHERE id=?1", run.id);
  const start: number | null = turn.turn_start_tokens ?? null;
  const end: number | null = turn.turn_tokens ?? null;
  if (end === null) return;
  const ctx = current(state, run.task_id) ?? db.Context_default();
  db.run(
    state.db(),
    "INSERT INTO context_stats (task_id, run_id, kind, at, tokens, start_tokens, max_tokens, model, cost_usd) VALUES (?1, ?2, 'turn', ?3, ?4, ?5, ?6, ?7, ?8)",
    run.task_id,
    run.id,
    now(),
    end,
    start,
    ctx.max_tokens,
    ctx.model,
    cost_usd,
  );
}

function set_tokens(state: Shared, task_id: string, tokens: number, max_tokens: number | null): void {
  const old = current(state, task_id);
  const ctx: Context = old ? { ...old } : db.Context_default();
  ctx.tokens = tokens;
  ctx.max_tokens = max_tokens ?? ctx.max_tokens;
  // One reply comes as several messages with the same usage.
  if (old && old.tokens === ctx.tokens && old.max_tokens === ctx.max_tokens) return;
  ctx.updated_at = now();
  save(state, task_id, ctx, null);
}

/** The model's context window, from a Claude Code `result`'s `modelUsage`, until a breakdown says it. */
export function on_result(state: Shared, task_id: string, v: any): void {
  const cur = current(state, task_id);
  if (!cur) return;
  const ctx = { ...cur };
  if (ctx.max_tokens !== null) return;
  const models = v?.modelUsage;
  if (models === null || typeof models !== "object" || Array.isArray(models)) return;
  let window: number | null;
  if (ctx.model !== null && Object.hasOwn(models, ctx.model)) {
    window = u64(models[ctx.model]?.contextWindow);
  } else {
    // Otherwise the biggest: subagents may have run on smaller models.
    const all = Object.values(models).map((m: any) => u64(m?.contextWindow)).filter((w): w is number => w !== null);
    window = all.length ? Math.max(...all) : null;
  }
  if (window === null) return;
  ctx.max_tokens = window;
  save(state, task_id, ctx, null);
}

/** Ask the agent for the (summary) breakdown of its context, if it still takes input. It answers once it's dealt with what it was sent before, even if its input is closed right after. */
export function request(state: Shared, run: Run): void {
  const line = { type: "control_request", request_id: `${REQUEST_PREFIX}${new_id()}`, request: { subtype: "get_context_usage", detail: "summary" } };
  try {
    runs.write_input(state, run.id, JSON.stringify(line));
  } catch (e) {
    console.warn(`run ${run.id}: asking for the context breakdown: ${err_str(e)}`);
  }
}

/** A `control_response`: the breakdown, if it answers `request`. */
export function on_control_response(state: Shared, task_id: string, v: any): void {
  const r = v?.response;
  if (!(typeof r?.request_id === "string" && r.request_id.startsWith(REQUEST_PREFIX))) return;
  // Claude Code versions without it say so; the token count still works.
  if (r.subtype !== "success") return;
  const resp = r.response;
  if (resp === null || typeof resp !== "object" || Array.isArray(resp)) return;
  const detail = { ...resp };
  // The board draws its own grid from the categories.
  delete detail.gridRows;
  const ctx: Context = { ...(current(state, task_id) ?? db.Context_default()) };
  const total = u64(detail.totalTokens);
  if (total !== null) ctx.tokens = total;
  ctx.max_tokens = u64(detail.maxTokens) ?? ctx.max_tokens;
  ctx.compact_at = detail.isAutoCompactEnabled === false ? null : u64(detail.autoCompactThreshold);
  if (typeof detail.model === "string") ctx.model = detail.model;
  const ts = now();
  ctx.updated_at = ts;
  ctx.detail_at = ts;
  save(state, task_id, ctx, JSON.stringify(detail));
}

/** Forget the session's context, when the thread starts a new one. */
export function clear(state: Shared, task_id: string): void {
  state.update_task(task_id, [
    ["context", null],
    ["context_detail", null],
  ]);
}

/**
 * `GET /tasks/{id}/context`: the summary on the task and the latest breakdown (shaped like Claude Code's
 * `get_context_usage` response, without `gridRows`), each null if there's none.
 */
export async function get(s: AppState, r: Req): Promise<any> {
  const id = r.params.id;
  const c = s.db();
  const task = db.get_task(c, id);
  if (!task) throw ApiError.not_found("task");
  const raw = db.value<string | null>(c, "SELECT context_detail FROM tasks WHERE id=?1", id) ?? null;
  let detail: any = null;
  if (raw !== null) {
    try {
      detail = JSON.parse(raw);
    } catch {}
  }
  return { context: task.context, detail };
}
