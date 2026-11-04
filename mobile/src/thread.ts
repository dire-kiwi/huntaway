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
  /** What one of the assistant's routines posted in its thread (API 111): its name, how its run ended, its text, and the
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

/** The streamed text of the agent's reply so far, from `delta` events, until the reply is stored. */
export function applyDelta(current: string, ev: { type: string; text?: string }): string {
  if (ev.type === "delta") return current + (ev.text ?? "");
  if (ev.type === "delta_reset") return "";
  return current;
}

/** A message ends the streamed preview when it's the agent's stored reply. */
export const endsDelta = (m: Message) => m.kind === "claude" && m.data?.type === "assistant" && !m.data?.parent_tool_use_id;

/** Whether a user message is the board's own (an empty start, or an automatic one), not shown as a bubble. */
export const hiddenUser = (it: ThreadItem) => it.type === "user" && !it.text.trim();
