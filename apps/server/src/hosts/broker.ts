// Port of server/src/hosts/broker.rs: dialling out to a broker (`serve --broker <url>`, see `crates/broker`), so this
// host can be reached through it from anywhere: its board in a browser, and its API from hubs.
//
// A managed broker sends a connector token and public endpoint; cloudflared carries application traffic to our private
// origin listener, independently of the broker connection. A legacy broker sends requests down our websocket instead,
// answered over loopback with the client's headers. Both public transports still require our token and must never
// expose --open-token.
import * as http from "node:http";
import * as https from "node:https";
import { spawn, type ChildProcess } from "node:child_process";
import { constants as os_constants } from "node:os";
import type { Writable } from "node:stream";
import WebSocket from "ws";
import type { AppState } from "../state.ts";
import { no_route_error } from "../http.ts";
import { background, context, err_str } from "../util.ts";
import { VERSION } from "./proto.ts";
import * as relay from "./relay.ts";
import * as proto from "./broker/proto.ts";
import type { Ctl, Tunnel } from "./broker/proto.ts";

const log = {
  info: (m: string) => console.error(new Date().toISOString(), " INFO huntaway::hosts::broker:", m),
  warn: (m: string) => console.error(new Date().toISOString(), " WARN huntaway::hosts::broker:", m),
};

/** Paths a client mustn't reach through the broker: `--open-token` hands the token to whoever asks. */
const BLOCKED = ["/api/open-token"];

/**
 * Marks the requests we make on our own server for the broker's clients, so a route that mustn't be reached through
 * the broker can refuse them however their path is spelled.
 */
export const VIA_BROKER = "x-huntaway-via-broker";

/** The broker sends a `Ping` every 20s; one we hear nothing from for this long is gone. */
const SILENCE = 60_000;

/** How long a websocket the broker closed has to close on our server before it's cut off. */
export const CLOSE_GRACE = 2000;

/** What the broker sent on one of our streams. */
type Incoming = { type: "data"; bytes: Buffer } | { type: "text"; text: string } | { type: "end" } | { type: "close"; code: number | null; reason: string | null };

/**
 * An unbounded channel with an async receiver (tokio's mpsc): `next()` gives what's sent in order, then `null` once
 * it's closed (its sender went) and empty.
 */
class Queue<T> {
  private buf: T[] = [];
  private waiter: ((v: T | null) => void) | null = null;
  private closed = false;

  send(v: T): boolean {
    if (this.closed) return false;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w(v);
    } else this.buf.push(v);
    return true;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w(null);
    }
  }

  next(): Promise<T | null> {
    if (this.buf.length) return Promise.resolve(this.buf.shift()!);
    if (this.closed) return Promise.resolve(null);
    return new Promise((r) => (this.waiter = r));
  }
}

/**
 * One of our streams: where what the broker sends on it goes, our room to send it data, and for a request, how to stop
 * it when the client goes away.
 */
interface Entry {
  tx: Queue<Incoming>;
  window: proto.Window;
  /** Stops the stream's task, which may be waiting on our server however long. */
  abort: (() => void) | null;
  ws: boolean;
}

/**
 * The stream is over. A request stops at once. A websocket gets the close it was sent through `tx`, with `CLOSE_GRACE`
 * to pass it on, unless it's to stop at once too (we lost the broker).
 */
function entry_end(e: Entry, at_once: boolean) {
  // Dropping the sender: the stream's task sees what was sent, then the end.
  e.tx.close();
  e.window.close();
  const a = e.abort;
  if (!a) return;
  if (e.ws && !at_once) setTimeout(a, CLOSE_GRACE).unref();
  else a();
}

/** A GET with no credential that follows no redirects, on a connection of its own. */
function discover(url: URL): Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string }> {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === "https:" ? https : http;
    // Never reuse a discovery socket: the last one may belong to the network that just died.
    const req = mod.request(url, { method: "GET", agent: false }, (res) => {
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
    const timer = setTimeout(() => req.destroy(new Error("operation timed out")), 10_000);
    req.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    req.end();
  });
}

