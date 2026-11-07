// Port of server/src/api/thread.rs: a task's thread and agent: its messages, sending, stopping and reviewing, its
// worktree, diff and terminal, and agents' permission prompts.
import type { WebSocket } from "ws";
import * as db from "../db.ts";
import * as devices from "../devices.ts";
import type { Project, Task } from "../db.ts";
import { ApiError, Reply, type Req } from "../http.ts";
import type { AppState } from "../state.ts";
import { err_str } from "../util.ts";
import * as runner from "../agent/runner.ts";
import * as assistant from "../agent/assistant.ts";
import * as approval_rules from "../agent/approval_rules.ts";
import * as worktree from "../git/worktree.ts";
import * as terminal from "../hosts/terminal.ts";
import * as permissions from "../mcp/permissions.ts";
import * as questions from "../mcp/questions.ts";
import * as pr_watch from "../mcp/pr_watch.ts";
import * as review from "../review.ts";
import * as workflows from "../integrations/workflows.ts";
import * as summary from "../review/summary.ts";
import { def_str, json_map, opt_str, query_bool, query_int, query_opt_bool, req_str, body_rejection, def_bool } from "./extract.ts";
import { create_task_inner } from "./new_task.ts";
import * as batch from "../threads/batch.ts";
import * as live from "../threads/live.ts";

/**
 * A thread's messages: all of them as a list, or with any of `before`, `after` (message ids) and `limit`, one page of
 * them (API 56, see db::message_page) as `{messages, more, subagents}`. The latest page (without `before` or `after`)
 * has, in `subagents`, what lists the subagents started before it.
 */
export async function list_messages(s: AppState, r: Req) {
  const id = r.params.id;
  const before = query_int(r, "before");
  const after = query_int(r, "after");
  const limit = query_int(r, "limit", 0);
  const c = s.db();
  // Opening the thread: a task without items gets them (see threads/batch.ts), and the client switches to them.
  if (before === null && after === null) batch.opened(s, id);
  if (before === null && after === null && limit === null) return db.list_messages(c, id);
  const [messages, more] = db.message_page(c, id, after, before, limit);
  const subagents = messages.length && more && before === null && after === null ? db.subagent_messages(c, id, messages[0].id) : [];
  return { messages, more, subagents };
}

// ---------- the thread kept as items (API 114, docs/threads-api.md) ----------

/**
 * `GET /tasks/{id}/thread[?limit=N]`: the task's thread kept as items, as a Snapshot `{thread, items, requests, seq}`,
 * or with `limit` a window of its last N items (with `start` and `context`). A 404 for a task without items (a task
 * opened without them gets them first, with the setting on: see threads/batch.ts).
 */
export async function get_thread(s: AppState, r: Req) {
  batch.opened(s, r.params.id);
  const task = live.open(s, r.params.id);
  const limit = query_int(r, "limit", 0);
  return live.window(s, task, limit ?? undefined);
}

/** `GET /tasks/{id}/thread/items?before=I[&limit=N]`: an ItemPage of the thread's items before index I (100 of them unless `limit` says). */
export async function thread_items(s: AppState, r: Req) {
  const task = live.open(s, r.params.id);
  const before = query_int(r, "before", 0);
  if (before === null) throw ApiError.bad("before is required: the index of the window's start");
  return live.page(s, task, before, query_int(r, "limit", 0) ?? live.PAGE_ITEMS);
}

/**
 * `GET /tasks/{id}/thread/events?after=SEQ[&limit=N]`: `{events, more, seq}`, the thread's saved events after SEQ (0
 * unless given), at most N and 1000; with `resync: true` instead when the log no longer goes back that far.
 */
export async function thread_events(s: AppState, r: Req) {
  const task = live.open(s, r.params.id);
  return live.events(s, task, query_int(r, "after", 0) ?? 0, query_int(r, "limit", 1) ?? live.MAX_EVENTS);
}

/** `POST /tasks/{id}/thread/commands`: a protocol Command for the task's thread (see threads/live.ts's command). */
export async function thread_command(s: AppState, r: Req) {
  const task = live.open(s, r.params.id);
  return await live.command(s, task, r.body);
}

export async function send_message(s: AppState, r: Req) {
  const id = r.params.id;
  const text = def_str(json_map(r), "text");
  const t = runner.send(s, id, text);
  // The user's reply answers the questions the agent asked (see mcp/questions.rs).
  if (text.trim()) questions.replied(s, t.id);
  return t;
}

