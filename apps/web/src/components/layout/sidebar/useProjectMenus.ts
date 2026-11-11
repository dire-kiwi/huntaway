import { useState, type MouseEvent } from "react"
import { type HostProject as Project } from "@huntaway/client"
import { groupNames, hiddenKey } from "../../../projectGroups"
import type { Route } from "../../../router"
import type { MenuItem } from "../../ui"
import { newWindowItems } from "./newWindow"
import type { ProjectMarks } from "./useProjectMarks"

/** The sidebar's context menu (a project's, a group's, a profile's), and the project being archived from it. */
export function useProjectMenus({
  projects,
  names,
  marks: { hidden, favorites, isPinned, setProjectsHidden, setProjectsPinned, setProjectsFavorite },
  trySetGroup,
  leaveGroup,
  setNaming,
}: {
  projects: ReadonlyArray<Project>
  names: string[]
  marks: ProjectMarks
  trySetGroup: (list: ReadonlyArray<Project>, name: string | null) => Promise<boolean>
  leaveGroup: (hostId: string, name: string, to: Route) => void
  setNaming: (naming: { title: string; initial: string; projects: ReadonlyArray<Project> }) => void
}) {
  const [menu, setMenu] = useState<{ x: number; y: number; title: string; items: MenuItem[] } | null>(null)
  const [archiving, setArchiving] = useState<Project | null>(null)

  const projectMenu = (e: MouseEvent, p: Project) => {
    e.preventDefault()
    const grouping = true
    const isHidden = hidden.has(hiddenKey(p))
    const favorite = favorites.has(hiddenKey(p))
    setMenu({
      x: e.clientX,
      y: e.clientY,
      title: grouping ? `Group ${p.name} in` : p.name,
      items: [
        ...(grouping
          ? [
              ...groupNames(projects, p.host_id).map((name) => ({ label: name, checked: p.group_name === name, onSelect: () => trySetGroup([p], name) })),
              { label: "New group…", onSelect: () => setNaming({ title: `New group for ${p.name}`, initial: "", projects: [p] }) },
              { label: "No group", checked: !p.group_name, onSelect: () => trySetGroup([p], null) },
            ]
          : []),
        { label: favorite ? "Remove from favorites" : "Add to favorites", divider: true, onSelect: () => setProjectsFavorite([p], !favorite) },
        ...(names.length > 1 || isPinned(p)
          ? [{ label: isPinned(p) ? "Unpin" : "Pin to every profile", onSelect: () => setProjectsPinned([p], !isPinned(p)) }]
          : []),
        { label: isHidden ? "Show in sidebar" : "Hide from sidebar", onSelect: () => setProjectsHidden([p], !isHidden) },
        { label: "Archive…", onSelect: () => setArchiving(p) },
        ...newWindowItems({ name: "board", projectId: p.id }, true),
      ],
    })
  }

  /** `list` is the group's projects of every profile, `listed` those the sidebar lists. */
  const groupMenu = (e: MouseEvent, name: string, list: ReadonlyArray<Project>, listed: ReadonlyArray<Project>) => {
    e.preventDefault()
    const allPinned = listed.every(isPinned)
    setMenu({
      x: e.clientX,
      y: e.clientY,
      title: name,
      items: [
        {
          label: "Rename group…",
          onSelect: () => setNaming({ title: `Rename ${name}`, initial: name, projects: list }),
        },
        {
          label: "Ungroup",
          onSelect: () =>
            void trySetGroup(list, null).then((ok) => {
              if (ok && list[0]) leaveGroup(list[0].host_id, name, { name: "board", projectId: list[0].id })
            }),
        },
        ...(names.length > 1 || listed.some(isPinned)
          ? [{ label: allPinned ? "Unpin" : "Pin to every profile", divider: true, onSelect: () => setProjectsPinned(listed, !allPinned) }]
          : []),
        { label: "Hide from sidebar", divider: names.length < 2 && !listed.some(isPinned), onSelect: () => setProjectsHidden(listed, true) },
      ],
    })
  }

  return { menu, setMenu, archiving, setArchiving, projectMenu, groupMenu }
}
