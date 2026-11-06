// Port of server/src/mcp/tools/resolve.rs: finding the boards, projects and tasks a call names: by id or key, on the
// caller's board or another profile's.
import * as db from "../../db.ts";
import type { Task } from "../../db.ts";
import type { Shared } from "../../state.ts";
import * as runner from "../../agent/runner.ts";
import * as prompts from "../../agent/prompts.ts";
import { ToolError, is_own, type Ctx } from "../tools.ts";

const eq_ic = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function project_json(s: Shared, p: db.Project, board: db.Profile): any {
  return { id: p.id, key: p.key, name: p.name, repo_path: p.repo_path, profile: board.name, host: s.host_name };
}

/** `get_project`: a project's settings, with each prompt's instructions in effect and whether they're the default. */
export function project_settings_json(s: Shared, p: db.Project, board: db.Profile): any {
  const out = project_json(s, p, board);
  out.former_keys = p.former_keys;
  out.base_branch = p.base_branch ?? null;
  out.model = p.model ?? null;
  out.permission_mode = p.permission_mode ?? null;
  out.use_worktrees = p.use_worktrees;
  out.worktrees_root = p.worktrees_root;
  out.setup_script = p.setup_script;
  out.teardown_script = p.teardown_script;
  out.copy_files = p.copy_files;
  out.link_folders = p.link_folders;
  out.status_script = p.status_script;
  out.status_scripts = p.status_scripts;
  out.is_git = p.is_git;
  out.auto_review = p.auto_review;
  out.review_rounds = p.review_rounds;
  out.pull_requests = p.pull_requests;
  out.subproject_pull_requests = p.subproject_pull_requests;
  out.watch_pull_requests = p.watch_pull_requests;
  out.pr_preview_url = p.pr_preview_url ?? null;
  out.reviewers = p.reviewers;
  out.auto_summary = p.auto_summary;
  out.summarizer = p.summarizer ?? null;
  out.summarizers = p.summarizers;
  // What the project's empty reviewers and summarizers use.
  out.profile_reviewers = board.reviewers;
  out.profile_summarizer = board.summarizer ?? null;
  out.profile_summarizers = board.summarizers;
  out.group_name = p.group_name ?? null;
  out.archived = p.archived_at != null;
  const own = [p.start_prompt, p.review_prompt, p.merge_prompt];
  const texts = [prompts.start(p), prompts.review(p), prompts.merge(p)];
  prompts.FIELDS.forEach(([k], i) => {
    out[k] = { instructions: texts[i], default: own[i] == null };
  });
  return out;
}

/** The boards the caller can use on this host: its own profile's first, then the profiles that let its agents in. */
export function boards(s: Shared, ctx: Ctx): db.Profile[] {
  const all = db.list_profiles(s.db()).filter((p) => is_own(ctx, p) || db.grants(p, ctx.profile_name));
  // A stable sort, own first (as `sort_by_key(|p| !is_own)`).
  return [...all.filter((p) => is_own(ctx, p)), ...all.filter((p) => !is_own(ctx, p))];
}

/** The board named by a `profile` argument or prefix (all of them for none or "all"). */
export function pick_boards(s: Shared, ctx: Ctx, profile: string | null): db.Profile[] {
  const all = boards(s, ctx);
  if (profile === null || profile === "all") return all;
  const name = profile;
  const named = (p: db.Profile) => eq_ic(p.name, name) || p.id === name;
  const b = all.find(named);
  if (b) return [b];
  // Not found, so that linked hosts are tried too.
  throw ToolError.not_found(
    db.list_profiles(s.db()).some(named)
      ? `profile ${name}'s board on ${s.host_name} doesn't let agents in profile ${ctx.profile_name} use it. Ask the user: they can allow it in Settings → Profiles (edit ${name}, "Agents from other profiles")`
      : `profile ${name}`,
  );
}

/**
 * `work:SD-3` → ["work", "SD-3"], if a profile here is named `work` (or it's `all`). Ids and keys have no colons, but a
 * project's name may: "Ops: infra" is a name unless there's a profile `Ops`.
 */
function split_ref(s: Shared, r: string): [string | null, string] {
  const i = r.indexOf(":");
  if (i <= 0) return [null, r];
  const [p, rest] = [r.slice(0, i), r.slice(i + 1)];
  // Any profile here, not only those that let the caller in, so pick_boards can say it doesn't. One only on a linked
  // host isn't found here either way, so the call goes on to that host.
  const profile = p === "all" || db.list_profiles(s.db()).some((b) => eq_ic(b.name, p) || b.id === p);
  return profile ? [p, rest] : [null, r];
}

/** One of the matches on the caller's boards: on its own board if it's there, else the only one. */
function pick_one<T>(ctx: Ctx, what: string, found: Array<[db.Profile, T]>, qualified: (b: db.Profile) => string): T {
  const own = found.find(([b]) => is_own(ctx, b));
  if (own) return own[1];
  if (found.length === 0) throw ToolError.not_found(what);
  if (found.length === 1) return found[0][1];
  const names = found.map(([b]) => qualified(b));
  throw ToolError.other(`${what} is on more than one profile's board: name one of ${names.join(", ")} (or pass profile)`);
}