/**
 * Resolve an explicit broker host URL before sending a host/hub token or opening a websocket. 404 means an older relay
 * broker. Discovery itself carries no credential and follows no redirects.
 */
export async function resolve(url: string, expected_host: string | null): Promise<string> {
  let base: URL;
  try {
    base = new URL(url);
  } catch (e) {
    throw context("bad host URL", e);
  }
  const path = base.pathname.replace(/\/+$/, "");
  const named = path.startsWith("/_broker/h/") ? path.slice("/_broker/h/".length) : null;
  const explicit = named !== null && proto.valid_name(named) ? named : null;
  if (explicit === null && path !== "") return url;
  const discovery = new URL(base.href);
  discovery.pathname = explicit !== null ? `/_broker/resolve/${explicit}` : "/_broker/resolve";
  discovery.search = "";
  discovery.hash = "";
  let res;
  try {
    res = await discover(discovery);
  } catch (e) {
    throw context("discovering the host endpoint", e);
  }
  // A normal host serves its UI fallback here. Only a broker identifies its default discovery route.
  if (explicit === null && res.headers["x-huntaway-broker"] === undefined) return url;
  if (res.status === 404) return url;
  if (res.status >= 400) {
    throw context("broker couldn't resolve the host endpoint", new Error(`HTTP status ${res.status} for url (${discovery.href})`));
  }
  let info: any;
  try {
    info = JSON.parse(res.text);
  } catch (e) {
    throw context("bad broker discovery response", e);
  }
  const host_id = typeof info?.host_id === "string" && info.host_id ? (info.host_id as string) : null;
  if (host_id === null) throw new Error("broker discovery has no host id");
  if (expected_host !== null && expected_host !== host_id) throw new Error("broker name now belongs to a different host; link it again");
  if (typeof info.url !== "string") throw new Error("broker discovery has no endpoint");
  let endpoint: URL;
  try {
    endpoint = new URL(info.url);
  } catch (e) {
    throw context("invalid broker endpoint", e);
  }
  const loopback = ["127.0.0.1", "[::1]", "localhost"].includes(endpoint.hostname);
  if (
    !(endpoint.protocol === "https:" || (endpoint.protocol === "http:" && loopback)) ||
    !endpoint.hostname ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.href.includes("?") ||
    endpoint.href.includes("#") ||
    endpoint.pathname !== "/"
  ) {
    throw new Error("broker returned an unsafe endpoint (expected a plain HTTPS origin)");
  }
  return endpoint.href.replace(/\/+$/, "");
}

/** Our streams by id. */
type Streams = Map<number, Entry>;

/**
 * Keep a connection to the broker at `url`, as `name`. `key` is our secret on the broker: it keeps `name` for whoever
 * took it first with theirs. Returns the function that stops it (tests).
 */
export function dial_out(s: AppState, url: string, token: string, name: string, key: string): () => void {
  return dial_with_origin(s, url, token, name, key, null);
}

/**
 * A tunnel must reach this listener, rather than the LAN listener: --open-token must stay private. It serves what `app`
 * (the server's own listener) does, with every request marked as coming through the broker.
 */
export async function origin(app: http.Server): Promise<number> {
  const srv = http.createServer();
  const mark = (req: http.IncomingMessage) => {
    req.headers[VIA_BROKER] = "1";
  };
  srv.on("request", (req, res) => {
    mark(req);
    app.emit("request", req, res);
  });
  srv.on("upgrade", (req, socket, head) => {
    mark(req);
    app.emit("upgrade", req, socket, head);
  });
  srv.on("error", (e) => log.warn(`tunnel origin: ${err_str(e)}`));
  // It lives as long as the server; it doesn't keep the process up by itself.
  srv.unref();
  await new Promise<void>((ok, fail) => {
    srv.once("error", fail);
    srv.listen(0, "127.0.0.1", () => {
      srv.off("error", fail);
      ok();
    });
  });
  return (srv.address() as any).port;
}

