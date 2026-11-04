// Port of server/src/api/projects.rs: projects: creating, importing, editing, archiving and relocating them.
import { existsSync, lstatSync, mkdirSync, rmSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import * as db from "../db.ts";
import type { Project, Reviewer } from "../db.ts";
import { ApiError, type Req } from "../http.ts";
import type { AppState } from "../state.ts";
import { derive_key, err_str, expand_tilde, new_id, now, path_str } from "../util.ts";
import { pick } from "../api.ts";
import * as runner from "../agent/runner.ts";
import * as runs from "../agent/runs.ts";
import * as documents from "../agent/documents.ts";
import * as worktree from "../git/worktree.ts";
import * as worktree_files from "../git/worktree_files.ts";
import * as relocate from "../git/relocate.ts";
import * as checkpoints from "../git/checkpoints.ts";
import * as github from "../integrations/github.ts";
import * as gh_mcp from "../mcp/gh_mcp.ts";
import * as permissions from "../mcp/permissions.ts";
import * as pr_watch from "../mcp/pr_watch.ts";
import * as terminal from "../hosts/terminal.ts";
import * as attachments from "../attachments.ts";
import { canonical_or, char_count, components, debug_list, def_str, drop_guard, file_name, json_map, opt_bool, opt_str, path_starts_with, query_bool, req_str } from "./extract.ts";
import { check_base_branch, check_config_ids, check_github_account, legacy_summarizer, reviewers_value, summarizer_mirror, summarizers_value } from "./profiles.ts";
import { ascii_lower } from "./new_task.ts";

const is_dir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

export async function list_projects(s: AppState, r: Req) {
  // `?archived=true` lists the archived projects instead of the others (API 46).
  const archived = query_bool(r, "archived");
  return db.list_projects(s.db(), r.params.id).filter((p) => (p.archived_at != null) === archived);
}

/** A new project, as `POST /profiles/{id}/projects` takes it (a missing field is None, or "" for the name). */
export interface CreateProject {
  name?: string;
  repo_path: string;
  key?: string | null;
  base_branch?: string | null;
  use_worktrees?: boolean | null;
}

export async function create_project(s: AppState, r: Req) {
  const body = json_map(r);
  const b: CreateProject = {
    name: def_str(body, "name"),
    repo_path: req_str(body, "repo_path"),
    key: opt_str(body, "key"),
    base_branch: opt_str(body, "base_branch"),
    use_worktrees: opt_bool(body, "use_worktrees"),
  };
  return await create_project_inner(s, r.params.id, b);
}

export async function create_project_inner(s: AppState, profile_id: string, b: CreateProject): Promise<Project> {
  if (!db.get_profile(s.db(), profile_id)) throw ApiError.not_found("profile");
  let repo = expand_tilde(b.repo_path);
  if (!existsSync(repo)) {
    // A new project folder: create it, but only somewhere unambiguous.
    if (!isAbsolute(repo)) throw ApiError.bad(`${repo} does not exist`);
    try {
      mkdirSync(repo, { recursive: true });
    } catch (e) {
      throw ApiError.bad(`creating ${repo}: ${err_str(e)}`);
    }
  }
  if (!is_dir(repo)) throw ApiError.bad(`${repo} is not a directory`);
  repo = canonical_or(repo);
  const is_git = await worktree.is_git_repo(repo);
  const asked = await check_base_branch(b.base_branch ?? null);
  const base_branch: string | null = typeof asked === "string" ? asked : is_git ? ((await worktree.current_branch(repo)) ?? null) : null;
  const name = (b.name ?? "").trim() || file_name(repo) || "Project";
  // Until it's stored, so no change takes its key meanwhile (see update_project_inner).
  const changing = await s.project_changes.lock();
  let p: Project;
  try {
    const given = b.key?.trim() ? b.key.trim().toUpperCase() : null;
    let key: string;
    if (given !== null) {
      if (reserved(given)) throw reserved_key(given);
      check_key(s, profile_id, null, given);
      key = given;
    } else key = new_project_key(s, profile_id, name);
    const id = new_id();
    const base = join(s.data_dir, "projects", id);
    const scratch = join(base, "scratch");
    const worktrees = join(base, "worktrees");
    mkdirSync(scratch, { recursive: true });
    p = db.insert_project(s.db(), {
      id,
      profile_id,
      name,
      key,
      repo_path: path_str(repo),
      scratch_path: path_str(scratch),
      worktrees_root: path_str(worktrees),
      base_branch,
      // Kept for a folder that isn't a git repository yet, for when it becomes one.
      use_worktrees: b.use_worktrees ?? true,
    });
  } finally {
    changing();
  }
  const repo_root = await relocate.fingerprint(repo);
  p = db.update_project(s.db(), p.id, [["repo_root", repo_root]]) ?? p;
  s.emit({ type: "project", project: p });
  return p;
}

/**
 * The key a new project named `name` gets on profile `profile_id` if it isn't given one. A derived key steers clear of
 * the group and scratch tasks' ones, and of the profile's projects' keys.
 */
export function new_project_key(s: AppState, profile_id: string, name: string): string {
  const derived = derive_key(name);
  const base = reserved(derived) ? `${derived}P` : derived;
  const projects = db.list_projects(s.db(), profile_id);
  for (let n = 1; ; n++) {
    const k = n === 1 ? base : `${base}${n}`;
    if (!key_owner(projects, null, k)) return k;
  }
}

/** Cloning a GitHub repository as a project (API 55). */
export interface CloneProject {
  /** The GitHub repository, as `OWNER/REPO`. */
  repo: string;
  /** Where to clone it to: by default a folder named after it in the profile's clone folder. */
  repo_path?: string | null;
  name?: string;
  key?: string | null;
}

export async function clone_project(s: AppState, r: Req) {
  const body = json_map(r);
  const b: CloneProject = { repo: req_str(body, "repo"), repo_path: opt_str(body, "repo_path"), name: def_str(body, "name"), key: opt_str(body, "key") };
  return await clone_project_inner(s, r.params.id, b, gh_mcp.gh_program());
}

/**
 * Clones a GitHub repository with `gh` as the profile's GitHub account, and adds it as a project (API 55). A clone of it
 * that's where it would go already is added as it is, unless it's one of the profile's projects already.
 */
export async function clone_project_inner(s: AppState, profile_id: string, b: CloneProject, gh: string): Promise<Project> {
  const profile = db.get_profile(s.db(), profile_id);
  if (!profile) throw ApiError.not_found("profile");
  const repo = github.check_repo(b.repo);
  if (repo == null) throw ApiError.bad("repo must be a GitHub repository, as OWNER/REPO");
  const given = b.repo_path?.trim();
  const dest = given ? expand_tilde(given) : join(expand_tilde(db.clone_dir_or_default(profile)), repo.includes("/") ? repo.slice(repo.indexOf("/") + 1) : "");
  if (!isAbsolute(dest)) throw ApiError.bad("repo_path must be an absolute path, or start with ~/");
  // A key that would stop the project being added stops the clone first (and is checked again then).
  const key = b.key?.trim() ? b.key.trim().toUpperCase() : null;
  if (key !== null) {
    if (reserved(key)) throw reserved_key(key);
    check_key(s, profile_id, null, key);
  }
  // (Rust spawns this so it carries on without the request: the dialog closed, a hub gave up on a slow clone. A promise
  // runs to the end whether or not anyone waits for it.) Until the project is added, the folder is reserved, so a
  // request for it meanwhile (the dialog opened again) waits for this one, and then finds the project rather than a
  // clone to add again.
  const folder = await github.reserve(dest);
  try {
    const dir = github.folder(dest);
    const p = db.list_projects(s.db(), profile_id).find((p) => components(p.repo_path) === components(dir));
    if (p) throw ApiError.conflict(`${dest} is already the project "${p.name}"`);
    try {
      await github.clone(gh, profile.github_account, repo, dest);
    } catch (e) {
      throw ApiError.bad(err_str(e));
    }
    return await create_project_inner(s, profile_id, { name: b.name ?? "", repo_path: path_str(dest), key, base_branch: null, use_worktrees: null });
  } finally {
    drop_guard(folder);
  }
}

/** Creating a GitHub repository for a folder, and adding it as a project (API 102). */
export interface NewGithubProject {
  /** The folder, on this host: a git repository, or a folder that isn't one yet (or doesn't exist yet). */
  repo_path: string;
  name?: string;
  key?: string | null;
  /** The GitHub repository's name: by default the folder's. */
  repo_name?: string | null;
  /** Who owns it: by default the profile's GitHub account (gh's active one without), or an organization it belongs to. */
  owner?: string | null;
  /** `public` or `private`. */
  visibility: string;
}

export function NewGithubProject_from_json(body: any): NewGithubProject {
  const b = json_map({ body } as Req);
  return {
    repo_path: req_str(b, "repo_path"),
    name: def_str(b, "name"),
    key: opt_str(b, "key"),
    repo_name: opt_str(b, "repo_name"),
    owner: opt_str(b, "owner"),
    visibility: req_str(b, "visibility"),
  };
}

export async function create_github_project(s: AppState, r: Req) {
  return await create_github_project_inner(s, r.params.id, NewGithubProject_from_json(r.body), gh_mcp.gh_program());
}

/**
 * Creates a GitHub repository, public or private, as the profile's GitHub account with `gh`, makes it the `origin` of
 * the folder (a git repository is made of it first if it isn't one) and adds the folder as a project (API 102). The
 * response is the project, and `github`: `{full_name, pushed, push_error}`.
 */
export async function create_github_project_inner(s: AppState, profile_id: string, b: NewGithubProject, gh: string): Promise<any> {
  const profile = db.get_profile(s.db(), profile_id);
  if (!profile) throw ApiError.not_found("profile");
  let priv: boolean;
  if (b.visibility === "private") priv = true;
  else if (b.visibility === "public") priv = false;
  else throw ApiError.bad("visibility must be public or private");
  const dest = expand_tilde(b.repo_path.trim());
  if (!b.repo_path.trim() || !isAbsolute(dest)) throw ApiError.bad("repo_path must be an absolute path, or start with ~/");
  if (existsSync(dest) && !is_dir(dest)) throw ApiError.bad(`${dest} is not a directory`);
  const default_name = file_name(dest) ?? "";
  const repo_name = github.check_name(b.repo_name?.trim() || default_name);
  if (repo_name == null) throw ApiError.bad("the repository's name must be letters, digits, - _ and . (up to 100)");
  // A key that would stop the project being added stops the repository being made first (and is checked again then).
  const key = b.key?.trim() ? b.key.trim().toUpperCase() : null;
  if (key !== null) {
    if (reserved(key)) throw reserved_key(key);
    check_key(s, profile_id, null, key);
  }
  // (Carries on without the request, so a repository that's made is also added.)
  const folder = await github.reserve(dest);
  try {
    const dir = github.folder(dest);
    const existing = db.list_projects(s.db(), profile_id).find((p) => components(p.repo_path) === components(dir));
    if (existing) throw ApiError.conflict(`${dest} is already the project "${existing.name}"`);
    let made: any;
    try {
      made = await github.create(gh, profile.github_account, dest, b.owner ?? null, repo_name, priv);
    } catch (e) {
      throw ApiError.bad(err_str(e));
    }
    let p: Project;
    try {
      p = await create_project_inner(s, profile_id, { name: b.name ?? "", repo_path: path_str(dest), key, base_branch: null, use_worktrees: null });
    } catch (e) {
      const status = e instanceof ApiError ? e.status : 500;
      throw new ApiError(status, `created ${made.full_name} on GitHub, but couldn't add the project: ${e instanceof ApiError ? e.message : err_str(e)}`);
    }
    if (made.push_error) console.warn(made.push_error);
    return { ...p, github: { full_name: made.full_name, pushed: made.pushed, push_error: made.push_error ?? null } };
  } finally {
    drop_guard(folder);
  }
}

export async function get_project(s: AppState, r: Req) {
  const p = db.get_project(s.db(), r.params.id);
  if (!p) throw ApiError.not_found("project");
  return p;
}

export async function update_project(s: AppState, r: Req) {
  return await update_project_inner(s, r.params.id, json_map(r));
}

/**
 * `move_repo: true` with a new `repo_path` moves the repository folder there; a `repo_path` alone points the project at
 * where its folder is now (see git/relocate.rs).
 */
export async function update_project_inner(s: AppState, id: string, b: Record<string, any>): Promise<Project> {
  // One at a time: moving the folder takes a while, and meanwhile another change mustn't take the key this one checked,
  // or store old keys this one would overwrite.
  const changing = await s.project_changes.lock();
  try {
    const before = db.get_project(s.db(), id);
    if (!before) throw ApiError.not_found("project");
    const fields = await project_fields(s, before, b);
    // Archiving is stored on its own, once the other changes check out (see archive).
    let archive_now = false;
    const ai = fields.findIndex(([k]) => k === "archived");
    if (ai >= 0) {
      const [[, archive]] = fields.splice(ai, 1);
      if (typeof archive !== "boolean") throw ApiError.bad("archived must be true or false");
      if (archive && before.archived_at == null) archive_now = true;
      else if (!archive) fields.push(["archived_at", null]);
    }
    // The old key keeps naming the project's tasks (e.g. OS-2 after OS became OMS).
    const key = fields.find(([k]) => k === "key");
    if (key && key[1] !== before.key) {
      const former = before.former_keys.filter((k) => key[1] !== k && k !== before.key);
      former.push(before.key);
      fields.push(["former_keys", JSON.stringify(former)]);
    }
    const move_repo = b.move_repo === true;
    let new_repo: number | null = fields.findIndex(([k]) => k === "repo_path");
    if (new_repo < 0 || fields[new_repo][1] === before.repo_path) new_repo = null;
    if (move_repo && new_repo === null) throw ApiError.bad("move_repo needs a new repo_path to move the folder to");
    // Tried (and rolled back) before the folder moves, so a change that can't be stored doesn't leave the folder
    // somewhere the project doesn't say.
    if (!db.preview_project_update(s.db(), id, fields)) throw ApiError.not_found("project");
    if (archive_now) archive(s, before);
    // Where the folder and what was in it are now, once they've moved.
    const relocated: Array<[string, any]> = [];
    // (Dropped before `changing`, so agents waiting for the move see it done.)
    const moving = new_repo !== null ? relocate.Moving_new(s, id) : null;
    try {
      if (new_repo !== null) {
        const target = typeof fields[new_repo][1] === "string" ? fields[new_repo][1] : "";
        const moved = await relocate.change(s, before, target, move_repo);
        fields[new_repo][1] = moved.repo_path;
        relocated.push(["repo_path", moved.repo_path]);
        relocated.push(["repo_root", moved.repo_root]);
        // Folders kept inside the repository moved with it, unless they're being set too.
        for (const [k, v] of [["worktrees_root", moved.worktrees_root], ["scratch_path", moved.scratch_path]] as Array<[string, string | null]>) {
          if (v != null) relocated.push([k, v]);
        }
        for (const [k, v] of relocated) if (!fields.some(([f]) => f === k)) fields.push([k, v]);
      }
      let p: Project;
      try {
        const updated = db.update_project(s.db(), id, fields);
        if (!updated) throw ApiError.not_found("project");
        p = updated;
      } catch (e) {
        // The folder has moved all the same, so the project says where it is now.
        if (relocated.length && !(e instanceof ApiError)) {
          try {
            const moved = db.update_project(s.db(), id, relocated);
            if (moved) s.emit({ type: "project", project: moved });
          } catch {}
        }
        throw e;
      }
      s.emit({ type: "project", project: p });
      if (p.pr_preview_url !== before.pr_preview_url) {
        try {
          follow_pr_previews(s, before, p);
        } catch (e) {
          console.error(`project ${p.id}: updating its tasks' preview URLs: ${err_str(e)}`);
        }
      }
      // Its tasks waiting for their dependencies or a merge slot while it was archived can go now.
      if (before.archived_at != null && p.archived_at == null) {
        runner.start_next_merge(s, p.id);
        runner.start_unblocked(s, p.id);
      }
      // The last of a group's projects to move to another group takes its group tasks along.
      const from = before.group_name;
      if (from != null && p.group_name !== from) {
        for (const tid of db.rename_group_tasks(s.db(), p.profile_id, from, p.group_name)) {
          const t = db.get_task(s.db(), tid);
          if (t) s.emit_task(t);
        }
      }
      return p;
    } finally {
      drop_guard(moving);
    }
  } finally {
    changing();
  }
}

/**
 * Gives project `p`'s tasks their pull requests' previews from its new `pr_preview_url`, in place of those from the old
 * one (`before`'s). A preview URL set otherwise stays, and done tasks without one get none: their previews are gone.
 */
function follow_pr_previews(s: AppState, before: Project, p: Project) {
  for (const t of db.list_tasks_for_project(s.db(), p.id, "task")) {
    const ours = t.preview_url != null ? t.preview_url === db.preview_for(before, t.pr_url ?? null) : t.status !== "done";
    const preview = db.preview_for(p, t.pr_url ?? null);
    if (ours && preview !== (t.preview_url ?? null)) {
      // Unless the task changed meanwhile.
      const unchanged = (c: db.Conn) => {
        const now = db.get_task(c, t.id);
        return !!now && (now.preview_url ?? null) === (t.preview_url ?? null) && (now.pr_url ?? null) === (t.pr_url ?? null);
      };
      s.update_task_if(t.id, [["preview_url", preview]], unchanged);
    }
  }
}

/**
 * Archives `p`, unless one of its agents is running: their tasks would be off the board. (Rust does this under the runs
 * lock, which runner::start_run checks archived projects under; here nothing runs in between.)
 */
function archive(s: AppState, p: Project) {
  const c = s.db();
  const ids = db.all<{ id: string }>(c, "SELECT id FROM tasks WHERE project_id=?1", p.id).map((r) => r.id);
  const n = ids.filter((id) => s.runs.has(id)).length;
  if (n === 0) {
    db.update_project(c, p.id, [["archived_at", now()]]);
    return;
  }
  throw ApiError.conflict(`${n} of the project's agents ${n === 1 ? "is" : "are"} running; stop ${n === 1 ? "it" : "them"} before archiving it`);
}

const PROJECT_FIELDS = [
  "name", "key", "repo_path", "base_branch", "setup_script", "teardown_script", "status_script", "status_scripts", "use_worktrees", "permission_mode", "model",
  "worktrees_root", "auto_review", "review_rounds", "reviewers", "auto_summary", "summarizer", "summarizers", "claude_config_ids", "start_prompt", "review_prompt", "merge_prompt", "group_name",
  "archived",
  "merge_approval",
  "require_pr_approval",
  "github_account",
  "done_when_merged",
  "pull_requests",
  "subproject_pull_requests",
  "watch_pull_requests",
  "pr_preview_url",
  "copy_files",
  "link_folders",
];

/** The project fields in `b`, checked and as they're stored, for a change to `before`. `archived` stays as given, for update_project_inner to turn into `archived_at`. */
export async function project_fields(s: AppState, before: Project, b: Record<string, any>): Promise<Array<[string, any]>> {
  let fields = pick(b, PROJECT_FIELDS);
  // Configs deleted since they were saved, here or in the profile's (which the project's settings start from when it
  // takes its own), are kept (see check_reviewers).
  const profile = db.get_profile(s.db(), before.profile_id);
  const saved_reviewers: Reviewer[] = [...before.reviewers, ...before.summarizers, ...(profile ? [...profile.reviewers, ...profile.summarizers] : [])];
  // A client from before API 103 sends the one `summarizer`: that's the only one, unless it also sends `summarizers`.
  if (!fields.some(([k]) => k === "summarizers")) {
    const i = fields.findIndex(([k]) => k === "summarizer");
    if (i >= 0) {
      const [[, v]] = fields.splice(i, 1);
      fields.push(["summarizers", legacy_summarizer(before.summarizers, v)]);
    }
  }
  fields = fields.filter(([k]) => k !== "summarizer");
  for (const f of fields) {
    const [k, v] = f;
    switch (k) {
      // null (or blank) uses the default (see agent/prompts.rs).
      case "start_prompt":
      case "review_prompt":
      case "merge_prompt": {
        if (!(v === null || typeof v === "string")) throw ApiError.bad(`${k} must be null or a string`);
        const text = typeof v === "string" ? v.trim() : "";
        f[1] = text || null;
        break;
      }
      // null (or blank) takes the project out of its group.
      case "group_name": {
        if (!(v === null || typeof v === "string")) throw ApiError.bad("group_name must be null or a string");
        const name = typeof v === "string" ? v.trim() : "";
        if (char_count(name) > 100) throw ApiError.bad("group_name can be at most 100 characters");
        f[1] = name || null;
        break;
      }
      // null (or blank) uses the profile's.
      case "github_account":
        f[1] = check_github_account(v);
        break;
      // null (or blank) previews none.
      case "pr_preview_url": {
        const url = typeof v === "string" ? v.trim() : "";
        const ok = (url.startsWith("http://") || url.startsWith("https://")) && url.includes("{pr}");
        if (!(v === null || typeof v === "string") || !(url === "" || ok)) {
          throw ApiError.bad("pr_preview_url must be null or an http(s) URL with {pr} for the pull request's number");
        }
        f[1] = url || null;
        break;
      }
      // One per line; null is none.
      case "copy_files":
      case "link_folders": {
        if (!(v === null || typeof v === "string")) throw ApiError.bad(`${k} must be a string, one entry per line`);
        const text = typeof v === "string" ? v.trim() : "";
        try {
          worktree_files.check(k, text);
        } catch (e) {
          throw ApiError.bad(err_str(e));
        }
        f[1] = text;
        break;
      }
      // null falls back to the host's default mode.
      case "permission_mode":
        if (!(v === null || (typeof v === "string" && db.PERMISSION_MODES.includes(v)))) {
          throw ApiError.bad(`permission_mode must be null or one of ${debug_list(db.PERMISSION_MODES)}`);
        }
        break;
      case "repo_path":
      case "worktrees_root": {
        const path = typeof v === "string" ? v.trim() : "";
        if (!path) throw ApiError.bad(`${k} can't be empty`);
        f[1] = path_str(expand_tilde(path));
        break;
      }
      case "base_branch":
        f[1] = await check_base_branch(v);
        break;
      case "name": {
        const name = typeof v === "string" ? v.trim() : "";
        if (!name) throw ApiError.bad("name can't be empty");
        if (char_count(name) > 100) throw ApiError.bad("name can be at most 100 characters");
        f[1] = name;
        break;
      }
      case "key": {
        const key = (typeof v === "string" ? v : "").trim().toUpperCase();
        if (reserved(key)) throw reserved_key(key);
        if (key !== before.key) check_key(s, before.profile_id, before.id, key);
        f[1] = key;
        break;
      }
      case "watch_pull_requests":
        if (!(typeof v === "string" && pr_watch.WATCH_MODES.includes(v))) throw ApiError.bad(`watch_pull_requests must be one of ${debug_list(pr_watch.WATCH_MODES)}`);
        break;
      // null follows the profile's.
      case "merge_approval":
        if (!(v === null || typeof v === "boolean")) throw ApiError.bad("merge_approval must be null, true or false");
        break;
      case "require_pr_approval":
        if (!(v === null || typeof v === "boolean")) throw ApiError.bad("require_pr_approval must be null, true or false");
        break;
      case "use_worktrees":
      case "auto_review":
      case "auto_summary":
      case "done_when_merged":
      case "pull_requests":
      case "subproject_pull_requests":
        if (typeof v !== "boolean") throw ApiError.bad(`${k} must be true or false`);
        break;
      case "review_rounds":
        if (!(typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 20)) throw ApiError.bad("review_rounds must be a whole number from 0 to 20");
        break;
      // null (or an empty list) uses the profile's reviewers.
      case "reviewers":
        f[1] = reviewers_value(s.db(), v, false, saved_reviewers);
        break;
      // null (or an empty list) uses the profile's summarizers.
      case "summarizers":
        f[1] = summarizers_value(s.db(), v, false, saved_reviewers);
        break;
      // A script per status; null or a blank script is none.
      case "status_scripts": {
        const msg = "status_scripts must be null or an object of status: script";
        if (v !== null && (typeof v !== "object" || Array.isArray(v) || !Object.values(v).every((x) => typeof x === "string"))) throw ApiError.bad(msg);
        const scripts: Record<string, string> = v ?? {};
        const keys = Object.keys(scripts).sort();
        const unknown = keys.find((k) => !db.STATUSES.includes(k));
        if (unknown !== undefined) throw ApiError.bad(`unknown status ${JSON.stringify(unknown)} in status_scripts; statuses are ${debug_list(db.STATUSES)}`);
        const kept: Record<string, string> = {};
        for (const k of keys) if (scripts[k].trim()) kept[k] = scripts[k];
        f[1] = JSON.stringify(kept);
        break;
      }
      // null (or an empty list) uses the profile's configs.
      case "claude_config_ids": {
        if (v !== null && !(Array.isArray(v) && v.every((x) => typeof x === "string"))) throw ApiError.bad("claude_config_ids must be null or a list of config ids");
        const ids = v === null ? null : check_config_ids(s.db(), v);
        f[1] = ids && ids.length ? JSON.stringify(ids) : null;
        break;
      }
    }
  }
  // The first of the summarizers is also kept as the `summarizer` older clients read.
  const summarizers = fields.find(([k]) => k === "summarizers");
  if (summarizers) fields.push(["summarizer", summarizer_mirror(summarizers[1])]);
  // A relative worktrees folder would be made against the server's folder but used by git from the repository's, which
  // puts worktrees in the main checkout; and it can't be the checkout.
  const root_field = fields.find(([k]) => k === "worktrees_root");
  if (root_field) {
    const root = typeof root_field[1] === "string" ? root_field[1] : "";
    const repo_field = fields.find(([k]) => k === "repo_path");
    const repo = repo_field && typeof repo_field[1] === "string" ? repo_field[1] : before.repo_path;
    if (!isAbsolute(root)) throw ApiError.bad("worktrees_root must be an absolute path, or start with ~/");
    const canon = (p: string) => canonical_or(p, components);
    if (canon(root) === canon(repo)) throw ApiError.bad("worktrees_root can't be the repository folder: give it a folder of its own");
  }
  return fields;
}

/**
 * A project's new key: letters and digits, and neither another of the profile's projects' key nor one it had before,
 * which its old task keys still use (a project may take back its own).
 */
function check_key(s: AppState, profile_id: string, project_id: string | null, key: string) {
  if (!key || Buffer.byteLength(key) > 10 || !/^[A-Za-z0-9]+$/.test(key)) throw ApiError.bad("the key must be 1 to 10 letters or digits");
  const other = key_owner(db.list_projects(s.db(), profile_id), project_id, key);
  if (!other) return;
  if (ascii_lower(other.key) === ascii_lower(key)) throw ApiError.bad(`the project "${other.name}" already has the key ${key}`);
  throw ApiError.bad(`the key ${key} was the project "${other.name}"'s, and its old task keys still use it`);
}

/** Which of `projects`, other than `project_id`, has or had `key`. */
function key_owner(projects: Project[], project_id: string | null, key: string): Project | null {
  const k = ascii_lower(key);
  const uses = (p: Project) => ascii_lower(p.key) === k || p.former_keys.some((f) => ascii_lower(f) === k);
  return projects.find((p) => p.id !== project_id && uses(p)) ?? null;
}

/** Group tasks' keys are `G-<n>` and scratch tasks' `S-<n>`, so no project can have the key G or S. */
function reserved(key: string): boolean {
  return key === runner.GROUP_TASK_KEY || key === db.SCRATCH_TASK_KEY;
}

function reserved_key(key: string): ApiError {
  const by = key === db.SCRATCH_TASK_KEY ? "scratch tasks" : "group tasks";
  return ApiError.bad(`the key ${key} is used by ${by}; pick another`);
}

export async function delete_project(s: AppState, r: Req) {
  await delete_project_inner(s, r.params.id);
  return { ok: true };
}

/** Deletes a project with its tasks and their threads and worktrees (not their branches), and its folder in the data dir. */
export async function delete_project_inner(s: AppState, id: string) {
  const project = db.get_project(s.db(), id);
  if (!project) throw ApiError.not_found("project");
  // All its threads: tasks, review threads and any other kind.
  const tasks = db.project_threads(s.db(), id);
  // Settled before the threads go, so the dialog asking about them (or this project) goes too.
  permissions.expire_for_project(s, id);
  const repo = project.repo_path;
  const files = new Set<string>();
  for (const t of tasks) {
    runner.abort(s, t.id);
    permissions.expire_for_task(s, t.id);
    await terminal.kill_all(s, t.id);
    for (const f of attachments.of_task(s.db(), t.id)) files.add(f);
    // Remove worktrees but keep branches so no committed work is lost.
    if (t.start_from != null) await worktree.forget_start(repo, t.id);
    if (t.worktree_path != null) {
      await checkpoints.forget(s, t.id, repo);
      try {
        await worktree.git(repo, ["worktree", "remove", "--force", t.worktree_path]);
      } catch {}
    }
  }
  if (tasks.some((t) => t.worktree_path != null)) {
    try {
      await worktree.git(repo, ["worktree", "prune"]);
    } catch {}
  }
  const run_ids = db.all<{ id: string }>(s.db(), "SELECT r.id FROM runs r JOIN tasks t ON t.id=r.task_id WHERE t.project_id=?1", id).map((r) => r.id);
  db.run(s.db(), "DELETE FROM projects WHERE id=?1", id);
  runs.remove_finished(s, run_ids);
  for (const t of tasks) {
    // Any agent asking to delete one is told it's gone (see tools::delete_task).
    permissions.expire_deletions_of(s, t.id);
    documents.remove(s, t.id);
  }
  // Unless another task refers to them too.
  try {
    attachments.remove_unreferenced(s, files);
  } catch (e) {
    console.warn(`removing attachments while deleting project ${id} failed: ${err_str(e)}`);
  }
  remove_project_dir(s, id);
  s.emit({ type: "project_deleted", id });
}

/**
 * Removes a deleted project's folder in the data dir (its scratch and worktrees folders, unless they were moved, and
 * its skills), unless what's left on the host is in it (see remove_unused_dir).
 */
function remove_project_dir(s: AppState, id: string) {
  remove_unused_dir(s, join(s.data_dir, "projects", id), "project");
}

/**
 * Removes a deleted project's or profile's (`what`) folder in the data dir, unless what's left on the host is in it: a
 * repository, a worktree, or a folder another project or task was pointed at.
 */
export function remove_unused_dir(s: AppState, dir: string, what: string) {
  let meta;
  try {
    meta = lstatSync(dir);
  } catch {
    return;
  }
  if (!meta.isDirectory()) return;
  const canonical = (p: string) => canonical_or(p);
  // A path that doesn't exist yet isn't resolved, so through a symlinked data dir it can only match the folder as it's named.
  const roots = [canonical(dir), dir];
  const used = db
    .all<{ p: string }>(
      s.db(),
      `SELECT repo_path AS p FROM projects UNION SELECT scratch_path FROM projects UNION SELECT worktrees_root FROM projects
       UNION SELECT worktree_path FROM tasks WHERE worktree_path IS NOT NULL UNION SELECT work_dir FROM tasks WHERE work_dir IS NOT NULL`,
    )
    .map((r) => r.p);
  const inside = (p: string) => isAbsolute(p) && roots.some((r) => path_starts_with(canonical(p), r) || path_starts_with(p, r));
  const p = used.find((p) => inside(p));
  if (p !== undefined) {
    console.warn(`keeping ${dir} after deleting its ${what}: ${p} is in it`);
    return;
  }
  try {
    rmSync(dir, { recursive: true });
  } catch (e) {
    console.warn(`removing ${dir} after deleting its ${what}: ${err_str(e)}`);
  }
}

/**
 * `GET /projects/{id}/branches` (API 96): the branches of the project's repository a task can start from (see
 * `check_start_from`), the latest commits first: `{branches: [{name, remote}]}`, local ones as `feature` and those only
 * on a remote as `origin/feature`. Empty for a folder that isn't a git repository.
 */
export async function project_branches(s: AppState, r: Req) {
  const project = db.get_project(s.db(), r.params.id);
  if (!project) throw ApiError.not_found("project");
  return { branches: await worktree.branches(expand_tilde(project.repo_path)) };
}

