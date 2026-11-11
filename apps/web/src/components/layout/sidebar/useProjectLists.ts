import { useMemo } from "react"
import { type HostProject as Project, type HostTask as Task } from "@huntaway/client"
import type { Host } from "@huntaway/contracts"
import { groupsWithTasks, hiddenKey, orphanGroupNames, profileProjects, sidebarEntries, visibleEntries, type SidebarEntry } from "../../../projectGroups"
import type { ProfileOf } from "./useProfileOf"
import type { ProjectMarks } from "./useProjectMarks"

/** A host's part of the project list. */
export type HostGroup = {
  host: Host
  projects: ReadonlyArray<Project>
  /** Every profile's projects on the host, for what a group does as a whole (moving, renaming). */
  all: ReadonlyArray<Project>
  entries: SidebarEntry[]
  orphans: string[]
}

/** What the sidebar lists for profile `active`: its projects (and the pinned ones), the favorites among them, and the rest by host. */
export function useProjectLists({
  hosts,
  projects,
  taskList,
  active,
  profileOf,
  marks: { hidden, pinned, favorites, isFavorite },
}: {
  hosts: ReadonlyArray<Host>
  projects: ReadonlyArray<Project>
  taskList: ReadonlyArray<Task>
  active: string | undefined
  profileOf: ProfileOf
  marks: ProjectMarks
}) {
  const shown = profileProjects(projects, active, profileOf, pinned)
  const favoriteList = shown.filter(isFavorite)
  const profileTasks = useMemo(() => taskList.filter((t) => profileOf(t) === active), [taskList, profileOf, active])
  // Every profile's group tasks, as a group's row and board count them all (pinned projects bring in other profiles' groups).
  const withTasks = useMemo(() => groupsWithTasks(taskList), [taskList])
  // Group projects by host once more than one host is involved.
  const groups: HostGroup[] = hosts
    .map((h) => ({
      host: h,
      projects: shown.filter((p) => p.host_id === h.id),
      // Every profile's projects on the host, for what a group does as a whole (moving, renaming).
      all: projects.filter((p) => p.host_id === h.id),
      entries: visibleEntries(sidebarEntries(shown.filter((p) => p.host_id === h.id)), hidden, favorites, withTasks),
      orphans: orphanGroupNames(profileTasks, shown, h.id),
    }))
    .filter((g) => g.entries.length > 0 || g.projects.some((p) => hidden.has(hiddenKey(p))) || g.orphans.length > 0 || !g.host.connected)
  const grouped = hosts.length > 1

  return { shown, favoriteList, groups, grouped }
}
