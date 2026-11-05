// Port of server/src/agent/usage.rs.
/**
 * Subscription usage (session and weekly limits) for each Claude config. Codex configs get
 * theirs from `codex app-server` (see agent/codex.ts).
 *
 * Two sources feed it: Anthropic's OAuth usage endpoint (what `/usage` in Claude Code shows),
 * called with the config's own login, and the `rate_limit_event`s agents print as they run.
 * The login is only read, never refreshed: refreshing rotates the token underneath any
 * `claude` running with the config. An expired login refreshes on the config's next run.
 *
 * Only configs with `show_usage` turned on are fetched and listed. The endpoint's rate limit is
 * per account, and every host with a copy of the login (PR previews, test servers) would
 * otherwise poll it too.
 *
 * A config with a proxy (CLIProxyAPI, see `ClaudeConfig::api_url`) pools several logins, none of
 * them in its directory. Its usage is each of the proxy's Claude accounts' (asked for through
 * the proxy's management API, with each account's own token, see `fetch_proxy`), and its limits
 * are the pool's: each limit's average over the accounts, resetting when the first of them does
 * (see `pool_limits`). Its runs' `rate_limit_event`s are about whichever account served them, so
 * they don't change its limits, only whether it's out (the proxy only passes a refusal on once
 * every account it could try has refused).
 *
 * A config is *out* when a run on it was refused for its usage limit (Claude Code's
 * `rate_limit_event` with status `rejected`, Codex's `usageLimitExceeded`), until that limit
 * resets. Usage at 100% alone doesn't make it out: a plan with extra usage carries on past it.
 * A run that stops on its limit leaves the reset on its task (`Task::limit_reset_at`), and its
 * profile's `limit_wait` and `limit_switch` say what the board does about it (see `before_run`
 * and `resume_loop`).
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import * as db from "../db.ts";
import { ApiError, type Req } from "../http.ts";
import type { Shared } from "../state.ts";
import { err_str, expand_tilde, now } from "../util.ts";
import * as codex from "./codex.ts";
import * as runner from "./runner.ts";
import * as runs from "./runs.ts";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
/** How long a fetched snapshot is good for before a plain `GET /usage` fetches again (a little under the UI's 5-minute poll). */
const MAX_AGE = 4 * 60_000;
/** Minimum gap between fetches for one config, even when a refresh is asked for. */
const MIN_GAP = 30_000;

const log = {
  debug: (..._a: any[]) => {},
  warn: (...a: any[]) => console.error(new Date().toISOString(), " WARN usage:", ...a),
};

export interface Limit {
  /** `session`, `weekly`, or `weekly:<model>`. */
  id: string;
  label: string;
  /** 0–100, how much of the limit is used. */
  percent: number;
  resets_at: string | null;
}

export interface Usage {
  config_id: string;
  limits: Limit[];
  /** Plan from the login, e.g. `max`, `pro`. */
  plan: string | null;
  /** When `limits` was last updated (by a fetch or an agent run). */
  updated_at: string | null;
  /** Why the last fetch didn't work; `limits` may still hold older numbers. */
  error: string | null;
  /**
   * Until when the config is out of usage (API 81): when the limit a run on it was refused
   * for resets. Kept in memory, so a restart forgets it until a run is refused again.
   */
  out_until: string | null;
  /**
   * For a config with a proxy (API 106): each of the proxy's Claude accounts, whose limits
   * `limits` pools. Left out for other configs.
   */
  accounts?: Account[];
  /** When it was last fetched (`performance.now()`); not serialized. */
  fetched?: number;
}

/** One of a proxy's Claude accounts (API 106). */
export interface Account {
  /** Its email, or the proxy's name for it. */
  name: string;
  limits: Limit[];
  /** Why its usage couldn't be read, or why the proxy isn't using it. */
  error: string | null;
}

/** `Usage { config_id, ..Default::default() }`. `fetched` is kept out of its JSON. */
export function Usage_new(config_id: string): Usage {
  const u: Usage = { config_id, limits: [], plan: null, updated_at: null, error: null, out_until: null };
  Object.defineProperty(u, "fetched", { value: undefined, writable: true, configurable: true, enumerable: false });
  return u;
}