/**
 * `GET /profiles/{id}/assistant` (API 109): the profile's assistant (see agent/assistant.ts), made the first time it's
 * asked for. API 112: with its `host_id`, which is the profile's assistant host's when it has one, where the request goes
 * (see assistant::on_its_host), unless `local` is set: a hub that routed the request here sets it, and it's this host's
 * then, whatever its profile's `assistant_host`.
 */
export async function get_assistant(s: AppState, r: Req) {
  if (r.query.local === undefined) {
    const t = await assistant.on_its_host(s, r.params.id, "GET");
    if (t !== null) return t;
  }
  return assistant.with_host(s, assistant.get_or_create(s, r.params.id));
}

/**
 * `POST /profiles/{id}/assistant` (API 109): send the user's message to the profile's assistant, as `POST
 * /tasks/{id}/messages` does to its thread, making it first if it has none. Returns the task, on its assistant host if it
 * has one, as `GET` does (API 112).
 */
export async function send_to_assistant(s: AppState, r: Req) {
  const text = def_str(json_map(r), "text");
  if (r.query.local === undefined) {
    const t = await assistant.on_its_host(s, r.params.id, "POST", { text });
    if (t !== null) return t;
  }
  return assistant.with_host(s, assistant.send(s, r.params.id, text));
}

/** A profile's approval rules as the UI shows them: the ones in force, whether they're the defaults, and the defaults to go back to. */
function rules_view(c: db.Conn, profile_id: string): any {
  const saved = approval_rules.saved(c, profile_id);
  const defaults = approval_rules.Rules_default();
  return {
    rules: (saved ?? defaults).rules,
    expiry_minutes: (saved ?? defaults).expiry_minutes,
    is_default: saved === null,
    defaults,
    board_server: runner.MCP_SERVER_NAME,
    google_server: approval_rules.GOOGLE_SERVER,
    create_task_tools: approval_rules.CREATE_TASK_TOOLS,
  };
}

/**
 * `GET /profiles/{id}/approval-rules` (API 115): what the profile's assistant may do outside the board, asks first or
 * never does (see agent/approval_rules.ts).
 */
export async function get_approval_rules(s: AppState, r: Req) {
  const c = s.db();
  if (!db.get_profile(c, r.params.id)) throw ApiError.not_found("profile");
  return rules_view(c, r.params.id);
}

/**
 * `POST /profiles/{id}/approval-rules` (API 115) with `{rules, expiry_minutes}` (either may be left out, keeping it as it
 * is), or `{reset: true}` for the defaults. They hold from the next run on.
 */
export async function set_approval_rules(s: AppState, r: Req) {
  const b = json_map(r);
  let rules: approval_rules.Rule[] | null = null;
  if (b.rules != null) {
    rules = approval_rules.parse_rule_list(b.rules);
    if (rules === null) throw body_rejection("rules: invalid type, expected a sequence of {tool, decision} with decision allow, ask or never");
  }
  const e = b.expiry_minutes;
  if (e != null && !(Number.isInteger(e) && e >= 0 && e <= 0xffffffff)) throw body_rejection("expiry_minutes: invalid value, expected u32");
  const reset = def_bool(b, "reset");
  const c = s.db();
  const id = r.params.id;
  if (!db.get_profile(c, id)) throw ApiError.not_found("profile");
  if (reset) {
    approval_rules.set(c, id, null);
  } else {
    const current = approval_rules.get(c, id);
    let checked: approval_rules.Rules;
    try {
      checked = approval_rules.checked({ rules: rules ?? current.rules, expiry_minutes: e ?? current.expiry_minutes });
    } catch (err) {
      throw ApiError.bad(err_str(err));
    }
    approval_rules.set(c, id, checked);
  }
  const view = rules_view(c, id);
  s.emit({ type: "approval_rules", profile_id: id });
  return view;
}

/**
 * `GET /profiles/{id}/approval-log` (API 115): the calls the profile's rules asked about or turned away, newest first (see
 * approval_rules.Action).
 */
export async function approval_log(s: AppState, r: Req) {
  const limit = query_int(r, "limit");
  const c = s.db();
  if (!db.get_profile(c, r.params.id)) throw ApiError.not_found("profile");
  return approval_rules.list(c, r.params.id, limit ?? 200);
}

