// Port of crates/broker/src/proto.rs (`huntaway_broker::proto`): what a host and the broker say to each other over the
// websocket the host opens to `/_broker/connect`. The broker itself stays Rust (crates/broker); this is the host's side
// of its protocol, which hosts/broker.ts speaks.
//
// With managed tunnels, Welcome supplies a per-tunnel connector token and endpoint. Only registration and heartbeats use
// this websocket; application traffic uses the tunnel.
//
// In legacy relay mode, text frames carry `Ctl` messages as JSON. Binary frames carry a stream's data: its id (8 bytes,
// big-endian), a kind byte (`DATA` or `TEXT`), then the bytes. A stream is one request from a client. The broker sends
// `Req`, then the request body as data and `End` (nothing when `body` is false), and the host answers `Head`, the
// response body as data and `End`. For a websocket (`ws`), the host opens it on its own server and answers `Head` with
// 101 (or with the response it got instead, as for a request), then both sides send its messages as data until one
// sends `Close`. `Close` also abandons a request: a client that went away, or a host that failed.
//
// Each side may send `WINDOW` bytes of a stream's data ahead of what the other has passed on, and the other side gives
// the room back with `Credit` as it does. A slow reader at either end holds up only its own stream, and nothing piles up
// in between.

/** Bump on incompatible changes to these messages. */
export const PROTOCOL = 1;

/** Request or response body bytes, or a binary websocket message. */
export const DATA = 0;
/** A text websocket message. */
export const TEXT = 1;

/** How many bytes of a stream's data a side may send before the other gives room back. */
export const WINDOW = 256 << 10;

/** A managed endpoint and its connector credential. Never log the token. */
export interface Tunnel {
  url: string;
  token: string;
}

/** The control messages, tagged by `t` (serde's `#[serde(tag = "t", rename_all = "snake_case")]`). */
export type Ctl =
  /**
   * Host → broker, first: which host this is. `key` is a secret the host keeps: the broker keeps `name` for the first
   * host to take it, and refuses it to others. `origin_port` is a separate loopback listener that refuses LAN-only
   * routes such as open-token. (Both are left out when there's none.)
   */
  | { t: "hello"; name: string; host_id: string; version: string; protocol: number; key?: string; origin_port?: number }
  /** Broker → host: it's reachable as `name` now. */
  | { t: "welcome"; name: string; tunnel?: Tunnel }
  /** Broker → host, every 20 seconds, so the connection is seen to be alive. The host answers `Pong`. */
  | { t: "ping" }
  | { t: "pong" }
  /** Broker → host: not taken (a bad name, a name kept for another host, another protocol). It hangs up after it. */
  | { t: "refused"; error: string }
  /** Broker → host: a client's request. `path` includes the query string. */
  | { t: "req"; id: number; method: string; path: string; headers: Array<[string, string]>; body: boolean; ws: boolean }
  /** Host → broker: the response's status and headers. */
  | { t: "head"; id: number; status: number; headers: Array<[string, string]> }
  /** The body that way is complete. */
  | { t: "end"; id: number }
  /** Either way: `bytes` of the stream's data have been passed on, so as many more may be sent. */
  | { t: "credit"; id: number; bytes: number }
  /** Either way: the stream is over (a websocket closed, or the request was abandoned). */
  | { t: "close"; id: number; code: number | null; reason: string | null };

const is_u64 = (v: any) => typeof v === "number" && Number.isInteger(v) && v >= 0;
const is_str = (v: any) => typeof v === "string";
const opt = (v: any, f: (v: any) => boolean) => v === undefined || v === null || f(v);
const is_headers = (v: any) => Array.isArray(v) && v.every((h) => Array.isArray(h) && h.length === 2 && is_str(h[0]) && is_str(h[1]));

