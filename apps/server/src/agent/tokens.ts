// Port of server/src/agent/tokens.rs.
/**
 * The tokens each run used, per model, for statistics (`GET /profiles/{id}/token-stats`, see
 * analytics.rs), in `token_usage` (see db::SCHEMA_V79).
 *
 * They're counted from the run's output (`runs/<id>/out.jsonl`) once it has ended, rather than as
 * it streams in, so runs from before this was kept are counted the same way while their folders
 * are kept (see runs::KEEP_DAYS): at startup, and before each prune (see runs::start_pruner).
 *
 * - Claude Code's `result` at the end of each turn has `modelUsage`: the session's totals for each
 *   model so far, its subagents' included. Like its `total_cost_usd` (see db::add_cost), they go
 *   on over the runs that resume the session, so a run used what they went up by: from its task's
 *   latest earlier run in the session (`usage_session`, `usage_snapshot`), or from nothing in a
 *   new session or one whose totals went down (Claude Code started counting again). A run's cost
 *   is also what the board charged it: one counted from nothing because its earlier runs' output
 *   was gone is scaled down to that, and estimated. Requests after a run's last `result` are
 *   counted from their own messages (see `count_claude`).
 * - Codex's `thread/tokenUsage/updated` has each thread's totals (subagents' threads are their
 *   own) and its latest request's (`last`). Threads keep their totals when they're resumed, so a
 *   run used what they went up by too. A thread whose earlier totals aren't known, or that went
 *   down (rolled back), adds just its latest request. Codex counts cached input as part of the
 *   input: here `input_tokens` is what wasn't cached, as for Claude. The model is the one the
 *   adapter says it started the thread with (`huntaway/model`), else the run's, else the one the
 *   thread's rollout file says, else the task's; a subagent's thread's is the one it was spawned
 *   with, when that's in the run's output.
 * - A run whose folder is gone gets a row with what it cost and no tokens, `estimated`.
 *
 * Rust's `BTreeMap<String, Counts>` is a `Counts` record here, with its keys sorted where the order shows.
 */
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync } from "node:fs";
import { join } from "node:path";
import * as db from "../db.ts";
import { run_dir } from "./runs.ts";
import type { Shared } from "../state.ts";
import { err_str, expand_tilde, now } from "../util.ts";

export * from "./tokens/calls.ts";

/** What a model used, as totals or as what they went up by. */
export interface Counts {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  reasoning: number;
  cost: number;
}

export type ByModel = Record<string, Counts>;

export function Counts_default(fields: Partial<Counts> = {}): Counts {
  return { input: 0, output: 0, cache_read: 0, cache_write: 0, reasoning: 0, cost: 0, ...fields };
}

/** Counts read back from a saved snapshot (serde's defaults for missing fields). */
function Counts_from_json(v: any): Counts {
  const n = (k: string) => (typeof v?.[k] === "number" ? v[k] : 0);
  return { input: n("input"), output: n("output"), cache_read: n("cache_read"), cache_write: n("cache_write"), reasoning: n("reasoning"), cost: n("cost") };
}

export function total(c: Counts): number {
  return c.input + c.output + c.cache_read + c.cache_write;
}

/** The tokens fed in, which a Claude Code request's message has in full (its output count can be short). */
export function fed(c: Counts): number {
  return c.input + c.cache_read + c.cache_write;
}

/** Whether every count is at least `o`'s: the same totals, gone on from there. */
export function covers(c: Counts, o: Counts): boolean {
  return c.input >= o.input && c.output >= o.output && c.cache_read >= o.cache_read && c.cache_write >= o.cache_write;
}

export function minus(c: Counts, o: Counts): Counts {
  return {
    input: c.input - o.input,
    output: c.output - o.output,
    cache_read: c.cache_read - o.cache_read,
    cache_write: c.cache_write - o.cache_write,
    reasoning: Math.max(c.reasoning - o.reasoning, 0),
    cost: Math.max(c.cost - o.cost, 0),
  };
}

export function add(c: Counts, o: Counts) {
  c.input += o.input;
  c.output += o.output;
  c.cache_read += o.cache_read;
  c.cache_write += o.cache_write;
  c.reasoning += o.reasoning;
  c.cost += o.cost;
}

/** Rust's `f64::round` (half away from zero). */
const round = (x: number) => Math.sign(x) * Math.round(Math.abs(x));

