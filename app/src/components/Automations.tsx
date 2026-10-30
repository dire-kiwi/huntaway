import clsx from "clsx";
import { ChevronDown, ChevronRight, Clock, Copy, Play, Plus, RefreshCw, Trash2, Webhook, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  api,
  EFFORTS,
  FILTER_OPS,
  MODEL_ALIASES,
  WEEKDAYS,
  type Automation,
  type AutomationFilter,
  type AutomationInput,
  type AutomationRun,
  type AutomationRunStatus,
  type AutomationTrigger,
  type FilterOp,
  type Project,
  type TaskType,
  type Weekday,
} from "../api";
import { openTask } from "../router";
import { onAutomationsChanged, useAvailableConfigs, useHost, useStore } from "../store";
import { Button, copyText, Field, IconButton, Input, Modal, SUBMIT_KEYS, Textarea, Toggle, timeAgo } from "./ui";

type TimeZone = { name: string | null; offset: string };

const DAY_LABELS: Record<Weekday, string> = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };

const OP_LABELS: Record<FilterOp, string> = {
  equals: "is",
  not_equals: "isn't",
  starts_with: "starts with",
  contains: "contains",
  in: "is one of",
  not_in: "isn't any of",
  exists: "is set",
  not_exists: "isn't set",
};

/** The filters the form has fields of their own for: the event, action and labels being one of a list. */
const SIMPLE_FILTERS = ["event", "action", "labels"] as const;

const STATUS_STYLE: Record<AutomationRunStatus, string> = {
  ok: "text-emerald-400",
  failed: "text-red-400",
  rejected: "text-red-400",
  running: "text-st-progress",
  pending: "text-st-progress",
  coalesced: "text-muted",
  skipped: "text-st-attention",
  filtered: "text-faint",
  duplicate: "text-faint",
};

const STATUS_LABEL: Record<AutomationRunStatus, string> = {
  ok: "Ran",
  failed: "Failed",
  rejected: "Rejected",
  running: "Running",
  pending: "Waiting to coalesce",
  coalesced: "Coalesced",
  skipped: "Skipped",
  filtered: "Filtered out",
  duplicate: "Duplicate",
};

const SOURCE_LABEL: Record<AutomationRun["source"], string> = { schedule: "Schedule", webhook: "Webhook", manual: "Run now" };

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function everyText(minutes: number) {
  if (minutes % 1440 === 0) return minutes === 1440 ? "Every day" : `Every ${plural(minutes / 1440, "day")}`;
  if (minutes % 60 === 0) return minutes === 60 ? "Every hour" : `Every ${plural(minutes / 60, "hour")}`;
  return `Every ${plural(minutes, "minute")}`;
}

function daysText(days: Weekday[]) {
  if (!days.length || days.length === 7) return "every day";
  const key = days.join(",");
  if (key === "mon,tue,wed,thu,fri") return "weekdays";
  if (key === "sat,sun") return "weekends";
  return days.map((d) => DAY_LABELS[d]).join(", ");
}

export function filterText(f: AutomationFilter) {
  const value = Array.isArray(f.value) ? f.value.join(", ") : (f.value ?? "");
  return f.op === "exists" || f.op === "not_exists" ? `${f.path} ${OP_LABELS[f.op]}` : `${f.path} ${OP_LABELS[f.op]} ${value}`;
}

/** What starts an automation, e.g. "Every hour" or "At 09:00 on weekdays (Pacific/Auckland)". */
export function triggerText(t: AutomationTrigger, tz: TimeZone | null) {
  if (t.kind === "interval") return everyText(t.every_minutes);
  if (t.kind === "daily") return `At ${t.time} on ${daysText(t.weekdays)}${tz?.name ? ` (${tz.name})` : ""}`;
  const parts = ["Webhook"];
  if (t.filters.length) parts.push(`when ${t.filters.map(filterText).join(" and ")}`);
  if (t.coalesce_seconds) parts.push(`coalescing ${t.coalesce_seconds}s`);
  return parts.join(", ");
}

/** "in 5m", "in 3h": how long until a time. */
function timeUntil(iso: string) {
  const s = Math.max(0, (new Date(iso).getTime() - Date.now()) / 1000);
  if (s < 60) return "in under a minute";
  if (s < 3600) return `in ${Math.round(s / 60)}m`;
  if (s < 86400 * 2) return `in ${Math.round(s / 3600)}h`;
  return `in ${Math.round(s / 86400)}d`;
}

