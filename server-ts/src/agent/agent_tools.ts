// Port of server/src/agent/agent_tools.rs.
/**
 * Skills and MCP servers for agents, global or per project.
 *
 * The host keeps skills (a `SKILL.md` each) and MCP servers outside any repository: global ones, which each profile
 * switches on or off by default and each project can override, and a project's own. Before each run the skills that are
 * on are written to `<data>/projects/<id>/agent/.claude/skills/<name>/SKILL.md`, which the agent gets with `--add-dir`
 * (Claude Code loads `.claude/skills` from added directories), and the servers go into the run's `--mcp-config` next to
 * the board's own.
 *
 * Skills and servers that come from elsewhere (the Claude config, its plugins, claude.ai connectors, the repository) can
 * be turned off per project: they're denied with `--disallowedTools Skill(<name>)` / `mcp__<server>`. To list them, each
 * run's `init` message records what the agent had, per Claude config ("seen").
 *
 * A global skill can also come from a **skill source**, a git repository the host clones (see `sources`): its skills
 * are global skills with a `source_id`, so profiles and projects switch them on and off like any other, and a run gets
 * the skill's whole folder, not just its `SKILL.md`.
 */
import { mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as db from "../db.ts";
import type { Conn, Project, Task } from "../db.ts";
import { ApiError, type Req } from "../http.ts";
import type { AppState, Shared } from "../state.ts";
import { expand_tilde, new_id, now, path_str } from "../util.ts";
import * as runner from "./runner.ts";
import * as codex from "./codex.ts";
import * as documents from "./documents.ts";
import { copy_skill, get_source, list_sources, sources_root } from "./agent_tools/sources.ts";

export * from "./agent_tools/sources.ts";

export interface Skill {
  id: string;
  /** Null for a global skill. */
  project_id: string | null;
  name: string;
  description: string;
  /** The whole `SKILL.md`, frontmatter included. */
  content: string;
  /** As for `McpServer.enabled`. */
  enabled: boolean;
  /** The skill source (a git repository) it comes from, if it does: it can't be edited or deleted by itself then. */
  source_id: string | null;
  /** Its folder in the source's clone, relative to the clone's root ("" for the root). Not serialized (non-enumerable). */
  source_path: string | null;
  created_at: string;
  updated_at: string;
}

export function Skill_from_row(r: any): Skill {
  const content: string = r.content;
  const s: any = {
    id: r.id,
    project_id: r.project_id ?? null,
    name: r.name,
    description: frontmatter(content)?.description ?? "",
    content,
    enabled: !!r.enabled,
    source_id: r.source_id ?? null,
  };
  Object.defineProperty(s, "source_path", { value: r.source_path ?? null, enumerable: false, writable: true, configurable: true });
  s.created_at = r.created_at;
  s.updated_at = r.updated_at;
  return s;
}

export interface McpServer {
  id: string;
  /** Null for a global server. */
  project_id: string | null;
  name: string;
  /** An `mcpServers` entry: `{"type": "stdio", "command", "args", "env"}` or `{"type": "http" | "sse", "url", "headers"}`. */
  config: any;
  /** A project's own server can be switched off. Global ones are switched per profile and project instead (see `switches`). */
  enabled: boolean;
  /** Its tools run without asking (`--allowedTools mcp__<name>`). */
  auto_allow: boolean;
  created_at: string;
  updated_at: string;
}

export function McpServer_from_row(r: any): McpServer {
  let config: any;
  try {
    config = JSON.parse(r.config);
  } catch {
    config = {};
  }
  return {
    id: r.id,
    project_id: r.project_id ?? null,
    name: r.name,
    config,
    enabled: !!r.enabled,
    auto_allow: !!r.auto_allow,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

/** Skills and servers from outside the project that it turns off, and what its agents had. */
export interface Overrides {
  disabled_skills: string[];
  disabled_mcp_servers: string[];
  /** Claude config id (empty for Claude's default) → what its last run in the project had. */
  seen: Record<string, any>;
}

const Overrides_default = (): Overrides => ({ disabled_skills: [], disabled_mcp_servers: [], seen: {} });

const isObj = (v: any): v is Record<string, any> => v !== null && typeof v === "object" && !Array.isArray(v);

// `project_id IS ?1` matches NULL (global) too.

export function list_skills(c: Conn, project_id: string | null): Skill[] {
  return db.all(c, "SELECT * FROM agent_skills WHERE project_id IS ?1 ORDER BY name", project_id).map(Skill_from_row);
}

export function get_skill(c: Conn, project_id: string | null, id: string): Skill | null {
  const r = db.one(c, "SELECT * FROM agent_skills WHERE project_id IS ?1 AND id=?2", project_id, id);
  return r ? Skill_from_row(r) : null;
}

export function list_mcp_servers(c: Conn, project_id: string | null): McpServer[] {
  return db.all(c, "SELECT * FROM agent_mcp_servers WHERE project_id IS ?1 ORDER BY name", project_id).map(McpServer_from_row);
}

export function get_mcp_server(c: Conn, project_id: string | null, id: string): McpServer | null {
  const r = db.one(c, "SELECT * FROM agent_mcp_servers WHERE project_id IS ?1 AND id=?2", project_id, id);
  return r ? McpServer_from_row(r) : null;
}

/**
 * Whether global skills and servers are on: a profile's defaults (`scope` "profile") or a project's overrides
 * ("project"), by item id. Items without one are off for a profile, and follow the profile in a project.
 */
export function switches(c: Conn, scope: string, scope_id: string): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const r of db.all(c, "SELECT item_id, enabled FROM agent_tool_switches WHERE scope=?1 AND scope_id=?2", scope, scope_id)) {
    out[r.item_id] = !!r.enabled;
  }
  return out;
}

function parse_or<T>(s: string, def: T, ok: (v: any) => boolean): T {
  try {
    const v = JSON.parse(s);
    return ok(v) ? v : def;
  } catch {
    return def;
  }
}

const strings = (v: any) => Array.isArray(v) && v.every((x) => typeof x === "string");

export function get_overrides(c: Conn, project_id: string): Overrides {
  const r = db.one(c, "SELECT disabled_skills, disabled_mcp_servers, seen FROM project_agent_tools WHERE project_id=?1", project_id);
  if (!r) return Overrides_default();
  return {
    disabled_skills: parse_or(r.disabled_skills, [], strings),
    disabled_mcp_servers: parse_or(r.disabled_mcp_servers, [], strings),
    seen: parse_or(r.seen, {}, isObj),
  };
}

export function set_overrides(c: Conn, project_id: string, o: Overrides): void {
  db.run(
    c,
    `INSERT INTO project_agent_tools (project_id, disabled_skills, disabled_mcp_servers, seen) VALUES (?1,?2,?3,?4)
         ON CONFLICT(project_id) DO UPDATE SET disabled_skills=?2, disabled_mcp_servers=?3, seen=?4`,
    project_id,
    JSON.stringify(o.disabled_skills),
    JSON.stringify(o.disabled_mcp_servers),
    JSON.stringify(o.seen),
  );
}

// ---------- validation ----------

export interface Frontmatter {
  name: string;
  description: string;
  /** `user-invocable: false` hides a skill from Claude Code's `/` commands (only Claude uses it). */
  user_invocable: boolean;
}

/** Rust's `str::lines`: split on `\n`, dropping a `\r` before it, and no empty last line after a final `\n`. */
function lines(s: string): string[] {
  if (s === "") return [];
  const out = s.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  if (s.endsWith("\n")) out.pop();
  return out;
}

/**
 * `name` and `description` from a `SKILL.md`'s YAML frontmatter. Handles plain, quoted and block (`>`, `|`) scalars,
 * which is all skills use for these two.
 */
export function frontmatter(content: string): Frontmatter | null {
  content = content.replace(/^\u{feff}+/u, "");
  if (!content.startsWith("---")) return null;
  let rest = content.slice(3).replace(/^[ \t]+/, "");
  if (rest.startsWith("\r\n")) rest = rest.slice(2);
  else if (rest.startsWith("\n")) rest = rest.slice(1);
  else return null;
  const all = lines(rest);
  const end = all.findIndex((l) => l.trimEnd() === "---");
  if (end < 0) return null;
  const ls = all.slice(0, end);
  const raw = (key: string): string | null => {
    for (const l of ls) if (l.startsWith(`${key}:`)) return l.slice(key.length + 1).trim();
    return null;
  };
  const field = (key: string): string | null => {
    const i = ls.findIndex((l) => l.startsWith(`${key}:`));
    if (i < 0) return null;
    const value = ls[i].slice(key.length + 1).trim();
    if (value.startsWith(">") || value.startsWith("|")) {
      const block: string[] = [];
      for (const l of ls.slice(i + 1)) {
        if (!(l.trim() === "" || l.startsWith(" ") || l.startsWith("\t"))) break;
        block.push(l.trim());
      }
      return block.join(value.startsWith(">") ? " " : "\n").trim();
    }
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1);
    if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
    return value;
  };
  const inv = raw("user-invocable");
  return { name: field("name") ?? "", description: field("description") ?? "", user_invocable: inv === null || yaml_true(inv) };
}