export function scale(c: Counts, f: number) {
  c.input = round(c.input * f);
  c.output = round(c.output * f);
  c.cache_read = round(c.cache_read * f);
  c.cache_write = round(c.cache_write * f);
  c.reasoning = round(c.reasoning * f);
  c.cost *= f;
}

const int = (v: any) => (Number.isInteger(v) ? (v as number) : 0);

/** One model's part of a Claude Code `modelUsage`. */
export function Counts_from_claude(m: any): Counts {
  return {
    input: int(m?.inputTokens),
    output: int(m?.outputTokens),
    cache_read: int(m?.cacheReadInputTokens),
    cache_write: int(m?.cacheCreationInputTokens),
    reasoning: int(m?.thinkingTokens),
    cost: typeof m?.costUSD === "number" ? m.costUSD : 0,
  };
}

/** A Codex `tokenUsage`'s `total` or `last`. */
export function Counts_from_codex(u: any): Counts {
  return {
    input: Math.max(int(u?.inputTokens) - int(u?.cachedInputTokens), 0),
    output: int(u?.outputTokens),
    cache_read: int(u?.cachedInputTokens),
    cache_write: int(u?.cacheWriteInputTokens),
    reasoning: int(u?.reasoningOutputTokens),
    cost: 0,
  };
}

const counts_eq = (a: Counts, b: Counts) =>
  a.input === b.input && a.output === b.output && a.cache_read === b.cache_read && a.cache_write === b.cache_write && a.reasoning === b.reasoning && a.cost === b.cost;

/** `m`'s entry for `k`, made (zero) if there's none (`entry(k).or_default()`). */
function at(m: ByModel, k: string): Counts {
  return (m[k] ??= Counts_default());
}

/** `m` with its keys sorted (a BTreeMap's order). */
export function sorted<T>(m: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const k of Object.keys(m).sort()) out[k] = m[k];
  return out;
}

const copy = (m: ByModel): ByModel => Object.fromEntries(Object.entries(m).map(([k, c]) => [k, { ...c }]));
const is_empty = (m: object) => Object.keys(m).length === 0;

/** What a run used, by model, and the totals its agent's session (`session`) or threads had reached. */
export interface Counted {
  runtime: string;
  models: ByModel;
  session: string | null;
  snapshot: ByModel;
  /** The part of `snapshot` a Claude Code run's requests after its last `result` add, counted from their own usage (see `count_claude`). */
  tail: ByModel;
  /** Some of it is a guess (see the module's docs). */
  estimated: boolean;
}

function Counted_new(runtime: string): Counted {
  return { runtime, models: {}, session: null, snapshot: {}, tail: {}, estimated: false };
}

/**
 * The totals a run's agent started from: its task's latest earlier counted run's for session (or
 * thread) `key`, and the part of them that run's requests after its last `result` add.
 */
export type Earlier = (key: string) => Before | null;

export interface Before {
  totals: ByModel;
  tail: ByModel;
}

/** One Claude Code request's usage, from an `assistant` message (`v`), and its model and id. */
function request_usage(v: any): [string, string, Counts] | null {
  const m = v?.message;
  const model = m?.model;
  if (typeof model !== "string" || model.startsWith("<")) return null;
  if (typeof m.id !== "string") return null;
  const u = m.usage;
  const c = Counts_default({
    input: int(u?.input_tokens),
    output: int(u?.output_tokens),
    cache_read: int(u?.cache_read_input_tokens),
    cache_write: int(u?.cache_creation_input_tokens),
  });
  return [m.id, model, c];
}

/**
 * The requests Claude Code `assistant` messages (`lines`) are of, by id, with their model: each request once, though its
 * message comes once for each content block, with the most output any of them says.
 */
