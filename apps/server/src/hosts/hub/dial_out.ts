// Port of server/src/hosts/hub/dial_out.rs: dialling out: this node as a host of someone else's hub, serving the
// requests it tunnels.
import type { AppState } from "../../state.ts";
import * as api from "../../api.ts";
import { background, err_str } from "../../util.ts";
import { API_COMPAT, API_VERSION, PROTOCOL, ToolAnswer_from, VERSION } from "../proto.ts";
import * as uplink from "../uplink.ts";
import * as relay from "../relay.ts";
import { Chan, Close, type Frame } from "../relay.ts";
import * as broker from "../broker.ts";
import type { Down, Up } from "../hub.ts";
import { REFUSED } from "./inbound.ts";

/** Keep a tunnel open to `hub`, answering its requests from our own API. Returns the function that stops it. */
export function dial_out(s: AppState, hub: string, token: string): () => void {
  let stopped = false;
  let abort: (() => void) | null = null;
  background(
    "keeping the tunnel to a hub open",
    (async () => {
      let backoff = 1;
      while (!stopped) {
        try {
          await tunnel_to(s, hub, token, (a) => (abort = a));
          backoff = 1;
        } catch (e) {
          if (!stopped) console.error(`hub ${hub}: ${err_str(e)}`);
        }
        if (stopped) break;
        await new Promise<void>((r) => {
          const t = setTimeout(r, backoff * 1000);
          abort = () => {
            clearTimeout(t);
            r();
          };
        });
        backoff = Math.min(backoff * 2, 30);
      }
    })(),
  );
  return () => {
    stopped = true;
    abort?.();
  };
}

export async function tunnel_to(s: AppState, hub: string, token: string, on_abort: (abort: () => void) => void = () => {}): Promise<void> {
  hub = await broker.resolve(hub, null);
  const url = `${hub.replace(/\/+$/, "").replace("http", "ws")}/api/hub/connect`;
  const ws = await relay.open(url, { Authorization: `Bearer ${token}` });
  const streams: HubStreams = new Map();
  const up: TunnelUplink = { registered: null };
  return new Promise<void>((resolve, reject) => {
    let finished = false;
    const send = (m: Up): boolean => {
      if (finished || ws.readyState !== ws.OPEN) return false;
      ws.send(JSON.stringify(m));
      return true;
    };
    const finish = (err: Error | null) => {
      if (finished) return;
      finished = true;
      clearInterval(ping);
      clearTimeout(quiet);
      off();
      up.registered?.drop();
      up.registered = null;
      // Closing the channels closes the relayed websockets.
      for (const c of streams.values()) c.close();
      streams.clear();
      ws.terminate();
      if (err) reject(err);
      else resolve();
    };
    on_abort(() => finish(null));
    send({ t: "hello", host_id: s.host_id, name: s.host_name, version: VERSION, protocol: PROTOCOL, api_version: API_VERSION, api_compat: API_COMPAT });
    // Websocket pings rather than a message of the tunnel's own, which hubs from before `Down::Ping` would log as bad.
    // Through a broker that answers them, we hear from the hub by its `ping`.
    const ping = setInterval(() => {
      try {
        ws.ping();
      } catch {
        finish(null);
      }
    }, relay.PING);
    const off = s.events.subscribe((event) => send({ t: "event", event }));
    const silence = () => setTimeout(() => finish(new Error(`nothing from the hub for ${relay.SILENCE / 1000}s`)), relay.SILENCE);
    let quiet = silence();
    const heard = () => {
      clearTimeout(quiet);
      if (!finished) quiet = silence();
    };
    ws.on("pong", heard);
    ws.on("ping", heard);
    ws.on("message", (data, binary) => {
      heard();
      const f = relay.frame_of(data, binary);
      if (f.type === "text") tunnel_message(s, f.text, send, streams, up);
    });
    ws.on("close", (code, reason) => {
      if (code === REFUSED) finish(new Error(`refused: ${reason.toString()}`));
      else finish(null);
    });
    ws.on("error", (e) => finish(e));
    ws.resume();
    console.error(`connected to hub ${hub}`);
  });
}

/** Websockets the hub opened on our API, by id. */
type HubStreams = Map<number, Chan<Frame>>;

/** The hub as an up-link, while it's connected (see hosts/uplink.ts). */
interface TunnelUplink {
  registered: uplink.Registered | null;
}

/** Act on a message from the hub. */
function tunnel_message(s: AppState, text: string, tx: (m: Up) => boolean, streams: HubStreams, up: TunnelUplink) {
  let d: Down;
  try {
    d = JSON.parse(text);
  } catch {
    return;
  }
  switch (d?.t) {
    case "hello": {
      if (typeof d.hub_id !== "string" || typeof d.name !== "string" || d.hub_id === s.host_id) return;
      up.registered?.drop();
      const [registered, calls] = uplink.register(s, d.hub_id, d.name);
      calls.recv((c) => {
        if (c) tx({ t: "tool_call", ...c });
      });
      up.registered = registered;
      return;
    }
    case "tool_answer": {
      const a = ToolAnswer_from(d);
      if (a && up.registered) up.registered.link.answer(a);
      return;
    }
    case "req": {
      const { id, method, path, body } = d;
      background(
        "answering a request from the hub",
        (async () => {
          let status: number, out: any;
          try {
            [status, out] = await api.local_request(s, method, path, body === null || body === undefined ? null : Buffer.from(JSON.stringify(body)));
          } catch (e) {
            [status, out] = [500, { error: err_str(e) }];
          }
          tx({ t: "res", id, status, body: out });
        })(),
      );
      return;
    }
    case "ws_open": {
      // Registered right away: the hub's first messages can arrive while we connect.
      const from_hub = new Chan<Frame>();
      streams.set(d.id, from_hub);
      const id = d.id;
      background(
        "relaying a websocket for the hub",
        relay_local(s, id, d.path, from_hub, tx).finally(() => {
          if (streams.get(id) === from_hub) streams.delete(id);
        }),
      );
      return;
    }
    case "ws_msg": {
      const w = streams.get(d.id);
      const f = relay.from_wire(d.text, d.data);
      if (w && f) w.send(f);
      return;
    }
    case "ws_close": {
      const w = streams.get(d.id);
      if (w) {
        streams.delete(d.id);
        w.send(Close(null));
      }
      return;
    }
    case "ping":
      tx({ t: "pong" });
      return;
  }
}

/** Open a websocket on our own API for the hub and relay it until either side closes. */
async function relay_local(s: AppState, id: number, path: string, from_hub: Chan<Frame>, to_hub: (m: Up) => boolean): Promise<void> {
  const url = `${s.internal_url.replace("http", "ws")}${path}`;
  let local: relay.Pipe;
  try {
    local = await relay.connect(url, s.token);
  } catch (e) {
    to_hub({ t: "ws_close", id, code: 1011, reason: err_str(e) });
    return;
  }
  await new Promise<void>((done) => {
    let over = false;
    const end = () => {
      if (over) return;
      over = true;
      done();
    };
    from_hub.recv((f) => {
      if (over) return;
      f = f ?? Close(null);
      const close = f.type === "close";
      if (!local.tx.send(f) || close) end();
    });
    local.rx.recv((f) => {
      if (over) return;
      f = f ?? Close(null);
      if (f.type === "close") {
        const [code, reason] = f.frame ?? [null, null];
        to_hub({ t: "ws_close", id, code, reason });
        return end();
      }
      const [text, data] = relay.to_wire(f);
      if (!to_hub({ t: "ws_msg", id, text, data })) end();
    });
  });
}
