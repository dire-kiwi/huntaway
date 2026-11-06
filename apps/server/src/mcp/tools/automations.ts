// Port of server/src/mcp/tools/automations.rs: the automation tools: listing, creating, changing and running a project's
// automations, or the agent's own profile's routines (see integrations/automations.rs).
import * as db from "../../db.ts";
import type { Shared } from "../../state.ts";
import * as au from "../../integrations/automations.ts";
import { new_token } from "../../util.ts";
import { ToolError, json_eq, te, type Ctx } from "../tools.ts";
import { boards, project_key, resolve_task } from "./resolve.ts";
import { is_own } from "../tools.ts";
import { project_or_own } from "./projects.ts";
import { approval_project, approval_task, ask_user } from "./approvals.ts";

const eq_ic = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * Whether a call is about the caller's profile's routines rather than a project's automations: it says `routines`, or its
 * action messages the assistant, or it names no project and comes from the assistant (or one of its routine threads),
 * which is in none.
 */
export function wants_routines(ctx: Ctx, args: any): boolean {
  const project = args?.project_id;
  return (
    args?.routines === true ||
    args?.action?.kind === "message_assistant" ||
    ((typeof project !== "string" || project === "") && ctx.task !== null && db.is_assistants(ctx.task))
  );
}

/**
 * The caller's own profile, whose routines it can see and change: other profiles' agents can't reach them, as they can't
 * its assistant.
 */
export function own_routines(s: Shared, ctx: Ctx, profile: string | null): au.Owner {
  const own = boards(s, ctx).find((b) => is_own(ctx, b));
  if (!own) throw ToolError.other("routines are for an agent on its own profile's host");
  if (profile !== null && !eq_ic(profile, own.name) && profile !== own.id) {
    throw ToolError.other(`an agent can only use its own profile's routines (${own.name})`);
  }
  return { profile: own.id };
}

/**
 * The automation an agent names in `automation_id`: its id, or its name in `project_id` (or the agent's own project, or
 * with `routines` its own profile's routines). Only one in a project on a board the agent can use, or a routine of its
 * own profile.
 */
export function resolve_automation(s: Shared, ctx: Ctx, args: any, profile: string | null, own_project: string | null): [au.Automation, au.Owner] {
  const r = typeof args.automation_id === "string" ? args.automation_id.trim() : "";
  const by_id = au.get(s.db(), r);
  if (by_id) {
    if (by_id.project_id === null) {
      if (ctx.profile_id === by_id.profile_id) return [by_id, { profile: by_id.profile_id }];
      throw ToolError.not_found(`automation ${r}`);
    }
    const p = db.get_project(s.db(), by_id.project_id);
    let usable = false;
    if (p) {
      try {
        usable = boards(s, ctx).some((b) => b.id === p.profile_id);
      } catch {}
    }
    if (p && usable) return [by_id, { project: p }];
    throw ToolError.not_found(`automation ${r}`);
  }
  if (wants_routines(ctx, args)) {
    const owner = own_routines(s, ctx, profile);
    const named = au.list_routines(s.db(), au.owner_profile_id(owner)).filter((a) => eq_ic(a.name, r));
    if (named.length === 0) throw ToolError.not_found(`routine ${r} (use list_automations with routines=true)`);
    if (named.length === 1) return [named[0], owner];
    throw ToolError.other(`there are several routines named ${r}; give its id (see list_automations)`);
  }
  const pid = typeof args.project_id === "string" && args.project_id ? args.project_id : null;
  const p = project_or_own(s, ctx, pid, profile, own_project);
  const named = au.list(s.db(), p.id).filter((a) => eq_ic(a.name, r));
  if (named.length === 0) throw ToolError.not_found(`automation ${r} in ${p.key} (use list_automations)`);
  if (named.length === 1) return [named[0], { project: p }];
  throw ToolError.other(`${p.key} has several automations named ${r}; give its id (see list_automations)`);
}

export function has_secret(a: au.Automation): boolean {
  return !!a.secret;
}

/** An automation as list_automations shows it, with its webhook's full URL when the host's public_url is set. */
export function automation_json(s: Shared, a: au.Automation): any {
  const c = s.db();
  const v = au.to_json(c, a);
  if (au.is_webhook(a)) {
    let url: string | null = null;
    try {
      url = db.get_setting(c, "public_url");
    } catch {}
    if (url) v.webhook_url = `${url}${au.hook_path(a)}`;
    else v.webhook_note = "hook_path is on this host; the full URL depends on how it's reached from outside (the host's public_url setting isn't set)";
  }
  return v;
}

/** What an automation runs under besides its trigger and action, as its approval shows them. */
export interface Guards {
  active_hours: au.ActiveHours | null;
  precheck: string | null;
  budget_usd: number | null;
}

export function Guards_default(): Guards {
  return { active_hours: null, precheck: null, budget_usd: null };
}

