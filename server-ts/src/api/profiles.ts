// Port of server/src/api/profiles.rs: profiles, one per Claude login, each with its own board.
import { mkdirSync } from "node:fs";
import { isAbsolute } from "node:path";
import * as db from "../db.ts";
import type { Conn, Reviewer } from "../db.ts";
import { ApiError, type Req } from "../http.ts";
import type { AppState } from "../state.ts";
import { err_str, expand_tilde } from "../util.ts";
import { pick } from "../api.ts";
import * as worktree from "../git/worktree.ts";
import * as github from "../integrations/github.ts";
import * as asana from "../integrations/asana.ts";
import * as gh_mcp from "../mcp/gh_mcp.ts";
import * as review from "../review.ts";
import * as assistant from "../agent/assistant.ts";
import { char_count, def_bool, def_value, json_map, opt_str, opt_strings, opt_value, req_str } from "./extract.ts";
import { ascii_lower } from "./new_task.ts";

export async function list_profiles(s: AppState) {
  return db.list_profiles(s.db());
}

export async function create_profile(s: AppState, r: Req) {
  const body = json_map(r);
  const b = {
    name: req_str(body, "name"),
    /** The Claude configs it can use, the default first. */
    claude_config_ids: opt_strings(body, "claude_config_ids"),
    /** Instead of `claude_config_ids`: use the config with this directory, creating it if needed (clients from before configs were separate). */
    claude_config_dir: opt_str(body, "claude_config_dir"),
    default_model: opt_str(body, "default_model"),
    /** See `db::Profile::agent_access`. */
    agent_access: opt_value(body, "agent_access"),
    github_account: def_value(body, "github_account"),
    /** See `db::Profile::clone_dir` (API 55). */
    clone_dir: def_value(body, "clone_dir"),
    /** See `db::Profile::asana_enabled` (API 60). */
    asana_enabled: def_bool(body, "asana_enabled", true),
    /** See `db::Profile::limit_wait` (API 81). */
    limit_wait: def_bool(body, "limit_wait"),
    limit_switch: def_bool(body, "limit_switch"),
    /** See `db::Profile::reviewers` (API 87). */
    reviewers: def_value(body, "reviewers"),
    /** See `db::Profile::summarizer` (API 87); `summarizers` (API 103) is used instead if it's given. */
    summarizer: def_value(body, "summarizer"),
    summarizers: def_value(body, "summarizers"),
    /** See `db::Profile::merge_approval` (API 92). */
    merge_approval: def_bool(body, "merge_approval"),
    /** See `db::Profile::require_pr_approval` (API 95). */
    require_pr_approval: def_bool(body, "require_pr_approval"),
    /** See `db::Profile::assistant_host` (API 111). */
    assistant_host: def_value(body, "assistant_host"),
  };
  const c = s.db();
  const name = check_profile_name(c, null, b.name);
  let ids: string[];
  if (b.claude_config_ids !== null) ids = check_config_ids(c, b.claude_config_ids);
  else if (b.claude_config_dir !== null) ids = [db.config_for_dir(c, name, b.claude_config_dir)];
  else ids = [];
  const access = b.agent_access !== null ? check_agent_access(name, b.agent_access) : null;
  const github_account = check_github_account(b.github_account);
  const clone_dir = check_clone_dir(b.clone_dir);
  const reviewers = reviewers_value(c, b.reviewers, true, []);
  const given = b.summarizers === null ? legacy_summarizer([], b.summarizer) : b.summarizers;
  const summarizers = summarizers_value(c, given, true, []);
  const assistant_host = assistant.check_host(s, b.assistant_host);
  let p = db.insert_profile(c, name, ids, b.default_model);
  const fields: Array<[string, any]> = [["github_account", github_account], ["clone_dir", clone_dir], ["asana_enabled", b.asana_enabled]];
  fields.push(["limit_wait", b.limit_wait], ["limit_switch", b.limit_switch], ["reviewers", reviewers], ["summarizer", summarizer_mirror(summarizers)], ["summarizers", summarizers]);
  fields.push(["merge_approval", b.merge_approval]);
  fields.push(["require_pr_approval", b.require_pr_approval]);
  fields.push(["assistant_host", assistant_host]);
  if (access !== null) fields.push(["agent_access", access]);
  const updated = db.update_profile(c, p.id, fields);
  if (!updated) throw ApiError.not_found("profile");
  p = updated;
  try {
    mkdirSync(s.profile_scratch_dir(p.id), { recursive: true });
  } catch {}
  s.emit({ type: "profiles_changed" });
  return p;
}

