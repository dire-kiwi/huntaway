// Tasks' agent-threads threads on the client (API 105, docs/agent-threads-api.md): their events from
// /api/ws (`thread_event`), handed to the threads shown, and the ThreadSource each one's drawn from.
// The package's ThreadStore applies the events, and asks the source to catch up when it sees a gap.
import type { ItemPage, Snapshot, ThreadEvent } from "@dire-kiwi/agent-threads-protocol";
import type { ThreadSource } from "@dire-kiwi/agent-threads-react";
import { api, ApiError, hostSupports, AGENT_THREADS_API, type Host, type Task } from "./api";

/** How many items a thread starts with, and loads at a time as it's scrolled up. */
export const THREAD_PAGE = 100;

type Listener = (event: ThreadEvent) => void;

/** The threads shown, by host and task: who to give their events to, and to tell when some may have been missed. */
const feeds = new Map<string, { events: Set<Listener>; missed: Set<() => void> }>();
const feedKey = (hostId: string, taskId: string) => `${hostId}\n${taskId}`;

function feed(hostId: string, taskId: string) {
  const key = feedKey(hostId, taskId);
  let f = feeds.get(key);
  if (!f) feeds.set(key, (f = { events: new Set(), missed: new Set() }));
  return f;
}

function unlisten(hostId: string, taskId: string, events?: Listener, missed?: () => void) {
  const key = feedKey(hostId, taskId);
  const f = feeds.get(key);
  if (!f) return;
  if (events) f.events.delete(events);
  if (missed) f.missed.delete(missed);
  if (!f.events.size && !f.missed.size) feeds.delete(key);
}

/** A `thread_event` from /api/ws, for task `taskId` on host `hostId`. */
export function threadEvent(hostId: string, taskId: string, event: ThreadEvent) {
  const f = feeds.get(feedKey(hostId, taskId));
  if (f) for (const l of [...f.events]) l(event);
}

/**
 * Events may have been missed: the host's forwarding fell behind (`thread_resync`), a linked host
 * reconnected or the socket lagged (`resync`), or the socket itself reconnected. The threads shown
 * (on `hostId`, or on every host) catch up from where they are.
 */
export function threadsMissed(hostId?: string) {
  for (const [key, f] of feeds) if (!hostId || key.startsWith(`${hostId}\n`)) for (const l of [...f.missed]) l();
}

/** Calls `fn` with each of the task's thread events, deltas included. Returns how to stop. */
export function onThreadEvents(hostId: string, taskId: string, fn: Listener): () => void {
  feed(hostId, taskId).events.add(fn);
  return () => unlisten(hostId, taskId, fn);
}

/** Whether the host serves agent-threads threads. */
export const hostHasThreads = (host: Host | undefined) => hostSupports(host, AGENT_THREADS_API);

/**
 * What a task's shown with: agent-threads' components for a task that runs on agent-threads, on a
 * host that serves its thread (`agent_threads`); the board's own thread for the others (`legacy`).
 * With `ia.stagedThreads` set in localStorage, any task on such a host is tried (`probe`), to look
 * at threads staged with `huntaway threads-import --stage`: one with none is shown as before.
 */
export function threadEngine(task: Pick<Task, "run_engine">, host: Host | undefined): "agent_threads" | "probe" | "legacy" {
  if (!hostHasThreads(host)) return "legacy";
  if (task.run_engine === "agent_threads") return "agent_threads";
  return stagedThreads() ? "probe" : "legacy";
}

function stagedThreads(): boolean {
  try {
    return localStorage.getItem("ia.stagedThreads") === "1";
  } catch {
    return false;
  }
}

/** Whether a failed load means the task has no thread (it's a legacy task, or hasn't started on agent-threads yet). */
export const noThread = (e: unknown) => e instanceof ApiError && e.status === 404;

/**
 * The source for a task's thread: its window (from `loadWindow`, with `limit` items), its events from
 * /api/ws, missed ones from `/thread/events`, and earlier items from `/thread/items`. It listens
 * before it loads the window, and keeps what comes before the ThreadStore subscribes for it (the
 * store skips what the window has). Call `close` once it's not used any more.
 */
export async function taskThreadSource(
  hostId: string,
  taskId: string,
  loadWindow: (limit: number) => Promise<Snapshot>,
  limit: number,
): Promise<ThreadSource & { close: () => void }> {
  const listeners = new Set<Listener>();
  // Events that came while nobody listened (before the store connected, or while React remounted it).
  let early: ThreadEvent[] = [];
  // The latest seq known to be saved, for catching up after events may have been missed.
  let seq = 0;
  const take = (e: ThreadEvent) => {
    if (e.type !== "delta" && e.seq > seq) seq = e.seq;
    if (!listeners.size) {
      early.push(e);
      if (early.length > 5000) early = early.slice(-5000);
      return;
    }
    for (const l of [...listeners]) l(e);
  };
  // Some may have been missed: fetch them from where the latest one heard of is, and hand them over
  // as the socket would have (the store drops those it has, and asks for any gap itself).
  const missed = () => {
    if (!listeners.size) return;
    void fetchEvents(hostId, taskId, seq).then(
      (events) => {
        for (const e of events) for (const l of [...listeners]) l(e);
        for (const e of events) if (e.seq > seq) seq = e.seq;
      },
      (e) => console.warn("Couldn't catch up on the thread's events", e),
    );
  };
  const f = feed(hostId, taskId);
  f.events.add(take);
  f.missed.add(missed);
  const close = () => unlisten(hostId, taskId, take, missed);
  let snapshot: Snapshot;
  try {
    snapshot = await loadWindow(limit);
  } catch (e) {
    close();
    throw e;
  }
  if (snapshot.seq > seq) seq = snapshot.seq;
  early = early.filter((e) => e.type === "delta" || e.seq > snapshot.seq);
  return {
    snapshot,
    subscribe(listener) {
      listeners.add(listener);
      const held = early;
      early = [];
      for (const e of held) listener(e);
      return () => void listeners.delete(listener);
    },
    resync: (from) => fetchEvents(hostId, taskId, from),
    loadEarlier: (before): Promise<ItemPage> => api.threadItemsBefore(hostId, taskId, before, limit),
    close,
  };
}

/** The thread's saved events after `after`, every page of them. */
async function fetchEvents(hostId: string, taskId: string, after: number): Promise<ThreadEvent[]> {
  const out: ThreadEvent[] = [];
  for (let from = after, pages = 0; pages < 50; pages++) {
    const page = await api.threadEvents(hostId, taskId, from);
    out.push(...page.events);
    if (!page.more || page.seq <= from) break;
    from = page.seq;
  }
  return out;
}
