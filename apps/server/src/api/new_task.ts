// Port of server/src/api/new_task.rs: creating tasks: a project's, scratch tasks and group tasks.
import { mkdirSync } from "node:fs";
import * as db from "../db.ts";
import type { Conn, Project, StartFrom, Task } from "../db.ts";
import { ApiError, type Req } from "../http.ts";
import type { AppState } from "../state.ts";
import { err_str } from "../util.ts";
import * as runner from "../agent/runner.ts";
import * as title from "../agent/title.ts";
import * as documents from "../agent/documents.ts";
import * as worktree from "../git/worktree.ts";
import { debug_list, json_map, opt_bool, opt_str, opt_strings, opt_value, def_str, req_str } from "./extract.ts";

/**
 * A new task, as `POST /projects/{id}/tasks` (and the scratch and group task routes) take it. Callers in other modules
 * can leave out any field (Rust's `..Default::default()`): a missing one is None (or "" for the title and description).
 */
export interface CreateTask {
  title?: string;
  description?: string;
  status?: string | null;
  /** How a done task ended (see db::RESOLUTIONS); only with status done. */
  resolution?: string | null;
  use_worktree?: boolean | null;
  model?: string | null;
  effort?: string | null;
  kind?: string | null;
  /** Start an agent immediately; the string (if any) is sent as an extra prompt. */
  start?: any;
  /** The subproject to add the task to (a task id). */
  parent_id?: string | null;
  /** Make the task a subproject. */
  subproject?: boolean | null;
  /** The Claude config to run with, one of those its project (or profile) offers. Unset uses the first of them. */
  claude_config_id?: string | null;
  /** Tasks (ids) in the project that have to be merged before its agent starts. */
  depends_on?: string[] | null;
  /**
   * What the task is, if not a code task: one of db::TASK_TYPES. In a project, also `subproject` (db::SUBPROJECT), the
   * same as `subproject: true`. One of db::LABELS (a task type before API 71) gives the task that label.
   */
  task_type?: string | null;
  /** Some of db::LABELS, each a document its agent writes besides its other work (see agent/documents.rs). */
  labels?: any;
  /** The tasks elsewhere it's for (see `check_external_links`). */
  external_links?: any;
  /** Shared by the tasks made together from one prompt, each run by another agent (see db::Task::fanout_id). */
  fanout_id?: string | null;
  /** What its worktree starts from, if not the project's base branch (see `check_start_from`). */
  start_from?: any;
}

export function CreateTask_default(): CreateTask {
  return { title: "", description: "" };
}

/** A CreateTask from a JSON body, as serde reads it (a 422 Reply thrown for one of the wrong shape). */
export function CreateTask_from_json(v: any): CreateTask {
  const b = json_map({ body: v } as Req);
  return {
    title: def_str(b, "title"),
    description: def_str(b, "description"),
    status: opt_str(b, "status"),
    resolution: opt_str(b, "resolution"),
    use_worktree: opt_bool(b, "use_worktree"),
    model: opt_str(b, "model"),
    effort: opt_str(b, "effort"),
    kind: opt_str(b, "kind"),
    start: opt_value(b, "start"),
    parent_id: opt_str(b, "parent_id"),
    subproject: opt_bool(b, "subproject"),
    claude_config_id: opt_str(b, "claude_config_id"),
    depends_on: opt_strings(b, "depends_on"),
    task_type: opt_str(b, "task_type"),
    labels: opt_value(b, "labels"),
    external_links: opt_value(b, "external_links"),
    fanout_id: opt_str(b, "fanout_id"),
    start_from: opt_value(b, "start_from"),
  };
}

const title_of = (b: CreateTask) => b.title ?? "";
const description_of = (b: CreateTask) => b.description ?? "";
const nonempty = (v: string | null | undefined) => (v != null && v !== "" ? v : null);

