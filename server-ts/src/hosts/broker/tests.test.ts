// Port of server/src/hosts/broker/tests.rs. Rust's tests run the `huntaway-broker` crate in-process; these run it as a
// process (see test_broker.ts).
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { STATUS_CODES, createServer, request as http_request, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createConnection, type Socket } from "node:net";
import { join } from "node:path";
import WebSocket, { WebSocketServer } from "ws";
import * as testing from "../../testing.ts";
import * as db from "../../db.ts";
import * as api from "../../api.ts";
import { errorAnswer, readBody, send } from "../../http.ts";
import { open_token } from "../../serve.ts";
import type { AppState } from "../../state.ts";
import { sleep } from "../../util.ts";
import * as relay from "../relay.ts";
import * as hub from "../hub.ts";
import type { Frame } from "../relay.ts";
import { CLOSE_GRACE, LIVE_WS, VIA_BROKER, Watch, connect_tunnel, dial_out, local_url, origin, resolve, session, spawn_connector } from "../broker.ts";
import * as proto from "./proto.ts";
import * as test_broker from "./test_broker.ts";
import type { Ctl, Tunnel } from "./proto.ts";

relay.test_timing();

/** What each test leaves running (servers, brokers, dialling loops), stopped when the file's tests end. */
const cleanups: Array<() => void> = [];
after(() => {
  for (const f of cleanups.splice(0)) f();
});

const BROKER_TOKEN = "broker-token-0123456789";

/** Options for tests that run the broker (see test_broker.ts). */
const needs_broker = test_broker.needs_broker();

/** A broker on a free port, with `cfg`; returns its URL. */
const broker_with = (cfg: test_broker.Config = {}) => test_broker.start_test_broker(BROKER_TOKEN, cfg, cleanups);
const broker = () => broker_with();

/** Serve `handler` on a free port; returns the server and its URL. */
async function http_server(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<[string, Server]> {
  const srv = createServer(handler);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  cleanups.push(() => stop_server(srv));
  return [`http://127.0.0.1:${(srv.address() as any).port}`, srv];
}

/** Close a server and every connection it has, upgraded ones included. */
const sockets = new WeakMap<Server, Set<Socket>>();
function track(srv: Server) {
  const set = new Set<Socket>();
  sockets.set(srv, set);
  srv.on("connection", (c: Socket) => {
    set.add(c);
    c.on("close", () => set.delete(c));
  });
}
function stop_server(srv: Server) {
  for (const c of sockets.get(srv) ?? []) c.destroy();
  srv.closeAllConnections();
  srv.close();
}

const json = (res: ServerResponse, status: number, v: any, headers: Record<string, string> = {}) =>
  res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(v));

/** Routes a test host serves besides its API: HTTP ones (true when it answered) and websockets by path. */
interface Extra {
  http?: (req: IncomingMessage, res: ServerResponse) => boolean;
  ws?: Record<string, (ws: WebSocket) => void>;
}

/**
 * Serve `s`'s API on a free port (as main.ts does, with `/api/open-token` as `--open-token` serves it) and `extra`,
 * setting `s.internal_url`. Returns the server.
 */
