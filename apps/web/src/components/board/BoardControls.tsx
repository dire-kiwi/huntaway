import { clsx } from "clsx"
import { ArrowUpDown, Check, ListFilter, Search, X } from "lucide-react"
import { useCallback, useDeferredValue, useEffect, useId, useMemo, useRef, useState, type ReactNode, type RefObject } from "react"
import { isArchived, STATUSES, type HostTask as Task } from "@huntaway/client"
import type { Status } from "@huntaway/contracts"
import { openTask } from "../../state/route"
import {
  EMPTY_QUERY,
  filterCount,
  highlighted,
  isFiltering,
  searchTasks,
  searchWords,
  snippet,
  SORTS,
  TASK_FLAGS,
  TASK_KINDS,
  toggled,
  type BoardQuery,
  type SearchHit,
  type SortKey,
  type TaskKind,
} from "./boardQuery"
import { forPage, isShortcut } from "../../shortcuts"
import { ContextMenu, StatusIcon, useClock } from "../ui"

const BUTTON = "inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-xs font-medium transition-colors narrow:h-8"
const BUTTON_STATE = (active: boolean) => (active ? "border-accent/50 bg-accent/10 text-fg" : "border-line text-muted hover:text-fg")

/** How many tasks the search lists; it says how many more it found. */
const SEARCH_LIMIT = 20

/**
 * The board's search field, which lists the board's tasks it finds (their key, title, description, branch or project)
 * under it, to open one (HA-306): ↑ and ↓ pick one, Enter or a click opens it. "/" anywhere on the page goes to it;
 * Escape closes the list, then clears the field, then leaves it.
 */