const localTime = (iso: string) => new Date(iso).toLocaleString([], { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/** A project's automations: tasks created, or messages sent to a task, on a schedule or from a webhook. */
export function ProjectAutomations({ project }: { project: Project }) {
  const hostId = project.host_id;
  const [list, setList] = useState<Automation[] | null>(null);
  const [tz, setTz] = useState<TimeZone | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<Automation | "new" | null>(null);
  const [testing, setTesting] = useState<Automation | null>(null);
  const reload = useCallback(
    () =>
      api.automations(hostId, project.id).then(
        (r) => {
          setList(r.automations);
          setTz(r.time_zone);
          setErr(null);
        },
        (e) => setErr((e as Error).message),
      ),
    [hostId, project.id],
  );
  useEffect(() => {
    reload();
    return onAutomationsChanged((h, pid) => {
      if (h === hostId && pid === project.id) reload();
    });
  }, [reload, hostId, project.id]);
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
    <div className="space-y-3 rounded-xl border border-line p-4" data-testid="automations">
      <div className="flex items-center justify-between gap-3">
        <div className="text-[13px] font-medium">Automations</div>
        <Button size="sm" onClick={() => setEditing("new")}>
          <Plus size={13} /> New automation
        </Button>
      </div>
      <div className="text-[12px] text-faint">
        Create a task, or send a message to one, on a schedule or when a webhook is delivered (a new GitHub issue, say). Saved as you change them.
      </div>
      {list && list.length > 0 && (
        <div className="divide-y divide-line/70 rounded-md border border-line/70">
          {list.map((a) => (
            <AutomationRow
              key={a.id}
              automation={a}
              project={project}
              tz={tz}
              onToggle={(enabled) => run(() => api.updateAutomation(hostId, a.id, { enabled }))}
              onEdit={() => setEditing(a)}
              onRun={() => (a.trigger.kind === "webhook" ? setTesting(a) : run(() => api.runAutomation(hostId, a.id)))}
              onDelete={() => confirm(`Delete the automation "${a.name}"? Its run history goes with it.`) && run(() => api.deleteAutomation(hostId, a.id))}
            />
          ))}
        </div>
      )}
      {list && !list.length && <div className="text-[12px] text-faint">No automations yet.</div>}
      {err && <div className="text-xs text-red-400">{err}</div>}
      {editing && (
        <AutomationEditor
          project={project}
          automation={editing === "new" ? null : editing}
          tz={tz}
          onSaved={reload}
          onClose={() => setEditing(null)}
        />
      )}
      {testing && <TestDelivery hostId={hostId} automation={testing} onClose={() => setTesting(null)} />}
    </div>
  );
}

function RunStatus({ run }: { run: AutomationRun }) {
  return <span className={clsx("shrink-0", STATUS_STYLE[run.status])}>{STATUS_LABEL[run.status]}</span>;
}

/** The task a run made or messaged, as a link. */
function RunTask({ run }: { run: AutomationRun }) {
  if (!run.task_id) return null;
  if (!run.task) return <span className="text-faint">(task deleted)</span>;
  const task = run.task;
  return (
    <button type="button" className="min-w-0 truncate text-left text-muted hover:text-fg hover:underline" onClick={() => openTask(run.task_id!)} title={task.title}>
      <span className="font-mono">{task.key}</span> {task.title}
    </button>
  );
}

function AutomationRow({
  automation: a,
  project,
  tz,
  onToggle,
  onEdit,
  onRun,
  onDelete,
}: {
  automation: Automation;
  project: Project;
  tz: TimeZone | null;
  onToggle: (enabled: boolean) => void;
  onEdit: () => void;
  onRun: () => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const target = useStore((s) => (a.action.kind === "send_to_task" ? s.tasks[a.action.task_id] : undefined));
  const what =
    a.action.kind === "create_task"
      ? `Creates "${a.action.title}"${a.action.start ? " and starts its agent" : ""}`
      : `Messages ${target ? `${project.key}-${target.number} ${target.title}` : "a task"}`;
  const last = a.last_run;
  return (
    <div className="px-3 py-2">
      <div className="flex items-center gap-3">
        <Toggle checked={a.enabled} onChange={onToggle} label="" />
        <button type="button" className="min-w-0 flex-1 text-left" onClick={onEdit}>
          <div className={clsx("flex items-center gap-1.5 text-[13px]", !a.enabled && "text-faint")}>
            {a.trigger.kind === "webhook" ? <Webhook size={13} className="shrink-0 text-muted" /> : <Clock size={13} className="shrink-0 text-muted" />}
            <span className="truncate font-medium">{a.name}</span>
          </div>
          <div className="truncate text-[11.5px] text-faint">
            {triggerText(a.trigger, tz)} · {what}
          </div>
        </button>
        <Button
          size="sm"
          variant="ghost"
          disabled={running}
          title={a.trigger.kind === "webhook" ? "Send it a test delivery" : "Run it now, whether or not it's on"}
          onClick={async () => {
            setRunning(true);
            try {
              await onRun();
            } finally {
              setRunning(false);
            }
          }}
        >
          <Play size={12} /> {a.trigger.kind === "webhook" ? "Test" : "Run now"}
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
            <span className="shrink-0">Last {a.trigger.kind === "webhook" && last.source === "webhook" ? "delivery" : "run"} {timeAgo(last.created_at)}:</span>
            <RunStatus run={last} />
            {last.task && <span className="truncate">{last.task.key}</span>}
          </>
        ) : (
          <span>{a.trigger.kind === "webhook" ? "No deliveries yet" : "Hasn't run yet"}</span>
        )}
        {a.enabled && a.next_run_at && (
          <span className="ml-auto shrink-0" title={new Date(a.next_run_at).toLocaleString()}>
            Next {timeUntil(a.next_run_at)} ({localTime(a.next_run_at)})
          </span>
        )}
        {!a.enabled && <span className="ml-auto shrink-0">Off</span>}
      </button>
      {open && <RunHistory hostId={project.host_id} automation={a} />}
    </div>
  );
}

