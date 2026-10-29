import clsx from "clsx";
import { ArrowRight, Check, ShieldAlert, Trash2, X } from "lucide-react";
import { useState } from "react";
import { api, PERMISSION_MODES, STATUSES, type Approval, type DeletionApproval, type ProjectApproval, type ProjectChange, type TaskDeletion } from "../api";
import { navigate } from "../router";
import { useStore } from "../store";
import { Button, Modal } from "./ui";

/** Project settings as the project's settings page names them. */
const LABELS: Record<string, string> = {
  name: "Name",
  key: "Key",
  base_branch: "Base branch",
  model: "Model",
  start_prompt: "In progress prompt",
  review_prompt: "In review prompt",
  merge_prompt: "Ready for merge prompt",
  auto_review: "Review each task's changes",
  review_rounds: "Fix rounds",
  reviewers: "Reviewers",
  group_name: "Group",
  permission_mode: "Permission mode",
  setup_script: "Setup script",
  teardown_script: "Teardown script",
  status_script: "Status script (any column)",
  status_scripts: "Column scripts",
  repo_path: "Repository path",
  move_repo: "Move the folder there",
  use_worktrees: "New tasks use their own git worktree",
  worktrees_root: "Worktrees folder",
};

/** Settings shown as blocks of text rather than inline. */
const LONG = ["start_prompt", "review_prompt", "merge_prompt", "setup_script", "teardown_script", "status_script", "status_scripts", "reviewers"];

function valueText(field: string, v: unknown): string {
  if (v === null || v === undefined) return field === "group_name" ? "(none)" : "(default)";
  if (typeof v === "boolean") return v ? "On" : "Off";
  if (field === "permission_mode") return PERMISSION_MODES.find((m) => m.id === v)?.label ?? String(v);
  if (field === "status_scripts" && typeof v === "object") {
    const entries = Object.entries(v as Record<string, string>);
    return entries.length ? entries.map(([status, script]) => `# ${status}\n${script}`).join("\n\n") : "";
  }
  if (typeof v === "object") return JSON.stringify(v, null, 2);
  return String(v);
}

function Block({ text, tone }: { text: string; tone: "from" | "to" }) {
  return (
    <pre
      className={clsx(
        "max-h-48 overflow-auto rounded-md border p-2 font-mono text-[12px] leading-[1.45] whitespace-pre-wrap break-words",
        tone === "from" ? "border-line bg-[#0c0c10] text-faint" : "border-st-attention/30 bg-[#0c0c10] text-[#c9c9d6]",
      )}
    >
      {text || <span className="text-faint">(empty)</span>}
    </pre>
  );
}

