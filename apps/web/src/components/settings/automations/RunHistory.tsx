import { useAtomValue } from "@effect/atom-react"
import { automationRunsAtom } from "@huntaway/client"
import type { Automation, AutomationRun, AutomationRunStatus } from "@huntaway/contracts"
import { clsx } from "clsx"
import { openTask } from "../../../state/route"
import { localeString, timeAgo } from "../../ui"
import { usd } from "./text"

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
}

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
}

const SOURCE_LABEL: Record<AutomationRun["source"], string> = { schedule: "Schedule", webhook: "Webhook", manual: "Run now" }

const OUTCOME_LABEL: Record<NonNullable<AutomationRun["outcome"]>, string> = {
  quiet: "Quiet",
  reported: "Reported",
  asked: "Waiting for you",
  stopped: "Stopped",
  failed: "Failed",
}

const OUTCOME_STYLE: Record<NonNullable<AutomationRun["outcome"]>, string> = {
  quiet: "text-faint",
  reported: "text-emerald-400",
  asked: "text-st-attention",
  stopped: "text-muted",
  failed: "text-red-400",
}

/** How a run went: for a routine's run in a thread of its own, how its agent ended (or that it's working). */
export function RunStatus({ run }: { run: AutomationRun }) {
  if (run.status === "ok" && run.outcome) return <span className={clsx("shrink-0", OUTCOME_STYLE[run.outcome])}>{OUTCOME_LABEL[run.outcome]}</span>
  if (run.status === "ok" && run.task?.running) return <span className="shrink-0 text-st-progress">Working</span>
  return <span className={clsx("shrink-0", STATUS_STYLE[run.status])}>{STATUS_LABEL[run.status]}</span>
}

/** The task a run made or messaged, as a link. */
export function RunTask({ run }: { run: AutomationRun }) {
  const id = run.task_id
  if (!id) return null
  if (!run.task) return <span className="text-faint">(task deleted)</span>
  const task = run.task
  return (
    <button type="button" className="min-w-0 truncate text-left text-muted hover:text-fg hover:underline" onClick={() => openTask(id)} title={task.title}>
      <span className="font-mono">{task.key}</span> {task.title}
    </button>
  )
}

/** An automation's latest runs and deliveries, read again as they change. */
export function RunHistory({ hostId, automation }: { hostId: string; automation: Automation }) {
  const { data, failed } = useAtomValue(automationRunsAtom({ host_id: hostId, automation_id: automation.id }))
  if (failed && !data) return <div className="mt-2 text-xs text-red-400">{failed}</div>
  const runs = data?.runs
  if (!runs) return null
  if (!runs.length) return <div className="mt-2 pl-4 text-[11.5px] text-faint">Nothing yet.</div>
  return (
    <div className="mt-2 max-h-72 space-y-1 overflow-y-auto pl-4" data-testid="automation-runs">
      {runs.map((r) => (
        <div key={r.id} className="text-[11.5px]">
          <div className="flex min-w-0 items-center gap-2">
            <span className="w-16 shrink-0 text-faint" title={localeString(r.created_at)}>
              {timeAgo(r.created_at)}
            </span>
            <span className="w-16 shrink-0 text-faint">{SOURCE_LABEL[r.source]}</span>
            <RunStatus run={r} />
            {r.event && <span className="shrink-0 font-mono text-faint">{r.event}</span>}
            {r.count > 1 && <span className="shrink-0 text-faint">×{r.count}</span>}
            <RunTask run={r} />
            {!!r.cost_usd && <span className="ml-auto shrink-0 text-faint">{usd(r.cost_usd)}</span>}
          </div>
          {r.detail && r.status !== "duplicate" && <div className="pl-[8.5rem] break-words text-faint">{r.detail}</div>}
        </div>
      ))}
    </div>
  )
}