async function serve_host(s: AppState, extra: Extra = {}): Promise<Server> {
  api.router(s);
  const srv: Server = createServer(async (req, res) => {
    const url = req.url ?? "/";
    const path = url.split("?")[0];
    try {
      if (extra.http?.(req, res)) return;
      if (path === "/api/open-token" && req.method === "GET") return send(res, open_token(s.token, false)(req.headers));
      if (path === "/api" || path.startsWith("/api/")) {
        const found = s.local_router!.find(path.slice(4));
        const raw = await readBody(req, found?.route.limit ?? 2 << 20);
        return send(res, await api.dispatch(s, api.makeReq(req.method ?? "GET", url, req.headers, raw)));
      }
      res.writeHead(404).end();
    } catch {
      if (!res.headersSent) res.writeHead(500).end();
    }
  });
  track(srv);
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  srv.on("upgrade", async (req, socket, head) => {
    const url = req.url ?? "/";
    const path = url.split("?")[0];
    const query = url.includes("?") ? url.slice(url.indexOf("?") + 1) : "";
    const own = extra.ws?.[path];
    if (own) return void wss.handleUpgrade(req, socket, head, own);
    const found = path.startsWith("/api/") ? s.local_router!.find(path.slice(4)) : null;
    if (!found?.route.ws) return void socket.end("HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\n\r\n");
    if (found.route.auth && !api.authorized(s, req.headers, query)) {
      return void socket.end(`HTTP/1.1 401 Unauthorized\r\ncontent-type: application/json\r\ncontent-length: 24\r\n\r\n{"error":"unauthorized"}`);
    }
    const r = api.makeReq("GET", url, req.headers, Buffer.alloc(0));
    r.params = found.params;
    if (found.route.pre) {
      try {
        r.pre = await found.route.pre(s, r);
      } catch (e) {
        const a = errorAnswer(e);
        return void socket.end(`HTTP/1.1 ${a.status} ${STATUS_CODES[a.status] ?? ""}\r\ncontent-type: application/json\r\ncontent-length: ${a.body.length}\r\n\r\n${a.body}`);
      }
    }
    wss.handleUpgrade(req, socket, head, (ws) => found.route.ws!(s, r, ws));
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  cleanups.push(() => {
    for (const c of wss.clients) c.terminate();
    stop_server(srv);
  });
  s.internal_url = `http://127.0.0.1:${(srv.address() as any).port}`;
  return srv;
}

function node(id: string, token = `${id}-tok`, hub_token = `${id}-hub`): AppState {
  return testing.state_as({ host_id: id, host_name: id, token, hub_token, internal_url: "" });
}

/** A host (`id`, token `<id>-tok`) served on a free port and dialled out to `broker` as `id`. */
async function host(id: string, b: string): Promise<AppState> {
  return host_with(id, b, {});
}

/** `host`, also serving `extra`. Every test host serves `/api/open-token` as `--open-token` does, which no client of the broker may reach. */
async function host_with(id: string, b: string, extra: Extra): Promise<AppState> {
  const s = node(id);
  await serve_host(s, extra);
  cleanups.push(dial_out(s, b, BROKER_TOKEN, id, `${id}-key`));
  // Connected once the broker passes a request to it.
  for (let i = 0; i < 100; i++) {
    if ((await call("GET", `${b}/_broker/h/${id}/api/health`))[0] === 200) return s;
    await sleep(50);
  }
  assert.fail(`host ${id} didn't connect to the broker`);
}

/** A request with these headers (`body` is a JSON body); redirects aren't followed. */
function call(method: string, url: string, headers: Array<[string, string]> = []): Promise<[number, any]> {
  return new Promise((resolve, reject) => {
    const h: Record<string, string> = {};
    let body: string | null = null;
    for (const [k, v] of headers) {
      if (k === "body") {
        h["content-type"] = "application/json";
        body = v;
      } else h[k] = v;
    }
    const req = http_request(url, { method, headers: h, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let v: any;
        try {
          v = JSON.parse(text);
        } catch {
          v = text;
        }
        resolve([res.statusCode ?? 0, v]);
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(body ?? undefined);
  });
}

/** Connect to `base` (`http://host:port`). */
function connect(base: string): Promise<Socket> {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const c = createConnection(Number(u.port), u.hostname, () => resolve(c));
    c.once("error", reject);
  });
}

/** A request sent as it's written (clients resolve dot segments before sending). */
async function raw(base: string, path: string): Promise<string> {
  const c = await connect(base);
  c.write(`GET ${path} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
  const chunks: Buffer[] = [];
  for await (const d of c) chunks.push(d as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** Asks for `path` and never reads the response. */
async function unread(base: string, path: string): Promise<Socket> {
  const c = await connect(base);
  c.pause();
  c.write(`GET ${path} HTTP/1.1\r\nHost: x\r\n\r\n`);
  cleanups.push(() => c.destroy());
  return c;
}

/** Opens a websocket at `path` and never reads from it. */
async function unread_ws(base: string, path: string): Promise<Socket> {
  const c = await connect(base);
  c.pause();
  const key = Buffer.from("0123456789abcdef").toString("base64");
  c.write(`GET ${path} HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  cleanups.push(() => c.destroy());
  return c;
}

/** A websocket client, open. */
/**
 * A websocket client, paused once it's open: a message that comes with the handshake is emitted on the next tick, before
 * the caller's `await` resumes, so the caller attaches its listeners and then calls `resume()` (sending works paused).
 */
function ws_client(url: string, headers: Record<string, string> = {}): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers, perMessageDeflate: false });
    ws.once("open", () => {
      ws.pause();
      resolve(ws);
    });
    ws.once("unexpected-response", (_req, res) => reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode })));
    ws.once("error", reject);
    cleanups.push(() => ws.terminate());
  });
}