/**
 * Whether a frontmatter value is true as Claude Code reads it: true, yes, on or 1, in any case, maybe quoted or with a
 * comment after it. Anything else, such as an empty value, isn't.
 */
export function yaml_true(raw: string): boolean {
  let value: string | null = null;
  let rest = "";
  let quoted = false;
  for (const q of ['"', "'"]) {
    if (!raw.startsWith(q)) continue;
    const end = raw.indexOf(q, 1);
    if (end < 0) continue;
    value = raw.slice(1, end);
    rest = raw.slice(end + 1).trimStart();
    quoted = true;
    break;
  }
  if (!quoted) {
    const m = /\s/u.exec(raw);
    const first = m ? raw.slice(0, m.index) : raw;
    rest = m ? raw.slice(m.index + m[0].length).trimStart() : "";
    value = first !== "" && !first.startsWith("#") ? first : null;
  }
  const rest_is_comment = rest === "" || rest.startsWith("#");
  return value !== null && rest_is_comment && ["true", "yes", "on", "1"].includes(value.replace(/[A-Z]/g, (c) => c.toLowerCase()));
}

/** Claude Code's limit for a skill's description. */
export const MAX_DESCRIPTION = 1024;

export function check_skill(content: string): Frontmatter {
  const f = frontmatter(content);
  if (!f) throw ApiError.bad("SKILL.md must start with a frontmatter block (--- name: …, description: … ---)");
  const valid = f.name !== "" && Buffer.byteLength(f.name) <= 64 && /^[a-z0-9-]+$/.test(f.name) && !f.name.startsWith("-");
  if (!valid) throw ApiError.bad("the skill's name must be lowercase letters, numbers and hyphens (at most 64)");
  if (f.description === "") throw ApiError.bad("the skill needs a description: Claude uses it to decide when to use the skill");
  if ([...f.description].length > MAX_DESCRIPTION) {
    throw ApiError.bad(`the skill's description is too long (at most ${MAX_DESCRIPTION} characters)`);
  }
  return f;
}

export function check_server_name(name: string): void {
  if (name === "" || Buffer.byteLength(name) > 64 || !/^[A-Za-z0-9_-]+$/.test(name)) {
    throw ApiError.bad("the server's name must be letters, numbers, - and _ (at most 64)");
  }
  if (runner.is_board_server(name)) throw ApiError.bad(`${name} is the board's own server`);
}

/** A server's `mcpServers` entry, with `type` filled in. */
export function check_server_config(config: any): any {
  if (!isObj(config)) throw ApiError.bad("the server's config must be a JSON object");
  config = { ...config };
  const has = (k: string) => typeof config[k] === "string" && config[k].trim() !== "";
  const kind: string = typeof config.type === "string" ? config.type : has("url") ? "http" : "stdio";
  if (kind === "stdio" && !has("command")) throw ApiError.bad("a stdio server needs a command");
  if ((kind === "http" || kind === "sse") && !has("url")) throw ApiError.bad(`an ${kind} server needs a url`);
  if (!["stdio", "http", "sse"].includes(kind)) throw ApiError.bad("type must be stdio, http or sse");
  for (const [key, what] of [["args", "a list of strings"], ["env", "an object of strings"], ["headers", "an object of strings"]]) {
    if (!Object.hasOwn(config, key)) continue;
    const v = config[key];
    const ok = Array.isArray(v)
      ? key === "args" && v.every((x) => typeof x === "string")
      : isObj(v)
        ? key !== "args" && Object.values(v).every((x) => typeof x === "string")
        : false;
    if (!ok) throw ApiError.bad(`${key} must be ${what}`);
  }
  config.type = kind;
  return config;
}

