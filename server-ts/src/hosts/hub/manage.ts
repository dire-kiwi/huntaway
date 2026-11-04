// Port of server/src/hosts/hub/manage.rs: managing hosts: copying Claude config between them, updating them, and adding
// hosts over SSH.
import { ApiError, type Req } from "../../http.ts";
import type { AppState } from "../../state.ts";
import * as api from "../../api.ts";
import { err_str } from "../../util.ts";
import * as admin from "../../update/admin.ts";
import { VERSION } from "../proto.ts";
import * as ssh from "../ssh.ts";
import * as db from "../../db.ts";
import { changed, spawn_outbound } from "../hub.ts";

/** Call any host's API (this one or a linked one). */
export async function host_request(s: AppState, host_id: string, method: string, path: string, body: any = null): Promise<any> {
  let status: number, out: any;
  if (host_id === s.host_id) {
    [status, out] = await api.local_request(s, method, path, body === null || body === undefined ? null : Buffer.from(JSON.stringify(body)));
  } else {
    const link = s.links.get(host_id);
    if (!link) throw ApiError.conflict(`host ${host_id} is offline`);
    [status, out] = await link.request(method, path, body);
  }
  if (!(status >= 200 && status < 300)) {
    const e = out && typeof out === "object" && typeof out.error === "string" ? (out.error as string) : null;
    let msg: string;
    // No such route (a bare 404 from older hosts) means the host's build predates this endpoint.
    if ((status === 404 || status === 405) && (e === null || e.startsWith(api.NO_ROUTE))) msg = "this host's version doesn't support that yet; update it";
    else if (e !== null) msg = e;
    else msg = JSON.stringify(out);
    throw new ApiError(status >= 100 && status < 600 ? status : 502, msg);
  }
  return out;
}

async function named(s: AppState, host_id: string, list: string, name: string): Promise<any | null> {
  const items = await host_request(s, host_id, "GET", list);
  return (Array.isArray(items) ? items : []).find((p: any) => p?.name === name) ?? null;
}

/** Copy a Claude config's login and settings from one host to another, creating the config on the target if needed. */
export async function copy_claude_config(s: AppState, r: Req) {
  const b = r.body ?? {};
  for (const k of ["from_host", "to_host"]) {
    if (typeof b[k] !== "string") throw new ApiError(422, `Failed to deserialize the JSON body into the target type: missing field \`${k}\``);
  }
  if (b.from_host === b.to_host) throw ApiError.bad("pick two different hosts");
  const dir = (source: any, key: string) =>
    typeof b.config_dir === "string" && b.config_dir.trim() ? b.config_dir : typeof source?.[key] === "string" ? source[key] : "";
  let from: string, to: string;
  if (typeof b.config === "string") {
    const name = b.config;
    const source = await named(s, b.from_host, "/api/claude-configs", name);
    if (!source) throw ApiError.not_found("Claude config on the source host");
    let target = await named(s, b.to_host, "/api/claude-configs", name);
    if (!target) {
      const body = { name, config_dir: dir(source, "config_dir"), agent: source.agent ?? null };
      target = await host_request(s, b.to_host, "POST", "/api/claude-configs", body);
    }
    const path = (c: any) => `/api/claude-configs/${typeof c?.id === "string" ? c.id : ""}/archive`;
    [from, to] = [path(source), path(target)];
  } else if (typeof b.profile === "string") {
    const name = b.profile;
    const source = await named(s, b.from_host, "/api/profiles", name);
    if (!source) throw ApiError.not_found("profile on the source host");
    let target = await named(s, b.to_host, "/api/profiles", name);
    if (!target) {
      const body = { name, claude_config_dir: dir(source, "claude_config_dir"), default_model: source.default_model ?? null };
      target = await host_request(s, b.to_host, "POST", "/api/profiles", body);
    }
    const path = (p: any) => `/api/profiles/${typeof p?.id === "string" ? p.id : ""}/claude-config`;
    [from, to] = [path(source), path(target)];
  } else {
    throw ApiError.bad("config (or profile) is required");
  }
  const archive = await host_request(s, b.from_host, "GET", from);
  const result = await host_request(s, b.to_host, "POST", to, { archive: archive?.archive ?? null, overwrite: b.overwrite === true });
  return { ok: true, files: archive?.files ?? null, target: result };
}

/**
 * Send this hub's code to a linked host, which fast-forwards its checkout and restarts. A host installed from a release
 * (API 89) goes by the version instead, and updates to that release.
 */
export async function update_host(s: AppState, r: Req) {
  const id = r.params.id;
  if (id === s.host_id) throw ApiError.bad("use Rebuild & restart for this host");
  // A hub with a checkout sends its code; one deployed without (a container) sends its commit and the host fetches it
  // from its own origin.
  let body: any;
  if (s.meta.source_dir !== null) body = await admin.bundle(s);
  else if (s.meta.running_commit !== null) body = { commit: s.meta.running_commit };
  // A release install knows its version but not its commit, which only a release host can go by.
  else if (admin.updates_from(s.meta) === "releases") body = {};
  else throw ApiError.bad("this hub doesn't know which commit it runs (set IA_COMMIT)");
  body.version = VERSION;
  return await host_request(s, id, "POST", "/api/admin/update", body);
}

// ---------- hosts over SSH ----------

/** The hub's SSH public key, for the target's authorized_keys. */
export async function ssh_key(s: AppState) {
  return { public_key: await ssh.public_key(s) };
}

/** Link a host over SSH: starts it on the target if needed, then keeps a tunnel to it. */
export async function add_ssh_host(s: AppState, r: Req) {
  let t: ssh.Target;
  try {
    t = ssh.Target_from_json(r.body);
  } catch (e) {
    throw new ApiError(422, `Failed to deserialize the JSON body into the target type: ${err_str(e)}`);
  }
  t = { ...t, target: t.target.trim() };
  if (!t.target.includes("@")) throw ApiError.bad("enter the target as user@host");
  let details: any;
  try {
    details = await ssh.ensure(s, t);
  } catch (e) {
    throw ApiError.bad(err_str(e));
  }
  const info = details?.info;
  const host_id = typeof info?.host_id === "string" ? (info.host_id as string) : null;
  if (host_id === null) throw ApiError.bad("the host didn't report an id");
  if (host_id === s.host_id) throw ApiError.bad("that's this host");
  const name = typeof info.host_name === "string" ? (info.host_name as string) : host_id;
  let link = db.upsert_link(s.db(), host_id, name, "ssh", null, typeof details.token === "string" ? details.token : null);
  db.run(s.db(), "UPDATE links SET ssh=?1 WHERE id=?2", JSON.stringify(t), host_id);
  link = db.get_link(s.db(), host_id) ?? link;
  spawn_outbound(s, link);
  changed(s);
  return { id: link.id, name: link.name, started: details.started ?? null };
}
