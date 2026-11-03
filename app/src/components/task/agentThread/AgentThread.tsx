// An agent-threads task's thread (API 105): its items drawn by agent-threads' React package, with
// Huntaway's own user messages, the board's prompts and events among them, its composer, and a
// subagent's own thread shown full screen in its place. Legacy tasks have Thread.tsx's.
import type { RateLimit, ThreadRequest, UserMessage } from "@dire-kiwi/agent-threads-protocol";
import {
  CodeBlock,
  groupRows,
  isLoaded,
  LoadEarlier,
  lineage,
  MessageRow,
  reportText,
  RequestCard,
  rowKey,
  SubagentStatusBadge,
  subagentKind,
  subagentTitle,
  toolRenderer,
  useHasEarlier,
  useLoadEarlier,
  useReveal,
  useThreadConfig,
  useThreadState,
  type Row,
  type SubagentInfo,
} from "@dire-kiwi/agent-threads-react";
import clsx from "clsx";
import { ArrowLeft, Bot, ChevronRight, CircleAlert, FileText, Hourglass, Loader2, LocateFixed } from "lucide-react";
import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Message, Task, Turn } from "../../../api";
import { useStore, useThreadMessages } from "../../../store";
import { useSubagentView } from "../../../subagents";
import { boardMessages, importedUpTo, lastSentAt, mainUserMessages, mergeRows, movedOn, parseTime, userMessageIds } from "../../../threadRows";
import { Button, RunningDot, WaitReason, waitTitle } from "../../ui";
import { RewindDialog } from "../Rewind";
import { useTurns } from "../turns";
import { Composer, rewound } from "../thread/Composer";
import { Collapsible } from "../thread/items";
import { Markdown } from "../thread/Markdown";
import { useAgentThread } from "./Provider";
import { BoardRow, TaskRowsCtx, type TaskRows } from "./rows";

const NO_MESSAGES: Message[] = [];
const NO_ROWS: readonly Row[] = [];

/** Memoized, as Thread is: the task view redrawing leaves a long thread be. */
export const AgentThread = memo(function AgentThread({ task, placeholder, empty }: { task: Task; placeholder?: string; empty?: ReactNode }) {
  const at = useAgentThread(task)!;
  return (
    <div className="at-root ha-thread flex h-full min-h-0 flex-col">
      {at.status === "ready" ? (
        <ThreadView task={task} empty={empty} />
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center text-[12.5px] text-faint">
          {at.status === "loading" ? (
            <span className="flex items-center gap-1.5">
              <Loader2 size={13} className="animate-spin" /> Loading the thread…
            </span>
          ) : (
            <span className="flex items-center gap-2 text-red-400">
              <CircleAlert size={13} /> Couldn't load the thread: {at.error}
              <Button size="sm" onClick={at.retry}>
                Try again
              </Button>
            </span>
          )}
        </div>
      )}
      {/* A fresh draft per task: its attachments are on this task's host. */}
      <Composer key={task.id} task={task} placeholder={placeholder} />
    </div>
  );
});

/** How near the top (in pixels) it's scrolled before earlier items load. */
const NEAR_TOP = 800;