/** Returns the function that stops it (Rust's never stop; tests stop theirs). */
export function dial_with_origin(s: AppState, url: string, token: string, name: string, key: string, origin_port: number | null): () => void {
  s.broker_url ??= `${url.replace(/\/+$/, "")}/_broker/h/${name}`;
  const connector = new Watch<Tunnel | null>(null);
  const connector_bin = process.env.IA_CLOUDFLARED_BIN ?? "cloudflared";
  connect_tunnel(connector.subscribe(), connector_bin).catch((e) => log.warn(`tunnel connector: ${err_str(e)}`));
  let stopped = false;
  let abort: (() => void) | null = null;
  background("keeping the broker connected", (async () => {
    let backoff = 1;
    while (!stopped) {
      const started = Date.now();
      try {
        await session(s, url, token, name, key, origin_port, connector, (a) => (abort = a));
      } catch (e) {
        if (!stopped) log.warn(`broker ${url}: ${err_str(e)}`);
      }
      abort = null;
      // A connection that lasted a while starts over at a quick retry.
      if (Date.now() - started > 60_000) backoff = 1;
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
    connector.close();
  })());
  return () => {
    stopped = true;
    abort?.();
  };
}

/** A value its receivers wait for changes of (tokio's `watch`): `close` is the sender being dropped. */
export class Watch<T> {
  value: T;
  version = 0;
  closed = false;
  private waiters = new Set<() => void>();

  constructor(value: T) {
    this.value = value;
  }

  /** Change the value with `f`, which says whether it did; receivers are told only if it did. */
  send_if_modified(f: (old: T) => [boolean, T]) {
    const [changed, v] = f(this.value);
    if (!changed) return;
    this.value = v;
    this.version++;
    this.wake();
  }

  send(v: T) {
    this.send_if_modified(() => [true, v]);
  }

  /** The sender goes: receivers' `changed` gives false. */
  close() {
    this.closed = true;
    this.wake();
  }

  subscribe(): WatchReceiver<T> {
    return new WatchReceiver(this);
  }

  private wake() {
    for (const w of [...this.waiters]) w();
  }

  /** @internal */
  wait(): Promise<void> {
    return new Promise((r) => {
      const w = () => {
        this.waiters.delete(w);
        r();
      };
      this.waiters.add(w);
    });
  }
}

export class WatchReceiver<T> {
  private watch: Watch<T>;
  private seen: number;

  constructor(watch: Watch<T>) {
    this.watch = watch;
    this.seen = watch.version;
  }

  borrow_and_update(): T {
    this.seen = this.watch.version;
    return this.watch.value;
  }

  /** Wait for a value not seen yet, and mark it seen: true, or false once the sender is gone. */
  async changed(): Promise<boolean> {
    for (;;) {
      if (this.watch.closed) return false;
      if (this.watch.version !== this.seen) {
        this.seen = this.watch.version;
        return true;
      }
      await this.watch.wait();
    }
  }

  /** Whether there's a value not seen yet; null once the sender is gone (tokio's `Err`). */
  has_changed(): boolean | null {
    return this.watch.closed ? null : this.watch.version !== this.seen;
  }
}

/**
 * The connector outlives broker sessions. A broker outage must not interrupt board traffic. Tokens use the environment,
 * never command arguments or logs; cloudflared owns its own retries.
 */
export async function connect_tunnel(updates: WatchReceiver<Tunnel | null>, bin: string): Promise<void> {
  for (;;) {
    if (updates.has_changed() === null) return;
    const tunnel = updates.borrow_and_update();
    if (!tunnel) {
      if (!(await updates.changed())) return;
      continue;
    }
    let spawned: { child: ChildProcess; alive: Writable; exited: Promise<string> } | null = null;
    try {
      spawned = spawn_connector(bin, tunnel.token);
    } catch (e) {
      log.warn(`couldn't start cloudflared: ${err_str(e)}; install it on this host or set IA_CLOUDFLARED_BIN`);
    }
    if (spawned) {
      const { child, alive, exited } = spawned;
      const first = await Promise.race([updates.changed().then((ok) => ({ changed: ok })), exited.then((status) => ({ status }))]);
      if ("changed" in first) {
        child.kill("SIGKILL");
        alive.destroy();
        await exited;
        if (!first.changed) return;
      } else {
        alive.destroy();
        log.warn(`cloudflared exited (${first.status}); check its installation/connectivity; restarting in five seconds`);
      }
    }
    let timer: NodeJS.Timeout | undefined;
    const next = await Promise.race([updates.changed(), new Promise<"timeout">((r) => (timer = setTimeout(() => r("timeout"), 5000)))]);
    clearTimeout(timer);
    if (next === false) return;
  }
}

/**
 * The watchdog owns the connector's process group and watches a pipe held only by this server (node opens it
 * close-on-exec). It kills the group on exec, forced exit or a crash, where killing the child can't run. Arguments are
 * positional, never interpreted as shell code (same pattern as wait::LAUNCH).
 *
 * Returns the child, the pipe's end that keeps it alive (destroying it is dropping Rust's `PipeWriter`), and how it
 * exited (as Rust's `ExitStatus` shows it).
 */
export function spawn_connector(bin: string, token: string): { child: ChildProcess; alive: Writable; exited: Promise<string> } {
  const LAUNCH = `exec 3<&0 </dev/null; (read -r _ <&3; kill -KILL 0) & exec 3<&-; exec "$@"`;
  const child = spawn("bash", ["-c", LAUNCH, "huntaway-tunnel", bin, "tunnel", "--no-autoupdate", "run"], {
    env: { ...process.env, TUNNEL_TOKEN: token },
    stdio: ["pipe", "ignore", "ignore"],
    // Its own process group (and session), which the watchdog kills.
    detached: true,
  });
  const alive = child.stdin!;
  alive.on("error", () => {});
  const exited = new Promise<string>((resolve) => {
    child.once("error", (e) => resolve(`couldn't start: ${err_str(e)}`));
    child.once("exit", (code, signal) => resolve(exit_status(code, signal)));
  });
  return { child, alive, exited };
}

/** How a process exited, as Rust's `ExitStatus` displays it. */
export function exit_status(code: number | null, signal: NodeJS.Signals | null): string {
  if (code !== null) return `exit status: ${code}`;
  const n = signal ? ((os_constants.signals as any)[signal] ?? 0) : 0;
  return `signal: ${n} (${signal ?? "unknown"})`;
}

/**
 * One connection to the broker: say who we are, then answer its requests (legacy relay) until it hangs up or goes
 * quiet. `connector` gets the managed tunnel the broker sends, if any. `on_abort` gets the function that ends it.
 */
export function session(
  s: AppState,
  url: string,
  token: string,
  name: string,
  key: string,
  origin_port: number | null,
  connector: Watch<Tunnel | null>,
  on_abort: (abort: () => void) => void = () => {},
): Promise<void> {
  return (async () => {
    const ws_url = `${url.replace(/\/+$/, "").replace("http", "ws")}/_broker/connect`;
    let ws: WebSocket;
    try {
      ws = await relay.open(ws_url, { Authorization: `Bearer ${token}` });
    } catch (e) {
      throw context("connecting", e);
    }
    const hello: Ctl = { t: "hello", name, host_id: s.host_id, version: VERSION, protocol: proto.PROTOCOL, key };
    if (origin_port !== null) (hello as any).origin_port = origin_port;
    ws.send(JSON.stringify(hello));
    const streams: Streams = new Map();
    return new Promise<void>((resolve, reject) => {
      let welcomed = false;
      let relaying = false;
      let finished = false;
      const finish = (err: Error | null) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        // Dropping the senders closes the websockets in flight; requests are stopped.
        const all = [...streams.values()];
        streams.clear();
        for (const e of all) entry_end(e, true);
        ws.terminate();
        if (err) reject(err);
        else resolve();
      };
      on_abort(() => finish(null));
      let timer = setTimeout(() => finish(new Error("no welcome")), 120_000);
      const heard = () => {
        clearTimeout(timer);
        timer = setTimeout(() => finish(new Error("the broker went quiet")), SILENCE);
      };
      const tx = (m: string | Buffer): boolean => {
        if (finished || ws.readyState !== WebSocket.OPEN) return false;
        ws.send(m);
        return true;
      };
      ws.on("message", (data, binary) => {
        if (finished) return;
        const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as any);
        if (!welcomed) {
          if (binary) return finish(new Error("no welcome"));
          let ctl: Ctl;
          try {
            ctl = proto.Ctl_from_json(buf.toString("utf8"));
          } catch (e) {
            return finish(e as Error);
          }
          if (ctl.t === "welcome") {
            const tunnel = ctl.tunnel ?? null;
            if (tunnel) log.info(`host ${ctl.name} tunnel endpoint ${tunnel.url} (broker handles setup only)`);
            else log.info(`reachable through the broker ${url} as ${ctl.name}`);
            relaying = tunnel === null;
            connector.send_if_modified((old) => (same_tunnel(old, tunnel) ? [false, old] : [true, tunnel]));
            welcomed = true;
            heard();
            return;
          }
          if (ctl.t === "refused") return finish(new Error(`refused: ${ctl.error}`));
          return finish(new Error(`expected a welcome, got ${JSON.stringify(ctl)}`));
        }
        heard();
        if (!binary) {
          let ctl: Ctl;
          try {
            ctl = proto.Ctl_from_json(buf.toString("utf8"));
          } catch (e) {
            return log.warn(`bad message from the broker: ${err_str(e)}`);
          }
          switch (ctl.t) {
            case "req": {
              if (!relaying) return finish(new Error("the broker tried to relay application traffic in managed tunnel mode"));
              start_stream(s, streams, tx, ctl);
              return;
            }
            case "ping":
              tx(JSON.stringify({ t: "pong" }));
              return;
            case "end":
              return incoming(streams, ctl.id, { type: "end" }, false);
            case "close":
              return incoming(streams, ctl.id, { type: "close", code: ctl.code, reason: ctl.reason }, true);
            case "credit":
              streams.get(ctl.id)?.window.credit(ctl.bytes);
              return;
            default:
              return;
          }
        }
        const d = proto.decode(buf);
        if (!d) return;
        const [id, kind, bytes] = d;
        incoming(streams, id, kind === proto.TEXT ? { type: "text", text: bytes.toString("utf8") } : { type: "data", bytes: Buffer.from(bytes) }, false);
      });
      ws.on("close", (_code, reason) => {
        if (!welcomed) return finish(new Error("no welcome"));
        if (reason.length) log.info(`the broker hung up: ${reason.toString()}`);
        finish(null);
      });
      ws.on("error", (e) => finish(e));
      ws.resume();
    });
  })();
}

