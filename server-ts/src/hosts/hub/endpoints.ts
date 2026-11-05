// Port of server/src/hosts/hub/endpoints.rs: the hub's HTTP endpoints: the proxy to each host, the hosts list, joining,
// and the UI's events.
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { WebSocket, WebSocketServer } from "ws";
import * as db from "../../db.ts";
import { ApiError, Reply, type Req } from "../../http.ts";
import type { AppState } from "../../state.ts";
import * as api from "../../api.ts";
import { err_str } from "../../util.ts";
import * as admin from "../../update/admin.ts";
import * as runs from "../../agent/runs.ts";
import { API_COMPAT, API_VERSION, BUILD_ID, VERSION } from "../proto.ts";
import * as relay from "../relay.ts";
import * as broker from "../broker.ts";
import * as ssh from "../ssh.ts";
import { changed, http_call, misplaced, spawn_outbound } from "../hub.ts";

/** A JSON answer, whatever the JSON value (a string too, which a `Reply` would send as text). */
function json_reply(status: number, body: any): Reply {
  return new Reply(status, Buffer.from(JSON.stringify(body ?? null)), { "content-type": "application/json" });
}

/** `/api/h/{host_id}/{*rest}`: the UI's way of talking to any host. (Its websockets come to `proxy_ws`.) */
export async function proxy(s: AppState, r: Req): Promise<Reply> {
  const host_id = r.params.host_id;
  // The rest of the path as it came, not decoded: it's passed on as it is.
  const m = r.path.match(/^(?:\/api)?\/h\/[^/]+\/(.*)$/);
  const rest = m ? m[1] : (r.params.rest ?? "");
  const method = r.method;
  const path = host_path(rest, r.query_string);
  const bytes = r.raw;
  // A task the user moves to another column doesn't push them a notification of it (see integrations/push.ts).
  if (method === "PATCH" && rest.startsWith("tasks/") && !rest.slice(6).includes("/")) {
    const id = rest.slice(6);
    let status: any;
    try {
      status = JSON.parse(bytes.toString("utf8"))?.status;
    } catch {}
    if (typeof status === "string") s.push.note_move(host_id, id, status);
  }
  let result: [number, any];
  try {
    if (host_id === s.host_id) {
      result = await api.local_request(s, method, path, bytes.length ? bytes : null);
    } else {
      const link = s.links.get(host_id);
      if (!link) {
        let name = host_id;
        try {
          name = db.get_link(s.db(), host_id)?.name ?? host_id;
        } catch {}
        return json_reply(503, { error: `host ${name} is offline` });
      }
      // Not one that came another way than an assistant host is linked (register refuses those, so this is one that's
      // become an assistant host, or whose link changed, since): the user's requests aren't for it.
      const why = misplaced(s, link);
      if (why !== null) return json_reply(503, { error: why });
      let body: any = null;
      if (bytes.length) {
        try {
          body = JSON.parse(bytes.toString("utf8"));
        } catch {
          body = null;
        }
      }
      result = await link.request(method, path, body);
    }
  } catch (e) {
    return json_reply(502, { error: err_str(e) });
  }
  const [status, body] = result;
  // Hosts from before the JSON 404 answer an unknown route (or method) with an empty 404 or 405.
  if ((status === 404 || status === 405) && typeof body === "string") return json_reply(status, api.no_route_error(method, path));
  return json_reply(status >= 100 && status < 600 ? status : 502, body);
}

/**
 * The path a proxied request takes on its host. A client may authenticate to us with `?token=`; that token is ours,
 * not the host's, so it isn't passed on (a linked host gets the link's token).
 */
export function host_path(rest: string, query: string | null): string {
  const q = (query ?? "").split("&").filter((kv) => kv && !kv.startsWith("token="));
  return q.length ? `/api/${rest}?${q.join("&")}` : `/api/${rest}`;
}

