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
test("a task on items is drawn from its thread's window, loaded again as it's written, with its earlier items on request", async () => {
  const user = (n: number, text: string) => ({ id: `legacy:${n}`, type: "user_message", text });
  let window = { items: [user(5, "five")], requests: [], start: 3, seq: 1 };
  const client: any = {
    task: jest.fn(async (_h: string, id: string) => ({ task: { id, running: false, thread_source: "items" } })),
    messagePage: jest.fn(async () => ({ messages: [], more: false, subagents: [] })),
    thread: jest.fn(async () => window),
    threadItems: jest.fn(async (_h: string, _id: string, before: number) => ({ items: [user(1, "one")], requests: [], start: 0, context: [], before })),
  };
  const view = await renderHook(() => useThread("b", client, "h", "T"));
  const rows = () => view.result.current.shown.map((it: any) => it.text);
  await waitFor(() => expect(rows()).toEqual(["five"]));
  expect(client.messagePage).not.toHaveBeenCalled();
  expect(view.result.current.thread.data?.more).toBe(true);
  // A message written to it (its event) loads the window again.
  window = { items: [user(5, "five"), user(6, "six")], requests: [], start: 3, seq: 2 };
  await act(async () =>
    emitBoardEvent("b", { type: "message", host_id: "h", task_id: "T", message: { id: 6, task_id: "T", kind: "user", data: { text: "six" }, created_at: "" } }),
  );
  await waitFor(() => expect(rows()).toEqual(["six", "five"]), { timeout: 2000 });
  await act(async () => view.result.current.older());
  expect(client.threadItems).toHaveBeenCalledWith("h", "T", 3, expect.any(Number));
  expect(rows()).toEqual(["six", "five", "one"]);
  expect(view.result.current.thread.data?.more).toBe(false);
  expect(view.result.current.olderBusy).toBe(false);
});