export async function update_profile(s: AppState, r: Req) {
  const id = r.params.id;
  const b = json_map(r);
  if (!db.get_profile(s.db(), id)) throw ApiError.not_found("profile");
  // Checked with Asana before the database is locked.
  const asana_fields = Object.hasOwn(b, "asana_token") ? await check_asana_token(b.asana_token) : null;
  const assistant_host = Object.hasOwn(b, "assistant_host") ? assistant.check_host(s, b.assistant_host) : undefined;
  const c = s.db();
  const current = db.get_profile(c, id);
  if (!current) throw ApiError.not_found("profile");
  const fields = pick(b, ["default_model"]);
  if (assistant_host !== undefined) fields.push(["assistant_host", assistant_host]);
  if (Object.hasOwn(b, "name")) {
    // Its name unchanged passes even if another profile has it in another case (allowed before HA-37), since the
    // profile form sends it with every save.
    const v = b.name;
    const name = typeof v === "string" && v.trim() === current.name ? v.trim() : check_profile_name(c, id, v);
    fields.push(["name", name]);
  }
  if (asana_fields) {
    fields.push(["asana_token", asana_fields[0]]);
    fields.push(["asana_user", asana_fields[1]]);
  }
  if (Object.hasOwn(b, "agent_access")) {
    const named = fields.find(([k]) => k === "name")?.[1];
    const name = typeof named === "string" ? named : current.name;
    fields.push(["agent_access", check_agent_access(name, b.agent_access)]);
  }
  if (Object.hasOwn(b, "github_account")) fields.push(["github_account", check_github_account(b.github_account)]);
  if (Object.hasOwn(b, "clone_dir")) fields.push(["clone_dir", check_clone_dir(b.clone_dir)]);
  if (Object.hasOwn(b, "asana_enabled")) {
    if (typeof b.asana_enabled !== "boolean") throw ApiError.bad("asana_enabled must be true or false");
    fields.push(["asana_enabled", b.asana_enabled]);
  }
  for (const key of ["limit_wait", "limit_switch", "merge_approval", "require_pr_approval"]) {
    if (Object.hasOwn(b, key)) {
      if (typeof b[key] !== "boolean") throw ApiError.bad(`${key} must be true or false`);
      fields.push([key, b[key]]);
    }
  }
  // Either may name a config deleted since it was saved, as both are sent with every save.
  const saved: Reviewer[] = [...current.reviewers, ...current.summarizers];
  if (Object.hasOwn(b, "reviewers")) fields.push(["reviewers", reviewers_value(c, b.reviewers, true, saved)]);
  const given = Object.hasOwn(b, "summarizers") ? b.summarizers : Object.hasOwn(b, "summarizer") ? legacy_summarizer(current.summarizers, b.summarizer) : undefined;
  if (given !== undefined) {
    const value = summarizers_value(c, given, true, saved);
    fields.push(["summarizer", summarizer_mirror(value)]);
    fields.push(["summarizers", value]);
  }
  if (Object.hasOwn(b, "claude_config_ids")) {
    const v = b.claude_config_ids;
    if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) throw ApiError.bad("claude_config_ids must be a list of config ids");
    fields.push(["claude_config_ids", check_config_ids(c, v)]);
  } else if (typeof b.claude_config_dir === "string") {
    // An older client changing the directory: switch the default to that directory's config.
    const first = db.config_for_dir(c, current.name, b.claude_config_dir);
    fields.push(["claude_config_ids", [first, ...current.claude_config_ids.filter((x) => x !== first)]]);
  }
  const p = db.update_profile(c, id, fields);
  if (!p) throw ApiError.not_found("profile");
  s.emit({ type: "profiles_changed" });
  return p;
}

/**
 * A profile's Asana token as it's stored, with who it's for (see integrations/asana.rs): null (or blank) disconnects
 * it, and a token is checked with Asana first.
 */
async function check_asana_token(v: any): Promise<[any, any]> {
  let token: string;
  if (v === null) token = "";
  else if (typeof v === "string") token = v.trim();
  else throw ApiError.bad("asana_token must be null or a string");
  if (!token) return [null, null];
  let user: any;
  try {
    user = await asana.me(token);
  } catch (e) {
    throw ApiError.bad(err_str(e));
  }
  return [token, asana.label(user)];
}

/** Whether an error from integrations/asana is its `Error::NotFound`. */
function asana_not_found(e: any): boolean {
  return e?.kind === "NotFound" || e === "NotFound" || err_str(e) === "Asana has no such task, or the token can't see it";
}

/** `GET /profiles/{id}/asana/tasks?q=`: the Asana tasks the profile's token finds for `q` (a search, or a task's URL), for linking a task to one (API 57). */
export async function asana_tasks(s: AppState, r: Req) {
  const q = r.query.q ?? "";
  const p = db.get_profile(s.db(), r.params.id);
  if (!p) throw ApiError.not_found("profile");
  if (!p.asana_enabled) throw ApiError.conflict(`Asana is turned off for the ${p.name} profile (Settings → Profiles)`);
  const token = p.asana_token;
  if (!token) throw ApiError.conflict(`the ${p.name} profile isn't connected to Asana`);
  try {
    return await asana.search(token, q);
  } catch (e) {
    if (asana_not_found(e) && asana.task_gid(q.trim()) != null) return [];
    throw new ApiError(502, err_str(e));
  }
}