/** Answer an upgrade request with an error, without upgrading. */
function refuse(socket: Duplex, status: number, text: string, body: any) {
  const payload = JSON.stringify(body);
  socket.end(`HTTP/1.1 ${status} ${text}\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(payload)}\r\nconnection: close\r\n\r\n${payload}`);
}

/**
 * A websocket for a linked host (a terminal), relayed to it. (One for this host is handled by `main.ts`, by our own
 * routes.)
 */
export async function proxy_ws(s: AppState, host_id: string, rest: string, query: string, req: IncomingMessage, socket: Duplex, head: Buffer, wss: WebSocketServer) {
  const path = host_path(rest, query);
  const link = s.links.get(host_id);
  if (!link) return refuse(socket, 503, "Service Unavailable", { error: "host is offline" });
  const why = misplaced(s, link);
  if (why !== null) return refuse(socket, 503, "Service Unavailable", { error: why });
  let pipe: relay.Pipe;
  try {
    pipe = await link.open_ws(path);
  } catch (e) {
    return refuse(socket, 502, "Bad Gateway", { error: err_str(e) });
  }
  wss.handleUpgrade(req, socket, head, (ws) => relay.bridge(ws, pipe));
}

/** This host plus every linked host, with live status. */
export function list_hosts(s: AppState) {
  const out: any[] = [
    {
      id: s.host_id,
      name: s.host_name,
      local: true,
      connected: true,
      mode: "local",
      version: VERSION,
      build_id: BUILD_ID,
      api_version: API_VERSION,
      api_compat: API_COMPAT,
      commit: s.meta.running_commit,
      updates_from: admin.updates_from(s.meta),
      agents: runs.can_run_agents(s),
    },
  ];
  for (const l of db.list_links(s.db())) {
    const live = s.links.get(l.id);
    const v: any = { ...l };
    delete v.token;
    v.local = false;
    v.connected = !!live && s.push.link_ready(live);
    if (live) {
      v.mode = live.mode;
      const ver = live.version;
      v.version = ver.version;
      v.api_version = ver.api_version;
      v.api_compat = ver.api_compat;
      v.commit = ver.commit;
      v.agents = ver.agents;
      v.updates_from = ver.updates_from;
      // Pings keep this recent on a live link: a while ago means the link is about to be dropped.
      v.last_message_at = live.last_message_at();
    }
    const t = ssh.parse_target(l.ssh);
    if (t) v.url = `ssh://${t.target}`;
    delete v.ssh;
    out.push(v);
  }
  return out;
}

/** Link a host we can reach directly. */
export async function add_host(s: AppState, r: Req) {
  const b = r.body ?? {};
  if (typeof b.url !== "string" || typeof b.token !== "string") throw new ApiError(422, "Failed to deserialize the JSON body into the target type: missing field `url` or `token`");
  const url = b.url.trim().replace(/\/+$/, "");
  const token = b.token.trim();
  let endpoint: string;
  try {
    endpoint = await broker.resolve(url, null);
  } catch (e) {
    throw ApiError.bad(`can't resolve ${url}: ${err_str(e)}`);
  }
  let res;
  try {
    res = await http_call("GET", `${endpoint}/api/info`, token, null, 10_000);
  } catch (e) {
    throw ApiError.bad(`can't reach ${url}: ${err_str(e)}`);
  }
  if (res.status >= 400) throw ApiError.bad(`${url} refused the token: HTTP status ${res.status} for url (${endpoint}/api/info)`);
  let info: any;
  try {
    info = JSON.parse(res.text);
  } catch (e) {
    throw ApiError.bad(`${url} isn't a Huntaway host: ${err_str(e)}`);
  }
  const host_id = info?.host_id;
  if (typeof host_id !== "string") throw ApiError.bad(`${url} is too old to be linked (no host_id)`);
  if (host_id === s.host_id) throw ApiError.bad("that's this host");
  const name = typeof info.host_name === "string" ? info.host_name : host_id;
  const link = db.upsert_link(s.db(), host_id, name, "outbound", url, token);
  spawn_outbound(s, link);
  changed(s);
  return link;
}