/** A task's external links as they're stored (see db::ExternalLink): a list of `{provider, id, url, title}`, each task once. */
export function check_external_links(v: any): any {
  if (v === null || v === undefined) return [];
  const bad = (m: string) => ApiError.bad(`external_links ${m}`);
  if (!Array.isArray(v)) throw bad("must be a list of {provider, id, url, title}");
  let links: db.ExternalLink[];
  try {
    links = v.map((l: any) => db.ExternalLink_from_json(l));
  } catch {
    throw bad("must be a list of {provider, id, url, title}");
  }
  const out: db.ExternalLink[] = [];
  for (const l of links) {
    const link = { provider: l.provider.trim(), id: l.id.trim(), url: l.url.trim(), title: Array.from(l.title.trim()).slice(0, 500).join("") };
    if (!db.LINK_PROVIDERS.includes(link.provider)) throw bad(`provider must be one of ${debug_list(db.LINK_PROVIDERS)}`);
    if (!link.id || Buffer.byteLength(link.id) > 100) throw bad("need an id");
    if (!(link.url.startsWith("https://") || link.url.startsWith("http://"))) throw bad("need an http(s) url");
    if (!out.some((o) => o.provider === link.provider && o.id === link.id)) out.push(link);
  }
  if (out.length > db.MAX_LINKS) throw bad(`can have at most ${db.MAX_LINKS}`);
  return out;
}

/** The external links a new task asks for, as an update to make once it's created. */
function new_task_links(b: CreateTask): [string, any] | null {
  return b.external_links != null ? ["external_links", check_external_links(b.external_links)] : null;
}

/** A new task's fanout id (blank for none): letters, digits, `-` and `_`, as an id is. */
function new_task_fanout(b: CreateTask): [string, any] | null {
  const f = b.fanout_id?.trim();
  if (!f) return null;
  if (f.length > 64 || !/^[A-Za-z0-9_-]+$/.test(f)) throw ApiError.bad("fanout_id must be up to 64 letters, digits, - or _");
  return ["fanout_id", f];
}

/** Check a new task's requested type (blank for none). A label (a type before API 71) is none: see new_task_labels. */
function check_task_type(task_type: string | null | undefined): string | null {
  const t = task_type?.trim();
  if (!t) return null;
  if (db.LABELS.includes(t)) return null;
  if (!db.TASK_TYPES.includes(t)) throw ApiError.bad(`task_type must be one of ${debug_list(db.TASK_TYPES)}`);
  return t;
}

/** The labels a new task asks for, as an update to make once it's created: its `labels`, and a `task_type` that's one of them, as it was before API 71. */
function new_task_labels(b: CreateTask): [string, any] | null {
  let asked: any[];
  if (Array.isArray(b.labels)) asked = [...b.labels];
  else if (b.labels == null) asked = [];
  else throw ApiError.bad("labels must be a list of strings");
  const t = b.task_type?.trim();
  if (t && db.LABELS.includes(t)) asked.push(t);
  let labels: string[];
  try {
    labels = documents.check_labels(asked);
  } catch (e) {
    throw ApiError.bad(err_str(e));
  }
  return labels.length ? ["labels", labels] : null;
}

/** What `start` asks for: an extra prompt ("" for `start: true`), or null not to start. */
function start_of(b: CreateTask): string | null {
  if (b.start === true) return "";
  if (typeof b.start === "string") return b.start;
  return null;
}

export async function create_scratch_task(s: AppState, r: Req) {
  const b = CreateTask_from_json(json_map(r));
  return create_scratch_task_inner(s, r.params.id, b);
}

