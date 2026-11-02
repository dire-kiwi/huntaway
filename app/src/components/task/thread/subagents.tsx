import clsx from "clsx";
import { ArrowLeft, Bot, Check, ChevronRight, FileText, Loader2, LocateFixed, Maximize2, ShieldQuestion, Square, X } from "lucide-react";
import { Fragment, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { duration, subagentTitle, useSubagentFocus, useSubagentView, type Subagent } from "../../../subagents";
import { buildItems, type Call, type Item, type ToolResult } from "../../../threadModel";
import { RunningDot } from "../../ui";
import { lineage, ThreadCtx, usePendingFocus, useThread } from "./context";
import { ItemList } from "./ItemList";
import { Collapsible } from "./items";
import { Markdown } from "./Markdown";
import { CodeBlock } from "./tools";

/** The subagent's final report, without the harness frame around a foreground result. */
function reportText(s: Subagent, result?: ToolResult): string | null {
  // A foreground Skill's notification can just repeat its name ("/code-review"); its actual
  // report is in the tool result. Background agents deliver their report in the notification.
  if (!result || s.background) return s.summary ?? null;
  const marker = "The report follows:\n";
  const i = result.content.indexOf(marker);
  if (i < 0) return result.content;
  return result.content
    .slice(i + marker.length)
    .split("\n")
    .map((l) => l.replace(/^ {2}/, ""))
    .join("\n");
}

export function SubagentStatusBadge({ s, compact }: { s: Subagent; compact?: boolean }) {
  const took = duration(s);
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-[11.5px]">
      {s.background && <span className="rounded bg-white/5 px-1 py-px text-[10.5px] text-faint">background</span>}
      {s.status === "running" && s.awaitingApproval ? (
        <span className="flex items-center gap-1 text-st-attention">
          needs approval <ShieldQuestion size={12} />
        </span>
      ) : s.status === "running" ? (
        <>
          {!compact && s.activity && <span className="max-w-[16rem] truncate text-faint">{s.activity}</span>}
          <Loader2 size={12} className="animate-spin text-st-progress" />
        </>
      ) : s.status === "completed" ? (
        <>
          {took && <span className="text-faint">{took}</span>}
          <Check size={12} className="text-emerald-400" />
        </>
      ) : s.status === "failed" ? (
        <span className="flex items-center gap-1 text-red-400">
          failed <X size={12} />
        </span>
      ) : (
        <span className="flex items-center gap-1 text-faint">
          stopped <Square size={9} />
        </span>
      )}
    </span>
  );
}

export function SubagentRow({ call, sub }: { call: Call; sub: Subagent }) {
  const source = useContext(ThreadCtx)!;
  const taskId = useThread((t) => t.taskId);
  const show = useSubagentView((s) => s.show);
  const [open, setOpen] = useState(false);
  const [flash, setFlash] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const focus = usePendingFocus();
  const handle = useSubagentFocus((s) => s.handle);
  useEffect(() => {
    if (!focus) return;
    if (focus.id === sub.id) {
      setOpen(true);
      setFlash(true);
      requestAnimationFrame(() => ref.current?.scrollIntoView({ block: "start", behavior: "smooth" }));
      handle(focus.n);
    } else if (lineage(source.data.subagents, focus.id).includes(sub.id)) setOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus]);
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(false), 1500);
    return () => clearTimeout(t);
  }, [flash]);

  return (
    <div ref={ref} data-tool-row className={clsx("scroll-mt-4 rounded transition-colors", flash && "bg-accent/10")}>
      <div className="group flex items-center rounded hover:bg-white/[0.03]">
        <button onClick={() => setOpen(!open)} className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1 text-left text-[12.5px]">
          <ChevronRight size={12} className={clsx("shrink-0 text-faint transition-transform", open && "rotate-90")} />
          <span className="shrink-0 text-muted">
            <Bot size={13} />
          </span>
          <span className="shrink-0 text-muted">{subagentKind(sub)}</span>
          <span className="min-w-0 truncate text-[12.5px] text-[#b9b9c8]">{subagentTitle(sub)}</span>
          <span className="ml-auto">
            <SubagentStatusBadge s={sub} />
          </span>
        </button>
        <button
          onClick={() => show(taskId, sub.id)}
          title="Open its thread"
          aria-label="Open subagent thread"
          className="mr-1 shrink-0 rounded p-1 text-faint hover:bg-white/5 hover:text-fg"
        >
          <Maximize2 size={12} />
        </button>
      </div>
      {open && <SubagentBody call={call} sub={sub} />}
    </div>
  );
}

const subagentKind = (s: Subagent) => (s.agentType && s.agentType !== "general-purpose" ? s.agentType : "Subagent");