/** A copy of `u` as serde serializes it (`accounts` left out when there are none). */
function usage_clone(u: Usage): Usage {
  const c: Usage = { config_id: u.config_id, limits: u.limits.map((l) => ({ ...l })), plan: u.plan, updated_at: u.updated_at, error: u.error, out_until: u.out_until };
  if (u.accounts) c.accounts = structuredClone(u.accounts);
  return c;
}

/** Replace or add limits by id, keeping the ones `new` doesn't mention. */
export function merge(u: Usage, fresh: Limit[]) {
  for (const l of fresh) {
    const i = u.limits.findIndex((x) => x.id === l.id);
    if (i >= 0) u.limits[i] = l;
    else u.limits.push(l);
  }
  const key = (l: Limit): [number, number, string] => [l.id !== "session" ? 1 : 0, l.id !== "weekly" ? 1 : 0, l.id];
  u.limits.sort((a, b) => {
    const [x, y] = [key(a), key(b)];
    return x[0] - y[0] || x[1] - y[1] || (x[2] < y[2] ? -1 : x[2] > y[2] ? 1 : 0);
  });
}

/** The cache entry for `config_id`, made if there's none. */
function entry(s: Shared, config_id: string): Usage {
  let u = s.usage.get(config_id) as Usage | undefined;
  if (!u) {
    u = Usage_new(config_id);
    s.usage.set(config_id, u);
  }
  return u;
}

/** `GET /usage`: every config on this host that shows its usage, fetching ones that are stale. */
export async function list(s: Shared, r: Req): Promise<any> {
  const refresh_asked = r.query.refresh === "true";
  const configs = db.list_claude_configs(s.db()).filter((c) => c.show_usage);
  const due = configs.filter((p) => {
    const fetched = (s.usage.get(p.id) as Usage | undefined)?.fetched;
    return fetched === undefined || performance.now() - fetched >= (refresh_asked ? MIN_GAP : MAX_AGE);
  });
  await Promise.all(due.map((c) => refresh(s, c)));
  return configs.map((c) => (s.usage.get(c.id) as Usage | undefined) ?? Usage_new(c.id));
}

