// The context meter for a task: the board's (`task.context`), or for an agent-threads task the board
// hasn't measured, its thread's latest turn's tokens.
import type { Item } from "@dire-kiwi/agent-threads-protocol";
import { useThreadState } from "@dire-kiwi/agent-threads-react";
import { useMemo } from "react";
import type { ContextSummary, Task } from "../../../api";
import { ContextPill } from "../Context";
import { useIsAgentThread } from "./Provider";

export function TaskContextPill({ task }: { task: Task }) {
  const at = useIsAgentThread(task);
  return at && !task.context ? <ThreadContextPill task={task} /> : <ContextPill task={task} />;
}

function ThreadContextPill({ task }: { task: Task }) {
  const items = useThreadState((s) => s.snapshot.items);
  const model = useThreadState((s) => s.snapshot.thread.model);
  const ctx = useMemo(() => threadContext(items, model ?? null), [items, model]);
  const shown = useMemo(() => (ctx ? { ...task, context: ctx } : task), [task, ctx]);
  return <ContextPill task={shown} />;
}

/** What the agent's context held at the end of the main thread's latest turn that says: its input tokens, read from the cache or not. */
export function threadContext(items: readonly Item[], model: string | null): ContextSummary | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.type !== "turn_result" || it.parent_id || !it.usage) continue;
    const u = it.usage;
    const tokens = u.input_tokens + (u.cache_read_tokens ?? 0) + (u.cache_write_tokens ?? 0);
    if (!tokens) continue;
    return { tokens, max_tokens: null, compact_at: null, model, updated_at: it.created_at ?? "", detail_at: null };
  }
  return null;
}
