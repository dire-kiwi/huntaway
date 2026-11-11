import { clsx } from "clsx"
import type { MouseEvent, ReactNode } from "react"

export function NavItem({
  active,
  current,
  onClick,
  onContextMenu,
  icon,
  children,
  right,
  className,
  title,
  expanded,
}: {
  active: boolean
  /** Marks the row with a bar at its left edge: the profile whose projects the sidebar lists. */
  current?: boolean | undefined
  title?: string | undefined
  /** For a row that shows or leaves out the rows under it. */
  expanded?: boolean | undefined
  onClick: () => void
  onContextMenu?: ((e: MouseEvent) => void) | undefined
  icon: ReactNode
  children: ReactNode
  right?: ReactNode | undefined
  className?: string | undefined
}) {
  return (
    <button
      onClick={onClick}
      onContextMenu={onContextMenu}
      title={title}
      aria-expanded={expanded}
      aria-current={current || undefined}
      className={clsx(
        "flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-[13px] narrow:h-10",
        active || current ? "text-fg" : "text-muted hover:text-fg",
        active ? "bg-raised" : "hover:bg-white/[0.04]",
        current && "relative before:absolute before:inset-y-1.5 before:left-0 before:w-0.5 before:rounded-full before:bg-accent",
        className,
      )}
    >
      <span className="shrink-0">{icon}</span>
      <span className="min-w-0 flex-1 truncate text-left">{children}</span>
      {right}
    </button>
  )
}

const BADGE_TONE = { attention: "bg-st-attention/20 text-amber-300", review: "bg-st-review/20 text-violet-300", muted: "bg-white/10 text-muted" }

export function Badge({ n, tone = "attention", title }: { n: number; tone?: keyof typeof BADGE_TONE | undefined; title?: string | undefined }) {
  if (!n) return null
  return (
    <span title={title} className={clsx("min-w-[18px] rounded-full px-1.5 text-center text-[10.5px] leading-[18px] font-semibold", BADGE_TONE[tone])}>
      {n}
    </span>
  )
}

export type Stats = { attention: number; running: number; ready: number }

/** What a project (or group) has waiting: tasks that need attention, in amber, and tasks in
 * review that are ready to check, in purple (see `readyToCheck`). */
export function Counts({ attention, ready }: Pick<Stats, "attention" | "ready">) {
  return (
    <>
      <Badge n={ready} tone="review" title={`${ready} in review and ready to check`} />
      <Badge n={attention} title={`${attention} need${attention === 1 ? "s" : ""} attention`} />
    </>
  )
}
