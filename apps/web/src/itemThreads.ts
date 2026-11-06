// The threads shown, drawn from their items (docs/threads-api.md) and kept up to date while they're shown: each starts
// from a window of its last items, follows its `thread_event`s with the shared reducer (threads.ts's apply_event),
// catches up from its seq after a gap or a reconnect, takes a fresh window on a `thread_resync`, and loads earlier items
// a page at a time. Streamed text (delta events, for an item the thread doesn't have yet) goes in deltas.ts's store.
// itemModel.ts makes what the view draws of it.

import { create } from "zustand";
import { ApiError, api } from "./api";
import { addDelta, clearDelta } from "./deltas";
import { forgetItemModels } from "./itemModel";
import { apply_event, is_gap, with_page, type DeltaEvent, type ItemPage, type SavedEvent, type Snapshot, type ThreadEvent } from "./threads";

export interface ItemThread {
  /** The window shown (its earlier pages put in as they load); null until it has loaded. */
  snap: Snapshot | null;
  /** An earlier page is loading. */
  loading: boolean;
  /** Its window couldn't be loaded. */
  failed: boolean;
}

/**
 * The threads shown from their items, by task id, and those whose host had no items for them (a 404: a task still on
 * its messages, on a host from before every task moved onto items with its Keep threads as items setting off), which
 * the view says it can't show. That's kept for the page's life, unless the thread is rebuilt (a thread_resync).
 */
export const useItemThreads = create<{ threads: Record<string, ItemThread>; missing: Record<string, true> }>(() => ({ threads: {}, missing: {} }));

/** How many items a thread's first window has, and each earlier page. */
export const WINDOW_ITEMS = 300;
export const PAGE_ITEMS = 200;
/** How long a thread nobody shows keeps its items, so going back to it soon shows it straight away. */
const KEEP_MS = 10_000;

/** What follows a thread that isn't for drawing. */
interface Live {
  host: string;
  views: number;
  /** Saved events that came while its window or a catch-up loads, applied once it has. */
  held: ThreadEvent[] | null;
  /** Counts its loads: one that a newer one started after leaves the thread to it. */
  gen: number;
  /** The item streaming now, and how much of its text has come. */
  preview: { id: string; length: number } | null;
}
const live = new Map<string, Live>();

const NONE: ItemThread = { snap: null, loading: false, failed: false };
const stateOf = (taskId: string): ItemThread | undefined => useItemThreads.getState().threads[taskId];

function put(taskId: string, patch: Partial<ItemThread>) {
  useItemThreads.setState((s) => ({ threads: { ...s.threads, [taskId]: { ...(s.threads[taskId] ?? NONE), ...patch } } }));
}

/**
 * Keeps task `taskId`'s thread (on host `hostId`) loaded from its items, and follows it, until the returned function is
 * called. Then, once nothing else shows it, it's dropped (showing it again loads it again).
 */
export function retainItemThread(hostId: string, taskId: string): () => void {
  let l = live.get(taskId);
  if (!l || l.host !== hostId) {
    l = { host: hostId, views: 0, held: null, gen: 0, preview: null };
    live.set(taskId, l);
    useItemThreads.setState((s) => {
      const threads = { ...s.threads };
      delete threads[taskId];
      return { threads };
    });
  }
  const mine = l;
  mine.views++;
  if (!stateOf(taskId)?.snap && mine.held === null) void loadWindow(taskId);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    if (--mine.views > 0) return;
    setTimeout(() => {
      if (live.get(taskId) !== mine || mine.views > 0) return;
      live.delete(taskId);
      useItemThreads.setState((s) => {
        const threads = { ...s.threads };
        delete threads[taskId];
        return { threads };
      });
      forgetItemModels((id) => live.has(id));
    }, KEEP_MS);
  };
}

function setMissing(taskId: string, missing: boolean) {
  if (!!useItemThreads.getState().missing[taskId] === missing) return;
  useItemThreads.setState((s) => {
    const next = { ...s.missing };
    if (missing) next[taskId] = true;
    else delete next[taskId];
    return { missing: next };
  });
}

/** Loads a fresh window of the thread, holding the events that come meanwhile, and applies them after it. */
async function loadWindow(taskId: string): Promise<void> {
  const l = live.get(taskId);
  if (!l) return;
  const gen = ++l.gen;
  l.held ??= [];
  const current = () => live.get(taskId) === l && l.gen === gen;
  try {
    const snap = await api.thread<Snapshot>(l.host, taskId, WINDOW_ITEMS);
    if (!current()) return;
    const held = l.held ?? [];
    l.held = null;
    put(taskId, { snap, failed: false });
    setMissing(taskId, false);
    drain(taskId, l, held);
  } catch (e) {
    if (!current()) return;
    l.held = null;
    if (e instanceof ApiError && e.status === 404) setMissing(taskId, true);
    else put(taskId, { failed: true });
  }
}

