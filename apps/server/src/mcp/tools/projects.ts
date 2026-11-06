// Port of server/src/mcp/tools/projects.rs: the project tools: creating projects and changing their settings.
import { existsSync, realpathSync, statSync } from "node:fs";
import * as db from "../../db.ts";
import type { Shared } from "../../state.ts";
import * as api from "../../api.ts";
import * as relocate from "../../git/relocate.ts";
import * as worktree from "../../git/worktree.ts";
import { expand_tilde, err_str } from "../../util.ts";
import { ToolError, json_eq, type Ctx } from "../tools.ts";
import { resolve_project, project_json } from "./resolve.ts";
import { approval_project, approval_task, ask_user } from "./approvals.ts";

/** The project an agent names (on a board it can use), or its own. */
export function project_or_own(s: Shared, ctx: Ctx, pid: string | null, profile: string | null, own: string | null): db.Project {
  if (pid !== null) return resolve_project(s, ctx, pid, profile);
  if (own === null) throw ToolError.other("project_id is required (use list_projects)");
  const p = db.get_project(s.db(), own);
  if (!p) throw ToolError.not_found(`project ${own}`);
  return p;
}

/**
 * The settings `update_project` changes without asking: how the project's agents are prompted and reviewed, and what it's
 * called and where on the board it is.
 */
export const AGENT_FIELDS = [
  "name",
  "key",
  "base_branch",
  "model",
  "start_prompt",
  "review_prompt",
  "merge_prompt",
  "auto_review",
  "review_rounds",
  "reviewers",
  "auto_summary",
  "summarizer",
  "summarizers",
  "group_name",
];

/**
 * The settings it only changes once the user approves: they run commands on the host, decide what agents may do without
 * asking, move where the work happens, or bring the repository's ignored files (secrets, say) into worktrees.
 */
export const APPROVAL_FIELDS = [
  "permission_mode",
  "setup_script",
  "teardown_script",
  "copy_files",
  "link_folders",
  "status_script",
  "status_scripts",
  "repo_path",
  "move_repo",
  "use_worktrees",
  "worktrees_root",
];

/** `update_project`: the changes in `args`, asking the user first if any of them need it. Nothing changes if they don't approve. */
export async function update_project(s: Shared, ctx: Ctx, p: db.Project, args: any, reason: string | null): Promise<db.Project> {
  if (args.claude_config_ids != null) {
    throw ToolError.other("a project's agent configs can only be changed by the user, in the project's settings");
  }
  const body: Record<string, any> = {};
  for (const k of [...AGENT_FIELDS, ...APPROVAL_FIELDS]) {
    let v = args[k];
    // An explicit null summarizer or reviewers goes back to the profile's.
    if (v == null && !(["reviewers", "summarizer", "summarizers"].includes(k) && Object.hasOwn(args, k))) continue;
    if (v === undefined) v = null;
    if (["name", "key", "repo_path"].includes(k) && (typeof v !== "string" || !v.trim())) throw ToolError.other(`${k} can't be blank`);
    // A blank one goes back to the default.
    if (["base_branch", "model", "permission_mode"].includes(k) && typeof v === "string" && !v.trim()) v = null;
    body[k] = v;
  }
  if (!Object.keys(body).length) throw ToolError.other("nothing to change");
  // What would change, found by making the change and rolling it back, so it's judged on what the project would be,
  // however each setting is stored. Checked before asking, so the user only sees changes that can be made.
  const fields: Array<[string, any]> = await api.project_fields(s, p, body);
  const after: any = db.preview_project_update(s.db(), p.id, fields);
  if (!after) throw ToolError.not_found(`project ${p.id}`);
  const before: any = p;
  // (Not what `project_fields` adds to them, the first summarizer that older clients read.)
  const changed: string[] = fields.map(([k]) => k).filter((k) => Object.hasOwn(body, k) && !json_eq(before[k], after[k]));
  // A new repository path has to be the project's folder, or where it can move to.
  const move_repo = args.move_repo === true;
  if (changed.includes("repo_path")) {
    await relocate.check(s, p, typeof after.repo_path === "string" ? after.repo_path : "", move_repo);
    if (move_repo) changed.push("move_repo");
  } else if (move_repo) {
    throw ToolError.other("move_repo needs a new repo_path to move the folder to");
  }
  // Only what differs, so a setting left as it was can't overwrite a change made meanwhile; with approval, exactly what
  // the user saw.
  const apply: Record<string, any> = {};
  for (const k of changed) apply[k] = body[k] ?? null;
  if (changed.some((k) => APPROVAL_FIELDS.includes(k))) {
    const change = (k: string) =>
      k === "move_repo"
        ? { field: k, from: false, to: true, needs_approval: true }
        : { field: k, from: before[k] ?? null, to: after[k] ?? null, needs_approval: APPROVAL_FIELDS.includes(k) };
    const changes = changed.map(change);
    const input = { project: approval_project(s, p), task: approval_task(s, ctx), changes, apply, reason };
    const approved = await ask_user(s, ctx, "update_project", input);
    return apply_changes(s, p, approved.apply);
  }
  return apply_changes(s, p, apply);
}

