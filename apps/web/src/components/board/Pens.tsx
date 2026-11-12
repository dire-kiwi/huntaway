// Pens (HA-285): the profile board's tabs, one for each active pen (HA-291), beside All and its Active and Inactive views
// (HA-292); the menus that move tasks between pens; the button that opens the profile's pens thread, which arranges them
// as the user asks; (HA-293) the button and menu item that open a pen's own thread, which works on its tasks; and the
// label in its pen's colour over a card whose task is in a pen (HA-294).
import { clsx } from "clsx"
import { CirclePause, CirclePlay, MessageSquare, MessagesSquare, Plus, Fence } from "lucide-react"
import { memo, useMemo, useState, type DragEvent, type FormEvent, type MouseEvent } from "react"
import { Effect, Exit } from "effect"
import type { AtomRegistry } from "effect/reactivity"
import { useShallow } from "../boardHelpers"
import { type CallError, PEN_COLOR_NAMES, PEN_COLORS, type HostTask as Task } from "@huntaway/client"
import {
  ACTIVE_VIEW,
  attempt,
  canPen,
  changeTab,
  createPen,
  deleteTab,
  INACTIVE_VIEW,
  inTab,
  moveTab,
  moveToPen,
  openPensThread,
  openPenThread,
  penKey,
  penLabel,
  penStyle,
  penTabs,
  type PenRefused,
  saveTab,
  settled,
  tabOf,
  type PenTab,
} from "./penModel"
import { useAction } from "../../state/mutation"
import { navigate } from "../../state/route"
import { after } from "../../state/timers"
import { profileNameOf } from "../boardHelpers"
import { Button, ContextMenu, errorText, Input, Modal, ModalFooter, RunningDot, useConfirm, type MenuItem } from "../ui"
import { board, useBoard } from "../../state/board"

/** A profile's pen tabs (merged across its hosts), `profiles` being the profile on each host as `<host>:<profile id>`. */
export function usePenTabs(profiles: Set<string>): PenTab[] {
  const pens = useBoard((s) => s.pens)
  const local = useBoard((s) => s.localHostId)
  return useMemo(() => penTabs(pens, profiles, local), [pens, profiles, local])
}

/** The pen tabs of the profile a task is in (by its name, on every host). */
function tabsFor(t: Task): PenTab[] {
  const s = board.get()
  const name = profileNameOf(s, t)
  const ids = new Set(s.profiles.filter((p) => p.name === name).map((p) => `${p.host_id}:${p.id}`))
  return penTabs(s.pens, ids, s.localHostId)
}

/**
 * The menu items that move a task into one of its profile's pens (the active ones, and the one it's in), out of its
 * pen, or into a new one (`onNew`): all the picked tasks if it's one of several, else just it.
 */
export function penItems(task: Task, picked: Task[], onError: (msg: string) => void, onNew: (tasks: Task[]) => void): MenuItem[] {
  if (!canPen(task)) return []
  const among = picked.length > 1 && picked.some((t) => t.id === task.id)
  const targets = among ? picked : [task]
  const suffix = among ? ` (${targets.length} picked)` : ""
  const tabs = tabsFor(task)
  const current = tabOf(tabs, task)
  const move = (name: string | null) => attempt(moveToPen(targets, name), onError)
  const items: MenuItem[] = tabs
    .filter((t) => t.active || t === current)
    .map((t, i) => ({
      label: (
        <span className="flex items-center gap-2">
          <Fence size={13} style={{ color: PEN_COLORS[t.color].base }} /> Pen: {t.name}
          {suffix}
        </span>
      ),
      divider: i === 0,
      checked: !among && t === current,
      onSelect: () => move(t.name),
    }))
  items.push({ label: `New pen…${suffix}`, divider: !items.length, onSelect: () => onNew(targets) })
  if (among ? targets.some((t) => t.pen_id) : current)
    items.push({ label: `Out of ${among ? "their pens" : (current?.name ?? "its pen")}${suffix}`, onSelect: () => move(null) })
  return items
}

