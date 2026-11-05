// Port of server/src/integrations/automations/running.rs: running an automation (its action), receiving a webhook
// delivery, and the scheduler that claims due runs and coalesced batches.
import * as db from "../../db.ts";
import { ApiError, Reply, type Req } from "../../http.ts";
import * as api from "../../api.ts";
import * as runner from "../../agent/runner.ts";
import type { Shared } from "../../state.ts";
import { background, err_str, now as util_now, same_secret } from "../../util.ts";
import {
  DEDUPE_DAYS,
  LATE_GRACE,
  MAX_PENDING,
  RATE_PER_MINUTE,
  TICK,
  Automation_from_row,
  Run_from_row,
  Run_new,
  bad,
  changed,
  days,
  finish,
  fmt,
  get,
  get_run,
  insert_run,
  is_routine,
  is_webhook,
  mark_interrupted,
  parse_time,
  prune,
  type Automation,
  type Outcome,
  type Run,
  type RunResult,
} from "../automations.ts";
import { ActiveHours_contains, ActiveHours_text, Local, align, format_local, next_run, target_task, type Tz } from "./check.ts";
import * as routines from "./routines.ts";
import {
  Delivery_from_json,
  Delivery_parse,
  allow_delivery,
  body_id,
  delivery_id,
  event,
  event_label,
  failed_filter,
  render,
  signed,
  takes_ping,
  untrusted_note,
  type Delivery,
  type Vars,
} from "./delivery.ts";

const MINUTE = 60_000;

/** What a run says it did, for the description of the task it creates or the message it sends. */
function how(source: string, ev: string | null): string {
  if (source === "schedule") return "on its schedule";
  if (source === "webhook") return ev !== null ? `from a webhook delivery (${ev})` : "from a webhook delivery";
  if (ev !== null) return `from a test delivery (${ev}) on the board`;
  return "by hand, from the board";
}

/** Does what the automation does, for run `run_id`, once it's passed its checks (see `guards`), and records how it went. */
export async function run_action(s: Shared, a: Automation, run_id: string, source: string, delivery: Delivery | null, count: number): Promise<Run | null> {
  const now = Date.now();
  const ev = delivery ? event_label(delivery) : null;
  let result: RunResult;
  try {
    const precheck = await guards(s, a, source, now);
    const vars: Vars = { automation: a, source, delivery, count, now, precheck };
    result = act(s, a, run_id, vars, ev);
  } catch (e) {
    result = is_outcome(e) ? e : { err: [null, message(e)] };
  }
  if ("err" in result) console.warn(`automation ${a.id}: automation "${a.name}" failed: ${result.err[1]}`);
  const c = s.db();
  try {
    finish(c, run_id, result);
  } catch (e) {
    console.error(`automation ${a.id}: recording an automation's run: ${err_str(e)}`);
  }
  try {
    db.run(c, "UPDATE automations SET last_run_at=?2 WHERE id=?1", a.id, util_now());
  } catch {}
  let run: Run | null = null;
  try {
    run = get_run(c, run_id);
  } catch {}
  changed(s, a);
  return run;
}

const message = (e: any) => (e instanceof ApiError ? e.message : err_str(e));

/** Whether a thrown value is an Outcome (see routines.precheck), rather than an error. */
const is_outcome = (e: any): e is Outcome => e !== null && typeof e === "object" && !(e instanceof Error) && ("err" in e || "skipped" in e);

const money = (n: number) => `$${n.toFixed(2)}`;

/**
 * What a run checks before it does anything: its active hours, its budget, that its last run in a thread of its own is
 * over (a run from the board is only checked against those), and its precheck, whose output it returns. Each throws the
 * Outcome that says why it skipped the run.
 */
