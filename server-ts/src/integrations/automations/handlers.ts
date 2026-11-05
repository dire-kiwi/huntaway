// Port of server/src/integrations/automations/handlers.rs: the API, an automation's JSON, and its routes' handlers.
import * as db from "../../db.ts";
import type { Conn, Project } from "../../db.ts";
import { ApiError, type Req } from "../../http.ts";
import * as permissions from "../../mcp/permissions.ts";
import type { Shared } from "../../state.ts";
import { byte_len, err_str, new_id, new_token } from "../../util.ts";
import {
  KEEP_RECENT,
  Action_from_json,
  Run_new,
  Trigger_from_json,
  bad,
  changed,
  fmt,
  get,
  hook_path,
  insert_run,
  is_webhook,
  list,
  list_routines,
  runs,
  sorted_json,
  type Action,
  type ActiveHours,
  type Automation,
  type Run,
  type Trigger,
} from "../automations.ts";
import * as runner from "../../agent/runner.ts";
import {
  Local,
  check_action,
  check_active_hours,
  check_budget,
  check_precheck,
  check_trigger,
  next_run,
  owner,
  owner_profile_id,
  owner_project_id,
  time_zone,
  type Owner,
} from "./check.ts";
import { Delivery_default, Delivery_from_json, event, type Delivery } from "./delivery.ts";
import { receive, run_action_detached } from "./running.ts";
import * as routines from "./routines.ts";

/**
 * An automation as the API shows it: its webhook path, and whether it has a secret (never the
 * secret itself), and its latest run.
 */
export function to_json(c: Conn, a: Automation): any {
  const v: any = {
    id: a.id,
    profile_id: a.profile_id,
    project_id: a.project_id,
    name: a.name,
    enabled: a.enabled,
    trigger: a.trigger,
    action: a.action,
    active_hours: a.active_hours,
    precheck: a.precheck,
    budget_usd: a.budget_usd,
    next_run_at: a.next_run_at,
    last_run_at: a.last_run_at,
    created_at: a.created_at,
    updated_at: a.updated_at,
  };
  // What its runs cost (those kept), and today in the host's time zone, against its budget.
  let [cost, today] = [0, 0];
  try {
    cost = routines.spent(c, a.id);
    today = routines.spent_today(c, a.id, Date.now(), Local);
  } catch {}
  v.cost_usd = cost;
  v.cost_today_usd = today;
  if (is_webhook(a)) {
    v.hook_path = hook_path(a);
    v.has_secret = !!a.secret;
  }
  let last: Run | undefined;
  try {
    last = runs(c, a.id, 1)[0];
  } catch {}
  v.last_run = last ? run_json(c, last) : null;
  return v;
}

/** A run, with the key and title of its task. */
export function run_json(c: Conn, r: Run): any {
  const v: any = { ...r };
  let t: db.Task | null = null;
  try {
    t = r.task_id ? db.get_task(c, r.task_id) : null;
  } catch {}
  if (t) {
    let p: Project | null = null;
    try {
      p = t.project_id ? db.get_project(c, t.project_id) : null;
    } catch {}
    const key = runner.key_prefix(t, p);
    v.task = { key: `${key}-${t.number}`, title: t.title, status: t.status, running: t.running };
    // A routine thread's cost so far, while it works.
    if (r.cost_usd === null && db.is_routine(t)) v.cost_usd = t.cost_usd;
  }
  // The agent run that took its message in, while it works (see routines.agent_run_ended).
  if (r.cost_usd === null && v.cost_usd == null) {
    let so_far: number | null = null;
    try {
      so_far =
        db.value<number | null>(
          c,
          `SELECT x.cost_usd / (SELECT COUNT(*) FROM automation_runs y WHERE y.agent_run_id = x.id) FROM automation_runs r JOIN runs x ON x.id = r.agent_run_id
                 WHERE r.id = ?1`,
          r.id,
        ) ?? null;
    } catch {}
    if (so_far !== null) v.cost_usd = so_far;
  }
  return v;
}

function project(c: Conn, id: string): Project {
  const p = db.get_project(c, id);
  if (!p) throw ApiError.not_found("project");
  return p;
}

export function automation(c: Conn, id: string): Automation {
  const a = get(c, id);
  if (!a) throw ApiError.not_found("automation");
  return a;
}

export function check_name(v: any): string {
  const n = typeof v === "string" ? v.trim() : null;
  if (n && [...n].length <= 100) return n;
  throw bad("name must be 1 to 100 characters");
}

function check_secret(v: any): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") {
    if (v === "") return null;
    // GitHub signs with the secret as it's given, so one trimmed here would never match.
    if (v.trim() !== v) throw bad("secret can't start or end with spaces or line breaks");
    if (byte_len(v) <= 200) return v;
  }
  throw bad("secret must be a string of up to 200 characters");
}

/**
 * serde's reading of `v` as `what`'s type: a Trigger for `trigger`, an Action for `action` (Rust's `parse::<T>`, whose
 * type the TypeScript can't infer: `as` names it when `what` doesn't).
 */
