// Subagents Claude or Codex starts during a run, derived from the stored stream-json messages.
// Codex's adapter gives each child thread a stable Agent row. A subagent's own messages carry
// its row's tool_use_id as `parent_tool_use_id`.

import { create } from "zustand";
import type { Message } from "./api";

export type SubagentStatus = "running" | "completed" | "failed" | "stopped";

export interface Subagent {
  /** tool_use_id of the launching call (Agent/Task, or a forked Skill). */
  id: string;
  description: string;
  prompt: string;
  agentType?: string;
  model?: string;
  background: boolean;
  status: SubagentStatus;
  /** Latest progress line while running (e.g. "Reading b.txt"). */
  activity?: string;
  /** Final report of a background subagent (a foreground one returns it as its tool result). */
  summary?: string;
  toolUses?: number;
  /** One of its tool calls is waiting on a permission prompt. */
  awaitingApproval?: boolean;
  startedAt: string;
  /** The message with its call: a long thread shows it once that's loaded. */
  messageId: number;
  endedAt?: string;
  /** The subagent that started this one, for nested subagents. */
  parent: string | null;
}

export const isAgentTool = (name: string) => name === "Agent" || name === "Task";

function terminal(status: unknown): SubagentStatus | null {
  switch (status) {
    case "completed":
    case "success":
      return "completed";
    case "failed":
    case "error":
      return "failed";
    case "killed":
    case "stopped":
    case "cancelled":
    case "interrupted":
      return "stopped";
  }
  return null;
}

const ASYNC_LAUNCHED = /^\s*Async agent launched/;

function firstText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => (typeof c === "string" ? c : (c?.text ?? ""))).join("\n");
  return "";
}

/**
 * All subagents in a thread, in start order. `running` is whether the thread's agent is still
 * running: a subagent that never reported an end in a finished run was stopped with it.
 */