/**
 * A skill from outside the board, as typed to turn it off: it goes into a `Skill(<name>)` rule, so spaces, commas and
 * parentheses would break the rules. Plugin skills are `<plugin>:<skill>`.
 */
export function valid_other_skill(name: string): boolean {
  return name !== "" && Buffer.byteLength(name) <= 200 && /^[A-Za-z0-9_:.-]+$/.test(name);
}

/**
 * The skills to turn off from a `disabled_skills` patch. The UI sends the whole list, so a bad name saved before names
 * were checked would fail every later toggle: only new bad names are refused. Saved ones are kept (runs skip them),
 * since a queued save may still send them, and switching one back on removes it.
 */
export function check_disabled_skills(saved: string[], v: string[]): string[] {
  const bad = v.find((n) => !valid_other_skill(n) && !saved.includes(n));
  if (bad !== undefined) throw ApiError.bad(`${JSON.stringify(bad)} isn't a skill name: skill names are letters, numbers, -, _, : and .`);
  return v;
}

/** How Claude Code names a server in its tool names (`mcp__<name>__<tool>`). */
export function tool_prefix(server: string): string {
  const name = [...server].map((c) => (/^[A-Za-z0-9_-]$/.test(c) ? c : "_")).join("");
  return `mcp__${name}`;
}

function unique(c: Conn, table: string, project_id: string | null, name: string, except: string | null): void {
  const taken = db.value<string>(c, `SELECT id FROM ${table} WHERE project_id IS ?1 AND name=?2`, project_id, name);
  if (taken !== undefined && taken !== except) {
    throw ApiError.conflict(`there's already one named ${name} ${project_id !== null ? "in this project" : "on this host"}`);
  }
}

function check_project(c: Conn, project_id: string): Project {
  const p = db.get_project(c, project_id);
  if (!p) throw ApiError.not_found("project");
  return p;
}

/** The deserialization error axum gives for a JSON body of the wrong shape. */
function bad_body(msg: string): ApiError {
  return new ApiError(422, `Failed to deserialize the JSON body into the target type: ${msg}`);
}

function body_of(r: Req): Record<string, any> {
  if (!isObj(r.body)) throw bad_body("invalid type: expected a map");
  return r.body;
}

function opt_str(b: Record<string, any>, k: string): string | null {
  const v = b[k];
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") throw bad_body(`${k}: invalid type: expected a string`);
  return v;
}

function opt_bool(b: Record<string, any>, k: string): boolean | null {
  const v = b[k];
  if (v === undefined || v === null) return null;
  if (typeof v !== "boolean") throw bad_body(`${k}: invalid type: expected a boolean`);
  return v;
}

function opt_strings(b: Record<string, any>, k: string): string[] | null {
  const v = b[k];
  if (v === undefined || v === null) return null;
  if (!strings(v)) throw bad_body(`${k}: invalid type: expected a sequence of strings`);
  return v;
}

// ---------- API ----------

function overview(c: Conn, project: Project): any {
  const o = get_overrides(c, project.id);
  return {
    skills: list_skills(c, project.id),
    mcp_servers: list_mcp_servers(c, project.id),
    disabled_skills: o.disabled_skills,
    disabled_mcp_servers: o.disabled_mcp_servers,
    seen: o.seen,
    global_skills: list_skills(c, null),
    global_mcp_servers: list_mcp_servers(c, null),
    skill_sources: list_sources(c),
    profile_switches: switches(c, "profile", project.profile_id),
    project_switches: switches(c, "project", project.id),
  };
}

export async function get(s: AppState, r: Req): Promise<any> {
  const c = s.db();
  const p = check_project(c, r.params.id);
  return overview(c, p);
}

/** Turn skills and servers from outside the board off (or back on) in a project. */
export async function patch(s: AppState, r: Req): Promise<any> {
  const b = body_of(r);
  const project_id = r.params.id;
  const c = s.db();
  const p = check_project(c, project_id);
  const tidy = (v: string[]) => [...new Set(v.map((n) => n.trim()).filter((n) => n !== ""))].sort();
  const o = get_overrides(c, project_id);
  const skills = opt_strings(b, "disabled_skills");
  const servers = opt_strings(b, "disabled_mcp_servers");
  if (skills !== null) o.disabled_skills = check_disabled_skills(o.disabled_skills, tidy(skills));
  if (servers !== null) {
    // Servers' names can be anything (claude.ai connectors have spaces): `tool_prefix` makes them into the tool names
    // Claude Code uses.
    if (servers.some((n) => runner.is_board_server(n.trim()))) throw ApiError.bad(`${runner.MCP_SERVER_NAME} can't be turned off`);
    o.disabled_mcp_servers = tidy(servers);
  }
  set_overrides(c, project_id, o);
  return overview(c, p);
}

/** The host's global skills and servers, and every profile's defaults for them. */
export async function get_global(s: AppState, _r: Req): Promise<any> {
  const c = s.db();
  const profiles: Record<string, any> = {};
  for (const p of db.list_profiles(c)) profiles[p.id] = switches(c, "profile", p.id);
  return { skills: list_skills(c, null), mcp_servers: list_mcp_servers(c, null), skill_sources: list_sources(c), profile_switches: profiles };
}

export interface SwitchBody {
  /** "profile" or "project". */
  scope: string;
  scope_id: string;
  /** A global skill or server. Either this or `source_id` is given. */
  item_id?: string | null;
  /** Every skill of a skill source, as they are now. */
  source_id?: string | null;
  /** Null clears it: a profile's default goes back to off, a project follows its profile. */
  enabled?: boolean | null;
}

