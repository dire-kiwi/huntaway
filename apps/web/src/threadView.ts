// Which way a task's thread is drawn: from its items (itemThreads.ts and itemModel.ts, for a task whose items are its
// thread's source, and one kept as items on a host from API 119 with its Keep threads as items setting on) or from its
// messages (threadModel.ts, for every other task and older hosts), and what the composer and the prompt cards send for it: thread commands for one
// drawn from its items (docs/threads-api.md), the board's own routes otherwise.

import { useEffect } from "react";
import { api, hostSupports, THREAD_VIEW_API, type Message, type PermissionMode as BoardMode, type Task } from "./api";
import { useStore, useThreadMessages } from "./store";
import { itemModel } from "./itemModel";
import { retainItemThread, useItemThreads, type ItemThread } from "./itemThreads";
import { threadModel, type ThreadModel } from "./threadModel";
import type { PermissionMode, Resolution } from "./threads";

type Settings = ReturnType<typeof useStore.getState>["hostSettings"][string] | undefined;

/**
 * Whether a thread is drawn from its items: its items are its source (API 122: it has no messages since it moved onto
 * them), or it's kept as items, its host serves the view (API 119), and its setting is on there (turning it off goes
 * back to messages, which are still written for a task on them). Until the host's settings have loaded, a flagged task
 * is taken to have it on.
 */
function draws(task: Task, supports: boolean, settings: Settings, missing: boolean): boolean {
  if (task.thread_source === "items") return supports;
  return !!task.thread_items && supports && !(settings && !settings.thread_items) && !missing;
}

export function useDrawsItems(task: Task): boolean {
  const supports = useStore((s) => hostSupports(s.hosts.find((h) => h.id === task.host_id), THREAD_VIEW_API));
  const settings = useStore((s) => s.hostSettings[task.host_id]);
  const missing = useItemThreads((s) => !!s.missing[task.id]);
  return draws(task, supports, settings, missing);
}

/** useDrawsItems, as things are now (outside a component). */
export function drawsItems(task: Task): boolean {
  const s = useStore.getState();
  return draws(task, hostSupports(s.hosts.find((h) => h.id === task.host_id), THREAD_VIEW_API), s.hostSettings[task.host_id], !!useItemThreads.getState().missing[task.id]);
}

/** The task's thread from its items while `on`, kept loaded and followed while the component is mounted (if `load`). */
export function useItemThread(task: Task, on: boolean, load = true): ItemThread | undefined {
  useEffect(() => (on && load ? retainItemThread(task.host_id, task.id) : undefined), [on, load, task.host_id, task.id]);
  return useItemThreads((s) => (on ? s.threads[task.id] : undefined));
}

const NO_MESSAGES: Message[] = [];

/**
 * The model of the task's thread, either way, while it's loaded (`load`: loading it too, as the thread does; without,
 * it's there while something else shows the thread, as for the Agents pill).
 */
export function useThreadModel(task: Task, load: boolean): ThreadModel {
  const items = useDrawsItems(task);
  // Messages are only kept (and with `load`, loaded) for a thread drawn from them.
  const messages = useThreadMessagesIf(task.id, !items, load);
  const earlier = useStore((s) => s.threads[task.id]?.subagents);
  const thread = useItemThread(task, items, load);
  if (items) return itemModel(task.id, thread?.snap ?? EMPTY, task.running);
  return threadModel(task.id, messages ?? NO_MESSAGES, task.running, earlier);
}

const EMPTY = { items: [], requests: [] };

/** useThreadMessages while `on`; nothing (and no load) otherwise. */
function useThreadMessagesIf(taskId: string, on: boolean, load: boolean): Message[] | undefined {
  return useThreadMessages(on ? taskId : null, load);
}

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

/** Sends the agent a message, as the composer does: a thread command for a thread drawn from its items. */
export function sendMessage(task: Task, text: string): Promise<Task> {
  return drawsItems(task) ? command<Task>(task, { type: "send", text }) : api.send(task.host_id, task.id, text);
}

/** Stops the agent. */
export function stopAgent(task: Task): Promise<unknown> {
  return drawsItems(task) ? command(task, { type: "interrupt" }) : api.stop(task.host_id, task.id);
}

/** Changes the thread's permission mode (null: back to the one it inherits, which only the board's route does). */
export function setMode(task: Task, mode: BoardMode | null): Promise<Task> {
  const m = mode === null ? undefined : modeOf(mode);
  return drawsItems(task) && m ? command<Task>(task, { type: "set_options", permission_mode: m }) : api.updateTask(task.host_id, task.id, { permission_mode: mode });
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
