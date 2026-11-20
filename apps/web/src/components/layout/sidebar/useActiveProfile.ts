import { useCallback, useEffect, useState } from "react"
import { activeProfile, loadActiveProfile, profilePlace, saveActiveProfile, saveProfilePlace } from "../../../activeProfile"
import type { HostProfile as Profile, HostProject as Project, HostTask as Task } from "@huntaway/client"

import { profileTint, showProfileTint } from "../../../theme"
import { groupProjects, groupTasks } from "../../../projectGroups"
import { href, type Route, withoutModal } from "../../../router"
import { navigate, onNavigate } from "../../../state/route"
import type { ProfileOf } from "./useProfileOf"
import { useBoard } from "../../../state/board"
import { setTitleProfile } from "../notifier"

/** The page open, without a task dialog over it (which is only over it for now). */
const here = (): string => withoutModal(window.location.pathname + window.location.search)

/**
 * The profile whose projects the sidebar lists, which is saved in this browser, named in the
 * page's title when there are several, and whose tint the board shows; and `switchTo`, which moves to a profile at
 * the page it was last on (HE-64).
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

  // HE-64: the page open is where the active profile is, once it's known whose it is: a profile's own pages, a project's
  // or group's once loaded, and a plugin's (its documents). Not the pages of every profile (settings, analytics, the
  // guide, a host's), nor a task's page, which moves on to its board.
  const [url, setUrl] = useState(here)
  useEffect(() => onNavigate(() => setUrl(here())), [])
  const loaded = useBoard((s) => s.loaded)
  const known =
    route.name === "profile" || route.name === "assistant"
      ? route.profile === active
      : route.name === "board" || route.name === "projectSettings"
        ? openProjects.length > 0
        : route.name === "group"
          ? loaded
          : route.name === "plugin"
  useEffect(() => {
    if (active !== undefined && known) saveProfilePlace(active, url)
  }, [active, known, url])
  // Another profile opens at its kept page, and the one already on at its board. The profile is picked first, so the
  // page goes on with it even where the sidebar would stay on this one (a pinned project, a plugin's page), and when
  // its kept page is the one open (the same pinned project, or plugin page, under both) it only moves the sidebar.
  const switchTo = useCallback(
    (name: string) => {
      setSavedProfile(name)
      navigate(name === active ? href({ name: "profile", profile: name }) : profilePlace(name))
    },
    [active],
  )

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

  return { active, switchTo }
}
