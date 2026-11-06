// What a thread shows on the phone, from its stored messages: the user's messages, the agent's text, its tool calls
// in one line each (with whether they failed), the board's events, the prompts and questions (answerable while
// they're pending), and the reports the assistant's routines post. A simpler cut of the web board's threadModel.ts.
import type { Message } from "@huntaway/client";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

export type ThreadItem =
  | { type: "user"; key: string; text: string; auto?: boolean }
  | { type: "text"; key: string; text: string }
  | { type: "tool"; key: string; id: string; name: string; input: Any; failed?: boolean; done: boolean }
  | { type: "event"; key: string; level: string; text: string }
  | { type: "permission"; key: string; requestId: string; status: string; tool: string; input: Any }
  | { type: "question"; key: string; id: number; data: Any }
  /** What one of the assistant's routines posted in its thread (API 110): its name, how its run ended, its text, and the
   *  routine thread it came from, to open. */
  | { type: "report"; key: string; automation: string; outcome: string; text: string; taskId?: string; taskKey?: string }
  | { type: "result"; key: string; error: boolean; text: string };

/** Messages in id order, with `m` added or put in place of the one with its id. */
export function withMessage(list: Message[], m: Message): Message[] {
  const i = list.findIndex((x) => x.id === m.id);
  if (i >= 0) return list.map((x, j) => (j === i ? m : x));
  if (!list.length || list[list.length - 1].id < m.id) return [...list, m];
  return [...list, m].sort((a, b) => a.id - b.id);
}

/** The items of a thread's main conversation (subagents' own messages are left out). */
export function threadItems(messages: Message[]): ThreadItem[] {
  const items: ThreadItem[] = [];
  const results = new Map<string, boolean>();
  for (const m of messages) {
    if (m.kind !== "claude" || m.data?.type !== "user") continue;
    const content = m.data.message?.content;
    if (Array.isArray(content)) for (const b of content) if (b?.type === "tool_result") results.set(b.tool_use_id, !!b.is_error);
  }
  for (const m of messages) {
    const k = String(m.id);
    const d = m.data ?? {};
    if (d.parent_tool_use_id) continue;
    if (m.kind === "user") items.push({ type: "user", key: k, text: d.text ?? "", auto: d.auto });
    else if (m.kind === "event") items.push({ type: "event", key: k, level: d.level ?? "info", text: d.text ?? "" });
    else if (m.kind === "permission")
      items.push({ type: "permission", key: k, requestId: d.request_id ?? "", status: d.status ?? "", tool: d.tool_name ?? d.tool ?? "", input: d.input });
    else if (m.kind === "question") items.push({ type: "question", key: k, id: m.id, data: d });
    else if (m.kind === "report")
      items.push({
        type: "report",
        key: k,
        automation: String(d.automation ?? "A routine"),
        outcome: String(d.outcome ?? "reported"),
        text: String(d.text ?? ""),
        taskId: typeof d.task_id === "string" && d.task_id !== m.task_id ? d.task_id : undefined,
        taskKey: typeof d.key === "string" ? d.key : undefined,
      });
    else if (m.kind === "claude" && d.type === "assistant") {
      (d.message?.content ?? []).forEach((b: Any, i: number) => {
        const key = `${k}.${i}`;
        if (b?.type === "text" && b.text?.trim()) items.push({ type: "text", key, text: b.text });
        else if (b?.type === "tool_use") items.push({ type: "tool", key, id: b.id, name: b.name, input: b.input, failed: results.get(b.id), done: results.has(b.id) });
      });
    } else if (m.kind === "claude" && d.type === "result" && d.is_error) items.push({ type: "result", key: k, error: true, text: String(d.result ?? d.subtype ?? "The run failed") });
  }
  return items;
}

/** A message ends the streamed preview when it's the agent's stored reply. */
export const endsDelta = (m: Message) => m.kind === "claude" && m.data?.type === "assistant" && !m.data?.parent_tool_use_id;

/** Whether a user message is the board's own (an empty start, or an automatic one), not shown as a bubble. */
export const hiddenUser = (it: ThreadItem) => it.type === "user" && !it.text.trim();

// ---------- a thread kept as items ----------

// A task whose items are its thread's source (API 122, `thread_source`, see docs/threads.md) has no messages since it
// moved onto them: its thread is read from `GET /tasks/{id}/thread` (a window of its last items) and its pages, whose
// items and requests are server-ts/src/threads/protocol.ts's. These give what threadItems gives from messages.

/** The message an item made from one names in its id (`legacy:<message id>[:<block>]`). */
const messageOf = (id: string): number | undefined => {
  const m = /^legacy:(\d+)(?::|$)/.exec(id);
  return m ? Number(m[1]) : undefined;
};

