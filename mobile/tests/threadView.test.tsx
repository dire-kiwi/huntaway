import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react-native";
import { emitBoardEvent } from "../src/session";
import { ThreadMessages, useThread } from "../src/threadView";

const msg = (id: number, task: string) => ({ id, task_id: task, kind: "user", data: { text: `${task} ${id}` }, created_at: "" });

// Two assistants (two profiles') on one host: the Assistant tab keeps the thread mounted when it switches between them.
function fakeClient() {
  const older: Record<string, (v: unknown) => void> = {};
  const client = {
    task: jest.fn(async (_h: string, id: string) => ({ task: { id, running: true } })),
    messagePage: jest.fn((_h: string, id: string, opts: { before?: number }) =>
      opts.before ? new Promise((r) => (older[id] = r)) : Promise.resolve({ messages: [msg(100, id)], more: true, subagents: [] }),
    ),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { client: client as any, older };
}

const texts = (t: ReturnType<typeof useThread>) => (t.thread.data?.messages ?? []).map((m) => m.data.text);

test("a reply streaming in one assistant's thread isn't carried into another's", async () => {
  const { client } = fakeClient();
  const view = await renderHook((p: { id: string }) => useThread("b", client, "h", p.id), { initialProps: { id: "A" } });
  await waitFor(() => expect(texts(view.result.current)).toEqual(["A 100"]));
  await act(async () => emitBoardEvent("b", { type: "delta", host_id: "h", task_id: "A", text: "Half of A's re" }));
  expect(view.result.current.delta).toBe("Half of A's re");
  await view.rerender({ id: "B" });
  expect(view.result.current.delta).toBe("");
  await act(async () => emitBoardEvent("b", { type: "delta", host_id: "h", task_id: "B", text: "B's reply" }));
  expect(view.result.current.delta).toBe("B's reply");
  // A's stream, still coming, isn't B's.
  await act(async () => emitBoardEvent("b", { type: "delta", host_id: "h", task_id: "A", text: "ply" }));
  expect(view.result.current.delta).toBe("B's reply");
});

test("earlier messages asked for in one assistant's thread don't land in another's", async () => {
  const { client, older } = fakeClient();
  const view = await renderHook((p: { id: string }) => useThread("b", client, "h", p.id), { initialProps: { id: "A" } });
  await waitFor(() => expect(texts(view.result.current)).toEqual(["A 100"]));
  let asked: Promise<void> = Promise.resolve();
  await act(async () => void (asked = view.result.current.older()));
  expect(view.result.current.olderBusy).toBe(true);
  await view.rerender({ id: "B" });
  await waitFor(() => expect(texts(view.result.current)).toEqual(["B 100"]));
  expect(view.result.current.olderBusy).toBe(false);
  await act(async () => {
    older.A({ messages: [msg(50, "A")], more: false, subagents: [] });
    await asked;
  });
  expect(texts(view.result.current)).toEqual(["B 100"]);
  expect(view.result.current.thread.data?.more).toBe(true);
  // B's own earlier messages still come.
  await act(async () => void (asked = view.result.current.older()));
  await act(async () => {
    older.B({ messages: [msg(40, "B")], more: false, subagents: [] });
    await asked;
  });
  expect(texts(view.result.current)).toEqual(["B 40", "B 100"]);

  // Back on A: its dropped request left nothing busy, and its earlier messages can be asked for again.
  await view.rerender({ id: "A" });
  await waitFor(() => expect(texts(view.result.current)).toEqual(["A 100"]));
  expect(view.result.current.olderBusy).toBe(false);
  await act(async () => void (asked = view.result.current.older()));
  expect(view.result.current.olderBusy).toBe(true);
  await act(async () => {
    older.A({ messages: [msg(30, "A")], more: false, subagents: [] });
    await asked;
  });
  expect(texts(view.result.current)).toEqual(["A 30", "A 100"]);
  expect(view.result.current.olderBusy).toBe(false);
});

test("a task a request returned for the last thread isn't taken by the next", async () => {
  const { client } = fakeClient();
  const view = await renderHook((p: { id: string }) => useThread("b", client, "h", p.id), { initialProps: { id: "A" } });
  await waitFor(() => expect(view.result.current.task?.id).toBe("A"));
  // A's composer kept the callback from before the switch.
  const settledForA = view.result.current.settled;
  await view.rerender({ id: "B" });
  await waitFor(() => expect(view.result.current.task?.id).toBe("B"));
  await act(async () => settledForA({ id: "A", running: true } as never));
  expect(view.result.current.task?.id).toBe("B");
  await act(async () => view.result.current.settled({ id: "B", running: false } as never));
  expect(view.result.current.task).toMatchObject({ id: "B", running: false });
});

test("an earlier page dropped after a switch leaves nothing busy when the first thread's back", async () => {
  const { client, older } = fakeClient();
  const view = await renderHook((p: { id: string }) => useThread("b", client, "h", p.id), { initialProps: { id: "A" } });
  await waitFor(() => expect(texts(view.result.current)).toEqual(["A 100"]));
  let asked: Promise<void> = Promise.resolve();
  await act(async () => void (asked = view.result.current.older()));
  await view.rerender({ id: "B" });
  await waitFor(() => expect(texts(view.result.current)).toEqual(["B 100"]));
  await act(async () => {
    older.A({ messages: [msg(50, "A")], more: false, subagents: [] });
    await asked;
  });
  await view.rerender({ id: "A" });
  await waitFor(() => expect(texts(view.result.current)).toEqual(["A 100"]));
  expect(view.result.current.olderBusy).toBe(false);
  await act(async () => void (asked = view.result.current.older()));
  await act(async () => {
    older.A({ messages: [msg(50, "A")], more: false, subagents: [] });
    await asked;
  });
  expect(texts(view.result.current)).toEqual(["A 50", "A 100"]);
});

test("a routine's report shows in the thread, and opens its routine's thread", async () => {
  const report = {
    id: 7,
    task_id: "asst",
    kind: "report",
    data: { automation_id: "a1", automation: "Morning brief", task_id: "r9", key: "A-9", outcome: "reported", text: "3 mails need you." },
    created_at: "",
  };
  const client = {
    task: jest.fn(async (_h: string, id: string) => ({ task: { id, running: false } })),
    messagePage: jest.fn(async () => ({ messages: [report], more: false, subagents: [] })),
  };
  function Shown({ onOpenTask }: { onOpenTask: (id: string) => void }) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = useThread("b", client as any, "h", "asst");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return <ThreadMessages t={t} client={client as any} host="h" taskId="asst" onOpenTask={onOpenTask} />;
  }
  const opened: string[] = [];
  await render(<Shown onOpenTask={(id) => opened.push(id)} />);
  await waitFor(() => expect(screen.getByText("3 mails need you.")).toBeTruthy());
  expect(screen.getByText("Morning brief")).toBeTruthy();
  fireEvent.press(screen.getByText("Open A-9"));
  expect(opened).toEqual(["r9"]);
});