/** Send on `ws`, once it's written. */
const ws_send = (ws: WebSocket, data: Buffer | string) => new Promise<boolean>((r) => ws.send(data, (e) => r(!e)));

/** Sends window-sized messages through the broker to `path` until they stop going; returns what stops it. */
async function flood_ws(b: string, path: string): Promise<() => void> {
  const ws = await ws_client(`${b.replace("http", "ws")}${path}`);
  let stopped = false;
  (async () => {
    while (!stopped && (await ws_send(ws, Buffer.alloc(proto.WINDOW)))) {}
  })();
  return () => {
    stopped = true;
    ws.terminate();
  };
}

/** A websocket route that never reads what it's sent. */
const ws_sink = (ws: WebSocket) => {
  ws.pause();
};

const live_ws = (path: string) => LIVE_WS.filter((p) => p === path).length;

async function until(what: string, limit_ms: number, done: () => boolean) {
  const started = Date.now();
  while (!done()) {
    assert.ok(Date.now() - started < limit_ms, `${what} after ${limit_ms}ms`);
    await sleep(50);
  }
}

const MIB = 1 << 20;

/**
 * A body of 128 MiB, written as the client takes it, counting the bytes it has given out in `sent.n`; `live.n` counts
 * the ones being served, one less when its request stops.
 */
function big_body(res: ServerResponse, sent: { n: number }, live?: { n: number }) {
  if (live) live.n++;
  let gone = false;
  res.on("close", () => {
    if (!gone && live) live.n--;
    gone = true;
  });
  res.writeHead(200, { "content-type": "application/octet-stream" });
  (async () => {
    for (let i = 0; i < 2048 && !gone; i++) {
      sent.n += 64 << 10;
      if (!res.write(Buffer.alloc(64 << 10))) await new Promise((r) => (res.once("drain", r), res.once("close", r)));
    }
    if (!gone) res.end();
  })();
}

// ---------- the managed tunnel's connector ----------

/** A fake broker that, for each host that connects, reads its hello and runs `then` on the socket. */
async function fake_broker(then: (ws: WebSocket, hello: Ctl) => void): Promise<string> {
  const [url, srv] = await http_server((_req, res) => res.writeHead(404).end());
  track(srv);
  const wss = new WebSocketServer({ server: srv, path: "/_broker/connect" });
  cleanups.push(() => {
    for (const c of wss.clients) c.terminate();
    wss.close();
  });
  wss.on("connection", (ws) => ws.once("message", (m) => then(ws, JSON.parse(m.toString()))));
  return url;
}

test("connector_lives_across_broker_disconnects_and_is_stopped_when_its_owner_goes", async () => {
  const dir = testing.temp_dir();
  const bin = join(dir, "cloudflared");
  // The fake connector records the credential from its environment and blocks like cloudflared.
  writeFileSync(bin, `#!/bin/sh\nd=$(dirname "$0")\nprintf '%s' "$TUNNEL_TOKEN" > "$d/token"\nprintf '%s' "$$" > "$d/pid"\nexec sleep 600\n`);
  chmodSync(bin, 0o700);
  const tunnel: Tunnel = { url: "https://desktop.example.com", token: "connector-secret" };
  const b = await fake_broker((ws) => {
    ws.send(JSON.stringify({ t: "welcome", name: "desktop", tunnel }));
    ws.close();
  });
  const tx = new Watch<Tunnel | null>(null);
  const connector = connect_tunnel(tx.subscribe(), bin);
  const s = testing.state();
  await session(s, b, "broker-token", "desktop", "host-key", 12345, tx).catch(() => {});
  assert.deepEqual(tx.value, tunnel);
  for (let i = 0; i < 100 && !existsSync(join(dir, "pid")); i++) await sleep(10);
  const pid = Number(readFileSync(join(dir, "pid"), "utf8"));
  const process_dir = `/proc/${pid}`;
  assert.ok(existsSync(process_dir), "broker disconnected and the connector died");
  assert.equal(readFileSync(join(dir, "token"), "utf8"), "connector-secret");
  assert.ok(!readFileSync(join(process_dir, "cmdline"), "utf8").includes("connector-secret"));
  tx.close();
  await connector;
  assert.ok(!existsSync(process_dir), "connector wasn't reaped");
});

