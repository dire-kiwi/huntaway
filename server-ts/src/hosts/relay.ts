// Port of server/src/hosts/relay.rs: relaying websockets (terminals) from the UI to a host: straight through for a host
// we reach over HTTP, or as `ws_open`/`ws_msg`/`ws_close` messages over a host's tunnel.
import WebSocket from "ws";

/**
 * How often each end of a link (and a relayed websocket) pings the other, so a connection that died without closing
 * (a NAT mapping that expired, a laptop that slept) is noticed. As the broker does. (Tests shorten these with
 * `test_timing`, as Rust's `cfg!(test)` does.)
 */
export let PING = 20_000;

/** A link we've heard nothing from (not even a pong) for this long is gone. */
export let SILENCE = 60_000;

/** How long opening a websocket may take. */
let CONNECT_TIMEOUT = 30_000;

/** The timings Rust's tests build with. */
export function test_timing() {
  PING = 300;
  SILENCE = 3000;
  CONNECT_TIMEOUT = 5000;
}

/**
 * Open a websocket, giving up after `CONNECT_TIMEOUT` (a host that doesn't answer would otherwise hold it for as long
 * as the system's TCP timeout). It comes paused: frames that came with the handshake would otherwise be emitted before
 * the caller has its listeners on, so `resume()` it once they are.
 */
export function open(url: string, headers: Record<string, string> = {}): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(url, { headers, perMessageDeflate: false });
    } catch (e) {
      return reject(e);
    }
    let done = false;
    const fail = (e: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        ws.terminate();
      } catch {}
      reject(e);
    };
    const timer = setTimeout(() => fail(new Error(`no answer in ${CONNECT_TIMEOUT / 1000}s`)), CONNECT_TIMEOUT);
    // Errors after it opened come with a close, which its user follows.
    ws.on("error", (e) => fail(e));
    ws.once("unexpected-response", (req, res) => {
      req.destroy();
      fail(new Error(`HTTP error: ${res.statusCode} ${res.statusMessage ?? ""}`.trim()));
    });
    ws.once("open", () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      ws.pause();
      resolve(ws);
    });
  });
}

/** One websocket message, whichever side carried it. */
export type Frame = { type: "text"; text: string } | { type: "binary"; data: Buffer } | { type: "close"; frame: [number, string] | null };

export const Text = (text: string): Frame => ({ type: "text", text });
export const Binary = (data: Buffer): Frame => ({ type: "binary", data });
export const Close = (frame: [number, string] | null = null): Frame => ({ type: "close", frame });

/**
 * An unbounded channel (tokio's mpsc): values sent before its receiver listens are kept for it. `null` tells the
 * receiver the channel closed (its sender went).
 */
export class Chan<T> {
  private buf: T[] = [];
  private cb: ((v: T | null) => void) | null = null;
  closed = false;
  /** False once the channel is closed (the receiver went). */
  send(v: T): boolean {
    if (this.closed) return false;
    if (this.cb) this.cb(v);
    else this.buf.push(v);
    return true;
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.cb) this.cb(null);
  }
  /** Receive what's sent (and what was sent already), then `null` once it closes. */
  recv(cb: (v: T | null) => void) {
    this.cb = cb;
    for (const v of this.buf.splice(0)) cb(v);
    if (this.closed) cb(null);
  }
}

/** Both directions of a relayed websocket: frames to send, and frames received. */
export interface Pipe {
  tx: Chan<Frame>;
  rx: Chan<Frame>;
}

/** The `text`/`data` fields of a tunnel `ws_msg` (binary data is base64). */
export function to_wire(f: Frame): [string | null, string | null] {
  if (f.type === "text") return [f.text, null];
  if (f.type === "binary") return [null, f.data.toString("base64")];
  return [null, null];
}

export function from_wire(text: string | null | undefined, data: string | null | undefined): Frame | null {
  if (typeof text === "string") return Text(text);
  if (typeof data === "string") return Binary(Buffer.from(data, "base64"));
  return null;
}

