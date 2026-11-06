// Port of server/src/hosts/hub/tests.rs. (The broker in `a_host_dialled_in_through_a_broker_over_a_dead_connection_reconnects`
// is the Rust one, run as a process: see hosts/broker/test_broker.ts.)
import { afterAll, test, vi } from "vite-plus/test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createConnection, createServer as createTcpServer, type Socket } from "node:net";
import { WebSocketServer } from "ws";
import * as testing from "../../testing.ts";
import * as db from "../../db.ts";
import * as api from "../../api.ts";
import { ApiError, readBody, send } from "../../http.ts";
import type { AppState } from "../../state.ts";
import { err_str, now, sleep } from "../../util.ts";
import * as relay from "../relay.ts";
import * as release from "../../update/release.ts";
import * as broker from "../broker.ts";
import * as test_broker from "../broker/test_broker.ts";
import { API_VERSION, VERSION } from "../proto.ts";
import { read_jsonl } from "../../threads/examples.ts";
import * as store from "../../threads/store.ts";
import * as live from "../../threads/live.ts";
import * as write from "../../threads/write.ts";
import { dial_out, find_link, host_request, hub_url, link_http, list_hosts, spawn_outbound, TICK_MS, tunnel_to, ws, type LinkConn } from "../hub.ts";

relay.test_timing();

/** What each test leaves running (servers, dialling loops), stopped when the file's tests end. */
const cleanups: Array<() => void> = [];
afterAll(() => {
  for (const f of cleanups.splice(0)) f();
});

/** `call` of api/tests.rs: a request to `s`'s router with its token (or `token`). */
async function call(s: AppState, method: string, path: string, token = s.token): Promise<[number, any]> {
  if (!s.local_router) api.router(s);
  const a = await api.dispatch(s, api.makeReq(method, path, { authorization: `Bearer ${token}`, "content-type": "application/json" }, Buffer.alloc(0)));
  const text = a.body.toString();
  try {
    return [a.status, JSON.parse(text)];
  } catch {
    return [a.status, text];
  }
}

/** Serve `handler` on a free port; returns its URL. */
async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
  const srv = createServer(handler);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  cleanups.push(() => {
    srv.closeAllConnections();
    srv.close();
  });
  return `http://127.0.0.1:${(srv.address() as any).port}`;
}

const json = (res: ServerResponse, status: number, v: any) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(v));

/**
 * Hosts from before the JSON 404, as axum served them: `/api/profiles` (GET) and `/api/permissions/{id}` (POST), a known
 * route without the method an empty 405, and an unknown route an empty 404; or with a UI, index.html for a GET or HEAD
 * and an empty 405 for other methods.
 */
function old_host(ui: boolean) {
  return (req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? "").split("?")[0];
    const get = req.method === "GET" || req.method === "HEAD";
    if (path === "/api/profiles") return get ? json(res, 200, []) : void res.writeHead(405).end();
    if (/^\/api\/permissions\/[^/]+$/.test(path)) return req.method === "POST" ? json(res, 200, {}) : void res.writeHead(405).end();
    if (!ui) return void res.writeHead(404).end();
    if (get) return void res.writeHead(200, { "content-type": "text/html" }).end("<!doctype html>");
    res.writeHead(405).end();
  };
}

test("the_uis_events_socket_is_sent_a_tick_that_isnt_an_event", (t) => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  t.onTestFinished(() => void vi.useRealTimers());
  const s = testing.state();
  const seen: any[] = [];
  s.events.subscribe((v) => seen.push(v));
  s.hub_events.subscribe((v) => seen.push(v));
  const sent: string[] = [];
  const on: Record<string, () => void> = {};
  const socket = { OPEN: 1, readyState: 1, bufferedAmount: 0, send: (m: string) => sent.push(m), on: (ev: string, f: () => void) => (on[ev] = f) };
  ws(s, {} as any, socket as any);
  const types = () => sent.map((m) => JSON.parse(m).type);
  assert.deepEqual(types(), ["hello"]);
  vi.advanceTimersByTime(TICK_MS - 1);
  assert.deepEqual(types(), ["hello"]);
  vi.advanceTimersByTime(1);
  s.hub_events.send({ type: "task", task: {} });
  vi.advanceTimersByTime(TICK_MS);
  assert.deepEqual(types(), ["hello", "tick", "task", "tick"]);
  // It's the socket's own: nothing else that follows the events (push, Telegram, the event log) has it.
  assert.deepEqual(
    seen.map((v) => v.type),
    ["task"],
  );
  // Closed: no more.
  on.close!();
  vi.advanceTimersByTime(TICK_MS * 3);
  assert.equal(sent.length, 4);
});

