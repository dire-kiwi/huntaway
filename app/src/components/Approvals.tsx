import clsx from "clsx";
import { ArrowRight, Check, Clock, FolderPlus, ShieldAlert, Trash2, Webhook, X, Zap } from "lucide-react";
import { useState, type ReactNode } from "react";
import {
  api,
  PERMISSION_MODES,
  STATUSES,
  type Approval,
  type AutomationApproval,
  type AutomationChange,
  type AutomationView,
  type DeletionApproval,
  type ProjectApproval,
  type ProjectChange,
  type ProjectCreation,
  type ProjectCreationApproval,
  type TaskDeletion,
} from "../api";
import { filterText, triggerText } from "./Automations";
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
  copy_files: "Files to copy",
  link_folders: "Folders to link",
  status_script: "Status script (any column)",
  status_scripts: "Column scripts",
  repo_path: "Repository path",
  move_repo: "Move the folder there",
  use_worktrees: "New tasks use their own git worktree",
  worktrees_root: "Worktrees folder",
};

/** Settings shown as blocks of text rather than inline. */
const LONG = ["start_prompt", "review_prompt", "merge_prompt", "setup_script", "teardown_script", "copy_files", "link_folders", "status_script", "status_scripts", "reviewers"];

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

/** A project an agent asked to add: where it is, and what its agents would be allowed to do there. */
export function ProjectCreationDetail({ creation }: { creation: ProjectCreation }) {
  const { reason, project } = creation;
  const mode = PERMISSION_MODES.find((m) => m.id === creation.permission_mode)?.label ?? creation.permission_mode;
  return (
    <div className="space-y-3 text-[13px]">
      {reason && <div className="rounded-md border-l-2 border-line-strong bg-white/[0.03] px-3 py-2 text-muted">{reason}</div>}
      <div className="space-y-2 rounded-md border border-st-attention/30 bg-[#0c0c10] px-3 py-2">
        <Row label="Folder">
          <Mono>{creation.repo_path}</Mono>
          {!creation.exists ? (
            <div className="text-[12px] text-amber-200/90">Doesn't exist yet: it's created.</div>
          ) : (
            !creation.git && <div className="text-[12px] text-faint">Not a git repository.</div>
          )}
        </Row>
        <Row label="Name">
          {project.name} <span className="font-mono text-[12px] text-faint">{project.key}</span>
        </Row>
        <Row label="Board">{creation.board}</Row>
        <Row label="Permission mode">{mode} (the host's default)</Row>
      </div>
      <p className="text-muted">
        Its tasks' agents work in this folder, and can read and change what's in it. Agents can start them straight away, with that permission mode.
      </p>
    </div>
  );
}

/** Whether an approval is to add a project. */
const isCreation = (a: Pick<Approval, "kind" | "tool_name">): a is ProjectCreationApproval => a.kind === "project" && a.tool_name === "create_project";

/** A task as an approval names it: its key and title. */
const taskName = (t: { key?: string; title: string }) => (t.key ? `${t.key} ${t.title}` : t.title);

/** What an agent asks to do to an automation, e.g. "wants to add an automation to". */
const AUTOMATION_ASKS = { create: "wants to add an automation to", update: "wants to change an automation in", delete: "wants to delete an automation in" };

/** The question an approval asks, e.g. "IA-12 wants to change Issue Agent" or "IA-12 wants to delete IA-3". */
function Asker({ approval }: { approval: Approval }) {
  const { input } = approval;
  const who = input.task ? taskName(input.task) : "An agent";
  const project = input.project;
  return (
    <p className="mb-3 text-[13px] text-muted">
      <span className="text-fg">{who}</span>{" "}
      {approval.kind === "automation" ? (
        <>
          {AUTOMATION_ASKS[approval.input.op]} the project{" "}
          <span className="text-fg">
            {project?.name} ({project?.key})
          </span>
        </>
      ) : isCreation(approval) ? (
        <>
          wants to add the project <span className="text-fg">{approval.input.project.name}</span> to the {approval.input.board} board
        </>
      ) : approval.kind === "delete_task" ? (
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

const STATUS_NAMES = { todo: "To do", backlog: "Backlog" };
const TYPE_NAMES: Record<string, string> = { plan: "Plan", artifact: "Artifact", diagram: "Diagram", scratch: "Scratch task" };

/** One line of an automation's summary: a label, and what it is. */
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[7.5rem_1fr] items-baseline gap-2">
      <span className="text-[12px] text-faint">{label}</span>
      <div className="min-w-0 text-fg">{children}</div>
    </div>
  );
}

const Mono = ({ children }: { children: ReactNode }) => <span className="font-mono text-[12px] break-words">{children}</span>;

/** What an automation does and what starts it, as an approval shows it: everything that will run. */
export function AutomationSummary({ a, tz, tone = "to" }: { a: AutomationView; tz?: AutomationChange["time_zone"]; tone?: "from" | "to" }) {
  const t = a.trigger;
  const act = a.action;
  return (
    <div className={clsx("space-y-2 text-[13px]", tone === "from" && "opacity-70")}>
      <Row label="Name">{a.name}</Row>
      <Row label="When">
        <span className="inline-flex items-center gap-1.5">
          {t.kind === "webhook" ? <Webhook size={13} className="shrink-0 text-muted" /> : <Clock size={13} className="shrink-0 text-muted" />}
          {t.kind === "webhook" ? "Each delivery to its webhook URL" : triggerText(t, tz ?? null)}
        </span>
        {!a.enabled && <div className="text-[12px] text-faint">Off: it doesn't run until it's turned on.</div>}
      </Row>
      {t.kind === "webhook" && (
        <>
          <Row label="Filters">
            {t.filters.length ? (
              <ul className="space-y-0.5">
                {t.filters.map((f, i) => (
                  <li key={i}>
                    <Mono>{filterText(f)}</Mono>
                  </li>
                ))}
              </ul>
            ) : (
              <span className="text-amber-200/90">None: every delivery runs it</span>
            )}
          </Row>
          {t.coalesce_seconds > 0 && (
            <Row label="Coalescing">
              Deliveries within {t.coalesce_seconds}s make one run
              {t.coalesce_key && (
                <>
                  , by <Mono>{t.coalesce_key}</Mono>
                </>
              )}
            </Row>
          )}
          <Row label="Signature">
            {a.signed ? (
              "Deliveries must be signed with its secret"
            ) : (
              <span className="text-amber-200/90">Not checked: anyone with its URL can run it</span>
            )}
          </Row>
        </>
      )}
      {act.kind === "create_task" ? (
        <>
          <Row label="Creates a task">
            <Mono>{act.title}</Mono>
          </Row>
          <Row label="Description">
            <Block text={act.description} tone={tone} />
          </Row>
          <Row label="Settings">
            {[
              act.task_type ? TYPE_NAMES[act.task_type] ?? act.task_type : "Code task",
              act.labels?.length ? `labelled ${act.labels.join(", ")}` : null,
              a.config ? a.config.name : "project's agent config",
              act.model ? `model ${act.model}` : null,
              act.effort ? `effort ${act.effort}` : null,
              `in ${STATUS_NAMES[act.status] ?? act.status}`,
            ]
              .filter(Boolean)
              .join(" · ")}
          </Row>
          <Row label="Agent">
            {act.start ? <span className="text-amber-200/90">Starts straight away, with the project's permission mode</span> : "Not started: the task waits on the board"}
          </Row>
        </>
      ) : (
        <>
          <Row label="Messages">{a.target ? taskName(a.target) : <Mono>{act.task_id}</Mono>}</Row>
          <Row label="Message">
            <Block text={act.message} tone={tone} />
          </Row>
        </>
      )}
    </div>
  );
}

/** A change to an automation's settings, by what it changes, e.g. "Trigger" or "A new signing secret". */
const CHANGE_LABELS: Record<string, string> = {
  name: "Name",
  enabled: "On",
  trigger: "Trigger",
  action: "Action",
  generate_secret: "A new signing secret (returned to the agent)",
  secret: "Removes the signing secret: deliveries aren't checked",
  rotate_token: "A new webhook URL (the old one stops working)",
};

/** What an agent asked to do to an automation: everything a new one would run, or a change from what it does now. */
export function AutomationChangeDetail({ change }: { change: AutomationChange }) {
  const { reason, automation: a, before, op } = change;
  return (
    <div className="space-y-3 text-[13px]">
      {reason && <div className="rounded-md border-l-2 border-line-strong bg-white/[0.03] px-3 py-2 text-muted">{reason}</div>}
      {op === "update" && before && (
        <ul className="space-y-1">
          {(change.changes ?? []).map((k) => (
            <li key={k} className="flex min-w-0 items-center gap-2">
              <span className="rounded bg-st-attention/15 px-1.5 py-0.5 text-[11px] text-st-attention">{CHANGE_LABELS[k] ?? k}</span>
              {k === "name" && (
                <span className="flex min-w-0 items-center gap-2 font-mono text-[12px]">
                  <span className="truncate text-faint line-through">{before.name}</span>
                  <ArrowRight size={12} className="shrink-0 text-faint" />
                  <span className="truncate text-fg">{a.name}</span>
                </span>
              )}
              {k === "enabled" && <span className="text-[12px]">{a.enabled ? "Turns it on" : "Turns it off"}</span>}
            </li>
          ))}
        </ul>
      )}
      <div className={clsx("rounded-md border bg-[#0c0c10] px-3 py-2", op === "delete" ? "border-red-500/30" : "border-st-attention/30")}>
        {op === "update" && <div className="mb-2 text-[12px] text-muted">As it would be:</div>}
        <AutomationSummary a={a} tz={change.time_zone} />
      </div>
      {op === "update" && before && (change.changes ?? []).some((k) => k === "trigger" || k === "action") && (
        <details className="rounded-md border border-line px-3 py-2">
          <summary className="cursor-pointer text-[12px] text-muted">As it is now</summary>
          <div className="mt-2">
            <AutomationSummary a={before} tz={change.time_zone} tone="from" />
          </div>
        </details>
      )}
      {op === "delete" && <p className="text-muted">It stops running, and its history goes with it. The tasks it made stay.</p>}
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

/** Whether an approval is to delete something (a task, or an automation). */
const isDeletion = (a: Pick<Approval, "kind" | "input">) => a.kind === "delete_task" || (a.kind === "automation" && (a.input as AutomationChange).op === "delete");

const TITLES = { project: "Approve a project change?", delete_task: "Delete a task?" };

function approvalTitle(a: Approval) {
  if (isCreation(a)) return "Add a project?";
  if (a.kind === "automation") return a.input.op === "delete" ? "Delete an automation?" : "Approve an automation?";
  return TITLES[a.kind];
}

function DecideButtons({ hostId, approval, onLater }: { hostId: string; approval: Pick<Approval, "request_id" | "kind" | "input">; onLater?: () => void }) {
  const { busy, err, decide } = useDecide(hostId, approval.request_id);
  const deletion = isDeletion(approval);
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
 * Asks the user to approve each project change and automation (and confirm each task deletion) an agent is
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
          {isDeletion(a) ? (
            <Trash2 size={15} className="text-red-400" />
          ) : a.kind === "automation" ? (
            <Zap size={15} className="text-st-attention" />
          ) : isCreation(a) ? (
            <FolderPlus size={15} className="text-st-attention" />
          ) : (
            <ShieldAlert size={15} className="text-st-attention" />
          )}
          {approvalTitle(a)}
          {waiting.length > 1 && <span className="text-[12px] font-normal text-faint">1 of {waiting.length}</span>}
        </span>
      }
    >
      <Asker approval={a} />
      <div className="max-h-[55vh] overflow-auto">
        {a.kind === "delete_task" ? (
          <TaskDeletionDetail deletion={a.input} />
        ) : a.kind === "automation" ? (
          <AutomationChangeDetail change={a.input} />
        ) : isCreation(a) ? (
          <ProjectCreationDetail creation={a.input} />
        ) : (
          <ProjectChangeDetail change={a.input} />
        )}
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

/** A project change (or a new project) in its thread: the same question as the dialog, and its answer once given. */
export function ProjectChangeCard({ data, hostId }: { data: ProjectApproval | ProjectCreationApproval; hostId: string }) {
  const pending = data.status === "pending";
  const [open, setOpen] = useState(false);
  if (isCreation(data)) return <ProjectCreationCard data={data} hostId={hostId} />;
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

/** A project an agent asked to add, in its thread. */
function ProjectCreationCard({ data, hostId }: { data: ProjectCreationApproval; hostId: string }) {
  const pending = data.status === "pending";
  const [open, setOpen] = useState(false);
  return (
    <div className={clsx("rounded-lg border p-3", pending ? "border-st-attention/50 bg-st-attention/[0.06]" : "border-line bg-panel/60")}>
      <div className="mb-2 flex items-center gap-2 text-[13px]">
        <FolderPlus size={15} className={pending ? "text-st-attention" : "text-faint"} />
        <span className={clsx("min-w-0 truncate", pending ? "text-fg" : "text-muted")}>
          Add the project <span className="font-medium">{data.input.project.name}</span>
        </span>
        {!pending && <Answer status={data.status} />}
      </div>
      {pending || open ? (
        <ProjectCreationDetail creation={data.input} />
      ) : (
        <button className="truncate text-left font-mono text-[12px] text-faint hover:text-muted" onClick={() => setOpen(true)}>
          {data.input.repo_path}
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

const AUTOMATION_CARD = { create: "Add the automation", update: "Change the automation", delete: "Delete the automation" };

/** An automation an agent asked to create, change or delete, in its thread: the same question as the dialog, and its answer once given. */
export function AutomationChangeCard({ data, hostId }: { data: AutomationApproval; hostId: string }) {
  const pending = data.status === "pending";
  const [open, setOpen] = useState(false);
  const { op, automation: a } = data.input;
  const deletion = op === "delete";
  return (
    <div
      className={clsx(
        "rounded-lg border p-3",
        !pending ? "border-line bg-panel/60" : deletion ? "border-red-500/40 bg-red-500/[0.05]" : "border-st-attention/50 bg-st-attention/[0.06]",
      )}
    >
      <div className="mb-2 flex items-center gap-2 text-[13px]">
        {deletion ? (
          <Trash2 size={15} className={pending ? "text-red-400" : "text-faint"} />
        ) : (
          <Zap size={15} className={pending ? "text-st-attention" : "text-faint"} />
        )}
        <span className={clsx("min-w-0 truncate", pending ? "text-fg" : "text-muted")}>
          {AUTOMATION_CARD[op]} <span className="font-medium">{a.name}</span>
          {op === "create" ? ` to ${data.input.project.name}` : ` in ${data.input.project.name}`}
        </span>
        {!pending && <Answer status={data.status} deletion={deletion} />}
      </div>
      {pending || open ? (
        <AutomationChangeDetail change={data.input} />
      ) : (
        <button className="truncate text-left text-[12px] text-faint hover:text-muted" onClick={() => setOpen(true)}>
          {data.input.reason || (a.trigger.kind === "webhook" ? "From a webhook" : triggerText(a.trigger, data.input.time_zone ?? null))}
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