/** Rust's `Guards::of`. */
export function Guards_of(a: au.Automation): Guards {
  return { active_hours: a.active_hours, precheck: a.precheck, budget_usd: a.budget_usd };
}

/**
 * An automation as its approval shows it: what it is, and the task its message goes to and the agent config its tasks
 * use, by name.
 */
export function automation_view(
  s: Shared,
  id: string,
  name: string,
  enabled: boolean,
  trigger: au.Trigger,
  action: au.Action,
  signed: boolean,
  guards: Guards,
): any {
  const v: any = { id, name, enabled, trigger, action, signed };
  if (guards.active_hours !== null) v.active_hours = guards.active_hours;
  if (guards.precheck !== null) v.precheck = guards.precheck;
  if (guards.budget_usd !== null) v.budget_usd = guards.budget_usd;
  const act: any = action;
  if (act.kind === "send_to_task") {
    let t: db.Task | null = null;
    try {
      t = db.get_task(s.db(), act.task_id);
    } catch {}
    if (t) v.target = { id: t.id, key: `${project_key(s, t)}-${t.number}`, title: t.title, status: t.status };
  } else if (act.kind === "create_task" && act.claude_config_id) {
    let c: db.ClaudeConfig | null = null;
    try {
      c = db.get_claude_config(s.db(), act.claude_config_id);
    } catch {}
    if (c) v.config = { id: c.id, name: c.name, agent: c.agent };
  }
  return v;
}

/**
 * What an automation approval asks: `op` (create, update or delete) on `automation` (see automation_view) in project `p`
 * (or for a routine, of profile `p`), asked by the calling agent, with the time zone its times of day are in.
 */
export function automation_input(s: Shared, ctx: Ctx, op: string, owner: au.Owner, automation: any): any {
  const time_zone = au.time_zone();
  const v: any = { op, task: approval_task(s, ctx), automation, time_zone };
  if ("project" in owner) v.project = approval_project(s, owner.project);
  else {
    let name = "";
    try {
      name = db.get_profile(s.db(), owner.profile)?.name ?? "";
    } catch {}
    v.profile = { id: owner.profile, name, host: s.host_name };
  }
  // serde_json's map, sorted by key.
  return Object.fromEntries(
    Object.keys(v)
      .sort()
      .map((k) => [k, v[k]]),
  );
}

/**
 * An automation's action as an agent gives it, checked against its owner: a message's task can be named by key, and has
 * to be one of the project's.
 */
function automation_action(s: Shared, ctx: Ctx, owner: au.Owner, v: any, profile: string | null): au.Action {
  let action: any = au.parse("action", v, "action");
  if (action.kind === "send_to_task" && "project" in owner) {
    const p = owner.project;
    const task_id: string = action.task_id;
    let t: db.Task;
    try {
      t = resolve_task(s, ctx, task_id.trim(), profile);
    } catch (e) {
      const err = te(e);
      throw err.kind === "NotFound" ? ToolError.other(`task ${task_id} not found in ${p.key}`) : err;
    }
    action = { ...action, task_id: t.id };
  }
  return au.check_action(s.db(), owner, action);
}

/** An automation's guards as an agent gives them, each kept as it was if left out. */
function automation_guards(args: any, was: Guards): Guards {
  const given = (k: string) => args !== null && typeof args === "object" && Object.hasOwn(args, k);
  return {
    active_hours: given("active_hours") ? au.check_active_hours(args.active_hours) : was.active_hours,
    precheck: given("precheck") ? au.check_precheck(args.precheck) : was.precheck,
    budget_usd: given("budget_usd") ? au.check_budget(args.budget_usd) : was.budget_usd,
  };
}

/** What `create_automation` asks the user to approve: the automation, checked. */
export function automation_creation(s: Shared, ctx: Ctx, owner: au.Owner, args: any, profile: string | null): any {
  const name = au.check_name(args.name ?? null);
  const trigger = au.check_trigger(au.parse("trigger", args.trigger ?? null, "trigger"));
  const action = automation_action(s, ctx, owner, args.action ?? null, profile);
  const guards = automation_guards(args, Guards_default());
  const enabled = typeof args.enabled === "boolean" ? args.enabled : true;
  const generate_secret = args.generate_secret === true;
  if (generate_secret && (trigger as any).kind !== "webhook") throw ToolError.other("only a webhook can have a secret");
  if (enabled && trigger.kind === "at" && au.next_after(trigger, Date.now(), au.Local) === null) {
    throw ToolError.other("its time (at) has passed: give it one to come");
  }
  const view = automation_view(s, "", name, enabled, trigger, action, generate_secret, guards);
  const input = automation_input(s, ctx, "create", owner, view);
  input.apply = {
    action,
    active_hours: guards.active_hours,
    budget_usd: guards.budget_usd,
    enabled,
    generate_secret,
    name,
    precheck: guards.precheck,
    trigger,
  };
  input.reason = args.reason ?? null;
  return input;
}