test("managed_registration_channels_refuse_application_requests", async () => {
  let calls = 0;
  const [internal] = await http_server((req, res) => {
    if (req.url === "/test") calls++;
    res.end("shouldn't be called");
  });
  const s = testing.state_as({ internal_url: internal, host_id: "desktop", host_name: "desktop", token: "host-token", hub_token: "" });
  const b = await fake_broker((ws) => {
    for (const msg of [
      { t: "welcome", name: "desktop", tunnel: { url: "https://desktop.example.com", token: "connector-token" } },
      { t: "req", id: 1, method: "GET", path: "/test", headers: [], body: false, ws: false },
    ]) {
      ws.send(JSON.stringify(msg));
    }
  });
  const tx = new Watch<Tunnel | null>(null);
  const error = await session(s, b, "broker-token", "desktop", "host-key", 12345, tx).then(
    () => assert.fail("the session went on"),
    (e) => e as Error,
  );
  assert.ok(error.message.includes("tried to relay application traffic"), error.message);
  assert.equal(calls, 0);
});

test("connector_watchdog_stops_the_group_when_the_servers_pipe_closes", async () => {
  const dir = testing.temp_dir();
  // Spaces and shell metacharacters must be a literal executable name.
  const bin = join(dir, "fake connector $literal");
  writeFileSync(bin, `#!/bin/sh\nprintf ready > "$(dirname "$0")/ready"\nexec sleep 600\n`);
  chmodSync(bin, 0o700);
  const { child, alive, exited } = spawn_connector(bin, "connector-token");
  cleanups.push(() => child.kill("SIGKILL"));
  for (let i = 0; i < 100 && !existsSync(join(dir, "ready")); i++) await sleep(10);
  assert.ok(existsSync(join(dir, "ready")), "literal connector path wasn't executed");
  // Models the kernel closing the server's descriptors on exec or forced exit.
  alive.destroy();
  const status = await Promise.race([exited, sleep(3000).then(() => "orphaned connector")]);
  assert.equal(status, "signal: 9 (SIGKILL)");
});

test("private_tunnel_origin_never_exposes_open_token", async () => {
  const handler = open_token("secret", false);
  const [, app] = await http_server((req, res) => {
    if ((req.url ?? "").split("?")[0] === "/api/open-token") return send(res, handler(req.headers));
    res.writeHead(404).end();
  });
  const port = await origin(app);
  for (const path of ["/api/open-token", "/api/%6fpen-token", "/api/open-token?token=x"]) {
    const [status, body] = await call("GET", `http://127.0.0.1:${port}${path}`);
    assert.ok(!(status >= 200 && status < 300), path);
    assert.ok(!JSON.stringify(body).includes("secret"), path);
  }
});

test("discovery_checks_identity_and_rejects_unsafe_or_redirected_endpoints", async () => {
  const [b] = await http_server((req, res) => {
    const m = (req.url ?? "").match(/^\/_broker\/resolve\/([^/?]+)$/);
    if (!m) return void res.writeHead(404).end();
    assert.equal(req.headers.authorization, undefined);
    const name = m[1];
    if (name === "legacy") return void res.writeHead(404).end();
    if (name === "redirect") return void res.writeHead(307, { location: "https://evil.example.com" }).end();
    const urls: Record<string, string> = {
      plain: "http://public.example.com",
      credentials: "https://user:secret@public.example.com",
      query: "https://public.example.com/?token=secret",
      path: "https://public.example.com/other",
      missing: "",
    };
    json(res, 200, { host_id: "desktop", url: urls[name] ?? "https://desktop.example.com" });
  });
  const address = (name: string) => `${b}/_broker/h/${name}`;
  assert.equal(await resolve(address("desktop"), "desktop"), "https://desktop.example.com");
  assert.equal(await resolve(address("legacy"), "desktop"), address("legacy"));
  await assert.rejects(resolve(address("desktop"), "different-host"), /different host/);
  for (const name of ["plain", "credentials", "query", "path", "missing", "redirect"]) {
    await assert.rejects(resolve(address(name), null), Error, name);
  }
  const [direct] = await http_server((_req, res) => res.writeHead(200, { "content-type": "text/html" }).end("<html>host UI</html>"));
  assert.equal(await resolve(direct, null), direct);
});