test("older_hosts_unknown_routes_are_json_404s_through_the_proxy", async () => {
  const s = testing.state();
  link_http(s, "old", await listen(old_host(false)), 0);
  link_http(s, "old-ui", await listen(old_host(true)), 0);
  api.router(s);
  for (const host of ["old", "old-ui"]) {
    assert.deepEqual(await call(s, "GET", `/api/h/${host}/profiles`), [200, []], host);
    assert.deepEqual(await call(s, "GET", `/api/h/${host}/claude-configs?x=1`), [404, { error: "no such API route: GET /api/claude-configs" }], host);
    assert.deepEqual(await call(s, "POST", `/api/h/${host}/claude-configs?x=1`), [404, { error: "no such API route: POST /api/claude-configs" }], host);
    // A known route without this method stays a 405.
    assert.deepEqual(await call(s, "DELETE", `/api/h/${host}/profiles`), [405, { error: "no such API route: DELETE /api/profiles" }], host);
    for (const method of ["GET", "DELETE"]) {
      const missing = { error: `no such API route: ${method} /api/permissions/p1` };
      assert.deepEqual(await call(s, method, `/api/h/${host}/permissions/p1`), [405, missing], `${method} on ${host}`);
    }
  }

  // The hub's own calls to a host say it needs an update, for older hosts and this one alike.
  for (const host of ["old", "old-ui", "h"]) {
    for (const method of ["GET", "POST"]) {
      await assert.rejects(host_request(s, host, method, "/api/nope"), (e: any) => {
        assert.equal(e.message, "this host's version doesn't support that yet; update it", `${method} on ${host}`);
        return true;
      });
    }
  }
  // Other 404s keep their message.
  await assert.rejects(host_request(s, "h", "GET", "/api/tasks/missing"), (e: any) => {
    assert.ok(e instanceof ApiError);
    assert.equal(e.status, 404);
    assert.ok(!e.message.includes("update it"), e.message);
    return true;
  });
});

test("update_sends_the_hubs_commit_and_version", async () => {
  const sent: any[] = [];
  const host = () =>
    listen(async (req, res) => {
      if (req.url === "/api/admin/update" && req.method === "POST") {
        sent.push(JSON.parse((await readBody(req, 1 << 20)).toString()));
        return json(res, 200, { ok: true });
      }
      res.writeHead(404).end();
    });
  const hub = (commit: string | null, rel: boolean) => {
    const meta = testing.meta();
    meta.running_commit = commit;
    meta.release = rel ? release.Config_from_env("o/r") : null;
    return testing.state_with(meta);
  };
  // A hub deployed without a checkout sends its commit, and its version for a release host.
  let s = hub("abc", false);
  link_http(s, "host", await host(), API_VERSION);
  assert.deepEqual(await call(s, "POST", "/api/hosts/host/update"), [200, { ok: true }]);
  // One that runs a release only has its version.
  s = hub(null, true);
  link_http(s, "host", await host(), API_VERSION);
  assert.equal((await call(s, "POST", "/api/hosts/host/update"))[0], 200);
  assert.deepEqual(sent, [{ commit: "abc", version: VERSION }, { version: VERSION }]);
  // Neither: it can't say what to update to.
  s = hub(null, false);
  link_http(s, "host", await host(), API_VERSION);
  const [code, v] = await call(s, "POST", "/api/hosts/host/update");
  assert.equal(code, 400);
  assert.ok(v.error.includes("set IA_COMMIT"), JSON.stringify(v));
  assert.equal(sent.length, 2);
  // The hosts list says how each host updates.
  s = hub(null, true);
  assert.equal((await call(s, "GET", "/api/hosts"))[1][0].updates_from, "releases");
});

