import { Effect, Exit } from "effect"
import { type AtomRegistry } from "effect/reactivity"
import { useState } from "react"
import { type CallError, type HostProject as Project, mutate } from "@huntaway/client"
import { groupKey } from "../../../projectGroups"
import { type Route } from "../../../router"
import { exitError, useAction } from "../../../state/mutation"
import { navigate } from "../../../state/route"

type GroupChange = Effect.Effect<void, CallError<"projects.update">, AtomRegistry.AtomRegistry>

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
  const [, run] = useAction()

  /** Puts `list` in group `name` (null takes them out of their group). */
  const setGroup = (list: ReadonlyArray<Project>, name: string | null): GroupChange =>
    Effect.sync(() => setGroupErr(null)).pipe(
      Effect.andThen(
        Effect.forEach(list, (p) => mutate("projects.update", p.host_id, { id: p.id, patch: { group_name: name } }), {
          concurrency: "unbounded",
          discard: true,
        }),
      ),
    )
  /** Moves off the board of a group that's gone (renamed or ungrouped). */
  const leaveGroup = (hostId: string, name: string, to: Route) => {
    if (route.name === "group" && route.hostId === hostId && route.group === name) navigate(to, true)
  }
  /** Resolves to whether it worked; the sidebar shows why it didn't. */
  const trySetGroup = (list: ReadonlyArray<Project>, name: string | null): Promise<boolean> =>
    run(setGroup(list, name)).then((exit) => {
      if (Exit.isSuccess(exit)) return true
      setGroupErr(exitError(exit))
      return false
    })

  /** Saving the name from the dialog, for the group `naming` is about: the dialog runs it and shows why it failed. */
  const saveName = (name: string): GroupChange => {
    const hostId = naming?.projects[0]?.host_id
    if (!naming || !hostId) return Effect.void
    const old = naming.initial && groupKey(hostId, naming.initial)
    return setGroup(naming.projects, name).pipe(
      Effect.andThen(
        Effect.sync(() => {
          if (naming.initial) leaveGroup(hostId, naming.initial, { name: "group", hostId, group: name })
          // A renamed group stays collapsed (or open).
          if (old && collapsed.has(old)) {
            setCollapsedGroup(old, false)
            setCollapsedGroup(groupKey(hostId, name), true)
          }
        }),
      ),
    )
  }

  return { naming, setNaming, groupErr, setGroupErr, leaveGroup, trySetGroup, saveName }
}
