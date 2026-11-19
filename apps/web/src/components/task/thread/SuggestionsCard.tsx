// A suggestions card (HE-61): the assistant, with suggest_task_actions, lists tasks it suggests doing something with
// (move to Done, merge, remind me later…), each with its reason. Every row has a button for each action it offers (the
// recommended one first, highlighted) and Leave it; a click does it on the board (`threads.actOnSuggestion`) and the row
// says what was done. A move asks first what the same move on the board asks (`useConfirmDone`, `useConfirmTodos`).
// Rows are settled one at a time, whenever the user gets to them: nothing waits on the card. Each row shows its task as
// it is now, and opens it.
import { mutate } from "@huntaway/client"
import type { Status, SuggestionChoice, TaskSuggestion, TaskSuggestions } from "@huntaway/contracts"
import { TaskId } from "@huntaway/contracts"
import { clsx } from "clsx"
import { ListChecks, Loader2 } from "lucide-react"
import { memo, useState } from "react"
import { useBoard } from "../../../state/board"
import { useAction } from "../../../state/mutation"
import { openTaskModal } from "../../../state/route"
import { useConfirmDone } from "../../board/ConfirmDone"
import { useConfirmTodos, type TaskUpdateOptions } from "../../board/ConfirmTodos"
import { statusLabel } from "../../board/StackedOn"
import { Button } from "../../ui"
import { localeString } from "../../ui/dates"
import { useThread } from "./context"
import { Frame, Outcome } from "./requestCards"

/** What a reminder's time reads as on its button: a delay (`3d`) as "in 3d", a date as "on 2026-12-01". */
const remindLabel = (at: string | null) => {
  const v = (at ?? "1d").trim()
  return /^(in\s)?\d+\s*[a-z]/i.test(v) && !/^\d{4}-/.test(v) ? `Remind me ${v.startsWith("in ") ? v : `in ${v}`}` : `Remind me on ${v}`
}

/** Each action's button. */
const LABELS: { readonly [C in SuggestionChoice]: string } = {
  done: "Move to Done",
  wont_fix: "Close as won't fix",
  merge: "Merge",
  remind: "Remind me",
  backlog: "Move to Backlog",
  start: "Start",
  message: "Send the message",
  delete: "Delete",
  keep: "Leave it",
}
const label = (choice: SuggestionChoice, row: TaskSuggestion): string => (choice === "remind" ? remindLabel(row.remind_at) : LABELS[choice])

/** What a settled row says was done. */
const DONE: { readonly [C in SuggestionChoice]: string } = {
  done: "Moved to Done",
  wont_fix: "Closed as won't fix",
  merge: "Sent to merge",
  remind: "Reminder set",
  backlog: "Moved to Backlog",
  start: "Started",
  message: "Message sent",
  delete: "Deleted",
  keep: "Left as it is",
}
const done = (row: TaskSuggestion): string => {
  const o = row.outcome
  if (!o) return ""
  if (o.choice === "remind" && o.remind_at)
    return `Reminder set for ${localeString(o.remind_at, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}`
  return DONE[o.choice]
}

/** The column each pick that moves its task moves it to (the server's `Suggestions` MOVES). */
const MOVES_TO: { readonly [C in SuggestionChoice]?: Status } = { done: "done", wont_fix: "done", merge: "ready_for_merge", backlog: "backlog" }

export const SuggestionsCard = memo(function SuggestionsCard({ itemId, data, hostId }: { itemId: string; data: TaskSuggestions; hostId: string }) {
  const threadId = useThread((t) => t.taskId)
  const left = data.suggestions.filter((s) => s.outcome === null).length
  return (
    <Frame pending={left > 0} label={data.title}>
      <div className="mb-1.5 flex items-center gap-2 text-[12px] text-faint">
        <ListChecks size={14} className={left > 0 ? "text-st-attention" : "text-faint"} />
        The assistant suggests what to do with {data.suggestions.length === 1 ? "a task" : `${data.suggestions.length} tasks`}
        {left === 0 ? <Outcome tone="good">all done</Outcome> : <Outcome tone="plain">{left} to go</Outcome>}
      </div>
      <div className={clsx("text-[13.5px] font-semibold", left > 0 ? "text-fg" : "text-muted")}>{data.title}</div>
      <ul className="mt-2 divide-y divide-line" data-testid="suggestions">
        {data.suggestions.map((row, index) => (
          <SuggestionRow key={row.task_id} row={row} index={index} itemId={itemId} threadId={threadId} hostId={hostId} />
        ))}
      </ul>
    </Frame>
  )
})

