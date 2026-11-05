import { Check, Map as MapIcon, MessageCircleQuestion, ShieldQuestion, X } from "lucide-react";
import { useState } from "react";
import { api, ownWorkDir, type Task } from "../../api";
import { openTask } from "../../router";
import { type Item } from "../../threadModel";
import { useThreadModel } from "../../threadView";
import { QUESTION_TOOLS, questionsOf } from "../../questions";
import { toolMeta } from "../task/thread/tools";
import { AskCard, BoardQuestionCard, PlanCard } from "../task/Questions";

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
  // From its items or its messages, as its thread is drawn (an items task has no messages since it moved onto them).
  const model = useThreadModel(task, true);
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