function same_tunnel(a: Tunnel | null, b: Tunnel | null): boolean {
  return a === b || (a !== null && b !== null && a.url === b.url && a.token === b.token);
}

/** Start answering a request (or relaying a websocket) the broker sent. */
function start_stream(s: AppState, streams: Streams, tx: (m: string | Buffer) => boolean, req: Extract<Ctl, { t: "req" }>) {
  const in_q = new Queue<Incoming>();
  const window = new proto.Window();
  // Registered right away: the request body follows at once.
  const entry: Entry = { tx: in_q, window, abort: null, ws: req.ws };
  streams.set(req.id, entry);
  const out = new Out(req.id, tx, window);
  const ac = new AbortController();
  entry.abort = () => ac.abort();
  background("a stream from the broker", (async () => {
    try {
      if (req.ws) await websocket(s, req.path, req.headers, in_q, out, ac.signal);
      else await request(s, req.method, req.path, req.headers, req.body ? in_q : null, out, ac.signal);
    } catch (e) {
      if (!ac.signal.aborted) log.warn(`stream ${req.id}: ${err_str(e)}`);
    }
    if (streams.get(req.id) === entry) streams.delete(req.id);
  })());
}

function incoming(streams: Streams, id: number, msg: Incoming, last: boolean) {
  if (last) {
    const e = streams.get(id);
    if (e) {
      streams.delete(id);
      e.tx.send(msg);
      entry_end(e, false);
    }
  } else streams.get(id)?.tx.send(msg);
}

