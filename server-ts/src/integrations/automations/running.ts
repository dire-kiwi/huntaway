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
  is_webhook,
  mark_interrupted,
  parse_time,
  prune,
  type Automation,
  type Run,
  type RunResult,
} from "../automations.ts";
import { Local, format_local, next_after, target_task, type Tz } from "./check.ts";
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

/** Does what the automation does, for run `run_id`, and records how it went. */
export async function run_action(s: Shared, a: Automation, run_id: string, source: string, delivery: Delivery | null, count: number): Promise<Run | null> {
  const vars: Vars = { automation: a, source, delivery, count, now: Date.now() };
  const ev = delivery ? event_label(delivery) : null;
  const result = act(s, a, vars, ev);
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

/**
 * The task the automation's action made or messaged, or why it couldn't (with the task, if it
 * made one but couldn't start it).
 */
function act(s: Shared, a: Automation, vars: Vars, ev: string | null): RunResult {
  let project;
  try {
    project = db.get_project(s.db(), a.project_id);
  } catch (e) {
    return { err: [null, err_str(e)] };
  }
  if (!project) return { err: [null, "the project is gone"] };
  if (project.archived_at != null) return { err: [null, "the project is archived"] };
  const h = how(vars.source, ev);
  const action = a.action;
  if (action.kind === "create_task") {
    let [title, title_untrusted] = render(action.title, vars, "title");
    if (!title) title = `${a.name} (${format_local(Local, vars.now)})`;
    const [body, body_untrusted] = render(action.description, vars, "text");
    let text = "";
    if (title_untrusted || body_untrusted) text += untrusted_note(a.name, title_untrusted);
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
    if (action.start) {
      try {
        runner.send(s, t.id, "");
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
  const note = untrusted ? untrusted_note(a.name, false) : "";
  const text = `From the automation "${a.name}", ${h}:\n\n${note}${body.trim()}`;
  try {
    runner.send_from_agent(s, t.id, text);
  } catch (e) {
    return { err: [t.id, message(e)] };
  }
  return { ok: t.id };
}

/**
 * A delivery to `a`: `[raw body, signature header]` for one from outside, which is checked
 * and deduplicated, null for a test delivery from the board. Returns its run (or why it didn't
 * run), or throws: a 429 when too many coalesced runs are waiting (recorded as skipped).
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
  return (await run_action(s, a, run.id, source, delivery, 1)) ?? run;
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
 * Claims the schedules due at `now` (moving each one's next run on, and recording the run, so a
 * restart can't run it again) and returns those to run.
 */
function claim_due(s: Shared, now: number, tz: Tz): Array<[Automation, Run]> {
  const c = s.db();
  const due: Array<[Automation, boolean]> = [];
  for (const r of db.all(
    c,
    `SELECT a.*, p.archived_at IS NOT NULL AS archived FROM automations a JOIN projects p ON p.id=a.project_id
         WHERE a.enabled=1 AND a.next_run_at IS NOT NULL`,
  )) {
    try {
      due.push([Automation_from_row(r), !!r.archived]);
    } catch {}
  }
  const out: Array<[Automation, Run]> = [];
  for (const [a, archived] of due) {
    const due_at = parse_time(a.next_run_at);
    if (due_at === null || due_at > now) continue;
    let run: boolean;
    let next: number | null;
    const t = a.trigger;
    if (t.kind === "interval") {
      // An interval keeps its rhythm, unless it's missed one: then it runs once, and goes on from now.
      const n = due_at + t.every_minutes * MINUTE;
      run = true;
      next = n > now ? n : now + t.every_minutes * MINUTE;
    } else if (t.kind === "daily") {
      run = now - due_at <= LATE_GRACE;
      next = next_after(t, now, tz);
    } else {
      run = false;
      next = null;
    }
    const claimed = db.tx(c, () => {
      const n = db.run(
        c,
        "UPDATE automations SET next_run_at=?3 WHERE id=?1 AND next_run_at=?2 AND enabled=1",
        a.id, a.next_run_at, next === null ? null : fmt(next),
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
    if (claimed === null || claimed === "none") continue;
    if (run) out.push([a, claimed]);
    else changed(s, a);
  }
  return out;
}

/** Claims the coalesced runs whose window has closed. */
function claim_batches(s: Shared, now: number): Array<[Automation, Run]> {
  const c = s.db();
  const due: Run[] = [];
  for (const r of db.all(c, "SELECT * FROM automation_runs WHERE status='pending' AND due_at <= ?1", fmt(now))) {
    try {
      due.push(Run_from_row(r));
    } catch {}
  }
  const out: Array<[Automation, Run]> = [];
  for (const r of due) {
    const a = get(c, r.automation_id);
    const ok = a !== null && a.enabled && is_webhook(a);
    const status = ok ? "running" : "skipped";
    const detail = ok ? null : "Skipped: the automation was turned off (or isn't a webhook any more) before it ran";
    const claimed = db.run(
      c,
      "UPDATE automation_runs SET status=?2, detail=?3, finished_at=CASE WHEN ?2='skipped' THEN ?4 END WHERE id=?1 AND status='pending'",
      r.id, status, detail, fmt(now),
    ).changes;
    if (a && claimed === 1 && status === "running") out.push([a, r]);
    else if (a) changed(s, a);
  }
  return out;
}

/** Runs what's due at `now` (milliseconds): schedules, and coalesced deliveries whose window has closed. */
export async function tick(s: Shared, now: number): Promise<void> {
  await tick_in(s, now, Local);
}

export async function tick_in(s: Shared, now: number, tz: Tz): Promise<void> {
  let due: Array<[Automation, Run]> = [];
  try {
    due = claim_due(s, now, tz);
  } catch (e) {
    console.error(`checking automations' schedules: ${err_str(e)}`);
  }
  for (const [a, r] of due) await run_action(s, a, r.id, "schedule", null, 1);
  let batches: Array<[Automation, Run]> = [];
  try {
    batches = claim_batches(s, now);
  } catch (e) {
    console.error(`checking automations' coalesced deliveries: ${err_str(e)}`);
  }
  for (const [a, r] of batches) {
    let delivery: Delivery | null = null;
    try {
      delivery = r.payload ? Delivery_from_json(JSON.parse(r.payload)) : null;
    } catch {}
    await run_action(s, a, r.id, "webhook", delivery, r.count);
  }
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
      await tick(s, Date.now());
      if (pruned === null || performance.now() - pruned > 3_600_000) {
        try {
          prune(s.db(), Date.now());
        } catch (e) {
          console.error(`pruning automation runs: ${err_str(e)}`);
        }
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