/** Answer a question an agent asked with request_user_input, from its card (API 64): the answer is sent as the user's message. */
export async function answer_question(s: AppState, r: Req) {
  const message_id = r.params.message_id;
  if (!/^[+-]?\d+$/.test(message_id)) return new Reply(400, `Invalid URL: Cannot parse \`${message_id}\` to a \`i64\``);
  const b = json_map(r);
  const choices = b.choices ?? [];
  if (!Array.isArray(choices) || !choices.every((c) => typeof c === "string")) throw body_rejection("choices: invalid type, expected a sequence of strings");
  const answer = { choices, text: opt_str(b, "text") };
  const task = db.get_task(s.db(), r.params.id);
  if (!task) throw ApiError.not_found("task");
  return questions.answer(s, task.id, Number(message_id), answer);
}

/** Drop the queued message. Returns the task as it was, queued message included. */
export async function unqueue_message(s: AppState, r: Req) {
  return runner.unqueue(s, r.params.id);
}

/** Stop the thread's agent, and the task's review if one is in progress. */
export async function stop_task(s: AppState, r: Req) {
  const id = r.params.id;
  const agent = runner.stop(s, id);
  const reviewing = review.stop(s, id);
  const summarising = summary.stop(s, id);
  const workflow_runs = workflows.stop(s, id);
  return { stopped: agent || reviewing || summarising || workflow_runs };
}

/** Summarise the task's changes now (see review/summary.rs). */
export async function summarise_task(s: AppState, r: Req) {
  return await summary.start(s, r.params.id, true);
}

/** Review the task's work now (see review.rs). */
export async function review_task(s: AppState, r: Req) {
  return await review.start(s, r.params.id, true);
}

/** Give a task that ran out of rounds of fixes as many again (API 93, see review::extend). */
export async function extend_review(s: AppState, r: Req) {
  return review.extend(s, r.params.id);
}

/** Send the agent its pull request's failed checks, with the ends of their logs (API 94, see mcp/pr_watch.rs's fix_checks). */
export async function fix_checks(s: AppState, r: Req) {
  return await pr_watch.fix_checks(s, r.params.id);
}

export async function setup_worktree(s: AppState, r: Req) {
  const id = r.params.id;
  // Reviewers work in the worktree too.
  if (worktree.agent_in_worktree(s, id))
    throw ApiError.conflict("an agent is working in the worktree (the task's or a reviewer's); wait for it to finish or stop it");
  try {
    return await worktree.setup(s, id);
  } catch (e) {
    throw ApiError.bad(err_str(e));
  }
}

export async function teardown_worktree(s: AppState, r: Req) {
  const id = r.params.id;
  // Reviewers work in the worktree too.
  if (worktree.agent_in_worktree(s, id))
    throw ApiError.conflict("an agent is working in the worktree (the task's or a reviewer's); wait for it to finish or stop it");
  // The body is optional: `{force, delete_branch}`, both false by default.
  const b = r.body !== null && typeof r.body === "object" && !Array.isArray(r.body) ? r.body : {};
  const force = def_bool(b, "force"),
    delete_branch = def_bool(b, "delete_branch");
  try {
    return await worktree.teardown(s, id, force, delete_branch);
  } catch (e) {
    throw ApiError.conflict(err_str(e));
  }
}

/**
 * `GET /projects/{id}/system-prompt` (API 80): what the agent of a new thread in the project is told on top of its
 * agent's own system prompt, for the options given (see runner::preview): `{text, runtime, permission_mode}`.
 */
export async function system_prompt_preview(s: AppState, r: Req) {
  const q = {
    type: r.query.type ?? null,
    labels: r.query.labels ?? null,
    worktree: query_opt_bool(r, "worktree"),
    runtime: r.query.runtime ?? null,
    permission_mode: r.query.permission_mode ?? null,
  };
  const project = db.get_project(s.db(), r.params.id);
  if (!project) throw ApiError.not_found("project");
  const [text, codex, mode] = await runner.preview(s, project, q);
  return { text, runtime: codex ? "codex" : "claude", permission_mode: mode };
}

/**
 * Remove the worktrees of the project's done tasks that are merged and have nothing uncommitted (see
 * worktree::remove_if_merged): `{"results": [{task_id, number, title, removed, detail}]}`, one for each done task that
 * had a worktree.
 */
