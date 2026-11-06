import { backoff, BoardSocket, resume, SILENCE_MS, type SocketLike } from "../src/live";

class FakeSocket implements SocketLike {
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(public url: string) {}
  close() {
    this.closed = true;
  }
}

describe("live updates", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test("hands on events, reconnects with a backoff, and resyncs after a reconnect", () => {
    const sockets: FakeSocket[] = [];
    const events: string[] = [];
    const status: boolean[] = [];
    const s = new BoardSocket(
      () => "wss://b/api/ws?token=t",
      (e) => events.push(e.type),
      (u) => (sockets.push(new FakeSocket(u)), sockets[sockets.length - 1]),
      (c) => status.push(c),
    );
    s.start();
    sockets[0].onopen!();
    sockets[0].onmessage!({ data: JSON.stringify({ type: "hello" }) });
    sockets[0].onmessage!({ data: JSON.stringify({ type: "task", task: {} }) });
    sockets[0].onmessage!({ data: "not json" });
    expect(events).toEqual(["task"]);
    sockets[0].onclose!();
    expect(sockets).toHaveLength(1);
    jest.advanceTimersByTime(backoff(0));
    expect(sockets).toHaveLength(2);
    sockets[1].onopen!();
    expect(events).toEqual(["task", "resync"]);
    expect(status).toEqual([true, false, true]);
    s.stop();
    expect(sockets[1].closed).toBe(true);
  });

  test("kick reconnects at once (back in front, new network), unless forced only when connected", () => {
    const sockets: FakeSocket[] = [];
    const s = new BoardSocket(
      () => "u",
      () => {},
      (u) => (sockets.push(new FakeSocket(u)), sockets[sockets.length - 1]),
    );
    s.start();
    sockets[0].onclose!();
    s.kick();
    expect(sockets).toHaveLength(2);
    sockets[1].onopen!();
    s.kick();
    expect(sockets).toHaveLength(2);
    s.kick(true);
    expect(sockets).toHaveLength(3);
    expect(sockets[1].closed).toBe(true);
    // A stale socket's close doesn't schedule another.
    sockets[1].onclose?.();
    jest.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(3);
    s.stop();
  });

  test("a connection that has had ticks and then goes quiet is opened again; one with no ticks (an older board) isn't", () => {
    const sockets: FakeSocket[] = [];
    const events: string[] = [];
    const status: boolean[] = [];
    const s = new BoardSocket(
      () => "u",
      (e) => events.push(e.type),
      (u) => (sockets.push(new FakeSocket(u)), sockets[sockets.length - 1]),
      (c) => status.push(c),
    );
    const tick = (n: number) => sockets[n].onmessage!({ data: JSON.stringify({ type: "tick" }) });
    s.start();
    sockets[0].onopen!();
    // No ticks: however quiet, it stays.
    jest.advanceTimersByTime(10 * SILENCE_MS);
    expect(sockets).toHaveLength(1);
    // Ticks, and events between them, keep it.
    tick(0);
    for (let i = 0; i < 4; i++) {
      jest.advanceTimersByTime(SILENCE_MS / 2);
      sockets[0].onmessage!({ data: JSON.stringify({ type: "task", task: {} }) });
    }
    jest.advanceTimersByTime(SILENCE_MS - 1);
    expect(sockets).toHaveLength(1);
    // The tick isn't an event.
    expect(events).toEqual(["task", "task", "task", "task"]);
    // Nothing for SILENCE_MS: it's closed, and another is opened after the backoff, which reads again what was missed.
    jest.advanceTimersByTime(1);
    expect(sockets[0].closed).toBe(true);
    expect(s.connected).toBe(false);
    jest.advanceTimersByTime(backoff(0));
    expect(sockets).toHaveLength(2);
    sockets[1].onopen!();
    expect(events[events.length - 1]).toBe("resync");
    expect(status).toEqual([true, false, true]);
    // The new connection is to a board that doesn't tick (rolled back): it isn't watched.
    jest.advanceTimersByTime(10 * SILENCE_MS);
    expect(sockets).toHaveLength(2);
    s.stop();
  });

  test("the backoff grows to 30 seconds", () => {
    expect([0, 1, 2, 5, 10].map(backoff)).toEqual([1000, 2000, 4000, 30000, 30000]);
  });

  test("back in front, a socket that still looks open is opened again, and what was missed is read again", () => {
    const sockets: FakeSocket[] = [];
    const events: string[] = [];
    const s = new BoardSocket(
      () => "u",
      (e) => events.push(e.type),
      (u) => (sockets.push(new FakeSocket(u)), sockets[sockets.length - 1]),
    );
    s.start();
    sockets[0].onopen!();
    // Suspended in the background: the connection died, but no close came.
    expect(s.connected).toBe(true);
    resume([s]);
    expect(sockets).toHaveLength(2);
    expect(sockets[0].closed).toBe(true);
    sockets[1].onopen!();
    expect(events).toEqual(["resync"]);
    s.stop();
  });
});
