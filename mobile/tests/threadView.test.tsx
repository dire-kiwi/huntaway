import { act, renderHook, waitFor } from "@testing-library/react-native";
import { emitBoardEvent } from "../src/session";
import { useThread } from "../src/threadView";

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