/** `POST /profiles/{id}/tasks`: a scratch task (see db::Task::is_scratch), which is in no project. Without a title or description it's called "New scratch task". */
export function create_scratch_task_inner(s: AppState, profile_id: string, b: CreateTask): Task {
  if (!db.get_profile(s.db(), profile_id)) throw ApiError.not_found("profile");
  if ((b.kind != null && b.kind !== "task") || [check_task_type(b.task_type)].some((t) => t !== null && t !== db.SCRATCH))
    throw ApiError.bad("a task in no project is a scratch task");
  if (b.parent_id != null || b.subproject === true || b.use_worktree === true || (b.depends_on != null && b.depends_on.length > 0)) {
    throw ApiError.bad("a scratch task can't be a subproject, be in one, have a worktree or have dependencies");
  }
  const description = description_of(b);
  const generate_title = !title_of(b).trim() && !!description.trim();
  const t_title = title_of(b).trim() || (generate_title ? title.placeholder(description) : "New scratch task");
  const status = b.status ?? "todo";
  if (!db.STATUSES.includes(status)) throw ApiError.bad(`status must be one of ${debug_list(db.STATUSES)}`);
  const resolution = nonempty(b.resolution);
  db.check_resolution(status, resolution);
  const effort = nonempty(b.effort);
  if (effort !== null && !db.THREAD_EFFORTS.includes(effort)) throw ApiError.bad(`effort must be one of ${debug_list(db.THREAD_EFFORTS)}`);
  const config = pick_config(s.db(), profile_id, null, b.claude_config_id ?? null);
  const links = new_task_links(b);
  const fanout = new_task_fanout(b);
  const labels = new_task_labels(b);
  let t = db.insert_scratch_task(s.db(), {
    profile_id,
    project_id: null,
    kind: "task",
    title: t_title,
    description,
    status,
    use_worktree: false,
    model: nonempty(b.model),
    effort,
    claude_config_id: config,
  });
  const fields: Array<[string, any]> = [];
  if (resolution !== null) fields.push(["resolution", resolution]);
  for (const f of [links, fanout, labels]) if (f) fields.push(f);
  const updated = db.update_task(s.db(), t.id, fields);
  if (!updated) throw ApiError.not_found("task");
  t = updated;
  s.emit_task(t);
  const start = start_of(b);
  if (generate_title) {
    title.generate(s, t, start);
    return t;
  }
  return start !== null ? runner.send(s, t.id, start) : t;
}

/** A group task: the group (of the profile's projects) it plans for, and the task. */
export interface CreateGroupTask {
  group: string;
  task: CreateTask;
}

/** `POST /profiles/{id}/group-tasks`: a group task, which plans work across a group's projects and creates their tasks (see db::Task::group_name). */
export async function create_group_task(s: AppState, r: Req) {
  const body = json_map(r);
  const b: CreateGroupTask = { group: req_str(body, "group"), task: CreateTask_from_json(body) };
  return create_group_task_inner(s, r.params.id, b);
}

/** `create_group_task` for a body already read (Rust's tests call the handler with one). */
export function create_group_task_inner(s: AppState, id: string, gb: CreateGroupTask): Task {
  if (!db.get_profile(s.db(), id)) throw ApiError.not_found("profile");
  const group = gb.group.trim();
  if (!group || db.group_projects(s.db(), id, group).length === 0) throw ApiError.bad("group must name a group of the profile's projects");
  const b = gb.task;
  if ((b.kind != null && b.kind !== "task") || b.parent_id != null || b.subproject === true || (b.depends_on != null && b.depends_on.length > 0)) {
    throw ApiError.bad("a group task can't be a subproject, be in one, or have dependencies");
  }
  const description = description_of(b);
  const generate_title = !title_of(b).trim() && !!description.trim();
  let t_title = title_of(b).trim();
  if (!t_title) {
    if (!generate_title) throw ApiError.bad("title or description is required");
    t_title = title.placeholder(description);
  }
  const status = b.status ?? "todo";
  if (!db.STATUSES.includes(status)) throw ApiError.bad(`status must be one of ${debug_list(db.STATUSES)}`);
  const effort = nonempty(b.effort);
  if (effort !== null && !db.THREAD_EFFORTS.includes(effort)) throw ApiError.bad(`effort must be one of ${debug_list(db.THREAD_EFFORTS)}`);
  const task_type = check_task_type(b.task_type);
  if (task_type === db.SCRATCH) throw ApiError.bad("a group task can't be a scratch task");
  const config = pick_config(s.db(), id, null, b.claude_config_id ?? null);
  const fanout = new_task_fanout(b);
  const links = new_task_links(b);
  const labels = new_task_labels(b);
  let t = db.insert_group_task(
    s.db(),
    {
      profile_id: id,
      project_id: null,
      kind: "task",
      title: t_title,
      description,
      status,
      use_worktree: false,
      model: nonempty(b.model),
      effort,
      claude_config_id: config,
    },
    group,
  );
  const fields: Array<[string, any]> = [];
  if (task_type !== null) fields.push(["task_type", task_type]);
  for (const f of [links, fanout, labels]) if (f) fields.push(f);
  const updated = db.update_task(s.db(), t.id, fields);
  if (!updated) throw ApiError.not_found("task");
  t = updated;
  try {
    mkdirSync(s.profile_scratch_dir(id), { recursive: true });
  } catch {}
  s.emit_task(t);
  const start = start_of(b);
  if (generate_title) {
    title.generate(s, t, start);
    return t;
  }
  return start !== null ? runner.send(s, t.id, start) : t;
}