export function SearchBox({
  value,
  onChange: setValue,
  tasks,
  keyOf,
  projectName,
  showProject,
  align = "right",
}: {
  value: string
  onChange: (v: string) => void
  /** The board's tasks, archived ones too. */
  tasks: Task[]
  keyOf: (t: Task) => string
  projectName: (t: Task) => string | undefined
  /** Whether each task found says which project it's in (on a board of several). */
  showProject: boolean
  /** Which edge of the field the list lines up with. */
  align?: "left" | "right" | undefined
}) {
  const ref = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  // The pick, and the search it was made in: a new search starts from the first again. They're kept together rather than
  // the pick being reset by an effect, which can land after an arrow key pressed as the deferred list catches up (HA-320).
  const [chosen, setChosen] = useState({ text: "", i: 0 })
  const id = useId()
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isShortcut(e, "search") || !forPage(e)) return
      e.preventDefault()
      ref.current?.focus()
      ref.current?.select()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])
  // Typing goes on at once while a big board is searched.
  const text = useDeferredValue(value)
  const words = useMemo(() => searchWords(text), [text])
  // Archived as the board has it (useBoardTasks's clock, by the minute).
  const now = useClock(60_000)
  const hits = useMemo(() => searchTasks(tasks, text, keyOf, projectName, (t) => isArchived(t, now)), [tasks, text, keyOf, projectName, now])
  const shown = hits.slice(0, SEARCH_LIMIT)
  const at = Math.min(chosen.text === text ? chosen.i : 0, shown.length - 1)
  const setActive = (i: number) => setChosen({ text, i })
  const showing = open && words.length > 0
  useEffect(() => {
    if (showing) listRef.current?.querySelector(`[data-hit="${at}"]`)?.scrollIntoView({ block: "nearest" })
  }, [showing, at])
  const pick = (hit: SearchHit) => {
    setOpen(false)
    ref.current?.blur()
    openTask(hit.task.id)
  }
  const optionId = (i: number) => `${id}-hit-${i}`
  const mark = (s: string) => highlighted(s, words).map((r) => (r.match ? <mark key={r.start}>{r.text}</mark> : r.text))
  return (
    <div className="relative narrow:min-w-0 narrow:flex-1">
      <Search size={13} className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-faint" />
      <input
        ref={ref}
        value={value}
        role="combobox"
        aria-expanded={showing}
        aria-controls={`${id}-hits`}
        aria-autocomplete="list"
        aria-activedescendant={showing && at >= 0 ? optionId(at) : undefined}
        onChange={(e) => {
          setValue(e.target.value)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            // Not on to a task panel or a dialog under it.
            e.preventDefault()
            if (showing) setOpen(false)
            else if (value) setValue("")
            else e.currentTarget.blur()
          } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault()
            if (!showing) return setOpen(true)
            if (shown.length) setActive((at + (e.key === "ArrowDown" ? 1 : shown.length - 1)) % shown.length)
          } else if (e.key === "Enter" && showing && shown[at]) {
            e.preventDefault()
            pick(shown[at])
          }
        }}
        placeholder="Search tasks"
        aria-label="Search tasks"
        title="Search the board's tasks by key, title, description, branch or project (/)"
        className={clsx(
          "h-7 w-36 rounded-md border bg-panel pr-6 pl-7 text-[12.5px] text-fg placeholder:text-faint outline-none transition-[width] focus:w-56 focus:border-accent/60 lg:w-48 narrow:h-8 narrow:w-full narrow:focus:w-full",
          value ? "border-accent/50 lg:w-56" : "border-line",
        )}
      />
      {value && (
        <button
          title="Clear the search"
          // Keeps the field focused, to type another search.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setValue("")}
          className="absolute top-1/2 right-1 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-faint hover:text-fg"
        >
          <X size={12} />
        </button>
      )}
      {showing && (
        <div
          ref={listRef}
          data-modal
          // A press in the list leaves the field focused (so it stays open), and a click on a task opens it.
          onMouseDown={(e) => e.preventDefault()}
          className={clsx(
            align === "right" ? "right-0" : "left-0",
            "absolute top-full z-50 mt-1 max-h-[70vh] w-[28rem] max-w-[calc(100vw-1.5rem)] overflow-y-auto rounded-lg border border-line bg-panel p-1 shadow-2xl shadow-black/50",
          )}
        >
          <div id={`${id}-hits`} role="listbox" aria-label="Tasks found">
            {shown.map((h, i) => {
              const status = STATUSES.find((s) => s.id === h.task.status)?.label ?? h.task.status
              const inName = words.every((w) => `${h.key}\n${h.task.title}`.toLowerCase().includes(w))
              const more = inName ? undefined : snippet(h.task.description, words)
              return (
                <div
                  key={h.task.id}
                  id={optionId(i)}
                  data-hit={i}
                  role="option"
                  aria-selected={i === at}
                  onMouseMove={() => i !== at && setActive(i)}
                  onClick={() => pick(h)}
                  className={clsx(
                    "flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 text-[12.5px] [&_mark]:rounded-[2px] [&_mark]:bg-accent/30 [&_mark]:text-fg",
                    i === at && "bg-white/5",
                    (h.archived || h.task.status === "done") && "opacity-70",
                  )}
                >
                  <span className="mt-0.5 shrink-0" title={status}>
                    <StatusIcon status={h.task.status} size={13} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-2">
                      <span className="shrink-0 font-mono text-[11.5px] text-muted">{mark(h.key)}</span>
                      <span className="min-w-0 flex-1 truncate text-fg">{mark(h.task.title || "Untitled")}</span>
                    </span>
                    {more && <span className="block truncate text-[11.5px] text-faint">{mark(more)}</span>}
                  </span>
                  <span className="shrink-0 pt-px text-[11px] text-faint">
                    {showProject && h.project && <>{h.project} · </>}
                    {h.archived ? "Archived" : status}
                  </span>
                </div>
              )
            })}
          </div>
          {!hits.length && <div className="px-2 py-1.5 text-[12.5px] text-muted">No tasks found</div>}
          {hits.length > shown.length && (
            <div className="px-2 pt-1 pb-0.5 text-[11.5px] text-faint">{hits.length - shown.length} more: type more to narrow the search</div>
          )}
        </div>
      )}
    </div>
  )
}

export type FilterOption<T> = { id: T; label: string }