/** Fetches the saved events after the thread's seq, applies them, then those `held` and any that came meanwhile. */
async function catchUp(taskId: string, held: ThreadEvent[]): Promise<void> {
  const l = live.get(taskId);
  if (!l || !stateOf(taskId)?.snap) return;
  const gen = ++l.gen;
  l.held = [...(l.held ?? []), ...held];
  const current = () => live.get(taskId) === l && l.gen === gen;
  try {
    for (;;) {
      const after = stateOf(taskId)!.snap!.seq;
      const page = await api.threadEvents<SavedEvent>(l.host, taskId, after);
      if (!current()) return;
      // The log doesn't go back that far (or the thread was rebuilt): a fresh window, keeping what's held.
      if (page.resync) return void loadWindow(taskId);
      let snap = stateOf(taskId)!.snap!;
      for (const e of page.events) snap = apply_event(snap, e);
      // Events of types this build doesn't know are counted in the page's seq.
      if (page.seq > snap.seq) snap = { ...snap, seq: page.seq };
      put(taskId, { snap });
      if (!page.more) break;
    }
    const rest = l.held ?? [];
    l.held = null;
    drain(taskId, l, rest);
  } catch {
    if (current()) void loadWindow(taskId);
  }
}

/** Events held during a load, in order: applied, or held again once one of them starts a catch-up. */
function drain(taskId: string, l: Live, events: ThreadEvent[]) {
  for (const ev of events) {
    if (l.held) l.held.push(ev);
    else receive(taskId, l, ev);
  }
}

/** A saved event for a thread whose window is loaded: applied, or (after a gap) caught up to. */
function receive(taskId: string, l: Live, ev: ThreadEvent) {
  const snap = stateOf(taskId)?.snap;
  if (!snap) return;
  if (is_gap(snap, ev)) return void catchUp(taskId, [ev]);
  const next = apply_event(snap, ev);
  if (next === snap) return;
  put(taskId, { snap: next });
  // The streamed message was saved (or the main conversation moved on): its preview is done.
  if (ev.type === "item.added" && !ev.item.parent_id) endPreview(taskId, l);
}

function endPreview(taskId: string, l: Live) {
  if (!l.preview) return;
  l.preview = null;
  clearDelta(taskId);
}

/** Streamed text for the item streaming now, which the thread doesn't have yet: the preview after its items. */
function preview(taskId: string, l: Live, ev: DeltaEvent) {
  if (ev.kind !== "text" || !ev.text) return;
  let p = l.preview;
  if (!p || p.id !== ev.item_id) {
    clearDelta(taskId);
    p = l.preview = { id: ev.item_id, length: 0 };
  }
  // What it has from `offset` on already is skipped; a thread opened mid-message shows the rest as it comes.
  const have = p.length - ev.offset;
  if (have >= ev.text.length) return;
  addDelta(taskId, have > 0 ? ev.text.slice(have) : ev.text);
  p.length = Math.max(p.length, ev.offset + ev.text.length);
}

/** A `thread_event` from host `hostId`. */
export function onThreadEvent(hostId: string, taskId: string, ev: ThreadEvent) {
  const l = live.get(taskId);
  if (!l || l.host !== hostId || !ev || typeof ev !== "object") return;
  if (ev.type === "delta") return preview(taskId, l, ev);
  if (l.held) return void l.held.push(ev);
  receive(taskId, l, ev);
}

/** A `thread_resync`: the thread changed in a way its events don't say (it was rebuilt). */
export function onThreadResync(hostId: string, taskId: string) {
  const l = live.get(taskId);
  if (l && l.host === hostId) void loadWindow(taskId);
  // One that had no items may have them now.
  else setMissing(taskId, false);
}

/** After a reconnect (or the host's events lagged): the shown threads catch up from their seqs. */
export function catchUpItemThreads(hostId?: string) {
  for (const [taskId, l] of live) {
    if (hostId !== undefined && l.host !== hostId) continue;
    if (stateOf(taskId)?.snap) void catchUp(taskId, []);
    else if (l.held === null) void loadWindow(taskId);
  }
}

/** Loads the page of the thread's items before its window's start, and puts it in. */
export async function loadOlderItems(taskId: string): Promise<void> {
  const l = live.get(taskId);
  const t = stateOf(taskId);
  if (!l || !t?.snap?.start || t.loading) return;
  put(taskId, { loading: true });
  try {
    const page = await api.threadItems<ItemPage>(l.host, taskId, t.snap.start, PAGE_ITEMS);
    const cur = stateOf(taskId)?.snap;
    if (!cur || live.get(taskId) !== l) return;
    // What the window has already (its context items, its requests) stays as events have left it.
    const items = new Map(cur.items.map((i) => [i.id, i]));
    const requests = new Map(cur.requests.map((r) => [r.id, r]));
    const merged = with_page(cur, { ...page, items: page.items.map((i) => items.get(i.id) ?? i), requests: page.requests.map((r) => requests.get(r.id) ?? r) });
    if (merged !== cur) put(taskId, { snap: merged });
  } finally {
    if (live.get(taskId) === l) put(taskId, { loading: false });
  }
}

/** Makes `retry` load the window again, for a thread whose window failed to load. */
export function reloadItemThread(taskId: string) {
  if (live.has(taskId)) {
    put(taskId, { failed: false });
    void loadWindow(taskId);
  }
}

/** For tests: forgets every thread. */
export function resetItemThreads() {
  live.clear();
  useItemThreads.setState({ threads: {}, missing: {} });
}