/** A `Ctl` from its JSON, checked as serde would (defaults filled in). Throws on one it can't read. */
export function Ctl_from_json(text: string): Ctl {
  const v = JSON.parse(text);
  const bad = () => new Error(`bad ${typeof v?.t === "string" ? v.t : "message"}: ${text.slice(0, 200)}`);
  if (!v || typeof v !== "object" || Array.isArray(v)) throw bad();
  switch (v.t) {
    case "hello":
      if (!is_str(v.name) || !is_str(v.host_id) || !is_str(v.version) || !is_u64(v.protocol) || !opt(v.key, is_str) || !opt(v.origin_port, is_u64)) throw bad();
      return v;
    case "welcome":
      if (!is_str(v.name) || !opt(v.tunnel, (t) => is_str(t?.url) && is_str(t?.token))) throw bad();
      return v.tunnel ? { t: "welcome", name: v.name, tunnel: { url: v.tunnel.url, token: v.tunnel.token } } : { t: "welcome", name: v.name };
    case "ping":
    case "pong":
      return { t: v.t };
    case "refused":
      if (!is_str(v.error)) throw bad();
      return v;
    case "req":
      if (!is_u64(v.id) || !is_str(v.method) || !is_str(v.path) || !is_headers(v.headers) || !opt(v.body, (b) => typeof b === "boolean") || !opt(v.ws, (b) => typeof b === "boolean")) throw bad();
      return { t: "req", id: v.id, method: v.method, path: v.path, headers: v.headers, body: v.body ?? false, ws: v.ws ?? false };
    case "head":
      if (!is_u64(v.id) || !is_u64(v.status) || !is_headers(v.headers)) throw bad();
      return v;
    case "end":
      if (!is_u64(v.id)) throw bad();
      return v;
    case "credit":
      if (!is_u64(v.id) || !is_u64(v.bytes)) throw bad();
      return v;
    case "close":
      if (!is_u64(v.id) || !opt(v.code, is_u64) || !opt(v.reason, is_str)) throw bad();
      return { t: "close", id: v.id, code: v.code ?? null, reason: v.reason ?? null };
    default:
      throw new Error(`unknown variant ${JSON.stringify(v.t)}`);
  }
}

export function encode(id: number, kind: number, bytes: Uint8Array): Buffer {
  const out = Buffer.allocUnsafe(9 + bytes.length);
  out.writeBigUInt64BE(BigInt(id), 0);
  out[8] = kind;
  out.set(bytes, 9);
  return out;
}

export function decode(frame: Buffer): [number, number, Buffer] | null {
  if (frame.length < 9) return null;
  return [Number(frame.readBigUInt64BE(0)), frame[8], frame.subarray(9)];
}

/**
 * The room a side has left to send a stream's data in (see the top of the file): a semaphore of `WINDOW` bytes, whose
 * waiters are served in order.
 */
export class Window {
  private available = WINDOW;
  private waiters: Array<{ n: number; wake: (ok: boolean) => void }> = [];
  private closed = false;
  private since: number | null = null;

  /**
   * Wait for room to send `n` bytes; false once the stream is over. A websocket message can't be split, so one bigger
   * than the window waits for all of it.
   */
  async take(n: number): Promise<boolean> {
    n = Math.min(n, WINDOW);
    if (this.closed) return false;
    if (!this.waiters.length && this.available >= n) {
      this.available -= n;
      return true;
    }
    this.since ??= Date.now();
    const ok = await new Promise<boolean>((wake) => this.waiters.push({ n, wake }));
    this.since = null;
    return ok;
  }

  /** How long a sender has been waiting for room (ms), if it is. */
  blocked_for(): number | null {
    return this.since === null ? null : Date.now() - this.since;
  }

  /** How much room there is now. */
  available_permits(): number {
    return this.available;
  }

  /** The other side passed on `bytes`. Never more room than the window, whatever it says. */
  credit(bytes: number) {
    if (this.closed) return;
    this.available += Math.max(0, Math.min(WINDOW - this.available, bytes));
    while (this.waiters.length && this.available >= this.waiters[0].n) {
      const w = this.waiters.shift()!;
      this.available -= w.n;
      w.wake(true);
    }
  }

  /** The stream is over: wake anything waiting for room. */
  close() {
    this.closed = true;
    for (const w of this.waiters.splice(0)) w.wake(false);
  }
}

/**
 * Headers that belong to one hop, which a proxy doesn't pass on. The websocket handshake's are made again for the
 * connection on the other side.
 */
export function hop_by_hop(name: string): boolean {
  const n = name.toLowerCase();
  return (
    ["connection", "keep-alive", "proxy-connection", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "host"].includes(n) ||
    n.startsWith("sec-websocket-")
  );
}

/** A host's name on the broker: what clients pick it by. */
export function valid_name(name: string): boolean {
  return name.length >= 1 && name.length <= 48 && /^[a-z0-9][a-z0-9-]*$/.test(name);
}

/** A valid name made from a host's own name ("Ivan's Desktop" → "ivan-s-desktop"). */
export function slug(name: string): string {
  let s = "";
  for (const c of [...name].flatMap((c) => [...c.toLowerCase()])) {
    if (/^[a-z0-9]$/.test(c)) s += c;
    else if (s && !s.endsWith("-")) s += "-";
  }
  s = s.replace(/-+$/, "");
  s = s.slice(0, 48).replace(/-+$/, "");
  return s || "host";
}
