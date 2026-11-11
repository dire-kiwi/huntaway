import { useState } from "react"
import { type HostProject as Project } from "@huntaway/client"
import { groupKey } from "../../../projectGroups"
import { type Route } from "../../../router"
import { navigate } from "../../../state/route"
import { rpc } from "../../../state/rpc"
import { errorText } from "../../ui"

/** Putting projects in a group and taking them out, the dialog that names a group, and why the last change failed. */
export function useGroupActions({
  route,
  collapsed,
  setCollapsedGroup,
}: {
  route: Route
  collapsed: Set<string>
  setCollapsedGroup: (key: string, on: boolean) => void
}) {
  const [naming, setNaming] = useState<{ title: string; initial: string; projects: ReadonlyArray<Project> } | null>(null)
  const [groupErr, setGroupErr] = useState<string | null>(null)

  /** Puts `list` in group `name` (null takes them out of their group). */
  const setGroup = async (list: ReadonlyArray<Project>, name: string | null) => {
    setGroupErr(null)
    await Promise.all(list.map((p) => rpc(p.host_id, "projects.update", { id: p.id, patch: { group_name: name } })))
  }
  /** Moves off the board of a group that's gone (renamed or ungrouped). */
  const leaveGroup = (hostId: string, name: string, to: Route) => {
    if (route.name === "group" && route.hostId === hostId && route.group === name) navigate(to, true)
  }
  /** Resolves to whether it worked; the sidebar shows why it didn't. */
  const trySetGroup = (list: ReadonlyArray<Project>, name: string | null) =>
    setGroup(list, name).then(
      () => true,
      (e: unknown) => {
        setGroupErr(errorText(e))
        return false
      },
    )

  /** Saves the name from the dialog, for the group `naming` is about. */
  const saveName = async (name: string) => {
    const hostId = naming?.projects[0]?.host_id
    if (!naming || !hostId) return
    const old = naming.initial && groupKey(hostId, naming.initial)
    await setGroup(naming.projects, name)
    if (naming.initial) leaveGroup(hostId, naming.initial, { name: "group", hostId, group: name })
    // A renamed group stays collapsed (or open).
    if (old && collapsed.has(old)) {
      setCollapsedGroup(old, false)
      setCollapsedGroup(groupKey(hostId, name), true)
    }
  }

  return { naming, setNaming, groupErr, setGroupErr, leaveGroup, trySetGroup, saveName }
}
