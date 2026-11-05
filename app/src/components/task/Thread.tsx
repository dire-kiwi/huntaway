import clsx from "clsx";
import { Hourglass, Loader2 } from "lucide-react";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Message, Task, Turn } from "../../api";
import { useStore, useThreadMessages } from "../../store";
import { useDelta } from "../../deltas";
import { useSubagentView, type Subagent } from "../../subagents";
import { threadModel, type Item, type ThreadModel } from "../../threadModel";
import { itemModel } from "../../itemModel";
import { loadOlderItems, reloadItemThread } from "../../itemThreads";
import { answersById, respond, useDrawsItems, useItemThread } from "../../threadView";
import type { Snapshot } from "../../threads";
import { PromptAnswers, type PromptAnswerer } from "./thread/promptAnswers";
import { RunningDot, WaitReason, waitTitle } from "../ui";
import { RewindDialog } from "./Rewind";
import { useTurns } from "./turns";
import { InMainThread, ThreadCtx, ThreadSource } from "./thread/context";
import { SubagentBar, SubagentThread } from "./thread/subagents";
import { ItemList, TurnsCtx } from "./thread/ItemList";
import { Composer, rewound } from "./thread/Composer";

type ThreadProps = {
  task: Task;
  cwd?: string | null;
  placeholder?: string;
  empty?: ReactNode;
};

/**
 * Memoized, so the task view redrawing leaves a long thread be: pass an `empty` that stays the same. A thread kept as
 * items is drawn from them (threadView.ts), and every other from its messages, the same way. It's one element tree
 * either way, so a thread that switches (its first message flags it, the setting changes, its host has no items for it)
 * keeps its view, and the composer what's being typed in it and its focus.
 */
export const Thread = memo(function Thread(props: ThreadProps) {
  const { task } = props;
  const items = useDrawsItems(task);
  const fromItems = useItemsView(task, items);
  // Until its window has loaded, a thread that's just switched to its items shows the messages it has.
  const fromMessages = useMessagesView(task, !fromItems, !items);
  const view = fromItems ?? fromMessages!;
  // The prompt cards answer a thread drawn from its items with its commands.
  const host = task.host_id;
  const id = task.id;
  const answerer = useMemo<PromptAnswerer>(
    () => ({
      respond: (request_id, resolution) => respond({ host_id: host, id }, request_id, resolution),
      answers: (request_id, lists) => answersById(id, request_id, lists),
    }),
    [host, id],
  );
  return (
    <PromptAnswers.Provider value={fromItems ? answerer : null}>
      <ThreadView {...props} model={view.model} paging={view.paging} source={fromItems ? "items" : "messages"} />
    </PromptAnswers.Provider>
  );
});

/** How the thread's earlier part loads, either way. */
interface Paging {
  /** What's shown has loaded. */
  loaded: boolean;
  /** There's more before it, and it's loading. */
  more: boolean;
  loading: boolean;
  /** Changes when an earlier page comes in above what's on screen. */
  oldest: number | undefined;
  loadOlder: () => Promise<void>;
  /** Whether a subagent's own thread starts before what's loaded. */
  before: (sub: Subagent) => boolean;
  /** The thread couldn't load, and how to try again. */
  failed?: boolean;
  retry?: () => void;
}

type View = { model: ThreadModel; paging: Paging };

/**
 * The thread from its messages, while `on` (null otherwise): kept while it's on, and loaded if `load` (a thread that's
 * switched to its items keeps the messages it had until its window comes, without loading them).
 */
function useMessagesView(task: Task, on: boolean, load: boolean): View | null {
  const messages = useThreadMessages(on ? task.id : null, load);
  // A long thread loads in pages, older ones as it's scrolled up (API 56).
  const pages = useStore((s) => (on ? s.threads[task.id] : undefined));
  const loadOlderMessages = useStore((s) => s.loadOlderMessages);
  const oldest = messages?.[0]?.id;
  const paging = useMemo<Paging>(
    () => ({
      loaded: !!messages,
      more: !!pages?.more,
      loading: !!pages?.loading,
      oldest,
      loadOlder: () => loadOlderMessages(task.id),
      before: (sub) => sub.messageId != null && oldest != null && sub.messageId < oldest,
    }),
    [messages, pages?.more, pages?.loading, oldest, loadOlderMessages, task.id],
  );
  if (!on) return null;
  return { model: threadModel(task.id, messages ?? NO_MESSAGES, task.running, pages?.subagents), paging };
}

