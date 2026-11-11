import { PERMISSION_MODES, STATUSES } from "@huntaway/client"
import { clsx } from "clsx"
import { ArrowRight } from "lucide-react"
import type { ReactNode } from "react"
import { toJson } from "../../ui"
import type { Any } from "./threadModel"

// What one of the board's own approvals asks, in detail (the old task/Approvals.tsx `ProjectChangeDetail`,
// `ProjectCreationDetail` and `TaskDeletionDetail`, step 1 of docs/plan/09-frontend.md): a project's change setting by
// setting, a project to add (its folder, and what its agents could do there), a task to delete. The input is the
// approval's as the server asked it (`Approvals`, plan task 3.4).

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
  auto_summary: "Summarise each task's changes",
  summarizers: "Summarizers",
  use_workflows: "Workflows take its tasks across the board",
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
}

/** Settings shown as blocks of text rather than inline. */
const LONG: ReadonlySet<string> = new Set([
  "start_prompt",
  "review_prompt",
  "merge_prompt",
  "setup_script",
  "teardown_script",
  "copy_files",
  "link_folders",
  "status_script",
  "status_scripts",
  "reviewers",
  "summarizers",
])

function valueText(field: string, v: Any): string {
  if (v === null || v === undefined) return field === "group_name" ? "(none)" : "(default)"
  if (typeof v === "boolean") return v ? "On" : "Off"
  if (field === "permission_mode") return PERMISSION_MODES.find((m) => m.id === v)?.label ?? String(v)
  if (field === "status_scripts" && typeof v === "object") {
    const entries: Array<[string, string]> = Object.entries(v)
    return entries.length ? entries.map(([status, script]) => `# ${status}\n${script}`).join("\n\n") : ""
  }
  if (Array.isArray(v)) return v.map((x) => toJson(x)).join("\n")
  if (typeof v === "object") return toJson(v)
  return String(v)
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
  )
}

function Reason({ text }: { text: unknown }) {
  return typeof text === "string" && text ? <div className="rounded-md border-l-2 border-line-strong bg-white/[0.03] px-3 py-2 text-muted">{text}</div> : null
}

/** What an agent asked to change about a project, setting by setting. */
export function ProjectChangeDetail({ change }: { change: Any }) {
  const changes: Any[] = Array.isArray(change?.changes) ? change.changes : []
  return (
    <div className="space-y-3 text-[13px]">
      <Reason text={change?.reason} />
      <ul className="space-y-3">
        {changes.map((c) => {
          const from = valueText(c.field, c.from)
          const to = valueText(c.field, c.to)
          return (
            <li key={c.field}>
              <div className="mb-1 flex items-center gap-2 text-[12px]">
                <span className="font-medium text-fg">{LABELS[c.field] ?? c.field}</span>
                {c.needs_approval && <span className="rounded bg-st-attention/15 px-1.5 py-0.5 text-[11px] text-st-attention">needs approval</span>}
              </div>
              {LONG.has(c.field) ? (
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
          )
        })}
      </ul>
    </div>
  )
}

/** One line of a summary: a label, and what it is. */
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[7.5rem_1fr] items-baseline gap-2">
      <span className="text-[12px] text-faint">{label}</span>
      <div className="min-w-0 text-fg">{children}</div>
    </div>
  )
}

const Mono = ({ children }: { children: ReactNode }) => <span className="font-mono text-[12px] break-words">{children}</span>

/** A project an agent asked to add: where it is, and what its agents would be allowed to do there. */
export function ProjectCreationDetail({ creation }: { creation: Any }) {
  const mode = PERMISSION_MODES.find((m) => m.id === creation?.permission_mode)?.label ?? creation?.permission_mode
  return (
    <div className="space-y-3 text-[13px]">
      <Reason text={creation?.reason} />
      <div className="space-y-2 rounded-md border border-st-attention/30 bg-[#0c0c10] px-3 py-2">
        <Row label="Folder">
          <Mono>{creation?.repo_path}</Mono>
          {!creation?.exists ? (
            <div className="text-[12px] text-amber-200/90">Doesn't exist yet: it's created.</div>
          ) : (
            !creation?.git && <div className="text-[12px] text-faint">Not a git repository.</div>
          )}
        </Row>
        <Row label="Name">
          {creation?.project?.name} <span className="font-mono text-[12px] text-faint">{creation?.project?.key}</span>
        </Row>
        <Row label="Board">{creation?.board}</Row>
        <Row label="Permission mode">{mode} (the host's default)</Row>
      </div>
      <p className="text-muted">
        Its tasks' agents work in this folder, and can read and change what's in it. Agents can start them straight away, with that permission mode.
      </p>
    </div>
  )
}

const statusLabel = (s: string) => STATUSES.find((x) => x.id === s)?.label ?? s

/** What deleting a task an agent asked to delete would delete. */
export function TaskDeletionDetail({ deletion }: { deletion: Any }) {
  const d = deletion?.delete ?? {}
  return (
    <div className="space-y-3 text-[13px]">
      <Reason text={deletion?.reason} />
      <div className="rounded-md border border-red-500/30 bg-[#0c0c10] px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 font-mono text-[12px] text-faint">{d.key}</span>
          <span className="truncate text-fg">{d.title}</span>
          <span className="ml-auto shrink-0 text-[11px] text-faint">{statusLabel(d.status)}</span>
        </div>
      </div>
      <p className="text-muted">
        This stops any running agent, deletes the thread, and removes its worktree, discarding any uncommitted changes.
        {d.running && <span className="text-amber-200/90"> Its agent is running now.</span>}
      </p>
      {d.branch && (
        <p className="text-muted">
          The branch <span className="font-mono text-fg">{d.branch}</span> {deletion?.delete_branch ? "is deleted too." : "is kept."}
        </p>
      )}
    </div>
  )
}