export async function create_task(s: AppState, r: Req) {
  const b = CreateTask_from_json(json_map(r));
  return create_task_inner(s, r.params.id, b);
}

export function create_task_inner(s: AppState, project_id: string, b: CreateTask): Task {
  const project = db.get_project(s.db(), project_id);
  if (!project) throw ApiError.not_found("project");
  if (project.archived_at != null) throw ApiError.bad(`the project "${project.name}" is archived; unarchive it in the board's settings first`);
  const kind = b.kind ?? "task";
  if (kind !== "task") throw ApiError.bad("kind must be task");
  // A task described but not titled gets a placeholder now and a generated title shortly.
  const description = description_of(b);
  const generate_title = !title_of(b).trim() && !!description.trim();
  let t_title = title_of(b).trim();
  if (!t_title) {
    if (!generate_title) throw ApiError.bad("title or description is required");
    t_title = title.placeholder(description);
  }
  const status = b.status ?? "todo";
  if (!db.STATUSES.includes(status)) throw ApiError.bad(`status must be one of ${debug_list(db.STATUSES)}`);
  const resolution = nonempty(b.resolution);
  db.check_resolution(status, resolution);
  // (Rust holds `s.deleting` until the task is in its subproject, so one being deleted can't gain a task that its
  // deletion would take with it, unasked (see Deleting). This function is synchronous, so nothing runs in between.)
  let parent: Task | null = null;
  const pid = nonempty(b.parent_id);
  if (pid !== null) {
    if (s.deleting.has(pid)) throw ApiError.conflict("the subproject is being deleted");
    const p = db.get_task(s.db(), pid);
    if (!p) throw ApiError.not_found("subproject");
    if (!p.subproject || p.project_id !== project.id) throw ApiError.bad("parent_id must be a subproject in the same project");
    if (kind !== "task") throw ApiError.bad("only tasks can be added to a subproject");
    parent = p;
  }
  // `subproject` is a task type too (API 51), though it's kept as the task's subproject flag.
  const as_subproject = b.task_type?.trim() === db.SUBPROJECT;
  const subproject = (b.subproject ?? false) || as_subproject;
  if (subproject && (kind !== "task" || parent)) throw ApiError.bad("only a top-level task can be a subproject");
  const task_type = as_subproject ? null : check_task_type(b.task_type);
  if (task_type !== null && (kind !== "task" || subproject)) throw ApiError.bad("only a task that isn't a subproject can be a scratch task");
  const labels = new_task_labels(b);
  if (labels && kind !== "task") throw ApiError.bad("only a task can have labels");
  // A subproject's branch is what its tasks branch from, so it and they work in worktrees. A scratch task works in its
  // own folder instead (see agent/documents.rs).
  const use_worktree = kind === "task" && task_type === null && (subproject || !!parent || (b.use_worktree ?? (project.use_worktrees && project.is_git)));
  const effort = nonempty(b.effort);
  if (effort !== null && !db.THREAD_EFFORTS.includes(effort)) throw ApiError.bad(`effort must be one of ${debug_list(db.THREAD_EFFORTS)}`);
  const config = pick_config(s.db(), project.profile_id, project, b.claude_config_id ?? null);
  const start_from = b.start_from != null ? check_start_from(s.db(), project, null, b.start_from) : null;
  if (start_from && parent) throw ApiError.bad("start_from: a subproject's tasks start from its branch");
  if (start_from && !use_worktree) throw ApiError.bad("start_from is for a task with a worktree");
  let depends_on: string[] | null = null;
  if (b.depends_on != null && b.depends_on.length > 0) {
    if (kind !== "task") throw ApiError.bad("only tasks can have dependencies");
    try {
      depends_on = db.check_dependencies(s.db(), null, project.id, b.depends_on);
    } catch (e) {
      throw ApiError.bad(err_str(e));
    }
  }
  const links = new_task_links(b);
  const fanout = new_task_fanout(b);
  let t = db.insert_task(s.db(), {
    profile_id: project.profile_id,
    project_id: project.id,
    kind,
    title: t_title,
    description,
    status,
    use_worktree,
    model: nonempty(b.model),
    effort,
    claude_config_id: config,
  });
  const fields: Array<[string, any]> = [];
  if (resolution !== null) fields.push(["resolution", resolution]);
  if (parent) {
    fields.push(["parent_id", parent.id]);
    // Known once the subproject's worktree exists; otherwise worktree::setup works it out.
    if (parent.branch != null) fields.push(["base_branch", parent.branch]);
  }
  if (subproject) fields.push(["subproject", true]);
  if (start_from) fields.push(["start_from", start_from]);
  if (depends_on) fields.push(["depends_on", depends_on]);
  if (task_type !== null) fields.push(["task_type", task_type]);
  for (const f of [labels, links, fanout]) if (f) fields.push(f);
  const updated = db.update_task(s.db(), t.id, fields);
  if (!updated) throw ApiError.not_found("task");
  t = updated;
  s.emit_task(t);
  if (parent) s.sync_subproject(parent.id);
  const start = start_of(b);
  if (generate_title) {
    // Starts the agent once the title is in, since it names the branch.
    title.generate(s, t, start);
    return t;
  }
  return start !== null ? runner.send(s, t.id, start) : t;
}

