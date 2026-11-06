// Port of server/src/api/tasks.rs: tasks: listing, reading, updating and deleting them.
import { existsSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import * as db from "../db.ts";
import type { Conn, Task } from "../db.ts";
import { ApiError, type Req } from "../http.ts";
import type { AppState } from "../state.ts";
import { err_str, expand_tilde, now } from "../util.ts";
import { pick } from "../api.ts";
import * as runner from "../agent/runner.ts";
import * as runs from "../agent/runs.ts";
import * as documents from "../agent/documents.ts";
import * as focus from "../agent/focus.ts";
import * as title from "../agent/title.ts";
import * as agent_tools from "../agent/agent_tools.ts";
import * as assistant from "../agent/assistant.ts";
import * as task_tmp from "../agent/task_tmp.ts";
import * as worktree from "../git/worktree.ts";
import * as permissions from "../mcp/permissions.ts";
import * as terminal from "../hosts/terminal.ts";
import * as review from "../review.ts";
import * as workflows from "../integrations/workflows.ts";
import * as merge_gate from "../review/merge_gate.ts";
import * as attachments from "../attachments.ts";
import { char_count, debug_list, json_map, query_bool, query_rejection, rfc3339_utc } from "./extract.ts";
import { check_external_links, check_start_from, pick_config } from "./new_task.ts";
import { check_base_branch } from "./profiles.ts";
import * as history from "../threads/history.ts";
import * as thread_batch from "../threads/batch.ts";

export async function list_project_tasks(s: AppState, r: Req) {
  const kind = r.query.kind ?? "task";
  const c = s.db();
  if (!db.get_project(c, r.params.id)) throw ApiError.not_found("project");
  return db.list_tasks_for_project(c, r.params.id, kind);
}

/** A profile's tasks; with `include_assistant` (API 109) its assistant too, which is left out otherwise, being off the board. */
export async function list_profile_tasks(s: AppState, r: Req) {
  return db.list_tasks_for_profile(s.db(), r.params.id, query_bool(r, "include_assistant"));
}

export async function list_profile_scratch(s: AppState, r: Req) {
  return db.list_profile_scratch(s.db(), r.params.id);
}

/** The profile's tasks in no project: its group and scratch tasks, and with `include_assistant` (API 109) its assistant. */
export async function list_group_tasks(s: AppState, r: Req) {
  return db.list_group_tasks(s.db(), r.params.id, query_bool(r, "include_assistant"));
}

export async function get_task(s: AppState, r: Req) {
  const id = r.params.id;
  const c = s.db();
  if (!db.get_task(c, id)) throw ApiError.not_found("task");
  // A task opened without items gets them (see threads/batch.ts).
  thread_batch.opened(s, id);
  const t = db.get_task(c, id)!;
  const last = history.last_assistant_text(c, id);
  const pending = db.value<number>(c, "SELECT COUNT(*) FROM permission_requests WHERE task_id=?1 AND status='pending'", id) ?? 0;
  return { task: t, last_message: last, pending_permissions: pending };
}

export async function update_task(s: AppState, r: Req) {
  const b = json_map(r);
  const t = await update_task_inner(s, r.params.id, b);
  // Any update to a task puts it in "now" (see agent::focus).
  return focus.updated(s, t, b);
}

const UPDATABLE = [
  "title",
  "title_pinned",
  "description",
  "status",
  "resolution",
  "position",
  "use_worktree",
  "model",
  "effort",
  "base_branch",
  "start_from",
  "permission_mode",
  "preview_url",
  "pr_url",
  "external_links",
  "subproject",
  "claude_config_id",
  "depends_on",
  "starred",
  "remind_at",
  "reminder",
  "done_at",
];

type Fields = Array<[string, any]>;
const field = (fields: Fields, k: string) => fields.find(([f]) => f === k);
const has = (fields: Fields, ...ks: string[]) => fields.some(([f]) => ks.includes(f));

export async function update_task_inner(s: AppState, id: string, b: Record<string, any>): Promise<Task> {
  const current = db.get_task(s.db(), id);
  if (!current) throw ApiError.not_found("task");
  // The profile's assistant lasts: it's never reviewed, merged, done or parked (see agent/assistant.ts).
  if (db.is_assistant(current) && typeof b.status === "string" && assistant.NOT_FOR_ASSISTANT.includes(b.status) && b.status !== current.status) {
    throw ApiError.bad("the assistant can't go to review, merge, Done or Backlog");
  }
  // A task with no changes to merge (and so no pull request) skips the merge and is done.
  const to_merge = b.status === "ready_for_merge" && current.status !== "ready_for_merge" && current.kind === "task";
  // A scratch task, or one that makes only documents (which the board keeps), has nothing to merge.
  const own_folder = db.is_scratch(current) || db.is_assistants(current) || documents.documents_only(current);
  const nothing_to_merge = to_merge && (own_folder || !(await worktree.has_work_to_merge(s, current)));
  let fields: Fields = pick(b, UPDATABLE);
  check_reminder(current, fields);
  // "now" puts the task in the Now view (from this moment), "later" takes it out.
  if (b.now !== undefined && b.now !== null) {
    if (typeof b.now !== "boolean") throw ApiError.bad("now must be true or false");
    if (b.now && current.kind !== "task") throw ApiError.bad("only a task can be in now");
    fields.push(["now_at", b.now ? now() : null]);
  }
  // A title is text that isn't blank, and a description is text (null clears it): anything else is turned away rather
  // than kept as JSON text, or left to the database to refuse with a 500.
  const title_f = field(fields, "title");
  if (title_f) {
    const t = typeof title_f[1] === "string" ? title_f[1].trim() : "";
    if (!t) throw ApiError.bad("title must be a non-empty string");
    title_f[1] = t;
  }
  const description_f = field(fields, "description");
  if (description_f) {
    if (description_f[1] === null) description_f[1] = "";
    else if (typeof description_f[1] !== "string") throw ApiError.bad("description must be a string");
  }
  // SQLite keeps a value of the wrong type as it is (text in a REAL column, say), and the row can't be read back after:
  // every list with the task in it would fail until it's repaired by hand.
  if (fields.some(([k, v]) => k === "position" && typeof v !== "number")) throw ApiError.bad("position must be a number");
  if (fields.some(([k, v]) => k === "use_worktree" && typeof v !== "boolean")) throw ApiError.bad("use_worktree must be true or false");
  if (fields.some(([k, v]) => k === "model" && !(v === null || typeof v === "string"))) throw ApiError.bad("model must be a string or null");
  const base_f = field(fields, "base_branch");
  if (base_f) base_f[1] = await check_base_branch(base_f[1]);
  const start_f = field(fields, "start_from");
  if (start_f) {
    if (current.project_id == null) throw ApiError.bad("start_from is for a task in a project");
    const project = db.get_project(s.db(), current.project_id);
    if (!project) throw ApiError.not_found("project");
    const sf = check_start_from(s.db(), project, id, start_f[1]);
    if (sf) {
      if (db.subproject_of(s.db(), current)) throw ApiError.bad("start_from: a subproject's tasks start from its branch");
      const wt = field(fields, "use_worktree");
      const in_worktree = wt ? wt[1] === true : current.use_worktree;
      if (!in_worktree) throw ApiError.bad("start_from is for a task with a worktree");
      if (fields.some(([k, v]) => k === "base_branch" && v !== null)) throw ApiError.bad("give start_from or base_branch, not both");
    }
    // Its branch started where it did, and is set up again from there.
    if (current.branch != null && !isDeepStrictEqual(sf, current.start_from ?? null)) {
      throw ApiError.conflict(`the task's branch ${current.branch} exists already, so it starts from where it did`);
    }
    // What it starts from decides its base branch, as the worktree is made.
    if (sf && !has(fields, "base_branch")) fields.push(["base_branch", null]);
    start_f[1] = sf;
  } else if (fields.some(([k, v]) => k === "base_branch" && v !== null) && current.start_from != null) {
    fields.push(["start_from", null]);
  }
  if (Object.hasOwn(b, "labels")) {
    if (current.kind !== "task") throw ApiError.bad("only a task can have labels");
    try {
      fields.push(["labels", documents.check_labels(b.labels)]);
    } catch (e) {
      throw ApiError.bad(err_str(e));
    }
  }
  if (fields.some(([k, v]) => k === "title_pinned" && typeof v !== "boolean")) throw ApiError.bad("title_pinned must be true or false");
  // A title renamed by hand stays as it is, rather than following the user's prompts (see title::refresh), unless the
  // same request says otherwise.
  if (fields.some(([k, v]) => k === "title" && v !== current.title) && !has(fields, "title_pinned")) fields.push(["title_pinned", true]);
  const unpinned = current.title_pinned && fields.some(([k, v]) => k === "title_pinned" && v === false);
  // Without a project (a group task) there's no repository to branch from.
  if (current.project_id == null && fields.some(([k, v]) => (k === "subproject" || k === "use_worktree") && v === true)) {
    throw ApiError.bad("a task without a project can't have a worktree or be a subproject");
  }
  // Nor does one that works in its own folder.
  if (own_folder && fields.some(([k, v]) => (k === "subproject" || k === "use_worktree") && v === true)) {
    throw ApiError.bad("a scratch task, or one that makes only documents, can't have a worktree or be a subproject");
  }
  const sub_f = field(fields, "subproject");
  if (sub_f) {
    const on = sub_f[1];
    if (typeof on !== "boolean") throw ApiError.bad("subproject must be true or false");
    if (on && (current.kind !== "task" || db.subproject_of(s.db(), current))) throw ApiError.bad("only a top-level task can be a subproject");
    if (!on && current.subproject && db.subproject_tasks(s.db(), id).length) throw ApiError.conflict("the subproject still has tasks; delete them first");
    // Its tasks branch from its branch, so it needs a worktree.
    if (on && !current.use_worktree && current.worktree_state === "none") fields.push(["use_worktree", true]);
  }
  for (const f of fields) {
    if (f[0] !== "preview_url" && f[0] !== "pr_url") continue;
    // Blank clears it.
    const v = f[1];
    const url = typeof v === "string" ? v.trim() : "";
    const ok = v === null || url === "" || url.startsWith("http://") || url.startsWith("https://");
    if (!ok || !(v === null || typeof v === "string")) throw ApiError.bad(`${f[0]} must be null or an http(s) URL`);
    f[1] = url || null;
  }
  const links_f = field(fields, "external_links");
  if (links_f) links_f[1] = check_external_links(links_f[1]);
  const effort_f = field(fields, "effort");
  if (effort_f) {
    // null (or blank) falls back to the host's default.
    if (effort_f[1] === "") effort_f[1] = null;
    const v = effort_f[1];
    if (!(v === null || (typeof v === "string" && db.THREAD_EFFORTS.includes(v))))
      throw ApiError.bad(`effort must be null or one of ${debug_list(db.THREAD_EFFORTS)}`);
  }
  const mode_f = field(fields, "permission_mode");
  // null falls back to the project's mode, then the host's.
  if (mode_f && !(mode_f[1] === null || (typeof mode_f[1] === "string" && db.PERMISSION_MODES.includes(mode_f[1])))) {
    throw ApiError.bad(`permission_mode must be null or one of ${debug_list(db.PERMISSION_MODES)}`);
  }
  const config_f = field(fields, "claude_config_id");
  if (config_f) {
    // Its conversation is kept in the config it started in, so it can only move before then.
    if (current.session_id != null || s.is_running(id)) throw ApiError.conflict("the agent has already started with its Claude config");
    const c = s.db();
    const project = current.project_id != null ? db.get_project(c, current.project_id) : null;
    if (typeof config_f[1] !== "string") throw ApiError.bad("claude_config_id must be a config id");
    pick_config(c, current.profile_id, project, config_f[1]);
  }
  const deps_f = field(fields, "depends_on");
  if (deps_f) {
    if (current.kind !== "task") throw ApiError.bad("only tasks can have dependencies");
    const ids = deps_f[1];
    if (!Array.isArray(ids) || !ids.every((x) => typeof x === "string")) throw ApiError.bad("depends_on must be a list of task ids");
    try {
      deps_f[1] = db.check_dependencies(s.db(), current.id, current.project_id ?? null, ids);
    } catch (e) {
      throw ApiError.bad(err_str(e));
    }
  }
  const res_f = field(fields, "resolution");
  if (res_f) {
    // Checked against where the task ends up; moving it in or out of done sets or clears it (see db::update_task).
    const st = field(fields, "status");
    const status = st && typeof st[1] === "string" ? st[1] : current.status;
    db.check_resolution(status, res_f[1]);
  }
  const done_f = field(fields, "done_at");
  if (done_f) {
    // When a done task was done, in UTC: the board archives it two days after (and a new time brings it back from the
    // archive). Moving a task into or out of done sets or clears it.
    const status = typeof b.status === "string" ? b.status : current.status;
    if (status !== "done") throw ApiError.bad("done_at can only be set on a done task");
    const at = typeof done_f[1] === "string" ? rfc3339_utc(done_f[1]) : null;
    if (at === null) throw ApiError.bad("done_at must be an RFC 3339 time");
    done_f[1] = at;
  }
  // A merging task's agent can step out of the merge queue to fix what the merge turned up, and the task rejoins the
  // queue when its run ends (see Task::remerge).
  let remerge = false;
  if (b.remerge !== undefined && b.remerge !== null) {
    if (typeof b.remerge !== "boolean") throw ApiError.bad("remerge must be true or false");
    remerge = b.remerge;
  }
  // Its agent's run ending is what brings it back, so the agent has to be at work.
  if (remerge && !(current.merging && s.is_running(id) && b.status === "in_progress")) {
    throw ApiError.bad("remerge only takes a task out of the merge queue while its agent is merging it, with status in_progress");
  }
  // Waiting for the user's approval, it isn't in the queue to step out of.
  if (remerge && merge_gate.is_pending(current)) {
    throw ApiError.bad("the merge hasn't been approved yet, so it isn't in the merge queue to step out of: summarize what will be merged and end your turn");
  }
  // Moving a task to "Ready for merge" asks its agent to merge it, once no other task in its project is merging. On a
  // host that can't run agents it joins the queue all the same, and its merge starts once they can (see
  // runner::start_queued_merges).
  let merge = false;
  const status_f = field(fields, "status");
  if (status_f) {
    const v = status_f[1];
    if (!(typeof v === "string" && db.STATUSES.includes(v))) throw ApiError.bad(`status must be one of ${debug_list(db.STATUSES)}`);
    const st: string = v;
    merge = st === "ready_for_merge" && current.status !== st && current.kind === "task";
    if (st !== "needs_attention") fields.push(["attention_reason", null]);
    // Only "In progress" holds a task queued for its dependencies.
    if (st !== "in_progress" && current.waiting) fields.push(["waiting", false]);
    // Anywhere but "Ready for merge" (or waiting on the user while merging) ends a merge.
    if (merge || !["ready_for_merge", "needs_attention"].includes(st)) fields.push(["merging", merge]);
    // Moved there again, a merge that needs approval is summarised again (see review/merge_gate.rs), unless it's
    // approved already (stepping out to make changes keeps it).
    if (merge && current.merge_approval !== merge_gate.APPROVED) fields.push(["merge_approval", null]);
    // Anywhere but "In progress" (or waiting on the user) drops its place to rejoin the queue (see db::update_task).
    if (remerge) fields.push(["remerge", true]);
    // Moving it ends its agent's wait (see mcp/wait.rs), told so in the same write.
    if (current.agent_wait != null && st !== current.status) fields.push(["agent_wait", { ...current.agent_wait, moved_to: st }]);
  }
  // A setup that failed before making the branch (a branch or pull request that isn't there, say) left nothing to tear
  // down, so what it starts from can be put right, and it's set up again from scratch. (The branch, its base and the
  // worktree's folder are saved as soon as git makes them.)
  const unmade = (t: Task) =>
    t.worktree_state === "none" || (t.worktree_state === "error" && t.branch == null && (t.worktree_path == null || !existsSync(t.worktree_path)));
  const worktree_settings = has(fields, "use_worktree", "base_branch", "start_from");
  if (worktree_settings && current.worktree_state === "error" && unmade(current)) fields.push(["worktree_state", "none"], ["worktree_error", null]);
  if (worktree_settings && !unmade(current)) throw ApiError.conflict("tear down the worktree before changing worktree settings");
  if (merge && s.is_running(id)) throw ApiError.conflict("the agent is still running; wait for it to finish before moving the task to Ready for merge");
  if (merge && nothing_to_merge) {
    merge = false;
    fields = fields.filter(([k]) => !["status", "merging", "position"].includes(k));
    fields.push(["status", "done"], ["merging", false]);
    const why = db.is_scratch(current)
      ? "Nothing to merge (a scratch task has no repository), so it's done"
      : own_folder
        ? "Nothing to merge (the board keeps the task's documents), so it's done"
        : "Nothing to merge (the task has no changes), so it's done";
    s.add_event(id, "info", why, null);
  }
  // Where the project or profile asks for it, the task's pull request needs an approving review on GitHub first. The
  // pull request it will have is the one checked, if the same request changes it.
  const gated = merge && !nothing_to_merge && !remerge && (await worktree.pr_approval_required(s, current));
  const pr_set = field(fields, "pr_url");
  const pr_url_set: string | null | undefined = pr_set ? (typeof pr_set[1] === "string" ? pr_set[1] : null) : undefined;
  if (gated) {
    const url = pr_url_set !== undefined ? pr_url_set : (current.pr_url ?? null);
    let approved: boolean;
    try {
      approved = await worktree.pr_approved(s, current, url ? url : null);
    } catch (e) {
      throw ApiError.conflict(`can't move the task to Ready for merge until its pull request is approved on GitHub: ${err_str(e)}`);
    }
    if (!approved) throw ApiError.conflict("the task's pull request has no approving review on GitHub yet, so it can't go to Ready for merge");
  }
  // Moved without a position (e.g. by an agent), it joins the back of the merge queue.
  if (merge && !has(fields, "position")) fields.push(["position", db.end_position(s.db(), current.project_id ?? null, "ready_for_merge", "task")]);
  // What was checked against the task as it was read is checked again with the change, so that two requests at once
  // can't both pass (and, say, both start a merge).
  const config = has(fields, "claude_config_id");
  const unsubproject = current.subproject && fields.some(([k, v]) => k === "subproject" && v === false);
  let refused = null as ApiError | null;
  const still = (c: Conn): boolean => {
    const nowt = db.get_task(c, id);
    if (!nowt) return true;
    const running = nowt.running || db.has_active_run(c, id);
    if (to_merge && nowt.status !== current.status) refused = ApiError.conflict(`the task was moved to ${nowt.status} meanwhile`);
    else if (merge && running) refused = ApiError.conflict("the agent is still running; wait for it to finish before moving the task to Ready for merge");
    else if (worktree_settings && !unmade(nowt)) refused = ApiError.conflict("tear down the worktree before changing worktree settings");
    else if (config && (nowt.session_id != null || running)) refused = ApiError.conflict("the agent has already started with its Claude config");
    else if (remerge && !(nowt.merging && running)) {
      refused = ApiError.bad("remerge only takes a task out of the merge queue while its agent is merging it, with status in_progress");
    } else if (gated && pr_url_set === undefined && (nowt.pr_url ?? null) !== (current.pr_url ?? null)) {
      refused = ApiError.conflict("the task's pull request changed meanwhile; try again");
    } else if (unsubproject && db.subproject_tasks(c, id).length) refused = ApiError.conflict("the subproject still has tasks; delete them first");
    else refused = null;
    return refused === null;
  };
  const updated = s.update_task_if(id, fields, still);
  if (refused) throw refused;
  if (!updated) throw ApiError.not_found("task");
  const t: Task = updated;
  // The approval it waited for is asked again, or not at all.
  if (merge_gate.is_pending(current) && !merge_gate.is_pending(t)) merge_gate.settle(s, id, "replaced");
  if (remerge) s.add_event(id, "info", "Stepped out of the merge queue to make changes; it rejoins the queue when its agent is done", null);
  if (merge && !runs.can_run_agents(s)) {
    s.add_event(id, "warn", "Agents can't run on this host yet (no Claude Code or Codex found), so the task waits in the merge queue until they can", null);
  }
  // Unpinned, the title catches up with what the task is about now.
  if (unpinned) title.refresh(s, id);
  if (has(fields, "permission_mode")) permissions.apply_mode_to_pending(s, t);
  // Moved into "In progress" before what it depends on is merged, it's queued until it is.
  if (t.status === "in_progress" && current.status !== "in_progress" && t.kind === "task" && !t.waiting && !s.is_running(id) && runs.can_run_agents(s)) {
    const unmet = db.unmet_dependencies(s.db(), t);
    if (unmet.length) runner.wait_for_dependencies(s, t, unmet, db.Queued_new("", false));
  }
  // Waiting for its old config's usage limit, it doesn't any more.
  if (config) runner.config_changed(s, id);
  // This may have merged a task others wait for, or dropped what this one waits for.
  if (has(fields, "status", "resolution", "depends_on")) runner.start_unblocked(s, t.project_id ?? null);
  if (has(fields, "status")) {
    // This may have queued a merge or ended one.
    runner.start_next_merge(s, t.project_id ?? null);
    if (t.status === "in_review" && current.status !== "in_review" && t.kind === "task") review.on_in_review(s, t);
    if (t.status !== current.status) workflows.on_status(s, t);
    // A finished task's terminal and tools aren't needed any more.
    if (t.status === "done" && current.status !== "done") {
      terminal.kill_all(s, t.id).catch((e: any) => console.error(`ending ${t.id}'s terminals:`, e));
    }
    const again = db.get_task(s.db(), id);
    if (!again) throw ApiError.not_found("task");
    return again;
  }
  return t;
}

/** Longest a reminder's note can be. */
const MAX_REMINDER = 500;

/** The fields `check_reminder` takes. */
export const MARK_FIELDS = ["starred", "remind_at", "reminder"];

/**
 * Checks `starred`, `remind_at` and `reminder` in an update of task `current` (null for one about to be created), and
 * puts the time in UTC. Clearing `remind_at` (null or blank) clears the note too; a note needs a time. Changes
 * `fields` in place.
 */
export function check_reminder(current: Task | null, fields: Array<[string, any]>) {
  if (fields.some(([k, v]) => k === "starred" && typeof v !== "boolean")) throw ApiError.bad("starred must be true or false");
  const at_f = fields.find(([k]) => k === "remind_at");
  if (at_f) {
    const bad = () => ApiError.bad("remind_at must be null or a time like 2026-05-01T09:00:00Z");
    const v = at_f[1];
    if (v === null) at_f[1] = null;
    else if (typeof v !== "string") throw bad();
    else if (!v.trim()) at_f[1] = null;
    else {
      const t = rfc3339_utc(v.trim());
      if (t === null) throw bad();
      at_f[1] = t;
    }
  }
  const timed = at_f ? at_f[1] !== null : !!current && current.remind_at != null;
  const note_f = fields.find(([k]) => k === "reminder");
  if (note_f) {
    const v = note_f[1];
    let note: string;
    if (typeof v === "string") note = v.trim();
    else if (v === null) note = "";
    else throw ApiError.bad("reminder must be null or text");
    if (char_count(note) > MAX_REMINDER) throw ApiError.bad(`reminder must be at most ${MAX_REMINDER} characters`);
    if (note && !timed) throw ApiError.bad("a reminder needs remind_at, the time to remind you");
    note_f[1] = note || null;
  } else if (!timed && current && current.reminder != null) {
    fields.push(["reminder", null]);
  }
}

/**
 * Whether a task's preview URL answers 200. Checked from here rather than the browser, which can't read the status of a
 * cross-origin response.
 */
export async function preview_status(_s: AppState, r: Req) {
  const url = r.query.url;
  if (url === undefined) throw query_rejection("missing field `url`");
  if (!(url.startsWith("http://") || url.startsWith("https://"))) throw ApiError.bad("url must be http(s)");
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    res.body?.cancel().catch(() => {});
    return { up: res.status === 200, status: res.status };
  } catch (e) {
    return { up: false, status: null, error: err_str(e) };
  }
}

