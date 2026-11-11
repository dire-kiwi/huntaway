// The boxes the Changes tab is drawn with, as lazygit draws them, and the lists in them.
import { clsx } from "clsx"
import { useLayoutEffect, useRef, type ReactNode, type Ref } from "react"
import { conflicted, hasStaged, hasUnstaged, untracked, type FileRow } from "../diffs"

/** A box with its title in its top border, as lazygit draws its panels. */
export function Panel({
  title,
  active,
  focused,
  className,
  right,
  children,
  scrollRef,
  onMouseDown,
}: {
  title: string
  active: boolean
  focused: boolean
  className?: string | undefined
  right?: ReactNode
  children: ReactNode
  scrollRef?: Ref<HTMLDivElement>
  onMouseDown?: () => void
}) {
  return (
    <section
      onMouseDown={onMouseDown}
      className={clsx(
        "relative flex min-h-[38px] min-w-0 flex-col rounded border",
        active ? (focused ? "border-emerald-400/80" : "border-emerald-400/45") : "border-line-strong",
        className,
      )}
    >
      <div className="pointer-events-none absolute -top-[9px] right-2 left-2 flex items-center justify-between gap-2 text-[11px] leading-4">
        <span className={clsx("truncate bg-bg px-1", active ? "font-semibold text-emerald-300" : "text-muted")}>{title}</span>
        {right && <span className="pointer-events-auto shrink-0 bg-bg px-1 text-faint">{right}</span>}
      </div>
      {/* A size container: comments under lines are as wide as it, however wide the lines are. */}
      <div ref={scrollRef} className="@container min-h-0 flex-1 overflow-auto pt-1.5 pb-0.5">
        {children}
      </div>
    </section>
  )
}

/** Keeps the selected row in view. */
function useScrollTo(selected: number) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    ref.current?.querySelector(`[data-i="${selected}"]`)?.scrollIntoView({ block: "nearest" })
  }, [selected])
  return ref
}

export function List<T>({
  items,
  keyOf,
  selected,
  active,
  empty,
  render,
  onSelect,
  onOpen,
  onMenu,
}: {
  items: ReadonlyArray<T>
  /** What tells an item from the others (its hash, its number). */
  keyOf: (t: T) => string | number
  selected: number
  active: boolean
  empty: string
  render: (t: T, i: number) => ReactNode
  onSelect: (t: T) => void
  onOpen: (t: T) => void
  onMenu: (t: T, x: number, y: number) => void
}) {
  const ref = useScrollTo(selected)
  if (!items.length) return <div className="px-1.5 text-faint">{empty}</div>
  return (
    <div ref={ref}>
      {items.map((t, i) => (
        <div
          key={keyOf(t)}
          data-i={i}
          onMouseDown={(e) => e.button === 0 && onSelect(t)}
          onDoubleClick={() => onOpen(t)}
          onContextMenu={(e) => {
            e.preventDefault()
            onMenu(t, e.clientX, e.clientY)
          }}
          className={clsx("cursor-default whitespace-nowrap", i === selected && (active ? "bg-accent/25" : "bg-white/[0.06]"))}
        >
          {render(t, i)}
        </div>
      ))}
    </div>
  )
}

export function FilesList({
  rows,
  selected,
  active,
  collapsed,
  empty,
  onSelect,
  onOpen,
  onToggle,
  onMenu,
}: {
  rows: FileRow[]
  selected: number
  active: boolean
  collapsed: ReadonlySet<string>
  empty: string
  onSelect: (r: FileRow) => void
  onOpen: (r: FileRow) => void
  onToggle: (r: FileRow) => void
  onMenu: (r: FileRow, x: number, y: number) => void
}) {
  const ref = useScrollTo(selected)
  if (!rows.length) return <div className="px-1.5 text-faint">{empty}</div>
  return (
    <div ref={ref}>
      {rows.map((r, i) => {
        const staged = r.files.filter(hasStaged).length
        const unstaged = r.files.filter(hasUnstaged).length
        const tone = r.files.some(conflicted) ? "text-amber-400" : !unstaged ? "text-emerald-400" : staged ? "text-amber-200" : "text-red-300"
        return (
          <div
            key={r.key}
            data-i={i}
            onMouseDown={(e) => e.button === 0 && onSelect(r)}
            onDoubleClick={() => onOpen(r)}
            onContextMenu={(e) => {
              e.preventDefault()
              onMenu(r, e.clientX, e.clientY)
            }}
            title={r.file?.orig_path ? `${r.file.orig_path} → ${r.file.path}` : r.key}
            className={clsx("flex cursor-default items-center whitespace-pre pr-1.5", i === selected && (active ? "bg-accent/25" : "bg-white/[0.06]"))}
            style={{ paddingLeft: 6 + r.depth * 14 }}
          >
            {r.file ? (
              <button
                tabIndex={-1}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={() => onToggle(r)}
                title={unstaged ? "Stage" : "Unstage"}
                className="mr-1.5 shrink-0 rounded hover:bg-white/10"
              >
                <span className={untracked(r.file) || conflicted(r.file) ? "text-red-400" : "text-emerald-400"}>{r.file.x}</span>
                <span className="text-red-400">{r.file.y}</span>
              </button>
            ) : (
              <span className="mr-1.5 w-[2ch] shrink-0 text-center text-faint">{collapsed.has(r.key) ? "▶" : "▼"}</span>
            )}
            <span className={clsx("truncate", tone)}>
              {r.name}
              {!r.file && "/"}
            </span>
            {r.file?.orig_path && <span className="ml-1 truncate text-faint">← {r.file.orig_path}</span>}
          </div>
        )
      })}
    </div>
  )
}

export function Section({ children }: { children: ReactNode }) {
  return <div className="mb-1 px-1.5 font-semibold text-muted">{children}</div>
}

export function Note({ children, error }: { children: ReactNode; error?: boolean }) {
  return <div className={clsx("px-1.5 text-[12px]", error ? "text-red-400" : "text-muted")}>{children}</div>
}

export function EmptyMain({ text }: { text: string }) {
  return text ? <div className="flex h-full items-center justify-center font-sans text-[13px] text-faint">{text}</div> : null
}