/** Asks for a pen's name, to make one (and put `tasks` in it) or rename one. */
export function PenNameModal({
  title,
  initial = "",
  action,
  onSave,
  onClose,
}: {
  title: string
  initial?: string | undefined
  action: string
  /** What saving it does (the dialog closes once it has, and shows why it failed if it did). */
  onSave: (name: string) => Effect.Effect<void, CallError<"tasks.update" | "pens.create" | "pens.update"> | PenRefused, AtomRegistry.AtomRegistry>
  onClose: () => void
}) {
  const [name, setName] = useState(initial)
  const [{ busy, error: err }, run] = useAction()
  const submit = (e?: FormEvent) => {
    e?.preventDefault()
    const n = name.trim()
    if (!n || busy) return
    if (n === initial) return onClose()
    void run(onSave(n)).then((exit) => {
      if (Exit.isSuccess(exit)) onClose()
    })
  }
  return (
    <Modal title={title} onClose={onClose} onSubmit={submit} width="max-w-md">
      <form onSubmit={submit} className="space-y-3">
        <Input
          autoFocus
          value={name}
          aria-label="Pen name"
          placeholder="Today, Parked, Billing rework…"
          onChange={(e) => setName(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
        />
        <div className="text-[12px] text-faint">A pen holds tasks from any of the profile's projects, and shows as a tab on its board.</div>
        <ModalFooter className="space-y-3">
          {err && <div className="text-xs text-red-400">{err}</div>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={busy || !name.trim()}>
              {action}
            </Button>
          </div>
        </ModalFooter>
      </form>
    </Modal>
  )
}

/** The dialog that makes a pen and moves tasks into it, for penItems' `onNew`. */
export function useNewPen(onError: (msg: string) => void) {
  const [tasks, setTasks] = useState<Task[] | null>(null)
  const dialog = tasks && (
    <PenNameModal
      title={tasks.length > 1 ? `Put ${tasks.length} tasks in a new pen` : "Put the task in a new pen"}
      action="Create pen"
      // Why it failed shows on the board, as for the menus' moves: the dialog closes either way.
      onSave={(name) => moveToPen(tasks, name).pipe(Effect.catch((e) => Effect.sync(() => onError(errorText(e)))))}
      onClose={() => setTasks(null)}
    />
  )
  return { newPen: setTasks, dialog }
}

/**
 * The profile board's tab bar: All, its Active and Inactive views (HA-292), then a tab for each active pen. A task dropped on a tab goes into its pen (or on All,
 * out of its pen). Right-click a tab to rename it, mark it inactive, move or delete it; _N inactive_ lists the inactive
 * ones, to mark one active again.
 */
export function PenTabs({
  profile,
  profiles,
  tabs,
  selected,
  onSelect,
  counts,
}: {
  profile: string
  /** The profile on each host, as `<host>:<profile id>`. */
  profiles: Set<string>
  tabs: PenTab[]
  /** The tab shown (its key), "" for All, or the Active or Inactive view. */
  selected: string
  onSelect: (key: string) => void
  /** How many tasks each tab has on the board, by key ("" for All). */
  counts: Map<string, number>
}) {
  const hosts = useBoard((s) => s.hosts)
  const [err, setErr] = useState<string | null>(null)
  // A tab's menu, its colours (`colors`), or the inactive tabs.
  const [menu, setMenu] = useState<{ x: number; y: number; tab?: PenTab | undefined; colors?: boolean | undefined; inactive?: boolean | undefined } | null>(
    null,
  )
  const [naming, setNaming] = useState<{ tab?: PenTab | undefined } | null>(null)
  const [over, setOver] = useState<string | null>(null)
  const { ask, dialog } = useConfirm()
  // The profile on each host that has pens, by host id.
  const byHost = useMemo(() => {
    const m = new Map<string, string>()
    for (const k of profiles) {
      const i = k.indexOf(":")
      const h = k.slice(0, i)
      if (hosts.some((x) => x.id === h)) m.set(h, k.slice(i + 1))
    }
    return m
  }, [profiles, hosts])
  // The pens whose own threads are running, as `<host>:<pen id>`.
  const runningKeys = useBoard((s) =>
    s.pens
      .filter((p) => p.thread_id && s.tasks[p.thread_id]?.running && s.tasks[p.thread_id]?.host_id === p.host_id)
      .map((p) => `${p.host_id}:${p.id}`)
      .join(" "),
  )
  // The profile's pens thread is running.
  const pensThreadRunning = useBoard((s) =>
    Object.values(s.tasks).some((t) => t.task_type === "pens" && t.running && profiles.has(`${t.host_id}:${t.profile_id}`)),
  )
  if (!byHost.size) return null
  const running = new Set(runningKeys.split(" "))
  const threadRunning = (tab: PenTab) => tab.pens.some((p) => running.has(`${p.host_id}:${p.id}`))
  const selectedTab = tabs.find((t) => t.key === selected)
  const shown = tabs.filter((t) => t.active || t.key === selected)
  const inactive = tabs.filter((t) => !t.active)
  const fail = (msg: string) => setErr(msg)

  const onDragOver = (e: DragEvent, key: string) => {
    if (!e.dataTransfer.types.includes("text/task-id")) return
    e.preventDefault()
    if (over !== key) setOver(key)
  }
  const onDrop = (e: DragEvent, tab: PenTab | null) => {
    e.preventDefault()
    setOver(null)
    const task = board.get().tasks[e.dataTransfer.getData("text/task-id")]
    // A drag stops at a tab, so the column it came from doesn't take it as a drop on itself.
    e.stopPropagation()
    if (task) attempt(moveToPen([task], tab?.name ?? null), fail)
  }
  const onTabMenu = (e: MouseEvent, tab?: PenTab) => {
    e.preventDefault()
    setMenu({ x: e.clientX, y: e.clientY, tab })
  }

  const tabMenu = (tab: PenTab): MenuItem[] => {
    const i = tabs.indexOf(tab)
    return [
      { label: "Open its thread", onSelect: () => void settled(openPenThread(tab)).catch(fail) },
      { label: "Rename…", divider: true, onSelect: () => setNaming({ tab }) },
      // The menu closes as an item is picked, so the colours open in a menu of their own where it was.
      {
        label: "Colour…",
        onSelect: () => {
          after(0, () => menu && setMenu({ x: menu.x, y: menu.y, tab, colors: true }))
        },
      },
      {
        label: tab.active ? "Mark inactive" : "Mark active",
        onSelect: () => {
          if (tab.active && selected === tab.key) onSelect("")
          attempt(changeTab(tab, { active: !tab.active }), fail)
        },
      },
      ...(i > 0 ? [{ label: "Move left", divider: true, onSelect: () => attempt(moveTab(tabs, tab, i - 1), fail) }] : []),
      ...(i < tabs.length - 1 ? [{ label: "Move right", divider: i === 0, onSelect: () => attempt(moveTab(tabs, tab, i + 1), fail) }] : []),
      {
        label: <span className="text-red-300">Delete…</span>,
        divider: true,
        onSelect: () =>
          ask({
            title: `Delete the ${tab.name} pen?`,
            body:
              ((counts.get(tab.key) ?? 0) > 0 ? "Its tasks aren't deleted: they stay on the board, in no pen." : "It has no tasks.") +
              (tab.pens.some((p) => p.thread_id) ? " Its own thread is deleted with it." : ""),
            action: "Delete pen",
            danger: true,
            onConfirm: () =>
              settled(deleteTab(tab)).then(() => {
                if (selected === tab.key) onSelect("")
              }),
          }),
      },
    ]
  }

  const tabButton = (key: string, label: string, tab: PenTab | null) => (
    <button
      key={key || "all"}
      role="tab"
      aria-selected={selected === key}
      title={
        tab
          ? `The ${tab.name} pen: drop a task here to put it in it; right-click (or click it again) for more`
          : "Every task: drop one here to take it out of its pen"
      }
      // The open pen's tab opens its menu, for touch screens, which have no right-click.
      onClick={(e) => (tab && selected === key ? setMenu({ x: e.clientX, y: e.clientY, tab }) : onSelect(key))}
      onContextMenu={tab ? (e) => onTabMenu(e, tab) : undefined}
      onDragOver={(e) => onDragOver(e, key)}
      onDragLeave={() => setOver((o) => (o === key ? null : o))}
      onDrop={(e) => onDrop(e, tab)}
      className={clsx(
        "no-drag relative flex h-8 shrink-0 items-center gap-1.5 border-b-2 px-2.5 text-[12.5px] transition-colors",
        selected === key ? "border-accent text-fg" : "border-transparent text-muted hover:text-fg",
        over === key && "bg-accent/15",
        tab && !tab.active && "italic",
      )}
    >
      {tab && (threadRunning(tab) ? <RunningDot /> : <Fence size={12} className="shrink-0" style={{ color: PEN_COLORS[tab.color].base }} />)}
      <span className="max-w-[16em] truncate">{label}</span>
      <span className="text-[11px] text-faint">{counts.get(key) ?? 0}</span>
    </button>
  )

  // The views under All (HA-292), which tasks aren't dropped on.
  const viewButton = (key: string, label: string, Icon: typeof CirclePlay, title: string) => (
    <button
      key={key}
      role="tab"
      aria-selected={selected === key}
      title={title}
      onClick={() => onSelect(key)}
      className={clsx(
        "no-drag flex h-8 shrink-0 items-center gap-1.5 border-b-2 px-2 text-[12px] transition-colors",
        selected === key ? "border-accent text-fg" : "border-transparent text-muted hover:text-fg",
      )}
    >
      <Icon size={12} className="shrink-0" />
      <span>{label}</span>
      <span className="text-[11px] text-faint">{counts.get(key) ?? 0}</span>
    </button>
  )

  return (
    <>
      <div
        role="tablist"
        aria-label={`${profile}'s pens`}
        className="flex h-9 shrink-0 items-end gap-0.5 overflow-x-auto border-b border-line px-3 narrow:px-1.5"
      >
        {tabButton("", "All", null)}
        {tabs.length > 0 && (
          <>
            {viewButton(ACTIVE_VIEW, "Active", CirclePlay, "Every task in an active pen, in a row for each pen")}
            {viewButton(INACTIVE_VIEW, "Inactive", CirclePause, "Every task in an inactive pen, in a row for each pen")}
            <span className="mx-1 mb-2 h-4 w-px shrink-0 bg-line" aria-hidden />
          </>
        )}
        {shown.map((t) => tabButton(t.key, t.name, t))}
        <button
          className="no-drag mb-1 flex h-6 w-6 shrink-0 items-center justify-center rounded text-faint hover:bg-white/5 hover:text-fg"
          title="New pen"
          aria-label="New pen"
          onClick={() => setNaming({})}
        >
          <Plus size={14} />
        </button>
        <div className="ml-auto flex shrink-0 items-center gap-1 pb-1">
          {inactive.length > 0 && (
            <Button
              size="sm"
              variant="ghost"
              title="The inactive pens: pick one to mark it active"
              onClick={(e) => setMenu({ x: e.clientX, y: e.clientY, inactive: true })}
            >
              <CirclePause size={13} /> {inactive.length} inactive
            </Button>
          )}
          {selectedTab && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void settled(openPenThread(selectedTab)).catch(fail)}
              title={`The ${selectedTab.name} pen's own thread: ask how its tasks are going, add tasks to it, or have it start and chase them`}
            >
              {threadRunning(selectedTab) ? <RunningDot /> : <MessageSquare size={14} />}{" "}
              <span className="max-w-[12em] truncate narrow:hidden">{selectedTab.name} thread</span>
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void settled(openPensThread(byHost)).catch(fail)}
            title="The pens thread: tell its agent what you're working on, and it sets up the pens for it"
          >
            {pensThreadRunning ? <RunningDot /> : <MessagesSquare size={14} />} <span className="narrow:hidden">Pens thread</span>
          </Button>
        </div>
      </div>
      {err && (
        <div className="flex items-center gap-2 border-b border-line bg-red-500/10 px-5 py-1.5 text-[12.5px] text-red-300 narrow:px-3">
          <span className="min-w-0 flex-1">{err}</span>
          <button className="text-faint hover:text-fg" onClick={() => setErr(null)}>
            Dismiss
          </button>
        </div>
      )}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          title={menu.tab ? (menu.colors ? `The ${menu.tab.name} pen's colour` : menu.tab.name) : menu.inactive ? "Mark a pen active" : undefined}
          items={
            menu.tab && menu.colors
              ? colorMenu(menu.tab, fail)
              : menu.tab
                ? tabMenu(menu.tab)
                : inactive.map((t) => ({
                    label: (
                      <span className="flex items-center gap-2">
                        <CirclePlay size={13} /> {t.name} <span className="text-faint">{counts.get(t.key) ?? 0}</span>
                      </span>
                    ),
                    onSelect: () => {
                      attempt(changeTab(t, { active: true }), fail)
                      onSelect(t.key)
                    },
                  }))
          }
          onClose={() => setMenu(null)}
        />
      )}
      {naming && (
        <PenNameModal
          title={naming.tab ? `Rename the ${naming.tab.name} pen` : "New pen"}
          initial={naming.tab?.name}
          action={naming.tab ? "Rename" : "Create pen"}
          onSave={(name) => {
            const renamed = naming.tab
            if (renamed)
              return changeTab(renamed, { name }).pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    if (selected === renamed.key) onSelect(penKey(name))
                  }),
                ),
              )
            return createPen(byHost, name).pipe(Effect.tap(() => Effect.sync(() => onSelect(penKey(name)))))
          }}
          onClose={() => setNaming(null)}
        />
      )}
      {dialog}
    </>
  )
}

