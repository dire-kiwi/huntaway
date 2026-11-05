// Port of server/src/mcp/tools/dispatch.rs: running a tool call: deduplicating the MCP helper's calls, and sending each
// to this host or to the linked host that has its project or task (with the API version each tool needs there).
import * as db from "../../db.ts";
import type { Task } from "../../db.ts";
import type { Shared } from "../../state.ts";
import * as api from "../../api.ts";
import * as hub from "../../hosts/hub.ts";
import * as runner from "../../agent/runner.ts";
import * as review from "../../review.ts";
import * as approval_rules from "../../agent/approval_rules.ts";
import * as workflows from "../../integrations/workflows.ts";
import * as mcp from "../../mcp.ts";
import * as permissions from "../permissions.ts";
import * as questions from "../questions.ts";
import * as wait from "../wait.ts";
import * as pr_watch from "../pr_watch.ts";
import { err_str, new_id, now, reached } from "../../util.ts";
import * as uplink from "../../hosts/uplink.ts";
import type { ToolCall } from "../../hosts/proto.ts";
import { te, msg, type Ctx } from "../tools.ts";
import { local } from "./local.ts";
import { project_key, resolve_task } from "./resolve.ts";
import { summary, task_field, task_overview } from "./tasks.ts";
import { AGENT_FIELDS, APPROVAL_FIELDS } from "./projects.ts";

/**
 * What an agent's MCP helper sends. Helpers from older builds keep running after an upgrade, so this shape must stay
 * backwards compatible (only add optional fields).
 */
export interface McpCall {
  run_id: string;
  call_id: string;
  tool: string;
  /** Missing (null) from some helpers. */
  args?: any;
  /** Missing on helpers that predate get_task_field and survive a daemon upgrade. */
  task_fields?: boolean;
}

/** An error for the caller (Rust's `Err(String)`). */
const fail = (m: string) => new Error(m);

/**
 * The tools a call to which is run again when it's retried after being cut short (by a restart, say): they only read,
 * record what they're given, or pick up where they left off (`wait` and `permission_prompt`, by their call id). A call to
 * another tool that was cut short may have taken effect, so it isn't run again.
 */
const RERUNNABLE = ["permission_prompt", "request_user_input", "submit_review", "wait", "list_projects", "list_tasks", "get_task", "get_project", "list_automations", "list_workflows"];

type CallResult = { ok: any } | { err: string };

/**
 * An agent's tool call, at most once per call id: it's recorded as executing before it runs, and with its result once it
 * has. Throws an Error with the message for the agent (Rust's `Err(String)`).
 */
export async function handle_mcp(s: Shared, c: McpCall): Promise<any> {
  const r = await handle_mcp_result(s, c);
  if ("err" in r) throw fail(r.err);
  return r.ok;
}

async function handle_mcp_result(s: Shared, c: McpCall): Promise<CallResult> {
  const call: Required<McpCall> = { run_id: c.run_id, call_id: c.call_id, tool: c.tool, args: c.args ?? null, task_fields: c.task_fields === true };
  let task_id = "";
  try {
    task_id = db.get_run(s.db(), call.run_id)?.task_id ?? "";
  } catch {}
  const record: Record = { id: call.call_id, run_id: call.run_id, task_id, tool: call.tool, args: call.args };
  return at_most_once(s, record, () => rerunnable(s, call), () => execute_mcp(s, call));
}

/** How a call is recorded in `mcp_calls`. */
interface Record {
  id: string;
  run_id: string;
  task_id: string;
  tool: string;
  args: any;
}

/**
 * Run `exec` once for call `r.id`, however often it's delivered: a duplicate delivery while it runs waits for its result,
 * and one after it ran gets the result recorded. A call that was executing when the server stopped runs again only if
 * `rerun` says it can.
 */