export function parse(what: string, v: any, as?: "trigger" | "action"): any {
  const kind = as ?? (what === "trigger" ? "trigger" : what === "action" ? "action" : null);
  if (!kind) throw new Error(`parse: no type for ${what}`);
  try {
    return kind === "trigger" ? Trigger_from_json(v ?? null) : Action_from_json(v ?? null);
  } catch (e) {
    throw bad(`${what}: ${err_str(e)}`);
  }
}

const body_map = (r: Req): Record<string, any> => {
  const b = r.body;
  if (b === null || typeof b !== "object" || Array.isArray(b)) {
    throw new ApiError(422, "Failed to deserialize the JSON body into the target type: invalid type: expected a map");
  }
  return b;
};

/** `GET /projects/{id}/automations`: the project's automations, and the host's time zone their times of day are in. */
export async function list_handler(s: Shared, r: Req): Promise<any> {
  const c = s.db();
  project(c, r.params.id);
  return { automations: list(c, r.params.id).map((a) => to_json(c, a)), time_zone: time_zone() };
}

/** `GET /profiles/{id}/automations`: the profile's routines, and the host's time zone their times are in. */
export async function list_routines_handler(s: Shared, r: Req): Promise<any> {
  const c = s.db();
  if (!db.get_profile(c, r.params.id)) throw ApiError.not_found("profile");
  return { automations: list_routines(c, r.params.id).map((a) => to_json(c, a)), time_zone: time_zone() };
}

/** `POST /projects/{id}/automations`: `{name, trigger, action, enabled?, secret?, active_hours?, precheck?, budget_usd?}`. */
export async function create_handler(s: Shared, r: Req): Promise<any> {
  const a = create(s, r.params.id, body_map(r));
  return to_json(s.db(), a);
}

/** `POST /profiles/{id}/automations`: a routine, as `create_handler` takes, whose action is `message_assistant`. */
export async function create_routine_handler(s: Shared, r: Req): Promise<any> {
  const a = create_routine(s, r.params.id, body_map(r));
  return to_json(s.db(), a);
}

export function create(s: Shared, project_id: string, b: Record<string, any>): Automation {
  const p = project(s.db(), project_id);
  return create_in(s, { project: p }, b);
}

/** Adds a routine to a profile. */
export function create_routine(s: Shared, profile_id: string, b: Record<string, any>): Automation {
  if (!db.get_profile(s.db(), profile_id)) throw ApiError.not_found("profile");
  return create_in(s, { profile: profile_id }, b);
}

/** When a schedule that's on and has just been set (or turned on) first runs: an `at` that's passed can't be. */
function first_run(trigger: Trigger, active: ActiveHours | null, now: number): string | null {
  const next = next_run(trigger, active, now, Local);
  if (next === null && trigger.kind === "at") throw bad("its time (at) has passed: give it one to come");
  return next === null ? null : fmt(next);
}

function create_in(s: Shared, o: Owner, b: Record<string, any>): Automation {
  const now = Date.now();
  const c = s.db();
  const name = check_name(b.name ?? null);
  const trigger: Trigger = check_trigger(parse("trigger", b.trigger ?? null));
  const action: Action = check_action(c, o, parse("action", b.action ?? null));
  const enabled = typeof b.enabled === "boolean" ? b.enabled : true;
  const secret = check_secret(b.secret ?? null);
  const active = check_active_hours(b.active_hours ?? null);
  const precheck = check_precheck(b.precheck ?? null);
  const budget = check_budget(b.budget_usd ?? null);
  const next = enabled ? first_run(trigger, active, now) : null;
  const id = new_id();
  db.run(
    c,
    `INSERT INTO automations (id,profile_id,project_id,name,enabled,trigger,action,token,secret,next_run_at,active_hours,precheck,budget_usd,created_at,updated_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?14)`,
    id, owner_profile_id(o), owner_project_id(o), name, enabled, sorted_json(trigger), sorted_json(action), new_token(), secret, next,
    active === null ? null : JSON.stringify(active), precheck, budget, fmt(now),
  );
  const a = automation(c, id);
  changed(s, a);
  return a;
}

export async function get_handler(s: Shared, r: Req): Promise<any> {
  const c = s.db();
  return to_json(c, automation(c, r.params.id));
}

/**
 * `PATCH /automations/{id}`: any of `name`, `enabled`, `trigger`, `action`, `secret` (blank
 * clears it), `rotate_token` (a new webhook URL; the old one stops working), `active_hours`,
 * `precheck` and `budget_usd` (null clears them).
 */
export async function update_handler(s: Shared, r: Req): Promise<any> {
  const a = update(s, r.params.id, body_map(r));
  return to_json(s.db(), a);
}