function requests_of(lines: string[]): Map<string, [string, Counts]> {
  const requests = new Map<string, [string, Counts]>();
  for (const line of lines) {
    let v: any;
    try {
      v = JSON.parse(line);
    } catch {
      continue;
    }
    if (v?.type !== "assistant") continue;
    const r = request_usage(v);
    if (!r) continue;
    const [id, model, c] = r;
    const have = requests.get(id);
    if (have) have[1].output = Math.max(have[1].output, c.output);
    else requests.set(id, [model, c]);
  }
  for (const [id, [, c]] of requests) if (total(c) <= 0) requests.delete(id);
  return new Map([...requests].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/**
 * Whether Claude Code didn't keep an earlier run's tail in a session's `totals`, which go on from both the totals with it
 * (`with`) and those without it (`without`): which of them the requests the run made before its first result (`made`) are
 * closer to having fed in, on the models the tail used. A guess (`estimated`) unless one is exact: the totals also have
 * requests that print no message.
 */
function tail_was_lost(totals: ByModel, with_: ByModel, without: ByModel, made: Map<string, [string, Counts]>, out: { estimated: boolean }): boolean {
  const tail_models = Object.keys(with_).filter((m) => !(m in without) || !counts_eq(without[m], with_[m]));
  const zero = Counts_default();
  const fed_since = (from: ByModel) => tail_models.reduce((sum, m) => sum + fed(minus(totals[m] ?? zero, from[m] ?? zero)), 0);
  const [from_with, from_without] = [fed_since(with_), fed_since(without)];
  let f = 0;
  for (const [m, c] of made.values()) if (tail_models.includes(m)) f += fed(c);
  if (f !== from_with && f !== from_without) out.estimated = true;
  return Math.abs(from_without - f) < Math.abs(from_with - f);
}

/**
 * What a Claude Code run used, from its output's lines.
 *
 * Requests after the run's last `result` (a turn stopped, or a run that failed or was killed
 * before its result) aren't in any totals: they're counted from their `assistant` messages' own
 * usage, each request once (its message comes once for each content block), subagents' included,
 * and estimated (a message's output count can be short of the request's). They go in the
 * session's totals too, as `tail`: Claude Code keeps them in its totals if it saved them as the
 * run ended, so a run that resumes the session goes on from the totals with them, or else from
 * the totals without them; when its totals go on from both, its own requests before its first
 * result say which (see `tail_was_lost`). A run with no result at all goes on from its earlier run's totals,
 * and its tail adds to that run's.
 */
export function count_claude(lines: Iterable<string>, earlier: Earlier): Counted {
  const out = Counted_new("claude");
  let session: string | null = null;
  // The session the totals in `out.snapshot` are for, and those totals without the earlier
  // run's tail, if it had one.
  let base_session: string | null = null;
  let have_base = false;
  let without_tail: ByModel | null = null;
  // The assistant messages since the latest result, which no result's totals have.
  let since: string[] = [];
  for (const line of lines) {
    const assistant = line.includes('"assistant"');
    const other = line.includes('"result"') || line.includes('"init"');
    if (!other) {
      // Read once it's known whether a result comes after it.
      if (assistant) since.push(line);
      continue;
    }
    let v: any;
    try {
      v = JSON.parse(line);
    } catch {
      continue;
    }
    if (v?.type === "assistant") {
      since.push(line);
      continue;
    }
    if (v?.type === "system" && v.subtype === "init") {
      if (typeof v.session_id === "string") session = v.session_id;
      continue;
    }
    if (v?.type !== "result") continue;
    const usage = v.modelUsage;
    if (!usage || typeof usage !== "object" || Array.isArray(usage) || is_empty(usage)) continue;
    const made = requests_of(since);
    since = [];
    const sid: string | null = typeof v.session_id === "string" ? v.session_id : session;
    if (!have_base || base_session !== sid) {
      const before: Before = (sid !== null ? earlier(sid) : null) ?? { totals: {}, tail: {} };
      if (!is_empty(before.tail)) {
        const t = copy(before.totals);
        for (const [m, tail] of Object.entries(before.tail)) if (t[m]) t[m] = minus(t[m], tail);
        // A model only the tail used isn't in totals that don't have it.
        for (const m of Object.keys(t)) if (total(t[m]) <= 0) delete t[m];
        without_tail = t;
      } else without_tail = null;
      out.snapshot = copy(before.totals);
      base_session = sid;
      have_base = true;
    }
    const totals: ByModel = {};
    for (const m of Object.keys(usage).sort()) totals[m] = Counts_from_claude(usage[m]);
    const covered = (before: ByModel) => Object.entries(before).every(([m, b]) => totals[m] !== undefined && covers(totals[m], b));
    const t = without_tail;
    without_tail = null;
    if (t !== null && covered(t) && (!covered(out.snapshot) || tail_was_lost(totals, out.snapshot, t, made, out))) {
      // Claude Code didn't keep the earlier run's tail: the totals don't go on from it, or they go on from both and
      // the run's own requests say which.
      out.snapshot = t;
    } else if (!covered(out.snapshot)) {
      // Counting started again: a model it had is gone, or went down.
      out.snapshot = {};
    }
    for (const [model, n] of Object.entries(totals)) add(at(out.models, model), minus(n, out.snapshot[model] ?? Counts_default()));
    out.snapshot = totals;
    out.session = sid;
  }
  // The requests after the last result.
  const requests = requests_of(since);
  // No result set where the session's totals were: the run's requests go on from its earlier
  // run's (and from its tail, if that had one too, which a run that resumes it may not find).
  if (requests.size && !have_base) {
    const before = session !== null ? earlier(session) : null;
    if (before) {
      out.snapshot = copy(before.totals);
      out.tail = copy(before.tail);
    }
    out.session = session;
  }
  for (const [model, c] of requests.values()) {
    out.estimated = true;
    add(at(out.models, model), c);
    add(at(out.snapshot, model), c);
    add(at(out.tail, model), c);
  }
  for (const m of Object.keys(out.models)) if (!(total(out.models[m]) > 0 || out.models[m].cost > 0)) delete out.models[m];
  out.models = sorted(out.models);
  out.snapshot = sorted(out.snapshot);
  out.tail = sorted(out.tail);
  return out;
}

/**
 * What a Codex run used, from its output's lines, with `model` unless the output names it. A
 * subagent's thread counts towards the model it was started with, if its start says (Codex's
 * `collabAgentToolCall` spawning it, or its `subAgentActivity`), else the run's.
 */
export function count_codex(lines: Iterable<string>, model: string, earlier: Earlier): Counted {
  const out = Counted_new("codex");
  // Threads' models, where they're known, and what each thread used.
  const models = new Map<string, string>();
  const used: Array<[string, Counts]> = [];
  for (const line of lines) {
    const starts = line.includes("collabAgentToolCall") || line.includes("subAgentActivity");
    if (!starts && !line.includes("thread/tokenUsage/updated") && !line.includes("huntaway/model")) continue;
    let v: any;
    try {
      v = JSON.parse(line);
    } catch {
      continue;
    }
    const p = v?.params ?? {};
    if (v?.method === "huntaway/model") {
      if (typeof p.model === "string" && p.model !== "") model = p.model;
      continue;
    }
    const item = p.item ?? {};
    const started = (m: any) => (typeof m === "string" && m !== "" ? m : null);
    if (item.type === "collabAgentToolCall" && item.tool === "spawnAgent") {
      const m = started(item.model);
      if (m !== null) for (const t of Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds : []) if (typeof t === "string") models.set(t, m);
      continue;
    }
    if (item.type === "subAgentActivity") {
      const m = started(item.model);
      if (typeof item.agentThreadId === "string" && m !== null) models.set(item.agentThreadId, m);
      continue;
    }
    if (v?.method !== "thread/tokenUsage/updated") continue;
    const thread = p.threadId;
    if (typeof thread !== "string") continue;
    const tot = Counts_from_codex(p.tokenUsage?.total);
    const last = Counts_from_codex(p.tokenUsage?.last);
    if (!(thread in out.snapshot)) {
      const before = earlier(thread)?.totals?.[thread];
      if (before) out.snapshot[thread] = { ...before };
    }
    const before = out.snapshot[thread];
    let added: Counts;
    if (before !== undefined) added = covers(tot, before) ? minus(tot, before) : last; // Rolled back, if it doesn't cover them.
    else added = total(tot) === total(last) ? tot : last; // Its earlier totals aren't known.
    used.push([thread, added]);
    out.snapshot[thread] = tot;
  }
  // Once the run's own model is known (the adapter says it as the thread starts).
  for (const [thread, added] of used) add(at(out.models, models.get(thread) ?? model), added);
  for (const m of Object.keys(out.models)) if (!(total(out.models[m]) > 0)) delete out.models[m];
  out.models = sorted(out.models);
  out.snapshot = sorted(out.snapshot);
  return out;
}

/** Lines of a file, or none if it can't be read (read a chunk at a time, as `BufRead::lines`). */
export function* lines_of(path: string): Generator<string> {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return;
  }
  try {
    const buf = Buffer.allocUnsafe(1 << 16);
    let pending: Buffer[] = [];
    let pos = 0;
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, pos);
      if (n === 0) break;
      pos += n;
      let start = 0;
      for (;;) {
        const nl = buf.indexOf(0x0a, start);
        if (nl < 0 || nl >= n) break;
        pending.push(Buffer.from(buf.subarray(start, nl)));
        let line = Buffer.concat(pending).toString("utf8");
        pending = [];
        if (line.endsWith("\r")) line = line.slice(0, -1);
        yield line;
        start = nl + 1;
      }
      if (start < n) pending.push(Buffer.from(buf.subarray(start, n)));
    }
    if (pending.length) {
      let line = Buffer.concat(pending).toString("utf8");
      if (line.endsWith("\r")) line = line.slice(0, -1);
      yield line;
    }
  } finally {
    closeSync(fd);
  }
}