// HA-49: the UI took any 401 from its own host as the board's token being wrong, and ignored the rest, even while it
// didn't know yet which host was its own. Now only the board's token being wrong is a 401.
test("only_the_boards_own_token_is_a_401_through_the_proxy", async () => {
  const s = testing.state();
  // A host whose token has changed since it was linked.
  const stale = await listen((req, res) => (req.url === "/api/profiles" ? json(res, 401, { error: "unauthorized" }) : void res.writeHead(404).end()));
  link_http(s, "stale", stale, 0);
  api.router(s);
  const err = { error: "host stale didn't accept this hub's token for it; link it again" };
  assert.deepEqual(await call(s, "GET", "/api/h/stale/profiles"), [502, err]);
  assert.equal((await call(s, "GET", "/api/h/h/profiles"))[0], 200);
  // The hub's own calls to it too.
  await assert.rejects(host_request(s, "stale", "GET", "/api/profiles"), (e: any) => {
    assert.deepEqual([e.status, e.message], [502, err.error]);
    return true;
  });
  for (const host of ["h", "stale"]) assert.equal((await call(s, "GET", `/api/h/${host}/profiles`, "wrong"))[0], 401, host);
});

function node(id: string, name: string): AppState {
  return testing.state_as({ host_id: id, host_name: name, token: `${id}-tok`, hub_token: `${id}-hub`, internal_url: "" });
}