/** Check a new thread's requested Claude config against those it can use (null for the default). */
export function pick_config(c: Conn, profile_id: string, project: Project | null, id: string | null | undefined): string | null {
  if (!id) return null;
  if (!db.available_configs(c, profile_id, project).some((cfg) => cfg.id === id)) {
    throw ApiError.bad("claude_config_id must be one of the project's (or profile's) Claude configs");
  }
  return id;
}

const is_hex = (w: string) => Buffer.byteLength(w) >= 7 && Buffer.byteLength(w) <= 40 && /^[0-9A-Fa-f]+$/.test(w);
/** Rust's `str::parse::<u64>()`. */
const parse_u64 = (w: string): number | null => (/^\+?\d+$/.test(w) && Number(w) <= Number.MAX_SAFE_INTEGER ? Number(w) : null);

/**
 * What a task's worktree starts from (see db::StartFrom), as `start_from` gives it for a task in `project` (`task_id`,
 * if it exists): null (or blank) for the project's base branch, an object as tasks have it, or text. Text is `task:`,
 * `branch:`, `pr:` or `commit:` and what it names, or without one of those: a task's key (or id) in the project, `#12`
 * or a pull request's URL, a commit's SHA (7 to 40 hex digits), or else a branch, local or on a remote
 * (`origin/feature`). Whether the branch or commit is there is found out as the worktree is made, after fetching.
 */