/** Closes the popover in `ref` on a press outside it, or Escape (which then goes no further, so an open task panel stays). */
function useDismiss(ref: RefObject<HTMLElement | null>, open: boolean, close: () => void) {
  useEffect(() => {
    if (!open) return undefined
    const onDown = (e: MouseEvent) => {
      if (!(e.target instanceof Node && ref.current?.contains(e.target))) close()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return
      e.preventDefault()
      close()
    }
    window.addEventListener("mousedown", onDown, true)
    window.addEventListener("keydown", onKey, true)
    return () => {
      window.removeEventListener("mousedown", onDown, true)
      window.removeEventListener("keydown", onKey, true)
    }
  }, [ref, open, close])
}

/** A checkbox item of the filter menu. */
const item = (key: string, checked: boolean, label: ReactNode, onSelect: () => void) => (
  <button
    key={key}
    role="menuitemcheckbox"
    aria-checked={checked}
    onClick={onSelect}
    className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[12.5px] text-fg outline-none hover:bg-white/5 focus:bg-white/5"
  >
    <span
      className={clsx(
        "flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[3px] border",
        checked ? "border-accent bg-accent/80 text-bg" : "border-line-strong",
      )}
    >
      {checked && <Check size={11} strokeWidth={3} />}
    </span>
    {label}
  </button>
)

/** A heading in the filter menu. */
const heading = (text: string) => <div className="px-2 pt-2 pb-1 text-[11px] font-medium tracking-wide text-faint uppercase first:pt-1">{text}</div>

/** A filter in the filter bar, to take off. */
const chip = (key: string, label: ReactNode, remove: () => void) => (
  <span key={key} className="inline-flex h-6 items-center gap-1 rounded-md border border-line bg-panel pr-0.5 pl-2 text-[12px] text-fg">
    {label}
    <button title="Remove this filter" onClick={remove} className="flex h-5 w-5 items-center justify-center rounded text-faint hover:text-fg">
      <X size={11} />
    </button>
  </span>
)