async function guards(s: Shared, a: Automation, source: string, now: number): Promise<string | null> {
  const by_hand = source === "manual";
  const hours = a.active_hours;
  if (!by_hand && a.trigger.kind !== "at" && hours && !ActiveHours_contains(hours, now, Local)) {
    throw { skipped: `Skipped: outside its active hours (${ActiveHours_text(hours)})` } satisfies Outcome;
  }
  if (!by_hand && a.budget_usd !== null) {
    const spent = routines.spent_today(s.db(), a.id, now, Local);
    if (spent >= a.budget_usd) {
      throw { skipped: `Skipped: over budget (its runs today cost ${money(spent)}, and its budget is ${money(a.budget_usd)} a day)` } satisfies Outcome;
    }
  }
  if (!by_hand) {
    const t = routines.still_running(s.db(), a);
    if (t) throw { skipped: `Skipped: its last run (A-${t.number}) is still going` } satisfies Outcome;
  }
  return a.precheck !== null ? await routines.precheck(s, a, a.precheck) : null;
}

/**
 * `run_action` on its own: the run is recorded, so a request that started it and is dropped meanwhile (a board request
 * given up on during a slow precheck, say) can't cancel it half way, leaving it `running` with nothing done. (A promise
 * goes on whether or not it's awaited, so this is `run_action`, with its errors logged.)
 */
function spawn_action(s: Shared, a: Automation, run_id: string, source: string, delivery: Delivery | null, count: number): Promise<Run | null> {
  return run_action(s, a, run_id, source, delivery, count).catch((e) => {
    console.error(`automation ${a.id}: running it: ${err_str(e)}`);
    return null;
  });
}

/** `spawn_action`, waited for. */
export async function run_action_detached(s: Shared, a: Automation, run_id: string, source: string, delivery: Delivery | null, count: number): Promise<Run | null> {
  return await spawn_action(s, a, run_id, source, delivery, count);
}

/**
 * The task the automation's action made or messaged, or why it couldn't (with the task, if it
 * made one but couldn't start it).
 */
function act(s: Shared, a: Automation, run_id: string, vars: Vars, ev: string | null): RunResult {
  const h = how(vars.source, ev);
  if (a.project_id === null) {
    const action = a.action;
    if (action.kind !== "message_assistant") return { err: [null, "a routine can only message the assistant"] };
    return routines.message(s, a, run_id, vars, h, action.message, action.mode);
  }
  let project;
  try {
    project = db.get_project(s.db(), a.project_id);
  } catch (e) {
    return { err: [null, err_str(e)] };
  }
  if (!project) return { err: [null, "the project is gone"] };
  if (project.archived_at != null) return { err: [null, "the project is archived"] };
  const action = a.action;
  if (action.kind === "message_assistant") return { err: [null, "message_assistant is for a profile's routines"] };
  if (action.kind === "create_task") {
    let [title, title_untrusted] = render(action.title, vars, "title");
    if (!title) title = `${a.name} (${format_local(Local, vars.now)})`;
    const [body, body_untrusted] = render(action.description, vars, "text");
    let text = "";
    if (title_untrusted || body_untrusted) text += untrusted_note(vars, title_untrusted);
    if (body.trim()) text += `${body.trimEnd()}\n\n`;
    text += `*Created by the automation "${a.name}" ${h}.*`;
    let t;
    try {
      t = api.create_task_inner(s, project.id, {
        title,
        description: text,
        status: action.status,
        task_type: action.task_type,
        labels: action.labels ?? [],
        claude_config_id: action.claude_config_id,
        model: action.model,
        effort: action.effort,
      } as any);
    } catch (e) {
      return { err: [null, message(e)] };
    }
    // Its first run is the automation run's, for its budget (and the task's later work isn't).
    if (action.start) {
      try {
        runner.send_from_automation(s, t.id, "", run_id);
      } catch (e) {
        return { err: [t.id, `created the task, but couldn't start its agent: ${message(e)}`] };
      }
    }
    return { ok: t.id };
  }
  let t;
  try {
    t = target_task(s.db(), project, action.task_id);
  } catch (e) {
    return { err: [null, message(e)] };
  }
  const [body, untrusted] = render(action.message, vars, "text");
  const note = untrusted ? untrusted_note(vars, false) : "";
  const text = `From the automation "${a.name}", ${h}:\n\n${note}${body.trim()}`;
  // The run that takes it in is the automation run's, for its budget.
  try {
    runner.send_from_automation(s, t.id, text, run_id);
  } catch (e) {
    return { err: [t.id, message(e)] };
  }
  return { ok: t.id };
}