/** A profile's or project's GitHub account as it's stored: null (or blank) for the default. */
export function check_github_account(v: any): any {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") throw ApiError.bad("github_account must be null or a string");
  const account = v.trim();
  if (!account) return null;
  if (gh_mcp.Account_parse(account) == null) throw ApiError.bad("github_account must be a GitHub login, or HOST/LOGIN for another GitHub host");
  return account;
}

/** The GitHub accounts gh is signed in to on this host (see gh_mcp::accounts). */
export async function github_accounts() {
  return await gh_mcp.accounts();
}

/** The GitHub repositories an account can clone, for adding one as a project (API 55). */
export async function github_repos(_s: AppState, r: Req) {
  // The GitHub account to act as (see `check_github_account`); gh's active one without it. `q` finds the repositories
  // named like this, its organizations' too (see github::list).
  const account = check_github_account(r.query.account ?? null);
  return await github.list(account, r.query.q ?? null);
}

/** A profile's clone folder as it's stored: null (or blank) for the default, else a folder on this host, absolute or in the home folder (`~/…`). */
function check_clone_dir(v: any): any {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") throw ApiError.bad("clone_dir must be null or a string");
  const dir = v.trim();
  if (!dir) return null;
  if (!isAbsolute(expand_tilde(dir))) throw ApiError.bad("clone_dir must be an absolute path, or start with ~/");
  return dir;
}

/** A project's or task's base branch: null (or blank) for the default, else a name git takes for a branch, as an agent may set it to anything. */
export async function check_base_branch(v: any): Promise<any> {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") throw ApiError.bad("base_branch must be null or a string");
  const name = v.trim();
  if (!name) return null;
  if (!worktree.valid_branch_name(name)) throw ApiError.bad(`base_branch ${JSON.stringify(name)} isn't a valid branch name`);
  return name;
}

/**
 * A profile's name, trimmed: required, and not another profile's in any case, as other profiles grant access by name
 * (see `check_agent_access`). `own` is the profile it's for, if it exists.
 */
function check_profile_name(c: Conn, own: string | null, v: any): string {
  const name = typeof v === "string" ? v.trim() : "";
  if (!name) throw ApiError.bad("name is required");
  const lower = ascii_lower(name);
  const other = db.list_profiles(c).find((p) => p.id !== own && ascii_lower(p.name) === lower);
  if (other) throw ApiError.conflict(`there's a profile named ${other.name} already`);
  return name;
}

/** Profile names whose agents may use a profile's board, tidied (`*` for every profile). */
export function check_agent_access(own_name: string, v: any): string[] {
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) throw ApiError.bad("agent_access must be a list of profile names");
  let names = v.map((n: string) => n.trim()).filter((n: string) => n && n !== own_name);
  names = [...new Set(names)].sort(byte_order);
  if (names.includes("*")) names = ["*"];
  return names;
}

/** Rust's `String` ordering (by bytes; by code points, which is the same). */
export function byte_order(a: string, b: string): number {
  const x = Buffer.from(a), y = Buffer.from(b);
  return Buffer.compare(x, y);
}

