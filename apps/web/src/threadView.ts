// How a task's thread is drawn: from its items (itemThreads.ts and itemModel.ts), on a host that serves them (API 119;
// an older host's threads aren't drawn here), and what the composer and the prompt cards send for it: thread commands
// (docs/threads-api.md).

import { useEffect } from "react";
import { api, hostSupports, THREAD_VIEW_API, type PermissionMode as BoardMode, type Task } from "./api";
import { useStore } from "./store";
import { itemModel } from "./itemModel";
import { retainItemThread, useItemThreads, type ItemThread } from "./itemThreads";
import type { ThreadModel } from "./threadModel";
import type { PermissionMode, Resolution } from "./threads";

/** Whether the task's host serves its thread as items (API 119), which is the only way it's drawn here. */
export function useServesItems(task: Pick<Task, "host_id">): boolean {
  return useStore((s) =>
    hostSupports(
      s.hosts.find((h) => h.id === task.host_id),
      THREAD_VIEW_API,
    ),
  );
}

/**
 * Whether the task has a thread to load: its items are its source (API 122), it's kept as items (API 119), or it has
 * run, so it has messages, which its host moves onto items when it's opened (API 121). A new task has none until its
 * first message (a 404 from its host), and is drawn as an empty thread.
 */
export const hasThread = (t: Pick<Task, "thread_source" | "thread_items" | "session_id">) => t.thread_source === "items" || !!t.thread_items || !!t.session_id;

/** useServesItems, as things are now (outside a component). */
function servesItems(task: Pick<Task, "host_id">): boolean {
  return hostSupports(
    useStore.getState().hosts.find((h) => h.id === task.host_id),
    THREAD_VIEW_API,
  );
}

/** The task's thread from its items while `on`, kept loaded and followed while the component is mounted (if `load`). */
export function useItemThread(task: Task, on: boolean, load = true): ItemThread | undefined {
  useEffect(() => (on && load ? retainItemThread(task.host_id, task.id) : undefined), [on, load, task.host_id, task.id]);
  return useItemThreads((s) => (on ? s.threads[task.id] : undefined));
}

/**
 * The model of the task's thread while it's loaded (`load`: loading it too, as the thread does; without, it's there
 * while something else shows the thread, as for the Agents pill). Empty on a host that doesn't serve it.
 */
export function useThreadModel(task: Task, load: boolean): ThreadModel {
  const on = useServesItems(task) && hasThread(task);
  const thread = useItemThread(task, on, load);
  return itemModel(task.id, thread?.snap ?? EMPTY, task.running);
}

const EMPTY = { items: [], requests: [] };

// ---------- what's sent ----------

/** The board's permission modes (PermissionMode in api) as the thread model names them. */
const MODES: Record<string, PermissionMode> = {
  default: "default",
  acceptEdits: "accept_edits",
  auto: "auto",
  plan: "plan",
  dontAsk: "dont_ask",
  bypassPermissions: "bypass",
};
export const modeOf = (m: BoardMode | string): PermissionMode | undefined => MODES[m];

/** A thread command for the task, through the board's own route for it: what the route answered. */
async function command<R>(task: Pick<Task, "host_id" | "id">, cmd: { type: string; [k: string]: unknown }): Promise<R> {
  return (await api.threadCommand<R>(task.host_id, task.id, cmd)).result;
}

/**
 * Whether the task's thread takes commands: it's kept as items (its host has no thread for a new task until its first
 * message, which the board's own route sends, and moves it onto items). A host older than API 119 (whose threads aren't
 * drawn here) is sent the board's own routes too, as the composer outside the thread (a document's, the triage view's)
 * still sends to one.
 */
const takesCommands = (task: Task) => (task.thread_source === "items" || !!task.thread_items) && servesItems(task);

/** Sends the agent a message, as the composer does. */
export function sendMessage(task: Task, text: string): Promise<Task> {
  return takesCommands(task) ? command<Task>(task, { type: "send", text }) : api.send(task.host_id, task.id, text);
}

/** Stops the agent. */
export function stopAgent(task: Task): Promise<unknown> {
  return takesCommands(task) ? command(task, { type: "interrupt" }) : api.stop(task.host_id, task.id);
}

/** Changes the thread's permission mode (null: back to the one it inherits, which only the board's route does). */
export function setMode(task: Task, mode: BoardMode | null): Promise<Task> {
  const m = mode === null ? undefined : modeOf(mode);
  return takesCommands(task) && m
    ? command<Task>(task, { type: "set_options", permission_mode: m })
    : api.updateTask(task.host_id, task.id, { permission_mode: mode });
}

/** Answers one of the thread's requests with a `respond` command. */
export function respond(task: Pick<Task, "host_id" | "id">, request_id: string, resolution: Resolution): Promise<unknown> {
  return command(task, { type: "respond", request_id, resolution });
}

/**
 * A question request's answers, given as a list for each of its questions in order (as its card has them), by the
 * questions' ids, as `respond` takes them. The request is the one in the task's thread as it's shown.
 */
export function answersById(taskId: string, request_id: string, lists: string[][]): { [k: string]: string[] } {
  const r = useItemThreads.getState().threads[taskId]?.snap?.requests.find((x) => x.id === request_id);
  if (!r || r.type !== "question") throw new Error("That question isn't in the thread any more.");
  return Object.fromEntries(r.questions.map((q, i) => [q.id, lists[i] ?? []]));
}
