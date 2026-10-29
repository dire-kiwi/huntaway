import clsx from "clsx";
import { Bot, ChevronDown, Loader2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Message, Task } from "../api";
import { useStore, useThreadMessages } from "../store";
import { subagentTitle, useSubagentView } from "../subagents";
import { threadModel } from "../threadModel";
import { SubagentStatusBadge } from "./Thread";

const NO_MESSAGES: Message[] = [];

/** Running/finished counts of the thread's subagents; opens a list that shows each one's own thread. */
export function AgentsPill({ task, onReveal, className }: { task: Task; onReveal?: () => void; className?: string }) {
  // The thread's own (built once for both), kept while the pill shows, but only loaded by the thread.
  const messages = useThreadMessages(task.id, false);
  // With those started before the loaded part of a long thread (the same as the thread's, for the same model).
  const earlier = useStore((s) => s.threads[task.id]?.subagents);
  const model = threadModel(task.id, messages ?? NO_MESSAGES, task.running, earlier);
  const subagents = useMemo(() => [...model.subagents.values()], [model.subagents]);
  const viewing = useSubagentView((s) => s.open[task.id]);
  const show = useSubagentView((s) => s.show);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

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

  if (subagents.length === 0) return null;
  const running = subagents.filter((s) => s.status === "running").length;
  const settled = subagents.length - running;
  // Newest first, running ones on top.
  const list = [...subagents].reverse().sort((a, b) => Number(b.status === "running") - Number(a.status === "running"));

  return (
    <div ref={root} className={clsx("relative", className)}>
      <button
        onClick={() => setOpen(!open)}
        title="Subagents in this thread"
        className={clsx(
          "flex h-7 items-center gap-1.5 rounded-lg border px-2 text-[12px] hover:bg-white/5",
          running ? "border-st-progress/40 text-fg" : "border-line text-muted",
        )}
      >
        {running ? <Loader2 size={12} className="animate-spin text-st-progress" /> : <Bot size={13} />}
        Agents
        <span className="text-faint">
          {running > 0 && `${running} running`}
          {running > 0 && settled > 0 && " · "}
          {settled > 0 && `${settled} done`}
        </span>
        <ChevronDown size={11} className="text-faint" />
      </button>
      {open && (
        <div className="absolute top-full right-0 z-30 mt-1.5 max-h-96 w-96 overflow-y-auto rounded-lg border border-line-strong bg-panel-2 p-1 shadow-xl">
          {list.map((s) => (
            <button
              key={s.id}
              onClick={() => {
                setOpen(false);
                onReveal?.();
                show(task.id, s.id);
              }}
              className={clsx("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-white/5", viewing === s.id && "bg-white/5")}
            >
              <Bot size={13} className="shrink-0 text-muted" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12.5px] text-fg">{subagentTitle(s)}</span>
                <span className="block truncate text-[11px] text-faint">
                  {[s.agentType, s.model, s.status === "running" ? s.activity : null].filter(Boolean).join(" · ")}
                </span>
              </span>
              <SubagentStatusBadge s={s} compact />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
