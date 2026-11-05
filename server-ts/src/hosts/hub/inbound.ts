// Port of server/src/hosts/hub/inbound.rs: the inbound tunnel: hosts started with `--hub` dial `/api/hub/connect`, and
// requests to them go back over that websocket.
import type WebSocket from "ws";
import * as db from "../../db.ts";
import { ApiError, type Req } from "../../http.ts";
import type { AppState } from "../../state.ts";
import { background, err_str, same_secret } from "../../util.ts";
import { API_VERSION, PROTOCOL, ToolCall_from } from "../proto.ts";
import * as relay from "../relay.ts";
import { Chan, type Frame } from "../relay.ts";
import { LinkConn, Version_from_info, changed, forward_event, register, run_up_call, unregister, type Down, type Up, type Version } from "../hub.ts";

/** The close code a hub refuses a host's tunnel with (a policy violation). */
export const REFUSED = 1008;

/** Whether a request to `/api/hub/connect` carries this hub's token. */
function hub_token_ok(s: AppState, r: Req): boolean {
  const auth = r.headers["authorization"];
  const token = typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice(7) : null;
  return token !== null && same_secret(token, s.hub_token);
}

/** `/api/hub/connect`'s check before the upgrade: a wrong hub token is a 401, as in Rust. */
export function accept_check(s: AppState, r: Req) {
  if (!hub_token_ok(s, r)) throw new ApiError(401, "unauthorized");
}

/** `/api/hub/connect`. (A caller that skipped `accept_check` still gets a refusal: the socket closes as refused.) */
export function accept(s: AppState, r: Req, ws: WebSocket) {
  if (!hub_token_ok(s, r)) {
    ws.close(REFUSED, "unauthorized");
    return;
  }
  serve_tunnel(s, ws).catch((e) => console.error(`hosted tunnel ended: ${err_str(e)}`));
}

/** The hello, the first message, within 10 seconds. The socket is paused after it, until the tunnel's loop listens. */
function hello(ws: WebSocket): Promise<Up> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      cleanup();
      reject(new Error("no hello"));
    }, 10_000);
    const on_msg = (data: WebSocket.RawData, binary: boolean) => {
      cleanup();
      ws.pause();
      const f = relay.frame_of(data, binary);
      if (f.type !== "text") return reject(new Error("expected hello"));
      try {
        resolve(JSON.parse(f.text));
      } catch (e) {
        reject(e);
      }
    };
    const on_close = () => {
      cleanup();
      reject(new Error("expected hello"));
    };
    const cleanup = () => {
      clearTimeout(t);
      ws.off("message", on_msg);
      ws.off("close", on_close);
    };
    ws.on("message", on_msg);
    ws.on("close", on_close);
  });
}

