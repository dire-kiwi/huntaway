import clsx from "clsx";
import { BellRing, ChevronRight, CircleAlert, Eye, GitMerge, MessagesSquare, Play, PlayCircle, Square } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { api, canRunAgents, dependencyQueued, type Project, type Task } from "../api";
import { openTask, usePanelOpen } from "../router";
import { keyPrefix, useHost, useStore } from "../store";
import { isDue } from "../reminders";
import { Composer, Markdown } from "./Thread";
import { PendingPrompts } from "./LiveView";
import { ReviewBadge } from "./Review";
import { Button, Kbd, PrIcon, RunState, StatusIcon, timeAgo, useClock } from "./ui";
import type { OnMenu } from "./Board";

/**
 * The board as a queue of what each task needs from the user, most pressing first: an answer, a
 * review, a reminder that's come round, an agent that stopped before it finished, a start. Each
 * shows the agent's last words, and the one picked can be answered, merged or started from the
 * list, without opening its thread. j and k move through it.
 */

type BucketId = "answer" | "review" | "due" | "stalled" | "start" | "working";
const BUCKETS: { id: BucketId; title: string; icon: ReactNode; hint: string }[] = [
  { id: "answer", title: "Waiting for your answer", icon: <CircleAlert size={14} className="text-st-attention" />, hint: "The agent asked something or hit a prompt" },
  { id: "review", title: "Ready for your review", icon: <Eye size={14} className="text-st-review" />, hint: "The agent finished; look over its work and merge it, or send it back" },
  { id: "due", title: "Reminders", icon: <BellRing size={14} className="text-amber-300" />, hint: "Reminders that have come round" },
  { id: "stalled", title: "Stopped before finishing", icon: <Square size={13} className="text-faint" />, hint: "In progress, but its agent isn't running" },
  { id: "start", title: "Not started", icon: <PlayCircle size={14} className="text-st-todo" />, hint: "In To do" },
  { id: "working", title: "Agents at work", icon: <StatusIcon status="in_progress" size={14} />, hint: "Nothing to do until they finish" },
];
// Those listed with their agent's last words; the rest are one line each.
const DETAILED: ReadonlySet<BucketId> = new Set(["answer", "review", "due", "stalled"]);
// Collapsed until opened, on this client.
const CLOSED_KEY = "ia.triage.closed";

function bucketOf(t: Task, now: number): BucketId | null {
  if (t.status === "needs_attention") return "answer";
  if (t.status === "in_review" && !t.running) return "review";
  if (isDue(t, now) && t.status !== "done") return "due";
  if (t.running || t.status === "ready_for_merge" || dependencyQueued(t)) return t.status === "done" || t.status === "backlog" ? null : "working";
  if (t.status === "in_progress") return t.session_id ? "stalled" : "start";
  if (t.status === "todo") return "start";
  return null;
}