/**
 * A thread kept as items, while `on`: its window, followed live and paged back (itemThreads.ts), drawn as itemModel.ts
 * makes it. Null until its window has loaded.
 */
function useItemsView(task: Task, on: boolean): View | null {
  const thread = useItemThread(task, on);
  const snap = thread?.snap;
  const start = snap?.start ?? 0;
  const context = snap?.context;
  const items = snap?.items;
  const paging = useMemo<Paging>(
    () => ({
      loaded: !!items,
      more: start > 0,
      loading: !!thread?.loading,
      oldest: start,
      loadOlder: () => loadOlderItems(task.id),
      // Its call is one of the window's context items, from before its start: its own items can be too.
      before: (sub) => !!context && (items ?? []).slice(0, context.length).some((i) => i.id === sub.id),
      failed: !!thread?.failed,
      retry: () => reloadItemThread(task.id),
    }),
    [items, start, context, thread?.loading, thread?.failed, task.id],
  );
  // A window that failed to load is shown as such, with its way to try again.
  if (!on || (!snap && !thread?.failed)) return null;
  return { model: itemModel(task.id, snap ?? NO_SNAPSHOT, task.running), paging };
}

const NO_SNAPSHOT: Pick<Snapshot, "items" | "requests"> = { items: [], requests: [] };