/** Config ids that exist, without repeats, in the order given. */
export function check_config_ids(c: Conn, ids: string[]): string[] {
  const out: string[] = [];
  for (const id of ids) {
    if (!db.get_claude_config(c, id)) throw ApiError.bad(`no Claude config ${id}`);
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/** The most skills a summarizer or reviewer can be asked to use, and the longest prompt it can have. */
const MAX_SKILLS = 20;
const MAX_PROMPT = 20_000;

/** A Reviewer as serde writes it: `name` and `prompt` left out when they're None, and `skills` when it's empty. */
function reviewer(claude_config_id: string | null, model: string | null, effort: string | null, name: string | null, skills: string[], prompt: string | null): Reviewer {
  const r: Reviewer = { claude_config_id, model, effort };
  if (name !== null) r.name = name;
  if (skills.length) r.skills = skills;
  if (prompt !== null) r.prompt = prompt;
  return r;
}

const is_default = (r: Reviewer) => r.claude_config_id == null && r.model == null && r.effort == null && r.name == null && !r.skills?.length && r.prompt == null;

/**
 * Reviewers (or summarizers, which keep their name, skills and prompt), with blank fields as None and each config
 * checked, except those in `saved` (the ones already saved), which may have been deleted since: their reviews fall
 * back to the task's config, and saving other changes keeps them.
 */
function check_reviewers(c: Conn, list: Reviewer[], saved: Reviewer[], summarizers: boolean): Reviewer[] {
  const what = summarizers ? "summarizers" : "reviewers";
  if (list.length > review.MAX_REVIEWERS) throw ApiError.bad(`there can be at most ${review.MAX_REVIEWERS} ${what}`);
  const blank = (v: string | null | undefined) => {
    const t = v?.trim();
    return t ? t : null;
  };
  const out: Reviewer[] = [];
  for (const r of list) {
    const prompt = blank(r.prompt);
    if (prompt !== null && char_count(prompt) > MAX_PROMPT) throw ApiError.bad(`a prompt can be at most ${MAX_PROMPT} characters`);
    const skills: string[] = [];
    for (const given of r.skills ?? []) {
      const skill = given.trim().replace(/^[/$]+/, "").trim();
      if (!skill || skills.includes(skill)) continue;
      if (/\s/u.test(skill)) throw ApiError.bad(`${JSON.stringify(skill)} isn't a skill's name: skills are named without spaces`);
      skills.push(skill);
    }
    if (skills.length > MAX_SKILLS) throw ApiError.bad(`a ${summarizers ? "summarizer" : "reviewer"} can use at most ${MAX_SKILLS} skills`);
    const checked = reviewer(blank(r.claude_config_id), blank(r.model), blank(r.effort), summarizers ? blank(r.name) : null, skills, prompt);
    const id = checked.claude_config_id;
    if (id != null && !saved.some((s) => s.claude_config_id === id) && !db.get_claude_config(c, id)) throw ApiError.bad(`no Claude config ${id}`);
    out.push(checked);
  }
  return out;
}

/** `serde_json::from_value::<Option<Vec<Reviewer>>>`, with `msg` for one that isn't. */
function reviewer_list(v: any, msg: string): Reviewer[] | null {
  if (v === null || v === undefined) return null;
  if (!Array.isArray(v)) throw ApiError.bad(msg);
  try {
    return v.map((x) => db.Reviewer_from_json(x));
  } catch {
    throw ApiError.bad(msg);
  }
}

/**
 * A project's or profile's `reviewers` as saved: checked, and null when it's empty. With `defaults_too`, just one
 * reviewer with the defaults is null too (a profile's, which is the same); a project's is kept, so it reviews with the
 * task's config rather than the profile's reviewers.
 */
export function reviewers_value(c: Conn, v: any, defaults_too: boolean, saved: Reviewer[]): any {
  const list = reviewer_list(v, "reviewers must be null or a list of {claude_config_id, model, effort, prompt, skills}");
  if (list === null) return null;
  const l = check_reviewers(c, list, saved, false);
  return l.length && !(defaults_too && l.length === 1 && is_default(l[0])) ? JSON.stringify(l) : null;
}

/**
 * A project's or profile's `summarizers` as saved, checked like `reviewers_value`'s: null when it's empty, or with
 * `defaults_too` just one with the defaults (a project's is kept, so it summarises with the task's config rather than
 * the profile's summarizers).
 */
export function summarizers_value(c: Conn, v: any, defaults_too: boolean, saved: Reviewer[]): any {
  const list = reviewer_list(v, "summarizers must be null or a list of {claude_config_id, model, effort, name, skills, prompt}");
  if (list === null) return null;
  const l = check_reviewers(c, list, saved, true);
  return l.length && !(defaults_too && l.length === 1 && is_default(l[0])) ? JSON.stringify(l) : null;
}

/**
 * The `summarizers` a `summarizer` from a client from before API 103 (which only knows the first) means, over the
 * `current` ones: null clears them; one that's still the first changes nothing, as such a client sends it with every
 * save; another replaces just the first, and keeps the rest.
 */
export function legacy_summarizer(current: Reviewer[], v: any): any {
  if (v === null || v === undefined) return null;
  let given: Reviewer;
  try {
    given = db.Reviewer_from_json(v);
  } catch {
    return [v];
  }
  const same = (a: Reviewer, b: Reviewer) => a.claude_config_id === b.claude_config_id && a.model === b.model && a.effort === b.effort;
  if (!current.length) return [given];
  if (same(current[0], given)) return current;
  return [given, ...current.slice(1)];
}

/** What the `summarizer` column (the first of the summarizers, for clients from before API 103) has when `summarizers` is saved as `value` (see `summarizers_value`). */
export function summarizer_mirror(value: any): any {
  if (typeof value !== "string") return null;
  try {
    const l = JSON.parse(value);
    if (!Array.isArray(l) || !l.length) return null;
    return JSON.stringify(db.Reviewer_from_json(l[0]));
  } catch {
    return null;
  }
}