/** Sending on one stream. */
class Out {
  id: number;
  private tx: (m: string | Buffer) => boolean;
  /** Our room to send its data. */
  window: proto.Window;

  constructor(id: number, tx: (m: string | Buffer) => boolean, window: proto.Window) {
    this.id = id;
    this.tx = tx;
    this.window = window;
  }

  ctl(ctl: Ctl): boolean {
    return this.tx(JSON.stringify(ctl));
  }

  /** Data sent whatever the window: only for a short body we make up ourselves, in place of a response. */
  data(kind: number, bytes: Uint8Array): boolean {
    return this.tx(proto.encode(this.id, kind, bytes));
  }

  /** Send body bytes as the window has room for them. */
  async body(bytes: Buffer): Promise<boolean> {
    for (let i = 0; i < bytes.length; i += proto.WINDOW) {
      const piece = bytes.subarray(i, i + proto.WINDOW);
      if (!(await this.window.take(piece.length)) || !this.data(proto.DATA, piece)) return false;
    }
    return true;
  }

  /** Send a websocket message once the window has room for it. */
  async message(kind: number, bytes: Buffer): Promise<boolean> {
    return (await this.window.take(bytes.length)) && this.data(kind, bytes);
  }

  /** Tell the broker we passed on `bytes` of what it sent. */
  credit(bytes: number) {
    if (bytes > 0) this.ctl({ t: "credit", id: this.id, bytes });
  }

