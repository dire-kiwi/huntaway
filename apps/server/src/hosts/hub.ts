// Port of server/src/hosts/hub.rs: the hub side of a node: one board over this host and any linked hosts.
//
// Every host keeps its own database; nothing about another host is stored here beyond how to reach it. The UI
// addresses a host as `/api/h/<host_id>/...`, which runs against this node's own API (for the local host) or is
// relayed over a link:
//
// * outbound: we call the host's URL with its token, and follow its `/api/host/ws` events;
// * inbound: the host dials `/api/hub/connect` (`serve --hub`), and requests are tunnelled back over that websocket.
//
// Events from every host reach the UI on `/api/ws`, tagged with `host_id`.
import * as http from "node:http";
import * as https from "node:https";
import * as db from "../db.ts";
import type { Link } from "../db.ts";
import type { AppState } from "../state.ts";
import * as api from "../api.ts";
import { background, context, err_str } from "../util.ts";
import * as relay from "./relay.ts";
import { Chan, type Frame, type Pipe } from "./relay.ts";
import * as broker from "./broker.ts";
import * as ssh from "./ssh.ts";
import { ToolCall_from, type ToolAnswer, type ToolCall } from "./proto.ts";
import * as uplink from "./uplink.ts";
import * as tools from "../mcp/tools.ts";

export * from "./hub/inbound.ts";
export * from "./hub/dial_out.ts";
export * from "./hub/endpoints.ts";
export * from "./hub/manage.ts";

/** Hub → host (proto.rs's `Down`), tagged by `t`. */
export type Down =
  | { t: "req"; id: number; method: string; path: string; body: any }
  | { t: "ws_open"; id: number; path: string }
  | { t: "ws_msg"; id: number; text: string | null; data: string | null }
  | { t: "ws_close"; id: number }
  | { t: "ping" }
  /**
   * Who the hub is, sent once the tunnel is up (API 112). A host may then pass it board tool calls (`tool_call`). Older
   * hosts ignore it.
   */
  | { t: "hello"; hub_id: string; name: string; api_version: number }
  /** The answer to `Up`'s `tool_call`. */
  | ({ t: "tool_answer" } & ToolAnswer);

/** Host → hub (proto.rs's `Up`), tagged by `t`. */
export type Up =
  | { t: "hello"; host_id: string; name: string; version: string; protocol: number; api_version: number; api_compat: number }
  | { t: "res"; id: number; status: number; body: any }
  | { t: "event"; event: any }
  | { t: "ws_msg"; id: number; text: string | null; data: string | null }
  | { t: "ws_close"; id: number; code: number | null; reason: string | null }
  | { t: "pong" }
  /** A board tool call from one of our agents that we couldn't resolve here, for the hub to run (API 112). Sent only to a hub that said `hello`. */
  | ({ t: "tool_call" } & ToolCall);

export interface Version {
  version: string;
  api_version: number;
  api_compat: number;
  /** Commit the host is running, if it runs from a checkout. */
  commit: string | null;
  /** Whether it can run agents (hosts that don't say are assumed to). */
  agents: boolean;
  /** How an Update reaches it (API 89): `checkout` or `releases`, or none. */
  updates_from: string | null;
}

export function Version_default(): Version {
  return { version: "", api_version: 0, api_compat: 0, commit: null, agents: false, updates_from: null };
}

export function Version_from_info(info: any): Version {
  const str = (v: any) => (typeof v === "string" ? v : null);
  const num = (v: any) => (typeof v === "number" && v >= 0 ? Math.floor(v) : 0);
  return {
    version: str(info?.version) ?? "",
    api_version: num(info?.api_version),
    api_compat: num(info?.api_compat),
    commit: str(info?.commit),
    agents: typeof info?.agents === "boolean" ? info.agents : true,
    updates_from: str(info?.updates_from),
  };
}

type Kind =
  /**
   * With an agent of its own, so its connections go with it: a connection that died without closing would otherwise
   * be kept for the next one, and hold up its requests.
   */
  | { type: "http"; url: string; token: string; agent: http.Agent }
  | {
      type: "tunnel";
      /** Sends to the host; false once the tunnel is gone. */
      tx: (d: Down) => boolean;
      pending: Map<number, (r: [number, any] | null) => void>;
      /** Websockets relayed over the tunnel, by id. */
      streams: Map<number, Chan<Frame>>;
      next: number;
    };

