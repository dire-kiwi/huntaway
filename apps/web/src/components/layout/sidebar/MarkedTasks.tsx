import { parseJson, toJson } from "../../ui/json"
import { clsx } from "clsx"
import { Bell, BellRing, ChevronRight, Star, X } from "lucide-react"
import { useMemo, useState, type ReactNode } from "react"
import { taskKey, type HostTask as Task } from "@huntaway/client"
import { isDue, reminderLabel, reminderTasks, starredTasks } from "../../ui/reminders"
import { type Route } from "../../../router"
import { openTask, usePanel } from "../../../state/route"

import { ReminderModal, reminderItems, starItem, useReminderClock } from "../../task/Reminders"
import { ContextMenu, IconButton } from "../../ui"
import { titleItem, TitleModal } from "../TitleModal"
import { Badge, NavItem } from "./NavItem"
import { useBoard } from "../../../state/board"

const COLLAPSED_SECTIONS_KEY = "ia.sidebar.collapsedSections"

function loadCollapsedSections(): Set<string> {
  try {
    const kept = parseJson(localStorage.getItem(COLLAPSED_SECTIONS_KEY) ?? "[]")
    return new Set(Array.isArray(kept) ? kept.filter((k): k is string => typeof k === "string") : [])
  } catch {
    return new Set()
  }
}

/** A heading over a list in the sidebar, which shows or leaves out the list. */
function SectionHeading({ label, open, onToggle, right }: { label: string; open: boolean; onToggle: () => void; right?: ReactNode | undefined }) {
  return (
    <button
      onClick={onToggle}
      aria-expanded={open}
      className="flex h-7 w-full items-center gap-1 px-2 text-left text-[11px] font-semibold tracking-wide text-faint uppercase hover:text-muted"
    >
      <ChevronRight size={12} className={clsx("transition-transform", open && "rotate-90")} />
      <span className="flex-1">{label}</span>
      {right}
    </button>
  )
}

/**
 * The starred tasks, and those with a reminder (soonest first, the due ones in amber). Each
 * section is only there while it has tasks; which are collapsed is saved in this browser.
 */
export function MarkedTasks({ route }: { route: Route }) {
  const tasks = useBoard((s) => s.tasks)
  const projects = useBoard((s) => s.projects)
  const panelTask = usePanel()?.taskId
  const list = useMemo(() => Object.values(tasks), [tasks])
  const starred = useMemo(
    () =>
      starredTasks(
        list,
        projects.map((p) => p.id),
      ),
    [list, projects],
  )
  const reminders = useMemo(() => reminderTasks(list), [list])
  const now = useReminderClock(reminders)
  const [collapsed, setCollapsed] = useState(loadCollapsedSections)
  const [menu, setMenu] = useState<{ x: number; y: number; task: Task } | null>(null)
  const [picking, setPicking] = useState<Task | null>(null)
  const [renaming, setRenaming] = useState<Task | null>(null)
  const [err, setErr] = useState<string | null>(null)
  // Its error, menu and dialog stay when the last task leaves the sections (a failed clear, say).
  if (!starred.length && !reminders.length && !err && !menu && !picking && !renaming) return null

  const openId = route.name === "task" ? route.taskId : panelTask
  const due = reminders.filter((t) => isDue(t, now)).length
  const toggle = (key: string) =>
    setCollapsed((old) => {
      const next = new Set(old)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      try {
        localStorage.setItem(COLLAPSED_SECTIONS_KEY, toJson([...next]))
      } catch {
        /* ignore */
      }
      return next
    })
  const row = (t: Task, right: ReactNode, title: string) => (
    <NavItem
      key={t.id}
      active={openId === t.id}
      title={title}
      onClick={() => openTask(t.id)}
      onContextMenu={(e) => {
        e.preventDefault()
        setErr(null)
        setMenu({ x: e.clientX, y: e.clientY, task: t })
      }}
      icon={<span className="font-mono text-[10.5px] text-faint">{taskKey(t)}</span>}
      right={right}
    >
      {t.title}
    </NavItem>
  )
  const section = (key: string, label: string, items: Task[], render: (t: Task) => ReactNode, right?: ReactNode) =>
    items.length > 0 && (
      <div role="group" aria-label={label}>
        <SectionHeading label={label} open={!collapsed.has(key)} onToggle={() => toggle(key)} right={right} />
        {!collapsed.has(key) && <div className="space-y-0.5">{items.map(render)}</div>}
      </div>
    )

  return (
    <div className="space-y-1 pb-2">
      {section("starred", "Starred", starred, (t) => row(t, <Star size={11} className="shrink-0 text-amber-300" fill="currentColor" />, t.title))}
      {section(
        "reminders",
        "Reminders",
        reminders,
        (t) => {
          const on = isDue(t, now)
          return row(
            t,
            <span className={clsx("flex shrink-0 items-center gap-1 text-[11px]", on ? "text-amber-300" : "text-faint")}>
              {on ? <BellRing size={11} /> : <Bell size={11} />}
              {t.remind_at && reminderLabel(t.remind_at, now)}
            </span>,
            `${t.title}\nReminder: ${t.remind_at ? new Date(t.remind_at).toLocaleString() : ""}${t.reminder ? `\n${t.reminder}` : ""}`,
          )
        },
        <Badge n={due} title={`${due} reminder${due === 1 ? "" : "s"} due`} />,
      )}
      {err && (
        <div className="flex items-start gap-1 px-2.5 py-1 text-[11.5px] text-red-400">
          <span className="min-w-0 flex-1">{err}</span>
          <IconButton className="h-5 w-5" title="Dismiss" onClick={() => setErr(null)}>
            <X size={12} />
          </IconButton>
        </div>
      )}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          title={`${taskKey(menu.task)}${menu.task.reminder ? ` · ${menu.task.reminder}` : ""}`}
          items={[
            starItem(menu.task, setErr),
            ...reminderItems(menu.task, () => setPicking(menu.task), setErr, true),
            titleItem(() => setRenaming(menu.task), true),
          ]}
          onClose={() => setMenu(null)}
        />
      )}
      {picking && <ReminderModal task={picking} onClose={() => setPicking(null)} />}
      {renaming && <TitleModal task={renaming} onClose={() => setRenaming(null)} />}
    </div>
  )
}
