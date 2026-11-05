// Port of server/src/db/profiles.rs: profiles (one per Claude login) and Claude configs (the config folders profiles
// and tasks run with).
import { all, hidden, json_list, one, run, update_generic, value, type Conn } from "../db.ts";
import { new_id, now } from "../util.ts";
import { get_project, type Project } from "./projects.ts";
import { Reviewer_default, Reviewer_from_json, json_opt, json_vec, type Reviewer } from "./task_data.ts";
import type { Task } from "./tasks.ts";

/**
 * An agent's config directory (its login, settings and history): Claude Code's, passed to agents as CLAUDE_CONFIG_DIR,
 * or Codex's, passed as CODEX_HOME. Profiles and projects pick which ones their threads can use, so a thread's config
 * also decides which agent runs it.
 */
export interface ClaudeConfig {
  id: string;
  name: string;
  /** May start with `~`. Empty means the agent's default (`~/.claude`, `~/.codex`). */
  config_dir: string;
  /** One of AGENTS. */
  agent: string;
  /** Whether the board fetches and shows its plan's usage limits (see agent/usage.rs). */
  show_usage: boolean;
  /** Whether the board starts its plan's next 5-hour window as soon as one ends (see agent/window.rs). */
  restart_window: boolean;
  /**
   * An Anthropic-compatible proxy its Claude Code agents go through instead of the login in its directory (API 106),
   * such as CLIProxyAPI, which pools several subscriptions: passed as ANTHROPIC_BASE_URL, with `api_key` as
   * ANTHROPIC_AUTH_TOKEN (see `api_env`). The directory's settings, skills and history are still used. None for Codex
   * configs.
   */
  api_url: string | null;
  /** The key agents present to the proxy. Never sent to the board, which sees `has_api_key` (non-enumerable). */
  api_key: string | null;
  /**
   * CLIProxyAPI's management key, which its accounts' usage is read with (see agent/usage.rs, `fetch_proxy`). It can
   * act as any of those accounts, so it's never sent to the board either (non-enumerable).
   */
  management_key: string | null;
  has_api_key: boolean;
  has_management_key: boolean;
  created_at: string;
}

export function ClaudeConfig_from_row(r: any): ClaudeConfig {
  const cfg: any = {
    id: r.id,
    name: r.name,
    config_dir: r.config_dir,
    agent: r.agent,
    show_usage: !!r.show_usage,
    restart_window: !!r.restart_window,
    api_url: r.api_url ?? null,
  };
  hidden(cfg, "api_key", r.api_key ?? null);
  hidden(cfg, "management_key", r.management_key ?? null);
  cfg.has_api_key = r.api_key != null;
  cfg.has_management_key = r.management_key != null;
  cfg.created_at = r.created_at;
  return cfg;
}

/** The proxy its agents go through, if it has one (see `api_url`). */
export function proxy(cfg: ClaudeConfig): string | null {
  const u = cfg.api_url;
  return u != null && !is_codex(cfg) && u.trim() !== "" ? u : null;
}

/**
 * What a `claude` started with this config gets in its environment to go through its proxy: nothing without one.
 * ANTHROPIC_API_KEY is emptied, as Claude Code would send it to the proxy instead of the proxy's key were the server
 * started with one.
 */
export function api_env(cfg: ClaudeConfig): Array<[string, string]> {
  const url = proxy(cfg);
  if (url == null) return [];
  return [
    ["ANTHROPIC_BASE_URL", url.trim().replace(/\/+$/, "")],
    ["ANTHROPIC_AUTH_TOKEN", cfg.api_key ?? ""],
    ["ANTHROPIC_API_KEY", ""],
  ];
}

export function is_codex(cfg: ClaudeConfig): boolean {
  return cfg.agent === "codex";
}

/** The config directory, with the agent's default for an empty one. May start with `~`. */
export function dir(cfg: ClaudeConfig): string {
  const d = cfg.config_dir.trim();
  if (d === "") return is_codex(cfg) ? "~/.codex" : "~/.claude";
  return d;
}

