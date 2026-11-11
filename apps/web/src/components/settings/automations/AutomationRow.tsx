import { clsx } from "clsx"
import { ChevronDown, ChevronRight, Clock, Play, Trash2, Webhook } from "lucide-react"
import { useState, type ReactNode } from "react"
import type { HostProject as Project } from "@huntaway/client"
import type { Automation } from "@huntaway/contracts"
import { useBoard } from "../../../state/board"
import { Button, Toggle, timeAgo } from "../../ui"
import { type TimeZone, triggerText, timeUntil, localTime } from "./text"
import { RunStatus, RunHistory } from "./RunHistory"

/** A project automation's row: the shared row, saying what it does. */
export function ProjectAutomationRow({
  automation: a,
  project,
  ...row
}: { project: Project } & Pick<Parameters<typeof AutomationRow>[0], "automation" | "tz" | "onToggle" | "onEdit" | "onRun" | "onDelete">) {
  const target = useBoard((s) => (a.action.kind === "send_to_task" ? s.tasks[a.action.task_id] : undefined))
  const runsWith = a.action.kind === "create_task" ? [a.action.model, a.action.effort && `${a.action.effort} effort`].filter(Boolean).join(", ") : ""
  const what =
    a.action.kind === "create_task"
      ? `Creates "${a.action.title}"${a.action.start ? " and starts its agent" : ""}${runsWith ? ` (${runsWith})` : ""}`
      : `Messages ${target ? `${project.key}-${target.number} ${target.title}` : "a task"}`
  const last = a.last_run
  return (
    <AutomationRow
      {...row}
      automation={a}
      hostId={project.host_id}
      detail={what}
      webhookRun={{ label: "Test", title: "Send it a test delivery" }}
      lastWord={a.trigger.kind === "webhook" && last?.source === "webhook" ? "delivery" : "run"}
      lastDetail={last?.task && <span className="truncate">{last.task.key}</span>}
      off="Off"
    />
  )
}

/**
 * An automation's row in a list (a project's automations, the assistant's routines): its toggle, name and trigger, the
 * buttons that run, edit and delete it, and its last and next run, which open its run history. The lists differ in
 * what they say it does (`detail`), what a webhook's run button says (`webhookRun`), what follows the last run's status
 * (`lastDetail`) and the word for one that's off (`off`); `aside` goes before the buttons.
 */
export function AutomationRow({
  automation: a,
  hostId,
  tz,
  detail,
  aside,
  webhookRun,
  lastWord,
  lastDetail,
  off,
  testId,
  onToggle,
  onEdit,
  onRun,
  onDelete,
}: {
  automation: Automation
  hostId: string
  tz: TimeZone | null
  detail: ReactNode
  aside?: ReactNode | undefined
  webhookRun: { label: string; title: string }
  /** "Last run 5m ago:", or with none "Last 5m ago:". */
  lastWord?: string | undefined
  lastDetail?: ReactNode | undefined
  off: string
  testId?: string | undefined
  onToggle: (enabled: boolean) => void
  onEdit: () => void
  onRun: () => unknown
  onDelete: () => void
}) {
  const [open, setOpen] = useState(false)
  const [running, setRunning] = useState(false)
  const last = a.last_run
  const webhook = a.trigger.kind === "webhook"
  return (
    <div className="px-3 py-2" data-testid={testId}>
      <div className="flex items-center gap-3">
        <Toggle checked={a.enabled} onChange={onToggle} label="" />
        <button type="button" className="min-w-0 flex-1 text-left" onClick={onEdit}>
          <div className={clsx("flex items-center gap-1.5 text-[13px]", !a.enabled && "text-faint")}>
            {webhook ? <Webhook size={13} className="shrink-0 text-muted" /> : <Clock size={13} className="shrink-0 text-muted" />}
            <span className="truncate font-medium">{a.name}</span>
          </div>
          <div className="truncate text-[11.5px] text-faint">
            {triggerText(a.trigger, tz)} · {detail}
          </div>
        </button>
        {aside}
        <Button
          size="sm"
          variant="ghost"
          disabled={running}
          title={webhook ? webhookRun.title : "Run it now, whether or not it's on"}
          onClick={() => {
            setRunning(true)
            void Promise.resolve(onRun()).finally(() => setRunning(false))
          }}
        >
          <Play size={12} /> {webhook ? webhookRun.label : "Run now"}
        </Button>
        <Button size="sm" variant="ghost" onClick={onEdit}>
          Edit
        </Button>
        <Button size="sm" variant="ghost" onClick={onDelete} title="Delete">
          <Trash2 size={13} />
        </Button>
      </div>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="mt-1 flex w-full min-w-0 items-center gap-1.5 text-left text-[11.5px] text-faint hover:text-muted"
      >
        {open ? <ChevronDown size={12} className="shrink-0" /> : <ChevronRight size={12} className="shrink-0" />}
        {last ? (
          <>
            <span className="shrink-0">
              Last {lastWord && `${lastWord} `}
              {timeAgo(last.created_at)}:
            </span>
            <RunStatus run={last} />
            {lastDetail}
          </>
        ) : (
          <span>{webhook ? "No deliveries yet" : "Hasn't run yet"}</span>
        )}
        {a.enabled && a.next_run_at && (
          <span className="ml-auto shrink-0" title={new Date(a.next_run_at).toLocaleString()}>
            Next {timeUntil(a.next_run_at)} ({localTime(a.next_run_at)})
          </span>
        )}
        {!a.enabled && <span className="ml-auto shrink-0">{off}</span>}
      </button>
      {open && <RunHistory hostId={hostId} automation={a} />}
    </div>
  )
}