/** The thread, drawn from `model` (`source` says which way, in `data-thread`, for tests). */
function ThreadView({ task, cwd, placeholder, empty, model, paging, source }: ThreadProps & { model: ThreadModel; paging: Paging; source: "items" | "messages" }) {
  const [olderFailed, setOlderFailed] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  // Streamed text grows in its own component, so a token doesn't redraw the whole thread.
  const follow = useCallback(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, []);

  // The turns with checkpoints, for rewinding to before one of the user's messages (API 70).
  const turns = useTurns(task);
  const [rewinding, setRewinding] = useState<Turn | null>(null);
  const turnsCtx = useMemo(() => {
    const list = turns.data?.turns;
    if (!list?.length) return null;
    // A message's first turn (the agent can go on by itself after it).
    const byMessage = new Map<number, Turn>();
    for (const t of list) if (t.message_id !== null && !byMessage.has(t.message_id)) byMessage.set(t.message_id, t);
    return { byMessage, rewind: setRewinding };
  }, [turns.data]);
  const items = useStableGroupKeys(model.items, task.id);
  const data = useMemo(
    () => ({ ...model, running: task.running, cwd, hostId: task.host_id, taskId: task.id, follow }),
    [model, task.running, cwd, task.host_id, task.id, follow],
  );
  // Rows that redraw now read the new model as they do; the others are told once it's shown.
  const [threadSource] = useState(() => new ThreadSource(data));
  threadSource.data = data;
  useLayoutEffect(() => threadSource.publish(), [threadSource, data]);
  // A subagent's own thread, shown in place of the main one (kept mounted, so it comes back as it was).
  const viewId = useSubagentView((s) => s.open[task.id]);
  const show = useSubagentView((s) => s.show);
  const viewed = viewId ? model.subagents.get(viewId) : undefined;
  const viewKey = viewed?.id ?? null;
  const mainScroll = useRef<number | null>(null);
  const shownView = useRef(viewKey);
  const oldest = paging.oldest;
  const shownOldest = useRef(oldest);
  // Older messages come in above what's on screen, and the main conversation changes while a
  // subagent's thread is shown: note what's at the top of the screen (before the DOM changes), to
  // put it back where it was.
  const anchor = useRef<{ el: Element; top: number } | null>(null);
  if (!anchor.current && shownView.current === null && (oldest !== shownOldest.current || viewKey !== null)) anchor.current = topItem(scroller.current, list.current);

  useLayoutEffect(() => {
    const el = scroller.current;
    const moved = anchor.current;
    const back = shownView.current !== null && viewKey === null;
    // Kept while a subagent's thread is shown, for coming back.
    if (viewKey === null) anchor.current = null;
    shownOldest.current = oldest;
    if (!el) return;
    const restore = () => {
      if (moved?.el.isConnected) el.scrollTop += moved.el.getBoundingClientRect().top - moved.top;
    };
    if (shownView.current !== viewKey) {
      shownView.current = viewKey;
      // A subagent's thread opens at its latest, like the main one; the main one comes back where it was left.
      if (viewKey || mainScroll.current == null) el.scrollTop = el.scrollHeight;
      else el.scrollTop = mainScroll.current;
      if (back) {
        restore();
        anchor.current = null;
      }
      pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      return;
    }
    if (pinned.current) el.scrollTop = el.scrollHeight;
    else if (viewKey === null) restore();
  }, [items, task.running, viewKey, oldest]);

  // The latest, for what runs from events (scrolling) rather than as it draws.
  const pagingNow = useRef(paging);
  pagingNow.current = paging;
  const loadOlder = useCallback(() => {
    setOlderFailed(false);
    pagingNow.current.loadOlder().catch(() => setOlderFailed(true));
  }, []);
  // Scrolled near the top of what's loaded (or it doesn't fill the screen): the page before it.
  const nearTop = useCallback(() => {
    const el = scroller.current;
    const p = pagingNow.current;
    if (el && shownView.current === null && p.more && !p.loading && !olderFailed && el.scrollTop < 800) loadOlder();
  }, [loadOlder, olderFailed]);
  useEffect(nearTop, [items, nearTop]);
  // A subagent's thread, from the Agents list, that started before the loaded messages: load back to it.
  const viewedBefore = !!viewed && paging.before(viewed);
  useEffect(() => {
    if (viewedBefore && paging.more && !paging.loading && !olderFailed) loadOlder();
  }, [viewedBefore, oldest, paging.more, paging.loading, olderFailed, loadOlder]);
  // Another subagent (or the main conversation) tries a page that failed again.
  useEffect(() => setOlderFailed(false), [viewKey]);

  // Escape goes back from a subagent's thread (before the task panel takes it to close).
  useEffect(() => {
    if (!viewed) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if ((e.target as Element).closest?.("input, textarea, select, [contenteditable]") || document.querySelector("[data-modal]")) return;
      e.preventDefault();
      show(task.id, viewed.parent);
    };
    // On the document, so it comes before the task panel's handler on the window.
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [viewed, show, task.id]);

  return (
    <ThreadCtx.Provider value={threadSource}>
      <div className="flex h-full min-h-0 flex-col" data-thread={paging.loaded ? source : undefined}>
        {viewed && <SubagentBar sub={viewed} />}
        <div
          ref={scroller}
          data-autoscroll=""
          onScroll={(e) => {
            const el = e.currentTarget;
            pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
            if (shownView.current === null) mainScroll.current = el.scrollTop;
            nearTop();
          }}
          className="min-h-0 flex-1 overflow-y-auto"
        >
          {/* The main conversation's; a subagent's thread only loads back to its start. */}
          {paging.failed && (
            <div className="flex justify-center pt-5 text-[12px] text-faint">
              <button onClick={paging.retry} className="hover:text-muted">
                Couldn't load the thread. Try again
              </button>
            </div>
          )}
          {paging.more && (!viewed || paging.loading || viewedBefore) && (
            <div className="flex justify-center pt-5 text-[12px] text-faint">
              {paging.loading ? (
                <span className="flex items-center gap-1.5">
                  <Loader2 size={12} className="animate-spin" /> Loading earlier messages…
                </span>
              ) : (
                <button onClick={loadOlder} className="hover:text-muted">
                  {olderFailed ? "Couldn't load earlier messages. Try again" : "Load earlier messages"}
                </button>
              )}
            </div>
          )}
          {viewed && (
            <div key={viewed.id} className="mx-auto w-full max-w-3xl space-y-4 px-5 py-6 narrow:px-3 narrow:py-4">
              <InMainThread.Provider value={false}>
                <SubagentThread sub={viewed} />
              </InMainThread.Provider>
            </div>
          )}
          <div ref={list} className={clsx("mx-auto w-full max-w-3xl space-y-4 px-5 py-6 narrow:px-3 narrow:py-4", viewed && "hidden")}>
            {paging.loaded && items.length === 0 && !task.running && !paging.more && empty}
            <TurnsCtx.Provider value={turnsCtx}>
              <ItemList items={items} running={task.running} hostId={task.host_id} cwd={cwd} />
            </TurnsCtx.Provider>
            <StreamingText taskId={task.id} onGrow={follow} />
            {task.running && (
              <div className="flex items-center gap-2 text-[12.5px] text-muted">
                {task.agent_wait ? (
                  <>
                    <Hourglass size={12} className="shrink-0" />{" "}
                    {task.agent_wait.pull_request ? (
                      <WaitReason wait={{ ...task.agent_wait, reason: `Waiting${task.agent_wait.reason ? `: ${task.agent_wait.reason}` : ""}` }} />
                    ) : (
                      <span title={waitTitle(task.agent_wait)}>Waiting{task.agent_wait.reason ? `: ${task.agent_wait.reason}` : "…"}</span>
                    )}
                  </>
                ) : (
                  <>
                    <RunningDot /> Working…
                  </>
                )}
              </div>
            )}
          </div>
        </div>
        {/* A fresh draft per task: its attachments are on this task's host. */}
        <Composer key={task.id} task={task} placeholder={placeholder} />
        {rewinding && (
          <RewindDialog task={task} turn={rewinding} head={turns.data?.head} onClose={() => setRewinding(null)} onDone={(r, convo) => rewound(task, r, convo)} />
        )}
      </div>
    </ThreadCtx.Provider>
  );
}