export async function remove_merged_worktrees(s: AppState, r: Req) {
  const id = r.params.id;
  if (!db.get_project(s.db(), id)) throw ApiError.not_found("project");
  return { results: await worktree.remove_merged(s, id) };
}

export interface StartSetupThread {
  /** What the user adds to the agent's instructions, if anything. */
  message?: string;
}

export async function start_setup_thread(s: AppState, r: Req) {
  return await start_setup_thread_inner(s, r.params.id, { message: def_str(json_map(r), "message") });
}

/**
 * `POST /projects/{id}/setup-thread` (API 73): the project's setup thread (see db::Project::setup_task_id), whose agent
 * helps the user make its folder a git repository with a commit, so its tasks can have worktrees. A new one is started
 * with `message` after its instructions; one the project has already is returned as it is.
 */
export async function start_setup_thread_inner(s: AppState, project_id: string, b: StartSetupThread): Promise<Task> {
  // So two at once make one thread.
  const changing = await s.project_changes.lock();
  try {
    const project = db.get_project(s.db(), project_id);
    if (!project) throw ApiError.not_found("project");
    const existing = project.setup_task_id != null ? db.get_task(s.db(), project.setup_task_id) : null;
    if (existing) return existing;
    if (project.is_git && project.has_commits) throw ApiError.conflict(`${project.repo_path} is ready for worktrees already`);
    const t = create_task_inner(s, project.id, { title: "Get the folder ready for worktrees", description: setup_instructions(project), use_worktree: false });
    const p = db.update_project(s.db(), project.id, [["setup_task_id", t.id]]);
    if (!p) throw ApiError.not_found("project");
    s.emit({ type: "project", project: p });
    // Kept as the project's thread even if its agent can't start, to try again from.
    return runner.send(s, t.id, (b.message ?? "").trim());
  } finally {
    changing();
  }
}

/** What a project's setup thread's agent is asked to do (see start_setup_thread_inner). */
function setup_instructions(p: Project): string {
  const now = !p.is_git ? "It isn't a git repository yet." : "It's a git repository, but it has no commits yet (or the branch checked out has none).";
  return (
    `Huntaway runs each of this project's tasks in a git worktree of its own, on a branch of its own, so several agents can ` +
    `work on the project at once without getting in each other's way. For that, the project's folder \`${p.repo_path}\` has to be the top ` +
    `folder of a git repository, with a commit checked out for the tasks' branches to start from. ${now} Until it is, the ` +
    `board shows this thread in place of the project's tasks.\n\n` +
    `Help me get it ready:\n\n` +
    `1. Look at what's in the folder and tell me briefly what you find. If it's inside another git repository (such as a ` +
    `home folder kept in git), say so, and ask me before making a repository of its own in it.\n` +
    `2. If it isn't a repository yet, run \`git init\` there (with \`main\` as the branch, unless I say otherwise).\n` +
    `3. Before the first commit, add a \`.gitignore\` for what shouldn't be committed, such as dependencies, build output, ` +
    `local environment files and secrets. Ask me when you're unsure whether something belongs in the repository.\n` +
    `4. Make the first commit.\n` +
    `5. Ask me whether to put the repository on GitHub (or another remote), and if I want to, set that up and push.\n\n` +
    `Ask me before anything that's hard to undo, such as deleting or moving files, rewriting history or pushing. Once the ` +
    `repository has a commit, the board shows the project's tasks again, and new tasks get their own worktrees. End with ` +
    `a short summary of what you set up.`
  );
}

export async function task_diff(s: AppState, r: Req) {
  return await worktree.diff(s, r.params.id);
}

/** Whether moving the task to Done would leave work of its unmerged (see worktree::unmerged). */
export async function task_unmerged(s: AppState, r: Req) {
  const t = db.get_task(s.db(), r.params.id);
  if (!t) throw ApiError.not_found("task");
  return { unmerged: await worktree.unmerged(s, t) };
}

// ---------- terminal ----------

/** `?tool=<id>` picks one of the host's terminal tools instead of the task's shell. */
function find_tool(s: AppState, id: string | null | undefined): any {
  if (!id) return null;
  const tool = terminal.tools(s.db()).find((t: any) => t.id === id);
  if (!tool) throw ApiError.not_found("terminal tool");
  return tool;
}

export async function terminal_status(s: AppState, r: Req) {
  devices.board_only(r.device, "use terminals");
  const t = db.get_task(s.db(), r.params.id);
  if (!t) throw ApiError.not_found("task");
  const tool = find_tool(s, r.query.tool);
  return await terminal.status(s, t, tool);
}