/** Switch a global skill or server on or off for a profile (by default) or a project. */
export async function set_switch(s: AppState, r: Req): Promise<any> {
  const raw = body_of(r);
  for (const k of ["scope", "scope_id"]) if (typeof raw[k] !== "string") throw bad_body(`missing field \`${k}\``);
  const b: SwitchBody = { scope: raw.scope, scope_id: raw.scope_id, item_id: opt_str(raw, "item_id"), source_id: opt_str(raw, "source_id"), enabled: opt_bool(raw, "enabled") };
  const c = s.db();
  let exists: boolean;
  if (b.scope === "profile") exists = db.get_profile(c, b.scope_id) !== null;
  else if (b.scope === "project") exists = db.get_project(c, b.scope_id) !== null;
  else throw ApiError.bad("scope must be profile or project");
  if (!exists) throw ApiError.not_found(b.scope);
  let items: string[];
  if (b.item_id != null) {
    if (get_skill(c, null, b.item_id) === null && get_mcp_server(c, null, b.item_id) === null) throw ApiError.not_found("global skill or MCP server");
    items = [b.item_id];
  } else if (b.source_id != null) {
    if (get_source(c, b.source_id) === null) throw ApiError.not_found("skill source");
    items = db.all(c, "SELECT id FROM agent_skills WHERE source_id=?1", b.source_id).map((x) => x.id);
  } else {
    throw ApiError.bad("item_id or source_id is needed");
  }
  for (const item of items) {
    if (b.enabled != null) {
      db.run(
        c,
        `INSERT INTO agent_tool_switches (scope, scope_id, item_id, enabled) VALUES (?1,?2,?3,?4)
                 ON CONFLICT(scope, scope_id, item_id) DO UPDATE SET enabled=?4`,
        b.scope,
        b.scope_id,
        item,
        b.enabled,
      );
    } else {
      db.run(c, "DELETE FROM agent_tool_switches WHERE scope=?1 AND scope_id=?2 AND item_id=?3", b.scope, b.scope_id, item);
    }
  }
  return { ok: true };
}

export interface SkillBody {
  content?: string | null;
  enabled?: boolean | null;
}

function skill_body(r: Req): SkillBody {
  const b = body_of(r);
  return { content: opt_str(b, "content"), enabled: opt_bool(b, "enabled") };
}

export function create_skill_in(c: Conn, project_id: string | null, b: SkillBody): Skill {
  const content = b.content ?? "";
  const f = check_skill(content);
  unique(c, "agent_skills", project_id, f.name, null);
  const id = new_id();
  const at = now();
  db.run(
    c,
    "INSERT INTO agent_skills (id, project_id, name, content, enabled, created_at, updated_at) VALUES (?1,?2,?3,?4,?5,?6,?6)",
    id,
    project_id,
    f.name,
    content,
    b.enabled ?? true,
    at,
  );
  const s = get_skill(c, project_id, id);
  if (!s) throw ApiError.not_found("skill");
  return s;
}

export function update_skill_in(c: Conn, project_id: string | null, id: string, b: SkillBody): Skill {
  const skill = get_skill(c, project_id, id);
  if (!skill) throw ApiError.not_found("skill");
  if (skill.source_id !== null && b.content != null) {
    throw ApiError.bad("this skill comes from a skill source: change it in its repository, then update the source");
  }
  let name: string, content: string;
  if (b.content != null) {
    const f = check_skill(b.content);
    unique(c, "agent_skills", project_id, f.name, id);
    name = f.name;
    content = b.content;
  } else {
    name = skill.name;
    content = skill.content;
  }
  db.run(c, "UPDATE agent_skills SET name=?1, content=?2, enabled=?3, updated_at=?4 WHERE id=?5", name, content, b.enabled ?? skill.enabled, now(), id);
  if (name !== skill.name) forget_board_skill(c, project_id, skill.name);
  const s = get_skill(c, project_id, id);
  if (!s) throw ApiError.not_found("skill");
  return s;
}

/**
 * A board skill was renamed or deleted: runs that had it reported it by its old name, which mustn't stay in the `/`
 * menu (see for_task), so it's forgotten wherever no skill of the board's has that name now. A skill of that name from
 * elsewhere is found again: in its folder, or by the next run.
 */
export function forget_board_skill(c: Conn, project_id: string | null, name: string): void {
  const projects: string[] = project_id !== null ? [project_id] : db.all(c, "SELECT project_id FROM project_agent_tools").map((r) => r.project_id);
  for (const id of projects) {
    const project = db.get_project(c, id);
    if (!project) continue;
    if (effective(c, project)[0].some((s) => s.name === name)) continue;
    const o = get_overrides(c, id);
    for (const seen of Object.values(o.seen)) {
      if (!isObj(seen)) continue;
      for (const list of ["skills", "board_skills"]) {
        const a = seen[list];
        if (Array.isArray(a)) seen[list] = a.filter((v) => (typeof v === "string" ? v : isObj(v) && typeof v.name === "string" ? v.name : null) !== name);
      }
    }
    set_overrides(c, id, o);
  }
}

export function delete_in(c: Conn, table: string, project_id: string | null, id: string): any {
  const skill = table === "agent_skills" ? get_skill(c, project_id, id) : null;
  if (skill && skill.source_id !== null) throw ApiError.bad("this skill comes from a skill source: remove the source to delete its skills");
  const n = db.run(c, `DELETE FROM ${table} WHERE project_id IS ?1 AND id=?2`, project_id, id).changes;
  if (n === 0) throw ApiError.not_found(table === "agent_skills" ? "skill" : "MCP server");
  if (skill) forget_board_skill(c, project_id, skill.name);
  return { ok: true };
}

export async function create_skill(s: AppState, r: Req): Promise<any> {
  const b = skill_body(r);
  const c = s.db();
  check_project(c, r.params.id);
  return create_skill_in(c, r.params.id, b);
}

export async function update_skill(s: AppState, r: Req): Promise<any> {
  return update_skill_in(s.db(), r.params.id, r.params.skill, skill_body(r));
}

export async function delete_skill(s: AppState, r: Req): Promise<any> {
  return delete_in(s.db(), "agent_skills", r.params.id, r.params.skill);
}

export async function create_global_skill(s: AppState, r: Req): Promise<any> {
  return create_skill_in(s.db(), null, skill_body(r));
}

export async function update_global_skill(s: AppState, r: Req): Promise<any> {
  return update_skill_in(s.db(), null, r.params.skill, skill_body(r));
}

export async function delete_global_skill(s: AppState, r: Req): Promise<any> {
  return delete_in(s.db(), "agent_skills", null, r.params.skill);
}

export interface McpServerBody {
  name?: string | null;
  config?: any;
  enabled?: boolean | null;
  auto_allow?: boolean | null;
}

function server_body(r: Req): McpServerBody {
  const b = body_of(r);
  return { name: opt_str(b, "name"), config: b.config ?? null, enabled: opt_bool(b, "enabled"), auto_allow: opt_bool(b, "auto_allow") };
}