/** A live connection to a linked host. */
export class LinkConn {
  id: string;
  name: string;
  mode: string;
  /** What the host reported; 0 for builds that predate API versioning. */
  version: Version;
  /** When we last heard anything from the host (a pong counts), in Unix milliseconds. */
  private heard_at: number;
  kind: Kind;

  constructor(id: string, name: string, mode: string, version: Version, kind: Kind) {
    this.id = id;
    this.name = name;
    this.mode = mode;
    this.version = version;
    this.heard_at = Date.now();
    this.kind = kind;
  }

  heard() {
    this.heard_at = Date.now();
  }

  /** When we last heard from the host, as `util::now` formats it. */
  last_message_at(): string {
    return new Date(this.heard_at).toISOString();
  }

  /**
   * Call the host's API. `path` starts with `/api/` and may carry a query string.
   *
   * The host turning down the link's token (its own changed since it was linked: its data dir was made again, say) is
   * a 502, not its 401, which the UI takes to mean the board's own token is wrong.
   */
  async request(method: string, path: string, body: any = null): Promise<[number, any]> {
    const r = await this.send(method, path, body);
    if (r[0] === 401) return [502, { error: `host ${this.name} didn't accept this hub's token for it; link it again` }];
    return r;
  }

  private async send(method: string, path: string, body: any): Promise<[number, any]> {
    const k = this.kind;
    if (k.type === "http") {
      const url = `${k.url.replace(/\/+$/, "")}${path}`;
      let res: HttpAnswer;
      try {
        res = await http_call(method, url, k.token, body, 300_000, k.agent);
      } catch (e) {
        throw context(`host ${this.name} unreachable`, e);
      }
      // The API only answers in JSON: a page is an older host's UI, served for a route it doesn't have.
      if (is_html(res)) return [404, api.no_route_error(method, path)];
      // An older host's UI also answers a route it doesn't have with an empty 405 for methods other than GET, the same
      // as the API does for a route without this method. The UI's page for a HEAD tells them apart.
      if (res.status === 405 && !res.text) {
        const head = await http_call("HEAD", url, k.token, null, 30_000, k.agent).catch(() => null);
        if (head && is_html(head)) return [404, api.no_route_error(method, path)];
      }
      return [res.status, parse_json_or_text(res.text)];
    }
    const id = k.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        k.pending.delete(id);
        reject(new Error(`host ${this.name} did not respond in time`));
      }, 300_000);
      k.pending.set(id, (r) => {
        clearTimeout(timer);
        if (r) resolve(r);
        else reject(new Error(`host ${this.name} disconnected`));
      });
      if (!k.tx({ t: "req", id, method, path, body: body ?? null })) {
        k.pending.delete(id);
        clearTimeout(timer);
        reject(new Error(`host ${this.name} disconnected`));
      }
    });
  }

  /** Open a websocket to `path` (starting with `/api/`) on the host. */
  async open_ws(path: string): Promise<Pipe> {
    const k = this.kind;
    if (k.type === "http") {
      const url = `${k.url.replace(/\/+$/, "").replace("http", "ws")}${path}`;
      try {
        return await relay.connect(url, k.token);
      } catch (e) {
        throw context(`host ${this.name} unreachable`, e);
      }
    }
    const id = k.next++;
    const in_ch = new Chan<Frame>();
    k.streams.set(id, in_ch);
    if (!k.tx({ t: "ws_open", id, path })) {
      k.streams.delete(id);
      throw new Error(`host ${this.name} disconnected`);
    }
    const out = new Chan<Frame>();
    out.recv((f) => {
      if (f === null || f.type === "close") {
        out.close();
        k.tx({ t: "ws_close", id });
        k.streams.delete(id);
        return;
      }
      const [text, data] = relay.to_wire(f);
      if (!k.tx({ t: "ws_msg", id, text, data })) out.close();
    });
    return { tx: out, rx: in_ch };
  }
}

export type LinkHandle = LinkConn;

export interface HttpAnswer {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
}

