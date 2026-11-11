// What the list and a document's view both show: the header, notices, links within the board, a publisher, labels.
import { clsx } from "clsx"
import { Tag } from "lucide-react"
import type { MouseEvent, ReactNode } from "react"
import type { DocPublisher } from "@huntaway/contracts"
import { href } from "../../../router"
import { useBoard } from "../../../state/board"
import { navigate } from "../../../state/route"
import { MenuButton } from "../../ui"

/** A link within the board: navigates here on a plain click, and opens in a new tab as links do otherwise. */
export function BoardLink({ to, className, title, children }: { to: string; className?: string; title?: string; children: ReactNode }) {
  const onClick = (e: MouseEvent) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    e.preventDefault()
    navigate(to)
  }
  return (
    <a href={to} onClick={onClick} className={className} title={title}>
      {children}
    </a>
  )
}

/** The task that published a version, linked. */
export function Publisher({ task }: { task: DocPublisher | null | undefined }) {
  if (!task) return <span className="text-faint">—</span>
  return (
    <BoardLink to={href({ name: "task", taskId: task.id })} className="min-w-0 truncate text-muted hover:text-fg hover:underline" title={task.title}>
      {task.key && <span className="mr-1.5 font-mono text-[12px] text-faint">{task.key}</span>}
      {task.title}
    </BoardLink>
  )
}

export function Header({ children }: { children: ReactNode }) {
  return (
    <header className="drag flex h-12 shrink-0 items-center gap-3 border-b border-line px-5 narrow:px-3">
      <MenuButton />
      {children}
    </header>
  )
}

export function Notice({ children }: { children: ReactNode }) {
  return <div className="p-8 text-[13px] text-muted">{children}</div>
}

/** Why there's nothing to show yet: the board is still loading, or no host with the profile's documents is connected. */
export function NoHomes({ name }: { name: string }) {
  const loaded = useBoard((s) => s.loaded)
  return <Notice>{loaded ? `${name}'s documents are kept on its hosts: none of them is connected.` : "Loading…"}</Notice>
}

/** A document's labels, as chips. */
export function LabelChips({ labels, className }: { labels: ReadonlyArray<string>; className?: string | undefined }) {
  return (
    <div className={clsx("flex min-w-0 flex-wrap gap-1", className)} aria-label="Labels">
      {labels.map((l) => (
        <span key={l} className="flex max-w-full items-center gap-1 truncate rounded bg-white/[0.06] px-1.5 py-px text-[11px] text-muted" title={l}>
          <Tag size={10} className="shrink-0 text-faint" />
          <span className="truncate">{l}</span>
        </span>
      ))}
    </div>
  )
}