export function check_start_from(c: Conn, project: Project, task_id: string | null, v: any): StartFrom | null {
  const bad = (m: string) => ApiError.bad(`start_from: ${m}`);
  let sf: StartFrom;
  if (v === null || v === undefined) return null;
  if (typeof v === "string") {
    const text = v.trim();
    if (!text) return null;
    let kind: string | null = null;
    let what = text;
    const colon = text.indexOf(":");
    if (colon >= 0 && ["task", "branch", "pr", "commit"].includes(text.slice(0, colon))) {
      kind = text.slice(0, colon);
      what = text.slice(colon + 1).trim();
    }
    const pr = (w: string): [number, string | null] | null => {
      const n = w.startsWith("#") ? w.slice(1) : kind === "pr" ? w : null;
      if (n !== null) {
        const num = parse_u64(n);
        return num === null ? null : [num, null];
      }
      // https://github.com/OWNER/REPO/pull/12, with anything after it (`/files`, `#discussion…`).
      const rest = w.startsWith("https://") ? w.slice(8) : w.startsWith("http://") ? w.slice(7) : null;
      if (rest === null) return null;
      const slash = rest.indexOf("/");
      if (slash < 0) return null;
      const parts = rest.slice(slash + 1).split(/[/#?]/);
      if (parts.length >= 4 && parts[2] === "pull" && parts[0] && parts[1]) {
        const num = parse_u64(parts[3]);
        return num === null ? null : [num, `${parts[0]}/${parts[1]}`];
      }
      return null;
    };
    const pull_request = (number: number, repo: string | null): StartFrom =>
      repo !== null ? { type: "pull_request", number, repo } : { type: "pull_request", number };
    if (kind === "task") {
      const t = find_task(c, project, what);
      if (!t) throw bad(`no task ${what} in ${project.name}`);
      sf = { type: "task", task_id: t.id };
    } else if (kind === "pr") {
      const p = pr(what);
      if (!p) throw bad(`${JSON.stringify(what)} isn't a pull request's number or URL`);
      sf = pull_request(p[0], p[1]);
    } else if (kind === "commit") {
      if (!is_hex(what)) throw bad(`${JSON.stringify(what)} isn't a commit's SHA (7 to 40 hex digits)`);
      sf = { type: "commit", commit: what.toLowerCase() };
    } else if (kind !== null) {
      sf = { type: "branch", branch: what };
    } else {
      const t = find_task(c, project, what);
      const p = pr(what);
      if (t) sf = { type: "task", task_id: t.id };
      else if (p) sf = pull_request(p[0], p[1]);
      else if (is_hex(what)) sf = { type: "commit", commit: what.toLowerCase() };
      else sf = { type: "branch", branch: what };
    }
  } else if (typeof v === "object" && !Array.isArray(v)) {
    try {
      sf = db.StartFrom_from_json(v);
    } catch (e) {
      throw bad(err_str(e));
    }
  } else {
    throw bad("must be null, a string or an object");
  }
  if (sf.type === "branch" && !worktree.valid_branch_name(sf.branch)) throw bad(`${JSON.stringify(sf.branch)} isn't a valid branch name`);
  if (sf.type === "commit" && !is_hex(sf.commit)) throw bad(`${JSON.stringify(sf.commit)} isn't a commit's SHA (7 to 40 hex digits)`);
  if (sf.type === "pull_request" && sf.number === 0) throw bad("a pull request's number starts at 1");
  if (sf.type === "task") {
    const other = sf.task_id;
    const t = db.get_task(c, other);
    if (!t) throw bad(`no task ${other}`);
    if (t.kind !== "task" || t.project_id !== project.id) throw bad(`"${t.title}" isn't a task in the same project`);
    if (t.id === task_id) throw bad("a task can't start from itself");
    if (db.is_scratch(t) || documents.documents_only(t) || !(t.use_worktree || t.branch != null))
      throw bad(`"${t.title}" has no branch of its own to start from`);
    // Nor from a task whose worktree (by way of others) needs this one's first: one that starts from it, or is in it as
    // a subproject (each sets the other up first, see worktree::setup).
    if (task_id !== null) {
      const stack: Task[] = [t];
      const seen: string[] = [t.id];
      while (stack.length) {
        const next = stack.pop()!;
        const needs = [next.start_from?.type === "task" ? next.start_from.task_id : null, next.parent_id ?? null];
        for (const id of needs) {
          if (id === null) continue;
          if (id === task_id) throw bad(`"${t.title}" needs this task's worktree first (it starts from it, or is in it)`);
          if (!seen.includes(id)) {
            seen.push(id);
            const n = db.get_task(c, id);
            if (n) stack.push(n);
          }
        }
      }
    }
  }
  return sf;
}

/** Rust's `to_ascii_lowercase` (for `eq_ignore_ascii_case`). */
export const ascii_lower = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

/** The task in `project` that `word` names: its id, or its key (with the project's key, or one it had before), in any case. */
function find_task(c: Conn, project: Project, word: string): Task | null {
  const byId = db.get_task(c, word);
  if (byId && byId.project_id === project.id) return byId;
  const dash = word.lastIndexOf("-");
  if (dash < 0) return null;
  const key = word.slice(0, dash),
    n = word.slice(dash + 1);
  if (!/^[+-]?\d+$/.test(n)) return null;
  const num = Number(n);
  const lower = ascii_lower(key);
  if (![project.key, ...project.former_keys].some((k) => ascii_lower(k) === lower)) return null;
  return db.task_by_number(c, project.id, num);
}
