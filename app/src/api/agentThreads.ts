// A task's agent-threads thread (API 105, docs/agent-threads-api.md): windows of it, pages of earlier
// items, its saved events after a seq, and the commands the board's own routes don't carry out. The
// shapes are agent-threads' protocol, unchanged.
import type { Command, ItemPage, Snapshot, ThreadEvent } from "@dire-kiwi/agent-threads-protocol";
import { enc, on } from "./http";

/** The host API that serves tasks' agent-threads threads, and sends their events on /api/ws (`thread_event`). */
export const AGENT_THREADS_API = 105;

/** A page of a thread's saved events: with `more`, ask again after `seq` (which is how far they go, unknown ones included). */
export interface ThreadEvents {
  events: ThreadEvent[];
  more: boolean;
  seq: number;
}

/** A command for the task's thread, without its thread_id (the route fills it in). */
export type ThreadCommand = Command extends infer C ? (C extends unknown ? Omit<C, "thread_id"> & { thread_id?: string } : never) : never;

export const agentThreadsApi = {
  /** The thread's last `limit` items (the whole thread if it has no more), with `start` and `context` for a window. */
  threadWindow: (h: string, id: string, limit: number) => on(h).get<Snapshot>(`/tasks/${enc(id)}/thread?limit=${limit}`),
  /** The items before index `before` (a window's `start`). */
  threadItemsBefore: (h: string, id: string, before: number, limit: number) =>
    on(h).get<ItemPage>(`/tasks/${enc(id)}/thread/items?before=${before}&limit=${limit}`),
  /** The saved events after `after` (no deltas). */
  threadEvents: (h: string, id: string, after: number) => on(h).get<ThreadEvents>(`/tasks/${enc(id)}/thread/events?after=${after}`),
  /** `respond`, `compact` or `new_session`; the others go through the board's routes. */
  threadCommand: (h: string, id: string, command: ThreadCommand) => on(h).post<{ ok: true }>(`/tasks/${enc(id)}/thread/commands`, command),
};
