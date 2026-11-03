import { backoff, BoardSocket, type SocketLike } from "../src/live";

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
    const s = new BoardSocket(() => "wss://b/api/ws?token=t", (e) => events.push(e.type), (u) => (sockets.push(new FakeSocket(u)), sockets[sockets.length - 1]), (c) => status.push(c));
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
    const s = new BoardSocket(() => "u", () => {}, (u) => (sockets.push(new FakeSocket(u)), sockets[sockets.length - 1]));
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

  test("the backoff grows to 30 seconds", () => {
    expect([0, 1, 2, 5, 10].map(backoff)).toEqual([1000, 2000, 4000, 30000, 30000]);
  });
});