interface RunRow {
  id: string;
  task_id: string;
  rowid: number;
  cost_usd: number;
  created_at: string;
}

const warn = (...a: any[]) => console.error(new Date().toISOString(), " WARN tokens:", ...a);

/**
 * Count the runs that have ended and haven't been counted (only `task_id`'s, if given), oldest
 * first for each task, so each goes on from its task's earlier runs. Returns how many it counted.
 * (Synchronous, so two counts can't interleave: Rust holds a lock for it.)
 */
export function count_pending(state: Shared, task_id: string | null): number {
  const runs = db.all<RunRow>(
    state.db(),
    `SELECT id, task_id, rowid, cost_usd, created_at FROM runs WHERE status='exited' AND usage_at IS NULL AND (?1 IS NULL OR task_id=?1)
     ORDER BY task_id, rowid`,
    task_id,
  );
  for (const run of runs) {
    try {
      count_run(state, run);
    } catch (e) {
      warn(`run=${run.id} counting the run's tokens: ${err_str(e)}`);
      // So it isn't tried again and again.
      db.run(state.db(), "UPDATE runs SET usage_at=?1 WHERE id=?2", now(), run.id);
    }
  }
  return runs.length;
}

function count_run(state: Shared, run: RunRow) {
  const dir = run_dir(state, run.id);
  const out_file = join(dir, "out.jsonl");
  // The totals the task's latest earlier counted run had reached for a session or thread.
  const earlier: Earlier = (key) => {
    let snap: any;
    try {
      snap = db.one(
        state.db(),
        `SELECT usage_snapshot, usage_tail FROM runs WHERE task_id=?1 AND rowid < ?2 AND usage_snapshot IS NOT NULL
           AND (usage_session=?3 OR (usage_session IS NULL AND instr(usage_snapshot, ?4) > 0))
         ORDER BY rowid DESC LIMIT 1`,
        run.task_id,
        run.rowid,
        key,
        `"${key}"`,
      );
    } catch {
      return null;
    }
    if (!snap) return null;
    let totals: ByModel;
    try {
      totals = by_model(JSON.parse(snap.usage_snapshot));
    } catch {
      return null;
    }
    let tail: ByModel = {};
    try {
      if (snap.usage_tail != null) tail = by_model(JSON.parse(snap.usage_tail));
    } catch {}
    return { totals, tail };
  };
  let counted: Counted;
  if (!existsSync(out_file)) {
    counted = estimate(state, run);
  } else if (existsSync(join(dir, "codex.json"))) {
    counted = count_codex(lines_of(out_file), codex_model(state, run, dir), earlier);
  } else {
    counted = count_claude(lines_of(out_file), earlier);
    // More than the board charged the run: it was counted from nothing, its session's earlier
    // runs' totals being gone.
    const cost = Object.values(counted.models).reduce((s, c) => s + c.cost, 0);
    if (run.cost_usd > 0 && cost > run.cost_usd * 1.05 + 0.01) {
      const f = run.cost_usd / cost;
      for (const c of Object.values(counted.models)) scale(c, f);
      counted.estimated = true;
    }
  }
  save(state, run.id, counted);
}