export async function delete_task(s: AppState, r: Req) {
  const delete_branch = query_bool(r, "delete_branch");
  const t = db.get_task(s.db(), r.params.id);
  if (!t) throw ApiError.not_found("task");
  await delete_task_inner(s, t, delete_branch);
  return { ok: true };
}

/**
 * Delete task `t`, and if it's a subproject, its tasks (or if it's a profile's assistant, its routines' threads), each
 * stopped and torn down rather than left to the database's cascade.
 */
export async function delete_task_inner(s: AppState, t: Task, delete_branch: boolean) {
  const deleting = new Deleting(s, t.id);
  try {
    // A subproject's tasks go with it, as do the assistant's routine threads.
    if (t.subproject || db.is_assistant(t)) {
      for (const child of db.subproject_tasks(s.db(), t.id)) await delete_one(s, child, delete_branch);
    }
    await delete_last(s, t, delete_branch);
  } finally {
    deleting.drop();
  }
}

/**
 * Marks a task as being deleted until it's dropped: no task can be added to it meanwhile (see create_task_inner), since
 * deleting it would take that task too (`parent_id` cascades), and one added after its tasks were looked up would go
 * without being stopped or torn down, or asked about (see tools::delete_task).
 */
export class Deleting {
  private s: AppState;
  private id: string;
  private dropped = false;
  constructor(s: AppState, id: string) {
    this.s = s;
    this.id = id;
    s.deleting.set(id, (s.deleting.get(id) ?? 0) + 1);
  }
  /** Rust's `Deleting::new`. */
  static new(s: AppState, id: string): Deleting {
    return new Deleting(s, id);
  }
  drop() {
    if (this.dropped) return;
    this.dropped = true;
    const n = this.s.deleting.get(this.id);
    if (n === undefined) return;
    if (n <= 1) this.s.deleting.delete(this.id);
    else this.s.deleting.set(this.id, n - 1);
  }
}