/** Serve a node's API (its requests and websockets, as main.ts does), returning its address (`127.0.0.1:<port>`). */
async function serve(s: AppState): Promise<string> {
  api.router(s);
  const srv: Server = createServer(async (req, res) => {
    const found = s.local_router!.find((req.url ?? "/").split("?")[0].slice(4));
    const raw = await readBody(req, found?.route.limit ?? 2 << 20);
    send(res, await api.dispatch(s, api.makeReq(req.method ?? "GET", req.url ?? "/", req.headers, raw)));
  });
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  srv.on("upgrade", (req, socket, head) => {
    const url = req.url ?? "/";
    const path = url.split("?")[0];
    const query = url.includes("?") ? url.slice(url.indexOf("?") + 1) : "";
    const found = s.local_router!.find(path.slice(4));
    if (!found?.route.ws || (found.route.auth && !api.authorized(s, req.headers, query))) return void socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
    const r = api.makeReq("GET", url, req.headers, Buffer.alloc(0));
    r.params = found.params;
    wss.handleUpgrade(req, socket, head, (ws) => found.route.ws!(s, r, ws));
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  cleanups.push(() => {
    for (const c of wss.clients) c.terminate();
    srv.closeAllConnections();
    srv.close();
  });
  return `127.0.0.1:${(srv.address() as any).port}`;
}

/**
 * A TCP proxy to `to`. `freeze` makes the connections it has so far stop passing anything on, either way, without
 * closing them: what a NAT mapping that expired, or a laptop that went to sleep, does.
 */
async function proxy(to: string) {
  const conns: Array<{ frozen: boolean; sockets: Socket[] }> = [];
  const [host, port] = [to.split(":")[0], Number(to.split(":")[1])];
  const srv = createTcpServer((a) => {
    const b = createConnection(port, host);
    const c = { frozen: false, sockets: [a, b] };
    conns.push(c);
    const pipe = (from: Socket, dest: Socket) => {
      from.on("data", (d) => {
        if (!c.frozen) dest.write(d);
      });
      // Nor does a frozen connection pass on that one end closed.
      from.on("end", () => {
        if (!c.frozen) dest.end();
      });
      from.on("error", () => {});
    };
    pipe(a, b);
    pipe(b, a);
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  cleanups.push(() => {
    for (const c of conns) for (const s of c.sockets) s.destroy();
    srv.close();
  });
  return {
    addr: `127.0.0.1:${(srv.address() as any).port}`,
    freeze: () => {
      for (const c of conns) c.frozen = true;
    },
  };
}

/** Wait (up to 20s) for `f` to give something. */
async function until<T>(what: string, f: () => T | null | undefined | false): Promise<T> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const v = f();
    if (v) return v;
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
    await sleep(50);
  }
}

function outbound_link(id: string, url: string, token: string): db.Link {
  const l: any = { id, name: id, mode: "outbound", url, ssh: null, last_seen: null, created_at: now() };
  Object.defineProperty(l, "token", { value: token, enumerable: false });
  return l;
}

/** `dial_out`, stopped when the file's tests end. */
function dial(s: AppState, hub: string, token: string) {
  cleanups.push(dial_out(s, hub, token));
}

/** `spawn_outbound`, stopped when the file's tests end. */
function outbound(s: AppState, link: db.Link) {
  spawn_outbound(s, link);
  cleanups.push(() => s.link_tasks.get(link.id)?.());
}

test("a_host_dialled_in_over_a_dead_connection_reconnects", async () => {
  const [hub, host] = [node("hub", "hub"), node("host", "laptop")];
  api.router(host);
  const p = await proxy(await serve(hub));
  dial(host, `http://${p.addr}`, "hub-hub");
  const first = await until("the host to dial in", () => find_link(hub, "host"));
  assert.equal((await first.request("GET", "/api/info"))[0], 200);

  // Both ends notice that they hear nothing, and the host dials in again. A request waiting on the dead connection fails
  // then, rather than after the request timeout.
  p.freeze();
  const waiting = await Promise.race([
    first.request("GET", "/api/info").then(
      () => null,
      (e) => e,
    ),
    sleep(relay.SILENCE * 3).then(() => "timeout"),
  ]);
  assert.notEqual(waiting, "timeout", "the request still waits");
  assert.ok(err_str(waiting).includes("disconnected"), err_str(waiting));
  const second = await until("the host to dial in again", () => {
    const l = find_link(hub, "host");
    return l !== first && l;
  });
  assert.equal((await second.request("GET", "/api/info"))[0], 200);
  // Pings keep it connected meanwhile.
  await sleep(relay.SILENCE * 2);
  assert.equal(find_link(hub, "host"), second);
});

test("a_host_dialled_over_a_dead_connection_is_dialled_again", async () => {
  const [hub, host] = [node("hub", "hub"), node("host", "laptop")];
  const p = await proxy(await serve(host));
  const url = `http://${p.addr}`;
  db.upsert_link(hub.db(), "host", "laptop", "outbound", url, "host-tok");
  outbound(hub, outbound_link("host", url, "host-tok"));
  const first = await until("the hub to connect", () => find_link(hub, "host"));
  const hosts = list_hosts(hub);
  assert.ok(typeof hosts[1].last_message_at === "string" && hosts[1].last_message_at.endsWith("Z"), JSON.stringify(hosts));

  p.freeze();
  await until("the hub to give up on it", () => find_link(hub, "host") === null);
  const second: LinkConn = await until("the hub to connect again", () => find_link(hub, "host"));
  assert.notEqual(first, second);
  await sleep(relay.SILENCE * 2);
  assert.equal(find_link(hub, "host"), second);
});

test("a_host_lets_go_of_a_hub_that_went_without_closing", async () => {
  // HA-262: a hub that dials a host takes its agents' board tool calls (an up-link). One that went without closing (a
  // laptop that slept) kept them waiting for its answers until they timed out (5 minutes each).
  const [hub, host] = [node("hub", "hub"), node("host", "laptop")];
  const p = await proxy(await serve(host));
  const url = `http://${p.addr}`;
  db.upsert_link(hub.db(), "host", "laptop", "outbound", url, "host-tok");
  outbound(hub, outbound_link("host", url, "host-tok"));
  const up = await until("the hub to say hello", () => host.uplinks.get("hub"));
  // Pings keep it meanwhile.
  await sleep(relay.SILENCE * 2);
  assert.equal(host.uplinks.get("hub"), up);
  // The hub goes, and doesn't come back.
  p.freeze();
  hub.link_tasks.get("host")?.();
  await until("the host to let go of the hub", () => !host.uplinks.has("hub"));
});

test("a_host_dialled_in_through_a_broker_over_a_dead_connection_reconnects", test_broker.needs_broker(), async () => {
  const BROKER_TOKEN = "broker-token-0123456789";
  const b = await test_broker.start_test_broker(BROKER_TOKEN, {}, cleanups);
  // The hub is on the broker, which it reaches its own API from.
  const hub = node("hub", "hub");
  hub.internal_url = `http://${await serve(hub)}`;
  cleanups.push(broker.dial_out(hub, b, BROKER_TOKEN, "hub", "hub-key"));

  // The host dials the hub at the broker, over a connection that dies.
  const host = node("host", "laptop");
  api.router(host);
  const p = await proxy(b.replace("http://", ""));
  dial(host, `http://${p.addr}/_broker/h/hub`, "hub-hub");
  const first = await until("the host to dial in", () => find_link(hub, "host"));
  assert.equal((await first.request("GET", "/api/info"))[0], 200);

  // The hub's relay to the broker answers its websocket pings, but the host doesn't answer its `Down::Ping`.
  p.freeze();
  const second = await until("the host to dial in again", () => {
    const l = find_link(hub, "host");
    return l !== first && l;
  });
  assert.equal((await second.request("GET", "/api/info"))[0], 200);
});

test("a_host_added_again_drops_its_old_connection", async () => {
  const [hub, host] = [node("hub", "hub"), node("host", "laptop")];
  const addr = await serve(host);
  outbound(hub, outbound_link("host", `http://${addr}`, "host-tok"));
  await until("the hub to connect", () => find_link(hub, "host"));
  // Added again at a URL where nothing answers: it's no longer connected.
  outbound(hub, outbound_link("host", "http://127.0.0.1:1", "host-tok"));
  await until("the old connection to go", () => find_link(hub, "host") === null);
});

test("a_host_dialling_in_keeps_its_link_and_a_second_one_is_refused", async () => {
  const [hub, host] = [node("hub", "hub"), node("host", "laptop")];
  api.router(host);
  // The hub also dials this host (it isn't up at the moment).
  db.upsert_link(hub.db(), "host", "laptop", "outbound", "http://127.0.0.1:1", "host-tok");
  const url = `http://${await serve(hub)}`;
  dial(host, url, "hub-hub");
  const first = await until("the host to dial in", () => find_link(hub, "host"));
  assert.equal(first.mode, "inbound");
  const link = db.get_link(hub.db(), "host")!;
  assert.deepEqual([link.mode, link.url], ["outbound", "http://127.0.0.1:1"]);

  // Another host with the same id is turned away, and the first stays connected.
  const twin = node("host", "twin");
  const refused = await Promise.race([
    tunnel_to(twin, url, "hub-hub").then(
      () => null,
      (e) => e,
    ),
    sleep(5000).then(() => "timeout"),
  ]);
  assert.notEqual(refused, "timeout", "the twin's tunnel stays up");
  assert.ok(err_str(refused).includes("already connected"), err_str(refused));
  assert.equal(find_link(hub, "host"), first);
  assert.equal(first.name, "laptop");

  // A host seen for the first time is noted as dialling in.
  const other = node("other", "desktop");
  api.router(other);
  dial(other, url, "hub-hub");
  await until("the other host to dial in", () => find_link(hub, "other"));
  assert.equal(db.get_link(hub.db(), "other")!.mode, "inbound");
});

test("the_join_command_dials_the_hub_where_the_browser_reached_it", () => {
  const s = node("hub", "hub");
  assert.equal(hub_url(s, { host: "box:7878" }), "http://box:7878");
  const proxied = { host: "127.0.0.1:7878", "x-forwarded-host": "board.example.com, inner", "x-forwarded-proto": "https" };
  assert.equal(hub_url(s, proxied), "https://board.example.com");
  // Through the broker, at the broker, once it's known.
  const brokered = { host: "127.0.0.1:7878", "x-huntaway-via-broker": "1" };
  assert.equal(hub_url(s, brokered), "http://127.0.0.1:7878");
  s.broker_url = "https://broker.example.com/_broker/h/hub";
  assert.equal(hub_url(s, brokered), "https://broker.example.com/_broker/h/hub");
});

// HA-215: a linked host's thread kept as items, and its live thread events, through the hub, over either kind of link.
test("a_linked_hosts_thread_and_its_events_are_relayed", async () => {
  for (const kind of ["outbound", "inbound"]) {
    const [hub, host] = [node("hub", "hub"), node("host", "laptop")];
    // The thread is the spec's example, not made from messages: with the setting (on by default), opening a task without
    // items would rebuild it from its messages.
    db.set_setting(host.db(), "thread_items", "false");
    if (kind === "outbound") {
      const url = `http://${await serve(host)}`;
      db.upsert_link(hub.db(), "host", "laptop", "outbound", url, "host-tok");
      outbound(hub, outbound_link("host", url, "host-tok"));
    } else {
      api.router(host);
      dial(host, `http://${await serve(hub)}`, "hub-hub");
    }
    await until(`the ${kind} link`, () => find_link(hub, "host"));
    const p = db.insert_profile(host.db(), "personal", [], null);
    const t = db.insert_task(host.db(), {
      profile_id: p.id,
      project_id: null,
      kind: "task",
      title: "t",
      description: "",
      status: "in_progress",
      use_worktree: false,
    });
    const events = read_jsonl("thread.events.jsonl").filter((e: any) => e.type !== "delta" && e.type !== "thread.updated");
    store.append(
      host.db(),
      t.id,
      events.map(({ thread_id: _t, seq: _s, ...e }: any) => e),
    );

    // Its routes, through the hub's path for the host.
    const [status, state] = await call(hub, "GET", `/api/h/host/tasks/${t.id}/thread?limit=8`);
    assert.equal(status, 200, `${kind}: ${JSON.stringify(state)}`);
    assert.deepEqual(state, await call(host, "GET", `/api/tasks/${t.id}/thread?limit=8`).then(([, v]) => v), kind);
    const [, page] = await call(hub, "GET", `/api/h/host/tasks/${t.id}/thread/events?after=20&limit=2`);
    assert.deepEqual([page.events.map((e: any) => e.seq), page.more], [[21, 22], true], kind);
    const body = Buffer.from(JSON.stringify({ type: "set_options", model: "opus" }));
    const headers = { authorization: `Bearer ${hub.token}`, "content-type": "application/json" };
    const a = await api.dispatch(hub, api.makeReq("POST", `/api/h/host/tasks/${t.id}/thread/commands`, headers, body));
    assert.equal(a.status, 200, `${kind}: ${a.body}`);
    assert.equal(db.get_task(host.db(), t.id)!.model, "opus", kind);
    assert.equal((await call(hub, "GET", `/api/h/host/tasks/nope/thread`))[0], 404, kind);

    // Its live events, tagged with its id.
    const got: any[] = [];
    const off = hub.hub_events.subscribe((v) => {
      if (v?.type === "thread_event" || v?.type === "thread_resync") got.push(v);
    });
    const saved = store.append(host.db(), t.id, [{ type: "item.added", item: { id: "a9", type: "assistant_message", text: "" } }]);
    live.send_events(host, t.id, saved);
    write.stream_text(host, t.id, "Hi");
    live.send_resync(host, t.id);
    await until(`${kind}: the events at the hub`, () => got.length >= 3);
    off();
    assert.deepEqual(
      got.map((v) => [v.type, v.host_id, v.task_id, v.event?.type ?? null, v.event?.seq ?? null]),
      [
        ["thread_event", "host", t.id, "item.added", saved[0].seq],
        ["thread_event", "host", t.id, "delta", saved[0].seq],
        ["thread_resync", "host", t.id, null, null],
      ],
      kind,
    );
    for (const f of cleanups.splice(0)) f();
  }
});
