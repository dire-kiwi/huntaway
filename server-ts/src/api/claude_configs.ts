// Port of server/src/api/claude_configs.rs: Claude configs (the config folders agents run with), their models, and
// moving a config's login and settings to another host.
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import * as db from "../db.ts";
import * as devices from "../devices.ts";
import { ApiError, type Req } from "../http.ts";
import type { AppState } from "../state.ts";
import { err_str, expand_tilde, path_str } from "../util.ts";
import { pick } from "../api.ts";
import * as codex from "../agent/codex.ts";
import { def_bool, def_str, json_map, opt_str, req_str } from "./extract.ts";
import { delete_one } from "./tasks.ts";
import { delete_project_inner, remove_unused_dir } from "./projects.ts";

export async function list_claude_configs(s: AppState) {
  return db.list_claude_configs(s.db());
}

/** The fields setting a config's proxy (see ClaudeConfig::api_url). */
const PROXY_FIELDS = ["api_url", "api_key", "management_key"];

/** Why `url` crate's `Url::parse` turns `t` down, or null if it takes it (as far as WHATWG's URL parser tells). */
function url_error(t: string): string | null {
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:/.test(t)) return "relative URL without a base";
  try {
    new URL(t);
    return null;
  } catch {
    const rest = t.replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/*/, "");
    const host = rest.split(/[/?#]/)[0].replace(/^.*@/, "");
    if (!host) return "empty host";
    if (host.startsWith("[")) return "invalid IPv6 address";
    const port = /:([^:\]]*)$/.exec(host);
    if (port && !/^\d{0,5}$/.test(port[1])) return "invalid port number";
    if (port && Number(port[1]) > 65535) return "invalid port number";
    return "invalid domain character";
  }
}

/**
 * The proxy fields in `b`, checked: strings, trimmed, a blank one cleared (null), and a URL that's http(s). The keys are
 * write-only, so leaving one out keeps it.
 */
function proxy_fields(b: Record<string, any>): Array<[string, any]> {
  const out: Array<[string, any]> = [];
  for (const key of PROXY_FIELDS) {
    if (!Object.hasOwn(b, key)) continue;
    const v = b[key];
    let t: string;
    if (v === null) t = "";
    else if (typeof v === "string") t = v.trim();
    else throw ApiError.bad(`${key} must be a string`);
    if (key === "api_url" && t) {
      const e = url_error(t);
      if (e) throw ApiError.bad(`api_url isn't a URL: ${e}`);
      const url = new URL(t);
      if (!["http:", "https:"].includes(url.protocol) || !url.hostname) throw ApiError.bad("api_url must be an http:// or https:// URL");
    }
    if (key === "api_url") t = t.replace(/\/+$/, "");
    out.push([key, t || null]);
  }
  return out;
}

function check_agent(agent: string) {
  if (!db.AGENTS.includes(agent)) throw ApiError.bad(`agent must be one of ${db.AGENTS.join(", ")}`);
}

export async function create_claude_config(s: AppState, r: Req) {
  const b = json_map(r);
  const name = req_str(b, "name");
  const config_dir = def_str(b, "config_dir");
  /** One of db::AGENTS (API 25); Claude Code by default. */
  const agent = opt_str(b, "agent") ?? "claude";
  if (!name.trim()) throw ApiError.bad("name is required");
  check_agent(agent);
  // A proxy for its agents, with its keys (API 106, see ClaudeConfig::api_url).
  const proxy = proxy_fields(b);
  if (agent === "codex" && proxy.some(([, v]) => v !== null)) throw ApiError.bad("a proxy is for Claude Code configs");
  const c = s.db();
  let cfg = db.insert_claude_config(c, name.trim(), config_dir, agent);
  if (proxy.length) {
    const updated = db.update_claude_config(c, cfg.id, proxy);
    if (!updated) throw ApiError.not_found("Claude config");
    cfg = updated;
  }
  s.emit({ type: "profiles_changed" });
  return cfg;
}

export async function update_claude_config(s: AppState, r: Req) {
  const id = r.params.id;
  const b = json_map(r);
  const fields = pick(b, ["name", "config_dir", "agent"]);
  for (const f of fields) {
    if (typeof f[1] !== "string") throw ApiError.bad(`${f[0]} must be a string`);
    const t = f[1].trim();
    if (f[0] === "name" && !t) throw ApiError.bad("name is required");
    f[1] = t;
  }
  for (const key of ["show_usage", "restart_window"]) {
    if (Object.hasOwn(b, key)) {
      if (typeof b[key] !== "boolean") throw ApiError.bad(`${key} must be true or false`);
      fields.push([key, b[key]]);
    }
  }
  fields.push(...proxy_fields(b));
  const c = s.db();
  const current = db.get_claude_config(c, id);
  if (!current) throw ApiError.not_found("Claude config");
  // A Codex config can't have a proxy, nor can one that has a proxy become a Codex config.
  const agent_f = fields.find(([k]) => k === "agent");
  const agent: string = agent_f ? agent_f[1] : current.agent;
  const url_f = fields.find(([k]) => k === "api_url");
  const url = url_f ? url_f[1] : (current.api_url ?? null);
  if (agent === "codex" && url != null) throw ApiError.bad("a proxy is for Claude Code configs; clear api_url first");
  if (agent_f) {
    check_agent(agent_f[1]);
    const started = db.value<number>(c, "SELECT COUNT(*) FROM tasks WHERE claude_config_id=?1 AND session_id IS NOT NULL", id) ?? 0;
    if (agent_f[1] !== current.agent && started > 0) throw ApiError.conflict("threads have conversations in this config; add another config for the other agent");
  }
  const cfg = db.update_claude_config(c, id, fields);
  if (!cfg) throw ApiError.not_found("Claude config");
  // Usage read through the old proxy (or from the directory's login) isn't this config's any more.
  if (fields.some(([k]) => PROXY_FIELDS.includes(k))) s.usage.delete(id);
  s.emit({ type: "profiles_changed" });
  return cfg;
}

export async function delete_claude_config(s: AppState, r: Req) {
  const id = r.params.id;
  if (!db.get_claude_config(s.db(), id)) throw ApiError.not_found("Claude config");
  const running = db.value<number>(s.db(), "SELECT COUNT(*) FROM tasks WHERE claude_config_id=?1 AND running=1", id) ?? 0;
  if (running > 0) throw ApiError.conflict("agents are running with this config; stop them first");
  db.delete_claude_config(s.db(), id);
  s.usage.delete(id);
  s.emit({ type: "profiles_changed" });
  return { ok: true };
}

/** Deletes a profile with its projects (see delete_project_inner), its threads in no project, and its folder in the data dir. */
export async function delete_profile(s: AppState, r: Req) {
  const id = r.params.id;
  if (!db.get_profile(s.db(), id)) throw ApiError.not_found("profile");
  // Archived ones too.
  for (const p of db.list_projects(s.db(), id)) await delete_project_inner(s, p.id);
  // Its scratch and group tasks, and their review threads.
  const rest = db.all<{ id: string }>(s.db(), "SELECT id FROM tasks WHERE profile_id=?1 ORDER BY kind='review' DESC, created_at", id).map((r) => r.id);
  for (const tid of rest) {
    // Review threads go first, so each is cleaned up on its own rather than in its task's cascade. One may have been
    // deleted meanwhile.
    const t = db.get_task(s.db(), tid);
    if (!t) continue;
    await delete_one(s, t, false);
  }
  db.run(s.db(), "DELETE FROM profiles WHERE id=?1", id);
  remove_unused_dir(s, join(s.data_dir, "profiles", id), "profile");
  s.emit({ type: "profiles_changed" });
  return { ok: true };
}

/** `GET /claude-configs/{id}/models` (API 25): the models a Codex config offers, with their efforts. Claude configs have none listed (the UI suggests Claude's aliases). */
export async function claude_config_models(s: AppState, r: Req) {
  const cfg = db.get_claude_config(s.db(), r.params.id);
  if (!cfg) throw ApiError.not_found("Claude config");
  if (!db.is_codex(cfg)) return [];
  try {
    return await codex.models(db.dir(cfg));
  } catch (e) {
    throw ApiError.bad(`couldn't list Codex models: ${err_str(e)}`);
  }
}

// ---------- Claude config (login + settings) transfer ----------

/** What makes a Claude config dir usable elsewhere. History, caches and snapshots stay put. */
const CLAUDE_CONFIG_ENTRIES = [
  ".credentials.json",
  ".claude.json",
  "settings.json",
  "settings.local.json",
  "CLAUDE.md",
  "keybindings.json",
  "agents",
  "commands",
  "skills",
  "plugins",
  "hooks",
  "output-styles",
];

/** The same for a Codex home. Sessions, logs and its databases stay put. */
const CODEX_CONFIG_ENTRIES = ["auth.json", "config.toml", "AGENTS.md", "skills", "rules", "prompts"];

/** Where a config's files are, and which of them a copy takes. */
interface ConfigFiles {
  dir: string;
  entries: string[];
  /** The file holding the login. */
  login: string;
}

function config_path(dir: string): string {
  return expand_tilde(dir.trim() ? dir : "~/.claude");
}

function claude_config_files(s: AppState, id: string): ConfigFiles {
  const cfg = db.get_claude_config(s.db(), id);
  if (!cfg) throw ApiError.not_found("Claude config");
  return db.is_codex(cfg)
    ? { dir: expand_tilde(db.dir(cfg)), entries: CODEX_CONFIG_ENTRIES, login: "auth.json" }
    : { dir: config_path(cfg.config_dir), entries: CLAUDE_CONFIG_ENTRIES, login: ".credentials.json" };
}

/** A profile's default config directory. */
function profile_config_files(s: AppState, profile_id: string): ConfigFiles {
  const p = db.get_profile(s.db(), profile_id);
  if (!p) throw ApiError.not_found("profile");
  return { dir: config_path(p.claude_config_dir), entries: CLAUDE_CONFIG_ENTRIES, login: ".credentials.json" };
}

export async function export_claude_config(s: AppState, r: Req) {
  devices.board_only(r.device, "export Claude logins");
  return await export_config(claude_config_files(s, r.params.id));
}

export async function import_claude_config(s: AppState, r: Req) {
  devices.board_only(r.device, "import Claude logins");
  const cf = claude_config_files(s, r.params.id);
  return await import_config(cf, import_body(r));
}

export async function export_profile_config(s: AppState, r: Req) {
  devices.board_only(r.device, "export Claude logins");
  return await export_config(profile_config_files(s, r.params.id));
}

export async function import_profile_config(s: AppState, r: Req) {
  devices.board_only(r.device, "import Claude logins");
  const cf = profile_config_files(s, r.params.id);
  return await import_config(cf, import_body(r));
}

/** Runs tar with `args`, feeding it `input`: (exit code, stdout, stderr). */
function tar(args: string[], input: Buffer | null): Promise<{ ok: boolean; stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("tar", args, { stdio: [input ? "pipe" : "ignore", "pipe", "pipe"] });
    const out: Buffer[] = [], err: Buffer[] = [];
    child.stdout!.on("data", (d: Buffer) => out.push(d));
    child.stderr!.on("data", (d: Buffer) => err.push(d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ ok: code === 0, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString("utf8") }));
    if (input) {
      child.stdin!.on("error", () => {});
      child.stdin!.end(input);
    }
  });
}

