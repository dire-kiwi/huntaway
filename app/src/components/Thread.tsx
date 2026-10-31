import clsx from "clsx";
import {
  ArrowLeft,
  ArrowUp,
  Ban,
  Bot,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Clock,
  FileText,
  Globe,
  History,
  Hourglass,
  Layers,
  LayoutGrid,
  ListChecks,
  Loader2,
  LocateFixed,
  Map as MapIcon,
  Maximize2,
  MessageSquare,
  Pencil,
  Search,
  ShieldOff,
  ShieldQuestion,
  Sparkles,
  Square,
  Terminal,
  Wrench,
  X,
} from "lucide-react";
import {
  createContext,
  Fragment,
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, dependencyQueued, hostSupports, PERMISSION_MODES, runningAgentSteers, stopTitle, type Message, type PermissionMode, type RewindResult, type Task, type Turn } from "../api";
import { useHost, useProject, useStore, useThreadMessages } from "../store";
import { duration, subagentTitle, useSubagentFocus, useSubagentView, type Subagent } from "../subagents";
import { buildItems, threadModel, type Call, type Item, type ThreadModel, type ToolResult } from "../threadModel";
import { splitAttachments, withAttachments, type AttachmentRef } from "../attachments";
import { lineRange, removeComments, reviewMessage, useReview, withComments, type LineComment } from "../lineComments";
import { AutomationChangeCard, ProjectChangeCard, TaskDeletionCard } from "./Approvals";
import { AskCard, BoardQuestionCard, PlanCard } from "./Questions";
import { QUESTION_TOOLS, questionsOf } from "../questions";
import { AttachButton, AttachmentList, DraftAttachments, useAttachmentDraft } from "./Attachments";
import { SkillHint, SkillMenu, useSkillMenu } from "./SkillMenu";
import { TOUCH_QUERY } from "../narrow";
import { Button, RunningDot, WaitReason, waitTitle } from "./ui";
import { RewindDialog, RewindNote } from "./Rewind";
import { useTurns } from "../turns";

// ---------- markdown ----------

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="prose-chat">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{ a: ({ ...p }) => <a {...p} target="_blank" rel="noreferrer" /> }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

// ---------- tool calls ----------

export function toolMeta(name: string, input: Any, cwd?: string | null): { icon: ReactNode; label: string; summary: string } {
  const rel = (p?: string) => (p && cwd && p.startsWith(cwd + "/") ? p.slice(cwd.length + 1) : p ?? "");
  const s = 13;
  switch (name) {
    case "Bash":
      return { icon: <Terminal size={s} />, label: "Ran", summary: input?.command ?? "" };
    case "Read":
      return { icon: <FileText size={s} />, label: "Read", summary: rel(input?.file_path) };
    case "Edit":
    case "MultiEdit":
      return { icon: <Pencil size={s} />, label: "Edited", summary: rel(input?.file_path) };
    case "Write":
      return { icon: <Pencil size={s} />, label: "Wrote", summary: rel(input?.file_path) };
    // Codex's file edits (see codex.rs on the server).
    case "ApplyPatch": {
      const changes: Any[] = input?.changes ?? [];
      const label = changes.length && changes.every((c) => c.kind === "add") ? "Wrote" : changes.every((c) => c.kind === "delete") ? "Deleted" : "Edited";
      return { icon: <Pencil size={s} />, label, summary: changes.map((c) => rel(c.path)).join(", ") };
    }
    case "NotebookEdit":
      return { icon: <Pencil size={s} />, label: "Edited", summary: rel(input?.notebook_path) };
    case "Grep":
      return { icon: <Search size={s} />, label: "Searched", summary: `${input?.pattern ?? ""}${input?.path ? `  in ${rel(input.path)}` : ""}` };
    case "Glob":
      return { icon: <Search size={s} />, label: "Listed", summary: input?.pattern ?? "" };
    case "WebFetch":
      return { icon: <Globe size={s} />, label: "Fetched", summary: input?.url ?? "" };
    case "WebSearch":
      return { icon: <Globe size={s} />, label: "Searched web", summary: input?.query ?? "" };
    case "Task":
    case "Agent":
      return { icon: <Bot size={s} />, label: "Subagent", summary: input?.description ?? "" };
    case "TodoWrite":
      return { icon: <ListChecks size={s} />, label: "Updated todos", summary: `${input?.todos?.length ?? 0} items` };
  }
  // The board's own server; mcp__issue_agent__ is its name before the rename to Huntaway.
  const board = /^mcp__(huntaway|issue_agent)__/;
  if (board.test(name)) {
    const tool = name.replace(board, "");
    return { icon: <LayoutGrid size={s} />, label: "Board", summary: `${tool}${input?.title ? `  “${input.title}”` : input?.question ? `  ${input.question}` : ""}` };
  }
  return { icon: <Wrench size={s} />, label: name.replace(/^mcp__/, "").replace(/__/g, " · "), summary: "" };
}

function EditDiff({ oldStr, newStr }: { oldStr: string; newStr: string }) {
  return (
    <pre className="overflow-x-auto rounded-md border border-line bg-[#0c0c10] p-2 font-mono text-[12px] leading-[1.45]">
      {oldStr.split("\n").map((l, i) => (
        <div key={`o${i}`} className="bg-red-500/10 text-red-300">
          - {l}
        </div>
      ))}
      {newStr.split("\n").map((l, i) => (
        <div key={`n${i}`} className="bg-emerald-500/10 text-emerald-300">
          + {l}
        </div>
      ))}
    </pre>
  );
}

/** A unified diff, as Codex reports a file change. */
function PatchDiff({ change }: { change: Any }) {
  const tone = (l: string) =>
    l.startsWith("+") && !l.startsWith("+++")
      ? "bg-emerald-500/10 text-emerald-300"
      : l.startsWith("-") && !l.startsWith("---")
        ? "bg-red-500/10 text-red-300"
        : l.startsWith("@@")
          ? "text-faint"
          : "text-[#c9c9d6]";
  const lines = String(change.diff ?? "").replace(/\n$/, "").split("\n");
  return (
    <div>
      <div className="mb-1 font-mono text-[11.5px] text-muted">
        {change.kind === "add" ? "new " : change.kind === "delete" ? "deleted " : ""}
        {change.path}
        {change.move_path ? ` → ${change.move_path}` : ""}
      </div>
      <pre className="max-h-80 overflow-auto rounded-md border border-line bg-[#0c0c10] p-2 font-mono text-[12px] leading-[1.45]">
        {lines.map((l, i) => (
          <div key={i} className={tone(l)}>
            {l || " "}
          </div>
        ))}
      </pre>
    </div>
  );
}