export function create_mcp_server_in(c: Conn, project_id: string | null, b: McpServerBody): McpServer {
  const name = (b.name ?? "").trim();
  check_server_name(name);
  const config = check_server_config(b.config ?? null);
  unique(c, "agent_mcp_servers", project_id, name, null);
  const id = new_id();
  const at = now();
  db.run(
    c,
    "INSERT INTO agent_mcp_servers (id, project_id, name, config, enabled, auto_allow, created_at, updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?7)",
    id,
    project_id,
    name,
    JSON.stringify(config),
    b.enabled ?? true,
    b.auto_allow ?? false,
    at,
  );
  const m = get_mcp_server(c, project_id, id);
  if (!m) throw ApiError.not_found("MCP server");
  return m;
}

export function update_mcp_server_in(c: Conn, project_id: string | null, id: string, b: McpServerBody): McpServer {
  const server = get_mcp_server(c, project_id, id);
  if (!server) throw ApiError.not_found("MCP server");
  let name = server.name;
  if (b.name != null) {
    name = b.name.trim();
    check_server_name(name);
    unique(c, "agent_mcp_servers", project_id, name, id);
  }
  const config = b.config != null ? check_server_config(b.config) : server.config;
  db.run(
    c,
    "UPDATE agent_mcp_servers SET name=?1, config=?2, enabled=?3, auto_allow=?4, updated_at=?5 WHERE id=?6",
    name,
    JSON.stringify(config),
    b.enabled ?? server.enabled,
    b.auto_allow ?? server.auto_allow,
    now(),
    id,
  );
  const m = get_mcp_server(c, project_id, id);
  if (!m) throw ApiError.not_found("MCP server");
  return m;
}

export async function create_mcp_server(s: AppState, r: Req): Promise<any> {
  const b = server_body(r);
  const c = s.db();
  check_project(c, r.params.id);
  return create_mcp_server_in(c, r.params.id, b);
}

export async function update_mcp_server(s: AppState, r: Req): Promise<any> {
  return update_mcp_server_in(s.db(), r.params.id, r.params.server, server_body(r));
}

export async function delete_mcp_server(s: AppState, r: Req): Promise<any> {
  return delete_in(s.db(), "agent_mcp_servers", r.params.id, r.params.server);
}

export async function create_global_mcp_server(s: AppState, r: Req): Promise<any> {
  return create_mcp_server_in(s.db(), null, server_body(r));
}

export async function update_global_mcp_server(s: AppState, r: Req): Promise<any> {
  return update_mcp_server_in(s.db(), null, r.params.server, server_body(r));
}

export async function delete_global_mcp_server(s: AppState, r: Req): Promise<any> {
  return delete_in(s.db(), "agent_mcp_servers", null, r.params.server);
}

// ---------- runs ----------

/** What a run in a project gets on top of the board's own setup. */
export interface RunTools {
  /** Directory holding `.claude/skills`, for `--add-dir`. */
  skills_dir: string | null;
  /** Extra `mcpServers` entries. */
  mcp_servers: Record<string, any>;
  /** For `--allowedTools`. */
  allowed: string[];
  /** For `--disallowedTools`. */
  disallowed: string[];
}

export function RunTools_default(): RunTools {
  return { skills_dir: null, mcp_servers: {}, allowed: [], disallowed: [] };
}

function skills_root(state: Shared, project_id: string): string {
  return join(state.data_dir, "projects", project_id, "agent");
}

/**
 * Where a review or summary thread with skills of its own (`thread_skills`) has its skills written, so that the
 * project's other runs don't lose or gain them.
 */
function thread_skills_root(state: Shared, project_id: string, thread_id: string): string {
  return join(state.data_dir, "projects", project_id, "agent-threads", thread_id);
}

/** A deleted review or summary thread's skills folder goes with it. */
export function remove_thread_skills(state: Shared, project_id: string, thread_id: string): void {
  const dir = thread_skills_root(state, project_id, thread_id);
  try {
    rmSync(dir, { recursive: true });
  } catch (e: any) {
    if (e?.code !== "ENOENT") console.warn(`removing ${dir}: ${e?.message ?? e}`);
  }
}

/**
 * What's on in a project: its own enabled skills and servers, then the global ones switched on for it (its override,
 * else its profile's default). A project's own one takes the name while it's on; switched off, the global one with that
 * name is used if it's on.
 */
export function effective(c: Conn, project: Project): [Skill[], McpServer[]] {
  return effective_with(c, project, []);
}

/**
 * What's on in a project (see `effective`) and the skills of the board's called `extra`, which a review or summary
 * thread has on top of the project's whether or not they're on for it: a project's own one before a global one of that
 * name. A project's own skill switched off for the project's runs can still be picked for a thread; a global one that's
 * switched off can't.
 */
export function effective_with(c: Conn, project: Project, extra: string[]): [Skill[], McpServer[]] {
  const skills = list_skills(c, project.id).filter((s) => s.enabled);
  const servers = list_mcp_servers(c, project.id).filter((s) => s.enabled);
  add_global(c, project.profile_id, project.id, skills, servers);
  if (extra.length) {
    const more = [...list_skills(c, project.id), ...list_skills(c, null)];
    for (const name of extra) {
      // The project's own skill of a name comes first, and takes the place of a global one the project has on.
      const i = more.findIndex((s) => (s.enabled || s.project_id !== null) && s.name === name);
      if (i < 0) continue;
      const at = skills.findIndex((s) => s.name === name);
      if (at >= 0 && skills[at].id === more[i].id) continue;
      if (at >= 0) skills[at] = more.splice(i, 1)[0];
      else skills.push(more.splice(i, 1)[0]);
    }
  }
  return [skills, servers];
}

/**
 * What's on for a profile's runs in no project (its assistant, see agent/assistant.ts): the global skills and servers the
 * profile switches on.
 */
export function effective_for_profile(c: Conn, profile_id: string): [Skill[], McpServer[]] {
  const skills: Skill[] = [], servers: McpServer[] = [];
  add_global(c, profile_id, null, skills, servers);
  return [skills, servers];
}

/**
 * Adds to `skills` and `servers` the global ones switched on for the project (its override, else the profile's default),
 * or with no project for the profile, that don't share a name with them.
 */
function add_global(c: Conn, profile_id: string, project_id: string | null, skills: Skill[], servers: McpServer[]): void {
  const profile = switches(c, "profile", profile_id);
  const own = project_id !== null ? switches(c, "project", project_id) : {};
  const on = (id: string) => (Object.hasOwn(own, id) ? own[id] : Object.hasOwn(profile, id) ? profile[id] : false) === true;
  for (const g of list_skills(c, null)) {
    if (g.enabled && on(g.id) && !skills.some((s) => s.name === g.name)) skills.push(g);
  }
  for (const g of list_mcp_servers(c, null)) {
    if (g.enabled && on(g.id) && !servers.some((s) => s.name === g.name)) servers.push(g);
  }
}

