import { clsx } from "clsx"
import { Bell, BellRing } from "lucide-react"
import { useState, type DragEvent } from "react"
import type { HostTask as Task } from "@huntaway/client"
import { ContextMenu } from "../../ui"
import { isDue } from "../../ui/reminders"
import { reminderItems } from "../../task/Reminders"
import { TaskCard } from "../TaskCard"
import { board } from "../../../state/board"
import { BIN_BOX, Bin, BinHeader } from "./Bin"
import type { CardsProps } from "./Cards"
import { FROM_REMINDERS } from "./model"

/**
 * The kanban board's Reminders bin, beside Ready for merge in its header (HE-52): the tasks with a reminder, soonest
 * first. One whose reminder is still to come isn't in its column (useBoardTasks' `snooze`); once it comes round it's
 * back there, and still here as due. A task dropped on the bin is asked when to be reminded about it; a card dragged
 * out of it into a column goes there without its reminder.
 */
export function ReminderBin({ board: tasks, drops, menus, labelled }: CardsProps & { labelled: boolean }) {
  const { reminders, reminderNow, projectOf, progressOf } = tasks
  const due = reminders.filter((t) => isDue(t, reminderNow)).length
  // A task is dragged over it; one dropped on it, and where, for the menu of when to be reminded.
  const [hot, setHot] = useState(false)
  const [asking, setAsking] = useState<{ x: number; y: number; task: Task } | null>(null)
  const onDragOver = (e: DragEvent) => {
    if (!e.dataTransfer.types.includes("text/task-id")) return
    e.preventDefault()
    if (!hot) setHot(true)
  }
  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    setHot(false)
    const task = board.get().tasks[e.dataTransfer.getData("text/task-id")]
    if (task) setAsking({ x: e.clientX, y: e.clientY, task })
  }
  const Icon = due ? BellRing : Bell
  return (
    <>
      <Bin
        icon={<Icon size={13} className={due ? "text-amber-300" : undefined} />}
        name="Reminders"
        count={reminders.length}
        title={`Reminders: ${reminders.length} task${reminders.length === 1 ? "" : "s"}${due ? `, ${due} due` : ""}. Drop a task here to be reminded about it`}
        labelled={labelled}
        hot={hot}
        tone={{ hot: "border-amber-300 bg-amber-300/15 text-fg ring-2 ring-amber-300/30", open: "border-amber-300/60 bg-amber-300/10 text-fg" }}
        label={{ "data-bin": "reminders", onDragOver, onDrop }}
        onLeave={() => setHot(false)}
      >
        <section
          aria-label="Reminders"
          onDragOver={onDragOver}
          onDrop={onDrop}
          // Carried out to a column, it's no longer waiting on its reminder.
          onDragStart={(e) => e.dataTransfer.setData(FROM_REMINDERS, "1")}
          className={clsx(BIN_BOX, hot ? "border-amber-300/60" : "border-line-strong")}
        >
          <BinHeader icon={<Icon size={14} className="text-amber-300" />} name="Reminders" count={reminders.length} note="soonest first" />
          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-2 pt-px pb-3">
            {reminders.map((t) => (
              <TaskCard key={t.id} task={t} project={projectOf(t)} progress={progressOf(t)} onMenu={menus.onMenu} />
            ))}
            {reminders.length === 0 && (
              <div className="px-2 py-6 text-center text-[12px] text-faint">Drop a task here to be reminded about it: it leaves its column until then</div>
            )}
          </div>
        </section>
      </Bin>
      {asking && (
        <ContextMenu
          x={asking.x}
          y={asking.y}
          title="Remind me about it"
          items={reminderItems(asking.task, () => menus.setPicking(asking.task), drops.setDropErr)}
          onClose={() => setAsking(null)}
        />
      )}
    </>
  )
}