function ToolInput({ name, input }: { name: string; input: Any }) {
  if (name === "Bash") return <CodeBlock text={input?.command ?? ""} />;
  if (name === "ApplyPatch")
    return (
      <div className="space-y-2">
        {(input?.changes ?? []).map((c: Any, i: number) => (
          <PatchDiff key={i} change={c} />
        ))}
      </div>
    );
  if (name === "Edit") return <EditDiff oldStr={input?.old_string ?? ""} newStr={input?.new_string ?? ""} />;
  if (name === "MultiEdit")
    return (
      <div className="space-y-1">
        {(input?.edits ?? []).map((e: Any, i: number) => (
          <EditDiff key={i} oldStr={e.old_string ?? ""} newStr={e.new_string ?? ""} />
        ))}
      </div>
    );
  if (name === "Write") return <CodeBlock text={input?.content ?? ""} max="max-h-64" />;
  if (name === "TodoWrite")
    return (
      <ul className="space-y-0.5 text-[12.5px]">
        {(input?.todos ?? []).map((t: Any, i: number) => (
          <li key={i} className={clsx("flex gap-2", t.status === "completed" && "text-faint line-through")}>
            <span>{t.status === "completed" ? "✓" : t.status === "in_progress" ? "◐" : "○"}</span>
            {t.content}
          </li>
        ))}
      </ul>
    );
  return <CodeBlock text={JSON.stringify(input, null, 2)} />;
}

function CodeBlock({ text, max = "max-h-80", tone }: { text: string; max?: string; tone?: "error" }) {
  return (
    <pre
      className={clsx(
        "overflow-auto rounded-md border border-line bg-[#0c0c10] p-2 font-mono text-[12px] leading-[1.45] whitespace-pre-wrap break-words",
        max,
        tone === "error" ? "text-red-300" : "text-[#c9c9d6]",
      )}
    >
      {text || <span className="text-faint">(empty)</span>}
    </pre>
  );
}

/** Tools whose input already shows the change, so only an error result is worth showing. */
const EDIT_TOOLS = ["Edit", "Write", "ApplyPatch"];

const ToolRow = memo(function ToolRow({ call, running, cwd }: { call: Call; running: boolean; cwd?: string | null }) {
  const sub = useThread((t) => t.subagents.get(call.id));
  if (sub) return <SubagentRow call={call} sub={sub} />;
  return <PlainToolRow call={call} running={running} cwd={cwd} />;
});

function PlainToolRow({ call, running, cwd }: { call: Call; running: boolean; cwd?: string | null }) {
  const [open, setOpen] = useState(false);
  const m = toolMeta(call.name, call.input, cwd);
  const pending = !call.result;
  return (
    <div data-tool-row>
      <button
        onClick={() => setOpen(!open)}
        className="group flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[12.5px] hover:bg-white/[0.03]"
      >
        <ChevronRight size={12} className={clsx("shrink-0 text-faint transition-transform", open && "rotate-90")} />
        <span className="shrink-0 text-muted">{m.icon}</span>
        <span className="shrink-0 text-muted">{m.label}</span>
        <span className="min-w-0 truncate font-mono text-[12px] text-[#b9b9c8]">{m.summary}</span>
        <span className="ml-auto shrink-0">
          {pending && running ? (
            <Loader2 size={12} className="animate-spin text-st-progress" />
          ) : call.result?.isError ? (
            <X size={12} className="text-red-400" />
          ) : null}
        </span>
      </button>
      {open && (
        <div className="space-y-2 px-2 pb-2 pl-7">
          <ToolInput name={call.name} input={call.input} />
          {call.result && !EDIT_TOOLS.includes(call.name) && <CodeBlock text={call.result.content} tone={call.result.isError ? "error" : undefined} />}
          {call.result?.isError && EDIT_TOOLS.includes(call.name) && <CodeBlock text={call.result.content} tone="error" />}
        </div>
      )}
    </div>
  );
}

const ToolGroup = memo(function ToolGroup({ calls, running, cwd }: { calls: Call[]; running: boolean; cwd?: string | null }) {
  const [expanded, setExpanded] = useState(false);
  const LIMIT = 6;
  const hidden = calls.length - LIMIT;
  const source = useContext(ThreadCtx)!;
  const focus = usePendingFocus();
  useEffect(() => {
    if (!focus || hidden <= 0) return;
    const path = lineage(source.data.subagents, focus.id);
    if (calls.slice(0, hidden).some((c) => path.includes(c.id))) setExpanded(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus]);
  const shown = expanded || hidden <= 0 ? calls : calls.slice(-LIMIT);
  return (
    <div className="rounded-lg border border-line bg-panel/60 py-1">
      {!expanded && hidden > 0 && (
        <button onClick={() => setExpanded(true)} className="px-3 py-1 text-[12px] text-faint hover:text-muted">
          Show {hidden} earlier tool call{hidden > 1 ? "s" : ""}
        </button>
      )}
      {shown.map((c) => (
        <ToolRow key={c.id} call={c} running={running} cwd={cwd} />
      ))}
    </div>
  );
});

// ---------- subagents ----------

type ThreadData = ThreadModel & {
  running: boolean;
  cwd?: string | null;
  hostId: string;
  taskId: string;
  /** Keeps the thread scrolled to its end, if it was there, after a part of it grew on its own. */
  follow: () => void;
};

/**
 * The thread's model, for its rows to pick what they show from (useThread). It's the same object for
 * the thread's life, so a new model only redraws the rows whose pick changed (see buildModel).
 */
class ThreadSource {
  private listeners = new Set<() => void>();
  constructor(public data: ThreadData) {}
  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => void this.listeners.delete(l);
  };
  publish() {
    for (const l of this.listeners) l();
  }
}