test("hub_links_resolve_before_authenticating_and_survive_a_broker_outage", async () => {
  const remote = node("remote", "remote-tok", "remote-hub");
  await serve_host(remote);
  const endpoint = remote.internal_url;
  const the_hub = node("hub", "hub-tok", "hub-join");
  await serve_host(the_hub);
  const hub_url = the_hub.internal_url;
  const [b, broker_srv] = await http_server((req, res) => {
    const path = (req.url ?? "").split("?")[0];
    if (path === "/_broker/resolve") return json(res, 200, { host_id: "hub", url: hub_url }, { "x-huntaway-broker": "1" });
    const m = path.match(/^\/_broker\/resolve\/([^/]+)$/);
    if (!m) return void res.writeHead(404).end();
    assert.equal(req.headers.authorization, undefined, "discovery received a host token");
    json(res, 200, { host_id: m[1], url: m[1] === "hub" ? hub_url : endpoint });
  });
  track(broker_srv);
  const [status, v] = await call("POST", `${hub_url}/api/hosts`, [
    ["authorization", "Bearer hub-tok"],
    ["body", JSON.stringify({ url: `${b}/_broker/h/remote`, token: "remote-tok" })],
  ]);
  assert.equal(status, 200, JSON.stringify(v));
  cleanups.push(() => the_hub.link_tasks.get("remote")?.());
  // The saved URL remains the broker URL, so a future reconnect resolves the current endpoint.
  assert.ok(db.list_links(the_hub.db())[0].url!.startsWith(b));
  const caller = node("caller", "caller-tok", "");
  api.router(caller);
  cleanups.push(hub.dial_out(caller, b, "hub-join"));
  for (let i = 0; i < 100; i++) {
    if (hub.find_link(the_hub, "remote") && hub.find_link(the_hub, "caller")) break;
    await sleep(20);
  }
  const link = hub.find_link(the_hub, "remote");
  assert.ok(link, "outbound link never connected");
  const inbound = hub.find_link(the_hub, "caller");
  assert.ok(inbound, "dial-in link never connected");
  const events = await link.open_ws("/api/host/ws");
  const frames: Array<Frame | null> = [];
  events.rx.recv((f) => frames.push(f));
  await until("an event", 5000, () => frames.length > 0);
  stop_server(broker_srv);
  assert.equal((await link.request("GET", "/api/info"))[1].host_id, "remote");
  assert.equal((await inbound.request("GET", "/api/info"))[1].host_id, "caller");
  remote.events.send({ type: "after_broker_stopped" });
  await until("the event after the broker stopped", 5000, () =>
    frames.some((f) => f?.type === "text" && f.text.includes("after_broker_stopped")),
  );
});

// ---------- relaying through the broker (legacy relay mode) ----------

test("a_websocket_stuck_writing_to_its_client_lets_go_of_its_stream", needs_broker, async () => {
  const b = await broker_with({ max_streams: 2, stall: 500 });
  // Sends messages a whole window in size, so the broker has none waiting while it writes one.
  await host_with("desktop", b, {
    ws: {
      "/test/ws-window": (ws) => {
        (async () => {
          while (await ws_send(ws, Buffer.alloc(proto.WINDOW))) {}
        })();
      },
    },
  });
  // As many clients as the host may have streams, none of them reading.
  const clients: Socket[] = [];
  for (let i = 0; i < 2; i++) clients.push(await unread_ws(b, "/test/ws-window"));
  await sleep(2000);
  assert.equal((await call("GET", `${b}/api/info?token=desktop-tok`))[0], 200);
  for (const c of clients) c.destroy();
});

test("a_websocket_stuck_on_our_server_is_cut_off_when_the_broker_closes_it", needs_broker, async () => {
  const stall = 1000;
  const b = await broker_with({ stall });
  await host_with("desktop", b, { ws: { "/test/ws-stuck": ws_sink } });
  const client = await flood_ws(b, "/test/ws-stuck");
  // Writing to our server, which reads nothing, gets stuck.
  await sleep(1500);
  assert.equal(live_ws("/test/ws-stuck"), 1);
  // The client goes. Its data waiting for the host makes no progress, so the broker closes the stream, and the host lets
  // go once it's had its grace.
  client();
  await until("the host still relays the websocket", stall * 2 + CLOSE_GRACE + 2000, () => live_ws("/test/ws-stuck") === 0);
});