/** Fetch the config's usage now: whether that worked (the last numbers stay if it didn't). */
export async function refresh(s: Shared, config: db.ClaudeConfig): Promise<boolean> {
  const config_id = config.id;
  let accounts: Account[] | undefined;
  let result: [string | null, Limit[]] | null = null;
  let error: string | null = null;
  try {
    const url = db.proxy(config);
    if (url !== null) {
      const a = await fetch_proxy(url, config.management_key ?? null);
      result = [`${a.length} account${a.length === 1 ? "" : "s"}`, pool_limits(a)];
      accounts = a;
    } else if (db.is_codex(config)) {
      const t = TEST_CODEX.get();
      if (t === null) throw new Error("no codex in tests");
      result = t !== undefined ? [null, codex.limits(t)] : await codex.rate_limits(db.dir(config));
    } else {
      result = await fetch(config.config_dir);
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  const u = entry(s, config_id);
  u.fetched = performance.now();
  if (result) {
    // A fresh fetch is the whole picture: drop limits it no longer reports.
    u.limits = [];
    merge(u, result[1]);
    u.plan = result[0];
    if (accounts) u.accounts = accounts;
    else delete u.accounts;
    u.updated_at = now();
    u.error = null;
    return true;
  }
  log.debug(`config=${config_id} usage fetch failed: ${error}`);
  u.error = error;
  return false;
}

/**
 * The config's session (5-hour) limit as last seen: undefined when its usage has none, else when it
 * resets (ms since the epoch), or null when that isn't known, as when no window is running.
 * (Rust's `Option<Option<DateTime>>`.)
 */
export function session_reset(s: Shared, config_id: string): number | null | undefined {
  const limit = (s.usage.get(config_id) as Usage | undefined)?.limits.find((l) => l.id === "session");
  if (!limit) return undefined;
  return limit.resets_at !== null ? parse_time(limit.resets_at) : null;
}

/** What `Response::status()` shows: `401 Unauthorized`. */
function status_str(res: Response): string {
  return `${res.status}${res.statusText ? ` ${res.statusText}` : ""}`;
}

async function fetch(config_dir: string): Promise<[string | null, Limit[]]> {
  const dir = expand_tilde(config_dir.trim() === "" ? "~/.claude" : config_dir);
  const path = join(dir, ".credentials.json");
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (e: any) {
    if (e?.code === "ENOENT") throw new Error(`No Claude login in ${dir}`);
    throw new Error(`Can't read ${path}: ${e?.message ?? e}`);
  }
  let creds: any;
  try {
    creds = JSON.parse(raw);
  } catch (e: any) {
    throw new Error(`Can't parse ${path}: ${e?.message ?? e}`);
  }
  const oauth = creds?.claudeAiOauth;
  if (oauth == null) throw new Error("Not signed in with a Claude subscription");
  if (typeof oauth.accessToken !== "string") throw new Error(`Can't parse ${path}: missing field \`accessToken\``);
  if (Number.isInteger(oauth.expiresAt) && oauth.expiresAt <= Date.now()) throw new Error("Login expired; it refreshes on this config's next agent run");
  let res: Response;
  try {
    res = await globalThis.fetch(USAGE_URL, {
      headers: { authorization: `Bearer ${oauth.accessToken}`, "anthropic-beta": "oauth-2025-04-20" },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    throw new Error(`Usage request failed: ${err_str(e)}`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    let msg: string | null = null;
    try {
      const m = JSON.parse(body)?.error?.message;
      if (typeof m === "string") msg = m;
    } catch {}
    throw new Error(`Usage request failed (${status_str(res)})${msg !== null ? `: ${msg}` : ""}`);
  }
  let v: any;
  try {
    v = await res.json();
  } catch (e) {
    throw new Error(`Bad usage response: ${err_str(e)}`);
  }
  return [typeof oauth.subscriptionType === "string" ? oauth.subscriptionType : null, parse_limits(v)];
}

/**
 * The usage of each Claude account of the CLIProxyAPI at `url`, read through its management API
 * with `key`: its credentials, then Anthropic's usage endpoint for each with the account's own
 * token (`requests/api-call`, which puts the token in for `$TOKEN$`), all at once.
 */
async function fetch_proxy(url: string, key: string | null): Promise<Account[]> {
  if (key === null || key.trim() === "") throw new Error("Add the proxy's management key to this config to see its accounts' usage");
  const base = `${url.replace(/\/+$/, "")}/v8/management`;
  const v = await proxy_json(`${base}/credentials`, key);
  const files: any[] = Array.isArray(v?.files) ? v.files : [];
  const claude = files.filter((c) => c?.provider === "claude" && c?.disabled !== true);
  return Promise.all(claude.map((c) => account_usage(base, key, c)));
}

async function account_usage(base: string, key: string, cred: any): Promise<Account> {
  const field = (k: string) => {
    const t = typeof cred[k] === "string" ? cred[k].trim() : "";
    return t !== "" ? t : null;
  };
  const name = field("email") ?? field("label") ?? field("name") ?? "Claude account";
  // A number in some versions.
  const ai = cred.auth_index;
  const index = typeof ai === "string" ? ai : JSON.stringify(ai === undefined ? null : ai);
  const body = {
    auth_index: index,
    method: "GET",
    url: USAGE_URL,
    header: { Authorization: "Bearer $TOKEN$", "anthropic-beta": "oauth-2025-04-20" },
  };
  let limits: Limit[] = [];
  let error: string | null = null;
  try {
    const r = await proxy_json(`${base}/requests/api-call`, key, body);
    const text = typeof r?.body === "string" ? r.body : "";
    if (r?.status_code === 200) {
      try {
        limits = parse_limits(JSON.parse(text));
      } catch (e) {
        error = `Bad usage response: ${err_str(e)}`;
      }
    } else {
      let msg: string | null = null;
      try {
        const m = JSON.parse(text)?.error?.message;
        if (typeof m === "string") msg = m;
      } catch {}
      error = `Usage request failed (${JSON.stringify(r?.status_code ?? null)})${msg !== null ? `: ${msg}` : ""}`;
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  // What the proxy says about it, when it isn't using it (a cooldown, a login that needs renewing).
  if (cred.unavailable === true && error === null) {
    const m = field("status_message");
    error = m !== null ? `Unavailable: ${m}` : "Unavailable";
  }
  return { name, limits, error };
}

/** A management API request's JSON (a GET, or a POST of `json`), or why there's none. */
async function proxy_json(url: string, key: string, json?: any): Promise<any> {
  let res: Response;
  try {
    res = await globalThis.fetch(url, {
      method: json === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${key}`, ...(json === undefined ? {} : { "content-type": "application/json" }) },
      body: json === undefined ? undefined : JSON.stringify(json),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    throw new Error(`Proxy request failed: ${err_str(e)}`);
  }
  const body = await res.text().catch(() => "");
  let v: any = null;
  try {
    v = JSON.parse(body);
  } catch {}
  if (!res.ok) {
    const msg = typeof v?.error === "string" ? v.error : Array.from(body).slice(0, 200).join("");
    const hint = msg.includes("remote management disabled") ? " (set management.allow-remote: true in its config.yaml)" : "";
    throw new Error(`Proxy request failed (${status_str(res)}): ${msg}${hint}`);
  }
  if (v === null) throw new Error("Bad response from the proxy");
  return v;
}

/**
 * A pool's limits from its accounts': for each limit, the average of the accounts that report it
 * (how much of the pool's room is used, for accounts on the same plan), resetting when the first
 * of them does (when some room comes back). Accounts without numbers are left out.
 */
export function pool_limits(accounts: Account[]): Limit[] {
  const out: Limit[] = [];
  const counts: number[] = [];
  // Option's order: None before any time.
  const key = (t: string) => parse_time(t) ?? -Infinity;
  for (const l of accounts.flatMap((a) => a.limits)) {
    const i = out.findIndex((x) => x.id === l.id);
    if (i >= 0) {
      out[i].percent += l.percent;
      counts[i]++;
      const [a, b] = [out[i].resets_at, l.resets_at];
      out[i].resets_at = a !== null && b !== null ? (key(b) < key(a) ? b : a) : (a ?? b);
    } else {
      out.push({ ...l });
      counts.push(1);
    }
  }
  out.forEach((l, i) => (l.percent = Math.round((l.percent / counts[i]) * 10) / 10));
  return out;
}

/** Limits from the usage endpoint: its `limits` list, or the older per-window fields. */
export function parse_limits(v: any): Limit[] {
  if (Array.isArray(v?.limits)) {
    const out: Limit[] = [];
    for (const l of v.limits) {
      const percent = l?.percent;
      const kind = l?.kind;
      if (typeof percent !== "number" || typeof kind !== "string") continue;
      const model = typeof l.scope?.model?.display_name === "string" ? (l.scope.model.display_name as string) : null;
      let id: string, label: string;
      if (kind === "session") [id, label] = ["session", "Session"];
      else if (kind === "weekly_all") [id, label] = ["weekly", "Weekly"];
      else if (model !== null && l.group === "weekly") [id, label] = [`weekly:${model.toLowerCase()}`, `Weekly · ${model}`];
      else [id, label] = [kind, kind.replaceAll("_", " ")];
      out.push({ id, label, percent, resets_at: typeof l.resets_at === "string" ? l.resets_at : null });
    }
    return out;
  }
  const windows: Array<[string, string, string]> = [
    ["five_hour", "session", "Session"],
    ["seven_day", "weekly", "Weekly"],
    ["seven_day_opus", "weekly:opus", "Weekly · Opus"],
    ["seven_day_sonnet", "weekly:sonnet", "Weekly · Sonnet"],
  ];
  const out: Limit[] = [];
  for (const [key, id, label] of windows) {
    const w = v?.[key];
    if (typeof w?.utilization !== "number") continue;
    out.push({ id, label, percent: w.utilization, resets_at: typeof w.resets_at === "string" ? w.resets_at : null });
  }
  return out;
}

/** A `rate_limit_event` from an agent run with `config_id`: update its session and weekly limits, and whether it's out of usage. */
export function on_rate_limit_event(s: Shared, config_id: string, v: any) {
  on_rate_limit(s, config_id, v, true);
}

/** The same for a run through a proxy: only whether it's out, as its limits are one account's. */
export function on_proxy_rate_limit_event(s: Shared, config_id: string, v: any) {
  on_rate_limit(s, config_id, v, false);
}

function on_rate_limit(s: Shared, config_id: string, v: any, windows: boolean) {
  const info = v?.rate_limit_info ?? {};
  // A plan with extra usage reports its used-up limit as rejected while its turns go on, on
  // the extra usage (as Claude Code works out `isUsingOverage`).
  const overage = info.isUsingOverage === true || info.overageStatus === "allowed" || info.overageStatus === "allowed_warning";
  if (typeof info.status === "string") {
    if (info.status === "rejected" && !overage) set_out(s, config_id, Number.isInteger(info.resetsAt) ? timestamp(info.resetsAt) : null);
    // Allowed again (or on extra usage), whatever said it was out before.
    else set_out(s, config_id, null);
  }
  if (!windows) return;
  const w = info.unifiedWindows ?? {};
  const limits: Limit[] = [];
  for (const [key, id, label] of [["five_hour", "session", "Session"], ["seven_day", "weekly", "Weekly"]]) {
    const util = w[key]?.utilization;
    if (typeof util !== "number") continue;
    const r = w[key].resetsAt;
    limits.push({ id, label, percent: Math.round(util * 1000) / 10, resets_at: Number.isInteger(r) ? rfc3339(r) : null });
  }
  set_limits(s, config_id, limits, null);
}

/** A Unix time as chrono's `to_rfc3339()` writes it (`+00:00`, no fraction for whole seconds). */
export function rfc3339(secs: number): string {
  return new Date(secs * 1000).toISOString().replace(/\.000Z$/, "Z").replace(/Z$/, "+00:00");
}

/** A Unix time, as the board writes times that are compared as text (`limit_reset_at`). */
export function timestamp(t: number): string {
  return new Date(t * 1000).toISOString().replace(/\.\d+Z$/, "Z");
}

const RFC3339 = /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;

/** An RFC 3339 time, as ms since the epoch, or null if it isn't one. */
export function parse_time(t: string): number | null {
  if (!RFC3339.test(t)) return null;
  const ms = Date.parse(t.replace(" ", "T"));
  return Number.isNaN(ms) ? null : ms;
}

/** Mark `config_id` out of usage until `until` (null: not out), telling the board if that changes. */
function set_out(s: Shared, config_id: string, until: string | null) {
  const have = s.usage.get(config_id) as Usage | undefined;
  if (until === null && (have === undefined || have.out_until === null)) return;
  const u = entry(s, config_id);
  if (u.out_until === until) return;
  u.out_until = until;
  s.emit({ type: "usage", usage: usage_clone(u) });
}

/** When `config_id` is out of usage until, if it is now. */
export function out_until(s: Shared, config_id: string): string | null {
  const until = (s.usage.get(config_id) as Usage | undefined)?.out_until ?? null;
  if (until === null) return null;
  const t = parse_time(until);
  return t !== null && t > Date.now() ? until : null;
}

/**
 * A Codex turn on `config_id` failed with `usageLimitExceeded`. Codex doesn't say which limit,
 * so it's out until the latest reset of the limits it last reported as used up.
 */
export function codex_refused(s: Shared, config_id: string) {
  const limits = (s.usage.get(config_id) as Usage | undefined)?.limits ?? [];
  let until: number | null = null;
  for (const l of limits) {
    if (l.percent < 100 || l.resets_at === null) continue;
    const t = parse_time(l.resets_at);
    if (t !== null && (until === null || t > until)) until = t;
  }
  if (until !== null) set_out(s, config_id, timestamp(Math.floor(until / 1000)));
}

/**
 * A run of `task_id` on `config_id` stopped because the config is out of usage: note on the
 * task when the limit resets, for `finish` to act on as the run ends (see runner::finish).
 * Nothing is noted when the reset isn't known (or is past), and the run just fails.
 */
export function ran_out(s: Shared, task_id: string, config_id: string) {
  const until = out_until(s, config_id);
  if (until !== null) {
    try {
      s.update_task(task_id, [["limit_reset_at", until]]);
    } catch {}
  }
}

/** Whether a reset noted as `limit_reset_at` has come. A minute late, for clocks that disagree. */
export function reset_due(limit_reset_at: string): boolean {
  const t = parse_time(limit_reset_at);
  return t === null || t + 60_000 <= Date.now();
}

/**
 * Before a run of `task` (not running) starts with `message`: if its config is out of usage,
 * start a task that hasn't run yet on the next config with room (`limit_switch`), or queue it
 * until the limit resets (`limit_wait`). Returns the task if it's been queued.
 */
export function before_run(s: Shared, task: db.Task, message: db.Queued | null): db.Task | null {
  // Already waiting for a reset (by itself or when asked, see `wait_for_reset`): a message
  // joins the queue, whatever the profile's settings and even if a restart has forgotten
  // that the config is out.
  const waiting_until = task.limit_reset_at;
  if (waiting_until != null && task.waiting && !reset_due(waiting_until)) {
    const config = db.task_claude_config(s.db(), task)?.name ?? "its config";
    return runner.wait_for_limit(s, task, config, waiting_until, message);
  }
  const c = s.db();
  const profile = db.get_profile(c, task.profile_id);
  if (!profile) return null;
  if (!profile.limit_wait && !profile.limit_switch) return null;
  const config = db.task_claude_config(c, task);
  if (!config) return null;
  const project = task.project_id != null ? db.get_project(c, task.project_id) : null;
  const until = out_until(s, config.id);
  if (until === null) return null;
  if (profile.limit_switch && task.session_id == null) {
    // Another of its configs with the same agent, so its model and effort still apply.
    const others = db.available_configs(s.db(), task.profile_id, project);
    const agent = db.is_codex(config) ? "codex" : "claude";
    const next = others.find((o) => o.id !== config.id && db.is_codex(o) === db.is_codex(config) && out_until(s, o.id) === null);
    if (next && runs.has_agent(agent)) {
      // Only while it still hasn't started: its conversation stays in the config it starts in.
      const moved = s.update_task_if(task.id, [["claude_config_id", next.id]], (c) => {
        const t = db.get_task(c, task.id);
        return t !== null && t.session_id == null && !db.has_active_run(c, task.id);
      });
      if (moved) {
        s.add_event(task.id, "info", `Starting on ${next.name} instead: ${config.name} is out of usage`, `${config.name} resets at ${until}`);
        return null;
      }
    }
  }
  if (!profile.limit_wait) return null;
  return runner.wait_for_limit(s, task, config.name, until, message);
}

/**
 * `POST /tasks/{id}/wait-for-limit` (API 81): a task whose agent stopped because its config ran
 * out of usage waits in "In progress" for the limit to reset, and its agent carries on then.
 */
export async function wait_for_reset(s: Shared, r: Req): Promise<any> {
  const id = r.params.id;
  const task = db.get_task(s.db(), id);
  if (!task) throw ApiError.not_found("task");
  if (task.kind !== "task") throw ApiError.bad("only tasks can wait for a usage limit to reset");
  // Out of the merge queue's slot while it waited, another merge could start alongside it.
  if (task.merging) {
    throw ApiError.conflict(
      "a merge can't wait for a usage limit to reset, as it would give up its place in the merge queue; message its agent once the limit has reset",
    );
  }
  const until = task.limit_reset_at;
  if (until == null || reset_due(until)) throw ApiError.conflict("its agent isn't out of usage (or the limit has reset already)");
  if (s.is_running(id)) throw ApiError.conflict("its agent is running");
  const config = db.task_claude_config(s.db(), task)?.name ?? "its config";
  return runner.wait_for_limit(s, task, config, until, null);
}

/** Background loop: carry on with the tasks waiting for a usage limit to reset, once it has. */
export function resume_loop(s: Shared) {
  const tick = () => {
    let held: string[] = [];
    try {
      held = db.all(s.db(), "SELECT limit_reset_at FROM tasks WHERE waiting=1 AND limit_reset_at IS NOT NULL").map((r: any) => r.limit_reset_at);
    } catch {}
    if (held.some((t) => reset_due(t))) {
      try {
        runner.start_unblocked(s, null);
      } catch (e) {
        log.warn(`starting tasks whose limit has reset: ${err_str(e)}`);
      }
    }
  };
  setTimeout(tick, 0).unref();
  setInterval(tick, 30_000).unref();
}

/** Limits an agent run reported for `config_id` (and its plan, if it said). */
export function set_limits(s: Shared, config_id: string, limits: Limit[], plan: string | null) {
  if (!limits.length) return;
  const u = entry(s, config_id);
  const before = JSON.stringify([u.limits, u.plan]);
  merge(u, limits);
  if (plan !== null) u.plan = plan;
  if (JSON.stringify([u.limits, u.plan]) === before) return;
  u.updated_at = now();
  s.emit({ type: "usage", usage: usage_clone(u) });
}

/**
 * Stands in for `codex app-server`'s `rateLimits` in tests: `undefined` asks the real one (outside tests), `null` is
 * an error (Rust's `None` under `cfg(test)`), and a value is what it answers.
 */
export const TEST_CODEX = {
  value: undefined as any,
  get(): any {
    return this.value;
  },
  set(v: any) {
    this.value = v;
  },
};