const ThreadCtx = createContext<ThreadSource | null>(null);

/** Part of the thread's model. `pick` mustn't make a new object each time (a Map's `get` is fine). */
function useThread<T>(pick: (t: ThreadData) => T): T {
  const source = useContext(ThreadCtx)!;
  return useSyncExternalStore(source.subscribe, () => pick(source.data));
}

/** Whether rows are in the main conversation, rather than in a subagent's own thread shown in its place. */
const InMainThread = createContext(true);

/**
 * The request to reveal a subagent in this thread's main conversation, while its row hasn't shown
 * itself yet (see useSubagentFocus). Rows in a subagent's own thread leave it alone.
 */
function usePendingFocus() {
  const taskId = useThread((t) => t.taskId);
  const main = useContext(InMainThread);
  return useSubagentFocus((s) => (main && s.focus && s.focus.taskId === taskId && s.focus.n > s.handled ? s.focus : null));
}

/** A subagent and the subagents that started it, innermost first. */
function lineage(subagents: Map<string, Subagent>, id: string): string[] {
  const out: string[] = [];
  for (let cur: string | null | undefined = id; cur && !out.includes(cur); cur = subagents.get(cur)?.parent) out.push(cur);
  return out;
}

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

function SubagentRow({ call, sub }: { call: Call; sub: Subagent }) {
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
function SubagentThread({ sub }: { sub: Subagent }) {
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
function SubagentBar({ sub }: { sub: Subagent }) {
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

// ---------- other items ----------

function Collapsible({ label, icon, text }: { label: string; icon: ReactNode; text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="text-[12.5px]">
      <button onClick={() => setOpen(!open)} className="flex items-center gap-1.5 text-faint hover:text-muted">
        {icon} {label}
        <ChevronRight size={12} className={clsx("transition-transform", open && "rotate-90")} />
      </button>
      {open && <div className="mt-1.5 border-l-2 border-line pl-3 whitespace-pre-wrap text-muted">{text}</div>}
    </div>
  );
}

function Thinking({ text }: { text: string }) {
  return <Collapsible label="Thinking" icon={<Brain size={13} />} text={text} />;
}

function EventLine({ level, text, detail }: { level: string; text: string; detail?: string | null }) {
  const [open, setOpen] = useState(false);
  const color = level === "error" ? "text-red-400" : level === "warn" ? "text-amber-400" : "text-faint";
  return (
    <div className="text-[12px]">
      <button
        disabled={!detail}
        onClick={() => setOpen(!open)}
        className={clsx("flex items-center gap-1.5", color, detail && "hover:text-muted")}
      >
        {level === "error" ? <CircleAlert size={12} /> : <span className="h-1 w-1 rounded-full bg-current" />}
        {text}
        {detail && <ChevronRight size={11} className={clsx("transition-transform", open && "rotate-90")} />}
      </button>
      {open && detail && (
        <div className="mt-1.5">
          <CodeBlock text={detail} tone={level === "error" ? "error" : undefined} />
        </div>
      )}
    </div>
  );
}

/** Which subagent asked for a prompt (its link opens the subagent's thread), unless it's the thread that's shown. */
function PromptFrom({ data }: { data: Any }) {
  const taskId = useThread((t) => t.taskId);
  const show = useSubagentView((s) => s.show);
  const viewing = useSubagentView((s) => s.open[taskId]);
  const fromId = useThread((t) => (data.tool_use_id ? t.callParent.get(data.tool_use_id) : undefined));
  // In the subagent's own thread, it's plain where the prompt is from.
  const from = useThread((t) => (fromId && fromId !== viewing ? t.subagents.get(fromId) : undefined));
  if (!from) return null;
  return (
    <button
      onClick={() => show(taskId, from.id)}
      className="flex min-w-0 items-center gap-1 text-[12px] text-faint hover:text-muted"
      title="Open the subagent's thread"
    >
      <Bot size={12} className="shrink-0" />
      <span className="truncate">from {subagentTitle(from)}</span>
    </button>
  );
}

/** A question the agent asked with request_user_input. */
function QuestionRow({ id, data, hostId }: { id: number; data: Any; hostId: string }) {
  const taskId = useThread((t) => t.taskId);
  const movedOn = useThread((t) => t.lastSent > id);
  return <BoardQuestionCard id={id} data={data} hostId={hostId} taskId={taskId} movedOn={movedOn} />;
}

/** A permission prompt: a question or a plan gets its own card. */
function PromptCard({ id, data, hostId }: { id: number; data: Any; hostId: string }) {
  const taskId = useThread((t) => t.taskId);
  // A message's been sent to the agent since: one whose run ended isn't answered any more.
  const movedOn = useThread((t) => t.lastSent > id);
  if (QUESTION_TOOLS.includes(data.tool_name) && questionsOf(data).length)
    return <AskCard id={id} data={data} hostId={hostId} from={<PromptFrom data={data} />} movedOn={movedOn} />;
  if (data.tool_name === "ExitPlanMode") return <PlanCard data={data} hostId={hostId} taskId={taskId} from={<PromptFrom data={data} />} movedOn={movedOn} />;
  return <PermissionCard data={data} hostId={hostId} />;
}

const PermissionCard = memo(function PermissionCard({ data, hostId }: { data: Any; hostId: string }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const pending = data.status === "pending";
  const decide = async (d: "allow" | "allow_always" | "deny") => {
    setBusy(true);
    setErr(null);
    try {
      await api.resolvePermission(hostId, data.request_id, d);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const m = toolMeta(data.tool_name, data.input);
  return (
    <div className={clsx("rounded-lg border p-3", pending ? "border-st-attention/50 bg-st-attention/[0.06]" : "border-line bg-panel/60")}>
      <div className="mb-2 flex items-center gap-2 text-[13px]">
        <ShieldQuestion size={15} className={pending ? "text-st-attention" : "text-faint"} />
        <span className={pending ? "text-fg" : "text-muted"}>
          {pending ? `${data.agent === "codex" ? "Codex" : "Claude"} wants to use ` : "Permission for "}
          <span className="font-mono">{data.tool_name}</span>
        </span>
        <PromptFrom data={data} />
        {!pending && (
          <span
            className={clsx(
              "ml-auto rounded px-1.5 py-0.5 text-[11px]",
              data.status === "allowed" ? "bg-emerald-500/10 text-emerald-300" : data.status === "denied" ? "bg-red-500/10 text-red-300" : "bg-white/5 text-faint",
            )}
          >
            {data.status}
          </span>
        )}
      </div>
      {pending ? <ToolInput name={data.tool_name} input={data.input} /> : <div className="truncate font-mono text-[12px] text-faint">{m.summary}</div>}
      {pending && (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" variant="primary" disabled={busy} onClick={() => decide("allow")} className="narrow:px-4">
            <Check size={13} /> Allow
          </Button>
          <Button size="sm" disabled={busy} onClick={() => decide("allow_always")} className="narrow:order-last narrow:h-auto narrow:min-h-9 narrow:py-1.5 narrow:break-all narrow:whitespace-normal">
            Always allow {data.tool_name} for this thread
          </Button>
          <Button size="sm" variant="danger" disabled={busy} onClick={() => decide("deny")} className="narrow:px-4">
            Deny
          </Button>
          {err && <span className="self-center text-xs text-red-400">{err}</span>}
        </div>
      )}
    </div>
  );
});

function tokens(n: number) {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function CompactLine({ meta, summary, result }: { meta: Any; summary?: string; result?: Any }) {
  const [open, setOpen] = useState(false);
  const bits = [
    meta.pre_tokens != null && (meta.post_tokens != null ? `${tokens(meta.pre_tokens)} → ${tokens(meta.post_tokens)} tokens` : `${tokens(meta.pre_tokens)} tokens`),
    result?.duration_ms != null && `${(result.duration_ms / 1000).toFixed(1)}s`,
    result?.total_cost_usd != null && `$${Number(result.total_cost_usd).toFixed(3)}`,
  ].filter(Boolean);
  return (
    <div className="text-[12px]">
      <button
        disabled={!summary}
        onClick={() => setOpen(!open)}
        className={clsx("flex w-full items-center gap-2 text-faint", summary && "hover:text-muted")}
      >
        <span className="h-px flex-1 bg-line" />
        <Layers size={12} />
        {meta.trigger === "auto" ? "Context full, conversation compacted" : "Conversation compacted"}
        {bits.map((b) => ` · ${b}`).join("")}
        {summary && <ChevronRight size={11} className={clsx("transition-transform", open && "rotate-90")} />}
        <span className="h-px flex-1 bg-line" />
      </button>
      {open && summary && (
        <div className="mt-2 rounded-md border border-line bg-panel/60 px-3 py-2">
          <Markdown text={summary} />
        </div>
      )}
    </div>
  );
}

function ResultLine({ data }: { data: Any }) {
  const bits = [
    data.duration_ms != null && `${(data.duration_ms / 1000).toFixed(1)}s`,
    data.num_turns != null && `${data.num_turns} turn${data.num_turns === 1 ? "" : "s"}`,
    data.total_cost_usd != null && `$${Number(data.total_cost_usd).toFixed(3)}`,
  ].filter(Boolean);
  const error = !data.interrupted && (data.is_error || (data.subtype && data.subtype !== "success"));
  return (
    <div className={clsx("flex items-center gap-2 text-[11.5px]", error ? "text-red-400" : "text-faint")}>
      <span className="h-px flex-1 bg-line" />
      {data.interrupted ? "Interrupted" : error ? `Ended: ${data.subtype ?? "error"}` : "Turn complete"} · {bits.join(" · ")}
      <span className="h-px flex-1 bg-line" />
    </div>
  );
}

// ---------- thread ----------

/** Memoized, so the task view redrawing leaves a long thread be: pass an `empty` that stays the same. */
export const Thread = memo(function Thread({
  task,
  cwd,
  placeholder,
  empty,
}: {
  task: Task;
  cwd?: string | null;
  placeholder?: string;
  empty?: ReactNode;
}) {
  const messages = useThreadMessages(task.id);
  // A long thread loads in pages, older ones as it's scrolled up (API 56).
  const pages = useStore((s) => s.threads[task.id]);
  const loadOlderMessages = useStore((s) => s.loadOlderMessages);
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
  const model = threadModel(task.id, messages ?? NO_MESSAGES, task.running, pages?.subagents);
  const items = useStableGroupKeys(model.items, task.id);
  const data = useMemo(
    () => ({ ...model, running: task.running, cwd, hostId: task.host_id, taskId: task.id, follow }),
    [model, task.running, cwd, task.host_id, task.id, follow],
  );
  // Rows that redraw now read the new model as they do; the others are told once it's shown.
  const [source] = useState(() => new ThreadSource(data));
  source.data = data;
  useLayoutEffect(() => source.publish(), [source, data]);
  // A subagent's own thread, shown in place of the main one (kept mounted, so it comes back as it was).
  const viewId = useSubagentView((s) => s.open[task.id]);
  const show = useSubagentView((s) => s.show);
  const viewed = viewId ? model.subagents.get(viewId) : undefined;
  const viewKey = viewed?.id ?? null;
  const mainScroll = useRef<number | null>(null);
  const shownView = useRef(viewKey);
  const oldest = messages?.[0]?.id;
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

  const loadOlder = useCallback(() => {
    setOlderFailed(false);
    loadOlderMessages(task.id).catch(() => setOlderFailed(true));
  }, [loadOlderMessages, task.id]);
  // Scrolled near the top of what's loaded (or it doesn't fill the screen): the page before it.
  const nearTop = useCallback(() => {
    const el = scroller.current;
    const th = useStore.getState().threads[task.id];
    if (el && shownView.current === null && th?.more && !th.loading && !olderFailed && el.scrollTop < 800) loadOlder();
  }, [task.id, loadOlder, olderFailed]);
  useEffect(nearTop, [items, nearTop]);
  // A subagent's thread, from the Agents list, that started before the loaded messages: load back to it.
  const viewedFrom = viewed?.messageId;
  const viewedBefore = viewedFrom != null && oldest != null && viewedFrom < oldest;
  useEffect(() => {
    if (viewedBefore && pages?.more && !pages.loading && !olderFailed) loadOlder();
  }, [viewedBefore, oldest, pages?.more, pages?.loading, olderFailed, loadOlder]);
  // Another subagent (or the main conversation) tries a page that failed again.
  useEffect(() => setOlderFailed(false), [viewKey]);

  useEffect(() => {
    pinned.current = true;
    mainScroll.current = null;
    setOlderFailed(false);
  }, [task.id]);

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
    <ThreadCtx.Provider value={source}>
      <div className="flex h-full min-h-0 flex-col">
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
          {pages?.more && (!viewed || pages.loading || viewedBefore) && (
            <div className="flex justify-center pt-5 text-[12px] text-faint">
              {pages.loading ? (
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
            {messages && items.length === 0 && !task.running && !pages?.more && empty}
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
});

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

/** The agent's reply as it streams in (not yet saved as a message). `onGrow` keeps the thread scrolled to it. */
function StreamingText({ taskId, onGrow }: { taskId: string; onGrow: () => void }) {
  const delta = useStore((s) => s.deltas[taskId]);
  useLayoutEffect(onGrow, [delta, onGrow]);
  return delta ? <Markdown text={delta} /> : null;
}

// Memoized: the thread redraws for changes to its task (e.g. its context use), which leave the items as they were.
const ItemList = memo(function ItemList({ items, running, hostId, cwd }: { items: Item[]; running: boolean; hostId: string; cwd?: string | null }) {
  return (
    <>
      {items.map((it) => (
        <Row key={it.key} it={it} running={running} hostId={hostId} cwd={cwd} />
      ))}
    </>
  );
});

/** Memoized: a new message leaves the items it doesn't change as they were (see buildModel), and their rows with them. */
/** The thread's turns with checkpoints, by the message each started with, and how to rewind to before one (API 70). */
const TurnsCtx = createContext<{ byMessage: Map<number, Turn>; rewind: (t: Turn) => void } | null>(null);

/** Beside a user message that started a turn: rewind the task to before it, or that it was rewound. */
function RewindMark({ id }: { id: string }) {
  const turns = useContext(TurnsCtx);
  const turn = turns?.byMessage.get(Number(id));
  if (!turns || !turn) return null;
  if (turn.stale)
    return (
      <span className="mr-2 self-center text-[11px] text-faint" title="A rewind went back to before this message">
        rewound
      </span>
    );
  if (!turn.rewind.ok) return null;
  return (
    <button
      className="mr-1 self-center rounded p-1 text-faint opacity-0 group-hover:opacity-100 hover:bg-white/5 hover:text-fg focus:opacity-100"
      title="Rewind to here: put the files back to how they were before this message"
      aria-label="Rewind to here"
      onClick={() => turns.rewind(turn)}
    >
      <History size={13} />
    </button>
  );
}

const Row = memo(function Row({ it, running, hostId, cwd }: { it: Item; running: boolean; hostId: string; cwd?: string | null }) {
  switch (it.type) {
    case "user":
      return (
        <div className="group flex justify-end">
          <RewindMark id={it.key} />
          <div
            title={it.steered ? "Sent while the agent was working; it read it here" : undefined}
            className={clsx(
              "max-w-[85%] rounded-2xl rounded-br-md border px-3.5 py-2 text-[13.5px] whitespace-pre-wrap narrow:break-words",
              it.auto ? "border-line bg-transparent text-muted italic" : "border-line-strong bg-raised",
            )}
          >
            <UserText text={it.text} hostId={hostId} />
          </div>
        </div>
      );
    case "text":
      return <Markdown text={it.text} />;
    case "thinking":
      return <Thinking text={it.text} />;
    case "tools":
      return <ToolGroup calls={it.calls} running={running} cwd={cwd} />;
    case "event":
      return <EventLine level={it.level} text={it.text} detail={it.detail} />;
    case "permission":
      if (it.data.kind === "project") return <ProjectChangeCard data={it.data} hostId={hostId} />;
      if (it.data.kind === "delete_task") return <TaskDeletionCard data={it.data} hostId={hostId} />;
      if (it.data.kind === "automation") return <AutomationChangeCard data={it.data} hostId={hostId} />;
      return <PromptCard id={Number(it.key)} data={it.data} hostId={hostId} />;
    case "question":
      return <QuestionRow id={it.id} data={it.data} hostId={hostId} />;
    case "result":
      return <ResultLine data={it.data} />;
    case "compact":
      return <CompactLine meta={it.meta} summary={it.summary} result={it.result} />;
  }
});

// ---------- permission mode ----------

const MODE_STYLE: Record<PermissionMode, { icon: ReactNode; className: string }> = {
  default: { icon: <ShieldQuestion size={12} />, className: "text-muted" },
  acceptEdits: { icon: <Pencil size={12} />, className: "text-violet-300" },
  auto: { icon: <Sparkles size={12} />, className: "text-sky-300" },
  plan: { icon: <MapIcon size={12} />, className: "text-emerald-300" },
  dontAsk: { icon: <Ban size={12} />, className: "text-amber-300" },
  bypassPermissions: { icon: <ShieldOff size={12} />, className: "text-red-300" },
};

/** Modes Shift+Tab cycles through, like Claude Code. Riskier ones are picked from the menu. */
const CYCLE: PermissionMode[] = ["default", "acceptEdits", "auto", "plan"];

function useModeControl(task: Task) {
  const project = useProject(task.project_id);
  const hostMode = useStore((s) => s.hostSettings[task.host_id]?.default_permission_mode);
  const inherited: PermissionMode = project?.permission_mode ?? hostMode ?? "default";
  // Where the inherited mode comes from, for the reset entry.
  const source = project?.permission_mode ? "project default" : hostMode ? "host default" : "default";
  const mode = task.permission_mode ?? inherited;
  const [err, setErr] = useState<string | null>(null);
  const setMode = async (m: PermissionMode | null) => {
    setErr(null);
    try {
      useStore.getState().upsertTask({ ...(await api.updateTask(task.host_id, task.id, { permission_mode: m })), host_id: task.host_id });
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const cycle = () => {
    const i = CYCLE.indexOf(mode);
    setMode(CYCLE[(i + 1) % CYCLE.length]);
  };
  return { mode, inherited, source, overridden: task.permission_mode != null, setMode, cycle, err };
}

function ModeSelect({ control, running }: { control: ReturnType<typeof useModeControl>; running: boolean }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const { mode, inherited, source, overridden, setMode } = control;
  const current = PERMISSION_MODES.find((m) => m.id === mode) ?? PERMISSION_MODES[0];

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault(); // so it doesn't close the task panel, or leave a subagent's thread, as well
      setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    // In the capture phase, ahead of the thread's own Escape on the document (registered before the menu opened).
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const pick = (m: PermissionMode | null) => {
    setOpen(false);
    setMode(m);
  };
  const inheritedLabel = PERMISSION_MODES.find((m) => m.id === inherited)?.label;

  return (
    <div ref={root} className="relative">
      <button
        onClick={() => setOpen(!open)}
        title={`Permission mode: ${current.description} (Shift+Tab to cycle)`}
        className={clsx(
          "flex h-6 items-center gap-1 rounded-md border border-line px-1.5 text-[11.5px] hover:border-line-strong hover:bg-white/5",
          MODE_STYLE[mode].className,
        )}
      >
        {MODE_STYLE[mode].icon}
        {current.label}
        <ChevronDown size={11} className="text-faint" />
      </button>
      {open && (
        <div className="absolute bottom-full left-0 z-20 mb-1.5 w-80 rounded-lg border border-line-strong bg-panel-2 p-1 shadow-xl">
          {PERMISSION_MODES.map((m) => (
            <button
              key={m.id}
              onClick={() => pick(m.id)}
              className={clsx("flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-white/5", m.id === mode && "bg-white/[0.04]")}
            >
              <span className={clsx("mt-0.5", MODE_STYLE[m.id].className)}>{MODE_STYLE[m.id].icon}</span>
              <span className="min-w-0 flex-1">
                <span className="block text-[12.5px] text-fg">{m.label}</span>
                <span className="block text-[11.5px] text-faint">{m.description}</span>
              </span>
              {m.id === mode && <Check size={13} className="mt-0.5 text-accent" />}
            </button>
          ))}
          <button
            onClick={() => pick(null)}
            disabled={!overridden}
            className="mt-1 flex w-full items-center gap-2 rounded-md border-t border-line px-2 py-1.5 text-left text-[11.5px] text-muted hover:bg-white/5 disabled:text-faint disabled:hover:bg-transparent"
          >
            {overridden ? `Reset to ${source} (${inheritedLabel})` : `Using ${source} (${inheritedLabel})`}
          </button>
          {running && (
            <div className="px-2 pt-1 pb-0.5 text-[11px] text-faint">
              Changes apply from the next message. Bypass and Don't ask also settle prompts in the current run.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** The diff's comments waiting to go with the next message: each one's file and lines, and its note. */
function ComposerComments({ task, comments }: { task: Task; comments: LineComment[] }) {
  return (
    <div className="border-b border-line px-4 py-2" data-comments>
      <div className="mb-1.5 flex items-center gap-1.5 text-[11px] text-faint">
        <MessageSquare size={11} className="text-accent" />
        {comments.length === 1 ? "A comment" : `${comments.length} comments`} on the diff, sent with this message
      </div>
      <div className="flex flex-wrap gap-1.5">
        {comments.map((c) => (
          <span
            key={c.id}
            title={`${c.path}, ${lineRange(c)} (${c.source})\n\n${c.note}`}
            className="flex max-w-full min-w-0 items-center gap-1.5 rounded-md border border-line-strong bg-raised py-0.5 pr-0.5 pl-2 text-[11.5px]"
          >
            <span className="shrink-0 font-mono text-muted">
              {c.path.split("/").pop()}:{c.start === c.end ? c.start : `${c.start}–${c.end}`}
            </span>
            <span className="max-w-[28ch] min-w-0 truncate text-fg">{c.note}</span>
            <button
              onClick={() => removeComments(task.host_id, task.id, [c.id])}
              title="Remove the comment"
              className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-faint hover:bg-white/10 hover:text-fg"
            >
              <X size={11} />
            </button>
          </span>
        ))}
      </div>
    </div>
  );
}

/** A user message: its text, and the files attached to it. */
function UserText({ text, hostId }: { text: string; hostId: string }) {
  const { text: body, files } = useMemo(() => splitAttachments(text), [text]);
  return (
    <>
      {body}
      <AttachmentList hostId={hostId} files={files} className={clsx(body && "mt-2")} />
    </>
  );
}

function QueuedMessage({ text, hostId }: { text: string; hostId: string }) {
  const { text: body, files } = splitAttachments(text);
  return (
    <>
      {body && <div className="line-clamp-4 text-[13px] whitespace-pre-wrap text-muted">{body}</div>}
      <AttachmentList hostId={hostId} files={files} className="mt-1" />
    </>
  );
}

/** What's been written to a task's agent and not sent, so another tab, task or a reload doesn't lose it. */
const composerDraftKey = (task: Task) => `ia.composer.draft.${task.host_id}:${task.id}`;

type ComposerDraft = { text: string; files: AttachmentRef[] };

/** The drafts as last written on this page, for when the browser's storage can't take them (full, or turned off). */
const pageDrafts = new Map<string, ComposerDraft | null>();

function loadComposerDraft(key: string): ComposerDraft | null {
  if (pageDrafts.has(key)) return pageDrafts.get(key)!;
  try {
    const d = JSON.parse(localStorage.getItem(key) ?? "null");
    return d && typeof d.text === "string" ? { text: d.text, files: Array.isArray(d.files) ? d.files : [] } : null;
  } catch {
    return null;
  }
}

/** Whether the browser kept it: if not, it's only kept while the page is open. */
function saveComposerDraft(key: string, text: string, files: AttachmentRef[]) {
  const empty = !text.trim() && !files.length;
  pageDrafts.set(key, empty ? null : { text, files });
  try {
    if (empty) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify({ text, files }));
    return true;
  } catch {
    return false;
  }
}

/** `typed` once `sent` has gone: what was typed after it while it was sending, or all of it if what was sent was changed. */
export const afterSent = (typed: string, sent: string) => (sent && typed.startsWith(sent) ? typed.slice(sent.length).replace(/^\s+/, "") : typed);

/** How a send ended: what went (text as typed, and files), or why it didn't. */
type SendEnd = { sent: string; files: AttachmentRef[] } | { error: string };

/**
 * Messages being sent, by draft key, and the composers showing that draft. They're kept here, not in the composer
 * that sent them: it can be gone (another tab or card) before the host answers, and a composer opened meanwhile
 * shows the send under way, and takes what was sent off its draft once it's gone.
 */
const sending = new Map<string, number>();
const sendWatchers = new Map<string, Set<(end: SendEnd) => void>>();

/** Sends a message: what was typed (`sent`), the files attached and the diff comments in it (by id) come off the draft once it's gone. */
async function sendDraft(key: string, task: Task, body: string, sent: string, files: AttachmentRef[], comments: string[] = []): Promise<SendEnd> {
  sending.set(key, (sending.get(key) ?? 0) + 1);
  let end: SendEnd;
  try {
    await api.send(task.host_id, task.id, body);
    // Off the saved draft as well, for when no composer shows it.
    const d = loadComposerDraft(key);
    if (d) saveComposerDraft(key, afterSent(d.text, sent), d.files.filter((f) => !files.some((x) => x.id === f.id)));
    removeComments(task.host_id, task.id, comments);
    end = { sent, files };
  } catch (e) {
    end = { error: (e as Error).message };
  }
  const n = (sending.get(key) ?? 1) - 1;
  if (n) sending.set(key, n);
  else sending.delete(key);
  for (const watch of sendWatchers.get(key) ?? []) watch(end);
  return end;
}

/** Sends the task's diff comments (from the Changes tab) on their own, as the composer would with nothing typed. */
export const sendComments = (task: Task, comments: LineComment[]) =>
  sendDraft(
    composerDraftKey(task),
    task,
    reviewMessage(comments),
    "",
    [],
    comments.map((c) => c.id),
  );

/** The composers showing each draft, to put text into. */
const composerFills = new Map<string, (text: string, files: AttachmentRef[]) => void>();

/**
 * After a rewind that took the conversation back: the message rewound to goes into the task's composer (ahead of
 * what's there), to edit and send again. Not the board's own messages (a review's issues, say).
 */
export function rewound(task: Task, r: RewindResult, conversation: boolean) {
  if (!conversation || r.message.auto || !r.message.text?.trim()) return;
  const { text, files } = splitAttachments(r.message.text.trim());
  const key = composerDraftKey(task);
  const fill = composerFills.get(key);
  if (fill) return fill(text, files);
  const d = loadComposerDraft(key);
  saveComposerDraft(key, d?.text.trim() ? `${text}\n\n${d.text}` : text, [...files, ...(d?.files ?? [])]);
}

export function Composer({ task, placeholder }: { task: Task; placeholder?: string }) {
  const draftKey = composerDraftKey(task);
  const [saved] = useState(() => loadComposerDraft(draftKey));
  const [text, setText] = useState(saved?.text ?? "");
  const [busy, setBusy] = useState(() => sending.has(draftKey));
  const [err, setErr] = useState<string | null>(null);
  const [unsaved, setUnsaved] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const modeControl = useModeControl(task);
  // Hosts before API 10 refuse messages while the agent is running.
  const host = useHost(task.host_id);
  const canQueue = hostSupports(host, 10);
  // A message goes to the running agent straight away, if its run takes them.
  const canSteer = runningAgentSteers(host, task);
  const blocked = task.running && !canQueue;
  const attach = useAttachmentDraft(task.host_id, hostSupports(host, 18), saved?.files);
  const skills = useSkillMenu(task, text, setText);
  // Comments on lines of the diff (the Changes tab's), which go with the message.
  const { comments } = useReview(task.host_id, task.id);
  // Saved as it's written. Files still uploading are left out until they're on the host.
  const draftJson = JSON.stringify({ text, files: attach.files });
  useEffect(() => {
    const { text, files } = JSON.parse(draftJson);
    setUnsaved(!saveComposerDraft(draftKey, text, files));
  }, [draftKey, draftJson]);
  // A send of this draft that ends, from this composer or one that was here before: only what was sent goes, and text
  // typed and files added while it was sending stay.
  const { drop } = attach;
  useEffect(() => {
    const watch = (end: SendEnd) => {
      setBusy(sending.has(draftKey));
      if ("error" in end) return setErr(end.error);
      setText((cur) => afterSent(cur, end.sent));
      drop(end.files);
    };
    const watchers = sendWatchers.get(draftKey) ?? new Set();
    watchers.add(watch);
    sendWatchers.set(draftKey, watchers);
    return () => {
      watchers.delete(watch);
      if (!watchers.size) sendWatchers.delete(draftKey);
    };
  }, [draftKey, drop]);

  const fitText = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = Math.min(el.scrollHeight, 260) + "px";
  };
  useLayoutEffect(fitText, [text]);
  // And when it gets wider or narrower, which wraps the text again (a phone turned round, say).
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let width = el.clientWidth;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      fitText();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // A rewound message to edit and send again (see `rewound`).
  const restore = useRef(attach.restore);
  restore.current = attach.restore;
  useEffect(() => {
    composerFills.set(draftKey, (fill, files) => {
      setText((cur) => (cur.trim() ? `${fill}\n\n${cur}` : fill));
      restore.current(files);
      ref.current?.focus();
    });
    return () => void composerFills.delete(draftKey);
  }, [draftKey]);

  const send = () => {
    const files = attach.files;
    const body = withAttachments(withComments(text, comments), files);
    if (blocked || busy || attach.uploading) return;
    if (!body && (task.session_id || task.running)) return;
    setBusy(true);
    setErr(null);
    void sendDraft(
      draftKey,
      task,
      body,
      text,
      files,
      comments.map((c) => c.id),
    );
  };

  /** Take the queued message back into the composer to edit it. */
  const unqueue = async () => {
    setErr(null);
    try {
      const { text: queued, files } = splitAttachments((await api.unqueue(task.host_id, task.id)).queued_message?.trim() ?? "");
      if (queued) setText((cur) => (cur.trim() ? `${queued}\n\n${cur}` : queued));
      attach.restore(files);
      ref.current?.focus();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const canStartEmpty = task.kind === "task" && !task.session_id && !task.running;
  return (
    <div className="shrink-0 px-5 pb-4 narrow:px-2 narrow:pb-2">
      <div className="mx-auto w-full max-w-3xl">
        <RewindNote task={task} />
        {(err || modeControl.err) && <div className="mb-2 text-xs text-red-400">{err || modeControl.err}</div>}
        {unsaved && (
          <div className="mb-2 text-xs text-amber-400">
            This browser couldn't save the draft (its storage may be full), so it's only kept until the page is closed or reloaded.
          </div>
        )}
        <div
          {...attach.dropProps}
          // Keeps the side panel open on a click outside it (see TaskPanel).
          data-draft={text.trim() !== "" || attach.items.length > 0 || undefined}
          className={clsx("rounded-2xl border border-line-strong bg-panel-2 focus-within:border-accent/50", attach.dragging && "border-accent! bg-accent/5")}
        >
          {task.steering?.map((s) => (
            <div key={s.id} className="flex items-start gap-2 border-b border-line py-2 pr-2 pl-4">
              <Loader2 size={12} className="mt-1 shrink-0 animate-spin text-faint" />
              <div className="min-w-0 flex-1">
                <QueuedMessage text={s.text} hostId={task.host_id} />
                <div className="mt-0.5 text-[11px] text-faint">
                  {s.from_agent ? "From another agent: " : "Sent: "}the agent reads it once it finishes its current step
                </div>
              </div>
            </div>
          ))}
          {task.queued_message && (
            <div className="flex items-start gap-2 border-b border-line py-2 pr-2 pl-4">
              <Clock size={12} className="mt-1 shrink-0 text-faint" />
              <div className="min-w-0 flex-1">
                <QueuedMessage text={task.queued_message} hostId={task.host_id} />
                <div className="mt-0.5 text-[11px] text-faint">
                  {task.running
                    ? "Queued: sends when the agent finishes, or press Stop to send it now"
                    : dependencyQueued(task)
                      ? "Queued: sends when the agent starts, once the tasks it depends on are merged"
                      : "Queued: sends with the next message"}
                </div>
              </div>
              <button
                onClick={unqueue}
                title="Unqueue and edit"
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-faint hover:bg-white/5 hover:text-fg"
              >
                <X size={13} />
              </button>
            </div>
          )}
          {comments.length > 0 && <ComposerComments task={task} comments={comments} />}
          <SkillMenu menu={skills} />
          {skills.hint && <SkillHint item={skills.hint} />}
          <textarea
            ref={ref}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onPaste={attach.onPaste}
            onKeyDown={(e) => {
              if (skills.onKeyDown(e)) return;
              if (e.key === "Tab" && e.shiftKey) {
                e.preventDefault();
                modeControl.cycle();
                return;
              }
              // On a touch screen's keyboard Enter starts a new line, and the send button sends (as Ctrl/Cmd+Enter does).
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && (!matchMedia(TOUCH_QUERY).matches || e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                send();
              }
            }}
            rows={1}
            placeholder={
              comments.length && !blocked
                ? `Add a message to the comment${comments.length === 1 ? "" : "s"}, or press Enter to send ${comments.length === 1 ? "it" : "them"}…`
                : task.running
                ? canQueue
                  ? task.queued_message
                    ? "Add to the queued message…"
                    : canSteer
                      ? "Message the agent: it reads it after its current step…"
                      : "Queue a message for when the agent finishes…"
                  : "Agent is working…"
                : dependencyQueued(task)
                  ? "Queue a message for when its agent starts…"
                  : (placeholder ?? (canStartEmpty ? "Add extra instructions, or press Enter to start" : "Reply to the agent…"))
            }
            className="block max-h-[260px] w-full resize-none bg-transparent px-4 pt-3 pb-1 text-[13.5px] text-fg placeholder:text-faint outline-none"
          />
          <DraftAttachments draft={attach} hostId={task.host_id} className="px-4 pt-1 pb-2" />
          <div className="flex items-center gap-2 px-3 pb-2">
            <ModeSelect control={modeControl} running={task.running} />
            <span className="text-[11px] text-faint narrow:min-w-0 narrow:truncate">
              {task.session_id ? `session ${task.session_id.slice(0, 8)}` : "new session"}
              {task.model ? ` · ${task.model}` : ""}
              {task.effort ? ` · ${task.effort} effort` : ""}
            </span>
            <div className="ml-auto flex items-center gap-1.5">
              <AttachButton draft={attach} />
              {task.running && canQueue && (text.trim() || attach.items.length > 0 || comments.length > 0) && (
                <button
                  onClick={send}
                  disabled={busy || attach.uploading}
                  title={canSteer && !task.queued_message ? "Send to the agent now (Enter)" : "Queue (Enter)"}
                  className="flex h-7 w-7 items-center justify-center rounded-full bg-accent-strong text-white hover:bg-accent disabled:bg-white/10 disabled:text-faint narrow:h-9 narrow:w-9"
                >
                  {busy ? <Loader2 size={14} className="animate-spin" /> : <ArrowUp size={15} />}
                </button>
              )}
              {task.running ? (
                <button
                  onClick={() => {
                    setErr(null);
                    api.stop(task.host_id, task.id).catch((e) => setErr(`Couldn't stop the agent: ${(e as Error).message}`));
                  }}
                  title={stopTitle(task, canSteer)}
                  className="flex h-7 w-7 items-center justify-center rounded-full bg-white/10 text-fg hover:bg-white/15 narrow:h-9 narrow:w-9"
                >
                  <Square size={11} fill="currentColor" />
                </button>
              ) : (
                <button
                  onClick={send}
                  disabled={busy || attach.uploading || (!text.trim() && !attach.items.length && !comments.length && !canStartEmpty)}
                  title="Send (Enter)"
                  className="flex h-7 w-7 items-center justify-center rounded-full bg-accent-strong text-white hover:bg-accent disabled:bg-white/10 disabled:text-faint narrow:h-9 narrow:w-9"
                >
                  {busy ? <Loader2 size={14} className="animate-spin" /> : <ArrowUp size={15} />}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