export async function kill_terminal(s: AppState, r: Req) {
  devices.board_only(r.device, "use terminals");
  const id = r.params.id;
  if (!db.get_task(s.db(), id)) throw ApiError.not_found("task");
  // A tool that was removed from the settings can still be ended.
  await terminal.kill(s, id, r.query.tool || null);
  return { ok: true };
}

/** The board still has this tool open: keep its session (see `terminal::start_reaper`). */
export async function terminal_keepalive(s: AppState, r: Req) {
  devices.board_only(r.device, "use terminals");
  const id = r.params.id;
  const tool = r.query.tool;
  if (!tool) throw ApiError.bad("tool is required");
  if (!db.get_task(s.db(), id)) throw ApiError.not_found("task");
  terminal.keepalive(id, tool);
  return { ok: true };
}

/**
 * The task's terminal (`?cols=&rows=&tool=`). The Rust server answers a missing task (404) or a host without tmux (503)
 * before the upgrade; here the socket is upgraded already, so it's closed with the reason.
 */
/** The terminal websocket's checks, before the upgrade (a 404 or 503 answers the request, as in Rust). */
export function terminal_ws_check(s: AppState, r: Req) {
  devices.board_only(r.device, "open terminals");
  const t = db.get_task(s.db(), r.params.id);
  if (!t) throw ApiError.not_found("task");
  if (!terminal.available()) throw new ApiError(503, "tmux is not installed on this host");
  let tool: any;
  try {
    tool = find_tool(s, r.query.tool);
  } catch (e) {
    throw e instanceof ApiError ? e : new ApiError(404, err_str(e));
  }
  const size = (v: string | undefined, d: number) => {
    const n = v !== undefined && /^\d+$/.test(v) ? Number(v) : NaN;
    return n >= 2 && n <= 1000 ? n : d;
  };
  return { t, tool, cols: size(r.query.cols, 80), rows: size(r.query.rows, 24) };
}

export function terminal_ws(s: AppState, r: Req, ws: WebSocket) {
  const { t, tool, cols, rows } = r.pre ?? terminal_ws_check(s, r);
  Promise.resolve(terminal.serve(s, t, tool, cols, rows, ws)).catch((e: any) => {
    console.error(`terminal for ${t.id}:`, e);
    ws.close(1011);
  });
}

// ---------- permissions ----------

/**
 * Pending permission prompts (`?task_id=` for one task's, `?profile_id=` for a profile's, API 118: the mobile app's
 * inbox), so scripts and the mobile app can answer them.
 */
export async function list_permissions(s: AppState, r: Req) {
  return permissions.pending(s, r.query.task_id ?? null, r.query.profile_id ?? null);
}

export async function resolve_permission(s: AppState, r: Req) {
  const b = json_map(r);
  const decision = req_str(b, "decision");
  const message = opt_str(b, "message");
  // The answers to a question, or how a plan is approved or what to change in it (API 64).
  const answers = b.answers ?? null;
  if (answers !== null && !(Array.isArray(answers) && answers.every((a) => Array.isArray(a) && a.every((x) => typeof x === "string")))) {
    throw body_rejection("answers: invalid type, expected a sequence of sequences of strings");
  }
  const reply = { answers, mode: opt_str(b, "mode"), feedback: opt_str(b, "feedback") };
  let allow: boolean;
  if (decision === "allow" || decision === "allow_always") allow = true;
  else if (decision === "deny") allow = false;
  else throw ApiError.bad("decision must be allow, allow_always or deny");
  // `push` for an answer from a notification, which the hub passes on (API 115), for the action log.
  const by = opt_str(b, "via") === "push" ? "push" : "user";
  const status = permissions.answer_by(s, r.params.id, allow, decision === "allow_always", message, reply, by);
  return { ok: true, status };
}

/**
 * Project changes (and with `?all=true`, task deletions, with `?automations=true`, automations, and with that and
 * `?workflows=true`, workflows) agents are waiting for the user to approve (see permissions::approve). (`all` is API 58,
 * which older hosts ignore; `automations` API 67; `workflows` API 107.)
 */
export async function project_approvals(s: AppState, r: Req) {
  return permissions.pending_approvals(s, query_bool(r, "all"), query_bool(r, "automations"), query_bool(r, "workflows"));
}