/** A saved snapshot's models (it must be an object of them). */
function by_model(v: any): ByModel {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("not a map");
  const out: ByModel = {};
  for (const [m, c] of Object.entries(v)) out[m] = Counts_from_json(c);
  return out;
}

/** A run whose output is gone: what it cost, on the model its turns or its task say. */
function estimate(state: Shared, run: RunRow): Counted {
  const c = state.db();
  const out = Counted_new("claude");
  out.estimated = true;
  const task = db.get_task(c, run.task_id);
  let cfg: db.ClaudeConfig | null = null;
  try {
    cfg = task ? db.task_claude_config(c, task) : null;
  } catch {}
  if (cfg && db.is_codex(cfg)) out.runtime = "codex";
  if (run.cost_usd <= 0) return out;
  const model: string | undefined = db.value(c, "SELECT model FROM context_stats WHERE run_id=?1 AND model IS NOT NULL ORDER BY id DESC LIMIT 1", run.id);
  out.models[model ?? task?.model ?? "unknown"] = Counts_default({ cost: run.cost_usd });
  return out;
}

function read_json(path: string): any {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** The model a Codex run's thread was started with, before its output says (see the module's docs). */
function codex_model(state: Shared, run: RunRow, dir: string): string {
  const spec = read_json(join(dir, "codex.json"));
  if (typeof spec?.model === "string" && spec.model !== "") return spec.model;
  const launch = read_json(join(dir, "spec.json"));
  let thread: string | null = typeof spec?.thread_id === "string" ? spec.thread_id : null;
  if (thread === null) {
    for (const l of lines_of(join(dir, "out.jsonl"))) {
      if (!l.includes("thread/started")) continue;
      try {
        const id = JSON.parse(l)?.params?.thread?.id;
        if (typeof id === "string") {
          thread = id;
          break;
        }
      } catch {}
    }
  }
  const config_dir = typeof launch?.config_dir === "string" ? launch.config_dir : "~/.codex";
  if (thread !== null) {
    const m = rollout_model(expand_tilde(config_dir), thread, run.created_at);
    if (m !== null) return m;
  }
  let task: db.Task | null = null;
  try {
    task = db.get_task(state.db(), run.task_id);
  } catch {}
  return task?.model ?? "codex";
}