/** A received message as a frame. */
export function frame_of(data: WebSocket.RawData, binary: boolean): Frame {
  const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as any);
  return binary ? Binary(buf) : Text(buf.toString("utf8"));
}

/** A close code and reason as a frame (none for the codes that mean there was no close frame). */
export function close_frame(code: number, reason: Buffer | string): [number, string] | null {
  if (code === 1005 || code === 1006 || !code) return null;
  return [code, reason.toString()];
}

/** Send `f` on `ws`. Returns false if it's closed. */
export function send_frame(ws: WebSocket, f: Frame): boolean {
  if (ws.readyState !== WebSocket.OPEN) return false;
  try {
    if (f.type === "text") ws.send(f.text);
    else if (f.type === "binary") ws.send(f.data);
    else if (f.frame) ws.close(f.frame[0], truncate_reason(f.frame[1]));
    else ws.close();
    return true;
  } catch {
    return false;
  }
}

/** A close reason fits in 123 bytes. */
export function truncate_reason(r: string): string {
  let out = r;
  while (Buffer.byteLength(out) > 123) out = out.slice(0, -1);
  return out;
}

/** Open a websocket to `url` (`ws://…`) with a bearer token. */
export async function connect(url: string, token: string): Promise<Pipe> {
  const ws = await open(url, { Authorization: `Bearer ${token}` });
  const tx = new Chan<Frame>(), rx = new Chan<Frame>();
  let ended = false;
  const end = (f: Frame) => {
    if (ended) return;
    ended = true;
    clearInterval(ping);
    clearTimeout(quiet);
    rx.send(f);
    rx.close();
    tx.close();
  };
  const ping = setInterval(() => {
    try {
      ws.ping();
    } catch {
      end(Close(null));
    }
  }, PING);
  let quiet = setTimeout(() => {
    end(Close([1011, "host went quiet"]));
    ws.terminate();
  }, SILENCE);
  const heard = () => {
    clearTimeout(quiet);
    quiet = setTimeout(() => {
      end(Close([1011, "host went quiet"]));
      ws.terminate();
    }, SILENCE);
  };
  ws.on("pong", heard);
  ws.on("ping", heard);
  ws.on("message", (data, binary) => {
    heard();
    if (!ended) rx.send(frame_of(data, binary));
  });
  ws.on("close", (code, reason) => end(Close(close_frame(code, reason))));
  tx.recv((f) => {
    if (ended) return;
    if (f === null || f.type === "close") {
      ended = true;
      clearInterval(ping);
      clearTimeout(quiet);
      send_frame(ws, f ?? Close(null));
      rx.close();
      return;
    }
    if (!send_frame(ws, f)) end(Close(null));
  });
  ws.resume();
  return { tx, rx };
}

/** Shuttle frames between the UI's websocket and a relayed one until either side closes. */
export function bridge(ui: WebSocket, { tx, rx }: Pipe) {
  let done = false;
  ui.on("message", (data, binary) => {
    if (done) return;
    if (!tx.send(frame_of(data, binary))) done = true;
  });
  const gone = () => {
    if (done) return;
    done = true;
    tx.send(Close(null));
  };
  ui.on("close", gone);
  ui.on("error", gone);
  rx.recv((f) => {
    if (done) return;
    if (f === null) {
      done = true;
      return void close(ui, [1011, "host disconnected"]);
    }
    if (f.type === "close") {
      done = true;
      return void close(ui, f.frame);
    }
    if (!send_frame(ui, f)) gone();
  });
}

/** Close and wait (briefly) for the peer's reply: hanging up right away can reset the connection before the close frame is read. */
export function close(ws: WebSocket, frame: [number, string] | null): Promise<void> {
  if (ws.readyState !== WebSocket.OPEN) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      ws.terminate();
      resolve();
    }, 2000);
    ws.once("close", () => {
      clearTimeout(t);
      resolve();
    });
    try {
      if (frame) ws.close(frame[0], truncate_reason(frame[1]));
      else ws.close();
    } catch {
      clearTimeout(t);
      ws.terminate();
      resolve();
    }
  });
}