/**
 * Set up a project's skills and servers for a run of thread `thread_id` (a review or summary thread has the board skills
 * its reviewer asks for as well, see `db.thread_skills`).
 */
export function for_run(state: Shared, project_id: string, thread_id: string | null): RunTools {
  return run_tools(state, { project: project_id, thread_id }, true);
}

/** A project's skills and servers as a run would have them, without setting up its skills. */
export function for_preview(state: Shared, project_id: string): RunTools {
  return run_tools(state, { project: project_id, thread_id: null }, false);
}

/**
 * Set up the skills and servers for a run of `task`: its project's, or for a profile's assistant (in no project) the
 * global ones its profile switches on. Other tasks in no project get none.
 */
export function for_task_run(state: Shared, task: Task, project: Project | null): RunTools {
  if (project) return for_run(state, project.id, task.kind === "review" ? task.id : null);
  if (db.is_assistant(task)) return run_tools(state, { profile: task.profile_id }, true);
  return RunTools_default();
}

/** Whose skills and servers a run gets: a project's (with a review or summary thread's own), or a profile's, for its runs in no project. */
type Scope = { project: string; thread_id: string | null } | { profile: string };

function run_tools(state: Shared, scope: Scope, sync: boolean): RunTools {
  const c = state.db();
  let skills: Skill[], servers: McpServer[], o: Overrides, root: string;
  if ("project" in scope) {
    const { project: project_id, thread_id } = scope;
    const project = db.get_project(c, project_id);
    if (!project) throw new Error("project not found");
    const extra: string[] = thread_id !== null ? db.thread_skills(c, thread_id) : [];
    [skills, servers] = effective_with(c, project, extra);
    o = get_overrides(c, project_id);
    root = thread_id !== null && extra.length ? thread_skills_root(state, project_id, thread_id) : skills_root(state, project_id);
  } else {
    [skills, servers] = effective_for_profile(c, scope.profile);
    // A profile has no list of others' skills and servers to turn off.
    o = Overrides_default();
    root = join(state.data_dir, "profiles", scope.profile, "agent");
  }
  if (sync) sync_skills(join(root, ".claude", "skills"), skills, sources_root(state));
  const t = RunTools_default();
  t.skills_dir = skills.length ? path_str(root) : null;
  for (const s of servers) {
    if (s.auto_allow) t.allowed.push(tool_prefix(s.name));
    t.mcp_servers[s.name] = s.config;
  }
  // Lists saved before names were checked may have bad ones.
  t.disallowed.push(...o.disabled_skills.filter(valid_other_skill).map((n) => `Skill(${n})`));
  t.disallowed.push(...o.disabled_mcp_servers.map(tool_prefix));
  return t;
}

const isFile = (p: string) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/**
 * Make `dir` hold exactly these skills. Files that are already right are left alone, since other agents in the project
 * may be reading them. A skill from a source (cloned in `sources`) is its whole folder, with the scripts and references
 * it comes with.
 */
export function sync_skills(dir: string, skills: Skill[], sources: string): void {
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {}
  for (const name of entries) {
    if (!skills.some((s) => s.name === name)) rmSync(join(dir, name), { recursive: true });
  }
  for (const s of skills) {
    if (s.source_id !== null && s.source_path != null) {
      const from = join(sources, s.source_id, s.source_path);
      if (isFile(join(from, "SKILL.md"))) {
        copy_skill(from, join(dir, s.name));
        continue;
      }
    }
    // Not a source's, or its clone has gone (the next update brings it back): the saved SKILL.md.
    const file = join(dir, s.name, "SKILL.md");
    let current: string | null = null;
    try {
      current = readFileSync(file, "utf8");
    } catch {}
    if (current !== s.content) {
      mkdirSync(join(dir, s.name), { recursive: true });
      writeFileSync(file, s.content);
    }
  }
}

/** How long something a run had stays listed after runs stop reporting it. */
const SEEN_DAYS = 14;

/**
 * A run's `init` message: remember the skills and MCP servers its agent had, so the project's settings can list them.
 * Runs don't always report everything (claude.ai connectors may still be connecting), so what earlier runs had is kept
 * for a while.
 */
export function record_seen(c: Conn, project_id: string, config_id: string | null, init: any): void {
  const at = now();
  const cutoff = new Date(Date.now() - SEEN_DAYS * 86_400_000).toISOString();
  const o = get_overrides(c, project_id);
  const key = config_id ?? "";
  const before = o.seen[key] ?? null;
  const nameOf = (v: any) => (isObj(v) ? (v.name ?? null) : null);
  const merge = (fresh: any[], before: any): any[] => {
    const all = fresh.map((v) => ({ ...v, at }));
    for (const old of Array.isArray(before) ? before : []) {
      const recent = isObj(old) && typeof old.at === "string" && old.at > cutoff;
      if (recent && !all.some((v) => JSON.stringify(nameOf(v)) === JSON.stringify(nameOf(old)))) all.push(old);
    }
    const key = (v: any) => (typeof nameOf(v) === "string" ? nameOf(v) : null);
    return all.sort((a, b) => {
      const x = key(a), y = key(b);
      if (x === y) return 0;
      if (x === null) return -1;
      if (y === null) return 1;
      return x < y ? -1 : 1;
    });
  };
  const skills = (Array.isArray(init?.skills) ? init.skills : []).filter((s: any) => typeof s === "string").map((n: string) => ({ name: n }));
  const servers = (Array.isArray(init?.mcp_servers) ? init.mcp_servers : [])
    .filter((s: any) => !(isObj(s) && typeof s.name === "string" && runner.is_board_server(s.name)))
    .map((s: any) => ({ name: isObj(s) ? (s.name ?? null) : null, status: isObj(s) ? (s.status ?? null) : null, source: isObj(s) ? (s.source ?? null) : null }));
  // The board's own skills the run was given, so they can be told from others once they're turned off, renamed or
  // deleted.
  const project = db.get_project(c, project_id);
  const board = project ? effective(c, project)[0].map((s) => s.name) : [];
  o.seen[key] = { skills: merge(skills, before?.skills), mcp_servers: merge(servers, before?.mcp_servers), board_skills: board, at };
  set_overrides(c, project_id, o);
}