/**
 * The model in Codex's rollout file for `thread` (`sessions/YYYY/MM/DD/rollout-…-<thread>.jsonl`
 * under its config folder), looked for in the days around `at`, the run's start.
 */
function rollout_model(config_dir: string, thread: string, at: string): string | null {
  const t = Date.parse(at);
  if (Number.isNaN(t)) return null;
  const suffix = `-${thread}.jsonl`;
  const pad = (n: number) => String(n).padStart(2, "0");
  for (const days of [0, -1, 1]) {
    // In local time, as chrono's `Local`.
    const day = new Date(t + days * 86400_000);
    const folder = join(config_dir, "sessions", String(day.getFullYear()), pad(day.getMonth() + 1), pad(day.getDate()));
    let names: string[];
    try {
      names = readdirSync(folder);
    } catch {
      continue;
    }
    const file = names.find((n) => join(folder, n).endsWith(suffix));
    if (file === undefined) continue;
    for (const l of lines_of(join(folder, file))) {
      if (!l.includes('"turn_context"')) continue;
      try {
        const m = JSON.parse(l)?.payload?.model;
        if (typeof m === "string") return m;
      } catch {}
    }
    return null;
  }
  return null;
}

function save(state: Shared, run_id: string, counted: Counted) {
  const c = state.db();
  db.tx(c, () => {
    // Counted already, by a count that started before this one finished: leave it.
    const pending = db.value<number>(c, "SELECT usage_at IS NULL FROM runs WHERE id=?1", run_id);
    if (!pending) return;
    for (const [model, n] of Object.entries(counted.models)) {
      db.run(
        c,
        `INSERT OR REPLACE INTO token_usage (run_id, model, runtime, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, cost_usd, estimated)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)`,
        run_id,
        model,
        counted.runtime,
        n.input,
        n.output,
        n.cache_read,
        n.cache_write,
        n.reasoning,
        counted.runtime === "claude" ? n.cost : null,
        counted.estimated,
      );
    }
    const snapshot = is_empty(counted.snapshot) ? null : JSON.stringify(sorted(counted.snapshot));
    const tail = is_empty(counted.tail) ? null : JSON.stringify(sorted(counted.tail));
    db.run(c, "UPDATE runs SET usage_at=?1, usage_session=?2, usage_snapshot=?3, usage_tail=?4 WHERE id=?5", now(), counted.session, snapshot, tail, run_id);
  });
}

/** A run of `task_id` ended: count it, and any of the task's before it, in the background. */
export function on_run_ended(state: Shared, task_id: string) {
  setImmediate(() => {
    try {
      count_pending(state, task_id);
    } catch (e) {
      warn(`task=${task_id} counting tokens: ${err_str(e)}`);
    }
  });
}