export interface Profile {
  id: string;
  name: string;
  /** The Claude configs its threads can use, the default first. */
  claude_config_ids: string[];
  /** The default config's directory, for clients from before configs were separate. */
  claude_config_dir: string;
  default_model: string | null;
  /**
   * Names of the other profiles whose agents may read and change this profile's board through their board tools (`*`
   * for every profile). Names, since profiles are matched by name across hosts.
   */
  agent_access: string[];
  /**
   * The GitHub account its agents' gh tools act as (see mcp/gh_mcp.rs): a login on github.com, or `HOST/LOGIN` for
   * another GitHub host. None uses gh's active account on the host.
   */
  github_account: string | null;
  /**
   * The folder the new project dialog's GitHub tab clones repositories into, each into a folder of its own. None for
   * `~/<name>` (see `clone_dir_or_default`). May start with `~`.
   */
  clone_dir: string | null;
  /**
   * The Asana personal access token its tasks' Asana links are looked up with (see integrations/asana.rs). Never sent
   * to the board, which sees `asana_user` instead (non-enumerable).
   */
  asana_token: string | null;
  /** Who the Asana token belongs to, as Asana named them when it was set; None when there's none. */
  asana_user: string | null;
  /**
   * Whether it uses Asana (API 60): off, its tasks can't be linked to Asana tasks and the board leaves Asana out. Its
   * token is kept, for when it's turned on again.
   */
  asana_enabled: boolean;
  /**
   * When a run stops because its config's usage limit ran out, its task waits in "In progress" for the limit to reset
   * and then carries on, and tasks started on a config that's out wait for it too (API 81, see agent/usage.rs). Off,
   * the task needs attention, offering to do that.
   */
  limit_wait: boolean;
  /** Tasks whose agent hasn't started yet start on the next of their configs that isn't out of usage, when theirs is (API 81). */
  limit_switch: boolean;
  /**
   * Who reviews the tasks of its projects that have no reviewers of their own (API 87, see `reviewers_for`). Empty is
   * one reviewer with the task's config.
   */
  reviewers: Reviewer[];
  /**
   * Who summarises them, each in a thread of its own, for its projects with no summarizers of their own (API 103, see
   * `summarizers_for`). Empty is one summarizer with the task's config and the default model and effort.
   */
  summarizers: Reviewer[];
  /** The first of `summarizers`, for clients from before there could be several (API 87). */
  summarizer: Reviewer | null;
  /**
   * A task moved to "Ready for merge" has its agent summarise what it would merge, and merges only once the user
   * approves (API 92, see review/merge_gate.rs). Its projects can say otherwise.
   */
  merge_approval: boolean;
  /**
   * A task can only go to "Ready for merge" once its pull request has an approving review on GitHub (API 95). Its
   * projects can say otherwise.
   */
  require_pr_approval: boolean;
  /** The linked host its assistant runs on (API 110, a link id; see agent/assistant.ts). Null for this host. */
  assistant_host: string | null;
  created_at: string;
}

/** Profiles with the directory of their default config. */
const PROFILE_SELECT =
  "SELECT p.*, (SELECT config_dir FROM claude_configs WHERE id=json_extract(p.claude_config_ids, '$[0]')) AS default_config_dir FROM profiles p";

export function Profile_from_row(r: any): Profile {
  const p: any = {
    id: r.id,
    name: r.name,
    claude_config_ids: json_list(r.claude_config_ids),
    claude_config_dir: r.default_config_dir ?? "",
    default_model: r.default_model ?? null,
    agent_access: json_list(r.agent_access),
    github_account: r.github_account ?? null,
    clone_dir: r.clone_dir ?? null,
  };
  hidden(p, "asana_token", r.asana_token ?? null);
  Object.assign(p, {
    asana_user: r.asana_user ?? null,
    asana_enabled: !!r.asana_enabled,
    limit_wait: !!r.limit_wait,
    limit_switch: !!r.limit_switch,
    reviewers: json_vec(r.reviewers, Reviewer_from_json),
    summarizers: summarizers_column(r.summarizers, r.summarizer),
    summarizer: json_opt(r.summarizer, Reviewer_from_json),
    merge_approval: !!r.merge_approval,
    require_pr_approval: !!r.require_pr_approval,
    assistant_host: r.assistant_host ?? null,
    created_at: r.created_at,
  });
  return p;
}