/** A tool call's tool's name as the harness gave it, as the web's itemModel.ts has it: an MCP tool's item has its server's
 *  name apart, and the board's own tools (kind `app`) are on its `app` server. */
const toolName = (it: Any): string => (it.kind === "mcp" && it.server ? `mcp__${it.server}__${it.name}` : it.kind === "app" ? `mcp__app__${it.name}` : it.name);

/** A request (a prompt or a question) as a row: a question the board asked (request_user_input, a merge card), or a prompt. */
function requestItem(r: Any): ThreadItem {
  const { message_id: n, ...md } = (r.metadata ?? {}) as Any;
  if (r.type === "question" && r.id === `legacy:${n}` && md.tool_name === undefined) return { type: "question", key: r.id, id: n, data: md };
  const status = typeof md.status === "string" ? md.status : r.resolution ? "answered" : "pending";
  return { type: "permission", key: r.id, requestId: md.request_id ?? r.id, status, tool: md.tool_name ?? r.name ?? "", input: md.input ?? r.input };
}

/**
 * The items of a thread kept as items, as threadItems gives them from messages: its main conversation's items (not a
 * window's context items, the first `context` of them, nor subagents' own), with its requests among them: a prompt
 * after the call it's for, the rest in the order their messages were written.
 */
export function itemThreadItems(items: Any[], requests: Any[], context = 0): ThreadItem[] {
  const out: ThreadItem[] = [];
  const asked = requests.map((r) => ({ r, at: typeof r.metadata?.message_id === "number" ? r.metadata.message_id : Infinity })).sort((a, b) => a.at - b.at);
  const calls = new Set(items.filter((it) => it.type === "tool_call").map((it) => it.id));
  const placed = new Set<Any>();
  const put = (r: Any) => {
    if (placed.has(r)) return;
    placed.add(r);
    out.push(requestItem(r));
  };
  let next = 0;
  const upTo = (at: number) => {
    for (; next < asked.length && asked[next].at < at; next++) if (!calls.has(asked[next].r.tool_call_id)) put(asked[next].r);
  };
  for (const it of items.slice(context)) {
    if (it.parent_id) continue;
    const n = messageOf(it.id);
    if (n !== undefined) upTo(n);
    const md = it.metadata ?? {};
    if (it.type === "user_message") out.push({ type: "user", key: it.id, text: it.text ?? "", auto: md.auto });
    else if (it.type === "assistant_message" && !md.from_result && it.text?.trim()) out.push({ type: "text", key: it.id, text: it.text });
    else if (it.type === "tool_call") {
      const name = toolName(it);
      const done = it.status !== "running" && it.status !== "pending";
      out.push({ type: "tool", key: it.id, id: it.id, name, input: it.input, failed: done ? it.status !== "completed" : undefined, done });
      for (const { r } of asked) if (r.tool_call_id === it.id) put(r);
    } else if (it.type === "notice" && it.code === "routine_report") {
      out.push({
        type: "report",
        key: it.id,
        automation: String(md.automation ?? "A routine"),
        outcome: String(md.outcome ?? "reported"),
        text: String(md.text ?? it.text ?? ""),
        taskId: typeof md.task_id === "string" ? md.task_id : undefined,
        taskKey: typeof md.key === "string" ? md.key : undefined,
      });
    } else if (it.type === "notice" && it.code === "interrupted") {
      // Claude Code's "[Request interrupted…]", which its messages draw nothing for.
    } else if (it.type === "notice" && it.level === "error" && it.code) out.push({ type: "text", key: it.id, text: it.text ?? "" });
    else if (it.type === "notice") out.push({ type: "event", key: it.id, level: it.level ?? "info", text: it.text ?? "" });
    else if (it.type === "turn_result" && !it.ok && !it.interrupted) out.push({ type: "result", key: it.id, error: true, text: String(it.error ?? "The run failed") });
  }
  for (const { r } of asked) put(r);
  return out;
}

/**
 * The question the board asked (request_user_input, a merge card) that a thread kept as items still waits on, as its
 * message would be (for the Inbox): the latest such request still open.
 */
export function openItemQuestion(taskId: string, requests: Any[]): Message | undefined {
  const open = requests.map(requestItem).filter((it): it is Extract<ThreadItem, { type: "question" }> => it.type === "question" && it.data?.status === "pending");
  const last = open[open.length - 1];
  if (!last) return undefined;
  const r = requests.find((x) => x.id === last.key);
  return { id: last.id, task_id: taskId, kind: "question", data: last.data, created_at: r?.created_at ?? "" };
}