function ThreadView({ task, empty }: { task: Task; empty?: ReactNode }) {
  const scroller = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  // The board's messages: its prompts, questions and events go among the thread's rows; its user messages say when the agent was last sent one.
  const messages = useThreadMessages(task.id) ?? NO_MESSAGES;
  // Picked as what changes them, not the items themselves: those change with every streamed token.
  const imported = useThreadState((s) => importedUpTo(s.snapshot.items, s.snapshot.requests));
  const requests = useThreadState((s) => s.snapshot.requests);
  const board = useMemo(() => boardMessages(messages, imported, requests), [messages, imported, requests]);
  const users = useMainUsers();
  const lastSent = useMemo(() => messages.reduce((n, m) => (m.kind === "user" && m.id > n ? m.id : n), 0), [messages]);

  // Where the task can be rewound to (API 70), by the user message each turn started with.
  const turns = useTurns(task);
  const [rewinding, setRewinding] = useState<Turn | null>(null);
  const byItem = useMemo(() => {
    const list = turns.data?.turns;
    if (!list?.length) return null;
    const byMessage = new Map<number, Turn>();
    for (const t of list) if (t.message_id !== null && !byMessage.has(t.message_id)) byMessage.set(t.message_id, t);
    const out = new Map<string, Turn>();
    for (const [item, id] of userMessageIds(users, messages)) {
      const t = byMessage.get(id);
      if (t) out.set(item, t);
    }
    return out;
  }, [turns.data, users, messages]);
  const rows = useMemo<TaskRows>(
    () => ({ hostId: task.host_id, taskId: task.id, turns: byItem, rewind: setRewinding, lastSent }),
    [task.host_id, task.id, byItem, lastSent],
  );

  // A subagent's own thread, shown in place of the main one (which stays mounted, to come back to as it was).
  const viewId = useSubagentView((s) => s.open[task.id]) ?? null;
  const show = useSubagentView((s) => s.show);
  const viewed = useThreadState((s) => (viewId ? s.view.subagents.get(viewId) : undefined));
  const viewKey = viewed ? viewed.id : null;

  // Paging: earlier items come in above what's on screen (and the board's earlier messages with them).
  const more = useHasEarlier();
  const loading = useThreadState((s) => s.loadingEarlier);
  const failed = useThreadState((s) => s.earlierError !== null);
  const loadEarlier = useLoadEarlier();
  const start = useThreadState((s) => s.snapshot.start ?? 0);
  const boardFirst = messages[0]?.id;
  const mainScroll = useRef<number | null>(null);
  const shownView = useRef<string | null>(viewKey);
  const shownTop = useRef(`${start}:${boardFirst}`);
  // What's at the top of the screen before the DOM changes, to put it back where it was: when
  // earlier items come in, and while a subagent's thread is shown (the main one may change meanwhile).
  const anchor = useRef<{ el: Element; top: number } | null>(null);
  const top = `${start}:${boardFirst}`;
  if (!anchor.current && shownView.current === null && (top !== shownTop.current || viewKey !== null)) anchor.current = topItem(scroller.current, list.current);

  useLayoutEffect(() => {
    const el = scroller.current;
    const moved = anchor.current;
    const back = shownView.current !== null && viewKey === null;
    if (viewKey === null) anchor.current = null;
    shownTop.current = top;
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
  }, [top, viewKey]);

  // Kept at the end while it's there, as the thread grows (streamed text included).
  useLayoutEffect(() => {
    const el = scroller.current;
    const inner = body.current;
    if (!el || !inner) return;
    el.scrollTop = el.scrollHeight;
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (pinned.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(inner);
    return () => ro.disconnect();
  }, []);

  // Scrolled near the top of what's loaded (or it doesn't fill the screen): the page before it.
  const nearTop = useCallback(() => {
    const el = scroller.current;
    if (el && shownView.current === null && more && !loading && !failed && el.scrollTop < NEAR_TOP) void loadEarlier();
  }, [more, loading, failed, loadEarlier]);
  useEffect(nearTop, [nearTop, start]);

  // The board's messages from before the first one loaded, when the thread's loaded back past it.
  const threadFirst = useThreadState((s) => firstTime(s.snapshot.items));
  const boardMore = useStore((s) => s.threads[task.id]?.more ?? false);
  const boardLoading = useStore((s) => s.threads[task.id]?.loading ?? false);
  const loadOlderMessages = useStore((s) => s.loadOlderMessages);
  const boardOldest = parseTime(messages[0]?.created_at);
  const boardFirstId = messages[0]?.id ?? 0;
  useEffect(() => {
    // Not those an import has in the thread: the board's messages up to its last are all there.
    if (!boardMore || boardLoading || boardOldest === null || (imported > 0 && boardFirstId <= imported)) return;
    // All of the thread is in, or the first of it is from before the board's first.
    if (threadFirst === null ? !more : threadFirst < boardOldest || !more) loadOlderMessages(task.id).catch(() => {});
  }, [boardMore, boardLoading, boardOldest, boardFirstId, imported, threadFirst, more, loadOlderMessages, task.id]);

  // Escape goes back from a subagent's thread (before the task panel takes it to close).
  const parentOfViewed = viewed?.parent ?? null;
  useEffect(() => {
    if (!viewKey) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if ((e.target as Element).closest?.("input, textarea, select, [contenteditable]") || document.querySelector("[data-modal]")) return;
      e.preventDefault();
      show(task.id, parentOfViewed);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [viewKey, parentOfViewed, show, task.id]);

  const none = useThreadState((s) => s.snapshot.items.length === 0 && !s.snapshot.start);
  return (
    <TaskRowsCtx.Provider value={rows}>
      {viewed && <SubagentBar sub={viewed} taskId={task.id} />}
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
        <div ref={body}>
          {viewed && (
            <div key={viewed.id} className="mx-auto w-full max-w-3xl space-y-4 px-5 py-6 narrow:px-3 narrow:py-4">
              <SubagentThread sub={viewed} />
            </div>
          )}
          <div className={clsx("mx-auto w-full max-w-3xl px-5 py-6 narrow:px-3 narrow:py-4", viewed && "hidden")}>
            <LoadEarlier className="mb-4" />
            <div ref={list} className="flex flex-col gap-4">
              {none && !task.running && board.length === 0 && empty}
              <ThreadList parentId="" board={board} />
              <OpenRequests />
              <Limits />
              <Working task={task} />
            </div>
          </div>
        </div>
      </div>
      {rewinding && (
        <RewindDialog task={task} turn={rewinding} head={turns.data?.head} onClose={() => setRewinding(null)} onDone={(r, convo) => rewound(task, r, convo)} />
      )}
    </TaskRowsCtx.Provider>
  );
}

/** The main thread's user messages: the same list while they're the same, so what's worked out from them isn't again for each streamed token. */
function useMainUsers() {
  const prev = useRef<readonly UserMessage[]>(undefined);
  return useThreadState((s) => (prev.current = mainUserMessages(s.snapshot.items, prev.current)));
}

/** When the first item loaded with a time was made. */
function firstTime(items: readonly { created_at?: string }[]): number | null {
  for (const it of items) {
    const t = parseTime(it.created_at);
    if (t !== null) return t;
  }
  return null;
}

/**
 * The first of the thread's rows on screen in `scroller`, and where it is: in a group of tool calls,
 * the call, as earlier calls can join the group above it.
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
  const rows = list.querySelector(".ha-rows");
  const item = first(rows?.children ?? list.children);
  return (item && first(item.el.querySelectorAll("[data-tool-row]"))) ?? item;
}

/**
 * A list of the thread's rows: the main thread's, or (given `parentId`) a subagent's, as the
 * package's MessageList draws them, with the board's messages (`board`) among them by time.
 */
const ThreadList = memo(function ThreadList({ parentId, board }: { parentId: string; board?: readonly Message[] }) {
  const items = useThreadState((s) => s.view.children.get(parentId));
  const answered = useThreadState((s) => s.view.answered.get(parentId));
  const hasEarlier = useHasEarlier();
  const config = useThreadConfig();
  const alone = useMemo(() => {
    if (!config.tools && !config.toolKinds) return undefined;
    return (call: Parameters<typeof toolRenderer>[1]) => !!toolRenderer(config, call).alone;
  }, [config]);
  const prev = useRef<readonly Row[]>(undefined);
  const rows = useMemo(() => (items ? (prev.current = groupRows(items, prev.current, alone, answered)) : NO_ROWS), [items, alone, answered]);
  const merged = useMemo(() => mergeRows(rows, board ?? NO_MESSAGES, hasEarlier), [rows, board, hasEarlier]);
  return (
    <div className="ha-rows at-message-list">
      {merged.map((r) => (r.kind === "row" ? <MessageRow key={rowKey(r.row)} row={r.row} /> : <BoardRow key={`b:${r.message.id}`} message={r.message} />))}
    </div>
  );
});

/**
 * The thread's open requests, oldest first, as cards to answer: all of them (each says which
 * subagent it's from), or one subagent's own. One the conversation has moved on from (the user's
 * sent a message since it was asked) is greyed out, and can still be answered.
 */
const OpenRequests = memo(function OpenRequests({ parentId }: { parentId?: string }) {
  const requests = useThreadState((s) => s.snapshot.requests);
  const sentAt = useThreadState((s) => lastSentAt(s.snapshot.items));
  const shown = requests.filter((r) => !r.resolution && (parentId === undefined || (r.parent_id ?? "") === parentId));
  if (!shown.length) return null;
  return (
    <div className="at-requests">
      {shown.map((r) => (
        <OpenRequest key={r.id} request={r} movedOn={movedOn(r, sentAt)} />
      ))}
    </div>
  );
});

function OpenRequest({ request, movedOn }: { request: ThreadRequest; movedOn: boolean }) {
  if (!movedOn) return <RequestCard request={request} />;
  return (
    <div className="ha-moved-on" title="The conversation has moved on since this was asked">
      <div className="mb-1 text-[11.5px] text-faint">Asked before your last message: an answer still goes to the agent.</div>
      <RequestCard request={request} />
    </div>
  );
}

/** The account's usage limits, as the harness last reported them: a line when one's used up (or nearly). */
function Limits() {
  const limits = useThreadState((s) => s.snapshot.thread.rate_limits);
  const shown = (limits ?? []).filter((l) => l.status !== "allowed");
  if (!shown.length) return null;
  return (
    <>
      {shown.map((l) => (
        <div key={l.id} className={clsx("flex items-center gap-1.5 text-[12px]", l.status === "rejected" ? "text-st-attention" : "text-faint")}>
          <Hourglass size={12} className="shrink-0" /> {limitText(l)}
        </div>
      ))}
    </>
  );
}

/** What a usage limit's line says, e.g. "Usage limit reached (5-hour): resets at 3:40 pm". */
export function limitText(l: RateLimit): string {
  const name = LIMIT_NAMES[l.id] ?? l.id.replace(/_/g, " ");
  const resets = l.resets_at ? ` resets ${resetText(l.resets_at)}` : "";
  if (l.status === "rejected") return `Usage limit reached (${name}):${resets || " waiting for it to reset"}`;
  const used = l.used_percent != null ? `${Math.round(l.used_percent)}% used` : "nearly used up";
  return `Usage limit (${name}): ${used}${resets ? `,${resets}` : ""}`;
}

const LIMIT_NAMES: Record<string, string> = { five_hour: "5-hour", seven_day: "weekly", seven_day_opus: "weekly Opus", seven_day_sonnet: "weekly Sonnet" };

function resetText(at: string): string {
  const t = parseTime(at);
  if (t === null) return `at ${at}`;
  const d = new Date(t);
  const today = new Date().toDateString() === d.toDateString();
  return today ? `at ${d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : `on ${d.toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}`;
}

/** Whether the agent's working (or waiting on something), from the board's task; or, once it's stopped, what went wrong with the thread, if something did. */
function Working({ task }: { task: Task }) {
  const error = useThreadState((s) => (s.snapshot.thread.status === "error" ? (s.snapshot.thread.error ?? null) : null));
  if (!task.running)
    return error ? (
      <div className="flex items-center gap-1.5 text-[12.5px] text-red-400">
        <CircleAlert size={12} className="shrink-0" /> {error}
      </div>
    ) : null;
  const wait = task.agent_wait;
  return (
    <div className="flex items-center gap-2 text-[12.5px] text-muted">
      {wait ? (
        <>
          <Hourglass size={12} className="shrink-0" />{" "}
          {wait.pull_request ? (
            <WaitReason wait={{ ...wait, reason: `Waiting${wait.reason ? `: ${wait.reason}` : ""}` }} />
          ) : (
            <span title={waitTitle(wait)}>Waiting{wait.reason ? `: ${wait.reason}` : "…"}</span>
          )}
        </>
      ) : (
        <>
          <RunningDot /> Working…
        </>
      )}
    </div>
  );
}

// ---------- a subagent's own thread ----------

type Input = Record<string, unknown>;
const inputOf = (sub: SubagentInfo): Input => (sub.call.input && typeof sub.call.input === "object" ? (sub.call.input as Input) : {});
const str = (x: unknown): string => (typeof x === "string" ? x : "");
const plural = (n: number, s: string) => `${n} ${s}${n === 1 ? "" : "s"}`;

/** A subagent's own thread, shown in place of the main conversation: its prompt, what it did, its open requests and its report. */
function SubagentThread({ sub }: { sub: SubagentInfo }) {
  const loaded = useThreadState((s) => isLoaded(s.snapshot, sub.id));
  const input = inputOf(sub);
  const prompt = str(input.prompt);
  const meta = [subagentKind(sub.call), sub.call.subagent?.model || str(input.model), sub.background && "in the background", sub.toolUses > 0 && plural(sub.toolUses, "tool use")].filter(Boolean);
  const call = sub.call;
  const hasText = sub.items.some((i) => i.type === "assistant_message" && i.text.trim());
  const report = sub.background ? (call.subagent?.summary ?? "") : call.result && call.status === "completed" ? reportText(call.result.content) : "";
  const error = sub.background ? report : (call.result?.content ?? "");
  return (
    <>
      <div className="text-[11.5px] text-faint">{meta.join(" · ")}</div>
      {prompt && (
        <div className="flex justify-end">
          <div className="max-w-[85%] rounded-2xl rounded-br-md border border-line-strong bg-raised px-3.5 py-2 text-[13.5px] whitespace-pre-wrap">{prompt}</div>
        </div>
      )}
      {!prompt && str(input.description) && <Collapsible label="Prompt" icon={<FileText size={13} />} text={str(input.description)} />}
      {!loaded && <LoadEarlier to={sub.id} />}
      <ThreadList parentId={sub.id} />
      <OpenRequests parentId={sub.id} />
      {sub.status === "running" && (
        <div className="flex items-center gap-2 text-[12px] text-muted">
          <RunningDot /> {sub.background ? "Working in the background…" : "Working…"}
        </div>
      )}
      {sub.status === "failed" && error ? <CodeBlock text={error} tone="error" /> : !hasText && report && <Markdown text={report} />}
      {sub.status === "stopped" && !report && <div className="text-[12px] text-faint">Stopped before it finished.</div>}
    </>
  );
}

/** Above a subagent's own thread: the way back to the threads that started it, and to its row in the main one. */
function SubagentBar({ sub, taskId }: { sub: SubagentInfo; taskId: string }) {
  const subagents = useThreadState((s) => s.view.subagents);
  const show = useSubagentView((s) => s.show);
  const reveal = useReveal();
  // Outermost first, without this one.
  const outer = lineage(subagents, sub.id)
    .slice(1)
    .reverse()
    .map((id) => subagents.get(id))
    .filter((s): s is SubagentInfo => !!s);
  const crumb = "min-w-0 shrink truncate text-muted hover:text-fg";
  return (
    <div className="flex h-10 shrink-0 items-center gap-1.5 border-b border-line px-3 text-[12.5px]" aria-label="Subagent thread">
      <button
        onClick={() => show(taskId, sub.parent ?? null)}
        title={sub.parent ? "Back to the subagent that started it" : "Back to the main thread (Esc)"}
        className="shrink-0 rounded p-1 text-muted hover:bg-white/5 hover:text-fg"
      >
        <ArrowLeft size={14} />
      </button>
      <button onClick={() => show(taskId, null)} className="shrink-0 text-muted hover:text-fg">
        Main thread
      </button>
      {outer.map((o) => (
        <Fragment key={o.id}>
          <ChevronRight size={12} className="shrink-0 text-faint" />
          <button onClick={() => show(taskId, o.id)} className={crumb}>
            {subagentTitle(o.call)}
          </button>
        </Fragment>
      ))}
      <ChevronRight size={12} className="shrink-0 text-faint" />
      <Bot size={13} className="shrink-0 text-muted" />
      <span className="min-w-0 truncate text-fg">{subagentTitle(sub.call)}</span>
      <span className="ml-auto flex shrink-0 items-center gap-2 pl-2">
        <SubagentStatusBadge status={sub.status} waiting={sub.waiting} />
        <button
          onClick={() => {
            show(taskId, null);
            reveal(sub.id);
          }}
          title="Show where it is in the main thread"
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[12px] text-muted hover:bg-white/5 hover:text-fg narrow:hidden"
        >
          <LocateFixed size={12} /> Show in thread
        </button>
      </span>
    </div>
  );
}
