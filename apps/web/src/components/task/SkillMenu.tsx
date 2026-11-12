import { useAtomValue } from "@effect/atom-react"
import { clsx } from "clsx"
import { AsyncResult, Atom } from "effect/reactivity"
import { Layers, Loader2, Sparkles } from "lucide-react"
import { useEffect, useRef, useState, type KeyboardEvent } from "react"
import { query as hostQuery, type HostTask as Task, type QueryResult } from "@huntaway/client"
import { resultError, resultValue } from "../ui"

// The composer's `/` menu (6.4; huntaway's task/SkillMenu.tsx): the skills a task's agent can be asked to use (the
// host's `tasks.skills`, a query read again when the task's config changes and kept ten seconds after the composer) and the board's own `/compact`, `/plan` and `/new`. Every host here handles
// them all, so the old API checks are gone.

/** Something the composer's `/` menu offers: a skill, or `/compact`, `/plan` or `/new`, which the board handles itself. */
export interface SkillItem {
  name: string
  description: string
  /** How a message calls it: `/name` for Claude Code, `$name` for a Codex skill. */
  prefix: "/" | "$"
  builtin?: boolean | undefined
  /** What a builtin takes after its name, for the hint. */
  args?: string | undefined
}

/** No skills asked for yet. */
const notAsked: Atom.Atom<QueryResult<"tasks.skills">> = Atom.make<QueryResult<"tasks.skills">>(AsyncResult.initial())

/** The `/` menu: typing `/` (or `$` for Codex) at the start of a message lists the skills its agent
 *  can be asked to use, and picking one puts `/name ` in the message. */
export function useSkillMenu(task: Task, text: string, setText: (t: string) => void) {
  const plans = task.kind === "task"
  // The task's config decides its skills, and whether they're `/name` or `$name`.
  const key = `${task.host_id}/${task.id}/${task.claude_config_id ?? ""}`
  // The list is read once a message here has started with `/` (or `$`) for this config, and followed from then on.
  const [asked, setAsked] = useState<string | null>(null)
  const [selected, setSelected] = useState(0)
  const [dismissed, setDismissed] = useState(false)
  const result = useAtomValue(asked === key ? hostQuery("tasks.skills", task.host_id, { id: task.id }) : notAsked)
  // Null when the host couldn't say.
  const data = asked === key ? (resultValue(result) ?? null) : null
  const failed = asked === key && resultError(result) !== null

  const agent = data?.agent
  const m = /^\s*([/$])(\S*)$/.exec(text)
  // `$` is Codex's, but until the host says which agent the task has, it loads the list too.
  const query = m && (m[1] === "/" || agent !== "claude") ? (m[2] ?? "").toLowerCase() : null
  const trigger = m?.[1]

  // A new query starts at the top of the list, and one that's gone lets the menu open again.
  const [lastQuery, setLastQuery] = useState(query)
  if (lastQuery !== query) {
    setLastQuery(query)
    setSelected(0)
    if (query === null) setDismissed(false)
  }
  if (query !== null && asked !== key) setAsked(key)

  const all: SkillItem[] = [
    {
      name: "compact",
      description: task.session_id ? "Summarise the conversation so far to free up context" : "Nothing to compact until the agent has started",
      prefix: "/",
      builtin: true,
      args: "[instructions]",
    },
    ...(plans
      ? [
          {
            name: "plan",
            description: "Write a plan in the task's Plan tab and go over it with you before the work",
            prefix: "/" as const,
            builtin: true,
            args: "[what to plan]",
          },
        ]
      : []),
    {
      name: "new",
      description: task.running
        ? "Stop the agent first: then start a new conversation with it, keeping this thread"
        : "Start a new conversation with the agent, keeping this thread",
      prefix: "/" as const,
      builtin: true,
      args: "[first message]",
    },
  ]
  // A skill named like a builtin can't be called with `/`: the board takes the message.
  all.push(
    ...(data?.skills ?? [])
      .map((s): SkillItem => ({ name: s.name, description: s.description, prefix: agent === "codex" ? "$" : "/" }))
      .filter((s) => !all.some((b) => b.prefix === s.prefix && b.name === s.name)),
  )
  const items =
    query === null
      ? []
      : all
          .filter((i) => i.name.toLowerCase().includes(query) && (trigger === "/" || !i.builtin))
          .toSorted((a, b) => Number(!a.name.toLowerCase().startsWith(query)) - Number(!b.name.toLowerCase().startsWith(query)))
  // Loading the first list for this config.
  const waiting = query !== null && !data && !failed
  const open = query !== null && !dismissed && (items.length > 0 || waiting)
  const sel = Math.min(selected, Math.max(items.length - 1, 0))

  // What the message calls, once it's typed: shown with what it does.
  const command = text.trimStart().split(/\s/)[0] ?? ""
  const hint = !open && command.length > 1 ? all.find((i) => i.prefix + i.name === command) : undefined

  const pick = (i: SkillItem) => setText(`${i.prefix}${i.name} `)

  /** Handles the menu's keys; true when the key was its. */
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!open) return false
    if (e.key === "Escape") {
      // Stops the task panel closing too (see TaskView).
      e.preventDefault()
      setDismissed(true)
      return true
    }
    const enter = e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing
    const take = enter || (e.key === "Tab" && !e.shiftKey)
    if (!items.length) {
      // Still loading: waits for the list rather than sending a half-typed command.
      if (take) e.preventDefault()
      return take
    }
    const move = (by: number) => {
      e.preventDefault()
      setSelected((sel + by + items.length) % items.length)
      return true
    }
    if (e.key === "ArrowDown") return move(1)
    if (e.key === "ArrowUp") return move(-1)
    if (take) {
      const item = items[sel]
      if (!item) return false
      // Typed out in full, Enter sends it as it is.
      if (enter && command === item.prefix + item.name) return false
      e.preventDefault()
      pick(item)
      return true
    }
    return false
  }

  return { open, items, selected: sel, setSelected, loading: waiting, pick, onKeyDown, hint }
}