/** `Deleting::new`. */
export function Deleting_new(s: AppState, id: string): Deleting {
  return new Deleting(s, id);
}

/** Delete task `t` once a subproject's tasks are gone, and catch up what it leaves behind: its own subproject, and the merges and tasks it held up. */
export async function delete_last(s: AppState, t: Task, delete_branch: boolean) {
  await delete_one(s, t, delete_branch);
  const subproject = db.subproject_of(s.db(), t);
  if (subproject) s.sync_subproject(subproject.id);
  runner.start_next_merge(s, t.project_id ?? null);
  runner.start_unblocked(s, t.project_id ?? null);
}

/** Stop a task's agents, remove its worktree and delete it. */
export async function delete_one(s: AppState, t: Task, delete_branch: boolean) {
  runner.abort(s, t.id);
  // Settled before the thread goes, so the dialog asking about them goes too.
  permissions.expire_for_task(s, t.id);
  // Its review threads go with it.
  const reviews = db.review_threads(s.db(), t.id);
  for (const r of reviews) {
    runner.abort(s, r.id);
    permissions.expire_for_task(s, r.id);
  }
  await terminal.kill_all(s, t.id);
  const files = new Set<string>(attachments.of_task(s.db(), t.id));
  for (const r of reviews) for (const f of attachments.of_task(s.db(), r.id)) files.add(f);
  if (t.worktree_path != null) {
    try {
      await worktree.teardown(s, t.id, true, delete_branch);
    } catch (e) {
      console.warn(`teardown during delete failed: ${err_str(e)}`);
    }
  }
  // The tasks stacked on it keep going where it went.
  await worktree.unstack(s, t);
  if (t.start_from != null && t.project_id != null) {
    const project = db.get_project(s.db(), t.project_id);
    if (project) await worktree.forget_start(expand_tilde(project.repo_path), t.id);
  }
  const run_ids: string[] = [];
  for (const id of [t.id, ...reviews.map((r) => r.id)]) {
    for (const row of db.all<{ id: string }>(s.db(), "SELECT id FROM runs WHERE task_id=?1", id)) run_ids.push(row.id);
  }
  db.run(s.db(), "DELETE FROM tasks WHERE id=?1", t.id);
  runs.remove_finished(s, run_ids);
  for (const r of reviews) if (r.project_id != null) agent_tools.remove_thread_skills(s, r.project_id, r.id);
  await task_tmp.deleted(s, t.id);
  // Any agent asking to delete it is told it's gone (see tools::delete_task), so after that.
  permissions.expire_deletions_of(s, t.id);
  documents.remove(s, t.id);
  for (const id of db.drop_dependency(s.db(), t.id)) {
    const d = db.get_task(s.db(), id);
    if (d) s.emit_task(d);
  }
  // Unless another task refers to them too.
  try {
    attachments.remove_unreferenced(s, files);
  } catch (e) {
    console.warn(`removing attachments during delete failed: ${err_str(e)}`);
  }
  for (const r of reviews) s.emit({ type: "task_deleted", id: r.id, project_id: r.project_id ?? null });
  s.emit({ type: "task_deleted", id: t.id, project_id: t.project_id ?? null });
}