  head(status: number, headers: Array<[string, string]>): boolean {
    return this.ctl({ t: "head", id: this.id, status, headers });
  }

  end() {
    this.ctl({ t: "end", id: this.id });
  }

  /** A whole JSON response, as the API answers errors. */
  json(status: number, body: any) {
    this.head(status, [["content-type", "application/json"]]);
    this.data(proto.DATA, Buffer.from(JSON.stringify(body)));
    this.end();
  }
}

/**
 * The URL on our server (`base`) for a path the broker passes on. Null for one a client mustn't reach through the
 * broker: one that isn't on our server (`@other.host/` after our URL would be another server), or one that's blocked,
 * however it's written (`/api/./open-token`, `%2e`, `\`). The URL is checked as it's parsed, which resolves dot
 * segments, and then decoded on top, so it's what gets requested that's checked.
 */
export function local_url(base: string, path: string): URL | null {
  if (!path.startsWith("/")) return null;
  let b: URL, url: URL;
  try {
    b = new URL(base);
    url = new URL(`${b.href.replace(/\/+$/, "")}${path}`);
  } catch {
    return null;
  }
  if (url.origin !== b.origin || BLOCKED.includes(normalized(url.pathname))) return null;
  return url;
}

/**
 * A path decoded and resolved until it doesn't change: no escapes, dot segments, backslashes, empty segments, trailing
 * slash or capitals. More than a server would make of it, so nothing that routes to a blocked path gets past.
 */
function normalized(path: string): string {
  let p = path.toLowerCase();
  for (let i = 0; i < 8; i++) {
    const decoded = percent_decode(p).replaceAll("\\", "/").toLowerCase();
    const segs: string[] = [];
    for (const seg of decoded.split("/")) {
      if (seg === "" || seg === ".") continue;
      if (seg === "..") segs.pop();
      else segs.push(seg);
    }
    const next = `/${segs.join("/")}`;
    if (next === p) break;
    p = next;
  }
  return p;
}

function percent_decode(s: string): string {
  const b = Buffer.from(s, "utf8");
  const out: number[] = [];
  const hex = (c: number) => (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);
  for (let i = 0; i < b.length; ) {
    if (b[i] === 37 && i + 2 < b.length && hex(b[i + 1]) && hex(b[i + 2])) {
      out.push(parseInt(String.fromCharCode(b[i + 1], b[i + 2]), 16));
      i += 3;
    } else out.push(b[i++]);
  }
  return Buffer.from(out).toString("utf8");
}

/** Redirects go back to the client as they are, and loopback never goes through a proxy. */
const LOCAL = new http.Agent({ keepAlive: true });

/** Pass the client's headers on, but not the ones that belong to the hop to the broker. */
function passed_on(headers: Array<[string, string]>): Array<[string, string]> {
  // A client's own is dropped: ours says the request came through the broker.
  return headers
    .filter(([k]) => !proto.hop_by_hop(k) && k.toLowerCase() !== "content-length" && k.toLowerCase() !== VIA_BROKER)
    .concat([[VIA_BROKER, "1"]]);
}

