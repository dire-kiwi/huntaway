import clsx from "clsx";
import { Check, Map as MapIcon, Maximize2, MessageCircleQuestion, Send, ShieldQuestion, X } from "lucide-react";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, ownWorkDir, type Message, type Project, type Task } from "../api";
import { openTask, usePanelOpen } from "../router";
import { keyPrefix, useStore, useThreadMessages } from "../store";
import { useDelta } from "../deltas";
import { threadModel, type Item } from "../threadModel";
import { QUESTION_TOOLS, questionsOf } from "../questions";
import { toolMeta } from "./Thread";
import { AskCard, BoardQuestionCard, PlanCard } from "./Questions";
import { CardState, StatusIcon } from "./ui";
import type { OnMenu } from "./TaskCard";

/**
 * Every agent that's working, or was a moment ago, side by side: a tile for each, with the tail of
 * its thread (what it said, the tools it ran) and the text it's streaming now, like a wall of
 * terminals. A message typed in a tile goes to its agent as the thread's composer would send it.
 */

// How recently a task that isn't running had activity to keep its tile.
const RECENT_MS = 30 * 60_000;
const MAX_TILES = 12;
// How much of each thread's tail a tile shows.
const TAIL = 14;
const NO_MESSAGES: Message[] = [];

/** One line for each of the last things in a thread: the user's messages, the agent's text and its tool calls. */
function tail(items: Item[], cwd: string | null): { key: string; kind: "user" | "text" | "tool" | "event"; icon?: React.ReactNode; text: string }[] {
  const lines: ReturnType<typeof tail> = [];
  for (const it of items.slice(-TAIL)) {
    if (it.type === "user" && !it.auto) lines.push({ key: it.key, kind: "user", text: it.text });
    else if (it.type === "text") lines.push({ key: it.key, kind: "text", text: it.text });
    else if (it.type === "event" && it.level !== "info") lines.push({ key: it.key, kind: "event", text: it.text });
    else if (it.type === "tools")
      for (const c of it.calls) {
        const m = toolMeta(c.name, c.input, cwd);
        lines.push({ key: `${it.key}:${c.id}`, kind: "tool", icon: m.icon, text: `${m.label} ${m.summary}`.trim() });
      }
  }
  return lines.slice(-TAIL);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

/** A question or a plan, which gets its own card (see Questions.tsx), not Allow and Deny. */
const asks = (data: Any) => (QUESTION_TOOLS.includes(data.tool_name) && questionsOf(data).length > 0) || data.tool_name === "ExitPlanMode";

/** A permission prompt still waiting in a thread, on one line, with Allow and Deny; a question or a plan opens the thread to answer it. */
function PromptLine({ data, task }: { data: Any; task: Task }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const m = toolMeta(data.tool_name, data.input, task.worktree_path ?? ownWorkDir(task));
  if (asks(data)) {
    const plan = data.tool_name === "ExitPlanMode";
    const text = plan ? "A plan to review" : questionsOf(data)[0].question;
    return (
      <div className="flex items-center gap-2 rounded-md border border-st-attention/40 bg-st-attention/[0.07] px-2 py-1.5 font-sans text-[12px]">
        {plan ? <MapIcon size={13} className="shrink-0 text-st-attention" /> : <MessageCircleQuestion size={13} className="shrink-0 text-st-attention" />}
        <span className="min-w-0 flex-1 truncate text-fg" title={text}>
          {text}
        </span>
        <button onClick={() => openTask(task.id)} className="shrink-0 rounded bg-accent-strong px-1.5 py-0.5 text-white hover:bg-accent">
          {plan ? "Review" : "Answer"}
        </button>
      </div>
    );
  }
  const decide = async (d: "allow" | "deny") => {
    setBusy(true);
    setErr(null);
    try {
      await api.resolvePermission(task.host_id, data.request_id, d);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <div className="flex items-center gap-2 rounded-md border border-st-attention/40 bg-st-attention/[0.07] px-2 py-1.5 font-sans text-[12px]">
      <ShieldQuestion size={13} className="shrink-0 text-st-attention" />
      <span className="min-w-0 flex-1 truncate" title={`${data.tool_name}: ${m.summary}`}>
        <span className="text-fg">{data.tool_name}</span> <span className="font-mono text-[11.5px] text-muted">{m.summary}</span>
      </span>
      {err && (
        <span className="max-w-[30%] truncate text-red-400" title={err}>
          {err}
        </span>
      )}
      <button disabled={busy} onClick={() => decide("allow")} className="flex shrink-0 items-center gap-1 rounded bg-accent-strong px-1.5 py-0.5 text-white hover:bg-accent disabled:opacity-50">
        <Check size={11} /> Allow
      </button>
      <button disabled={busy} onClick={() => decide("deny")} className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-red-300 hover:bg-red-500/15 disabled:opacity-50">
        <X size={11} /> Deny
      </button>
    </div>
  );
}

const pendingPrompts = (items: Item[]) => items.filter((it): it is Extract<Item, { type: "permission" }> => it.type === "permission" && it.data?.status === "pending");

/** The permission prompts, questions and plans a task's agent is waiting on, to answer without opening its thread. */
export function PendingPrompts({ task }: { task: Task }) {
  const messages = useThreadMessages(task.id);
  const earlier = useStore((s) => s.threads[task.id]?.subagents);
  const model = threadModel(task.id, messages ?? NO_MESSAGES, task.running, earlier);
  const prompts = pendingPrompts(model.items);
  // The question it asked with request_user_input, while nothing's been sent to it since.
  const question = model.items.findLast((it) => it.type === "question");
  const asked = question?.type === "question" && question.data?.status === "pending" && model.lastSent < question.id ? question : undefined;
  if (!prompts.length && !asked) return null;
  return (
    <div className="space-y-1.5">
      {prompts.map((p) => {
        const id = Number(p.key);
        const movedOn = model.lastSent > id;
        if (p.data.tool_name === "ExitPlanMode") return <PlanCard key={p.key} data={p.data} hostId={task.host_id} taskId={task.id} movedOn={movedOn} />;
        if (asks(p.data)) return <AskCard key={p.key} id={id} data={p.data} hostId={task.host_id} movedOn={movedOn} />;
        return <PromptLine key={p.key} data={p.data} task={task} />;
      })}
      {asked && <BoardQuestionCard id={asked.id} data={asked.data} hostId={task.host_id} taskId={task.id} movedOn={false} />}
    </div>
  );
}

function Tile({ task, project, onMenu }: { task: Task; project?: Project; onMenu?: OnMenu }) {
  const messages = useThreadMessages(task.id);
  const earlier = useStore((s) => s.threads[task.id]?.subagents);
  const delta = useDelta(task.id);
  const model = threadModel(task.id, messages ?? NO_MESSAGES, task.running, earlier);
  const cwd = task.worktree_path ?? ownWorkDir(task);
  const lines = useMemo(() => tail(model.items, cwd), [model.items, cwd]);
  const prompts = pendingPrompts(model.items);
  const open = usePanelOpen(task.id);
  const [text, setText] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  // Kept at the newest line, as a terminal is.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines, delta, prompts.length]);

  const send = async () => {
    const body = text.trim();
    if (!body) return;
    setErr(null);
    setText("");
    try {
      await api.send(task.host_id, task.id, body);
    } catch (e) {
      setText(body);
      setErr((e as Error).message);
    }
  };

  return (
    <div
      onContextMenu={onMenu && ((e) => onMenu(e, task))}
      className={clsx(
        "flex h-[340px] min-w-0 flex-col overflow-hidden rounded-lg border bg-[#0c0c10]",
        task.status === "needs_attention" ? "border-st-attention/45" : task.running ? "border-st-progress/30" : "border-line",
        open && "ring-1 ring-accent/60",
      )}
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-line bg-panel-2 px-3 py-2 text-[11.5px]">
        <StatusIcon status={task.status} size={13} />
        <span className="shrink-0 font-mono text-faint">
          {keyPrefix(task, project)}-{task.number}
        </span>
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-fg" title={task.title}>
          {task.title}
        </span>
        <span className="text-faint">
          <CardState task={task} />
        </span>
        <button className="shrink-0 rounded p-0.5 text-faint hover:bg-raised hover:text-fg" title="Open the thread" onClick={() => openTask(task.id)}>
          <Maximize2 size={12} />
        </button>
      </div>
      <div ref={scroller} className="min-h-0 flex-1 space-y-1 overflow-y-auto px-3 py-2 font-mono text-[11.5px] leading-[1.5]">
        {messages === undefined && <div className="text-faint">Loading…</div>}
        {lines.map((l) =>
          l.kind === "tool" ? (
            <div key={l.key} className="flex items-start gap-1.5 text-faint">
              <span className="mt-[3px] shrink-0 [&>svg]:h-3 [&>svg]:w-3">{l.icon}</span>
              <span className="truncate" title={l.text}>
                {l.text}
              </span>
            </div>
          ) : l.kind === "user" ? (
            <div key={l.key} className="line-clamp-3 border-l-2 border-accent/60 pl-2 whitespace-pre-wrap text-accent">
              {l.text}
            </div>
          ) : l.kind === "event" ? (
            <div key={l.key} className="line-clamp-2 text-amber-300/80">
              {l.text}
            </div>
          ) : (
            <div key={l.key} className="line-clamp-4 font-sans text-[12.5px] whitespace-pre-wrap text-fg/90">
              {l.text}
            </div>
          ),
        )}
        {delta && (
          <div className="font-sans text-[12.5px] whitespace-pre-wrap text-fg">
            {delta.slice(-600)}
            <span className="ml-0.5 inline-block h-3 w-1.5 translate-y-0.5 animate-pulse bg-st-progress" />
          </div>
        )}
        {prompts.map((p) => (
          <PromptLine key={p.key} data={p.data} task={task} />
        ))}
        {task.status === "needs_attention" && !prompts.length && task.attention_reason && (
          <div className="line-clamp-3 rounded bg-st-attention/[0.1] px-2 py-1 font-sans text-[12px] text-amber-200/90" title={task.attention_reason}>
            {task.attention_reason}
          </div>
        )}
      </div>
      {/* No reply box on a task in Backlog or Done with no agent running: a message there would start one. */}
      {(task.running || (task.status !== "backlog" && task.status !== "done")) && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
          className="flex shrink-0 items-center gap-1 border-t border-line bg-panel-2 px-2 py-1.5"
        >
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={task.running ? "Message the agent while it works…" : "Reply to the agent…"}
            className="min-w-0 flex-1 bg-transparent px-1 text-[12px] text-fg outline-none placeholder:text-faint"
          />
          {err && (
            <span className="max-w-[40%] truncate text-[11px] text-red-400" title={err}>
              {err}
            </span>
          )}
          <button type="submit" disabled={!text.trim()} className="rounded p-1 text-faint hover:bg-raised hover:text-fg disabled:opacity-30" title="Send (Enter)">
            <Send size={12} />
          </button>
        </form>
      )}
    </div>
  );
}

export function LiveView({ tasks, projectOf, onMenu }: { tasks: Task[]; projectOf: (t: Task) => Project | undefined; onMenu?: OnMenu }) {
  const now = Date.now();
  // Running first (longest running first, so tiles don't jump about), then those that need the user, then the most recent.
  const { live, more } = useMemo(() => {
    const rank = (t: Task) => (t.running ? 0 : t.status === "needs_attention" ? 1 : 2);
    const shown = tasks
      .filter((t) => t.running || t.status === "needs_attention" || now - Date.parse(t.last_activity_at) < RECENT_MS)
      .sort((a, b) => rank(a) - rank(b) || (a.running ? (a.run_started_at ?? "").localeCompare(b.run_started_at ?? "") : b.last_activity_at.localeCompare(a.last_activity_at)));
    return { live: shown.slice(0, MAX_TILES), more: shown.length - MAX_TILES };
    // Which tasks have tiles only changes as they start, stop and move; not every tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks]);

  if (!live.length)
    return (
      <div className="flex flex-1 items-center justify-center text-[12.5px] text-faint">
        No agent is working, needs you or was active in the last 30 minutes.
      </div>
    );
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="grid gap-3 p-4" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(420px, 1fr))" }}>
        {live.map((t) => (
          <Tile key={t.id} task={t} project={projectOf(t)} onMenu={onMenu} />
        ))}
      </div>
      {more > 0 && (
        <div className="px-5 pb-4 text-[12px] text-faint">
          and {more} more: the board's other views list them.
        </div>
      )}
    </div>
  );
}
