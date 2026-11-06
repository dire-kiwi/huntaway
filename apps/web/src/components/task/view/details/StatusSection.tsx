import clsx from "clsx";
import { useEffect, useState } from "react";
import {
  api,
  canRunAgents,
  dependencyQueued,
  hostStatuses,
  hostSupports,
  limitQueued,
  mergeAwaitsApproval,
  mergeQueued,
  outOfUsage,
  rejoinsMerge,
  type Host,
  type Resolution,
  type Status,
  type Task,
} from "../../../../api";
import { resetsPhrase, resetTime } from "../../../../usageConfigs";
import { saveMarks } from "../../Reminders";
import { MoreFixRounds } from "../../Review";
import { Button, RESOLUTION_LABELS, RunningDot, StatusIcon } from "../../../ui";
import { useThreadConfig } from "../hooks";
import { Section } from "./Section";

/** The task's status, to move it on, with what it's waiting for. `confirmDone` asks before it's moved to Done. */
export function StatusSection({ task, host, confirmDone }: { task: Task; host: Host | undefined; confirmDone: (task: Task) => Promise<boolean> }) {
  const [err, setErr] = useState<string | null>(null);
  const setStatus = async (status: Status) => {
    setErr(null);
    if (status === "done" && !(await confirmDone(task))) return;
    try {
      await api.updateTask(task.host_id, task.id, { status });
      // Into "In progress" from the list, as from a drop on the board: a fresh task's agent starts (where one can run).
      if (status === "in_progress" && task.status !== "in_progress" && !task.session_id && !task.running && canRunAgents(host)) {
        await api.send(task.host_id, task.id, "");
      }
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const setResolution = (resolution: Resolution) => {
    setErr(null);
    api.updateTask(task.host_id, task.id, { resolution }).catch((e) => setErr(e.message));
  };
  return (
    <Section title="Status">
      <div className="grid grid-cols-1 gap-0.5">
        {hostStatuses(host).map((s) => (
          <button
            key={s.id}
            onClick={() => setStatus(s.id)}
            className={clsx(
              "flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px]",
              task.status === s.id ? "bg-raised text-fg" : "text-muted hover:bg-white/[0.03] hover:text-fg",
            )}
          >
            <StatusIcon status={s.id} size={13} /> {s.label}
            {task.status === s.id && task.running && <RunningDot className="ml-auto" />}
          </button>
        ))}
      </div>
      {task.status === "done" && hostSupports(host, 19) && (
        <div className="mt-2 flex items-center gap-2 text-[12px]">
          <span className="text-faint">Resolution</span>
          <div className="ml-auto flex items-center rounded-md border border-line p-0.5">
            {(Object.keys(RESOLUTION_LABELS) as Resolution[]).map((r) => (
              <button
                key={r}
                onClick={() => setResolution(r)}
                className={clsx(
                  "inline-flex h-6 items-center rounded px-2 text-xs font-medium transition-colors",
                  (task.resolution ?? "done") === r ? "bg-raised text-fg" : "text-muted hover:text-fg",
                )}
              >
                {RESOLUTION_LABELS[r]}
              </button>
            ))}
          </div>
        </div>
      )}
      {mergeQueued(task) && (
        <div className="mt-2 rounded-md bg-white/[0.03] px-2.5 py-2 text-[12px] text-muted">
          Queued to merge. Another task in this project is merging; this one starts when it's done.
        </div>
      )}
      {mergeAwaitsApproval(task) && (
        <div className="mt-2 rounded-md bg-white/[0.03] px-2.5 py-2 text-[12px] text-muted">
          {task.running
            ? "The merge waits for your approval. Its agent is summarizing what will be merged; then you're asked to approve or deny it in its thread."
            : "The merge waits for your approval: approve or deny it in its thread. Its agent can't merge until you approve."}
        </div>
      )}
      {rejoinsMerge(task) && (
        <div className="mt-2 rounded-md bg-white/[0.03] px-2.5 py-2 text-[12px] text-muted">
          Stepped out of the merge queue to make changes, so the tasks behind it could merge. It rejoins the end of the queue when its agent is done, unless you
          move it to another column first.
        </div>
      )}
      {dependencyQueued(task) && (
        <div className="mt-2 rounded-md bg-white/[0.03] px-2.5 py-2 text-[12px] text-muted">
          Queued. Its agent starts once the tasks it depends on are merged.
        </div>
      )}
      {task.attention_reason && <div className="mt-2 rounded-md bg-st-attention/[0.08] px-2.5 py-2 text-[12px] text-amber-200/90">{task.attention_reason}</div>}
      {task.status === "needs_attention" && <MoreFixRounds task={task} className="mt-2" />}
      <UsageLimitNote task={task} onError={(e) => setErr(e)} />
      {task.remind_at && (
        <div className="mt-2 flex items-start gap-2 rounded-md bg-white/[0.03] px-2.5 py-2 text-[12px] text-muted">
          <span className="min-w-0 flex-1">
            Reminder {new Date(task.remind_at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}
            {task.reminder && <span className="block text-fg">{task.reminder}</span>}
          </span>
          <button className="shrink-0 text-faint hover:text-fg" onClick={() => saveMarks(task, { remind_at: null }).catch((e) => setErr((e as Error).message))}>
            Clear
          </button>
        </div>
      )}
      {err && <div className="mt-2 rounded bg-red-500/10 p-2 text-[11.5px] whitespace-pre-wrap text-red-300">{err}</div>}
    </Section>
  );
}

/**
 * A task held until its config's usage limit resets, or one whose agent ran out of usage, which can wait for the reset
 * (API 81). After the reset, sending a message carries on.
 */
function UsageLimitNote({ task, onError }: { task: Task; onError: (e: string | null) => void }) {
  const { current } = useThreadConfig(task);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const at = task.limit_reset_at;
  useEffect(() => {
    if (!at) return;
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(tick);
  }, [at]);
  if (!at) return null;
  const name = current?.name ?? "Its config";
  const when = `${resetsPhrase(at, now)} (${resetTime(at)})`;
  if (limitQueued(task)) {
    return (
      <div className="mt-2 rounded-md bg-white/[0.03] px-2.5 py-2 text-[12px] text-muted" data-usage-limit="waiting">
        Waiting for {name}'s usage limit to reset: it {when}. Its agent carries on then, with any message you queue.
      </div>
    );
  }
  if (!outOfUsage(task, now)) return null;
  const wait = async () => {
    setBusy(true);
    onError(null);
    try {
      await api.waitForLimit(task.host_id, task.id);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-2 flex items-start gap-2 rounded-md bg-white/[0.03] px-2.5 py-2 text-[12px] text-muted" data-usage-limit="out">
      <span className="min-w-0 flex-1">
        {name} is out of usage; it {when}.{/* Waiting in In progress would give up its merge slot, so another merge could start alongside it. */}
        {task.merging && " Its merge keeps its place in the merge queue: message its agent once it has reset to carry on."}
      </span>
      {!task.merging && (
        <Button
          size="sm"
          variant="ghost"
          className="-my-1 shrink-0"
          disabled={busy}
          onClick={wait}
          title="Wait in In progress, and carry on once the limit resets"
        >
          Carry on then
        </Button>
      )}
    </div>
  );
}