/** An automation's latest runs and deliveries. */
function RunHistory({ hostId, automation }: { hostId: string; automation: Automation }) {
  const [runs, setRuns] = useState<AutomationRun[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(
    () =>
      api.automationRuns(hostId, automation.id).then(
        (r) => setRuns(r.runs),
        (e) => setErr((e as Error).message),
      ),
    [hostId, automation.id],
  );
  useEffect(() => {
    load();
    return onAutomationsChanged((h, _pid, id) => {
      if (h === hostId && id === automation.id) load();
    });
  }, [load, hostId, automation.id]);
  if (err) return <div className="mt-2 text-xs text-red-400">{err}</div>;
  if (!runs) return null;
  if (!runs.length) return <div className="mt-2 pl-4 text-[11.5px] text-faint">Nothing yet.</div>;
  return (
    <div className="mt-2 max-h-72 space-y-1 overflow-y-auto pl-4" data-testid="automation-runs">
      {runs.map((r) => (
        <div key={r.id} className="text-[11.5px]">
          <div className="flex min-w-0 items-center gap-2">
            <span className="w-16 shrink-0 text-faint" title={new Date(r.created_at).toLocaleString()}>
              {timeAgo(r.created_at)}
            </span>
            <span className="w-16 shrink-0 text-faint">{SOURCE_LABEL[r.source]}</span>
            <RunStatus run={r} />
            {r.event && <span className="shrink-0 font-mono text-faint">{r.event}</span>}
            {r.count > 1 && <span className="shrink-0 text-faint">×{r.count}</span>}
            <RunTask run={r} />
          </div>
          {r.detail && r.status !== "duplicate" && <div className="pl-[8.5rem] text-faint break-words">{r.detail}</div>}
        </div>
      ))}
    </div>
  );
}

// ---------- the editor ----------

type Unit = "minutes" | "hours" | "days";
const UNIT_MINUTES: Record<Unit, number> = { minutes: 1, hours: 60, days: 1440 };

interface Draft {
  name: string;
  enabled: boolean;
  when: "interval" | "daily" | "webhook";
  every: number;
  unit: Unit;
  time: string;
  weekdays: Weekday[];
  /** Comma-separated lists for the simple filters. */
  simple: Record<(typeof SIMPLE_FILTERS)[number], string>;
  /** Any other filters. */
  filters: AutomationFilter[];
  coalesce: number;
  coalesceKey: string;
  /** A new signing secret ("" leaves it as it is). */
  secret: string;
  removeSecret: boolean;
  does: "create_task" | "send_to_task";
  title: string;
  description: string;
  taskType: TaskType | "";
  config: string;
  model: string;
  effort: string;
  status: "todo" | "backlog";
  start: boolean;
  taskId: string;
  message: string;
}

const listText = (v: AutomationFilter["value"]) => (Array.isArray(v) ? v.join(", ") : (v ?? ""));
const splitList = (s: string) =>
  s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

function draftOf(a: Automation | null): Draft {
  const d: Draft = {
    name: "",
    enabled: true,
    when: "daily",
    every: 1,
    unit: "days",
    time: "09:00",
    weekdays: ["mon", "tue", "wed", "thu", "fri"],
    simple: { event: "", action: "", labels: "" },
    filters: [],
    coalesce: 0,
    coalesceKey: "",
    secret: "",
    removeSecret: false,
    does: "create_task",
    title: "",
    description: "",
    taskType: "",
    config: "",
    model: "",
    effort: "",
    status: "todo",
    start: false,
    taskId: "",
    message: "",
  };
  if (!a) return d;
  d.name = a.name;
  d.enabled = a.enabled;
  const t = a.trigger;
  d.when = t.kind;
  if (t.kind === "interval") {
    d.unit = t.every_minutes % 1440 === 0 ? "days" : t.every_minutes % 60 === 0 ? "hours" : "minutes";
    d.every = t.every_minutes / UNIT_MINUTES[d.unit];
  } else if (t.kind === "daily") {
    d.time = t.time;
    d.weekdays = t.weekdays.length ? t.weekdays : [...WEEKDAYS];
  } else {
    for (const f of t.filters) {
      const simple = SIMPLE_FILTERS.find((p) => p === f.path);
      if (simple && f.op === "in" && !d.simple[simple]) d.simple[simple] = listText(f.value);
      else d.filters.push({ ...f });
    }
    d.coalesce = t.coalesce_seconds;
    d.coalesceKey = t.coalesce_key;
  }
  const act = a.action;
  d.does = act.kind;
  if (act.kind === "create_task") {
    d.title = act.title;
    d.description = act.description;
    d.taskType = act.task_type ?? "";
    d.config = act.claude_config_id ?? "";
    d.model = act.model ?? "";
    d.effort = act.effort ?? "";
    d.status = act.status;
    d.start = act.start;
  } else {
    d.taskId = act.task_id;
    d.message = act.message;
  }
  return d;
}

function inputOf(d: Draft, existing: Automation | null): AutomationInput {
  const trigger: AutomationInput["trigger"] =
    d.when === "interval"
      ? { kind: "interval", every_minutes: Math.round(d.every * UNIT_MINUTES[d.unit]) }
      : d.when === "daily"
        ? { kind: "daily", time: d.time, weekdays: d.weekdays.length === 7 ? [] : WEEKDAYS.filter((w) => d.weekdays.includes(w)) }
        : {
            kind: "webhook",
            filters: [
              ...SIMPLE_FILTERS.filter((p) => splitList(d.simple[p]).length).map((p): AutomationFilter => ({ path: p, op: "in", value: splitList(d.simple[p]) })),
              ...d.filters.filter((f) => f.path.trim()),
            ],
            coalesce_seconds: Math.max(0, Math.round(d.coalesce || 0)),
            coalesce_key: d.coalesceKey,
          };
  const action: AutomationInput["action"] =
    d.does === "create_task"
      ? {
          kind: "create_task",
          title: d.title,
          description: d.description,
          task_type: d.taskType || null,
          claude_config_id: d.config || null,
          model: d.model.trim() || null,
          effort: d.effort || null,
          status: d.status,
          start: d.start,
        }
      : { kind: "send_to_task", task_id: d.taskId, message: d.message };
  const b: AutomationInput = { name: d.name, enabled: d.enabled, trigger, action };
  if (d.when === "webhook") {
    // As it's typed: GitHub signs with it as it is (the server refuses one with spaces around it).
    if (d.secret.trim()) b.secret = d.secret;
    else if (d.removeSecret && existing?.has_secret) b.secret = "";
  }
  return b;
}

/** A random signing secret. */
function newSecret() {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { id: T; label: ReactNode }[]; onChange: (v: T) => void }) {
  return (
    <div className="inline-flex rounded-md border border-line bg-panel p-0.5">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          onClick={() => onChange(o.id)}
          className={clsx("flex items-center gap-1.5 rounded px-2.5 py-1 text-[12.5px]", value === o.id ? "bg-raised text-fg" : "text-muted hover:text-fg")}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

const selectClass = "h-8 w-full rounded-md border border-line bg-panel px-2 text-[13px] outline-none";

function AutomationEditor({
  project,
  automation,
  tz,
  onSaved,
  onClose,
}: {
  project: Project;
  automation: Automation | null;
  tz: TimeZone | null;
  onSaved: () => void;
  onClose: () => void;
}) {
  const hostId = project.host_id;
  const [d, setD] = useState<Draft>(() => draftOf(automation));
  const [saved, setSaved] = useState<Automation | null>(automation);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));
  const configs = useAvailableConfigs(hostId, project.profile_id, project);
  const tasks = useStore(
    useShallow((s) =>
      Object.values(s.tasks)
        .filter((t) => t.host_id === hostId && t.project_id === project.id && t.kind === "task")
        .sort((a, b) => b.number - a.number),
    ),
  );
  const save = async () => {
    setErr(null);
    if (!d.name.trim()) return setErr("Give it a name.");
    if (d.does === "create_task" && !d.title.trim()) return setErr("The task needs a title.");
    if (d.does === "send_to_task" && !d.taskId) return setErr("Pick the task to message.");
    if (d.does === "send_to_task" && !d.message.trim()) return setErr("Write the message.");
    setBusy(true);
    try {
      const b = inputOf(d, saved);
      const a = saved ? await api.updateAutomation(hostId, saved.id, b) : await api.createAutomation(hostId, project.id, b);
      onSaved();
      // A new webhook stays open, to show its URL, and the secret it was given until it closes.
      if (!saved && a.trigger.kind === "webhook") {
        setSaved(a);
        setD({ ...draftOf(a), secret: d.secret });
        setBusy(false);
        return;
      }
      onClose();
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };
  const webhook = d.when === "webhook";
  const vars = webhook
    ? ["{{body.issue.title}}", "{{body.issue.html_url}}", "{{body.issue.body}}", "{{event}}", "{{action}}", "{{labels}}", "{{count}}"]
    : ["{{date}}", "{{time}}", "{{automation}}"];
  const templateHint = (
    <>
      Templates take values like {vars.map((v, i) => (
        <span key={v}>
          {i > 0 && ", "}
          <code>{v}</code>
        </span>
      ))}
      .{webhook && " A webhook's values are wrapped in <untrusted-data> tags, and the agent is told not to follow instructions in them."}
    </>
  );
  return (
    <Modal title={saved ? `Edit ${saved.name}` : "New automation"} onClose={onClose} onSubmit={save} width="max-w-2xl">
      {/* The fields scroll, under the dialog's title and above its buttons. */}
      <div className="flex max-h-[calc(90vh-7rem)] flex-col">
      <div className="-mx-4 -mt-4 min-h-0 flex-1 space-y-4 overflow-y-auto px-4 pt-4 pb-1">
        <div className="grid grid-cols-[1fr_auto] items-end gap-3">
          <Field label="Name">
            <Input value={d.name} onChange={(e) => set("name", e.target.value)} placeholder="Weekly dependency update" autoFocus={!saved} />
          </Field>
          <div className="pb-1.5">
            <Toggle checked={d.enabled} onChange={(v) => set("enabled", v)} label="On" />
          </div>
        </div>

        <div className="space-y-3 rounded-lg border border-line/70 p-3">
          <div className="flex items-center gap-3">
            <span className="text-xs font-medium text-muted">When</span>
            <Segmented
              value={d.when}
              onChange={(v) => set("when", v)}
              options={[
                { id: "daily", label: "At a time of day" },
                { id: "interval", label: "Every…" },
                { id: "webhook", label: "From a webhook" },
              ]}
            />
          </div>
          {d.when === "interval" && (
            <div className="flex items-center gap-2 text-[13px]">
              Every
              <Input
                type="number"
                min={1}
                className="w-20"
                aria-label="Every"
                value={d.every}
                onChange={(e) => set("every", Math.max(1, Number(e.target.value) || 1))}
              />
              <select className={clsx(selectClass, "w-28")} aria-label="Unit" value={d.unit} onChange={(e) => set("unit", e.target.value as Unit)}>
                <option value="minutes">minutes</option>
                <option value="hours">hours</option>
                <option value="days">days</option>
              </select>
              <span className="text-[12px] text-faint">from when it's turned on (at least 5 minutes)</span>
            </div>
          )}
          {d.when === "daily" && (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2 text-[13px]">
                At
                <Input type="time" className="w-28" aria-label="Time" value={d.time} onChange={(e) => set("time", e.target.value)} />
                on
                {WEEKDAYS.map((w) => {
                  const on = d.weekdays.includes(w);
                  return (
                    <button
                      key={w}
                      type="button"
                      onClick={() => set("weekdays", on ? d.weekdays.filter((x) => x !== w) : [...d.weekdays, w])}
                      className={clsx("h-7 w-10 rounded-md border text-[12px]", on ? "border-accent/60 bg-accent/15 text-fg" : "border-line text-faint hover:text-muted")}
                    >
                      {DAY_LABELS[w]}
                    </button>
                  );
                })}
              </div>
              <div className="text-[12px] text-faint">
                In the host's time zone{tz ? ` (${[tz.name, tz.offset].filter(Boolean).join(", ")})` : ""}. No day picked means every day. A run missed by more than 10
                minutes (the server was down) is skipped, not made up.
              </div>
            </div>
          )}
          {webhook && <WebhookFields project={project} draft={d} saved={saved} set={set} onRotated={(a) => setSaved(a)} />}
        </div>

        <div className="space-y-3 rounded-lg border border-line/70 p-3">
          <div className="flex items-center gap-3">
            <span className="text-xs font-medium text-muted">Do</span>
            <Segmented
              value={d.does}
              onChange={(v) => set("does", v)}
              options={[
                { id: "create_task", label: "Create a task" },
                { id: "send_to_task", label: "Message a task" },
              ]}
            />
          </div>
          {d.does === "create_task" ? (
            <>
              <Field label="Title">
                <Input value={d.title} onChange={(e) => set("title", e.target.value)} placeholder={webhook ? "Triage: {{body.issue.title}}" : "Update dependencies ({{date}})"} />
              </Field>
              <Field label="Description" hint={templateHint}>
                <Textarea
                  rows={6}
                  className="font-mono text-[12px]"
                  value={d.description}
                  onChange={(e) => set("description", e.target.value)}
                  placeholder={webhook ? "Triage this issue: {{body.issue.html_url}}\n\n{{body.issue.body}}" : "Update the dependencies and open a pull request."}
                />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Type">
                  <select className={selectClass} value={d.taskType} onChange={(e) => set("taskType", e.target.value as TaskType | "")}>
                    <option value="">Code task</option>
                    <option value="plan">Plan</option>
                    <option value="artifact">Artifact</option>
                    <option value="diagram">Diagram</option>
                    <option value="scratch">Scratch task</option>
                  </select>
                </Field>
                {configs.length > 1 ? (
                  <Field label="Agent config">
                    <select className={selectClass} value={d.config} onChange={(e) => set("config", e.target.value)}>
                      <option value="">Project default ({configs[0]?.name})</option>
                      {configs.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                ) : (
                  <div />
                )}
                <Field label="Model">
                  <Input value={d.model} list="automation-models" placeholder="project default" onChange={(e) => set("model", e.target.value)} />
                  <datalist id="automation-models">
                    {MODEL_ALIASES.map((m) => (
                      <option key={m} value={m} />
                    ))}
                  </datalist>
                </Field>
                <Field label="Effort">
                  <select className={selectClass} value={d.effort} onChange={(e) => set("effort", e.target.value)}>
                    <option value="">Default</option>
                    {EFFORTS.map((e) => (
                      <option key={e} value={e}>
                        {e}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
              <div className="flex flex-wrap items-center gap-4">
                <Toggle checked={d.start} onChange={(v) => set("start", v)} label="Start its agent" />
                {!d.start && (
                  <label className="flex items-center gap-2 text-[13px] text-muted">
                    Put it in
                    <select className={clsx(selectClass, "w-32")} value={d.status} onChange={(e) => set("status", e.target.value as Draft["status"])}>
                      <option value="todo">To do</option>
                      <option value="backlog">Backlog</option>
                    </select>
                  </label>
                )}
              </div>
              {d.start && webhook && (
                <div className="text-[12px] text-st-attention">
                  Its agent runs with the project's permission mode on what the delivery says. Keep that mode asking for approval if anyone outside can trigger it.
                </div>
              )}
            </>
          ) : (
            <>
              <Field label="Task" hint="One of this project's tasks. Messages to a task whose agent is running go to it as it works.">
                <select className={selectClass} value={d.taskId} onChange={(e) => set("taskId", e.target.value)}>
                  <option value="">Pick a task…</option>
                  {tasks.map((t) => (
                    <option key={t.id} value={t.id}>
                      {project.key}-{t.number} {t.title}
                      {t.status === "done" ? " (done)" : ""}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Message" hint={templateHint}>
                <Textarea
                  rows={5}
                  className="font-mono text-[12px]"
                  value={d.message}
                  onChange={(e) => set("message", e.target.value)}
                  placeholder={webhook ? "A new comment on {{body.issue.html_url}}:\n\n{{body.comment.body}}" : "Check on the nightly build and fix what broke."}
                />
              </Field>
            </>
          )}
        </div>
      </div>
      <div className="space-y-2 pt-3">
        {err && <div className="text-xs text-red-400">{err}</div>}
        <div className="flex items-center justify-end gap-2">
          <span className="mr-auto text-[11.5px] text-faint">{SUBMIT_KEYS} to save</span>
          <Button variant="ghost" onClick={onClose}>
            {saved && !automation ? "Done" : "Cancel"}
          </Button>
          <Button variant="primary" disabled={busy} onClick={save}>
            {saved ? "Save automation" : "Add automation"}
          </Button>
        </div>
      </div>
      </div>
    </Modal>
  );
}

/** A webhook's URL, signing secret, filters and coalescing. */
function WebhookFields({
  project,
  draft: d,
  saved,
  set,
  onRotated,
}: {
  project: Project;
  draft: Draft;
  saved: Automation | null;
  set: <K extends keyof Draft>(k: K, v: Draft[K]) => void;
  onRotated: (a: Automation) => void;
}) {
  const hostId = project.host_id;
  const host = useHost(hostId);
  const publicUrl = useStore((s) => s.hostSettings[hostId]?.public_url ?? "");
  const [address, setAddress] = useState(publicUrl);
  const [addressErr, setAddressErr] = useState<string | null>(null);
  const [rotateErr, setRotateErr] = useState<string | null>(null);
  useEffect(() => {
    setAddress(publicUrl);
  }, [publicUrl]);
  const [copied, setCopied] = useState(false);
  const base = publicUrl || (host?.local ? window.location.origin : "");
  const path = saved?.trigger.kind === "webhook" ? saved.hook_path : undefined;
  const url = path ? `${base}${path}` : null;
  // Shown once it's saved (or made anew): brought into view.
  const urlField = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Not returned: browsers' scrollIntoView may return a promise, which isn't a cleanup.
    urlField.current?.scrollIntoView({ block: "nearest" });
  }, [path]);
  const setFilter = (i: number, f: Partial<AutomationFilter>) => set("filters", d.filters.map((x, j) => (j === i ? { ...x, ...f } : x)));
  return (
    <div className="space-y-3">
      <Field
        label="URL"
        hint={
          <>
            Deliveries are POSTed here, as JSON or as GitHub's form-encoded <code>payload</code>. The URL is its only key: keep it secret, or make a new one if
            it gets out.{" "}
            {!publicUrl &&
              (host?.local
                ? "Something outside (GitHub, say) needs a public address for this host: set it below, once a tunnel or broker reaches it."
                : `This is the path on ${host?.name ?? "the host"}; set its public address below.`)}
          </>
        }
      >
        {url ? (
          <div ref={urlField} className="flex items-center gap-2">
            <Input readOnly aria-label="Webhook URL" className="font-mono text-[12px]" value={url} onFocus={(e) => e.target.select()} data-testid="webhook-url" />
            <IconButton
              title="Copy the URL"
              onClick={(e) => {
                e.preventDefault();
                copyText(url);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
            >
              {copied ? <span className="text-[11px]">✓</span> : <Copy size={13} />}
            </IconButton>
            <IconButton
              title="Make a new URL (the old one stops working)"
              onClick={async (e) => {
                e.preventDefault();
                if (!saved || !confirm("Make a new URL? The current one stops working, so update it wherever it's used.")) return;
                setRotateErr(null);
                try {
                  onRotated(await api.updateAutomation(hostId, saved.id, { rotate_token: true }));
                } catch (err) {
                  setRotateErr(`Couldn't make a new URL: ${(err as Error).message}`);
                }
              }}
            >
              <RefreshCw size={13} />
            </IconButton>
          </div>
        ) : (
          <div className="text-[12px] text-faint">Shown here once it's saved.</div>
        )}
        {rotateErr && <div className="text-xs text-red-400">{rotateErr}</div>}
      </Field>
      <Field label="This host's public address" hint="For every webhook on this host. Where a tunnel or the connection broker reaches it from outside.">
        <div className="flex items-center gap-2">
          <Input
            className="font-mono text-[12px]"
            value={address}
            placeholder={host?.local ? window.location.origin : "https://board.example.com"}
            onChange={(e) => setAddress(e.target.value)}
          />
          {address.trim() !== publicUrl && (
            <Button
              size="sm"
              onClick={async (e) => {
                e.preventDefault();
                setAddressErr(null);
                try {
                  await api.updateSettings(hostId, { public_url: address.trim() || null });
                  await useStore.getState().loadHostSettings(hostId);
                } catch (err) {
                  setAddressErr((err as Error).message);
                }
              }}
            >
              Save address
            </Button>
          )}
        </div>
        {addressErr && <div className="text-xs text-red-400">{addressErr}</div>}
      </Field>
      <Field
        label="Secret"
        hint="GitHub's webhook Secret: deliveries without a matching X-Hub-Signature-256 are rejected. Copy a new one into GitHub: once this dialog closes, it isn't shown again."
      >
        <div className="flex items-center gap-2">
          <Input
            className="font-mono text-[12px]"
            value={d.secret}
            aria-label="Secret"
            autoComplete="off"
            placeholder={saved?.has_secret && !d.removeSecret ? "Saved (type a new one to replace it)" : "None: deliveries aren't checked"}
            onChange={(e) => set("secret", e.target.value)}
          />
          <Button
            size="sm"
            onClick={(e) => {
              e.preventDefault();
              set("secret", newSecret());
            }}
          >
            Generate
          </Button>
          {saved?.has_secret && !d.secret && (
            <Button
              size="sm"
              variant="ghost"
              onClick={(e) => {
                e.preventDefault();
                set("removeSecret", !d.removeSecret);
              }}
            >
              {d.removeSecret ? "Keep it" : "Remove"}
            </Button>
          )}
        </div>
      </Field>
      <div className="space-y-2">
        <div className="text-xs font-medium text-muted">Only when</div>
        <div className="grid grid-cols-3 gap-2">
          <Input value={d.simple.event} placeholder="Events, e.g. issues" aria-label="Events" onChange={(e) => set("simple", { ...d.simple, event: e.target.value })} />
          <Input value={d.simple.action} placeholder="Actions, e.g. opened" aria-label="Actions" onChange={(e) => set("simple", { ...d.simple, action: e.target.value })} />
          <Input value={d.simple.labels} placeholder="Labels, e.g. bug, triage" aria-label="Labels" onChange={(e) => set("simple", { ...d.simple, labels: e.target.value })} />
        </div>
        {d.filters.map((f, i) => (
          <div key={i} className="grid grid-cols-[1fr_9rem_1fr_auto] gap-2">
            <Input className="font-mono text-[12px]" value={f.path} placeholder="body.issue.user.login" aria-label="Value to check" onChange={(e) => setFilter(i, { path: e.target.value })} />
            <select className={selectClass} value={f.op} aria-label="Condition" onChange={(e) => setFilter(i, { op: e.target.value as FilterOp })}>
              {FILTER_OPS.map((op) => (
                <option key={op} value={op}>
                  {OP_LABELS[op]}
                </option>
              ))}
            </select>
            {f.op === "exists" || f.op === "not_exists" ? (
              <div />
            ) : (
              <Input value={listText(f.value)} placeholder={f.op === "in" || f.op === "not_in" ? "a, b, c" : "value"} aria-label="Filter value" onChange={(e) => setFilter(i, { value: e.target.value })} />
            )}
            <IconButton
              title="Remove this filter"
              onClick={(e) => {
                e.preventDefault();
                set("filters", d.filters.filter((_, j) => j !== i));
              }}
            >
              <X size={13} />
            </IconButton>
          </div>
        ))}
        <div className="flex items-center gap-3">
          <Button
            size="sm"
            variant="ghost"
            onClick={(e) => {
              e.preventDefault();
              set("filters", [...d.filters, { path: "", op: "equals", value: "" }]);
            }}
          >
            <Plus size={12} /> Another condition
          </Button>
          <span className="text-[12px] text-faint">
            Lists are comma-separated; each condition has to hold. <code>event</code> is GitHub's X-GitHub-Event, <code>labels</code> the issue's or pull
            request's labels.
          </span>
        </div>
      </div>
      <div className="grid grid-cols-[10rem_1fr] gap-3">
        <Field label="Coalesce for (seconds)">
          <Input type="number" min={0} max={3600} value={d.coalesce} onChange={(e) => set("coalesce", Math.max(0, Math.min(3600, Number(e.target.value) || 0)))} />
        </Field>
        <Field label="…deliveries with the same" hint="A burst of deliveries in the window becomes one run, with the latest delivery's values. 0 runs each one.">
          <Input className="font-mono text-[12px]" value={d.coalesceKey} placeholder="{{body.issue.number}} (blank: all of them)" onChange={(e) => set("coalesceKey", e.target.value)} />
        </Field>
      </div>
    </div>
  );
}

/** Sends a webhook automation a delivery from the board, to try its filters and templates. */
function TestDelivery({ hostId, automation, onClose }: { hostId: string; automation: Automation; onClose: () => void }) {
  const [event, setEvent] = useState("");
  const [body, setBody] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<AutomationRun | null>(null);
  useEffect(() => {
    api.automationRuns(hostId, automation.id).then(
      (r) => {
        setEvent(r.latest_delivery?.event ?? "issues");
        setBody(JSON.stringify(r.latest_delivery?.body ?? { action: "opened", issue: { number: 1, title: "An issue", body: "What it says", labels: [] } }, null, 2));
      },
      (e) => setErr((e as Error).message),
    );
  }, [hostId, automation.id]);
  const send = async () => {
    setErr(null);
    setResult(null);
    let payload: unknown;
    try {
      payload = JSON.parse(body ?? "{}");
    } catch {
      return setErr("The body isn't valid JSON.");
    }
    setBusy(true);
    try {
      setResult(await api.runAutomation(hostId, automation.id, { payload, event }));
    } catch (e) {
      setErr((e as Error).message);
    }
    setBusy(false);
  };
  return (
    <Modal title={`Test ${automation.name}`} onClose={onClose} onSubmit={send} width="max-w-2xl">
      <div className="space-y-3">
        <div className="text-[12px] text-faint">
          Runs it now with this delivery, through its filters (but not its secret, duplicate check or coalescing), whether or not it's on. It starts from the
          latest delivery it got.
        </div>
        <Field label="Event (X-GitHub-Event)">
          <Input className="font-mono text-[12px]" value={event} onChange={(e) => setEvent(e.target.value)} placeholder="issues" />
        </Field>
        <Field label="Body">
          <Textarea rows={14} className="font-mono text-[12px]" value={body ?? ""} spellCheck={false} onChange={(e) => setBody(e.target.value)} />
        </Field>
        {result && (
          <div className="flex min-w-0 items-center gap-2 rounded-md border border-line/70 px-3 py-2 text-[12.5px]" data-testid="test-result">
            <RunStatus run={result} />
            <RunTask run={result} />
            {result.detail && <span className="min-w-0 truncate text-faint">{result.detail}</span>}
          </div>
        )}
        {err && <div className="text-xs text-red-400">{err}</div>}
        <div className="flex items-center justify-end gap-2">
          <span className="mr-auto text-[11.5px] text-faint">{SUBMIT_KEYS} to send</span>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button variant="primary" disabled={busy || body === null} onClick={send}>
            <Play size={12} /> Send test delivery
          </Button>
        </div>
      </div>
    </Modal>
  );
}