async function at_most_once(s: Shared, r: Record, rerun: () => boolean, exec: () => Promise<any>): Promise<CallResult> {
  // A duplicate delivery while the first is still executing waits for its result.
  const waiters = s.calls_inflight.get(r.id);
  if (waiters) return new Promise<CallResult>((resolve) => waiters.push(resolve));
  s.calls_inflight.set(r.id, []);
  // The waiters on this call, once it's done (or cut short, which lets them go: a retry then finds it recorded as
  // executing but not done).
  let result: CallResult | null = null;
  try {
    // Nothing runs unless the board knows it's running: a call it can't record may already have.
    let before: { status: string; result: string | null; error: string | null } | undefined;
    let before_err: unknown = null;
    try {
      before = db.one(s.db(), "SELECT status, result, error FROM mcp_calls WHERE id=?1", r.id);
    } catch (e) {
      before_err = e;
    }
    const record = (status: string, res: CallResult | null) => {
      const [out, err] = res === null ? [null, null] : "ok" in res ? [JSON.stringify(res.ok ?? null), null] : [null, res.err];
      db.run(
        s.db(),
        `INSERT INTO mcp_calls (id,run_id,task_id,tool,args,status,result,error,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)
         ON CONFLICT(id) DO UPDATE SET status=?6, result=?7, error=?8`,
        r.id,
        r.run_id,
        r.task_id,
        r.tool,
        JSON.stringify(r.args ?? null),
        status,
        out,
        err,
        now(),
      );
    };
    const unrecorded = (e: unknown) => `The board couldn't record this ${r.tool} call, so it wasn't run (call it again): ${sql_error(e)}`;
    const done = (res: CallResult) => {
      try {
        record("done", res);
      } catch (e) {
        console.error(`recording an MCP call's result (call ${r.id}, tool ${r.tool}): ${err_str(e)}`);
      }
    };
    if (before_err !== null) result = { err: unrecorded(before_err) };
    else if (before && before.status === "done") {
      if (before.error !== null && before.error !== undefined) result = { err: before.error };
      else {
        let v: any = null;
        try {
          v = before.result === null ? null : JSON.parse(before.result);
        } catch {}
        result = { ok: v };
      }
    } else if (before && !rerun()) {
      // Executing when the server stopped.
      result = {
        err:
          `This ${r.tool} call was interrupted (the board's server restarted while it ran), so it isn't run again: it may or may not have ` +
          "taken effect. Check (with get_task or list_tasks, say) before you call it again.",
      };
      done(result);
    } else {
      let recorded = true;
      try {
        record("executing", null);
      } catch (e) {
        recorded = false;
        result = { err: unrecorded(e) };
      }
      if (recorded) {
        let res: CallResult;
        try {
          res = { ok: await exec() };
        } catch (e) {
          res = { err: err_str(e) };
        }
        reached("mcp:executed");
        done(res);
        result = res;
      }
    }
    return result!;
  } finally {
    const list = s.calls_inflight.get(r.id) ?? [];
    s.calls_inflight.delete(r.id);
    // Cut short (it threw), the duplicates are let go: a retry then finds the call recorded as executing.
    for (const w of list) w(result ?? { err: "call abandoned" });
  }
}

