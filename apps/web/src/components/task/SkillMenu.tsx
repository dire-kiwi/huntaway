import { useAtomValue } from "@effect/atom-react"
import { clsx } from "clsx"
import { AsyncResult, Atom } from "effect/reactivity"
import { Layers, Loader2, Palette, Sparkles } from "lucide-react"
import { useEffect, useRef, useState, type KeyboardEvent } from "react"
import { query as hostQuery, type HostTask as Task, type QueryResult } from "@huntaway/client"
import { resultError, resultValue } from "../ui"

// The composer's `/` menu (6.4; huntaway's task/SkillMenu.tsx): the skills a task's agent can be asked to use (the
// host's `tasks.skills`, a query read again when the task's config changes and kept ten seconds after the composer) and the board's own `/compact`, `/plan` and `/new`. Every host here handles
// them all, so the old API checks are gone. HE-102: a Claude task's `/output-style`, whose menu, once its name is typed,
// lists the output styles from the same query.

/** Something the composer's `/` menu offers: a skill, or `/compact`, `/plan`, `/new` or `/output-style`, which the board handles itself; or after `/output-style `, a style. */
export interface SkillItem {
  name: string
  description: string
  /** How a message calls it: `/name` for Claude Code, `$name` for a Codex skill. */
  prefix: "/" | "$"
  builtin?: boolean | undefined
  /** What a builtin takes after its name, for the hint. */
  args?: string | undefined
  /** An output style, for `/output-style <name>` (HE-102); `current` is the task's now. */
  style?: "current" | true | undefined
}

/** The command that sets the output style. */
const OUTPUT_STYLE = "output-style"

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
  // `$` is Codex's (Claude Code and ACP agents take `/`), but until the host says which agent the task has, it loads the list too.
  const query = m && (m[1] === "/" || (agent !== "claude" && agent !== "acp")) ? (m[2] ?? "").toLowerCase() : null
  const trigger = m?.[1]
  // Output styles are Claude Code's.
  const styles = agent !== "codex" && agent !== "acp"
  // `/output-style <name>`, being typed: the styles, for its name.
  const typing = styles ? /^\s*\/output-style\s+(\S*)$/.exec(text) : null
  const styleArg = typing ? (typing[1] ?? "") : null
  const styleQuery = styleArg?.toLowerCase() ?? null
  const asking = query !== null || styleQuery !== null

  // A new query starts at the top of the list, and one that's gone lets the menu open again.
  const menuQuery = query !== null ? `/${query}` : styleQuery !== null ? ` ${styleQuery}` : null
  const [lastQuery, setLastQuery] = useState(menuQuery)
  if (lastQuery !== menuQuery) {
    setLastQuery(menuQuery)
    setSelected(0)
    if (menuQuery === null) setDismissed(false)
  }
  if (asking && asked !== key) setAsked(key)
  // The task's style, else the one its last run had (from Claude Code's settings).
  const currentStyle = task.output_style ?? data?.output_style ?? null

  const all: SkillItem[] = [
    // An ACP agent's conversation is never compacted.
    ...(agent === "acp"
      ? []
      : [
          {
            name: "compact",
            description: task.session_id ? "Summarise the conversation so far to free up context" : "Nothing to compact until the agent has started",
            prefix: "/" as const,
            builtin: true,
            args: "[instructions]",
          },
        ]),
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
    ...(styles
      ? [
          {
            name: OUTPUT_STYLE,
            description: `How the agent writes its replies${currentStyle === null ? "" : ` (now ${currentStyle})`}`,
            prefix: "/" as const,
            builtin: true,
            args: "[style]",
          },
        ]
      : []),
  ]
  // A skill named like a builtin can't be called with `/`: the board takes the message.
  all.push(
    ...(data?.skills ?? [])
      .map((s): SkillItem => ({ name: s.name, description: s.description, prefix: agent === "codex" ? "$" : "/" }))
      .filter((s) => !all.some((b) => b.prefix === s.prefix && b.name === s.name)),
  )
  const styleItems = (data?.output_styles ?? []).map((st): SkillItem => ({
    name: st.name,
    description: st.description,
    prefix: "/",
    style: st.name === currentStyle ? "current" : true,
  }))
  const startsFirst = (q: string) => (a: SkillItem, b: SkillItem) => Number(!a.name.toLowerCase().startsWith(q)) - Number(!b.name.toLowerCase().startsWith(q))
  const items =
    styleQuery !== null
      ? styleItems.filter((i) => i.name.toLowerCase().includes(styleQuery)).toSorted(startsFirst(styleQuery))
      : query === null
        ? []
        : all.filter((i) => i.name.toLowerCase().includes(query) && (trigger === "/" || !i.builtin)).toSorted(startsFirst(query))
  // Loading the first list for this config.
  const waiting = asking && !data && !failed
  const open = asking && !dismissed && (items.length > 0 || waiting)
  const sel = Math.min(selected, Math.max(items.length - 1, 0))

  // What the message calls, once it's typed: shown with what it does.
  const command = text.trimStart().split(/\s/)[0] ?? ""
  const hint = !open && command.length > 1 ? all.find((i) => i.prefix + i.name === command) : undefined

  const pick = (i: SkillItem) => setText(i.style ? `/${OUTPUT_STYLE} ${i.name}` : `${i.prefix}${i.name} `)

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
      if (enter && (item.style ? styleArg === item.name : command === item.prefix + item.name)) return false
      e.preventDefault()
      pick(item)
      return true
    }
    return false
  }

  return { open, items, selected: sel, setSelected, loading: waiting, pick, onKeyDown, hint, styles: styleQuery !== null }
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
    <div
      ref={list}
      role="listbox"
      aria-label={menu.items.some((i) => i.style) ? "Output styles" : "Skills"}
      className="max-h-60 overflow-y-auto border-b border-line py-1"
    >
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
          {i.style ? (
            <Palette size={12} className="shrink-0 text-faint" />
          ) : i.builtin ? (
            <Layers size={12} className="shrink-0 text-faint" />
          ) : (
            <Sparkles size={12} className="shrink-0 text-faint" />
          )}
          <span className="shrink-0 font-mono text-fg">
            {!i.style && i.prefix}
            {i.name}
          </span>
          {i.style === "current" && <span className="shrink-0 rounded bg-white/10 px-1 text-[10.5px] text-muted">current</span>}
          {i.description && <span className="min-w-0 truncate text-faint">{i.description}</span>}
        </div>
      ))}
      {menu.loading && (
        <div className="flex items-center gap-2 px-4 py-1 text-[12px] text-faint">
          <Loader2 size={12} className="animate-spin" />
          {menu.styles ? "Loading output styles…" : "Loading skills…"}
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
