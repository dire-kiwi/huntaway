import clsx from "clsx";
import { Bot, Brain, Check, ChevronRight, CircleAlert, Clock, Layers, ShieldQuestion } from "lucide-react";
import { memo, useState, type ReactNode } from "react";
import { api } from "../../../api";
import { useSubagentView, subagentTitle } from "../../../subagents";
import { QUESTION_TOOLS, questionsOf } from "../../../questions";
import { Button } from "../../ui";
import { AskCard, BoardQuestionCard, PlanCard } from "../Questions";
import { useThread } from "./context";
import { Markdown } from "./Markdown";
import { CodeBlock, toolMeta, ToolInput } from "./tools";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

export function Collapsible({ label, icon, text }: { label: string; icon: ReactNode; text: string }) {
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

export function Thinking({ text }: { text: string }) {
  return <Collapsible label="Thinking" icon={<Brain size={13} />} text={text} />;
}

export function EventLine({ level, text, detail }: { level: string; text: string; detail?: string | null }) {
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
export function QuestionRow({ id, data, hostId }: { id: number; data: Any; hostId: string }) {
  const taskId = useThread((t) => t.taskId);
  const movedOn = useThread((t) => t.lastSent > id);
  return <BoardQuestionCard id={id} data={data} hostId={hostId} taskId={taskId} movedOn={movedOn} />;
}

/** A permission prompt: a question or a plan gets its own card. */
export function PromptCard({ id, data, hostId }: { id: number; data: Any; hostId: string }) {
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
      <PromptRule data={data} pending={pending} />
      {pending && (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" variant="primary" disabled={busy} onClick={() => decide("allow")} className="narrow:px-4">
            <Check size={13} /> Allow
          </Button>
          {/* What an approval rule asks about is asked each time (API 101). */}
          {!data.rule && (
            <Button size="sm" disabled={busy} onClick={() => decide("allow_always")} className="narrow:order-last narrow:h-auto narrow:min-h-9 narrow:py-1.5 narrow:break-all narrow:whitespace-normal">
              Always allow {data.tool_name} for this thread
            </Button>
          )}
          <Button size="sm" variant="danger" disabled={busy} onClick={() => decide("deny")} className="narrow:px-4">
            Deny
          </Button>
          {err && <span className="self-center text-xs text-red-400">{err}</span>}
        </div>
      )}
    </div>
  );
});

/** Why a prompt asks (an approval rule, API 101), and when one from a routine run is denied if nobody answers it. */
function PromptRule({ data, pending }: { data: Any; pending: boolean }) {
  const expires = typeof data.expires_at === "string" ? new Date(data.expires_at) : null;
  if (!data.rule && !expires) return null;
  const at = expires?.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return (
    <div className="mt-2 space-y-0.5 text-[11.5px] text-muted">
      {data.rule && (
        <div>
          Your approval rule <span className="font-mono">{data.rule.tool}</span> asks first, whatever the thread's mode.
        </div>
      )}
      {expires && pending && (
        <div className="flex items-center gap-1">
          <Clock size={11} /> From a routine run: denied at {at} if nobody answers, and the agent carries on without it.
        </div>
      )}
      {expires && data.status === "expired" && data.note && <div>Nobody answered in time, so it was denied.</div>}
    </div>
  );
}

function tokens(n: number) {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export function CompactLine({ meta, summary, result }: { meta: Any; summary?: string; result?: Any }) {
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

export function ResultLine({ data }: { data: Any }) {
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
