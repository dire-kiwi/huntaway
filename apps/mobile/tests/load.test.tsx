import type { Message, MessagePage } from "@huntaway/client";
import { act, renderHook } from "@testing-library/react-native";
import { Snapshot, useLoad } from "../src/load";
import { withMessage } from "../src/thread";

const m = (id: number) => ({ id, task_id: "t", kind: "user", data: { text: String(id) }, created_at: "" }) as Message;
const addMessage = (msg: Message) => (t: MessagePage | undefined): MessagePage => ({ more: t?.more ?? false, subagents: t?.subagents ?? [], messages: withMessage(t?.messages ?? [], msg) });

/** A promise to resolve by hand. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}

describe("reading and live changes", () => {
  test("a message that comes while the first page loads joins it, keeping its paging", () => {
    const s = new Snapshot<MessagePage>();
    const g = s.begin(true);
    s.update(addMessage(m(5)));
    // Nothing to show yet: the page isn't in.
    expect(s.state.data).toBeUndefined();
    expect(s.resolve(g, { messages: [1, 2, 3, 4].map(m), more: true, subagents: [] })).toBe(true);
    expect(s.state.data!.messages.map((x) => x.id)).toEqual([1, 2, 3, 4, 5]);
    expect(s.state.data!.more).toBe(true);
  });

  test("a change during a reload shows at once and is made again to what it reads", () => {
    const s = new Snapshot<number[]>();
    s.resolve(s.begin(true), [1]);
    const g = s.begin(false);
    s.update((l = []) => [...l, 2]);
    expect(s.state.data).toEqual([1, 2]);
    s.resolve(g, [1, 3]);
    expect(s.state.data).toEqual([1, 3, 2]);
    // Once it's in, changes aren't made twice.
    s.update((l = []) => [...l, 4]);
    expect(s.state.data).toEqual([1, 3, 2, 4]);
  });

  test("another resource starts from nothing, and an outdated read is dropped", () => {
    const s = new Snapshot<string>();
    s.resolve(s.begin(true), "board A's projects");
    const a = s.begin(false);
    const b = s.begin(true);
    expect(s.state.data).toBeUndefined();
    expect(s.resolve(a, "late A")).toBe(false);
    expect(s.fail(b, "board B is unreachable")).toBe(true);
    expect(s.state).toEqual({ error: "board B is unreachable", loading: false });
  });

  test("useLoad: switching boards drops the last board's data even when the new load fails", async () => {
    const reads = { A: deferred<string>(), B: deferred<string>() };
    const { result, rerender } = await renderHook(({ board }: { board: "A" | "B" }) => useLoad(() => reads[board].promise, [board]), { initialProps: { board: "A" as "A" | "B" } });
    await act(async () => reads.A.resolve("A's projects"));
    expect(result.current.data).toBe("A's projects");
    await rerender({ board: "B" });
    expect(result.current.data).toBeUndefined();
    await act(async () => reads.B.reject(new Error("unreachable")));
    expect(result.current.data).toBeUndefined();
    expect(result.current).toMatchObject({ error: "unreachable", loading: false });
  });

  test("useLoad: a live message during the first load doesn't replace the page", async () => {
    const read = deferred<MessagePage>();
    const { result } = await renderHook(() => useLoad(() => read.promise, ["t"]));
    await act(() => result.current.setData(addMessage(m(9))));
    await act(async () => read.resolve({ messages: [m(7), m(8)], more: true, subagents: [] }));
    expect(result.current.data?.messages.map((x: Message) => x.id)).toEqual([7, 8, 9]);
    expect(result.current.data?.more).toBe(true);
  });
});
