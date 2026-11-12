import { clsx } from "clsx"
import { Cause, Exit } from "effect"
import { Bell, BellRing, Star } from "lucide-react"
import { useEffect, useState, type FormEvent, type MouseEvent } from "react"
import { mutate, type HostTask as Task } from "@huntaway/client"
import type { TaskPatch } from "@huntaway/contracts"
import { fromLocalInput, isDue, nextDue, reminderLabel, reminderPresets, toLocalInput } from "../ui/reminders"

import { Button, ContextMenu, errorText, IconButton, Input, Modal, ModalFooter, Wide, type MenuItem } from "../ui"
import { nowMillis, useNow } from "../../state/clock"
import { runExit, useAction } from "../../state/mutation"
import { after } from "../../state/timers"
import { isoOf, localeString, millisOf } from "../ui/dates"

/** Whether the task's host can star it and set reminders on it: every host on this server can. */
export function useCanMark(task: Task | undefined): boolean {
  return !!task
}

type Marks = Pick<TaskPatch, "starred" | "remind_at" | "reminder">

/** The save of a change to the task's star or reminder (`tasks.update`); the saved task comes in as an event. */
const marksSaved = (task: Task, patch: Marks) => mutate("tasks.update", task.host_id, { id: task.id, patch })

/**
 * Saves a change to the task's star or reminder, rejecting with the host's error if it fails. The saved task comes in
 * as an event. (The old board showed it straight away and put it back if the save failed, keeping what other saves in
 * flight showed; that is the client's to do, docs/plan/09-frontend.md.)
 */
export function saveMarks(task: Task, patch: Marks): Promise<void> {
  return runExit(marksSaved(task, patch)).then((exit) => (Exit.isSuccess(exit) ? undefined : Promise.reject(Cause.squash(exit.cause))))
}

/** The time, re-read every 30 seconds while any of `tasks` has a reminder, and as the next one comes round. */
export function useReminderClock(tasks: ReadonlyArray<Task>) {
  const any = tasks.some((t) => t.remind_at)
  // Every 30 seconds while there is a reminder to show (a day otherwise: nothing shows the time then).
  const ticked = useNow(any ? 30_000 : 86_400_000)
  // The time read when the next reminder came round, which a 30-second tick would show late.
  const [woke, setWoke] = useState(0)
  const now = Math.max(ticked, woke)
  const next = nextDue(tasks, now)
  // When the next one comes round, once that is within a minute (`now` is up to a tick behind the time).
  const soon = next === null || next > 60_000 ? null : now + next
  useEffect(() => {
    if (soon === null) return undefined
    return after(Math.max(0, soon - nowMillis()) + 50, () => setWoke(nowMillis()))
  }, [soon])
  return now
}

/**
 * Menu items that set the task's reminder to one of the quick choices, pick a time, or clear
 * it. `onError` gets a failed save's message.
 */
export function reminderItems(task: Task, onPick: () => void, onError: (msg: string) => void, divider = false): MenuItem[] {
  const save = (patch: Parameters<typeof saveMarks>[1]) => saveMarks(task, patch).catch((e: unknown) => onError(errorText(e)))
  return [
    ...reminderPresets(nowMillis()).map((p, i) => ({
      label: `Remind me ${p.label.charAt(0).toLowerCase()}${p.label.slice(1)}`,
      divider: divider && i === 0,
      onSelect: () => save({ remind_at: isoOf(p.at) }),
    })),
    { label: "Remind me at…", onSelect: onPick },
    ...(task.remind_at ? [{ label: "Clear reminder", onSelect: () => save({ remind_at: null }) }] : []),
  ]
}

/** The star item for a task's menu. */
export const starItem = (task: Task, onError: (msg: string) => void, divider = false): MenuItem => ({
  label: task.starred ? "Unstar" : "Star",
  divider,
  onSelect: () => void saveMarks(task, { starred: !task.starred }).catch((e: unknown) => onError(errorText(e))),
})