/** Whether agents in the profile named `name` may use this profile's board. */
export function grants(p: Profile, name: string): boolean {
  return p.name === name || p.agent_access.some((n) => n === "*" || n === name);
}

/** The folder its repositories are cloned into: its own, or `~/<name>`. May start with `~`. */
export function clone_dir_or_default(p: Profile): string {
  const d = p.clone_dir?.trim();
  return d ? d : default_clone_dir(p.name);
}

/**
 * The clone folder of a profile that hasn't picked one: `~/<name>` (`~/work`, `~/personal`). The UI has the same
 * (`defaultCloneDir`).
 */
export function default_clone_dir(name: string): string {
  name = name.trim().replaceAll("/", "-");
  return name === "" || name === "." || name === ".." ? "~" : `~/${name}`;
}

// ---------- profiles ----------

export function list_profiles(c: Conn): Profile[] {
  return all(c, `${PROFILE_SELECT} ORDER BY p.created_at`).map(Profile_from_row);
}

export function get_profile(c: Conn, id: string): Profile | null {
  const r = one(c, `${PROFILE_SELECT} WHERE p.id=?1`, id);
  return r ? Profile_from_row(r) : null;
}

/** Who reviews `project`'s tasks: its own reviewers, or else its profile's, or else one reviewer with the task's config. */
export function reviewers_for(c: Conn, project: Project): Reviewer[] {
  if (project.reviewers.length) return structuredClone(project.reviewers);
  const profile = get_profile(c, project.profile_id)?.reviewers ?? [];
  return profile.length ? profile : [Reviewer_default()];
}

/**
 * Who summarises `project`'s tasks: its own summarizers, or else its profile's, or else one summarizer with the task's
 * config and the defaults. Each writes in a thread of its own.
 */
export function summarizers_for(c: Conn, project: Project): Reviewer[] {
  if (project.summarizers.length) return structuredClone(project.summarizers);
  const profile = get_profile(c, project.profile_id)?.summarizers ?? [];
  return profile.length ? profile : [Reviewer_default()];
}

/** A `summarizers` column (a JSON list), or else the single `summarizer` saved before there could be several, as a list. */
export function summarizers_column(list: string | null | undefined, single: string | null | undefined): Reviewer[] {
  const l = json_vec(list, Reviewer_from_json);
  if (l.length) return l;
  const s = json_opt(single, Reviewer_from_json);
  return s ? [s] : [];
}

export function insert_profile(c: Conn, name: string, config_ids: string[], model: string | null): Profile {
  const id = new_id();
  run(c, "INSERT INTO profiles (id,name,claude_config_ids,default_model,created_at) VALUES (?1,?2,?3,?4,?5)", id, name, JSON.stringify(config_ids), model, now());
  return get_profile(c, id)!;
}

/**
 * A profile called `name` with the Claude config in `dir` (see `config_for_dir`), unless there's a profile of that name
 * already, which is left as it is. The new profile if it made one, else null.
 */
export function ensure_profile(c: Conn, name: string, dir: string): Profile | null {
  const lower = (s: string) => s.replace(/[A-Z]/g, (ch) => ch.toLowerCase());
  if (list_profiles(c).some((p) => lower(p.name) === lower(name))) return null;
  const config = config_for_dir(c, name, dir);
  return insert_profile(c, name, [config], null);
}

// ---------- Claude configs ----------

export function list_claude_configs(c: Conn): ClaudeConfig[] {
  return all(c, "SELECT * FROM claude_configs ORDER BY name COLLATE NOCASE, created_at").map(ClaudeConfig_from_row);
}

export function get_claude_config(c: Conn, id: string): ClaudeConfig | null {
  const r = one(c, "SELECT * FROM claude_configs WHERE id=?1", id);
  return r ? ClaudeConfig_from_row(r) : null;
}

export function insert_claude_config(c: Conn, name: string, config_dir: string, agent: string): ClaudeConfig {
  const id = new_id();
  run(c, "INSERT INTO claude_configs (id,name,config_dir,agent,created_at) VALUES (?1,?2,?3,?4,?5)", id, name, config_dir.trim(), agent, now());
  return get_claude_config(c, id)!;
}