/**
 * A delivery to `a`: `[raw body, signature header]` for one from outside, which is checked
 * and deduplicated, null for a test delivery from the board. Returns its run (or why it didn't
 * run), or throws: a 429 when too many coalesced runs are waiting (recorded as skipped). One
 * from outside that runs is answered as soon as its run is recorded, `running`, and its action
 * carries on by itself: a slow precheck would outlast a sender's timeout (GitHub's is 10 seconds),
 * which would then count it as failed. The board's test delivery waits for how it went.
 */
export async function receive(s: Shared, a: Automation, delivery: Delivery, raw: [Buffer, string | null] | null): Promise<Run> {
  const now = Date.now();
  const source = raw ? "webhook" : "manual";
  const trigger = a.trigger;
  if (trigger.kind !== "webhook") throw bad("not a webhook");
  const { filters, coalesce_seconds, coalesce_key } = trigger;
  const run = Run_new(a.id, source, "running", now);
  run.delivery_id = delivery_id(delivery);
  run.event = event_label(delivery);
  const record = (status: string, detail: string, batch_id: string | null = null): Run => {
    run.status = status;
    run.detail = detail;
    if (batch_id !== null) run.batch_id = batch_id;
    if (run.status !== "running" && run.status !== "pending") run.finished_at = fmt(now);
    insert_run(s.db(), run);
    changed(s, a);
    return run;
  };
  const secret = a.secret ? a.secret : null;
  if (raw) {
    const [body, signature] = raw;
    if (secret !== null && !signed(secret, body, signature)) {
      const why = signature !== null ? "its X-Hub-Signature-256 doesn't match the secret" : "it isn't signed (no X-Hub-Signature-256)";
      return record("rejected", `Rejected: ${why}`);
    }
    // A signed delivery without an id is known by its body, so one that's been captured can't
    // be sent again with its id header taken out (which only the secret's holder could change).
    if (secret !== null && run.delivery_id === null) run.delivery_id = body_id(body);
    if (!a.enabled) return record("skipped", "Skipped: the automation is off");
  }
  if (event(delivery) === "ping" && !filters.some(takes_ping)) {
    return record("filtered", "Ignored: GitHub's ping, sent when a webhook is added (a filter on event equal to ping takes it)");
  }
  const vars: Vars = { automation: a, source, delivery, count: 1, now };
  const why = failed_filter(filters, vars);
  if (why !== null) return record("filtered", why);
  const payload = JSON.stringify(delivery);
  const coalesce = raw !== null && coalesce_seconds > 0;
  {
    // No await from the checks to the record, so two deliveries at once can't both pass them.
    const c = s.db();
    const cutoff = fmt(now - days(DEDUPE_DAYS));
    if (raw && run.delivery_id !== null) {
      const id = run.delivery_id;
      const seen = db.value<string>(
        c,
        `SELECT id FROM automation_runs WHERE automation_id=?1 AND delivery_id=?2 AND created_at >= ?3
                       AND status IN ('pending','coalesced','running','ok') ORDER BY created_at LIMIT 1`,
        a.id, id, cutoff,
      );
      if (seen != null) {
        const why = id.startsWith("body-sha256:")
          ? "Dropped: this delivery came before (it has no delivery id header, so it's known by its signed body)"
          : "Dropped: this delivery came before";
        return record("duplicate", why, seen);
      }
    }
    if (coalesce) {
      const key = render(coalesce_key, vars, "title")[0];
      const batch = db.value<string>(
        c,
        "SELECT id FROM automation_runs WHERE automation_id=?1 AND status='pending' AND COALESCE(batch_key,'')=?2 LIMIT 1",
        a.id, key,
      );
      run.batch_key = key;
      if (batch != null) {
        // The batch runs with the latest delivery's values.
        db.run(
          c,
          "UPDATE automation_runs SET count=count+1, payload=?2, delivery_id=COALESCE(delivery_id,?3), event=?4 WHERE id=?1",
          batch, payload, run.delivery_id, run.event,
        );
        run.status = "coalesced";
        run.batch_id = batch;
        run.finished_at = fmt(now);
        insert_run(c, run);
        changed(s, a);
        return run;
      }
      const waiting = Number(db.value(c, "SELECT COUNT(*) FROM automation_runs WHERE automation_id=?1 AND status='pending'", a.id) ?? 0);
      if (waiting >= MAX_PENDING) {
        const why = `${MAX_PENDING} coalesced runs are waiting already`;
        run.status = "skipped";
        run.finished_at = fmt(now);
        run.detail = `Turned away: ${why}`;
        insert_run(c, run);
        changed(s, a);
        throw new ApiError(429, why);
      }
      run.status = "pending";
      run.payload = payload;
      run.due_at = fmt(now + coalesce_seconds * 1000);
      insert_run(c, run);
      changed(s, a);
      return run;
    }
    run.payload = payload;
    insert_run(c, run);
  }
  changed(s, a);
  if (raw) {
    background("an automation's run", spawn_action(s, a, run.id, source, delivery, 1));
    return run;
  }
  return (await run_action_detached(s, a, run.id, source, delivery, 1)) ?? run;
}