/** A request with a bearer token and an optional JSON body, through `agent` (a link's own connections). */
export function http_call(method: string, url: string, token: string | null, body: any, timeout_ms: number, agent?: http.Agent): Promise<HttpAnswer> {
  return new Promise((resolve, reject) => {
    let u: URL;
    try {
      u = new URL(url);
    } catch (e) {
      return reject(e);
    }
    const mod = u.protocol === "https:" ? https : http;
    const headers: Record<string, string> = {};
    if (token !== null) headers.authorization = `Bearer ${token}`;
    const payload = body === null || body === undefined ? null : Buffer.from(JSON.stringify(body));
    if (payload) {
      headers["content-type"] = "application/json";
      headers["content-length"] = String(payload.length);
    }
    const req = mod.request(u, { method, headers, agent: agent as any }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        clearTimeout(timer);
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") });
      });
      res.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });
    const timer = setTimeout(() => req.destroy(new Error("operation timed out")), timeout_ms);
    req.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    req.end(payload ?? undefined);
  });
}

/** A connection pool for one connection to a host. TCP keepalive is a backstop for the pings on its events. */
function link_agent(): http.Agent {
  return new http.Agent({ keepAlive: true, keepAliveMsecs: relay.PING });
}

function is_html(res: HttpAnswer): boolean {
  const ct = res.headers["content-type"];
  return typeof ct === "string" && ct.startsWith("text/html");
}