/** How many of `tasks` each tab has, by key, "" (All) for all of them, and the Active and Inactive views theirs. */
export function tabCounts(tabs: PenTab[], tasks: Task[]): Map<string, number> {
  const m = new Map<string, number>([
    ["", tasks.length],
    [ACTIVE_VIEW, 0],
    [INACTIVE_VIEW, 0],
  ])
  for (const tab of tabs) {
    const n = tasks.filter((t) => inTab(tab, t)).length
    m.set(tab.key, n)
    const view = tab.active ? ACTIVE_VIEW : INACTIVE_VIEW
    m.set(view, (m.get(view) ?? 0) + n)
  }
  return m
}

/** The menu of a tab's colours: picking one gives it to each of its pens. */
function colorMenu(tab: PenTab, fail: (msg: string) => void): MenuItem[] {
  return PEN_COLOR_NAMES.map((c) => ({
    label: (
      <span className="flex items-center gap-2">
        <span className="h-3 w-3 rounded-full" style={{ backgroundColor: PEN_COLORS[c].base }} />
        <span className="capitalize">{c}</span>
      </span>
    ),
    checked: tab.color === c,
    onSelect: () => attempt(changeTab(tab, { color: c }), fail),
  }))
}

/** Opens the profile's board on a pen's tab. */
function openPen(profile: string, key: string) {
  saveTab(profile, key)
  navigate({ name: "profile", profile })
}

/**
 * The label over a card whose task is in a pen (HA-294): the pen's name in its colour, as its tab has it. Clicking it
 * opens the pen's tab: with `onOpen` on the board it's on (a profile's), else on the profile's board.
 */
export const CardPenLabel = memo(function CardPenLabel({ task, onOpen }: { task: Task; onOpen?: ((key: string) => void) | undefined }) {
  const label = useBoard(useShallow((s) => penLabel(s, task)))
  if (!label) return null
  return (
    <button
      type="button"
      data-pen-label={label.name}
      className="ml-2 flex max-w-[calc(100%-1rem)] items-center gap-1 rounded-t-md border border-b-0 px-1.5 text-[10.5px] leading-[15px] font-medium transition-[filter] hover:brightness-125"
      style={penStyle(label.color)}
      title={`In the ${label.name} pen: click to open its tab`}
      onClick={(e) => {
        e.stopPropagation()
        if (onOpen) onOpen(label.key)
        else openPen(label.profile, label.key)
      }}
    >
      <Fence size={10} className="shrink-0" />
      <span className="truncate">{label.name}</span>
    </button>
  )
})