export function update(s: Shared, id: string, b: Record<string, any>): Automation {
  const now = Date.now();
  const c = s.db();
  const a = automation(c, id);
  const o = owner(c, a);
  const has = (k: string) => Object.hasOwn(b, k);
  const name = has("name") ? check_name(b.name) : a.name;
  const trigger: Trigger = has("trigger") ? check_trigger(parse("trigger", b.trigger)) : a.trigger;
  const action: Action = has("action") ? check_action(c, o, parse("action", b.action)) : a.action;
  let enabled = a.enabled;
  if (has("enabled")) {
    if (typeof b.enabled !== "boolean") throw bad("enabled must be true or false");
    enabled = b.enabled;
  }
  const secret = has("secret") ? check_secret(b.secret) : a.secret;
  const token = b.rotate_token === true ? new_token() : a.token;
  const active = has("active_hours") ? check_active_hours(b.active_hours) : a.active_hours;
  const precheck = has("precheck") ? check_precheck(b.precheck) : a.precheck;
  const budget = has("budget_usd") ? check_budget(b.budget_usd) : a.budget_usd;
  // A schedule starts over from now when it's turned on or changed; it doesn't run while it's off.
  let next: string | null;
  if (!enabled) next = null;
  else if (enabled !== a.enabled || sorted_json(trigger) !== sorted_json(a.trigger) || sorted_json(active) !== sorted_json(a.active_hours)) {
    next = first_run(trigger, active, now);
  } else next = a.next_run_at;
  db.run(
    c,
    `UPDATE automations SET name=?2, enabled=?3, trigger=?4, action=?5, secret=?6, token=?7, next_run_at=?8, active_hours=?9, precheck=?10, budget_usd=?11,
               updated_at=?12 WHERE id=?1`,
    a.id, name, enabled, sorted_json(trigger), sorted_json(action), secret, token, next, active === null ? null : JSON.stringify(active), precheck, budget,
    fmt(now),
  );
  const updated = automation(c, id);
  changed(s, updated);
  return updated;
}

export async function delete_handler(s: Shared, r: Req): Promise<any> {
  delete_(s, r.params.id);
  return { ok: true };
}

/** Rust's `automations::delete` (`delete` is a keyword here). */
export function delete_(s: Shared, id: string): Automation {
  const a = automation(s.db(), id);
  db.run(s.db(), "DELETE FROM automations WHERE id=?1", id);
  // Agents waiting to change or delete it are told it's gone.
  permissions.expire_for_automation(s, id);
  changed(s, a);
  return a;
}
export { delete_ as delete };

export interface RunNow {
  /** For a webhook: the test delivery's body (else the latest delivery's, or `{}`). */
  payload?: any;
  /** For a webhook: its event (`X-GitHub-Event`), e.g. `issues`. */
  event?: string | null;
}

/**
 * `POST /automations/{id}/run`: runs it now, whether or not it's on. A webhook's runs a test
 * delivery through its filters (not its signature check, deduplication or coalescing).
 */
export async function run_handler(s: Shared, r: Req): Promise<any> {
  const a = automation(s.db(), r.params.id);
  const b = r.body && typeof r.body === "object" && !Array.isArray(r.body) ? r.body : {};
  const run_now_b: RunNow = { payload: b.payload ?? null, event: typeof b.event === "string" ? b.event : null };
  const run = await run_now(s, a, run_now_b);
  return run_json(s.db(), run);
}

/** Runs `a` now (see run_handler). */
export async function run_now(s: Shared, a: Automation, b: RunNow): Promise<Run> {
  if (is_webhook(a)) {
    const latest = latest_delivery(s.db(), a.id);
    const delivery: Delivery =
      b.payload !== undefined && b.payload !== null ? Delivery_default(b.payload) : (latest ?? Delivery_default({}));
    const e = b.event?.trim();
    if (e) delivery.headers["x-github-event"] = e;
    // The same delivery id would be a duplicate of the real one.
    for (const h of ["x-github-delivery", "x-delivery-id", "idempotency-key"]) delete delivery.headers[h];
    return await receive(s, a, delivery, null);
  }
  const r = Run_new(a.id, "manual", "running", Date.now());
  insert_run(s.db(), r);
  return (await run_action_detached(s, a, r.id, "manual", null, 1)) ?? r;
}

/** The latest delivery kept, for the next test delivery. */
function latest_delivery(c: Conn, automation_id: string): Delivery | null {
  const p = db.value<string>(
    c,
    "SELECT payload FROM automation_runs WHERE automation_id=?1 AND payload IS NOT NULL ORDER BY created_at DESC, rowid DESC LIMIT 1",
    automation_id,
  );
  if (p == null) return null;
  try {
    return Delivery_from_json(JSON.parse(p));
  } catch {
    return null;
  }
}

/**
 * `GET /automations/{id}/runs`: its latest runs and deliveries, newest first, and the latest
 * delivery's body and event (to start a test delivery from).
 */
export async function runs_handler(s: Shared, r: Req): Promise<any> {
  const c = s.db();
  const a = automation(c, r.params.id);
  const l = runs(c, a.id, KEEP_RECENT).map((run) => run_json(c, run));
  const d = latest_delivery(c, a.id);
  return { runs: l, latest_delivery: d ? { body: d.body, event: event(d) } : null };
}