const NO_MESSAGES: Message[] = [];

/**
 * The first of the thread's items on screen in `scroller`, and where it is: in a group of tool calls,
 * the call, as older calls can join the group above it.
 */
function topItem(scroller: HTMLElement | null, list: HTMLElement | null): { el: Element; top: number } | null {
  if (!scroller || !list) return null;
  const top = scroller.getBoundingClientRect().top;
  const first = (els: Iterable<Element>) => {
    for (const el of els) {
      const r = el.getBoundingClientRect();
      if (r.bottom > top) return { el, top: r.top };
    }
    return null;
  };
  const item = first(list.children);
  return (item && first(item.el.querySelectorAll("[data-tool-row]"))) ?? item;
}

/**
 * The thread's items, with each group of tool calls keeping the key it was first shown with. A group
 * is keyed by its first call, which changes when an older page adds calls before it: it would be
 * drawn again from scratch, losing what was expanded in it.
 */
function useStableGroupKeys(items: Item[], taskId: string): Item[] {
  const keys = useRef<{ taskId: string; byCall: Map<string, string>; copies: WeakMap<Item, Item> }>({ taskId, byCall: new Map(), copies: new WeakMap() });
  return useMemo(() => {
    if (keys.current.taskId !== taskId) keys.current = { taskId, byCall: new Map(), copies: new WeakMap() };
    const { byCall, copies } = keys.current;
    let changed = false;
    const out = items.map((it) => {
      if (it.type !== "tools") return it;
      const key = it.calls.map((c) => byCall.get(c.id)).find((k) => k != null) ?? it.key;
      for (const c of it.calls) byCall.set(c.id, key);
      if (key === it.key) return it;
      changed = true;
      // The same copy for the same item, so its row doesn't redraw.
      let copy = copies.get(it);
      if (copy?.key !== key) copies.set(it, (copy = { ...it, key }));
      return copy;
    });
    return changed ? out : items;
  }, [items, taskId]);
}

/**
 * The agent's reply as it streams in (not yet saved as a message), as plain text: drawing it as markdown
 * again for each token would take longer the longer it got. The saved message is markdown. A paragraph
 * each, so a token changes (and lays out again) only the last one. `onGrow` keeps the thread scrolled to it.
 */
function StreamingText({ taskId, onGrow }: { taskId: string; onGrow: () => void }) {
  const delta = useDelta(taskId);
  useLayoutEffect(onGrow, [delta, onGrow]);
  if (!delta) return null;
  return (
    <div className="prose-chat break-words whitespace-pre-wrap">
      {delta.split(/\n{2,}/).map((p, i) => (
        <p key={i}>{p}</p>
      ))}
    </div>
  );
}