const json = (status: number, body: any) => new Reply(status, body);

/**
 * `POST /api/hooks/{id}/{token}`: a webhook delivery. It doesn't take the board's token: the
 * token in the path is the automation's own, and reaches only it.
 */
export async function webhook(s: Shared, r: Req): Promise<any> {
  const not_found = () => json(404, { error: "no such webhook" });
  const { id, token } = r.params;
  const a = get(s.db(), id);
  if (!a) return not_found();
  if (!is_webhook(a) || !same_secret(a.token, token)) return not_found();
  const sig = r.headers["x-hub-signature-256"];
  const signature = typeof sig === "string" ? sig : Array.isArray(sig) ? (sig[0] ?? null) : null;
  // Counted after the signature check, so that anyone with the URL can't use up the minute's
  // deliveries with unsigned ones. Those have a limit of their own, past which they aren't recorded.
  const genuine = !a.secret || signed(a.secret, r.raw, signature);
  if (!allow_delivery(genuine ? a.id : `${a.id}:unsigned`)) {
    return json(429, { error: `too many deliveries: at most ${RATE_PER_MINUTE} a minute` });
  }
  const delivery = Delivery_parse(r.headers, r.query_string || null, r.raw);
  let run: Run;
  try {
    run = await receive(s, a, delivery, [r.raw, signature]);
  } catch (e) {
    const status = e instanceof ApiError ? e.status : 500;
    if (status >= 500) {
      console.warn(`webhook delivery to automation ${a.id}: ${message(e)}`);
      return json(status, { error: "the delivery couldn't be taken" });
    }
    throw e;
  }
  const status = ({ rejected: 401, skipped: 409, failed: 500, duplicate: 200 } as Record<string, number>)[run.status] ?? 202;
  // The sender sees why a delivery was turned away, but not what went wrong inside or which task it made.
  const detail = run.status === "failed" ? "the automation's action failed: see its deliveries on the board" : run.detail;
  return json(status, { run: run.id, status: run.status, detail });
}

/**
 * The automations whose scheduled or coalesced run is under way: the scheduler starts another of theirs only once it's
 * over (one that comes due meanwhile waits for it, as one held back by its active hours does), so an automation's runs
 * don't overlap, while the others' go ahead.
 */
const IN_FLIGHT = new Set<string>();

/** Automation `id`'s place in `IN_FLIGHT`, given up with `drop` (Rust's `InFlight`, given up when it's dropped). */
class InFlight {
  id: string;
  private dropped = false;
  constructor(id: string) {
    this.id = id;
  }
  static take(automation_id: string): InFlight | null {
    if (IN_FLIGHT.has(automation_id)) return null;
    IN_FLIGHT.add(automation_id);
    return new InFlight(automation_id);
  }
  drop() {
    if (this.dropped) return;
    this.dropped = true;
    IN_FLIGHT.delete(this.id);
  }
}

