// Live updates: one websocket per paired board (its /ws, the events of every host on it), which reconnects after a
// drop (or a minute without the board's ticks) with a backoff, and at once when the app comes back to the front or the
// network changes (see BoardSockets in session.tsx). After each reconnect it hands on a `resync` event, so screens read
// again what they may have missed.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type BoardEvent = { type: string; host_id?: string; [k: string]: any };

export interface SocketLike {
  onopen: (() => void) | null;
  onmessage: ((e: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  close(): void;
}

export type Connect = (url: string) => SocketLike;

/** How long to wait before the `n`th attempt in a row to reconnect. */
export const backoff = (n: number) => Math.min(30_000, 1000 * 2 ** Math.min(n, 5));

/**
 * A connection that has had the board's `tick` (every 25 s, see the server's hosts/hub/endpoints.ts) and then nothing
 * for this long is taken for dead (a network that dropped it without a close) and opened again. One to a board from
 * before ticks never is, as it can be quiet for any time.
 */
export const SILENCE_MS = 60_000;

export class BoardSocket {
  private ws: SocketLike | null = null;
  private attempts = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private everOpened = false;
  /** When the connection last had anything, and the check for its silence once it has had a tick. */
  private heard = 0;
  private silence: ReturnType<typeof setTimeout> | null = null;
  /** Whether it's connected, for the screens' "live" mark. */
  connected = false;

  constructor(
    private url: () => string,
    private onEvent: (e: BoardEvent) => void,
    private connect: Connect = (u) => new WebSocket(u) as unknown as SocketLike,
    private onStatus: (connected: boolean) => void = () => {},
  ) {}

  start() {
    this.closed = false;
    this.open();
  }

  /**
   * Reconnects now, unless it's connected and not `force`d. The app forces it when it comes back to the front or the
   * network changes, where a socket can look open and be dead; the new one's `resync` reads again what was missed.
   */
  kick(force = false) {
    if (this.closed || (this.connected && !force)) return;
    this.attempts = 0;
    this.open();
  }

  stop() {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.drop();
  }

  private drop() {
    if (this.silence) clearTimeout(this.silence);
    this.silence = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    }
    this.setConnected(false);
  }

  private open() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.drop();
    let ws: SocketLike;
    try {
      ws = this.connect(this.url());
    } catch {
      this.retry();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.attempts = 0;
      this.setConnected(true);
      // Whatever happened while it was away.
      if (this.everOpened) this.onEvent({ type: "resync" });
      this.everOpened = true;
    };
    ws.onmessage = (e) => {
      this.heard = Date.now();
      if (typeof e.data !== "string") return;
      try {
        const ev = JSON.parse(e.data);
        if (ev?.type === "tick") this.silence ??= this.watch(ws);
        else if (ev && typeof ev.type === "string" && ev.type !== "hello") this.onEvent(ev);
      } catch {
        /* not an event */
      }
    };
    ws.onclose = ws.onerror = () => this.lost(ws);
  }

  /** Checks, SILENCE_MS after it was last heard from, that `ws` has been since. */
  private watch(ws: SocketLike): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
      this.silence = null;
      if (this.ws !== ws) return;
      if (Date.now() - this.heard >= SILENCE_MS) this.lost(ws);
      else this.silence = this.watch(ws);
    }, this.heard + SILENCE_MS - Date.now());
  }

  /** `ws` closed, or went silent: another, after the backoff. */
  private lost(ws: SocketLike) {
    if (this.ws !== ws) return;
    this.drop();
    this.retry();
  }

  private retry() {
    if (this.closed || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.open();
    }, backoff(this.attempts++));
  }

  private setConnected(c: boolean) {
    if (this.connected === c) return;
    this.connected = c;
    this.onStatus(c);
  }
}

/** The app came back to the front, or onto another network: every board's socket starts again, and so reads again. */
export function resume(sockets: Iterable<BoardSocket>) {
  for (const s of sockets) s.kick(true);
}