// ---------- a task's skills, for the composer ----------

/**
 * A skill the user can call in a message to a task's agent: `/name` for Claude Code, which expands it in `-p` mode as
 * at its own prompt, and `$name` for Codex, whose agents use a skill the user names.
 */
export interface TaskSkill {
  name: string;
  description: string;
}

/** `GET /tasks/{id}/skills`: the skills a task's agent can be asked to use, for the composer's `/` menu (API 54). */
export async function for_task(s: AppState, r: Req): Promise<any> {
  const c = s.db();
  const task = db.get_task(c, r.params.id);
  if (!task) throw ApiError.not_found("task");
  const config = db.task_claude_config(c, task);
  const project = task.project_id ? db.get_project(c, task.project_id) : null;
  const [cwd, add_dirs] = skill_places(s, c, task, project);
  let board: Skill[] = [];
  let board_off: string[] = [];
  let o = Overrides_default();
  if (project) {
    const extra = task.kind === "review" ? db.thread_skills(c, task.id) : [];
    board = effective_with(c, project, extra)[0];
    board_off = board_skills_off(c, project, board);
    o = get_overrides(c, project.id);
  } else if (db.is_assistant(task)) {
    // A profile's assistant has the global skills its profile switches on (see for_task_run).
    board = effective_for_profile(c, task.profile_id)[0];
    board_off = list_skills(c, null).map((s) => s.name).filter((n) => !board.some((s) => s.name === n));
  }
  const repo = project ? expand_tilde(project.repo_path) : null;
  const is_codex = config !== null && db.is_codex(config);
  const dir = config ? db.dir(config) : is_codex ? "~/.codex" : "~/.claude";
  let skills: TaskSkill[];
  if (is_codex) {
    // Codex finds a repository's skills from where it runs; it doesn't read added folders.
    try {
      skills = await codex.skills(dir, cwd);
    } catch (e: any) {
      console.warn(`listing Codex skills: ${e?.message ?? e}`);
      skills = [];
    }
  } else {
    const key = config ? config.id : "";
    // The board's own skills the last run had that are off now aren't given to runs any more; a folder's skill of the
    // same name is still found below.
    const seen = reported_skills(o.seen[key] ?? null, board, board_off);
    // Claude Code reads skills from where it runs and the folders it's given.
    const dirs = [...(cwd !== null ? [cwd] : []), ...add_dirs];
    try {
      skills = claude_skills(expand_tilde(dir), dirs, repo, seen);
    } catch {
      skills = [];
    }
  }
  return { agent: is_codex ? "codex" : "claude", skills: with_board_skills(skills, board, is_codex, o.disabled_skills) };
}

/** Adds the board's own skills, which runs get from its folder (see for_run), and takes out the ones the project turns off. */
export function with_board_skills(skills: TaskSkill[], board: Skill[], is_codex: boolean, disabled: string[]): TaskSkill[] {
  for (const b of board) {
    // Claude Code turns down `/name` for a skill that isn't `user-invocable`.
    if (!is_codex && frontmatter(b.content)?.user_invocable === false) {
      skills = skills.filter((s) => s.name !== b.name);
      continue;
    }
    const found = skills.find((s) => s.name === b.name);
    if (found) found.description = b.description;
    else skills.push({ name: b.name, description: b.description });
  }
  skills = skills.filter((s) => !disabled.includes(s.name));
  skills.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return skills.filter((s, i) => i === 0 || skills[i - 1].name !== s.name);
}

/**
 * Where a task's agent runs and the folders it's given to read, as runner::launch has them, for the skills it finds
 * there: a scratch task (or one that makes only documents) in its own folder, reading its project's; a review thread in
 * the reviewed task's worktree; a task in its worktree once it has one, else the project's checkout; one in no project
 * in its profile's scratch folder.
 */
export function skill_places(state: Shared, c: Conn, task: Task, project: Project | null): [string | null, string[]] {
  const parent = task.parent_id ? db.get_task(c, task.parent_id) : null;
  const worktree = (t: Task) => (t.worktree_state === "ready" ? (t.worktree_path ?? null) : null);
  const repo = project ? project.repo_path : null;
  const add_dirs: string[] = [];
  let cwd: string | null;
  const doc = documents.work_dir(state, task);
  if (doc !== null) {
    if (repo !== null) add_dirs.push(repo);
    if (parent && task.kind === "task" && parent.subproject) {
      const w = worktree(parent);
      if (w !== null) add_dirs.push(w);
    }
    cwd = doc;
  } else if (project) {
    const reviewed = task.kind === "review" ? parent : null;
    cwd = expand_tilde((reviewed ? worktree(reviewed) : worktree(task)) ?? project.repo_path);
  } else {
    cwd = state.profile_scratch_dir(task.profile_id);
  }
  // A group task reads its group's projects.
  if (task.group_name && !project && task.kind === "task") {
    add_dirs.push(...db.group_projects(c, task.profile_id, task.group_name).map((p: Project) => p.repo_path));
  }
  return [cwd, add_dirs.map(expand_tilde)];
}

/** The board's own skills for a project that aren't on for it (`on`, see effective), by name. */
export function board_skills_off(c: Conn, project: Project, on: Skill[]): string[] {
  const all = [...list_skills(c, project.id), ...list_skills(c, null)];
  return all.map((s) => s.name).filter((n) => !on.some((s) => s.name === n));
}

/**
 * The skills Claude Code has with a config dir and working directory, for the `/` menu: the ones its last run in the
 * project reported (`last_run`), which are the ones a user can call, and the ones in the config's and the repository's
 * `skills` folders, which `/<folder>` calls, so a task has them before any run has reported them. One changed since that
 * run to say a user can't call it (`user-invocable: false`) is left out. Descriptions come from the `SKILL.md`s, also
 * those of synced skills and installed plugins' (skills bundled with Claude Code have none). `dirs` are where it runs
 * and the folders it's given; `repo` is the project's main checkout, which plugins installed for the project name.
 */