const CLAUDE_CONFIG_COLUMNS = ["name", "config_dir", "agent", "show_usage", "restart_window", "api_url", "api_key", "management_key"];

export function update_claude_config(c: Conn, id: string, fields: Array<[string, any]>): ClaudeConfig | null {
  update_generic(c, "claude_configs", CLAUDE_CONFIG_COLUMNS, id, fields);
  return get_claude_config(c, id);
}

/**
 * Delete a config and take it off every profile and project. Threads that ran with it go back to their project's or
 * profile's default.
 */
export function delete_claude_config(c: Conn, id: string): void {
  run(c, "DELETE FROM claude_configs WHERE id=?1", id);
  const drop = (list: string[]) => JSON.stringify(list.filter((x) => x !== id));
  for (const p of list_profiles(c).filter((p) => p.claude_config_ids.includes(id))) {
    run(c, "UPDATE profiles SET claude_config_ids=?1 WHERE id=?2", drop(p.claude_config_ids), p.id);
  }
  const projects = all<{ id: string; claude_config_ids: string }>(c, "SELECT id, claude_config_ids FROM projects WHERE claude_config_ids IS NOT NULL");
  for (const { id: pid, claude_config_ids } of projects) {
    const ids = json_list(claude_config_ids);
    if (ids.includes(id)) {
      const rest = ids.filter((x) => x !== id);
      // An override left empty goes back to the profile's.
      run(c, "UPDATE projects SET claude_config_ids=?1 WHERE id=?2", rest.length ? JSON.stringify(rest) : null, pid);
    }
  }
}

/** The config using `dir`, creating one called `name` if there's none. */
export function config_for_dir(c: Conn, name: string, dir: string): string {
  dir = dir.trim();
  const id = value<string>(c, "SELECT id FROM claude_configs WHERE config_dir=?1 AND agent='claude' ORDER BY created_at LIMIT 1", dir);
  if (id !== undefined) return id;
  return insert_claude_config(c, name, dir, "claude").id;
}

/** The configs a new thread can pick from: its project's override, else its profile's, the default first. */
export function available_configs(c: Conn, profile_id: string, project: Project | null | undefined): ClaudeConfig[] {
  const own = project?.claude_config_ids;
  const ids = own && own.length ? own : (get_profile(c, profile_id)?.claude_config_ids ?? []);
  const out: ClaudeConfig[] = [];
  for (const id of ids) {
    const cfg = get_claude_config(c, id);
    if (cfg) out.push(cfg);
  }
  return out;
}

/** The config a thread runs with: its own, else the default for its project and profile. None means Claude's default config. */
export function task_claude_config(c: Conn, task: Task): ClaudeConfig | null {
  if (task.claude_config_id != null) {
    const cfg = get_claude_config(c, task.claude_config_id);
    if (cfg) return cfg;
  } else if (task.session_id != null) {
    // A thread is given a config when it starts (see runner::launch), so one that has a session without one started in
    // Claude's default config, and its conversation is there.
    return null;
  }
  const project = task.project_id != null ? get_project(c, task.project_id) : null;
  return available_configs(c, task.profile_id, project)[0] ?? null;
}

/** The CLAUDE_CONFIG_DIR (or, for Codex, CODEX_HOME) for a thread, if it isn't the agent's default. */
export function task_config_dir(c: Conn, task: Task): string | null {
  const d = task_claude_config(c, task)?.config_dir;
  return d != null && d.trim() !== "" ? d : null;
}

/** Whether a thread runs on Codex rather than Claude Code (see agent/codex.rs). */
export function task_is_codex(c: Conn, task: Task): boolean {
  const cfg = task_claude_config(c, task);
  return cfg != null && is_codex(cfg);
}

const PROFILE_COLUMNS = [
  "name", "claude_config_ids", "default_model", "agent_access", "github_account", "clone_dir", "asana_token", "asana_user", "asana_enabled",
  "limit_wait", "limit_switch", "reviewers", "summarizer", "summarizers", "merge_approval", "require_pr_approval",
  "assistant_host",
];

export function update_profile(c: Conn, id: string, fields: Array<[string, any]>): Profile | null {
  update_generic(c, "profiles", PROFILE_COLUMNS, id, fields);
  return get_profile(c, id);
}