test("a_websocket_stuck_on_our_server_is_cut_off_when_the_broker_goes", needs_broker, async () => {
  const b = await broker();
  const s = await host_with("desktop", b, { ws: { "/test/ws-stuck-2": ws_sink } });
  const client = await flood_ws(b, "/test/ws-stuck-2");
  await sleep(1500);
  assert.equal(live_ws("/test/ws-stuck-2"), 1);
  // Connecting again under the same name makes the broker hang up on the first connection.
  const again = dial_out(s, b, BROKER_TOKEN, "desktop", "desktop-key");
  cleanups.push(again);
  await until("the host still relays the websocket", 1000, () => live_ws("/test/ws-stuck-2") === 0);
  client();
  // (Two connections under one name take turns for good: this one goes, so the other stays.)
  again();
});

test("relays_requests_to_a_host", needs_broker, async () => {
  const b = await broker();
  await host("desktop", b);
  const auth: [string, string] = ["authorization", "Bearer desktop-tok"];
  // The host's token still guards its API.
  assert.deepEqual(await call("GET", `${b}/api/info`), [401, { error: "unauthorized" }]);
  assert.equal((await call("GET", `${b}/api/info`, [["authorization", "Bearer nope"]]))[0], 401);
  const [status, info] = await call("GET", `${b}/api/info`, [auth]);
  assert.deepEqual([status, info.host_id], [200, "desktop"]);
  assert.equal((await call("GET", `${b}/api/info?token=desktop-tok`))[0], 200);
  // Request bodies get there.
  const [s2, p] = await call("POST", `${b}/api/profiles`, [auth, ["body", `{"name": "remote"}`]]);
  assert.deepEqual([s2, p.name], [200, "remote"], JSON.stringify(p));
  const [s3, e] = await call("POST", `${b}/api/profiles`, [auth, ["body", `{"name": 5}`]]);
  assert.ok(s3 === 422 && JSON.stringify(e).includes("invalid type"), `${s3} ${JSON.stringify(e)}`);
  // By path, which hubs use.
  assert.equal((await call("GET", `${b}/_broker/h/desktop/api/info`, [auth]))[1].host_id, "desktop");
  assert.deepEqual(await call("GET", `${b}/_broker/h/laptop/api/info`, [auth]), [502, { error: "host laptop isn't connected to the broker" }]);
  assert.equal((await call("GET", `${b}/_broker/nope`))[0], 404);
  // The path goes on as it was sent: `%2F` isn't a `/`.
  const raw_path = await call("GET", `${b}/_broker/h/desktop/api/tasks/a%2Fb`, [auth]);
  assert.deepEqual(raw_path, await call("GET", `${b}/api/tasks/a%2Fb`, [auth]));
  assert.notDeepEqual(raw_path, await call("GET", `${b}/api/tasks/a/b`, [auth]));
  // The root of a host, as hubs ask for it.
  assert.deepEqual(await call("GET", `${b}/_broker/h/desktop`), await call("GET", `${b}/`));
  // The broker's own token, for hosts to connect.
  await assert.rejects(ws_client(`${b.replace("http", "ws")}/_broker/connect`, { Authorization: "Bearer desktop-tok" }), (e: any) => e.status === 401);
});

test("keeps_the_open_token_from_clients_of_the_broker", needs_broker, async () => {
  const b = await broker();
  const s = await host("desktop", b);
  // The host does hand it out, to whoever reaches it directly, but not for the broker's clients.
  assert.ok((await raw(s.internal_url, "/api/open-token")).includes("desktop-tok"));
  const marked = await call("GET", `${s.internal_url}/api/open-token`, [[VIA_BROKER, "1"]]);
  assert.deepEqual(marked, [404, { error: "no such API route: GET /api/open-token" }]);
  for (const p of ["/api/open-token", "/api/./open-token", "/api/%2e/open-token", "/api/x/../open-token", "/api/%2E%2E/api/open-token", "/api\\open-token", "/api/open-token/"]) {
    for (const path of [p, `/_broker/h/desktop${p}`]) {
      const res = await raw(b, path);
      assert.ok(!res.includes("desktop-tok"), `${path} gave the token away: ${res}`);
      assert.ok(res.startsWith("HTTP/1.1 4"), `${path}: ${res}`);
    }
  }
});