export function claude_skills(config_dir: string, dirs: string[], repo: string | null, last_run: string[]): TaskSkill[] {
  const user = join(config_dir, "skills");
  // A personal skill wins over the repository's of the same name, as in Claude Code.
  const own: FoundSkill[] = [];
  find_skills(user, 1, "", own);
  for (const d of dirs) find_skills(join(d, ".claude", "skills"), 1, "", own);
  add_aliases(own);
  // A plugin's are `<plugin>:<folder>`, in the installation that applies here.
  const plugins: FoundSkill[] = [];
  const places = [...dirs, ...(repo !== null ? [repo] : [])];
  for (const [plugin, path] of installed_plugins(config_dir, places)) {
    const found: FoundSkill[] = [];
    find_skills(join(path, "skills"), 1, `${plugin}:`, found);
    add_aliases(found);
    plugins.push(...found);
  }
  // Synced ones are in skills/synced/<bucket>/<folder>, under a plugin name the board can't tell, so they only give
  // descriptions.
  const synced: FoundSkill[] = [];
  find_skills(join(user, "synced"), 2, "", synced);
  const exact = (n: string) => own.find((f) => f.name === n) ?? plugins.find((f) => f.name === n);
  const describe = (n: string) => {
    const colon = n.lastIndexOf(":");
    const short = colon >= 0 ? n.slice(colon + 1) : null;
    const by_short = short !== null ? (synced.find((f) => f.name === short) ?? own.filter((f) => !f.alias).find((f) => f.name === short)) : undefined;
    return (exact(n) ?? by_short)?.description ?? "";
  };
  const folders = own.filter((f) => !f.alias).map((f) => f.name);
  const names = [...new Set([...last_run, ...folders])].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return names.filter((n) => !(exact(n) && !exact(n)!.user_invocable)).map((n) => ({ name: n, description: describe(n) }));
}

/**
 * The skills the last run reported (see last_run_skills) less the board's own that aren't on any more: those it gave
 * the run (turned off, renamed or deleted since), and for runs recorded before the board noted those, the ones that are
 * off now.
 */
export function reported_skills(seen: any, on: Skill[], off: string[]): string[] {
  const given: string[] = isObj(seen) && Array.isArray(seen.board_skills) ? seen.board_skills.filter((v: any) => typeof v === "string") : [];
  const gone = (n: string) => !on.some((s) => s.name === n) && (given.includes(n) || off.includes(n));
  return last_run_skills(seen).filter((n) => !gone(n));
}

/**
 * The skills a project's last run with a Claude config reported (see record_seen), rather than all those runs had
 * lately: one that a user can no longer call stops being reported.
 */
export function last_run_skills(seen: any): string[] {
  if (!isObj(seen)) return [];
  const skills = Array.isArray(seen.skills) ? seen.skills : [];
  const at = JSON.stringify(seen.at ?? null);
  return skills.filter((s: any) => JSON.stringify((isObj(s) ? s.at : null) ?? null) === at && isObj(s) && typeof s.name === "string").map((s: any) => s.name);
}

const canonical = (p: string): string | null => {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
};

/**
 * The plugins installed in a Claude config for the folders a task works in, each with the folder of its installation
 * that applies: one for the project (`local`, then `project`, by `projectPath`) over the user's.
 */
export function installed_plugins(config_dir: string, places: string[]): Array<[string, string]> {
  let file: string;
  try {
    file = readFileSync(join(config_dir, "plugins", "installed_plugins.json"), "utf8");
  } catch {
    return [];
  }
  let v: any = null;
  try {
    v = JSON.parse(file);
  } catch {}
  const same = (a: string, b: string) => {
    if (a === b) return true;
    const x = canonical(a);
    return x !== null && x === canonical(b);
  };
  const out: Array<[string, string]> = [];
  const plugins = isObj(v?.plugins) ? v.plugins : {};
  for (const id of Object.keys(plugins).sort()) {
    const installs = plugins[id];
    const plugin = id.split("@")[0];
    const rank = (i: any): number | null => {
      const here = () => typeof i?.projectPath === "string" && places.some((d) => same(i.projectPath, d));
      const scope = i?.scope;
      if (scope === "local" && here()) return 3;
      if (scope === "project" && here()) return 2;
      if (scope === "local" || scope === "project") return null;
      return 1;
    };
    let best: [number, string] | null = null;
    for (const i of Array.isArray(installs) ? installs : []) {
      const r = rank(i);
      if (r === null || typeof i?.installPath !== "string") continue;
      // The last of the best, as Rust's `max_by_key`.
      if (best === null || r >= best[0]) best = [r, i.installPath];
    }
    if (best) out.push([plugin, best[1]]);
  }
  return out;
}

/** A skill in a folder, from its `SKILL.md`. */
interface FoundSkill {
  /** `<prefix><folder>`, the name that always calls it, or for an alias its frontmatter's `name`. */
  name: string;
  /** Its frontmatter's `name`, if that's another (see add_aliases). */
  other_name: string | null;
  /** Found by its frontmatter's `name`: not listed by itself. */
  alias: boolean;
  description: string;
  user_invocable: boolean;
}

function subdirs(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.map((n) => join(dir, n)).filter(isDir).sort();
}

/** The skills in `dir` (folders with a `SKILL.md`), looking `depth` folders down, named `<prefix><folder>`. */
function find_skills(dir: string, depth: number, prefix: string, out: FoundSkill[]): void {
  for (const path of subdirs(dir)) {
    const folder = path.slice(path.lastIndexOf("/") + 1);
    if (folder.startsWith(".") || folder === "node_modules") continue;
    let content: string | null = null;
    try {
      content = readFileSync(join(path, "SKILL.md"), "utf8");
    } catch {}
    if (content !== null) {
      const name = `${prefix}${folder}`;
      if (!out.some((f) => f.name === name)) {
        const f = frontmatter(content);
        // A plugin's skill may name itself with the plugin's prefix already.
        const alias = f && f.name !== "" ? (f.name.startsWith(prefix) ? f.name : `${prefix}${f.name}`) : null;
        out.push({
          other_name: alias !== null && alias !== name ? alias : null,
          name,
          alias: false,
          description: f ? f.description : "",
          user_invocable: f ? f.user_invocable : true,
        });
      }
    } else if (depth > 1) {
      find_skills(path, depth - 1, prefix, out);
    }
  }
}

/**
 * Claude Code may call a skill by its frontmatter's `name` instead of its folder, unless another skill has that name:
 * adds those names, after all the folders', so a run's name for a skill finds it. They aren't listed by themselves.
 */
function add_aliases(found: FoundSkill[]): void {
  const aliases: FoundSkill[] = found
    .filter((f) => f.other_name !== null)
    .map((f) => ({ name: f.other_name!, other_name: null, alias: true, description: f.description, user_invocable: f.user_invocable }));
  for (const a of aliases) if (!found.some((f) => f.name === a.name)) found.push(a);
}