export function buildSubagents(messages: Message[], running: boolean): Subagent[] {
  const byId = new Map<string, Subagent>();
  const byTaskId = new Map<string, string>();
  // A Skill can fork a local_agent without an Agent/Task call. Its lifecycle identifies the
  // launch; keep the call's message to reveal that row and retain its parent if nested.
  const callMessages = new Map<string, Message>();
  // Tool calls made inside subagents. A permission prompt can be stored before the call's message.
  const callParent = new Map<string, string>();
  for (const m of messages) {
    const d = m.kind === "claude" && m.data?.type === "assistant" ? m.data : null;
    for (const b of d?.message?.content ?? []) if (b.type === "tool_use") {
      callMessages.set(b.id, m);
      if (d.parent_tool_use_id) callParent.set(b.id, d.parent_tool_use_id);
    }
  }
  const finish = (s: Subagent, status: SubagentStatus, at: string) => {
    s.status = status;
    s.endedAt ??= at;
  };
  for (const m of messages) {
    const d = m.data;
    if (m.kind !== "claude") continue;
    if (d?.type === "assistant") {
      for (const b of d.message?.content ?? []) {
        if (b.type !== "tool_use" || !isAgentTool(b.name) || byId.has(b.id)) continue;
        byId.set(b.id, {
          id: b.id,
          description: b.input?.description ?? "",
          prompt: b.input?.prompt ?? "",
          agentType: b.input?.subagent_type,
          model: b.input?.model,
          background: !!b.input?.run_in_background,
          status: "running",
          startedAt: m.created_at,
          messageId: m.id,
          parent: d.parent_tool_use_id ?? null,
        });
      }
    } else if (d?.type === "user") {
      for (const b of d.message?.content ?? []) {
        const s = b.type === "tool_result" ? byId.get(b.tool_use_id) : undefined;
        if (!s) continue;
        const meta = d.tool_use_result;
        if (meta?.resolvedModel) s.model = meta.resolvedModel;
        if (meta?.agentType) s.agentType = meta.agentType;
        if (meta?.totalToolUseCount != null) s.toolUses = meta.totalToolUseCount;
        // A background subagent's call returns at once; it ends with a task_notification.
        if (meta?.isAsync || meta?.status === "async_launched" || ASYNC_LAUNCHED.test(firstText(b.content))) s.background = true;
        else if (s.status === "running") finish(s, b.is_error ? "failed" : (terminal(meta?.status) ?? "completed"), m.created_at);
      }
    } else if (d?.type === "system") {
      let s = d.tool_use_id ? byId.get(d.tool_use_id) : byTaskId.get(d.task_id) ? byId.get(byTaskId.get(d.task_id)!) : undefined;
      if (!s && d.subtype === "task_started" && d.task_type === "local_agent" && d.tool_use_id) {
        const launch = callMessages.get(d.tool_use_id) ?? m;
        s = { id: d.tool_use_id, description: "", prompt: "", background: false, status: "running",
          startedAt: launch.created_at, messageId: launch.id, parent: launch.data.parent_tool_use_id ?? null };
        byId.set(s.id, s);
      }
      if (!s) continue;
      if (d.task_id) byTaskId.set(d.task_id, s.id);
      switch (d.subtype) {
        case "task_started":
          if (d.is_backgrounded != null) s.background = !!d.is_backgrounded;
          if (d.subagent_type) s.agentType = d.subagent_type;
          if (d.prompt) s.prompt = d.prompt;
          if (d.description) s.description = d.description;
          if (d.model) s.model = d.model;
          if (Object.hasOwn(d, "parent_tool_use_id")) s.parent = d.parent_tool_use_id;
          break;
        case "task_progress":
          if (d.description) s.activity = d.description;
          if (d.usage?.tool_uses != null) s.toolUses = d.usage.tool_uses;
          break;
        case "task_updated": {
          const t = terminal(d.patch?.status);
          if (d.patch?.status === "running") {
            s.status = "running";
            s.endedAt = undefined;
            s.summary = undefined;
          } else if (t && s.status === "running") finish(s, t, m.created_at);
          break;
        }
        case "task_notification": {
          if (d.summary) s.summary = d.summary;
          if (d.usage?.tool_uses != null) s.toolUses = d.usage.tool_uses;
          const t = terminal(d.status);
          if (t && s.status === "running") finish(s, t, m.created_at);
          break;
        }
      }
    }
  }
  for (const m of messages) {
    const d = m.data;
    const s = m.kind === "permission" && d?.status === "pending" && d.tool_use_id ? byId.get(callParent.get(d.tool_use_id) ?? "") : undefined;
    if (s) s.awaitingApproval = true;
  }
  const list = [...byId.values()];
  if (!running) for (const s of list) if (s.status === "running") s.status = "stopped";
  return list;
}

export function subagentTitle(s: Pick<Subagent, "description" | "prompt" | "agentType">) {
  return s.description || s.prompt.split("\n")[0].slice(0, 80) || s.agentType || "Subagent";
}

export function duration(s: Subagent): string | null {
  if (!s.endedAt) return null;
  const ms = Date.parse(s.endedAt) - Date.parse(s.startedAt);
  if (!(ms >= 0)) return null;
  const sec = Math.round(ms / 1000);
  return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m ${sec % 60}s`;
}

/**
 * Ask a task's thread to reveal a subagent's row in the main conversation, expanding the rows around
 * it. The request is pending until that row has shown itself (`handled`): rows that mount on the way,
 * as their parents expand, still act on it, and ones that mount after it don't.
 */
export const useSubagentFocus = create<{
  focus: { taskId: string; id: string; n: number } | null;
  /** The latest request that's been dealt with. */
  handled: number;
  reveal: (taskId: string, id: string) => void;
  handle: (n: number) => void;
}>((set, get) => ({
  focus: null,
  handled: 0,
  reveal: (taskId, id) => set({ focus: { taskId, id, n: (get().focus?.n ?? 0) + 1 } }),
  handle: (n) => set({ handled: Math.max(get().handled, n) }),
}));

/** The subagent each task's thread shows in full in place of the main conversation, by task id. */
export const useSubagentView = create<{ open: Record<string, string | undefined>; show: (taskId: string, id: string | null) => void }>((set) => ({
  open: {},
  show: (taskId, id) => set((s) => ({ open: { ...s.open, [taskId]: id ?? undefined } })),
}));