/** Headers as node takes them: repeated ones as arrays. */
function header_object(headers: Array<[string, string]>): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of headers) {
    const key = k.toLowerCase();
    const had = out[key];
    out[key] = had === undefined ? v : Array.isArray(had) ? [...had, v] : [had, v];
  }
  return out;
}

/** A response's headers as pairs, in the order they came. */
function header_pairs(raw: string[]): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (let i = 0; i + 1 < raw.length; i += 2) out.push([raw[i].toLowerCase(), raw[i + 1]]);
  return out;
}

/** Make an HTTP request on our own server and send the response back. */
async function request(s: AppState, method: string, path: string, headers: Array<[string, string]>, body: Queue<Incoming> | null, out: Out, signal: AbortSignal) {
  const url = local_url(s.internal_url, path);
  if (!url) return out.json(404, no_route_error(method, path));
  if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(method)) return out.json(400, { error: `bad method ${method}` });
  let req: http.ClientRequest;
  try {
    req = http.request(url, { method, headers: header_object(passed_on(headers)), agent: LOCAL });
  } catch (e) {
    return out.json(502, { error: err_str(e) });
  }
  const stop = () => req.destroy(new Error("aborted"));
  signal.addEventListener("abort", stop, { once: true });
  try {
    const response = new Promise<http.IncomingMessage>((ok, fail) => {
      req.once("response", ok);
      req.once("error", fail);
    });
    if (body) {
      // The body as the broker sends it, giving it room for more as our server takes it; a client that went away fails
      // the request.
      (async () => {
        for (;;) {
          const m = await body.next();
          if (m?.type === "data" || m?.type === "text") {
            const bytes = m.type === "data" ? m.bytes : Buffer.from(m.text, "utf8");
            out.credit(bytes.length);
            if (req.destroyed) return;
            if (!req.write(bytes)) {
              await new Promise<void>((r) => {
                req.once("drain", r);
                req.once("close", r);
              });
            }
          } else if (m?.type === "end") return void req.end();
          else return void req.destroy(new Error("the client went away"));
        }
      })().catch((e) => req.destroy(e));
    } else req.end();
    let res: http.IncomingMessage;
    try {
      res = await response;
    } catch (e) {
      if (signal.aborted) return;
      return out.json(502, { error: err_str(e) });
    }
    if (!out.head(res.statusCode ?? 502, header_pairs(res.rawHeaders))) return void res.destroy();
    try {
      for await (const chunk of res) {
        if (signal.aborted || !(await out.body(chunk as Buffer))) return void res.destroy();
      }
    } catch (e) {
      if (!signal.aborted) out.ctl({ t: "close", id: out.id, code: null, reason: err_str(e) });
      return;
    }
    if (signal.aborted) return;
    out.end();
  } finally {
    signal.removeEventListener("abort", stop);
  }
}

/** The websockets the host is relaying to its own server, by path, so a test can see one end. */
export const LIVE_WS: string[] = [];

/** Open a websocket on our own server and relay it until either side closes it. */
async function websocket(s: AppState, path: string, headers: Array<[string, string]>, from_broker: Queue<Incoming>, out: Out, signal: AbortSignal) {
  LIVE_WS.push(path);
  try {
    await relay_websocket(s, path, headers, from_broker, out, signal);
  } finally {
    const i = LIVE_WS.indexOf(path);
    if (i >= 0) LIVE_WS.splice(i, 1);
  }
}

