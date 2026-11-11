import { clsx } from "clsx"
import { ChevronRight, Folder } from "lucide-react"
import type { MouseEvent } from "react"
import type { HostProject as Project } from "@huntaway/client"
import { groupKey, groupProjects, type SidebarEntry } from "../../../projectGroups"
import { type Route } from "../../../router"
import { navigate } from "../../../state/route"
import { RunningDot } from "../../ui"
import { Counts } from "./NavItem"
import { ProjectRow, type RowProps } from "./ProjectRow"

/** A group's row, which opens its board, and its projects under it unless it's collapsed. */
export function ProjectGroup({
  entry,
  route,
  list,
  all,
  collapsed,
  setCollapsedGroup,
  groupMenu,
  row,
}: {
  entry: Extract<SidebarEntry, { kind: "group" }>
  route: Route
  /** Its host's projects that the sidebar lists, and those of every profile. */
  list: ReadonlyArray<Project>
  all: ReadonlyArray<Project>
  collapsed: Set<string>
  setCollapsedGroup: (key: string, on: boolean) => void
  groupMenu: (e: MouseEvent, name: string, list: ReadonlyArray<Project>, listed: ReadonlyArray<Project>) => void
  row: RowProps
}) {
  const { stats, activeProject } = row
  const key = groupKey(entry.hostId, entry.name)
  const open = !collapsed.has(key)
  // Its projects are all favorites: the row stays for its group tasks (see visibleEntries), with nothing to open.
  const empty = !entry.projects.length
  const total = [...entry.projects.map((p) => p.id), `g:${key}`].reduce(
    (t, id) => ({
      attention: t.attention + (stats[id]?.attention ?? 0),
      running: t.running + (stats[id]?.running ?? 0),
      ready: t.ready + (stats[id]?.ready ?? 0),
    }),
    { attention: 0, running: 0, ready: 0 },
  )
  const onGroup = route.name === "group" && route.hostId === entry.hostId && route.group === entry.name
  const hidesActive = !open && entry.projects.some((p) => p.id === activeProject)
  return (
    <div className="flex">
      <div className="min-w-0 flex-1">
        <div
          className={clsx(
            "flex h-8 items-center rounded-md text-[13px] narrow:h-10",
            onGroup || hidesActive ? "bg-raised text-fg" : "text-muted hover:bg-white/[0.04] hover:text-fg",
          )}
          onContextMenu={(e) => groupMenu(e, entry.name, groupProjects(all, entry.hostId, entry.name), groupProjects(list, entry.hostId, entry.name))}
        >
          {empty ? (
            <span className="w-6 shrink-0 narrow:w-8" />
          ) : (
            <button
              aria-expanded={open}
              aria-label={`${open ? "Collapse" : "Expand"} ${entry.name}`}
              title={open ? "Collapse" : "Expand"}
              onClick={() => setCollapsedGroup(key, open)}
              className="flex h-8 w-6 shrink-0 items-center justify-center rounded-l-md text-faint hover:text-fg narrow:h-10 narrow:w-8"
            >
              <ChevronRight size={13} className={clsx("transition-transform", open && "rotate-90")} />
            </button>
          )}
          <button
            onClick={() => navigate({ name: "group", hostId: entry.hostId, group: entry.name })}
            title={`All of ${entry.name}'s tasks`}
            className="flex h-8 min-w-0 flex-1 items-center gap-2 pr-2.5 text-left narrow:h-10"
          >
            <Folder size={14} className="shrink-0" />
            <span className="min-w-0 flex-1 truncate">{entry.name}</span>
            {(!open || empty) && (
              <span className="flex items-center gap-1.5">
                {total.running ? <RunningDot /> : null}
                <Counts attention={total.attention} ready={total.ready} />
              </span>
            )}
          </button>
        </div>
        {open && !empty && (
          <div role="group" aria-label={entry.name} className="ml-3 space-y-0.5 border-l border-line pl-1">
            {entry.projects.map((p) => (
              <div key={p.id} className="flex">
                <ProjectRow p={p} {...row} />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