/** The agent's last words in a task's thread, asked for again as the task moves on. */
const lastWords = new Map<string, string | null>();
function useLastMessage(task: Task, enabled: boolean) {
  const key = `${task.id}@${task.last_activity_at}`;
  const [text, setText] = useState(() => lastWords.get(key));
  useEffect(() => {
    if (!enabled) return;
    if (lastWords.has(key)) return setText(lastWords.get(key));
    let cancelled = false;
    api
      .task(task.host_id, task.id)
      .then((d) => {
        lastWords.set(key, d.last_message);
        if (!cancelled) setText(d.last_message);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [key, enabled, task.host_id, task.id]);
  return text;
}

function TriageItem({ task, project, bucket, picked, onPick, onMenu }: { task: Task; project?: Project; bucket: BucketId; picked: boolean; onPick: () => void; onMenu?: OnMenu }) {
  const detailed = DETAILED.has(bucket);
  const last = useLastMessage(task, detailed);
  const host = useHost(task.host_id);
  const upsertTask = useStore((s) => s.upsertTask);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const open = usePanelOpen(task.id);
  const key = `${keyPrefix(task, project)}-${task.number}`;

  const act = async (f: () => Promise<unknown>) => {
    setBusy(true);
    setErr(null);
    try {
      await f();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const merge = () =>
    act(async () => {
      upsertTask({ ...task, status: "ready_for_merge" });
      try {
        await api.updateTask(task.host_id, task.id, { status: "ready_for_merge" });
      } catch (e) {
        upsertTask(task);
        throw e;
      }
    });
  // As dragging it to In progress does.
  const start = () =>
    act(async () => {
      if (task.status !== "in_progress") await api.updateTask(task.host_id, task.id, { status: "in_progress" });
      await api.send(task.host_id, task.id, "");
    });

  if (!detailed)
    return (
      <div
        data-triage={task.id}
        onClick={() => openTask(task.id)}
        onContextMenu={onMenu && ((e) => onMenu(e, task))}
        className={clsx("flex cursor-pointer items-center gap-2.5 px-3 py-1.5 text-[12.5px] hover:bg-white/[0.03]", (picked || open) && "bg-accent/[0.07]")}
      >
        <StatusIcon status={task.status} size={13} />
        <span className="w-16 shrink-0 font-mono text-[11px] text-faint">{key}</span>
        <span className="min-w-0 flex-1 truncate">{task.title}</span>
        {bucket === "working" ? (
          <span className="shrink-0 text-[11.5px]">{task.running ? <RunState task={task} /> : <span className="text-faint">queued</span>}</span>
        ) : (
          canRunAgents(host) &&
          task.kind === "task" && (
            <button
              disabled={busy}
              onClick={(e) => {
                e.stopPropagation();
                start();
              }}
              className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11.5px] text-muted hover:bg-raised hover:text-fg"
              title="Start its agent"
            >
              <Play size={11} /> Start
            </button>
          )
        )}
        {err && <span className="text-[11.5px] text-red-400">{err}</span>}
      </div>
    );

  return (
    <div
      data-triage={task.id}
      onContextMenu={onMenu && ((e) => onMenu(e, task))}
      className={clsx("rounded-lg border bg-panel-2 transition-colors", picked ? "border-accent/50" : "border-line hover:border-line-strong", open && "ring-1 ring-accent/60")}
    >
      <div onClick={onPick} className="flex cursor-pointer items-center gap-2.5 px-3 pt-2.5 pb-1.5">
        <StatusIcon status={task.status} size={13} />
        <span className="shrink-0 font-mono text-[11px] text-faint">{key}</span>
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-fg">{task.title}</span>
        <ReviewBadge task={task} compact />
        {task.pr_url && <PrIcon url={task.pr_url} className="text-muted" />}
        <span className="shrink-0 text-[11.5px] text-faint" title={new Date(task.last_activity_at).toLocaleString()}>
          {bucket === "due" && task.remind_at ? `reminder ${timeAgo(task.remind_at)}` : `waiting ${timeAgo(task.last_activity_at).replace(" ago", "")}`}
        </span>
      </div>
      <div onClick={onPick} className="cursor-pointer px-3 pb-2.5 pl-[34px]">
        {bucket === "answer" && task.attention_reason && (
          <div className="mb-1.5 rounded-md bg-st-attention/[0.08] px-2 py-1.5 text-[12.5px] leading-snug text-amber-200/90">{task.attention_reason}</div>
        )}
        {bucket === "due" && task.reminder && <div className="mb-1.5 text-[12.5px] text-amber-200/90">{task.reminder}</div>}
        {last === undefined ? (
          <div className="text-[12px] text-faint">…</div>
        ) : last ? (
          <div className={clsx("relative overflow-hidden text-[12.5px] text-muted", !picked && "max-h-[4.6em]")}>
            <Markdown text={last} />
            {!picked && <div className="pointer-events-none absolute inset-x-0 bottom-0 h-5 bg-gradient-to-t from-panel-2" />}
          </div>
        ) : (
          <div className="text-[12px] text-faint">No reply from the agent yet.</div>
        )}
      </div>
      {picked && (
        <div className="border-t border-line pt-3">
          <div className="flex flex-wrap items-center gap-2 px-3 pb-2 pl-[34px]">
            <Button size="sm" variant="ghost" onClick={() => openTask(task.id)} title="Open the thread beside the list (Enter)">
              <MessagesSquare size={13} /> Thread
            </Button>
            {bucket === "review" && (
              <Button size="sm" variant="primary" disabled={busy} onClick={merge} title="Move it to Ready for merge: its agent merges it">
                <GitMerge size={13} /> Ready for merge
              </Button>
            )}
            {err && <span className="text-[12px] text-red-400">{err}</span>}
          </div>
          {task.status === "needs_attention" && (
            <div className="px-3 pb-2 pl-[34px]">
              <PendingPrompts task={task} />
            </div>
          )}
          {/* The thread's own composer: a draft here is the same draft as in its panel. */}
          <Composer task={task} placeholder={bucket === "answer" ? "Answer the agent…" : "Reply to the agent…"} />
        </div>
      )}
    </div>
  );
}

export function TriageView({ tasks, projectOf, onMenu }: { tasks: Task[]; projectOf: (t: Task) => Project | undefined; onMenu?: OnMenu }) {
  const now = useClock(60_000);
  const [closed, setClosed] = useState<Set<BucketId>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(CLOSED_KEY) ?? '["start","working"]'));
    } catch {
      return new Set<BucketId>(["start", "working"]);
    }
  });
  const toggle = (id: BucketId) => {
    const next = new Set(closed);
    if (!next.delete(id)) next.add(id);
    setClosed(next);
    localStorage.setItem(CLOSED_KEY, JSON.stringify([...next]));
  };
  const buckets = useMemo(() => {
    const by = new Map<BucketId, Task[]>(BUCKETS.map((b) => [b.id, []]));
    for (const t of tasks) {
      const b = bucketOf(t, now);
      if (b) by.get(b)!.push(t);
    }
    // Waiting longest first; what's not started in the board's order.
    for (const [id, ts] of by) if (id !== "start") ts.sort((a, b) => a.last_activity_at.localeCompare(b.last_activity_at));
    return BUCKETS.map((b) => ({ ...b, tasks: by.get(b.id)! }));
  }, [tasks, now]);

  // What j and k move through: the tasks of open buckets that list their details.
  const order = buckets.filter((b) => DETAILED.has(b.id) && !closed.has(b.id)).flatMap((b) => b.tasks.map((t) => t.id));
  const [picked, setPicked] = useState<string | null>(null);
  const current = picked && order.includes(picked) ? picked : null;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || (e.target as Element).closest?.("input, textarea, select, [contenteditable]") || document.querySelector("[data-modal]")) return;
      if (e.key !== "j" && e.key !== "k" && e.key !== "Enter") return;
      if (e.key === "Enter") {
        // Not a press of the button or link that has the focus.
        if (current && !(e.target as Element).closest?.("button, a")) openTask(current);
        return;
      }
      e.preventDefault();
      const i = current ? order.indexOf(current) : -1;
      const next = order[Math.max(0, Math.min(order.length - 1, i + (e.key === "j" ? 1 : -1)))];
      if (!next) return;
      setPicked(next);
      requestAnimationFrame(() => document.querySelector(`[data-triage="${next}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [order, current]);

  const needs = buckets.filter((b) => DETAILED.has(b.id)).reduce((n, b) => n + b.tasks.length, 0);
  const working = buckets.find((b) => b.id === "working")!.tasks.length;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-4xl space-y-5 p-6">
        <div className="flex items-baseline gap-3">
          <h2 className="text-[15px] font-semibold">{needs ? `${needs} task${needs === 1 ? "" : "s"} need${needs === 1 ? "s" : ""} you` : "Nothing needs you"}</h2>
          <span className="text-[12px] text-faint">
            {working} agent{working === 1 ? "" : "s"} at work · <Kbd>j</Kbd> <Kbd>k</Kbd> to move, <Kbd>Enter</Kbd> to open the thread
          </span>
        </div>
        {buckets.map((b) =>
          b.tasks.length === 0 ? null : (
            <section key={b.id}>
              <button onClick={() => toggle(b.id)} className="mb-2 flex items-center gap-2 text-left" title={b.hint}>
                <ChevronRight size={14} className={clsx("text-faint transition-transform", !closed.has(b.id) && "rotate-90")} />
                {b.icon}
                <h3 className="text-[13px] font-medium">{b.title}</h3>
                <span className="text-[12px] text-faint">{b.tasks.length}</span>
              </button>
              {!closed.has(b.id) &&
                (DETAILED.has(b.id) ? (
                  <div className="space-y-2">
                    {b.tasks.map((t) => (
                      <TriageItem key={t.id} task={t} project={projectOf(t)} bucket={b.id} picked={current === t.id} onPick={() => setPicked(current === t.id ? null : t.id)} onMenu={onMenu} />
                    ))}
                  </div>
                ) : (
                  <div className="overflow-hidden rounded-lg border border-line">
                    {b.tasks.map((t, i) => (
                      <div key={t.id} className={clsx(i > 0 && "border-t border-line")}>
                        <TriageItem task={t} project={projectOf(t)} bucket={b.id} picked={false} onPick={() => {}} onMenu={onMenu} />
                      </div>
                    ))}
                  </div>
                ))}
            </section>
          ),
        )}
      </div>
    </div>
  );
}