function SuggestionRow({ row, index, itemId, threadId, hostId }: { row: TaskSuggestion; index: number; itemId: string; threadId: string; hostId: string }) {
  const task = useBoard((s) => s.tasks[row.task_id])
  const [action, run] = useAction()
  const [doing, setDoing] = useState<SuggestionChoice | null>(null)
  // Delete asks once more.
  const [confirm, setConfirm] = useState(false)
  // A move asks first what the board's own moves ask: Done with work that isn't merged, closing a task others merge into
  // or land after, leaving In progress with the agent's todo list unfinished.
  const { confirmDone, dialog: doneDialog } = useConfirmDone()
  const { confirmTodos, dialog: todosDialog } = useConfirmTodos()
  const asked = (choice: SuggestionChoice): Promise<TaskUpdateOptions | null> => {
    const status = MOVES_TO[choice]
    if (!status || !task) return Promise.resolve({})
    const closing = choice === "done" || choice === "wont_fix" ? confirmDone(task, choice) : Promise.resolve(true)
    return closing.then((go) => (go ? confirmTodos(task, status) : null))
  }
  const pick = (choice: SuggestionChoice) => {
    if (choice === "delete" && !confirm) return setConfirm(true)
    void asked(choice).then((options) => {
      if (options === null) return
      setDoing(choice)
      void run(mutate("threads.actOnSuggestion", hostId, { task_id: TaskId.make(threadId), item_id: itemId, index, choice, ...options }))
    })
  }
  const settled = row.outcome !== null
  const busy = action.busy ? doing : null
  return (
    <li className={clsx("py-2", settled && "opacity-70")} data-testid="suggestion">
      <div className="flex min-w-0 items-baseline gap-2 text-[13px]">
        <button
          type="button"
          className="shrink-0 font-mono text-[12px] text-faint hover:text-fg hover:underline"
          onClick={() => openTaskModal(row.task_id)}
          title="Open the task"
        >
          {row.key}
        </button>
        <span className={clsx("min-w-0 truncate", settled ? "text-muted" : "text-fg")}>{task?.title ?? row.title}</span>
        {task ? <span className="shrink-0 rounded bg-white/5 px-1.5 py-0.5 text-[11px] text-faint">{statusLabel(task)}</span> : null}
        {settled && <Outcome tone={row.outcome?.choice === "keep" ? "plain" : "good"}>{done(row)}</Outcome>}
      </div>
      <div className="mt-0.5 text-[12.5px] whitespace-pre-wrap text-muted">{row.reason}</div>
      {row.message && !settled && <div className="mt-1 border-l-2 border-line pl-2 text-[12px] whitespace-pre-wrap text-faint">{row.message}</div>}
      {!settled && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {row.actions.map((choice, i) => (
            <Button
              key={choice}
              size="sm"
              variant={choice === "delete" ? "danger" : i === 0 ? "primary" : "secondary"}
              disabled={!!busy}
              onClick={() => pick(choice)}
              title={i === 0 ? "What the assistant recommends" : undefined}
            >
              {busy === choice && <Loader2 size={12} className="animate-spin" />}
              {choice === "delete" && confirm ? "Really delete?" : label(choice, row)}
            </Button>
          ))}
          <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => pick("keep")}>
            {busy === "keep" && <Loader2 size={12} className="animate-spin" />}
            Leave it
          </Button>
        </div>
      )}
      {action.error && <div className="mt-1 text-xs text-red-400">{action.error}</div>}
      {doneDialog}
      {todosDialog}
    </li>
  )
}
