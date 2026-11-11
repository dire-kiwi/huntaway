// An assistant's tracked work (HA-326, API 146) in its details: what it's doing or following for the user, as its MCP
// `track_work` tool keeps it on its task (`Task.tracked`), so task events keep it live. An item that follows a board task
// shows that task's key and status, and shows as done once it is. Items come off the list with `tasks.removeTracked` (6.7).
import { isMerged, STATUSES, trackedStatus, type HostTask as Task, type TrackedStatus } from "@huntaway/client"
import type { TrackedItem } from "@huntaway/contracts"
import { clsx } from "clsx"
import { CircleCheck, CircleDot, CircleX, Hourglass, MessageCircleQuestion, type LucideIcon } from "lucide-react"
import { useState, type MouseEvent } from "react"
import { useBoard } from "../../../../state/board"
import { useRpc } from "../../../../state/rpc"
import { openTaskModal, useTaskModal } from "../../../../state/route"
import { ContextMenu, errorText, StatusIcon, type MenuItem } from "../../../ui"
import { Section } from "./Section"

const LOOK: Record<TrackedStatus, { icon: LucideIcon; tone: string; label: string }> = {
  working: { icon: CircleDot, tone: "text-sky-400", label: "Working on it" },
  waiting_user: { icon: MessageCircleQuestion, tone: "text-amber-300", label: "Waiting on you" },
  waiting_task: { icon: Hourglass, tone: "text-violet-300", label: "Waiting on a task" },
  done: { icon: CircleCheck, tone: "text-emerald-400", label: "Done" },
  failed: { icon: CircleX, tone: "text-red-400", label: "Failed" },
}

const HIDE_DONE_KEY = "ia.details.trackedHideDone"

const statusLabel = (t: Task) => (t.status === "done" ? (isMerged(t) ? "merged" : "closed") : (STATUSES.find((s) => s.id === t.status)?.label ?? t.status))

const loadHideDone = () => {
  try {
    return localStorage.getItem(HIDE_DONE_KEY) === "1"
  } catch {
    return false
  }
}

/** Opens what an item follows: its task over the page, or its link. */
const open = (item: TrackedItem, linked: Task | undefined) => {
  if (linked) openTaskModal(linked.id)
  else if (item.url) window.open(item.url, "_blank", "noopener")
}

/** The items of assistant `task`'s list, with the tasks they follow. */
export function TrackedWork({ task }: { task: Task }) {
  const tasks = useBoard((s) => s.tasks)
  const modalTask = useTaskModal()
  const [hideDone, setHideDoneState] = useState(loadHideDone)
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[]; title: string } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const rpc = useRpc()
  const items = task.tracked

  const setHideDone = (on: boolean) => {
    setHideDoneState(on)
    try {
      localStorage.setItem(HIDE_DONE_KEY, on ? "1" : "0")
    } catch {
      /* ignore */
    }
  }
  const rows = items.map((item) => {
    const linked = item.task_id ? tasks[item.task_id] : undefined
    return { item, linked, status: trackedStatus(item, linked) }
  })
  const done = rows.filter((r) => r.status === "done")
  const waiting = rows.filter((r) => r.status === "waiting_user").length
  const shown = hideDone ? rows.filter((r) => r.status !== "done") : rows
  // What comes back arrives as the task's event.
  const remove = (ids: string[]) => {
    setErr(null)
    rpc(task.host_id, "tasks.removeTracked", { id: task.id, ids }).catch((e: unknown) => setErr(errorText(e)))
  }
  const itemMenu = (e: MouseEvent, item: TrackedItem, linked: Task | undefined) => {
    e.preventDefault()
    const url = item.url
    setMenu({
      x: e.clientX,
      y: e.clientY,
      title: item.title,
      items: [
        ...(linked ? [{ label: `Open ${item.task_key ?? "the task"}`, onSelect: () => openTaskModal(linked.id) }] : []),
        ...(url ? [{ label: "Open link", onSelect: () => void window.open(url, "_blank", "noopener") }] : []),
        { label: "Remove from the list", divider: !!(linked || url), onSelect: () => remove([item.id]) },
      ],
    })
  }

  return (
    <Section
      title={`Working on${rows.length ? ` · ${rows.length - done.length}` : ""}`}
      collapsible="tracked"
      open
      right={
        waiting > 0 && (
          <span title={`${waiting} waiting on you`} className="rounded-full bg-st-attention/20 px-1.5 text-[10.5px] leading-4 font-semibold text-amber-300">
            {waiting} waiting on you
          </span>
        )
      }
    >
      <div role="group" aria-label="Tracked work" className="-mx-1.5 space-y-0.5">
        {!rows.length && <div className="px-1.5 text-[12.5px] text-faint">Nothing yet: the assistant lists here what it's doing or following for you.</div>}
        {shown.map(({ item, linked, status }) => {
          const look = LOOK[status]
          const Icon = look.icon
          // What the assistant last said, unless the task it follows has moved on since (see trackedStatus): then where that is.
          const behind = !!linked && status !== item.status
          const note = behind ? `${item.task_key ?? "Its task"} is ${statusLabel(linked).toLowerCase()}` : item.note
          const tip = [
            look.label,
            behind && item.note && `The assistant's last note: ${item.note}`,
            item.task_key && `${item.task_key}${linked ? `: ${linked.title} (${statusLabel(linked)})` : ""}`,
            item.url,
            `Updated ${new Date(item.updated_at).toLocaleString()}`,
          ]
            .filter(Boolean)
            .join("\n")
          const clickable = !!(linked || item.url)
          return (
            <button
              key={item.id}
              title={tip}
              data-status={status}
              onClick={() => open(item, linked)}
              onContextMenu={(e) => itemMenu(e, item, linked)}
              className={clsx(
                "flex w-full items-start gap-2 rounded-md px-1.5 py-1 text-left",
                linked && modalTask === linked.id ? "bg-raised text-fg" : "text-muted hover:bg-white/[0.04] hover:text-fg",
                !clickable && "cursor-default",
                status === "done" && "opacity-60",
              )}
            >
              <Icon size={13} className={clsx("mt-[3px] shrink-0", look.tone)} aria-label={look.label} />
              <span className="min-w-0 flex-1">
                <span className="block text-[12.5px] leading-5 break-words">{item.title}</span>
                {note && <span className="block text-[11.5px] leading-4 text-faint">{note}</span>}
              </span>
              {item.task_key && (
                <span className="mt-[3px] flex shrink-0 items-center gap-1 font-mono text-[10.5px] text-faint">
                  {item.task_key}
                  {linked && <StatusIcon status={linked.status} size={11} />}
                </span>
              )}
            </button>
          )
        })}
        {done.length > 0 && (
          <div className="flex items-center gap-2 px-1.5 pt-1 text-[11px] text-faint">
            <button className="hover:text-muted" onClick={() => setHideDone(!hideDone)}>
              {hideDone ? `Show ${done.length} done` : `Hide ${done.length} done`}
            </button>
            <span>·</span>
            <button className="hover:text-muted" onClick={() => remove(done.map((r) => r.item.id))} title="Take the done items off the assistant's list">
              Clear done
            </button>
          </div>
        )}
      </div>
      {err && <div className="pt-1 text-[11.5px] text-red-400">{err}</div>}
      {menu && <ContextMenu x={menu.x} y={menu.y} title={menu.title} items={menu.items} onClose={() => setMenu(null)} />}
    </Section>
  )
}