/**
 * What `update_automation` asks the user to approve (`{ask: input}`), or the change to make without asking (`{apply}`):
 * turning the automation off, or renaming it. Only what differs is changed, so a setting left as it was can't overwrite
 * a change the user made meanwhile.
 */
export function automation_update(
  s: Shared,
  ctx: Ctx,
  a: au.Automation,
  owner: au.Owner,
  args: any,
  profile: string | null,
): { ask: any } | { apply: Record<string, any> } {
  const apply: Record<string, any> = {};
  const name = args.name == null ? a.name : au.check_name(args.name);
  if (name !== a.name) apply.name = name;
  const trigger = args.trigger == null ? a.trigger : au.check_trigger(au.parse("trigger", args.trigger, "trigger"));
  if (!json_eq(trigger, a.trigger)) apply.trigger = trigger;
  const action = args.action == null ? a.action : automation_action(s, ctx, owner, args.action, profile);
  if (!json_eq(action, a.action)) apply.action = action;
  const was = Guards_of(a);
  const guards = automation_guards(args, was);
  if (!json_eq(guards.active_hours, was.active_hours)) apply.active_hours = guards.active_hours;
  if (guards.precheck !== was.precheck) apply.precheck = guards.precheck;
  if (guards.budget_usd !== was.budget_usd) apply.budget_usd = guards.budget_usd;
  let enabled: boolean;
  if (args.enabled == null) enabled = a.enabled;
  else if (typeof args.enabled === "boolean") enabled = args.enabled;
  else throw ToolError.other("enabled must be true or false");
  if (enabled !== a.enabled) apply.enabled = enabled;
  const webhook = (trigger as any).kind === "webhook";
  const [generate, remove, rotate] = [args.generate_secret === true, args.remove_secret === true, args.rotate_url === true];
  if ((generate || rotate) && !webhook) throw ToolError.other("only a webhook has a secret or a URL");
  if (generate && remove) throw ToolError.other("generate_secret and remove_secret can't both be true");
  if (generate) apply.generate_secret = true;
  else if (remove && has_secret(a)) apply.secret = "";
  if (rotate) apply.rotate_token = true;
  const keys = Object.keys(apply);
  if (!keys.length) throw ToolError.other("nothing to change");
  // Turning it off, or renaming it, doesn't make it do anything it didn't.
  if (keys.every((k) => k === "name" || k === "enabled") && (!enabled || a.enabled)) return { apply };
  const signed = generate ? true : remove ? false : has_secret(a);
  const input = automation_input(s, ctx, "update", owner, automation_view(s, a.id, name, enabled, trigger, action, signed, guards));
  input.before = automation_view(s, a.id, a.name, a.enabled, a.trigger, a.action, has_secret(a), was);
  // serde_json's map, sorted by key.
  input.changes = [...keys].sort();
  input.apply = apply;
  input.reason = args.reason ?? null;
  return { ask: input };
}

/**
 * Asks the user to approve the automation change `input` describes (see automation_input), then makes it, exactly as
 * they saw it. A new secret is made once it's approved, and returned.
 */
export async function change_automation(s: Shared, ctx: Ctx, input: any): Promise<any> {
  const op: string = typeof input?.op === "string" ? input.op : "";
  const tool = `${op}_automation`;
  const id: string = typeof input?.automation?.id === "string" ? input.automation.id : "";
  let approved: any;
  try {
    approved = await ask_user(s, ctx, tool, input);
  } catch (e) {
    // Deleted while the user was asked.
    if (op !== "create" && !au.get(s.db(), id)) {
      const name = typeof input?.automation?.name === "string" ? input.automation.name : id;
      throw ToolError.other(`the automation "${name}" was deleted meanwhile, so nothing was changed`);
    }
    throw e;
  }
  const apply: Record<string, any> = approved?.apply && typeof approved.apply === "object" && !Array.isArray(approved.apply) ? { ...approved.apply } : {};
  const generate = apply.generate_secret === true;
  delete apply.generate_secret;
  const secret = generate ? new_token() : null;
  if (secret !== null) apply.secret = secret;
  let a: au.Automation;
  if (op === "create" && approved?.profile !== null && typeof approved?.profile === "object" && !Array.isArray(approved.profile)) {
    a = au.create_routine(s, typeof approved.profile.id === "string" ? approved.profile.id : "", apply);
  } else if (op === "create") a = au.create(s, typeof approved?.project?.id === "string" ? approved.project.id : "", apply);
  else if (op === "update") a = au.update(s, id, apply);
  else {
    const gone = au.delete(s, id);
    return { deleted: true, id: gone.id, name: gone.name };
  }
  const out = automation_json(s, a);
  if (secret !== null) {
    out.secret = secret;
    out.secret_note = "Deliveries must be signed with this secret (X-Hub-Signature-256, as GitHub does). It isn't shown again.";
  }
  return out;
}
