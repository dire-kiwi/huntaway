import { useEffect, useState } from "react"
import { activeProfile, loadActiveProfile, saveActiveProfile } from "../../../activeProfile"
import type { HostProfile as Profile, HostProject as Project, HostTask as Task } from "@huntaway/client"

import { profileTint, showProfileTint } from "../../../theme"
import { groupProjects, groupTasks } from "../../../projectGroups"
import type { Route } from "../../../router"
import type { ProfileOf } from "./useProfileOf"
import { useBoard } from "../../../state/board"
import { setTitleProfile } from "../notifier"

/**
 * The profile whose projects the sidebar lists, which is saved in this browser, named in the
 * page's title when there are several, and whose tint the board shows.
 */
export function useActiveProfile({
  route,
  routeTask,
  names,
  profiles,
  projects,
  taskList,
  profileOf,
  isPinned,
}: {
  route: Route
  routeTask: Task | undefined
  names: string[]
  profiles: ReadonlyArray<Profile>
  projects: ReadonlyArray<Project>
  taskList: ReadonlyArray<Task>
  profileOf: ProfileOf
  isPinned: (p: Project) => boolean
}) {
  const [savedProfile, setSavedProfile] = useState(loadActiveProfile)

  // The sidebar lists the projects of one profile (and the pinned ones): the profile whose board
  // is open, else the one picked last. Opening a project it doesn't list moves to its profile.
  const openProjects =
    route.name === "board" || route.name === "projectSettings"
      ? projects.filter((p) => p.id === route.projectId)
      : routeTask?.project_id
        ? projects.filter((p) => p.host_id === routeTask.host_id && p.id === routeTask.project_id)
        : route.name === "group"
          ? groupProjects(projects, route.hostId, route.group)
          : []
  const active = activeProfile(names, savedProfile, (current) => {
    if (route.name === "profile" || route.name === "assistant") return route.profile
    // A docs route names its profile by name, or by id as agents' links do (the old docs.ts `docsProfileName`).
    if (route.name === "docs") return profiles.find((p) => p.id === route.profile)?.name ?? route.profile
    const listed = openProjects.some((p) => profileOf(p) === current || isPinned(p))
    if (route.name === "group") {
      // A profile lists a group for its projects in it, and for its group tasks in it (which can
      // stay after its own projects leave the group), so either keeps it.
      const owners = groupTasks(taskList, route.hostId, route.group).map(profileOf)
      if (listed || owners.includes(current)) return undefined
      const [first] = openProjects
      return first ? profileOf(first) : owners[0]
    }
    const [first] = openProjects
    return first && !listed ? profileOf(first) : undefined
  })
  if (active !== undefined && active !== savedProfile) setSavedProfile(active)
  useEffect(() => {
    if (active !== undefined) saveActiveProfile(active)
  }, [active])

  // The board takes on the active profile's tint (HA-397).
  const localHostId = useBoard((s) => s.localHostId)
  const tint = profileTint(profiles, active, localHostId)
  useEffect(() => {
    if (tint !== undefined) showProfileTint(tint)
  }, [tint])

  const titled = names.length > 1 ? active : undefined
  // The window's title, with the count of tasks that need attention (layout/notifier.ts).
  useEffect(() => {
    setTitleProfile(titled)
  }, [titled])

  return active
}