test("clients_that_stop_reading_cant_keep_others_out", needs_broker, async () => {
  const b = await broker_with({ max_streams: 8, stall: 3000 });
  const live = { n: 0 };
  await host_with("desktop", b, {
    http: (req, res) => {
      if (req.url !== "/test/big") return false;
      big_body(res, { n: 0 }, live);
      return true;
    },
  });
  // More downloads than the host may have in flight, none of them read.
  const conns: Socket[] = [];
  for (let i = 0; i < 12; i++) conns.push(await unread(b, "/test/big"));
  // Rust waits 1.5 s, for the streams' windows to fill and count as stuck (the broker's EVICT_AFTER, 1 s): the Node host
  // fills them more slowly on a busy runner, and the broker drops stalled ones only after 3 s.
  await sleep(2000);
  // A request still gets through, in place of one of them, at once.
  const started = Date.now();
  assert.equal((await call("GET", `${b}/api/info?token=desktop-tok`))[0], 200);
  assert.ok(Date.now() - started < 1000);
  // And once they've stalled for long enough, the host stops serving every one of them.
  for (let i = 0; i < 100; i++) {
    if (live.n === 0) {
      for (const c of conns) c.destroy();
      return;
    }
    await sleep(100);
  }
  assert.fail(`the host is still serving ${live.n} downloads nobody reads`);
});

test("a_websocket_that_isnt_read_holds_up_only_itself", needs_broker, async () => {
  const b = await broker();
  let flooded = 0;
  await host_with("desktop", b, {
    ws: {
      // Never reads what it's sent.
      "/test/ws-sink": ws_sink,
      // Sends 128 MiB as fast as it's let.
      "/test/ws-flood": (ws) => {
        (async () => {
          for (let i = 0; i < 2048; i++) {
            if (!(await ws_send(ws, Buffer.alloc(64 << 10)))) return;
            flooded += 64 << 10;
          }
        })();
      },
    },
  });
  const ws = b.replace("http", "ws");
  // Up: the client sends 128 MiB to a websocket on the host that reads none of it.
  const up = await ws_client(`${ws}/test/ws-sink`);
  let uploaded = 0;
  (async () => {
    for (let i = 0; i < 2048; i++) {
      if (!(await ws_send(up, Buffer.alloc(64 << 10)))) return;
      uploaded += 64 << 10;
    }
  })();
  // Down: the host's websocket sends 128 MiB to a client that reads none of it.
  const down = await unread_ws(b, "/test/ws-flood");
  await sleep(2000);
  assert.ok(uploaded < 48 * MIB, `${uploaded / MIB} MiB of 128 went towards a websocket that reads none of it`);
  assert.ok(flooded < 48 * MIB, `the host's websocket sent ${flooded / MIB} MiB of 128 towards a client that reads none of it`);
  assert.equal((await call("GET", `${b}/api/info?token=desktop-tok`))[0], 200);
  up.terminate();
  down.destroy();
});

test("a_client_that_doesnt_read_holds_up_only_its_own_download", needs_broker, async () => {
  const b = await broker();
  const sent = { n: 0 };
  await host_with("desktop", b, {
    http: (req, res) => {
      if (req.url !== "/test/big") return false;
      big_body(res, sent);
      return true;
    },
  });
  // Asks for it, and never reads the response.
  const c = await unread(b, "/test/big");
  await sleep(1500);
  // What the host could send is the window plus what the sockets in between hold, not all of it.
  assert.ok(sent.n < 48 * MIB, `the host sent ${sent.n / MIB} MiB of 128 to a client that reads none of it`);
  // Other requests still go through.
  assert.equal((await call("GET", `${b}/api/info?token=desktop-tok`))[0], 200);
  c.destroy();
});

test("a_host_that_doesnt_read_holds_up_only_its_own_upload", needs_broker, async () => {
  const b = await broker();
  // Takes the body, and never reads it.
  await host_with("desktop", b, {
    http: (req) => {
      if (req.url !== "/test/stall") return false;
      req.pause();
      return true;
    },
  });
  let sent = 0;
  const upload = http_request(`${b}/test/stall`, { method: "POST", agent: false });
  upload.on("error", () => {});
  cleanups.push(() => upload.destroy());
  (async () => {
    for (let i = 0; i < 2048 && !upload.destroyed; i++) {
      sent += 64 << 10;
      if (!upload.write(Buffer.alloc(64 << 10))) await new Promise((r) => (upload.once("drain", r), upload.once("close", r)));
    }
  })();
  await sleep(1500);
  assert.ok(sent < 48 * MIB, `the broker took ${sent / MIB} MiB of 128 for a host that reads none of it`);
  assert.equal((await call("GET", `${b}/api/info?token=desktop-tok`))[0], 200);
  upload.destroy();
});