// HA-222: a task whose items are its thread's source has no messages since it moved onto them.
const user = (n: number, text: string) => ({ id: `legacy:${n}`, type: "user_message", text });
const added = (seq: number, item: unknown) => ({ type: "thread_event", host_id: "h", task_id: "T", event: { type: "item.added", thread_id: "T", seq, item } });
const window1 = { thread: { id: "T", harness: "claude", status: "idle", created_at: "" }, items: [user(5, "five")], requests: [], start: 3, seq: 1 };

function itemsClient() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client: any = {
    task: jest.fn(async (_h: string, id: string) => ({ task: { id, running: false, thread_source: "items" } })),
    messagePage: jest.fn(async () => ({ messages: [], more: false, subagents: [] })),
    thread: jest.fn(async () => window1),
    threadItems: jest.fn(async () => ({ thread_id: "T", items: [user(1, "one"), user(2, "two"), user(3, "three")], requests: [], start: 0, context: [], seq: 1 })),
  };
  return client;
}

/** Waits past the half second a thread kept as items is loaded again after. */
const settle = () => act(() => new Promise<void>((r) => setTimeout(r, 700)));

test("a task on items is drawn from its thread's window, kept current from its events, with its earlier items on request", async () => {
  const client = itemsClient();
  const view = await renderHook(() => useThread("b", client, "h", "T"));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = () => view.result.current.shown.map((it: any) => it.text);
  await waitFor(() => expect(rows()).toEqual(["five"]));
  expect(client.messagePage).not.toHaveBeenCalled();
  expect(view.result.current.thread.data?.more).toBe(true);
  // What's written to it comes as its events (with the message it was written from), and is folded in.
  await act(async () => {
    emitBoardEvent("b", { type: "message", host_id: "h", task_id: "T", message: { id: 6, task_id: "T", kind: "user", data: { text: "six" }, created_at: "" } });
    emitBoardEvent("b", added(2, user(6, "six")));
  });
  expect(rows()).toEqual(["six", "five"]);
  await act(async () => view.result.current.older());
  expect(client.threadItems).toHaveBeenCalledWith("h", "T", 3, expect.any(Number));
  expect(rows()).toEqual(["six", "five", "three", "two", "one"]);
  expect(view.result.current.thread.data?.more).toBe(false);
  expect(view.result.current.olderBusy).toBe(false);
  // The earlier page stays as more is written.
  await act(async () => emitBoardEvent("b", added(3, user(7, "seven"))));
  expect(rows()).toEqual(["seven", "six", "five", "three", "two", "one"]);
  // An event it has already changes nothing.
  await act(async () => emitBoardEvent("b", added(3, user(7, "seven again"))));
  expect(rows()).toEqual(["seven", "six", "five", "three", "two", "one"]);
  // None of it loaded the window again.
  await settle();
  expect(client.thread).toHaveBeenCalledTimes(1);
  expect(rows()).toEqual(["seven", "six", "five", "three", "two", "one"]);
});