/** Rename a linked host, or let its agents use this board (or not). */
export function change_host(s: AppState, r: Req) {
  const b = r.body && typeof r.body === "object" && !Array.isArray(r.body) ? r.body : {};
  const bad = (field: string, kind: string) => new ApiError(422, `Failed to deserialize the JSON body into the target type: ${field}: invalid type, expected ${kind}`);
  if (b.name != null && typeof b.name !== "string") throw bad("name", "a string");
  /** Whether its agents may use this board's tools, up the link (API 112, see hosts/uplink.ts). */
  if (b.uplink != null && typeof b.uplink !== "boolean") throw bad("uplink", "a boolean");
  const id = r.params.id;
  const c = s.db();
  if (!db.get_link(c, id)) throw ApiError.not_found("host");
  const name = typeof b.name === "string" ? b.name.trim() : "";
  if (name) db.run(c, "UPDATE links SET name=?1 WHERE id=?2", name, id);
  if (typeof b.uplink === "boolean") db.run(c, "UPDATE links SET uplink=?1 WHERE id=?2", b.uplink ? 1 : 0, id);
  changed(s);
  return { ok: true };
}

/** Forget a link. Its data stays on that host. */
export function remove_host(s: AppState, r: Req) {
  const id = r.params.id;
  db.run(s.db(), "DELETE FROM links WHERE id=?1", id);
  // Profiles whose assistants ran there have them here again.
  if (db.run(s.db(), "UPDATE profiles SET assistant_host=NULL WHERE assistant_host=?1", id).changes > 0) s.emit({ type: "profiles_changed" });
  const t = s.link_tasks.get(id);
  if (t) {
    s.link_tasks.delete(id);
    t();
  }
  s.links.delete(id);
  changed(s);
  return { ok: true };
}

/** What a host needs to dial in to this hub. */
export function join_info(s: AppState, r: Req) {
  return {
    hub_token: s.hub_token,
    host_token: s.token,
    command: `huntaway serve --hub ${hub_url(s, r.headers)} --hub-token ${s.hub_token}`,
  };
}

/** The URL hosts dial this hub at, as the browser asking reaches it. */
export function hub_url(s: AppState, headers: IncomingHttpHeaders | Record<string, any>): string {
  // Through a broker, whose request comes from loopback without the client's Host: at the broker.
  if (headers[broker.VIA_BROKER] !== undefined && s.broker_url) return s.broker_url;
  const header = (name: string): string | null => {
    const v = headers[name];
    const t = (Array.isArray(v) ? v[0] : v)?.split(",")[0]?.trim();
    return t ? t : null;
  };
  // Behind a TLS proxy (Caddy sets X-Forwarded-Proto), hosts must dial https: they don't follow redirects.
  const scheme = header("x-forwarded-proto") === "https" ? "https" : "http";
  const host = header("x-forwarded-host") ?? header("host") ?? "this-hub:7878";
  return `${scheme}://${host}`;
}

/** Merged events from every host, for the UI. */
export function ws(s: AppState, _r: Req, socket: WebSocket) {
  socket.send(JSON.stringify({ type: "hello", host_id: s.host_id }));
  let lagged = false;
  const off = s.hub_events.subscribe((v) => {
    if (socket.readyState !== socket.OPEN) return;
    // A UI that can't keep up misses events, and is told to reload once it has caught up, as a lagging broadcast
    // receiver is.
    if (socket.bufferedAmount > 64 << 20) return void (lagged = true);
    if (lagged) {
      lagged = false;
      socket.send(JSON.stringify({ type: "resync" }));
    }
    socket.send(JSON.stringify(v));
  });
  socket.on("close", off);
  socket.on("error", off);
}