/** Rust's `Path`: a path's parts, without empty and `.` ones. */
function path_parts(p: string): string[] {
  return p.split("/").filter((x) => x && x !== ".");
}

/**
 * What `create_project` asks the user to approve: adding the folder `repo_path` (created if it's missing) as a project
 * named `name` on `board`. Its tasks' agents work in that folder, with the host's default permission mode, so the user
 * sees where it is first.
 */
export async function project_creation(s: Shared, ctx: Ctx, board: db.Profile, name: string | null, repo_path: string, reason: string | null): Promise<any> {
  const given = expand_tilde(repo_path.trim());
  if (!given.startsWith("/")) throw ToolError.other("repo_path must be an absolute path, or start with ~/");
  // The folder as it would be added: symlinks resolved, as far as it exists.
  const missing: string[] = [];
  let existing = path_parts(given);
  const as_path = (parts: string[]) => `/${parts.join("/")}`;
  while (!existsSync(as_path(existing))) {
    const last = existing[existing.length - 1];
    // `..` in the part that doesn't exist yet would hide where it ends up.
    if (existing.length === 0 || last === "..") throw ToolError.other(`${given} isn't a folder that exists or can be created`);
    missing.push(last);
    existing = existing.slice(0, -1);
  }
  let base: string;
  try {
    base = realpathSync(as_path(existing));
  } catch (e) {
    throw ToolError.other(`${as_path(existing)}: ${err_str(e)}`);
  }
  const path = [base.replace(/\/+$/, ""), ...missing.reverse()].join("/") || "/";
  if (!missing.length) {
    let dir = false;
    try {
      dir = statSync(path).isDirectory();
    } catch {}
    if (!dir) throw ToolError.other(`${path} is not a directory`);
  }
  const trimmed = name?.trim() || null;
  const file_name = path_parts(path).pop();
  const project_name = trimmed ?? (file_name && file_name !== ".." ? file_name : "Project");
  const key = api.new_project_key(s, board.id, project_name);
  const git = missing.length === 0 && (await worktree.is_git_repo(path));
  const permission_mode = db.get_setting(s.db(), "default_permission_mode") ?? "default";
  return {
    op: "create",
    project: { id: "", key, name: project_name, host: s.host_name },
    task: approval_task(s, ctx),
    board: board.name,
    repo_path: path,
    exists: missing.length === 0,
    git,
    permission_mode,
    // As a change from nothing, for UIs from before creations were asked about.
    changes: [
      { field: "name", from: null, to: project_name, needs_approval: false },
      { field: "repo_path", from: null, to: path, needs_approval: true },
    ],
    apply: { profile_id: board.id, name: project_name, repo_path: path },
    reason,
  };
}

/**
 * Asks the user to approve the project `input` describes (see project_creation), or carries on waiting for the answer if
 * this call asked before it was retried, then adds it if they approve.
 */
export async function create_project(s: Shared, ctx: Ctx, input: any): Promise<any> {
  const approved = await ask_user(s, ctx, "create_project", input);
  const apply = approved.apply ?? {};
  const profile_id = typeof apply.profile_id === "string" ? apply.profile_id : "";
  const board = db.get_profile(s.db(), profile_id);
  if (!board) throw ToolError.not_found(`profile ${profile_id}`);
  const body = {
    name: typeof apply.name === "string" ? apply.name : "",
    repo_path: typeof apply.repo_path === "string" ? apply.repo_path : "",
    key: null,
    base_branch: null,
    use_worktrees: null,
  };
  const p = await api.create_project_inner(s, board.id, body);
  return project_json(s, p, board);
}

/** Makes `apply` (update_project's arguments that change something) to project `p`. */
export async function apply_changes(s: Shared, p: db.Project, apply: any): Promise<db.Project> {
  if (apply && typeof apply === "object" && !Array.isArray(apply) && Object.keys(apply).length) return api.update_project_inner(s, p.id, apply);
  return p;
}
