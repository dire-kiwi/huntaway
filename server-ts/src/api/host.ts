// Port of server/src/api/host.rs: host-wide routes: settings, the agents' MCP endpoints, server admin and updates, and
// the folder browser.
import { existsSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import * as db from "../db.ts";
import { ApiError, Reply, type Req } from "../http.ts";
import type { AppState } from "../state.ts";
import { err_str, expand_tilde, home_dir, path_str } from "../util.ts";
import * as focus from "../agent/focus.ts";
import * as terminal from "../hosts/terminal.ts";
import * as tools from "../mcp/tools.ts";
import * as mcp_http from "../mcp/http.ts";
import { authorized } from "../api.ts";
import * as merge_gate from "../review/merge_gate.ts";
import * as admin from "../update/admin.ts";
import * as release from "../update/release.ts";
import * as threads from "../threads/write.ts";
import * as thread_batch from "../threads/batch.ts";
import { debug_list, def_bool, def_str, def_value, json_map, opt_str, req_str } from "./extract.ts";

export async function get_settings(s: AppState) {
  const c = s.db();
  return {
    default_model: db.get_setting(c, "default_model"),
    default_effort: db.get_setting(c, "default_effort"),
    default_permission_mode: db.get_setting(c, "default_permission_mode"),
    scratch_host: db.get_setting(c, "scratch_host"),
    terminal_tools: terminal.tools(c),
    public_url: db.get_setting(c, "public_url"),
    now_expiry_hours: focus.expiry_hours(c),
    release_prereleases: db.get_setting(c, release.PRERELEASES) === "true",
    thread_items: threads.setting_on(c),
  };
}

const STRING_SETTINGS = ["default_model", "default_effort", "default_permission_mode", "scratch_host", "public_url"];

/**
 * Agent defaults for this host: the model and permission mode (when nothing more specific is set) and effort. Also,
 * for a board that can't run agents itself, the linked host its workspace scratch chats go to (`scratch_host`, a link
 * id). And the TUI programs offered as shortcuts in task terminals (`terminal_tools`, a list of `{id?, name,
 * command}`). And the address it's reached at from outside (`public_url`, API 63), which its automations' webhook URLs
 * are shown with. And whether release checks include prereleases (`release_prereleases`, API 88), which checks again
 * when it changes. And how many hours a task can go without activity in the board's Now view before it goes back to
 * Later (`now_expiry_hours`, API 97; 0 for never, null for the default of a day). And whether tasks started from now
 * on keep their threads as items as well as messages (`thread_items`, API 116; on by default since API 120, so null
 * is on; see threads/write.ts).
 */
export async function update_settings(s: AppState, r: Req) {
  const b = { ...json_map(r) };
  // Null (or blank) clears a setting; a value of another type is a mistake, not a clearing.
  for (const key of STRING_SETTINGS) {
    if (Object.hasOwn(b, key) && !(b[key] === null || typeof b[key] === "string")) throw ApiError.bad(`${key} must be a string or null`);
  }
  const e = b.default_effort;
  if (typeof e === "string" && e && !db.EFFORTS.includes(e)) throw ApiError.bad(`default_effort must be one of ${debug_list(db.EFFORTS)}`);
  const m = b.default_permission_mode;
  if (typeof m === "string" && m && !db.PERMISSION_MODES.includes(m)) throw ApiError.bad(`default_permission_mode must be one of ${debug_list(db.PERMISSION_MODES)}`);
  const h = b.scratch_host;
  if (typeof h === "string" && h && !db.get_link(s.db(), h)) throw ApiError.bad("scratch_host must be a linked host");
  if (Object.hasOwn(b, "public_url") && b.public_url !== null) {
    if (typeof b.public_url !== "string") throw ApiError.bad("public_url must be a string");
    const url = b.public_url.trim().replace(/\/+$/, "");
    if ((url && !(url.startsWith("https://") || url.startsWith("http://"))) || /\s/u.test(url) || Buffer.byteLength(url) > 500) {
      throw ApiError.bad("public_url must be an http(s) URL, like https://board.example.com");
    }
    b.public_url = url;
  }
  let now_expiry: number | null | undefined = undefined;
  if (Object.hasOwn(b, "now_expiry_hours")) {
    const v = b.now_expiry_hours;
    if (v === null) now_expiry = null;
    else if (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= focus.MAX_EXPIRY_HOURS) now_expiry = v;
    else throw ApiError.bad(`now_expiry_hours must be a whole number of hours, 0 to ${focus.MAX_EXPIRY_HOURS}, or null`);
  }
  let prereleases: boolean | null = null;
  if (Object.hasOwn(b, release.PRERELEASES)) {
    const v = b[release.PRERELEASES];
    if (!(v === null || typeof v === "boolean")) throw ApiError.bad("release_prereleases must be true, false or null");
    prereleases = v === true;
  }
  // Null is the default, which is on (since API 120).
  let thread_items: boolean | null | undefined;
  if (Object.hasOwn(b, threads.SETTING)) {
    const v = b[threads.SETTING];
    if (!(v === null || typeof v === "boolean")) throw ApiError.bad("thread_items must be true, false or null");
    thread_items = v;
  }
  let terminal_tools: any[] | null = null;
  if (b.terminal_tools != null) {
    try {
      terminal_tools = terminal.parse_tools(b.terminal_tools);
    } catch (e) {
      throw ApiError.bad(err_str(e));
    }
  }
  for (const key of STRING_SETTINGS) {
    if (Object.hasOwn(b, key)) db.set_setting(s.db(), key, typeof b[key] === "string" ? b[key] : null);
  }
  if (now_expiry !== undefined) db.set_setting(s.db(), focus.EXPIRY_SETTING, now_expiry === null ? null : String(now_expiry));
  if (thread_items !== undefined) db.set_setting(s.db(), threads.SETTING, thread_items === false ? "false" : null);
  if (terminal_tools !== null) db.set_setting(s.db(), "terminal_tools", terminal_tools.length ? JSON.stringify(terminal_tools) : null);
  if (prereleases !== null && release.prereleases(s) !== prereleases) {
    db.set_setting(s.db(), release.PRERELEASES, prereleases ? "true" : null);
    release.check_soon(s);
  }
  s.emit({ type: "settings_changed" });
  return await get_settings(s);
}

// ---------- agent tools ----------

/**
 * From an agent's MCP helper, or a Codex run's adapter; may block (permission prompts) until the user answers. It takes
 * the host's token, or the run's own secret (see mcp/http.ts), which only acts as that run.
 */
export async function internal_mcp(s: AppState, r: Req) {
  const run_id = typeof r.body?.run_id === "string" ? r.body.run_id : "";
  if (!authorized(s, r.headers, r.query_string) && !(run_id && mcp_http.run_authorized(s, run_id, r.headers))) throw new ApiError(401, "unauthorized");
  const b = json_map(r);
  const call = { run_id: req_str(b, "run_id"), call_id: req_str(b, "call_id"), tool: req_str(b, "tool"), args: def_value(b, "args"), task_fields: def_bool(b, "task_fields") };
  try {
    return { result: await tools.handle_mcp(s, call) };
  } catch (e) {
    return { error: err_str(e) };
  }
}

/** From a run's gh server, before it merges a pull request: why it can't, if it can't (see review/merge_gate.rs). */
export async function internal_merge_gate(s: AppState, r: Req) {
  const c = s.db();
  const run = db.get_run(c, r.params.run_id);
  if (!run) throw ApiError.not_found("run");
  const task = db.get_task(c, run.task_id);
  const blocked = task ? merge_gate.blocked(c, task) : null;
  return { blocked: blocked ?? null };
}

/** A board tool forwarded from an agent on another host. */
export async function remote_tool(s: AppState, r: Req) {
  const b = json_map(r);
  const profile = req_str(b, "profile");
  const args = def_value(b, "args");
  // Original helper capability, absent on hosts before paginated task fields.
  const task_fields = def_bool(b, "task_fields");
  try {
    return { result: await tools.handle_remote(s, r.params.tool, profile, args, task_fields) };
  } catch (e) {
    return new Reply(400, { error: err_str(e) });
  }
}

// ---------- server admin ----------

export async function server_status(s: AppState) {
  return await admin.status(s);
}

export async function restart_server(s: AppState, r: Req) {
  const rebuild = def_bool(json_map(r), "rebuild", true);
  admin.start(s, rebuild);
  return { ok: true };
}

/** Check for releases now (with `--release-updates`), and return the server's status after. */
export async function check_releases(s: AppState) {
  if (s.meta.release == null) throw ApiError.bad("this server doesn't check for releases (start it with --release-updates OWNER/REPO)");
  await release.check(s);
  return await admin.status(s);
}

/** Restart onto a release (staged, or downloaded first), as a restart job. */
export async function update_to_release(s: AppState, r: Req) {
  const version = req_str(json_map(r), "version");
  release.update(s, version);
  return { ok: true };
}

/** Mark the running release bad and restart onto the one before it, as a restart job. */
export async function roll_back_release(s: AppState) {
  release.rollback(s);
  return { ok: true };
}

/**
 * `GET /admin/threads` (API 120): `{pending, batch}`, how many tasks the batch rebuild of threads as items would rebuild
 * now (those that aren't done whose threads aren't kept as items by this build), and the batch's progress (null if it
 * hasn't run since the server started). See threads/batch.ts.
 */
export async function threads_status(s: AppState) {
  return thread_batch.status(s);
}

/** `POST /admin/threads/batch` (API 120): starts the batch rebuild (or goes on with it); `{"stop": true}` stops it after the task it's on. */
export async function threads_batch(s: AppState, r: Req) {
  if (def_bool(json_map(r), "stop", false)) thread_batch.stop(s);
  else thread_batch.start(s);
  return thread_batch.status(s);
}

/** Copy the older builds' database into this build's again, as a restart job (API 108; see db/file.ts). */
export async function recopy_database(s: AppState) {
  admin.recopy_database(s);
  return { ok: true };
}

/** A hub asking this host to update to its commit, or a release install to its version. */
export async function update_from_hub(s: AppState, r: Req) {
  const b = json_map(r);
  // `commit` is missing from a hub that runs a release, which only release hosts can update from. With a `bundle` (a hub
  // that has a checkout), update from it; otherwise fetch the commit from this host's own `origin` (API 3+). `version`
  // is the hub's (API 89), which a release install updates to instead.
  const commit = def_str(b, "commit");
  const bundle = opt_str(b, "bundle");
  const branch = opt_str(b, "branch");
  const version = opt_str(b, "version");
  if (admin.updates_from(s.meta) === "releases") {
    if (version === null) throw ApiError.bad("this host updates from releases, and the board didn't say which version it runs (it needs API 89)");
    return await release.update_from_hub(s, version);
  }
  if (!commit) throw ApiError.bad("the board runs a release rather than a checkout, so it can't say which commit to update this host to");
  if (bundle !== null && branch !== null) return await admin.update_from_bundle(s, branch, commit, bundle);
  return await admin.update_from_origin(s, commit);
}

// ---------- filesystem browser (for picking repos remotely) ----------

const is_dir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** Rust's `Path::parent`, as `path_str` writes it. */
function parent_of(p: string): string | null {
  const trimmed = p.length > 1 ? p.replace(/\/+$/, "") : p;
  if (trimmed === "/" || trimmed === "") return null;
  const i = trimmed.lastIndexOf("/");
  if (i < 0) return "";
  return i === 0 ? "/" : trimmed.slice(0, i).replace(/\/+$/, "") || "/";
}

export async function fs_dirs(_s: AppState, r: Req) {
  const q = r.query.path;
  const path = q && q.trim() ? expand_tilde(q) : (home_dir() ?? "/");
  // A missing folder is listed as empty, so the picker can offer to create it.
  if (!existsSync(path) && isAbsolute(path)) {
    return { path: path_str(path), parent: parent_of(path), exists: false, is_git: false, entries: [] };
  }
  let names: string[];
  try {
    names = readdirSync(path);
  } catch (e) {
    throw ApiError.bad(`${path}: ${err_str(e)}`);
  }
  const entries: Array<{ name: string; path: string; is_git: boolean; hidden: boolean }> = [];
  for (const name of names) {
    const p = join(path, name);
    // Hidden folders are included (flagged) so the picker can complete them.
    if (is_dir(p)) entries.push({ name, path: path_str(p), is_git: existsSync(join(p, ".git")), hidden: name.startsWith(".") });
  }
  const key = (e: { name: string }) => e.name.toLowerCase();
  entries.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  return { path: path_str(path), parent: parent_of(path), exists: true, is_git: existsSync(join(path, ".git")), entries };
}
