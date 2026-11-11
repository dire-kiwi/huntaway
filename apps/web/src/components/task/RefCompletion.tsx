import { clsx } from "clsx"
import { FolderGit2 } from "lucide-react"
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react"
import { STATUSES } from "@huntaway/client"
import { mayMention, refItems, refMatches, refMentions, refPick, refTyped, type RefItem, type RefMention } from "../../refCompletion"

import { StatusIcon } from "../ui"
import { useBoard } from "../../state/board"

export type RefCompletion = ReturnType<typeof useRefCompletion>

/**
 * `@` completion of projects and tasks for a text area (HA-303, see refCompletion.ts): the message box of a task's
 * agent and the new task dialog's description. `caret` is null while the field isn't focused; `apply` puts the text
 * with the picked key in it, and the caret after it. `onKeyDown` takes the list's keys (and says when it took one), so
 * Enter picks rather than sends while the list is open.
 */
export function useRefCompletion({
  text,
  caret,
  owner,
  apply,
}: {
  text: string
  caret: number | null
  /** The profile whose agent reads what's written: its own board's keys go in as they are, others' qualified. */
  owner: { host_id: string; profile_id: string } | null
  apply: (text: string, caret: number) => void
}) {
  const [lit, setLit] = useState(0)
  // The `@` whose list Escape closed, which stays closed until the text changes.
  const [closedAt, setClosedAt] = useState<number | null>(null)
  const typed = caret == null || !owner ? null : refTyped(text, caret)
  const active = typed && typed.start !== closedAt ? typed : null
  // A change of the text opens a closed list again, and a new `@` (or what's typed after it) lights its first item: as
  // the text and the `@` change, while this renders.
  const [seenText, setSeenText] = useState(text)
  if (seenText !== text) {
    setSeenText(text)
    setClosedAt(null)
  }
  const typedKey = active ? `${active.start}:${active.query}` : ""
  const [seenTyped, setSeenTyped] = useState(typedKey)
  if (seenTyped !== typedKey) {
    setSeenTyped(typedKey)
    setLit(0)
  }

  const profiles = useBoard((s) => s.profiles)
  const projects = useBoard((s) => s.projects)
  const tasks = useBoard((s) => s.tasks)
  const on = !!active
  const ownerHost = owner?.host_id
  const ownerProfile = owner?.profile_id
  const items = useMemo(
    () =>
      on && ownerHost !== undefined && ownerProfile !== undefined
        ? refItems(profiles, projects, Object.values(tasks), { host_id: ownerHost, profile_id: ownerProfile })
        : [],
    [on, ownerHost, ownerProfile, profiles, projects, tasks],
  )
  const matches = active ? refMatches(items, active.query) : []
  const open = !!active && matches.length > 0
  const hl = Math.min(lit, matches.length - 1)

  const pick = (item: RefItem) => {
    if (!active) return
    const r = refPick(text, active, item.value)
    apply(r.text, r.caret)
  }

  /** Handles the list's keys while it's open; true when the key was its. */
  const onKeyDown = (e: KeyboardEvent) => {
    if (!open || e.nativeEvent.isComposing) return false
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault()
      setLit((hl + (e.key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length)
      return true
    }
    if ((e.key === "Enter" && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) || (e.key === "Tab" && !e.shiftKey && !e.ctrlKey && !e.altKey)) {
      e.preventDefault()
      const m = matches[hl]
      if (m) pick(m)
      return true
    }
    if (e.key === "Escape") {
      // Closes the list, not the dialog or the task panel.
      e.preventDefault()
      e.stopPropagation()
      setClosedAt(active?.start ?? null)
      return true
    }
    return false
  }

  return { open, matches, lit: hl, setLit, pick, onKeyDown, at: active?.start ?? null }
}

/**
 * The keys in `text` that name a project or task `owner`'s agents can use (HA-400, see refMentions), to show them as
 * read: only the key goes to the agent, which looks it up with the board's tools.
 */
export function useRefMentions(text: string, owner: { host_id: string; profile_id: string } | null): RefMention[] {
  const profiles = useBoard((s) => s.profiles)
  const projects = useBoard((s) => s.projects)
  const tasks = useBoard((s) => s.tasks)
  // The board's tasks are only gone through when something in the text could be a key.
  const may = !!owner && mayMention(text)
  const ownerHost = owner?.host_id
  const ownerProfile = owner?.profile_id
  const items = useMemo(
    () =>
      may && ownerHost !== undefined && ownerProfile !== undefined
        ? refItems(profiles, projects, Object.values(tasks), { host_id: ownerHost, profile_id: ownerProfile })
        : [],
    [may, ownerHost, ownerProfile, profiles, projects, tasks],
  )
  return useMemo(() => refMentions(text, items), [text, items])
}

/** What a mention's chip and highlight say of it when pointed at. */
export const mentionTitle = (m: RefItem) =>
  m.kind === "project"
    ? `Project ${m.title}: its agent reads the key ${m.value}, and can look the project up on the board`
    : `${m.title}${m.project ? ` (${m.project.name})` : ""}: its agent reads the key ${m.value}, and can look the task up on the board`

/** The projects and tasks a text mentions, each once: its key in the accent colour, then its name or title. */
export function RefChips({ mentions, className }: { mentions: RefMention[]; className?: string | undefined }) {
  const items = [...new Map(mentions.map((m) => [m.item.value, m.item])).values()]
  if (!items.length) return null
  return (
    <div className={clsx("flex flex-wrap items-center gap-1.5 text-[12px] text-faint", className)} aria-label="Mentions">
      <span className="mr-0.5">Mentions</span>
      {items.map((m) => (
        <span
          key={m.value}
          title={mentionTitle(m)}
          className="inline-flex h-6 max-w-64 items-center gap-1 rounded-md border border-line bg-panel-2 px-1.5 text-[12px] text-fg"
        >
          {m.kind === "project" ? <FolderGit2 size={12} className="shrink-0 text-accent" /> : <StatusIcon status={m.status ?? "todo"} size={12} />}
          <code className="shrink-0 font-mono text-[11.5px] text-accent">{m.value}</code>
          <span className="truncate">{m.title}</span>
        </span>
      ))}
    </div>
  )
}

const STATUS_LABEL = Object.fromEntries(STATUSES.map((s) => [s.id, s.label]))

// What's copied from the text area to the mirror that finds where its caret is.
const MIRRORED = [
  "boxSizing",
  "width",
  "borderTopWidth",
  "borderRightWidth",
  "borderBottomWidth",
  "borderLeftWidth",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "fontStyle",
  "fontVariant",
  "fontWeight",
  "fontStretch",
  "fontSize",
  "fontFamily",
  "lineHeight",
  "letterSpacing",
  "wordSpacing",
  "tabSize",
  "textIndent",
  "textTransform",
] as const

/** Where in the window the character at `index` of `ta` is drawn, as a box one line high. */
export function caretRect(ta: HTMLTextAreaElement, index: number) {
  const cs = getComputedStyle(ta)
  const div = document.createElement("div")
  for (const p of MIRRORED) div.style[p] = cs[p]
  Object.assign(div.style, { position: "absolute", top: "0", left: "0", visibility: "hidden", whiteSpace: "pre-wrap", overflowWrap: "break-word" })
  div.textContent = ta.value.slice(0, index)
  const mark = document.createElement("span")
  mark.textContent = ta.value.slice(index) || "."
  div.appendChild(mark)
  document.body.appendChild(div)
  const box = ta.getBoundingClientRect()
  const left = box.left + parseFloat(cs.borderLeftWidth) + mark.offsetLeft - ta.scrollLeft
  const top = box.top + parseFloat(cs.borderTopWidth) + mark.offsetTop - ta.scrollTop
  const lineHeight = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.3
  div.remove()
  return { left, top, bottom: top + lineHeight, box }
}

/** The `@` list, by the caret of `input`: fixed to the window, under the caret or over it where there's more room. */
export function RefMenu({ refs, input }: { refs: RefCompletion; input: RefObject<HTMLTextAreaElement | null> }) {
  const list = useRef<HTMLDivElement>(null)
  const { open, matches, lit, setLit, pick, at } = refs
  useLayoutEffect(() => {
    if (!open || at == null) return undefined
    const place = () => {
      const ta = input.current
      const l = list.current
      if (!ta || !l) return
      const c = caretRect(ta, at)
      const below = window.innerHeight - c.bottom - 10
      const above = c.top - 10
      const up = l.scrollHeight > below && above > below
      l.style.maxHeight = `${Math.max(80, Math.min(280, up ? above : below))}px`
      l.style.top = `${up ? Math.max(8, c.top - 2 - l.offsetHeight) : c.bottom + 2}px`
      l.style.left = `${Math.max(8, Math.min(c.left, window.innerWidth - l.offsetWidth - 8))}px`
    }
    place()
    window.addEventListener("scroll", place, true)
    window.addEventListener("resize", place)
    return () => {
      window.removeEventListener("scroll", place, true)
      window.removeEventListener("resize", place)
    }
  })
  useEffect(() => {
    // The lit item (`lit`), shown in the list once it opens.
    if (open && lit >= 0) list.current?.querySelector("[aria-selected=true]")?.scrollIntoView({ block: "nearest" })
  }, [lit, open])
  if (!open) return null
  return (
    <div
      ref={list}
      role="listbox"
      aria-label="Projects and tasks"
      className="fixed z-50 w-[26rem] max-w-[calc(100vw-16px)] overflow-y-auto rounded-lg border border-line-strong bg-panel-2 p-1 shadow-xl shadow-black/50"
      // Keeps the text area focused, so picking doesn't close the list first.
      onMouseDown={(e) => e.preventDefault()}
    >
      {matches.map((m, i) => (
        <div
          key={m.id}
          role="option"
          aria-selected={i === lit}
          onMouseMove={() => i !== lit && setLit(i)}
          onClick={() => pick(m)}
          title={m.kind === "task" ? `${m.title}${m.project ? ` (${m.project.name})` : ""}` : `Project ${m.title}`}
          className={clsx("flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-[12.5px]", i === lit ? "bg-raised text-fg" : "text-muted")}
        >
          {m.kind === "project" ? <FolderGit2 size={12} className="shrink-0 text-faint" /> : <StatusIcon status={m.status ?? "todo"} size={12} />}
          <code className="shrink-0 font-mono text-[12px] text-accent">{m.value}</code>
          <span className="min-w-0 flex-1 truncate">{m.title}</span>
          <span className="shrink-0 text-[11px] text-faint">
            {m.kind === "project" ? "project" : [m.status && STATUS_LABEL[m.status], m.project?.name].filter(Boolean).join(" · ")}
          </span>
        </div>
      ))}
    </div>
  )
}