/**
 * Claims the schedules due at `now` (moving each one's next run on, and recording the run, so a restart can't run it
 * again) and returns those to run. One whose last run is still under way stays due.
 */
function claim_due(s: Shared, now: number, tz: Tz): Array<[Automation, Run, InFlight]> {
  const c = s.db();
  const due: Array<[Automation, boolean]> = [];
  for (const r of db.all(
    c,
    `SELECT a.*, p.archived_at IS NOT NULL AS archived FROM automations a LEFT JOIN projects p ON p.id=a.project_id
         WHERE a.enabled=1 AND a.next_run_at IS NOT NULL`,
  )) {
    try {
      // A routine has no project, so it's never archived.
      due.push([Automation_from_row(r), !!r.archived]);
    } catch {}
  }
  const out: Array<[Automation, Run, InFlight]> = [];
  for (const [a, archived] of due) {
    const due_at = parse_time(a.next_run_at);
    if (due_at === null || due_at > now) continue;
    const active = a.active_hours;
    let run: boolean;
    let next: number | null;
    const t = a.trigger;
    if (t.kind === "interval") {
      // An interval keeps its rhythm, unless it's missed one: then it runs once, and goes on from now. Outside its
      // active hours, it starts again when they do.
      const n = due_at + t.every_minutes * MINUTE;
      run = true;
      next = align(t, active, n > now ? n : now + t.every_minutes * MINUTE, tz);
    } else if (t.kind === "daily" || t.kind === "cron") {
      run = now - due_at <= LATE_GRACE;
      next = next_run(t, active, now, tz);
    } else if (t.kind === "at") {
      // Once, however late (a reminder is better late than never), and then it's off.
      run = true;
      next = null;
    } else {
      run = false;
      next = null;
    }
    const in_flight = InFlight.take(a.id);
    if (!in_flight) continue;
    const once = t.kind === "at";
    let claimed: Run | "none" | null;
    try {
      claimed = db.tx(c, () => {
        const n = db.run(
          c,
          "UPDATE automations SET next_run_at=?3, enabled=CASE WHEN ?4 THEN 0 ELSE enabled END WHERE id=?1 AND next_run_at=?2 AND enabled=1",
          a.id, a.next_run_at, next === null ? null : fmt(next), once,
        ).changes;
        if (n === 0) return null;
        // An archived project's schedules go on without running (or filling its history) until it's unarchived.
        if (is_webhook(a) || archived) return "none" as const;
        const r = Run_new(a.id, "schedule", run ? "running" : "skipped", now);
        r.due_at = a.next_run_at;
        if (!run) {
          const at = format_local(Local, due_at);
          r.detail = `Missed: it was due at ${at}, when the server wasn't running (or the host was asleep). Runs more than 10 minutes late are skipped.`;
          r.finished_at = fmt(now);
        }
        insert_run(c, r);
        return r;
      });
    } catch (e) {
      in_flight.drop();
      throw e;
    }
    if (claimed === null || claimed === "none" || !run) {
      in_flight.drop();
      if (claimed !== null && claimed !== "none") changed(s, a);
      continue;
    }
    out.push([a, claimed, in_flight]);
  }
  return out;
}

/**
 * Claims the coalesced runs whose window has closed, by automation (to run one after another). One whose automation's
 * last run is still under way waits for it.
 */