test("a task on items is loaded again after a gap in its events, or a thread_resync", async () => {
  const client = itemsClient();
  const view = await renderHook(() => useThread("b", client, "h", "T"));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = () => view.result.current.shown.map((it: any) => it.text);
  await waitFor(() => expect(rows()).toEqual(["five"]));
  // Seq 2 was missed: this isn't put in, and the window's loaded again.
  client.thread.mockResolvedValue({ ...window1, items: [user(5, "five"), user(6, "six"), user(7, "seven")], seq: 3 });
  await act(async () => emitBoardEvent("b", added(3, user(7, "seven"))));
  expect(rows()).toEqual(["five"]);
  await waitFor(() => expect(rows()).toEqual(["seven", "six", "five"]), { timeout: 2000 });
  expect(client.thread).toHaveBeenCalledTimes(2);
  client.thread.mockResolvedValue({ ...window1, items: [user(8, "rebuilt")], seq: 1 });
  await act(async () => emitBoardEvent("b", { type: "thread_resync", host_id: "h", task_id: "T" }));
  await waitFor(() => expect(rows()).toEqual(["rebuilt"]), { timeout: 2000 });
  expect(client.thread).toHaveBeenCalledTimes(3);
});

test("a task on items gets the events that come while its window loads", async () => {
  const client = itemsClient();
  let loaded: (w: unknown) => void = () => {};
  client.thread.mockImplementation(() => new Promise((r) => (loaded = r)));
  const view = await renderHook(() => useThread("b", client, "h", "T"));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = () => view.result.current.shown.map((it: any) => it.text);
  await waitFor(() => expect(client.thread).toHaveBeenCalled());
  // Written after the window was read, and before it's in.
  await act(async () => emitBoardEvent("b", added(2, user(6, "six"))));
  await act(async () => loaded(window1));
  await waitFor(() => expect(rows()).toEqual(["six", "five"]));
  await settle();
  expect(client.thread).toHaveBeenCalledTimes(1);
});