async function relay_websocket(s: AppState, path: string, headers: Array<[string, string]>, from_broker: Queue<Incoming>, out: Out, signal: AbortSignal) {
  const url = local_url(s.internal_url, path);
  if (!url) return out.json(404, no_route_error("GET", path));
  url.protocol = "ws:";
  if (signal.aborted) return;
  let ws: WebSocket;
  try {
    ws = new WebSocket(url, { headers: header_object(passed_on(headers)), perMessageDeflate: false, followRedirects: false });
  } catch (e) {
    return out.json(400, { error: err_str(e) });
  }
  const aborted = new Promise<"aborted">((r) => signal.addEventListener("abort", () => r("aborted"), { once: true }));
  try {
    const opened = await Promise.race([
      aborted,
      new Promise<{ ok: true } | { res: http.IncomingMessage; req: http.ClientRequest } | { err: Error }>((r) => {
        // Paused at once: messages that came with the handshake would otherwise go before `down` listens.
        ws.once("open", () => {
          ws.pause();
          r({ ok: true });
        });
        ws.once("unexpected-response", (req, res) => r({ req, res }));
        ws.once("error", (err) => r({ err }));
      }),
    ]);
    if (opened === "aborted") return;
    if ("err" in opened) return out.json(502, { error: err_str(opened.err) });
    if ("res" in opened) {
      // Not a websocket after all (unauthorized, say): the client gets that response.
      const { req, res } = opened;
      const chunks: Buffer[] = [];
      try {
        for await (const c of res) chunks.push(c as Buffer);
      } catch {}
      req.destroy();
      out.head(res.statusCode ?? 502, header_pairs(res.rawHeaders));
      out.data(proto.DATA, Buffer.concat(chunks));
      return out.end();
    }
    out.head(101, []);
    ws.on("error", () => {});
    // The websocket itself rather than a relay with queues of its own: we read a message from our server only once
    // there's room to send it on, and give the broker room back only once one is written, so neither way piles up here.
    let done = false;
    const up = async () => {
      for (;;) {
        const m = await Promise.race([from_broker.next(), aborted]);
        if (m === "aborted" || done) return;
        if (m === null || m.type === "close") {
          const code = m?.type === "close" ? m.code : null;
          try {
            if (code !== null) ws.close(code, relay.truncate_reason(m?.type === "close" ? (m.reason ?? "") : ""));
            else ws.close();
          } catch {
            try {
              ws.close();
            } catch {}
          }
          await flushed(ws, signal);
          return;
        }
        if (m.type === "end") continue;
        const [data, n] = m.type === "data" ? [m.bytes, m.bytes.length] : [m.text, Buffer.byteLength(m.text)];
        const sent = await new Promise<boolean>((r) => ws.send(data, { binary: m.type === "data" }, (e) => r(!e)));
        if (!sent) return;
        out.credit(n);
      }
    };
    const down = () =>
      new Promise<void>((resolve) => {
        const pending: Array<{ kind: number; bytes: Buffer } | { close: [number, string] | null }> = [];
        let pumping = false;
        const pump = async () => {
          if (pumping) return;
          pumping = true;
          while (pending.length) {
            if (done) return resolve();
            const m = pending.shift()!;
            if ("close" in m) {
              out.ctl({ t: "close", id: out.id, code: m.close?.[0] ?? null, reason: m.close?.[1] ?? null });
              return resolve();
            }
            if (!(await out.message(m.kind, m.bytes))) return resolve();
          }
          pumping = false;
          if (!done && ws.readyState === WebSocket.OPEN) ws.resume();
        };
        // A message that couldn't go to the broker ends this way of the stream, as a closed one does.
        const kick = () =>
          pump().catch((e) => {
            if (!signal.aborted) log.warn(`websocket stream ${out.id}: ${err_str(e)}`);
            resolve();
          });
        ws.on("message", (data, binary) => {
          const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as any);
          pending.push({ kind: binary ? proto.DATA : proto.TEXT, bytes: buf });
          ws.pause();
          kick();
        });
        ws.on("close", (code, reason) => {
          pending.push({ close: relay.close_frame(code, reason) });
          kick();
        });
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    // The two ways go on side by side, so one waiting for room doesn't hold up the other.
    const both = Promise.race([up(), down()]);
    ws.resume();
    await both;
    done = true;
  } finally {
    ws.terminate();
  }
}

/** Wait until what was written to `ws` has gone to its socket (Rust awaits sending the close), or until aborted. */
async function flushed(ws: WebSocket, signal: AbortSignal) {
  while (ws.bufferedAmount > 0 && !signal.aborted && ws.readyState !== WebSocket.CLOSED) {
    await new Promise((r) => setTimeout(r, 20));
  }
}