/** A project named by an agent: its id, key or name, optionally as `<profile>:<key>`. */
export function resolve_project(s: Shared, ctx: Ctx, r: string, profile: string | null): db.Project {
  // A name with a colon ("Ops: infra") is a project's on the caller's boards before it's a key on profile Ops's, which
  // they may not even reach.
  if (r.includes(":")) {
    let bs: db.Profile[] | null = null;
    try {
      bs = pick_boards(s, ctx, profile);
    } catch {}
    if (bs) {
      const found: Array<[db.Profile, db.Project]> = [];
      for (const b of bs) {
        const named = db.list_projects(s.db(), b.id).find((p) => eq_ic(p.name, r));
        if (named) found.push([b, named]);
      }
      if (found.length) return pick_one(ctx, `project ${r}`, found, (b) => `${b.name}:${r}`);
    }
  }
  const [prefix, key] = split_ref(s, r);
  const bs = pick_boards(s, ctx, prefix ?? profile);
  const byId = db.get_project(s.db(), key);
  if (byId && bs.some((b) => b.id === byId.profile_id)) return byId;
  const found: Array<[db.Profile, db.Project]> = [];
  for (const b of bs) {
    const projects = db.list_projects(s.db(), b.id);
    const p = projects.find((p) => eq_ic(p.key, key) || eq_ic(p.name, key)) ?? projects.find((p) => p.former_keys.some((f: string) => eq_ic(f, key)));
    if (p) found.push([b, p]);
  }
  return pick_one(ctx, `project ${r}`, found, (b) => `${b.name}:${key}`);
}

export function project_key(s: Shared, t: Task): string {
  return runner.task_key_prefix(s, t);
}

/** A subproject named by an agent (task id or key). */
export function subproject_arg(s: Shared, ctx: Ctx, id: string, profile: string | null): Task {
  const t = resolve_task(s, ctx, id, profile);
  if (!t.subproject) throw ToolError.other(`${id} is not a subproject`);
  return t;
}

/** The tasks named in a `depends_on` argument (ids or keys), as ids. Null if it wasn't given. */
export function dependency_ids(s: Shared, ctx: Ctx, v: any, profile: string | null): string[] | null {
  if (v === undefined || v === null) return null;
  if (!Array.isArray(v)) throw ToolError.other("depends_on must be a list of task ids or keys");
  const ids: string[] = [];
  for (const r of v) {
    if (typeof r !== "string") throw ToolError.other("depends_on must be a list of task ids or keys");
    ids.push(resolve_task(s, ctx, r, profile).id);
  }
  return ids;
}

/** A task named by an agent: its id or a key like `ABC-12`, optionally as `<profile>:ABC-12`. */
export function resolve_task(s: Shared, ctx: Ctx, r: string, profile: string | null): Task {
  const [prefix, id] = split_ref(s, r);
  const bs = pick_boards(s, ctx, prefix ?? profile);
  // Not a review thread, as by its key: an agent's tools only reach tasks.
  // A profile's assistant is its own: other profiles' agents can't reach it (see agent/assistant.ts). So are its routine
  // threads.
  const reaches = (t: Task) => t.kind === "task" && bs.some((b) => b.id === t.profile_id && (!db.is_assistants(t) || is_own(ctx, b)));
  const byId = db.get_task(s.db(), id);
  if (byId && reaches(byId)) return byId;
  const found: Array<[db.Profile, Task]> = [];
  const dash = id.lastIndexOf("-");
  const [k, ns] = dash < 0 ? ["", ""] : [id.slice(0, dash), id.slice(dash + 1)];
  // Rust's `parse::<i64>`: an optional sign and digits.
  if (dash >= 0 && /^[+-]?\d+$/.test(ns)) {
    const n = Number(ns);
    for (const b of bs) {
      // No project has the group, scratch or assistant tasks' keys (see db::free_task_key).
      if (eq_ic(k, runner.GROUP_TASK_KEY)) {
        const t = db.group_task_by_number(s.db(), b.id, n);
        if (t) found.push([b, t]);
        continue;
      }
      if (eq_ic(k, db.SCRATCH_TASK_KEY)) {
        const t = db.scratch_task_by_number(s.db(), b.id, n);
        if (t) found.push([b, t]);
        continue;
      }
      if (eq_ic(k, db.ASSISTANT_TASK_KEY)) {
        const t = is_own(ctx, b) ? db.assistant_task_by_number(s.db(), b.id, n) : null;
        if (t) found.push([b, t]);
        continue;
      }
      // A key a project had before still names its tasks. No other project can take it (see api::check_key), so more
      // than one is from before that, and naming either would be a guess.
      const projects = db.list_projects(s.db(), b.id);
      const here: Array<[db.Project, Task]> = [];
      for (const p of projects.filter((p) => eq_ic(p.key, k) || p.former_keys.some((f: string) => eq_ic(f, k)))) {
        const t = db.task_by_number(s.db(), p.id, n);
        if (t) here.push([p, t]);
      }
      if (here.length > 1) {
        const ids = here.map(([p, t]) => `${t.title} (id ${t.id}, in ${p.name})`);
        throw ToolError.other(`task ${r} could be more than one task: ${ids.join(", ")}; name it by its id`);
      }
      for (const [, t] of here) found.push([b, t]);
    }
  }
  return pick_one(ctx, `task ${r}`, found, (b) => `${b.name}:${id}`);
}