function claim_batches(s: Shared, now: number): Array<[Automation, Run[], InFlight]> {
  const c = s.db();
  const due: Run[] = [];
  for (const r of db.all(c, "SELECT * FROM automation_runs WHERE status='pending' AND due_at <= ?1 ORDER BY due_at", fmt(now))) {
    try {
      due.push(Run_from_row(r));
    } catch {}
  }
  const out: Array<[Automation, Run[], InFlight]> = [];
  for (const r of due) {
    const a = get(c, r.automation_id);
    const at = out.findIndex(([o]) => o.id === r.automation_id);
    let status: string;
    let detail: string | null = null;
    let in_flight: InFlight | null = null;
    if (a && a.enabled && is_webhook(a)) {
      status = "running";
      if (at < 0) {
        in_flight = InFlight.take(a.id);
        if (!in_flight) continue;
      }
    } else {
      status = "skipped";
      detail = "Skipped: the automation was turned off (or isn't a webhook any more) before it ran";
    }
    let claimed: number;
    try {
      claimed = db.run(
        c,
        "UPDATE automation_runs SET status=?2, detail=?3, finished_at=CASE WHEN ?2='skipped' THEN ?4 END WHERE id=?1 AND status='pending'",
        r.id, status, detail, fmt(now),
      ).changes;
    } catch (e) {
      in_flight?.drop();
      for (const [, , f] of out) f.drop();
      throw e;
    }
    if (a && at >= 0 && claimed === 1 && status === "running") out[at][1].push(r);
    else if (a && at < 0 && in_flight && claimed === 1) out.push([a, [r], in_flight]);
    else {
      in_flight?.drop();
      if (a) changed(s, a);
    }
  }
  return out;
}

/**
 * Runs what's due at `now` (milliseconds): schedules, and coalesced deliveries whose window has closed. Each on its own
 * (see `start_due`), all waited for. (The scheduler doesn't wait: see `start`.)
 */
export async function tick(s: Shared, now: number): Promise<void> {
  await tick_in(s, now, Local);
}

export async function tick_in(s: Shared, now: number, tz: Tz): Promise<void> {
  await Promise.all(start_due(s, now, tz));
}

/**
 * Starts what's due at `now`, each automation's runs on their own, so that one that's slow (a precheck can take up to
 * two minutes) doesn't hold up the others' schedules.
 */
export function start_due(s: Shared, now: number, tz: Tz): Array<Promise<void>> {
  const started: Array<Promise<void>> = [];
  const start = (a: Automation, runs: Run[], in_flight: InFlight, source: string) => {
    started.push(
      (async () => {
        try {
          for (const r of runs) {
            let delivery: Delivery | null = null;
            try {
              delivery = r.payload ? Delivery_from_json(JSON.parse(r.payload)) : null;
            } catch {}
            await run_action(s, a, r.id, source, delivery, r.count);
          }
        } catch (e) {
          console.error(`automation ${a.id}: running it: ${err_str(e)}`);
        } finally {
          in_flight.drop();
        }
      })(),
    );
  };
  try {
    for (const [a, r, f] of claim_due(s, now, tz)) start(a, [r], f, "schedule");
  } catch (e) {
    console.error(`checking automations' schedules: ${err_str(e)}`);
  }
  try {
    for (const [a, runs, f] of claim_batches(s, now)) start(a, runs, f, "webhook");
  } catch (e) {
    console.error(`checking automations' coalesced deliveries: ${err_str(e)}`);
  }
  return started;
}

/** Starts the scheduler, once runs left over from before a restart are marked as interrupted. */
export function start(s: Shared): void {
  try {
    const n = mark_interrupted(s.db());
    if (n) console.warn(`${n} automation run(s) were interrupted by the restart; they aren't run again`);
  } catch (e) {
    console.error(`checking for interrupted automation runs: ${err_str(e)}`);
  }
  let pruned: number | null = null;
  const loop = async () => {
    try {
      start_due(s, Date.now(), Local);
      if (pruned === null || performance.now() - pruned > 3_600_000) {
        try {
          prune(s.db(), Date.now());
        } catch (e) {
          console.error(`pruning automation runs: ${err_str(e)}`);
        }
        await routines.prune_threads(s, Date.now());
        pruned = performance.now();
      }
    } catch (e) {
      console.error(`automations' scheduler: ${err_str(e)}`);
    }
    setTimeout(next, TICK).unref();
  };
  const next = () => background("automations' scheduler", loop());
  next();
}
