import type { Message } from "@huntaway/client";
import { photoName, withAttachments } from "../src/attachments";
import { applyDelta, endsDelta, threadItems, withMessage } from "../src/thread";
import { groupTasks } from "../src/tasks";

const m = (id: number, kind: Message["kind"], data: unknown) => ({ id, task_id: "t", kind, data, created_at: "" }) as Message;

describe("the thread", () => {
  test("shows a routine's report with its name, outcome, text and its thread", () => {
    // As routines.rs posts them in the assistant's thread ("t").
    const brief = m(7, "report", { automation_id: "a1", automation: "Morning brief", task_id: "r9", key: "A-9", outcome: "reported", text: "3 mails need you." });
    const failed = m(8, "report", { automation: "Inbox sweep", task_id: "r10", key: "A-10", outcome: "failed", text: "Out of usage" });
    const old = m(9, "report", { outcome: "asked", text: "Which one?" });
    expect(threadItems([brief, failed, old])).toEqual([
      { type: "report", key: "7", automation: "Morning brief", outcome: "reported", text: "3 mails need you.", taskId: "r9", taskKey: "A-9" },
      { type: "report", key: "8", automation: "Inbox sweep", outcome: "failed", text: "Out of usage", taskId: "r10", taskKey: "A-10" },
      { type: "report", key: "9", automation: "A routine", outcome: "asked", text: "Which one?", taskId: undefined, taskKey: undefined },
    ]);
  });

  test("shows the user's messages, the agent's text and tool calls with their results, and prompts", () => {
    const msgs = [
      m(1, "user", { text: "Fix it" }),
      m(2, "claude", { type: "assistant", message: { content: [{ type: "text", text: "On it" }, { type: "tool_use", id: "c1", name: "Bash", input: { command: "ls" } }] } }),
      m(3, "claude", { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "c1", is_error: true }] } }),
      m(4, "claude", { type: "assistant", parent_tool_use_id: "x", message: { content: [{ type: "text", text: "subagent" }] } }),
      m(5, "permission", { request_id: "r1", status: "pending", tool_name: "Write", input: { file_path: "a" } }),
      m(6, "event", { level: "info", text: "Moved" }),
    ];
    expect(threadItems(msgs).map((i) => i.type)).toEqual(["user", "text", "tool", "permission", "event"]);
    expect(threadItems(msgs)[2]).toMatchObject({ name: "Bash", failed: true, done: true });
    expect(threadItems(msgs)[3]).toMatchObject({ requestId: "r1", status: "pending", tool: "Write" });
  });

  test("messages are kept in order, and an updated one replaces itself", () => {
    let list = withMessage([], m(2, "user", { text: "b" }));
    list = withMessage(list, m(1, "user", { text: "a" }));
    list = withMessage(list, m(2, "user", { text: "b2" }));
    expect(list.map((x) => [x.id, x.data.text])).toEqual([
      [1, "a"],
      [2, "b2"],
    ]);
  });

  test("the reply streams in until it's stored", () => {
    let d = applyDelta("", { type: "delta", text: "Hel" });
    d = applyDelta(d, { type: "delta", text: "lo" });
    expect(d).toBe("Hello");
    expect(applyDelta(d, { type: "delta_reset" })).toBe("");
    expect(endsDelta(m(1, "claude", { type: "assistant", message: { content: [] } }))).toBe(true);
    expect(endsDelta(m(1, "claude", { type: "assistant", parent_tool_use_id: "x" }))).toBe(false);
  });

  test("photos are listed after the message for the agent to read", () => {
    expect(withAttachments("Look", [{ path: "/d/attachments/1/a.jpg" }])).toBe("Look\n\nAttached files:\n- /d/attachments/1/a.jpg");
    expect(withAttachments("", [{ path: "/p" }])).toBe("Attached files:\n- /p");
    expect(withAttachments("Hi", [])).toBe("Hi");
    expect(photoName("IMG 0001.HEIC", "image/jpeg")).toBe("IMG-0001.jpg");
    expect(photoName(null, "image/png", 5)).toBe("photo-5.png");
  });

  test("tasks group by status, attention first", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = (id: string, status: string, position = 0): any => ({ id, status, position, kind: "task", updated_at: "" });
    const groups = groupTasks([t("a", "todo", 2), t("b", "needs_attention"), t("c", "todo", 1), t("d", "done")]);
    expect(groups.map((g) => [g.status, g.data.map((x) => x.id)])).toEqual([
      ["needs_attention", ["b"]],
      ["todo", ["c", "a"]],
      ["done", ["d"]],
    ]);
  });
});