test("picks_a_host_by_header_cookie_or_path", needs_broker, async () => {
  const b = await broker();
  await host("desktop", b);
  // The only host gets the requests that don't pick one.
  assert.equal((await call("GET", `${b}/api/info?token=desktop-tok`))[1].host_id, "desktop");
  await host("laptop", b);
  const [status, err] = await call("GET", `${b}/api/info?token=desktop-tok`);
  assert.ok(status === 502 && err.error.includes("several hosts"), JSON.stringify(err));
  assert.equal((await call("GET", `${b}/api/info?token=laptop-tok`, [["x-huntaway-host", "laptop"]]))[1].host_id, "laptop");
  assert.equal((await call("GET", `${b}/api/info?token=desktop-tok`, [["cookie", "a=b; huntaway_host=desktop"]]))[1].host_id, "desktop");
  assert.equal((await call("GET", `${b}/_broker/h/laptop/api/info?token=laptop-tok`))[1].host_id, "laptop");
  // Opening /_broker/use/<name> sets the cookie, and keeps ?token= for the board.
  const res = await new Promise<IncomingMessage>((r, j) => http_request(`${b}/_broker/use/laptop?token=x`, { agent: false }, r).on("error", j).end());
  res.resume();
  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.location, "/?token=x");
  assert.ok(String(res.headers["set-cookie"]?.[0]).startsWith("huntaway_host=laptop;"));
});

test("relays_websockets", needs_broker, async () => {
  const b = await broker();
  const s = await host("desktop", b);
  const ws = b.replace("http", "ws");
  await assert.rejects(ws_client(`${ws}/api/host/ws`), (e: any) => e.status === 401);
  const events = await ws_client(`${ws}/api/host/ws?token=desktop-tok`);
  const got: any[] = [];
  events.on("message", (m, binary) => {
    if (!binary) got.push(JSON.parse(m.toString()));
  });
  events.resume();
  await until("hello", 5000, () => got.length > 0);
  assert.deepEqual(got[0], { type: "hello" });
  s.events.send({ type: "test", n: 1 });
  await until("the event", 5000, () => got.length > 1);
  assert.deepEqual(got[1], { type: "test", n: 1 });
});

test("links_a_host_to_a_hub_through_the_broker", needs_broker, async () => {
  const b = await broker();
  // The hub is behind the broker, and the host dials in to it there (`--hub <broker>/_broker/h/<hub>`).
  const the_hub = await host("desktop", b);
  const laptop = node("laptop", "laptop-tok", "");
  api.router(laptop);
  cleanups.push(hub.dial_out(laptop, `${b}/_broker/h/desktop`, "desktop-hub"));
  for (let i = 0; i < 100; i++) {
    const link = hub.find_link(the_hub, "laptop");
    if (link) {
      const [status, info] = await link.request("GET", "/api/info");
      assert.deepEqual([status, info.host_id], [200, "laptop"]);
      return;
    }
    await sleep(50);
  }
  assert.fail("the host didn't link to the hub");
});

test("blocks_the_open_token_however_its_written", () => {
  const base = "http://127.0.0.1:7878";
  for (const p of [
    "/api/open-token",
    "/api/open-token?x=1",
    "/api/open-token/",
    "/api/./open-token",
    "/api/%2e/open-token",
    "/api/%2E%2E/api/open-token",
    "/api/x/../open-token",
    "/api/x/%2e%2e/open-token",
    "/api\\open-token",
    "//api//open-token",
    "/api/%6Fpen-token",
    "/api/%252e/open-token",
    "/x/../../api/open-token",
    "/API/Open-Token",
  ]) {
    assert.equal(local_url(base, p), null, p);
  }
  // Not on our server.
  for (const p of ["@example.com/", "", "?x=1", "x"]) assert.equal(local_url(base, p), null, JSON.stringify(p));
  assert.equal(local_url(base, "/api/info?a=1")!.href, "http://127.0.0.1:7878/api/info?a=1");
  assert.equal(local_url(base, "/")!.href, "http://127.0.0.1:7878/");
  // Escapes go on as they were.
  assert.equal(local_url(base, "/api/tasks/a%2Fb")!.href, "http://127.0.0.1:7878/api/tasks/a%2Fb");
  assert.equal(local_url(base, "//example.com/x")!.hostname, "127.0.0.1");
});
