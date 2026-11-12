import {
  canRunAgents,
  dependencyQueued,
  hostStatuses,
  limitQueued,
  mergeAwaitsApproval,
  mergeQueued,
  outOfUsage,
  rejoinsMerge,
  type HostTask as Task,
} from "@huntaway/client"
import type { Host, Resolution, Status } from "@huntaway/contracts"
import { clsx } from "clsx"
import { useState } from "react"
import { useNow } from "../../../../state/clock"
import { exitError, useMutation } from "../../../../state/mutation"
import { moveTask, useProject } from "../../../boardHelpers"
import { useConfirmTodos, type TaskUpdateOptions } from "../../../board/ConfirmTodos"
import { useStackWait } from "../../../board/StackedOn"
import { errorText, localeString, millisOf, RESOLUTION_LABELS, RunningDot, StatusIcon } from "../../../ui"
import { resetsIn, resetTime } from "../../../ui/usageConfigs"
import { saveMarks } from "../../Reminders"
import { useThreadConfig } from "../hooks"
import { Section } from "./Section"
import { MoreFixRounds } from "../../Review"

// Cut until its area comes: "Carry on then" for a
// task out of usage (`waitForLimit`, with Usage in 2.8).

/** When a usage limit resets, as a phrase: "resets in 2h 5m", "resets Sun 2 Nov", "has reset". */
function resetsPhrase(iso: string, now: number) {
  const ms = millisOf(iso) - now
  if (Number.isNaN(ms)) return ""
  if (ms <= 0) return "has reset"
  return ms < 24 * 3600_000 ? `resets in ${resetsIn(iso, now)}` : `resets ${resetsIn(iso, now)}`
}

const RESOLUTIONS: ReadonlyArray<Resolution> = ["done", "not_done", "wont_fix"]

/** The task's status, to move it on, with what it's waiting for. `confirmDone` asks before it's moved to Done. */
export function StatusSection({
  task,
  host,
  confirmDone,
}: {
  task: Task
  host: Host | undefined
  confirmDone: (task: Task, resolution?: Resolution) => Promise<boolean>
}) {
  const [err, setErr] = useState<string | null>(null)
  // A stack level's merge waits for the one below it (API 142), not for another merge.
  const stackWait = useStackWait(task, useProject(task.project_id))
  // Asks before a task whose todo list isn't complete leaves In progress (API 148).
  const { confirmTodos, dialog: todosDialog } = useConfirmTodos()
  const [, send] = useMutation("tasks.send")
  const [, update] = useMutation("tasks.update")
  const failed = (exit: Parameters<typeof exitError>[0]) => {
    const why = exitError(exit)
    if (why !== null) setErr(why)
  }
  /** What the move adds, once the todo list (and, for Done, `confirmDone`) let it go; null to leave it where it is. */
  const asked = (status: Status): Promise<TaskUpdateOptions | null> =>
    confirmTodos(task, status).then((anyway) => (anyway && status === "done" ? confirmDone(task).then((ok) => (ok ? anyway : null)) : anyway))
  const setStatus = (status: Status) => {
    setErr(null)
    void asked(status).then((anyway) => {
      if (!anyway) return undefined
      return moveTask(task, { ...anyway, status }).then(
        () => {
          // Moving a fresh task into In progress starts its agent, with the empty message (the old client's `moveTask`).
          const starts = status === "in_progress" && task.status !== "in_progress" && !task.session_id && !task.running && canRunAgents(host)
          if (starts) void send(task.host_id, { id: task.id, text: "" }).then(failed)
        },
        (e: unknown) => setErr(errorText(e)),
      )
    })
  }
  const setResolution = (resolution: Resolution) => {
    setErr(null)
    void update(task.host_id, { id: task.id, patch: { resolution } }).then(failed)
  }
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
      {task.status === "done" && (
        <div className="mt-2 flex items-center gap-2 text-[12px]">
          <span className="text-faint">Resolution</span>
          <div className="ml-auto flex items-center rounded-md border border-line p-0.5">
            {RESOLUTIONS.map((r) => (
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
          {stackWait ?? "Queued to merge. Another task in this project is merging; this one starts when it's done."}
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
      <UsageLimitNote task={task} />
      {task.remind_at && (
        <div className="mt-2 flex items-start gap-2 rounded-md bg-white/[0.03] px-2.5 py-2 text-[12px] text-muted">
          <span className="min-w-0 flex-1">
            Reminder {localeString(task.remind_at, { dateStyle: "medium", timeStyle: "short" }, [])}
            {task.reminder && <span className="block text-fg">{task.reminder}</span>}
          </span>
          <button
            className="shrink-0 text-faint hover:text-fg"
            onClick={() => void saveMarks(task, { remind_at: null }).catch((e: unknown) => setErr(errorText(e)))}
          >
            Clear
          </button>
        </div>
      )}
      {err && <div className="mt-2 rounded bg-red-500/10 p-2 text-[11.5px] whitespace-pre-wrap text-red-300">{err}</div>}
      {todosDialog}
    </Section>
  )
}

/**
 * A task held until its config's usage limit resets, or one whose agent ran out of usage, which can wait for the reset
 * (API 81). After the reset, sending a message carries on.
 */
function UsageLimitNote({ task }: { task: Task }) {
  const at = task.limit_reset_at
  return at ? <UsageLimitNoteAt task={task} at={at} /> : null
}

/** The note for a limit that resets at `at`, read again every 30 seconds while it's shown. */
function UsageLimitNoteAt({ task, at }: { task: Task; at: string }) {
  const { current } = useThreadConfig(task)
  const now = useNow(30_000)
  const name = current?.name ?? "Its config"
  const when = `${resetsPhrase(at, now)} (${resetTime(at)})`
  if (limitQueued(task)) {
    return (
      <div className="mt-2 rounded-md bg-white/[0.03] px-2.5 py-2 text-[12px] text-muted" data-usage-limit="waiting">
        Waiting for {name}'s usage limit to reset: it {when}. Its agent carries on then, with any message you queue.
      </div>
    )
  }
  if (!outOfUsage(task, now)) return null
  return (
    <div className="mt-2 flex items-start gap-2 rounded-md bg-white/[0.03] px-2.5 py-2 text-[12px] text-muted" data-usage-limit="out">
      <span className="min-w-0 flex-1">
        {name} is out of usage; it {when}.{/* Waiting in In progress would give up its merge slot, so another merge could start alongside it. */}
        {task.merging && " Its merge keeps its place in the merge queue: message its agent once it has reset to carry on."}
      </span>
    </div>
  )
}