/** What an agent asked to change about a project, setting by setting. */
export function ProjectChangeDetail({ change }: { change: ProjectChange }) {
  const { reason } = change;
  return (
    <div className="space-y-3 text-[13px]">
      {reason && <div className="rounded-md border-l-2 border-line-strong bg-white/[0.03] px-3 py-2 text-muted">{reason}</div>}
      <ul className="space-y-3">
        {(change.changes ?? []).map((c) => {
          const from = valueText(c.field, c.from);
          const to = valueText(c.field, c.to);
          return (
            <li key={c.field}>
              <div className="mb-1 flex items-center gap-2 text-[12px]">
                <span className="font-medium text-fg">{LABELS[c.field] ?? c.field}</span>
                {c.needs_approval && <span className="rounded bg-st-attention/15 px-1.5 py-0.5 text-[11px] text-st-attention">needs approval</span>}
              </div>
              {LONG.includes(c.field) ? (
                <div className="grid gap-1.5">
                  <Block text={from} tone="from" />
                  <Block text={to} tone="to" />
                </div>
              ) : (
                <div className="flex min-w-0 items-center gap-2 font-mono text-[12px]">
                  <span className="truncate text-faint line-through">{from}</span>
                  <ArrowRight size={12} className="shrink-0 text-faint" />
                  <span className="truncate text-fg">{to}</span>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** A task as an approval names it: its key and title. */
const taskName = (t: { key?: string; title: string }) => (t.key ? `${t.key} ${t.title}` : t.title);

/** The question an approval asks, e.g. "IA-12 wants to change Issue Agent" or "IA-12 wants to delete IA-3". */
function Asker({ approval }: { approval: Approval }) {
  const { input } = approval;
  const who = input.task ? taskName(input.task) : "An agent";
  const project = input.project;
  return (
    <p className="mb-3 text-[13px] text-muted">
      <span className="text-fg">{who}</span>{" "}
      {approval.kind === "delete_task" ? (
        <>
          wants to delete the task <span className="text-fg">{taskName(approval.input.delete)}</span>
          {project ? ` in ${project.name}` : ""}
        </>
      ) : (
        <>
          wants to change the project{" "}
          <span className="text-fg">
            {project?.name} ({project?.key})
          </span>
        </>
      )}
      {project?.host ? ` on ${project.host}` : ""}.
    </p>
  );
}

const statusLabel = (s: string) => STATUSES.find((x) => x.id === s)?.label ?? s;

/** What deleting a task an agent asked to delete would delete. */
export function TaskDeletionDetail({ deletion }: { deletion: TaskDeletion }) {
  const { reason, delete: d } = deletion;
  const others = deletion.tasks_with_it ?? [];
  const row = (t: { key: string; title: string; status: string }) => (
    <div className="flex min-w-0 items-center gap-2">
      <span className="shrink-0 font-mono text-[12px] text-faint">{t.key}</span>
      <span className="truncate text-fg">{t.title}</span>
      <span className="ml-auto shrink-0 text-[11px] text-faint">{statusLabel(t.status)}</span>
    </div>
  );
  return (
    <div className="space-y-3 text-[13px]">
      {reason && <div className="rounded-md border-l-2 border-line-strong bg-white/[0.03] px-3 py-2 text-muted">{reason}</div>}
      <div className="rounded-md border border-red-500/30 bg-[#0c0c10] px-3 py-2">{row(d)}</div>
      <p className="text-muted">
        This stops any running agent, deletes the thread, and removes its worktree, discarding any uncommitted changes.
        {d.running && <span className="text-amber-200/90"> Its agent is running now.</span>}
      </p>
      {others.length > 0 && (
        <div>
          <div className="mb-1 text-amber-200/90">
            It's a subproject: its {others.length} task{others.length === 1 ? " is" : "s are"} deleted the same way.
          </div>
          <ul className="max-h-40 space-y-1 overflow-auto rounded-md border border-line bg-[#0c0c10] px-3 py-2">
            {others.map((t) => (
              <li key={t.id}>{row(t)}</li>
            ))}
          </ul>
        </div>
      )}
      {d.branch && (
        <p className="text-muted">
          The branch <span className="font-mono text-fg">{d.branch}</span>
          {others.length > 0 && " and its tasks' branches"} {deletion.delete_branch ? (others.length > 0 ? "are deleted too." : "is deleted too.") : others.length > 0 ? "are kept." : "is kept."}
        </p>
      )}
    </div>
  );
}

function useDecide(hostId: string, requestId: string) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const decide = async (d: "allow" | "deny") => {
    setBusy(true);
    setErr(null);
    try {
      await api.resolvePermission(hostId, requestId, d);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return { busy, err, decide };
}

function DecideButtons({ hostId, approval, onLater }: { hostId: string; approval: Pick<Approval, "request_id" | "kind">; onLater?: () => void }) {
  const { busy, err, decide } = useDecide(hostId, approval.request_id);
  const deletion = approval.kind === "delete_task";
  return (
    <div className="flex flex-wrap items-center gap-2">
      {deletion ? (
        <Button size="sm" variant="danger" disabled={busy} onClick={() => decide("allow")}>
          <Trash2 size={13} /> Delete
        </Button>
      ) : (
        <Button size="sm" variant="primary" disabled={busy} onClick={() => decide("allow")}>
          <Check size={13} /> Approve
        </Button>
      )}
      <Button size="sm" disabled={busy} onClick={() => decide("deny")}>
        <X size={13} /> {deletion ? "Don't delete" : "Deny"}
      </Button>
      {onLater && (
        <Button size="sm" variant="ghost" className="ml-auto" disabled={busy} onClick={onLater}>
          Decide later
        </Button>
      )}
      {err && <span className="text-xs text-red-400">{err}</span>}
    </div>
  );
}

/**
 * Asks the user to approve each project change (and confirm each task deletion) an agent is
 * waiting on, on any host, wherever they are in the app. "Decide later" hides one until it's
 * asked again (it stays in its thread).
 */
export function ProjectApprovals() {
  const approvals = useStore((s) => s.approvals);
  const tasks = useStore((s) => s.tasks);
  const [later, setLater] = useState<string[]>([]);
  const waiting = approvals.filter((a) => !later.includes(`${a.host_id}:${a.request_id}`));
  const a = waiting[0];
  if (!a) return null;
  // Only threads on the board can be opened (not another profile's, while one is selected).
  const thread = tasks[a.task_id];
  const close = () => setLater((l) => [...l, `${a.host_id}:${a.request_id}`]);
  return (
    <Modal
      key={`${a.host_id}:${a.request_id}`}
      width="max-w-2xl"
      onClose={close}
      title={
        <span className="flex items-center gap-2">
          {a.kind === "delete_task" ? <Trash2 size={15} className="text-red-400" /> : <ShieldAlert size={15} className="text-st-attention" />}
          {a.kind === "delete_task" ? "Delete a task?" : "Approve a project change?"}
          {waiting.length > 1 && <span className="text-[12px] font-normal text-faint">1 of {waiting.length}</span>}
        </span>
      }
    >
      <Asker approval={a} />
      <div className="max-h-[55vh] overflow-auto">
        {a.kind === "delete_task" ? <TaskDeletionDetail deletion={a.input} /> : <ProjectChangeDetail change={a.input} />}
      </div>
      <div className="mt-4 flex items-center gap-3 border-t border-line pt-3">
        <div className="flex-1">
          <DecideButtons hostId={a.host_id} approval={a} onLater={close} />
        </div>
        {thread && (
          <button
            className="text-[12px] text-faint hover:text-muted"
            onClick={() => {
              close();
              navigate({ name: "task", taskId: thread.id });
            }}
          >
            Open thread
          </button>
        )}
      </div>
    </Modal>
  );
}

/** How an approval was answered, once it was. */
function Answer({ status, deletion }: { status: Approval["status"]; deletion?: boolean }) {
  return (
    <span
      className={clsx(
        "ml-auto rounded px-1.5 py-0.5 text-[11px]",
        status === "allowed" ? "bg-emerald-500/10 text-emerald-300" : status === "denied" ? "bg-red-500/10 text-red-300" : "bg-white/5 text-faint",
      )}
    >
      {status === "allowed" ? (deletion ? "confirmed" : "approved") : status === "denied" && deletion ? "kept" : status}
    </span>
  );
}

/** A task deletion in its thread: the same question as the dialog, and its answer once given. */
export function TaskDeletionCard({ data, hostId }: { data: DeletionApproval; hostId: string }) {
  const pending = data.status === "pending";
  const [open, setOpen] = useState(false);
  const d = data.input.delete;
  const others = data.input.tasks_with_it?.length ?? 0;
  return (
    <div className={clsx("rounded-lg border p-3", pending ? "border-red-500/40 bg-red-500/[0.05]" : "border-line bg-panel/60")}>
      <div className="mb-2 flex items-center gap-2 text-[13px]">
        <Trash2 size={15} className={pending ? "text-red-400" : "text-faint"} />
        <span className={clsx("min-w-0 truncate", pending ? "text-fg" : "text-muted")}>
          Delete the task <span className="font-medium">{taskName(d)}</span>
          {others > 0 && ` and its ${others} task${others === 1 ? "" : "s"}`}
        </span>
        {!pending && <Answer status={data.status} deletion />}
      </div>
      {pending || open ? (
        <TaskDeletionDetail deletion={data.input} />
      ) : (
        data.input.reason && (
          <button className="truncate text-left text-[12px] text-faint hover:text-muted" onClick={() => setOpen(true)}>
            {data.input.reason}
          </button>
        )
      )}
      {pending && (
        <div className="mt-3">
          <DecideButtons hostId={hostId} approval={data} />
        </div>
      )}
    </div>
  );
}

/** A project change in its thread: the same question as the dialog, and its answer once given. */
export function ProjectChangeCard({ data, hostId }: { data: ProjectApproval; hostId: string }) {
  const pending = data.status === "pending";
  const [open, setOpen] = useState(false);
  return (
    <div className={clsx("rounded-lg border p-3", pending ? "border-st-attention/50 bg-st-attention/[0.06]" : "border-line bg-panel/60")}>
      <div className="mb-2 flex items-center gap-2 text-[13px]">
        <ShieldAlert size={15} className={pending ? "text-st-attention" : "text-faint"} />
        <span className={pending ? "text-fg" : "text-muted"}>
          Change the project <span className="font-medium">{data.input.project.name}</span>
        </span>
        {!pending && <Answer status={data.status} />}
      </div>
      {pending || open ? (
        <ProjectChangeDetail change={data.input} />
      ) : (
        <button className="truncate text-left font-mono text-[12px] text-faint hover:text-muted" onClick={() => setOpen(true)}>
          {(data.input.changes ?? []).map((c) => c.field).join(", ")}
        </button>
      )}
      {pending && (
        <div className="mt-3">
          <DecideButtons hostId={hostId} approval={data} />
        </div>
      )}
    </div>
  );
}