async function export_config(cf: ConfigFiles) {
  const dir = cf.dir;
  const files = cf.entries.filter((e) => existsSync(join(dir, e)));
  if (!files.length) throw ApiError.bad(`nothing to copy in ${dir}`);
  let out;
  try {
    out = await tar(["czf", "-", "-C", dir, ...files], null);
  } catch (e) {
    throw ApiError.bad(`tar: ${err_str(e)}`);
  }
  if (!out.ok) throw ApiError.bad(`tar failed: ${out.stderr}`);
  return { archive: out.stdout.toString("base64"), files, bytes: out.stdout.length };
}

interface ImportConfig {
  archive: string;
  overwrite: boolean;
}

function import_body(r: Req): ImportConfig {
  const b = json_map(r);
  return { archive: req_str(b, "archive"), overwrite: def_bool(b, "overwrite") };
}

/** Standard base64 with padding, as the Rust server's decoder takes it (Node's is lenient). */
export function decode_base64(s: string): Buffer {
  if (s.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(s)) throw new Error("Invalid input length or symbol");
  return Buffer.from(s, "base64");
}

async function import_config(cf: ConfigFiles, b: ImportConfig) {
  const dir = cf.dir;
  if (existsSync(join(dir, cf.login)) && !b.overwrite) throw ApiError.conflict(`${dir} already has a login; choose overwrite to replace it`);
  let bytes: Buffer;
  try {
    bytes = decode_base64(b.archive.trim());
  } catch (e) {
    throw ApiError.bad(`bad archive: ${err_str(e)}`);
  }
  mkdirSync(dir, { recursive: true });
  try {
    chmodSync(dir, 0o700);
  } catch {}
  let out;
  try {
    out = await tar(["xzf", "-", "-C", dir], bytes);
  } catch (e) {
    throw ApiError.bad(`tar: ${err_str(e)}`);
  }
  if (!out.ok) throw ApiError.bad(`tar failed: ${out.stderr}`);
  return { ok: true, dir: path_str(dir) };
}
