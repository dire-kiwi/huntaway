// HA-222: a task whose items are its thread's source has no messages since it moved onto them, so the phone draws it
// from `GET /tasks/{id}/thread`. Its rows from the items the server's translator makes of a thread are the rows its
// messages gave, and its Inbox question is the one its messages gave.
import type { Message } from "@huntaway/client";
import { convert } from "../../server/src/threads/translate";
import { openQuestion } from "../src/inbox";
import { itemThreadItems, openItemQuestion, threadItems } from "../src/thread";

const m = (id: number, kind: Message["kind"], data: unknown) => ({ id, task_id: "t", kind, data, created_at: `2026-11-06T10:00:${String(id).padStart(2, "0")}.000Z` }) as Message;

const thread = [
  m(1, "user", { text: "Start working on this task.", auto: true, start: true }),
  m(2, "event", { level: "info", text: "Worktree ready" }),
  m(3, "claude", { type: "assistant", message: { content: [{ type: "text", text: "On it" }, { type: "tool_use", id: "c1", name: "Bash", input: { command: "ls" } }] } }),
  m(4, "permission", { request_id: "r1", status: "allowed", tool_name: "Bash", input: { command: "ls" }, tool_use_id: "c1" }),
  m(5, "claude", { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "c1", content: "a b", is_error: true }] } }),
  m(6, "claude", { type: "assistant", message: { content: [{ type: "tool_use", id: "c2", name: "mcp__huntaway__list_tasks", input: {} }] } }),
  m(7, "claude", { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "c2", content: "[]" }] } }),
  m(8, "claude", { type: "assistant", message: { content: [{ type: "text", text: "Which one?" }] } }),
  m(9, "question", { question: "Which colour?", options: [{ label: "Red" }], status: "pending", call_id: "q1" }),
  m(10, "report", { automation: "Inbox", outcome: "reported", text: "2 mails", task_id: "r9", key: "A-9" }),
  m(11, "claude", { type: "result", subtype: "error_during_execution", is_error: true, result: "It broke" }),
  // A Stop: Claude Code's "[Request interrupted…]", which the messages draw nothing for.
  m(12, "claude", { type: "user", message: { content: [{ type: "text", text: "[Request interrupted by user]" }] } }),
  // One of the board's own tools, on its `app` server (an `app` call, named apart from its server).
  m(14, "claude", { type: "assistant", message: { content: [{ type: "tool_use", id: "c3", name: "mcp__app__set_title", input: { title: "T" } }] } }),
  m(15, "claude", { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "c3", content: "ok" }] } }),
];

/** What a row shows, without its key (the two keep their own). */
const shown = (it: any) => {
  const { key: _, ...rest } = it;
  return JSON.parse(JSON.stringify(rest));
};

describe("a thread kept as items", () => {
  test("gives the rows its messages give", () => {
    const { items, requests } = convert(thread, { finished: false });
    expect(itemThreadItems(items, requests).map(shown)).toEqual(threadItems(thread).map(shown));
  });

  test("draws no row for a Stop's interruption, and names the board's own tools as the web does", () => {
    const { items, requests } = convert(thread, { finished: false });
    expect(items.some((it) => it.type === "notice" && it.code === "interrupted")).toBe(true);
    expect(items.some((it) => it.type === "tool_call" && it.kind === "app" && it.name === "set_title")).toBe(true);
    const rows = itemThreadItems(items, requests);
    expect(rows.filter((r) => r.type === "event").map((r: any) => r.text)).toEqual(["Worktree ready"]);
    expect(rows.filter((r) => r.type === "tool").map((r: any) => r.name)).toEqual(["Bash", "mcp__huntaway__list_tasks", "mcp__app__set_title"]);
  });

  test("leaves out a window's context items and subagents' own items", () => {
    const { items, requests } = convert(thread, { finished: false });
    const rows = itemThreadItems([{ id: "ctx", type: "user_message", text: "context" }, ...items, { id: "s1", type: "assistant_message", text: "sub", parent_id: "c1" }], requests, 1);
    expect(rows.map((r) => r.type)).toEqual(threadItems(thread).map((r) => r.type));
  });

  test("its open question is the one its messages had, until it's answered", () => {
    const { requests } = convert(thread, { finished: false });
    expect(openItemQuestion("t", requests)).toEqual(openQuestion(thread));
    const answered = [...thread.slice(0, 8), m(9, "question", { question: "Which colour?", options: [{ label: "Red" }], status: "answered", call_id: "q1" })];
    expect(openItemQuestion("t", convert(answered, { finished: false }).requests)).toBeUndefined();
  });
});