/** The Filter button and its menu, which stays open while filters are picked. */
export function FilterMenu({
  query,
  onChange,
  statuses,
  kinds,
  projects,
  align = "right",
}: {
  query: BoardQuery
  onChange: (q: BoardQuery) => void
  statuses: FilterOption<Status>[]
  kinds: TaskKind[]
  /** Offered with two or more. */
  projects: FilterOption<string>[]
  /** Which edge of the button the menu lines up with. */
  align?: "left" | "right" | undefined
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const close = useCallback(() => setOpen(false), [])
  useDismiss(ref, open, close)
  const count = filterCount(query)
  return (
    <div ref={ref} className="relative">
      <button title="Filter the board's tasks" aria-expanded={open} onClick={() => setOpen(!open)} className={clsx(BUTTON, BUTTON_STATE(count > 0 || open))}>
        <ListFilter size={13} /> Filter
        {count > 0 && <span className="rounded bg-accent/25 px-1 text-[11px] text-fg">{count}</span>}
      </button>
      {open && (
        <div
          data-modal
          role="menu"
          className={clsx(
            align === "right" ? "right-0" : "left-0",
            "absolute top-full z-50 mt-1 max-h-[70vh] w-60 overflow-y-auto rounded-lg border border-line bg-panel p-1 shadow-2xl shadow-black/50",
          )}
        >
          {heading("Status")}
          {statuses.map((s) =>
            item(
              `s:${s.id}`,
              query.statuses.includes(s.id),
              <>
                <StatusIcon status={s.id} size={13} /> {s.label}
              </>,
              () => onChange({ ...query, statuses: toggled(query.statuses, s.id) }),
            ),
          )}
          {kinds.length > 1 && (
            <>
              {heading("Type")}
              {TASK_KINDS.filter((k) => kinds.includes(k.id)).map((k) =>
                item(`k:${k.id}`, query.kinds.includes(k.id), k.label, () => onChange({ ...query, kinds: toggled(query.kinds, k.id) })),
              )}
            </>
          )}
          {projects.length > 1 && (
            <>
              {heading("Project")}
              {projects.map((p) =>
                item(`p:${p.id}`, query.projects.includes(p.id), p.label, () => onChange({ ...query, projects: toggled(query.projects, p.id) })),
              )}
            </>
          )}
          {heading("Only")}
          {TASK_FLAGS.map((f) => item(`f:${f.id}`, query.flags.includes(f.id), f.label, () => onChange({ ...query, flags: toggled(query.flags, f.id) })))}
          {count > 0 && (
            <>
              <div role="separator" className="mx-1 my-1 h-px bg-line" />
              <button
                onClick={() => onChange(EMPTY_QUERY)}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[12.5px] text-muted outline-none hover:bg-white/5 hover:text-fg focus:bg-white/5"
              >
                <X size={13} /> Clear filters
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}

/** The Sort button: it names the sort when it isn't the board's own (manual) order. */
export function SortMenu({ sort, onChange }: { sort: SortKey; onChange: (s: SortKey) => void }) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null)
  // A press on the button closes the open menu (as one anywhere outside it does), so the click mustn't open it again.
  const wasOpen = useRef(false)
  const label = SORTS.find((s) => s.id === sort)?.label
  return (
    <>
      <button
        title={sort === "manual" ? "Sort the board's tasks" : `Sorted by ${label?.toLowerCase()}: dragging a task moves it to another column, not within one`}
        onMouseDown={() => (wasOpen.current = !!at)}
        onClick={(e) => {
          if (wasOpen.current) return
          const r = e.currentTarget.getBoundingClientRect()
          setAt({ x: r.left, y: r.bottom + 4 })
        }}
        className={clsx(BUTTON, BUTTON_STATE(sort !== "manual"))}
      >
        <ArrowUpDown size={13} /> {sort === "manual" ? "Sort" : label}
      </button>
      {at && (
        <ContextMenu
          x={at.x}
          y={at.y}
          title="Sort by"
          items={SORTS.map((s) => ({ label: s.label, checked: s.id === sort, divider: s.id === "activity", onSelect: () => onChange(s.id) }))}
          onClose={() => setAt(null)}
        />
      )}
    </>
  )
}

/**
 * Below the header while anything is filtered: how many tasks show, and each filter, to take off one by one.
 * With `tools` (the search, filter and sort controls, on a board too narrow for them in its header), always, with them first.
 */
export function FilterBar({
  query,
  onChange,
  shown,
  total,
  statuses,
  projects,
  tools,
}: {
  query: BoardQuery
  onChange: (q: BoardQuery) => void
  tools?: ReactNode | undefined
  shown: number
  total: number
  statuses: FilterOption<Status>[]
  projects: FilterOption<string>[]
}) {
  const named = <T,>(options: FilterOption<T>[], id: T) => options.find((o) => o.id === id)?.label ?? String(id)
  return (
    <div className="flex flex-wrap items-center gap-1.5 border-b border-line bg-panel/60 px-5 py-1.5 text-[12px] text-muted narrow:px-3">
      {tools}
      {isFiltering(query) && (
        <>
          <span className={clsx("mr-1", tools && "ml-2")}>
            {shown} of {total} task{total === 1 ? "" : "s"}
          </span>
          {query.statuses.map((s) =>
            chip(
              `s:${s}`,
              <>
                <StatusIcon status={s} size={12} /> {named(statuses, s)}
              </>,
              () => onChange({ ...query, statuses: toggled(query.statuses, s) }),
            ),
          )}
          {query.kinds.map((k) => chip(`k:${k}`, named(TASK_KINDS, k), () => onChange({ ...query, kinds: toggled(query.kinds, k) })))}
          {query.projects.map((p) => chip(`p:${p}`, named(projects, p), () => onChange({ ...query, projects: toggled(query.projects, p) })))}
          {query.flags.map((f) => chip(`f:${f}`, named(TASK_FLAGS, f), () => onChange({ ...query, flags: toggled(query.flags, f) })))}
          <button className="ml-1 text-muted hover:text-fg hover:underline" onClick={() => onChange(EMPTY_QUERY)}>
            Clear all
          </button>
        </>
      )}
    </div>
  )
}
