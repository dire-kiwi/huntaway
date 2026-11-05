import clsx from "clsx";
import { useEffect, useState } from "react";
import { navigate } from "../../router";
import { api, type ApprovalAction, type Task } from "../../api";
import { onApprovalRules, useStore } from "../../store";
import { Ago } from "../ui";

const OUTCOME_STYLE: Record<ApprovalAction["outcome"], string> = {
  pending: "bg-st-attention/10 text-st-attention",
  allowed: "bg-emerald-500/10 text-emerald-300",
  denied: "bg-red-500/10 text-red-300",
  expired: "bg-white/5 text-muted",
  blocked: "bg-red-500/10 text-red-300",
};

const BY: Record<string, string> = {
  user: "you, on the board",
  push: "you, from a notification",
  mode: "Don't ask mode",
  rule: "a never rule",
};

/** Why a prompt expired, by what settled it (not someone who answered it, so not "Expired by …"). */
const EXPIRED_BY: Record<string, string> = {
  expiry: "Expired: nobody answered it in time",
  ended: "Expired: its run ended first",
};

/** What an entry came to, in words. */
function outcomeText(a: ApprovalAction) {
  if (a.outcome === "pending") return "Waiting for your answer";
  if (a.outcome === "blocked") return "Blocked by a never rule";
  if (a.outcome === "expired") return (a.answered_by && EXPIRED_BY[a.answered_by]) || "Expired";
  return a.answered_by ? `${a.outcome[0].toUpperCase()}${a.outcome.slice(1)} by ${BY[a.answered_by] ?? a.answered_by}` : a.outcome;
}

/**
 * The assistant's Actions tab (API 115): every call its rules asked about or turned away, newest first, with what it was
 * called with, how it ended and who answered. It follows the log as it changes.
 */
export function ActionLog({ task }: { task: Task }) {
  const [log, setLog] = useState<ApprovalAction[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const tasks = useStore((s) => s.tasks);
  useEffect(() => {
    let live = true;
    const load = () =>
      api.approvalLog(task.host_id, task.profile_id).then(
        (l) => live && (setLog(l), setError(null)),
        (e: Error) => live && setError(e.message),
      );
    load();
    const off = onApprovalRules((h, p, what) => {
      if (h === task.host_id && p === task.profile_id && what === "log") load();
    });
    return () => {
      live = false;
      off();
    };
  }, [task.host_id, task.profile_id]);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-5 py-5">
        <p className="mb-3 text-[12.5px] text-muted">
          The calls the assistant's approval rules asked you about or turned away (see Rules in its details), newest first.
        </p>
        {error && <div className="text-[12.5px] text-red-400">Couldn't load the log: {error}</div>}
        {!log && !error && <div className="text-[12.5px] text-faint">Loading…</div>}
        {log?.length === 0 && (
          <div className="rounded-xl border border-dashed border-line p-6 text-center text-[13px] text-muted">
            Nothing yet: calls that a rule asks about or blocks are listed here.
          </div>
        )}
        <ul className="space-y-1.5" aria-label="Action log">
          {log?.map((a) => {
            const other = a.task_id !== task.id ? tasks[a.task_id] : undefined;
            return (
              <li key={a.id} className="rounded-lg border border-line bg-panel/60 px-3 py-2 text-[12.5px]">
                <div className="flex items-center gap-2">
                  <span className="min-w-0 truncate font-mono text-fg">{a.tool_name}</span>
                  <span className={clsx("ml-auto shrink-0 rounded px-1.5 py-0.5 text-[11px]", OUTCOME_STYLE[a.outcome])}>{a.outcome}</span>
                </div>
                {a.summary && <div className="mt-0.5 truncate font-mono text-[11.5px] text-muted" title={a.summary}>{a.summary}</div>}
                <div className="mt-1 flex flex-wrap gap-x-3 text-[11.5px] text-faint">
                  <span>{outcomeText(a)}</span>
                  <span>
                    rule <span className="font-mono">{a.rule}</span> ({a.decision})
                  </span>
                  {other && (
                    <button onClick={() => navigate(`/t/${other.id}`)} className="hover:text-muted">
                      in {other.title}
                    </button>
                  )}
                  <span className="ml-auto">
                    <Ago at={a.created_at} />
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