export function SkillMenu({ menu }: { menu: ReturnType<typeof useSkillMenu> }) {
  const list = useRef<HTMLDivElement>(null)
  const { selected } = menu
  const count = menu.items.length
  useEffect(() => {
    if (count === 0) return
    list.current?.querySelectorAll("[role=option]")[selected]?.scrollIntoView({ block: "nearest" })
  }, [selected, count])
  if (!menu.open) return null
  return (
    <div ref={list} role="listbox" aria-label="Skills" className="max-h-60 overflow-y-auto border-b border-line py-1">
      {menu.items.map((i, n) => (
        <div
          key={i.prefix + i.name}
          role="option"
          aria-selected={n === menu.selected}
          data-selected={n === menu.selected || undefined}
          // Keeps the focus in the message.
          onMouseDown={(e) => {
            e.preventDefault()
            menu.pick(i)
          }}
          onMouseMove={() => n !== menu.selected && menu.setSelected(n)}
          title={i.description || undefined}
          className={clsx("flex cursor-pointer items-center gap-2 px-4 py-1 text-[12.5px]", n === menu.selected && "bg-white/5")}
        >
          {i.builtin ? <Layers size={12} className="shrink-0 text-faint" /> : <Sparkles size={12} className="shrink-0 text-faint" />}
          <span className="shrink-0 font-mono text-fg">
            {i.prefix}
            {i.name}
          </span>
          {i.description && <span className="min-w-0 truncate text-faint">{i.description}</span>}
        </div>
      ))}
      {menu.loading && (
        <div className="flex items-center gap-2 px-4 py-1 text-[12px] text-faint">
          <Loader2 size={12} className="animate-spin" />
          Loading skills…
        </div>
      )}
    </div>
  )
}

/** What the command the message starts with does. */
export function SkillHint({ item }: { item: SkillItem }) {
  return (
    <div className="flex items-center gap-2 border-b border-line px-4 py-1.5 text-[12px] text-faint">
      {item.builtin ? <Layers size={12} className="shrink-0" /> : <Sparkles size={12} className="shrink-0" />}
      <span className="shrink-0 font-mono text-muted">
        {item.prefix}
        {item.name} {item.args ?? "[arguments]"}
      </span>
      <span className="min-w-0 truncate" title={item.description || undefined}>
        {item.description || (item.prefix === "$" ? "Ask the agent to use this skill" : "Run this skill")}
      </span>
    </div>
  )
}