/** A subagent's conversation inline, under its row in the thread that started it. */
function SubagentBody({ call, sub }: { call: Call; sub: Subagent }) {
  const meta = [sub.model, toolUses(sub)].filter(Boolean);
  return (
    <div className="mt-1 mb-2 ml-[13px] space-y-3 border-l border-line pr-2 pl-4">
      {meta.length > 0 && <div className="text-[11.5px] text-faint">{meta.join(" · ")}</div>}
      {sub.prompt && <Collapsible label="Prompt" icon={<FileText size={13} />} text={sub.prompt} />}
      <SubagentItems sub={sub} result={call.result} />
    </div>
  );
}

const toolUses = (s: Subagent) => s.toolUses != null && `${s.toolUses} tool use${s.toolUses === 1 ? "" : "s"}`;

/**
 * What a subagent did, and its report. Its permission prompts are answered in the main thread, so
 * they're left out inline and shown in its own thread (`withPrompts`).
 */
function SubagentItems({ sub, result, withPrompts }: { sub: Subagent; result?: ToolResult; withPrompts?: boolean }) {
  const msgs = useThread((t) => t.children.get(sub.id));
  const results = useThread((t) => t.results);
  const running = useThread((t) => t.running);
  const hostId = useThread((t) => t.hostId);
  const cwd = useThread((t) => t.cwd);
  const prev = useRef<Item[]>(undefined);
  const items = useMemo(
    () => (prev.current = buildItems((msgs ?? []).filter((m) => withPrompts || m.kind !== "permission"), results, prev.current)),
    [msgs, results, withPrompts],
  );
  const report = reportText(sub, result);
  const hasText = items.some((i) => i.type === "text");
  // A subagent's own messages leave the thread's items as they were, so the thread doesn't scroll for them: this
  // does, as they come (not as it's opened, which would move the row that was clicked). `sub` is a new object when
  // anything about it changes (e.g. its prompt, which can come late), and `result` when its result comes.
  const follow = useThread((t) => t.follow);
  const shown = useRef<unknown[]>(null);
  useLayoutEffect(() => {
    const now = [items, sub, result];
    if (shown.current?.some((x, i) => x !== now[i])) follow();
    shown.current = now;
  }, [follow, items, sub, result]);
  return (
    <>
      <ItemList items={items} running={running && sub.status === "running"} hostId={hostId} cwd={cwd} />
      {sub.status === "running" && (
        <div className="flex items-center gap-2 text-[12px] text-muted">
          <RunningDot /> {sub.activity ?? "Working…"}
        </div>
      )}
      {sub.status === "failed" && result?.isError ? <CodeBlock text={result.content} tone="error" /> : !hasText && report && <Markdown text={report} />}
      {sub.status === "stopped" && !report && <div className="text-[12px] text-faint">Stopped before it finished.</div>}
    </>
  );
}

/** A subagent's own thread, shown in place of the main conversation: its prompt, what it did and its report. */
export function SubagentThread({ sub }: { sub: Subagent }) {
  const result = useThread((t) => t.results.get(sub.id));
  const meta = [subagentKind(sub), sub.model, toolUses(sub)].filter(Boolean);
  return (
    <>
      <div className="text-[11.5px] text-faint">{meta.join(" · ")}</div>
      {sub.prompt && (
        <div className="flex justify-end">
          <div className="max-w-[85%] rounded-2xl rounded-br-md border border-line-strong bg-raised px-3.5 py-2 text-[13.5px] whitespace-pre-wrap">{sub.prompt}</div>
        </div>
      )}
      <SubagentItems sub={sub} result={result} withPrompts />
    </>
  );
}

/** Above a subagent's own thread: the way back to the threads that started it, and to its row in the main one. */
export function SubagentBar({ sub }: { sub: Subagent }) {
  const subagents = useThread((t) => t.subagents);
  const taskId = useThread((t) => t.taskId);
  const show = useSubagentView((s) => s.show);
  const reveal = useSubagentFocus((s) => s.reveal);
  // Outermost first, without this one.
  const outer = lineage(subagents, sub.id)
    .slice(1)
    .reverse()
    .map((id) => subagents.get(id)!);
  const crumb = "min-w-0 shrink truncate text-muted hover:text-fg";
  return (
    <div className="flex h-10 shrink-0 items-center gap-1.5 border-b border-line px-3 text-[12.5px]">
      <button
        onClick={() => show(taskId, sub.parent)}
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
            {subagentTitle(o)}
          </button>
        </Fragment>
      ))}
      <ChevronRight size={12} className="shrink-0 text-faint" />
      <Bot size={13} className="shrink-0 text-muted" />
      <span className="min-w-0 truncate text-fg">{subagentTitle(sub)}</span>
      <span className="ml-auto flex shrink-0 items-center gap-2 pl-2">
        <SubagentStatusBadge s={sub} compact />
        <button
          onClick={() => {
            show(taskId, null);
            reveal(taskId, sub.id);
          }}
          title="Show where it is in the main thread"
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[12px] text-muted hover:bg-white/5 hover:text-fg"
        >
          <LocateFixed size={12} /> Show in thread
        </button>
      </span>
    </div>
  );
}
