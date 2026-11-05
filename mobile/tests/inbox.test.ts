import type { Message, PendingPermission, Task } from "@huntaway/client";
import { hostItems, loadBoardInbox, mergeInbox, openQuestion, taskKey } from "../src/inbox";

const task = (id: string, extra: Partial<Task> = {}) =>
  ({ id, number: 1, title: `Task ${id}`, status: "in_progress", kind: "task", project_id: "p1", attention_reason: null, updated_at: "2026-11-03T10:00:00Z", ...extra }) as Task;
const perm = (id: string, taskId: string, at: string): PendingPermission => ({ id, task_id: taskId, tool_name: "Bash", input: { command: "ls" }, created_at: at });
const msg = (id: number, kind: Message["kind"], data: unknown, at = "2026-11-03T10:00:00Z") => ({ id, task_id: "t", kind, data, created_at: at }) as Message;
const work = { id: "work", name: "work-hub" };
const home = { id: "home", name: "home" };

describe("the inbox", () => {
  test("a task's prompt or question stands for it, and other tasks needing attention show as that", () => {
    const tasks = [
      task("a", { status: "needs_attention", number: 3 }),
      task("b", { status: "needs_attention", attention_reason: "Out of usage" }),
      task("c", { status: "needs_attention" }),
      task("d"),
    ];
    const items = hostItems(work, "h1", tasks, [{ id: "p1", key: "HA" }], [perm("r1", "a", "2026-11-03T11:00:00Z")], new Map([["c", msg(9, "question", { question: "Which?", status: "pending" })]]));
    expect(items.map((i) => [i.kind, i.taskId, i.taskKey])).toEqual([
      ["permission", "a", "HA-3"],
      ["question", "c", "HA-1"],
      ["attention", "b", "HA-1"],
    ]);
    expect(items.find((i) => i.kind === "attention")).toMatchObject({ reason: "Out of usage", board: work, hostId: "h1" });
  });

  test("prompts of tasks not in the profile are left out", () => {
    const items = hostItems(work, "h1", [task("a")], [], [perm("r1", "a", "x"), perm("r2", "someone-elses", "y")], new Map());
    expect(items.map((i) => i.key)).toEqual(["work/h1/perm/r1"]);
  });

  test("boards merge newest first, each item labelled with its board, and unread boards are listed", () => {
    const a = hostItems(work, "h1", [task("a")], [], [perm("r1", "a", "2026-11-03T09:00:00Z")], new Map());
    const b = hostItems(home, "h2", [task("a", { status: "needs_attention", updated_at: "2026-11-03T12:00:00Z" })], [], [], new Map());
    const c = hostItems(work, "h1", [task("x")], [], [perm("r3", "x", "2026-11-03T10:00:00Z")], new Map());
    const merged = mergeInbox([
      { board: work, items: [...a, ...c] },
      { board: home, items: b },
      { board: { id: "old", name: "old" }, items: [], error: "offline" },
    ]);
    expect(merged.items.map((i) => `${i.board.name}:${i.kind}:${i.taskId}`)).toEqual(["home:attention:a", "work-hub:permission:x", "work-hub:permission:a"]);
    expect(merged.errors).toEqual([{ board: { id: "old", name: "old" }, error: "offline" }]);
    // The same task id on two boards is two items.
    expect(new Set(merged.items.map((i) => i.key)).size).toBe(3);
  });

  test("an open question is the latest one, still pending, with no reply since", () => {
    expect(openQuestion([msg(1, "question", { status: "pending" })])?.id).toBe(1);
    expect(openQuestion([msg(1, "question", { status: "answered" })])).toBeUndefined();
    expect(openQuestion([msg(1, "question", { status: "pending" }), msg(2, "user", { text: "this" })])).toBeUndefined();
    expect(openQuestion([msg(1, "question", { status: "pending" }), msg(2, "question", { status: "answered" })])).toBeUndefined();
    expect(openQuestion([msg(1, "user", { text: "go" })])).toBeUndefined();
  });

  test("task keys", () => {
    expect(taskKey(task("a", { number: 7 }), [{ id: "p1", key: "HA" }])).toBe("HA-7");
    expect(taskKey(task("a", { project_id: null, task_type: "scratch", number: 2 }), [])).toBe("S-2");
    expect(taskKey(task("a", { project_id: null, group_name: "g", number: 4 }), [])).toBe("G-4");
  });

  test("a board's inbox reads its picked profile on each connected host", async () => {
    const calls: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client: any = {
      hosts: async () => [
        { id: "h1", local: true, connected: true },
        { id: "h2", local: false, connected: true, agents: true },
        { id: "h3", local: false, connected: false },
      ],
      profiles: async (h: string) => [{ id: `${h}-work`, name: "Work" }, { id: `${h}-home`, name: "Home" }],
      profileTasks: async (h: string, p: string) => (calls.push(`tasks ${h} ${p}`), [task(`${h}-t`, { status: "needs_attention" })]),
      projects: async () => [{ id: "p1", key: "HA" }],
      pendingPermissions: async (h: string, q: { profile_id: string }) => (calls.push(`perms ${h} ${q.profile_id}`), []),
      messagePage: async () => ({ messages: [msg(5, "question", { question: "?", status: "pending" })], more: false, subagents: [] }),
    };
    const inbox = await loadBoardInbox(client, work, "Home");
    expect(calls.sort()).toEqual(["perms h1 h1-home", "perms h2 h2-home", "tasks h1 h1-home", "tasks h2 h2-home"]);
    expect(inbox.items.map((i) => `${i.hostId}:${i.kind}`)).toEqual(["h1:question", "h2:question"]);
    // A board that can't be read says why.
    const broken = await loadBoardInbox({ ...client, hosts: async () => Promise.reject(new Error("Unauthorized")) }, work, null);
    expect(broken).toEqual({ board: work, items: [], error: "Unauthorized" });
  });

  test("a board with no profile picked uses its first profile by name on every host, as Projects shows it", async () => {
    const asked: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client: any = {
      hosts: async () => [
        { id: "a", local: true, connected: true },
        { id: "b", local: false, connected: true, agents: true },
      ],
      // The hosts list their profiles in different orders.
      profiles: async (h: string) => (h === "a" ? [{ id: "w1", name: "Work" }, { id: "p1", name: "Personal" }] : [{ id: "p2", name: "Personal" }, { id: "w2", name: "Work" }]),
      profileTasks: async (_h: string, p: string) => (asked.push(p), []),
      projects: async () => [],
      pendingPermissions: async (_h: string, q: { profile_id: string }) => (asked.push(`perms ${q.profile_id}`), []),
      messagePage: async () => ({ messages: [], more: false, subagents: [] }),
    };
    await loadBoardInbox(client, work, null);
    expect(asked.sort()).toEqual(["perms w1", "perms w2", "w1", "w2"]);
    // A picked profile the board no longer has falls back the same way.
    asked.length = 0;
    await loadBoardInbox(client, work, "Gone");
    expect(asked.sort()).toEqual(["perms w1", "perms w2", "w1", "w2"]);
  });

  test("the assistant's prompts and attention, and its routine threads' prompts, show", async () => {
    const asked: string[] = [];
    const fetched: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client: any = {
      hosts: async () => [{ id: "h1", local: true, connected: true }],
      profiles: async () => [{ id: "me", name: "Me" }],
      // The board leaves the assistant out unless asked, and never lists routine threads.
      profileTasks: async (_h: string, p: string, assistant?: boolean) => (
        asked.push(`${p} ${!!assistant}`),
        assistant ? [task("asst", { project_id: null, task_type: "assistant", profile_id: "me", status: "needs_attention", attention_reason: "Asked you" })] : []
      ),
      projects: async () => [],
      pendingPermissions: async () => [perm("r1", "routine", "2026-11-03T11:00:00Z"), perm("r2", "elsewhere", "2026-11-03T12:00:00Z"), perm("r3", "gone", "2026-11-03T13:00:00Z")],
      task: async (_h: string, id: string) => {
        fetched.push(id);
        if (id === "gone") throw new Error("not found");
        return { task: task(id, { project_id: null, task_type: "routine", profile_id: id === "routine" ? "me" : "someone-else", title: "Morning brief" }), last_message: null, pending_permissions: 1 };
      },
      messagePage: async () => ({ messages: [], more: false, subagents: [] }),
    };
    const inbox = await loadBoardInbox(client, work, "Me");
    expect(asked).toEqual(["me true"]);
    expect(fetched.sort()).toEqual(["elsewhere", "gone", "routine"]);
    // The routine's prompt is there under its thread; another profile's routine and a task that's gone aren't.
    expect(inbox.items.map((i) => `${i.kind}:${i.taskId}`).sort()).toEqual(["attention:asst", "permission:routine"]);
    expect(inbox.items.find((i) => i.kind === "permission")).toMatchObject({ title: "Morning brief" });
  });
});
