// The helpers of server/src/hosts/uplink/tests.rs that other tests use too (agent/assistant/tests.rs): nodes with their
// own ids, their API, and a hub linked to a host by URL. What they start is stopped when the test file's tests end.
import { afterAll } from "vite-plus/test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { WebSocketServer } from "ws";
import * as testing from "../../testing.ts";
import * as db from "../../db.ts";
import * as api from "../../api.ts";
import { readBody, send } from "../../http.ts";
import type { AppState } from "../../state.ts";
import { background, sleep } from "../../util.ts";
import * as hub from "../hub.ts";

/** What the tests leave running (servers, links), stopped when the file's tests end. */
const cleanups: Array<() => void> = [];
afterAll(() => {
  for (const f of cleanups.splice(0)) f();
});

/** Run `f` when the file's tests end. */
export function on_end(f: () => void) {
  cleanups.push(f);
}

export function node(id: string, name: string): AppState {
  return testing.state_as({ host_id: id, host_name: name, token: `${id}-tok`, hub_token: `${id}-hub`, internal_url: "" });
}

/** Serve a node's API (its requests and websockets, as main.ts does), returning its URL. */
export async function serve(s: AppState): Promise<string> {
  api.router(s);
  const srv: Server = createServer((req, res) =>
    background("serving a test node's API", (async () => {
      const found = s.local_router!.find((req.url ?? "/").split("?")[0].slice(4));
      const raw = await readBody(req, found?.route.limit ?? 2 << 20);
      send(res, await api.dispatch(s, api.makeReq(req.method ?? "GET", req.url ?? "/", req.headers, raw)));
    })()),
  );
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  srv.on("upgrade", (req, socket, head) => {
    const url = req.url ?? "/";
    const path = url.split("?")[0];
    const query = url.includes("?") ? url.slice(url.indexOf("?") + 1) : "";
    const found = s.local_router!.find(path.slice(4));
    if (!found?.route.ws || (found.route.auth && !api.authorized(s, req.headers, query))) return void socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
    const r = api.makeReq("GET", url, req.headers, Buffer.alloc(0));
    r.params = found.params;
    if (found.route.pre) {
      try {
        found.route.pre(s, r);
      } catch {
        return void socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
      }
    }
    wss.handleUpgrade(req, socket, head, (ws) => found.route.ws!(s, r, ws));
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  cleanups.push(() => {
    for (const c of wss.clients) c.terminate();
    srv.closeAllConnections();
    srv.close();
  });
  return `http://127.0.0.1:${(srv.address() as any).port}`;
}

/** Wait (up to 10s) for `f` to give something. */
export async function until<T>(what: string, f: () => T | null | undefined | false): Promise<T> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const v = f();
    if (v) return v;
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
    await sleep(20);
  }
}

/** A request with a JSON body to a node's API, as its own UI makes it. */
export async function call_api(s: AppState, method: string, path: string, body?: any): Promise<[number, any]> {
  if (!s.local_router) api.router(s);
  const headers: Record<string, string> = { authorization: `Bearer ${s.token}`, "content-type": "application/json" };
  const raw = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
  const a = await api.dispatch(s, api.makeReq(method, path, headers, raw));
  const text = a.body.toString("utf8");
  try {
    return [a.status, JSON.parse(text)];
  } catch {
    return [a.status, null];
  }
}

/** Follow `link` from `s`, as `spawn_outbound` does for an outbound link, until the file's tests end. */
export function follow(s: AppState, link: db.Link) {
  hub.spawn_outbound(s, link);
  cleanups.push(() => s.link_tasks.get(link.id)?.());
}

/** The hub links the host by URL (as an SSH link does, through its tunnel), and the host's ws says who the hub is. */
export async function link_by_url(hub_s: AppState, host: AppState) {
  const url = await serve(host);
  const link = db.upsert_link(hub_s.db(), host.host_id, host.host_name, "outbound", url, host.token);
  follow(hub_s, link);
  await until("the link", () => hub.find_link(hub_s, host.host_id));
  await until("the up-link", () => host.uplinks.get(hub_s.host_id));
}
