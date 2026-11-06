// The Routines tab of a profile's assistant (API 110): its profile's automations that wake it, each with its next run,
// its last result (quiet, reported, skipped and why), what it's cost, and Run now, pause and edit.
import clsx from "clsx";
import { ChevronDown, ChevronRight, Clock, Play, Plus, Trash2, Webhook } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api, type Automation, type Task } from "../../api";
import { openTask } from "../../router";
import { useShallow } from "zustand/react/shallow";
import { onAutomationsChanged, useStore } from "../../store";
import { activeText, AutomationEditor, localTime, RunHistory, RunStatus, timeUntil, triggerText, usd, type TimeZone } from "../settings/Automations";
import { Button, timeAgo, Toggle, useConfirm } from "../ui";

/** The assistant's routines: `assistant` is the profile's assistant, whose host and profile they're on. */
export function Routines({ assistant }: { assistant: Task }) {
  const { host_id: hostId, profile_id: profileId } = assistant;
  const [list, setList] = useState<Automation[] | null>(null);
  const [tz, setTz] = useState<TimeZone | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<Automation | "new" | null>(null);
  const reload = useCallback(
    () =>
      api.routines(hostId, profileId).then(
        (r) => {
          setList(r.automations);
          setTz(r.time_zone);
          setErr(null);
        },
        (e) => setErr((e as Error).message),
      ),
    [hostId, profileId],
  );
  useEffect(() => {
    reload();
    return onAutomationsChanged((h, projectId, _id, profile) => {
      if (h === hostId && !projectId && (!profile || profile === profileId)) reload();
    });
  }, [reload, hostId, profileId]);
  const confirm = useConfirm();
  const run = async (fn: () => Promise<unknown>) => {
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr((e as Error).message);
    }
    await reload();
  };
  return (
    <div className="h-full overflow-y-auto" data-testid="routines">
      <div className="mx-auto max-w-3xl space-y-3 px-5 py-5">
        <div className="flex items-center gap-3">
          <p className="flex-1 text-[12.5px] text-muted">
            Routines wake your assistant on a schedule or a webhook. By default each run works in a thread of its own and posts a report here, or
            stays quiet when there's nothing new. Ask the assistant to set one up, or add one yourself.
          </p>
          <Button size="sm" onClick={() => setEditing("new")}>
            <Plus size={13} /> New routine
          </Button>
        </div>
        {list && list.length > 0 && (
          <div className="divide-y divide-line/70 rounded-md border border-line/70">
            {list.map((a) => (
              <RoutineRow
                key={a.id}
                routine={a}
                hostId={hostId}
                tz={tz}
                onToggle={(enabled) => run(() => api.updateAutomation(hostId, a.id, { enabled }))}
                onEdit={() => setEditing(a)}
                onRun={() => run(() => api.runAutomation(hostId, a.id))}
                onDelete={() =>
                  confirm.ask({
                    title: `Delete routine ${a.name}`,
                    body: `Delete the routine "${a.name}"? Its run history goes with it; its reports stay in the thread.`,
                    action: "Delete routine",
                    danger: true,
                    onConfirm: () => api.deleteAutomation(hostId, a.id).then(reload),
                  })
                }
              />
            ))}
          </div>
        )}
        <LeftBehind assistant={assistant} />
        {list && !list.length && <div className="text-[12px] text-faint">No routines yet. Try asking the assistant: "Every weekday at 8, check my inbox."</div>}
        {err && <div className="text-xs text-red-400">{err}</div>}
        {confirm.dialog}
        {editing && (
          <AutomationEditor owner={{ hostId, profileId }} automation={editing === "new" ? null : editing} tz={tz} onSaved={reload} onClose={() => setEditing(null)} />
        )}
      </div>
    </div>
  );
}

/** The routines this board's own host still has for the profile, which don't run while its assistant is on another host
 *  (`assistant_host`, HA-241): that host's routines are its own, here. Each can be deleted from here, since the board no
 *  longer opens the assistant they'd wake. */
