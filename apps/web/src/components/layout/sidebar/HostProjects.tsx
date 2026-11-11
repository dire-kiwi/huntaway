import { clsx } from "clsx"
import { Folder } from "lucide-react"
import type { Dispatch, MouseEvent, SetStateAction } from "react"
import type { HostProject as Project } from "@huntaway/client"
import { groupKey, groupProjects } from "../../../projectGroups"
import { type Route } from "../../../router"
import { navigate } from "../../../state/route"
import { RunningDot } from "../../ui"
import { HiddenProjects } from "./HiddenProjects"
import { Counts, NavItem } from "./NavItem"
import { ProjectGroup } from "./ProjectGroup"
import { ProjectRow, type RowProps } from "./ProjectRow"
import type { HostGroup } from "./useProjectLists"

/**
 * A host's part of the project list: its name (once there are several hosts), its projects and
 * groups, its hidden projects, and the groups that only have group tasks left.
 */
export function HostProjects({
  group: { host, projects: list, all, entries, orphans },
  route,
  hidden,
  showHidden,
  setShowHidden,
  collapsed,
  setCollapsedGroup,
  groupMenu,
  row,
}: {
  group: HostGroup
  route: Route
  hidden: Set<string>
  showHidden: Set<string>
  setShowHidden: Dispatch<SetStateAction<Set<string>>>
  collapsed: Set<string>
  setCollapsedGroup: (key: string, on: boolean) => void
  groupMenu: (e: MouseEvent, name: string, list: ReadonlyArray<Project>, listed: ReadonlyArray<Project>) => void
  row: RowProps
}) {
  const { stats, grouped, active } = row
  return (
    <div className={clsx(grouped && "pb-2")}>
      {grouped && (
        <button
          onClick={() => navigate({ name: "host", hostId: host.id })}
          title={`Configure ${host.name}`}
          className="flex w-full items-center gap-1.5 px-2.5 pt-1 pb-0.5 text-left text-[10.5px] text-faint hover:text-muted"
        >
          <span className={clsx("h-1.5 w-1.5 rounded-full", host.connected ? "bg-emerald-400/70" : "bg-red-400")} />
          {host.name}
          {!host.connected && " · offline"}
        </button>
      )}
      {entries.map((entry) =>
        entry.kind === "project" ? (
          <div key={entry.key} className="flex">
            <ProjectRow p={entry.project} {...row} />
          </div>
        ) : (
          <ProjectGroup
            key={entry.key}
            entry={entry}
            route={route}
            list={list}
            all={all}
            collapsed={collapsed}
            setCollapsedGroup={setCollapsedGroup}
            groupMenu={groupMenu}
            row={row}
          />
        ),
      )}
      <HiddenProjects host={host} list={list} hidden={hidden} showHidden={showHidden} setShowHidden={setShowHidden} row={row} />
      {orphans.map((name) => {
        const s = stats[`g:${groupKey(host.id, name)}`]
        return (
          <NavItem
            key={name}
            className="min-w-0"
            active={route.name === "group" && route.hostId === host.id && route.group === name}
            onClick={() => navigate({ name: "group", hostId: host.id, group: name })}
            title={
              groupProjects(all, host.id, name).length
                ? `${name}'s projects are in other profiles; ${active}'s group tasks in it are here`
                : `${name} has no projects any more; its group tasks are still here`
            }
            icon={<Folder size={14} className="text-faint" />}
            right={
              <span className="flex items-center gap-1.5">
                {s?.running ? <RunningDot /> : null}
                <Counts attention={s?.attention ?? 0} ready={s?.ready ?? 0} />
              </span>
            }
          >
            <span className="italic">{name}</span>
          </NavItem>
        )
      })}
    </div>
  )
}