/** A database error's message, as rusqlite's Display has it. */
function sql_error(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Whether call `c`, cut short, can run again. An `update_project`, `delete_task` or a change to an automation can while
 * the user hasn't approved what it asked (nothing is changed before then): it carries on waiting for them.
 */
function rerunnable(s: Shared, c: Required<McpCall>): boolean {
  // One that was waiting for an approval rule's prompt (see check_rules) hasn't done anything yet.
  try {
    const ruled = db.value<string>(s.db(), "SELECT status FROM permission_requests WHERE call_id=?1 AND kind='tool' AND rule IS NOT NULL", c.call_id);
    if (ruled !== undefined && ruled !== "allowed") return true;
  } catch {}
  if (RERUNNABLE.includes(c.tool)) return true;
  let kind: string;
  if (c.tool === "update_project" || c.tool === "create_project") kind = "project";
  else if (c.tool === "delete_task") kind = "delete_task";
  else if (["create_automation", "update_automation", "delete_automation"].includes(c.tool)) kind = "automation";
  else if (["create_workflow", "update_workflow", "delete_workflow"].includes(c.tool)) kind = "automation";
  else return false;
  try {
    const status = db.value<string>(s.db(), "SELECT status FROM permission_requests WHERE call_id=?1 AND kind=?2", c.call_id, kind);
    return status !== undefined && status !== "allowed";
  } catch {
    return false;
  }
}

async function execute_mcp(s: Shared, c: Required<McpCall>): Promise<any> {
  const bad = mcp.check_args(c.tool, c.args);
  if (bad !== null) throw fail(bad);
  const args = c.args && typeof c.args === "object" && !Array.isArray(c.args) ? c.args : {};
  const run = db.get_run(s.db(), c.run_id);
  if (!run) throw fail("unknown run");
  // The board has reported the run as over (its supervisor vanished, say, while the agent went on), so its thread is no
  // longer its own: nothing it asks for is done.
  if (run.status === "exited") {
    throw fail(`This run has ended on the board, so its ${c.tool} call wasn't run. Stop here: the board no longer follows this run.`);
  }
  const task = db.get_task(s.db(), run.task_id);
  if (!task) throw fail("unknown task");
  // Whatever the run's tool list offers (see mcp::tools), a reviewer only reads.
  if (task.kind === "review" && !mcp.for_reviewers(c.tool)) {
    throw fail(`${c.tool} isn't available to reviewers: they can only read the board and submit_review`);
  }
  // Nor does a thread in plan mode, until its plan is approved (which changes its mode, see
  // permissions::mode_after_plan): the run's tool list was fixed when it started.
  if (!mcp.for_planning(c.tool) && planning(s, task)) {
    throw fail(
      `${c.tool} isn't available in plan mode: until the user approves your plan (present it with ExitPlanMode), you can only read the board, ` +
        "wait and request_user_input",
    );
  }
  const profile = db.get_profile(s.db(), task.profile_id);
  if (!profile) throw fail("unknown profile");
  // Any other call means the run is working again (see mcp/wait.rs). Not a permission prompt: subagents raise them too,
  // and the agent's own tool calls end the wait before theirs.
  if (c.tool !== "wait" && c.tool !== "permission_prompt") wait.resumed(s, task.id, run.id);
  // The user's approval rules hold for every board tool but the plumbing of prompts and questions, `wait` included (its
  // command runs as the agent's own would).
  if (c.tool !== "permission_prompt" && c.tool !== "request_user_input") await check_rules(s, task, c.call_id, c.tool, args);
  switch (c.tool) {
    case "permission_prompt": {
      const tool_name = typeof args.tool_name === "string" ? args.tool_name : "";
      return permissions.prompt(s, task, c.call_id, tool_name, args.input ?? null, typeof args.tool_use_id === "string" ? args.tool_use_id : null);
    }
    case "request_user_input": {
      const card = questions.card(args);
      const question = typeof card.question === "string" ? card.question : "The agent needs your input";
      db.run(s.db(), "UPDATE runs SET attention=?1 WHERE id=?2", question, c.run_id);
      const options = Array.isArray(card.options) && card.options.length > 0;
      questions.ask(s, task, c.call_id, card);
      const note = options
        ? "The user will be notified and shown your question with its options. End your turn now; their answer (the options " +
          "they picked, or what they wrote) comes as their next message."
        : "The user will be notified. End your turn now with your question.";
      return { ok: true, note };
    }
    case "submit_review":
      if (workflows.is_workflow(task)) return workflows.submit(s, task, run.id, args);
      return review.submit(s, task, run.id, args);
    case "wait":
      return wait_tool(s, c, args, run, task, profile);
    default: {
      const ctx: Ctx = { profile_id: profile.id, profile_name: profile.name, task, call_id: c.call_id, task_fields: c.task_fields, from_host: null };
      return dispatch(s, ctx, c.tool, args);
    }
  }
}

/** The `wait` tool. */
async function wait_tool(s: Shared, c: Required<McpCall>, args: any, run: db.Run, task: Task, profile: db.Profile): Promise<any> {
  const ctx: Ctx = { profile_id: profile.id, profile_name: profile.name, task, call_id: null, task_fields: c.task_fields, from_host: null };
  const watched: db.WaitTask[] = [];
  const resuming = wait.resuming(task, c.call_id);
  // A call retried after a restart watches what it started with, even tasks since deleted.
  if (!resuming && Array.isArray(args.tasks)) {
    for (const r of args.tasks) {
      if (typeof r !== "string") throw fail("tasks must be a list of task ids or keys");
      let t: Task;
      try {
        t = resolve_task(s, ctx, r, null);
      } catch (e) {
        const err = te(e);
        throw fail(err.kind === "NotFound" ? `task ${r} not found on this host (wait can only watch tasks on the host it runs on)` : err.message);
      }
      watched.push({ id: t.id, key: `${project_key(s, t)}-${t.number}`, status: t.status });
    }
  }
  const reason = typeof args.reason === "string" ? args.reason : null;
  const command = typeof args.command === "string" && args.command.trim() ? args.command.trim() : null;
  // The command runs as the agent's own Bash calls would, so it's approved like them: in auto mode the agent's reviewer
  // (Claude's or Codex's) has already reviewed this call, otherwise the user (or the mode) decides. An approval rule on
  // Bash holds for it whoever reviewed the call: a wait's command is a command.
  if (command !== null && !resuming && (!runner.agent_reviews_waits(s, run.id) || ruled_bash(s, task))) {
    const cwd = runner.work_dir(s, task);
    const description = `Run while waiting${reason !== null ? `: ${reason}` : ""}`;
    const input = { command, cwd, description };
    const answer = await permissions.prompt(s, task, c.call_id, "Bash", input, null);
    if (answer?.behavior !== "allow") {
      throw fail(`The command wasn't approved, so the wait didn't start: ${typeof answer?.message === "string" ? answer.message : "denied"}`);
    }
  }
  // Read as the task's GitHub account, which isn't asked about: it only reads.
  const pr = args.pull_request;
  const pull_request =
    pr == null || resuming || (typeof pr === "string" && !pr.trim()) ? null : await pr_watch.request(s, task, pr, args.pull_request_events ?? null);
  const req = { reason, seconds: typeof args.seconds === "number" ? args.seconds : null, tasks: watched, command, pull_request };
  const started = Date.now();
  const [ended, w] = await wait.wait(s, run, task, c.call_id, req);
  const changed: string[] = ended.kind === "Tasks" ? w.tasks.filter((x: db.WaitTask) => ended.tasks.includes(x.id)).map((x: db.WaitTask) => x.key) : [];
  const tasks = w.tasks.map((x: db.WaitTask) => {
    let t: Task | null = null;
    try {
      t = db.get_task(s.db(), x.id);
    } catch {}
    return t ? summary(s, t) : { id: x.id, key: x.key, deleted: true };
  });
  const result: any = { ended: wait.name(ended), waited_seconds: Math.floor((Date.now() - started) / 1000), note: wait.note(ended, changed), tasks };
  if (ended.kind === "Command") result.command = { exit_code: ended.code, output: ended.output };
  if (ended.kind === "Subagent") result.subagent = ended.agent;
  // Its news, whatever ended the wait, or else how it was when last read.
  if (w.pull_request) {
    const p = w.pull_request;
    if (p.news != null) {
      if (ended.kind !== "PullRequest") result.note = `${result.note ?? ""} ${pr_watch.note(p.news)}`;
      result.pull_request = p.news;
    } else result.pull_request = pr_watch.last(s, task.id, p) ?? { url: p.url, number: p.number };
  }
  return result;
}

/** Whether the user's approval rules ask about or refuse Bash in `task`'s thread now (see agent/approval_rules.ts). */
function ruled_bash(s: Shared, task: Task): boolean {
  const rules = approval_rules.for_task(s.db(), task);
  if (!rules) return false;
  const project = task.project_id ? db.get_project(s.db(), task.project_id) : null;
  const mode = db.effective_permission_mode(task, s.db(), project);
  const r = approval_rules.decide(approval_rules.for_mode(rules, mode), "Bash");
  return r !== null && r.decision !== "allow";
}

/**
 * The user's approval rules for the board's own tools, which the board holds as it runs them for either runtime (see
 * agent/approval_rules.ts): a call a never rule matches is refused, and one an ask rule matches waits for the user's
 * answer, as a permission prompt.
 */
async function check_rules(s: Shared, task: Task, call_id: string, tool: string, args: any): Promise<void> {
  const rules = approval_rules.for_task(s.db(), task);
  if (!rules) return;
  const found = approval_rules.board_rule(rules, tool);
  if (!found) return;
  const [name, rule] = found;
  // The tools that ask the user themselves, whatever the mode, aren't asked about twice (their own request carries the
  // rule, see permissions.approve); never still refuses them.
  if (rule.decision === "allow" || (rule.decision === "ask" && approval_rules.ASKS_ITSELF.includes(tool))) return;
  const answer = await permissions.prompt(s, task, call_id, name, args, null);
  if (answer?.behavior === "allow") return;
  throw fail(typeof answer?.message === "string" ? answer.message : "The user denied this action.");
}

/** Whether thread `task` is in plan mode now (its own mode, or the one it inherits). */
function planning(s: Shared, task: Task): boolean {
  const project = task.project_id ? db.get_project(s.db(), task.project_id) : null;
  return db.effective_permission_mode(task, s.db(), project) === "plan";
}

/**
 * A tool call forwarded from another host's agent in the profile named `profile_name`: run it here only, on this host's
 * profile of that name and those that let it in. Throws an Error with the message for the caller.
 */
export async function handle_remote(s: Shared, tool: string, profile_name: string, args: any, task_fields: boolean): Promise<any> {
  const profiles = db.list_profiles(s.db());
  const own = profiles.find((p) => p.name === profile_name);
  if (!own && !profiles.some((p) => db.grants(p, profile_name))) {
    throw fail(`host ${s.host_name} has no profile named ${profile_name}, and no profile there lets its agents in`);
  }
  const ctx: Ctx = { profile_id: own?.id ?? null, profile_name, task: null, call_id: null, task_fields, from_host: null };
  try {
    return await local(s, ctx, tool, args ?? null);
  } catch (e) {
    const err = te(e);
    throw fail(err.kind === "NotFound" ? `not found: ${err.message}` : err.message);
  }
}

/** The tools that act for the calling agent's own thread, which only its own host can run. */
const THREAD_TOOLS = ["permission_prompt", "request_user_input", "submit_review", "wait"];

/**
 * A board tool call from an agent on linked host `host_id` that it passed up its link (see hosts/uplink.ts), once
 * `hub::run_up_call` has let it in (the switch, and a profile whose assistant runs there): run here with the access of
 * this host's profile of the caller's name, as `handle_remote` does, and on this host's other links, but never up again,
 * nor back down to that host. At most once per call id. Throws an Error with the message for the caller.
 */
export async function handle_up_call(s: Shared, host_id: string, c: ToolCall): Promise<any> {
  const [id, run_id] = [`up:${host_id}:${c.call_id}`, `up:${host_id}`];
  const record: Record = { id, run_id, task_id: "", tool: c.tool, args: c.args ?? null };
  const r = await at_most_once(s, record, () => RERUNNABLE.includes(c.tool), async () => {
    if (THREAD_TOOLS.includes(c.tool)) throw fail(`${c.tool} only works on the host the agent runs on`);
    const bad = mcp.check_args(c.tool, c.args ?? null);
    if (bad !== null) throw fail(bad);
    const profiles = db.list_profiles(s.db());
    const own = profiles.find((p) => p.name === c.profile);
    if (!own && !profiles.some((p) => db.grants(p, c.profile))) {
      throw fail(`not found: ${s.host_name} has no profile named ${c.profile}, and no profile there lets its agents in`);
    }
    const ctx: Ctx = { profile_id: own?.id ?? null, profile_name: c.profile, task: null, call_id: id, task_fields: c.task_fields, from_host: host_id };
    return dispatch(s, ctx, c.tool, c.args ?? null);
  });
  if ("err" in r) throw fail(r.err);
  return r.ok;
}

/** The hubs `ctx`'s call may go up to: none for a call that came up a link itself. */
function uplinks(s: Shared, ctx: Ctx): uplink.Uplink[] {
  return ctx.from_host ? [] : uplink.hubs(s);
}

/** The links `ctx`'s call may go down to: not back to the host it came up from. */
function links_for(s: Shared, ctx: Ctx): hub.LinkHandle[] {
  return hub.connected_links(s).filter((l) => !ctx.from_host || l.id !== ctx.from_host);
}

/** The id a call goes up a link with, by which the hub runs it at most once. */
function up_call_id(ctx: Ctx): string {
  return ctx.call_id ?? new_id();
}

/** Why hubs that said no, by name with their reasons, might have had it. */
function off_note(s: Shared, off: Array<[string, string | null]>): string {
  const why = off.map(
    ([hub_name, why]) =>
      why ??
      `${hub_name} doesn't let this host's agents use its board; the user can switch on "Let this host's agents use this board" for ${s.host_name} ` +
        "in Settings → Hosts there",
  );
  return why.length ? ` (${why.join("; ")})` : "";
}

/** Run a board tool here, falling back to (or fanning out over) linked hosts. Throws an Error with the message. */
export async function dispatch(s: Shared, ctx: Ctx, tool: string, args: any): Promise<any> {
  args = args && typeof args === "object" && !Array.isArray(args) ? args : {};
  const h = typeof args.host === "string" ? args.host : "";
  if (h) {
    if (h !== s.host_name && h !== s.host_id) {
      const link = hub.find_link(s, h);
      if (link) {
        const old = too_old(link.name, link.version.api_version, tool, args);
        if (old !== null) throw fail(old);
        return call_linked(s, link, tool, ctx.profile_name, args, ctx.task_fields);
      }
      // A hub this host is linked to, or one of its hosts: it goes there with `host` as it is.
      const ups = uplinks(s, ctx);
      const up = ups.find((u) => u.hub_id === h || u.hub_name.toLowerCase() === h.toLowerCase()) ?? ups[0];
      if (!up) throw fail(`no linked host named ${h}`);
      const o = await up.call(up_call_id(ctx), tool, ctx.profile_name, args, ctx.task_fields);
      if (o.kind === "Ok") return o.value;
      if (o.kind === "Err") throw fail(o.error);
      throw fail(`no linked host named ${h}${off_note(s, [[up.hub_name, o.why]])}`);
    }
    try {
      return await local(s, ctx, tool, args);
    } catch (e) {
      throw fail(msg(e));
    }
  }
  const fan_out = tool === "list_projects" || (tool === "list_tasks" && (args.project_id === "all" || args.profile === "all"));
  if (fan_out) {
    // A profile that's only on other hosts isn't found here.
    let all: any[] = [];
    let missing: string | null = null;
    try {
      const v = await local(s, ctx, tool, args);
      all = Array.isArray(v) ? [...v] : [];
    } catch (e) {
      const err = te(e);
      if (err.kind !== "NotFound") throw fail(err.message);
      missing = err.message;
    }
    for (const link of links_for(s, ctx)) {
      try {
        const v = await hub.call_tool(s, link, tool, ctx.profile_name, args, ctx.task_fields);
        if (Array.isArray(v)) {
          all.push(...v);
          missing = null;
        }
      } catch (e) {
        if (process.env.IA_DEBUG) console.error(`${tool} on ${link.name}: ${err_str(e)}`);
      }
    }
    // A hub's list covers its other hosts, which may be ours too: each item once.
    const call_id = up_call_id(ctx);
    for (const up of uplinks(s, ctx)) {
      const o = await up.call(call_id, tool, ctx.profile_name, args, ctx.task_fields);
      if (o.kind === "Ok" && Array.isArray(o.value)) {
        const seen = new Set(all.map((i) => i?.id).filter((id) => typeof id === "string"));
        all.push(...o.value.filter((i: any) => typeof i?.id !== "string" || !seen.has(i.id)));
        missing = null;
      } else if (o.kind === "Err" && process.env.IA_DEBUG) console.error(`${tool} on ${up.hub_name}: ${o.error}`);
    }
    if (missing !== null && !all.length) throw fail(`not found: ${missing}`);
    return all;
  }
  try {
    return await local(s, ctx, tool, args);
  } catch (e) {
    const err = te(e);
    if (err.kind !== "NotFound") throw fail(err.message);
    // Why a host that has it couldn't do it (e.g. a change that needs approval), rather than "not found".
    let refused: string | null = null;
    const skipped: string[] = [];
    for (const link of links_for(s, ctx)) {
      if (too_old(link.name, link.version.api_version, tool, args) !== null) {
        skipped.push(link.name);
        continue;
      }
      try {
        return await call_linked(s, link, tool, ctx.profile_name, args, ctx.task_fields);
      } catch (e2) {
        const m = err_str(e2);
        if (!m.startsWith("not found")) refused ??= m;
      }
    }
    // Then the hubs that take our calls, which look on their own boards and their other hosts.
    const off: Array<[string, string | null]> = [];
    for (const up of uplinks(s, ctx)) {
      const o = await up.call(up_call_id(ctx), tool, ctx.profile_name, args, ctx.task_fields);
      if (o.kind === "Ok") return o.value;
      if (o.kind === "Off") off.push([up.hub_name, o.why]);
      else if (!o.error.startsWith("not found")) refused ??= o.error;
    }
    const note = off_note(s, off);
    if (refused !== null) throw fail(refused);
    if (!skipped.length) throw fail(`not found: ${err.message}${note}`);
    throw fail(`not found: ${err.message} (${skipped.join(", ")} run an older build that can't do this, so they weren't asked)${note}`);
  }
}

/** The API version from which update_project takes every setting (and asks for approval). */
const PROJECT_SETTINGS_API = 44;

/** The API version from which update_project can move a project's folder (move_repo). */
const MOVE_REPO_API = 45;

/** The API version from which create_task and update_task take `starred`, `remind_at` and `reminder`. */
export const MARKS_API = 48;

/** The API version from which hosts have delete_task. */
const DELETE_TASK_API = 58;

/** The API version from which task details are bounded and get_task_field is available. */
export const TASK_FIELDS_API = 59;

/** The API version from which hosts have the automation tools. */
const AUTOMATIONS_API = 67;

const AUTOMATION_TOOLS = ["list_automations", "create_automation", "update_automation", "delete_automation", "run_automation"];

/** The API version from which hosts have workflows (HA-173). */
const WORKFLOWS_API = 107;

const WORKFLOW_TOOLS = ["list_workflows", "create_workflow", "update_workflow", "delete_workflow", "run_workflow"];

export const TASK_FIELD_DEFAULT_LIMIT = 2000;
export const TASK_FIELD_MAX_LIMIT = 4000;

/**
 * Older hosts return the full details from get_task. Bound or page that response here so agents can still read their
 * tasks without exposing the oversized legacy tool result. Throws an Error with the message.
 */
async function call_linked(s: Shared, link: any, tool: string, profile: string, args: any, task_fields: boolean): Promise<any> {
  const legacy = link.version.api_version < TASK_FIELDS_API;
  if (legacy && (tool === "get_task" || tool === "get_task_field")) {
    const details = await hub.call_tool(s, link, "get_task", profile, { task_id: args.task_id ?? null, profile: args.profile ?? null }, false);
    if (tool === "get_task_field") {
      try {
        return task_field(details, args);
      } catch (e) {
        throw fail(msg(e));
      }
    }
    return task_fields ? task_overview(details) : details;
  }
  return hub.call_tool(s, link, tool, profile, args, task_fields);
}

/**
 * Why `tool` can't go to linked host `host`, on API `api_version`: it runs a build from before it could do this (one
 * that would ignore the settings it doesn't know rather than say so). Null if it can.
 */
export function too_old(host: string, api_version: number, tool: string, args: any): string | null {
  const move_repo = tool === "update_project" && args.move_repo != null;
  // Clearing them (false, "") too: an older host would say it had.
  const marks = ["create_task", "update_task"].includes(tool) && api.MARK_FIELDS.some((k: string) => args[k] != null);
  if (marks && api_version < MARKS_API) return `${host} runs an older build that can't star tasks or set reminders; ask the user to update it`;
  if (tool === "delete_task" && api_version < DELETE_TASK_API) {
    return `${host} runs an older build that can't delete tasks; ask the user to delete it on the board`;
  }
  if (AUTOMATION_TOOLS.includes(tool) && api_version < AUTOMATIONS_API) {
    return `${host} runs an older build without the automation tools; ask the user to update it, or to set it up in the project's settings`;
  }
  if (WORKFLOW_TOOLS.includes(tool) && api_version < WORKFLOWS_API) return `${host} runs an older build without workflows; ask the user to update it`;
  if ((needs_project_settings_api(tool, args) && api_version < PROJECT_SETTINGS_API) || (move_repo && api_version < MOVE_REPO_API)) {
    return `${host} runs an older build that can't do this with ${tool}; ask the user to update it, or to make the change in the project's settings`;
  }
  return null;
}

/** Whether a host needs PROJECT_SETTINGS_API for this call: update_project with a setting it couldn't change before. */
export function needs_project_settings_api(tool: string, args: any): boolean {
  const OLD_FIELDS = ["start_prompt", "review_prompt", "merge_prompt", "auto_review", "review_rounds", "reviewers", "group_name"];
  return tool === "update_project" && [...AGENT_FIELDS, ...APPROVAL_FIELDS].some((k) => !OLD_FIELDS.includes(k) && args[k] != null);
}