async function serve_tunnel(s: AppState, ws: WebSocket): Promise<void> {
  ws.on("error", () => {});
  let first: Up;
  try {
    first = await hello(ws);
  } catch (e) {
    ws.terminate();
    throw e;
  }
  if (first?.t !== "hello") {
    ws.terminate();
    throw new Error("expected hello");
  }
  if (first.protocol !== PROTOCOL) {
    ws.terminate();
    throw new Error(`host speaks protocol ${first.protocol}, we speak ${PROTOCOL}`);
  }
  const { host_id, name } = first;
  const version: Version = {
    version: first.version ?? "",
    api_version: first.api_version ?? 0,
    api_compat: first.api_compat ?? 0,
    commit: null,
    agents: true,
    updates_from: null,
  };
  if (host_id === s.host_id) {
    ws.terminate();
    throw new Error("a host can't link to itself");
  }
  let open = true;
  const tx = (d: Down): boolean => {
    if (!open || ws.readyState !== ws.OPEN) return false;
    ws.send(JSON.stringify(d));
    return true;
  };
  const pending = new Map<number, (r: [number, any] | null) => void>();
  const streams = new Map<number, Chan<Frame>>();
  const conn = new LinkConn(host_id, name, "inbound", version, { type: "tunnel", tx, pending, streams, next: 1 });
  if (!register(s, conn)) {
    const reason = `host ${host_id} is already connected to this hub`;
    ws.resume();
    await relay.close(ws, [REFUSED, reason]);
    throw new Error(`${name}: ${reason}`);
  }
  try {
    db.note_inbound_link(s.db(), host_id, name);
  } catch (e) {
    open = false;
    ws.terminate();
    unregister(s, conn);
    throw e;
  }
  // Who we are, so the host can pass its agents' board tool calls up (hosts before API 111 ignore it).
  tx({ t: "hello", hub_id: s.host_id, name: s.host_name, api_version: API_VERSION });
  // A websocket ping for hosts from before `Down::Ping`, which answer it whatever their version; `ping` for the
  // others, which gets through a broker.
  const send_ping = () => {
    try {
      ws.ping();
    } catch {}
    tx({ t: "ping" });
  };
  // At once too, as tokio's interval ticks: a host that answers is known to before anything can go wrong, so through a
  // broker (whose relay answers websocket pings) the hub then goes by its answers alone.
  send_ping();
  const ping = setInterval(send_ping, relay.PING);
  forward_event(s, host_id, { type: "resync" });
  console.error(`host ${name} connected in`);
  // The hello doesn't carry the commit; ask once the tunnel is up.
  conn
    .request("GET", "/api/info")
    .then(([status, info]) => {
      if (status === 200) {
        conn.version = Version_from_info(info);
        changed(s);
      }
    })
    .catch(() => {});
  // A websocket pong needn't come from the host: through a broker, it's our own relay to the broker that answers our
  // pings. So once the host has answered a `ping`, only its messages count.
  let answers_pings = false;
  await new Promise<void>((done) => {
    let quiet: NodeJS.Timeout;
    const silence = () => {
      clearTimeout(quiet);
      quiet = setTimeout(() => {
        console.error(`nothing from host ${name} for ${relay.SILENCE / 1000}s`);
        end();
      }, relay.SILENCE);
    };
    silence();
    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      clearTimeout(quiet);
      done();
    };
    const control = () => {
      if (!answers_pings) {
        conn.heard();
        silence();
      }
    };
    ws.on("pong", control);
    ws.on("ping", control);
    ws.on("close", end);
    ws.on("error", end);
    ws.resume();
    ws.on("message", (data, binary) => {
      if (ended) return;
      const f = relay.frame_of(data, binary);
      if (f.type !== "text") return control();
      conn.heard();
      silence();
      let m: Up;
      try {
        m = JSON.parse(f.text);
      } catch (e) {
        return void console.error(`bad tunnel message from ${name}: ${err_str(e)}`);
      }
      switch (m?.t) {
        case "res": {
          const w = pending.get(m.id);
          if (w) {
            pending.delete(m.id);
            w([m.status, m.body ?? null]);
          }
          break;
        }
        case "event":
          forward_event(s, host_id, m.event);
          break;
        case "ws_msg": {
          const fr = relay.from_wire(m.text, m.data);
          const w = streams.get(m.id);
          if (w && fr) w.send(fr);
          break;
        }
        case "ws_close": {
          const w = streams.get(m.id);
          if (w) {
            streams.delete(m.id);
            w.send(relay.Close(typeof m.code === "number" ? [m.code, m.reason ?? ""] : null));
          }
          break;
        }
        case "tool_call": {
          const c = ToolCall_from(m);
          if (c) background("answering a host's board tool call", run_up_call(s, host_id, c, "tunnel").then((a) => void tx({ t: "tool_answer", ...a })));
          break;
        }
        case "pong":
          answers_pings = true;
          break;
        case "hello":
          break;
        default:
          console.error(`bad tunnel message from ${name}: unknown variant ${JSON.stringify((m as any)?.t)}`);
      }
    });
  });
  open = false;
  clearInterval(ping);
  ws.terminate();
  // Requests and websockets in flight hold the connection, so they'd wait for answers that won't come.
  for (const w of pending.values()) w(null);
  pending.clear();
  for (const c of streams.values()) c.close();
  streams.clear();
  unregister(s, conn);
  console.error(`host ${name} disconnected`);
}
