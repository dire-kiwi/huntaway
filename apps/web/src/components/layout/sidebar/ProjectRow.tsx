import { clsx } from "clsx"
import { Pin } from "lucide-react"
import type { MouseEvent } from "react"
import { type HostProject as Project } from "@huntaway/client"
import type { Host } from "@huntaway/contracts"
import { navigate } from "../../../state/route"
import { ProfileAvatar } from "../../board/Board"
import { RunningDot } from "../../ui"
import { Counts, NavItem, type Stats } from "./NavItem"
import type { ProfileOf } from "./useProfileOf"

/** What every project's row is drawn from, besides its project. */
export type RowProps = {
  /** By project id, and by `g:<groupKey>` for a group's own tasks. */
  stats: Record<string, Stats>
  hosts: ReadonlyArray<Host>
  /** Whether projects are listed by host. */
  grouped: boolean
  /** The profile whose projects the sidebar lists. */
  active: string | undefined
  activeProject: string | null | undefined
  profileOf: ProfileOf
  isPinned: (p: Project) => boolean
  isFavorite: (p: Project) => boolean
  projectMenu: (e: MouseEvent, p: Project) => void
}

/** A project in the sidebar. `dim`: one that's hidden, listed under its host's hidden row. */
export function ProjectRow({
  p,
  dim = false,
  stats,
  hosts,
  grouped,
  active,
  activeProject,
  profileOf,
  isPinned,
  isFavorite,
  projectMenu,
}: RowProps & { p: Project; dim?: boolean | undefined }) {
  const s = stats[p.id]
  const owner = profileOf(p)
  const pin = isPinned(p)
  const notes = [
    grouped && isFavorite(p) && `On ${hosts.find((h) => h.id === p.host_id)?.name ?? p.host_id}`,
    dim && `${p.name} is hidden from the sidebar; right-click it to show it again`,
    pin && (owner !== active ? `In ${owner}, pinned to every profile's sidebar` : "Pinned to every profile's sidebar"),
  ].filter(Boolean)
  return (
    <NavItem
      className={clsx("min-w-0 flex-1", dim && "opacity-60")}
      title={notes.length ? notes.join("\n") : undefined}
      active={activeProject === p.id}
      onClick={() => navigate({ name: "board", projectId: p.id })}
      onContextMenu={(e) => projectMenu(e, p)}
      icon={
        <span className="flex h-4.5 w-7 items-center justify-center rounded bg-white/[0.06] font-mono text-[9.5px] font-semibold text-muted">
          {p.key.slice(0, 3)}
        </span>
      }
      right={
        <span className="flex items-center gap-1.5">
          {s?.running ? <RunningDot /> : null}
          <Counts attention={s?.attention ?? 0} ready={s?.ready ?? 0} />
          {pin && <Pin size={11} className="shrink-0 text-faint" aria-label="Pinned" />}
          {pin && owner && owner !== active && <ProfileAvatar name={owner} muted className="h-4 w-4 text-[9px]" />}
        </span>
      }
    >
      {p.name}
    </NavItem>
  )
}