function parse_json_or_text(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function connected_links(s: AppState): LinkConn[] {
  return [...s.links.values()];
}

/** A connected link by id or (case-insensitive) name. */
export function find_link(s: AppState, id_or_name: string): LinkConn | null {
  const l = s.links.get(id_or_name);
  if (l) return l;
  const lower = id_or_name.toLowerCase();
  for (const c of s.links.values()) if (c.name.toLowerCase() === lower) return c;
  return null;
}

/**
 * Run a board tool on a linked host (see `tools::handle_remote`). Rust's `Result<Value, String>`: the result, or an
 * Error with the host's message.
 */
export async function call_tool(_s: AppState, link: LinkConn, tool: string, profile: string, args: any, task_fields: boolean): Promise<any> {
  args = args && typeof args === "object" && !Array.isArray(args) ? { ...args } : args;
  if (args && typeof args === "object") delete args.host;
  let r: [number, any];
  try {
    r = await link.request("POST", `/api/tools/${tool}`, { profile, args, task_fields });
  } catch (e) {
    throw new Error(err_str(e));
  }
  const [status, body] = r;
  if (status === 200) return body?.result ?? null;
  throw new Error(typeof body?.error === "string" ? body.error : JSON.stringify(body));
}

/** How a linked host's connection reached us: we dialled it (by URL or over SSH), or it dialled in (`--hub`). */
export type Via = "dialled" | "tunnel";

/**
 * Whether a connection that came `via` is how `link` is linked. A host that dials in is known only by the id in its
 * hello, behind the hub token every such host shares, so a tunnel can claim the id of a host we dial: it isn't that
 * host for anything that acts for one of its profiles (up-calls, the assistant's routed requests).
 */
export function linked_via(link: Link, via: Via): boolean {
  return via === "tunnel" ? link.mode === "inbound" : link.mode === "outbound" || link.mode === "ssh";
}

/** How live connection `conn` reached us. */
export function conn_via(conn: LinkConn): Via {
  return conn.kind.type === "tunnel" ? "tunnel" : "dialled";
}

/**
 * A board tool call that linked host `host_id` passed up its link (see hosts/uplink.ts), over a connection that came
 * `via`: run only if the user lets that host's agents use this board, only if it came the way that host is linked (a
 * tunnel that took a dialled host's id isn't it), and only for the profiles whose assistants run there. The host says
 * which profile its caller is in, and whoever controls it can say any: a profile of this board's whose assistant isn't
 * there would let it act with that profile's access.
 */
export async function run_up_call(s: AppState, host_id: string, c: ToolCall, via: Via): Promise<ToolAnswer> {
  const off = (why: string | null): ToolAnswer => ({ id: c.id, result: null, error: why, off: true });
  let link: Link | null = null;
  try {
    link = db.get_link(s.db(), host_id);
  } catch {}
  if (!link?.uplink) return off(null);
  if (!linked_via(link, via)) {
    return off(`${s.host_name} links ${link.name} ${link.mode === "inbound" ? "as a host that dials in" : "itself"}, and this call came another way, so it isn't taken`);
  }
  let placed = false;
  try {
    placed = db.list_profiles(s.db()).some((p) => p.name === c.profile && p.assistant_host === host_id);
  } catch {}
  if (!placed) {
    return off(
      `${s.host_name} lets ${link.name}'s agents use its board only in the profiles whose assistant runs on ${link.name}, and ${c.profile} isn't one; ` +
        `the user can pick ${link.name} as the profile's Assistant host in Settings → Profiles there`,
    );
  }
  try {
    return { id: c.id, result: (await tools.handle_up_call(s, host_id, c)) ?? null, error: null, off: false };
  } catch (e) {
    return { id: c.id, result: null, error: err_str(e), off: false };
  }
}

export function changed(s: AppState) {
  s.hub_events.send({ type: "hosts_changed" });
}

/**
 * The link no longer counts as connected (Rust's `Registered` being dropped): however its loop ended, by an error or by
 * an abort when the link is added again or removed.
 */
export function unregister(s: AppState, conn: LinkConn) {
  if (s.links.get(conn.id) === conn) s.links.delete(conn.id);
  // Last seen when we last heard from it, which for a connection that died without closing is a while before we gave
  // up on it.
  try {
    db.run(s.db(), "UPDATE links SET last_seen=?1 WHERE id=?2", conn.last_message_at(), conn.id);
  } catch {}
  changed(s);
}

/**
 * Why live connection `conn` can't stand in for the host this hub links under its id, if it can't: that host is a
 * profile's assistant host, and `conn` didn't come the way it's linked (see `linked_via`), as when a host dials in under
 * the id of one we dial. The user's messages to the assistant go through the proxy too, so they'd reach it. Any other
 * host we dial may also dial in, and stands in for itself while the link we dial is down.
 */
export function misplaced(s: AppState, conn: LinkConn): string | null {
  let link: Link | null = null;
  let assistant = false;
  try {
    link = db.get_link(s.db(), conn.id);
    assistant = !!link && db.list_profiles(s.db()).some((p) => p.assistant_host === conn.id);
  } catch {}
  if (!link || !assistant || linked_via(link, conn_via(conn))) return null;
  return conn_via(conn) === "tunnel"
    ? `${s.host_name} links assistant host ${link.name} itself, so a host that dials in under its id (${conn.id}) isn't taken for it`
    : `${s.host_name} links assistant host ${link.name} as a host that dials in, and this connection didn't`;
}

/**
 * Count `conn` as connected, in place of any other connection to its host, except that a host that dials in while it's
 * already connected in is refused (two hosts with the same id would otherwise take each other's place for as long as
 * both run), and so is one that dials in under the id of an assistant host we dial (see `misplaced`): it would take
 * that host's place for the UI's requests (the proxy) and its name. Returns false when refused; else `unregister` it
 * when it goes.
 */
export function register(s: AppState, conn: LinkConn): boolean {
  const old = s.links.get(conn.id);
  if (conn.kind.type === "tunnel" && old?.kind.type === "tunnel") return false;
  if (misplaced(s, conn) !== null) return false;
  s.links.set(conn.id, conn);
  changed(s);
  return true;
}

export function forward_event(s: AppState, host_id: string, ev: any) {
  if (ev && typeof ev === "object" && !Array.isArray(ev)) ev = { ...ev, host_id };
  s.hub_events.send(ev);
}

// ---------- startup ----------

/** Relay this host's own events to the UI stream, and connect outbound links. */
export function start(s: AppState) {
  s.events.subscribe((ev) => forward_event(s, s.host_id, ev));
  for (const link of db.list_links(s.db()).filter((l: Link) => l.mode === "outbound" || l.mode === "ssh")) spawn_outbound(s, link);
}

export function spawn_outbound(s: AppState, link: Link) {
  const id = link.id;
  let stop: () => void;
  if (link.mode === "ssh") {
    stop = ssh.run(s, link);
  } else {
    let stopped = false;
    let abort: (() => void) | null = null;
    stop = () => {
      stopped = true;
      abort?.();
    };
    background("keeping a link to another host open", (async () => {
      let backoff = 1;
      while (!stopped) {
        try {
          await run_outbound(s, link, "outbound", (a) => (abort = a));
          backoff = 1;
        } catch (e) {
          if (process.env.IA_DEBUG) console.error(`link ${link.name}: ${err_str(e)}`);
        }
        abort = null;
        if (stopped) break;
        await new Promise<void>((r) => {
          const t = setTimeout(r, backoff * 1000);
          abort = () => {
            clearTimeout(t);
            r();
          };
        });
        abort = null;
        backoff = Math.min(backoff * 2, 30);
      }
    })());
  }
  const old = s.link_tasks.get(id);
  s.link_tasks.set(id, stop);
  old?.();
}

/**
 * Follow an outbound link's events; the link counts as connected while this is up. `on_abort` gets the function that
 * ends it (Rust aborts the task).
 */
export async function run_outbound(s: AppState, link: Link, mode: string, on_abort: (abort: () => void) => void = () => {}): Promise<void> {
  let aborted = false;
  on_abort(() => (aborted = true));
  if (!link.token) throw new Error("link has no token");
  if (!link.url) throw new Error("link has no url");
  const token = link.token;
  const url = await broker.resolve(link.url, link.id);
  if (aborted) return;
  // The token goes in a header rather than the URL, which proxies and brokers on the way log.
  const ws_url = `${url.replace(/\/+$/, "").replace("http", "ws")}/api/host/ws`;
  const ws = await relay.open(ws_url, { Authorization: `Bearer ${token}` });
  if (aborted) return void ws.terminate();
  const conn = new LinkConn(link.id, link.name, mode, Version_default(), { type: "http", url, token, agent: link_agent() });
  let ended: () => void = () => {};
  const done = new Promise<void>((r) => (ended = r));
  // Messages that come while it asks for the host's info are kept for the loop.
  const early: any[] = [];
  let ready = false;
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    clearInterval(ping);
    clearTimeout(quiet);
    ws.terminate();
    ended();
  };
  on_abort(finish);
  const silence = () =>
    setTimeout(() => {
      console.error(`nothing from host ${link.name} for ${relay.SILENCE / 1000}s`);
      finish();
    }, relay.SILENCE);
  let quiet = silence();
  const heard = () => {
    conn.heard();
    clearTimeout(quiet);
    if (!finished) quiet = silence();
  };
  // Hosts answer websocket pings whatever their version, which keeps the events coming or ends the link.
  const ping = setInterval(() => {
    try {
      ws.ping();
    } catch {
      finish();
    }
  }, relay.PING);
  ws.on("pong", heard);
  ws.on("ping", heard);
  ws.on("message", (data, binary) => {
    heard();
    const f = relay.frame_of(data, binary);
    if (f.type !== "text") return;
    let ev: any;
    try {
      ev = JSON.parse(f.text);
    } catch {
      return;
    }
    if (ev?.type === "hub_call") {
      const c = ToolCall_from(ev);
      if (c) {
        background("answering a host's board tool call", run_up_call(s, link.id, c, "dialled").then((a) => {
          if (!finished && ws.readyState === ws.OPEN) ws.send(JSON.stringify(uplink.answer_frame(a)));
        }));
      }
      return;
    }
    if (ready) forward_event(s, link.id, ev);
    else early.push(ev);
  });
  ws.on("close", finish);
  ws.on("error", finish);
  ws.resume();
  try {
    const [status, info] = await conn.request("GET", "/api/info");
    if (status === 200) conn.version = Version_from_info(info);
  } catch {}
  if (finished) return;
  register(s, conn);
  try {
    console.error(`connected to host ${link.name}`);
    // Who we are, so the host can pass its agents' board tool calls up (hosts before API 112 ignore it).
    try {
      ws.send(JSON.stringify(uplink.hub_hello(s)));
    } catch {
      finish();
    }
    // Anything missed while disconnected: tell the UI to reload this host.
    forward_event(s, link.id, { type: "resync" });
    ready = true;
    for (const ev of early.splice(0)) forward_event(s, link.id, ev);
    await done;
    console.error(`lost host ${link.name}`);
  } finally {
    unregister(s, conn);
    conn.kind.type === "http" && conn.kind.agent.destroy();
  }
}

/** Links `s` over HTTP to a host at `url` (a test's server), which reports API `api_version`. */
export function link_http(s: AppState, id: string, url: string, api_version: number) {
  const kind: Kind = { type: "http", url, token: "", agent: link_agent() };
  const conn = new LinkConn(id, id, "http", { ...Version_default(), api_version }, kind);
  s.links.set(id, conn);
  return conn;
}