/** Sets the task's reminder to a time picked, with a note on what it's for. */
export function ReminderModal({ task, onClose }: { task: Task; onClose: () => void }) {
  const [at, setAt] = useState(() => toLocalInput(task.remind_at ? millisOf(task.remind_at) : (reminderPresets(nowMillis())[2]?.at ?? nowMillis())))
  const [note, setNote] = useState(task.reminder ?? "")
  const [{ busy, error: err }, run] = useAction()
  const when = fromLocalInput(at)
  const save = (e?: FormEvent) => {
    e?.preventDefault()
    if (!when || busy) return
    void run(marksSaved(task, { remind_at: when, reminder: note.trim() || null })).then((exit) => {
      if (Exit.isSuccess(exit)) onClose()
    })
  }
  return (
    <Modal title={`Remind me about “${task.title}”`} onClose={onClose} onSubmit={() => save()} width="max-w-sm">
      <form onSubmit={(e) => save(e)} className="space-y-3">
        <Input autoFocus type="datetime-local" aria-label="Remind me at" value={at} onChange={(e) => setAt(e.target.value)} />
        <Input value={note} placeholder="What for (optional)" aria-label="What for" maxLength={500} onChange={(e) => setNote(e.target.value)} />
        <ModalFooter className="space-y-3">
          {err && <div className="text-xs text-red-400">{err}</div>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={busy || !when}>
              Set reminder
            </Button>
          </div>
        </ModalFooter>
      </form>
    </Modal>
  )
}

/** A task's star, which stars or unstars it. */
export function StarButton({ task, onError }: { task: Task; onError: (msg: string) => void }) {
  return (
    <IconButton
      className={clsx("h-7 w-7", task.starred && "text-amber-300 hover:text-amber-200")}
      title={task.starred ? "Unstar" : "Star (lists it in the sidebar)"}
      aria-pressed={task.starred}
      onClick={() => void saveMarks(task, { starred: !task.starred }).catch((e: unknown) => onError(errorText(e)))}
    >
      <Star size={14} fill={task.starred ? "currentColor" : "none"} />
    </IconButton>
  )
}

/** A task's bell: when its reminder is, and a menu to set or clear it. */
export function ReminderButton({ task, onError }: { task: Task; onError: (msg: string) => void }) {
  const now = useReminderClock([task])
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [picking, setPicking] = useState(false)
  const due = isDue(task, now)
  const open = (e: MouseEvent) => {
    const r = e.currentTarget.getBoundingClientRect()
    setMenu({ x: r.left, y: r.bottom + 4 })
  }
  return (
    <>
      {task.remind_at ? (
        <Button
          size="sm"
          className={clsx(due && "border-st-attention/40 text-amber-300")}
          title={`Reminder: ${localeString(task.remind_at)}${task.reminder ? ` · ${task.reminder}` : ""}`}
          onClick={open}
        >
          {due ? <BellRing size={12} /> : <Bell size={12} />} {reminderLabel(task.remind_at, now)}
        </Button>
      ) : (
        <IconButton className="h-7 w-7" title="Remind me about this later" onClick={open}>
          <Bell size={14} />
        </IconButton>
      )}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          title={task.reminder ?? (task.remind_at ? `Reminder: ${localeString(task.remind_at)}` : undefined)}
          items={reminderItems(task, () => setPicking(true), onError)}
          onClose={() => setMenu(null)}
        />
      )}
      {picking && <ReminderModal task={task} onClose={() => setPicking(false)} />}
    </>
  )
}

/** A card's or row's star and reminder, if it has them. `compact`, on a card: the reminder's icon, and its time once the card has room. */
export function TaskMarks({ task, compact }: { task: Task; compact?: boolean | undefined }) {
  const now = useReminderClock(task.remind_at ? [task] : [])
  return (
    <>
      {task.starred && (
        <span className="flex shrink-0 text-amber-300" title="Starred">
          <Star size={11} fill="currentColor" aria-label="Starred" />
        </span>
      )}
      {task.remind_at && (
        <span
          className={clsx("flex shrink-0 items-center gap-1 whitespace-nowrap", isDue(task, now) ? "text-amber-300" : "text-muted")}
          title={`Reminder: ${reminderLabel(task.remind_at, now)}, ${localeString(task.remind_at)}${task.reminder ? ` · ${task.reminder}` : ""}`}
        >
          {isDue(task, now) ? <BellRing size={11} /> : <Bell size={11} />}{" "}
          {compact ? <Wide>{reminderLabel(task.remind_at, now)}</Wide> : reminderLabel(task.remind_at, now)}
        </span>
      )}
    </>
  )
}