function LeftBehind({ assistant }: { assistant: Task }) {
  const { host_id: hostId, profile_id: profileId } = assistant;
  // The board's own profile of the assistant's name, if it sends its assistant to this host.
  const [boardHost, boardHostName, boardProfile, hostName] = useStore(
    useShallow((s) => {
      const local = s.hosts.find((h) => h.local);
      const name = s.profiles.find((p) => p.host_id === hostId && p.id === profileId)?.name;
      const p = local && local.id !== hostId ? s.profiles.find((p) => p.host_id === local.id && p.name === name && p.assistant_host === hostId) : undefined;
      return [local?.id, local?.name, p?.id, s.hosts.find((h) => h.id === hostId)?.name ?? hostId];
    }),
  );
  const [list, setList] = useState<Automation[]>([]);
  const [tz, setTz] = useState<TimeZone | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const reload = useCallback(() => {
    if (!boardHost || !boardProfile) return void setList([]);
    api.routines(boardHost, boardProfile).then(
      (r) => (setList(r.automations), setTz(r.time_zone)),
      () => setList([]),
    );
  }, [boardHost, boardProfile]);
  useEffect(() => {
    reload();
    return onAutomationsChanged((h, projectId, _id, profile) => {
      if (h === boardHost && !projectId && (!profile || profile === boardProfile)) reload();
    });
  }, [reload, boardHost, boardProfile]);
  const confirm = useConfirm();
  if (!boardHost || !list.length) return null;
  return (
    <div className="space-y-1.5 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2" data-testid="routines-left-behind">
      <p className="text-[12px] text-muted">
        {list.length === 1 ? "This routine stays" : `These ${list.length} routines stay`} on {boardHostName}, where your assistant ran before, and{" "}
        {list.length === 1 ? "doesn't" : "don't"} run while it's on {hostName}. Add the ones you want again here, and delete them there.
      </p>
      {list.map((a) => (
        <div key={a.id} className="flex items-center gap-3 text-[12.5px]" data-testid="routine-left-behind">
          <span className="min-w-0 flex-1 truncate">
            <span className="font-medium">{a.name}</span> <span className="text-faint">· {triggerText(a.trigger, tz)}</span>
          </span>
          <Button
            size="sm"
            variant="ghost"
            title={`Delete it on ${boardHostName}`}
            onClick={() =>
              confirm.ask({
                title: `Delete routine ${a.name}`,
                body: `Delete the routine "${a.name}" on ${boardHostName}? Its run history goes with it.`,
                action: "Delete routine",
                danger: true,
                onConfirm: () =>
                  api.deleteAutomation(boardHost, a.id).then(reload, (e: Error) => {
                    setErr(e.message);
                  }),
              })
            }
          >
            <Trash2 size={13} />
          </Button>
        </div>
      ))}
      {err && <div className="text-xs text-red-400">{err}</div>}
      {confirm.dialog}
    </div>
  );
}

function RoutineRow({
  routine: a,
  hostId,
  tz,
  onToggle,
  onEdit,
  onRun,
  onDelete,
}: {
  routine: Automation;
  hostId: string;
  tz: TimeZone | null;
  onToggle: (enabled: boolean) => void;
  onEdit: () => void;
  onRun: () => Promise<void>;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const last = a.last_run;
  const mode = a.action.kind === "message_assistant" && a.action.mode === "thread" ? "in the assistant's thread" : "in a fresh thread";
  const guards = [a.active_hours && `active ${activeText(a.active_hours)}`, a.precheck && "with a precheck"].filter(Boolean).join(", ");
  return (
    <div className="px-3 py-2" data-testid="routine">
      <div className="flex items-center gap-3">
        <Toggle checked={a.enabled} onChange={onToggle} label="" />
        <button type="button" className="min-w-0 flex-1 text-left" onClick={onEdit}>
          <div className={clsx("flex items-center gap-1.5 text-[13px]", !a.enabled && "text-faint")}>
            {a.trigger.kind === "webhook" ? <Webhook size={13} className="shrink-0 text-muted" /> : <Clock size={13} className="shrink-0 text-muted" />}
            <span className="truncate font-medium">{a.name}</span>
          </div>
          <div className="truncate text-[11.5px] text-faint">
            {triggerText(a.trigger, tz)} · {mode}
            {guards && ` · ${guards}`}
          </div>
        </button>
        <span className="shrink-0 text-right text-[11.5px] text-faint" title="What its runs cost today, and all its runs kept">
          {usd(a.cost_today_usd ?? 0)} today{a.budget_usd ? ` of ${usd(a.budget_usd)}` : ""}
          <br />
          {usd(a.cost_usd ?? 0)} in all
        </span>
        <Button
          size="sm"
          variant="ghost"
          disabled={running}
          title={a.trigger.kind === "webhook" ? "Run it now, with an empty delivery" : "Run it now, whether or not it's on"}
          onClick={async () => {
            setRunning(true);
            try {
              await onRun();
            } finally {
              setRunning(false);
            }
          }}
        >
          <Play size={12} /> Run now
        </Button>
        <Button size="sm" variant="ghost" onClick={onEdit}>
          Edit
        </Button>
        <Button size="sm" variant="ghost" onClick={onDelete} title="Delete">
          <Trash2 size={13} />
        </Button>
      </div>
      <button type="button" onClick={() => setOpen(!open)} className="mt-1 flex w-full min-w-0 items-center gap-1.5 text-left text-[11.5px] text-faint hover:text-muted">
        {open ? <ChevronDown size={12} className="shrink-0" /> : <ChevronRight size={12} className="shrink-0" />}
        {last ? (
          <>
            <span className="shrink-0">Last {timeAgo(last.created_at)}:</span>
            <RunStatus run={last} />
            {last.status !== "ok" && last.detail && <span className="truncate">{last.detail.replace(/^Skipped: /, "")}</span>}
            {last.task && (
              <span
                role="link"
                className="truncate font-mono hover:text-fg hover:underline"
                onClick={(e) => {
                  e.stopPropagation();
                  openTask(last.task_id!);
                }}
              >
                {last.task.key}
              </span>
            )}
          </>
        ) : (
          <span>{a.trigger.kind === "webhook" ? "No deliveries yet" : "Hasn't run yet"}</span>
        )}
        {a.enabled && a.next_run_at && (
          <span className="ml-auto shrink-0" title={new Date(a.next_run_at).toLocaleString()}>
            Next {timeUntil(a.next_run_at)} ({localTime(a.next_run_at)})
          </span>
        )}
        {!a.enabled && <span className="ml-auto shrink-0">Paused</span>}
      </button>
      {open && <RunHistory hostId={hostId} automation={a} />}
    </div>
  );
}
